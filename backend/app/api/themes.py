"""Theme API — 主题持久化与激活。

提供主题 CRUD 与激活端点。系统预置主题 (user_id is NULL) 全局共享，不可被
普通用户删除；用户自定义主题仅对所属用户可见。激活一个主题会自动取消同一
用户范围内其它主题的激活状态。
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, Theme

router = APIRouter(prefix="/api/themes", tags=["themes"])

logger = logging.getLogger(__name__)


class ThemeCreateRequest(BaseModel):
    name: str = Field(..., max_length=200)
    config: Optional[dict] = Field(default_factory=dict)
    is_active: Optional[bool] = False


class ThemeUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    config: Optional[dict] = None
    is_active: Optional[bool] = None


def _parse_config(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _theme_to_dict(t: Theme) -> dict:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "name": t.name,
        "config": _parse_config(t.config_json),
        "is_active": bool(t.is_active),
        "is_system": t.user_id is None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


@router.get("")
def list_themes(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出所有可见主题（系统预置 + 当前用户自定义）。"""
    themes = (
        db.query(Theme)
        .filter(
            (Theme.user_id.is_(None))
            | (Theme.user_id == user.id)
        )
        .order_by(Theme.user_id.asc(), Theme.id)
        .all()
    )
    return [_theme_to_dict(t) for t in themes]


@router.post("")
def create_theme(
    req: ThemeCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = Theme(
        user_id=user.id,
        name=req.name,
        config_json=json.dumps(req.config or {}, ensure_ascii=False),
        is_active=bool(req.is_active),
    )
    if t.is_active:
        _deactivate_user_themes(db, user.id)
    db.add(t)
    db.commit()
    db.refresh(t)
    return _theme_to_dict(t)


@router.put("/{theme_id}")
def update_theme(
    theme_id: int,
    req: ThemeUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(Theme).filter(Theme.id == theme_id).first()
    if not t:
        raise HTTPException(404, "Theme not found")
    # 用户自定义主题仅 owner 可编辑；系统预置主题允许任意已登录用户更新配置
    if t.user_id is not None and t.user_id != user.id:
        raise HTTPException(404, "Theme not found")

    update_data = req.model_dump(exclude_unset=True)
    if "name" in update_data and update_data["name"] is not None:
        t.name = update_data["name"]
    if "config" in update_data and update_data["config"] is not None:
        t.config_json = json.dumps(update_data["config"], ensure_ascii=False)
    if "is_active" in update_data and update_data["is_active"] is not None:
        if update_data["is_active"]:
            _deactivate_user_themes(db, user.id)
            t.is_active = True
        else:
            t.is_active = False
    db.commit()
    db.refresh(t)
    return _theme_to_dict(t)


@router.delete("/{theme_id}")
def delete_theme(
    theme_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.query(Theme).filter(Theme.id == theme_id).first()
    if not t:
        raise HTTPException(404, "Theme not found")
    if t.user_id is None:
        raise HTTPException(400, "System preset themes cannot be deleted")
    if t.user_id != user.id:
        raise HTTPException(404, "Theme not found")
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.post("/{theme_id}/activate")
def activate_theme(
    theme_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """激活指定主题，自动取消同范围内其它主题的激活状态。"""
    t = db.query(Theme).filter(Theme.id == theme_id).first()
    if not t:
        raise HTTPException(404, "Theme not found")
    if t.user_id is not None and t.user_id != user.id:
        raise HTTPException(404, "Theme not found")

    _deactivate_user_themes(db, user.id)
    t.is_active = True
    db.commit()
    db.refresh(t)
    return _theme_to_dict(t)


def _deactivate_user_themes(db: Session, user_id: int) -> None:
    """取消当前用户范围内主题的激活状态。

    仅清除该用户自定义主题及系统预置主题的 is_active，不影响其它用户，
    保证每个用户同一时刻只有一个激活主题。
    """
    db.query(Theme).filter(
        Theme.is_active.is_(True),
        (Theme.user_id == user_id) | (Theme.user_id.is_(None)),
    ).update({Theme.is_active: False}, synchronize_session=False)
