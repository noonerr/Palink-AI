"""Extension Prompts API routes — persistence for injected prompt entries."""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.extension_prompt import (
    ExtensionPrompt,
    EXTENSION_PROMPT_POSITION_MAX,
    EXTENSION_PROMPT_POSITION_MIN,
)

router = APIRouter(prefix="/api/extension-prompts", tags=["extension-prompts"])


def _utc_now():
    return datetime.now(timezone.utc)


def _normalize_role(role_val) -> str:
    """ST extension_prompt_roles: 0=SYSTEM, 1=USER, 2=ASSISTANT。接受 int 或 str。"""
    if isinstance(role_val, bool):
        # bool 是 int 的子类，先排除避免误判
        return "system"
    if isinstance(role_val, int):
        return {0: "system", 1: "user", 2: "assistant"}.get(role_val, "system")
    val = str(role_val or "system").strip().lower()
    if val not in ("system", "user", "assistant"):
        return "system"
    return val


class ExtensionPromptRequest(BaseModel):
    session_id: Optional[str] = None
    content: str = ""
    position: int = -1
    depth: int = 4
    role: Union[int, str] = "system"
    enabled: bool = True
    order: Optional[int] = None
    scan: Optional[bool] = None
    marker: Optional[str] = None
    # filter 支持 dict（新格式 {"character_ids":[...], "session_ids":[...]}）
    # 或 list（旧格式，仅 character_ids）。None 表示无过滤。
    filter: Optional[Any] = None


def _entry_to_dict(e: ExtensionPrompt) -> dict:
    # P2-7 修复: 返回 scan 字段，对齐 ST 1.18.0 extension_prompt.scan 语义
    return {
        "identifier": e.identifier,
        "content": e.content or "",
        "position": e.position if e.position is not None else -1,
        "depth": e.depth if e.depth is not None else 4,
        "role": e.role or "system",
        "enabled": bool(e.enabled),
        "session_id": e.session_id,
        "order": 0,
        "scan": bool(getattr(e, "scan", False)),
        "filter": e.get_filter() if hasattr(e, "get_filter") else None,
    }


@router.get("")
def list_extension_prompts(
    session_id: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(ExtensionPrompt).filter(ExtensionPrompt.user_id == user.id)
    if session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))
    items = query.order_by(ExtensionPrompt.identifier).all()
    return [_entry_to_dict(e) for e in items]


@router.put("/{identifier}")
def set_extension_prompt(
    identifier: str,
    req: ExtensionPromptRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Pydantic 已确保 position 是 int；这里做一次范围校验，与模型 @validates 对齐。
    if req.position is not None and (req.position < EXTENSION_PROMPT_POSITION_MIN or req.position > EXTENSION_PROMPT_POSITION_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"position must be in [{EXTENSION_PROMPT_POSITION_MIN}, {EXTENSION_PROMPT_POSITION_MAX}]",
        )

    # role 归一化：ST 插件可能发 int（0/1/2），统一转为 str 存入 DB
    normalized_role = _normalize_role(req.role)

    query = db.query(ExtensionPrompt).filter(
        ExtensionPrompt.user_id == user.id,
        ExtensionPrompt.identifier == identifier,
    )
    if req.session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == req.session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))

    existing = query.first()
    if existing:
        existing.content = req.content
        existing.position = req.position
        existing.depth = req.depth
        existing.role = normalized_role
        existing.enabled = req.enabled
        # P2-7 修复: 持久化 scan 字段（None 时保留默认 False）
        if hasattr(existing, "scan"):
            existing.scan = bool(req.scan) if req.scan is not None else False
        existing.set_filter(req.filter) if hasattr(existing, "set_filter") else None
        existing.updated_at = _utc_now()
    else:
        existing = ExtensionPrompt(
            user_id=user.id,
            session_id=req.session_id,
            identifier=identifier,
            content=req.content,
            position=req.position,
            depth=req.depth,
            role=normalized_role,
            enabled=req.enabled,
            created_at=_utc_now(),
            updated_at=_utc_now(),
        )
        # P2-7 修复: 持久化 scan 字段
        if hasattr(existing, "scan"):
            existing.scan = bool(req.scan) if req.scan is not None else False
        if hasattr(existing, "set_filter"):
            existing.set_filter(req.filter)
        db.add(existing)
    db.commit()
    db.refresh(existing)
    return _entry_to_dict(existing)


@router.delete("/{identifier}")
def delete_extension_prompt(
    identifier: str,
    session_id: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(ExtensionPrompt).filter(
        ExtensionPrompt.user_id == user.id,
        ExtensionPrompt.identifier == identifier,
    )
    if session_id is not None:
        query = query.filter(ExtensionPrompt.session_id == session_id)
    else:
        query = query.filter(ExtensionPrompt.session_id.is_(None))
    existing = query.first()
    if existing:
        db.delete(existing)
        db.commit()
    return {"ok": True}
