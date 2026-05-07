"""
记忆模块路由：压缩、统计、自动检查
"""
import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..memory_module.compression_service import MemoryCompressionService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/memory", tags=["memory"])


class CompressRequest(BaseModel):
    session_id: str
    branch_id: Optional[str] = None
    model: str = ""
    compression_ratio: float = Field(default=0.5, ge=0.1, le=0.9)


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
