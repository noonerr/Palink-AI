from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, cast, Date

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.character import CharacterChatMessage, CharacterChatSession, Character
from ..models.message import ChatMessage
from ..models.session import ChatSession

router = APIRouter(prefix="/api/stats", tags=["stats"])


def _since(period: str) -> Optional[datetime]:
    now = datetime.now(timezone.utc)
    if period == "day":
        return now - timedelta(days=1)
    elif period == "week":
        return now - timedelta(weeks=1)
    elif period == "month":
        return now - timedelta(days=30)
    return None  # all


@router.get("/usage")
async def get_usage_stats(
    period: str = Query("month", pattern="^(day|week|month|all)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = _since(period)

    # ─── Character chat ───────────────────────────────────────────
    char_base = (
        db.query(CharacterChatMessage)
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatMessage.role == "assistant",
        )
    )
    if since:
        char_base = char_base.filter(CharacterChatMessage.created_at >= since)

    char_msgs = char_base.all()

    char_summary = {
        "requests": len(char_msgs),
        "input": sum(m.prompt_tokens or 0 for m in char_msgs),
        "output": sum(m.tokens or 0 for m in char_msgs),
        "total": sum((m.prompt_tokens or 0) + (m.tokens or 0) for m in char_msgs),
    }

    # by_model
    by_model_q = (
        db.query(
            CharacterChatMessage.model,
            func.sum(CharacterChatMessage.prompt_tokens).label("input"),
            func.sum(CharacterChatMessage.tokens).label("output"),
            func.count(CharacterChatMessage.id).label("requests"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatMessage.role == "assistant",
        )
        .group_by(CharacterChatMessage.model)
    )
    if since:
        by_model_q = by_model_q.filter(CharacterChatMessage.created_at >= since)
    char_by_model = [
        {"model": r.model or "unknown", "input": r.input or 0, "output": r.output or 0, "requests": r.requests}
        for r in by_model_q.all()
    ]

    # by_character
    by_char_q = (
        db.query(
            Character.name.label("character_name"),
            func.sum(CharacterChatMessage.prompt_tokens).label("input"),
            func.sum(CharacterChatMessage.tokens).label("output"),
            func.count(CharacterChatMessage.id).label("requests"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .join(Character, CharacterChatSession.character_id == Character.id)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatMessage.role == "assistant",
        )
        .group_by(Character.name)
    )
    if since:
        by_char_q = by_char_q.filter(CharacterChatMessage.created_at >= since)
    char_by_character = [
        {"character_name": r.character_name, "input": r.input or 0, "output": r.output or 0, "requests": r.requests}
        for r in by_char_q.all()
    ]

    # daily
    char_daily_q = (
        db.query(
            cast(CharacterChatMessage.created_at, Date).label("date"),
            func.sum(CharacterChatMessage.prompt_tokens).label("input"),
            func.sum(CharacterChatMessage.tokens).label("output"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatMessage.role == "assistant",
        )
        .group_by(cast(CharacterChatMessage.created_at, Date))
        .order_by(cast(CharacterChatMessage.created_at, Date))
    )
    if since:
        char_daily_q = char_daily_q.filter(CharacterChatMessage.created_at >= since)
    char_daily = [
        {"date": str(r.date), "input": r.input or 0, "output": r.output or 0}
        for r in char_daily_q.all()
    ]

    # ─── Regular chat ─────────────────────────────────────────────
    reg_base = (
        db.query(ChatMessage)
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user.id,
            ChatMessage.role == "assistant",
        )
    )
    if since:
        reg_base = reg_base.filter(ChatMessage.created_at >= since)

    reg_msgs = reg_base.all()

    reg_summary = {
        "requests": len(reg_msgs),
        "input": sum(m.prompt_tokens or 0 for m in reg_msgs),
        "output": sum(m.tokens or 0 for m in reg_msgs),
        "total": sum((m.prompt_tokens or 0) + (m.tokens or 0) for m in reg_msgs),
    }

    # by_model
    reg_by_model_q = (
        db.query(
            ChatMessage.model,
            func.sum(ChatMessage.prompt_tokens).label("input"),
            func.sum(ChatMessage.tokens).label("output"),
            func.count(ChatMessage.id).label("requests"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user.id,
            ChatMessage.role == "assistant",
        )
        .group_by(ChatMessage.model)
    )
    if since:
        reg_by_model_q = reg_by_model_q.filter(ChatMessage.created_at >= since)
    reg_by_model = [
        {"model": r.model or "unknown", "input": r.input or 0, "output": r.output or 0, "requests": r.requests}
        for r in reg_by_model_q.all()
    ]

    # daily
    reg_daily_q = (
        db.query(
            cast(ChatMessage.created_at, Date).label("date"),
            func.sum(ChatMessage.prompt_tokens).label("input"),
            func.sum(ChatMessage.tokens).label("output"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user.id,
            ChatMessage.role == "assistant",
        )
        .group_by(cast(ChatMessage.created_at, Date))
        .order_by(cast(ChatMessage.created_at, Date))
    )
    if since:
        reg_daily_q = reg_daily_q.filter(ChatMessage.created_at >= since)
    reg_daily = [
        {"date": str(r.date), "input": r.input or 0, "output": r.output or 0}
        for r in reg_daily_q.all()
    ]

    return {
        "character_chat": {
            "summary": char_summary,
            "by_model": char_by_model,
            "by_character": char_by_character,
            "daily": char_daily,
        },
        "regular_chat": {
            "summary": reg_summary,
            "by_model": reg_by_model,
            "daily": reg_daily,
        },
    }
