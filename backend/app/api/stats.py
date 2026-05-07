from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, cast, Date

from ..core import get_db
from ..api.dependencies import get_current_user, get_admin
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


def _get_usage_stats_for_user(
    user_id: str,
    period: str,
    db: Session,
    hide_character_usage: bool = False
):
    since = _since(period)

    # ─── Character chat ───────────────────────────────────────────
    char_stats_row = (
        db.query(
            func.count(CharacterChatMessage.id).label("requests"),
            func.coalesce(func.sum(CharacterChatMessage.prompt_tokens), 0).label("input"),
            func.coalesce(func.sum(CharacterChatMessage.tokens), 0).label("output"),
            func.coalesce(func.sum(CharacterChatMessage.reasoning_tokens), 0).label("reasoning"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user_id,
            CharacterChatMessage.role == "assistant",
        )
    )
    if since:
        char_stats_row = char_stats_row.filter(CharacterChatMessage.created_at >= since)
    char_row = char_stats_row.first()

    char_input = int(char_row.input or 0)
    char_output = int(char_row.output or 0)
    char_reasoning = int(char_row.reasoning or 0)
    char_summary = {
        "requests": char_row.requests or 0,
        "input": char_input,
        "output": char_output,
        "reasoning": char_reasoning,
        "total": char_input + char_output,
    }

    # by_model
    by_model_q = (
        db.query(
            CharacterChatMessage.model,
            func.sum(CharacterChatMessage.prompt_tokens).label("input"),
            func.sum(CharacterChatMessage.tokens).label("output"),
            func.sum(CharacterChatMessage.reasoning_tokens).label("reasoning"),
            func.count(CharacterChatMessage.id).label("requests"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user_id,
            CharacterChatMessage.role == "assistant",
        )
        .group_by(CharacterChatMessage.model)
    )
    if since:
        by_model_q = by_model_q.filter(CharacterChatMessage.created_at >= since)
    char_by_model = [
        {"model": r.model or "unknown", "input": r.input or 0, "output": r.output or 0, "reasoning": r.reasoning or 0, "requests": r.requests}
        for r in by_model_q.all()
    ]

    # by_character (only if not hidden)
    char_by_character = []
    if not hide_character_usage:
        by_char_q = (
            db.query(
                Character.name.label("character_name"),
                func.sum(CharacterChatMessage.prompt_tokens).label("input"),
                func.sum(CharacterChatMessage.tokens).label("output"),
                func.sum(CharacterChatMessage.reasoning_tokens).label("reasoning"),
                func.count(CharacterChatMessage.id).label("requests"),
            )
            .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
            .join(Character, CharacterChatSession.character_id == Character.id)
            .filter(
                CharacterChatSession.user_id == user_id,
                CharacterChatMessage.role == "assistant",
            )
            .group_by(Character.name)
        )
        if since:
            by_char_q = by_char_q.filter(CharacterChatMessage.created_at >= since)
        char_by_character = [
            {"character_name": r.character_name, "input": r.input or 0, "output": r.output or 0, "reasoning": r.reasoning or 0, "requests": r.requests}
            for r in by_char_q.all()
        ]

    # daily
    char_daily_q = (
        db.query(
            cast(CharacterChatMessage.created_at, Date).label("date"),
            func.sum(CharacterChatMessage.prompt_tokens).label("input"),
            func.sum(CharacterChatMessage.tokens).label("output"),
            func.sum(CharacterChatMessage.reasoning_tokens).label("reasoning"),
        )
        .join(CharacterChatSession, CharacterChatMessage.session_id == CharacterChatSession.id)
        .filter(
            CharacterChatSession.user_id == user_id,
            CharacterChatMessage.role == "assistant",
        )
        .group_by(cast(CharacterChatMessage.created_at, Date))
        .order_by(cast(CharacterChatMessage.created_at, Date))
    )
    if since:
        char_daily_q = char_daily_q.filter(CharacterChatMessage.created_at >= since)
    char_daily = [
        {"date": str(r.date), "input": r.input or 0, "output": r.output or 0, "reasoning": r.reasoning or 0}
        for r in char_daily_q.all()
    ]

    # ─── Regular chat ─────────────────────────────────────────────
    reg_stats_row = (
        db.query(
            func.count(ChatMessage.id).label("requests"),
            func.coalesce(func.sum(ChatMessage.prompt_tokens), 0).label("input"),
            func.coalesce(func.sum(ChatMessage.tokens), 0).label("output"),
            func.coalesce(func.sum(ChatMessage.reasoning_tokens), 0).label("reasoning"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user_id,
            ChatMessage.role == "assistant",
        )
    )
    if since:
        reg_stats_row = reg_stats_row.filter(ChatMessage.created_at >= since)
    reg_row = reg_stats_row.first()

    reg_input = int(reg_row.input or 0)
    reg_output = int(reg_row.output or 0)
    reg_reasoning = int(reg_row.reasoning or 0)
    reg_summary = {
        "requests": reg_row.requests or 0,
        "input": reg_input,
        "output": reg_output,
        "reasoning": reg_reasoning,
        "total": reg_input + reg_output,
    }

    # by_model
    reg_by_model_q = (
        db.query(
            ChatMessage.model,
            func.sum(ChatMessage.prompt_tokens).label("input"),
            func.sum(ChatMessage.tokens).label("output"),
            func.sum(ChatMessage.reasoning_tokens).label("reasoning"),
            func.count(ChatMessage.id).label("requests"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user_id,
            ChatMessage.role == "assistant",
        )
        .group_by(ChatMessage.model)
    )
    if since:
        reg_by_model_q = reg_by_model_q.filter(ChatMessage.created_at >= since)
    reg_by_model = [
        {"model": r.model or "unknown", "input": r.input or 0, "output": r.output or 0, "reasoning": r.reasoning or 0, "requests": r.requests}
        for r in reg_by_model_q.all()
    ]

    # daily
    reg_daily_q = (
        db.query(
            cast(ChatMessage.created_at, Date).label("date"),
            func.sum(ChatMessage.prompt_tokens).label("input"),
            func.sum(ChatMessage.tokens).label("output"),
            func.sum(ChatMessage.reasoning_tokens).label("reasoning"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(
            ChatSession.user_id == user_id,
            ChatMessage.role == "assistant",
        )
        .group_by(cast(ChatMessage.created_at, Date))
        .order_by(cast(ChatMessage.created_at, Date))
    )
    if since:
        reg_daily_q = reg_daily_q.filter(ChatMessage.created_at >= since)
    reg_daily = [
        {"date": str(r.date), "input": r.input or 0, "output": r.output or 0, "reasoning": r.reasoning or 0}
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


@router.get("/usage")
async def get_usage_stats(
    period: str = Query("month", pattern="^(day|week|month|all)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _get_usage_stats_for_user(user.id, period, db, hide_character_usage=False)


@router.get("/admin/usage/{user_id}")
async def get_admin_user_usage_stats(
    user_id: str,
    period: str = Query("month", pattern="^(day|week|month|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin),
):
    target_user = db.query(User).filter(User.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return _get_usage_stats_for_user(user_id, period, db, hide_character_usage=True)
