from sqlalchemy import create_engine, Column, Integer, String, Boolean, Text, ForeignKey, Float, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
import os
import datetime
import uuid

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://ai_user:ai_password@db:5432/ai_hub")

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(String, default="user")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")
    settings = relationship("UserSetting", back_populates="user", cascade="all, delete-orphan", uselist=False)

class UserSetting(Base):
    __tablename__ = "user_settings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True)
    memory_mode = Column(String, default="rule")  # 'disabled', 'rule', 'ai'
    memory_model = Column(String, default="")  # AI model for memory summarization
    show_model_reasoning = Column(Boolean, default=False)  # 是否显示模型深度思考
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    user = relationship("User", back_populates="settings")

class SystemSetting(Base):
    __tablename__ = "system_settings"
    key = Column(String, primary_key=True, index=True)
    value = Column(String)

class ChatSession(Base):
    __tablename__ = "chat_sessions"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
    user = relationship("User", back_populates="sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")

class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"))
    role = Column(String)
    content = Column(Text)
    model = Column(String, nullable=True)
    tokens = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    session = relationship("ChatSession", back_populates="messages")

class SessionSummary(Base):
    __tablename__ = "session_summaries"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"), unique=True)
    summary = Column(Text)
    tokens_compressed = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Character(Base):
    __tablename__ = "characters"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String)
    description = Column(Text, nullable=True)
    background = Column(Text, nullable=True)
    personality = Column(Text, nullable=True)
    avatar = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
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


# ========================================
# 多角色对话预留模型 - Multi-Character Chat Extension Models
# ========================================

class MultiCharacterSession(Base):
    """多角色对话会话 - 预留"""
    __tablename__ = "multi_character_sessions"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, nullable=True)
    scenario = Column(Text, nullable=True)
    world_description = Column(Text, nullable=True)
    interaction_rules = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)


class MultiCharacterParticipant(Base):
    """多角色对话参与者 - 预留"""
    __tablename__ = "multi_character_participants"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("multi_character_sessions.id"))
    character_id = Column(String, ForeignKey("characters.id"))
    participant_role = Column(String, default="participant")  # 'participant', 'narrator', 'gm', etc.
    is_active = Column(Boolean, default=True)
    joined_at = Column(DateTime, default=datetime.utcnow)
    state_data = Column(Text, nullable=True)  # JSON存储角色状态数据


class MultiCharacterMessage(Base):
    """多角色对话消息 - 预留"""
    __tablename__ = "multi_character_messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("multi_character_sessions.id"))
    participant_id = Column(String, ForeignKey("multi_character_participants.id"), nullable=True)
    character_id = Column(String, ForeignKey("characters.id"), nullable=True)
    role = Column(String)  # 'user', 'assistant', 'system', 'narrator'
    content = Column(Text)
    model = Column(String, nullable=True)
    tokens = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class CharacterInteractionRule(Base):
    """角色间交互规则定义 - 预留"""
    __tablename__ = "character_interaction_rules"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    rule_name = Column(String)
    rule_description = Column(Text, nullable=True)
    rule_config = Column(Text, nullable=True)  # JSON存储规则配置
    is_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()