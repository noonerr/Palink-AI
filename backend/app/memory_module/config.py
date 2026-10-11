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
    # 切分策略：sentence = 按句切（每句一条向量，2026-10-11 起默认）；
    # structural = 只用文本里客观存在的结构边界（段落/对话轮/括号动作），
    # 零嵌入调用；semantic = 每句嵌入找话题断点（旧行为，保留作一键回退）。
    #
    # ⚠️ 2026-10-07 实测换默认值为 structural（跨 3 会话 18 条真实长回复，
    # ground truth 唯一性校验，n=21 真实回指查询 / n=27 片段查询）：
    #   成本   structural 1631ms/条 vs semantic 3822ms/条（省 57%，少一批嵌入）
    #   召回   真实用户消息回指前文时 top1 43% vs 33%，top3 81% vs 57%
    #   ⇒ semantic 更贵**且不更准**。它唯一的优势在"片段查询"口径（78% vs 74%），
    #   那个口径的查询本身就是块内某句的片段，对"块重新编码"的方案天然不利，
    #   贴近不了生产（生产查询是用户那句 29 字的话）。
    #
    # ⚠️ 2026-10-11 短暂改为 sentence 后**已改回 structural** —— 当日实战配对评测
    #   否证了"句级更优"的前提。过程留档（避免后人重复踩）：
    #
    #   改句级的依据是 REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md
    #   （称"严格口径 top1 14.6% → 29.6%"）。但当日复跑其来源脚本
    #   `p38_granularity.py`（同一题集/同一语料/同一嵌入），实际输出为：
    #     句级 13.8% / 微块120字 13.8% / 现状块293字 9.1% / 大块600字 31.0%（top1）
    #   ⇒ **报告引用的 29.6% 在该脚本输出里找不到对应行**，疑似把 p34 的
    #   **宽松口径**（gold = 整条消息任意一块，句级天然占便宜）当成了严格口径。
    #   且该脚本句级组 n=29、块级组 n=55，**样本不可比**。
    #
    #   当日自建严格配对评测（P64，真实会话 f25daab6，57 题取两组都有 gold 的 36 道，
    #   两组用同一批原始消息文本切分、n 相同）：
    #     | 指标     | 块级   | 句级   | 块级更好 | 句级更好 |
    #     | 中位排名 | 3.0    | 12.5   | 25       | 8        |
    #     | top3     | 52.8%  | 27.8%  | 11       | 2        |
    #     | top1     | 25.0%  | 16.7%  | 7        | 4        |
    #     | 注入命中 | 80.6%  | 75.0%  | 8        | 6        |
    #   另有 **18 道题（33%）在句级下定位不到证据**（evidence 原文被句级边界切断），
    #   块级下可定位 ⇒ 句级不只是排名差，还会**丢证据**。
    #
    #   为什么与端到端结论看似矛盾：报告的端到端实验是**"6 条历史"**条件
    #   （历史覆盖少 ⇒ 依赖记忆提供内容，句级的精准片段有价值）；生产是 **24 条历史**
    #   （历史已覆盖近期 ⇒ 记忆只补早期细节，**能否准确命中那一条**比片段精准更重要）
    #   ⇒ 生产口径下块级更合适。
    #
    #   句级实现**完整保留**：`MEMORY_CHUNK_STRATEGY=sentence` 可一键切回，
    #   检索侧参数会随 EFFECTIVE_* 属性自动切到句级值。若将来要在"短历史"场景
    #   重新评估句级，先看 SPEC_句级记忆切分_2026-10-11.md §十二 的否证记录。
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

    # ── [CHUNK-SENTENCE 2026-10-11] 句级切分 + "按粒度自适应"的检索参数 ──
    #
    # **为什么检索侧参数要跟着切分策略走**：回退开关的语义必须是"回到改动前的行为"。
    # 若把邻居范围 / STM 条数 / 候选池写死成句级值，回退到 structural 后块级也会用新值，
    # 回退就不是等价开关 —— 仓库既有教训：`test_structural_and_semantic_produce_comparable_sizes`
    # 就是为"回退必须是等价开关"立的。故三组参数各存块级值与句级值，由 EFFECTIVE_* 属性取用。
    #
    # 单轮最多切几句。超限**整体退回结构切分**，而不是截断 ——
    # 截断会丢内容，破坏"记忆 = 消息镜像"的不变式（见 mirror.py 顶部声明）。
    #
    # ⚠️ 2026-10-11 实战实测后由 40 上调为 **120**：初版 40 卡在真实分布的中位数附近，
    #   实测会话 f25daab6 的 47 条回复里 **14 条（29.8%）句数 > 40 ⇒ 退回块级**，
    #   即"句级在生产里近三成不生效"。句数分布：中位 37 / 均值 38 / 最大 58；
    #   全库最长回复 3458 字 ≈ 93 句。取 120 可覆盖全部分布。
    #   成本（实测，同一条 3458 字回复）：嵌入 58 条 3675ms、80 条 3610ms、
    #   116 条 3680ms —— **58 条之后进入平台期，成本由总字数决定、与条数几乎无关**，
    #   所以提高上限几乎没有代价（切细不增加总字数）。
    SENTENCE_MAX_CHUNKS: int = int(os.getenv("MEMORY_SENTENCE_MAX_CHUNKS", "120"))
    # 邻居扩展范围（±N 条）。块级一条 = 一个完整语义单元，±1 够；
    # 句级一条 = 一句话，±1 仍是"三句碎片"读不通，±2 才接近一个语义单元。
    # 两者都被 NEIGHBOR_MAX_ADDS（现 4）封顶，不会因半径放大而失控。
    SENTENCE_NEIGHBOR_RADIUS: int = int(os.getenv("MEMORY_SENTENCE_NEIGHBOR_RADIUS", "2"))
    BLOCK_NEIGHBOR_RADIUS: int = int(os.getenv("MEMORY_BLOCK_NEIGHBOR_RADIUS", "1"))
    # 短期记忆（无条件注入的最近 N 条）。句级下"最近 5 条"很可能全部来自同一条
    # 回复的 5 句话，覆盖不了最近几轮 —— 与 STM 的设计意图（近期上下文）相悖。
    # 12 句 × 约 30 字 ≈ 360 字，覆盖 2~3 轮，占记忆预算（4000 内部单位）不到 10%。
    SENTENCE_STM_LIMIT: int = int(os.getenv("MEMORY_SENTENCE_STM_LIMIT", "12"))
    BLOCK_STM_LIMIT: int = int(os.getenv("MEMORY_BLOCK_STM_LIMIT", "5"))
    # STM 补位系数：**每条被排除消息平均占多少条记忆**，用于把"排除集过滤后
    # STM 被吃光"补回来（见 retriever 的 `limit=recent_limit + len(exclude) * 系数`）。
    #
    # ⚠️ 这是既有缺陷的修复，不是句级引入的：生产实测（2026-10-11，会话
    # f25daab6，排除最近 5 条消息）取 17 条**全部命中排除集 ⇒ STM 剩余 0 条**；
    # 块级时代 `limit = 5 + 5 = 10` 同样全中 ⇒ 也是 0。差别只是句级把目标从
    # 5 条抬到 12 条，缺口更大、`rule` 模式（STM 是唯一内容）更加形同虚设。
    # 块级 1 = 保持改动前公式逐字不变；句级 12 = 一条长回复约 12 句（上限 40
    # 由 SENTENCE_MAX_CHUNKS 约束，取中位而非上限以免单次取数过大）。
    # 成本实测（同会话）：limit 10 → 0.6ms、17 → 0.5ms、72 → 1.1ms，可忽略。
    SENTENCE_STM_EXCLUDE_FACTOR: int = int(
        os.getenv("MEMORY_SENTENCE_STM_EXCLUDE_FACTOR", "12")
    )
    BLOCK_STM_EXCLUDE_FACTOR: int = int(os.getenv("MEMORY_BLOCK_STM_EXCLUDE_FACTOR", "1"))
    # 语义检索候选池（粗筛出参与排序的条数；最终注入多少由 token 预算决定）。
    #
    # ⚠️ 2026-10-11 复核订正：初版取 120，**依据算错了**。原注释写"120 条 ≈ 块级
    # 50 条的信息量"，但 50×295 字 = 14750 字 ≠ 120×30 字 = 3600 字，差 4 倍。
    # 按"注入字数对齐"重算：块级 50 条候选最终注入 26 条 × 295 字 = 7670 字
    # （受 token 预算限制），句级要注入同量字数需 7670/30 ≈ **256** 条；
    # 另按预算直接算：剩余预算约 3820 内部单位 ÷ 15 单位/条 ≈ **254** 条。两者一致。
    # ⇒ 取 **260**。
    #
    # 不放大就会让候选池成为瓶颈：120 条 × 15 单位 = 1800 单位，只用到 4000 档
    # 预算的 45%，**实际注入 token 反而低于块级**（块级 26 条 = 3822 单位），
    # 与"句级化是为了更好利用预算"的初衷相反。
    # 成本：库内精确扫描取 top-260 vs top-120 差异在毫秒级（实测 top-50 为 14.0ms）；
    # 融合与打分都是纯内存操作，可忽略。
    SENTENCE_CANDIDATE_LIMIT: int = int(os.getenv("MEMORY_SENTENCE_CANDIDATE_LIMIT", "260"))
    BLOCK_CANDIDATE_LIMIT: int = int(os.getenv("MEMORY_BLOCK_CANDIDATE_LIMIT", "50"))

    @property
    def IS_SENTENCE_LEVEL(self) -> bool:
        """当前是否为句级切分。供检索侧按粒度取参（回退时自动回到块级值）。"""
        return self.CHUNK_STRATEGY == "sentence"

    @property
    def EFFECTIVE_NEIGHBOR_RADIUS(self) -> int:
        return (
            self.SENTENCE_NEIGHBOR_RADIUS
            if self.IS_SENTENCE_LEVEL
            else self.BLOCK_NEIGHBOR_RADIUS
        )

    @property
    def EFFECTIVE_STM_LIMIT(self) -> int:
        return self.SENTENCE_STM_LIMIT if self.IS_SENTENCE_LEVEL else self.BLOCK_STM_LIMIT

    @property
    def EFFECTIVE_STM_EXCLUDE_FACTOR(self) -> int:
        return (
            self.SENTENCE_STM_EXCLUDE_FACTOR
            if self.IS_SENTENCE_LEVEL
            else self.BLOCK_STM_EXCLUDE_FACTOR
        )

    @property
    def EFFECTIVE_CANDIDATE_LIMIT(self) -> int:
        return (
            self.SENTENCE_CANDIDATE_LIMIT
            if self.IS_SENTENCE_LEVEL
            else self.BLOCK_CANDIDATE_LIMIT
        )

    @classmethod
    def is_enabled(cls) -> bool:
        return cls.ENABLED
    
    @classmethod
    def validate(cls) -> bool:
        if cls.EMBEDDING_PROVIDER == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        return True


memory_config = MemoryConfig()
