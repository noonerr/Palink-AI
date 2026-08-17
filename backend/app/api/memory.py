"""
记忆模块路由：压缩记忆 + 向量记忆
"""
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..memory_module.compression_service import MemoryCompressionService
from ..memory_module.service import MemoryService
from ..memory_module.storage import MemoryStorage
from ..memory_module.embedder import get_embedder, embed_text
from ..memory_module.config import memory_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/memory", tags=["memory"])


# ============================================================
# 请求模型
# ============================================================

class CompressRequest(BaseModel):
    session_id: str
    branch_id: Optional[str] = None
    model: str = ""
    compression_ratio: float = Field(default=0.5, ge=0.1, le=0.9)


class VectorStoreRequest(BaseModel):
    content: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    user_id: Optional[int] = None


class VectorRetrieveRequest(BaseModel):
    query: str
    top_k: int = Field(default=5, ge=1, le=50)
    user_id: Optional[int] = None
    filter: Dict[str, Any] = Field(default_factory=dict)


# ============================================================
# 压缩记忆 API（保留现有功能）
# ============================================================

@router.get("/stats")
def get_memory_stats(
    session_id: str,
    branch_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取会话记忆统计信息"""
    try:
        service = MemoryCompressionService(db)
        result = service.check_compression_needed(current_user.id, session_id, branch_id)
        stats = result.get("stats", {})
        return {
            "session_id": session_id,
            "branch_id": branch_id,
            "message_count": stats.get("message_count", 0),
            "token_count": stats.get("token_count", 0),
            "oldest_message_hours": stats.get("oldest_message_hours", 0),
            "compression_needed": result.get("needed", False),
            "compression_reason": result.get("reason", ""),
        }
    except Exception as e:
        logger.error(f"获取记忆统计失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get memory stats")


@router.get("/check-auto-compress")
def check_auto_compress(
    session_id: str,
    branch_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """检查是否需要自动压缩"""
    try:
        service = MemoryCompressionService(db)
        result = service.check_compression_needed(current_user.id, session_id, branch_id)
        return result
    except Exception as e:
        logger.error(f"检查自动压缩失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to check auto compression")


@router.post("/compress")
async def compress_memory(
    body: CompressRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """手动触发记忆压缩"""
    from ..models import ChatSession
    session = db.query(ChatSession).filter(
        ChatSession.id == body.session_id,
        ChatSession.user_id == current_user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        service = MemoryCompressionService(db)
        result = await service.compress_memory(
            user_id=current_user.id,
            session_id=body.session_id,
            compression_ratio=body.compression_ratio,
            branch_id=body.branch_id,
        )
        return result
    except Exception as e:
        logger.error(f"记忆压缩失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to compress memory")


# ============================================================
# 向量记忆 API（新增）
# ============================================================

@router.post("/vector/store")
async def vector_store(
    body: VectorStoreRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """存储向量记忆"""
    try:
        service = MemoryService(db)
        if not service.is_available():
            raise HTTPException(status_code=503, detail="Memory module is disabled")

        metadata = body.metadata or {}
        importance = float(metadata.get("importance", 0.5))
        topics = metadata.get("topics", [])
        if not topics and metadata.get("type"):
            topics = [metadata["type"]]

        memory_id = service.store_memory(
            user_id=current_user.id,
            session_id=metadata.get("session_id", "vector_api"),
            role=metadata.get("role", "user"),
            content=body.content,
            importance_score=importance,
            topics=topics,
        )

        if memory_id is None:
            raise HTTPException(status_code=500, detail="Failed to store memory")

        # 查询创建时间
        result = db.execute(
            text("SELECT created_at FROM conversation_memories WHERE id = :id"),
            {"id": memory_id},
        )
        row = result.fetchone()
        created_at = row.created_at if row else datetime.utcnow()

        return {
            "id": memory_id,
            "content": body.content,
            "metadata": metadata,
            "created_at": created_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"存储向量记忆失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to store vector memory")


@router.post("/vector/retrieve")
async def vector_retrieve(
    body: VectorRetrieveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """检索向量记忆"""
    try:
        embedding = embed_text(body.query)
        embedding_list = (
            embedding.tolist()[0] if len(embedding.shape) > 1 else embedding.tolist()
        )

        storage = MemoryStorage(db)
        results = storage.semantic_search(
            user_id=current_user.id,
            query_embedding=embedding_list,
            limit=body.top_k,
        )

        memories: List[Dict[str, Any]] = []
        for memory, score in results:
            memories.append({
                "id": memory.id,
                "content": memory.content,
                "score": round(score, 4),
                "metadata": {
                    "role": memory.role,
                    "importance": memory.importance_score,
                    "topics": memory.topics,
                    "session_id": memory.session_id,
                    "created_at": memory.created_at.isoformat() if memory.created_at else None,
                },
            })

        return {"memories": memories}
    except Exception as e:
        logger.error(f"检索向量记忆失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve vector memory")


@router.get("/vector/stats")
def vector_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """向量记忆统计信息"""
    try:
        result = db.execute(
            text("SELECT COUNT(*) FROM conversation_memories WHERE user_id = :user_id"),
            {"user_id": current_user.id},
        )
        total = result.scalar() or 0

        embedder = get_embedder()
        provider_map = {
            "SimpleHashEmbedder": "simple_hash",
            "FastEmbedEmbedder": "fastembed",
            "SentenceTransformerEmbedder": "sentencetransformer",
            "OpenAIEmbedder": "openai",
        }
        provider = provider_map.get(type(embedder).__name__, memory_config.EMBEDDING_PROVIDER)

        return {
            "total_memories": total,
            "embedding_provider": provider,
            "vector_dimension": embedder.dimension,
            "cache_enabled": True,
        }
    except Exception as e:
        logger.error(f"获取向量记忆统计失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get vector memory stats")
