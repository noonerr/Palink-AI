import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text, Index
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class Character(Base):
    __tablename__ = "characters"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    background = Column(Text, nullable=True)
    personality = Column(Text, nullable=True)
    avatar = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    user = relationship("User")
    sessions = relationship("CharacterChatSession", back_populates="character", cascade="all, delete-orphan")
    world_books = relationship("WorldBook", back_populates="character", cascade="all, delete-orphan")
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
    preset_data = Column(Text, nullable=True)
    alternate_greetings = Column(Text, nullable=True)
    creator_notes = Column(Text, nullable=True)
    post_history_instructions = Column(Text, nullable=True)
    # ST 1.18.0 角色卡 jailbreak 字段（V3: data.extensions.jailbreak 或 data.jailbreak）。
    # 与 post_history_instructions 分离存储。ST 1.18.0 默认使用 post_history_instructions
    # 作为 jailbreak override（script.js:3361），但 V3 spec 允许独立 jailbreak 字段。
    jailbreak = Column(Text, nullable=True)
    ui_config = Column(Text, nullable=True)
    raw_card_spec_version = Column(String, nullable=True)
    # ST V3 角色卡多模态资源（图片/音频等），存储为 JSON 字符串
    assets = Column(Text, nullable=True)
    # ST 1.18.0 V3 chara card fields
    # talkativeness: ST 1.18.0 uses string for this; controls group chat speaker weight
    talkativeness = Column(String, nullable=True, default="0.5")
    # nickname: character display nickname (V3 chara card field)
    nickname = Column(String, nullable=True)
    # group_only_greetings: JSON array of greetings used only in group chats (V3)
    group_only_greetings = Column(Text, nullable=True)

class CharacterChatSession(Base):
    __tablename__ = "character_chat_sessions"
    __table_args__ = (
        Index('idx_ccs_character_user', 'character_id', 'user_id'),
        Index('idx_ccs_user_id', 'user_id'),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    character_id = Column(String, ForeignKey("characters.id"))
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, nullable=True)
    dialogue_mode = Column(String, default="first_person")
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now)
    # ST 1.18.0 chat_metadata persistence (note_prompt/variables/hidden_bots/etc.)
    chat_metadata = Column(Text, default="{}")
    # ST 1.18.0 background image filename/path for this session
    background = Column(String, nullable=True)
    character = relationship("Character", back_populates="sessions")
    messages = relationship("CharacterChatMessage", back_populates="session", cascade="all, delete-orphan")

class CharacterChatSessionBranch(Base):
    __tablename__ = "character_chat_session_branches"
    __table_args__ = (
        # Composite index for finding child branches from a specific node
        Index('idx_branch_parent_lookup', 'session_id', 'parent_branch_id', 'parent_message_id'),
        # Index for finding active branch in a session
        Index('idx_branch_session_active', 'session_id', 'is_active'),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id"))
    parent_branch_id = Column(String, ForeignKey("character_chat_session_branches.id"), nullable=True)
    parent_message_id = Column(Integer, nullable=True)
    branch_name = Column(String, default="分支 1")
    is_active = Column(Boolean, default=False)
    is_frozen = Column(Boolean, default=False)
    is_favorited = Column(Boolean, default=False)
    last_message_at = Column(DateTime, default=utc_now)
    created_at = Column(DateTime, default=utc_now)
    session = relationship("CharacterChatSession")
    parent_branch = relationship("CharacterChatSessionBranch", remote_side=[id])

class CharacterChatMessage(Base):
    __tablename__ = "character_chat_messages"
    __table_args__ = (
        # Composite index for branch message queries
        Index('idx_message_branch_lookup', 'session_id', 'branch_id', 'created_at'),
        # Index for finding assistant messages after a user message
        Index('idx_message_role_lookup', 'session_id', 'branch_id', 'role', 'id'),
        # Standalone index for branch_id (used in check_frozen_branches, etc.)
        Index('idx_message_branch_only', 'branch_id'),
    )
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("character_chat_sessions.id"))
    branch_id = Column(String, ForeignKey("character_chat_session_branches.id"), nullable=True)
    role = Column(String)
    content = Column(Text)
    short_title = Column(String, nullable=True)
    model = Column(String, nullable=True)
    tokens = Column(Integer, default=0)
    prompt_tokens = Column(Integer, default=0)
    reasoning_tokens = Column(Integer, default=0)
    name = Column(String, nullable=True)
    is_user = Column(Boolean, nullable=True)
    is_system = Column(Boolean, default=False, nullable=False)
    mesid = Column(Integer, nullable=True)
    swipe_id = Column(Integer, default=0)
    swipes = Column(Text, nullable=True)
    extra = Column(Text, nullable=True)
    is_hidden = Column(Boolean, default=False, nullable=False)
    is_locked = Column(Boolean, default=False, nullable=False)
    # ST V3 多模态消息内容：JSON 字符串数组（OpenAI multimodal content schema）。
    # 当存在时，包含 text / image_url / input_audio 等内容片段；NULL 时
    # 回退到 legacy 单字符串 content 列。
    content_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    session = relationship("CharacterChatSession", back_populates="messages")
    branch = relationship("CharacterChatSessionBranch")
