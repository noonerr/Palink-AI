import os
import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..services.llm_client import get_async_openai_client

from ..core import get_db, settings, get_password_hash, validate_password_policy
from ..api.dependencies import get_current_user, get_admin
from ..models import User, ChatSession, ChatMessage, SystemSetting
from ..schemas import ProviderModel, ProviderConfig, DefaultModelConfig, TestProviderRequest
from ..models.system import ProviderTestResult
from ..services.provider_registry import get_providers, invalidate_provider_cache, resolve_secret_reference
from ..services.local_model_registry import (
    delete_local_model,
    set_local_model_enabled,
    upload_local_model,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = logging.getLogger(__name__)


# --- 管理员重置密码的请求体（字段与用户自改密码的 PasswordReset 区分） ---
class AdminPasswordReset(BaseModel):
    password: str

def _providers_path() -> str:
    return os.path.join(settings.DATA_DIR, "providers.json")


def _get_providers() -> list:
    return get_providers()


_ENV_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _is_env_secret_ref(value: str) -> bool:
    raw = (value or "").strip()
    if raw.startswith("env:"):
        return bool(_ENV_NAME_PATTERN.fullmatch(raw[4:].strip()))
    if raw.startswith("${") and raw.endswith("}"):
        return bool(_ENV_NAME_PATTERN.fullmatch(raw[2:-1].strip()))
    return False


def _validate_provider_secrets(data: list) -> None:
    for provider in data:
        if not isinstance(provider, dict):
            raise HTTPException(status_code=400, detail="Invalid provider payload")

        provider_id = provider.get("id") or provider.get("name") or "unknown"
        api_key = str(provider.get("api_key") or "").strip()

        if not api_key:
            continue

        if not _is_env_secret_ref(api_key):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Provider '{provider_id}' uses a plaintext api_key. "
                    "Only env references are allowed (env:VAR_NAME or ${VAR_NAME})."
                ),
            )


def _save_providers(data: list):
    _validate_provider_secrets(data)
    os.makedirs(settings.DATA_DIR, exist_ok=True)
    with open(_providers_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    invalidate_provider_cache()


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
    rows = (
        db.query(
            User.id,
            User.username,
            User.role,
            User.is_active,
            User.storage_used,
            func.count(ChatSession.id).label("chat_count"),
        )
        .outerjoin(ChatSession, ChatSession.user_id == User.id)
        .group_by(User.id, User.username, User.role, User.is_active, User.storage_used)
        .order_by(User.id.asc())
        .all()
    )

    return [
        {
            "id": row.id,
            "username": row.username,
            "role": row.role,
            "is_active": row.is_active,
            "storage_used": row.storage_used or 0,
            "chat_count": int(row.chat_count or 0),
        }
        for row in rows
    ]


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

    pw_error = validate_password_policy(req.password)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

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


# --- Local model management (llama.cpp) ---

@router.post("/models/local/upload")
async def upload_local_model_api(
    file: UploadFile = File(...),
    user: User = Depends(get_admin),
):
    result = upload_local_model(file)
    return {
        "status": "ok",
        "message": result.get("message", "模型上传成功"),
        "model": result.get("model"),
    }


@router.put("/models/local/{model_ref}/enable")
async def set_local_model_enabled_api(
    model_ref: str,
    enabled: bool = Query(...),
    user: User = Depends(get_admin),
):
    model = set_local_model_enabled(model_ref, enabled)
    state = "启用" if enabled else "禁用"
    return {
        "status": "ok",
        "message": f"模型已{state}",
        "model": model,
    }


@router.delete("/models/local/{model_ref}")
async def delete_local_model_api(
    model_ref: str,
    user: User = Depends(get_admin),
):
    removed = delete_local_model(model_ref)
    return {
        "status": "ok",
        "message": "模型已删除",
        "model": removed,
    }


# --- Provider connection test ---

@router.post("/test-provider")
async def test_provider_connection(
    req: TestProviderRequest,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    """Test connectivity to an AI provider by listing its models."""
    try:
        resolved_api_key = resolve_secret_reference(req.api_key)
        if not resolved_api_key:
            raise ValueError("Provider API key is not configured. Use env:VAR_NAME and set the environment variable.")

        client = get_async_openai_client(
            api_key=resolved_api_key,
            base_url=req.base_url,
            timeout=15.0,
        )
        models = await client.models.list()
        model_count = len(models.data) if models.data else 0
        message = f"连接成功，发现 {model_count} 个模型"
        success = True
    except Exception as e:
        message = f"连接失败: {e}"
        success = False

    # Find provider name for logging
    provider_name = ""
    for p in _get_providers():
        if p.get("id") == req.provider_id:
            provider_name = p.get("name", "")
            break

    db.add(ProviderTestResult(
        provider_id=req.provider_id,
        provider_name=provider_name,
        success=success,
        message=message,
        base_url=req.base_url,
        user_id=user.id,
    ))
    db.commit()

    return {"success": success, "message": message}
