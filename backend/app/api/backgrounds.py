"""聊天背景图 API。

提供 5 个端点对齐前端背景图管理需求：
  GET    /api/backgrounds/                       列出当前用户的所有背景图
  POST   /api/backgrounds/upload                 上传新背景图（multipart/form-data）
  DELETE /api/backgrounds/{background_id}        删除背景图（文件 + DB 记录）
  POST   /api/backgrounds/set/{background_id}    设置为指定会话的背景（session_id 查询参数）
  GET    /api/backgrounds/active/{session_id}    获取指定会话的当前背景

文件保存在 data/backgrounds/ 目录下，DB 记录元数据。
"""

import logging
import os
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from ..api.dependencies import get_current_user
from ..core import get_db, settings
from ..models import Background, CharacterChatSession, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backgrounds", tags=["backgrounds"])

# 支持的图片格式：content-type -> 扩展名
_CONTENT_TYPE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

# 允许的扩展名白名单（用于扩展名校验）
_ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# 上传图片大小上限（10MB）
_MAX_UPLOAD_SIZE = 10 * 1024 * 1024
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024

# 背景图相对 DATA_DIR 的存储子目录
_BG_SUBDIR = "backgrounds"


def _backgrounds_dir() -> str:
    """返回背景图存储目录绝对路径。"""
    return os.path.join(settings.DATA_DIR, _BG_SUBDIR)


def _relative_path(filename: str) -> str:
    """返回相对 DATA_DIR 的路径（存入 DB 的 path 字段）。"""
    return os.path.join(_BG_SUBDIR, filename).replace("\\", "/")


async def _read_upload_with_limit(file: UploadFile) -> bytes:
    """读取上传文件内容，超限则抛出 413。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Background image too large (max {_MAX_UPLOAD_SIZE // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _resolve_extension(filename: str | None, content_type: str | None) -> str:
    """根据文件名或 content-type 推断扩展名，校验白名单。"""
    ext = ""
    if filename:
        _, file_ext = os.path.splitext(filename)
        ext = (file_ext or "").lower()
    if not ext and content_type:
        ext = _CONTENT_TYPE_EXT.get((content_type or "").lower(), "")
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported image format; allowed: png, jpg, jpeg, webp, gif",
        )
    return ext


@router.get("/")
async def list_backgrounds(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """返回当前用户的所有背景图列表。"""
    rows = (
        db.query(Background)
        .filter(Background.user_id == user.id)
        .order_by(Background.created_at.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "filename": row.filename,
            "original_filename": row.original_filename,
            "path": row.path,
            "is_default": bool(row.is_default),
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
    ]


@router.post("/upload")
async def upload_background(
    file: UploadFile = File(...),
    is_default: bool = Form(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传背景图。

    保存到 data/backgrounds/{uuid}{ext}，返回新创建的 Background 对象。
    """
    ext = _resolve_extension(file.filename, file.content_type)
    original_filename = file.filename or ""

    target_dir = _backgrounds_dir()
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create backgrounds dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create backgrounds directory")

    # 使用 uuid 避免重名
    stored_filename = f"{uuid.uuid4().hex}{ext}"
    target_path = os.path.join(target_dir, stored_filename)

    try:
        data = await _read_upload_with_limit(file)
        with open(target_path, "wb") as fp:
            fp.write(data)
    except HTTPException:
        raise
    except OSError as exc:
        logger.error("Failed to write background file %s: %s", target_path, exc)
        raise HTTPException(status_code=400, detail="Failed to save background image")

    # 如果标记为默认，先清除该用户其他默认
    if is_default:
        db.query(Background).filter(
            Background.user_id == user.id,
            Background.is_default.is_(True),
        ).update({Background.is_default: False}, synchronize_session=False)

    record = Background(
        id=str(uuid.uuid4()),
        user_id=user.id,
        filename=stored_filename,
        original_filename=original_filename or None,
        path=_relative_path(stored_filename),
        is_default=is_default,
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    return {
        "id": record.id,
        "filename": record.filename,
        "original_filename": record.original_filename,
        "path": record.path,
        "is_default": bool(record.is_default),
    }


@router.delete("/{background_id}")
async def delete_background(
    background_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除背景图（文件 + DB 记录）。"""
    record = (
        db.query(Background)
        .filter(
            Background.id == background_id,
            Background.user_id == user.id,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Background not found")

    file_path = os.path.join(settings.DATA_DIR, record.path)
    if os.path.isfile(file_path):
        try:
            os.remove(file_path)
        except OSError as exc:
            logger.warning("Failed to remove background file %s: %s", file_path, exc)

    db.delete(record)
    db.commit()
    return {"deleted": background_id}


@router.post("/set/{background_id}")
async def set_session_background(
    background_id: str,
    session_id: str = Query(..., description="Target CharacterChatSession id"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """将指定背景图设置为当前会话的背景。"""
    record = (
        db.query(Background)
        .filter(
            Background.id == background_id,
            Background.user_id == user.id,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Background not found")

    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")

    session.background = record.filename
    db.commit()

    return {
        "session_id": session.id,
        "background": record.filename,
        "path": record.path,
    }


@router.get("/active/{session_id}")
async def get_session_background(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前会话的背景。"""
    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")

    bg_filename = getattr(session, "background", None) or None
    record = None
    if bg_filename:
        record = (
            db.query(Background)
            .filter(
                Background.user_id == user.id,
                Background.filename == bg_filename,
            )
            .first()
        )

    if record is None:
        return {
            "session_id": session.id,
            "background": None,
            "path": None,
            "is_default": False,
        }

    return {
        "session_id": session.id,
        "background": record.filename,
        "path": record.path,
        "is_default": bool(record.is_default),
    }
