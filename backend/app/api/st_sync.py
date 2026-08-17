"""ST Native 同步 API - 提供 Palink DB 与 ST DATA_ROOT 的同步端点"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session, selectinload

from ..core import get_db
from ..models import Character, User, UserSetting, WorldBook
from ..services.st_sync_service import (
    async_sync_all_for_user,
    async_sync_character_to_st,
    async_sync_session_to_st,
    async_sync_worldbook_to_st,
    clean_smart_card_markup,
    get_sync_status,
    sync_plugin_messages_to_session,
)

router = APIRouter(prefix="/api/st/sync", tags=["st-sync"])


class SyncCharacterRequest(BaseModel):
    character_id: Optional[str] = None
    include_sessions: bool = True
    include_worldbooks: bool = True


class SyncSessionRequest(BaseModel):
    session_id: str
    character_id: str
    branch_id: Optional[str] = None


class SyncWorldbookRequest(BaseModel):
    world_id: str


class SyncAllRequest(BaseModel):
    character_id: Optional[str] = None


def _get_current_user(request: Request, db: Session) -> User:
    user = request.state.user if hasattr(request, "state") and hasattr(request.state, "user") else None
    if user:
        return user
    auth_header = request.headers.get("Authorization", "")
    token = ""
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    if not token:
        token = request.query_params.get("token") or request.query_params.get("palinkToken") or ""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    from .silly_tavern import _user_from_request_token
    user = _user_from_request_token(request, db, token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user


@router.get("/status")
async def st_sync_status(
    request: Request,
    db: Session = Depends(get_db),
):
    """获取 ST 同步状态"""
    user = _get_current_user(request, db)
    return get_sync_status(db, user)


@router.post("/character")
async def st_sync_character(
    req: SyncCharacterRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """同步单个角色卡（含会话和世界书）到 ST DATA_ROOT"""
    user = _get_current_user(request, db)
    if not req.character_id:
        raise HTTPException(status_code=400, detail="character_id is required")

    character = (
        db.query(Character)
        .options(selectinload(Character.world_books))
        .filter(Character.id == req.character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    result = await async_sync_character_to_st(db, user, character)
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("reason", "sync_failed"))
    return result


@router.post("/session")
async def st_sync_session(
    req: SyncSessionRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """同步单个会话到 ST DATA_ROOT"""
    user = _get_current_user(request, db)

    character = (
        db.query(Character)
        .filter(Character.id == req.character_id, Character.user_id == user.id)
        .first()
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    from ..models import CharacterChatSession, CharacterChatSessionBranch
    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == req.session_id,
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == req.character_id,
        )
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branch = None
    if req.branch_id:
        branch = (
            db.query(CharacterChatSessionBranch)
            .filter(
                CharacterChatSessionBranch.id == req.branch_id,
                CharacterChatSessionBranch.session_id == session.id,
            )
            .first()
        )

    result = await async_sync_session_to_st(db, user, character, session, branch)
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("reason", "sync_failed"))

    plugin_result = sync_plugin_messages_to_session(db, user, character, session, branch)
    result["plugin_sync"] = plugin_result
    return result


@router.post("/worldbook")
async def st_sync_worldbook(
    req: SyncWorldbookRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """同步世界书到 ST DATA_ROOT"""
    user = _get_current_user(request, db)
    wb = (
        db.query(WorldBook)
        .filter(WorldBook.id == req.world_id, WorldBook.user_id == user.id)
        .first()
    )
    if not wb:
        raise HTTPException(status_code=404, detail="World book not found")

    result = await async_sync_worldbook_to_st(db, user, wb)
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("reason", "sync_failed"))
    return result


@router.post("/all")
async def st_sync_all(
    req: SyncAllRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """同步用户所有数据到 ST DATA_ROOT"""
    user = _get_current_user(request, db)
    result = await async_sync_all_for_user(db, user, req.character_id)
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("reason", "sync_failed"))
    return result


class CleanMarkupRequest(BaseModel):
    text: str
    keep_inner_text: bool = True


@router.post("/clean-markup")
async def st_clean_markup(
    req: CleanMarkupRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """清理 SmartCard 渲染层标签（预览接口）"""
    _get_current_user(request, db)
    return {
        "original": req.text,
        "cleaned": clean_smart_card_markup(req.text, keep_inner_text=req.keep_inner_text),
    }
