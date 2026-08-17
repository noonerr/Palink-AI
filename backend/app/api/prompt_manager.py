"""Prompt Manager API routes — CRUD for prompt presets."""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.prompt_preset import PromptPreset

router = APIRouter(prefix="/api/prompt-manager", tags=["prompt-manager"])


def _utc_now():
    return datetime.now(timezone.utc)


class PresetCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    entries: List[Dict[str, Any]] = []
    config: Optional[Dict[str, Any]] = None


class PresetUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    entries: Optional[List[Dict[str, Any]]] = None
    config: Optional[Dict[str, Any]] = None


def _preset_to_dict(p: PromptPreset) -> dict:
    entries_data = []
    if p.entries:
        try:
            entries_data = json.loads(p.entries)
        except (json.JSONDecodeError, TypeError):
            entries_data = []
    config_data = None
    if p.config:
        try:
            config_data = json.loads(p.config)
        except (json.JSONDecodeError, TypeError):
            config_data = None
    return {
        "id": p.id,
        "name": p.name,
        "entries": entries_data,
        "config": config_data,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("/presets")
def list_presets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    presets = (
        db.query(PromptPreset)
        .filter(PromptPreset.user_id == user.id)
        .order_by(PromptPreset.updated_at.desc())
        .all()
    )
    return [_preset_to_dict(p) for p in presets]


@router.post("/presets")
def create_preset(
    req: PresetCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = PromptPreset(
        user_id=user.id,
        name=req.name,
        entries=json.dumps(req.entries, ensure_ascii=False) if req.entries else None,
        config=json.dumps(req.config, ensure_ascii=False) if req.config else None,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.put("/presets/{preset_id}")
def update_preset(
    preset_id: str,
    req: PresetUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(PromptPreset).filter(
        PromptPreset.id == preset_id,
        PromptPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")

    if req.name is not None:
        p.name = req.name
    if req.entries is not None:
        p.entries = json.dumps(req.entries, ensure_ascii=False) if req.entries else None
    if req.config is not None:
        p.config = json.dumps(req.config, ensure_ascii=False) if req.config else None
    p.updated_at = _utc_now()
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.delete("/presets/{preset_id}")
def delete_preset(
    preset_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(PromptPreset).filter(
        PromptPreset.id == preset_id,
        PromptPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")
    db.delete(p)
    db.commit()
    return {"ok": True}
