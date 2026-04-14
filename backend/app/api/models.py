import os
import uuid
import base64
import logging
from typing import Set

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
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
        parts = req.data.split(",", 1)
        encoded = parts[1] if len(parts) == 2 else req.data
        file_bytes = base64.b64decode(encoded)
        unique_name = f"{uuid.uuid4()}_{req.filename}"
        os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
        filepath = os.path.join(settings.UPLOAD_DIR, unique_name)
        with open(filepath, "wb") as f:
            f.write(file_bytes)
        return {"url": f"/api/uploads/{unique_name}", "filename": req.filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/models/local")
async def get_local_models(all: bool = False, user: User = Depends(get_current_user)):
    """获取本地上传的模型文件列表"""
    include_disabled = bool(all and user.role == "admin")
    return list_local_models(include_disabled=include_disabled)
