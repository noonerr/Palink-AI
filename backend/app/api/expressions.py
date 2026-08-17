"""角色表情系统 API。

对齐前端 frontend/src/lib/expression/manager.ts 的 4 个调用，并提供
SillyTavern 1.18.0 兼容路由（get / merge / delete）。

默认 15 种表情图资源由前端 frontend/public/st/img/default-expressions/
提供，后端仅在 API 返回名称列表，不复制这些文件。用户上传的自定义表情
保存到 data/characters/{character_id}/expressions/ 目录。
"""

import logging
import os
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..api.dependencies import get_current_user
from ..core import get_db, settings
from ..models import Character, CharacterExpression, User
from ..services.expression_service import DEFAULT_EXPRESSIONS, ExpressionService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["expressions"])

# 默认表情图资源（由前端静态目录提供）
_DEFAULT_EXPRESSION_URL_TEMPLATE = "/st/img/default-expressions/{name}.png"
# 自定义表情图资源（由本路由的 image 端点提供）
_CUSTOM_EXPRESSION_URL_TEMPLATE = "/api/characters/{character_id}/expressions/{expression_name}/image"

# 表情名称仅允许字母、数字、下划线、短横线，防止路径穿越
_EXPRESSION_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

# 上传图片大小上限（10MB）
_MAX_EXPRESSION_UPLOAD_SIZE = 10 * 1024 * 1024
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024

# content-type -> 扩展名
_CONTENT_TYPE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


class AnalyzeRequest(BaseModel):
    text: str = ""


class MergeSpritesRequest(BaseModel):
    name: str
    sprites: dict = {}


# ---------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------

def _validate_expression_name(expression_name: str) -> str:
    """校验表情名称合法，返回清洗后的名称。"""
    if not expression_name or not _EXPRESSION_NAME_PATTERN.match(expression_name):
        raise HTTPException(
            status_code=400,
            detail="Invalid expression name; only letters, digits, '_' and '-' are allowed.",
        )
    return expression_name


def _get_character_or_404(db: Session, character_id: str, user: User) -> Character:
    character = db.query(Character).filter(
        Character.id == character_id,
        Character.user_id == user.id,
    ).first()
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


def _get_character_by_name_or_404(db: Session, name: str, user: User) -> Character:
    character = db.query(Character).filter(
        Character.name == name,
        Character.user_id == user.id,
    ).first()
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


def _expressions_dir(character_id: str) -> str:
    """返回角色自定义表情的存储目录绝对路径。"""
    return os.path.join(settings.DATA_DIR, "characters", character_id, "expressions")


def _default_expression_url(name: str) -> str:
    return _DEFAULT_EXPRESSION_URL_TEMPLATE.format(name=name)


def _custom_expression_url(character_id: str, expression_name: str) -> str:
    return _CUSTOM_EXPRESSION_URL_TEMPLATE.format(
        character_id=character_id,
        expression_name=expression_name,
    )


async def _read_upload_with_limit(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_EXPRESSION_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Expression image too large (max {_MAX_EXPRESSION_UPLOAD_SIZE // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


# ---------------------------------------------------------------------
# 前端对齐端点
# ---------------------------------------------------------------------

@router.get("/characters/{character_id}/expressions")
async def list_character_expressions(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """返回角色可用表情列表。

    返回格式同时满足前端 manager.ts（expressions 为 Record<name,url>）和
    任务规约（custom / names 数组）：
    {
      "expressions": {"anger": "/st/...", "joy": "/st/...", "<custom>": "/api/..."},
      "custom": ["custom_expr_name", ...],
      "names": ["anger", "joy", ..., "<custom>"]
    }
    """
    _get_character_or_404(db, character_id, user)

    custom_rows = (
        db.query(CharacterExpression)
        .filter(CharacterExpression.character_id == character_id)
        .order_by(CharacterExpression.expression_name)
        .all()
    )
    custom_names = [row.expression_name for row in custom_rows]

    expressions_map: dict = {}
    names: list = []
    for name in DEFAULT_EXPRESSIONS:
        expressions_map[name] = _default_expression_url(name)
        names.append(name)
    for name in custom_names:
        expressions_map[name] = _custom_expression_url(character_id, name)
        if name not in names:
            names.append(name)

    return {
        "expressions": expressions_map,
        "custom": custom_names,
        "names": names,
    }


@router.post("/expressions/analyze")
async def analyze_expression(
    body: AnalyzeRequest,
    user: User = Depends(get_current_user),
):
    """根据文本分析表情，返回表情名称。"""
    service = ExpressionService()
    expression = service.analyze_expression(body.text or "")
    return {"expression": expression}


@router.post("/characters/{character_id}/expressions")
async def upload_character_expression(
    character_id: str,
    expression: str = Form(...),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传自定义表情图片。

    前端 manager.ts 使用字段名 `expression` 与 `image`（multipart/form-data）。
    保存到 data/characters/{character_id}/expressions/{expression_name}{ext}。
    """
    _get_character_or_404(db, character_id, user)
    expression_name = _validate_expression_name(expression)

    content_type = (image.content_type or "").lower()
    ext = _CONTENT_TYPE_EXT.get(content_type, ".png")

    target_dir = _expressions_dir(character_id)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("Failed to create expression dir %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create expression directory")

    file_name = f"{expression_name}{ext}"
    target_path = os.path.join(target_dir, file_name)
    # 相对 DATA_DIR 的路径，存入数据库
    relative_path = os.path.join("characters", character_id, "expressions", file_name)

    try:
        data = await _read_upload_with_limit(image)
        with open(target_path, "wb") as fp:
            fp.write(data)
    except HTTPException:
        raise
    except OSError as exc:
        logger.error("Failed to write expression file %s: %s", target_path, exc)
        raise HTTPException(status_code=400, detail="Failed to save expression image")

    # upsert 数据库记录
    existing = (
        db.query(CharacterExpression)
        .filter(
            CharacterExpression.character_id == character_id,
            CharacterExpression.expression_name == expression_name,
        )
        .first()
    )
    if existing is not None:
        # 替换旧文件（如扩展名变化）
        old_path = os.path.join(settings.DATA_DIR, existing.file_path)
        if os.path.normpath(old_path) != os.path.normpath(target_path) and os.path.isfile(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass
        existing.file_path = relative_path
        db.commit()
        db.refresh(existing)
    else:
        record = CharacterExpression(
            id=str(uuid.uuid4()),
            character_id=character_id,
            expression_name=expression_name,
            file_path=relative_path,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

    url = _custom_expression_url(character_id, expression_name)
    return {"url": url, "expression": expression_name}


@router.delete("/characters/{character_id}/expressions/{expression_name}")
async def delete_character_expression(
    character_id: str,
    expression_name: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除自定义表情。"""
    _get_character_or_404(db, character_id, user)
    _validate_expression_name(expression_name)

    record = (
        db.query(CharacterExpression)
        .filter(
            CharacterExpression.character_id == character_id,
            CharacterExpression.expression_name == expression_name,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Expression not found")

    file_path = os.path.join(settings.DATA_DIR, record.file_path)
    if os.path.isfile(file_path):
        try:
            os.remove(file_path)
        except OSError as exc:
            logger.warning("Failed to remove expression file %s: %s", file_path, exc)

    db.delete(record)
    db.commit()
    return {"deleted": expression_name}


@router.get("/characters/{character_id}/expressions/{expression_name}/image")
async def get_character_expression_image(
    character_id: str,
    expression_name: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提供自定义表情图片文件。

    兼容层（Task 28.2）：当 DB 记录的文件缺失时，依次回退查找
    sprites/ 目录及按角色名查找，以兼容 ST 1.18.0 sprite 资源路径。
    """
    character = _get_character_or_404(db, character_id, user)
    _validate_expression_name(expression_name)

    record = (
        db.query(CharacterExpression)
        .filter(
            CharacterExpression.character_id == character_id,
            CharacterExpression.expression_name == expression_name,
        )
        .first()
    )

    db_record_path = record.file_path if record is not None else None
    file_path = _resolve_sprite_file_path(character, expression_name, db_record_path)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Expression image file missing")

    return FileResponse(file_path)


# ---------------------------------------------------------------------
# SillyTavern 1.18.0 兼容路由
# ---------------------------------------------------------------------
#
# 路径差异说明（Task 28.2）：
# ST 1.18.0 的 sprite 系统约定文件位于 data/characters/{character_name}/
# （由 getSpritesPath 返回，文件以 /characters/{name}/{file} 形式提供）；
# Palink 的自定义表情存储于 data/characters/{character_id}/expressions/。
# 为兼容 ST sprite 资源，文件服务端点（get_character_expression_image）
# 在 DB 记录文件缺失时会回退查找 sprites/ 目录及按角色名查找，详见
# _resolve_sprite_file_path。

# sprite 兼容回退查找所支持的图片扩展名（与 _CONTENT_TYPE_EXT 对齐）
_SPRITE_FALLBACK_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")


def _is_safe_char_name(name: str) -> bool:
    """校验角色名可作为文件系统目录名使用（防止路径穿越）。"""
    if not name:
        return False
    if "/" in name or "\\" in name or name in (".", ".."):
        return False
    if name.startswith(".") and name.count(".") == len(name):
        return False
    return True


def _resolve_sprite_file_path(
    character: Character,
    expression_name: str,
    db_record_path: Optional[str] = None,
) -> Optional[str]:
    """解析表情图片文件绝对路径，兼容 ST 1.18.0 sprite 存放位置。

    查找优先级：
    1. DB 记录的 file_path（Palink 默认 characters/{cid}/expressions/）
    2. data/characters/{character_id}/sprites/{expression_name}.{ext}
       （sprites/ 目录别名，按 ID）
    3. data/characters/{character_name}/expressions/{expression_name}.{ext}
       （按角色名查找 expressions/）
    4. data/characters/{character_name}/sprites/{expression_name}.{ext}
       （ST sprite 约定路径，按角色名 + sprites/）

    返回首个存在的文件绝对路径；都不存在则返回 None。
    """
    candidates: list[str] = []
    if db_record_path:
        candidates.append(os.path.join(settings.DATA_DIR, db_record_path))

    cid = str(character.id)
    name = character.name or ""

    for ext in _SPRITE_FALLBACK_EXTS:
        file_name = f"{expression_name}{ext}"
        # 按 ID + sprites/ 别名
        candidates.append(
            os.path.join(settings.DATA_DIR, "characters", cid, "sprites", file_name)
        )
        # 按角色名查找（expressions/ 与 sprites/）
        if _is_safe_char_name(name):
            candidates.append(
                os.path.join(settings.DATA_DIR, "characters", name, "expressions", file_name)
            )
            candidates.append(
                os.path.join(settings.DATA_DIR, "characters", name, "sprites", file_name)
            )

    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


@router.get("/expressions/get")
async def st_get_expressions(
    name: str = Query(..., description="character name"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容：返回角色可用表情名称数组。

    返回形状对齐 ST 1.18.0 表情/ sprite 期望：
    {"expressions": ["anger", "joy", ...], "sprite_count": N}
    其中 sprite_count 为可用表情总数（默认 + 自定义）。
    """
    character = _get_character_by_name_or_404(db, name, user)

    custom_rows = (
        db.query(CharacterExpression)
        .filter(CharacterExpression.character_id == character.id)
        .order_by(CharacterExpression.expression_name)
        .all()
    )
    custom_names = [row.expression_name for row in custom_rows]

    names: list = list(DEFAULT_EXPRESSIONS)
    for n in custom_names:
        if n not in names:
            names.append(n)

    return {"expressions": names, "sprite_count": len(names)}


@router.post("/expressions/merge")
async def st_merge_expressions(
    body: MergeSpritesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容：合并角色表情 sprites。

    body: {"name": "<character_name>", "sprites": {"<expression>": "<path/url>"}}
    将 sprites 中非默认的表情注册为自定义表情记录（已存在则跳过）。
    """
    character = _get_character_by_name_or_404(db, body.name, user)

    sprites = body.sprites or {}
    merged = 0
    for expr_name, sprite_path in sprites.items():
        if not expr_name or not _EXPRESSION_NAME_PATTERN.match(expr_name):
            continue
        if expr_name in DEFAULT_EXPRESSIONS:
            continue
        existing = (
            db.query(CharacterExpression)
            .filter(
                CharacterExpression.character_id == character.id,
                CharacterExpression.expression_name == expr_name,
            )
            .first()
        )
        if existing is not None:
            continue
        record = CharacterExpression(
            id=str(uuid.uuid4()),
            character_id=character.id,
            expression_name=expr_name,
            file_path=str(sprite_path) if sprite_path else f"characters/{character.id}/expressions/{expr_name}.png",
        )
        db.add(record)
        merged += 1
    db.commit()

    all_rows = (
        db.query(CharacterExpression)
        .filter(CharacterExpression.character_id == character.id)
        .order_by(CharacterExpression.expression_name)
        .all()
    )
    names: list = list(DEFAULT_EXPRESSIONS)
    for row in all_rows:
        if row.expression_name not in names:
            names.append(row.expression_name)

    return {"expressions": names, "merged": merged}


@router.delete("/expressions/delete")
async def st_delete_expression(
    name: str = Query(..., description="character name"),
    expression: str = Query(..., description="expression name"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ST 兼容：删除角色表情。"""
    character = _get_character_by_name_or_404(db, name, user)
    _validate_expression_name(expression)

    record = (
        db.query(CharacterExpression)
        .filter(
            CharacterExpression.character_id == character.id,
            CharacterExpression.expression_name == expression,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Expression not found")

    file_path = os.path.join(settings.DATA_DIR, record.file_path)
    if os.path.isfile(file_path):
        try:
            os.remove(file_path)
        except OSError as exc:
            logger.warning("Failed to remove expression file %s: %s", file_path, exc)

    db.delete(record)
    db.commit()
    return {"deleted": expression}
