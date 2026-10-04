"""
记忆模块数据模型
"""

from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, JSON, Index, text
from sqlalchemy.dialects.postgresql import ARRAY, FLOAT
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple
from pydantic import BaseModel


# ========== SQLAlchemy ORM 模型 ==========

class ConversationMemoryORM:
    """对话记忆表 - 用于向量检索"""
    __tablename__ = "conversation_memories"
    
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    # [T-跨卡串味修复 2026-10-03] 角色维度。NULL=无角色归属（普通聊天 /
    # ST 向量集合 / 存量行），行为不变；非 NULL=该记忆归属的角色会话。
    # 存在原因见 storage.semantic_search 分支3：session_id 为空时若无此列
    # 只能按 user_id 召回，会把 A 卡的记忆塞给 B 卡。
    character_id = Column(String, nullable=True)

    # 内容
    role = Column(String)  # 'user' | 'assistant' | 'system'
    content = Column(Text)
    content_summary = Column(Text, nullable=True)  # 摘要版本
    
    # 向量嵌入 - 使用 pgvector
    embedding = Column(ARRAY(FLOAT))  # PostgreSQL 向量
    
    # 元数据
    importance_score = Column(Float, default=0.5)
    topics = Column(JSON, default=list)  # 提取的话题标签
    tokens_count = Column(Integer, default=0)  # token 数量估算
    
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # 向量索引（在迁移时创建）
    # __table_args__ = (
    #     Index('idx_memory_embedding', 'embedding', postgresql_using='ivfflat'),
    # )


class UserProfileORM:
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
    
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ========== Pydantic 模型（API用） ==========

class MemoryEntry(BaseModel):
    """单条记忆条目"""
    id: Optional[int] = None
    user_id: int
    session_id: str
    # D 批补齐: 存储构造点本就传 branch_id/message_id（此前模型缺字段被静默丢弃）；
    # message_id 是"记忆=消息镜像"的关联键，STM/LTM 排除最近消息镜像依赖它。
    branch_id: Optional[str] = None
    message_id: Optional[int] = None
    role: str
    content: str
    importance_score: float = 0.5
    topics: List[str] = []
    tokens_count: int = 0
    created_at: Optional[datetime] = None
    embedding: Optional[List[float]] = None

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
    memory_mode: str = "vector"
    # D3 修复: ST protect 语义 —— 最近 N 条消息的 id 集合，其记忆镜像不注入
    # （对话历史窗口已含原文，重复召回浪费 token）；None/空 = 行为不变。
    exclude_message_ids: Optional[List[int]] = None
    # [T-跨卡串味修复 2026-10-03] 角色维度。记忆表原先只有 user_id/session_id，
    # session_id 一旦传空（分支3）就退化成用户级全量召回 → A 卡注入 B 卡记忆。
    # 调用方（角色扮演装配链）传当前会话的 character_id，把过滤落到 SQL。
    # None = 调用方不掌握角色（如普通聊天 / ST 向量集合），行为与修复前一致。
    character_id: Optional[str] = None
    # [MEM-MIRROR 2026-10-05] 分支作用域 [(branch_id, up_to_message_id)]，root→self。
    # 提供时按分叉点截断召回（与消息历史 fork_limits 同语义）：某祖先分支在分叉点
    # 之后写入的记忆对子分支不可见。None = 沿用 branch_ids 的旧行为（全祖先链可见）。
    branch_scopes: Optional[List[Tuple[str, Optional[int]]]] = None


class ContextResponse(BaseModel):
    """上下文响应"""
    memories: List[MemoryEntry]
    user_profile: Optional[UserProfile] = None
    total_tokens: int = 0
    strategy_used: str = "hybrid"
    # [T-跨卡串味修复 2026-10-03] 实际生效的召回作用域（可观测性，非行为）。
    # "session"    = 有 session_id 约束（最窄，正常路径）
    # "character"  = 无 session_id 但有 character_id，按 user+character 过滤
    # "user"       = 两者都无 —— **降级**（用户级全量召回，跨角色串味风险面）
    # 静默降级是本项目既往教训，故显式回传供调用方判断。
    scope: str = "session"

