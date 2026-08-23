"""World Book API routes — CRUD, import, session association, keyword-trigger."""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session, selectinload

from ..core import get_db
from ..core.cache import cached, invalidate_cache
from ..core.input_validation import sanitize_name, sanitize_text, sanitize_tags
from ..api.dependencies import get_current_user
from ..models import User
from ..models.worldbook import WorldBook, WorldBookStage, SessionWorldBook
from ..services.worldbook_import_utils import (
    entry_is_disabled,
    entry_keys,
    entry_secondary_keys,
    normalize_worldbook_position,
)
from ..schemas.worldbook import (
    WorldBookCreate, WorldBookUpdate, WorldBookResponse,
    WorldBookDetailResponse, WorldBookStageResponse, WorldBookStageUpdate,
    SessionWorldBookCreate, SessionWorldBookResponse,
    WorldBookParseRequest,
)

router = APIRouter(prefix="/api/worldbooks", tags=["worldbooks"])
router_session_wb = APIRouter(prefix="/api/character-sessions", tags=["session-worldbook"])


def _utc_now():
    return datetime.now(timezone.utc)


def _wb_to_response(wb: WorldBook, stage_count: int = 0) -> dict:
    tags = None
    if wb.tags:
        try:
            tags = json.loads(wb.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
    return {
        "id": wb.id,
        "name": wb.name,
        "description": wb.description,
        "source_type": wb.source_type,
        "format": wb.format,
        "type": wb.type or "world_book",
        "tags": tags,
        "is_parsed": wb.is_parsed,
        "stage_count": stage_count,
        "character_id": wb.character_id,
        "created_at": str(wb.created_at) if wb.created_at else "",
        "updated_at": str(wb.updated_at) if wb.updated_at else "",
    }


def _parse_keys(field) -> list:
    """Safely parse a JSON-encoded keys field."""
    if not field:
        return []
    try:
        return json.loads(field)
    except (json.JSONDecodeError, TypeError):
        return []


def _stage_to_response(s: WorldBookStage) -> dict:
    return {
        "id": s.id,
        "world_book_id": s.world_book_id,
        "stage_index": s.stage_index,
        "title": s.title,
        "content": s.content,
        "summary": s.summary,
        "transition_hint": s.transition_hint,
        "priority": s.priority,
        "token_count": s.token_count,
        "image_prompt": s.image_prompt,
        "keys": _parse_keys(s.keys),
        "secondary_keys": _parse_keys(s.secondary_keys),
        "scan_depth": s.scan_depth if s.scan_depth is not None else 4,
        "position": s.position if s.position is not None else 4,
        "selective": bool(s.selective),
        "probability": s.probability if s.probability is not None else 100,
        "constant": bool(s.constant),
        "group": s.group,
        "extensions_json": s.extensions_json,
    }


# ──────────────────────────────────────────────
# World Book CRUD
# ──────────────────────────────────────────────

@router.get("")
@cached(ttl_seconds=15, key_prefix="worldbook_list")
async def list_worldbooks(
    character_id: Optional[str] = None,
    type: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取用户的所有世界书"""
    from sqlalchemy import func as sa_func

    entry_count_sub = db.query(
        WorldBookStage.world_book_id,
        sa_func.count(WorldBookStage.id).label("stage_count")
    ).group_by(WorldBookStage.world_book_id).subquery()

    query = db.query(WorldBook, sa_func.coalesce(entry_count_sub.c.stage_count, 0)).outerjoin(
        entry_count_sub, WorldBook.id == entry_count_sub.c.world_book_id
    ).filter(
        WorldBook.user_id == user.id,
    )
    if type == "character_book":
        if character_id:
            query = query.filter(WorldBook.character_id == character_id, WorldBook.type == "character_book")
        else:
            query = query.filter(WorldBook.character_id.isnot(None), WorldBook.type == "character_book")
    elif type == "world_book":
        query = query.filter(WorldBook.type == "world_book")
    else:
        if character_id:
            query = query.filter(
                (WorldBook.character_id.is_(None)) | (WorldBook.character_id == character_id)
            )
        else:
            pass
    rows = query.order_by(WorldBook.updated_at.desc()).all()
    return [_wb_to_response(wb, stage_count) for wb, stage_count in rows]


@router.post("")
async def create_worldbook(
    req: WorldBookCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建世界书（在线编写或标记为上传来源）"""
    wb = WorldBook(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=req.name,
        description=req.description,
        source_type=req.source_type,
        raw_content=req.raw_content,
        format=req.format,
        tags=json.dumps(req.tags) if req.tags else None,
        is_parsed=False,
        type="world_book",
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)
    db.commit()
    db.refresh(wb)
    invalidate_cache(f"worldbook_list:user={user.id}")

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "worldbook", world_book_id=wb.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for worldbook create", exc_info=True,
        )

    return _wb_to_response(wb, 0)


@router.get("/{world_book_id}")
async def get_worldbook(
    world_book_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取世界书详情（含阶段列表）"""
    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    tags = None
    if wb.tags:
        try:
            tags = json.loads(wb.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
    return {
        "id": wb.id,
        "name": wb.name,
        "description": wb.description,
        "source_type": wb.source_type,
        "raw_content": wb.raw_content,
        "format": wb.format,
        "type": wb.type or "world_book",
        "tags": tags,
        "is_parsed": wb.is_parsed,
        "stages": [_stage_to_response(s) for s in wb.entries],
        "created_at": str(wb.created_at) if wb.created_at else "",
        "updated_at": str(wb.updated_at) if wb.updated_at else "",
    }


@router.put("/{world_book_id}")
async def update_worldbook(
    world_book_id: str,
    req: WorldBookUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """编辑世界书"""
    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    if req.name is not None:
        wb.name = req.name
    if req.description is not None:
        wb.description = req.description
    if req.raw_content is not None:
        wb.raw_content = req.raw_content
        wb.is_parsed = False  # Content changed, need re-parse
    if req.tags is not None:
        wb.tags = json.dumps(req.tags)
    wb.updated_at = _utc_now()
    db.commit()
    db.refresh(wb)
    invalidate_cache(f"worldbook_list:user={user.id}")

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "worldbook", world_book_id=wb.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for worldbook update", exc_info=True,
        )

    return _wb_to_response(wb, len(wb.entries) if wb.entries else 0)


@router.delete("/{world_book_id}")
async def delete_worldbook(
    world_book_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除世界书"""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    # Also remove any session associations
    db.query(SessionWorldBook).filter(SessionWorldBook.world_book_id == world_book_id).delete()
    db.delete(wb)
    db.commit()
    invalidate_cache(f"worldbook_list:user={user.id}")

    # 级联清理 ST DATA_ROOT 中的 worlds 文件
    try:
        from pathlib import Path
        from ..services.st_sync_service import _st_data_root_for_user, _world_file_name
        data_root = _st_data_root_for_user(user)
        if data_root:
            world_path = Path(data_root) / "worlds" / _world_file_name(world_book_id)
            if world_path.exists():
                world_path.unlink(missing_ok=True)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST DATA_ROOT cleanup failed for worldbook delete", exc_info=True,
        )

    return {"status": "ok"}


# ──────────────────────────────────────────────
# Import SillyTavern V2 JSON
# ──────────────────────────────────────────────

@router.post("/import")
async def import_worldbook(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导入 SillyTavern V2 JSON 世界书文件"""
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(400, "Only .json files are supported")

    content = await file.read(5 * 1024 * 1024)
    if await file.read(1):
        raise HTTPException(413, "File too large (max 5MB)")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON file")

    # SillyTavern lorebook format has "entries" key
    entries = data.get("entries", {})
    if not entries and isinstance(data, list):
        # Some formats use a list of entries directly
        entries = {str(i): e for i, e in enumerate(data)}

    if not entries:
        raise HTTPException(400, "No entries found in world book file")

    # Build raw content from entries for storage
    raw_parts = []
    for _key, entry in sorted(entries.items(), key=lambda x: x[1].get("order", 0)):
        if entry_is_disabled(entry):
            continue
        comment = entry.get("comment", "")
        entry_content = entry.get("content", "")
        if entry_content:
            raw_parts.append(f"## {comment}\n{entry_content}" if comment else entry_content)

    name = data.get("name") or file.filename.replace(".json", "")
    description = data.get("description", "")
    
    try:
        name = sanitize_name(name, max_length=200)
    except ValueError:
        name = file.filename.replace(".json", "")
        name = sanitize_name(name, max_length=200)
    try:
        description = sanitize_text(description, max_length=5000) or ""
    except ValueError:
        description = ""

    wb = WorldBook(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=name,
        description=description,
        source_type="upload",
        raw_content="\n\n---\n\n".join(raw_parts),
        format="silly_tavern_v2",
        tags=json.dumps(data.get("tags", [])),
        is_parsed=False,
        type="world_book",
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)

    # Auto-create entries from lorebook: keyword-trigger mode
    MAX_IMPORT_ENTRIES = 500
    stage_index = 0
    for _key, entry in sorted(entries.items(), key=lambda x: x[1].get("order", 0)):
        if stage_index >= MAX_IMPORT_ENTRIES:
            break
        if entry_is_disabled(entry):
            continue
        entry_content = entry.get("content", "").strip()
        if not entry_content:
            continue
        if len(entry_content) > 50000:
            entry_content = entry_content[:50000]
        is_constant = entry.get("constant", False)
        extensions = entry.get("extensions") or {}
        # D-2 修复（2026-08-23）: 补齐条目级高级字段映射（此前仅映射 8 项，
        # order/sticky/cooldown/delay/depth/selectiveLogic/caseSensitive/
        # matchWholeWords/excludeRecursion/preventRecursion/group 系/scanDepth
        # 等十余字段静默丢失）。字段名与默认值语义对齐 ST 契约路径
        # （silly_tavern.py:1618-1670）与 character_import_service 路径。
        def _int(name: str, default: int) -> int:
            v = entry.get(name)
            return v if isinstance(v, int) and not isinstance(v, bool) else default

        stage = WorldBookStage(
            id=str(uuid.uuid4()),
            world_book_id=wb.id,
            stage_index=stage_index,
            title=entry.get("comment", f"Entry {stage_index}"),
            content=entry_content,
            summary=None,
            transition_hint=None,
            priority=10 if is_constant else 5,
            token_count=len(entry_content) // 4,
            keys=json.dumps(entry_keys(entry)),
            secondary_keys=json.dumps(entry_secondary_keys(entry)),
            scan_depth=_int("scanDepth", 4),
            position=normalize_worldbook_position(entry.get("position", 4)),
            selective=entry.get("selective", False),
            probability=entry.get("probability", 100),
            constant=is_constant,
            group=entry.get("group", None),
            enabled=True,  # disabled 条目已在上方 entry_is_disabled 过滤
            case_sensitive=bool(entry.get("caseSensitive")),
            match_whole_words=bool(entry.get("matchWholeWords")),
            selective_logic=_int("selectiveLogic", 0),
            sticky=_int("sticky", 0),
            cooldown=_int("cooldown", 0),
            delay=_int("delay", 0),
            depth=_int("depth", 4),
            order=_int("order", stage_index),
            exclude_recursion=bool(entry.get("excludeRecursion")),
            prevent_recursion=bool(entry.get("preventRecursion")),
            group_override=bool(entry.get("groupOverride")),
            group_weight=_int("groupWeight", 0),
            vectorized=bool(entry.get("vectorized")),
            add_memo=bool(entry.get("addMemo")),
            decorators=json.dumps(entry.get("decorators") or [], ensure_ascii=False),
            character_filter=None,
            min_activations=_int("minActivations", 0),
            delay_until_recursion=(
                int(entry["delayUntilRecursion"])
                if isinstance(entry.get("delayUntilRecursion"), int) and not isinstance(entry.get("delayUntilRecursion"), bool)
                else 0
            ),
            triggers=json.dumps(entry.get("triggers") or [], ensure_ascii=False),
            outlet_name=(str(entry.get("outletName"))[:200] or None) if entry.get("outletName") else None,
            ignore_budget=bool(entry.get("ignoreBudget") or extensions.get("ignore_budget", False)),
            role=(
                _int("role", 0)
                if isinstance(entry.get("role"), int) and not isinstance(entry.get("role"), bool)
                else (extensions["role"] if isinstance(extensions.get("role"), int) and not isinstance(extensions.get("role"), bool) else 0)
            ),
            use_group_scoring=(
                entry["useGroupScoring"]
                if isinstance(entry.get("useGroupScoring"), bool)
                else (extensions.get("use_group_scoring") if isinstance(extensions.get("use_group_scoring"), bool) else None)
            ),
            automation_id=str(entry.get("automationId") or "") or None,
            created_at=_utc_now(),
        )
        if isinstance(entry.get("matchPersonaDescription"), bool):
            stage.match_persona_description = entry["matchPersonaDescription"]
        if isinstance(entry.get("matchCharacterDescription"), bool):
            stage.match_character_description = entry["matchCharacterDescription"]
        if isinstance(entry.get("matchCharacterPersonality"), bool):
            stage.match_character_personality = entry["matchCharacterPersonality"]
        if isinstance(entry.get("matchCharacterDepthPrompt"), bool):
            stage.match_character_depth_prompt = entry["matchCharacterDepthPrompt"]
        if isinstance(entry.get("matchScenario"), bool):
            stage.match_scenario = entry["matchScenario"]
        if isinstance(entry.get("matchCreatorNotes"), bool):
            stage.match_creator_notes = entry["matchCreatorNotes"]
        entry_extensions = entry.get("extensions", {})
        if entry_extensions and isinstance(entry_extensions, dict):
            stage.extensions_json = json.dumps(entry_extensions, ensure_ascii=False)
        db.add(stage)
        stage_index += 1

    if stage_index > 0:
        wb.is_parsed = True

    db.commit()
    db.refresh(wb)
    invalidate_cache(f"worldbook_list:user={user.id}")
    return _wb_to_response(wb, stage_index)


# ──────────────────────────────────────────────
# Stage editing
# ──────────────────────────────────────────────

@router.put("/{world_book_id}/stages/{stage_id}")
async def update_stage(
    world_book_id: str,
    stage_id: str,
    req: WorldBookStageUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """编辑单个阶段"""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")
    stage = db.query(WorldBookStage).filter(
        WorldBookStage.id == stage_id, WorldBookStage.world_book_id == world_book_id
    ).first()
    if not stage:
        raise HTTPException(404, "Stage not found")

    if req.title is not None:
        stage.title = req.title
    if req.content is not None:
        stage.content = req.content
        stage.token_count = len(req.content) // 4
    if req.summary is not None:
        stage.summary = req.summary
    if req.transition_hint is not None:
        stage.transition_hint = req.transition_hint
    if req.priority is not None:
        stage.priority = max(1, min(10, req.priority))
    if req.image_prompt is not None:
        stage.image_prompt = req.image_prompt
    if req.keys is not None:
        stage.keys = json.dumps(req.keys)
    if req.secondary_keys is not None:
        stage.secondary_keys = json.dumps(req.secondary_keys)
    if req.scan_depth is not None:
        stage.scan_depth = req.scan_depth
    if req.position is not None:
        stage.position = req.position
    if req.selective is not None:
        stage.selective = req.selective
    if req.probability is not None:
        stage.probability = req.probability
    if req.constant is not None:
        stage.constant = req.constant
    if req.group is not None:
        stage.group = req.group

    wb.updated_at = _utc_now()
    db.commit()
    return _stage_to_response(stage)


# ──────────────────────────────────────────────
# Session ↔ WorldBook association
# ──────────────────────────────────────────────

@router_session_wb.post("/{session_id}/worldbook")
async def associate_worldbook(
    session_id: str,
    req: SessionWorldBookCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为对话关联世界书（一个对话仅能激活一个世界书）"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    wb = db.query(WorldBook).options(selectinload(WorldBook.entries)).filter(WorldBook.id == req.world_book_id, WorldBook.user_id == user.id).first()
    if not wb:
        raise HTTPException(404, "World book not found")

    # Remove existing association if any (replace)
    existing = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if existing:
        db.delete(existing)
        db.flush()

    swb = SessionWorldBook(
        id=str(uuid.uuid4()),
        session_id=session_id,
        world_book_id=req.world_book_id,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(swb)
    db.commit()
    db.refresh(swb)

    return {
        "id": swb.id,
        "session_id": swb.session_id,
        "world_book_id": swb.world_book_id,
        "world_book": _wb_to_response(wb, len(wb.entries) if wb.entries else 0),
        "stages": [_stage_to_response(s) for s in wb.entries],
        "created_at": str(swb.created_at),
        "updated_at": str(swb.updated_at),
    }


@router_session_wb.delete("/{session_id}/worldbook")
async def disassociate_worldbook(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """取消对话的世界书关联"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    deleted = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).delete()
    db.commit()
    if not deleted:
        raise HTTPException(404, "No world book associated with this session")
    return {"status": "ok"}


@router_session_wb.get("/{session_id}/worldbook/status")
async def get_worldbook_status(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取对话的世界书状态（当前阶段等）"""
    from ..models.character import CharacterChatSession
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(404, "Session not found")

    result = (
        db.query(SessionWorldBook, WorldBook)
        .join(WorldBook, SessionWorldBook.world_book_id == WorldBook.id)
        .filter(SessionWorldBook.session_id == session_id, WorldBook.user_id == user.id)
        .first()
    )

    if not result:
        return {"active": False}

    swb, wb = result

    entry_count = db.query(WorldBookStage).filter(
        WorldBookStage.world_book_id == swb.world_book_id
    ).count()
    entries_overview = [
        {
            "id": e.id,
            "title": e.title,
            "keys_preview": ", ".join(_parse_keys(e.keys)[:3]) if e.keys else ("[constant]" if e.constant else ""),
        }
        for e in db.query(WorldBookStage).filter(
            WorldBookStage.world_book_id == swb.world_book_id
        ).order_by(WorldBookStage.stage_index).limit(20).all()
    ]

    return {
        "active": True,
        "world_book_id": swb.world_book_id,
        "world_book_name": wb.name,
        "active_entries_count": entry_count,
        "entries_overview": entries_overview,
    }
