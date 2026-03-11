import asyncio
import json
import logging
import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from openai import AsyncOpenAI

from ..schemas.chat import ChatRequest
from ..services.chat_service import ChatService
from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User, ChatMessage, UserSetting
from ..memory_module.service import MemoryService

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)


def _get_providers() -> list:
    cfg = os.path.join(settings.DATA_DIR, "providers.json")
    try:
        with open(cfg, "r") as f:
            return json.load(f)
    except Exception:
        return []


def _find_model(model_id: str):
    for p in _get_providers():
        if p.get("is_active"):
            for m in p.get("models", []):
                mid = m["id"] if isinstance(m, dict) else m
                if mid == model_id:
                    return p, (m if isinstance(m, dict) else {"id": m, "alias": m})
    return None, None


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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """处理聊天请求，返回流式响应"""
    provider, model_cfg = _find_model(req.model)
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
        .limit(30)
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

        try:
            client = AsyncOpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
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

            if is_new_session:
                yield f"data: {json.dumps({'session_id': session_id})}\n\n"

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
                    yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"

            if total_tokens > 0:
                yield f"data: {json.dumps({'type': 'usage', 'total_tokens': total_tokens, 'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens})}\n\n"

            yield "data: [DONE]\n\n"

            # ── Save assistant message ──────────────────────────────────
            from ..core.database import SessionLocal
            new_db = SessionLocal()
            try:
                final = f"<think>{full_reasoning}</think>\n{full_content}" if full_reasoning else full_content
                token_count = completion_tokens if completion_tokens > 0 else len(full_content) // 2
                chat_service_new = ChatService(new_db)
                chat_service_new.save_assistant_message(session_id, final, req.model, token_count)

                # ── Store memory ────────────────────────────────────────
                if memory_mode != "disabled":
                    try:
                        mem_svc = MemoryService(new_db)
                        if mem_svc.is_available():
                            mem_svc.store_memory(user.id, session_id, "user", req.message)
                            mem_svc.store_memory(user.id, session_id, "assistant", full_content)
                    except Exception as e:
                        logger.warning(f"Memory storage failed: {e}")
            finally:
                new_db.close()

        except Exception as e:
            logger.error(f"Chat stream error: {e}")
            yield f"data: {json.dumps({'content': f'Error: {str(e)}', 'error': True})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )
