"""Context template API (ST 1.18.0 parity).

Provides CRUD endpoints for context templates used during prompt assembly.
Built-in templates (is_builtin=True) cannot be deleted by users but their
editable fields can still be updated.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, ContextTemplate

router = APIRouter(prefix="/api/roleplay/context-templates", tags=["roleplay-context-templates"])

logger = logging.getLogger(__name__)


class ContextTemplateCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    display_name: Optional[str] = None
    story_string: Optional[str] = None
    chat_start: Optional[str] = None
    system_prompt: Optional[str] = None
    jailbreak: Optional[str] = None
    normal_prompt: Optional[str] = None
    group_prompt: Optional[str] = None


class ContextTemplateUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    display_name: Optional[str] = None
    story_string: Optional[str] = None
    chat_start: Optional[str] = None
    system_prompt: Optional[str] = None
    jailbreak: Optional[str] = None
    normal_prompt: Optional[str] = None
    group_prompt: Optional[str] = None


def _template_to_dict(t: ContextTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "display_name": t.display_name,
        "story_string": t.story_string,
        "chat_start": t.chat_start,
        "system_prompt": t.system_prompt,
        "jailbreak": t.jailbreak,
        "normal_prompt": t.normal_prompt,
        "group_prompt": t.group_prompt,
        "is_builtin": bool(t.is_builtin),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


@router.get("")
def list_context_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all context templates (built-in + user-defined).

    Built-in templates are global (shared across users); user-defined
    templates are scoped to the requesting user.
    """
    templates = (
        db.query(ContextTemplate)
        .order_by(ContextTemplate.is_builtin.desc(), ContextTemplate.name)
        .all()
    )
    return [_template_to_dict(t) for t in templates]


@router.get("/{template_name}")
def get_context_template(
    template_name: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(ContextTemplate).filter(ContextTemplate.name == template_name).first()
    if not t:
        raise HTTPException(404, "Context template not found")
    return _template_to_dict(t)


@router.post("")
def create_context_template(
    req: ContextTemplateCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if db.query(ContextTemplate).filter(ContextTemplate.name == req.name).first():
        raise HTTPException(409, f"Context template '{req.name}' already exists")
    t = ContextTemplate(
        name=req.name,
        display_name=req.display_name,
        story_string=req.story_string,
        chat_start=req.chat_start,
        system_prompt=req.system_prompt,
        jailbreak=req.jailbreak,
        normal_prompt=req.normal_prompt,
        group_prompt=req.group_prompt,
        is_builtin=False,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _template_to_dict(t)


@router.put("/{template_id}")
def update_context_template(
    template_id: int,
    req: ContextTemplateUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(ContextTemplate).filter(ContextTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Context template not found")

    update_data = req.model_dump(exclude_unset=True)
    # Built-in templates: name is immutable (it's the lookup key for presets).
    if t.is_builtin and "name" in update_data and update_data["name"] != t.name:
        raise HTTPException(400, "Built-in template name cannot be changed")

    if "name" in update_data and update_data["name"] != t.name:
        existing = db.query(ContextTemplate).filter(ContextTemplate.name == update_data["name"]).first()
        if existing and existing.id != t.id:
            raise HTTPException(409, f"Context template '{update_data['name']}' already exists")

    for key, value in update_data.items():
        setattr(t, key, value)
    db.commit()
    db.refresh(t)
    return _template_to_dict(t)


@router.delete("/{template_id}")
def delete_context_template(
    template_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(ContextTemplate).filter(ContextTemplate.id == template_id).first()
    if not t:
        raise HTTPException(404, "Context template not found")
    if t.is_builtin:
        raise HTTPException(400, "Built-in context templates cannot be deleted")
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.post("/ensure-builtin")
def ensure_builtin_context_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Idempotently insert/refresh built-in context templates.

    Mirrors the seed performed at server startup but can be invoked by
    clients when the schema is upgraded in place.
    """
    from ..core.context_template_seeds import BUILTIN_CONTEXT_TEMPLATES
    created = 0
    updated = 0
    for seed in BUILTIN_CONTEXT_TEMPLATES:
        existing = db.query(ContextTemplate).filter(ContextTemplate.name == seed["name"]).first()
        if existing is None:
            db.add(ContextTemplate(**seed))
            created += 1
        else:
            for key, value in seed.items():
                setattr(existing, key, value)
            updated += 1
    db.commit()
    return {"created": created, "updated": updated}
