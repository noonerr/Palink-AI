import os
from typing import Optional


class MemoryConfig:
    # 向量维度必须与 provider 实际产出一致，三档对照（2026-09-29 世界书向量 P4 勘定）：
    #   ollama+bge-m3=1024（docker-compose 口径）/
    #   fastembed+BAAI/bge-small-zh-v1.5=512（本文件默认）/
    #   SimpleHash 兜底=384（embedder.py）。
    # 漂移会让世界书向量表作废、记忆检索报错（世界书侧已加门禁拒绝建表并降级，
    # 见 worldbook_vector_service._declared_dim_matches_provider）；
    # 换嵌入模型必须同步改此值并重测相似度阈值（见下方 MIN_SIMILARITY 注释）。
    VECTOR_DIMENSION: int = int(os.getenv("MEMORY_VECTOR_DIMENSION", "512"))
    EMBEDDING_PROVIDER: str = os.getenv("MEMORY_EMBEDDING_PROVIDER", "fastembed")
    LOCAL_MODEL_NAME: str = os.getenv("MEMORY_LOCAL_MODEL", "BAAI/bge-small-zh-v1.5")
    OPENAI_MODEL: str = os.getenv("MEMORY_OPENAI_MODEL", "text-embedding-3-small")
    # Ollama 嵌入（与另一个项目统一向量引擎，2026-08-18）
    OLLAMA_HOST: str = os.getenv("OLLAMA_HOST", "http://host.docker.internal:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "bge-m3")
    OLLAMA_TIMEOUT: float = float(os.getenv("OLLAMA_TIMEOUT", "30.0"))
    MAX_MEMORIES_PER_QUERY: int = int(os.getenv("MEMORY_MAX_RESULTS", "30"))
    SEMANTIC_WEIGHT: float = float(os.getenv("MEMORY_SEMANTIC_WEIGHT", "0.7"))
    TIME_WEIGHT: float = float(os.getenv("MEMORY_TIME_WEIGHT", "0.2"))
    IMPORTANCE_WEIGHT: float = float(os.getenv("MEMORY_IMPORTANCE_WEIGHT", "0.1"))
    # 相似度下限（cosine）。0.3 对 bge-m3 中文语料基本失效——2026-09-22 实测：
    # 无关查询（"今天上海天气怎么样"）top1=0.459 且 75/77 条过阈值，阈值形同虚设。
    # 0.5 是经验分界：无关查询全部归零，相关查询（0.693/0.748）仍保留 7-34 条。
    # 换嵌入模型（非 bge-m3）后必须重新实测校准，勿沿用此值。
    MIN_SIMILARITY: float = float(os.getenv("MEMORY_MIN_SIMILARITY", "0.5"))
    MEMORY_TABLE_NAME: str = "conversation_memories"
    PROFILE_TABLE_NAME: str = "user_profiles"
    ENABLED: bool = os.getenv("MEMORY_ENABLED", "true").lower() == "true"

    # ── 语义切分（方案 B，2026-08-22，详见 SPEC_向量记忆语义切分_2026-08-22.md）──
    # 总开关：false 时 assistant 回复回到整条单向量入库（回滚开关）
    SEMANTIC_CHUNKING: bool = os.getenv("MEMORY_SEMANTIC_CHUNKING", "true").lower() == "true"
    # 回复低于此长度不切分（零额外成本）
    CHUNK_TRIGGER_CHARS: int = int(os.getenv("MEMORY_CHUNK_TRIGGER_CHARS", "250"))
    # 块下限：不足则并入邻居
    CHUNK_MIN_CHARS: int = int(os.getenv("MEMORY_CHUNK_MIN_CHARS", "120"))
    # 块上限：超过则句边界强制再分（保证向量聚焦）
    CHUNK_MAX_CHARS: int = int(os.getenv("MEMORY_CHUNK_MAX_CHARS", "450"))
    # 切分策略：structural = 只用文本里客观存在的结构边界（段落/对话轮/括号动作），
    # 零嵌入调用；semantic = 每句嵌入找话题断点（旧行为，保留作一键回退）。
    #
    # ⚠️ 2026-10-07 实测换默认值为 structural（跨 3 会话 18 条真实长回复，
    # ground truth 唯一性校验，n=21 真实回指查询 / n=27 片段查询）：
    #   成本   structural 1631ms/条 vs semantic 3822ms/条（省 57%，少一批嵌入）
    #   召回   真实用户消息回指前文时 top1 43% vs 33%，top3 81% vs 57%
    #   ⇒ semantic 更贵**且不更准**。它唯一的优势在"片段查询"口径（78% vs 74%），
    #   那个口径的查询本身就是块内某句的片段，对"块重新编码"的方案天然不利，
    #   贴近不了生产（生产查询是用户那句 29 字的话）。
    CHUNK_STRATEGY: str = os.getenv("MEMORY_CHUNK_STRATEGY", "structural")
    # structural 策略的目标块长（实际切点落在 [0.55×, 1.35×] 区间的结构边界上）
    CHUNK_TARGET_CHARS: int = int(os.getenv("MEMORY_CHUNK_TARGET_CHARS", "250"))
    # 断点检测：距离绝对下限。**注意它只是兜底下限，不是主阈值** ——
    # semantic_chunker._detect_breakpoints 的判定是 floor = max(epsilon, mean(dists))，
    # 即 epsilon 一旦低于该文本的 mean，阈值就由 mean 主导（随文本自适应）。
    #
    # ⚠️ 2026-10-07 订正（原值 0.12 是把自适应机制废掉的元凶）：
    #   bge-m3 在本项目语料上相邻句余弦距离实测 max=0.101 / mean=0.070 /
    #   p99=0.098（n=191），0.12 **比最大值还高** ⇒ 命中率 0.0% ⇒ 断点恒为 0
    #   ⇒ 语义切分完全失效，实际退化成「按 CHUNK_MAX_CHARS 在句边界硬切」。
    #   降到 0.05 后进入自适应模式（实测 0.075→0.050 结果完全不动，证明由 mean 主导），
    #   换嵌入模型也无需重调。详见
    #   docs/_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md §8
    CHUNK_DISTANCE_EPSILON: float = float(os.getenv("MEMORY_CHUNK_DIST_EPSILON", "0.05"))
    # 相似度比较的缓冲窗口（±句数）
    CHUNK_BUFFER_WINDOW: int = int(os.getenv("MEMORY_CHUNK_BUFFER", "1"))
    # 碎句并入阈值（字符）
    CHUNK_MIN_SENTENCE_CHARS: int = int(os.getenv("MEMORY_CHUNK_MIN_SENTENCE_CHARS", "20"))
    # 检索命中块时是否自动携带前后相邻块
    NEIGHBOR_EXPAND: bool = os.getenv("MEMORY_NEIGHBOR_EXPAND", "true").lower() == "true"

    # ── 检索查询构造（[MEM-QUERY-2026-10-09] 实测订正，详见
    #   docs/_active/report/REPORT_记忆最优解复核_关键词路与查询构造_2026-10-09.md）──
    # 2026-10-07 定的「最近 4 条拼接 + 尾截 600」实测**更差**：那 600 字里本轮问题
    # 只占 3.4%（n=50 中位），其余是上一条回复的尾巴（还夹着 <UpdateVariable> 与
    # 【声音：…】）。同一批题上：窗口查询 top1 6.2%，换成「本轮消息」22.9%，
    # 单次耗时 3009ms → 619ms（要嵌的文本从 600 字降到 30 字）。
    #   current = 只用本轮消息（清洗后）；过短时才回退拼接最近 1 条
    #   window  = 2026-10-07 的旧行为（一键回退开关）
    QUERY_MODE: str = os.getenv("MEMORY_QUERY_MODE", "current")
    # 回退阈值：本轮消息清洗后不足该字数才拼接上下文（生产用户消息中位 29 字，
    # 12/101 条不足 10 字 —— 太短的句子单独嵌入确实没有信息量）
    QUERY_MIN_CHARS: int = int(os.getenv("MEMORY_QUERY_MIN_CHARS", "15"))
    # 回退时拼接的上文长度上限（字符，取最近 1 条消息的**尾部**）
    QUERY_FALLBACK_CHARS: int = int(os.getenv("MEMORY_QUERY_FALLBACK_CHARS", "120"))

    # ── 关键词路（[MEM-HYBRID 2026-10-09]）──
    # 纯向量路会漏掉专名/数字/改口这类「字面重合但语义向量接近」的情况。
    # 实测两条路是**相乘**关系：只修查询 top1 22.9%，只加关键词路 6.2%，
    # 两者都做 47.9%（注入命中 31.2% → 81.2%，中位排名 17 → 2）。
    #   0    = 关闭（行为与改动前完全一致，一键回退）
    #   0.7  = 实测推荐值（p47：48 道原题 + 48 道同义改写题双题集扫描）
    #          w_kw   0.0   0.2   0.35  0.5   0.7   1.0
    #          原题  22.9% 41.7% 41.7% 41.7% 41.7% 43.8%   ← top1
    #          改写  20.8% 27.1% 29.2% 31.2% 33.3% 31.2%   ← top1
    #          取"两套题里较差的那一侧"最大化 ⇒ 0.7（33.3%）。
    #          注意：原题集是从原文句子生成的，天然字面重合度高，纯关键词在上面
    #          还能到 58%，但同义改写后掉到 31% —— 单看原题集定权重会过拟合，
    #          所以额外造了改写题集来反向校验。
    HYBRID_WEIGHT: float = float(os.getenv("MEMORY_HYBRID_WEIGHT", "0.7"))
    # 关键词路取多少条候选参与融合（pg_trgm 粗筛，再在 Python 侧用 bigram 精排）
    HYBRID_KW_CANDIDATES: int = int(os.getenv("MEMORY_HYBRID_KW_CANDIDATES", "50"))
    # 关键词分下限（查询字符 bigram 被该行覆盖的比例；低于此值视为无字面关联）
    HYBRID_KW_MIN_COVERAGE: float = float(os.getenv("MEMORY_HYBRID_KW_MIN_COV", "0.12"))
    # RRF 平滑常数（经典 60；越大越接近"只看排名先后"）
    HYBRID_RRF_K: int = int(os.getenv("MEMORY_HYBRID_RRF_K", "60"))

    # ── 邻居扩展独立预算（[MEM-NEIGHBOR 2026-10-09]）──
    # _expand_chunk_neighbors 原先与检索**共用** request.max_tokens，而预算本来就被
    # 填满（实测 1480/1500）⇒ 恒 `total + t > max_tokens` ⇒ **一条都补不进来**
    # （实测 retriever 10 条 → get_context 10 条，+0）。切开的块因此永远只有半截。
    # 这里给它独立额度 = max_tokens × 该比例；0 = 关闭（回到旧行为）。
    NEIGHBOR_EXTRA_RATIO: float = float(os.getenv("MEMORY_NEIGHBOR_EXTRA_RATIO", "0.3"))
    # 独立额度的硬上限（条数），防止长会话把记忆区撑大
    NEIGHBOR_MAX_ADDS: int = int(os.getenv("MEMORY_NEIGHBOR_MAX_ADDS", "4"))

    # ── NULL 向量自动回填（[EMB-BACKFILL] 2026-10-07，backfill.py）──
    # 轮询间隔秒数；<=0 关闭回填线程。宽限期内（默认 300s）的 NULL 行不回填——
    # 正常路径 store() 的异步首算几秒内就会补上，回填不抢活、避免双算。
    EMBED_BACKFILL_INTERVAL: float = float(os.getenv("MEMORY_EMBED_BACKFILL_INTERVAL", "600"))
    EMBED_BACKFILL_BATCH: int = int(os.getenv("MEMORY_EMBED_BACKFILL_BATCH", "32"))
    EMBED_BACKFILL_GRACE_SECONDS: float = float(os.getenv("MEMORY_EMBED_BACKFILL_GRACE", "300"))
    
    @classmethod
    def is_enabled(cls) -> bool:
        return cls.ENABLED
    
    @classmethod
    def validate(cls) -> bool:
        if cls.EMBEDDING_PROVIDER == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        return True


memory_config = MemoryConfig()
