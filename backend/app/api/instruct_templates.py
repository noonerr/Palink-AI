"""Instruct template API (ST 1.18.0 parity).

Provides CRUD endpoints for instruct templates used during prompt assembly.
System-preset templates (user_id is NULL) cannot be deleted by users but their
editable fields can still be updated. User-defined templates are scoped to the
requesting user.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, InstructTemplate

router = APIRouter(prefix="/api/instruct-templates", tags=["instruct-templates"])

logger = logging.getLogger(__name__)


class InstructTemplateCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    system_prompt: Optional[str] = ""
    input_prefix: Optional[str] = ""
    input_suffix: Optional[str] = ""
    output_prefix: Optional[str] = ""
    output_suffix: Optional[str] = ""
    first_output_prefix: Optional[str] = ""
    last_output_prefix: Optional[str] = ""
    system_sequence_prefix: Optional[str] = ""
    system_sequence_suffix: Optional[str] = ""
    stop_sequence: Optional[str] = ""
    separator_sequence: Optional[str] = ""
    wrap_sequences: Optional[bool] = False
    is_default: Optional[bool] = False


class InstructTemplateUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    system_prompt: Optional[str] = None
    input_prefix: Optional[str] = None
    input_suffix: Optional[str] = None
    output_prefix: Optional[str] = None
    output_suffix: Optional[str] = None
    first_output_prefix: Optional[str] = None
    last_output_prefix: Optional[str] = None
    system_sequence_prefix: Optional[str] = None
    system_sequence_suffix: Optional[str] = None
    stop_sequence: Optional[str] = None
    separator_sequence: Optional[str] = None
    wrap_sequences: Optional[bool] = None
    is_default: Optional[bool] = None


def _template_to_dict(t: InstructTemplate) -> dict:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "name": t.name,
        "system_prompt": t.system_prompt or "",
        "input_prefix": t.input_prefix or "",
        "input_suffix": t.input_suffix or "",
        "output_prefix": t.output_prefix or "",
        "output_suffix": t.output_suffix or "",
        "first_output_prefix": t.first_output_prefix or "",
        "last_output_prefix": t.last_output_prefix or "",
        "system_sequence_prefix": t.system_sequence_prefix or "",
        "system_sequence_suffix": t.system_sequence_suffix or "",
        "stop_sequence": t.stop_sequence or "",
        "separator_sequence": t.separator_sequence or "",
        "wrap_sequences": bool(t.wrap_sequences),
        "is_default": bool(t.is_default),
        "is_system": t.user_id is None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


@router.get("")
def list_instruct_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all instruct templates (system presets + user-defined).

    System presets (user_id is NULL) are global/shared; user-defined templates
    are scoped to the requesting user.
    """
    templates = (
        db.query(InstructTemplate)
        .filter(
            (InstructTemplate.user_id.is_(None))
            | (InstructTemplate.user_id == user.id)
        )
        .order_by(InstructTemplate.user_id.asc(), InstructTemplate.id)
        .all()
    )
    return [_template_to_dict(t) for t in templates]


@router.get("/{template_id}")
def get_instruct_template(
    template_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(InstructTemplate).filter(InstructTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Instruct template not found")
    # User-defined templates are only visible to their owner.
    if t.user_id is not None and t.user_id != user.id:
        raise HTTPException(404, "Instruct template not found")
    return _template_to_dict(t)


@router.post("")
def create_instruct_template(
    req: InstructTemplateCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = InstructTemplate(
        user_id=user.id,
        name=req.name,
        system_prompt=req.system_prompt or "",
        input_prefix=req.input_prefix or "",
        input_suffix=req.input_suffix or "",
        output_prefix=req.output_prefix or "",
        output_suffix=req.output_suffix or "",
        first_output_prefix=req.first_output_prefix or "",
        last_output_prefix=req.last_output_prefix or "",
        system_sequence_prefix=req.system_sequence_prefix or "",
        system_sequence_suffix=req.system_sequence_suffix or "",
        stop_sequence=req.stop_sequence or "",
        separator_sequence=req.separator_sequence or "",
        wrap_sequences=bool(req.wrap_sequences),
        is_default=bool(req.is_default),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _template_to_dict(t)


@router.put("/{template_id}")
def update_instruct_template(
    template_id: int,
    req: InstructTemplateUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(InstructTemplate).filter(InstructTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Instruct template not found")
    # User-defined templates can only be edited by their owner.
    if t.user_id is not None and t.user_id != user.id:
        raise HTTPException(404, "Instruct template not found")

    update_data = req.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(t, key, value)
    db.commit()
    db.refresh(t)
    return _template_to_dict(t)


@router.delete("/{template_id}")
def delete_instruct_template(
    template_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(InstructTemplate).filter(InstructTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Instruct template not found")
    # System presets (user_id is NULL) cannot be deleted.
    if t.user_id is None:
        raise HTTPException(400, "System preset instruct templates cannot be deleted")
    if t.user_id != user.id:
        raise HTTPException(404, "Instruct template not found")
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.post("/ensure-builtin")
def ensure_builtin_instruct_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Idempotently insert/refresh system-preset instruct templates.

    Mirrors the seed performed at server startup but can be invoked by
    clients when the schema is upgraded in place.
    """
    from ..core.instruct_template_seeds import BUILTIN_INSTRUCT_TEMPLATES
    created = 0
    updated = 0
    for seed in BUILTIN_INSTRUCT_TEMPLATES:
        existing = (
            db.query(InstructTemplate)
            .filter(
                InstructTemplate.user_id.is_(None),
                InstructTemplate.name == seed["name"],
            )
            .first()
        )
        if existing is None:
            db.add(InstructTemplate(**seed))
            created += 1
        else:
            for key, value in seed.items():
                setattr(existing, key, value)
            updated += 1
    db.commit()
    return {"created": created, "updated": updated}
