import os
from typing import Optional


class MemoryConfig:
    VECTOR_DIMENSION: int = int(os.getenv("MEMORY_VECTOR_DIMENSION", "512"))
    EMBEDDING_PROVIDER: str = os.getenv("MEMORY_EMBEDDING_PROVIDER", "fastembed")
    LOCAL_MODEL_NAME: str = os.getenv("MEMORY_LOCAL_MODEL", "BAAI/bge-small-zh-v1.5")
    OPENAI_MODEL: str = os.getenv("MEMORY_OPENAI_MODEL", "text-embedding-3-small")
    MAX_MEMORIES_PER_QUERY: int = int(os.getenv("MEMORY_MAX_RESULTS", "30"))
    SEMANTIC_WEIGHT: float = float(os.getenv("MEMORY_SEMANTIC_WEIGHT", "0.7"))
    TIME_WEIGHT: float = float(os.getenv("MEMORY_TIME_WEIGHT", "0.2"))
    IMPORTANCE_WEIGHT: float = float(os.getenv("MEMORY_IMPORTANCE_WEIGHT", "0.1"))
    MIN_SIMILARITY: float = float(os.getenv("MEMORY_MIN_SIMILARITY", "0.3"))
    MEMORY_TABLE_NAME: str = "conversation_memories"
    PROFILE_TABLE_NAME: str = "user_profiles"
    ENABLED: bool = os.getenv("MEMORY_ENABLED", "true").lower() == "true"
    
    @classmethod
    def is_enabled(cls) -> bool:
        return cls.ENABLED
    
    @classmethod
    def validate(cls) -> bool:
        if cls.EMBEDDING_PROVIDER == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        return True


memory_config = MemoryConfig()
