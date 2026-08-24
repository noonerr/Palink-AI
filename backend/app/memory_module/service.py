"""
记忆模块主服务
对外暴露的统一接口
"""

from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
from datetime import datetime, timezone
from collections import OrderedDict
import asyncio
import hashlib
import logging
import threading

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

    _cache: OrderedDict = OrderedDict()
    _cache_ttl: Dict[str, float] = {}
    _MAX_CACHE_SIZE = 1000
    _lock: Optional[asyncio.Lock] = None
    _init_lock = threading.Lock()

    def __init__(self, db_session: Session, enable_cache: bool = True):
        self.db = db_session
        self.storage = MemoryStorage(db_session)
        self.retriever = MemoryRetriever(self.storage)
        self.enable_cache = enable_cache
        with MemoryService._init_lock:
            if MemoryService._lock is None:
                MemoryService._lock = asyncio.Lock()
        self._lock = MemoryService._lock

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
        branch_id: Optional[str] = None,
        message_id: Optional[int] = None,
        **metadata
    ) -> Optional[int]:
        """
        存储对话记忆

        assistant 长回复（≥ CHUNK_TRIGGER_CHARS 且总开关开启）会先经
        semantic_split 按话题断点切成语义块，再批量入库（方案 B，2026-08-22）。

        Args:
            user_id: 用户ID
            session_id: 会话ID
            role: 角色 ('user' | 'assistant')
            content: 内容
            message_id: 关联消息主键（[MEM-UPSERT] 记忆=消息当前内容的镜像；
                切分多块共享同一 id；None 表示无关联——存量兼容路径）
            **metadata: 额外元数据 (importance_score, topics等)

        Returns:
            memory_id: 记忆ID（多块时为首块 ID）；失败返回 None
        """
        if not self.is_available():
            return None

        try:
            # 方案 B：assistant 长回复语义切分（user 消息保持整条）
            if (
                role == "assistant"
                and memory_config.SEMANTIC_CHUNKING
                and content
                and len(content) >= memory_config.CHUNK_TRIGGER_CHARS
            ):
                try:
                    from .semantic_chunker import semantic_split

                    chunks = semantic_split(content)
                    if len(chunks) > 1:
                        ids = self.storage.store_chunks(
                            user_id=user_id,
                            session_id=session_id,
                            role=role,
                            chunks=chunks,
                            branch_id=branch_id,
                            importance_score=metadata.get('importance_score', 0.5),
                            message_id=message_id,
                        )
                        if ids:
                            return ids[0]
                        # store_chunks 整体失败（含降级路径内部已处理）→ 落到底部单条存储
                except Exception as chunk_exc:
                    logger.warning(f"语义切分入库失败，回退整条存储: {chunk_exc}")

            return self.storage.store(
                user_id=user_id,
                session_id=session_id,
                role=role,
                content=content,
                importance_score=metadata.get('importance_score', 0.5),
                topics=metadata.get('topics', []),
                branch_id=branch_id,
                message_id=message_id
            )
        except Exception as e:
            logger.error(f"存储记忆失败: {e}")
            return None
    
    async def get_context(
        self,
        user_id: int,
        query: str,
        session_id: Optional[str] = None,
        max_tokens: int = 2000,
        include_profile: bool = True,
        branch_ids: Optional[List[str]] = None,
        memory_mode: str = "vector"
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

        if self.enable_cache:
            branch_key = ",".join(sorted(branch_ids)) if branch_ids else ""
            query_hash = hashlib.sha256(query.encode()).hexdigest()[:16]
            cache_key = f"context:{user_id}:{session_id or ''}:{branch_key}:{query_hash}"
            cached = await self._get_cache(cache_key)
            if cached is not None:
                return cached

        try:
            request = ContextRequest(
                user_id=user_id,
                query=query,
                session_id=session_id,
                branch_ids=branch_ids,
                max_tokens=max_tokens,
                include_profile=include_profile,
                memory_mode=memory_mode
            )

            result = await asyncio.to_thread(self.retriever.retrieve, request)

            # 方案 B：命中语义块时自动携带前后相邻块（预算内），保证上下文完整
            if memory_config.NEIGHBOR_EXPAND and result.memories:
                result = self._expand_chunk_neighbors(result, request.max_tokens)

            if self.enable_cache:
                await self._set_cache(cache_key, result, ttl=60)

            return result

        except Exception as e:
            logger.error(f"获取上下文失败: {e}")
            self.db.rollback()
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="error"
            )

    def _expand_chunk_neighbors(self, result: ContextResponse, max_tokens: int) -> ContextResponse:
        """对命中的语义块做邻居扩展（idx±1，同 turn_hash），受 token 预算约束。"""
        try:
            from .storage import _parse_chunk_meta

            has_chunk = any(_parse_chunk_meta(m.topics) for m in result.memories)
            if not has_chunk:
                return result

            ids = {m.id for m in result.memories}
            total = result.total_tokens or sum(
                m.tokens_count or (len(m.content) // 2) for m in result.memories
            )
            additions: Dict[int, Any] = {}
            for mem in list(result.memories):
                if _parse_chunk_meta(mem.topics) is None:
                    continue
                for nb in self.storage.get_adjacent_chunks(mem):
                    if nb.id in ids or nb.id in additions:
                        continue
                    t = nb.tokens_count or (len(nb.content) // 2)
                    if max_tokens and total + t > max_tokens:
                        continue
                    additions[nb.id] = nb
                    ids.add(nb.id)
                    total += t
            if not additions:
                return result

            merged = sorted(
                list(result.memories) + list(additions.values()),
                key=lambda x: (x.created_at or datetime.min, x.id),
            )
            logger.info(
                f"记忆邻居扩展: +{len(additions)} 块, total_tokens={total}"
            )
            return ContextResponse(
                memories=merged,
                user_profile=result.user_profile,
                total_tokens=total,
                strategy_used=result.strategy_used + "+neighbors",
            )
        except Exception as e:
            logger.warning(f"邻居扩展失败（忽略，返回原结果）: {e}")
            return result
    
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

    # ========== 缓存工具 ==========

    async def _get_cache(self, key: str) -> Any:
        async with self._lock:
            if key in self._cache:
                expire_time = self._cache_ttl.get(key, 0)
                if datetime.now(timezone.utc).timestamp() < expire_time:
                    self._cache.move_to_end(key)
                    return self._cache[key]
                else:
                    del self._cache[key]
                    del self._cache_ttl[key]
            return None

    async def _set_cache(self, key: str, value: Any, ttl: int = 300):
        async with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            elif len(self._cache) >= self._MAX_CACHE_SIZE:
                oldest_key, _ = self._cache.popitem(last=False)
                self._cache_ttl.pop(oldest_key, None)
            self._cache[key] = value
            self._cache_ttl[key] = datetime.now(timezone.utc).timestamp() + ttl

    @classmethod
    async def set_cache(cls, key, value, ttl=600):
        with cls._init_lock:
            if cls._lock is None:
                cls._lock = asyncio.Lock()
        async with cls._lock:
            if key in cls._cache:
                cls._cache.move_to_end(key)
            elif len(cls._cache) >= cls._MAX_CACHE_SIZE:
                oldest_key, _ = cls._cache.popitem(last=False)
                cls._cache_ttl.pop(oldest_key, None)
            cls._cache[key] = value
            cls._cache_ttl[key] = datetime.now(timezone.utc).timestamp() + ttl

    @classmethod
    async def _clear_cache(cls):
        with cls._init_lock:
            if cls._lock is None:
                cls._lock = asyncio.Lock()
        async with cls._lock:
            cls._cache.clear()
            cls._cache_ttl.clear()


# ========== 便捷函数 ==========

def get_memory_service(db: Session) -> MemoryService:
    """依赖注入用工厂函数"""
    return MemoryService(db)
