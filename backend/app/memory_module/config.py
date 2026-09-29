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
    # 断点检测：局部峰值需超过的距离绝对下限（配合全体均值过滤噪声峰）；
    # 对话题跳变数量不敏感（全局阈值法在多跳变短文本上会漏切）
    CHUNK_DISTANCE_EPSILON: float = float(os.getenv("MEMORY_CHUNK_DIST_EPSILON", "0.12"))
    # 相似度比较的缓冲窗口（±句数）
    CHUNK_BUFFER_WINDOW: int = int(os.getenv("MEMORY_CHUNK_BUFFER", "1"))
    # 碎句并入阈值（字符）
    CHUNK_MIN_SENTENCE_CHARS: int = int(os.getenv("MEMORY_CHUNK_MIN_SENTENCE_CHARS", "20"))
    # 检索命中块时是否自动携带前后相邻块
    NEIGHBOR_EXPAND: bool = os.getenv("MEMORY_NEIGHBOR_EXPAND", "true").lower() == "true"
    
    @classmethod
    def is_enabled(cls) -> bool:
        return cls.ENABLED
    
    @classmethod
    def validate(cls) -> bool:
        if cls.EMBEDDING_PROVIDER == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        return True


memory_config = MemoryConfig()
