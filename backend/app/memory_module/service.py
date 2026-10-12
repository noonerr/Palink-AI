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
        character_id: Optional[str] = None,
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
            character_id: 角色维度（[T-跨卡串味修复]）；None = 无角色归属
                （普通聊天 / ST 向量集合），行为不变
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
                            character_id=character_id,
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
                message_id=message_id,
                character_id=character_id,
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
        memory_mode: str = "vector",
        exclude_message_ids: Optional[List[int]] = None,
        character_id: Optional[str] = None,
        branch_scopes: Optional[List[tuple]] = None,
    ) -> ContextResponse:
        """
        获取增强上下文

        这是主要接口，用于在聊天前获取相关记忆。

        Args:
            character_id: [T-跨卡串味修复] 角色维度。与 session_id 一起决定
                召回作用域：见 ``ContextResponse.scope``
                （"session" 正常 / "character" 按角色过滤 / "user" 降级）。
        """
        if not self.is_available():
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="disabled",
                scope=self.storage.resolve_search_scope(session_id, character_id),
            )

        if self.enable_cache:
            branch_key = ",".join(sorted(branch_ids)) if branch_ids else ""
            query_hash = hashlib.sha256(query.encode()).hexdigest()[:16]
            # D3 修复: 排除集逐轮变化（随最近消息滚动），必须进缓存键防跨轮串味
            exclude_key = (
                hashlib.sha256(
                    ",".join(str(m) for m in sorted(exclude_message_ids)).encode()
                ).hexdigest()[:12]
                if exclude_message_ids else "none"
            )
            # [T-跨卡串味修复] character_id 必须进缓存键：同一 session_id 传空
            # 召回（scope=user/character）时，不同角色拿到的结果集不同，共用
            # 键会把 A 卡的召回结果喂给 B 卡 —— 正是本次要修的串味。
            char_key = character_id or ""
            # [MEM-MIRROR 2026-10-05] 分叉点截断后，作用域不再是「branch_id 集合」
            # 就够描述 —— 同一批 branch_ids 在不同分叉点下召回集不同，故截断键
            # （branch:up_to 序列）也必须进缓存键，否则子分支会命中祖先分支的缓存。
            scope_key = (
                hashlib.sha256(
                    ",".join(f"{b}:{u}" for b, u in branch_scopes).encode()
                ).hexdigest()[:12]
                if branch_scopes else "none"
            )
            # [阶段0-D6 2026-10-11] **memory_mode 与 max_tokens 必须进缓存键**。
            # 原实现只含 user/session/char/branch/scope/query/exclude，**漏了模式与预算**
            # ⇒ 同一 query 下 `rule`（纯 STM）与 `vector`（STM+LTM）共用缓存，
            # 后到的调用者拿到前一个模式的结果；预算不同（750 vs 4000）同理
            # 会拿到别的档位装出来的结果集。用户在设置里切档位后会看到
            # 最多 60 秒的"切了没反应"。
            # 实测证据：同一会话同一 query 连续调用 rule/vector，第二次
            # 直接命中第一次的缓存 ⇒ rule 分支的诊断日志根本不落（P78）。
            cache_key = (
                f"context:{user_id}:{session_id or ''}:{char_key}:"
                f"{branch_key}:{scope_key}:{query_hash}:{exclude_key}:"
                f"{memory_mode}:{max_tokens}"
            )
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
                memory_mode=memory_mode,
                exclude_message_ids=exclude_message_ids,
                character_id=character_id,
                branch_scopes=branch_scopes,
            )

            result = await asyncio.to_thread(self.retriever.retrieve, request)

            # 方案 B：命中语义块时自动携带前后相邻块，保证上下文完整
            # [NEIGHBOR-BUDGET 2026-10-09] **必须给邻居单开预算**：
            # 旧实现把 request.max_tokens 直接传下去，而检索已经把窗口填到接近
            # 满额，于是 `total + t > max_tokens` 恒真 ⇒ 实测 24 次检索全部 +0
            # 条（p43）。后果比"没做扩展"更糟：注入的是被切开的半截段落，
            # 前半句在、后半句不在，模型只能脑补。现在按 NEIGHBOR_EXTRA_RATIO
            # 主预算之外再加一小段，并用 NEIGHBOR_MAX_ADDS 封顶（防一次检索
            # 顺着邻居链把整段历史拖进来）。两者置 0 即回到旧行为。
            if memory_config.NEIGHBOR_EXPAND and result.memories:
                _base = int(request.max_tokens or 0)
                _extra = int(_base * max(0.0, memory_config.NEIGHBOR_EXTRA_RATIO))
                result = self._expand_chunk_neighbors(
                    result,
                    _base + _extra,
                    max_adds=int(memory_config.NEIGHBOR_MAX_ADDS),
                    priority_order=list(result.relevance_order or []) or None,
                )

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
                strategy_used="error",
                scope=self.storage.resolve_search_scope(session_id, character_id),
            )

    def _expand_chunk_neighbors(
        self,
        result: ContextResponse,
        max_tokens: int,
        max_adds: int = 0,
        priority_order: Optional[list] = None,
    ) -> ContextResponse:
        """对命中的语义块做邻居扩展（idx±1，同 turn_hash），受 token 预算约束。

        Args:
            max_tokens: **已含邻居附加预算**的总上限（由调用方按
                ``NEIGHBOR_EXTRA_RATIO`` 放大后传入，见 get_context）。
            max_adds: **每个命中块**最多新增几块邻居。0 = 不限（旧行为）。

        [NEIGHBOR-PER-HIT 2026-10-11 阶段 0（D2）] ``max_adds`` 由
        **全局封顶**改为**每命中各自封顶**。

        旧实现的缺陷（实测 P75c，会话 f25daab6，7 轮）：
        全局计数器 ``len(additions) >= max_adds`` 让同一次检索里**只有前几个
        命中**能补到邻居 —— 块级 radius=1 时 1 个命中最多带 2 条，故
        ``max_adds=4`` 只够**前 2 个命中**用，从第 3 个起一条都补不到。
        实测：命中块 183 个，**被饿死 152 个（83.1%）**，整轮只补进 4 条邻居；
        改为各自封顶后可补 134 条（+379%）。后果不是"少补几条"而是**注入的是
        被切开的半截段落**（前半句在、后半句不在），模型只能脑补。

        另订正原注释的一处动机错误：旧注释称"无封顶时单次检索可能拖进整段
        历史" —— 但本函数**不递归**（`get_adjacent_chunks` 只取 idx±radius，
        扩进来的块不会再被扩展），故不存在"邻居的邻居再带邻居"的链式放大。
        真正的上界是 ``命中块数 × (2×radius)``，由 ``max_tokens`` 预算兜底。

        [NEIGHBOR-DETERMINISM 2026-10-09] **必须按检索得分序扩展**。
        ``result.memories`` 里的顺序是**时间序**（retriever 末尾 sort by
        created_at），不是相关度序；而封顶一旦生效，"轮到谁先被扩展"就由迭代
        顺序决定 ⇒ 同一问题两次检索可能补进**不同**的邻居块（实测同一问题两趟
        注入 3167 / 4028 字符，差一条 462 tok 的块）。邻居扩展的语义是
        "把最相关的那条记忆补完整"，所以按相关度序才对：这里用检索返回的原始
        顺序作为得分序代理（调用方在合并时也是时间序，故额外接收
        preferred_order）。
        """
        try:
            from .storage import _parse_chunk_meta

            has_chunk = any(_parse_chunk_meta(m.topics) for m in result.memories)
            if not has_chunk:
                return result

            ids = {m.id for m in result.memories}
            total = result.total_tokens or sum(
                m.tokens_count or (len(m.content) // 2) for m in result.memories
            )
            # priority_order 未给（直接调用的测试/旧调用方）时退回时间序，
            # 行为与本次修复前一致。
            priority_order = priority_order if priority_order else list(result.memories)
            # [D2] 每个命中块各自的上限 = max_adds。若调用方仍按"全局总量"传值
            # （如 4），而单命中最多只能带 2×radius 条，则实际每命中上限取
            # min(max_adds, 2×radius) 更贴近语义；此处直接用 max_adds，
            # 由 tokens 预算做最终约束，避免误伤 radius=2（句级）的配置。
            per_hit_cap = max_adds if max_adds else 0
            additions: Dict[int, Any] = {}
            for mem in priority_order:
                if mem.id not in ids or _parse_chunk_meta(mem.topics) is None:
                    continue
                # [D2] 计数器按**每个命中块**重置（旧实现是整个循环共享一个
                # 全局计数器，导致第 3 个命中起永远补不到邻居）。
                added_this_hit = 0
                # [CHUNK-SENTENCE 2026-10-11] 半径按当前切分粒度取（句级 2 / 块级 1），
                # 保证回退到块级时邻居行为逐字回到改动前。
                for nb in self.storage.get_adjacent_chunks(
                    mem, radius=memory_config.EFFECTIVE_NEIGHBOR_RADIUS
                ):
                    if per_hit_cap and added_this_hit >= per_hit_cap:
                        break
                    if nb.id in ids or nb.id in additions:
                        continue
                    t = nb.tokens_count or (len(nb.content) // 2)
                    if max_tokens and total + t > max_tokens:
                        continue
                    additions[nb.id] = nb
                    ids.add(nb.id)
                    total += t
                    added_this_hit += 1  # [D2] 只增本命中的计数
            if not additions:
                return result

            merged = sorted(
                list(result.memories) + list(additions.values()),
                key=lambda x: (x.created_at or datetime.min, x.id),
            )
            # [D2] 顺带报告"有多少命中块真的被扩展到了" —— 旧实现下这个数字
            # 恒等于「前几个命中」，看不出 83% 被饿死。
            logger.info(
                f"记忆邻居扩展: +{len(additions)} 块, total_tokens={total}, "
                f"命中块={len(result.memories)}, 每命中上限={max_adds or '不限'}"
            )
            return ContextResponse(
                memories=merged,
                user_profile=result.user_profile,
                total_tokens=total,
                strategy_used=result.strategy_used + "+neighbors",
                scope=result.scope,
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
