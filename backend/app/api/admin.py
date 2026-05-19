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
from ..models import User, ChatSession, ChatMessage, SystemSetting, Character, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch, UserFile, UserFolder
from ..schemas import ProviderModel, ProviderConfig, DefaultModelConfig, TestProviderRequest
from ..models.system import ProviderTestResult
from ..services.provider_registry import get_providers, invalidate_provider_cache, resolve_secret_reference, _providers_path
from ..services.web_search import get_web_search_config, save_web_search_config, search_web, validate_web_search_config, _get_raw_config
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

        if _is_env_secret_ref(api_key):
            pass
        elif settings.APP_ENV != "development":
            raise HTTPException(
                status_code=400,
                detail=f"Provider '{provider_id}' uses a plaintext API key. "
                       "Production mode requires environment variable references (env:VAR_NAME) for API keys.",
            )
        else:
            logging.warning(
                "Provider '%s' uses a plaintext API key. "
                "For production use, consider using env:VAR_NAME format instead.",
                provider_id,
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
    _save_providers([d.model_dump() for d in data])
    return {"status": "ok"}


@router.delete("/providers/{provider_id}")
async def delete_provider_api(provider_id: str, user: User = Depends(get_admin)):
    providers = _get_providers()
    original_len = len(providers)
    updated = [p for p in providers if p.get("id") != provider_id]
    if len(updated) == original_len:
        raise HTTPException(status_code=404, detail="Provider not found")
    _save_providers(updated)
    return {"status": "ok", "message": "Provider deleted"}


# --- System defaults ---

@router.get("/system/defaults")
async def get_system_defaults(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    if setting:
        try:
            return json.loads(setting.value)
        except (json.JSONDecodeError, TypeError):
            logger.warning("Corrupted default_model_config, returning empty")
    return {}


@router.post("/system/defaults")
async def set_system_defaults(config: DefaultModelConfig, user: User = Depends(get_admin), db: Session = Depends(get_db)):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first()
    value = json.dumps(config.model_dump())
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
    if not usr:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        user_sessions = db.query(ChatSession).filter(ChatSession.user_id == user_id).all()
        session_ids = [s.id for s in user_sessions]
        if session_ids:
            db.query(ChatMessage).filter(ChatMessage.session_id.in_(session_ids)).delete(synchronize_session=False)
        db.query(ChatSession).filter(ChatSession.user_id == user_id).delete()

        user_characters = db.query(Character).filter(Character.user_id == user_id).all()
        char_ids = [c.id for c in user_characters]
        if char_ids:
            char_sessions = db.query(CharacterChatSession).filter(
                CharacterChatSession.character_id.in_(char_ids)
            ).all()
            cs_ids = [cs.id for cs in char_sessions]
            if cs_ids:
                db.query(CharacterChatSessionBranch).filter(
                    CharacterChatSessionBranch.session_id.in_(cs_ids)
                ).delete(synchronize_session=False)
                db.query(CharacterChatMessage).filter(
                    CharacterChatMessage.session_id.in_(cs_ids)
                ).delete(synchronize_session=False)
            db.query(CharacterChatSession).filter(
                CharacterChatSession.character_id.in_(char_ids)
            ).delete(synchronize_session=False)
        db.query(Character).filter(Character.user_id == user_id).delete()

        user_files = db.query(UserFile).filter(UserFile.user_id == user_id).all()
        for uf in user_files:
            if uf.file_path and os.path.isfile(uf.file_path):
                try:
                    os.remove(uf.file_path)
                except Exception as e:
                    logger.warning("Failed to delete file %s: %s", uf.file_path, e)
        db.query(UserFile).filter(UserFile.user_id == user_id).delete()
        db.query(UserFolder).filter(UserFolder.user_id == user_id).delete()

        user_upload_dir = os.path.join(settings.UPLOAD_DIR, str(user_id))
        if os.path.isdir(user_upload_dir):
            try:
                import shutil
                shutil.rmtree(user_upload_dir, ignore_errors=True)
            except Exception as e:
                logger.warning("Failed to remove upload directory %s: %s", user_upload_dir, e)

        db.delete(usr)
        db.commit()
    except Exception:
        db.rollback()
        raise

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
        .limit(500)
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


@router.put("/models/local/{model_ref}/mmproj")
async def set_local_model_mmproj_api(
    model_ref: str,
    mmproj_enabled: bool = Query(...),
    user: User = Depends(get_admin),
):
    from ..services.local_model_registry import _load_registry, _save_registry, _find_model_entry, _normalize_model_view, _now_iso
    data = _load_registry()
    model = _find_model_entry(data, model_ref)
    if not model:
        raise HTTPException(status_code=404, detail="Local model not found")

    model["mmproj_enabled"] = bool(mmproj_enabled)
    model["updated_at"] = _now_iso()
    _save_registry(data)

    from datetime import datetime, timezone
    return {
        "status": "ok",
        "message": f"视觉编码器已{'启用' if mmproj_enabled else '禁用'}",
        "model": _normalize_model_view(model),
    }


@router.get("/models/local/mmproj-files")
async def list_mmproj_files(
    user: User = Depends(get_admin),
):
    from ..services.local_model_registry import _models_dir
    models_dir = _models_dir()
    mmproj_files = []
    if os.path.isdir(models_dir):
        for fname in os.listdir(models_dir):
            if "mmproj" in fname.lower() and fname.lower().endswith(".gguf"):
                fpath = os.path.join(models_dir, fname)
                mmproj_files.append({
                    "filename": fname,
                    "path": fpath,
                    "size_bytes": os.path.getsize(fpath) if os.path.isfile(fpath) else 0,
                })
    return mmproj_files


@router.put("/models/local/{model_ref}/mmproj-path")
async def set_local_model_mmproj_path_api(
    model_ref: str,
    req: dict,
    user: User = Depends(get_admin),
):
    from ..services.local_model_registry import _load_registry, _save_registry, _find_model_entry, _normalize_model_view, _now_iso
    data = _load_registry()
    model = _find_model_entry(data, model_ref)
    if not model:
        raise HTTPException(status_code=404, detail="Local model not found")

    mmproj_path = req.get("mmproj_path")
    mmproj_enabled = req.get("mmproj_enabled", True)

    if mmproj_path and not os.path.isfile(mmproj_path):
        raise HTTPException(status_code=400, detail=f"mmproj file not found: {mmproj_path}")

    if mmproj_path:
        from ..services.local_model_registry import _models_dir
        models_root = os.path.realpath(_models_dir())
        mmproj_real = os.path.realpath(mmproj_path)
        if not mmproj_real.startswith(models_root + os.sep):
            raise HTTPException(status_code=400, detail="mmproj file must be within models directory")

    model["mmproj_path"] = mmproj_path or None
    model["mmproj_enabled"] = bool(mmproj_enabled) if mmproj_path else False
    model["updated_at"] = _now_iso()
    _save_registry(data)

    return {
        "status": "ok",
        "message": f"视觉编码器已{'配置' if mmproj_path else '移除'}",
        "model": _normalize_model_view(model),
    }


@router.put("/models/local/{model_ref}/max-concurrent")
async def set_local_model_max_concurrent_api(
    model_ref: str,
    req: dict,
    user: User = Depends(get_admin),
):
    from ..services.local_model_registry import _load_registry, _save_registry, _find_model_entry, _normalize_model_view, _now_iso
    from ..services.inference_queue import inference_queue
    data = _load_registry()
    model = _find_model_entry(data, model_ref)
    if not model:
        raise HTTPException(status_code=404, detail="Local model not found")

    max_concurrent = req.get("max_concurrent", 1)
    max_concurrent = max(1, min(int(max_concurrent), 8))

    model["max_concurrent"] = max_concurrent
    model["updated_at"] = _now_iso()
    _save_registry(data)

    model_key = str(model.get("key") or "")
    if model_key:
        inference_queue.set_model_max_concurrent(model_key, max_concurrent)

    return {
        "status": "ok",
        "message": f"并发数已设置为 {max_concurrent}",
        "model": _normalize_model_view(model),
    }


@router.put("/models/local/{model_ref}/vision-source")
async def set_local_model_vision_source_api(
    model_ref: str,
    req: dict,
    user: User = Depends(get_admin),
):
    from ..services.local_model_registry import _load_registry, _save_registry, _find_model_entry, _normalize_model_view, _now_iso
    data = _load_registry()
    model = _find_model_entry(data, model_ref)
    if not model:
        raise HTTPException(status_code=404, detail="Local model not found")

    vision_source = req.get("vision_source") or None

    if vision_source and vision_source.startswith("local:"):
        proxy_key = vision_source[len("local:"):]
        if proxy_key == model.get("key"):
            raise HTTPException(status_code=400, detail="Cannot use self as vision proxy")
        model["mmproj_enabled"] = False
    else:
        vision_source = None

    model["vision_source"] = vision_source
    model["vision_mode"] = None
    model["vision_proxy_model"] = None
    model["vision_api_model"] = None

    model["updated_at"] = _now_iso()
    _save_registry(data)

    return {
        "status": "ok",
        "message": f"视觉来源已设置",
        "model": _normalize_model_view(model),
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


@router.put("/providers/{provider_id}/models/{model_id}/vision-support")
async def set_api_model_vision_support(
    provider_id: str,
    model_id: str,
    req: dict,
    user: User = Depends(get_admin),
):
    from ..services.provider_registry import get_providers, invalidate_provider_cache
    providers = get_providers()
    provider = None
    for p in providers:
        if p.get("id") == provider_id:
            provider = p
            break
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    model_entry = None
    for m in provider.get("models", []):
        mid = m["id"] if isinstance(m, dict) else m
        if mid == model_id:
            model_entry = m
            break
    if not model_entry:
        raise HTTPException(status_code=404, detail="Model not found in provider")

    if not isinstance(model_entry, dict):
        idx = provider["models"].index(model_entry)
        model_entry = {"id": model_entry, "alias": model_entry}
        provider["models"][idx] = model_entry

    supports_vision = req.get("supports_vision")
    if supports_vision is None:
        model_entry.pop("supports_vision", None)
    else:
        model_entry["supports_vision"] = bool(supports_vision)

    path = os.path.join(settings.DATA_DIR, "providers.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(providers, f, ensure_ascii=False, indent=2)

    invalidate_provider_cache()

    return {
        "status": "ok",
        "message": f"视觉支持已更新",
        "model_id": model_id,
        "supports_vision": model_entry.get("supports_vision"),
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
        saved_base_urls = {p.get("base_url", "").rstrip("/") for p in _get_providers() if p.get("base_url")}
        req_base_url = (req.base_url or "").rstrip("/")
        is_trusted_url = req_base_url in saved_base_urls

        if _is_env_secret_ref(req.api_key) and not is_trusted_url:
            raise ValueError(
                "Cannot resolve environment variable secrets for untrusted base_url. "
                "Save the provider first, then test with its saved base_url."
            )

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


# --- Image cleanup settings ---

class ImageCleanupConfig(BaseModel):
    enabled: bool = True
    max_age_days: int = 30

@router.get("/image-cleanup")
async def get_image_cleanup_config(
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "image_cleanup_config").first()
    if setting:
        try:
            return json.loads(setting.value)
        except Exception:
            pass
    return {"enabled": True, "max_age_days": 30}

@router.put("/image-cleanup")
async def set_image_cleanup_config(
    req: ImageCleanupConfig,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "image_cleanup_config").first()
    val = json.dumps({"enabled": req.enabled, "max_age_days": req.max_age_days})
    if setting:
        setting.value = val
    else:
        db.add(SystemSetting(key="image_cleanup_config", value=val))
    db.commit()
    return {"status": "ok", "config": {"enabled": req.enabled, "max_age_days": req.max_age_days}}

@router.post("/image-cleanup/run")
async def run_image_cleanup(
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "image_cleanup_config").first()
    max_age_days = 30
    if setting:
        try:
            config = json.loads(setting.value)
            max_age_days = config.get("max_age_days", 30)
        except Exception:
            pass

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    upload_dir = settings.UPLOAD_DIR
    deleted_count = 0
    total_size = 0

    if os.path.isdir(upload_dir):
        for user_dir_name in os.listdir(upload_dir):
            user_dir_path = os.path.join(upload_dir, user_dir_name)
            if not os.path.isdir(user_dir_path):
                continue
            for fname in os.listdir(user_dir_path):
                fpath = os.path.join(user_dir_path, fname)
                try:
                    mtime = datetime.fromtimestamp(os.path.getmtime(fpath), tz=timezone.utc)
                    if mtime < cutoff:
                        fsize = os.path.getsize(fpath)
                        os.remove(fpath)
                        deleted_count += 1
                        total_size += fsize
                except Exception:
                    continue

    return {
        "status": "ok",
        "deleted_count": deleted_count,
        "freed_bytes": total_size,
        "freed_mb": round(total_size / (1024 * 1024), 2),
        "max_age_days": max_age_days,
    }


# --- Web Search ---

class WebSearchConfig(BaseModel):
    enabled: bool = False
    engine: str = "searxng"
    searxng_url: str = "http://localhost:8080"
    brave_api_key: str = ""
    baidu_cookie: str = ""
    custom_url: str = ""
    custom_engine: str = "searxng"
    search_token: str = ""

@router.get("/web-search")
async def get_web_search_settings(user: User = Depends(get_admin)):
    return get_web_search_config()

@router.post("/web-search")
async def set_web_search_settings(config: WebSearchConfig, user: User = Depends(get_admin)):
    from ..services.web_search import _is_safe_search_url
    if config.engine == "custom" and config.custom_url:
        if not _is_safe_search_url(config.custom_url):
            raise HTTPException(status_code=400, detail="Custom URL points to a private/internal address (SSRF protection)")
    if config.engine == "searxng" and config.searxng_url:
        from ..core.config import settings as app_settings
        if app_settings.APP_ENV != "development" and not _is_safe_search_url(config.searxng_url):
            raise HTTPException(status_code=400, detail="SearXNG URL points to a private/internal address (SSRF protection). In development mode, localhost is allowed.")
    saved = save_web_search_config(config.model_dump())
    return {"status": "ok", "config": saved}

@router.post("/web-search/test")
async def test_web_search(user: User = Depends(get_admin)):
    config = _get_raw_config()
    if not config.get("enabled"):
        return {"success": False, "error": "Web search is not enabled"}
    try:
        result = await validate_web_search_config(config)
        return {
            "success": result.get("valid", False),
            "message": result.get("message", ""),
            "details": result.get("details", {}),
            "zero_cost": True
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
