import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class Background(Base):
    """用户上传的聊天背景图。

    文件保存在 data/backgrounds/ 目录下，DB 仅记录元数据。
    CharacterChatSession.background 引用此处的 filename 或 path。
    """
    __tablename__ = "backgrounds"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    filename = Column(String, nullable=False)
    original_filename = Column(String, nullable=True)
    path = Column(String, nullable=False)
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
