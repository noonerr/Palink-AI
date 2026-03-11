import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class Character(Base):
    __tablename__ = "characters"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    background = Column(Text, nullable=True)
    personality = Column(Text, nullable=True)
    avatar = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    user = relationship("User")
    sessions = relationship("CharacterChatSession", back_populates="character", cascade="all, delete-orphan")
    scenario = Column(Text, nullable=True)
    first_mes = Column(Text, nullable=True)
    mes_example = Column(Text, nullable=True)
    system_prompt = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)
    creator = Column(String, nullable=True)
    character_version = Column(String, nullable=True)
    extensions = Column(Text, nullable=True)
    user_nickname = Column(String, nullable=True)
    is_processing = Column(Boolean, default=False)
    processing_status = Column(String, nullable=True)

class CharacterChatSession(Base):
    __tablename__ = "character_chat_sessions"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    character_id = Column(String, ForeignKey("characters.id"))
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, nullable=True)
    dialogue_mode = Column(String, default="first_person")
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now)
    character = relationship("Character", back_populates="sessions")
    messages = relationship("CharacterChatMessage", back_populates="session", cascade="all, delete-orphan")

class CharacterChatSessionBranch(Base):
    __tablename__ = "character_chat_session_branches"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id"))
    parent_branch_id = Column(String, ForeignKey("character_chat_session_branches.id"), nullable=True)
    parent_message_id = Column(Integer, nullable=True)
    branch_name = Column(String, default="Main")
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
    session = relationship("CharacterChatSession")
    parent_branch = relationship("CharacterChatSessionBranch", remote_side=[id])

class CharacterChatMessage(Base):
    __tablename__ = "character_chat_messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("character_chat_sessions.id"))
    branch_id = Column(String, ForeignKey("character_chat_session_branches.id"), nullable=True)
    role = Column(String)
    content = Column(Text)
    model = Column(String, nullable=True)
    tokens = Column(Integer, default=0)
    prompt_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)
    session = relationship("CharacterChatSession", back_populates="messages")
    branch = relationship("CharacterChatSessionBranch")
