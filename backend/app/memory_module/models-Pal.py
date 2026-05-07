"""
记忆模块数据模型
"""

from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, JSON, Index, text
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from app.models.base import Base


# ========== SQLAlchemy ORM 模型 ==========

class ConversationMemoryORM(Base):
    """对话记忆表 - 用于向量检索"""
    __tablename__ = "conversation_memories"
    
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    branch_id = Column(String, nullable=True, index=True)
    
    # 内容
    role = Column(String)  # 'user' | 'assistant' | 'system'
    content = Column(Text)
    content_summary = Column(Text, nullable=True)  # 摘要版本
    
    # 向量嵌入 - 存储为 JSON 字符串（跨数据库兼容）
    embedding = Column(Text, nullable=True)
    
    # 元数据
    importance_score = Column(Float, default=0.5)
    topics = Column(JSON, default=list)  # 提取的话题标签
    tokens_count = Column(Integer, default=0)  # token 数量估算
    
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    
    # 向量索引（在迁移时创建）
    # __table_args__ = (
    #     Index('idx_memory_embedding', 'embedding', postgresql_using='ivfflat'),
    # )


class UserProfileORM(Base):
    """用户画像表 - 长期记忆"""
    __tablename__ = "user_profiles"
    
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, index=True)
    
    # 结构化画像
    preferences = Column(JSON, default=dict)      # 偏好设置
    goals = Column(JSON, default=list)            # 长期目标
    common_topics = Column(JSON, default=list)    # 常讨论话题
    communication_style = Column(String, nullable=True)  # 沟通风格
    
    # 统计信息
    total_conversations = Column(Integer, default=0)
    total_messages = Column(Integer, default=0)
    
    # 自动生成的摘要
    summary = Column(Text, nullable=True)
    
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))


# ========== Pydantic 模型（API用） ==========

class MemoryEntry(BaseModel):
    """单条记忆条目"""
    id: Optional[int] = None
    user_id: int
    session_id: str
    branch_id: Optional[str] = None
    role: str
    content: str
    importance_score: float = 0.5
    topics: List[str] = []
    tokens_count: int = 0
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class UserProfile(BaseModel):
    """用户画像"""
    user_id: int
    preferences: Dict[str, Any] = {}
    goals: List[str] = []
    common_topics: List[str] = []
    communication_style: Optional[str] = None
    summary: Optional[str] = None
    total_conversations: int = 0
    total_messages: int = 0
    
    class Config:
        from_attributes = True


class ContextRequest(BaseModel):
    """上下文请求"""
    user_id: int
    query: str
    session_id: Optional[str] = None
    branch_ids: Optional[List[str]] = None
    max_tokens: int = 2000
    include_profile: bool = True


class ContextResponse(BaseModel):
    """上下文响应"""
    memories: List[MemoryEntry]
    user_profile: Optional[UserProfile] = None
    total_tokens: int = 0
    strategy_used: str = "hybrid"
