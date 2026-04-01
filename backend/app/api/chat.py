import asyncio
import json
import logging
import time
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..schemas.chat import ChatRequest
from ..services.chat_service import ChatService
from ..core import get_db, settings
from ..core.database import SessionLocal
from ..core.rate_limit import enforce_rate_limit
from ..api.dependencies import get_current_user
from ..models import User, ChatMessage, UserSetting
from ..memory_module.service import MemoryService
from ..services.provider_registry import find_model
from ..services.llm_client import get_async_openai_client

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)


def _build_memory_context(memory_ctx) -> str:
    """将记忆上下文格式化为 system prompt 片段"""
    parts = []
    if memory_ctx.user_profile and memory_ctx.user_profile.summary:
        parts.append(f"[User Profile]\n{memory_ctx.user_profile.summary}")
    if memory_ctx.memories:
        mem_lines = []
        for mem in memory_ctx.memories:
            prefix = "User" if mem.role == "user" else "Assistant"
            mem_lines.append(f"- {prefix}: {mem.content[:200]}")
        if mem_lines:
            parts.append("[Relevant Memories]\n" + "\n".join(mem_lines))
    return "\n\n".join(parts)


@router.post("")
async def chat_stream(
    req: ChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """处理聊天请求，返回流式响应"""
    enforce_rate_limit(
        request,
        "chat:stream",
        settings.CHAT_RATE_LIMIT_REQUESTS,
        settings.CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )

    provider, model_cfg = find_model(req.model)
    if not provider:
        raise HTTPException(status_code=400, detail="Model not configured or not available")

    chat_service = ChatService(db)

    context = await chat_service.prepare_chat_context(req, user.id)
    memory_mode = context.get("memory_mode", "rule")

    session_id, is_new_session = chat_service.ensure_session(
        req.session_id,
        user.id,
        req.message,
        req.session_type
    )

    chat_service.save_user_message(
        session_id,
        req.message,
        req.model,
        req.images,
        req.files
    )

    # ── Build system prompt with optional memory ────────────────────────
    system_parts = ["You are a helpful assistant."]

    if memory_mode != "disabled":
        try:
            mem_svc = MemoryService(db)
            if mem_svc.is_available():
                mem_ctx = mem_svc.get_context(
                    user_id=user.id,
                    query=req.message,
                    session_id=session_id,
                    max_tokens=2000
                )
                memory_text = _build_memory_context(mem_ctx)
                if memory_text:
                    system_parts.append(memory_text)
        except Exception as e:
            logger.warning(f"Memory context retrieval failed: {e}")

    messages = [{"role": "system", "content": "\n\n".join(system_parts)}]

    # ── Load conversation history ───────────────────────────────────────
    history = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.desc())
        .limit(settings.CHAT_HISTORY_LIMIT)
        .all()[::-1]
    )
    # Exclude the user message we just saved (last one)
    for m in history[:-1]:
        messages.append({"role": m.role, "content": m.content})

    # ── Append current user message ─────────────────────────────────────
    user_content = context["user_message"]["content"]
    if req.images:
        content_payload = [{"type": "text", "text": user_content}]
        for img_url in req.images:
            content_payload.append({"type": "image_url", "image_url": {"url": img_url}})
        messages.append({"role": "user", "content": content_payload})
    else:
        messages.append({"role": "user", "content": user_content})

    async def event_generator():
        full_content = ""
        full_reasoning = ""
        total_tokens = 0
        prompt_tokens = 0
        completion_tokens = 0
        assistant_message_id = None
        last_saved_content_len = 0
        last_saved_reasoning_len = 0
        last_flush_ts = 0.0
        memory_stored = False
        save_db = SessionLocal()

        def persist_snapshot(force: bool = False):
            nonlocal assistant_message_id
            nonlocal last_saved_content_len
            nonlocal last_saved_reasoning_len
            nonlocal last_flush_ts

            has_content = bool(full_content or full_reasoning)
            if not has_content:
                return

            content_delta = len(full_content) - last_saved_content_len
            reasoning_delta = len(full_reasoning) - last_saved_reasoning_len
            changed = content_delta > 0 or reasoning_delta > 0

            if not force:
                if not changed:
                    return
                # Reduce DB churn: flush when enough delta is accumulated or enough time elapsed.
                if content_delta < 80 and reasoning_delta < 80 and (time.monotonic() - last_flush_ts) < 1.0:
                    return

            final = f"<think>{full_reasoning}</think>\n{full_content}" if full_reasoning else full_content
            token_count = completion_tokens if completion_tokens > 0 else len(full_content) // 2

            try:
                if assistant_message_id is None:
                    msg = ChatMessage(
                        session_id=session_id,
                        role="assistant",
                        content=final,
                        model=req.model,
                        tokens=token_count,
                        prompt_tokens=prompt_tokens,
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
                            prompt_tokens=prompt_tokens,
                        )
                        save_db.add(msg)
                        save_db.commit()
                        save_db.refresh(msg)
                        assistant_message_id = msg.id
                    else:
                        msg.content = final
                        msg.model = req.model
                        msg.tokens = token_count
                        msg.prompt_tokens = prompt_tokens
                        save_db.commit()

                last_saved_content_len = len(full_content)
                last_saved_reasoning_len = len(full_reasoning)
                last_flush_ts = time.monotonic()
            except Exception as persist_error:
                save_db.rollback()
                logger.warning(f"Failed to persist assistant snapshot: {persist_error}")

        try:
            if is_new_session:
                yield f"data: {json.dumps({'session_id': session_id})}\n\n"

            client = get_async_openai_client(
                api_key=provider["api_key"],
                base_url=provider["base_url"],
                timeout=30.0,
            )
            stream_kwargs = dict(
                model=req.model,
                messages=messages,
                temperature=req.temperature,
                stream=True,
            )
            try:
                stream_kwargs["stream_options"] = {"include_usage": True}
                stream = await client.chat.completions.create(**stream_kwargs)
            except Exception:
                stream_kwargs.pop("stream_options", None)
                stream = await client.chat.completions.create(**stream_kwargs)

            async for chunk in stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    total_tokens = getattr(usage, "total_tokens", 0) or 0
                    prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
                    completion_tokens = getattr(usage, "completion_tokens", 0) or 0

                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                content = delta.content
                resp = {}
                if reasoning:
                    full_reasoning += reasoning
                    resp["reasoning"] = reasoning
                if content:
                    full_content += content
                    resp["content"] = content
                if resp:
                    persist_snapshot()
                    yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"

            if not full_content and not full_reasoning:
                full_content = "Error: 模型未返回任何可显示内容，请切换模型或稍后重试。"
                persist_snapshot(force=True)
                yield f"data: {json.dumps({'content': full_content, 'error': True}, ensure_ascii=False)}\n\n"

            if total_tokens > 0:
                yield f"data: {json.dumps({'type': 'usage', 'total_tokens': total_tokens, 'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens})}\n\n"

            persist_snapshot(force=True)
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            # Client disconnected: keep already-generated content for later resume.
            if not full_content and not full_reasoning:
                full_content = "Error: 请求已中断，未收到模型回复。"
            persist_snapshot(force=True)
            raise
        except Exception as e:
            logger.exception("Chat stream error")
            if not full_content and not full_reasoning:
                full_content = "Error: 服务暂时不可用，请稍后重试。"
                yield f"data: {json.dumps({'content': full_content, 'error': True}, ensure_ascii=False)}\n\n"
            persist_snapshot(force=True)
        finally:
            try:
                persist_snapshot(force=True)

                if memory_mode != "disabled" and full_content and not memory_stored:
                    try:
                        if full_content.strip().startswith("Error:"):
                            return
                        mem_svc = MemoryService(save_db)
                        if mem_svc.is_available():
                            mem_svc.store_memory(user.id, session_id, "user", req.message)
                            mem_svc.store_memory(user.id, session_id, "assistant", full_content)
                            save_db.commit()
                            memory_stored = True
                    except Exception as e:
                        save_db.rollback()
                        logger.warning(f"Memory storage failed: {e}")
            finally:
                save_db.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )
