import os
import uuid
import base64
import binascii
import logging
import re
from typing import Optional, Set

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User
from ..services.provider_registry import get_providers
from ..services.local_model_registry import list_enabled_chat_models, list_local_models

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)


class UploadRequest(BaseModel):
    filename: str
    data: str  # base64 data URL


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


def _normalize_upload_filename(filename: str) -> str:
    base_name = os.path.basename((filename or "").strip())
    cleaned = re.sub(r"[^\w.\- ()\[\]]", "_", base_name)
    cleaned = cleaned.strip(" .")
    if not cleaned or cleaned in {".", ".."}:
        cleaned = f"upload_{uuid.uuid4().hex}.bin"
    return cleaned


def _directory_size_bytes(path: str) -> int:
    total = 0
    if not os.path.exists(path):
        return 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            fp = os.path.join(root, name)
            try:
                total += os.path.getsize(fp)
            except OSError:
                continue
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


def _validate_chat_upload(user: User, filename: str, file_bytes: bytes, mime_hint: Optional[str]) -> str:
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file is not allowed")

    safe_filename = _normalize_upload_filename(filename)
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
    user_usage = _directory_size_bytes(user_dir)
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
async def get_models():
    """获取所有启用服务商的可用模型列表"""
    result = []
    seen_ids: Set[str] = set()

    for p in get_providers():
        if not p.get("is_active"):
            continue
        for m in p.get("models", []):
            if isinstance(m, dict):
                display_name = m.get("name") or m.get("alias") or m["id"]
                item = {
                    "id": m["id"],
                    "name": display_name,
                    "alias": display_name,
                    "icon": m.get("icon", "🤖"),
                    "description": m.get("description", ""),
                    "context_length": m.get("context_length", 4096),
                    "avatar": m.get("avatar", ""),
                    "provider": p["name"],
                }
            else:
                item = {
                    "id": m, "name": m, "icon": "🤖", "description": "",
                    "context_length": 4096, "avatar": "", "provider": p["name"],
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

    return result


@router.post("/api/upload")
async def upload_file_base64(req: UploadRequest, user: User = Depends(get_current_user)):
    """Base64 文件上传（聊天图片/附件）"""
    try:
        payload = req.data.strip()
        mime_hint: Optional[str] = None

        match = re.match(r"^data:([^;,]+);base64,(.+)$", payload, flags=re.IGNORECASE | re.DOTALL)
        if match:
            mime_hint = match.group(1).lower().strip()
            encoded = match.group(2).strip()
        else:
            encoded = payload

        encoded = re.sub(r"\s+", "", encoded)
        missing_padding = len(encoded) % 4
        if missing_padding:
            encoded += "=" * (4 - missing_padding)

        file_bytes = base64.b64decode(encoded, validate=True)
        safe_filename = _validate_chat_upload(user=user, filename=req.filename, file_bytes=file_bytes, mime_hint=mime_hint)

        user_dir = os.path.join(settings.UPLOAD_DIR, str(user.id))
        os.makedirs(user_dir, exist_ok=True)

        unique_name = f"{uuid.uuid4().hex}_{safe_filename}"
        filepath = os.path.join(user_dir, unique_name)
        with open(filepath, "wb") as f:
            f.write(file_bytes)

        return {
            "url": f"/api/uploads/{user.id}/{unique_name}",
            "filename": safe_filename,
            "size": len(file_bytes),
            "mime_type": mime_hint or "application/octet-stream",
        }
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Invalid base64 payload")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to upload chat file")
        raise HTTPException(status_code=500, detail=f"Failed to upload file: {e}")


@router.get("/api/models/local")
async def get_local_models(all: bool = False, user: User = Depends(get_current_user)):
    """获取本地上传的模型文件列表"""
    include_disabled = bool(all and user.role == "admin")
    return list_local_models(include_disabled=include_disabled)
