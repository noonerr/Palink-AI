"""ST 兼容资源端点。

提供背景图、头像、立绘、资产的 ST 兼容 API（ST 期望 POST 方法）：
  POST /api/backgrounds/all        列出所有背景图
  POST /api/backgrounds/folders    列出背景图文件夹
  POST /api/backgrounds/upload     上传背景图
  POST /api/backgrounds/rename     重命名背景图
  POST /api/backgrounds/delete     删除背景图
  POST /api/avatars/get            列出头像
  POST /api/avatars/upload         上传头像
  POST /api/avatars/delete         删除头像
  GET  /api/sprites/get            列出立绘
  POST /api/sprites/upload         上传立绘
  POST /api/sprites/upload-zip     上传立绘 ZIP 并解压
  POST /api/sprites/delete         删除立绘
  POST /api/assets/get             列出资产
  POST /api/assets/character       角色资产
  POST /api/assets/download        下载资产
  POST /api/assets/delete          删除资产

文件保存在 data/ 目录下对应子目录，所有端点都需认证。
"""
from __future__ import annotations

import io
import logging
import os
import shutil
import uuid
import zipfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db, settings
from ..models import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["st-resources"])

# 支持的图片格式：content-type -> 扩展名
_CONTENT_TYPE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

# 允许的扩展名白名单
_ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# 上传图片大小上限（10MB）
_MAX_UPLOAD_SIZE = 10 * 1024 * 1024
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024


# ---------------------------------------------------------------------------
# 认证与通用工具
# ---------------------------------------------------------------------------

def _get_user(request: Request, db: Session) -> User:
    """获取当前用户：优先使用中间件注入的 request.state.user，否则回退到 token 认证。"""
    user = request.state.user if hasattr(request, "state") and hasattr(request.state, "user") else None
    if user:
        return user
    auth_header = request.headers.get("Authorization", "")
    token = ""
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    if not token:
        token = request.query_params.get("token") or request.query_params.get("palinkToken") or ""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    from .silly_tavern import _user_from_request_token
    user = _user_from_request_token(request, db, token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user


def _resolve_upload_field(file: UploadFile | None, avatar: UploadFile | None) -> UploadFile:
    """兼容 ST 前端发 `avatar` 字段与 Palink 前端发 `file` 字段的上传参数。
    ST 1.18.0 全局 multer 用 `avatar` 作为单文件字段名，Palink 此前用 `file`。
    两个字段任选其一；都不提供则 422。"""
    resolved = file or avatar
    if resolved is None:
        raise HTTPException(status_code=422, detail="No file uploaded (expected 'file' or 'avatar' field)")
    return resolved


def _data_dir() -> str:
    """返回 DATA_DIR 绝对路径。"""
    return os.path.abspath(settings.DATA_DIR)


def _safe_join(base: str, *parts: str) -> str:
    """拼接路径并确保结果在 base 目录内，防止路径穿越。"""
    base_abs = os.path.abspath(base)
    # 过滤空片段
    clean = [p for p in parts if p not in (None, "")]
    target = os.path.abspath(os.path.join(base_abs, *clean))
    if target != base_abs and not target.startswith(base_abs + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")
    return target


def _resolve_within_data(rel_path: str) -> str:
    """将相对 DATA_DIR 的路径解析为绝对路径并校验未越界。"""
    return _safe_join(_data_dir(), rel_path)


def _to_rel_data(abs_path: str) -> str:
    """将绝对路径转为相对 DATA_DIR 的正斜杠路径。"""
    rel = os.path.relpath(abs_path, _data_dir())
    return rel.replace("\\", "/")


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
                detail=f"File too large (max {_MAX_UPLOAD_SIZE // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _list_image_files(directory: str, rel_root: str) -> list[dict]:
    """列出目录下的图片文件（非递归），返回 [{filename, path}]。目录不存在返回空列表。"""
    if not os.path.isdir(directory):
        return []
    items: list[dict] = []
    for entry in sorted(os.listdir(directory)):
        full = os.path.join(directory, entry)
        if not os.path.isfile(full):
            continue
        _, ext = os.path.splitext(entry)
        if (ext or "").lower() not in _ALLOWED_EXTS:
            continue
        rel = os.path.join(rel_root, entry).replace("\\", "/")
        items.append({"filename": entry, "path": rel})
    return items


# ---------------------------------------------------------------------------
# 背景图（ST 兼容形状）
# ---------------------------------------------------------------------------

@router.post("/api/backgrounds/all")
async def st_backgrounds_all(
    request: Request,
    db: Session = Depends(get_db),
):
    """列出所有背景图。返回 ST 期望形状 {images, config}。"""
    _get_user(request, db)
    bg_dir = _safe_join(_data_dir(), "backgrounds")
    images = _list_image_files(bg_dir, "backgrounds")
    # ST 前端 backgrounds.js:715 解构 {images, config}，images 为 [{filename, path}, ...]
    return {"images": images, "config": {}}


@router.post("/api/backgrounds/folders")
async def st_backgrounds_folders(
    request: Request,
    db: Session = Depends(get_db),
):
    """列出背景图文件夹（简单实现，返回空列表）。"""
    _get_user(request, db)
    return {"folders": []}


@router.post("/api/backgrounds/upload")
async def st_backgrounds_upload(
    request: Request,
    file: UploadFile | None = File(None),
    avatar: UploadFile | None = File(None),
    folder: str | None = Form(None),
    db: Session = Depends(get_db),
):
    """上传背景图到 data/backgrounds/{folder}/。兼容 ST 前端 `avatar` 字段名。"""
    _get_user(request, db)
    file = _resolve_upload_field(file, avatar)
    ext = _resolve_extension(file.filename, file.content_type)

    # 目标子目录（folder 不允许越界）
    sub_parts = ["backgrounds"]
    if folder:
        sub_parts.append(folder)
    target_dir = _safe_join(_data_dir(), *sub_parts)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create backgrounds dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create backgrounds directory")

    # 保留原始文件名（若冲突则追加短随机串）
    original = os.path.basename(file.filename or "") or "background"
    name, _ = os.path.splitext(original)
    stored_filename = f"{name}{ext}"
    target_path = os.path.join(target_dir, stored_filename)
    if os.path.exists(target_path):
        stored_filename = f"{name}-{uuid.uuid4().hex[:8]}{ext}"
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

    # N4 修复: ST backgrounds.js:1565 `const bg = await response.text()` 期望纯文本
    # 背景文件名（ST 后端 response.send(filename)）；此前返回 JSON 导致 setBackground
    # 拿到 JSON 文本、背景选择失效。返回文件名（不含 backgrounds/ 前缀）。
    # 注意必须用 PlainTextResponse：FastAPI 直接 `return str` 会序列化为 JSON 字符串
    # （带引号 "N4Bg.png"），ST 前端 response.text() 仍会拿到引号，背景名含引号失效。
    return PlainTextResponse(stored_filename)


class BackgroundRenameRequest(BaseModel):
    # ST 1.18.0 backgrounds.js:511 发送 old_bg/new_bg，Palink 此前用 old_path/new_path；
    # 双字段兼容（任一提供即可，old 优先，new 优先）。
    old_path: str | None = None
    new_path: str | None = None
    old_bg: str | None = None
    new_bg: str | None = None


@router.post("/api/backgrounds/rename")
async def st_backgrounds_rename(
    req: BackgroundRenameRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """重命名背景图文件。"""
    _get_user(request, db)
    old_rel = req.old_path or req.old_bg
    new_rel = req.new_path or req.new_bg
    if not old_rel or not new_rel:
        raise HTTPException(status_code=400, detail="Both old and new paths are required")
    old_abs = _resolve_within_data(old_rel)
    new_abs = _resolve_within_data(new_rel)
    if not os.path.isfile(old_abs):
        raise HTTPException(status_code=404, detail="Background not found")
    try:
        os.makedirs(os.path.dirname(new_abs), exist_ok=True)
        os.replace(old_abs, new_abs)
    except OSError as exc:
        logger.error("Failed to rename background %s -> %s: %s", old_abs, new_abs, exc)
        raise HTTPException(status_code=400, detail="Failed to rename background")
    return {"path": _to_rel_data(new_abs)}


class BackgroundDeleteRequest(BaseModel):
    # ST 1.18.0 backgrounds.js:1453-1454 发送 bg，Palink 此前用 path；双字段兼容。
    path: str | None = None
    bg: str | None = None


@router.post("/api/backgrounds/delete")
async def st_backgrounds_delete(
    req: BackgroundDeleteRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """删除指定背景图文件。"""
    _get_user(request, db)
    rel = req.path or req.bg
    if not rel:
        raise HTTPException(status_code=400, detail="Path is required")
    target = _resolve_within_data(rel)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="Background not found")
    try:
        os.remove(target)
    except OSError as exc:
        logger.error("Failed to delete background %s: %s", target, exc)
        raise HTTPException(status_code=400, detail="Failed to delete background")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 头像
# ---------------------------------------------------------------------------

@router.post("/api/avatars/get")
async def st_avatars_get(
    request: Request,
    db: Session = Depends(get_db),
):
    """列出所有头像。C-5 修复: 返回 string[]（ST personas.js:283 用 Array.isArray
    判定并把元素当字符串处理，原 {filename,path} 对象数组会被当成无效人设）。
    元素格式与 ST 一致：`avatars/{filename}` 相对路径。"""
    _get_user(request, db)
    avatars_dir = _safe_join(_data_dir(), "avatars")
    items = _list_image_files(avatars_dir, "avatars")
    return [f"avatars/{item['filename']}" for item in items]


@router.post("/api/avatars/upload")
async def st_avatars_upload(
    request: Request,
    file: UploadFile | None = File(None),
    avatar: UploadFile | None = File(None),
    character_name: str | None = Form(None),
    overwrite_name: str | None = Form(None),
    db: Session = Depends(get_db),
):
    """上传头像到 data/avatars/。兼容 ST 前端 `avatar` 字段名。
    ST 1.18.0 personas.js 覆盖上传时携带 `overwrite_name`（N13 修复）：
    提供时按该名保存并覆盖同名文件（ST avatars.js:41-60 语义）；
    未提供时保留 Palink 原有「冲突追加随机串」行为。"""
    _get_user(request, db)
    file = _resolve_upload_field(file, avatar)
    ext = _resolve_extension(file.filename, file.content_type)

    target_dir = _safe_join(_data_dir(), "avatars")
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create avatars dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create avatars directory")

    original = os.path.basename(file.filename or "") or "avatar"
    if overwrite_name and overwrite_name.strip():
        # ST 覆盖上传：overwrite_name 作为最终文件名（防穿越取 basename）
        ov_base = os.path.basename(overwrite_name.strip())
        _, ov_ext = os.path.splitext(ov_base)
        if ov_ext and (ov_ext or "").lower() not in _ALLOWED_EXTS:
            raise HTTPException(status_code=400, detail="Unsupported image format for overwrite_name")
        stored_filename = ov_base if ov_ext else f"{ov_base}{ext}"
        target_path = os.path.join(target_dir, stored_filename)
        # 覆盖语义：若已有同名文件直接覆盖，不追加随机串
    else:
        if character_name:
            base_name = character_name
        else:
            base_name = os.path.splitext(original)[0]
        stored_filename = f"{base_name}{ext}"
        target_path = os.path.join(target_dir, stored_filename)
        if os.path.exists(target_path):
            stored_filename = f"{base_name}-{uuid.uuid4().hex[:8]}{ext}"
            target_path = os.path.join(target_dir, stored_filename)

    try:
        data = await _read_upload_with_limit(file)
        with open(target_path, "wb") as fp:
            fp.write(data)
    except HTTPException:
        raise
    except OSError as exc:
        logger.error("Failed to write avatar file %s: %s", target_path, exc)
        raise HTTPException(status_code=400, detail="Failed to save avatar image")

    return {"path": _to_rel_data(target_path)}


class AvatarDeleteRequest(BaseModel):
    # ST 1.18.0 personas.js:1173-1174 发送 avatar，Palink 此前用 path；双字段兼容。
    path: str | None = None
    avatar: str | None = None


@router.post("/api/avatars/delete")
async def st_avatars_delete(
    req: AvatarDeleteRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """删除头像文件。"""
    _get_user(request, db)
    rel = req.path or req.avatar
    if not rel:
        raise HTTPException(status_code=400, detail="Path is required")
    target = _resolve_within_data(rel)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="Avatar not found")
    try:
        os.remove(target)
    except OSError as exc:
        logger.error("Failed to delete avatar %s: %s", target, exc)
        raise HTTPException(status_code=400, detail="Failed to delete avatar")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 立绘（Sprites）
# ---------------------------------------------------------------------------

def _sprites_dir(name: str, sprites_folder: str | None = None) -> str:
    """返回角色立绘目录绝对路径。"""
    parts = ["characters", name, "sprites"]
    if sprites_folder:
        parts.append(sprites_folder)
    return _safe_join(_data_dir(), *parts)


@router.get("/api/sprites/get")
async def st_sprites_get(
    request: Request,
    name: str = Query(..., description="角色名"),
    sprites_folder: str | None = Query(None, description="立绘子目录"),
    db: Session = Depends(get_db),
):
    """列出角色立绘。N5 修复: 返回裸数组 [{label, path}]（ST sprites.js:118-150
    直接 response.send(sprites)，expressions/index.js:1295-1300 消费 sprite.label /
    sprite.path；原 {"sprites":[...]} + name 字段导致表情面板空）。
    path 为相对 DATA_DIR 的相对路径；图片静态服务缺位属已知限制（另行专项）。"""
    _get_user(request, db)
    sprites_dir = _sprites_dir(name, sprites_folder)
    sprites: list[dict] = []
    if not os.path.isdir(sprites_dir):
        return sprites

    for entry in sorted(os.listdir(sprites_dir)):
        full = os.path.join(sprites_dir, entry)
        if os.path.isfile(full):
            _, ext = os.path.splitext(entry)
            if (ext or "").lower() not in _ALLOWED_EXTS:
                continue
            label = os.path.splitext(entry)[0]
            sprites.append({"label": label, "path": _to_rel_data(full)})
        elif os.path.isdir(full):
            # 子目录作为表情标签，取目录内第一张图片
            for sub in sorted(os.listdir(full)):
                sub_full = os.path.join(full, sub)
                if not os.path.isfile(sub_full):
                    continue
                _, sub_ext = os.path.splitext(sub)
                if (sub_ext or "").lower() not in _ALLOWED_EXTS:
                    continue
                sprites.append({"label": entry, "path": _to_rel_data(sub_full)})
                break
    return sprites


@router.post("/api/sprites/upload")
async def st_sprites_upload(
    request: Request,
    file: UploadFile | None = File(None),
    avatar: UploadFile | None = File(None),
    name: str = Form(..., description="角色名"),
    label: str = Form(..., description="表情名"),
    db: Session = Depends(get_db),
):
    """上传立绘到 data/characters/{name}/sprites/{label}/。兼容 ST 前端 `avatar` 字段名。"""
    _get_user(request, db)
    file = _resolve_upload_field(file, avatar)
    ext = _resolve_extension(file.filename, file.content_type)

    target_dir = _safe_join(_data_dir(), "characters", name, "sprites", label)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create sprites dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create sprites directory")

    original = os.path.basename(file.filename or "") or "sprite"
    base_name = os.path.splitext(original)[0] or label
    stored_filename = f"{base_name}{ext}"
    target_path = os.path.join(target_dir, stored_filename)
    if os.path.exists(target_path):
        stored_filename = f"{base_name}-{uuid.uuid4().hex[:8]}{ext}"
        target_path = os.path.join(target_dir, stored_filename)

    try:
        data = await _read_upload_with_limit(file)
        with open(target_path, "wb") as fp:
            fp.write(data)
    except HTTPException:
        raise
    except OSError as exc:
        logger.error("Failed to write sprite file %s: %s", target_path, exc)
        raise HTTPException(status_code=400, detail="Failed to save sprite image")

    return {"path": _to_rel_data(target_path)}


@router.post("/api/sprites/upload-zip")
async def st_sprites_upload_zip(
    request: Request,
    file: UploadFile | None = File(None),
    avatar: UploadFile | None = File(None),
    name: str = Form(..., description="角色名"),
    db: Session = Depends(get_db),
):
    """上传 ZIP 并解压到 data/characters/{name}/sprites/。兼容 ST 前端 `avatar` 字段名。"""
    _get_user(request, db)
    file = _resolve_upload_field(file, avatar)
    target_root = _safe_join(_data_dir(), "characters", name, "sprites")
    try:
        os.makedirs(target_root, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create sprites dir %s: %s", target_root, exc)
        raise HTTPException(status_code=400, detail="Failed to create sprites directory")

    data = await _read_upload_with_limit(file)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        logger.error("Invalid zip upload: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid zip file")

    # 安全解压：防止 Zip Slip 路径穿越
    target_root_abs = os.path.abspath(target_root)
    extracted_count = 0
    try:
        for member in zf.infolist():
            if member.is_dir():
                continue
            member_name = member.filename.replace("\\", "/")
            # 阻止绝对路径与父级引用
            if member_name.startswith("/") or ".." in member_name.split("/"):
                continue
            dest = os.path.abspath(os.path.join(target_root_abs, member_name))
            if dest != target_root_abs and not dest.startswith(target_root_abs + os.sep):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(member) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            # N14 修复: 仅统计图片文件（ST expressions/index.js:2032 解构 count 显示上传数）
            _, member_ext = os.path.splitext(member_name)
            if (member_ext or "").lower() in _ALLOWED_EXTS:
                extracted_count += 1
    except OSError as exc:
        logger.error("Failed to extract sprite zip: %s", exc)
        raise HTTPException(status_code=400, detail="Failed to extract zip file")
    finally:
        zf.close()

    return {"ok": True, "count": extracted_count}


class SpriteDeleteRequest(BaseModel):
    name: str
    label: str


@router.post("/api/sprites/delete")
async def st_sprites_delete(
    req: SpriteDeleteRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """删除指定立绘（data/characters/{name}/sprites/{label}/）。"""
    _get_user(request, db)
    target_dir = _safe_join(_data_dir(), "characters", req.name, "sprites", req.label)
    if not os.path.isdir(target_dir):
        # 也可能是直接文件
        target_file = _safe_join(_data_dir(), "characters", req.name, "sprites", f"{req.label}")
        if os.path.isfile(target_file):
            try:
                os.remove(target_file)
            except OSError as exc:
                logger.error("Failed to delete sprite %s: %s", target_file, exc)
                raise HTTPException(status_code=400, detail="Failed to delete sprite")
            return {"ok": True}
        raise HTTPException(status_code=404, detail="Sprite not found")

    try:
        shutil.rmtree(target_dir)
    except OSError as exc:
        logger.error("Failed to delete sprite dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to delete sprite")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 资产（Assets）
# ---------------------------------------------------------------------------

# 资产类别 -> 子目录映射
_ASSET_CATEGORY_DIRS = {
    "character": "assets/character",
    "bg": "assets/bg",
    "background": "assets/bg",
    "persona": "assets/persona",
}


def _asset_dir(category: str | None) -> str:
    if not category:
        return _safe_join(_data_dir(), "assets")
    sub = _ASSET_CATEGORY_DIRS.get(category.lower(), f"assets/{category}")
    return _safe_join(_data_dir(), *sub.split("/"))


class AssetGetRequest(BaseModel):
    category: str | None = None


@router.post("/api/assets/get")
async def st_assets_get(
    req: AssetGetRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """列出指定类别的资产。返回 {assets}。"""
    _get_user(request, db)
    asset_dir = _asset_dir(req.category)
    assets: list[dict] = []
    if not os.path.isdir(asset_dir):
        return {"assets": assets}
    for entry in sorted(os.listdir(asset_dir)):
        full = os.path.join(asset_dir, entry)
        if os.path.isfile(full):
            assets.append({"filename": entry, "path": _to_rel_data(full)})
        elif os.path.isdir(full):
            assets.append({"filename": entry, "path": _to_rel_data(full), "is_dir": True})
    return {"assets": assets}


class AssetCharacterRequest(BaseModel):
    name: str | None = None
    id: str | None = None


@router.post("/api/assets/character")
async def st_assets_character(
    req: AssetCharacterRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """列出角色资产。优先按 name 查找 data/assets/character/{name}/。"""
    _get_user(request, db)
    assets: list[dict] = []
    if not req.name:
        return {"assets": assets}
    char_dir = _safe_join(_data_dir(), "assets", "character", req.name)
    if not os.path.isdir(char_dir):
        return {"assets": assets}
    for entry in sorted(os.listdir(char_dir)):
        full = os.path.join(char_dir, entry)
        if os.path.isfile(full):
            assets.append({"filename": entry, "path": _to_rel_data(full)})
        elif os.path.isdir(full):
            assets.append({"filename": entry, "path": _to_rel_data(full), "is_dir": True})
    return {"assets": assets}


class AssetDownloadRequest(BaseModel):
    path: str


@router.post("/api/assets/download")
async def st_assets_download(
    req: AssetDownloadRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """下载资产文件。"""
    _get_user(request, db)
    target = _resolve_within_data(req.path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(target)


class AssetDeleteRequest(BaseModel):
    path: str


@router.post("/api/assets/delete")
async def st_assets_delete(
    req: AssetDeleteRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """删除资产文件。"""
    _get_user(request, db)
    target = _resolve_within_data(req.path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="Asset not found")
    try:
        os.remove(target)
    except OSError as exc:
        logger.error("Failed to delete asset %s: %s", target, exc)
        raise HTTPException(status_code=400, detail="Failed to delete asset")
    return {"ok": True}
