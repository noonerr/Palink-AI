import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import jwt
from fastapi import WebSocket, APIRouter

from ..core import settings
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
)
from ..services.websocket_manager import ws_manager, Connection, ChatRoom
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.stream_builder import StreamResult
from ..services.web_search import search_web, format_search_results, get_web_search_config
from ..services.mcp_service import get_all_tools_openai_format
from ..services.compact_title_service import generate_compact_title
from ..memory_module.service import MemoryService
from ..utils import normalize_image_url, build_memory_context

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)


async def authenticate_websocket(token: str) -> User:
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=["HS256"],
            options={"verify_signature": True},
        )
        username: str = payload.get("sub")
        if username is None:
            raise ValueError("Invalid token")
    except jwt.PyJWTError:
        raise ValueError("Invalid token")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
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

        final = result.final_text()
        token_count = result.token_count()

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
                    save_db.commit()

            last_saved_content_len = len(result.full_content)
            last_saved_reasoning_len = len(result.full_reasoning)
            last_flush_ts = time.monotonic()
        except Exception as persist_error:
            save_db.rollback()
            logger.warning("Failed to persist assistant snapshot: %s", persist_error)

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

        stream = stream_text_completion(
            model_id=model,
            messages=messages,
            temperature=0.7,
            timeout=30.0,
            request_id="auto",
            user_id=user_id,
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

            reasoning = delta.get("reasoning")
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
                persist_snapshot()

        persist_snapshot(force=True)

        if not result.has_content:
            result.full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
            await ws_manager.send_error(session_id, result.full_content)
            return

        usage_info = None
        if result.total_tokens > 0:
            usage_info = {
                "total_tokens": result.total_tokens,
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "reasoning_tokens": result.effective_reasoning_tokens(),
            }
            await ws_manager.broadcast_to_session(session_id, {"type": "usage", **usage_info})

        await ws_manager.send_done(session_id, usage=usage_info)

    except asyncio.CancelledError:
        if not result.has_content:
            result.full_content = "Error: 请求已中断，未收到模型回复。"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, "Generation was cancelled")
        raise
    except ServiceError as e:
        logger.exception("Chat stream service error")
        if not result.has_content:
            result.full_content = f"Error: {e.message}"
        else:
            result.full_content += f"\n\n[{e.message}]"
        persist_snapshot(force=True)
        await ws_manager.send_error(session_id, result.full_content)
    except Exception as e:
        logger.exception("Chat stream error")
        if not result.has_content:
            result.full_content = f"Error: {str(e)}"
        else:
            result.full_content += f"\n\n[推理中断: {str(e)}]"
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
                            mem_svc.store_memory(user_id, session_id, "user", user_message)
                            mem_svc.store_memory(user_id, session_id, "assistant", result.full_content)
                            save_db.commit()
                            memory_stored = True
                except Exception as e:
                    save_db.rollback()
                    logger.warning("Memory storage failed: %s", e)
        finally:
            save_db.close()


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
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 2048,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    min_p: float = 0.05,
    top_k: int = 40,
    repetition_penalty: float = 1.1,
):
    result = StreamResult()
    save_db = SessionLocal()
    assistant_message_id = None
    last_saved_content_len = 0
    last_saved_reasoning_len = 0
    last_flush_ts = 0.0

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

        final = result.final_text()
        token_count = result.token_count()

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
                    save_db.commit()

            last_saved_content_len = len(result.full_content)
            last_saved_reasoning_len = len(result.full_reasoning)
            last_flush_ts = time.monotonic()
        except Exception as persist_error:
            save_db.rollback()
            logger.warning("Failed to persist character chat snapshot: %s", persist_error)

    try:
        if is_new_session:
            await ws_manager.broadcast_to_session(session_id, {
                "type": "session_created",
                "session_id": session_id,
                "branch_id": branch_id,
            })

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
                continue

            reasoning = delta.get("reasoning")
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
                persist_snapshot()

        persist_snapshot(force=True)

        if not result.has_content:
            result.full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
            await ws_manager.send_error(session_id, result.full_content)
            return

        usage_info = None
        if result.total_tokens > 0:
            usage_info = {
                "total_tokens": result.total_tokens,
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "reasoning_tokens": result.effective_reasoning_tokens(),
            }
            await ws_manager.broadcast_to_session(session_id, {"type": "usage", **usage_info})

        await ws_manager.send_done(session_id, usage=usage_info)

    except asyncio.CancelledError:
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
                            mem_svc.store_memory(
                                user_id=user_id,
                                session_id=session_id,
                                role="user",
                                content=user_message,
                                branch_id=branch_id,
                            )
                            mem_svc.store_memory(
                                user_id=user_id,
                                session_id=session_id,
                                role="assistant",
                                content=result.full_content,
                                branch_id=branch_id,
                            )
                            save_db.commit()
                except Exception as e:
                    save_db.rollback()
                    logger.warning("Memory storage failed: %s", e)
        finally:
            save_db.close()


@router.websocket("/api/ws/chat")
async def ws_chat(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    try:
        user = await authenticate_websocket(token)
    except ValueError:
        await websocket.close(code=4001, reason="Invalid token")
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

                    db.add(ChatMessage(
                        session_id=session_id,
                        role="user",
                        content=final_user_content,
                        model=model,
                    ))
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

                    if memory_mode != "disabled":
                        try:
                            mem_svc = MemoryService(db)
                            if mem_svc.is_available():
                                mem_ctx = await mem_svc.get_context(
                                    user_id=user.id,
                                    query=message,
                                    session_id=session_id,
                                    max_tokens=2000,
                                )
                                memory_text = build_memory_context(mem_ctx)
                                if memory_text:
                                    system_parts.append(memory_text)
                        except Exception as e:
                            logger.warning("Memory context retrieval failed: %s", e)

                    messages = [{"role": "system", "content": "\n\n".join(system_parts)}]

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
                        messages.append({"role": m.role, "content": m.content})

                    if images:
                        content_payload = [{"type": "text", "text": final_user_content}]
                        for img_url in images:
                            normalized_url = normalize_image_url(img_url)
                            content_payload.append({
                                "type": "image_url",
                                "image_url": {"url": normalized_url},
                            })
                        messages.append({"role": "user", "content": content_payload})
                    else:
                        messages.append({"role": "user", "content": final_user_content})

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
                                    system_parts.append(web_search_context)
                                    messages[0] = {"role": "system", "content": "\n\n".join(system_parts)}
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
                    )

                await ws_manager.create_stream_session(session_id, user.id, _gen)

            elif msg_type == "sync":
                sync_sid = raw.get("session_id", "")
                if sync_sid:
                    if conn.session_id != sync_sid:
                        await _add_conn_to_room(conn, sync_sid)
                    await ws_manager.sync_connection(conn, sync_sid)

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
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    try:
        user = await authenticate_websocket(token)
    except ValueError:
        await websocket.close(code=4001, reason="Invalid token")
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
                frequency_penalty = raw.get("frequency_penalty", 0.0)
                presence_penalty = raw.get("presence_penalty", 0.0)
                min_p = raw.get("min_p", 0.05)
                top_k = raw.get("top_k", 40)
                repetition_penalty = raw.get("repetition_penalty", 1.1)

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
                        from ..api.character_ext import _replace_placeholders
                        from ..services.compact_title_service import rule_based_compact_title

                        first_mes = (char.first_mes or "").strip()
                        first_mes = _replace_placeholders(first_mes, user_nickname, char.name or "")
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
                        ))
                        db.commit()

                        await _add_conn_to_room(conn, session_id)
                        await ws_manager.broadcast_to_session(session_id, {
                            "type": "session_created",
                            "session_id": session_id,
                            "branch_id": branch_id,
                        })

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
                    )
                    from ..services.worldbook_service import build_worldbook_context
                    from ..services.plotline_service import build_plotline_context

                    system_prompt = _build_char_system_prompt(
                        char, user_nickname, dialogue_mode or "first_person",
                    )

                    author_note = None
                    author_note_position = "after_char"
                    if user_setting:
                        if user_setting.author_note:
                            author_note = user_setting.author_note
                        if user_setting.author_note_position:
                            author_note_position = user_setting.author_note_position

                    if author_note:
                        note_text = _replace_placeholders(author_note, user_nickname, char.name or '')
                        if author_note_position == "before_char":
                            system_prompt = note_text + "\n\n" + system_prompt
                        else:
                            system_prompt = system_prompt + "\n\n" + note_text

                    try:
                        nested = db.begin_nested()
                        from ..models.character import CharacterChatMessage as CCM
                        recent_for_wb = db.query(CCM).filter(
                            CCM.session_id == session_id,
                        ).order_by(CCM.created_at.desc()).limit(8).all()[::-1]
                        recent_msgs_for_wb = [{"role": m.role, "content": m.content} for m in recent_for_wb]
                        wb_context = build_worldbook_context(db, session_id, user.id, recent_msgs_for_wb)
                        if wb_context:
                            system_prompt += "\n\n" + _replace_placeholders(wb_context, user_nickname, char.name or '')
                        nested.commit()
                    except Exception as e:
                        logger.warning("World book context injection failed: %s", e)
                        try:
                            nested.rollback()
                        except Exception:
                            try:
                                db.rollback()
                            except Exception:
                                pass

                    try:
                        nested = db.begin_nested()
                        pl_context = build_plotline_context(db, session_id, user.id)
                        if pl_context:
                            system_prompt += "\n\n" + _replace_placeholders(pl_context, user_nickname, char.name or '')
                        nested.commit()
                    except Exception as e:
                        logger.warning("Plot line context injection failed: %s", e)
                        try:
                            nested.rollback()
                        except Exception:
                            try:
                                db.rollback()
                            except Exception:
                                pass

                    if memory_mode != "disabled":
                        try:
                            nested = db.begin_nested()
                            mem_svc = MemoryService(db)
                            if mem_svc.is_available():
                                ancestor_branch_ids = _get_ancestor_branch_ids(db, session_id, branch_id)
                                mem_ctx = await mem_svc.get_context(
                                    user_id=user.id,
                                    query=message,
                                    session_id=session_id,
                                    max_tokens=1500,
                                    branch_ids=ancestor_branch_ids if ancestor_branch_ids else None,
                                )
                                if mem_ctx and mem_ctx.memories:
                                    memory_text = build_memory_context(mem_ctx)
                                    if memory_text:
                                        system_prompt += "\n\n" + _replace_placeholders(
                                            memory_text, user_nickname, char.name or '',
                                        )
                            nested.commit()
                        except Exception as e:
                            logger.warning("Memory context retrieval failed: %s", e)
                            try:
                                nested.rollback()
                            except Exception:
                                try:
                                    db.rollback()
                                except Exception:
                                    pass

                    messages = [{"role": "system", "content": system_prompt}]

                    if char.mes_example:
                        messages.append({
                            "role": "system",
                            "content": f"Example dialogue:\n{_replace_placeholders(char.mes_example, user_nickname, char.name or '')}",
                        })

                    if branch_id:
                        history = _get_full_branch_history(
                            db, session_id, branch_id,
                            limit=settings.CHARACTER_CHAT_HISTORY_LIMIT,
                        )
                    else:
                        history = (
                            db.query(CharacterChatMessage)
                            .filter(
                                CharacterChatMessage.session_id == session_id,
                                CharacterChatMessage.branch_id == None,
                            )
                            .order_by(CharacterChatMessage.created_at.desc())
                            .limit(settings.CHARACTER_CHAT_HISTORY_LIMIT)
                            .all()[::-1]
                        )
                    for m in history:
                        messages.append({"role": m.role, "content": m.content})

                    if images:
                        content_payload = [{"type": "text", "text": message}]
                        for img_url in images:
                            normalized_img_url = normalize_image_url(img_url, check_size=True)
                            content_payload.append({
                                "type": "image_url",
                                "image_url": {"url": normalized_img_url},
                            })
                        user_msg = {"role": "user", "content": content_payload}
                    else:
                        user_msg = {"role": "user", "content": message}

                    messages.append(user_msg)

                    db.add(CharacterChatMessage(
                        session_id=session_id,
                        branch_id=branch_id,
                        role="user",
                        content=message,
                        model=model,
                    ))
                    db.commit()

                finally:
                    db.close()

                await _add_conn_to_room(conn, session_id)

                async def _gen(ss):
                    await run_character_chat_generation(
                        ss=ss,
                        session_id=session_id,
                        branch_id=branch_id,
                        user_id=user.id,
                        messages=messages,
                        model=model,
                        is_new_session=is_new_session,
                        memory_mode=memory_mode,
                        user_message=message,
                        temperature=temperature,
                        top_p=top_p,
                        max_tokens=max_tokens,
                        frequency_penalty=frequency_penalty,
                        presence_penalty=presence_penalty,
                        min_p=min_p,
                        top_k=top_k,
                        repetition_penalty=repetition_penalty,
                    )

                await ws_manager.create_stream_session(session_id, user.id, _gen)

            elif msg_type == "sync":
                sync_sid = raw.get("session_id", "")
                if sync_sid:
                    if conn.session_id != sync_sid:
                        await _add_conn_to_room(conn, sync_sid)
                    await ws_manager.sync_connection(conn, sync_sid)

            elif msg_type == "pong":
                ws_manager.handle_pong(conn)

            elif msg_type == "cancel":
                active_ss = None
                if conn.session_id:
                    active_ss = ws_manager.get_stream_session(conn.session_id)
                if active_ss and active_ss.generation_task and not active_ss.generation_task.done():
                    active_ss.generation_task.cancel()

    except Exception:
        logger.exception("WebSocket character chat error")
    finally:
        await _remove_conn_from_room(conn)
