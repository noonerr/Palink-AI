"""Context template API (ST 1.18.0 parity).

Provides CRUD endpoints for context templates used during prompt assembly.

[预设模板库 2026-10-25] 归属模型（alembic 0072 加 ``user_id`` 可空列）：
  · ``user_id IS NULL`` —— 内置（is_builtin=True）或 2026-10-25 之前 admin 建的
    共享行。全员可见；改/删仍限 admin（非 admin 一律 403，保持 PENTEST-2026-09-02
    收口后的口径）。
  · ``user_id = 某人`` —— 该用户私人模板（导入/自建）。只有本人可见/可改/可删，
    他人访问一律 404（不泄露存在性）。
  · ``name`` 保持**全局唯一**：装配按 name 查模板（roleplay_prompt_assembly.py
    的 ``_load_context_template``），改成 (user_id, name) 唯一会让同名行产生歧义。
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
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
        "user_id": t.user_id,
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


def _visible_templates(db: Session, user: User):
    """内置 + 历史共享行（user_id NULL）+ 本人私人行。"""
    return db.query(ContextTemplate).filter(
        or_(
            ContextTemplate.is_builtin.is_(True),
            ContextTemplate.user_id.is_(None),
            ContextTemplate.user_id == user.id,
        )
    )


def _is_admin(user: User) -> bool:
    return getattr(user, "role", "") == "admin"


@router.get("")
def list_context_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List visible context templates (built-in/shared + current user's own).

    Built-in and legacy shared templates are global; user-defined templates are
    scoped to the requesting user.
    """
    templates = (
        _visible_templates(db, user)
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
    t = (
        _visible_templates(db, user)
        .filter(ContextTemplate.name == template_name)
        .first()
    )
    if not t:
        raise HTTPException(404, "Context template not found")
    return _template_to_dict(t)


@router.post("")
def create_context_template(
    req: ContextTemplateCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # [PENTEST-2026-09-02] 模板曾无属主字段（全局共享资源），任何登录用户都能
    # 改删他人模板（D2/D3 实锤跨账号 200）。现在改为**按属主隔离**：
    #   · 普通用户：只能建自己的（user_id=本人），改删也只限自己那几行；
    #   · admin：沿用旧语义建共享行（user_id=NULL），便于维护全局模板。
    # 跨账号改删仍然被堵死（见 update/delete 的归属校验）。
    if db.query(ContextTemplate).filter(ContextTemplate.name == req.name).first():
        raise HTTPException(409, f"Context template '{req.name}' already exists")
    t = ContextTemplate(
        user_id=None if _is_admin(user) else user.id,
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
    # 归属：私人行只认本人；内置/共享行（user_id NULL）仍限 admin。
    if t.user_id is None:
        if not _is_admin(user):
            raise HTTPException(403, "Not enough permissions")
    elif t.user_id != user.id:
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
    if t.user_id is None:
        if not _is_admin(user):
            raise HTTPException(403, "Not enough permissions")
    elif t.user_id != user.id:
        raise HTTPException(404, "Context template not found")
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
