"""
优化版记忆服务 - 分层记忆架构
目标：无限记忆 + 可接受延迟

.. deprecated::
    OptimizedMemoryService is deprecated, use MemoryService instead.
    此模块仅保留向后兼容，所有缓存功能已整合到 MemoryService 中。
"""

import asyncio
import hashlib
import json
import logging
import warnings
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from sqlalchemy import text
import numpy as np

from .storage import MemoryStorage
from .models import MemoryEntry, ContextRequest, ContextResponse
from .config import memory_config
from .service import MemoryService

warnings.warn(
    "OptimizedMemoryService is deprecated, use MemoryService instead",
    DeprecationWarning,
    stacklevel=2,
)

logger = logging.getLogger("OptimizedMemory")


class OptimizedMemoryService(MemoryService):
    """
    优化版记忆服务（已弃用，请使用 MemoryService）

    特点：
    1. 异步非阻塞 - 记忆更新在后台进行
    2. 分层检索 - L1(即时) + L2(缓存) + L3(向量)
    3. 智能压缩 - 自动总结历史对话
    4. 预加载 - 热数据常驻内存
    """

    def __init__(self, db_session: Session):
        super().__init__(db_session, enable_cache=True)
    
    # ========== 核心 API ==========
    
    async def get_context_fast(self, user_id: int, session_id: str, query: str) -> Dict:
        """
        快速获取上下文 - 主流程调用（非阻塞）
        
        耗时目标: < 10ms
        """
        context = {
            "short_term": [],      # L1: 当前对话历史
            "session_summary": "",  # L2: 会话摘要
            "key_facts": [],       # L3: 关键事实（缓存）
            "latency_ms": 0
        }
        
        start_time = datetime.now(timezone.utc)
        
        try:
            # L1: 获取当前对话的最近消息（从已有history，不查询）
            # 这部分由主流程提供，这里跳过
            
            # L2: 获取会话摘要（从缓存）
            cache_key = f"summary:{user_id}:{session_id}"
            summary = self._get_cache(cache_key)
            if summary:
                context["session_summary"] = summary
            
            # L3: 获取关键事实（从缓存，异步预加载）
            facts_key = f"facts:{user_id}"
            facts = self._get_cache(facts_key)
            if facts:
                context["key_facts"] = facts[:3]  # 最多3条
            
            # 计算延迟
            context["latency_ms"] = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000
            
        except Exception as e:
            logger.error(f"快速获取上下文失败: {e}")
        
        return context
    
    async def update_memory_async(self, user_id: int, session_id: str, 
                                   user_msg: str, assistant_msg: str):
        """
        异步更新记忆 - 后台任务
        
        不阻塞主流程
        """
        try:
            # 1. 存储原始消息（低优先级）
            await asyncio.to_thread(
                self._store_message,
                user_id, session_id, user_msg, assistant_msg
            )
            
            # 2. 检查是否需要生成摘要
            await self._check_and_update_summary(user_id, session_id)
            
            # 3. 提取关键事实
            await self._extract_key_facts(user_id, user_msg, assistant_msg)
            
        except Exception as e:
            logger.error(f"异步更新记忆失败: {e}")
    
    def _store_message(self, user_id: int, session_id: str, 
                       user_msg: str, assistant_msg: str):
        """存储消息到数据库"""
        try:
            timestamp_fn = "NOW()" if self.storage.is_postgres else "CURRENT_TIMESTAMP"
            sql = text(f"""
                INSERT INTO conversation_memories 
                (user_id, session_id, role, content, importance_score, created_at)
                VALUES 
                (:user_id, :session_id, 'user', :user_msg, 0.5, {timestamp_fn}),
                (:user_id, :session_id, 'assistant', :assistant_msg, 0.5, {timestamp_fn})
            """)
            self.db.execute(sql, {
                "user_id": user_id,
                "session_id": session_id,
                "user_msg": user_msg[:1000],  # 限制长度
                "assistant_msg": assistant_msg[:2000]
            })
            self.db.commit()
        except Exception as e:
            logger.error(f"存储消息失败: {e}")
            self.db.rollback()
    
    async def _check_and_update_summary(self, user_id: int, session_id: str):
        """检查并更新会话摘要"""
        cache_key = f"summary:{user_id}:{session_id}"
        
        # 检查缓存是否存在且未过期（5分钟）
        if self._get_cache(cache_key):
            return
        
        try:
            # 获取最近10条消息
            messages = await asyncio.to_thread(
                self.storage.get_recent,
                user_id=user_id,
                session_id=session_id,
                limit=10
            )
            
            if len(messages) < 5:
                return  # 消息太少，不生成摘要
            
            # 简单的规则-based 摘要（避免调用AI，节省成本）
            summary = self._generate_simple_summary(messages)
            
            # 存入缓存（5分钟）
            self._set_cache(cache_key, summary, ttl=300)
            
        except Exception as e:
            logger.error(f"更新摘要失败: {e}")
    
    def _generate_simple_summary(self, messages: List[MemoryEntry]) -> str:
        """生成简单摘要（规则-based，无AI调用）"""
        user_contents = [m.content for m in messages if m.role == 'user']
        
        # 提取关键词（简单实现）
        keywords = []
        for content in user_contents:
            if 'python' in content.lower():
                keywords.append('Python')
            if 'data' in content.lower():
                keywords.append('数据分析')
            if 'learn' in content.lower() or '学习' in content:
                keywords.append('学习')
        
        keywords = list(set(keywords))  # 去重
        
        if keywords:
            return f"用户关注: {', '.join(keywords[:3])}"
        return "一般对话"
    
    async def _extract_key_facts(self, user_id: int, user_msg: str, assistant_msg: str):
        """提取关键事实"""
        facts_key = f"facts:{user_id}"
        
        # 简单的规则提取
        new_facts = []
        
        # 提取用户偏好
        if '我喜欢' in user_msg or 'I like' in user_msg:
            new_facts.append(user_msg.replace('我喜欢', '').strip()[:50])
        
        if '我是' in user_msg or 'I am' in user_msg:
            new_facts.append(user_msg.replace('我是', '').strip()[:50])
        
        # 更新缓存
        if new_facts:
            existing_facts = self._get_cache(facts_key) or []
            updated_facts = new_facts + existing_facts[:5]  # 保留最近5条
            self._set_cache(facts_key, updated_facts, ttl=3600)


# 便捷函数
async def get_memory_context_fast(db: Session, user_id: int, 
                                   session_id: str, query: str) -> Dict:
    """快速获取记忆上下文"""
    service = OptimizedMemoryService(db)
    return await service.get_context_fast(user_id, session_id, query)


async def update_memory_background(db: Session, user_id: int, session_id: str,
                                    user_msg: str, assistant_msg: str):
    """后台更新记忆"""
    service = OptimizedMemoryService(db)
    await service.update_memory_async(user_id, session_id, user_msg, assistant_msg)
