import os
import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from openai import AsyncOpenAI

from ..core import get_db, settings, get_password_hash
from ..api.dependencies import get_current_user, get_admin
from ..models import User, ChatSession, ChatMessage, SystemSetting
from ..schemas import ProviderModel, ProviderConfig, DefaultModelConfig

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = logging.getLogger(__name__)


# --- 管理员重置密码的请求体（字段与用户自改密码的 PasswordReset 区分） ---
class AdminPasswordReset(BaseModel):
    password: str

def _providers_path() -> str:
    return os.path.join(settings.DATA_DIR, "providers.json")


def _get_providers() -> list:
    try:
        with open(_providers_path(), "r") as f:
            return json.load(f)
    except Exception:
        return []


def _save_providers(data: list):
    os.makedirs(settings.DATA_DIR, exist_ok=True)
    with open(_providers_path(), "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _find_model(model_id: str):
    for p in _get_providers():
        if p.get("is_active"):
            for m in p.get("models", []):
                mid = m["id"] if isinstance(m, dict) else m
                if mid == model_id:
                    return p, (m if isinstance(m, dict) else {"id": m, "alias": m})
    return None, None


# --- Provider helpers (shared with workspace/models) ---

@router.get("/providers")
async def get_providers_api(user: User = Depends(get_admin)):
    return _get_providers()


@router.post("/providers")
async def save_providers_api(data: List[ProviderConfig], user: User = Depends(get_admin)):
    _save_providers([d.dict() for d in data])
    return {"status": "ok"}


# --- System defaults ---

@router.get("/system/defaults")
async def get_system_defaults(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    if setting:
        return json.loads(setting.value)
    return {}


@router.post("/system/defaults")
async def set_system_defaults(config: DefaultModelConfig, user: User = Depends(get_admin), db: Session = Depends(get_db)):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    value = json.dumps(config.dict())
    if setting:
        setting.value = value
    else:
        db.add(SystemSetting(key="default_model_config", value=value))
    db.commit()
    return {"status": "ok"}


# --- User management ---

@router.get("/users")
async def list_users(user: User = Depends(get_admin), db: Session = Depends(get_db)):
    users = db.query(User).all()
    result = []
    for u in users:
        chat_count = db.query(ChatSession).filter(ChatSession.user_id == u.id).count()
        result.append({
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "is_active": u.is_active,
            "storage_used": u.storage_used or 0,
            "chat_count": chat_count,
        })
    return result


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, current_user: User = Depends(get_admin), db: Session = Depends(get_db)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    usr = db.query(User).filter(User.id == user_id).first()
    if usr:
        db.delete(usr)
        db.commit()
    return {"status": "ok"}


@router.post("/users/{user_id}/reset_password")
async def reset_user_password(user_id: int, req: AdminPasswordReset, user: User = Depends(get_admin), db: Session = Depends(get_db)):
    usr = db.query(User).filter(User.id == user_id).first()
    if not usr:
        raise HTTPException(status_code=404, detail="User not found")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    usr.hashed_password = get_password_hash(req.password)
    db.commit()
    return {"status": "ok"}


@router.get("/users/{user_id}/chats")
async def get_user_chats(user_id: int, user: User = Depends(get_admin), db: Session = Depends(get_db)):
    sessions = (
        db.query(ChatSession)
        .filter(ChatSession.user_id == user_id)
        .order_by(ChatSession.updated_at.desc())
        .all()
    )
    return [{"id": s.id, "title": s.title, "type": s.type, "updated_at": s.updated_at} for s in sessions]


@router.get("/sessions/{sid}/messages")
async def get_admin_session_messages(sid: str, user: User = Depends(get_admin), db: Session = Depends(get_db)):
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == sid)
        .order_by(ChatMessage.created_at)
        .all()
    )
    return [{"id": m.id, "role": m.role, "content": m.content, "model": m.model, "created_at": m.created_at} for m in messages]


# --- Recommendations / Starters ---

@router.post("/recommendations/starters")
async def update_starter_questions(questions: List[str], user: User = Depends(get_admin), db: Session = Depends(get_db)):
    existing = db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first()
    val = json.dumps(questions, ensure_ascii=False)
    if existing:
        existing.value = val
    else:
        db.add(SystemSetting(key="starter_questions", value=val))
    # Reset timer so they are shown immediately
    last_upd = db.query(SystemSetting).filter(SystemSetting.key == "last_starters_update").first()
    now_iso = datetime.now(timezone.utc).isoformat()
    if last_upd:
        last_upd.value = now_iso
    else:
        db.add(SystemSetting(key="last_starters_update", value=now_iso))
    db.commit()
    return {"status": "ok"}
