from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, UserSetting

router = APIRouter(prefix="/api/users/me", tags=["user-settings"])


class UserSettingUpdate(BaseModel):
    memory_mode: Optional[str] = None
    memory_model: Optional[str] = None
    show_model_reasoning: Optional[bool] = None


def _get_or_create_settings(user: User, db: Session) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not setting:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
        db.commit()
        db.refresh(setting)
    return setting


@router.get("/settings")
async def get_user_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = _get_or_create_settings(user, db)
    return {
        "memory_mode": setting.memory_mode or "rule",
        "memory_model": setting.memory_model,
        "show_model_reasoning": setting.show_model_reasoning if setting.show_model_reasoning is not None else True
    }


@router.put("/settings")
async def update_user_settings(req: UserSettingUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = _get_or_create_settings(user, db)
    if req.memory_mode is not None:
        setting.memory_mode = req.memory_mode
    if req.memory_model is not None:
        setting.memory_model = req.memory_model
    if req.show_model_reasoning is not None:
        setting.show_model_reasoning = req.show_model_reasoning
    db.commit()
    return {"status": "ok"}
