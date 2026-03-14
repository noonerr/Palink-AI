from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class SystemSetting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(String)

class UserSetting(Base):
    __tablename__ = "user_settings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True)
    show_model_reasoning = Column(Boolean, default=True)
    memory_mode = Column(String, default="rule")
    memory_model = Column(String, nullable=True)
    prompt_language = Column(String, default="auto")
    user = relationship("User", back_populates="settings")

class ProviderTestResult(Base):
    __tablename__ = "provider_test_results"
    id = Column(Integer, primary_key=True, index=True)
    provider_id = Column(String, nullable=False)
    provider_name = Column(String, nullable=False)
    success = Column(Boolean, nullable=False)
    message = Column(String, nullable=True)
    base_url = Column(String, nullable=True)
    tested_at = Column(DateTime, default=utc_now)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
