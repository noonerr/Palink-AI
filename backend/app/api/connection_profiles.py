"""Connection Profiles API —— 用户级 API 连接配置的加密存储 CRUD。

响应中绝不返回 api_key（即使是加密的），仅返回 has_api_key 布尔值。
"""
import json
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, ConnectionProfile
from ..services.crypto_service import encrypt_api_key

router = APIRouter(prefix="/api/connection-profiles", tags=["connection-profiles"])


def _utc_now():
    return datetime.now(timezone.utc)


class ConnectionProfileCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    provider: str = Field(..., max_length=100)
    api_key: Optional[str] = None  # 明文传入，服务端加密存储
    base_url: Optional[str] = None
    model_mapping: Optional[Dict[str, str]] = None
    is_active: bool = False


class ConnectionProfileUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    provider: Optional[str] = Field(default=None, max_length=100)
    api_key: Optional[str] = None  # None=不修改；空串=清除；非空=更新
    base_url: Optional[str] = None
    model_mapping: Optional[Dict[str, str]] = None
    is_active: Optional[bool] = None


def _profile_to_dict(p: ConnectionProfile) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "provider": p.provider,
        "has_api_key": bool(p.api_key_encrypted),
        "base_url": p.base_url,
        "model_mapping": _parse_mapping(p.model_mapping),
        "isActive": bool(p.is_active),
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }


def _parse_mapping(raw: Optional[str]) -> Dict[str, str]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _serialize_mapping(mapping: Optional[Dict[str, str]]) -> str:
    return json.dumps(mapping or {}, ensure_ascii=False)


def _deactivate_others(db: Session, user_id: int, keep_id: Optional[int] = None) -> None:
    query = db.query(ConnectionProfile).filter(
        ConnectionProfile.user_id == user_id,
        ConnectionProfile.is_active == True,  # noqa: E712
    )
    if keep_id is not None:
        query = query.filter(ConnectionProfile.id != keep_id)
    query.update({"is_active": False})


@router.get("")
def list_connection_profiles(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    profiles = (
        db.query(ConnectionProfile)
        .filter(ConnectionProfile.user_id == user.id)
        .order_by(ConnectionProfile.created_at.asc())
        .all()
    )
    return [_profile_to_dict(p) for p in profiles]


@router.post("")
def create_connection_profile(
    req: ConnectionProfileCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if req.is_active:
        _deactivate_others(db, user.id)

    profile = ConnectionProfile(
        user_id=user.id,
        name=req.name,
        provider=req.provider,
        api_key_encrypted=encrypt_api_key(req.api_key) if req.api_key else None,
        base_url=req.base_url,
        model_mapping=_serialize_mapping(req.model_mapping),
        is_active=req.is_active,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return _profile_to_dict(profile)


@router.put("/{profile_id}")
def update_connection_profile(
    profile_id: int,
    req: ConnectionProfileUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    profile = db.query(ConnectionProfile).filter(
        ConnectionProfile.id == profile_id,
        ConnectionProfile.user_id == user.id,
    ).first()
    if not profile:
        raise HTTPException(404, "Connection profile not found")

    if req.is_active is True:
        _deactivate_others(db, user.id, keep_id=profile.id)

    if req.name is not None:
        profile.name = req.name
    if req.provider is not None:
        profile.provider = req.provider
    if req.base_url is not None:
        profile.base_url = req.base_url
    if req.model_mapping is not None:
        profile.model_mapping = _serialize_mapping(req.model_mapping)
    if req.is_active is not None:
        profile.is_active = req.is_active
    # api_key: None=不修改；空串=清除；非空=加密更新
    if req.api_key is not None:
        profile.api_key_encrypted = encrypt_api_key(req.api_key) if req.api_key else None

    profile.updated_at = _utc_now()
    db.commit()
    db.refresh(profile)
    return _profile_to_dict(profile)


@router.delete("/{profile_id}")
def delete_connection_profile(
    profile_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    profile = db.query(ConnectionProfile).filter(
        ConnectionProfile.id == profile_id,
        ConnectionProfile.user_id == user.id,
    ).first()
    if not profile:
        raise HTTPException(404, "Connection profile not found")
    db.delete(profile)
    db.commit()
    return {"ok": True}


@router.post("/{profile_id}/activate")
def activate_connection_profile(
    profile_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    profile = db.query(ConnectionProfile).filter(
        ConnectionProfile.id == profile_id,
        ConnectionProfile.user_id == user.id,
    ).first()
    if not profile:
        raise HTTPException(404, "Connection profile not found")

    _deactivate_others(db, user.id, keep_id=profile.id)
    profile.is_active = True
    profile.updated_at = _utc_now()
    db.commit()
    db.refresh(profile)
    return _profile_to_dict(profile)
