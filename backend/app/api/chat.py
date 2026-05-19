import asyncio
import json
import logging
import time
from typing import AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..schemas.chat import ChatRequest
from ..services.chat_service import ChatService
from ..core import get_db, settings
from ..core.database import SessionLocal
from ..core.rate_limit import enforce_rate_limit
from ..core.exceptions import ServiceError
from ..api.dependencies import get_current_user
from ..models import User, ChatMessage, UserSetting, ChatSession
from ..memory_module.service import MemoryService
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.inference_queue import inference_queue
from ..services.compact_title_service import generate_compact_title
from ..services.web_search import search_web, format_search_results, get_web_search_config
from ..services.mcp_service import get_all_tools_openai_format

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)


from ..utils import normalize_image_url, build_memory_context
from ..core.default_prompts import build_default_chat_prompt


@router.post("")
async def chat_stream(
    req: ChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """处理聊天请求，返回流式响应"""
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    enforce_rate_limit(
        request,
        "chat:stream",
        settings.CHAT_RATE_LIMIT_REQUESTS,
        settings.CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )

    try:
        ensure_model_available(req.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    chat_service = ChatService(db)

    context = await chat_service.prepare_chat_context(req, user.id)
    memory_mode = context.get("memory_mode", "rule")

    session_id, is_new_session = chat_service.ensure_session(
        req.session_id,
        user.id,
        req.message,
        req.session_type
    )

    # Replace default first-message truncation with compact title for new sessions.
    if is_new_session and (req.message or "").strip():
        try:
            compact_title = await generate_compact_title(
                db,
                req.message,
                fallback_model_id=req.model,
                max_len=10,
            )
            if compact_title:
                session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
                if session:
                    session.title = compact_title
                    db.commit()
        except Exception as e:
            logger.warning(f"Failed to apply compact title for session {session_id}: {e}")

    chat_service.save_user_message(
        session_id,
        req.message,
        req.model,
        req.images,
        req.files,
        req.display_content
    )

    # Get user's prompt language preference
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    prompt_lang = user_setting.prompt_language if user_setting else "auto"

    # Auto-detect language if needed
    if prompt_lang == "auto":
        has_chinese = any('一' <= c <= '鿿' for c in req.message[:100])
        prompt_lang = "zh" if has_chinese else "en"

    # Build system prompt (use custom or default)
    if user_setting and user_setting.use_custom_prompts:
        # Use custom prompt
        custom_prompt = user_setting.custom_chat_prompt_zh if prompt_lang == "zh" else user_setting.custom_chat_prompt_en
        system_prompt_base = custom_prompt if custom_prompt else build_default_chat_prompt(prompt_lang)
    else:
        # Use default prompt
        system_prompt_base = build_default_chat_prompt(prompt_lang)

    system_parts = [system_prompt_base]

    if memory_mode != "disabled":
        try:
            mem_svc = MemoryService(db)
            if mem_svc.is_available():
                mem_ctx = await mem_svc.get_context(
                    user_id=user.id,
                    query=req.message,
                    session_id=session_id,
                    max_tokens=2000
                )
                memory_text = build_memory_context(mem_ctx)
                if memory_text:
                    system_parts.append(memory_text)
        except Exception as e:
            logger.warning(f"Memory context retrieval failed: {e}")

    messages = [{"role": "system", "content": "\n\n".join(system_parts)}]

    # ── Load conversation history ───────────────────────────────────────
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
    # Exclude the user message we just saved (last one)
    for m in history[:-1]:
        messages.append({"role": m.role, "content": m.content})

    # ── Append current user message ─────────────────────────────────────
    user_content = context["user_message"]["content"]
    if req.images:
        content_payload = [{"type": "text", "text": user_content}]
        for img_url in req.images:
            normalized_url = normalize_image_url(img_url, user_id=user.id)
            content_payload.append({"type": "image_url", "image_url": {"url": normalized_url}})
        messages.append({"role": "user", "content": content_payload})
    else:
        messages.append({"role": "user", "content": user_content})

    # ── Web Search ──────────────────────────────────────────────────────
    web_search_context = ""
    web_search_results = []
    if req.web_search:
        ws_config = get_web_search_config()
        if ws_config.get("enabled"):
            try:
                search_results = await search_web(req.message, num_results=5)
                if search_results:
                    web_search_results = search_results
                    web_search_context = format_search_results(search_results, req.message)
                    system_parts.append(web_search_context)
                    messages[0] = {"role": "system", "content": "\n\n".join(system_parts)}
            except Exception as e:
                logger.warning(f"Web search failed: {e}")

    async def event_generator() -> AsyncGenerator[str, None]:
        from ..services.stream_builder import StreamResult, stream_chat_deltas
        result = StreamResult()
        assistant_message_id = None
        last_saved_content_len = 0
        last_saved_reasoning_len = 0
        last_flush_ts = 0.0
        memory_stored = False
        save_db = None
        try:
            save_db = SessionLocal()
        except Exception as db_err:
            logger.error(f"Failed to create database session: {db_err}")
            yield f"data: {json.dumps({'content': 'Error: Database connection failed', 'error': True}, ensure_ascii=False)}\n\n"
            return

        def persist_snapshot(force: bool = False):
            nonlocal assistant_message_id
            nonlocal last_saved_content_len
            nonlocal last_saved_reasoning_len
            nonlocal last_flush_ts

            if not save_db:
                return

            has_content = result.has_content
            if not has_content:
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
            ws_json = json.dumps({"query": req.message, "results": web_search_results}, ensure_ascii=False) if web_search_results else None

            try:
                if assistant_message_id is None:
                    msg = ChatMessage(
                        session_id=session_id,
                        role="assistant",
                        content=final,
                        model=req.model,
                        tokens=token_count,
                        prompt_tokens=result.prompt_tokens,
                        reasoning_tokens=result.effective_reasoning_tokens(),
                        web_search_results=ws_json,
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
                            model=req.model,
                            tokens=token_count,
                            prompt_tokens=result.prompt_tokens,
                            reasoning_tokens=result.effective_reasoning_tokens(),
                            web_search_results=ws_json,
                        )
                        save_db.add(msg)
                        save_db.commit()
                        save_db.refresh(msg)
                        assistant_message_id = msg.id
                    else:
                        msg.content = final
                        msg.model = req.model
                        msg.tokens = token_count
                        msg.prompt_tokens = result.prompt_tokens
                        msg.reasoning_tokens = result.effective_reasoning_tokens()
                        if ws_json is not None:
                            msg.web_search_results = ws_json
                        save_db.commit()

                last_saved_content_len = len(result.full_content)
                last_saved_reasoning_len = len(result.full_reasoning)
                last_flush_ts = time.monotonic()
            except Exception as persist_error:
                save_db.rollback()
                logger.warning(f"Failed to persist assistant snapshot: {persist_error}")

        try:
            initial_events = []
            if is_new_session:
                initial_events.append({"session_id": session_id})

            if web_search_results:
                initial_events.append({"type": "web_search", "query": req.message, "results": web_search_results})

            mcp_tools = []
            try:
                mcp_tools = await get_all_tools_openai_format()
            except Exception as e:
                logger.warning(f"Failed to fetch MCP tools: {e}")

            stream = stream_text_completion(
                model_id=req.model,
                messages=messages,
                temperature=req.temperature,
                timeout=30.0,
                request_id="auto",
                user_id=user.id,
                tools=mcp_tools if mcp_tools else None,
            )

            async for sse_event in stream_chat_deltas(stream, result, initial_events=initial_events, enable_tools=True):
                persist_snapshot()
                try:
                    yield sse_event
                except Exception:
                    persist_snapshot(force=True)
                    raise

            persist_snapshot(force=True)
        except asyncio.CancelledError:
            if not result.has_content:
                result.full_content = "Error: 请求已中断，未收到模型回复。"
            persist_snapshot(force=True)
            raise
        except ServiceError as e:
            logger.exception("Chat stream service error")
            if not result.has_content:
                result.full_content = f"Error: {e.message}"
            else:
                result.full_content += f"\n\n[{e.message}]"
            yield f"data: {json.dumps({'content': result.full_content, 'error': True}, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("Chat stream error")
            err_msg = "推理过程中发生错误，请稍后重试。"
            if not result.has_content:
                result.full_content = f"Error: {err_msg}"
            else:
                result.full_content += f"\n\n[推理中断: {err_msg}]"
            yield f"data: {json.dumps({'content': result.full_content, 'error': True}, ensure_ascii=False)}\n\n"
            persist_snapshot(force=True)
        finally:
            try:
                persist_snapshot(force=True)

                if memory_mode != "disabled" and result.full_content and not memory_stored:
                    try:
                        if not result.full_content.strip().startswith("Error:"):
                            mem_svc = MemoryService(save_db)
                            if mem_svc.is_available():
                                mem_svc.store_memory(user.id, session_id, "user", req.message)
                                mem_svc.store_memory(user.id, session_id, "assistant", result.full_content)
                                save_db.commit()
                                memory_stored = True
                    except Exception as e:
                        save_db.rollback()
                        logger.warning(f"Memory storage failed: {e}")
            finally:
                if save_db:
                    save_db.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


@router.get("/queue/status/{request_id}")
async def get_queue_status(
    request_id: str,
    user: User = Depends(get_current_user),
):
    status = inference_queue.get_queue_status(request_id, user_id=user.id)
    if status.get("status") == "forbidden":
        raise HTTPException(status_code=403, detail="Request does not belong to current user")
    return status


@router.post("/queue/cancel/{request_id}")
async def cancel_queue_request(
    request_id: str,
    user: User = Depends(get_current_user),
):
    success = inference_queue.cancel_request(request_id, user_id=user.id)
    if success:
        return {"status": "cancelled", "request_id": request_id}
    return {"status": "not_found", "request_id": request_id}


@router.get("/queue/status")
async def get_full_queue_status(
    user: User = Depends(get_current_user),
):
    return inference_queue.get_full_status()
