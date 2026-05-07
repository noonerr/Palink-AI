from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, Float, DateTime, ForeignKey, Text
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
    developer_mode = Column(Boolean, default=False)
    memory_mode = Column(String, default="rule")
    memory_model = Column(String, nullable=True)
    prompt_language = Column(String, default="auto")
    character_display_mode = Column(String, default="framed")
    author_note = Column(Text, nullable=True)
    author_note_position = Column(String, default="after_char")
    author_note_frequency = Column(Integer, default=0)
    user = relationship("User", back_populates="settings")

class GenerationPreset(Base):
    __tablename__ = "generation_presets"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String, nullable=False)
    is_default = Column(Boolean, default=False)
    activation_regex = Column(String, nullable=True)
    temperature = Column(Float, default=0.7)
    top_p = Column(Float, default=0.95)
    max_tokens = Column(Integer, default=1024)
    frequency_penalty = Column(Float, default=0.0)
    presence_penalty = Column(Float, default=0.0)
    min_p = Column(Float, default=0.05)
    top_k = Column(Integer, default=40)
    repetition_penalty = Column(Float, default=1.1)
    system_prompt_override = Column(Text, nullable=True)
    post_history_instructions = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

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
