import os
import uuid
import shutil
import base64
import logging
from typing import Optional, List, Set

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User, UserFolder, UserFile
from ..schemas import FolderCreate
from ..services.inference_dispatcher import complete_text_completion, ensure_model_available

router = APIRouter(prefix="/api/workspace", tags=["workspace"])
logger = logging.getLogger(__name__)


# --- helpers ---

def _clean_id(val: Optional[str]) -> Optional[str]:
    if not val or str(val).lower() in ("null", "undefined", "none", ""):
        return None
    return str(val)


def _workspace_allowed_extensions() -> Set[str]:
    raw = settings.WORKSPACE_ALLOWED_EXTENSIONS or ""
    return {
        f".{ext.strip().lower().lstrip('.')}"
        for ext in raw.split(",")
        if ext and ext.strip()
    }


def _normalize_upload_filename(filename: Optional[str]) -> str:
    safe_name = os.path.basename(filename or "").strip()
    if not safe_name:
        safe_name = f"upload_{uuid.uuid4().hex}.bin"
    return safe_name


def _validate_workspace_upload(user: User, file_size: int, filename: str) -> None:
    if file_size <= 0:
        raise HTTPException(status_code=400, detail="Empty file is not allowed")

    max_file_size_bytes = max(0, settings.WORKSPACE_MAX_FILE_SIZE_MB) * 1024 * 1024
    if max_file_size_bytes and file_size > max_file_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max size: {settings.WORKSPACE_MAX_FILE_SIZE_MB}MB",
        )

    extension = os.path.splitext(filename)[1].lower()
    allowed_extensions = _workspace_allowed_extensions()
    if allowed_extensions and extension not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"File type not allowed: {extension or '[none]'}",
        )

    max_storage_bytes = max(0, settings.WORKSPACE_MAX_USER_STORAGE_MB) * 1024 * 1024
    if max_storage_bytes and ((user.storage_used or 0) + file_size) > max_storage_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Storage quota exceeded. Max quota: {settings.WORKSPACE_MAX_USER_STORAGE_MB}MB",
        )




# --- schemas ---

class FileMove(BaseModel):
    file_ids: List[str] = []
    folder_ids: List[str] = []
    target_folder_id: Optional[str] = None


class DeleteRequest(BaseModel):
    file_ids: List[str] = []
    folder_ids: List[str] = []


class AnalyzeRequest(BaseModel):
    file_id: str
    model: str
    lang: str = "zh"


# --- routes ---

@router.get("")
async def get_workspace(
    parent_id: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    pid = _clean_id(parent_id)
    folders = db.query(UserFolder).filter(
        UserFolder.user_id == user.id, UserFolder.parent_id == pid
    ).all()
    files = db.query(UserFile).filter(
        UserFile.user_id == user.id, UserFile.folder_id == pid
    ).all()

    # Build breadcrumb path
    path = []
    current = pid
    while current:
        f = db.query(UserFolder).filter(UserFolder.id == current).first()
        if f:
            path.insert(0, {"id": f.id, "name": f.name})
            current = f.parent_id
        else:
            break

    return {
        "folders": [{"id": f.id, "name": f.name, "created_at": f.created_at} for f in folders],
        "files": [
            {
                "id": f.id,
                "filename": f.filename,
                "size": f.file_size,
                "url": f"/api/workspace/file/{f.id}",
                "type": f.mime_type,
                "created_at": f.created_at,
                "summary": f.summary,
            }
            for f in files
        ],
        "path": path,
        "usage": user.storage_used or 0,
        "limit": 0,
    }


@router.post("/folder")
async def create_folder(
    req: FolderCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    pid = _clean_id(req.parent_id)
    db.add(UserFolder(user_id=user.id, name=req.name, parent_id=pid))
    db.commit()
    return {"status": "ok"}


@router.post("/upload")
async def upload_workspace_file(
    file: UploadFile = File(...),
    folder_id: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)

    original_name = _normalize_upload_filename(file.filename)
    _validate_workspace_upload(user=user, file_size=size, filename=original_name)

    fid = _clean_id(folder_id)
    if fid:
        folder = db.query(UserFolder).filter(
            UserFolder.id == fid,
            UserFolder.user_id == user.id,
        ).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Target folder not found")

    user_dir = os.path.join(settings.WORKSPACE_DIR, str(user.id))
    os.makedirs(user_dir, exist_ok=True)

    safe_name = f"{uuid.uuid4()}_{original_name}"
    file_path = os.path.join(user_dir, safe_name)

    try:
        with open(file_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {e}")

    try:
        db_file = UserFile(
            user_id=user.id,
            folder_id=fid,
            filename=original_name,
            file_path=file_path,
            file_size=size,
            mime_type=file.content_type or "application/octet-stream",
        )
        user.storage_used = (user.storage_used or 0) + size
        db.add(db_file)
        db.commit()
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"Database error: {e}")

    return {"status": "ok", "file": {"id": db_file.id, "filename": db_file.filename}}


@router.post("/move")
async def move_items(
    req: FileMove,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    target = _clean_id(req.target_folder_id)
    if req.file_ids:
        db.query(UserFile).filter(
            UserFile.id.in_(req.file_ids), UserFile.user_id == user.id
        ).update({"folder_id": target}, synchronize_session=False)
    if req.folder_ids:
        if target in req.folder_ids:
            raise HTTPException(status_code=400, detail="Cannot move a folder into itself")
        db.query(UserFolder).filter(
            UserFolder.id.in_(req.folder_ids), UserFolder.user_id == user.id
        ).update({"parent_id": target}, synchronize_session=False)
    db.commit()
    return {"status": "ok"}


@router.delete("/delete")
async def delete_items(
    req: DeleteRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    freed = 0
    if req.file_ids:
        files = db.query(UserFile).filter(
            UserFile.id.in_(req.file_ids), UserFile.user_id == user.id
        ).all()
        for f in files:
            if os.path.exists(f.file_path):
                try:
                    os.remove(f.file_path)
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"Failed to delete file '{f.filename}': {e}")
            freed += f.file_size or 0
            db.delete(f)
    if req.folder_ids:
        folders = db.query(UserFolder).filter(
            UserFolder.id.in_(req.folder_ids), UserFolder.user_id == user.id
        ).all()
        for fol in folders:
            db.delete(fol)
    user.storage_used = max(0, (user.storage_used or 0) - freed)
    db.commit()
    return {"status": "ok"}


@router.get("/file/{file_id}")
async def download_workspace_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    f = db.query(UserFile).filter(
        UserFile.id == file_id,
        UserFile.user_id == user.id,
    ).first()
    if not f or not os.path.exists(f.file_path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(f.file_path, filename=f.filename)


@router.post("/analyze")
async def analyze_workspace_file(
    req: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    f = db.query(UserFile).filter(UserFile.id == req.file_id, UserFile.user_id == user.id).first()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    try:
        ensure_model_available(req.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Read text content
    text_exts = (".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".html", ".css", ".yaml", ".yml")
    content = ""
    if f.mime_type and f.mime_type.startswith("text/") or f.filename.endswith(text_exts):
        try:
            with open(f.file_path, "r", encoding="utf-8", errors="ignore") as fo:
                content = fo.read(settings.WORKSPACE_ANALYZE_MAX_CHARS)
        except Exception:
            content = "[Unreadable text content]"
    else:
        content = f"[Binary file: {f.filename}]"

    lang_hint = "Respond in English." if req.lang == "en" else "请使用中文回答。"
    prompt = (
        f"Analyze the following file and provide a structured outline with key points and a brief summary.\n"
        f"{lang_hint}\n\nFileName: {f.filename}\n\nContent:\n{content}"
    )

    try:
        completion = await complete_text_completion(
            model_id=req.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
            max_tokens=1200,
            timeout=30.0,
        )
        summary_text = completion.get("content") or ""
        f.summary = summary_text
        db.commit()
        return {"status": "ok", "summary": summary_text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")
