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
