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
from .models import MemoryEntry, UserProfile
from .compression_service import MemoryCompressionService
from ..core.silent_failure import record as _record_silent_failure
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


def _refresh_user_profile(db: Session, user_id: int, compress_result: Dict) -> None:
    """[ST-ALIGN P1] 把压缩结果沉淀到 user_profiles（轻量、**不调 AI**）。

    user_profiles 此前「有读无写」：``retriever.py`` 检索时会读
    ``storage.get_user_profile(user_id)``，但全仓没有任何业务写入方 → profile 恒为
    None，跨会话用户画像形同虚设（ST 对应物是长期记忆文件源 / dataBank）。

    这里刻意**不接 AI 摘要**：``generate_ai_summary`` 需要 provider 密钥链路
    （api_key/base_url/model），在对话主流程里引入会带���密钥获取与调用成本耦合，
    已登记为独立立项。此处只沉淀压缩摘要与统计计数，零额外成本、无外部依赖。
    """
    storage = MemoryStorage(db)
    profile = storage.get_user_profile(user_id) or UserProfile(user_id=user_id)
    compression = compress_result.get("compression") or {}
    summary = compression.get("summary")
    if isinstance(summary, str) and summary.strip():
        profile.summary = summary.strip()
    profile.total_conversations = int(profile.total_conversations or 0) + 1
    storage.update_user_profile(profile)


async def maybe_auto_compress(
    db: Session,
    user_id: int,
    session_id: str,
    *,
    memory_mode: Optional[str] = None,
) -> Optional[Dict]:
    """[ST-ALIGN P0-1] 记忆自动封存的统一入口 —— 供对话主流程调用。

    背景：ST 1.18 由 memory 扩展按 promptInterval / context 阈值滚动摘要、
    vectors 自动注入，长会话不会无限膨胀。Palink 侧 ``MemoryLifecycleService
    .check_and_auto_compress`` 此前**只有定义、没有任何自动调用方**，仅暴露为
    手动端点 ``/api/memory/compress``，导致记忆只增不减直到撞上下文窗口硬截断。
    本函数把该能力接到「对话落库之后」，HTTP 与 WebSocket 两条链路共用。

    跳过条件：
    - ``memory_mode == "disabled"``（与 store_memory 同条件，用户关了记忆就不压）
    - ``settings.AUTO_MEMORY_COMPRESS = False``（全局熔断，env 可配）

    容错：任何异常只 warn 并吞掉，绝不影响主对话流程。
    事务：压缩内部自行 commit，调用方无需再提交。
    """
    if memory_mode == "disabled":
        return None

    try:
        from ..core import settings

        if not getattr(settings, "AUTO_MEMORY_COMPRESS", True):
            return None
    except Exception as _cfg_exc:  # pragma: no cover - 配置不可用时按开启处理
        # [SILENT-FAIL 2026-10-22] 读不到配置就"按开启处理"，等于替用户决定了要跑
        # 自动封存。行为本身保留（宁可不丢记忆），但必须留痕。
        _record_silent_failure("memory.lifecycle.read_auto_compress_setting", _cfg_exc, once=True)

    try:
        svc = MemoryLifecycleService(db)
        result = await svc.check_and_auto_compress(user_id, session_id)
        if result and result.get("auto_compressed"):
            logger.info(
                "自动记忆封存完成 user_id=%s session_id=%s reason=%s",
                user_id,
                session_id,
                (result.get("check") or {}).get("reason"),
            )
            # [ST-ALIGN P1] 压缩后沉淀一次轻量用户画像（user_profiles 此前零写入）
            try:
                _refresh_user_profile(db, user_id, result)
            except Exception as exc:
                logger.warning("User profile refresh skipped: %s", exc)
        return result
    except Exception as exc:
        logger.warning("Auto memory compression skipped: %s", exc)
        return None
