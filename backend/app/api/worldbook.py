"""World Book API routes — CRUD, import, session association, keyword-trigger."""
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.worldbook import WorldBook, WorldBookStage, SessionWorldBook
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


def _wb_to_response(wb: WorldBook) -> dict:
    stage_count = len(wb.entries) if wb.entries else 0
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
        "tags": tags,
        "is_parsed": wb.is_parsed,
        "stage_count": stage_count,
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
    }


# ──────────────────────────────────────────────
# World Book CRUD
# ──────────────────────────────────────────────

@router.get("")
async def list_worldbooks(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取用户的所有世界书"""
    wbs = db.query(WorldBook).filter(WorldBook.user_id == user.id).order_by(WorldBook.updated_at.desc()).all()
    return [_wb_to_response(wb) for wb in wbs]


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
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)
    db.commit()
    db.refresh(wb)
    return _wb_to_response(wb)


@router.get("/{world_book_id}")
async def get_worldbook(
    world_book_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取世界书详情（含阶段列表）"""
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
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
    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id, WorldBook.user_id == user.id).first()
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
    return _wb_to_response(wb)


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
    return {"ok": True}


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

    content = await file.read()
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
        if entry.get("disable", False):
            continue
        comment = entry.get("comment", "")
        entry_content = entry.get("content", "")
        if entry_content:
            raw_parts.append(f"## {comment}\n{entry_content}" if comment else entry_content)

    name = data.get("name") or file.filename.replace(".json", "")
    description = data.get("description", "")

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
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(wb)

    # Auto-create entries from lorebook: keyword-trigger mode
    stage_index = 0
    for _key, entry in sorted(entries.items(), key=lambda x: x[1].get("order", 0)):
        if entry.get("disable", False):
            continue
        entry_content = entry.get("content", "").strip()
        if not entry_content:
            continue
        is_constant = entry.get("constant", False)
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
            keys=json.dumps(entry.get("key", [])),
            secondary_keys=json.dumps(entry.get("keysecondary", [])),
            scan_depth=entry.get("scanDepth", 4),
            position=entry.get("position", 4),
            selective=entry.get("selective", False),
            probability=entry.get("probability", 100),
            constant=is_constant,
            created_at=_utc_now(),
        )
        db.add(stage)
        stage_index += 1

    if stage_index > 0:
        wb.is_parsed = True

    db.commit()
    db.refresh(wb)
    return _wb_to_response(wb)


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

    wb = db.query(WorldBook).filter(WorldBook.id == req.world_book_id, WorldBook.user_id == user.id).first()
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
        "world_book": _wb_to_response(wb),
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
    return {"ok": True}


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

    swb = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if not swb:
        return {"active": False}

    wb = db.query(WorldBook).filter(WorldBook.id == swb.world_book_id).first()
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
        "world_book_name": wb.name if wb else None,
        "active_entries_count": entry_count,
        "entries_overview": entries_overview,
    }
