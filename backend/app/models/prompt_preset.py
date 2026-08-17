import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class PromptPreset(Base):
    __tablename__ = "prompt_presets"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    entries = Column(Text, nullable=True)
    config = Column(Text, nullable=True)
    # ST 1.18.0 prompt_order system:
    # prompt_order: JSON array defining the order of prompt components
    # prompt_active: JSON array of active prompt identifiers
    # prompt_disabled: JSON array of disabled prompt identifiers
    # chat_completion_source: which chat completion source to use
    prompt_order = Column(Text, nullable=True)
    prompt_active = Column(Text, nullable=True)
    prompt_disabled = Column(Text, nullable=True)
    chat_completion_source = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
