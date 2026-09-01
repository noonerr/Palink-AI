"""用户 LLM token 额度服务（管理员分配，一次性总额度）。

设计（2026-08-30 用户配额功能，方案经用户拍板）：
- 单位 = tokens（prompt + completion + reasoning 总和）
- 周期 = 一次性总额度，管理员手动加量 / 清零已用
- 范围 = 仅 5 个主聊天入口（REST 两条 + WebSocket 两条 + 动作流）；
  辅助小功能（标题/摘要/mvu 等）与封存的 ST 轨不计量（AGENTS.md 红线）
- 无行 / quota_tokens=NULL 都表示「不限」，向后兼容：不设置即功能不存在
- 不做 new-api 式预扣费（预扣泄漏是上游已知 bug 源），完成时按实际用量扣减；
  并发窗口内的微量超额可接受（下一轮预检拦截）

参照：new-api quota/used_quota 模型、LiteLLM budget 超限拦截。
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import update
from sqlalchemy.orm import Session

from ..models import UserQuota

logger = logging.getLogger(__name__)

QUOTA_EXCEEDED_MESSAGE = "对话额度已用完，请联系管理员"


class QuotaExceededError(Exception):
    """用户 token 额度已耗尽。携带剩余额度信息供错误响应。"""

    def __init__(self, used_tokens: int, quota_tokens: int):
        self.used_tokens = used_tokens
        self.quota_tokens = quota_tokens
        super().__init__(QUOTA_EXCEEDED_MESSAGE)


def _current_period_month() -> str:
    now = datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


def _maybe_monthly_reset(db: Session, row: Optional[UserQuota]) -> None:
    """月度自动重置（懒触发）：row 的计数月不是当前自然月时清零已用并推进计数月。

    仅对设置了 monthly_reset 且有额度上限的行生效；只在真实发生重置时 commit
    （每月每用户至多一次），其余读路径保持零写入。
    """
    if row is None or not row.monthly_reset or row.quota_tokens is None:
        return
    cur = _current_period_month()
    if row.period_month != cur:
        row.used_tokens = 0
        row.period_month = cur
        db.commit()
        logger.info("Monthly quota reset applied: user_id=%s period=%s", row.user_id, cur)


def get_quota_state(db: Session, user_id: int) -> Dict[str, Any]:
    """返回用户额度状态（无行 = 不限）。"""
    row = db.query(UserQuota).filter(UserQuota.user_id == user_id).first()
    _maybe_monthly_reset(db, row)
    if row is None or row.quota_tokens is None:
        return {
            "unlimited": True,
            "quota_tokens": None,
            "used_tokens": row.used_tokens if row else 0,
            "remaining": None,
            "monthly_reset": bool(row.monthly_reset) if row else False,
        }
    return {
        "unlimited": False,
        "quota_tokens": int(row.quota_tokens),
        "used_tokens": int(row.used_tokens or 0),
        "remaining": max(int(row.quota_tokens) - int(row.used_tokens or 0), 0),
        "monthly_reset": bool(row.monthly_reset),
        "period_month": row.period_month,
    }


def ensure_quota(db: Session, user_id: Optional[int]) -> None:
    """预检：额度已耗尽则抛 QuotaExceededError，否则放行。

    无行 / NULL 额度 / user_id 为空（系统调用）一律放行。
    月度重置在此懒触发（预检是每个计费请求的必经点）。
    """
    if user_id is None:
        return
    row = db.query(UserQuota).filter(UserQuota.user_id == user_id).first()
    _maybe_monthly_reset(db, row)
    if row is None or row.quota_tokens is None:
        return
    used = int(row.used_tokens or 0)
    if used >= int(row.quota_tokens):
        raise QuotaExceededError(used_tokens=used, quota_tokens=int(row.quota_tokens))


def deduct_usage(db: Session, user_id: Optional[int], total_tokens: int) -> None:
    """按实际用量累加 used_tokens（原子自增，无行则建行）。

    不限额用户也记账（供用量展示）；total_tokens<=0 忽略；
    并发/竞态下允许 used 超过 quota（completion 实耗照记，下一轮预检拦截）。
    调用方持有事务：本函数不 commit，由调用方随业务写库一起提交。
    """
    if user_id is None or not total_tokens or total_tokens <= 0:
        return

    row = db.query(UserQuota).filter(UserQuota.user_id == user_id).first()
    if row is None:
        db.add(UserQuota(user_id=user_id, quota_tokens=None, used_tokens=int(total_tokens)))
        # 立即 flush：同一会话内的后续调用/写入要能读到该行（autoflush=False 场景）
        db.flush()
        return

    db.execute(
        update(UserQuota)
        .where(UserQuota.user_id == user_id)
        .values(used_tokens=UserQuota.used_tokens + int(total_tokens))
    )


def set_user_quota(
    db: Session,
    user_id: int,
    quota_tokens: Optional[int],
    reset_used: bool = False,
    monthly_reset: Optional[bool] = None,
) -> Dict[str, Any]:
    """管理员设置额度。quota_tokens=None → 不限；reset_used=True → 已用清零；
    monthly_reset=None → 不改变现有月度重置设置（True/False 覆盖）。"""
    row = db.query(UserQuota).filter(UserQuota.user_id == user_id).first()
    if row is None:
        row = UserQuota(
            user_id=user_id,
            quota_tokens=quota_tokens,
            used_tokens=0,
            monthly_reset=bool(monthly_reset),
            period_month=_current_period_month() if monthly_reset else None,
        )
        db.add(row)
    else:
        row.quota_tokens = quota_tokens
        if reset_used:
            row.used_tokens = 0
        if monthly_reset is not None:
            row.monthly_reset = monthly_reset
            row.period_month = _current_period_month() if monthly_reset else None
    db.flush()
    return get_quota_state(db, user_id)


def compute_deduct_tokens(result: Any, messages: Optional[list], model_id: Optional[str] = None) -> int:
    """计算一次生成应扣减的 token 数。

    优先级（对齐云端计费口径）：
    1. 供应商上报的真实 usage（流式 stream_options.include_usage 尾块 /
       非流式 resp.usage）→ result.total_tokens > 0 时直接采用——这是
       供应商计费用的同一个数字；
    2. error-only（中断/网关无响应的 "Error:" 占位文本，无真实输出）→ 0，
       不扣费——对齐 SillyTavern「只对最终成功文本计数」的语义；
    3. 按型号 tokenizer 精确计数（token_counter_service，DeepSeek/Qwen/
       OpenAI 等公开词表型号）；model_id 未提供或无词表 → 跳过；
    4. 字符启发式兜底：prompt 侧 dispatcher.estimate_messages_tokens，
       补全侧 result.token_count()。
    """
    total = getattr(result, "total_tokens", 0) or 0
    if total > 0:
        return int(total)

    content = (getattr(result, "full_content", "") or "").strip()
    if content.startswith("Error:"):
        # 真实输出 + 错误后缀（不以 Error: 开头）不在此列，照常按回退估算计
        return 0

    # 第二层：按型号 tokenizer 精确计数（prompt + 补全 + 思考）
    if model_id:
        try:
            from .token_counter_service import count_messages_tokens, count_text_tokens
            prompt_est = count_messages_tokens(model_id, messages)
            completion_text = (getattr(result, "full_content", "") or "") + (
                getattr(result, "full_reasoning", "") or ""
            )
            completion_est = count_text_tokens(model_id, completion_text)
            if prompt_est is not None and completion_est is not None:
                return int(prompt_est + completion_est)
        except Exception:
            pass

    # 第三层：字符启发式兜底
    fallback = 0
    try:
        from .inference_dispatcher import estimate_messages_tokens
        fallback += estimate_messages_tokens(messages or [])
    except Exception:
        pass
    if hasattr(result, "token_count"):
        fallback += result.token_count()
    return int(fallback)
