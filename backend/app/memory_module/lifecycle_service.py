"""
记忆生命周期服务
整合压缩和 AI 摘要功能，提供统一的记忆管理接口
"""

import asyncio
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime
from sqlalchemy.orm import Session

from .storage import MemoryStorage
from .models import MemoryEntry
from .compression_service import MemoryCompressionService
from .ai_summary_service import AISummaryMemoryService

logger = logging.getLogger("MemoryLifecycle")


class MemoryLifecycleService:
    """
    记忆生命周期服务

    整合压缩和 AI 摘要功能：
    1. compress_memory - 压缩过期/冗余记忆
    2. generate_ai_summary - 使用 AI 生成对话摘要
    """

    def __init__(
        self,
        db_session: Session,
        api_key: str = "",
        base_url: str = "",
        model: str = "",
    ):
        self.db = db_session
        self.storage = MemoryStorage(db_session)
        self._compression_service = MemoryCompressionService(db_session)
        self._summary_service: Optional[AISummaryMemoryService] = None
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    def _ensure_summary_service(self) -> Optional[AISummaryMemoryService]:
        if self._summary_service is None and self._api_key and self._model:
            self._summary_service = AISummaryMemoryService(
                self.db, self._api_key, self._base_url, self._model
            )
        return self._summary_service

    async def compress_memory(
        self,
        user_id: int,
        session_id: str,
        compression_ratio: float = 0.5,
        branch_id: Optional[str] = None,
    ) -> Dict:
        """
        压缩记忆

        参数:
            user_id: 用户ID
            session_id: 会话ID
            compression_ratio: 压缩比例（保留多少比例的记忆），默认0.5保留50%
            branch_id: 分支ID

        返回: {
            "success": bool,
            "compressed_count": int,
            "remaining_count": int,
            "summary": str
        }
        """
        return await self._compression_service.compress_memory(
            user_id=user_id,
            session_id=session_id,
            compression_ratio=compression_ratio,
            branch_id=branch_id,
        )

    def check_compression_needed(
        self, user_id: int, session_id: str, branch_id: Optional[str] = None
    ) -> Dict:
        """
        检查是否需要压缩记忆

        返回: {
            "needed": bool,
            "reason": str,
            "stats": {...}
        }
        """
        return self._compression_service.check_compression_needed(
            user_id, session_id, branch_id
        )

    async def generate_ai_summary(
        self, user_id: int, session_id: str
    ) -> Optional[str]:
        """
        使用 AI 生成对话摘要

        参数:
            user_id: 用户ID
            session_id: 会话ID

        返回:
            摘要文本，失败返回 None
        """
        summary_svc = self._ensure_summary_service()
        if summary_svc is None:
            logger.warning("AI 摘要服务未配置（缺少 api_key 或 model）")
            return None
        return await summary_svc.generate_summary(user_id, session_id)

    async def extract_key_facts(
        self, user_id: int, user_msg: str, assistant_msg: str
    ) -> List[str]:
        """
        从单条对话中提取关键事实

        参数:
            user_id: 用户ID
            user_msg: 用户消息
            assistant_msg: AI 回复

        返回:
            关键事实列表
        """
        summary_svc = self._ensure_summary_service()
        if summary_svc is None:
            return []
        return await summary_svc.extract_key_facts(user_id, user_msg, assistant_msg)

    async def get_context_with_summary(
        self, user_id: int, session_id: str, current_query: str
    ) -> Dict:
        """
        获取包含 AI 摘要的上下文

        返回: {
            "summary": "对话摘要",
            "key_facts": ["事实1", "事实2"],
            "latency_ms": 500
        }
        """
        summary_svc = self._ensure_summary_service()
        if summary_svc is None:
            return {"summary": "", "key_facts": [], "latency_ms": 0}
        return await summary_svc.get_context_with_summary(
            user_id, session_id, current_query
        )

    async def check_and_auto_compress(
        self, user_id: int, session_id: str
    ) -> Optional[Dict]:
        """
        检查并自动压缩记忆

        如果记忆超过阈值，自动触发压缩
        """
        check_result = self.check_compression_needed(user_id, session_id)

        if check_result["needed"]:
            logger.info(f"自动触发记忆压缩: {check_result['reason']}")
            compression_result = await self.compress_memory(user_id, session_id)
            return {
                "auto_compressed": True,
                "check": check_result,
                "compression": compression_result,
            }

        return None

    def get_memory_stats(self, user_id: int, session_id: str) -> Dict:
        """获取记忆统计信息（用于UI显示）"""
        stats = self._compression_service._get_session_stats(user_id, session_id)
        check = self.check_compression_needed(user_id, session_id)

        return {
            **stats,
            "compression_needed": check["needed"],
            "compression_reason": check["reason"],
        }
