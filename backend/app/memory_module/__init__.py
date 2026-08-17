"""
Memory Module for Palink-AI
轻量级长期记忆系统

功能特性:
- 语义检索 (pgvector)
- 混合排序 (语义+时间+重要性)
- 用户画像
- 可插拔架构

使用示例:
    # 方式1: 直接实例化
    from memory_module import MemoryService
    service = MemoryService(db_session)
    context = service.get_context(user_id, query)
    
    # 方式2: 依赖注入
    from memory_module import get_memory_service
    @app.get("/chat")
    async def chat(memory: MemoryService = Depends(get_memory_service)):
        ...

配置环境变量:
    MEMORY_ENABLED=true
    MEMORY_EMBEDDING_PROVIDER=local  # 或 openai
    MEMORY_VECTOR_DIMENSION=384
"""

from .service import MemoryService, get_memory_service
from .models import MemoryEntry, UserProfile, ContextResponse
from .config import memory_config

__version__ = "1.0.0"
__all__ = [
    "MemoryService",
    "get_memory_service",
    "MemoryEntry",
    "UserProfile",
    "ContextResponse",
    "memory_config",
]
