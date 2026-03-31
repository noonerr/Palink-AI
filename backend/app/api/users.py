from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User, UserSetting
from ..schemas import UserSettingUpdate

router = APIRouter(prefix="/api/users/me", tags=["user-settings"])


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
        "show_model_reasoning": setting.show_model_reasoning if setting.show_model_reasoning is not None else True,
        "developer_mode": setting.developer_mode if setting.developer_mode is not None else False,
        "prompt_language": setting.prompt_language or "auto"
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
    if req.developer_mode is not None:
        setting.developer_mode = req.developer_mode
    if req.prompt_language is not None:
        setting.prompt_language = req.prompt_language
    db.commit()
    return {"status": "ok"}
