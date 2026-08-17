from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session, defer
import base64
import io
import json
import logging
import random
import re
import zipfile
from datetime import datetime
from typing import Optional

from ..schemas.character import CharacterCreate, CharacterUpdate
from ..services.character_service import CharacterService
from ..services.character_import_service import CharacterImportService, PngCharacterCardParser
from ..core import get_db
from ..core.cache import cached, invalidate_cache, invalidate_user_cache
from ..api.dependencies import get_current_user
from ..models import User, Character
from .smart_card_assets import schedule_smart_card_source_prefetch

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/characters", tags=["characters"])
_MAX_CHARACTER_IMPORT_UPLOAD_SIZE = 50 * 1024 * 1024
_MAX_PRESET_UPLOAD_SIZE = 5 * 1024 * 1024
_MAX_BATCH_IMPORT_UPLOAD_SIZE = 100 * 1024 * 1024
_MAX_BATCH_IMPORT_FILE_COUNT = 1000
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024

# 角色列表裁剪字段（fields=basic 时排除这些大字段）
# 列表 UI 仅使用 id/name/avatar/description/tags/is_processing/processing_status/
# has_character_book/has_alternate_greetings/created_at/updated_at 等基础字段，
# 大字段改为按需 GET /api/characters/{id} 拉取完整卡
_CHARACTER_LIST_HEAVY_FIELDS = frozenset({
    "first_mes", "mes_example", "creator_notes", "post_history_instructions",
    "scenario", "system_prompt", "preset_data", "ui_config",
    "alternate_greetings", "personality", "background",
})

# 分页参数上限
_CHARACTER_LIST_MAX_PAGE_SIZE = 200


async def _read_upload_with_limit(file: UploadFile, max_size: int) -> bytes:
    chunks: list[bytes] = []
    total_read = 0
    while True:
        chunk = await file.read(_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total_read += len(chunk)
        if total_read > max_size:
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file is too large (max {max_size // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)

@router.get("")
@cached(ttl_seconds=30, key_prefix="character_list")
async def get_characters(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    page: Optional[int] = Query(None, ge=1, description="页码（从 1 开始）；与 page_size 同时提供时启用分页"),
    page_size: Optional[int] = Query(None, ge=1, le=_CHARACTER_LIST_MAX_PAGE_SIZE, description=f"每页数量（最大 {_CHARACTER_LIST_MAX_PAGE_SIZE}）"),
    fields: Optional[str] = Query(None, description="字段裁剪：传 'basic' 时裁剪列表 UI 不使用的大字段（first_mes / mes_example / creator_notes 等），完整卡按需 GET /api/characters/{id} 拉取"),
):
    """获取用户的所有角色

    兼容策略：
    - 不传任何参数：保持旧行为，返回完整字段 list（兼容现有调用方）
    - fields=basic：裁剪大字段，用于列表展示加速
    - page+page_size：同时提供时返回分页结构 {items, total, page, page_size, has_more}

    缓存：@cached 装饰器自动把 page/page_size/fields 纳入缓存键，不会与现有缓存冲突。
    """
    trim_heavy = fields == "basic"
    paginate = page is not None and page_size is not None

    character_service = CharacterService(db)
    if trim_heavy:
        # fields=basic：SQL 层 defer 大字段列，避免缓存未命中时全列全表加载
        characters = (
            db.query(Character)
            .filter(Character.user_id == user.id)
            .order_by(Character.updated_at.desc())
            .options(
                defer(Character.first_mes),
                defer(Character.mes_example),
                defer(Character.creator_notes),
                defer(Character.post_history_instructions),
                defer(Character.scenario),
                defer(Character.system_prompt),
                defer(Character.preset_data),
                defer(Character.ui_config),
                defer(Character.alternate_greetings),
                defer(Character.personality),
                defer(Character.background),
            )
            .all()
        )
    else:
        characters = character_service.get_characters(user.id)

    from ..models.worldbook import WorldBook
    char_ids = [c.id for c in characters]
    wb_char_ids = set()
    if char_ids:
        rows = db.query(WorldBook.character_id).filter(
            WorldBook.character_id.in_(char_ids),
            WorldBook.is_parsed == True
        ).distinct().all()
        wb_char_ids = {r[0] for r in rows}

    result = []
    for c in characters:
        char_data = {
            "id": c.id,
            "name": c.name,
            "description": c.description,
            "avatar": c.avatar,
            "created_at": c.created_at,
            "updated_at": c.updated_at,
            "creator": c.creator,
            "character_version": c.character_version,
            "is_processing": c.is_processing or False,
            "processing_status": c.processing_status or "",
            "has_character_book": c.id in wb_char_ids,
        }
        try:
            if c.tags:
                char_data["tags"] = json.loads(c.tags)
            else:
                char_data["tags"] = []
            if c.extensions:
                char_data["extensions"] = json.loads(c.extensions)
            else:
                char_data["extensions"] = {}
        except (json.JSONDecodeError, TypeError, ValueError):
            char_data["tags"] = []
            char_data["extensions"] = {}

        if trim_heavy:
            # fields=basic：大字段列已 defer，不访问即不触发懒加载；
            # 与旧 pop 行为一致——这些字段不进入响应体
            char_data["has_alternate_greetings"] = False
        else:
            char_data["background"] = c.background
            char_data["personality"] = c.personality
            char_data["scenario"] = c.scenario
            char_data["first_mes"] = c.first_mes
            char_data["mes_example"] = c.mes_example
            char_data["system_prompt"] = c.system_prompt
            try:
                if c.preset_data:
                    char_data["preset_data"] = json.loads(c.preset_data)
                else:
                    char_data["preset_data"] = None
                if c.ui_config:
                    char_data["ui_config"] = json.loads(c.ui_config)
                else:
                    char_data["ui_config"] = None
            except (json.JSONDecodeError, TypeError, ValueError):
                char_data["preset_data"] = None
                char_data["ui_config"] = None
            try:
                alternate_greetings = json.loads(c.alternate_greetings) if c.alternate_greetings else []
                char_data["alternate_greetings"] = alternate_greetings if isinstance(alternate_greetings, list) else []
                char_data["has_alternate_greetings"] = bool(char_data["alternate_greetings"])
            except (json.JSONDecodeError, TypeError, ValueError):
                char_data["alternate_greetings"] = []
                char_data["has_alternate_greetings"] = False
            char_data["creator_notes"] = c.creator_notes
            char_data["post_history_instructions"] = c.post_history_instructions

        result.append(char_data)

    # 分页（仅当 page 与 page_size 同时提供时启用）
    if paginate:
        total = len(result)
        start = (page - 1) * page_size
        end = start + page_size
        items = result[start:end] if start < total else []
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": end < total,
        }

    return result

@router.post("/batch-import")
async def batch_import_characters(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """批量导入角色卡（ZIP 文件，包含 .png 和 .json 文件）"""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    content = await _read_upload_with_limit(file, _MAX_BATCH_IMPORT_UPLOAD_SIZE)
    if not content:
        raise HTTPException(400, "Empty file")

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as e:
        raise HTTPException(400, f"无效的 ZIP 文件: {e}")

    infos = [info for info in zf.infolist() if not info.is_dir()]
    if len(infos) > _MAX_BATCH_IMPORT_FILE_COUNT:
        raise HTTPException(
            400,
            f"ZIP 内文件数过多（最多 {_MAX_BATCH_IMPORT_FILE_COUNT} 个）",
        )

    import_service = CharacterImportService(db)
    imported = []
    failed = []

    for info in infos:
        filename = info.filename
        # 取 basename，避免目录路径干扰（ZIP 始终使用 / 作为分隔符）
        safe_name = filename.split("/")[-1].split("\\")[-1]
        if not safe_name:
            continue

        lower = safe_name.lower()
        if not (lower.endswith(".png") or lower.endswith(".json")):
            continue

        try:
            file_content = zf.read(info)
        except Exception as e:
            failed.append({"filename": filename, "error": f"读取文件失败: {e}"})
            continue

        try:
            character = await import_service.import_from_file(safe_name, file_content, user.id)
            imported.append({
                "id": character.get("id"),
                "name": character.get("name"),
            })
        except ValueError as e:
            db.rollback()
            failed.append({"filename": filename, "error": str(e)})
        except Exception as e:
            db.rollback()
            logger.warning("Batch import failed for %s: %s", filename, e)
            failed.append({"filename": filename, "error": f"导入失败: {e}"})

    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)
    return {"imported": imported, "failed": failed}

@router.get("/export-all")
async def export_all_characters(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """导出当前用户的所有角色卡为 ZIP 文件（每个角色卡为含内嵌 JSON 的 PNG）"""
    from sqlalchemy.orm import selectinload
    from ..models.worldbook import WorldBook
    from ..character_card import create_png_with_chara_card, convert_character_to_chara_card
    from ..utils import _is_public_http_url
    from .character_ext import _worldbook_to_charbook

    characters = db.query(Character).filter(Character.user_id == user.id).all()
    if not characters:
        raise HTTPException(404, "No characters found to export")

    char_ids = [c.id for c in characters]
    worldbooks = {}
    if char_ids:
        wbs = db.query(WorldBook).filter(
            WorldBook.character_id.in_(char_ids)
        ).options(selectinload(WorldBook.entries)).all()
        worldbooks = {wb.character_id: wb for wb in wbs}

    used_names = set()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for char in characters:
            wb = worldbooks.get(char.id)
            charbook_data = _worldbook_to_charbook(wb) if wb else None
            card_data = convert_character_to_chara_card(char, world_book_data=charbook_data)

            avatar_url = char.avatar or ""
            image_data = None
            if avatar_url.startswith("data:image"):
                try:
                    image_data = base64.b64decode(avatar_url.split(",", 1)[1])
                except Exception:
                    pass
            elif avatar_url.startswith(("http://", "https://")) and _is_public_http_url(avatar_url):
                try:
                    import httpx
                    with httpx.Client(timeout=10.0, follow_redirects=False) as client:
                        resp = client.get(avatar_url)
                        image_data = resp.content
                except Exception:
                    pass

            if not image_data:
                from PIL import Image as PILImage
                img = PILImage.new("RGBA", (256, 256), (100, 100, 100, 255))
                img_buf = io.BytesIO()
                img.save(img_buf, format="PNG")
                image_data = img_buf.getvalue()

            png_bytes = create_png_with_chara_card(image_data, card_data)

            # 文件名安全化
            raw_name = (char.name or "").strip() or "character"
            safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', raw_name)
            if len(safe_name) > 100:
                safe_name = safe_name[:100]
            if not safe_name:
                safe_name = "character"

            file_name = f"{safe_name}.png"
            counter = 1
            while file_name in used_names:
                file_name = f"{safe_name}_{counter}.png"
                counter += 1
            used_names.add(file_name)

            zf.writestr(file_name, png_bytes)

    zip_bytes = buf.getvalue()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"characters_export_{timestamp}.zip"

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@router.get("/{character_id}/random-greeting")
async def get_random_greeting(
    character_id: str,
    exclude: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    all_greetings = [char.first_mes] if char.first_mes else []
    if char.alternate_greetings:
        try:
            alt = json.loads(char.alternate_greetings)
            all_greetings.extend([g for g in alt if g])
        except (json.JSONDecodeError, TypeError):
            pass
    if not all_greetings:
        return {"greeting": ""}
    if exclude and len(all_greetings) > 1:
        candidates = [g for g in all_greetings if g != exclude]
        if candidates:
            return {"greeting": random.choice(candidates)}
    return {"greeting": random.choice(all_greetings)}

@router.get("/{character_id}")
@cached(ttl_seconds=30, key_prefix="character_detail")
async def get_character(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取角色详情"""
    character_service = CharacterService(db)
    character = character_service.get_character(character_id, user.id)
    
    if not character:
        raise HTTPException(404, "Character not found")
    
    user_nickname = character.user_nickname or user.username or "用户"
    
    char_data = {
        "id": character.id,
        "name": character.name,
        "description": character.description,
        "background": character.background,
        "personality": character.personality,
        "avatar": character.avatar,
        "created_at": character.created_at,
        "updated_at": character.updated_at,
        "scenario": character.scenario,
        "first_mes": character.first_mes,
        "mes_example": character.mes_example,
        "system_prompt": character.system_prompt,
        "creator": character.creator,
        "character_version": character.character_version,
        "user_nickname": character.user_nickname,
        "is_processing": character.is_processing or False
    }

    from ..models.worldbook import WorldBook
    has_character_book = db.query(WorldBook.id).filter(
        WorldBook.character_id == character.id,
        WorldBook.is_parsed == True
    ).first() is not None
    char_data["has_character_book"] = has_character_book
    try:
        if character.tags:
            char_data["tags"] = json.loads(character.tags)
        else:
            char_data["tags"] = []
        if character.extensions:
            char_data["extensions"] = json.loads(character.extensions)
        else:
            char_data["extensions"] = {}
        if character.preset_data:
            char_data["preset_data"] = json.loads(character.preset_data)
        else:
            char_data["preset_data"] = None
    except (json.JSONDecodeError, TypeError, ValueError):
        char_data["tags"] = []
        char_data["extensions"] = {}
        char_data["preset_data"] = None
    try:
        char_data["alternate_greetings"] = json.loads(character.alternate_greetings) if character.alternate_greetings else []
    except (json.JSONDecodeError, TypeError, ValueError):
        char_data["alternate_greetings"] = []
    try:
        if character.ui_config:
            char_data["ui_config"] = json.loads(character.ui_config)
        else:
            char_data["ui_config"] = None
    except (json.JSONDecodeError, TypeError, ValueError):
        char_data["ui_config"] = None
    char_data["creator_notes"] = character.creator_notes
    char_data["post_history_instructions"] = character.post_history_instructions
    try:
        char_data["group_only_greetings"] = json.loads(character.group_only_greetings) if character.group_only_greetings else []
    except (json.JSONDecodeError, TypeError, ValueError):
        char_data["group_only_greetings"] = []
    char_data["talkativeness"] = character.talkativeness if character.talkativeness is not None else "0.5"
    char_data["nickname"] = character.nickname
    schedule_smart_card_source_prefetch(
        f"character:{character.id}",
        "\n".join(
            value
            for value in [
                character.extensions,
                character.first_mes,
                character.alternate_greetings,
                character.creator_notes,
                character.post_history_instructions,
            ]
            if value
        )
    )
    return char_data

@router.post("")
async def create_character(
    req: CharacterCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建角色"""
    character_service = CharacterService(db)
    character = character_service.create_character(user.id, req)
    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "character", character_id=character.id)
    except Exception:
        logger.debug("ST sync trigger failed for character create", exc_info=True)

    return {"status": "ok", "character": {"id": character.id, "name": character.name}}

@router.post("/import")
async def import_character(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """导入角色卡（PNG 或 JSON 格式）"""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    content = await _read_upload_with_limit(file, _MAX_CHARACTER_IMPORT_UPLOAD_SIZE)
    if not content:
        raise HTTPException(400, "Empty file")

    import_service = CharacterImportService(db)

    try:
        character = await import_service.import_from_file(file.filename, content, user.id)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        logger.exception("Character import failed")
        raise HTTPException(500, f"导入失败: {e}")

    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)
    return {"status": "ok", "character": character, "auto_parsed": False}

@router.post("/{character_id}/import-preset")
async def import_preset(
    character_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """为角色导入SillyTavern预设文件（JSON格式）"""
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(404, "Character not found")

    if not file.filename:
        raise HTTPException(400, "No filename provided")

    content = await _read_upload_with_limit(file, _MAX_PRESET_UPLOAD_SIZE)
    if not content:
        raise HTTPException(400, "Empty file")

    try:
        preset_data = json.loads(content.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise HTTPException(422, f"无效的JSON文件: {e}")

    # 验证是否为SillyTavern预设格式
    if "prompts" not in preset_data or not isinstance(preset_data["prompts"], list):
        raise HTTPException(422, "该文件不是有效的SillyTavern预设文件（缺少prompts字段）")

    char.preset_data = json.dumps(preset_data, ensure_ascii=False)
    db.commit()
    db.refresh(char)

    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)

    logger.info("Preset imported for character %s", character_id)
    return {"status": "ok", "message": "预设导入成功", "preset_name": preset_data.get("name", "未知预设")}

@router.delete("/{character_id}/preset")
async def remove_preset(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """移除角色的预设"""
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(404, "Character not found")

    char.preset_data = None
    db.commit()
    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)
    return {"status": "ok"}

@router.get("/{character_id}/status")
async def get_character_status(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取角色处理状态"""
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(404, "Character not found")
    return {
        "is_processing": char.is_processing or False,
        "processing_status": char.processing_status or "",
    }

@router.post("/{character_id}/reset-status")
async def reset_character_status(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """重置角色处理状态"""
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(404, "Character not found")
    char.is_processing = False
    char.processing_status = ""
    db.commit()
    return {"status": "ok"}

@router.put("/{character_id}")
async def update_character(
    character_id: str,
    req: CharacterUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新角色"""
    character_service = CharacterService(db)
    character = character_service.update_character(character_id, user.id, req)

    if not character:
        raise HTTPException(404, "Character not found")

    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "character", character_id=character.id)
    except Exception:
        logger.debug("ST sync trigger failed for character update", exc_info=True)

    return {"status": "ok"}

@router.delete("/{character_id}")
async def delete_character(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除角色"""
    character_service = CharacterService(db)
    try:
        success = character_service.delete_character(character_id, user.id)
    except Exception as e:
        logger.error(f"Character deletion failed: {e}")
        raise HTTPException(500, f"Failed to delete character: {e}")

    if not success:
        raise HTTPException(404, "Character not found")

    invalidate_user_cache("character_list", user.id)
    invalidate_user_cache("character_detail", user.id)
    # ST DATA_ROOT 清理已在 character_service.delete_character 中完成
    return {"status": "ok"}
