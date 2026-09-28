"""Image generation API routes."""

import base64
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, selectinload

from .dependencies import get_admin, get_current_user
from ..core import get_db
from ..models import CharacterChatMessage, CharacterChatSession, ChatMessage, ChatSession, User
from ..schemas.image_generation import (
    ImageGenerationConfigRequest,
    ImageGenerationMediaRequest,
    ImageGenerationMessageResponse,
    ImageGenerationTestRequest,
    LocalImageTaskFailRequest,
    LocalImageTaskResultRequest,
)
from ..services.image_generation_service import (
    generate_image,
    generate_image_for_message,
    get_image_generation_config,
    image_result_to_dict,
    is_browser_execution_active,
    message_to_dict,
    save_image_generation_config,
)
from ..services.local_image_bridge import (
    claim_pending_tasks,
    complete_local_task,
    fail_local_task,
)

router = APIRouter(prefix="/api/image-generation", tags=["image-generation"])
logger = logging.getLogger(__name__)

# 回传图片解码上限（与 _save_generated_image 的 30MB 落盘上限对齐；base64 膨胀
# 约 4/3，请求原文超 45MB 直接拒绝，避免无谓的解码开销）。
_LOCAL_TASK_MAX_DECODED_BYTES = 30 * 1024 * 1024
_LOCAL_TASK_MAX_B64_CHARS = 45_000_000

_IMAGE_MAGIC_SIGNATURES: tuple[tuple[bytes, ...], ...] = (
    (b"\x89PNG\r\n\x1a\n",),
    (b"\xff\xd8\xff",),
    (b"RIFF",),  # WEBP：RIFF....WEBP，偏移 8
)


def _sniff_image_magic(data: bytes) -> bool:
    for sigs in _IMAGE_MAGIC_SIGNATURES:
        if sigs[0] and data.startswith(sigs[0]):
            if sigs[0] == b"RIFF":
                return len(data) >= 12 and data[8:12] == b"WEBP"
            return True
    return False


def _decode_uploaded_image_b64(raw: str) -> bytes:
    """浏览器回传的图片解码 + 三道闸（格式/大小/非空）。失败一律 400/413。"""
    text = str(raw or "").strip()
    if text.startswith("data:"):
        text = text.partition(",")[2]
    if len(text) > _LOCAL_TASK_MAX_B64_CHARS:
        raise HTTPException(status_code=413, detail="回传图片过大")
    try:
        data = base64.b64decode("".join(text.split()), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="回传图片的 base64 无效") from exc
    if not data:
        raise HTTPException(status_code=400, detail="回传图片为空")
    if not _sniff_image_magic(data):
        raise HTTPException(status_code=400, detail="回传内容不是受支持的图片格式（PNG/JPEG/WEBP）")
    if len(data) > _LOCAL_TASK_MAX_DECODED_BYTES:
        raise HTTPException(status_code=413, detail="回传图片过大")
    return data


def _chat_message_context(db: Session, session_id: str, up_to_message_id: int, limit: int) -> list[ChatMessage]:
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.id <= up_to_message_id)
        .order_by(ChatMessage.id.desc())
        .limit(limit)
        .all()
    )
    return list(reversed(messages))


def _character_message_context(db: Session, session_id: str, branch_id: str | None, up_to_message_id: int, limit: int) -> list[CharacterChatMessage]:
    query = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        CharacterChatMessage.id <= up_to_message_id,
    )
    if branch_id is None:
        query = query.filter(CharacterChatMessage.branch_id.is_(None))
    else:
        query = query.filter(CharacterChatMessage.branch_id == branch_id)
    messages = query.order_by(CharacterChatMessage.id.desc()).limit(limit).all()
    return list(reversed(messages))


@router.get("/config")
async def get_config(current_user: User = Depends(get_current_user)):
    config = get_image_generation_config(mask_secrets=True)
    return {**config, "can_admin": current_user.role == "admin"}


@router.put("/config")
async def update_config(req: ImageGenerationConfigRequest, http_request: Request, current_user: User = Depends(get_admin)):
    try:
        saved = save_image_generation_config(req.model_dump())
        return {**saved, "can_admin": True}
    except ValueError as exc:
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("Image generation config save failed: %s request_id=%s", exc, _rid)
        raise HTTPException(status_code=400, detail=f"图片生成配置无效 (request_id: {_rid})") from exc


@router.post("/test")
async def test_generation(req: ImageGenerationTestRequest, current_user: User = Depends(get_current_user)):
    if is_browser_execution_active():
        raise HTTPException(
            status_code=400,
            detail="当前图片服务商为浏览器桥接执行，服务端无法代为执行——请在设置页用「检测本机 ComfyUI」验证连通性",
        )
    result = await generate_image(prompt=req.prompt, user_id=current_user.id)
    return {"status": "ok", "image": image_result_to_dict(result)}


@router.post("/sessions/{session_id}/messages/{message_id}", response_model=ImageGenerationMessageResponse)
async def generate_for_chat_message(
    session_id: str,
    message_id: int,
    req: Optional[ImageGenerationMediaRequest] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    message = db.query(ChatMessage).filter(ChatMessage.id == message_id, ChatMessage.session_id == session_id).first()
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    context_messages = _chat_message_context(db, session_id, message_id, limit=8)
    result = await generate_image_for_message(
        db,
        current_user,
        message,
        context_messages,
        media_id=req.media_id if req else None,
    )
    return {"status": "ok", "image": image_result_to_dict(result), "updated_message": message_to_dict(message)}


@router.post("/character-sessions/{session_id}/messages/{message_id}", response_model=ImageGenerationMessageResponse)
async def generate_for_character_message(
    session_id: str,
    message_id: int,
    req: Optional[ImageGenerationMediaRequest] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = (
        db.query(CharacterChatSession)
        .options(selectinload(CharacterChatSession.character))
        .filter(CharacterChatSession.id == session_id, CharacterChatSession.user_id == current_user.id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Character session not found")

    message = (
        db.query(CharacterChatMessage)
        .filter(CharacterChatMessage.id == message_id, CharacterChatMessage.session_id == session_id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    context_messages = _character_message_context(db, session_id, message.branch_id, message_id, limit=8)
    result = await generate_image_for_message(
        db,
        current_user,
        message,
        context_messages,
        character=session.character,
        media_id=req.media_id if req else None,
    )
    return {"status": "ok", "image": image_result_to_dict(result), "updated_message": message_to_dict(message)}


# ============================================================
# 浏览器桥接执行（SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28）
# ============================================================

@router.get("/local-tasks/pending")
async def list_pending_local_tasks(current_user: User = Depends(get_current_user)):
    """浏览器执行器认领任务：调用即置 dispatched，45s 未回传自动回收重认领。"""
    return {"tasks": claim_pending_tasks(current_user.id)}


@router.post("/local-tasks/{task_id}/result")
async def submit_local_task_result(
    task_id: str,
    req: LocalImageTaskResultRequest,
    current_user: User = Depends(get_current_user),
):
    """浏览器回传出图结果。媒体收敛由等待中的出图协程负责，这里只搬运字节。"""
    data = _decode_uploaded_image_b64(req.images[0])
    b64 = base64.b64encode(data).decode("ascii")
    status = complete_local_task(task_id, current_user.id, [b64])
    return {"status": status}


@router.post("/local-tasks/{task_id}/fail")
async def submit_local_task_fail(
    task_id: str,
    req: LocalImageTaskFailRequest,
    current_user: User = Depends(get_current_user),
):
    """浏览器上报执行失败（连不上/CORS 拦截/工作流出错/超时）。"""
    status = fail_local_task(task_id, current_user.id, req.error)
    return {"status": status}
