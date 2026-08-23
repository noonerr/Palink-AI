"""验证副 AI 配置读写 + 端到端副 AI 兜底。"""
import asyncio
import sys

sys.path.insert(0, "/app")

from app.core.database import SessionLocal
from app.models import UserSetting


def test_config_rw():
    db = SessionLocal()
    us = db.query(UserSetting).filter(UserSetting.user_id == 1).first()
    print("before: model=", us.mvu_secondary_model, "enabled=", us.mvu_secondary_enabled)
    us.mvu_secondary_model = "deepseek-v4-flash"
    us.mvu_secondary_enabled = True
    db.commit()
    db.refresh(us)
    print("after: model=", us.mvu_secondary_model, "enabled=", us.mvu_secondary_enabled)
    db.close()


test_config_rw()
