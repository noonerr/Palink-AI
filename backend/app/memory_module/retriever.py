"""
记忆检索引擎 - 混合检索
支持语义搜索 + 上下文邻近度 + 重要性权重
"""

from typing import List, Dict, Tuple
from datetime import datetime, timedelta, timezone
import logging
import hashlib
import numpy as np

from .storage import MemoryStorage, _resolve_search_scope
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
        - rule 模式：仅使用最近 N 条记忆（纯上下文），不做向量语义搜索
        - vector 模式：
          1. 强制包含最近的 N 条记忆（短期记忆 STM）
          2. 用剩余的 token 空间填充语义相关的旧记忆（长期记忆 LTM）
          3. 对 LTM 进行上下文邻近度 + 语义相似度加权排序

        [T-跨卡串味修复 2026-10-03] 角色维度：``request.character_id`` 非空且
        ``session_id`` 为空时，STM/LTM 两条路都按 user+character 过滤，
        避免退化成用户级全量召回（修复前 A 卡会召回 B 卡的记忆）。
        实际作用域通过 ``ContextResponse.scope`` 回传（"session" /
        "character" / "user"），"user" = 降级，调用方可据此判断。
        """
        # [T-跨卡串味修复] 本次召回作用域，三条返回路径共用（可观测性）。
        scope = _resolve_search_scope(request.session_id, request.character_id)
        try:
            # 1. 获取短期记忆 (STM) - 最近 5 条
            recent_limit = 5
            # D3 修复: ST protect 语义 —— 排除最近消息的记忆镜像（调用方传入最近
            # N 条消息 id；命中 message_id 的条目不注入，历史窗口已含原文）。
            # 多取 len(exclude_ids) 条补位，保证过滤后 STM 数量稳定。
            exclude_ids = set(request.exclude_message_ids or [])
            stm_memories = self.storage.get_recent(
                user_id=request.user_id,
                session_id=request.session_id,
                limit=recent_limit + len(exclude_ids),
                branch_ids=request.branch_ids,
                character_id=request.character_id,
                branch_scopes=request.branch_scopes,
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

            # D3: 过滤最近消息镜像（message_id 命中排除集；NULL message_id 的
            # 存量行永不排除——按既定边界不做回填）
            if exclude_ids:
                stm_memories = [
                    m for m in stm_memories if m.message_id not in exclude_ids
                ][:recent_limit]

            # 计算 STM 占用的 tokens
            current_tokens = sum(m.tokens_count or (len(m.content) // 2) for m in stm_memories)

            # ── rule 模式：纯上下文，只返回最近记忆 ──
            if request.memory_mode == "rule":
                stm_memories.sort(key=lambda x: x.created_at or datetime.min)
                user_profile = None
                if request.include_profile:
                    user_profile = self.storage.get_user_profile(request.user_id)
                return ContextResponse(
                    memories=stm_memories,
                    user_profile=user_profile,
                    total_tokens=current_tokens,
                    strategy_used="rule_stm_only",
                    scope=scope,
                )
            
            # ── vector 模式：STM + LTM 语义检索 ──
            remaining_tokens = request.max_tokens - current_tokens
            
            # 如果 STM 已经占满窗口，直接返回 STM
            if remaining_tokens <= 0:
                logger.info(f"短期记忆已占满窗口 ({current_tokens} tokens)，跳过长期检索")
                stm_memories.sort(key=lambda x: x.created_at or datetime.min)
                return ContextResponse(
                    memories=stm_memories,
                    user_profile=self.storage.get_user_profile(request.user_id) if request.include_profile else None,
                    total_tokens=current_tokens,
                    strategy_used="stm_only",
                    scope=scope,
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
                    branch_ids=request.branch_ids,
                    character_id=request.character_id,
                    branch_scopes=request.branch_scopes,
                )
                
                if semantic_candidates:
                    # D3: LTM 侧同样排除最近消息镜像
                    # [TUPLE-UNPACK-FIX 2026-10-07] semantic_search 返回的是
                    # List[Tuple[MemoryEntry, float]]，逐项必须按 (mem, sim) 解包。
                    # 旧写法对元组取 .message_id ⇒ AttributeError ⇒ 被本函数 except 兜住
                    # 返回空结果 ⇒ **记忆注入恒为 0**（连 STM 一起丢）。
                    # 已坏 5 周（2026-08-29 ff9c1e7 引入）。下游 _score_candidates /
                    # _compute_context_proximity 都是正确解包写法，可对照。
                    if exclude_ids:
                        semantic_candidates = [
                            (mem, sim) for mem, sim in semantic_candidates
                            if mem.message_id not in exclude_ids
                        ]

                    # [HYBRID-KW 2026-10-09] 关键词路：与向量路互补，RRF 融合。
                    # 开关 = memory_config.HYBRID_WEIGHT：置 0 则整条路不调用，
                    # 走下面纯粹的 _score_candidates，与 2026-10-09 前逐条等价。
                    kw_candidates: List[Tuple[MemoryEntry, float]] = []
                    if memory_config.HYBRID_WEIGHT > 0:
                        kw_candidates = self.storage.keyword_search(
                            user_id=request.user_id,
                            query_text=request.query,
                            limit=50,
                            min_coverage=memory_config.HYBRID_KW_MIN_COVERAGE,
                            session_id=request.session_id,
                            branch_ids=request.branch_ids,
                            character_id=request.character_id,
                            branch_scopes=request.branch_scopes,
                            candidates=memory_config.HYBRID_KW_CANDIDATES,
                        )
                        if exclude_ids and kw_candidates:
                            kw_candidates = [
                                (mem, cov) for mem, cov in kw_candidates
                                if mem.message_id not in exclude_ids
                            ]

                    if kw_candidates:
                        scored_candidates = self._fuse_rrf(
                            semantic_candidates, kw_candidates, stm_ids,
                            w_kw=memory_config.HYBRID_WEIGHT,
                            k=memory_config.HYBRID_RRF_K,
                        )
                    else:
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
            
            # [NEIGHBOR-DETERMINISM 2026-10-09] 记录**相关度序**（LTM 强 → 弱，
            # 再拼 STM）。合并后的 final_memories 是时间序，用于注入排版没问题，
            # 但"邻居扩展该先补哪一条"必须按相关度：否则 max_adds 封顶生效时，
            # 谁先被扩到取决于 set/dict 迭代顺序，同一问题两次跑会得到不同的
            # 邻居集合（实测 3167 / 4028 字符）。
            relevance_order = ltm_memories + stm_memories

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
                strategy_used="dual_path_stm_ltm",
                scope=scope,
                relevance_order=relevance_order,
            )
            
        except Exception as e:
            logger.exception(f"检索记忆失败: {e}")
            self.storage.db.rollback()
            return ContextResponse(
                memories=[],
                user_profile=None,
                total_tokens=0,
                strategy_used="error",
                scope=scope,
            )
    
    def _fuse_rrf(
        self,
        semantic_candidates: List[Tuple[MemoryEntry, float]],
        kw_candidates: List[Tuple[MemoryEntry, float]],
        stm_ids: set,
        w_kw: float,
        k: int,
    ) -> List[Tuple[MemoryEntry, float]]:
        """[HYBRID-KW 2026-10-09] 倒数排名融合（Reciprocal Rank Fusion）。

        只吃**名次**不吃分数：向量相似度（0~1 的余弦）和关键词覆盖率（0~1 的
        字面占比）不是同一量纲，直接加权相加等于让覆盖率这种"天然偏低"的信号
        永远输给余弦。RRF 把两路各自排序后按名次融合，是这类跨量纲融合里最稳
        的做法（Cormack et al. 2009，k=60 为原论文推荐的平滑常数）。

        score = 1/(k + rank_dense) + w_kw × 1/(k + rank_kw)

        - ``w_kw`` = 0 时**本函数不会被调用**（调用方直接走 _score_candidates），
          所以这里的 w_kw 恒 > 0。
        - 只在两路 top-50 的并集上算：粗筛/阈值之外的条目名次差到不影响结果，
          却会把分母推大、稀释头部差异。
        - 命中 STM 的条目直接剔除（与 _score_candidates 同口径，避免重复注入）。

        融合后**不再叠 _score_candidates 的 importance/上下文邻近度加权**：p41
        实测就是用纯 RRF 名次装配的，再叠一层等于引入未经验证的排序因素。
        """
        dense_pool = [m for m, _ in semantic_candidates]
        kw_pool = [m for m, _ in kw_candidates]

        dense_rank = {m.id: r for r, m in enumerate(dense_pool)}
        kw_rank = {m.id: r for r, m in enumerate(kw_pool)}

        by_id: Dict[int, MemoryEntry] = {}
        for m in dense_pool:
            by_id[m.id] = m
        for m in kw_pool:
            # 关键词路构造的条目 embedding 为 None；若同一条两路都命中，
            # 保留带向量的那个（下游去重/装配都不用向量，但留着更保值）
            if m.id not in by_id or by_id[m.id].embedding is None:
                by_id[m.id] = m

        scored: List[Tuple[MemoryEntry, float]] = []
        for mid, mem in by_id.items():
            if mid in stm_ids:
                continue
            rd = dense_rank.get(mid)
            rk = kw_rank.get(mid)
            if rd is None and rk is None:
                continue
            s = 0.0
            if rd is not None:
                s += 1.0 / (k + rd)
            if rk is not None:
                s += w_kw * 1.0 / (k + rk)
            scored.append((mem, s))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored

    def _score_candidates(
        self,
        semantic_candidates: List[Tuple[MemoryEntry, float]],
        stm_ids: set,
    ) -> List[Tuple[MemoryEntry, float]]:
        """
        对候选记忆评分：similarity × 0.6 + context_proximity × 0.2 + (importance − 0.5) × 0.2

        [IMP-CENTER 2026-10-07] importance 项**居中**（减去默认值 0.5）。此前写法
        ``importance × 0.2`` 里，自动入库的记忆 importance 恒为默认 0.5（写入点
        全部硬编码，前端无任何设置入口），等于给所有候选加了常数 +0.1——不改变
        排序，却让这 20% 权重"假装存在"。居中后：
        - 默认 0.5 的行贡献恰好为 0，排序在默认行之间与旧公式**逐条等价**
          （旧式每条多加的 0.1 是同一常数，不改变相对次序）；
        - 手动经 /api/memory/vector/store 设置过 importance 的行仍按偏离 0.5
          的幅度 ±0.1 内浮动，人工加权能力保留（数据列与 API 均不动）。
        """
        # 过滤掉 STM 中已有的
        filtered = [(m, s) for m, s in semantic_candidates if m.id not in stm_ids]
        if not filtered:
            return []

        # 计算上下文邻近度
        context_scores = self._compute_context_proximity(filtered)

        scored = []
        for i, (memory, similarity) in enumerate(filtered):
            # [IMP-CENTER 2026-10-07] 显式判 None 而非 `or 0.5`：旧写法把手动
            # 设置的合法 0.0 也当成默认值吞掉（falsy 陷阱），居中化后 0.0 的
            # −0.1 惩罚开始有实际语义，必须区分"没设"和"设为零"。
            importance = (
                memory.importance_score
                if memory.importance_score is not None
                else 0.5
            )
            ctx = context_scores[i]
            final_score = (
                similarity * 0.6 +
                ctx * 0.2 +
                (importance - 0.5) * 0.2
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
