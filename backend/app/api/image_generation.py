"""Image generation API routes."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, selectinload

from .dependencies import get_admin, get_current_user
from ..core import get_db
from ..models import CharacterChatMessage, CharacterChatSession, ChatMessage, ChatSession, User
from ..schemas.image_generation import (
    ImageGenerationConfigRequest,
    ImageGenerationMessageResponse,
    ImageGenerationTestRequest,
)
from ..services.image_generation_service import (
    generate_image,
    generate_image_for_message,
    get_image_generation_config,
    image_result_to_dict,
    message_to_dict,
    save_image_generation_config,
)

router = APIRouter(prefix="/api/image-generation", tags=["image-generation"])
logger = logging.getLogger(__name__)


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
    result = await generate_image(prompt=req.prompt, user_id=current_user.id)
    return {"status": "ok", "image": image_result_to_dict(result)}


@router.post("/sessions/{session_id}/messages/{message_id}", response_model=ImageGenerationMessageResponse)
async def generate_for_chat_message(
    session_id: str,
    message_id: int,
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
    result = await generate_image_for_message(db, current_user, message, context_messages)
    return {"status": "ok", "image": image_result_to_dict(result), "updated_message": message_to_dict(message)}


@router.post("/character-sessions/{session_id}/messages/{message_id}", response_model=ImageGenerationMessageResponse)
async def generate_for_character_message(
    session_id: str,
    message_id: int,
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
    result = await generate_image_for_message(db, current_user, message, context_messages, character=session.character)
    return {"status": "ok", "image": image_result_to_dict(result), "updated_message": message_to_dict(message)}
