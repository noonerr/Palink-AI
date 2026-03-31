import os
import uuid
import shutil
import base64
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from openai import AsyncOpenAI

from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User, UserFolder, UserFile
from ..schemas import FolderCreate
from ..services.provider_registry import find_model

router = APIRouter(prefix="/api/workspace", tags=["workspace"])
logger = logging.getLogger(__name__)


# --- helpers ---

def _clean_id(val: Optional[str]) -> Optional[str]:
    if not val or str(val).lower() in ("null", "undefined", "none", ""):
        return None
    return str(val)




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

    user_dir = os.path.join(settings.WORKSPACE_DIR, str(user.id))
    os.makedirs(user_dir, exist_ok=True)

    safe_name = f"{uuid.uuid4()}_{file.filename}"
    file_path = os.path.join(user_dir, safe_name)

    try:
        with open(file_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {e}")

    fid = _clean_id(folder_id)
    try:
        db_file = UserFile(
            user_id=user.id,
            folder_id=fid,
            filename=file.filename,
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

    provider, _ = find_model(req.model)
    if not provider:
        raise HTTPException(status_code=400, detail="Model not configured")

    # Read text content
    text_exts = (".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".html", ".css", ".yaml", ".yml")
    content = ""
    if f.mime_type and f.mime_type.startswith("text/") or f.filename.endswith(text_exts):
        try:
            with open(f.file_path, "r", encoding="utf-8", errors="ignore") as fo:
                content = fo.read(15000)
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
        client = AsyncOpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
        resp = await client.chat.completions.create(
            model=req.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
        )
        summary_text = resp.choices[0].message.content
        f.summary = summary_text
        db.commit()
        return {"status": "ok", "summary": summary_text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")
