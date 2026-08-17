import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class TTSVoiceBinding(Base):
    __tablename__ = "tts_voice_bindings"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    scope = Column(String, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    character_id = Column(String, ForeignKey("characters.id"), nullable=True, index=True)
    role = Column(String, nullable=False, default="character", index=True)
    provider_id = Column(String, nullable=True)
    voice_id = Column(String, nullable=True)
    gender = Column(String, nullable=True)
    clone_sample_id = Column(String, ForeignKey("tts_clone_samples.id"), nullable=True)
    speed = Column(Float, default=1.0)
    volume = Column(Float, default=1.0)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    user = relationship("User")
    character = relationship("Character")
    clone_sample = relationship("TTSCloneSample")


class TTSCloneSample(Base):
    __tablename__ = "tts_clone_samples"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    provider_id = Column(String, nullable=False, default="xiaomi_mimo")
    source_voice_id = Column(String, nullable=True)
    filename = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    file_size = Column(Integer, nullable=False, default=0)
    mime_type = Column(String, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    user = relationship("User")
