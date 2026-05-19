import os
import asyncio
import uuid
import logging
import time
from typing import Optional, Set, Dict, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, File, UploadFile
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..api.dependencies import get_current_user, get_admin
from ..models import User
from ..services.provider_registry import get_providers, get_model_vision_support
from ..services.local_model_registry import list_enabled_chat_models, list_local_models
from ..services.unified_model_registry import (
    get_unified_model_list,
    get_flat_model_list,
    save_unified_model_config,
    get_routing_strategies,
    invalidate_registry_cache,
)
from ..utils import normalize_upload_filename

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)


_TEXT_LIKE_EXTENSIONS = {
    ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".cpp", ".c",
    ".h", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".xml", ".html", ".css", ".csv",
}


def _parse_extensions(raw: str) -> Set[str]:
    return {
        f".{ext.strip().lower().lstrip('.')}"
        for ext in (raw or "").split(",")
        if ext and ext.strip()
    }


_storage_cache: Dict[int, Tuple[float, int]] = {}
_STORAGE_CACHE_TTL = 60.0


def _directory_size_bytes(path: str, user_id: int = 0) -> int:
    now = time.monotonic()
    if user_id and user_id in _storage_cache:
        cached_ts, cached_size = _storage_cache[user_id]
        if now - cached_ts < _STORAGE_CACHE_TTL:
            return cached_size
    total = 0
    if not os.path.exists(path):
        if user_id:
            _storage_cache[user_id] = (now, 0)
        return 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            fp = os.path.join(root, name)
            try:
                total += os.path.getsize(fp)
            except OSError:
                continue
    if user_id:
        _storage_cache[user_id] = (now, total)
    return total


def _has_expected_magic(extension: str, content: bytes) -> bool:
    if extension in _TEXT_LIKE_EXTENSIONS:
        return True

    if extension == ".png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if extension in {".jpg", ".jpeg"}:
        return content.startswith(b"\xff\xd8\xff")
    if extension == ".gif":
        return content.startswith(b"GIF87a") or content.startswith(b"GIF89a")
    if extension == ".webp":
        return len(content) > 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP"
    if extension == ".pdf":
        return content.startswith(b"%PDF")
    if extension in {".zip", ".docx", ".xlsx"}:
        return content.startswith(b"PK\x03\x04")
    if extension == ".gz":
        return content.startswith(b"\x1f\x8b")
    if extension == ".7z":
        return content.startswith(b"7z\xbc\xaf\x27\x1c")
    if extension == ".rar":
        return content.startswith(b"Rar!\x1a\x07\x00") or content.startswith(b"Rar!\x1a\x07\x01\x00")

    return True


async def _validate_chat_upload(user: User, filename: str, file_bytes: bytes, mime_hint: Optional[str]) -> str:
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file is not allowed")

    safe_filename = normalize_upload_filename(filename)
    extension = os.path.splitext(safe_filename)[1].lower()
    if not extension:
        raise HTTPException(status_code=400, detail="File extension is required")

    blocked = _parse_extensions(settings.CHAT_UPLOAD_BLOCKED_EXTENSIONS)
    if extension in blocked:
        raise HTTPException(status_code=400, detail=f"Blocked file type: {extension}")

    allowed = _parse_extensions(settings.CHAT_UPLOAD_ALLOWED_EXTENSIONS)
    if allowed and extension not in allowed:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {extension}")

    max_file_size = max(0, settings.CHAT_UPLOAD_MAX_FILE_SIZE_MB) * 1024 * 1024
    if max_file_size and len(file_bytes) > max_file_size:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max size: {settings.CHAT_UPLOAD_MAX_FILE_SIZE_MB}MB",
        )

    user_dir = os.path.join(settings.UPLOAD_DIR, str(user.id))
    user_usage = await asyncio.to_thread(_directory_size_bytes, user_dir, user.id)
    max_user_size = max(0, settings.CHAT_UPLOAD_MAX_USER_STORAGE_MB) * 1024 * 1024
    if max_user_size and (user_usage + len(file_bytes)) > max_user_size:
        raise HTTPException(
            status_code=413,
            detail=f"Upload quota exceeded. Max quota: {settings.CHAT_UPLOAD_MAX_USER_STORAGE_MB}MB",
        )

    if mime_hint and extension in {".png", ".jpg", ".jpeg", ".gif", ".webp"} and not mime_hint.startswith("image/"):
        raise HTTPException(status_code=400, detail="MIME type does not match image upload")

    if not _has_expected_magic(extension, file_bytes[:32]):
        raise HTTPException(status_code=400, detail=f"File signature mismatch for {extension}")

    return safe_filename


@router.get("/api/models")
async def get_models(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取所有启用服务商的可用模型列表"""
    result = []
    seen_ids: Set[str] = set()

    for p in get_providers():
        if not p.get("is_active"):
            continue
        for m in p.get("models", []):
            if isinstance(m, dict):
                display_name = m.get("name") or m.get("alias") or m["id"]
                model_id = m["id"]
                item = {
                    "id": model_id,
                    "name": display_name,
                    "alias": display_name,
                    "icon": m.get("icon", "🤖"),
                    "description": m.get("description", ""),
                    "context_length": m.get("context_length", 4096),
                    "avatar": m.get("avatar", ""),
                    "provider": p["name"],
                    "provider_id": p.get("id", ""),
                    "supports_vision": get_model_vision_support(model_id, m),
                }
            else:
                model_id = str(m)
                item = {
                    "id": model_id, "name": m, "icon": "🤖", "description": "",
                    "context_length": 4096, "avatar": "", "provider": p["name"],
                    "provider_id": p.get("id", ""),
                    "supports_vision": get_model_vision_support(model_id),
                }

            model_id = str(item.get("id") or "")
            if model_id and model_id not in seen_ids:
                seen_ids.add(model_id)
                result.append(item)

    for local_model in list_enabled_chat_models():
        model_id = str(local_model.get("id") or "")
        if model_id and model_id not in seen_ids:
            seen_ids.add(model_id)
            result.append(local_model)

    from ..models.system import UserSetting
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if user_setting and user_setting.developer_mode:
        test_model_id = "local:test-model"
        if test_model_id not in seen_ids:
            seen_ids.add(test_model_id)
            result.append({
                "id": test_model_id,
                "name": "测试模型 (开发者)",
                "alias": "测试模型 (开发者)",
                "icon": "🧪",
                "description": "开发者模式专用，返回预设示例回复",
                "context_length": 4096,
                "avatar": "",
                "provider": "开发者",
                "provider_id": "developer",
                "supports_vision": False,
                "is_test_model": True,
            })

    return result


@router.post("/api/upload")
async def upload_file(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """multipart 文件上传（聊天图片/附件）"""
    try:
        file_bytes = await file.read()
        mime_hint = file.content_type

        safe_filename = await _validate_chat_upload(user=user, filename=file.filename or "upload.bin", file_bytes=file_bytes, mime_hint=mime_hint)

        user_dir = os.path.join(settings.UPLOAD_DIR, str(user.id))
        os.makedirs(user_dir, exist_ok=True)

        unique_name = f"{uuid.uuid4().hex}_{safe_filename}"
        filepath = os.path.join(user_dir, unique_name)
        with open(filepath, "wb") as f:
            f.write(file_bytes)

        _storage_cache.pop(user.id, None)

        return {
            "url": f"/api/uploads/{user.id}/{unique_name}",
            "filename": safe_filename,
            "size": len(file_bytes),
            "mime_type": mime_hint or "application/octet-stream",
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to upload chat file")
        raise HTTPException(status_code=500, detail="Failed to upload file")


@router.get("/api/models/local")
async def get_local_models(all: bool = Query(False), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取本地上传的模型文件列表"""
    include_disabled = bool(all and user.role == "admin")
    models = list_local_models(include_disabled=include_disabled)

    # 检查用户是否开启开发者模式
    from ..models.system import UserSetting
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if user_setting and user_setting.developer_mode:
        # 添加测试模型
        test_model = {
            "id": "local:test-model",
            "key": "test-model",
            "display_name": "测试模型 (开发者)",
            "filename": "test-model.gguf",
            "enabled": True,
            "size_gb": 0.001,
            "context_length": 4096,
            "supports_vision": False,
            "is_test_model": True,
        }
        models.append(test_model)

    return models


@router.get("/api/models/unified")
async def get_unified_models(user: User = Depends(get_current_user)):
    """获取统一模型列表（含多提供商信息）"""
    return get_unified_model_list()


@router.get("/api/models/unified/flat")
async def get_unified_models_flat(user: User = Depends(get_current_user)):
    """获取扁平化的统一模型列表（用于聊天模型选择器）"""
    return get_flat_model_list()


@router.get("/api/models/unified/strategies")
async def get_model_routing_strategies(user: User = Depends(get_current_user)):
    """获取可用的路由策略列表"""
    return get_routing_strategies()


class ProviderOverrideItem(BaseModel):
    priority: Optional[int] = None
    weight: Optional[int] = None
    enabled: Optional[bool] = None
    max_rpm: Optional[int] = None
    max_concurrent: Optional[int] = None
    max_tokens_per_min: Optional[int] = None


class UnifiedModelConfigRequest(BaseModel):
    display_name: Optional[str] = None
    icon: Optional[str] = None
    description: Optional[str] = None
    routing_strategy: Optional[str] = None
    failover_enabled: Optional[bool] = None
    provider_overrides: Optional[dict] = None


@router.put("/api/models/unified/{unified_id}")
async def update_unified_model_config(
    unified_id: str,
    req: UnifiedModelConfigRequest,
    user: User = Depends(get_admin),
):
    """更新统一模型配置（显示名、路由策略、提供商优先级等）"""
    result = save_unified_model_config(
        unified_id=unified_id,
        display_name=req.display_name,
        icon=req.icon,
        description=req.description,
        routing_strategy=req.routing_strategy,
        failover_enabled=req.failover_enabled,
        provider_overrides=req.provider_overrides,
    )
    return result
