"""
记忆检索引擎 - 混合检索
支持语义搜索 + 时间权重 + 重要性权重
"""

from typing import List, Dict, Tuple
from datetime import datetime, timedelta
import logging
import hashlib
import numpy as np

from .storage import MemoryStorage
from .models import MemoryEntry, ContextRequest, ContextResponse
from .embedder import embed_text
from .config import memory_config

logger = logging.getLogger("MemoryModule")


class MemoryRetriever:
    """记忆检索器 - 混合检索模式"""
    
    def __init__(self, storage: MemoryStorage):
        self.storage = storage
    
    def retrieve(self, request: ContextRequest) -> ContextResponse:
        """
        改进后的双路检索策略：
        1. 强制包含最近的 N 条记忆（短期记忆 STM）
        2. 用剩余的 token 空间填充语义相关的旧记忆（长期记忆 LTM）
        3. 对 LTM 进行时间衰减 + 语义相似度加权排序
        """
        try:
            # 1. 获取短期记忆 (STM) - 最近 5 条
            recent_limit = 5
            stm_memories = self.storage.get_recent(
                user_id=request.user_id,
                session_id=request.session_id,
                limit=recent_limit
            )
            
            # 使用列表推导式去重，保留最新
            seen_ids = set()
            unique_stm = []
            for m in stm_memories:
                if m.id not in seen_ids:
                    seen_ids.add(m.id)
                    unique_stm.append(m)
            stm_memories = unique_stm
            stm_ids = seen_ids
            
            # 计算 STM 占用的 tokens
            current_tokens = sum(m.tokens_count or (len(m.content) // 2) for m in stm_memories)
            remaining_tokens = request.max_tokens - current_tokens
            
            # 如果 STM 已经占满窗口，直接返回 STM
            if remaining_tokens <= 0:
                logger.info(f"短期记忆已占满窗口 ({current_tokens} tokens)，跳过长期检索")
                # 按时间排序确保顺序正确
                stm_memories.sort(key=lambda x: x.created_at or datetime.min)
                return ContextResponse(
                    memories=stm_memories,
                    user_profile=self.storage.get_user_profile(request.user_id) if request.include_profile else None,
                    total_tokens=current_tokens,
                    strategy_used="stm_only"
                )

            # 2. 获取长期记忆 (LTM)
            ltm_memories = []
            # 至少留点空间才去检索，且仅当 query 有意义时
            if remaining_tokens > 100 and request.query and len(request.query.strip()) > 1:
                query_embedding = embed_text(request.query)
                query_embedding_list = query_embedding.tolist()[0] if len(query_embedding.shape) > 1 else query_embedding.tolist()
                
                # 检索更多候选，以便过滤
                semantic_candidates = self.storage.semantic_search(
                    user_id=request.user_id,
                    query_embedding=query_embedding_list,
                    limit=50,
                    min_similarity=memory_config.MIN_SIMILARITY,
                    session_id=request.session_id
                )
                
                if semantic_candidates:
                    now = datetime.utcnow()
                    scored_candidates = []
                    
                    for memory, similarity in semantic_candidates:
                        # A. 去重：如果在 STM 中则跳过
                        if memory.id in stm_ids:
                            continue
                            
                        # B. 评分：语义分 + 时间衰减 + 重要性
                        # 时间衰减：越近越好，但不会超过 STM
                        time_decay = self._calculate_time_decay(memory.created_at, now)
                        importance = memory.importance_score or 0.5
                        
                        # 权重分配：语义主导，但兼顾时效
                        final_score = (
                            similarity * 0.6 +
                            time_decay * 0.2 +
                            importance * 0.2
                        )
                        scored_candidates.append((memory, final_score))
                    
                    # 按综合分数排序
                    scored_candidates.sort(key=lambda x: x[1], reverse=True)
                    
                    # 填充 LTM 到剩余空间
                    # 先做简单的内容去重
                    candidate_memories = [m for m, _ in scored_candidates]
                    deduped_candidates = self._deduplicate_memories(candidate_memories)
                    
                    for mem in deduped_candidates:
                        mem_tokens = mem.tokens_count or (len(mem.content) // 2)
                        if remaining_tokens - mem_tokens >= 0:
                            ltm_memories.append(mem)
                            remaining_tokens -= mem_tokens
                        else:
                            break
            
            # 4. 合并最终结果 (LTM + STM)
            combined_memories = ltm_memories + stm_memories
            
            # 最终去重 (ID)
            final_map = {}
            for m in combined_memories:
                final_map[m.id] = m
            final_memories = list(final_map.values())
            
            # 按时间正序排列（旧 -> 新），符合 LLM 阅读习惯
            final_memories.sort(key=lambda x: x.created_at or datetime.min)
            
            total_tokens = sum(m.tokens_count or (len(m.content) // 2) for m in final_memories)
            
            user_profile = None
            if request.include_profile:
                user_profile = self.storage.get_user_profile(request.user_id)
            
            return ContextResponse(
                memories=final_memories,
                user_profile=user_profile,
                total_tokens=total_tokens,
                strategy_used="dual_path_stm_ltm"
            )
            
        except Exception as e:
            logger.error(f"检索记忆失败: {e}")
            import traceback
            traceback.print_exc()
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="error"
            )
    
    def _calculate_time_decay(self, created_at: datetime, now: datetime) -> float:
        """
        计算时间衰减因子
        
        返回值：0-1之间，越近越高
        """
        if not created_at:
            return 0.5
        
        try:
            delta = now - created_at
            hours = delta.total_seconds() / 3600
            
            if hours < 1:
                return 1.0
            elif hours < 24:
                return 0.9
            elif hours < 168:
                return 0.7
            elif hours < 720:
                return 0.5
            else:
                return 0.3
        except:
            return 0.5
    
    def _deduplicate_memories(self, memories: List[MemoryEntry]) -> List[MemoryEntry]:
        """去除重复记忆（基于内容相似度）"""
        seen_contents = set()
        deduplicated = []
        
        for memory in memories:
            content_hash = self._simple_hash(memory.content)
            if content_hash not in seen_contents:
                seen_contents.add(content_hash)
                deduplicated.append(memory)
        
        return deduplicated
    
    def _simple_hash(self, content: str) -> str:
        """生成简单的内容哈希"""
        content_normalized = content.strip().lower()
        return hashlib.blake2b(content_normalized.encode("utf-8"), digest_size=16).hexdigest()
    
    def _select_by_tokens(
        self,
        memories: List[MemoryEntry],
        max_tokens: int
    ) -> List[MemoryEntry]:
        """根据 token 限制选择记忆（先去重）"""
        
        memories = self._deduplicate_memories(memories)
        
        selected = []
        current_tokens = 0
        
        for memory in memories:
            tokens = memory.tokens_count or (len(memory.content) // 2)
            
            if current_tokens + tokens > max_tokens:
                break
            
            selected.append(memory)
            current_tokens += tokens
        
        return selected
