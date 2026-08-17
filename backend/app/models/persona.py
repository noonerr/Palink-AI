import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class Persona(Base):
    __tablename__ = "personas"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    avatar = Column(String, nullable=True)
    character_bindings = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False)
    # ST 1.18.0 persona description injection controls.
    # persona_show: whether the description is injected into the prompt.
    # persona_description_position: 0=in story (depth), 1=after post-history,
    # 2=last in chat, 3=inactive.
    persona_show = Column(Boolean, default=False)
    persona_description_position = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
