"""Personas API routes — CRUD for user personas."""
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, UserSetting
from ..models.persona import Persona

router = APIRouter(prefix="/api/personas", tags=["personas"])


def _utc_now():
    return datetime.now(timezone.utc)


class PersonaCreateRequest(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    avatar: Optional[str] = None
    character_bindings: Optional[Dict[str, str]] = None
    is_default: bool = False
    persona_show: bool = False
    persona_description_position: int = 0


class PersonaUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = None
    avatar: Optional[str] = None
    character_bindings: Optional[Dict[str, str]] = None
    is_default: Optional[bool] = None
    persona_show: Optional[bool] = None
    persona_description_position: Optional[int] = None


class ActivePersonaRequest(BaseModel):
    persona_id: Optional[str] = None


def _persona_to_dict(p: Persona) -> dict:
    bindings = {}
    if p.character_bindings:
        try:
            bindings = json.loads(p.character_bindings)
        except (json.JSONDecodeError, TypeError):
            bindings = {}
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description or "",
        "avatar": p.avatar,
        "characterBindings": bindings,
        "isDefault": bool(p.is_default),
        "personaShow": bool(p.persona_show) if p.persona_show is not None else False,
        "personaDescriptionPosition": int(p.persona_description_position) if p.persona_description_position is not None else 0,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("")
def list_personas(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    personas = (
        db.query(Persona)
        .filter(Persona.user_id == user.id)
        .order_by(Persona.created_at.asc())
        .all()
    )
    return [_persona_to_dict(p) for p in personas]


@router.post("")
async def create_persona(
    req: PersonaCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if req.is_default:
        db.query(Persona).filter(
            Persona.user_id == user.id,
            Persona.is_default == True,
        ).update({"is_default": False})

    p = Persona(
        id=req.id,
        user_id=user.id,
        name=req.name,
        description=req.description,
        avatar=req.avatar,
        character_bindings=json.dumps(req.character_bindings or {}, ensure_ascii=False),
        is_default=req.is_default,
        persona_show=req.persona_show,
        persona_description_position=req.persona_description_position,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(p)
    db.commit()
    db.refresh(p)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "persona", persona_id=p.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for persona create", exc_info=True,
        )

    return _persona_to_dict(p)


@router.get("/active")
def get_active_persona(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the currently active persona for the user, if any."""
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    active_id = getattr(setting, "active_persona_id", None) if setting else None
    if not active_id:
        return {"activePersonaId": None, "persona": None}
    p = db.query(Persona).filter(
        Persona.id == active_id,
        Persona.user_id == user.id,
    ).first()
    if not p:
        return {"activePersonaId": active_id, "persona": None}
    return {"activePersonaId": active_id, "persona": _persona_to_dict(p)}


@router.put("/active")
def set_active_persona(
    req: ActivePersonaRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set (or clear) the currently active persona for the user."""
    persona_id = req.persona_id or None
    if persona_id:
        p = db.query(Persona).filter(
            Persona.id == persona_id,
            Persona.user_id == user.id,
        ).first()
        if not p:
            raise HTTPException(404, "Persona not found")
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not setting:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
        db.flush()
    setting.active_persona_id = persona_id
    db.commit()
    return {"activePersonaId": persona_id, "ok": True}


@router.put("/{persona_id}")
async def update_persona(
    persona_id: str,
    req: PersonaUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(Persona).filter(
        Persona.id == persona_id,
        Persona.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Persona not found")

    if req.is_default is True:
        db.query(Persona).filter(
            Persona.user_id == user.id,
            Persona.is_default == True,
        ).update({"is_default": False})

    if req.name is not None:
        p.name = req.name
    if req.description is not None:
        p.description = req.description
    if req.avatar is not None:
        p.avatar = req.avatar
    if req.character_bindings is not None:
        p.character_bindings = json.dumps(req.character_bindings, ensure_ascii=False)
    if req.is_default is not None:
        p.is_default = req.is_default
    if req.persona_show is not None:
        p.persona_show = req.persona_show
    if req.persona_description_position is not None:
        p.persona_description_position = req.persona_description_position
    p.updated_at = _utc_now()
    db.commit()
    db.refresh(p)

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    try:
        from ..services.st_sync_service import trigger_async_sync
        from ..core.database import SessionLocal
        await trigger_async_sync(SessionLocal, user.id, "persona", persona_id=p.id)
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "ST sync trigger failed for persona update", exc_info=True,
        )

    return _persona_to_dict(p)


@router.delete("/{persona_id}")
def delete_persona(
    persona_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.query(Persona).filter(
        Persona.id == persona_id,
        Persona.user_id == user.id,
    ).first()
    if not p:
        raise HTTPException(404, "Persona not found")
    db.delete(p)
    db.commit()
    return {"ok": True}
