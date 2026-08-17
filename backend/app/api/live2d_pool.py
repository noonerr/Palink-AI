"""Live2D 模型池 API

在 Palink 服务器上托管一个 Live2D 模型库（池），让前端（galgame 界面插件等）
无需用户自行上传模型文件，即可把服务器池中的远程模型绑定到角色：
绑定后向插件的 IndexedDB（GalgameUIPluginDB -> live2dModels）写入
`{ modelId: <角色ID>, source: "remote", modelUrl: <本服务URL> }`，
插件按角色 ID 自动加载远程模型（见插件 Live2DManager._isRemoteModelData）。

目录结构：
    {DATA_DIR}/live2d-pool/
        {model_id}/
            model3.json / *.model3.json / model.json（模型入口，自动识别）
            ...模型资源（.moc3 / .png / motions/ / physics 等）
            metadata.json（可选）：{ name, description, tags, preview }
            preview.png / preview.jpg（可选，列表缩略图）

模型文件通过 GET /api/live2d-pool/files/{model_id}/{path} 同源托管（无需鉴权，
插件运行时 fetch 不带 Authorization header）；列表/上传/删除接口需要登录。
"""

import json
import os
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..core.config import settings
from .dependencies import get_admin, get_current_user

router = APIRouter(prefix="/api/live2d-pool", tags=["live2d-pool"])

# 上传 zip 防炸弹限制（与 plugins.py 导入策略一致）
_MAX_UPLOAD_BYTES = 200 * 1024 * 1024       # 200MB 上传文件
_MAX_ENTRIES = 5000                          # 单 zip 最多条目
_MAX_UNCOMPRESSED = 500 * 1024 * 1024        # 解压总量 500MB


def _pool_dir() -> Path:
    """模型池根目录（自动创建）。"""
    base = Path(getattr(settings, "DATA_DIR", "./data")) / "live2d-pool"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _model_dir(model_id: str) -> Path:
    return _pool_dir() / model_id


def _safe_model_path(model_id: str, rel_path: str) -> Path:
    """校验并返回模型目录内的绝对路径，防目录穿越。"""
    mdir = _model_dir(model_id).resolve()
    full = (mdir / rel_path.replace("\\", "/").lstrip("/")).resolve()
    if not (full == mdir or full.is_relative_to(mdir)):
        raise HTTPException(status_code=403, detail="Access denied")
    return full


_ENTRY_RE = re.compile(r"(?:^|/)(?:[^/]*\.)?(model3\.json|model\.json)$", re.IGNORECASE)


def _find_entry_file(mdir: Path) -> Optional[str]:
    """在模型目录内寻找 Live2D 模型入口文件（model3.json / model.json）。"""
    if not mdir.is_dir():
        return None
    candidates = []
    for root, _dirs, files in os.walk(mdir):
        for f in files:
            if f.lower() in ("model3.json", "model.json") or f.lower().endswith(
                (".model3.json", ".model.json")
            ):
                rel = os.path.relpath(os.path.join(root, f), mdir).replace("\\", "/")
                # 深度优先：浅层的优先（motions/xxx.model3.json 这类子资源不应作为入口）
                candidates.append((rel.count("/"), rel))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1]))
    return candidates[0][1]


def _load_metadata(mdir: Path) -> dict:
    meta_file = mdir / "metadata.json"
    if meta_file.is_file():
        try:
            return json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _preview_url(mdir: Path, model_id: str, meta: dict) -> Optional[str]:
    # 优先使用 metadata.json 中的 preview 相对路径
    meta_preview = str(meta.get("preview") or "").strip()
    if meta_preview:
        p = (mdir / meta_preview.replace("\\", "/")).resolve()
        if p.is_relative_to(mdir.resolve()) and p.is_file():
            return f"/api/live2d-pool/files/{model_id}/{meta_preview.replace(chr(92), '/')}"
    for name in ("preview.png", "preview.jpg", "preview.jpeg", "preview.webp"):
        if (mdir / name).is_file():
            return f"/api/live2d-pool/files/{model_id}/{name}"
    return None


def _scan_model(mdir: Path) -> Optional[dict[str, Any]]:
    model_id = mdir.name
    entry = _find_entry_file(mdir)
    if not entry:
        return None
    meta = _load_metadata(mdir)
    total_size = sum(
        f.stat().st_size for f in mdir.rglob("*") if f.is_file()
    )
    return {
        "id": model_id,
        "name": meta.get("name") or model_id,
        "description": meta.get("description", ""),
        "tags": meta.get("tags", []),
        "modelUrl": f"/api/live2d-pool/files/{model_id}/{entry}",
        "previewUrl": _preview_url(mdir, model_id, meta),
        "sizeBytes": total_size,
        "createdAt": meta.get("createdAt") or "",
    }


@router.get("/models")
async def list_models(_user=Depends(get_current_user)) -> dict:
    """列出模型池中的全部模型。"""
    models = []
    root = _pool_dir()
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if child.is_dir():
            model = _scan_model(child)
            if model:
                models.append(model)
    return {"models": models, "count": len(models)}


@router.get("/files/{model_id}/{file_path:path}")
async def serve_model_file(model_id: str, file_path: str):
    """静态托管模型文件（无需鉴权，插件 fetch 同源访问）。"""
    # model_id 只允许安全字符，防止把任意目录名当模型目录
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", model_id):
        raise HTTPException(status_code=400, detail="Invalid model id")
    full = _safe_model_path(model_id, file_path)
    if not full.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(full)


@router.post("/upload")
async def upload_model(
    file: UploadFile = File(...),
    name: str = Form(""),
    description: str = Form(""),
    _user=Depends(get_current_user),
) -> dict:
    """上传 Live2D 模型 zip 包到服务器池。

    zip 内可含 model3.json/moc3/textures 等；若根目录只有单个子目录则自动提升。
    """
    content = await _read_upload_limited(file)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    model_id = f"m_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    target = _model_dir(model_id)
    target.mkdir(parents=True, exist_ok=False)

    try:
        _extract_zip(content, target)
        # 单层目录提升：zip 常见结构是解压后只有一层目录
        _collapse_single_child(target)
        entry = _find_entry_file(target)
        if not entry:
            raise HTTPException(
                status_code=400,
                detail="未找到 Live2D 模型入口（model3.json / model.json）",
            )
        meta = {"name": name or model_id, "description": description}
        if name:
            meta["name"] = name
        meta["createdAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
        (target / "metadata.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except HTTPException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"解压失败: {e}") from e

    model = _scan_model(target)
    return {"model": model}


@router.delete("/models/{model_id}")
async def delete_model(
    model_id: str,
    _admin=Depends(get_admin),
) -> dict:
    """删除池中模型（仅管理员）。"""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", model_id):
        raise HTTPException(status_code=400, detail="Invalid model id")
    mdir = _model_dir(model_id)
    if not mdir.is_dir():
        raise HTTPException(status_code=404, detail="Model not found")
    shutil.rmtree(mdir, ignore_errors=True)
    return {"ok": True, "id": model_id}


async def _read_upload_limited(file: UploadFile, max_bytes: int = _MAX_UPLOAD_BYTES) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file too large (max {max_bytes // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _extract_zip(content: bytes, target: Path) -> None:
    import io

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail="不是有效的 zip 文件") from e

    total_uncompressed = 0
    infos = zf.infolist()
    if len(infos) > _MAX_ENTRIES:
        raise HTTPException(status_code=400, detail="zip 条目过多")

    # 路径穿越防护
    for info in infos:
        norm = info.filename.replace("\\", "/")
        if norm.startswith("/") or ".." in norm.split("/"):
            raise HTTPException(status_code=400, detail=f"非法的 zip 路径: {info.filename}")

    with zf:
        for info in infos:
            if info.is_dir():
                continue
            total_uncompressed += info.file_size
            if total_uncompressed > _MAX_UNCOMPRESSED:
                raise HTTPException(status_code=400, detail="解压总量超限")
            dest = target / info.filename.replace("\\", "/")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out, length=1024 * 1024)


def _collapse_single_child(target: Path) -> None:
    children = [c for c in target.iterdir()]
    if len(children) == 1 and children[0].is_dir():
        inner = children[0]
        for item in inner.iterdir():
            shutil.move(str(item), str(target / item.name))
        inner.rmdir()
