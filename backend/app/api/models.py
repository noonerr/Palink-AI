import os
import uuid
import base64
import logging
import json
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)


def _get_providers() -> list:
    cfg = os.path.join(settings.DATA_DIR, "providers.json")
    try:
        with open(cfg, "r") as f:
            return json.load(f)
    except Exception:
        return []


class UploadRequest(BaseModel):
    filename: str
    data: str  # base64 data URL


@router.get("/api/models")
async def get_models():
    """获取所有启用服务商的可用模型列表"""
    result = []
    for p in _get_providers():
        if not p.get("is_active"):
            continue
        for m in p.get("models", []):
            if isinstance(m, dict):
                result.append({
                    "id": m["id"],
                    "name": m.get("alias", m["id"]),
                    "icon": m.get("icon", "🤖"),
                    "description": m.get("description", ""),
                    "context_length": m.get("context_length", 4096),
                    "avatar": m.get("avatar", ""),
                    "provider": p["name"],
                })
            else:
                result.append({
                    "id": m, "name": m, "icon": "🤖", "description": "",
                    "context_length": 4096, "avatar": "", "provider": p["name"],
                })
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
    models_dir = os.path.join(settings.DATA_DIR, "models")
    if not os.path.exists(models_dir):
        return []
    result = []
    for fname in os.listdir(models_dir):
        fpath = os.path.join(models_dir, fname)
        if os.path.isfile(fpath):
            result.append({
                "id": fname,
                "name": fname,
                "size": os.path.getsize(fpath),
                "path": fpath,
            })
    return result
