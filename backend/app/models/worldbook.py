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
    character_id = Column(String, ForeignKey("characters.id", ondelete="CASCADE"), nullable=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    source_type = Column(String, default="online_edit")  # "upload" / "online_edit"
    raw_content = Column(Text, nullable=True)
    format = Column(String, default="custom")  # "silly_tavern_v2" / "custom"
    tags = Column(Text, nullable=True)  # JSON array stored as string
    is_parsed = Column(Boolean, default=False)
    type = Column(String, default="world_book")  # "character_book" / "world_book"
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    # ST-compatible budget fields (migration 0040)
    budget_tokens = Column(String, nullable=True)  # "10%" percentage of maxContext, or "1000" fixed tokens
    budget_cap = Column(Integer, default=0, nullable=True)  # hard upper limit on budget (0 = no cap)

    user = relationship("User")
    character = relationship("Character", back_populates="world_books")
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
    # ST 1.18.0 entry.useProbability — False 时无视 probability 必现，
    # True 时按 probability% 滚动（migration 0061）
    use_probability = Column(Boolean, default=True, nullable=False)
    constant = Column(Boolean, default=False)
    group = Column(String, nullable=True)
    extensions_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)

    # ST-compatible fields (Phase 2)
    enabled = Column(Boolean, default=True)
    case_sensitive = Column(Boolean, default=False)
    match_whole_words = Column(Boolean, default=False)
    selective_logic = Column(Integer, default=0)  # 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL
    sticky = Column(Integer, default=0)
    cooldown = Column(Integer, default=0)
    delay = Column(Integer, default=0)
    depth = Column(Integer, default=4)  # injection depth
    order = Column(Integer, default=0)  # sorting order
    exclude_recursion = Column(Boolean, default=False)
    prevent_recursion = Column(Boolean, default=False)
    match_persona_description = Column(Boolean, default=False)
    match_character_description = Column(Boolean, default=False)
    match_character_personality = Column(Boolean, default=False)
    match_character_depth_prompt = Column(Boolean, default=False)
    match_scenario = Column(Boolean, default=False)
    match_creator_notes = Column(Boolean, default=False)
    vectorized = Column(Boolean, default=False)
    group_override = Column(Boolean, default=False)
    group_weight = Column(Integer, default=0)
    add_memo = Column(Boolean, default=False)
    decorators = Column(Text, nullable=True)  # JSON array string
    character_filter = Column(Text, nullable=True)  # JSON array：角色 names/tags
    # ST-compatible advanced fields (migration 0040)
    min_activations = Column(Integer, default=0)  # group min activations (0 = disabled)
    delay_until_recursion = Column(Integer, default=0)  # delay until recursion depth N (0 = disabled)
    triggers = Column(Text, nullable=True)  # JSON array of trigger types (empty = all)
    outlet_name = Column(String, nullable=True)  # named outlet for position=7
    # ST 1.18.0 ignoreBudget (extensions.ignore_budget) — when True, the entry
    # is exempt from token budget truncation. Reference: world-info.js:4898-4907.
    # Migration: 0052_add_worldbook_ignore_budget
    ignore_budget = Column(Boolean, default=False, nullable=False)
    # ST 1.18.0 entry fields lacking dedicated columns (migration 0053).
    # Reference: world-info.js newWorldInfoEntryDefinition:4037/4035/4036 and
    # convertCharacterBook:5535-5537 (extensions.role / use_group_scoring / automation_id).
    # role: @Depth injection role — 0=system, 1=user, 2=assistant (default 0/SYSTEM).
    role = Column(Integer, default=0)
    # use_group_scoring: null = inherit global setting; True/False = per-entry override.
    use_group_scoring = Column(Boolean, nullable=True, default=None)
    # automation_id: STscript automation id bound to the entry (default '' in ST).
    automation_id = Column(String, nullable=True)

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


class SessionWorldBookEntryState(Base):
    __tablename__ = "session_worldbook_entry_states"
    __table_args__ = (
        UniqueConstraint("session_id", "entry_id", name="uq_session_entry_state"),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id", ondelete="CASCADE"), nullable=False)
    entry_id = Column(String, ForeignKey("world_book_stages.id", ondelete="CASCADE"), nullable=False)
    sticky_remaining = Column(Integer, default=0)
    cooldown_remaining = Column(Integer, default=0)
    delay_remaining = Column(Integer, default=0)
    last_activated_message_index = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class WorldBookBlueprint(Base):
    """ST 1.18.0 世界书蓝图（blueprints）—— 批量定义一组关联条目和触发逻辑。

    应用蓝图时基于 entries_json 批量创建 WorldBookStage，并应用 trigger_logic。
    """
    __tablename__ = "world_book_blueprints"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, unique=True, nullable=False)
    description = Column(Text, nullable=True)
    # JSON 数组字符串：包含的条目定义（comment/content/key/position 等）
    entries_json = Column(Text, nullable=True)
    # JSON 对象字符串：触发逻辑（如 auto_activate / recursion_depth）
    trigger_logic = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
