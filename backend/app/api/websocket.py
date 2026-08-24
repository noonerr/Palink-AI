import asyncio
import json
import logging
import random
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import WebSocket, APIRouter

from ..core import settings
from ..core.ws_ticket import validate_ticket
from ..core.database import SessionLocal
from ..core.exceptions import ServiceError
from ..models import (
    User,
    ChatMessage,
    ChatSession,
    UserSetting,
    Character,
    CharacterChatSession,
    CharacterChatMessage,
    CharacterChatSessionBranch,
    WorldBook,
)
from ..models.system import GenerationPreset
from ..services.websocket_manager import ws_manager, Connection, ChatRoom, StreamSessionBusyError
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.generation_service import _build_logit_bias
from ..services.inference_queue import inference_queue
from ..services.stream_builder import StreamResult
from ..services.web_search import search_web, format_search_results, get_web_search_config
from ..services.mcp_service import get_all_tools_openai_format
from ..services.compact_title_service import generate_compact_title
from ..services.character_message_builder import build_character_chat_messages, clean_smart_card_trigger_context
from ..services.status_bar_detector import (
    StreamingStatusStripper,
    strip_and_parse_status_marker,
)
from ..services.image_generation_service import image_result_to_dict, maybe_generate_image_for_message
from ..services.roleplay_prompt_assembly import (
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
    resolve_group_speaker_queue,
    _resolve_group_speaker,
)
from ..services.slash_command_service import (
    is_slash_command,
    execute_slash_command,
    SlashCommandContext,
    SlashCommandResult,
)
from ..api.character_ext import (
    _apply_plugin_regex_scripts,
    _apply_regex_scripts,
    _apply_persist_regex_to_display_text,
    _character_alternate_greetings,
    _json_dump_or_none,
    _message_swipes,
    _st_message_kwargs,
    REGEX_PLACEMENT_AI_OUTPUT,
    REGEX_PLACEMENT_REASONING,
    REGEX_PLACEMENT_WORLD_INFO,
)
from ..memory_module.service import MemoryService
from ..memory_module.storage import delete_by_message_id
from ..utils import normalize_image_url, build_memory_context, clean_memory_content, apply_message_extra_patch

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)


async def authenticate_websocket(ticket: str) -> User:
    user_id = validate_ticket(ticket)
    if user_id is None:
        raise ValueError("Invalid or expired ticket")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user is None:
            raise ValueError("User not found")
        if not user.is_active:
            raise ValueError("Inactive user")
        return user
    finally:
        db.close()


async def _ensure_room(session_id: str) -> ChatRoom:
    async with ws_manager._room_lock:
        if session_id not in ws_manager.rooms:
            ws_manager.rooms[session_id] = ChatRoom(session_id)
        return ws_manager.rooms[session_id]


async def _add_conn_to_room(conn: Connection, session_id: str):
    old_session_id = conn.session_id
    if old_session_id and old_session_id != session_id:
        await _remove_conn_from_room(conn)

    conn.session_id = session_id
    room = await _ensure_room(session_id)
    await room.add(conn)

    async with ws_manager._stream_lock:
        ss = ws_manager.stream_sessions.get(session_id)
        if ss and ss.is_active:
            await room.sync_connection(conn, ss)
            ss.subscribers.add(conn)


async def _remove_conn_from_room(conn: Connection):
    session_id = conn.session_id
    if not session_id:
        return
    async with ws_manager._room_lock:
        room = ws_manager.rooms.get(session_id)
        if room:
            empty = await room.remove(conn)
            if empty:
                del ws_manager.rooms[session_id]
    async with ws_manager._stream_lock:
        ss = ws_manager.stream_sessions.get(session_id)
        if ss:
            ss.subscribers.discard(conn)
    conn.session_id = ""


def _rollback_last_user_message(db_model, session_id: str) -> None:
    """M-7 修复: 同会话已有 active 生成任务时，回滚刚落库的用户消息。

    避免出现「用户消息已存在但没有回复」的数据不一致（普通聊天走
    ChatMessage，character-chat 走 CharacterChatMessage）。
    """
    rollback_db = SessionLocal()
    try:
        last_user = (
            rollback_db.query(db_model)
            .filter(
                db_model.session_id == session_id,
                db_model.role == "user",
            )
            .order_by(db_model.created_at.desc(), db_model.id.desc())
            .first()
        )
        if last_user is not None:
            rollback_db.delete(last_user)
            rollback_db.commit()
    finally:
        rollback_db.close()


async def _send_stream_busy_error(conn: Connection) -> None:
    """M-7 修复: 向前端发送「会话生成中」的明确错误提示。"""
    await conn.websocket.send_text(json.dumps({
        "type": "error",
        "message": "该会话已有生成任务进行中，请等待完成后再发送。",
    }, ensure_ascii=False))


async def run_chat_generation(
    ss,
    session_id: str,
    user_id: int,
    messages: list,
    model: str,
    is_new_session: bool,
    web_search_results: list,
    web_search_query: str,
    memory_mode: str,
    user_message: str,
    enable_tools: bool = True,
    user_message_id: Optional[int] = None,
    # N-2 修复: 函数体 stream_text_completion 调用引用此二形参，缺失即 NameError
    # 导致 WS 普通聊天路径整体不可用（对齐 run_character_chat_generation 签名）
    reasoning_effort: Optional[str] = None,
    provider_id: Optional[str] = None,
):
    result = StreamResult()
    save_db = SessionLocal()
    assistant_message_id = None
    last_saved_content_len = 0
    last_saved_reasoning_len = 0
    last_flush_ts = 0.0
    memory_stored = False

    def persist_snapshot(force: bool = False):
        nonlocal assistant_message_id, last_saved_content_len, last_saved_reasoning_len, last_flush_ts

        if not result.has_content:
            return

        content_delta = len(result.full_content) - last_saved_content_len
        reasoning_delta = len(result.full_reasoning) - last_saved_reasoning_len
        changed = content_delta > 0 or reasoning_delta > 0

        if not force:
            if not changed:
                return
            if content_delta < 80 and reasoning_delta < 80 and (time.monotonic() - last_flush_ts) < 1.0:
                return

        # [REASONING-SEPARATE] 纯正文入库；思考经 extra.reasoning 单独持久化
        final = result.full_content
        token_count = result.token_count()
        extra_payload = json.dumps({"reasoning": result.full_reasoning}, ensure_ascii=False) if result.full_reasoning else None

        try:
            if assistant_message_id is None:
                msg = ChatMessage(
                    session_id=session_id,
                    role="assistant",
                    content=final,
                    model=model,
                    tokens=token_count,
                    prompt_tokens=result.prompt_tokens,
                    reasoning_tokens=result.effective_reasoning_tokens(),
                    extra=extra_payload,
                )
                save_db.add(msg)
                save_db.commit()
                save_db.refresh(msg)
                assistant_message_id = msg.id
            else:
                msg = save_db.query(ChatMessage).filter(ChatMessage.id == assistant_message_id).first()
                if msg is None:
                    msg = ChatMessage(
                        session_id=session_id,
                        role="assistant",
                        content=final,
                        model=model,
                        tokens=token_count,
                        prompt_tokens=result.prompt_tokens,
                        reasoning_tokens=result.effective_reasoning_tokens(),
                        extra=extra_payload,
                    )
                    save_db.add(msg)
                    save_db.commit()
                    save_db.refresh(msg)
                    assistant_message_id = msg.id
                else:
                    msg.content = final
                    msg.model = model
                    msg.tokens = token_count
                    msg.prompt_tokens = result.prompt_tokens
                    msg.reasoning_tokens = result.effective_reasoning_tokens()
                    # [REASONING-SEPARATE] 快照更新同步刷新 extra.reasoning
                    apply_message_extra_patch(msg, {"reasoning": result.full_reasoning} if result.full_reasoning else {})
                    save_db.commit()

            last_saved_content_len = len(result.full_content)
            last_saved_reasoning_len = len(result.full_reasoning)
            last_flush_ts = time.monotonic()
        except Exception as persist_error:
            save_db.rollback()
            logger.warning("Failed to persist assistant snapshot: %s", persist_error)

    async def maybe_broadcast_image_event():
        if assistant_message_id is None or not result.has_content:
            return
        if result.full_content.strip().startswith("Error:"):
            return
        try:
            assistant_msg = save_db.query(ChatMessage).filter(ChatMessage.id == assistant_message_id).first()
            current_user = save_db.query(User).filter(User.id == user_id).first()
            if not assistant_msg or not current_user:
                return
            context_messages = (
                save_db.query(ChatMessage)
                .filter(ChatMessage.session_id == session_id, ChatMessage.id <= assistant_msg.id)
                .order_by(ChatMessage.id.desc())
                .limit(8)
                .all()
            )
            image = await maybe_generate_image_for_message(
                save_db,
                current_user,
                assistant_msg,
                list(reversed(context_messages)),
                target="chat",
            )
            if image:
                await ws_manager.broadcast_to_session(session_id, {
                    "type": "message_image_generated",
                    "message_id": assistant_msg.id,
                    "image": image_result_to_dict(image),
                    "image_url": image.image_url,
                    "content": assistant_msg.content,
                })
        except Exception as image_error:
            save_db.rollback()
            logger.warning("Auto image generation failed: %s", image_error)
            await ws_manager.broadcast_to_session(session_id, {
                "type": "message_image_generation_failed",
                "message_id": assistant_message_id,
                "error": "自动图片生成失败",
            })

    try:
        if is_new_session:
            await ws_manager.broadcast_to_session(session_id, {
                "type": "session_created",
                "session_id": session_id,
            })

        if web_search_results:
            await ws_manager.broadcast_to_session(session_id, {
                "type": "web_search",
                "query": web_search_query,
                "results": web_search_results,
            })

        mcp_tools = []
        if enable_tools:
            try:
                mcp_tools = await get_all_tools_openai_format()
            except Exception as e:
                logger.warning("Failed to fetch MCP tools: %s", e)

        # [EMPTY-RESP-RETRY] 同角色扮演路径：模型偶发空响应自动重试一次，空/Error 不入库。
        for _attempt in range(2):
            stream = stream_text_completion(
                model_id=model,
                messages=messages,
                temperature=0.7,
                timeout=30.0,
                request_id="auto",
                user_id=user_id,
                reasoning_effort=reasoning_effort,
                provider_id=provider_id,
                tools=mcp_tools if mcp_tools else None,
            )

            async for delta in stream:
                if delta.get("type") == "queue":
                    await ws_manager.broadcast_to_session(session_id, delta)
                    continue

                usage = delta.get("usage")
                if usage:
                    result.total_tokens = int(usage.get("total_tokens", 0) or 0)
                    result.prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
                    result.completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                    _rt = int(usage.get("reasoning_tokens", 0) or 0)
                    if not _rt:
                        _details = usage.get("completion_tokens_details") or {}
                        _rt = int(_details.get("reasoning_tokens", 0) or 0)
                    result.reasoning_tokens = _rt
                    result.cache_creation_input_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
                    prompt_details = usage.get("prompt_tokens_details") or {}
                    result.cache_read_input_tokens = int(usage.get("cache_read_input_tokens", 0) or prompt_details.get("cached_tokens", 0) or 0)
                    continue

                if enable_tools:
                    tool_call = delta.get("tool_call")
                    if tool_call:
                        await ws_manager.broadcast_to_session(session_id, {
                            "type": "tool_call",
                            "id": tool_call.get("id", ""),
                            "name": tool_call.get("name", ""),
                            "arguments": tool_call.get("arguments", {}),
                        })
                        continue

                    tool_result = delta.get("tool_result")
                    if tool_result:
                        await ws_manager.broadcast_to_session(session_id, {
                            "type": "tool_result",
                            "id": tool_result.get("id", ""),
                            "name": tool_result.get("name", ""),
                            "content": tool_result.get("content", "")[:2000],
                        })
                        continue

                reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                content = delta.get("content")
                if content or reasoning:
                    await ws_manager.send_chunk(
                        session_id,
                        content=content or "",
                        reasoning=reasoning or "",
                    )
                    if reasoning:
                        result.full_reasoning += reasoning
                    if content:
                        result.full_content += content
                    # 同步正则重处理 + DB commit 极慢, 丢到线程池, 避免阻塞事件循环导致全站冻结
                    await asyncio.to_thread(persist_snapshot)

            persist_snapshot(force=True)

            if result.full_content or result.full_reasoning:
                break
            logger.warning("EMPTY-RESP-RETRY auto-chat session=%s attempt=%d/2", session_id, _attempt + 1)
            # 指数退避：模型网关故障窗口通常持续数十秒，给恢复时间再重试
            await asyncio.sleep(4 * (2 ** _attempt))
            result.full_content = ""
            result.full_reasoning = ""
            result.total_tokens = 0
            result.prompt_tokens = 0
            result.completion_tokens = 0
            result.reasoning_tokens = 0

        # [EMPTY-RESP-FIX] 判定改为「无正文」而非「无任何内容」：模型偶发只输出
        # <think> 思考无正文（reasoning-only），对用户同样是"没输出"，应报错不显示。
        if not result.full_content:
            logger.error(
                "[NO-CONTENT-FINAL] session=%s 重试后仍无正文 reasoning_len=%d（reasoning-only，已向用户报错）",
                session_id, len(result.full_reasoning or ""),
            )
            result.full_content = "Error: 模型网关暂时无响应（连续多次返回空内容），请稍后重试或切换模型。"
            await ws_manager.send_error(session_id, result.full_content)
            return

        usage_info = None
        if result.total_tokens > 0:
            usage_info = {
                "total_tokens": result.total_tokens,
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "reasoning_tokens": result.effective_reasoning_tokens(),
                "cache_creation_input_tokens": result.cache_creation_input_tokens,
                "cache_read_input_tokens": result.cache_read_input_tokens,
            }
            await ws_manager.broadcast_to_session(session_id, {"type": "usage", **usage_info})

        await maybe_broadcast_image_event()
        await ws_manager.send_done(session_id, usage=usage_info)

    except asyncio.CancelledError:
        # [DIAG] 此路径此前零日志，"第二轮报错"排查时无法区分用户取消/超时取消
        logger.warning(
            "[STREAM-CANCELLED] session=%s content_len=%d reasoning_len=%d（用户断开或超时取消）",
            session_id, len(result.full_content or ""), len(result.full_reasoning or ""),
        )
        if not result.has_content:
            result.full_content = "Error: 请求已中断，未收到模型回复。"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, "Generation was cancelled")
        raise
    except ServiceError:
        logger.exception("Chat stream service error")
        if not result.has_content:
            result.full_content = "Error: Service error"
        else:
            result.full_content += "\n\n[Service error]"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, result.full_content)
    except Exception:
        logger.exception("Chat stream error")
        if not result.has_content:
            result.full_content = "Error: Internal error"
        else:
            result.full_content += "\n\n[推理中断: Internal error]"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, result.full_content)
    finally:
        try:
            persist_snapshot(force=True)
            if memory_mode != "disabled" and result.full_content and not memory_stored:
                try:
                    if not result.full_content.strip().startswith("Error:"):
                        mem_svc = MemoryService(save_db)
                        if mem_svc.is_available():
                            # [MEM-UPSERT] 记忆 = 消息当前内容的镜像：同 message_id 先删后写（幂等）。
                            # 覆盖：重试路径重复写入；user_message_id 为 None 时保持存量兼容。
                            if user_message_id is not None:
                                delete_by_message_id(save_db, session_id, user_message_id)
                            mem_svc.store_memory(user_id, session_id, "user", user_message,
                                                 message_id=user_message_id)
                            # [MEMORY-POLLUTION-FIX] assistant 入库前清洗功能块/思维链
                            if assistant_message_id is not None:
                                delete_by_message_id(save_db, session_id, assistant_message_id)
                            mem_svc.store_memory(user_id, session_id, "assistant", clean_memory_content(result.full_content),
                                                 message_id=assistant_message_id)
                            save_db.commit()
                            memory_stored = True
                except Exception as e:
                    save_db.rollback()
                    logger.warning("Memory storage failed: %s", e)
        finally:
            save_db.close()


def _run_secondary_mvu_sync(
    save_db,
    user_id: int,
    char_ext_raw: dict,
    stat_data: dict,
    story_text: str,
    main_loop,
) -> tuple[list, list[str]]:
    """同步包装：查询副 AI 配置，若开启则跨线程调副模型生成变量 patches。

    返回 (patches, logs)。未配置/未开启/调用失败均返回 ([], [])，不抛异常。
    persist_snapshot 可能在 to_thread 线程运行，故用 run_coroutine_threadsafe
    把副 AI 协程提交到主事件循环执行。
    """
    try:
        from app.models import UserSetting
        us = save_db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        if us is None:
            return [], []
        if not us.mvu_secondary_enabled:
            return [], []
        sec_model = (us.mvu_secondary_model or "").strip()
        if not sec_model:
            return [], []
    except Exception as exc:
        logger.warning("MVU secondary config load failed: %s", exc)
        return [], []

    try:
        from app.services.mvu_engine import extract_schema_defaults
        from app.services.mvu_secondary import run_secondary_mvu
        schema_defaults = extract_schema_defaults(
            char_ext_raw.get("tavern_helper") if isinstance(char_ext_raw, dict) else None
        )
        # [MVU-SECONDARY-GUARD] 无 schema = 角色卡没有变量系统/面板，副 AI 不介入，
        # 避免对无变量系统的卡乱生成变量（特调/乱输出防护）。仅当卡定义了
        # tavern_helper schema（z.object）时才触发副 AI。
        if not schema_defaults:
            return [], []
        coro = run_secondary_mvu(
            secondary_model=sec_model,
            stat_data=stat_data,
            story_text=story_text,
            schema_defaults=schema_defaults,
        )
        future = asyncio.run_coroutine_threadsafe(coro, main_loop)
        patches, logs = future.result(timeout=90)
        return patches, logs
    except Exception as exc:
        logger.warning("MVU secondary AI failed: %s", exc)
        return [], []


async def run_character_chat_generation(
    ss,
    session_id: str,
    branch_id: str,
    user_id: int,
    messages: list,
    model: str,
    is_new_session: bool,
    memory_mode: str,
    user_message: str,
    # P2-8 修复: continue_message_id 非空时，续写模式 — 追加到最后一条 AI 消息
    # 而非创建新消息（对齐 ST slash-commands.js:1845 /continue 语义）
    continue_message_id: Optional[int] = None,
    char_extensions=None,
    character_name: str = "Character",
    user_name: str = "User",
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 2048,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    min_p: float = 0.05,
    top_k: int = 40,
    repetition_penalty: float = 1.1,
    enable_thinking: Optional[bool] = None,
    reasoning_effort: Optional[str] = None,
    provider_id: Optional[str] = None,
    logit_bias: Optional[Dict[str, int]] = None,
    store_user_memory: bool = True,
    user_message_id: Optional[int] = None,
    char=None,
    # Task 3.4.3: 前端序列化的插件 function tool（OpenAI 格式）
    tools: Optional[list] = None,
):
    result = StreamResult()
    save_db = SessionLocal()
    # [MVU-SECONDARY] 主事件循环引用：persist_snapshot 可能在 to_thread 线程运行，
    # 副 AI 协程需跨线程提交到主循环执行（asyncio.run_coroutine_threadsafe）。
    _main_loop = asyncio.get_running_loop()
    # P2-8 修复: 续写模式下预设 assistant_message_id，使 persist 更新而非创建新消息
    assistant_message_id = continue_message_id
    # 记录原始内容长度，用于续写时追加（而非替换）
    _continue_original_content = ""
    if continue_message_id is not None:
        try:
            _orig_msg = save_db.query(CharacterChatMessage).filter(
                CharacterChatMessage.id == continue_message_id
            ).first()
            if _orig_msg is not None:
                _continue_original_content = _orig_msg.content or ""
        except Exception:
            pass
    last_saved_content_len = 0
    last_saved_reasoning_len = 0
    last_flush_ts = 0.0
    # Phase 3 extra 字段: gen_id 自动生成 + reasoning_duration 计时
    # ST 1.18.0 对齐: bookmarks.js:419 在生成时自动分配 gen_id 用于 swipe 分组
    import uuid as _uuid_mod
    stream_gen_id = _uuid_mod.uuid4().hex[:8]
    stream_start_ts = time.monotonic()
    status_stripper = StreamingStatusStripper()
    mvu_variables_saved = False
    mvu_latest_variables: dict | None = None

    def persist_snapshot(force: bool = False):
        nonlocal assistant_message_id, last_saved_content_len, last_saved_reasoning_len, last_flush_ts, mvu_variables_saved, mvu_latest_variables

        # [EMPTY-RESP-FIX] 空响应/仅思考无正文时不入库：模型偶发返回空（200 OK 但无
        # content/reasoning）或只有 <think> 无正文，若把 "Error: ..." 或 think 残渣存成
        # assistant 消息，会污染历史 → 后续重试提示词带 Error 历史 → 越重试越失败
        # （2026-08-18 实测：2175/2177/2181 三条 Error 消息入库后该会话连续失败）。
        if not result.full_content:
            return
        if result.full_content.strip().startswith("Error:"):
            return

        content_delta = len(result.full_content) - last_saved_content_len
        reasoning_delta = len(result.full_reasoning) - last_saved_reasoning_len
        changed = content_delta > 0 or reasoning_delta > 0

        if not force:
            if not changed:
                return
            if content_delta < 80 and reasoning_delta < 80 and (time.monotonic() - last_flush_ts) < 1.0:
                return

        # [THINK-DEDUP] 用 full_content 而非 final_text()：final_text() 会把
        # full_reasoning 包成 <think> 前缀拼在正文前，而下方 574 行还会再拼一次
        # regexed_reasoning 的 <think>，导致入库 content 出现两份重复思维链
        # （2026-08-18 实测 2198：双 <think> 块，用户看到思维链"泄露/重复"）。
        final_raw = result.full_content
        # 剥离历史残留的 palink-status 标记（防御性清理，不再解析/保存状态栏配置）
        final_raw, _ = strip_and_parse_status_marker(final_raw, char, force=force)
        # [THINK-IN-CONTENT-FIX] 模型可能把思维链直接写进 content（reasoning 字段为空，
        # content 里带  thinking... response 块，2026-08-18 实测 598/600/1292/2207）。
        # 在下方拼 reasoning 前缀之前剥离，避免思维链污染入库正文（前端显示"思维链泄露"）。
        # 剥离后为空（纯思维链无正文）时保留原始，避免入库空消息。
        _clean_raw = re.sub(r"<think[\s\S]*?</think\s*>", "", final_raw, flags=re.IGNORECASE).strip()
        if _clean_raw:
            final_raw = _clean_raw
        final = _apply_persist_regex_to_display_text(
            final_raw,
            save_db,
            char,
            user_name=user_name or "User",
            placement=REGEX_PLACEMENT_AI_OUTPUT,
            depth=0,
        )
        if result.full_reasoning:
            regexed_reasoning = _apply_plugin_regex_scripts(
                result.full_reasoning,
                save_db,
                placement=REGEX_PLACEMENT_REASONING,
                is_markdown=False,
                is_prompt=False,
                depth=0,
                skip_extensions=char_extensions,
                user_name=user_name or "User",
                char_name=character_name or "Character",
            )
            regexed_reasoning = _apply_regex_scripts(
                regexed_reasoning,
                char_extensions,
                placement=REGEX_PLACEMENT_REASONING,
                is_markdown=False,
                is_prompt=False,
                depth=0,
                user_name=user_name or "User",
                char_name=character_name or "Character",
            )
            # [REASONING-SEPARATE] 思考不再内联包裹进 content，仅经 msg_extra.reasoning 持久化
            # （与 Step 4 前端消费点迁移同批上线）
        token_count = result.token_count()

        # Phase 3 extra 字段: reasoning 双写 + gen_id + per-swipe 元数据
        # ST 1.18.0 对齐: reasoning 同时写入 content 内联(包裹符号, 兼容旧前端)
        # 和 extra.reasoning(供 ST Native 前端 reasoning 面板使用)
        msg_extra: dict = {}
        msg_extra["gen_id"] = stream_gen_id
        if result.full_reasoning:
            msg_extra["reasoning"] = regexed_reasoning
            msg_extra["reasoning_type"] = "thinking"
            msg_extra["reasoning_duration"] = round(time.monotonic() - stream_start_ts, 3)
        msg_extra["model"] = model
        msg_extra["token_count"] = token_count

        # MVU 变量引擎：解析 <UpdateVariable> JSON Patch → 更新会话 stat_data（仅 force 时）
        if force and not mvu_variables_saved:
            try:
                from app.services.mvu_engine import (
                    MvuEngine,
                    merge_character_book_entries,
                )
                # [MVU-DETACHED-FIX] char 参数来自 ws 调用方会话（gen_db 已 close，实例
                # detached），直接访问 char.world_books 触发 lazy load 必抛
                # "Parent instance is not bound to a Session" → 整个 MVU 更新失败、
                # variables 永不下发（2026-08-17 实测 26 次失败 / 0 成功）。
                # 用 save_db 重新加载并 eager load world_books.entries，读到的仍是同一角色。
                from sqlalchemy.orm import selectinload
                _mvu_char = None
                if char is not None and getattr(char, "id", None):
                    try:
                        _mvu_char = (
                            save_db.query(Character)
                            .options(
                                selectinload(Character.world_books).selectinload(WorldBook.entries)
                            )
                            .filter(Character.id == char.id)
                            .first()
                        )
                    except Exception:
                        _mvu_char = None
                char_ext_raw: dict = {}
                if _mvu_char is not None and getattr(_mvu_char, "extensions", None):
                    try:
                        raw_ext = _mvu_char.extensions
                        char_ext_raw = json.loads(raw_ext) if isinstance(raw_ext, str) else (raw_ext if isinstance(raw_ext, dict) else {})
                    except (json.JSONDecodeError, TypeError):
                        pass
                # character_book 存在 world_books 表而非 extensions，需合并其 entry content
                # 供 build_initial_stat_data 提取 <initvar>（头像 URL/服饰/内心想法等初始值）。
                wb_entries = [
                    str(stage.content or "")
                    for wb in ((_mvu_char.world_books) if _mvu_char is not None else [])
                    if getattr(wb, "type", "") == "character_book"
                    for stage in (wb.entries or [])
                ]
                char_ext_raw = merge_character_book_entries(char_ext_raw, wb_entries)
                sess = save_db.query(CharacterChatSession).filter(
                    CharacterChatSession.id == session_id
                ).first()
                if sess is not None:
                    cur_meta: dict = {}
                    if sess.chat_metadata:
                        try:
                            cur_meta = json.loads(sess.chat_metadata)
                            if not isinstance(cur_meta, dict):
                                cur_meta = {}
                        except (json.JSONDecodeError, TypeError):
                            pass
                    cur_vars = cur_meta.get("variables")
                    if not isinstance(cur_vars, dict) or not cur_vars.get("stat_data"):
                        cur_vars = MvuEngine.init_session_variables(char_ext_raw)
                    new_vars, mvu_logs = MvuEngine.update_from_reply(
                        cur_vars, final_raw, char_ext_raw
                    )
                    # [MVU-SECONDARY-MANUAL] 副 AI 已改为全手动模式：
                    # 不再在 persist 阶段自动调用副模型解析剧情（此前 90s 同步阻塞
                    # 会导致主流程收尾停滞、界面"生成完但一直转圈"）。
                    # 需要变量更新时由用户在前端消息按钮手动触发
                    # POST /api/character-sessions/{session_id}/mvu-secondary。
                    cur_meta["variables"] = new_vars
                    sess.chat_metadata = json.dumps(cur_meta, ensure_ascii=False)
                    msg_extra["variables"] = new_vars
                    mvu_latest_variables = new_vars
                    mvu_variables_saved = True
                    if mvu_logs:
                        logger.info("MVU variables updated: %s", "; ".join(mvu_logs[:8]))
            except Exception as mvu_err:
                logger.warning("MVU variable update failed: %s", mvu_err, exc_info=True)
        elif mvu_latest_variables is not None:
            msg_extra["variables"] = mvu_latest_variables

        # MVU 解析后剥离 <UpdateVariable> 指令块，避免正文泄漏 stat_data 更新指令
        # （Time passed / Variable updates / JSON patch 数组等）。stat_data 更新基于
        # 剥离前的 final_raw 已在上面完成，此处剥离仅作用于落库正文（含 swipe），
        # 流式结束后的 final_content 推送亦取自剥离后的 msg.content，前端显示干净。
        from app.services.mvu_engine import strip_update_variable_blocks
        final = strip_update_variable_blocks(final)

        try:
            if assistant_message_id is None:
                msg = CharacterChatMessage(
                    session_id=session_id,
                    branch_id=branch_id,
                    role="assistant",
                    content=final,
                    model=model,
                    tokens=token_count,
                    prompt_tokens=result.prompt_tokens,
                    reasoning_tokens=result.effective_reasoning_tokens(),
                    **_st_message_kwargs(
                        role="assistant",
                        content=final,
                        char_name=character_name or "Character",
                        user_name=user_name or "User",
                        extra=msg_extra,
                        gen_id=stream_gen_id,
                    ),
                )
                save_db.add(msg)
                save_db.commit()
                save_db.refresh(msg)
                assistant_message_id = msg.id
            else:
                msg = save_db.query(CharacterChatMessage).filter(
                    CharacterChatMessage.id == assistant_message_id
                ).first()
                if msg is None:
                    msg = CharacterChatMessage(
                        session_id=session_id,
                        branch_id=branch_id,
                        role="assistant",
                        content=final,
                        model=model,
                        tokens=token_count,
                        prompt_tokens=result.prompt_tokens,
                        reasoning_tokens=result.effective_reasoning_tokens(),
                        **_st_message_kwargs(
                            role="assistant",
                            content=final,
                            char_name=character_name or "Character",
                            user_name=user_name or "User",
                            extra=msg_extra,
                            gen_id=stream_gen_id,
                        ),
                    )
                    save_db.add(msg)
                    save_db.commit()
                    save_db.refresh(msg)
                    assistant_message_id = msg.id
                else:
                    # P2-8 修复: 续写模式下追加内容到原始内容之后，而非替换
                    if continue_message_id is not None and _continue_original_content:
                        msg.content = _continue_original_content + final
                        # 同步到当前 swipe（追加模式）
                        current_swipes_for_continue = _message_swipes(msg)
                        if current_swipes_for_continue and msg.swipe_id < len(current_swipes_for_continue):
                            current_swipes_for_continue[msg.swipe_id] = msg.content
                            msg.swipes = _json_dump_or_none(current_swipes_for_continue)
                    else:
                        msg.content = final
                    msg.model = model
                    msg.tokens = token_count
                    msg.prompt_tokens = result.prompt_tokens
                    msg.reasoning_tokens = result.effective_reasoning_tokens()
                    if not msg.name:
                        msg.name = character_name or "Character"
                    msg.is_user = False
                    msg.is_system = False
                    current_swipes = _message_swipes(msg)
                    if not current_swipes or current_swipes == [""]:
                        msg.swipes = _json_dump_or_none([final])
                    elif msg.swipe_id == 0:
                        current_swipes[0] = final
                        msg.swipes = _json_dump_or_none(current_swipes)
                    # Phase 3 extra 字段更新: 合并 msg_extra 到现有 msg.extra (保留 swipe_info)
                    # ST 1.18.0 对齐: reasoning/gen_id/per-swipe 元数据 round-trip
                    try:
                        existing_extra: dict = {}
                        raw_extra = getattr(msg, "extra", None)
                        if raw_extra:
                            try:
                                parsed = json.loads(raw_extra)
                                if isinstance(parsed, dict):
                                    existing_extra = parsed
                            except (json.JSONDecodeError, TypeError):
                                pass
                        existing_extra.update(msg_extra)
                        msg.extra = _json_dump_or_none(existing_extra)
                    except Exception:
                        logger.warning("Failed to update msg.extra with Phase 3 fields", exc_info=True)
                    save_db.commit()

            last_saved_content_len = len(result.full_content)
            last_saved_reasoning_len = len(result.full_reasoning)
            last_flush_ts = time.monotonic()
        except Exception as persist_error:
            save_db.rollback()
            logger.warning("Failed to persist character chat snapshot: %s", persist_error)

    async def maybe_broadcast_image_event():
        if assistant_message_id is None or not result.has_content:
            return
        if result.full_content.strip().startswith("Error:"):
            return
        try:
            assistant_msg = save_db.query(CharacterChatMessage).filter(
                CharacterChatMessage.id == assistant_message_id
            ).first()
            current_user = save_db.query(User).filter(User.id == user_id).first()
            session = save_db.query(CharacterChatSession).filter(CharacterChatSession.id == session_id).first()
            character = None
            if session:
                character = save_db.query(Character).filter(Character.id == session.character_id).first()
            if not assistant_msg or not current_user:
                return
            context_messages = (
                save_db.query(CharacterChatMessage)
                .filter(
                    CharacterChatMessage.session_id == session_id,
                    CharacterChatMessage.branch_id == assistant_msg.branch_id,
                    CharacterChatMessage.id <= assistant_msg.id,
                )
                .order_by(CharacterChatMessage.id.desc())
                .limit(8)
                .all()
            )
            image = await maybe_generate_image_for_message(
                save_db,
                current_user,
                assistant_msg,
                list(reversed(context_messages)),
                target="character",
                character=character,
            )
            if image:
                await ws_manager.broadcast_to_session(session_id, {
                    "type": "message_image_generated",
                    "message_id": assistant_msg.id,
                    "image": image_result_to_dict(image),
                    "image_url": image.image_url,
                    "content": assistant_msg.content,
                })
        except Exception as image_error:
            save_db.rollback()
            logger.warning("Auto character image generation failed: %s", image_error)
            await ws_manager.broadcast_to_session(session_id, {
                "type": "message_image_generation_failed",
                "message_id": assistant_message_id,
                "error": "自动图片生成失败",
            })

    try:
        if is_new_session:
            await ws_manager.broadcast_to_session(session_id, {
                "type": "session_created",
                "session_id": session_id,
                "branch_id": branch_id,
            })

        # [GEN-STARTED] 流式开始前推送生成状态事件：模型网关（opencode.ai）响应慢时
        # 首个 chunk 可能数十秒后才到，前端若只等 chunk 会误判"没回复"并弹超时警告
        # （2026-08-18 实测：连接重试 31s + 生成 64s，前端 15s 就警告）。先推送
        # generation_started，前端据此清除超时警告并显示"正在生成"。
        await ws_manager.broadcast_to_session(session_id, {"type": "generation_started"})

        # [EMPTY-RESP-RETRY] 模型偶发空响应（HTTP 200 但无 content/reasoning 增量，
        # opencode.ai 网关实测出现）：自动重试。失败不入库（persist_snapshot
        # 已跳过空/Error 文本），重试提示词保持干净，避免 Error 历史污染恶性循环。
        # 仅当「完全空」时重试；只输出  thinking 无正文（reasoning-only）不重试，
        # 防止前端收到重复思考流。
        # 2026-08-18 实测：网关间歇性空响应（直连 3 次中 1 次 reasoning-only），
        # 2 次重试不够（生产连续 2 次全空 → 报错）。增至 3 次 + 退避 4s/8s/16s。
        for _attempt in range(3):
            stream = stream_text_completion(
                model_id=model,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                frequency_penalty=frequency_penalty,
                presence_penalty=presence_penalty,
                min_p=min_p,
                top_k=top_k,
                repetition_penalty=repetition_penalty,
                timeout=30.0,
                request_id=session_id,
                user_id=user_id,
                enable_thinking=enable_thinking,
                reasoning_effort=reasoning_effort,
                provider_id=provider_id,
                logit_bias=logit_bias,
                # Task 3.4.3/3.4.4: 传递前端 function tool，并通过 WebSocket
                # 请求前端执行 handler（替代后端 MCP 执行）
                tools=tools,
                tool_executor=(
                    lambda tool_name, tool_call_id, tool_args: ws_manager.request_tool_call(
                        session_id, tool_call_id, tool_name, tool_args
                    )
                ) if tools else None,
            )

            async for delta in stream:
                if delta.get("type") == "queue":
                    await ws_manager.broadcast_to_session(session_id, delta)
                    continue

                usage = delta.get("usage")
                if usage:
                    result.total_tokens = int(usage.get("total_tokens", 0) or 0)
                    result.prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
                    result.completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                    _rt = int(usage.get("reasoning_tokens", 0) or 0)
                    if not _rt:
                        _details = usage.get("completion_tokens_details") or {}
                        _rt = int(_details.get("reasoning_tokens", 0) or 0)
                    result.reasoning_tokens = _rt
                    result.cache_creation_input_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
                    prompt_details = usage.get("prompt_tokens_details") or {}
                    result.cache_read_input_tokens = int(usage.get("cache_read_input_tokens", 0) or prompt_details.get("cached_tokens", 0) or 0)
                    continue

                reasoning = delta.get("reasoning")
                content = delta.get("content")
                # 当思考模式关闭时，将 reasoning 合并到 content 显示
                if enable_thinking is False and reasoning:
                    if not content:
                        content = reasoning
                    reasoning = ""
                # 流式层剥离 palink-status 标记（跨 chunk 缓冲）
                push_content = status_stripper.feed(content) if content else ""
                if push_content or reasoning:
                    await ws_manager.send_chunk(
                        session_id,
                        content=push_content or "",
                        reasoning=reasoning or "",
                    )
                    if reasoning:
                        result.full_reasoning += reasoning
                    if content:
                        result.full_content += content
                    # 同步正则重处理 + DB commit 极慢, 丢到线程池, 避免阻塞事件循环导致全站冻结
                    await asyncio.to_thread(persist_snapshot)

            persist_snapshot(force=True)

            # [REASONING-ONLY-RETRY] 2026-08-18：有思考无正文（reasoning-only）同样
            # 视为失败并重试。此前 break 条件含 full_reasoning，reasoning-only 直接
            # 跳过重试走 922 报错路径（零日志），实测"第二轮 100% 报错"即此路径：
            # HTTP 200 但只有思考流，用户端只见 Error。重试期间清空状态，前端会
            # 收到第二段思考流（可接受，优于直接报错）。
            if result.full_content:
                break
            _rr_tail = (result.full_reasoning[-200:]) if result.full_reasoning else ""
            logger.warning(
                "EMPTY-RESP-RETRY session=%s attempt=%d/3 content_len=%d reasoning_len=%d reasoning_tail=%r",
                session_id, _attempt + 1, len(result.full_content or ""),
                len(result.full_reasoning or ""), _rr_tail,
            )
            # 指数退避：模型网关故障窗口通常持续数十秒，给恢复时间再重试
            await asyncio.sleep(4 * (2 ** _attempt))
            result.full_content = ""
            result.full_reasoning = ""
            result.total_tokens = 0
            result.prompt_tokens = 0
            result.completion_tokens = 0
            result.reasoning_tokens = 0
            status_stripper = StreamingStatusStripper()

        # [EMPTY-RESP-FIX] 判定改为「无正文」而非「无任何内容」：模型偶发只输出
        # <think> 思考无正文（reasoning-only），对用户同样是"没输出"，应报错不显示。
        if not result.full_content:
            logger.error(
                "[NO-CONTENT-FINAL] session=%s 重试后仍无正文 reasoning_len=%d（reasoning-only，已向用户报错）",
                session_id, len(result.full_reasoning or ""),
            )
            result.full_content = "Error: 模型网关暂时无响应（连续多次返回空内容），请稍后重试或切换模型。"
            await ws_manager.send_error(session_id, result.full_content)
            return

        usage_info = None
        if result.total_tokens > 0:
            usage_info = {
                "total_tokens": result.total_tokens,
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "reasoning_tokens": result.effective_reasoning_tokens(),
                "cache_creation_input_tokens": result.cache_creation_input_tokens,
                "cache_read_input_tokens": result.cache_read_input_tokens,
            }
            await ws_manager.broadcast_to_session(session_id, {"type": "usage", **usage_info})

        if assistant_message_id is not None:
            try:
                msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == assistant_message_id).first()
                if msg and msg.content:
                    await ws_manager.broadcast_to_session(session_id, {
                        "type": "final_content",
                        "content": msg.content,
                        "message_id": assistant_message_id,
                        **({"variables": mvu_latest_variables} if mvu_latest_variables is not None else {}),
                    })
            except Exception:
                pass

        await maybe_broadcast_image_event()
        await ws_manager.send_done(session_id, usage=usage_info)

    except asyncio.CancelledError:
        # [DIAG] 此路径此前零日志，"第二轮报错"排查时无法区分用户取消/超时取消
        logger.warning(
            "[STREAM-CANCELLED] session=%s content_len=%d reasoning_len=%d（用户断开或超时取消）",
            session_id, len(result.full_content or ""), len(result.full_reasoning or ""),
        )
        if not result.has_content:
            result.full_content = "Error: 请求已中断，未收到模型回复。"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, "Generation was cancelled")
        raise
    except ServiceError as e:
        logger.exception("Character chat stream service error")
        if not result.has_content:
            result.full_content = "Error: Service error"
        else:
            result.full_content += "\n\n[Service error]"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, result.full_content)
    except Exception as e:
        logger.exception("Character chat stream error")
        if not result.has_content:
            result.full_content = "Error: Internal error"
        else:
            result.full_content += "\n\n[Internal error]"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, result.full_content)
    finally:
        try:
            persist_snapshot(force=True)

            if assistant_message_id is not None:
                try:
                    msg = save_db.query(CharacterChatMessage).filter(
                        CharacterChatMessage.id == assistant_message_id
                    ).first()
                    if msg and msg.short_title is None:
                        short_title = await generate_compact_title(
                            save_db,
                            f"{user_message}\n{result.full_content}",
                            fallback_model_id=model,
                            max_len=10,
                        )
                        msg.short_title = short_title
                        save_db.commit()
                except Exception as e:
                    save_db.rollback()
                    logger.warning("Failed to generate short title: %s", e)

            if memory_mode != "disabled" and result.full_content:
                try:
                    if not result.full_content.strip().startswith("Error:"):
                        mem_svc = MemoryService(save_db)
                        if mem_svc.is_available():
                            # [MEM-UPSERT] 记忆 = 消息当前内容的镜像：同 message_id 先删后写（幂等）。
                            # 覆盖：continue 追加重叠(P3)、swipe 重roll 旧内容残留(P4)、重试路径重复写。
                            if store_user_memory and user_message.strip():
                                if user_message_id is not None:
                                    delete_by_message_id(save_db, session_id, user_message_id)
                                mem_svc.store_memory(
                                    user_id=user_id,
                                    session_id=session_id,
                                    role="user",
                                    content=user_message,
                                    branch_id=branch_id,
                                    message_id=user_message_id,
                                )
                            # [MEMORY-POLLUTION-FIX] assistant 入库前清洗功能块/思维链。
                            # 记忆源取 DB 中消息最终显示内容（persist_snapshot 已含
                            # continue 追加/regex 清洗），保证「记忆=当前内容镜像」：
                            # 续写(P2-8)后为合并全文而非仅本轮增量，修复 P3 重叠。
                            if assistant_message_id is not None:
                                delete_by_message_id(save_db, session_id, assistant_message_id)
                                _asst_db_msg = save_db.query(CharacterChatMessage).filter(
                                    CharacterChatMessage.id == assistant_message_id
                                ).first()
                                _asst_mem_src = (
                                    (_asst_db_msg.content or "")
                                    if _asst_db_msg is not None
                                    else result.full_content
                                ) or result.full_content
                            else:
                                _asst_mem_src = result.full_content
                            mem_svc.store_memory(
                                user_id=user_id,
                                session_id=session_id,
                                role="assistant",
                                content=clean_memory_content(_asst_mem_src),
                                branch_id=branch_id,
                                message_id=assistant_message_id,
                            )
                            save_db.commit()
                except Exception as e:
                    save_db.rollback()
                    logger.warning("Memory storage failed: %s", e)
        finally:
            save_db.close()
            # Task 3.4.4: 清理 tool response 队列，避免内存泄漏
            if tools:
                ws_manager.clear_tool_response_queue(session_id)


@router.websocket("/api/ws/chat")
async def ws_chat(websocket: WebSocket):
    ticket = websocket.query_params.get("ticket")
    if not ticket:
        await websocket.close(code=4001, reason="Missing ticket")
        return

    try:
        user = await authenticate_websocket(ticket)
    except ValueError:
        await websocket.close(code=4001, reason="Invalid ticket")
        return

    await websocket.accept()
    conn = Connection(websocket=websocket, user_id=user.id, session_id="")

    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_json(), timeout=300)
            except asyncio.TimeoutError:
                await websocket.close(code=4000, reason="Idle timeout")
                break
            except Exception:
                break

            msg_type = raw.get("type")

            if msg_type == "chat_request":
                message = raw.get("message", "").strip()
                if not message:
                    await conn.websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Message cannot be empty",
                    }, ensure_ascii=False))
                    continue

                model = raw.get("model", "")
                try:
                    ensure_model_available(model)
                except ValueError as exc:
                    await conn.websocket.send_text(json.dumps({
                        "type": "error",
                        "message": str(exc),
                    }, ensure_ascii=False))
                    continue

                session_id = raw.get("session_id") or ""
                session_type = raw.get("session_type", "chat")
                images = raw.get("images", [])
                files = raw.get("files", [])
                display_content = raw.get("display_content")
                web_search = raw.get("web_search", False)
                temperature = raw.get("temperature", 0.7)
                # N-2 修复: 解析推理努力/供应商并传入 run_chat_generation
                # （解析写法对齐 ws_character_chat 角色扮演侧）
                reasoning_effort = raw.get("reasoning_effort") or None
                provider_id = raw.get("provider_id") or None

                db = SessionLocal()
                try:
                    is_new_session = False
                    if not session_id:
                        session_id = str(uuid.uuid4())
                        is_new_session = True
                        title = message[:30] if message else "New Chat"
                        db.add(ChatSession(
                            id=session_id,
                            user_id=user.id,
                            title=title,
                            type=session_type,
                        ))
                        db.commit()
                    else:
                        existing = db.query(ChatSession).filter(
                            ChatSession.id == session_id,
                            ChatSession.user_id == user.id,
                        ).first()
                        if not existing:
                            await conn.websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Session not found",
                            }, ensure_ascii=False))
                            continue

                    if is_new_session and message:
                        try:
                            compact_title = await generate_compact_title(
                                db, message, fallback_model_id=model, max_len=10,
                            )
                            if compact_title:
                                session_obj = db.query(ChatSession).filter(ChatSession.id == session_id).first()
                                if session_obj:
                                    session_obj.title = compact_title
                                    db.commit()
                        except Exception as e:
                            logger.warning("Compact title failed: %s", e)

                    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
                    memory_mode = user_setting.memory_mode if user_setting else "rule"

                    context_text = ""
                    if files:
                        from ..services.chat_service import ChatService
                        cs = ChatService(db)
                        context_text = cs._process_file_references(files, user.id)

                    final_user_content = message + "\n\n" + context_text if context_text else message

                    # [MEM-UPSERT] flush 取回用户消息主键，供记忆写入按 message_id 关联
                    _user_msg_row = ChatMessage(
                        session_id=session_id,
                        role="user",
                        content=final_user_content,
                        model=model,
                    )
                    db.add(_user_msg_row)
                    db.flush()
                    user_message_id = _user_msg_row.id
                    db.commit()

                    system_parts = [
                        "You are a helpful assistant.",
                        (
                            "Return only the final answer for the user. "
                            "Do not reveal chain-of-thought or internal analysis. "
                            "Never output labels like 'Final Answer', 'Analysis', or 'Thinking'."
                        ),
                        "Reply in the same language as the user unless explicitly requested otherwise.",
                    ]

                    memory_text = None
                    if memory_mode != "disabled":
                        try:
                            mem_svc = MemoryService(db)
                            if mem_svc.is_available():
                                mem_ctx = await mem_svc.get_context(
                                    user_id=user.id,
                                    query=message,
                                    session_id=session_id,
                                    max_tokens=2000,
                                    memory_mode=memory_mode,
                                )
                                memory_text = build_memory_context(mem_ctx, max_tokens=2000)
                        except Exception as e:
                            logger.warning("Memory context retrieval failed: %s", e)

                    # 添加固定标识（session_id），普通聊天没有分支，session_id 是固定的
                    # 注意：同一个会话内 session_id 不变，不会破坏前缀缓存
                    system_content = "\n\n".join(system_parts) + f"\n\n[Conversation: {session_id}]"
                    messages = [{"role": "system", "content": system_content}]

                    latest_ids_subquery = (
                        db.query(ChatMessage.id)
                        .filter(ChatMessage.session_id == session_id)
                        .order_by(ChatMessage.created_at.desc())
                        .limit(settings.CHAT_HISTORY_LIMIT)
                        .subquery()
                    )
                    history = (
                        db.query(ChatMessage)
                        .filter(ChatMessage.id.in_(latest_ids_subquery))
                        .order_by(ChatMessage.created_at)
                        .all()
                    )
                    for m in history[:-1]:
                        msg_content = m.content
                        if m.role == "assistant":
                            msg_content = re.sub(r"<think[\s\S]*?</think\s*>", "", msg_content, flags=re.IGNORECASE).strip()
                            if not msg_content:
                                msg_content = m.content
                        messages.append({"role": m.role, "content": msg_content})

                    if images:
                        content_payload = [{"type": "text", "text": final_user_content}]
                        for img_url in images:
                            normalized_url = normalize_image_url(img_url, user_id=user.id)
                            content_payload.append({
                                "type": "image_url",
                                "image_url": {"url": normalized_url},
                            })
                        messages.append({"role": "user", "content": content_payload})
                    else:
                        messages.append({"role": "user", "content": final_user_content})

                    if memory_text:
                        messages.append({"role": "system", "content": memory_text})

                    web_search_context = ""
                    web_search_results = []
                    if web_search:
                        ws_config = get_web_search_config()
                        if ws_config.get("enabled"):
                            try:
                                search_results = await search_web(message, num_results=5)
                                if search_results:
                                    web_search_results = search_results
                                    web_search_context = format_search_results(search_results, message)
                                    if web_search_context:
                                        messages.append({"role": "system", "content": web_search_context})
                            except Exception as e:
                                logger.warning("Web search failed: %s", e)

                finally:
                    db.close()

                await _add_conn_to_room(conn, session_id)

                async def _gen(ss):
                    await run_chat_generation(
                        ss=ss,
                        session_id=session_id,
                        user_id=user.id,
                        messages=messages,
                        model=model,
                        is_new_session=is_new_session,
                        web_search_results=web_search_results,
                        web_search_query=message,
                        memory_mode=memory_mode,
                        user_message=message,
                        enable_tools=True,
                        user_message_id=user_message_id,
                        # N-2 修复: 传参样式对齐 ws_character_chat 角色扮演侧
                        reasoning_effort=reasoning_effort,
                        provider_id=provider_id,
                    )

                try:
                    await ws_manager.create_stream_session(session_id, user.id, _gen)
                except StreamSessionBusyError:
                    # M-7 修复: 同会话已有 active 生成任务——回滚刚落库的用户
                    # 消息（避免「消息存在、无回复」）并向前端发送明确错误提示。
                    _rollback_last_user_message(ChatMessage, session_id)
                    await _send_stream_busy_error(conn)
                    continue

            elif msg_type == "sync":
                sync_sid = raw.get("session_id", "")
                if sync_sid:
                    db = SessionLocal()
                    try:
                        session = db.query(ChatSession).filter(
                            ChatSession.id == sync_sid,
                            ChatSession.user_id == user.id,
                        ).first()
                    finally:
                        db.close()
                    if not session:
                        await websocket.send_json({"type": "error", "message": "Session not found"})
                        continue
                    if conn.session_id != sync_sid:
                        await _add_conn_to_room(conn, sync_sid)
                    await ws_manager.sync_connection(conn, sync_sid)

            elif msg_type == "ping":
                await conn.websocket.send_text(json.dumps({"type": "pong"}, ensure_ascii=False))

            elif msg_type == "pong":
                ws_manager.handle_pong(conn)

            elif msg_type == "cancel":
                active_ss = None
                if conn.session_id:
                    active_ss = ws_manager.get_stream_session(conn.session_id)
                if active_ss and active_ss.generation_task and not active_ss.generation_task.done():
                    active_ss.generation_task.cancel()

    except Exception:
        logger.exception("WebSocket chat error")
    finally:
        await _remove_conn_from_room(conn)


@router.websocket("/api/ws/character-chat")
async def ws_character_chat(websocket: WebSocket):
    ticket = websocket.query_params.get("ticket")
    if not ticket:
        await websocket.close(code=4001, reason="Missing ticket")
        return

    try:
        user = await authenticate_websocket(ticket)
    except ValueError:
        await websocket.close(code=4001, reason="Invalid ticket")
        return

    await websocket.accept()
    conn = Connection(websocket=websocket, user_id=user.id, session_id="")

    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_json(), timeout=300)
            except asyncio.TimeoutError:
                await websocket.close(code=4000, reason="Idle timeout")
                break
            except Exception:
                break

            msg_type = raw.get("type")

            if msg_type == "chat_request":
                character_id = raw.get("character_id", "")
                message = raw.get("message", "").strip()
                model = raw.get("model", "")
                session_id = raw.get("session_id") or ""
                dialogue_mode = raw.get("dialogue_mode", "first_person")
                branch_id = raw.get("branch_id") or ""
                user_nickname = raw.get("user_nickname") or user.username or "用户"
                images = raw.get("images", [])
                temperature = raw.get("temperature", 0.7)
                top_p = raw.get("top_p", 0.95)
                max_tokens = raw.get("max_tokens", 2048)
                # 解析模型硬上限（模型管理里设置的 max_output_tokens）；
                # 若前端未显式指定回复长度，则默认提升到模型上限，使设置真正生效
                _user_specified_max = "max_tokens" in raw
                try:
                    from ..services.unified_model_registry import get_model_output_cap
                    _model_cap = get_model_output_cap(model) if model else None
                except Exception:
                    _model_cap = None
                if not _user_specified_max and _model_cap:
                    max_tokens = _model_cap
                reasoning_effort = raw.get("reasoning_effort") or None
                provider_id = raw.get("provider_id") or None
                frequency_penalty = raw.get("frequency_penalty", 0.0)
                presence_penalty = raw.get("presence_penalty", 0.0)
                min_p = raw.get("min_p", 0.05)
                top_k = raw.get("top_k", 40)
                repetition_penalty = raw.get("repetition_penalty", 1.1)
                response_length = raw.get("response_length") or None
                preset_id = raw.get("preset_id")
                smart_card_trigger = bool(raw.get("smart_card_trigger"))
                smart_card_context = clean_smart_card_trigger_context(
                    raw.get("smart_card_context") or message
                ) if smart_card_trigger else ""
                if smart_card_trigger:
                    message = clean_smart_card_trigger_context(message)
                # Task 3.4.1/3.4.3: 前端序列化的插件 function tool（OpenAI 格式）
                ws_tools = raw.get("tools") or None
                # [EP-BRIDGE] ST 1.18.0 extension_prompts：由前端 promptInjection 聚合
                # （含 smart-card iframe 上报）在生成请求中透传，后端装配时按 identifier
                # 覆盖 DB 记录（_collect_extension_prompts 运行时优先 + 四态注入）。
                ws_extension_prompts = raw.get("extension_prompts") or None
                # D8 修复: 群聊装配路径接通，解析 group_id / current_speaker_id
                ws_group_id = raw.get("group_id") or None
                ws_current_speaker_id = raw.get("current_speaker_id") or None
                # Phase B 修复: 解析 generation_type (ST generateGroupWrapper type)，
                # 用于群聊 swipe/continue/impersonate/quiet 专用选角。None/normal 走原策略。
                ws_generation_type = (raw.get("generation_type") or raw.get("gen_type") or "").lower() or None
                # P0-3: ST generate_interceptor 回传协议（docs/st_plugin_frontend_bridge_protocol.md）。
                # 前端沙箱在生成前按 runtime/config.generation_interceptors 顺序执行拦截器，
                # 将结果通过 interceptor_result 回传：
                #   {"message_order": [id...], "excluded_message_ids": [id...], "abort": bool}
                # 兼容旧字段：顶层 message_order（Task 7 遗留）优先级低于 interceptor_result。
                _icpt = raw.get("interceptor_result")
                _icpt = _icpt if isinstance(_icpt, dict) else {}
                ws_message_order = [
                    str(mid) for mid in (
                        _icpt.get("message_order") or raw.get("message_order") or []
                    ) if isinstance(mid, (str, int))
                ]
                ws_excluded_message_ids = [
                    str(mid) for mid in (_icpt.get("excluded_message_ids") or [])
                    if isinstance(mid, (str, int))
                ]
                ws_interceptor_abort = _icpt.get("abort") is True

                is_init = message == "__INIT__"

                db = SessionLocal()
                try:
                    char = db.query(Character).filter(
                        Character.id == character_id,
                        Character.user_id == user.id,
                    ).first()
                    if not char:
                        await conn.websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "Character not found",
                        }, ensure_ascii=False))
                        continue
                    char_extensions = char.extensions

                    if not is_init:
                        try:
                            ensure_model_available(model)
                        except ValueError:
                            await conn.websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Invalid model",
                            }, ensure_ascii=False))
                            continue

                    is_new_session = False
                    if not session_id:
                        session_id = str(uuid.uuid4())
                        is_new_session = True
                        initial_title = char.name
                        if not is_init and message:
                            try:
                                initial_title = await generate_compact_title(
                                    db, message, fallback_model_id=model, max_len=10,
                                )
                            except Exception as e:
                                logger.warning("Character session compact title fallback: %s", e)
                                db.rollback()
                        new_session = CharacterChatSession(
                            id=session_id,
                            character_id=char.id,
                            user_id=user.id,
                            title=initial_title,
                            dialogue_mode=dialogue_mode,
                        )
                        db.add(new_session)
                        db.commit()
                    else:
                        existing_session = db.query(CharacterChatSession).filter(
                            CharacterChatSession.id == session_id,
                            CharacterChatSession.user_id == user.id,
                            CharacterChatSession.character_id == char.id,
                        ).first()
                        if not existing_session:
                            await conn.websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Session not found",
                            }, ensure_ascii=False))
                            continue
                        existing_session.updated_at = datetime.now(timezone.utc)
                        db.commit()

                    session = new_session if is_new_session else existing_session

                    if not branch_id:
                        active_branch = db.query(CharacterChatSessionBranch).filter(
                            CharacterChatSessionBranch.session_id == session_id,
                            CharacterChatSessionBranch.is_active == True,
                        ).first()
                        if active_branch:
                            branch_id = active_branch.id
                        else:
                            if is_new_session:
                                main_branch = CharacterChatSessionBranch(
                                    session_id=session_id,
                                    branch_name="Main",
                                    is_active=True,
                                )
                                db.add(main_branch)
                                db.commit()
                                db.refresh(main_branch)
                                branch_id = main_branch.id
                    else:
                        branch = db.query(CharacterChatSessionBranch).filter(
                            CharacterChatSessionBranch.id == branch_id,
                            CharacterChatSessionBranch.session_id == session_id,
                        ).first()
                        if not branch:
                            await conn.websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Branch not found",
                            }, ensure_ascii=False))
                            continue

                    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
                    memory_mode = "disabled"
                    if user_setting and user_setting.memory_mode:
                        memory_mode = user_setting.memory_mode

                    if is_init:
                        from ..api.character_ext import _replace_placeholders, _apply_regex_scripts, _apply_plugin_regex_scripts, _apply_persist_regex_to_display_text
                        from ..services.compact_title_service import rule_based_compact_title

                        # Match SillyTavern: first_mes is the first displayed
                        # greeting, while alternate_greetings remain swipes for
                        # smart-card UI scripts to select with setChatMessage.
                        first_mes = _replace_placeholders(char.first_mes or "", user_nickname, char.name or "")
                        first_mes = _apply_persist_regex_to_display_text(
                            first_mes,
                            db,
                            char,
                            user_name=user_nickname,
                            placement=REGEX_PLACEMENT_AI_OUTPUT,
                            depth=0,
                        )
                        if not first_mes:
                            await conn.websocket.send_text(json.dumps({
                                "type": "done",
                                "content": "",
                                "session_id": session_id,
                            }, ensure_ascii=False))
                            continue

                        init_short_title = rule_based_compact_title(first_mes, max_len=10)
                        db.add(CharacterChatMessage(
                            session_id=session_id,
                            branch_id=branch_id,
                            role="assistant",
                            content=first_mes,
                            short_title=init_short_title,
                            model=model,
                            **_st_message_kwargs(
                                role="assistant",
                                content=first_mes,
                                char_name=char.name or "Character",
                                user_name=user_nickname,
                                swipes=[first_mes] + _character_alternate_greetings(char, user_nickname),
                            ),
                        ))
                        db.commit()

                        await _add_conn_to_room(conn, session_id)
                        await ws_manager.broadcast_to_session(session_id, {
                            "type": "session_created",
                            "session_id": session_id,
                            "branch_id": branch_id,
                        })

                        if "<palink-html>" in first_mes or "```html" in first_mes or re.search(r"<(?:!DOCTYPE\s+html|html|script|style)\b", first_mes, re.IGNORECASE):
                            await ws_manager.send_chunk(session_id, content=first_mes)
                        else:
                            chunk_size = 20
                            for i in range(0, len(first_mes), chunk_size):
                                await ws_manager.send_chunk(
                                    session_id,
                                    content=first_mes[i:i + chunk_size],
                                )
                        await ws_manager.send_done(session_id)
                        continue

                    from ..api.character_ext import (
                        _build_char_system_prompt,
                        _replace_placeholders,
                        _get_full_branch_history,
                        _get_ancestor_branch_ids,
                        _contains_chinese,
                        _apply_regex_scripts,
                        _apply_plugin_regex_scripts,
                        _apply_prompt_regex_to_messages,
                    )

                    # ── Slash command handling (Phase 4) ───────────────────────
                    slash_result: SlashCommandResult | None = None
                    if not is_init and is_slash_command(message):
                        slash_ctx = SlashCommandContext(
                            db=db,
                            session_id=session_id,
                            user_id=user.id,
                            user_name=user_nickname,
                            character=char,
                            session=session,
                            input_text=message,
                        )
                        slash_result = execute_slash_command(message, slash_ctx)
                        # P0-3 修复: /gen 命令支持 — gen_prompt 非空时调用 LLM 生成
                        if slash_result and slash_result.gen_prompt is not None:
                            try:
                                from ..services.inference_dispatcher import complete_text_completion
                                completion = await complete_text_completion(
                                    model_id=model,
                                    messages=[{"role": "user", "content": slash_result.gen_prompt}],
                                    temperature=0.7,
                                    top_p=0.95,
                                    max_tokens=1024,
                                    timeout=60.0,
                                    provider_id=provider_id,
                                )
                                gen_text = completion.get("content") or ""
                            except Exception as gen_exc:
                                logger.exception("[WS-SLASH-GEN] /gen LLM call failed: %s", gen_exc)
                                gen_text = f"[/gen error: {gen_exc}]"
                            await conn.websocket.send_text(json.dumps({
                                "type": "slash_response",
                                "response": gen_text,
                            }, ensure_ascii=False))
                            continue
                        if slash_result and not slash_result.send_to_chat and not slash_result.system_message and not slash_result.extra_messages:
                            await conn.websocket.send_text(json.dumps({
                                "type": "slash_response",
                                "response": slash_result.response,
                            }, ensure_ascii=False))
                            continue

                    # ── Get model config for thinking mode ───────────────────────
                    enable_thinking = None
                    try:
                        from ..services.unified_model_registry import find_model
                        _, model_data = find_model(model)
                        if model_data and isinstance(model_data, dict):
                            enable_thinking = model_data.get("enable_thinking")
                            # 模型级默认思考挡位（请求未指定时沿用）
                            if not reasoning_effort:
                                reasoning_effort = model_data.get("reasoning_effort")
                    except Exception as e:
                        logger.warning(f"Failed to get model config for thinking mode: {e}")

                    # ST 1.18.0 context template — load the preset's bound
                    # template name (if any) so prompt assembly can wrap
                    # messages accordingly.
                    context_template_name = None
                    if preset_id:
                        try:
                            _preset_for_template = db.query(GenerationPreset).filter(
                                GenerationPreset.id == preset_id,
                                (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
                            ).first()
                            if _preset_for_template and _preset_for_template.context_template_name:
                                context_template_name = _preset_for_template.context_template_name
                        except Exception as tmpl_err:
                            logger.warning("Failed to load context_template_name from preset %s: %s", preset_id, tmpl_err)

                    # ── F1: 多发言者队列解析（模块 04 多人串联流式）──
                    # 用户消息已在下方落库（chat_request 持久化块）。此处仅决定
                    # 本轮需要顺序生成的发言者 character_id 列表；具体装配+生成
                    # 延迟到 _gen 内逐发言者执行，保证 LIST 模式下多人顺序响应。
                    # _speaker_plan: None => 单发言者（由装配内部 _resolve_group_speaker 解析）；
                    #               list => 显式队列（LIST 按名册顺序多成员 / MANUAL 空队列跳过）。
                    _speaker_plan = resolve_group_speaker_queue(db, ws_group_id, ws_current_speaker_id, ws_generation_type)

                    # [MEM-UPSERT] 本轮用户消息行引用；smart_card_trigger / slash
                    # 不落用户消息时保持 None，记忆写入退化为存量兼容（无 message_id）。
                    _user_msg_row = None
                    user_message_id = None
                    if not smart_card_trigger:
                        if slash_result:
                            if slash_result.extra_messages:
                                for em in slash_result.extra_messages:
                                    em_role = em.get("role", "user")
                                    em_content = em.get("content", "")
                                    # P0-2 修复: /send 已自行 commit 消息，跳过重复保存
                                    if em.get("_already_persisted"):
                                        # 仅广播 new_message 事件到前端，不重复写库
                                        try:
                                            await ws_manager.broadcast_to_session(session_id, {
                                                "type": "new_message",
                                                "is_extra": True,
                                                "role": em_role,
                                                "content": em_content,
                                                "session_id": session_id,
                                                "branch_id": branch_id,
                                            })
                                        except Exception as em_broadcast_err:
                                            logger.warning(
                                                "extra_message broadcast failed (session=%s branch=%s): %s",
                                                session_id, branch_id, em_broadcast_err,
                                            )
                                        continue
                                    db.add(CharacterChatMessage(
                                        session_id=session_id,
                                        branch_id=branch_id,
                                        role=em_role,
                                        content=em_content,
                                        model=model,
                                        **_st_message_kwargs(
                                            role=em_role,
                                            content=em_content,
                                            char_name=char.name or "Character",
                                            user_name=user_nickname,
                                        ),
                                    ))
                                    try:
                                        await ws_manager.broadcast_to_session(session_id, {
                                            "type": "new_message",
                                            "is_extra": True,
                                            "role": em_role,
                                            "content": em_content,
                                            "session_id": session_id,
                                            "branch_id": branch_id,
                                        })
                                    except Exception as em_broadcast_err:
                                        logger.warning(
                                            "extra_message broadcast failed (session=%s branch=%s): %s",
                                            session_id, branch_id, em_broadcast_err,
                                        )
                            if slash_result.system_message:
                                db.add(CharacterChatMessage(
                                    session_id=session_id,
                                    branch_id=branch_id,
                                    role="system",
                                    content=slash_result.system_message,
                                    model=model,
                                    **_st_message_kwargs(
                                        role="system",
                                        content=slash_result.system_message,
                                        char_name=char.name or "Character",
                                        user_name=user_nickname,
                                    ),
                                ))
                            if slash_result.send_to_chat:
                                _user_msg_row = CharacterChatMessage(
                                    session_id=session_id,
                                    branch_id=branch_id,
                                    role="user",
                                    content=message,
                                    model=model,
                                    **_st_message_kwargs(
                                        role="user",
                                        content=message,
                                        char_name=char.name or "Character",
                                        user_name=user_nickname,
                                    ),
                                )
                                db.add(_user_msg_row)
                        else:
                            # [MEM-UPSERT] 保留用户消息主键，供记忆写入按 message_id 关联
                            _user_msg_row = CharacterChatMessage(
                                session_id=session_id,
                                branch_id=branch_id,
                                role="user",
                                content=message,
                                model=model,
                                **_st_message_kwargs(
                                    role="user",
                                    content=message,
                                    char_name=char.name or "Character",
                                    user_name=user_nickname,
                                ),
                            )
                            db.add(_user_msg_row)
                    # [MEM-UPSERT] flush 取回用户消息主键，供记忆写入按 message_id 关联
                    if _user_msg_row is not None:
                        db.flush()
                        user_message_id = _user_msg_row.id
                    db.commit()

                    # ST 1.18.0 logit_bias / ban_sequences — load preset (if any)
                    # and build the merged bias dict while db is still open.
                    # Silently skipped when preset_id is absent or load fails.
                    logit_bias_dict = None
                    if preset_id:
                        try:
                            preset_for_bias = db.query(GenerationPreset).filter(
                                GenerationPreset.id == preset_id,
                                (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
                            ).first()
                            if preset_for_bias:
                                logit_bias_dict = _build_logit_bias(preset_for_bias) or None
                        except Exception as bias_err:
                            logger.warning("Failed to load preset %s for logit_bias: %s", preset_id, bias_err)

                finally:
                    db.close()

                await _add_conn_to_room(conn, session_id)

                async def _gen(ss):
                    # P0-3: 前端拦截器 abort(immediately) 语义——用户消息已落库，
                    # 但本轮 AI 生成被扩展中止（对齐 ST extensions.js:2039 aborted）。
                    if ws_interceptor_abort:
                        logger.info(
                            "[WS-CHAR-CHAT] Generation aborted by frontend generate_interceptor (session=%s)",
                            session_id,
                        )
                        await ws_manager.broadcast_to_session(session_id, {
                            "type": "generation_aborted",
                            "reason": "interceptor",
                            "session_id": session_id,
                        })
                        return

                    # F1 多发言者流水线（模块 04 多人串联流式）。
                    # _speaker_plan: None => 单发言者（装配内 _resolve_group_speaker 解析）；
                    #               []   => 仅落用户消息，跳过 AI（MANUAL 无发言者）；
                    #               list => 显式队列（LIST 模式，按名册顺序多成员顺序生成）。
                    plan = _speaker_plan
                    if plan is not None and len(plan) == 0:
                        logger.info(
                            "[WS-CHAR-CHAT] No AI generation this turn (group MANUAL no speaker / empty queue); "
                            "user message already persisted (session=%s group=%s)",
                            session_id, ws_group_id,
                        )
                        return

                    # 单发言者路径（1:1 或 NATURAL/POOLED/TALKATIVE/VOTING 等自动选角）：
                    # 由装配内部解析当前发言者，此处队列仅含 ws_current_speaker_id（可能为 None）。
                    speaker_ids = plan if plan is not None else [ws_current_speaker_id]

                    for idx, speaker_id in enumerate(speaker_ids):
                        # 每个发言者重置 StreamSession，产生独立的 chunk…done 流式周期，
                        # 使后续发言者能在前序成员消息落库后看到完整历史（与 ST generateGroupWrapper 一致）。
                        async with ss._lock:
                            ss.full_content = ""
                            ss.full_reasoning = ""
                            ss.status = "streaming"

                        gen_db = SessionLocal()
                        try:
                            req_local = PromptAssemblyRequest(
                                db=gen_db,
                                user=user,
                                char=char,
                                session_id=session_id,
                                branch_id=branch_id,
                                message=message,  # 保留供 NATURAL 选角；不重复注入（include_user_message=False）
                                images=images,
                                model=model,
                                user_nickname=user_nickname,
                                dialogue_mode=dialogue_mode or "first_person",
                                response_length=response_length,
                                max_tokens=max_tokens,
                                smart_card_trigger=smart_card_trigger,
                                smart_card_context=smart_card_context,
                                context_template_name=context_template_name,
                                group_id=ws_group_id,
                                current_speaker_id=speaker_id,
                                generation_type=ws_generation_type,  # Phase B: swipe/continue/impersonate/quiet 选角
                                include_user_message=False,  # 用户消息已落库，从 DB 历史读取，避免重复注入
                                message_order=ws_message_order,  # P0-3: interceptor 重排
                                excluded_message_ids=ws_excluded_message_ids,  # P0-3: interceptor 排除
                                extension_prompts=ws_extension_prompts,  # [EP-BRIDGE] 运行时扩展提示词（iframe/插件注入）
                            )
                            # D3 深层修复: SWAP 群聊须以「发言者卡」而非「主角色卡」构建 system_prompt 与角色卡。
                            # 先让选角逻辑解析实际发言者（装配内 _resolve_group_speaker 二次调用为幂等），再回填 req.char；
                            # 装配内所有 char=req.char 读取点（原生 system_prompt / st-compat char_system_prompt / 两个 builder）同步生效。
                            await _resolve_group_speaker(req_local)
                            _resolved = req_local.current_speaker_id or speaker_id
                            speaker_char = char
                            if _resolved:
                                _sc = gen_db.query(Character).filter(Character.id == str(_resolved)).first()
                                if _sc is not None:
                                    speaker_char = _sc
                            req_local.char = speaker_char  # 回填发言者卡
                            speaker_name = speaker_char.name or "Character"
                            assembly = await assemble_roleplay_prompt(
                                req_local,
                                PromptAssemblyDeps(
                                    build_system_prompt=_build_char_system_prompt,
                                    replace_placeholders=_replace_placeholders,
                                    get_full_branch_history=_get_full_branch_history,
                                    get_ancestor_branch_ids=_get_ancestor_branch_ids,
                                    contains_chinese=_contains_chinese,
                                    apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
                                    apply_regex_scripts=_apply_regex_scripts,
                                    apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
                                ),
                            )
                            messages = assembly.messages
                            mem_mode = assembly.memory_mode
                            eff_max = assembly.effective_max_tokens
                            # 角色扮演回应长度受模型硬上限约束（不超过模型管理能力）
                            if _model_cap:
                                eff_max = min(eff_max, _model_cap)
                        finally:
                            gen_db.close()

                        # 多人模式：广播发言人起始事件（后端协议就绪，前端后续接入）
                        if len(speaker_ids) > 1:
                            await ws_manager.broadcast_to_session(session_id, {
                                "type": "group_speaker_start",
                                "speaker_id": str(_resolved) if _resolved else "",
                                "speaker_name": speaker_name,
                            })

                        try:
                            await run_character_chat_generation(
                                ss=ss,
                                session_id=session_id,
                                branch_id=branch_id,
                                user_id=user.id,
                                messages=messages,
                                model=model,
                                is_new_session=(is_new_session and idx == 0),
                                memory_mode=mem_mode,
                                user_message="" if smart_card_trigger else message,
                                char_extensions=speaker_char.extensions,
                                character_name=speaker_name,
                                user_name=user_nickname,
                                temperature=temperature,
                                top_p=top_p,
                                max_tokens=eff_max,
                                frequency_penalty=frequency_penalty,
                                presence_penalty=presence_penalty,
                                min_p=min_p,
                                top_k=top_k,
                                repetition_penalty=repetition_penalty,
                                enable_thinking=enable_thinking,
                                reasoning_effort=reasoning_effort,
                                provider_id=provider_id,
                                logit_bias=logit_bias_dict,
                                store_user_memory=(idx == 0),
                                user_message_id=(user_message_id if idx == 0 else None),
                                char=speaker_char,
                                # Task 3.4.3: 传递前端 function tool
                                tools=ws_tools,
                            )
                        except Exception as _spk_err:
                            logger.exception(
                                "[WS-CHAR-CHAT] speaker generation failed (speaker=%s group=%s session=%s): %s",
                                _resolved, ws_group_id, session_id, _spk_err,
                            )

                        if len(speaker_ids) > 1:
                            await ws_manager.broadcast_to_session(session_id, {
                                "type": "group_speaker_end",
                                "speaker_id": str(_resolved) if _resolved else "",
                                "speaker_name": speaker_name,
                            })

                # P0-2 修复: /send 等 send_to_chat=False 的 slash 命令不应触发 AI 生成。
                # 此时用户消息已落库（_cmd_send 自行 commit 或 extra_messages 已 db.add），
                # 前端已通过 slash_response 或 new_message 广播获知结果，无需进入 streaming。
                if slash_result and slash_result.is_continue:
                    # P2-8 修复: /continue 命令 — 触发续写而非新轮生成
                    # 不添加 user 消息；追加到最后一条 AI 消息内容末尾
                    _continue_prompt = slash_result.continue_prompt
                    _continue_msg_id = None

                    # 查找最后一条 AI 消息
                    _cont_db = SessionLocal()
                    try:
                        _branch = _cont_db.query(CharacterChatSessionBranch).filter(
                            CharacterChatSessionBranch.session_id == session_id,
                            CharacterChatSessionBranch.is_active == True,
                        ).first()
                        _branch_id = _branch.id if _branch else branch_id
                        _last_ai = _cont_db.query(CharacterChatMessage).filter(
                            CharacterChatMessage.session_id == session_id,
                            CharacterChatMessage.branch_id == _branch_id,
                            CharacterChatMessage.role == "assistant",
                        ).order_by(CharacterChatMessage.id.desc()).first()

                        if _last_ai is None:
                            await conn.websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "No assistant message to continue",
                            }, ensure_ascii=False))
                            continue

                        _continue_msg_id = _last_ai.id

                        # 如果有 continue_prompt，追加到最后一条 AI 消息
                        if _continue_prompt and _continue_prompt.strip():
                            _prompt_text = _continue_prompt.strip()
                            _last_ai.content = (_last_ai.content or "") + _prompt_text
                            # 同步到当前 swipe
                            _cur_swipes = _message_swipes(_last_ai)
                            if _cur_swipes and _last_ai.swipe_id < len(_cur_swipes):
                                _cur_swipes[_last_ai.swipe_id] = _last_ai.content
                                _last_ai.swipes = _json_dump_or_none(_cur_swipes)
                            _cont_db.commit()
                            # 广播消息更新
                            try:
                                await ws_manager.broadcast_to_session(session_id, {
                                    "type": "message_updated",
                                    "message_id": _continue_msg_id,
                                    "content": _last_ai.content,
                                    "session_id": session_id,
                                    "branch_id": _branch_id,
                                })
                            except Exception:
                                pass
                    finally:
                        _cont_db.close()

                    # 定义续写生成函数
                    async def _gen_continue(ss):
                        gen_db = SessionLocal()
                        try:
                            req_local = PromptAssemblyRequest(
                                db=gen_db,
                                user=user,
                                char=char,
                                session_id=session_id,
                                branch_id=branch_id,
                                message="",
                                images=[],
                                model=model,
                                user_nickname=user_nickname,
                                dialogue_mode=dialogue_mode or "first_person",
                                response_length=response_length,
                                max_tokens=max_tokens,
                                is_continue=True,
                                include_user_message=False,
                                include_title_instruction=False,
                                context_template_name=context_template_name,
                                group_id=ws_group_id,
                                current_speaker_id=ws_current_speaker_id,
                                generation_type=ws_generation_type,
                                extension_prompts=ws_extension_prompts,  # [EP-BRIDGE] 运行时扩展提示词（iframe/插件注入）
                            )
                            await _resolve_group_speaker(req_local)
                            _resolved = req_local.current_speaker_id or ws_current_speaker_id
                            speaker_char = char
                            if _resolved:
                                _sc = gen_db.query(Character).filter(Character.id == str(_resolved)).first()
                                if _sc is not None:
                                    speaker_char = _sc
                            req_local.char = speaker_char
                            speaker_name = speaker_char.name or "Character"
                            assembly = await assemble_roleplay_prompt(
                                req_local,
                                PromptAssemblyDeps(
                                    build_system_prompt=_build_char_system_prompt,
                                    replace_placeholders=_replace_placeholders,
                                    get_full_branch_history=_get_full_branch_history,
                                    get_ancestor_branch_ids=_get_ancestor_branch_ids,
                                    contains_chinese=_contains_chinese,
                                    apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
                                    apply_regex_scripts=_apply_regex_scripts,
                                    apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
                                ),
                            )
                            messages = assembly.messages
                            mem_mode = assembly.memory_mode
                            eff_max = assembly.effective_max_tokens
                            # 角色扮演回应长度受模型硬上限约束（不超过模型管理能力）
                            if _model_cap:
                                eff_max = min(eff_max, _model_cap)
                        finally:
                            gen_db.close()

                        try:
                            await run_character_chat_generation(
                                ss=ss,
                                session_id=session_id,
                                branch_id=branch_id,
                                user_id=user.id,
                                messages=messages,
                                model=model,
                                is_new_session=False,
                                memory_mode=mem_mode,
                                user_message="",
                                char_extensions=speaker_char.extensions,
                                character_name=speaker_name,
                                user_name=user_nickname,
                                temperature=temperature,
                                top_p=top_p,
                                max_tokens=eff_max,
                                frequency_penalty=frequency_penalty,
                                presence_penalty=presence_penalty,
                                min_p=min_p,
                                top_k=top_k,
                                repetition_penalty=repetition_penalty,
                                enable_thinking=enable_thinking,
                                reasoning_effort=reasoning_effort,
                                provider_id=provider_id,
                                logit_bias=logit_bias_dict,
                                store_user_memory=False,
                                char=speaker_char,
                                tools=ws_tools,
                                continue_message_id=_continue_msg_id,
                            )
                        except Exception as _cont_err:
                            logger.exception(
                                "[WS-CHAR-CHAT] continue generation failed (session=%s): %s",
                                session_id, _cont_err,
                            )

                    try:
                        await ws_manager.create_stream_session(session_id, user.id, _gen_continue)
                    except StreamSessionBusyError:
                        # M-7 修复: 同会话已有 active 生成任务。/continue 不新增
                        # user 消息（send_to_chat=False），无需回滚；仅发送错误提示。
                        await _send_stream_busy_error(conn)
                        continue
                elif slash_result and not slash_result.send_to_chat:
                    logger.info(
                        "[WS-CHAR-CHAT] Skip AI generation (slash command send_to_chat=False); "
                        "session=%s",
                        session_id,
                    )
                else:
                    try:
                        await ws_manager.create_stream_session(session_id, user.id, _gen)
                    except StreamSessionBusyError:
                        # M-7 修复: 同会话已有 active 生成任务——回滚刚落库的
                        # 用户消息（避免「消息存在、无回复」）并发送错误提示。
                        _rollback_last_user_message(CharacterChatMessage, session_id)
                        await _send_stream_busy_error(conn)
                        continue

            elif msg_type == "sync":
                sync_sid = raw.get("session_id", "")
                if sync_sid:
                    db = SessionLocal()
                    try:
                        session = db.query(CharacterChatSession).filter(
                            CharacterChatSession.id == sync_sid,
                            CharacterChatSession.user_id == user.id,
                        ).first()
                    finally:
                        db.close()
                    if not session:
                        await websocket.send_json({"type": "error", "message": "Session not found"})
                        continue
                    if conn.session_id != sync_sid:
                        await _add_conn_to_room(conn, sync_sid)
                    await ws_manager.sync_connection(conn, sync_sid)

            elif msg_type == "ping":
                await conn.websocket.send_text(json.dumps({"type": "pong"}, ensure_ascii=False))

            elif msg_type == "pong":
                ws_manager.handle_pong(conn)

            elif msg_type == "tool_call_response":
                # Task 3.4.5: 前端执行完插件 handler 后返回结果，投递到对应 session 队列
                tc_session_id = raw.get("session_id") or conn.session_id or ""
                tc_tool_call_id = raw.get("tool_call_id", "")
                tc_result = raw.get("result", "")
                if tc_session_id:
                    ws_manager.submit_tool_response(tc_session_id, tc_tool_call_id, tc_result)

            elif msg_type == "cancel":
                active_ss = None
                if conn.session_id:
                    active_ss = ws_manager.get_stream_session(conn.session_id)
                if conn.session_id:
                    inference_queue.cancel_request(conn.session_id, user_id=user.id)
                if active_ss and active_ss.generation_task and not active_ss.generation_task.done():
                    active_ss.generation_task.cancel()

    except Exception:
        logger.exception("WebSocket character chat error")
    finally:
        await _remove_conn_from_room(conn)
