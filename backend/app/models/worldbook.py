import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class WorldBook(Base):
    __tablename__ = "world_books"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    source_type = Column(String, default="online_edit")  # "upload" / "online_edit"
    raw_content = Column(Text, nullable=True)
    format = Column(String, default="custom")  # "silly_tavern_v2" / "custom"
    tags = Column(Text, nullable=True)  # JSON array stored as string
    is_parsed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    user = relationship("User")
    entries = relationship("WorldBookStage", back_populates="world_book", cascade="all, delete-orphan",
                           order_by="WorldBookStage.stage_index")


class WorldBookStage(Base):
    __tablename__ = "world_book_stages"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    world_book_id = Column(String, ForeignKey("world_books.id", ondelete="CASCADE"))
    stage_index = Column(Integer, nullable=False, default=0)
    title = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    summary = Column(Text, nullable=True)
    transition_hint = Column(Text, nullable=True)
    priority = Column(Integer, default=5)  # 1-10, higher = more critical
    token_count = Column(Integer, default=0)
    image_prompt = Column(Text, nullable=True)  # Reserved for future text-to-image
    # Keyword-trigger fields (Phase 6A)
    keys = Column(Text, nullable=True)           # JSON array string
    secondary_keys = Column(Text, nullable=True) # JSON array string
    scan_depth = Column(Integer, default=4)
    position = Column(Integer, default=4)
    selective = Column(Boolean, default=False)
    probability = Column(Integer, default=100)
    constant = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)

    world_book = relationship("WorldBook", back_populates="entries")


class SessionWorldBook(Base):
    __tablename__ = "session_world_books"
    __table_args__ = (
        UniqueConstraint("session_id", name="uq_session_worldbook"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id", ondelete="CASCADE"))
    world_book_id = Column(String, ForeignKey("world_books.id", ondelete="CASCADE"))
    current_stage_index = Column(Integer, nullable=True)
    stage_transition_mode = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    session = relationship("CharacterChatSession")
    world_book = relationship("WorldBook")
