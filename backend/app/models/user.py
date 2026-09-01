from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(String, default="user")
    is_active = Column(Boolean, default=True)
    avatar = Column(String, nullable=True)
    storage_used = Column(BigInteger, default=0)
    sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")
    files = relationship("UserFile", back_populates="user", cascade="all, delete-orphan")
    folders = relationship("UserFolder", back_populates="user", cascade="all, delete-orphan")
    settings = relationship("UserSetting", back_populates="user", cascade="all, delete-orphan")
    oauth_accounts = relationship("OAuthAccount", back_populates="user", cascade="all, delete-orphan")


class UserQuota(Base):
    """用户 LLM token 额度（管理员分配，一次性总额度）。

    quota_tokens 为 NULL 表示不限；无行也表示不限（向后兼容：不设置即功能不存在）。
    used_tokens 由主聊天入口在 usage 落库时累加（prompt+completion+reasoning 总和）。
    monthly_reset=True 时按自然月自动清零 used_tokens（懒重置：预检/查询时发现
    period_month 不是当前月即清零并推进）。
    """
    __tablename__ = "user_quotas"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    quota_tokens = Column(BigInteger, nullable=True)  # NULL = 不限
    used_tokens = Column(BigInteger, default=0)
    monthly_reset = Column(Boolean, default=False)
    period_month = Column(String, nullable=True)  # 当前计数月 YYYY-MM（月度重置用）
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
