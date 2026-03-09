"""
记忆模块路由：压缩、统计、自动检查
"""
import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..memory_module.compression_service import MemoryCompressionService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/memory", tags=["memory"])


class CompressRequest(BaseModel):
    session_id: str
    model: str = ""
    compression_ratio: float = 0.5


@router.get("/stats")
def get_memory_stats(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取会话记忆统计信息"""
    try:
        service = MemoryCompressionService(db)
        result = service.check_compression_needed(current_user.id, session_id)
        return {
            "session_id": session_id,
            "stats": result.get("stats", {}),
            "compression_needed": result.get("needed", False),
            "reason": result.get("reason", ""),
        }
    except Exception as e:
        logger.error(f"获取记忆统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/check-auto-compress")
def check_auto_compress(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """检查是否需要自动压缩"""
    try:
        service = MemoryCompressionService(db)
        result = service.check_compression_needed(current_user.id, session_id)
        return result
    except Exception as e:
        logger.error(f"检查自动压缩失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/compress")
async def compress_memory(
    body: CompressRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """手动触发记忆压缩"""
    try:
        service = MemoryCompressionService(db)
        result = await service.compress_memory(
            user_id=current_user.id,
            session_id=body.session_id,
            compression_ratio=body.compression_ratio,
        )
        return result
    except Exception as e:
        logger.error(f"记忆压缩失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
