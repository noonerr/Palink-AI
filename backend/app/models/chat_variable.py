import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, UniqueConstraint
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class ChatVariable(Base):
    __tablename__ = "chat_variables"
    __table_args__ = (
        UniqueConstraint("session_id", "key", name="uq_chat_variable"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, nullable=False)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class UserVariable(Base):
    __tablename__ = "user_variables"
    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_user_variable"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class GlobalVariable(Base):
    __tablename__ = "global_variables"
    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_global_variable"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False, default=0)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
