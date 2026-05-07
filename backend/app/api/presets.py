import json
import logging
from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, GenerationPreset

router = APIRouter(prefix="/api/roleplay/presets", tags=["roleplay-presets"])

logger = logging.getLogger(__name__)


class PresetCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    is_default: bool = False
    activation_regex: Optional[str] = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, ge=0.0, le=1.0)
    max_tokens: int = Field(default=1024, ge=1, le=128000)
    frequency_penalty: float = Field(default=0.0, ge=-2.0, le=2.0)
    presence_penalty: float = Field(default=0.0, ge=-2.0, le=2.0)
    min_p: float = Field(default=0.05, ge=0.0, le=1.0)
    top_k: int = Field(default=40, ge=1, le=200)
    repetition_penalty: float = Field(default=1.1, ge=0.5, le=2.0)
    system_prompt_override: Optional[str] = None
    post_history_instructions: Optional[str] = None


class PresetUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    is_default: Optional[bool] = None
    activation_regex: Optional[str] = None
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    top_p: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=128000)
    frequency_penalty: Optional[float] = Field(default=None, ge=-2.0, le=2.0)
    presence_penalty: Optional[float] = Field(default=None, ge=-2.0, le=2.0)
    min_p: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    top_k: Optional[int] = Field(default=None, ge=1, le=200)
    repetition_penalty: Optional[float] = Field(default=None, ge=0.5, le=2.0)
    system_prompt_override: Optional[str] = None
    post_history_instructions: Optional[str] = None


def _preset_to_dict(p: GenerationPreset) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "is_default": p.is_default,
        "activation_regex": p.activation_regex,
        "temperature": p.temperature,
        "top_p": p.top_p,
        "max_tokens": p.max_tokens,
        "frequency_penalty": p.frequency_penalty,
        "presence_penalty": p.presence_penalty,
        "min_p": p.min_p,
        "top_k": p.top_k,
        "repetition_penalty": p.repetition_penalty,
        "system_prompt_override": p.system_prompt_override,
        "post_history_instructions": p.post_history_instructions,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("")
def list_presets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    presets = (
        db.query(GenerationPreset)
        .filter((GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None))
        .order_by(GenerationPreset.is_default.desc(), GenerationPreset.name)
        .all()
    )
    return [_preset_to_dict(p) for p in presets]


@router.post("")
def create_preset(
    req: PresetCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if req.is_default:
        db.query(GenerationPreset).filter(
            GenerationPreset.user_id == user.id,
            GenerationPreset.is_default == True,
        ).update({"is_default": False})

    p = GenerationPreset(
        user_id=user.id,
        name=req.name,
        is_default=req.is_default,
        activation_regex=req.activation_regex,
        temperature=req.temperature,
        top_p=req.top_p,
        max_tokens=req.max_tokens,
        frequency_penalty=req.frequency_penalty,
        presence_penalty=req.presence_penalty,
        min_p=req.min_p,
        top_k=req.top_k,
        repetition_penalty=req.repetition_penalty,
        system_prompt_override=req.system_prompt_override,
        post_history_instructions=req.post_history_instructions,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.put("/{preset_id}")
def update_preset(
    preset_id: int,
    req: PresetUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(GenerationPreset).filter(
        GenerationPreset.id == preset_id,
        GenerationPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")

    if req.is_default is True:
        db.query(GenerationPreset).filter(
            GenerationPreset.user_id == user.id,
            GenerationPreset.is_default == True,
        ).update({"is_default": False})

    update_data = req.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(p, key, value)
    p.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.delete("/{preset_id}")
def delete_preset(
    preset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(GenerationPreset).filter(
        GenerationPreset.id == preset_id,
        GenerationPreset.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


@router.get("/{preset_id}/export")
def export_preset(
    preset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(GenerationPreset).filter(
        GenerationPreset.id == preset_id,
        (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
    ).first()
    if not p:
        raise HTTPException(404, "Preset not found")

    export_data = {
        "name": p.name,
        "temperature": p.temperature,
        "top_p": p.top_p,
        "max_tokens": p.max_tokens,
        "frequency_penalty": p.frequency_penalty,
        "presence_penalty": p.presence_penalty,
        "min_p": p.min_p,
        "top_k": p.top_k,
        "repetition_penalty": p.repetition_penalty,
        "system_prompt": p.system_prompt_override,
        "post_history_instructions": p.post_history_instructions,
        "activation_regex": p.activation_regex,
        "_palink_version": "0.22.0",
        "_source": "palink-ai",
    }
    return export_data


@router.post("/import")
async def import_preset(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    content = await file.read(5 * 1024 * 1024)
    if await file.read(1):
        raise HTTPException(413, "File too large (max 5MB)")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON file")

    name = data.get("name", file.filename or "Imported Preset")
    existing = db.query(GenerationPreset).filter(
        GenerationPreset.user_id == user.id,
        GenerationPreset.name == name,
    ).first()
    if existing:
        name = f"{name} (imported)"

    p = GenerationPreset(
        user_id=user.id,
        name=name,
        temperature=data.get("temperature", 0.7),
        top_p=data.get("top_p", 0.95),
        max_tokens=data.get("max_tokens", 1024),
        frequency_penalty=data.get("frequency_penalty", 0.0),
        presence_penalty=data.get("presence_penalty", 0.0),
        min_p=data.get("min_p", 0.05),
        top_k=data.get("top_k", 40),
        repetition_penalty=data.get("repetition_penalty", 1.1),
        system_prompt_override=data.get("system_prompt") or data.get("sysprompt"),
        post_history_instructions=data.get("post_history_instructions"),
        activation_regex=data.get("activation_regex"),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _preset_to_dict(p)


@router.post("/ensure-defaults")
def ensure_default_presets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = db.query(GenerationPreset).filter(
        GenerationPreset.user_id == user.id,
    ).first()

    if existing:
        return {"created": 0}

    defaults = [
        GenerationPreset(
            user_id=user.id, name="平衡", is_default=True,
            temperature=0.7, top_p=0.95, max_tokens=1024,
            frequency_penalty=0.0, presence_penalty=0.0,
            min_p=0.05, top_k=40, repetition_penalty=1.1,
        ),
        GenerationPreset(
            user_id=user.id, name="自由",
            temperature=1.0, top_p=0.9, max_tokens=2048,
            frequency_penalty=0.0, presence_penalty=0.0,
            min_p=0.05, top_k=40, repetition_penalty=1.0,
        ),
        GenerationPreset(
            user_id=user.id, name="严谨",
            temperature=0.3, top_p=0.95, max_tokens=1024,
            frequency_penalty=0.0, presence_penalty=0.0,
            min_p=0.05, top_k=40, repetition_penalty=1.2,
        ),
    ]
    for d in defaults:
        db.add(d)
    db.commit()
    return {"created": len(defaults)}
