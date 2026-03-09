"""
记忆模块主服务
对外暴露的统一接口
"""

from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
import logging

from .storage import MemoryStorage
from .retriever import MemoryRetriever
from .models import MemoryEntry, UserProfile, ContextRequest, ContextResponse
from .config import memory_config

logger = logging.getLogger("MemoryModule")


class MemoryService:
    """
    记忆服务主类
    
    使用方式:
        service = MemoryService(db_session)
        context = service.get_context(user_id, query)
    """
    
    def __init__(self, db_session: Session):
        self.db = db_session
        self.storage = MemoryStorage(db_session)
        self.retriever = MemoryRetriever(self.storage)
        
        if not memory_config.is_enabled():
            logger.warning("记忆模块已禁用")
    
    def is_available(self) -> bool:
        """检查服务是否可用"""
        return memory_config.is_enabled()
    
    # ========== 核心 API ==========
    
    def store_memory(
        self,
        user_id: int,
        session_id: str,
        role: str,
        content: str,
        **metadata
    ) -> Optional[int]:
        """
        存储对话记忆
        
        Args:
            user_id: 用户ID
            session_id: 会话ID
            role: 角色 ('user' | 'assistant')
            content: 内容
            **metadata: 额外元数据 (importance_score, topics等)
        
        Returns:
            memory_id: 记忆ID
        """
        if not self.is_available():
            return None
        
        try:
            return self.storage.store(
                user_id=user_id,
                session_id=session_id,
                role=role,
                content=content,
                importance_score=metadata.get('importance_score', 0.5),
                topics=metadata.get('topics', [])
            )
        except Exception as e:
            logger.error(f"存储记忆失败: {e}")
            return None
    
    def get_context(
        self,
        user_id: int,
        query: str,
        session_id: Optional[str] = None,
        max_tokens: int = 2000,
        include_profile: bool = True
    ) -> ContextResponse:
        """
        获取增强上下文
        
        这是主要接口，用于在聊天前获取相关记忆
        """
        if not self.is_available():
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="disabled"
            )
        
        try:
            request = ContextRequest(
                user_id=user_id,
                query=query,
                session_id=session_id,
                max_tokens=max_tokens,
                include_profile=include_profile
            )
            
            return self.retriever.retrieve(request)
            
        except Exception as e:
            logger.error(f"获取上下文失败: {e}")
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="error"
            )
    
    def get_user_profile(self, user_id: int) -> Optional[UserProfile]:
        """获取用户画像"""
        if not self.is_available():
            return None
        
        try:
            return self.storage.get_user_profile(user_id)
        except Exception as e:
            logger.error(f"获取用户画像失败: {e}")
            return None
    
    def update_user_profile(self, profile: UserProfile) -> bool:
        """更新用户画像"""
        if not self.is_available():
            return False
        
        try:
            return self.storage.update_user_profile(profile)
        except Exception as e:
            logger.error(f"更新用户画像失败: {e}")
            return False
    
    def search_memories(
        self,
        user_id: int,
        query: str,
        limit: int = 10
    ) -> List[MemoryEntry]:
        """搜索记忆（用于前端展示）"""
        if not self.is_available():
            return []
        
        try:
            from .embedder import embed_text
            
            embedding = embed_text(query)
            embedding_list = embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
            
            results = self.storage.semantic_search(
                user_id=user_id,
                query_embedding=embedding_list,
                limit=limit
            )
            
            return [m for m, _ in results]
            
        except Exception as e:
            logger.error(f"搜索记忆失败: {e}")
            return []
    
    def get_recent_memories(
        self,
        user_id: int,
        session_id: Optional[str] = None,
        limit: int = 20
    ) -> List[MemoryEntry]:
        """获取最近记忆"""
        if not self.is_available():
            return []
        
        try:
            return self.storage.get_recent(user_id, session_id, limit)
        except Exception as e:
            logger.error(f"获取最近记忆失败: {e}")
            return []


# ========== 便捷函数 ==========

def get_memory_service(db: Session) -> MemoryService:
    """依赖注入用工厂函数"""
    return MemoryService(db)
