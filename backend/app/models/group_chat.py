"""群组聊天数据模型 - 支持 SillyTavern 群组聊天功能"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, Index
from sqlalchemy.orm import relationship
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class GroupChat(Base):
    __tablename__ = "group_chats"
    __table_args__ = (
        Index('idx_group_chat_user', 'user_id'),
        Index('idx_group_chat_user_updated', 'user_id', 'updated_at'),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    avatar = Column(String, nullable=True)
    member_ids = Column(Text, nullable=False, default="[]")
    allow_self_responses = Column(Boolean, default=False)
    activation_strategy = Column(Integer, default=0)
    generation_mode = Column(Integer, default=0)
    disabled_members = Column(Text, default="[]")
    chat_metadata = Column(Text, default="{}")
    # 群组成员 profile（区分各 bot 在群聊中的身份/个性），存储为 JSON 字符串
    # 格式: {"character_id": {"description": "...", "personality": "..."}}
    member_profiles = Column(Text, nullable=True)
    # 群组级 author_note（覆盖 UserSetting.author_note）
    author_note = Column(Text, nullable=True)
    # 群聊上下文最近消息预算：仅保留最近 N 条消息用于提示词构建，
    # None/0 时回退到全局 CHARACTER_CHAT_HISTORY_LIMIT。仅对群聊生效。
    recent_messages_budget = Column(Integer, default=20)
    # ST 1.18.0 群聊高级成员管理：
    # active_members: JSON array of currently active member character IDs
    # follower_members: JSON array of follower member character IDs
    active_members = Column(Text, nullable=True)
    follower_members = Column(Text, nullable=True)
    # Phase D 修复 (F6): ST 1.18.0 群聊合并卡顶层字段。
    # 原仅存于 chat_metadata.meta，现提升为顶层列以便 API 直接读写。
    # _build_group_combined_card 优先读顶层，回退 chat_metadata.meta（向后兼容）。
    # generation_mode_join_prefix/suffix: 合并卡字段拼接时每项的前/后缀包裹
    #   （ST group-chats.js:497-571 customTransform/replaceAndPrepareForJoin）。
    # auto_mode_delay: 自动模式发言间隔毫秒数（ST group auto mode delay）。
    generation_mode_join_prefix = Column(Text, nullable=True)
    generation_mode_join_suffix = Column(Text, nullable=True)
    auto_mode_delay = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    user = relationship("User")


class GroupChatSession(Base):
    __tablename__ = "group_chat_sessions"
    __table_args__ = (
        Index('idx_group_session_group', 'group_id'),
    )
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    group_id = Column(String, ForeignKey("group_chats.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    title = Column(String, nullable=True)
    messages = Column(Text, nullable=True)
    avatars = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    group = relationship("GroupChat")
    user = relationship("User")
