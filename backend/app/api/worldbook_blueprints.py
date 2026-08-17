"""World Book Blueprints API routes — CRUD + apply (ST 1.18.0 blueprints)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import get_db
from ..core.cache import invalidate_cache
from ..api.dependencies import get_current_user
from ..models import User
from ..models.worldbook import WorldBook, WorldBookBlueprint
from ..schemas.worldbook import (
    BlueprintCreate,
    BlueprintUpdate,
    BlueprintApplyRequest,
)
from ..services.worldbook_service import apply_blueprint, BlueprintApplyResult

router = APIRouter(prefix="/api/worldbook-blueprints", tags=["worldbook-blueprints"])


def _blueprint_to_response(bp: WorldBookBlueprint) -> dict:
    return {
        "id": bp.id,
        "name": bp.name,
        "description": bp.description,
        "entries_json": bp.entries_json,
        "trigger_logic": bp.trigger_logic,
        "created_at": str(bp.created_at) if bp.created_at else "",
        "updated_at": str(bp.updated_at) if bp.updated_at else "",
    }


@router.get("")
async def list_blueprints(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出所有世界书蓝图"""
    bps = db.query(WorldBookBlueprint).order_by(WorldBookBlueprint.id.desc()).all()
    return [_blueprint_to_response(bp) for bp in bps]


@router.post("")
async def create_blueprint(
    req: BlueprintCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建世界书蓝图"""
    existing = db.query(WorldBookBlueprint).filter(WorldBookBlueprint.name == req.name).first()
    if existing:
        raise HTTPException(409, "Blueprint with this name already exists")
    bp = WorldBookBlueprint(
        name=req.name,
        description=req.description,
        entries_json=req.entries_json,
        trigger_logic=req.trigger_logic,
    )
    db.add(bp)
    db.commit()
    db.refresh(bp)
    return _blueprint_to_response(bp)


@router.get("/{blueprint_id}")
async def get_blueprint(
    blueprint_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取蓝图详情"""
    bp = db.query(WorldBookBlueprint).filter(WorldBookBlueprint.id == blueprint_id).first()
    if not bp:
        raise HTTPException(404, "Blueprint not found")
    return _blueprint_to_response(bp)


@router.put("/{blueprint_id}")
async def update_blueprint(
    blueprint_id: int,
    req: BlueprintUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新蓝图"""
    bp = db.query(WorldBookBlueprint).filter(WorldBookBlueprint.id == blueprint_id).first()
    if not bp:
        raise HTTPException(404, "Blueprint not found")
    if req.name is not None:
        dup = db.query(WorldBookBlueprint).filter(
            WorldBookBlueprint.name == req.name, WorldBookBlueprint.id != blueprint_id
        ).first()
        if dup:
            raise HTTPException(409, "Blueprint with this name already exists")
        bp.name = req.name
    if req.description is not None:
        bp.description = req.description
    if req.entries_json is not None:
        bp.entries_json = req.entries_json
    if req.trigger_logic is not None:
        bp.trigger_logic = req.trigger_logic
    db.commit()
    db.refresh(bp)
    return _blueprint_to_response(bp)


@router.delete("/{blueprint_id}")
async def delete_blueprint(
    blueprint_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除蓝图"""
    bp = db.query(WorldBookBlueprint).filter(WorldBookBlueprint.id == blueprint_id).first()
    if not bp:
        raise HTTPException(404, "Blueprint not found")
    db.delete(bp)
    db.commit()
    return {"status": "ok"}


@router.post("/{blueprint_id}/apply")
async def apply_blueprint_endpoint(
    blueprint_id: int,
    req: BlueprintApplyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """将蓝图应用到指定世界书（幂等：通过 comment 去重）"""
    # 校验目标世界书归属当前用户
    wb = db.query(WorldBook).filter(
        WorldBook.id == req.worldbook_id, WorldBook.user_id == user.id
    ).first()
    if not wb:
        raise HTTPException(404, "World book not found")

    try:
        result: BlueprintApplyResult = apply_blueprint(db, req.worldbook_id, blueprint_id)
    except ValueError as e:
        raise HTTPException(404, str(e))

    # 失效世界书相关缓存
    invalidate_cache(f"worldbook_list:user={user.id}")

    return {
        "status": "ok",
        "worldbook_id": req.worldbook_id,
        "blueprint_id": blueprint_id,
        "created_count": result.created_count,
        "skipped_count": result.skipped_count,
        "created_entry_ids": result.created_entry_ids,
        "skipped_comments": result.skipped_comments,
    }
