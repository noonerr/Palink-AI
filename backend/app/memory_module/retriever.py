"""
记忆检索引擎 - 混合检索
支持语义搜索 + 上下文邻近度 + 重要性权重
"""

from typing import List, Dict, Tuple
from datetime import datetime, timedelta, timezone
import logging
import hashlib
import numpy as np

from .storage import MemoryStorage
from .models import MemoryEntry, ContextRequest, ContextResponse
from .embedder import embed_text
from .config import memory_config

logger = logging.getLogger("MemoryModule")

# 候选集中话题相似度阈值（用于判断两条记忆是否属于同一话题）
_TOPIC_SIMILARITY_THRESHOLD = 0.6
# 上下文邻近度衰减系数（gap × 此系数，越大衰减越快）
_CONTEXT_DECAY_FACTOR = 0.1


class MemoryRetriever:
    """记忆检索器 - 混合检索模式"""
    
    def __init__(self, storage: MemoryStorage):
        self.storage = storage
    
    def retrieve(self, request: ContextRequest) -> ContextResponse:
        """
        双路检索策略：
        1. 强制包含最近的 N 条记忆（短期记忆 STM）
        2. 用剩余的 token 空间填充语义相关的旧记忆（长期记忆 LTM）
        3. 对 LTM 进行上下文邻近度 + 语义相似度加权排序
        """
        try:
            # 1. 获取短期记忆 (STM) - 最近 5 条
            recent_limit = 5
            stm_memories = self.storage.get_recent(
                user_id=request.user_id,
                session_id=request.session_id,
                limit=recent_limit,
                branch_ids=request.branch_ids
            )
            
            # 去重，保留最新
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
                stm_memories.sort(key=lambda x: x.created_at or datetime.min)
                return ContextResponse(
                    memories=stm_memories,
                    user_profile=self.storage.get_user_profile(request.user_id) if request.include_profile else None,
                    total_tokens=current_tokens,
                    strategy_used="stm_only"
                )

            # 2. 获取长期记忆 (LTM)
            ltm_memories = []
            if remaining_tokens > 100 and request.query and len(request.query.strip()) > 1:
                query_embedding = embed_text(request.query)
                query_embedding_list = query_embedding.tolist()[0] if len(query_embedding.shape) > 1 else query_embedding.tolist()
                
                # 检索候选（含 embedding）
                semantic_candidates = self.storage.semantic_search(
                    user_id=request.user_id,
                    query_embedding=query_embedding_list,
                    limit=50,
                    min_similarity=memory_config.MIN_SIMILARITY,
                    session_id=request.session_id,
                    branch_ids=request.branch_ids
                )
                
                if semantic_candidates:
                    scored_candidates = self._score_candidates(semantic_candidates, stm_ids)
                    
                    # 按综合分数排序
                    scored_candidates.sort(key=lambda x: x[1], reverse=True)
                    
                    # 填充 LTM 到剩余空间
                    candidate_memories = [m for m, _ in scored_candidates]
                    deduped_candidates = self._deduplicate_memories(candidate_memories)
                    
                    for mem in deduped_candidates:
                        mem_tokens = mem.tokens_count or (len(mem.content) // 2)
                        if remaining_tokens - mem_tokens >= 0:
                            ltm_memories.append(mem)
                            remaining_tokens -= mem_tokens
                        else:
                            break
            
            # 3. 合并最终结果 (LTM + STM)
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
            logger.exception(f"检索记忆失败: {e}")
            self.storage.db.rollback()
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="error"
            )
    
    def _score_candidates(
        self,
        semantic_candidates: List[Tuple[MemoryEntry, float]],
        stm_ids: set,
    ) -> List[Tuple[MemoryEntry, float]]:
        """
        对候选记忆评分：similarity × 0.6 + context_proximity × 0.2 + importance × 0.2
        """
        # 过滤掉 STM 中已有的
        filtered = [(m, s) for m, s in semantic_candidates if m.id not in stm_ids]
        if not filtered:
            return []
        
        # 计算上下文邻近度
        context_scores = self._compute_context_proximity(filtered)
        
        scored = []
        for i, (memory, similarity) in enumerate(filtered):
            importance = memory.importance_score or 0.5
            ctx = context_scores[i]
            final_score = (
                similarity * 0.6 +
                ctx * 0.2 +
                importance * 0.2
            )
            scored.append((memory, final_score))
        
        return scored
    
    def _compute_context_proximity(
        self,
        candidates: List[Tuple[MemoryEntry, float]],
    ) -> List[float]:
        """
        计算每条候选的上下文邻近度分数。
        
        算法：
        1. 按 created_at 正序排列（旧 → 新）
        2. 计算候选集中每对记忆的余弦相似度
        3. 对每条记忆，找"比它新且与它相似"的最近一条，计算 gap
        4. 首次提及的话题（无更近的相似记忆）→ proximity = 0
        5. 旧话题 → proximity = 1 / (1 + gap × decay_factor)
        """
        n = len(candidates)
        if n <= 1:
            return [0.0]
        
        # 按 created_at 正序排列（旧 → 新），记录原始索引
        indexed = [(i, m, s) for i, (m, s) in enumerate(candidates)]
        indexed.sort(key=lambda x: x[1].created_at or datetime.min)
        
        # 提取 embedding 向量
        embeddings = []
        for _, mem, _ in indexed:
            if mem.embedding:
                embeddings.append(np.array(mem.embedding, dtype=np.float32))
            else:
                embeddings.append(None)
        
        # 计算归一化向量（用于余弦相似度）
        norms = []
        for emb in embeddings:
            if emb is not None:
                norm = np.linalg.norm(emb)
                norms.append(emb / norm if norm > 0 else emb)
            else:
                norms.append(None)
        
        # 计算每条记忆的上下文邻近度
        context_raw = [0.0] * n
        
        for i in range(n):
            # 找比 i 新（j > i）且与 i 相似（余弦 > 阈值）的最近一条
            nearest_gap = None
            for j in range(i + 1, n):
                if norms[i] is None or norms[j] is None:
                    continue
                pairwise_sim = float(np.dot(norms[i], norms[j]))
                if pairwise_sim >= _TOPIC_SIMILARITY_THRESHOLD:
                    nearest_gap = j - i
                    break  # 找到最近的就停（j 递增，越后面 gap 越大）
            
            if nearest_gap is not None:
                context_raw[i] = 1.0 / (1.0 + nearest_gap * _CONTEXT_DECAY_FACTOR)
            else:
                # 首次提及的话题：proximity = 0
                context_raw[i] = 0.0
        
        # 还原原始顺序
        result = [0.0] * n
        for sorted_idx, (orig_idx, _, _) in enumerate(indexed):
            result[orig_idx] = context_raw[sorted_idx]
        
        return result
    
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
