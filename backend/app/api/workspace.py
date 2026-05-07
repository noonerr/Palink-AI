import base64
import os
import uuid
import shutil
import logging
import json as json_lib
from typing import Optional, List, Set, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..core import get_db, settings
from ..api.dependencies import get_current_user
from ..models import User, UserFolder, UserFile
from ..schemas import FolderCreate, AnalyzeRequest
from ..services.inference_dispatcher import complete_text_completion, ensure_model_available, stream_text_completion
from ..utils import normalize_upload_filename

router = APIRouter(prefix="/api/workspace", tags=["workspace"])
logger = logging.getLogger(__name__)


# --- helpers ---

def _is_safe_path(file_path: str) -> bool:
    workspace_root = os.path.realpath(settings.WORKSPACE_DIR)
    real_path = os.path.realpath(file_path)
    return real_path.startswith(workspace_root + os.sep) or real_path == workspace_root

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

def _extract_file_content(f) -> Dict[str, Any]:
    text_exts = (".txt", ".md", ".py", ".js", ".ts", ".tsx", ".json", ".csv", ".html", ".css", ".yaml", ".yml", ".xml", ".toml", ".ini", ".cfg", ".sh", ".bash", ".zsh", ".sql", ".r", ".rb", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".hpp")

    if f.mime_type and f.mime_type.startswith("image/"):
        if _is_safe_path(f.file_path) and os.path.exists(f.file_path):
            try:
                with open(f.file_path, "rb") as img_f:
                    img_data = base64.b64encode(img_f.read()).decode("utf-8")
                return {"type": "image", "data_url": f"data:{f.mime_type};base64,{img_data}", "filename": f.filename, "mime_type": f.mime_type}
            except Exception:
                return {"type": "image_fallback", "text": f"[IMAGE_FILE:{f.filename}]"}
        return {"type": "image_fallback", "text": f"[IMAGE_FILE:{f.filename}]"}

    if f.filename.lower().endswith(".pdf"):
        try:
            import pdfplumber
            with pdfplumber.open(f.file_path) as pdf:
                texts = []
                for page in pdf.pages[:20]:
                    text = page.extract_text()
                    if text:
                        texts.append(text)
                if texts:
                    return {"type": "text", "text": "\n\n".join(texts)[:settings.WORKSPACE_ANALYZE_MAX_CHARS]}
        except ImportError:
            pass
        try:
            from PyPDF2 import PdfReader
            reader = PdfReader(f.file_path)
            texts = []
            for page in reader.pages[:20]:
                text = page.extract_text()
                if text:
                    texts.append(text)
            if texts:
                return {"type": "text", "text": "\n\n".join(texts)[:settings.WORKSPACE_ANALYZE_MAX_CHARS]}
        except ImportError:
            pass
        return {"type": "text", "text": f"[PDF_FILE:{f.filename}:Unable to extract text - no PDF library installed]"}

    if f.mime_type and f.mime_type.startswith("text/") or f.filename.lower().endswith(text_exts):
        if not _is_safe_path(f.file_path):
            return {"type": "text", "text": "[Access denied]"}
        try:
            with open(f.file_path, "r", encoding="utf-8", errors="ignore") as fo:
                return {"type": "text", "text": fo.read(settings.WORKSPACE_ANALYZE_MAX_CHARS)}
        except Exception:
            return {"type": "text", "text": "[Unreadable text content]"}

    return {"type": "binary", "text": f"[BINARY_FILE:{f.filename}:type={f.mime_type or 'unknown'}:size={f.file_size or 0}]"}


def _build_analysis_messages(f, content_info: Dict[str, Any], lang: str) -> list:
    content_type = content_info.get("type", "text")
    content_text = content_info.get("text", "")
    lang_hint = "请使用中文回答。" if lang == "zh" else "Respond in English."

    if content_type == "image":
        system_msg = (
            f"You are a professional file analyst. {lang_hint}\n"
            f"Analyze the image file and provide a structured insight with:\n"
            f"1. **Summary**: A concise description of the image content\n"
            f"2. **Key Points**: Notable elements, objects, text, or patterns in the image (as a numbered list)\n"
            f"3. **Tags**: 3-5 relevant tags for categorization"
        )
        user_content = [
            {"type": "text", "text": f"FileName: {f.filename}\nFile type: {f.mime_type}\n\nPlease analyze this image."},
            {"type": "image_url", "image_url": {"url": content_info["data_url"]}},
        ]
        return [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_content},
        ]
    elif content_type == "binary":
        system_msg = (
            f"You are a professional file analyst. {lang_hint}\n"
            f"Based on the file metadata, provide a brief structured insight:\n"
            f"1. **Summary**: What this file likely contains based on its name and type\n"
            f"2. **Key Points**: Potential uses or contents (as a numbered list)\n"
            f"3. **Tags**: 3-5 relevant tags"
        )
        user_msg = f"File metadata:\n{content_text}"
    else:
        system_msg = (
            f"You are a professional file analyst. {lang_hint}\n"
            f"Analyze the following file content and provide a structured insight with:\n"
            f"1. **Summary**: A concise summary of the file's purpose and content\n"
            f"2. **Key Points**: Important information, patterns, or notable elements (as a numbered list)\n"
            f"3. **Tags**: 3-5 relevant tags for categorization"
        )
        user_msg = f"FileName: {f.filename}\n\nContent:\n{content_text}"

    return [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_msg},
    ]


# --- schemas ---

class FileMove(BaseModel):
    file_ids: List[str] = []
    folder_ids: List[str] = []
    target_folder_id: Optional[str] = None


class DeleteRequest(BaseModel):
    file_ids: List[str] = []
    folder_ids: List[str] = []



def _recursive_delete_folder(db: Session, user: User, folder: UserFolder) -> int:
    """递归删除文件夹及其所有子文件和子文件夹，返回释放的字节数"""
    freed = 0
    child_folders = db.query(UserFolder).filter(
        UserFolder.parent_id == folder.id, UserFolder.user_id == user.id
    ).all()
    for child in child_folders:
        freed += _recursive_delete_folder(db, user, child)

    child_files = db.query(UserFile).filter(
        UserFile.folder_id == folder.id, UserFile.user_id == user.id
    ).all()
    for f in child_files:
        if os.path.exists(f.file_path):
            try:
                os.remove(f.file_path)
            except Exception:
                logger.exception("Failed to delete workspace file %s", f.filename)
        freed += f.file_size or 0
        db.delete(f)

    db.delete(folder)
    return freed


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

    original_name = normalize_upload_filename(file.filename)
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
    except Exception:
        logger.exception("Failed to write workspace file")
        raise HTTPException(status_code=500, detail="Failed to write file")

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
    except Exception:
        if os.path.exists(file_path):
            os.remove(file_path)
        logger.exception("Workspace database write failed")
        raise HTTPException(status_code=500, detail="Database error")

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
                except Exception:
                    logger.exception("Failed to delete workspace file %s", f.filename)
                    raise HTTPException(status_code=500, detail=f"Failed to delete file '{f.filename}'")
            freed += f.file_size or 0
            db.delete(f)
    if req.folder_ids:
        folders = db.query(UserFolder).filter(
            UserFolder.id.in_(req.folder_ids), UserFolder.user_id == user.id
        ).all()
        for fol in folders:
            freed += _recursive_delete_folder(db, user, fol)
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
    if not _is_safe_path(f.file_path):
        raise HTTPException(status_code=403, detail="Access denied")
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

    content = _extract_file_content(f)
    messages = _build_analysis_messages(f, content, req.lang)

    try:
        completion = await complete_text_completion(
            model_id=req.model,
            messages=messages,
            temperature=0.5,
            max_tokens=1200,
            timeout=30.0,
        )
        summary_text = completion.get("content") or ""
        f.summary = summary_text
        db.commit()
        return {"status": "ok", "summary": summary_text}
    except Exception:
        logger.exception("Workspace file analysis failed")
        raise HTTPException(status_code=500, detail="Analysis failed")


@router.post("/analyze/stream")
async def stream_analyze_workspace_file(
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

    content = _extract_file_content(f)
    messages = _build_analysis_messages(f, content, req.lang)

    async def event_generator():
        full_content = ""
        try:
            async for chunk in stream_text_completion(
                model_id=req.model,
                messages=messages,
                temperature=0.5,
                timeout=120.0,
            ):
                if "content" in chunk:
                    text = chunk["content"]
                    full_content += text
                    yield f"data: {json_lib.dumps({'content': text})}\n\n"
                elif "usage" in chunk:
                    yield f"data: {json_lib.dumps({'usage': chunk['usage']})}\n\n"
        except Exception as e:
            logger.exception("Stream analysis error")
            yield f"data: {json_lib.dumps({'error': str(e)[:200]})}\n\n"

        if full_content:
            from ..core.database import SessionLocal
            save_db = SessionLocal()
            try:
                file_obj = save_db.query(UserFile).filter(UserFile.id == f.id).first()
                if file_obj:
                    file_obj.summary = full_content
                    save_db.commit()
            except Exception as e:
                save_db.rollback()
                logger.error("Failed to save file summary: %s", e)
            finally:
                save_db.close()

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
