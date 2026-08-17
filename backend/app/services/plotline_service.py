"""PlotLine service — linear stage progression (Phase 6C)."""
import logging
import json
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from ..models.plotline import PlotLine, PlotStage, SessionPlotLine
from ..models.character import CharacterChatSession

logger = logging.getLogger(__name__)

# System prompt for AI-assisted plot parsing
PARSE_SYSTEM_PROMPT = """你是专业的小说/故事结构分析师。
用户会提供故事大纲或世界设定文本，你需要将其拆分为若干「剧情阶段」。

每个阶段包含：
- title: 阶段标题（简洁，10字以内）
- content: 该阶段的完整叙述/设定文本（直接可注入对话系统）
- summary: 一句话总结（给AI快速定向，20字以内）
- transition_hint: 进入下一阶段的触发条件（可为空）
- priority: 重要程度 1-10（默认5）

严格输出 JSON 数组，格式：
[
  {"title": "...", "content": "...", "summary": "...", "transition_hint": "...", "priority": 5},
  ...
]
不要输出其他任何内容。"""

TRANSITION_CHECK_PROMPT = """你是故事推进判断器。
当前剧情阶段：
{current_stage_content}

最近的对话摘要：
{recent_summary}

过渡触发条件：{transition_hint}

请判断：对话是否已满足进入下一阶段的条件？
只需回答 "YES" 或 "NO"，不要解释。"""


def build_plotline_context(
    db: DBSession,
    session_id: str,
    user_id: int,
) -> Optional[str]:
    """获取当前剧情阶段内容，用于注入到角色对话提示词中。"""
    session = db.query(CharacterChatSession.id).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user_id,
    ).first()
    if not session:
        return None

    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if not spl:
        return None

    stage = (
        db.query(PlotStage)
        .filter(
            PlotStage.plot_line_id == spl.plot_line_id,
            PlotStage.stage_index == spl.current_stage_index,
        )
        .first()
    )
    if not stage:
        return None

    return f"[剧情阶段: {stage.title or '当前阶段'}]\n{stage.content}"


async def check_plot_transition(
    db: DBSession,
    session_id: str,
    recent_messages: list | None = None,
    llm_call_fn=None,
) -> bool:
    """
    使用LLM判断是否应该推进到下一剧情阶段（仅auto模式）。
    返回 True 表示应self-advance。
    """
    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if not spl or spl.stage_transition_mode != "auto":
        return False

    total = db.query(PlotStage).filter(PlotStage.plot_line_id == spl.plot_line_id).count()
    if spl.current_stage_index >= total - 1:
        return False  # Already at last stage

    stage = (
        db.query(PlotStage)
        .filter(
            PlotStage.plot_line_id == spl.plot_line_id,
            PlotStage.stage_index == spl.current_stage_index,
        )
        .first()
    )
    if not stage or not stage.transition_hint:
        return False

    if not llm_call_fn or not recent_messages:
        return False

    recent_summary = "\n".join(
        f"{m.get('role','?')}: {m.get('content','')[:200]}"
        for m in (recent_messages[-6:] if len(recent_messages) >= 6 else recent_messages)
    )

    prompt = TRANSITION_CHECK_PROMPT.format(
        current_stage_content=stage.content[:500],
        recent_summary=recent_summary,
        transition_hint=stage.transition_hint,
    )

    try:
        answer = await llm_call_fn(prompt)
        normalized = str(answer).strip().upper()
        return normalized == "YES"
    except Exception as e:
        logger.warning("Plot transition check failed: %s", e)
        return False


def advance_stage(db: DBSession, session_id: str) -> bool:
    """将当前剧情阶段+1，如已在末尾则不操作。返回是否成功前进。"""
    spl = db.query(SessionPlotLine).filter(SessionPlotLine.session_id == session_id).first()
    if not spl:
        return False
    total = db.query(PlotStage).filter(PlotStage.plot_line_id == spl.plot_line_id).count()
    if spl.current_stage_index >= total - 1:
        return False
    spl.current_stage_index += 1
    db.commit()
    return True
