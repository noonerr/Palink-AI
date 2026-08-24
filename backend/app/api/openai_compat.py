import asyncio
import json
import logging
import time
import uuid
from typing import AsyncGenerator, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db, settings
from ..core.database import SessionLocal
from ..core.exceptions import ServiceError
from ..core.security import verify_service_user_id
from ..models import User
from ..services.inference_dispatcher import ensure_model_available, stream_text_completion
from ..services.provider_registry import get_providers
from ..services.stream_builder import StreamResult, stream_chat_deltas

router = APIRouter(tags=["openai"])
logger = logging.getLogger(__name__)
PALINK_DEFAULT_MODEL_ID = "palink-default"


class OpenAIMessage(BaseModel):
    role: str
    content: Union[str, List[dict], None] = None
    name: Optional[str] = None


class OpenAIChatCompletionRequest(BaseModel):
    model: str
    messages: List[OpenAIMessage]
    temperature: Optional[float] = 0.7
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    frequency_penalty: Optional[float] = 0.0
    presence_penalty: Optional[float] = 0.0
    stream: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    user: Optional[str] = None


class OpenAIModelItem(BaseModel):
    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = "palink"


class OpenAIModelList(BaseModel):
    object: str = "list"
    data: List[OpenAIModelItem]


class OpenAIUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class OpenAIChoice(BaseModel):
    index: int = 0
    message: Optional[dict] = None
    delta: Optional[dict] = None
    finish_reason: Optional[str] = None


class OpenAIChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[OpenAIChoice]
    usage: OpenAIUsage


class OpenAIChatCompletionStreamChunk(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    created: int
    model: str
    choices: List[OpenAIChoice]


def _extract_bearer_token(request: Request) -> Optional[str]:
    auth_header = request.headers.get("Authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return None


async def get_openai_compat_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = _extract_bearer_token(request)
    service_key = (settings.ST_NATIVE_SERVICE_KEY or "").strip()

    if service_key and token == service_key:
        # M-4 修复: service key 认证后优先按 ST sidecar 注入的 X-Palink-User-Id
        # 解析真实用户，避免多 ST 用户共用一个后端时全部固定以 admin 身份执行。
        # [N-6] 该头必须同时携带 HMAC 签名头 X-Palink-User-Sig（见
        # security.sign_service_user_id）；签名不符视为伪造——忽略该头并记
        # warning，落入无头回退路径（admin），不返回 403 以免提供探测信号。
        header_user_id = (
            request.headers.get("X-Palink-User-Id")
            or request.headers.get("x-palink-user-id")
        )
        if header_user_id:
            header_sig = (
                request.headers.get("X-Palink-User-Sig")
                or request.headers.get("x-palink-user-sig")
            )
            try:
                uid = int(str(header_user_id).strip())
            except (TypeError, ValueError):
                uid = None
            if uid:
                if not verify_service_user_id(uid, header_sig):
                    logger.warning(
                        "Rejected forged X-Palink-User-Id header (uid=%s, sig=%s) "
                        "on OpenAI-compat endpoint; falling back to default user.",
                        uid,
                        "present" if header_sig else "missing",
                    )
                else:
                    scoped_user = db.query(User).filter(
                        User.id == uid,
                        User.is_active == True,  # noqa: E712
                    ).first()
                    if scoped_user:
                        return scoped_user
        user = db.query(User).filter(User.username == "admin").first()
        if not user:
            user = db.query(User).filter(User.is_active == True).order_by(User.id.asc()).first()  # noqa: E712
        if not user:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="No active Palink user is available for ST Native service calls.",
            )
        return user

    from ..api.dependencies import get_current_user

    return await get_current_user(token=token or "", db=db)


def _normalize_messages(messages: List[OpenAIMessage]) -> List[dict]:
    result = []
    for msg in messages:
        if msg.content is None:
            content = ""
        elif isinstance(msg.content, str):
            content = msg.content
        elif isinstance(msg.content, list):
            content = msg.content
        else:
            content = str(msg.content)
        result.append({"role": msg.role, "content": content})
    return result


def _get_available_models() -> List[OpenAIModelItem]:
    items = []
    seen = set()
    for p in get_providers():
        if not p.get("is_active"):
            continue
        for m in p.get("models", []):
            if isinstance(m, dict):
                model_id = m.get("id", "")
            else:
                model_id = str(m)
            if model_id and model_id not in seen:
                seen.add(model_id)
                items.append(OpenAIModelItem(id=model_id, owned_by=p.get("name", "palink")))
    if items:
        items.insert(0, OpenAIModelItem(id=PALINK_DEFAULT_MODEL_ID, owned_by="palink"))
    return items


def _resolve_openai_model_id(model_id: str) -> str:
    if model_id != PALINK_DEFAULT_MODEL_ID:
        return model_id
    models = [item.id for item in _get_available_models() if item.id != PALINK_DEFAULT_MODEL_ID]
    if not models:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No Palink model is configured for ST Native calls.",
        )
    return models[0]


@router.get("/api/openai/v1/models")
async def openai_list_models(user: User = Depends(get_openai_compat_user)):
    models = _get_available_models()
    return OpenAIModelList(data=models)


@router.post("/api/openai/v1/chat/completions")
async def openai_chat_completions(
    req: OpenAIChatCompletionRequest,
    request: Request,
    user: User = Depends(get_openai_compat_user),
    db: Session = Depends(get_db),
):
    model_id = _resolve_openai_model_id(req.model)
    try:
        ensure_model_available(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    messages = _normalize_messages(req.messages)
    if not messages:
        raise HTTPException(status_code=400, detail="messages cannot be empty")

    temperature = req.temperature if req.temperature is not None else 0.7
    max_tokens = req.max_tokens
    top_p = req.top_p
    frequency_penalty = req.frequency_penalty if req.frequency_penalty is not None else 0.0
    presence_penalty = req.presence_penalty if req.presence_penalty is not None else 0.0

    if req.stream:
        async def stream_generator() -> AsyncGenerator[str, None]:
            result = StreamResult()
            completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            created = int(time.time())

            try:
                stream = stream_text_completion(
                    model_id=model_id,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    frequency_penalty=frequency_penalty,
                    presence_penalty=presence_penalty,
                    timeout=120.0,
                )

                first_chunk = True
                async for sse_event in stream_chat_deltas(stream, result):
                    try:
                        data = json.loads(sse_event.removeprefix("data: ").strip())
                    except Exception:
                        continue

                    delta = {}
                    if "content" in data and isinstance(data["content"], str):
                        delta["content"] = data["content"]
                    if "reasoning" in data and isinstance(data["reasoning"], str):
                        delta["content"] = delta.get("content", "") + data["reasoning"]

                    if not delta and first_chunk:
                        delta["role"] = "assistant"

                    if delta or first_chunk:
                        chunk = OpenAIChatCompletionStreamChunk(
                            id=completion_id,
                            created=created,
                            model=model_id,
                            choices=[OpenAIChoice(delta=delta if delta else None)],
                        )
                        yield f"data: {chunk.model_dump_json()}\n\n"
                        first_chunk = False

                chunk = OpenAIChatCompletionStreamChunk(
                    id=completion_id,
                    created=created,
                    model=model_id,
                    choices=[OpenAIChoice(delta={}, finish_reason="stop")],
                )
                yield f"data: {chunk.model_dump_json()}\n\n"
                yield "data: [DONE]\n\n"
            except asyncio.CancelledError:
                raise
            except ServiceError as e:
                logger.exception("OpenAI compat stream service error")
                err_text = e.message if not result.has_content else result.full_content + f"\n\n[{e.message}]"
                chunk = OpenAIChatCompletionStreamChunk(
                    id=completion_id,
                    created=created,
                    model=model_id,
                    choices=[OpenAIChoice(delta={"content": err_text}, finish_reason="stop")],
                )
                yield f"data: {chunk.model_dump_json()}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as e:
                logger.exception("OpenAI compat stream error")
                err_text = "推理过程中发生错误，请稍后重试。" if not result.has_content else result.full_content + "\n\n[推理中断]"
                chunk = OpenAIChatCompletionStreamChunk(
                    id=completion_id,
                    created=created,
                    model=model_id,
                    choices=[OpenAIChoice(delta={"content": err_text}, finish_reason="stop")],
                )
                yield f"data: {chunk.model_dump_json()}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    result = StreamResult()
    try:
        stream = stream_text_completion(
            model_id=model_id,
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            frequency_penalty=frequency_penalty,
            presence_penalty=presence_penalty,
            timeout=120.0,
        )

        async for sse_event in stream_chat_deltas(stream, result):
            pass

        content = result.full_content
        if result.full_reasoning:
            content = f"<think>{result.full_reasoning}</think>\n{content}"

        return OpenAIChatCompletionResponse(
            id=f"chatcmpl-{uuid.uuid4().hex[:24]}",
            created=int(time.time()),
            model=model_id,
            choices=[
                OpenAIChoice(
                    message={
                        "role": "assistant",
                        "content": content,
                    },
                    finish_reason="stop",
                )
            ],
            usage=OpenAIUsage(
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens or result.token_count(),
                total_tokens=result.total_tokens or (result.prompt_tokens + result.token_count()),
            ),
        )
    except ServiceError as e:
        logger.exception("OpenAI compat non-stream service error")
        raise HTTPException(status_code=500, detail=e.message)
    except Exception as e:
        logger.exception("OpenAI compat non-stream error")
        raise HTTPException(status_code=500, detail="推理过程中发生错误，请稍后重试。")
