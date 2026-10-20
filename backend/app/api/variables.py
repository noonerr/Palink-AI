"""Variables API routes — global and local (session-scoped) variable persistence."""
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.character import CharacterChatSession
from ..models.chat_variable import ChatVariable, GlobalVariable
# [批次P2 P2-1 2026-10-21] 内部簿记键（会话级预设覆盖层）的前缀唯一来源。
from ..services.preset_overlay import INTERNAL_KEY_PREFIX

router = APIRouter(prefix="/api/variables", tags=["variables"])


def _verify_local_session_owner(db: Session, user: User, session_id: str) -> None:
    """M-1 修复: 校验 /api/variables/local/{session_id} 归属当前用户。

    查询 ChatVariable 前先解析 session 并校验 user_id，防止水平越权
    （攻击者传他人 session_id 读写其会话变量）。session 不存在或不属于
    当前用户时抛 404。
    """
    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == str(session_id).strip(),
            CharacterChatSession.user_id == user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")


class VariableValueRequest(BaseModel):
    value: Optional[str] = None


def _global_to_dict(items) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for v in items:
        if v.value is not None:
            result[v.key] = v.value
    return result


def _local_to_dict(items) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for v in items:
        # [批次P2 P2-1 2026-10-21] 宿主自己的簿记行（`__palink_internal_` 前缀，
        # 例如会话级预设覆盖层 `__palink_internal_preset_overlay_v1`）不是
        # 用户自建变量：既不能出现在变量面板里，也不能被这里当普通变量删掉。
        # 它们各有专属端点（`/api/prompt-manager/sessions/{id}/preset`）。
        if v.key.startswith(INTERNAL_KEY_PREFIX):
            continue
        if v.value is not None:
            result[v.key] = v.value
    return result


def _reject_internal_key(key: str) -> None:
    """内部簿记键一律不许经"用户变量"端点改写/删除（否则覆盖层会被静默破坏）。"""
    if key.startswith(INTERNAL_KEY_PREFIX):
        raise HTTPException(status_code=400, detail="Reserved internal variable key")


# ──────────────────────────────────────────────
# Global variables
# ──────────────────────────────────────────────

@router.get("/global")
def get_global_variables(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items = db.query(GlobalVariable).filter(GlobalVariable.user_id == user.id).all()
    return _global_to_dict(items)


@router.post("/global")
def bulk_set_global_variables(
    body: Dict[str, str],
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    db.query(GlobalVariable).filter(GlobalVariable.user_id == user.id).delete()
    for key, value in body.items():
        if value is None:
            continue
        db.add(GlobalVariable(user_id=user.id, key=key, value=value))
    db.commit()
    return {"ok": True}


@router.put("/global/{key}")
def set_global_variable(
    key: str,
    req: VariableValueRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = db.query(GlobalVariable).filter(
        GlobalVariable.user_id == user.id,
        GlobalVariable.key == key,
    ).first()
    if existing:
        existing.value = req.value
    else:
        db.add(GlobalVariable(user_id=user.id, key=key, value=req.value))
    db.commit()
    return {"ok": True, "key": key, "value": req.value}


@router.delete("/global/{key}")
def delete_global_variable(
    key: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = db.query(GlobalVariable).filter(
        GlobalVariable.user_id == user.id,
        GlobalVariable.key == key,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
    return {"ok": True}


# ──────────────────────────────────────────────
# Local (session-scoped) variables
# ──────────────────────────────────────────────

@router.get("/local/{session_id}")
def get_local_variables(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # M-1 修复: 校验 session 归属当前用户（防止水平越权）
    _verify_local_session_owner(db, user, session_id)
    items = db.query(ChatVariable).filter(ChatVariable.session_id == session_id).all()
    return _local_to_dict(items)


@router.put("/local/{session_id}/{key}")
def set_local_variable(
    session_id: str,
    key: str,
    req: VariableValueRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # M-1 修复: 校验 session 归属当前用户（防止水平越权）
    _verify_local_session_owner(db, user, session_id)
    _reject_internal_key(key)
    existing = db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id,
        ChatVariable.key == key,
    ).first()
    if existing:
        existing.value = req.value
    else:
        db.add(ChatVariable(session_id=session_id, key=key, value=req.value))
    db.commit()
    return {"ok": True, "key": key, "value": req.value}


@router.delete("/local/{session_id}/{key}")
def delete_local_variable(
    session_id: str,
    key: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # M-1 修复: 校验 session 归属当前用户（防止水平越权）
    _verify_local_session_owner(db, user, session_id)
    _reject_internal_key(key)
    existing = db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id,
        ChatVariable.key == key,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
    return {"ok": True}
