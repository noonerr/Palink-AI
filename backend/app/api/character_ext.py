"""
角色扩展路由：会话、分支、对话流、导入/导出、解析、翻译
"""
import os
import io
import json
import uuid
import logging
import re
import asyncio
import base64
import time
import random
import threading
import urllib.request
import urllib.error
from collections import OrderedDict
from typing import Optional, List, Dict, AsyncGenerator, Any, Union
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func
from pydantic import BaseModel

from ..core import get_db, settings
from ..core.database import SessionLocal
from ..core.cache import invalidate_user_cache
from ..core.rate_limit import enforce_rate_limit
from ..core.exceptions import ServiceError
from ..api.dependencies import get_current_user
from ..models import User, Character, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch
from ..models.system import UserSetting, GenerationPreset
from ..character_card import create_png_with_chara_card, convert_character_to_chara_card
from ..services.character_import_service import CharacterImportService, PngCharacterCardParser
from ..memory_module.service import MemoryService
from ..memory_module.storage import delete_by_message_id
from ..schemas.character import character_to_dict
from ..utils import normalize_image_url, get_default_ai_model, _is_public_http_url, clean_memory_content
from ..services.inference_dispatcher import (
    complete_text_completion,
    ensure_model_available,
    stream_text_completion,
)
from ..services.generation_service import _build_logit_bias
from ..core.default_prompts import build_default_character_prompt
from ..services.character_message_builder import (
    build_character_chat_messages,
    clean_smart_card_trigger_context,
    is_smart_card_trigger_message,
)
from ..services.roleplay_prompt_assembly import (
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    assemble_roleplay_prompt,
)
from ..services.slash_command_service import (
    SlashCommandContext,
    SlashCommandResult,
    execute_slash_command,
    is_slash_command,
)
from ..services.compact_title_service import generate_compact_title, rule_based_compact_title
from ..services.image_generation_service import image_result_to_dict, maybe_generate_image_for_message
from ..services.plotline_service import check_plot_transition, advance_stage
from ..models.plotline import SessionPlotLine, PlotStage

router_characters = APIRouter(prefix="/api/characters", tags=["character-ext"])
router_sessions = APIRouter(prefix="/api/character-sessions", tags=["character-sessions"])
router_chat = APIRouter(tags=["character-chat"])

logger = logging.getLogger(__name__)

_MAX_IMAGE_SIZE = 50 * 1024 * 1024
_CHUNK_SIZE = 8192


def _read_with_size_limit(resp, max_size: int = _MAX_IMAGE_SIZE) -> bytes:
    chunks = []
    total_read = 0
    while True:
        chunk = resp.read(_CHUNK_SIZE)
        if not chunk:
            break
        total_read += len(chunk)
        if total_read > max_size:
            raise ValueError(f"Response body exceeds {max_size // (1024 * 1024)}MB limit")
        chunks.append(chunk)
    return b"".join(chunks)


# ───────────────────────────────────────────────
# Branch History Helpers
# ───────────────────────────────────────────────

def _get_assistant_message_id_for_node(db: Session, session_id: str, branch_id: str, user_msg_id: int) -> Optional[int]:
    """
    Given a user message ID, find the immediately following assistant message ID in the same branch.
    This defines a "dialogue node" as (user_msg, assistant_msg) pair.
    Returns None if no assistant message follows.
    """
    assistant_msg = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id == branch_id,
            CharacterChatMessage.role == "assistant",
            CharacterChatMessage.id > user_msg_id,
        )
        .order_by(CharacterChatMessage.id)
        .first()
    )
    return assistant_msg.id if assistant_msg else None


def _count_child_branches_from_node(db: Session, session_id: str, parent_branch_id: Optional[str], parent_message_id: Optional[int]) -> int:
    """
    Count how many branches fork from a specific node (identified by parent_branch_id + parent_message_id).
    This enforces the "max 3 branches per node" rule.

    Note: parent_message_id should always point to an assistant message (the end of a dialogue pair).
    """
    query = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
    )

    if parent_branch_id is None:
        query = query.filter(CharacterChatSessionBranch.parent_branch_id.is_(None))
    else:
        query = query.filter(CharacterChatSessionBranch.parent_branch_id == parent_branch_id)

    if parent_message_id is None:
        query = query.filter(CharacterChatSessionBranch.parent_message_id.is_(None))
    else:
        query = query.filter(CharacterChatSessionBranch.parent_message_id == parent_message_id)

    return query.count()


def _get_branch_messages_up_to(db: Session, session_id: str, branch_id: str, up_to_message_id: Optional[int] = None) -> list:
    """Get messages for a branch, optionally up to (and including) a specific message id."""
    msgs = (
        db.query(CharacterChatMessage)
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id == branch_id,
        )
        .order_by(CharacterChatMessage.created_at)
        .all()
    )
    if up_to_message_id is None:
        return msgs
    result = []
    for m in msgs:
        result.append(m)
        if m.id == up_to_message_id:
            break
    return result


def _json_load_object(raw, fallback):
    if raw is None or raw == "":
        return fallback
    if isinstance(raw, (dict, list)):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if parsed is not None else fallback
    except (json.JSONDecodeError, TypeError, ValueError):
        return fallback


def _json_dump_or_none(value) -> Optional[str]:
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def _message_display_name(message: CharacterChatMessage, char_name: str = "Character", user_name: str = "User") -> str:
    if getattr(message, "name", None):
        return message.name
    if message.role == "user":
        return user_name or "User"
    if message.role == "system":
        return "System"
    return char_name or "Character"


_ST_MESSAGE_EXTRA_FIELDS = (
    # ST 1.18.0 标准消息 extra 字段
    "is_name",
    "force_avatar",
    "original_avatar",
    "avatar",
    "gen_id",
    "group_id",
    "group_name",
    "selected_group",
    "groups",
    # Phase 3 extra 字段补齐 (ST 1.18.0 对齐)
    # - reasoning: LLM 思考链原文 (双写兼容: 同时写入 content 内联 ⋇...⋑ 和 extra.reasoning)
    # - reasoning_type: thinking | analysis | redacted (默认 thinking)
    # - reasoning_duration: 思考耗时秒数
    # - reasoning_display_text: 用户可编辑的思考链显示文本
    # - tool_invocations: LLM tool call 数组 (字段透传, 不实现主动 tool calling)
    # - files: 文件附件数组 (字段透传, 前端 UI 留作 follow-up)
    # - media_display / media_index / media: 媒体附件 (字段透传)
    # - bias: per-message logit bias (字段透传, Palink 仅支持 preset 级)
    # - memory: per-message memory context (字段透传, Palink 仅全局 memory)
    # - ignore: 消息标记为忽略时在 prompt 装配时跳过 (替代 ST Symbol.for('ignore'))
    "reasoning",
    "reasoning_type",
    "reasoning_duration",
    "reasoning_display_text",
    "tool_invocations",
    "files",
    "media_display",
    "media_index",
    "media",
    "bias",
    "memory",
    "ignore",
)


def _merge_st_message_extra_fields(extra: Optional[dict], **fields) -> dict:
    merged = _extra_without_swipe_info(extra)
    for key in _ST_MESSAGE_EXTRA_FIELDS:
        value = fields.get(key)
        if value is not None:
            merged[key] = value
    return merged


def _message_extra_field(message: CharacterChatMessage, key: str):
    extra = _message_extra(message)
    return extra.get(key)


def _has_st_message_extra_values(**fields) -> bool:
    return any(fields.get(key) is not None for key in _ST_MESSAGE_EXTRA_FIELDS)


def _message_swipes(message: CharacterChatMessage) -> list[str]:
    stored = _json_load_object(getattr(message, "swipes", None), [])
    if isinstance(stored, list):
        swipes = [str(item) for item in stored if item is not None]
        if swipes:
            return swipes
    return [message.content or ""]


def _message_extra(message: CharacterChatMessage) -> dict:
    extra = _json_load_object(getattr(message, "extra", None), {})
    return extra if isinstance(extra, dict) else {}


def _extra_without_swipe_info(extra: Optional[dict]) -> dict:
    if not isinstance(extra, dict):
        return {}
    return {key: value for key, value in extra.items() if key != "swipe_info"}


def _normalize_swipe_info(
    *,
    extra: Optional[dict],
    swipes: list[str],
    swipe_id: int = 0,
    swipe_info: Optional[list[dict]] = None,
    send_date: str = "",
) -> list[dict]:
    source_extra = _extra_without_swipe_info(extra)
    raw_info = swipe_info if isinstance(swipe_info, list) else (
        extra.get("swipe_info") if isinstance(extra, dict) and isinstance(extra.get("swipe_info"), list) else []
    )
    result: list[dict] = []
    for item in raw_info[:len(swipes)]:
        entry = dict(item) if isinstance(item, dict) else {}
        entry_extra = entry.get("extra") if isinstance(entry.get("extra"), dict) else source_extra
        entry["extra"] = _extra_without_swipe_info(entry_extra)
        entry.setdefault("send_date", send_date)
        result.append(entry)
    while len(result) < len(swipes):
        result.append({"send_date": send_date, "extra": dict(source_extra)})
    if swipes:
        safe_swipe_id = max(0, min(int(swipe_id or 0), len(swipes) - 1))
        active_entry = result[safe_swipe_id] if isinstance(result[safe_swipe_id], dict) else {}
        active_extra = active_entry.get("extra") if isinstance(active_entry.get("extra"), dict) else source_extra
        active_extra = {**_extra_without_swipe_info(active_extra), **source_extra}
        result[safe_swipe_id] = {
            **active_entry,
            "send_date": active_entry.get("send_date") or send_date,
            "extra": _extra_without_swipe_info(active_extra),
        }
    return result


def _compose_message_extra_with_swipe_info(
    extra: Optional[dict],
    *,
    swipes: list[str],
    swipe_id: int = 0,
    swipe_info: Optional[list[dict]] = None,
    send_date: str = "",
) -> dict:
    base_extra = _extra_without_swipe_info(extra)
    base_extra["swipe_info"] = _normalize_swipe_info(
        extra=extra,
        swipes=swipes,
        swipe_id=swipe_id,
        swipe_info=swipe_info,
        send_date=send_date,
    )
    return base_extra


def _message_swipe_info(message: CharacterChatMessage, swipes: Optional[list[str]] = None) -> list[dict]:
    extra = _message_extra(message)
    source_swipes = swipes if isinstance(swipes, list) and swipes else _message_swipes(message)
    send_date = getattr(message, "created_at", None)
    try:
        swipe_id = int(getattr(message, "swipe_id", 0) or 0)
    except (TypeError, ValueError):
        swipe_id = 0
    return _normalize_swipe_info(
        extra=extra,
        swipes=source_swipes,
        swipe_id=swipe_id,
        send_date=send_date.isoformat() if hasattr(send_date, "isoformat") else str(send_date or ""),
    )


def _serialize_character_message(
    message: CharacterChatMessage,
    *,
    index: Optional[int] = None,
    char_name: str = "Character",
    user_name: str = "User",
) -> dict:
    mesid = message.mesid if isinstance(getattr(message, "mesid", None), int) else index
    if mesid is None:
        mesid = 0
    is_user = bool(message.is_user) if getattr(message, "is_user", None) is not None else message.role == "user"
    is_system = bool(message.is_system) if getattr(message, "is_system", None) is not None else message.role == "system"
    swipes = _message_swipes(message)
    swipe_id = getattr(message, "swipe_id", None)
    try:
        swipe_id_int = int(swipe_id or 0)
    except (TypeError, ValueError):
        swipe_id_int = 0
    message_extra = _message_extra(message)
    # 多角色单消息合并：当 extra 中存在 multi_character 字段时，返回结构化数据。
    # 格式: [{character_id, content, name?}, ...]，用于在同一消息内呈现多个角色发言。
    multi_character = message_extra.get("multi_character") if isinstance(message_extra, dict) else None
    return {
        "id": message.id,
        "message_id": message.id,
        "mesid": mesid,
        "role": message.role,
        "name": _message_display_name(message, char_name=char_name, user_name=user_name),
        "is_name": message_extra.get("is_name"),
        "force_avatar": message_extra.get("force_avatar"),
        "original_avatar": message_extra.get("original_avatar"),
        "avatar": message_extra.get("avatar"),
        "gen_id": message_extra.get("gen_id"),
        "group_id": message_extra.get("group_id"),
        "group_name": message_extra.get("group_name"),
        "selected_group": message_extra.get("selected_group"),
        "groups": message_extra.get("groups"),
        "is_user": is_user,
        "is_system": is_system,
        "content": message.content,
        "mes": message.content,
        "message": message.content,
        "text": message.content,
        "model": message.model,
        "created_at": message.created_at,
        "tokens": message.tokens,
        "prompt_tokens": getattr(message, "prompt_tokens", 0),
        "reasoning_tokens": getattr(message, "reasoning_tokens", 0),
        "branch_id": message.branch_id,
        "short_title": getattr(message, "short_title", None),
        "swipes": swipes,
        "swipe_id": max(0, min(swipe_id_int, len(swipes) - 1)),
        "extra": _extra_without_swipe_info(message_extra),
        "swipe_info": _message_swipe_info(message, swipes),
        "is_hidden": bool(getattr(message, "is_hidden", False)),
        "is_locked": bool(getattr(message, "is_locked", False)),
        "multi_character": multi_character,
    }


def _serialize_character_messages(
    messages: list[CharacterChatMessage],
    *,
    char_name: str = "Character",
    user_name: str = "User",
) -> list[dict]:
    return [
        _serialize_character_message(message, index=index, char_name=char_name, user_name=user_name)
        for index, message in enumerate(messages)
    ]


def _st_message_kwargs(
    *,
    role: str,
    content: str,
    char_name: str = "Character",
    user_name: str = "User",
    name: Optional[str] = None,
    swipes: Optional[list[str]] = None,
    extra: Optional[dict] = None,
    swipe_id: int = 0,
    swipe_info: Optional[list[dict]] = None,
    is_name: Optional[bool] = None,
    force_avatar: Optional[str] = None,
    original_avatar: Optional[str] = None,
    avatar: Optional[str] = None,
    gen_id: Optional[str] = None,
    group_id: Optional[str] = None,
    group_name: Optional[str] = None,
    selected_group=None,
    groups=None,
) -> dict:
    resolved_name = name
    if not resolved_name:
        resolved_name = user_name if role == "user" else "System" if role == "system" else char_name
    normalized_swipes = swipes if isinstance(swipes, list) and swipes else [content or ""]
    normalized_swipe_id = max(0, min(int(swipe_id or 0), len(normalized_swipes) - 1))
    normalized_swipes[normalized_swipe_id] = content or ""
    normalized_extra = _compose_message_extra_with_swipe_info(
        _merge_st_message_extra_fields(
            extra if isinstance(extra, dict) else {},
            is_name=is_name,
            force_avatar=force_avatar,
            original_avatar=original_avatar,
            avatar=avatar,
            gen_id=gen_id,
            group_id=group_id,
            group_name=group_name,
            selected_group=selected_group,
            groups=groups,
        ),
        swipes=normalized_swipes,
        swipe_id=normalized_swipe_id,
        swipe_info=swipe_info,
    )
    return {
        "name": resolved_name,
        "is_user": role == "user",
        "is_system": role == "system",
        "swipe_id": normalized_swipe_id,
        "swipes": _json_dump_or_none(normalized_swipes),
        "extra": _json_dump_or_none(normalized_extra),
    }


def _sync_message_content_to_active_swipe(
    message: CharacterChatMessage,
    content: str,
    *,
    extra: Optional[dict] = None,
    swipe_info: Optional[list[dict]] = None,
) -> None:
    message.content = content or ""
    try:
        current_swipe_id = int(getattr(message, "swipe_id", 0) or 0)
    except (TypeError, ValueError):
        current_swipe_id = 0

    current_swipes = _message_swipes(message)
    if not current_swipes:
        current_swipes = [message.content]
    while len(current_swipes) <= current_swipe_id:
        current_swipes.append("")
    current_swipe_id = max(0, min(current_swipe_id, len(current_swipes) - 1))
    current_swipes[current_swipe_id] = message.content
    message.swipe_id = current_swipe_id
    message.swipes = _json_dump_or_none(current_swipes)

    current_extra = _message_extra(message)
    explicit_display_text = isinstance(extra, dict) and "display_text" in extra
    if not explicit_display_text:
        current_extra.pop("display_text", None)
        raw_swipe_info = current_extra.get("swipe_info")
        if isinstance(raw_swipe_info, list) and current_swipe_id < len(raw_swipe_info):
            active_entry = raw_swipe_info[current_swipe_id]
            if isinstance(active_entry, dict) and isinstance(active_entry.get("extra"), dict):
                active_entry["extra"].pop("display_text", None)
    if isinstance(extra, dict):
        current_extra.update(extra)
    message.extra = _json_dump_or_none(_compose_message_extra_with_swipe_info(
        current_extra,
        swipes=current_swipes,
        swipe_id=current_swipe_id,
        swipe_info=swipe_info,
    ))


def _character_alternate_greetings(char: Character, user_name: str) -> list[str]:
    greetings = _json_load_object(getattr(char, "alternate_greetings", None), [])
    if not isinstance(greetings, list):
        return []
    return [
        _replace_placeholders(item, user_name, char.name or "")
        for item in greetings
        if isinstance(item, str) and item.strip()
    ]


def _get_full_branch_history(db: Session, session_id: str, branch_id: str, limit: int = 60, up_to_message_id: Optional[int] = None) -> list:
    """Return ordered messages by traversing the ancestor branch chain.

    For the target branch itself all messages are loaded.  For each ancestor
    branch only messages up to (and including) the fork-point message are
    loaded so that messages after the fork on a parent branch are excluded.

    If up_to_message_id is provided, the target branch's messages are
    truncated at (and including) that message id - used for "fork from
    here" navigation.
    """
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id,
    ).first()
    if not branch:
        return []

    # Build chain from target branch back to root.
    chain: list = []
    cur = branch
    up_to: int | None = None
    while cur:
        chain.append((cur, up_to))
        if cur.parent_branch_id:
            up_to = cur.parent_message_id
            parent = db.query(CharacterChatSessionBranch).filter(
                CharacterChatSessionBranch.id == cur.parent_branch_id,
                CharacterChatSessionBranch.session_id == session_id,
            ).first()
            cur = parent
        else:
            break

    chain.reverse()

    # E-4 修复: 逐分支 SQL LIMIT——每个分支按 created_at 倒序只取最近 limit 条
    # （再反转恢复升序），并在 SQL 层直接过滤 fork 点之后的 ancestor 消息
    # （id <= up_to_id），替代原「全量加载 + Python 内存截断 deduped[-limit:]」。
    # 长会话数千条历史时不再全量拉取；最终保留的必然来自各分支最新 limit 条，
    # 与原内存截断语义等价（一条消息只属于一个 branch，跨分支无重复 id）。
    all_msgs: list = []
    for idx, (b, up_to_id) in enumerate(chain):
        query = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id == b.id,
        )
        if up_to_id is not None:
            query = query.filter(CharacterChatMessage.id <= up_to_id)
        elif idx == len(chain) - 1 and up_to_message_id is not None:
            query = query.filter(CharacterChatMessage.id <= up_to_message_id)
        branch_msgs = (
            query.order_by(CharacterChatMessage.created_at.desc())
            .limit(limit)
            .all()[::-1]
        )
        all_msgs.extend(branch_msgs)

    seen: set = set()
    deduped: list = []
    for m in all_msgs:
        if m.id not in seen:
            seen.add(m.id)
            # [EMPTY-RESP-FIX] 过滤历史中的错误占位消息：模型空响应时曾把
            # "Error: 模型未返回..." 存成 assistant 消息（2026-08-18 前行为），
            # 若注入提示词会诱导模型继续空响应（恶性循环）。历史残留一律跳过。
            _mc = (m.content or "").strip()
            if _mc.startswith("Error:"):
                continue
            deduped.append(m)
    return deduped[-limit:]

def _get_ancestor_branch_ids(db: Session, session_id: str, branch_id: str) -> list:
    """Return all branch IDs in the ancestry chain from root to the given branch."""
    from sqlalchemy import text
    cte_sql = text("""
        WITH RECURSIVE ancestor_tree AS (
            SELECT id, parent_branch_id FROM character_chat_session_branches WHERE id = :bid
            UNION ALL
            SELECT b.id, b.parent_branch_id
            FROM character_chat_session_branches b
            INNER JOIN ancestor_tree a ON b.id = a.parent_branch_id
        )
        SELECT id FROM ancestor_tree
    """)
    result = db.execute(cte_sql, {"bid": branch_id}).fetchall()
    if not result:
        return []
    return [row[0] for row in reversed(result)]


def _get_full_branch_history_paged(
    db: Session,
    session_id: str,
    branch_id: str,
    limit: int = 10,
    before_id: Optional[int] = None,
    up_to_message_id: Optional[int] = None,
) -> dict:
    """Database-level paginated branch history query.

    Returns {"messages": [...], "has_more": bool} with messages ordered
    chronologically.  Only messages belonging to the current branch and
    its ancestors (up to each fork-point) are included.

    Pagination:
      - If before_id is given, only messages with id < before_id are returned.
      - The *limit* newest matching messages are returned (tail pagination).
      - has_more is True when more older messages exist beyond the page.
    """
    from sqlalchemy import text

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id,
    ).first()
    if not branch:
        return {"messages": [], "has_more": False}

    chain: list = []
    cur = branch
    up_to: int | None = None
    while cur:
        chain.append((cur, up_to))
        if cur.parent_branch_id:
            up_to = cur.parent_message_id
            parent = db.query(CharacterChatSessionBranch).filter(
                CharacterChatSessionBranch.id == cur.parent_branch_id,
                CharacterChatSessionBranch.session_id == session_id,
            ).first()
            cur = parent
        else:
            break
    chain.reverse()

    branch_ids = [b.id for b, _ in chain]

    fork_limits: dict = {}
    for b, up_to_id in chain:
        if up_to_id is not None:
            fork_limits[b.id] = up_to_id

    if up_to_message_id is not None and chain:
        target_branch_id = chain[-1][0].id
        fork_limits[target_branch_id] = up_to_message_id

    if not branch_ids:
        return {"messages": [], "has_more": False}

    params: dict = {
        "session_id": session_id,
    }

    # Expand branch_ids into individual named params for SQLite compatibility
    bid_placeholders = []
    for i, bid in enumerate(branch_ids):
        key = f"bid_{i}"
        bid_placeholders.append(f":{key}")
        params[key] = bid
    bid_in_clause = ", ".join(bid_placeholders)

    fork_clauses = []
    for bid, mid in fork_limits.items():
        # Replace hyphens with underscores to avoid SQL parameter name parsing issues
        safe_bid = bid.replace("-", "_")
        fk_key = f"fk_{safe_bid}"
        params[fk_key] = mid
        fork_clauses.append(f"(m.branch_id != :{fk_key}_bid OR m.id <= :{fk_key})")
        params[f"{fk_key}_bid"] = bid

    fork_where = ""
    if fork_clauses:
        fork_where = "AND " + " AND ".join(fork_clauses)

    before_where = ""
    if before_id is not None:
        before_where = "AND m.id < :before_id"
        params["before_id"] = before_id

    count_sql = text(f"""
        SELECT COUNT(*)
        FROM character_chat_messages m
        WHERE m.session_id = :session_id
          AND m.branch_id IN ({bid_in_clause})
          {fork_where}
          {before_where}
    """)
    total = db.execute(count_sql, params).scalar() or 0

    has_more = total > limit

    data_sql = text(f"""
        SELECT m.id, m.role, m.content
        FROM character_chat_messages m
        WHERE m.session_id = :session_id
          AND m.branch_id IN ({bid_in_clause})
          {fork_where}
          {before_where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT :limit
    """)
    params["limit"] = limit + 50
    rows = list(reversed(db.execute(data_sql, params).fetchall()))
    visible_ids = [
        row[0]
        for row in rows
        if not (row[1] == "user" and is_smart_card_trigger_message(row[2]))
    ]
    if len(visible_ids) > limit:
        visible_ids = visible_ids[-limit:]

    message_map = {}
    if visible_ids:
        for message in (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.id.in_(visible_ids))
            .all()
        ):
            message_map[message.id] = message
    ordered_messages = [message_map[mid] for mid in visible_ids if mid in message_map]
    messages = _serialize_character_messages(
        ordered_messages,
        char_name=getattr(branch.session.character, "name", None) if getattr(branch, "session", None) else "Character",
    )

    return {"messages": messages, "has_more": has_more}


# ───────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, msg, headers, fp)


def _contains_chinese(text: str) -> bool:
    """Check if text contains Chinese characters."""
    return any('一' <= c <= '鿿' for c in text)


def _replace_placeholders(text: str, user_nickname: str = "用户", char_name: str = "") -> str:
    if not text:
        return text
    result = text
    user_patterns = [
        r'\{\{user\}\}', r'\{user\}',
        r'\{\{用户\}\}', r'\{用户\}',
        r'\{\{你\}\}', r'\{你\}',
        r'\{\{您\}\}', r'\{您\}',
    ]
    for pat in user_patterns:
        result = re.sub(pat, user_nickname, result, flags=re.IGNORECASE if 'user' in pat.lower() else 0)
    if char_name:
        char_patterns = [
            r'\{\{char\}\}', r'\{char\}',
            r'\{\{character\}\}', r'\{character\}',
            r'\{\{name\}\}', r'\{name\}',
            r'\{\{角色\}\}', r'\{角色\}',
        ]
        for pat in char_patterns:
            result = re.sub(pat, char_name, result, flags=re.IGNORECASE)
    # 清理SillyTavern模板宏（不支持的功能）
    result = re.sub(r'\{\{setvar::[^}]*\}\}', '', result)
    result = re.sub(r'\{\{addvar::[^}]*\}\}', '', result)
    result = re.sub(r'\{\{trim\}\}', '', result)
    result = re.sub(r'\{\{//.*?\}\}', '', result)  # 注释
    result = re.sub(r'\{\{getvar::[^}]*\}\}', '', result)
    result = re.sub(r'\{\{if::[^}]*\}\}[^{]*\{\{endif\}\}', '', result)
    result = re.sub(r'\n{3,}', '\n\n', result)  # 清理多余空行
    return result


# P1-4 修复: ST 1.18.0 对正则脚本数量无硬上限。原 Palink 限制 20 个会导致
# 复杂角色卡（部分高级卡有 30+ 个脚本）被截断。提高到 100 以兼顾兼容性与性能。
_MAX_REGEX_SCRIPTS = 100
_MAX_REGEX_REPLACE_LEN = 200000
REGEX_PLACEMENT_MD_DISPLAY = 0
REGEX_PLACEMENT_USER_INPUT = 1
REGEX_PLACEMENT_AI_OUTPUT = 2
REGEX_PLACEMENT_SLASH_COMMAND = 3
REGEX_PLACEMENT_WORLD_INFO = 5
REGEX_PLACEMENT_REASONING = 6


def _regex_script_enabled(script: dict) -> bool:
    if _coerce_bool(script.get("disabled"), False):
        return False
    enabled = script.get("enabled")
    return enabled is None or _coerce_bool(enabled, True)


def _is_regex_globally_disabled(db, user_id: Optional[int]) -> bool:
    """检查用户是否在 ST 全局禁用了正则脚本扩展。

    ST 1.18.0 在 ``power_user.disabledExtensions`` 数组中列出被禁用的扩展。
    对于正则脚本扩展，扩展名为 ``"regex"``。当该扩展被全局禁用时，
    所有正则脚本应用都应被跳过（无论其 disabled 标志如何）。

    未传 user_id 或用户无设置时返回 False（不禁用）。
    """
    if not user_id:
        return False
    try:
        setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
    except Exception:
        return False
    if not setting:
        return False
    raw_power_user = getattr(setting, "power_user", None)
    if not isinstance(raw_power_user, str) or not raw_power_user.strip():
        return False
    try:
        power_user = json.loads(raw_power_user)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(power_user, dict):
        return False
    disabled = power_user.get("disabledExtensions")
    if not isinstance(disabled, list):
        return False
    return "regex" in disabled


def _coerce_bool(value, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return fallback


def _coerce_placement_list(value) -> list[int]:
    if isinstance(value, str):
        try:
            return _coerce_placement_list(json.loads(value))
        except (json.JSONDecodeError, TypeError):
            try:
                return [int(value)]
            except (TypeError, ValueError):
                return []
    if isinstance(value, list):
        result: list[int] = []
        for item in value:
            try:
                result.append(int(item))
            except (TypeError, ValueError):
                continue
        return result
    if value is not None:
        try:
            return [int(value)]
        except (TypeError, ValueError):
            return []
    return []


def _normalize_regex_placements_for_st(value) -> list[int]:
    return _coerce_placement_list(value)


def _coerce_depth(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _regex_script_matches_context(
    script: dict,
    *,
    placement: Optional[int],
    is_markdown: bool,
    is_prompt: bool,
    ephemeral: str = "all",
    depth: Optional[int],
    is_edit: bool = False,
) -> bool:
    placements = _normalize_regex_placements_for_st(script.get("placement"))
    if placement is not None:
        # P0-1 修复: ST 1.18.0 (engine.js:374) 使用 `script.placement.includes(placement)`
        # 空数组 includes 永远返回 false，脚本不运行。原 Palink `if placements and ...`
        # 在空列表时跳过判断，错误地把空 placement 当作"匹配所有"。
        # 修复后：placement 非空时，必须在 placements 列表中，否则跳过。
        if placement not in placements:
            return False

    # P1-1 修复: ST 1.18.0 (engine.js:356-359) runOnEdit 检查
    # 当 isEdit=True 且 script.runOnEdit=False 时跳过该脚本。
    # 默认 is_edit=False，不影响现有调用方行为。
    if is_edit:
        run_on_edit = _coerce_bool(script.get("runOnEdit", script.get("run_on_edit")), False)
        if not run_on_edit:
            return False

    markdown_only = _coerce_bool(script.get("markdownOnly", script.get("markdown_only")), False)
    prompt_only = _coerce_bool(script.get("promptOnly", script.get("prompt_only")), False)
    if ephemeral == "display" and not markdown_only:
        return False
    if ephemeral == "prompt" and not prompt_only:
        return False
    if ephemeral == "persist" and (markdown_only or prompt_only):
        return False

    if markdown_only or prompt_only:
        if markdown_only and is_markdown:
            pass
        elif prompt_only and is_prompt:
            pass
        else:
            return False
    elif is_markdown or is_prompt:
        return False

    if depth is not None:
        min_depth = _coerce_depth(script.get("minDepth", script.get("min_depth")))
        max_depth = _coerce_depth(script.get("maxDepth", script.get("max_depth")))
        if min_depth is not None and min_depth >= -1 and depth < min_depth:
            return False
        if max_depth is not None and max_depth >= 0 and depth > max_depth:
            return False

    return True


# ── 正则模式预编译缓存（LRU + 线程安全） ─────────────────────────
# 缓存 find_pattern → (translated_pattern, flags)，避免重复解析+翻译
# 注：Python re 模块自身有内部缓存（re._cache，默认 512），但本缓存覆盖了
# _parse_regex_pattern 中的 _translate_js_regex_to_python 翻译开销
# ST 1.18.0 对齐: RegexProvider (engine.js:44) maxSize=1000
_REGEX_PATTERN_CACHE: OrderedDict[str, tuple] = OrderedDict()
_REGEX_PATTERN_CACHE_LOCK = threading.Lock()
_REGEX_PATTERN_CACHE_MAX = 1000


def _parse_regex_pattern_cached(find_pattern: str) -> tuple:
    """带 LRU 缓存的 _parse_regex_pattern。

    缓存键为原始 find_pattern 字符串（含 JS 风格的 /pattern/flags 包装），
    缓存值为 (translated_python_pattern, flags)。
    """
    with _REGEX_PATTERN_CACHE_LOCK:
        cached = _REGEX_PATTERN_CACHE.get(find_pattern)
        if cached is not None:
            _REGEX_PATTERN_CACHE.move_to_end(find_pattern)
            return cached

    result = _parse_regex_pattern(find_pattern)

    with _REGEX_PATTERN_CACHE_LOCK:
        _REGEX_PATTERN_CACHE[find_pattern] = result
        _REGEX_PATTERN_CACHE.move_to_end(find_pattern)
        while len(_REGEX_PATTERN_CACHE) > _REGEX_PATTERN_CACHE_MAX:
            _REGEX_PATTERN_CACHE.popitem(last=False)

    return result


def invalidate_regex_pattern_cache() -> None:
    """清除正则模式预编译缓存。

    在正则脚本被编辑/导入/删除时调用，确保下次应用正则时使用最新模式。
    """
    with _REGEX_PATTERN_CACHE_LOCK:
        _REGEX_PATTERN_CACHE.clear()


def _parse_regex_pattern(find_pattern: str):
    flags = 0
    pattern = find_pattern
    if pattern.startswith('/'):
        last_slash = pattern.rfind('/')
        if last_slash > 0:
            pattern_flags = pattern[last_slash + 1:]
            pattern = pattern[1:last_slash]
            for f in pattern_flags:
                if f == 'i':
                    flags |= re.IGNORECASE
                elif f == 'm':
                    flags |= re.MULTILINE
                elif f == 's':
                    flags |= re.DOTALL
                    # JS-only flags such as g/u/y/d are intentionally ignored here.
                # Python re.sub is already global, and Unicode is the default.
    pattern = _translate_js_regex_to_python(pattern)
    return pattern, flags


def _translate_js_regex_to_python(pattern: str) -> str:
    """Translate the JS regex constructs most often used by Tavern cards."""
    if not pattern:
        return pattern
    # JS named capture: (?<name>...) -> Python named capture: (?P<name>...)
    pattern = re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", pattern)
    # JS named backreference: \k<name> -> Python named backreference: (?P=name)
    pattern = re.sub(r"\\k<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P=\1)", pattern)
    return pattern


def _substitute_regex_params(text: str, user_name: str = "User", char_name: str = "Character") -> str:
    """ST 1.18.0 substituteParams 对齐: 替换正则脚本中的宏。

    本函数在正则脚本上下文中运行，无法访问 db/character/persona 等
    运行时上下文，因此只支持不依赖这些上下文的宏:
    - 用户/角色名类: {{user}}/{{char}}/{{character}}/{{name1}}/{{name2}}/{{persona}} (persona 降级为 user_name)
    - 时间/日期类: {{time}}/{{date}}/{{datetime}}/{{weekday}}/{{isotime}}/{{isodate}}/{{time_utc}}
    - 控制类: {{newline}}/{{br}}/{{ln}}/{{space}}/{{tab}}/{{noop}}

    注: 角色卡类宏 ({{description}}/{{personality}}/{{scenario}}/{{mesExamples}} 等)
    和变量类宏 ({{getvar::x}}/{{setvar::x::y}} 等) 依赖 db/character 上下文，
    无法在此处支持，需在 PromptAssemblyDeps 重构后由调用方注入 extra_macros。
    参考 ST 1.18.0 script.js:2922 substituteParams 完整宏集合。

    用法: 调用方若需扩展宏集合，可在调用后追加自定义替换。
    """
    result = str(text or "")
    if not result:
        return result

    # 时间/日期类宏（不依赖运行时上下文）
    now = datetime.utcnow()
    weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    # 构建宏字典（按 case-insensitive 匹配）
    replacements: dict[str, str] = {
        # 用户/角色名类
        "{{user}}": user_name,
        "{{char}}": char_name,
        "{{character}}": char_name,
        "{{name1}}": user_name,
        "{{name2}}": char_name,
        # persona 降级为 user_name（无 db 上下文时无法读取真正 persona）
        "{{persona}}": user_name,
        "{{personaName}}": user_name,
        # 时间/日期类
        "{{time}}": now.strftime("%H:%M"),
        "{{time_utc}}": now.strftime("%H:%M"),
        "{{isotime}}": now.strftime("%H:%M:%S"),
        "{{date}}": now.strftime("%Y-%m-%d"),
        "{{isodate}}": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "{{datetime}}": now.strftime("%Y-%m-%d %H:%M"),
        "{{datetimeformat}}": now.strftime("%Y-%m-%d %H:%M:%S"),
        "{{weekday}}": weekday_names[now.weekday()],
        # 控制类
        "{{newline}}": "\n",
        "{{br}}": "\n",
        "{{ln}}": "\n",
        "{{space}}": " ",
        "{{tab}}": "\t",
        "{{noop}}": "",
    }
    for key, value in replacements.items():
        result = re.sub(re.escape(key), lambda v, val=value: val, result, flags=re.IGNORECASE)
    return result


def _escape_regex_macro(text: str) -> str:
    """ST 1.18.0 sanitizeRegexMacro 对齐 (engine.js:304-324)。

    转义宏内容中的正则特殊字符，使其可安全嵌入正则模式。
    对照 ST 实现：转义 \n \r \t \v \f \0 以及 . ^ $ * + ? { } [ ] \ / | ( )
    """
    if not isinstance(text, str) or not text:
        return text
    # ST 1.18.0 使用 char class: /[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs
    # 对照 engine.js:304-324 完整字符集（含控制字符）
    def _replace(m: re.Match) -> str:
        s = m.group(0)
        if s == "\n":
            return "\\n"
        if s == "\r":
            return "\\r"
        if s == "\t":
            return "\\t"
        if s == "\v":
            return "\\v"
        if s == "\f":
            return "\\f"
        if s == "\0":
            return "\\0"
        return "\\" + s
    return re.sub(r"[\n\r\t\v\f\0.^$*+?{}\[\]\\/|()]", _replace, text)


# Public alias for tests / external callers (ST 1.18.0 对齐: sanitizeRegexMacro)
sanitize_regex_macro = _escape_regex_macro


def _normalize_regex_trim_strings(value) -> list:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return _normalize_regex_trim_strings(parsed)
        except (json.JSONDecodeError, TypeError):
            return [value] if value else []
    return []


def _filter_trim_strings(value: str, trim_strings, *, user_name: str = "User", char_name: str = "Character") -> str:
    if not isinstance(value, str):
        return ""
    if not isinstance(trim_strings, list):
        return value
    result = value
    for trim in trim_strings:
        if isinstance(trim, str) and trim:
            # P1-2 修复: ST 1.18.0 (engine.js:460) 对每个 trimString 先做
            # substituteParams 宏替换（含 {{user}}/{{char}} 等），再 replaceAll 移除。
            # 原 Palink 直接 str.replace，导致含宏的 trimString 无法匹配。
            sub_trim = _substitute_regex_params(trim, user_name, char_name)
            if sub_trim:
                result = result.replace(sub_trim, "")
    return result


def _run_regex_script(script: dict, text: str, *, user_name: str = "User", char_name: str = "Character") -> str:
    find_pattern = script.get("findRegex", script.get("find_regex", script.get("find", "")))
    replace_with = script.get("replaceString", script.get("replace_string", script.get("replace", "")))
    if not find_pattern:
        return text
    substitute_regex = script.get("substituteRegex", script.get("substitute_regex", 0))
    try:
        substitute_mode = 1 if isinstance(substitute_regex, bool) and substitute_regex else int(substitute_regex or 0)
    except (TypeError, ValueError):
        substitute_mode = 0
    if substitute_mode == 1:
        find_pattern = _substitute_regex_params(find_pattern, user_name, char_name)
    elif substitute_mode == 2:
        find_pattern = re.sub(
            r"\{\{(?:user|char|character|name1|name2)\}\}",
            lambda m: _escape_regex_macro(_substitute_regex_params(m.group(0), user_name, char_name)),
            find_pattern,
            flags=re.IGNORECASE,
        )
    if len(replace_with or "") > _MAX_REGEX_REPLACE_LEN:
        replace_with = (replace_with or "")[:_MAX_REGEX_REPLACE_LEN]
    replace_template = re.sub(
        r"\{\{match\}\}",
        "$0",
        _substitute_regex_params(replace_with or "", user_name, char_name),
        flags=re.IGNORECASE,
    )
    # [C-5 B 方案] 默认放行、危险模式拦截：角色卡正则替身串里出现全局变量读写类宏
    # （getvar/setvar/addvar/if 等）时剥除，避免模板/装配链潜在展开泄露全局数据。
    # 与 _generic_character_text_sanitize（L781-785）同 semantics：{{user}}/{{char}}/
    # {{match}}/时间宏等合法宏不受影响。
    replace_template = re.sub(r"\{\{getvar::[^}]*\}\}", "", replace_template, flags=re.IGNORECASE)
    replace_template = re.sub(r"\{\{setvar::[^}]*\}\}", "", replace_template, flags=re.IGNORECASE)
    replace_template = re.sub(r"\{\{addvar::[^}]*\}\}", "", replace_template, flags=re.IGNORECASE)
    replace_template = re.sub(r"\{\{(?:get|set|inc|del)globalvar::[^}]*\}\}", "", replace_template, flags=re.IGNORECASE)
    replace_template = re.sub(r"\{\{if::[^}]*\}\}[^{]*\{\{endif\}\}", "", replace_template, flags=re.IGNORECASE)
    trim_strings = _normalize_regex_trim_strings(script.get("trimStrings", script.get("trim_strings", [])))
    pattern, flags = _parse_regex_pattern_cached(find_pattern)

    def replacer(match: re.Match) -> str:
        def replace_group(group_match: re.Match) -> str:
            num = group_match.group(1)
            name = group_match.group(2)
            try:
                if num is not None:
                    group_value = match.group(int(num))
                elif name is not None:
                    group_value = match.group(name)
                else:
                    group_value = ""
            except (IndexError, KeyError):
                group_value = ""
            return _filter_trim_strings(group_value or "", trim_strings, user_name=user_name, char_name=char_name)

        return re.sub(r'\$(\d+)|\$<([^>]+)>', replace_group, replace_template)

    return re.sub(pattern, replacer, text, flags=flags)


def _apply_regex_scripts(
    text: str,
    extensions_raw,
    *,
    placement: Optional[int] = 2,
    is_markdown: bool = True,
    is_prompt: bool = False,
    ephemeral: str = "all",
    depth: Optional[int] = 0,
    user_name: str = "User",
    char_name: str = "Character",
    is_edit: bool = False,
    allowed_regex_names: Optional[list[str]] = None,
) -> str:
    """Apply SillyTavern regex scripts to text.

    ST 1.18.0 对齐:
    - character_allowed_regex: 若 provided，仅应用 scriptName 在白名单中的脚本
      (参考 index.js:1395 applySettings 的 character_allowed_regex 检查)
    - 顺序: GLOBAL → SCOPED → PRESET (调用方负责分层调用)
    """
    if not text or not extensions_raw:
        return text
    try:
        ext = json.loads(extensions_raw) if isinstance(extensions_raw, str) else extensions_raw
    except (json.JSONDecodeError, TypeError):
        return text
    if not isinstance(ext, dict):
        return text
    scripts = ext.get("regex_scripts")
    if not isinstance(scripts, list):
        return text
    applied = 0
    for script in scripts:
        if applied >= _MAX_REGEX_SCRIPTS:
            break
        if not isinstance(script, dict):
            continue
        if not _regex_script_enabled(script):
            continue
        # ST 1.18.0 character_allowed_regex 白名单过滤
        # 若 provided，仅应用 scriptName 在白名单中的脚本
        if allowed_regex_names is not None:
            script_name = str(script.get("scriptName", script.get("script_name", "")) or "")
            if script_name not in allowed_regex_names:
                continue
        if not _regex_script_matches_context(
            script,
            placement=placement,
            is_markdown=is_markdown,
            is_prompt=is_prompt,
            ephemeral=ephemeral,
            depth=depth,
            is_edit=is_edit,
        ):
            continue
        try:
            text = _run_regex_script(script, text, user_name=user_name, char_name=char_name)
            applied += 1
        except re.error:
            continue
    text = _convert_html_code_blocks_to_markers(text)
    return text


def _convert_html_code_blocks_to_markers(text: str) -> str:
    """Convert ```html...``` code blocks to <palink-html>...</palink-html> markers.
    Uses balanced backtick matching so internal backticks (e.g. JS template literals)
    don't break the extraction."""
    def replacer(match):
        content = match.group(2)
        return f'<palink-html>{content}</palink-html>'
    return re.sub(r'(`{3,})html\s*\r?\n([\s\S]*?)\r?\n\1', replacer, text)


def _regex_signature_from_dict(script: dict) -> tuple:
    pattern, _flags = _parse_regex_pattern_cached(str(script.get("findRegex", script.get("find", "")) or ""))
    return (
        pattern,
        str(script.get("replaceString", script.get("replace", "")) or ""),
    )


def _character_regex_signatures(extensions_raw) -> set:
    try:
        ext = json.loads(extensions_raw) if isinstance(extensions_raw, str) else extensions_raw
    except (json.JSONDecodeError, TypeError):
        return set()
    if not isinstance(ext, dict) or not isinstance(ext.get("regex_scripts"), list):
        return set()
    return {
        _regex_signature_from_dict(script)
        for script in ext["regex_scripts"]
        if isinstance(script, dict)
    }


def _plugin_script_to_regex_dict(script) -> dict:
    original = None
    if getattr(script, "content", None):
        try:
            parsed = json.loads(script.content)
            if isinstance(parsed, dict):
                original = parsed
        except (json.JSONDecodeError, TypeError):
            original = None
    if original:
        result = dict(original)
        result.setdefault("scriptName", script.script_name or "")
        result.setdefault("findRegex", script.find_regex or "")
        result.setdefault("replaceString", script.replace_string or "")
        result.setdefault("enabled", bool(script.enabled))
        return result

    try:
        placement = json.loads(script.placement) if script.placement else None
    except (json.JSONDecodeError, TypeError):
        placement = None
    try:
        trim_strings = json.loads(script.trim_strings) if script.trim_strings else []
    except (json.JSONDecodeError, TypeError):
        trim_strings = []
    return {
        "scriptName": script.script_name or "",
        "findRegex": script.find_regex or "",
        "replaceString": script.replace_string or "",
        "trimStrings": trim_strings,
        "placement": placement,
        "markdownOnly": bool(script.markdown_only),
        "promptOnly": bool(script.prompt_only),
        "minDepth": script.min_depth,
        "maxDepth": script.max_depth,
        "enabled": bool(script.enabled),
    }


def _plugin_allows_global_regex_runtime(plugin) -> bool:
    if not plugin:
        return False

    if getattr(plugin, "source_type", None) == "character_card_extension":
        return False

    config = {}
    raw_config = getattr(plugin, "config", None)
    if raw_config:
        try:
            parsed = json.loads(raw_config) if isinstance(raw_config, str) else raw_config
            if isinstance(parsed, dict):
                config = parsed
        except (json.JSONDecodeError, TypeError):
            config = {}

    if config.get("global_runtime") is False:
        return False
    if isinstance(config.get("scope"), str) and config["scope"] != "global":
        return False
    if config.get("character_card_extension") is True and config.get("global_runtime") is not True:
        return False

    # Legacy imports from character-card extension payloads were named this way
    # before we stored explicit config. They must not mutate other characters.
    name = getattr(plugin, "name", "") or ""
    if (
        getattr(plugin, "plugin_type", None) == "regex_scripts"
        and getattr(plugin, "source_type", None) == "sillytavern"
        and isinstance(name, str)
        and name.endswith(" - 正则脚本")
    ):
        return False

    return True


def _load_plugin_regex_script_dicts(db) -> list:
    """E-7 修复: 一次性加载全部启用的全局插件 regex 脚本（dict 形式）。

    供请求级复用（如 `_apply_prompt_regex_to_messages` 消息循环），
    避免每条消息重复查询 PluginScript 表。
    """
    try:
        from ..models.plugin import Plugin, PluginScript
        scripts = db.query(PluginScript).join(Plugin).filter(
            Plugin.enabled == True,
            PluginScript.enabled == True,
            PluginScript.script_type == "regex",
            PluginScript.find_regex != None,
        ).order_by(PluginScript.order_no).all()
        result = []
        for script in scripts[:_MAX_REGEX_SCRIPTS]:
            if not _plugin_allows_global_regex_runtime(script.plugin):
                continue
            result.append(_plugin_script_to_regex_dict(script))
        return result
    except Exception:
        return []


def _apply_plugin_regex_script_dicts(
    text: str,
    regex_scripts: list,
    *,
    skip_signatures=None,
    placement: Optional[int] = 2,
    is_markdown: bool = True,
    is_prompt: bool = False,
    ephemeral: str = "all",
    depth: Optional[int] = 0,
    user_name: str = "User",
    char_name: str = "Character",
    is_edit: bool = False,
) -> str:
    """E-7 修复: 对已加载的 regex 脚本 dict 列表做纯内存应用（不查库）。

    与 `_apply_plugin_regex_scripts` 的应用逻辑保持一致：
    - skip_signatures: 跳过被角色卡 scoped 脚本遮蔽的全局脚本
    - _regex_script_matches_context: 位置/深度/编辑态过滤
    - _run_regex_script: 实际替换
    """
    if not text:
        return text
    for regex_script in regex_scripts:
        try:
            if skip_signatures and _regex_signature_from_dict(regex_script) in skip_signatures:
                continue
            if not _regex_script_matches_context(
                regex_script,
                placement=placement,
                is_markdown=is_markdown,
                is_prompt=is_prompt,
                ephemeral=ephemeral,
                depth=depth,
                is_edit=is_edit,
            ):
                continue
            text = _run_regex_script(regex_script, text, user_name=user_name, char_name=char_name)
        except re.error:
            continue
    return text


def _apply_plugin_regex_scripts(
    text: str,
    db,
    *,
    placement: Optional[int] = 2,
    is_markdown: bool = True,
    is_prompt: bool = False,
    ephemeral: str = "all",
    depth: Optional[int] = 0,
    skip_extensions=None,
    user_name: str = "User",
    char_name: str = "Character",
    is_edit: bool = False,
    # P2-9 修复: 支持从 extension_settings.regex_scripts 读取 ST 插件写入的 regex 脚本
    user_id: Optional[int] = None,
) -> str:
    if not text:
        return text
    try:
        skip_signatures = _character_regex_signatures(skip_extensions)
        plugin_scripts = _load_plugin_regex_script_dicts(db)
        text = _apply_plugin_regex_script_dicts(
            text,
            plugin_scripts,
            skip_signatures=skip_signatures,
            placement=placement,
            is_markdown=is_markdown,
            is_prompt=is_prompt,
            ephemeral=ephemeral,
            depth=depth,
            user_name=user_name,
            char_name=char_name,
            is_edit=is_edit,
        )
    except Exception:
        pass

    # P2-9 修复: 同步 extension_settings.regex_scripts — ST 插件通过
    # setExtensionSettings 写入的 regex_scripts 数组（与 Palink Plugin 表隔离）。
    # 这里直接从 UserSetting.silly_tavern_settings 读取并应用，使 ST 插件写入的
    # 全局 regex 脚本在 Palink 生成流水线中生效。
    if user_id is not None:
        try:
            ext_scripts = _load_extension_settings_regex_scripts(db, user_id)
            text = _apply_plugin_regex_script_dicts(
                text,
                ext_scripts[:_MAX_REGEX_SCRIPTS],
                skip_signatures=skip_signatures,
                placement=placement,
                is_markdown=is_markdown,
                is_prompt=is_prompt,
                ephemeral=ephemeral,
                depth=depth,
                user_name=user_name,
                char_name=char_name,
                is_edit=is_edit,
            )
        except Exception:
            pass

    text = _convert_html_code_blocks_to_markers(text)
    return text


def _load_extension_settings_regex_scripts(db, user_id: int) -> list:
    """P2-9: 从 UserSetting.silly_tavern_settings.extension_settings.regex_scripts
    读取 ST 插件写入的 regex 脚本（camelCase 格式），归一化为 Palink 内部 dict 格式。

    ST extension_settings.regex_scripts 是数组，每个元素含 camelCase 字段：
    {scriptName, findRegex, replaceString, trimStrings, placement, disabled,
     markdownOnly, promptOnly, runOnEdit, substituteRegex, minDepth, maxDepth, order}
    """
    try:
        from ..models.user_setting import UserSetting
        setting = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        if not setting or not setting.silly_tavern_settings:
            return []
        raw = setting.silly_tavern_settings
        if isinstance(raw, str):
            data = json.loads(raw)
        elif isinstance(raw, dict):
            data = raw
        else:
            return []
        ext_settings = data.get("extension_settings") if isinstance(data, dict) else None
        if not isinstance(ext_settings, dict):
            return []
        raw_scripts = ext_settings.get("regex_scripts")
        if not isinstance(raw_scripts, list):
            return []
        result = []
        for s in raw_scripts:
            if not isinstance(s, dict):
                continue
            # 跳过 disabled 脚本
            if s.get("disabled", False):
                continue
            find_regex = s.get("findRegex") or s.get("find_regex")
            if not find_regex:
                continue
            # 归一化为 Palink 内部格式（snake_case）
            result.append({
                "scriptName": s.get("scriptName") or s.get("name") or "ST Extension Regex",
                "findRegex": find_regex,
                "replaceString": s.get("replaceString") or s.get("replace_string") or "",
                "trimStrings": s.get("trimStrings") or s.get("trim_strings") or [],
                "placement": s.get("placement") or [],
                "disabled": False,
                "markdownOnly": s.get("markdownOnly", s.get("markdown_only", False)),
                "promptOnly": s.get("promptOnly", s.get("prompt_only", False)),
                "runOnEdit": s.get("runOnEdit", s.get("run_on_edit", False)),
                "substituteRegex": s.get("substituteRegex", s.get("substitute_regex", 0)),
                "minDepth": s.get("minDepth", s.get("min_depth")),
                "maxDepth": s.get("maxDepth", s.get("max_depth")),
                "order": s.get("order", 0),
            })
        return result
    except Exception:
        return []


def _extract_preset_regex_scripts_from_character(char: Character) -> list:
    if not getattr(char, "preset_data", None):
        return []
    try:
        preset_data = json.loads(char.preset_data) if isinstance(char.preset_data, str) else char.preset_data
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(preset_data, dict):
        return []
    extensions = preset_data.get("extensions")
    if isinstance(extensions, dict) and isinstance(extensions.get("regex_scripts"), list):
        return extensions["regex_scripts"]
    prompts = preset_data.get("prompts")
    if isinstance(prompts, list):
        scripts = []
        for prompt in prompts:
            if not isinstance(prompt, dict):
                continue
            prompt_ext = prompt.get("extensions")
            if isinstance(prompt_ext, dict) and isinstance(prompt_ext.get("regex_scripts"), list):
                scripts.extend(prompt_ext["regex_scripts"])
        return scripts
    return []


def _apply_prompt_regex_to_messages(messages: list, db, char: Character, user_name: str = "User", user_id: Optional[int] = None) -> list:
    if not messages:
        return messages

    # ST 1.18.0: 当用户在 power_user.disabledExtensions 中禁用 regex 扩展时，
    # 跳过所有正则脚本的应用（包括 GLOBAL/SCOPED/PRESET 三层）。
    if _is_regex_globally_disabled(db, getattr(char, "user_id", None)):
        return messages

    scoped_extensions = char.extensions
    preset_scripts = _extract_preset_regex_scripts_from_character(char)
    # E-7 修复: 请求级预加载全局插件脚本与 ST extension_settings 脚本，
    # 消息循环内不再重复查询 PluginScript / UserSetting（每消息 2 次 → 每请求 2 次）。
    plugin_script_dicts = _load_plugin_regex_script_dicts(db)
    ext_script_dicts = _load_extension_settings_regex_scripts(db, user_id) if user_id is not None else []
    skip_signatures = _character_regex_signatures(scoped_extensions)

    total = len(messages)
    transformed = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            transformed.append(message)
            continue
        content = message.get("content")
        if not isinstance(content, str) or not content:
            transformed.append(message)
            continue
        depth = max(0, total - 1 - index)
        role = str(message.get("role") or "").lower()
        prompt_placement = (
            REGEX_PLACEMENT_AI_OUTPUT
            if role in {"assistant", "character", "model"}
            else REGEX_PLACEMENT_USER_INPUT
        )
        next_content = content
        next_content = _apply_plugin_regex_script_dicts(
            next_content,
            plugin_script_dicts,
            skip_signatures=skip_signatures,
            placement=prompt_placement,
            is_markdown=False,
            is_prompt=True,
            ephemeral="prompt",
            depth=depth,
            user_name=user_name,
            char_name=char.name or "Character",
        )
        # P2-9 修复: ST extension_settings.regex_scripts（请求级已预加载）
        if ext_script_dicts:
            next_content = _apply_plugin_regex_script_dicts(
                next_content,
                ext_script_dicts,
                skip_signatures=skip_signatures,
                placement=prompt_placement,
                is_markdown=False,
                is_prompt=True,
                ephemeral="prompt",
                depth=depth,
                user_name=user_name,
                char_name=char.name or "Character",
            )
        # ST 标准顺序：GLOBAL → SCOPED → PRESET
        if scoped_extensions:
            next_content = _apply_regex_scripts(
                next_content,
                scoped_extensions,
                placement=prompt_placement,
                is_markdown=False,
                is_prompt=True,
                ephemeral="prompt",
                depth=depth,
                user_name=user_name,
                char_name=char.name or "Character",
            )
        if preset_scripts:
            next_content = _apply_regex_scripts(
                next_content,
                {"regex_scripts": preset_scripts},
                placement=prompt_placement,
                is_markdown=False,
                is_prompt=True,
                ephemeral="prompt",
                depth=depth,
                user_name=user_name,
                char_name=char.name or "Character",
            )
        transformed.append({**message, "content": next_content})
    return transformed


def _apply_persist_regex_to_display_text(
    text: str,
    db,
    char: Character,
    *,
    user_name: str = "User",
    placement: int = REGEX_PLACEMENT_AI_OUTPUT,
    depth: int = 0,
) -> str:
    """Apply SillyTavern's non-ephemeral regex scripts before saving chat text.

    SillyTavern writes normal regex replacements into the chat file. Scripts marked
    markdownOnly or promptOnly are ephemeral and are handled by the frontend display
    layer or prompt construction respectively.
    """
    if not text:
        return text
    # ST 1.18.0: 当用户在 power_user.disabledExtensions 中禁用 regex 扩展时，
    # 跳过所有正则脚本的应用（不影响正则流程）。
    regex_globally_disabled = _is_regex_globally_disabled(db, getattr(char, "user_id", None))
    if regex_globally_disabled:
        return text
    result = _apply_plugin_regex_scripts(
        text,
        db,
        placement=placement,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=depth,
        skip_extensions=char.extensions,
        user_name=user_name,
        char_name=char.name or "Character",
        # P2-9 修复: 透传 user_id 以读取 extension_settings.regex_scripts
        user_id=getattr(char, "user_id", None),
    )
    # ST 标准顺序：GLOBAL → SCOPED → PRESET
    result = _apply_regex_scripts(
        result,
        char.extensions,
        placement=placement,
        is_markdown=False,
        is_prompt=False,
        ephemeral="persist",
        depth=depth,
        user_name=user_name,
        char_name=char.name or "Character",
    )
    preset_scripts = _extract_preset_regex_scripts_from_character(char)
    if preset_scripts:
        result = _apply_regex_scripts(
            result,
            {"regex_scripts": preset_scripts},
            placement=placement,
            is_markdown=False,
            is_prompt=False,
            ephemeral="persist",
            depth=depth,
            user_name=user_name,
            char_name=char.name or "Character",
        )
    return result


def _build_character_card_attributes(char: Character, prompt_lang: str) -> str:
    fields = [
        ("核心设定" if prompt_lang == "zh" else "Core Instructions", char.system_prompt),
        ("性格" if prompt_lang == "zh" else "Personality", char.personality),
        ("背景" if prompt_lang == "zh" else "Background", char.background),
        ("场景" if prompt_lang == "zh" else "Scenario", char.scenario),
        ("描述" if prompt_lang == "zh" else "Description", char.description),
        ("创作者备注" if prompt_lang == "zh" else "Creator Notes", char.creator_notes),
    ]
    return "\n".join(f"{label}: {value.strip()}" for label, value in fields if value and value.strip())


def _replace_character_card_placeholders(text: str, char: Character, prompt_lang: str, dialogue_mode: str) -> str:
    from ..core.default_prompts import DIALOGUE_MODE_ZH, DIALOGUE_MODE_EN

    char_name = char.name or "Character"
    dialogue_templates = DIALOGUE_MODE_ZH if prompt_lang == "zh" else DIALOGUE_MODE_EN
    default_mode = dialogue_templates["first_person"]
    values = {
        "system_prompt": char.system_prompt or "",
        "personality": char.personality or "",
        "background": char.background or "",
        "scenario": char.scenario or "",
        "description": char.description or "",
        "creator_notes": char.creator_notes or "",
        "attributes": _build_character_card_attributes(char, prompt_lang),
        "dialogue_mode": dialogue_templates.get(dialogue_mode, default_mode).format(name=char_name),
    }
    result = text
    for key, value in values.items():
        result = re.sub(r"\{\{" + key + r"\}\}|\{" + key + r"\}", value, result, flags=re.IGNORECASE)
    return result


def _build_character_card_block(char: Character, prompt_lang: str) -> str:
    attributes = _build_character_card_attributes(char, prompt_lang)
    if not attributes:
        return ""
    title = "【角色卡】" if prompt_lang == "zh" else "[Character Card]"
    return title + "\n" + attributes


def _custom_prompt_contains_character_card_variable(text: str) -> bool:
    return any(
        re.search(r"\{\{" + key + r"\}\}|\{" + key + r"\}", text, flags=re.IGNORECASE)
        for key in ("system_prompt", "personality", "background", "scenario", "description", "creator_notes", "attributes")
    )


def _detect_preset_type(preset_data: dict) -> str:
    """检测预设类型：roleplay（角色扮演增强）或 creation（创作助手）。

    创作助手预设的特征：
    - 包含角色身份设定（assistant角色的提示词设定了助手身份）
    - 包含输出格式覆盖（YAML、代码块、<thinking>/<content>等）
    - 包含思维链要求（<thinking>、[metacognition]等）
    - 包含创作模板/知识库（角色卡模板、世界观模板等）
    """
    prompts = preset_data.get("prompts", [])
    creation_signals = 0

    for p in prompts:
        if not isinstance(p, dict) or not p.get("enabled", False):
            continue
        content = (p.get("content", "") or "").lower()
        name = (p.get("name", "") or "").lower()
        role = p.get("role", "")

        # 信号1：assistant角色设定了助手身份（如秋青子）
        if role == "assistant" and len(content) > 50:
            creation_signals += 2

        # 信号2：要求<thinking>/<content>格式
        if "<thinking>" in content or "<content>" in content or "[metacognition]" in content:
            creation_signals += 2

        # 信号3：要求YAML/代码块输出
        if "yaml" in content and ("代码块" in content or "```" in content):
            creation_signals += 1

        # 信号4：创作模板/知识库相关
        template_keywords = ["template_", "创作指南", "创作指导", "模板", "知识库", "addvar"]
        if any(kw in content for kw in template_keywords):
            creation_signals += 1

        # 信号5：助手身份关键词
        assistant_keywords = ["哥哥", "助手", "秘书", "秋青子", "蛇娘"]
        if any(kw in content for kw in assistant_keywords):
            creation_signals += 1

    return "creation" if creation_signals >= 3 else "roleplay"


def _filter_preset_for_roleplay(prompts: list, preset_type: str) -> list:
    """过滤预设提示词，移除与角色扮演冲突的内容。

    对于创作助手类预设：
    - 移除assistant角色的身份设定（如秋青子身份）
    - 移除思维链要求（<thinking>、[metacognition]）
    - 移除输出格式覆盖（YAML、代码块、<content>）
    - 保留：创作原则（白描、绝对零度等）、反审查、写作指导
    """
    if preset_type != "creation":
        return prompts

    # 需要过滤的内容模式
    format_override_patterns = [
        r"<thinking>", r"</thinking>", r"<content>", r"</content>",
        r"\[metacognition\]",
        r"yaml", r"代码块", r"```",
        r"输出格式要求", r"输出格式（强制",
    ]

    assistant_identity_patterns = [
        r"秋青子", r"蛇娘", r"秘书", r"助手",
        r"哥哥",  # 助手对用户的称呼
    ]

    filtered = []
    for p in prompts:
        content = p.get("content", "")
        name = p.get("name", "")
        role = p.get("role", "")
        content_lower = content.lower()

        # 规则1：移除assistant角色的身份设定
        if role == "assistant":
            logger.info("Filtering out assistant role prompt: %s", name)
            continue

        # 规则2：移除思维链相关提示词（但保留"禁止泄露思维链"的反审查提示词）
        thinking_require_keywords = ["<thinking>", "[metacognition]", "</thinking>"]
        thinking_prohibit_keywords = ["不泄露思维链", "禁止输出思维链", "不得泄露思维链", "不输出思维链"]
        requires_thinking = any(kw.lower() in content_lower for kw in thinking_require_keywords)
        prohibits_thinking = any(kw in content for kw in thinking_prohibit_keywords)

        if requires_thinking and not prohibits_thinking:
            # 检查是否同时包含有用的创作原则
            has_useful_content = any(kw in content for kw in ["绝对零度", "白描", "八股", "形容词", "意象词"])
            if not has_useful_content:
                logger.info("Filtering out thinking chain prompt: %s", name)
                continue
            # 如果同时包含有用内容，剥离思维链部分
            for pattern in [r"<thinking>.*?</thinking>", r"\[metacognition\]", r"</thinking>", r"<thinking>"]:
                content = re.sub(pattern, "", content, flags=re.DOTALL)
            content = content.strip()
            if not content:
                continue
            p = {**p, "content": content}

        # 规则3：移除强制输出格式覆盖（YAML/代码块/<content>）
        has_format_override = (
            ("<content>" in content_lower and "</content>" in content_lower)
            or ("yaml" in content_lower and "代码块" in content_lower)
            or ("输出格式" in content and "强制" in content)
        )
        if has_format_override:
            # 检查是否同时包含有用的创作原则
            has_useful = any(kw in content for kw in ["绝对零度", "白描", "八股", "形容词", "意象词", "创作原则"])
            if not has_useful:
                logger.info("Filtering out format override prompt: %s", name)
                continue

        # 规则4：不再按身份关键词密度过滤整条提示词
        # 反审查提示词（如Catbox破限）虽然包含助手身份词，但其核心功能是反安全审查，必须保留
        # 身份引用会在规则5中被替换为角色扮演兼容的表述

        # 规则4.5：移除纯创作分析步骤（在角色对话中不需要"分析任务类型"等步骤）
        creation_analysis_keywords = ["创作角色卡", "创作世界观", "创作场景", "创作NPC", "创作开场白", "整理角色速览", "整理世界观"]
        if sum(1 for kw in creation_analysis_keywords if kw in content) >= 3:
            logger.info("Filtering out creation analysis prompt: %s", name)
            continue

        # 规则5：清理内容中的格式覆盖指令和助手身份引用
        cleaned_content = content
        # 移除<thinking>...</thinking>块
        cleaned_content = re.sub(r"<thinking>.*?</thinking>", "", cleaned_content, flags=re.DOTALL)
        # 移除[metacognition]标记
        cleaned_content = re.sub(r"\[metacognition\]", "", cleaned_content)
        # 移除<content></content>标签（保留内容）
        cleaned_content = re.sub(r"</?content>", "", cleaned_content)
        # 移除"必须使用YAML/代码块"的指令
        cleaned_content = re.sub(r"必须使用YAML[^。]*。", "", cleaned_content)
        cleaned_content = re.sub(r"必须用代码块[^。]*。", "", cleaned_content)
        cleaned_content = re.sub(r"禁止在标签外输出[^。]*。", "", cleaned_content)
        cleaned_content = re.sub(r"铁律：.*?(?=\n\n|\Z)", "", cleaned_content, flags=re.DOTALL)
        # 替换助手身份引用为角色扮演兼容的表述
        cleaned_content = re.sub(r"秋青子[：:]", "角色：", cleaned_content)
        cleaned_content = re.sub(r"秋青子", "角色", cleaned_content)
        cleaned_content = re.sub(r"蛇娘", "角色", cleaned_content)
        cleaned_content = re.sub(r"哥哥", "用户", cleaned_content)
        # 清理多余空行
        cleaned_content = re.sub(r"\n{3,}", "\n\n", cleaned_content).strip()

        if cleaned_content:
            p = {**p, "content": cleaned_content}

        filtered.append(p)

    return filtered


def _extract_preset_prompts(preset_data: dict, user_nickname: str = "用户", char_name: str = "") -> list:
    """从SillyTavern预设数据中提取有效的提示词条目。

    返回按injection_order排序的、已启用且有实际内容的提示词列表。
    每个元素: {"role": str, "content": str, "name": str}
    """
    prompts = preset_data.get("prompts", [])
    if not isinstance(prompts, list):
        return []

    # 标记类identifier（SillyTavern用来标记位置的，不是实际内容）
    marker_identifiers = {
        "worldInfoBefore", "charDescription", "personaDescription",
        "charPersonality", "scenario", "worldInfoAfter", "dialogueExamples",
        "chatHistory",
    }

    # SillyTavern特殊功能标识符（由平台自身处理，不需要注入）
    special_identifiers = {
        "nsfw", "jailbreak", "enhanceDefinitions",
    }

    result = []
    for p in prompts:
        if not isinstance(p, dict):
            continue
        # 只处理启用的提示词
        if not p.get("enabled", False):
            continue
        identifier = p.get("identifier", "")
        # 跳过标记类条目
        if identifier in marker_identifiers:
            continue
        # 跳过SillyTavern特殊功能标识符
        if identifier in special_identifiers:
            continue
        # 跳过marker条目
        if p.get("marker", False):
            continue
        content = p.get("content", "")
        if not content or not content.strip():
            continue
        # 跳过只包含模板宏的内容（如变量初始化等）
        stripped = content.strip()
        # 先清理模板宏后再检查
        cleaned = re.sub(r'\{\{(setvar::|addvar::|trim|//|getvar::|if::|endif)[^}]*\}\}', '', stripped)
        if not cleaned.strip():
            continue

        # 替换占位符
        content = _replace_placeholders(content, user_nickname, char_name)
        if not content.strip():
            continue

        result.append({
            "role": p.get("role", "system"),
            "content": content.strip(),
            "name": p.get("name", ""),
            "injection_order": p.get("injection_order", 0),
        })

    # 按injection_order排序
    result.sort(key=lambda x: x["injection_order"])
    return result


def _build_char_system_prompt(char: Character, user_nickname: str = "用户", dialogue_mode: str = "first_person", prompt_lang: str = "auto", user_setting: Optional[UserSetting] = None) -> str:
    """Build character system prompt using config file.

    Args:
        char: Character object
        user_nickname: User's nickname
        dialogue_mode: 'first_person' or 'third_person'
        prompt_lang: 'auto', 'zh', or 'en'
        user_setting: User's settings (for custom prompts)
    """
    # Auto-detect language if needed
    if prompt_lang == "auto":
        has_chinese = any('一' <= c <= '鿿' for c in (char.name or "") + (char.description or "")[:100])
        prompt_lang = "zh" if has_chinese else "en"

    show_character_status = False
    if user_setting and user_setting.show_character_status:
        show_character_status = True

    # Check if user has custom prompts enabled
    if user_setting and user_setting.use_custom_prompts:
        custom_prompt = None
        if prompt_lang == "zh" and user_setting.custom_character_prompt_zh:
            custom_prompt = user_setting.custom_character_prompt_zh
        elif prompt_lang == "en" and user_setting.custom_character_prompt_en:
            custom_prompt = user_setting.custom_character_prompt_en

        if custom_prompt:
            has_character_card_variable = _custom_prompt_contains_character_card_variable(custom_prompt)
            custom_prompt = _replace_placeholders(custom_prompt, user_nickname, char.name or "Character")
            custom_prompt = _replace_character_card_placeholders(custom_prompt, char, prompt_lang, dialogue_mode)
            if not has_character_card_variable:
                character_card_block = _build_character_card_block(char, prompt_lang)
                if character_card_block:
                    custom_prompt += "\n\n" + character_card_block
            # 注入预设提示词
            custom_prompt = _inject_preset_into_prompt(char, custom_prompt, user_nickname)
            return custom_prompt

    # Build system prompt using default config
    from ..core.default_prompts import build_default_character_prompt

    # [B-4 A 方案对齐 ST] prefer_character_prompt（ST power_user.prefer_character_prompt，
    # 默认 true）决定角色卡 system_prompt 是否作为 main 槽头部 override：
    # - true（默认）且角色 system_prompt 非空 → 作为角色设定总纲置于核心规则层之上
    #   （ST 语义：charPrompt 决定 system 槽，角色设定优先于用户全局）；
    # - false（或空）→ 忽略角色 system_prompt，回落默认三层模板（ST：退回用户全局 sysprompt）。
    prefer_char_prompt = True
    if user_setting and user_setting.power_user:
        try:
            _pu = json.loads(user_setting.power_user) if isinstance(user_setting.power_user, str) else user_setting.power_user
            if isinstance(_pu, dict):
                prefer_char_prompt = bool(_pu.get("prefer_character_prompt", True))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    effective_char_prompt = char.system_prompt if prefer_char_prompt else ""
    system_prompt = build_default_character_prompt(
        char_name=char.name or "Character",
        user_nickname=user_nickname,
        dialogue_mode=dialogue_mode,
        lang=prompt_lang,
        personality=char.personality,
        background=char.background,
        scenario=char.scenario,
        description=char.description,
        custom_prompt=effective_char_prompt or "",
        show_character_status=show_character_status,
        creator_notes=char.creator_notes or "",
        char=char
    )

    # 注入预设提示词
    system_prompt = _inject_preset_into_prompt(char, system_prompt, user_nickname)

    return system_prompt


def _inject_preset_into_prompt(char: Character, system_prompt: str, user_nickname: str) -> str:
    """将角色的SillyTavern预设提示词注入到系统提示词中。"""
    if not char.preset_data:
        return system_prompt

    try:
        preset_data = json.loads(char.preset_data) if isinstance(char.preset_data, str) else char.preset_data
    except (json.JSONDecodeError, TypeError):
        return system_prompt

    # 检测预设类型
    preset_type = _detect_preset_type(preset_data)
    logger.info("Detected preset type: %s for character '%s'", preset_type, char.name)

    # 提取预设提示词
    preset_prompts = _extract_preset_prompts(preset_data, user_nickname, char.name or "")
    if not preset_prompts:
        logger.info("Preset found for character '%s' but no valid prompts extracted", char.name)
        return system_prompt

    # 对创作助手类预设进行智能过滤
    preset_prompts = _filter_preset_for_roleplay(preset_prompts, preset_type)

    if not preset_prompts:
        logger.info("All preset prompts filtered out for character '%s'", char.name)
        return system_prompt

    logger.info("Injecting %d preset prompts (type=%s) for character '%s'", len(preset_prompts), preset_type, char.name)

    # 只保留system角色的提示词（assistant角色已在过滤阶段移除）
    system_prompts = [p for p in preset_prompts if p["role"] == "system"]

    parts = []
    if system_prompts:
        for p in system_prompts:
            name_tag = f"[{p['name']}]" if p['name'] else ""
            parts.append(f"{name_tag}\n{p['content']}" if name_tag else p['content'])

    if parts:
        preset_text = "\n\n".join(parts)
        system_prompt = system_prompt + "\n\n" + preset_text

    # 对创作助手类预设，追加格式重申指令
    if preset_type == "creation":
        format_override = (
            "\n\n"
            "【重要：角色对话格式规则（优先级最高）】\n"
            "以上预设内容中的创作规则、写作原则仍然有效，但输出格式必须遵循以下角色对话格式：\n"
            "- 口语对话用双引号包裹：\"你好！\"\n"
            "- 内心想法和独白用括号包裹：（我该怎么办...）\n"
            "- 动作、叙述和描写用普通文本，不加特殊标记\n"
            "- 禁止使用 YAML/代码块格式输出对话内容\n"
            "- 你是角色本身，不是创作助手。直接以角色身份回应，不需要先分析再输出\n"
        )
        system_prompt = system_prompt + format_override

    logger.info("Preset injection complete. Final system prompt length: %d", len(system_prompt))

    return system_prompt


def _worldbook_to_charbook(wb):
    entries = {}
    for i, stage in enumerate(wb.entries):
        # 从 extensions_json 读取额外字段（useProbability/displayIndex/automationId/role 等）
        ext_extra = {}
        if stage.extensions_json:
            try:
                ext_extra = json.loads(stage.extensions_json)
            except (json.JSONDecodeError, TypeError):
                ext_extra = {}

        # V3 extensions 子字段（ST 1.18.0 完整映射）
        extensions = {
            "excludeRecursion": stage.exclude_recursion or False,
            "preventRecursion": stage.prevent_recursion or False,
            "delayUntilRecursion": stage.delay_until_recursion or 0,
            "depth": stage.depth if stage.depth is not None else 4,
            "selectiveLogic": stage.selective_logic if stage.selective_logic is not None else 0,
            "outletName": stage.outlet_name or "",
            "groupOverride": stage.group_override or False,
            "groupWeight": stage.group_weight or 0,
            "caseSensitive": stage.case_sensitive or False,
            "matchWholeWords": stage.match_whole_words or False,
            "vectorized": stage.vectorized or False,
            "sticky": stage.sticky or 0,
            "cooldown": stage.cooldown or 0,
            "delay": stage.delay or 0,
            "matchPersonaDescription": stage.match_persona_description or False,
            "matchCharacterDescription": stage.match_character_description or False,
            "matchCharacterPersonality": stage.match_character_personality or False,
            "matchCharacterDepthPrompt": stage.match_character_depth_prompt or False,
            "matchScenario": stage.match_scenario or False,
            "matchCreatorNotes": stage.match_creator_notes or False,
            "useProbability": ext_extra.get("useProbability", True),
            "displayIndex": ext_extra.get("displayIndex", i),
            "automationId": ext_extra.get("automationId", ""),
            "role": ext_extra.get("role", 0),
            "useGroupScoring": ext_extra.get("useGroupScoring", False),
        }
        # Bug #6: ST 1.18.0 ignoreBudget — 仅当 stage 显式设置为 True 时
        # 写入 extensions，避免 False 默认值污染原始 extensions roundtrip
        if getattr(stage, "ignore_budget", False):
            extensions["ignoreBudget"] = True
        # 合并 extensions_json 中的其他自定义字段
        for _ek, _ev in ext_extra.items():
            if _ek not in extensions:
                extensions[_ek] = _ev

        # triggers
        if stage.triggers:
            try:
                extensions["triggers"] = json.loads(stage.triggers)
            except (json.JSONDecodeError, TypeError):
                extensions["triggers"] = []
        else:
            extensions["triggers"] = []

        entry = {
            "key": json.loads(stage.keys) if stage.keys else [],
            "keysecondary": json.loads(stage.secondary_keys) if stage.secondary_keys else [],
            "content": stage.content or "",
            "constant": stage.constant or False,
            "selective": stage.selective or False,
            "scanDepth": stage.scan_depth or 4,
            "position": stage.position if isinstance(stage.position, int) else 4,
            "probability": stage.probability if stage.probability is not None else 100,
            "comment": stage.title or "",
            "order": stage.order if stage.order is not None else (stage.stage_index or 0),
            "disable": not (stage.enabled if stage.enabled is not None else True),
            "addMemo": stage.add_memo or False,
            "group": stage.group or None,
            "extensions": extensions,
        }
        entries[str(i)] = entry
    return {
        "name": wb.name,
        "description": wb.description or "",
        "entries": entries,
    }


@router_characters.get("/{character_id}/export")
async def export_character(
    character_id: str,
    format: str = "png",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    char = db.query(Character).filter(Character.id == character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    from ..models.worldbook import WorldBook
    wb = db.query(WorldBook).filter(WorldBook.character_id == char.id).options(selectinload(WorldBook.entries)).first()
    charbook_data = _worldbook_to_charbook(wb) if wb else None

    card_data = convert_character_to_chara_card(char, world_book_data=charbook_data)

    if format == "json":
        return card_data

    avatar_url = char.avatar or ""
    image_data = None
    if avatar_url.startswith("data:image"):
        try:
            image_data = base64.b64decode(avatar_url.split(",", 1)[1])
        except Exception:
            pass
    elif avatar_url.startswith(("http://", "https://")) and _is_public_http_url(avatar_url):
        try:
            import httpx
            with httpx.Client(timeout=10.0, follow_redirects=False) as client:
                resp = client.get(avatar_url)
                image_data = resp.content
        except Exception:
            pass

    if not image_data:
        from PIL import Image as PILImage
        img = PILImage.new("RGBA", (256, 256), (100, 100, 100, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        image_data = buf.getvalue()

    png_bytes = create_png_with_chara_card(image_data, card_data)
    return Response(content=png_bytes, media_type="image/png")


class ImportParseImageRequest(BaseModel):
    image_url: str
    model: Optional[str] = None


@router_characters.post("/import-parse-image")
async def import_parse_image(
    req: ImportParseImageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """从图片自动解析并创建角色（用于 AI 生成图片等非角色卡 PNG）"""
    if not req.image_url:
        raise HTTPException(status_code=400, detail="image_url is required")

    image_data = None
    if req.image_url.startswith("data:image"):
        try:
            image_data = base64.b64decode(req.image_url.split(",", 1)[1])
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 image data")
    else:
        if req.image_url.startswith(("/api/uploads/", "/uploads/")):
            normalized_url = normalize_image_url(req.image_url, check_size=True, user_id=user.id)
            if normalized_url.startswith("data:image"):
                try:
                    image_data = base64.b64decode(normalized_url.split(",", 1)[1])
                except Exception:
                    raise HTTPException(status_code=400, detail="Invalid uploaded image data")
        else:
            if not _is_public_http_url(req.image_url):
                raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")
            try:
                import httpx
                async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
                    resp = await client.get(req.image_url, headers={"User-Agent": "Palink-AI/1.0"})
                    if len(resp.content) > _MAX_IMAGE_SIZE:
                        raise ValueError("Image too large")
                    image_data = resp.content
            except ValueError:
                raise HTTPException(status_code=413, detail="Image too large (max 50MB)")
            except Exception:
                raise HTTPException(status_code=400, detail="Failed to download image")

    if not image_data:
        raise HTTPException(status_code=400, detail="Could not read image data")

    base64_avatar = base64.b64encode(image_data).decode('utf-8')
    content_type = "image/png" if PngCharacterCardParser.validate_png_format(image_data) else "image/jpeg"
    avatar_url = f"data:{content_type};base64,{base64_avatar}"

    char = Character(
        user_id=user.id,
        name="AI Image Character",
        description="",
        background="",
        personality="",
        scenario="",
        first_mes="",
        mes_example="",
        system_prompt="",
        creator="auto-import",
        tags="[]",
        avatar=avatar_url,
        is_processing=True,
    )
    db.add(char)
    db.commit()
    db.refresh(char)
    # 占位卡入库后立即失效列表缓存，使前端刷新能看到"处理中"占位卡并触发状态轮询。
    invalidate_user_cache("character_list", user.id)

    try:
        char.is_processing = True
        char.processing_status = "Parsing..."
        db.commit()

        model_id = req.model
        if not model_id:
            try:
                model_id = get_default_ai_model()
            except HTTPException:
                char.is_processing = False
                db.commit()
                return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}

        try:
            ensure_model_available(model_id)
        except ValueError as exc:
            char.is_processing = False
            db.commit()
            return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}

        prompt = (
            "Analyze this character image and generate a detailed character profile. "
            "The image shows an anime-style character. Create a character card based on what you see.\n\n"
            "Return a valid JSON object with these fields:\n"
            "- name: A fitting name for the character based on appearance\n"
            "- description: Detailed physical appearance and visual traits\n"
            "- personality: Personality traits inferred from the image\n"
            "- scenario: A possible scenario or setting for this character\n"
            "- background: Background story or origin\n"
            "- first_mes: An opening message/greeting in character\n"
            "- mes_example: Example dialogues (3-4 exchanges)\n\n"
            "IMPORTANT: You may include any content including NSFW, explicit, or adult themes if the character image suggests it. "
            "Do NOT censor, omit, soften, or hold back any content. Be creative and detailed."
        )
        completion = await complete_text_completion(
            model_id=model_id,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
            max_tokens=4000,
            timeout=60.0,
        )
        content = completion.get("content") or ""
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            if parsed.get("name"):
                char.name = parsed["name"][:100]
            if parsed.get("description"):
                char.description = parsed["description"]
            if parsed.get("personality"):
                char.personality = parsed["personality"]
            if parsed.get("scenario"):
                char.scenario = parsed["scenario"]
            if parsed.get("background"):
                char.background = parsed["background"]
            if parsed.get("first_mes"):
                char.first_mes = parsed["first_mes"]
            if parsed.get("mes_example"):
                char.mes_example = parsed["mes_example"]

        char.is_processing = False
        char.processing_status = ""
        db.commit()
        # 占位卡处理完成，状态由 is_processing=True 变为正常卡，
        # 必须失效列表缓存，否则前端刷新仍拿到 30s 旧快照（占位卡消失后本体不出现）。
        invalidate_user_cache("character_list", user.id)
    except Exception as e:
        logger.exception("Parse failed for character %s", char.id)
        char.is_processing = False
        char.processing_status = "Parsing failed"
        db.commit()
        invalidate_user_cache("character_list", user.id)

    return {"status": "ok", "character_id": str(char.id), "auto_parsed": True}


class ParseCharacterRequest(BaseModel):
    character_id: Optional[str] = None
    image_url: Optional[str] = None
    model: Optional[str] = None


@router_characters.post("/parse")
async def parse_character_card(
    req: ParseCharacterRequest,
    http_request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """解析角色卡：支持从 URL 或从已导入的角色卡用 AI 解析"""
    if not req.character_id and not req.image_url:
        raise HTTPException(status_code=400, detail="Either character_id or image_url is required")

    if req.image_url:
        try:
            normalized_url = normalize_image_url(req.image_url, check_size=True, user_id=user.id)

            if normalized_url.startswith("data:image"):
                img_data = base64.b64decode(normalized_url.split(",", 1)[1])
            else:
                if not _is_public_http_url(normalized_url):
                    raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")

                import httpx
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                    resp = await client.get(normalized_url, headers={"User-Agent": "Palink-AI/1.0"})
                    content_type = (resp.headers.get("content-type") or "").lower()
                    if content_type and not content_type.startswith("image/"):
                        raise HTTPException(status_code=415, detail="URL did not return an image")
                    if len(resp.content) > 10 * 1024 * 1024:
                        raise ValueError("Image too large")
                    img_data = resp.content

        except ValueError:
            raise HTTPException(status_code=413, detail="Image too large (max 10MB)")
        except HTTPException:
            raise
        except Exception:
            logger.exception("Failed to fetch character image from URL")
            raise HTTPException(status_code=400, detail="Failed to fetch image")

        char_data = PngCharacterCardParser.extract_character_data(img_data)
        if not char_data:
            raise HTTPException(status_code=422, detail="No character data found in image")

        if "data" in char_data and isinstance(char_data["data"], dict):
            char_data = char_data["data"]

        return {"status": "ok", "character": char_data}

    if req.character_id:
        char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
        if not char:
            raise HTTPException(status_code=404, detail="Character not found")

        char.is_processing = True
        char.processing_status = "Parsing..."
        db.commit()

        model_id = req.model
        if not model_id:
            try:
                model_id = get_default_ai_model()
            except HTTPException:
                char.is_processing = False
                db.commit()
                raise

        try:
            ensure_model_available(model_id)
        except ValueError as exc:
            char.is_processing = False
            db.commit()
            _rid = getattr(http_request.state, "request_id", "unknown")
            logger.warning("Character parse model unavailable: %s request_id=%s", exc, _rid)
            raise HTTPException(
                status_code=400,
                detail=f"Model not configured or not available (request_id: {_rid})",
            ) from exc

        fields_to_parse = {
            "description": char.description or "",
            "personality": char.personality or "",
            "scenario": char.scenario or "",
            "background": char.background or "",
            "first_mes": char.first_mes or "",
            "mes_example": char.mes_example or "",
            "system_prompt": char.system_prompt or "",
        }

        try:
            prompt = (
                "Parse the following character card content, extract and organize the information. "
                "Return a valid JSON object with the same keys, clean up any messy format, "
                "and improve the content to be more coherent and structured. "
                "IMPORTANT: Preserve ALL content faithfully and completely, including any NSFW, explicit, or adult content. "
                "Do NOT censor, omit, soften, or truncate any content regardless of its nature. "
                "Keep the original meaning and tone exactly.\n\n"
                + json.dumps(fields_to_parse, ensure_ascii=False)
            )
            completion = await complete_text_completion(
                model_id=model_id,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=4000,
                timeout=60.0,
            )
            content = completion.get("content") or ""
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if match:
                parsed = json.loads(match.group(0))
                if parsed.get("description"):
                    char.description = parsed["description"]
                if parsed.get("personality"):
                    char.personality = parsed["personality"]
                if parsed.get("scenario"):
                    char.scenario = parsed["scenario"]
                if parsed.get("background"):
                    char.background = parsed["background"]
                if parsed.get("first_mes"):
                    char.first_mes = parsed["first_mes"]
                if parsed.get("mes_example"):
                    char.mes_example = parsed["mes_example"]
                if parsed.get("system_prompt"):
                    char.system_prompt = parsed["system_prompt"]

            char.is_processing = False
            char.processing_status = ""
            db.commit()
            invalidate_user_cache("character_list", user.id)
            from ..models.worldbook import WorldBook
            has_cb = db.query(WorldBook.id).filter(WorldBook.character_id == char.id).first() is not None
            return {"status": "ok", "character": character_to_dict(char, has_character_book=has_cb)}
        except Exception:
            char.is_processing = False
            char.processing_status = "Parsing failed"
            db.commit()
            invalidate_user_cache("character_list", user.id)
            logger.exception("Character parsing failed")
            raise HTTPException(status_code=500, detail="Character parsing failed")


class TranslateRequest(BaseModel):
    character_id: str
    target_language: str = "zh"
    model: Optional[str] = None


@router_characters.post("/translate")
async def translate_character(
    req: TranslateRequest,
    http_request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """用 AI 翻译角色卡内容"""
    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    # Mark as processing
    char.is_processing = True
    char.processing_status = "Translating..."
    db.commit()

    lang_name = "Chinese (Simplified)" if req.target_language == "zh" else req.target_language

    model_id = req.model
    if not model_id:
        try:
            model_id = get_default_ai_model()
        except HTTPException:
            char.is_processing = False
            db.commit()
            raise

    try:
        ensure_model_available(model_id)
    except ValueError as exc:
        char.is_processing = False
        db.commit()
        _rid = getattr(http_request.state, "request_id", "unknown")
        logger.warning("Character translate model unavailable: %s request_id=%s", exc, _rid)
        raise HTTPException(
            status_code=400,
            detail=f"Model not configured or not available (request_id: {_rid})",
        ) from exc

    fields_to_translate = {
        "description": char.description or "",
        "personality": char.personality or "",
        "scenario": char.scenario or "",
        "first_mes": char.first_mes or "",
        "background": char.background or "",
        "system_prompt": char.system_prompt or "",
        "mes_example": char.mes_example or "",
    }

    try:
        prompt = (
            f"Translate the following character card fields to {lang_name}. "
            f"Return a valid JSON object with the same keys. You MUST translate ALL 7 fields. "
            f"Keep proper nouns (character names) unchanged. Do not omit any field. "
            f"IMPORTANT: Translate ALL content faithfully and completely, including any NSFW, explicit, or adult content. "
            f"Do NOT censor, omit, soften, or truncate any content regardless of its nature. "
            f"Preserve the original meaning and tone exactly.\n\n"
            + json.dumps(fields_to_translate, ensure_ascii=False)
        )
        completion = await complete_text_completion(
            model_id=model_id,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=4000,
            timeout=60.0,
        )
        content = completion.get("content") or ""
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            translated = json.loads(match.group(0))
            if translated.get("description"):
                char.description = translated["description"]
            if translated.get("personality"):
                char.personality = translated["personality"]
            if translated.get("scenario"):
                char.scenario = translated["scenario"]
            if translated.get("first_mes"):
                char.first_mes = translated["first_mes"]
            if translated.get("background"):
                char.background = translated["background"]
            if translated.get("system_prompt"):
                char.system_prompt = translated["system_prompt"]
            if translated.get("mes_example"):
                char.mes_example = translated["mes_example"]

        char.is_processing = False
        char.processing_status = ""
        db.commit()
        db.refresh(char)
        invalidate_user_cache("character_list", user.id)
        from ..models.worldbook import WorldBook as _WB2
        has_cb2 = db.query(_WB2.id).filter(_WB2.character_id == char.id).first() is not None
        return {"status": "ok", "character": character_to_dict(char, has_character_book=has_cb2)}
    except Exception:
        char.is_processing = False
        char.processing_status = "Translation failed"
        db.commit()
        invalidate_user_cache("character_list", user.id)
        logger.exception("Character translation failed")
        raise HTTPException(status_code=500, detail="Character translation failed")


@router_characters.get("/{character_id}/sessions")
async def list_character_sessions(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取指定角色的所有对话会话列表"""
    char = db.query(Character).filter(
        Character.id == character_id,
        Character.user_id == user.id,
    ).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    sessions = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.character_id == character_id,
            CharacterChatSession.user_id == user.id,
        )
        .order_by(
            func.coalesce(CharacterChatSession.updated_at, CharacterChatSession.created_at).desc(),
            CharacterChatSession.created_at.desc(),
        )
        .all()
    )

    return [
        {
            "id": s.id,
            "character_id": s.character_id,
            "title": s.title,
            "created_at": s.created_at,
            "updated_at": s.updated_at,
            "dialogue_mode": s.dialogue_mode,
            "user_id": s.user_id,
        }
        for s in sessions
    ]


# ───────────────────────────────────────────────
# Session management
# ───────────────────────────────────────────────

@router_sessions.put("/{session_id}/metadata")
async def update_session_chat_metadata(
    session_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新 chat_metadata（ST 插件 saveChat / saveMetadata 后端持久化）。

    ST 插件调用 getContext().saveChat() 或 saveMetadata() 时，
    前端将 window.chat_metadata 发到此端点持久化到 DB。
    messages 由 messageManager 自动持久化，此处只处理 metadata。
    """
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    existing = json.loads(session.chat_metadata) if session.chat_metadata else {}
    existing.update(body)
    existing["palink_session_id"] = session.id
    session.chat_metadata = json.dumps(existing, ensure_ascii=False)
    db.commit()

    return {"status": "ok"}


@router_sessions.delete("/{session_id}")
async def delete_character_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # 缓存清理所需信息（commit 后 session 对象失效）
    character = session.character
    char_name = character.name if character else "character"

    # 级联清理 ChatVariable 表中该 session 的所有记录（无 ForeignKey，需手动删除）
    from ..models import ChatVariable
    db.query(ChatVariable).filter(
        ChatVariable.session_id == session_id
    ).delete(synchronize_session=False)

    # [ORPHAN-MEM-FIX] 级联清理向量记忆（conversation_memories.session_id 为裸 TEXT
    # 无 ForeignKey，不删则成为孤儿：检索永不召回但持续占存储。对齐普通聊天
    # sessions.py delete_session_memories 的行为，2026-08-24 排查实锤 44 条全量孤儿）。
    from sqlalchemy import text as _sa_text
    db.execute(
        _sa_text("DELETE FROM conversation_memories WHERE session_id = :sid"),
        {"sid": session_id},
    )

    # P0-5 修复: 手动清理 CharacterChatSessionBranch（无 ORM cascade 定义）
    # 原 Palink 仅删除 ChatVariable + session，未清理 branches，导致:
    # - SQLite (PRAGMA foreign_keys=ON): FOREIGN KEY constraint failed
    # - FK 未启用: 留下孤儿 branch 记录
    # 参照 silly_tavern.py:3093-3141 的正确清理顺序:
    # 1. 解除 parent_branch_id 自引用
    # 2. 删除所有 branches
    # 注意删除顺序必须自底向上：character_chat_messages.branch_id 外键引用
    # character_chat_session_branches，必须先删 messages 再删 branches，
    # 否则 PostgreSQL（强制 FK）抛 ForeignKeyViolation（SQLite 未强制 FK 时侥幸通过）。
    from ..models import CharacterChatSessionBranch, CharacterChatMessage
    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    ).delete(synchronize_session=False)
    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.parent_branch_id.isnot(None),
        CharacterChatSessionBranch.session_id == session_id,
    ).update({"parent_branch_id": None}, synchronize_session=False)
    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).delete(synchronize_session=False)

    db.delete(session)
    db.commit()

    # 清理 ST DATA_ROOT 中的 JSONL 和变量文件
    try:
        from ..services.st_sync_service import _st_data_root_for_user, _session_file_name
        from pathlib import Path
        data_root = _st_data_root_for_user(user)
        if data_root:
            data_root_path = Path(data_root)
            chat_dir = data_root_path / "chats" / (char_name or "character")
            jsonl_path = chat_dir / _session_file_name(session_id, with_suffix=True)
            if jsonl_path.exists():
                jsonl_path.unlink(missing_ok=True)
            var_path = data_root_path / "variables" / f"{_session_file_name(session_id)}.json"
            if var_path.exists():
                var_path.unlink(missing_ok=True)
    except Exception:
        logger.debug("ST DATA_ROOT cleanup failed for session delete", exc_info=True)

    return {"status": "ok"}


@router_sessions.get("/{session_id}/messages")
async def get_character_session_messages(
    session_id: str,
    limit: int = 10,
    before_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    active_branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_active == True
    ).first()

    target_branch = active_branch
    if not target_branch:
        target_branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).order_by(CharacterChatSessionBranch.created_at.desc()).first()

    # MVU 变量：从 chat_metadata 提取会话级 stat_data 下发前端
    session_variables: dict = {"stat_data": {}}
    try:
        if session.chat_metadata:
            meta = json.loads(session.chat_metadata)
            if isinstance(meta, dict) and isinstance(meta.get("variables"), dict):
                session_variables = meta["variables"]
    except (json.JSONDecodeError, TypeError):
        pass

    if target_branch:
        result = _get_full_branch_history_paged(db, session_id, target_branch.id, limit=limit, before_id=before_id)
        if isinstance(result, dict):
            result["variables"] = session_variables
        return result

    query = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        CharacterChatMessage.branch_id == None,
    )

    if before_id is not None:
        query = query.filter(CharacterChatMessage.id < before_id)

    # 避免长会话全量加载：倒序只取「limit + 过滤余量」条窗口，再按 id 升序处理；
    # 若过滤智能卡触发消息后不足 limit 条（尾部连续触发消息的病态场景），
    # 回退为全量加载，保持与原逻辑完全一致。
    window = limit + 60
    collected = list(query.order_by(CharacterChatMessage.id.desc()).limit(window).all())
    visible_msgs = [
        m for m in reversed(collected)
        if not (m.role == "user" and is_smart_card_trigger_message(m.content))
    ]
    if len(visible_msgs) < limit:
        collected = list(query.order_by(CharacterChatMessage.id.desc()).all())
        visible_msgs = [
            m for m in reversed(collected)
            if not (m.role == "user" and is_smart_card_trigger_message(m.content))
        ]

    total = len(visible_msgs)
    has_more = total > limit
    page = visible_msgs[-limit:] if total > limit else visible_msgs

    return {
        "messages": _serialize_character_messages(
            page,
            char_name=session.character.name if session.character else "Character",
            user_name=user.username or "User",
        ),
        "has_more": has_more,
        "variables": session_variables,
    }


@router_sessions.delete("/{session_id}/messages/{message_id}")
async def delete_character_message(
    session_id: str,
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    # P2 修复: is_locked 强制检查 — 锁定消息不允许删除（对齐 ST message is_locked 语义）
    if getattr(msg, "is_locked", False):
        raise HTTPException(status_code=403, detail="Message is locked and cannot be deleted")
    # [ORPHAN-MEM-FIX] 单条消息删除级联清理其向量记忆（第五条删除路径收尾：
    # 整角色 / 整会话 / 分支 / 单条消息 / 普通聊天会话）；存量 NULL 行不受影响。
    delete_by_message_id(db, session_id, message_id)
    db.delete(msg)
    db.commit()

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    if session.character:
        try:
            from ..services.st_sync_service import trigger_async_sync
            await trigger_async_sync(
                SessionLocal, user.id, "session",
                character_id=session.character.id, session_id=session.id,
            )
        except Exception:
            logger.debug("ST sync trigger failed for delete message", exc_info=True)

    return {"status": "ok"}


class MessageEditRequest(BaseModel):
    content: str
    role: Optional[str] = None
    name: Optional[str] = None
    is_user: Optional[bool] = None
    is_system: Optional[bool] = None
    is_name: Optional[bool] = None
    force_avatar: Optional[str] = None
    original_avatar: Optional[str] = None
    avatar: Optional[str] = None
    gen_id: Optional[str] = None
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    selected_group: Optional[Any] = None
    groups: Optional[List[dict]] = None
    swipe_id: Optional[int] = None
    swipes: Optional[List[str]] = None
    swipe_info: Optional[List[dict]] = None
    extra: Optional[dict] = None


class MessageAppendRequest(BaseModel):
    content: str
    role: Optional[str] = "assistant"
    name: Optional[str] = None
    is_user: Optional[bool] = None
    is_system: Optional[bool] = None
    is_name: Optional[bool] = None
    force_avatar: Optional[str] = None
    original_avatar: Optional[str] = None
    avatar: Optional[str] = None
    gen_id: Optional[str] = None
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    selected_group: Optional[Any] = None
    groups: Optional[List[dict]] = None
    swipe_id: Optional[int] = None
    swipes: Optional[List[str]] = None
    swipe_info: Optional[List[dict]] = None
    extra: Optional[dict] = None
    model: Optional[str] = None


@router_sessions.post("/{session_id}/messages")
async def append_character_message(
    session_id: str,
    req: MessageAppendRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    content = str(req.content or "")
    if not content.strip():
        raise HTTPException(status_code=422, detail="Message content is empty")

    active_branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_active == True,
    ).first()
    if not active_branch:
        active_branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id,
        ).order_by(CharacterChatSessionBranch.created_at.desc()).first()

    role = (req.role or "assistant").strip().lower()
    if role not in {"assistant", "user", "system"}:
        role = "assistant"
    is_user = req.is_user if req.is_user is not None else role == "user"
    is_system = req.is_system if req.is_system is not None else role == "system"
    if is_user:
        role = "user"
    elif is_system:
        role = "system"
    else:
        role = "assistant"

    # Slash command handling (Phase 4)
    slash_result: SlashCommandResult | None = None
    if is_user and is_slash_command(content):
        slash_ctx = SlashCommandContext(
            db=db,
            session_id=session_id,
            user_id=user.id,
            user_name=user.username or "User",
            character=session.character,
            session=session,
            input_text=content,
        )
        slash_result = execute_slash_command(content, slash_ctx)
        # P0-3 修复: /gen 命令支持 — gen_prompt 非空时调用 LLM 生成
        if slash_result and slash_result.gen_prompt is not None:
            try:
                ensure_model_available(req.model or "")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid model") from exc
            try:
                completion = await complete_text_completion(
                    model_id=req.model or "",
                    messages=[{"role": "user", "content": slash_result.gen_prompt}],
                    temperature=0.7,
                    top_p=0.95,
                    max_tokens=1024,
                    timeout=60.0,
                )
                gen_text = completion.get("content") or ""
            except Exception as exc:
                logger.exception("[SLASH-GEN] /gen LLM call failed: %s", exc)
                return {
                    "status": "ok",
                    "slash_command": True,
                    "response": f"[/gen error: {exc}]",
                }
            return {
                "status": "ok",
                "slash_command": True,
                "response": gen_text,
            }
        if slash_result and not slash_result.send_to_chat and not slash_result.system_message and not slash_result.extra_messages:
            return {
                "status": "ok",
                "slash_command": True,
                "response": slash_result.response,
            }

    swipes = req.swipes if isinstance(req.swipes, list) and req.swipes else [content]
    swipe_id = int(req.swipe_id or 0)
    swipe_id = max(0, min(swipe_id, len(swipes) - 1))
    append_extra = _merge_st_message_extra_fields(
        req.extra if isinstance(req.extra, dict) else {},
        is_name=req.is_name,
        force_avatar=req.force_avatar,
        original_avatar=req.original_avatar,
        avatar=req.avatar,
        gen_id=req.gen_id,
        group_id=req.group_id,
        group_name=req.group_name,
        selected_group=req.selected_group,
        groups=req.groups,
    )

    messages_to_save: list[CharacterChatMessage] = []
    save_original = True
    if slash_result:
        if not slash_result.send_to_chat and not slash_result.system_message and not slash_result.extra_messages:
            save_original = False
        elif slash_result.extra_messages:
            save_original = False
            for em in slash_result.extra_messages:
                em_role = em.get("role", "user")
                em_content = em.get("content", "")
                # P0-2 修复: /send 已自行 commit 消息，跳过重复保存
                if em.get("_already_persisted"):
                    continue
                em_swipes = [em_content]
                em_msg = CharacterChatMessage(
                    session_id=session_id,
                    branch_id=active_branch.id if active_branch else None,
                    role=em_role,
                    content=em_content,
                    model=req.model,
                    **_st_message_kwargs(
                        role=em_role,
                        content=em_content,
                        char_name=session.character.name if session.character else "Character",
                        user_name=user.username or "User",
                        name=req.name,
                        swipes=em_swipes,
                        extra=append_extra,
                        swipe_id=0,
                        swipe_info=req.swipe_info,
                        is_name=req.is_name,
                        force_avatar=req.force_avatar,
                        original_avatar=req.original_avatar,
                        avatar=req.avatar,
                        gen_id=req.gen_id,
                        group_id=req.group_id,
                        group_name=req.group_name,
                        selected_group=req.selected_group,
                        groups=req.groups,
                    ),
                )
                em_msg.is_user = em_role == "user"
                em_msg.is_system = em_role == "system"
                em_msg.swipe_id = 0
                messages_to_save.append(em_msg)
        if slash_result.system_message:
            sys_content = slash_result.system_message
            sys_swipes = [sys_content]
            sys_msg = CharacterChatMessage(
                session_id=session_id,
                branch_id=active_branch.id if active_branch else None,
                role="system",
                content=sys_content,
                model=req.model,
                **_st_message_kwargs(
                    role="system",
                    content=sys_content,
                    char_name=session.character.name if session.character else "Character",
                    user_name=user.username or "User",
                    name=req.name,
                    swipes=sys_swipes,
                    extra=append_extra,
                    swipe_id=0,
                    swipe_info=req.swipe_info,
                    is_name=req.is_name,
                    force_avatar=req.force_avatar,
                    original_avatar=req.original_avatar,
                    avatar=req.avatar,
                    gen_id=req.gen_id,
                    group_id=req.group_id,
                    group_name=req.group_name,
                    selected_group=req.selected_group,
                    groups=req.groups,
                ),
            )
            sys_msg.is_user = False
            sys_msg.is_system = True
            sys_msg.swipe_id = 0
            messages_to_save.append(sys_msg)

    if save_original:
        message = CharacterChatMessage(
            session_id=session_id,
            branch_id=active_branch.id if active_branch else None,
            role=role,
            content=content,
            model=req.model,
            **_st_message_kwargs(
                role=role,
                content=content,
                char_name=session.character.name if session.character else "Character",
                user_name=user.username or "User",
                name=req.name,
                swipes=swipes,
                extra=append_extra,
                swipe_id=swipe_id,
                swipe_info=req.swipe_info,
                is_name=req.is_name,
                force_avatar=req.force_avatar,
                original_avatar=req.original_avatar,
                avatar=req.avatar,
                gen_id=req.gen_id,
                group_id=req.group_id,
                group_name=req.group_name,
                selected_group=req.selected_group,
                groups=req.groups,
            ),
        )
        message.is_user = bool(is_user)
        message.is_system = bool(is_system)
        message.swipe_id = swipe_id
        messages_to_save.append(message)

    for msg in messages_to_save:
        db.add(msg)
    if active_branch:
        active_branch.last_message_at = datetime.now(timezone.utc)
        active_branch.is_frozen = False
    db.commit()
    for msg in messages_to_save:
        db.refresh(msg)

    # 触发 ST DATA_ROOT 同步（后台非阻塞，仅在实际保存消息时）
    if messages_to_save and session.character:
        try:
            from ..services.st_sync_service import trigger_async_sync
            await trigger_async_sync(
                SessionLocal, user.id, "session",
                character_id=session.character.id, session_id=session.id,
            )
        except Exception:
            logger.debug("ST sync trigger failed for append message", exc_info=True)

    result_payload: dict[str, Any] = {"status": "ok"}
    if slash_result:
        result_payload["slash_command"] = True
        if slash_result.response:
            result_payload["response"] = slash_result.response
    if messages_to_save:
        result_payload["message"] = _serialize_character_message(
            messages_to_save[-1],
            char_name=session.character.name if session.character else "Character",
            user_name=user.username or "User",
        )
    return result_payload


@router_sessions.put("/{session_id}/messages/{message_id}")
async def edit_character_message(
    session_id: str,
    message_id: int,
    req: MessageEditRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    # P2 修复: is_locked 强制检查 — 锁定消息不允许编辑（对齐 ST message is_locked 语义）
    if getattr(msg, "is_locked", False):
        raise HTTPException(status_code=403, detail="Message is locked and cannot be edited")
    # [MEM-SYNC-ON-EDIT] 进入函数时缓存旧正文，供 commit 前对比内容是否变化
    old_content_before = msg.content or ""
    if req.role:
        role = req.role.strip().lower()
        if role in {"assistant", "user", "system"}:
            msg.role = role
    if req.name is not None:
        msg.name = req.name
    if req.is_user is not None:
        msg.is_user = bool(req.is_user)
        if req.is_user:
            msg.role = "user"
    if req.is_system is not None:
        msg.is_system = bool(req.is_system)
        if req.is_system:
            msg.role = "system"
    if msg.is_user is False and msg.is_system is False and msg.role not in {"user", "system"}:
        msg.role = "assistant"
    if req.swipe_id is not None:
        msg.swipe_id = max(0, int(req.swipe_id))
    if isinstance(req.swipes, list) and req.swipes:
        msg.swipes = _json_dump_or_none([str(item) for item in req.swipes])
    edit_extra = req.extra if isinstance(req.extra, dict) else None
    if _has_st_message_extra_values(
        is_name=req.is_name,
        force_avatar=req.force_avatar,
        original_avatar=req.original_avatar,
        avatar=req.avatar,
        gen_id=req.gen_id,
        group_id=req.group_id,
        group_name=req.group_name,
        selected_group=req.selected_group,
        groups=req.groups,
    ):
        edit_extra = _merge_st_message_extra_fields(
            edit_extra if isinstance(edit_extra, dict) else _message_extra(msg),
            is_name=req.is_name,
            force_avatar=req.force_avatar,
            original_avatar=req.original_avatar,
            avatar=req.avatar,
            gen_id=req.gen_id,
            group_id=req.group_id,
            group_name=req.group_name,
            selected_group=req.selected_group,
            groups=req.groups,
        )
    _sync_message_content_to_active_swipe(
        msg,
        req.content,
        extra=edit_extra,
        swipe_info=req.swipe_info,
    )
    # [MEM-SYNC-ON-EDIT] 编辑即同步：记忆 = 消息当前内容的镜像。
    # 内容(strip)变化 → 先删该消息全部记忆行，commit 后按新文本后台重嵌；
    # 内容未变零操作；锁定消息已在上方 403 拦截（防御性再判一次）。
    _edited_for_reembed = None
    if not getattr(msg, "is_locked", False) and (msg.content or "").strip() != old_content_before.strip():
        delete_by_message_id(db, session_id, message_id)
        _edited_for_reembed = (msg.role, msg.content or "")
    # 捕获标量，避免后台线程访问已关闭请求 Session 的 ORM 对象
    _edit_branch_id = msg.branch_id
    _edit_user_id = user.id
    db.commit()

    if _edited_for_reembed is not None:
        _reembed_role, _reembed_text = _edited_for_reembed

        def _reembed_edited_message():
            re_db = SessionLocal()
            try:
                svc = MemoryService(re_db)
                if not svc.is_available():
                    return
                text_for_mem = (
                    clean_memory_content(_reembed_text)
                    if _reembed_role == "assistant"
                    else _reembed_text
                )
                if text_for_mem.strip():
                    svc.store_memory(
                        user_id=_edit_user_id,
                        session_id=session_id,
                        role=_reembed_role,
                        content=text_for_mem,
                        branch_id=_edit_branch_id,
                        message_id=message_id,
                    )
                    re_db.commit()
            except Exception:
                re_db.rollback()
                logger.warning("[MEM-SYNC-ON-EDIT] re-embed after edit failed (message=%s)", message_id)
            finally:
                re_db.close()

        asyncio.create_task(asyncio.to_thread(_reembed_edited_message))

    # 触发 ST DATA_ROOT 同步（后台非阻塞）
    if session.character:
        try:
            from ..services.st_sync_service import trigger_async_sync
            await trigger_async_sync(
                SessionLocal, user.id, "session",
                character_id=session.character.id, session_id=session.id,
            )
        except Exception:
            logger.debug("ST sync trigger failed for edit message", exc_info=True)

    return {"status": "ok"}


class MessageVisibilityUpdateRequest(BaseModel):
    is_hidden: Optional[bool] = None
    is_locked: Optional[bool] = None


@router_sessions.patch("/{session_id}/messages/{message_id}")
async def update_message_visibility(
    session_id: str,
    message_id: int,
    req: MessageVisibilityUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if req.is_hidden is not None:
        msg.is_hidden = bool(req.is_hidden)
    if req.is_locked is not None:
        msg.is_locked = bool(req.is_locked)
    db.commit()
    db.refresh(msg)
    return _serialize_character_message(
        msg,
        char_name=session.character.name if session.character else "Character",
        user_name=user.username or "User",
    )


# ───────────────────────────────────────────────
# Branches
# ───────────────────────────────────────────────

class BranchCreateRequest(BaseModel):
    session_id: str
    branch_name: Optional[str] = None
    parent_message_id: Optional[int] = None
    parent_branch_id: Optional[str] = None
    same_level: bool = True


@router_sessions.get("/{session_id}/branches")
async def get_branches(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).all()
    if not branches:
        # Auto-create main branch (re-check after commit to prevent race condition)
        existing = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).first()
        if existing:
            branches = [existing]
        else:
            main_branch = CharacterChatSessionBranch(
                session_id=session_id,
                branch_name="分支 1",
                is_active=True,
            )
            db.add(main_branch)
            db.commit()
            db.refresh(main_branch)
            branches = [main_branch]
    return [
        {
            "id": b.id,
            "session_id": b.session_id,
            "branch_name": b.branch_name,
            "is_active": b.is_active,
            "parent_branch_id": b.parent_branch_id,
            "parent_message_id": b.parent_message_id,
            "is_frozen": b.is_frozen,
            "is_favorited": b.is_favorited,
            "last_message_at": b.last_message_at,
            "created_at": b.created_at,
        }
        for b in branches
    ]


@router_sessions.post("/{session_id}/branches")
async def create_branch(
    session_id: str,
    req: BranchCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    existing_branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).all()
    is_first_branch = len(existing_branches) == 0

    branch_name = req.branch_name
    if not branch_name:
        # 计算同级分支数量（同一父节点下的分支编号）
        sibling_branches = [
            b for b in existing_branches
            if b.parent_branch_id == req.parent_branch_id
            and b.parent_message_id == req.parent_message_id
        ]
        branch_num = len(sibling_branches) + 1
        branch_name = f"分支 {branch_num}"

    effective_parent_branch_id = req.parent_branch_id
    effective_parent_message_id = req.parent_message_id

    # Validate that parent_message_id points to an assistant message if provided
    if effective_parent_message_id is not None and effective_parent_branch_id is not None:
        parent_msg = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == effective_parent_message_id,
            CharacterChatMessage.session_id == session_id,
         CharacterChatMessage.branch_id == effective_parent_branch_id,
        ).first()
        if parent_msg and parent_msg.role != "assistant":
          raise HTTPException(
                status_code=400,
                detail="parent_message_id must point to an assistant message (end of dialogue pair)"
        )

    if req.same_level and not is_first_branch:
        active_branch = next((b for b in existing_branches if b.is_active), None)
        if active_branch:
            effective_parent_branch_id = active_branch.parent_branch_id
            effective_parent_message_id = active_branch.parent_message_id

    # Check branch limit: max 3 branches per node (dialogue pair)
    child_count = _count_child_branches_from_node(
        db, session_id, effective_parent_branch_id, effective_parent_message_id
    )
    if child_count >= 3:
        raise HTTPException(status_code=400, detail="每个节点最多只能创建3个分支")

    is_root_branch = effective_parent_branch_id is None and effective_parent_message_id is None

    branch = CharacterChatSessionBranch(
        session_id=session_id,
        branch_name=branch_name,
        parent_message_id=effective_parent_message_id,
        parent_branch_id=effective_parent_branch_id,
        is_active=True,
    )
    db.add(branch)

    if not is_first_branch:
        db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.id != branch.id,
        ).update({"is_active": False}, synchronize_session=False)

    db.commit()
    db.refresh(branch)

    greeting_msg = None
    messages_result = []

    if session.character_id:
        char = db.query(Character).filter(Character.id == session.character_id).first()
        if char and char.first_mes:
            should_add_greeting = False
            if is_root_branch:
                should_add_greeting = True
            elif is_first_branch:
                should_add_greeting = True
            elif not req.same_level and req.parent_message_id is not None:
                should_add_greeting = False
            else:
                branch_depth = 0
                current_bid = effective_parent_branch_id
                visited = set()
                while current_bid and current_bid not in visited:
                    visited.add(current_bid)
                    parent_b = db.query(CharacterChatSessionBranch).filter(
                        CharacterChatSessionBranch.id == current_bid
                    ).first()
                    if parent_b:
                        branch_depth += 1
                        current_bid = parent_b.parent_branch_id
                    else:
                        break
                if branch_depth <= 1:
                    should_add_greeting = True

            if should_add_greeting:
                greeting_swipes = [char.first_mes, *_character_alternate_greetings(char, user.username or "User")]
                greeting_msg = CharacterChatMessage(
                    session_id=session_id,
                    branch_id=branch.id,
                    role="assistant",
                    content=char.first_mes,
                    **_st_message_kwargs(
                        role="assistant",
                        content=char.first_mes,
                        char_name=char.name or "Character",
                        user_name=user.username or "User",
                        swipes=greeting_swipes,
                    ),
                )
                db.add(greeting_msg)
                db.commit()
                db.refresh(greeting_msg)
                messages_result.append(_serialize_character_message(
                    greeting_msg,
                    index=0,
                    char_name=char.name or "Character",
                    user_name=user.username or "User",
                ))

    return {
        "status": "ok",
        "branch": {"id": branch.id, "branch_name": branch.branch_name, "is_active": branch.is_active},
        "greeting": {
            "id": greeting_msg.id if greeting_msg else None,
            "content": greeting_msg.content if greeting_msg else None,
            "role": "assistant",
        } if greeting_msg else None,
        "messages": messages_result,
    }


@router_sessions.post("/{session_id}/branches/{branch_id}/switch")
async def switch_branch(
    session_id: str,
    branch_id: str,
    up_to_message_id: Optional[int] = None,
    limit: int = 10,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).update({"is_active": False}, synchronize_session=False)

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    branch.is_active = True
    db.commit()

    result = _get_full_branch_history_paged(db, session_id, branch_id, limit=limit, up_to_message_id=up_to_message_id)

    return {"status": "ok", "messages": result["messages"], "up_to_message_id": up_to_message_id, "has_more": result["has_more"]}


@router_sessions.post("/{session_id}/branches/{branch_id}/favorite")
async def toggle_favorite_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """收藏或取消收藏分支"""
    session = db.query(CharacterChatSession).filter(
     CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
      raise HTTPException(status_code=404, detail="Session not found")

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    branch.is_favorited = not branch.is_favorited
    db.commit()

    return {"status": "ok", "is_favorited": branch.is_favorited}


@router_sessions.post("/{session_id}/branches/{branch_id}/unfreeze")
async def unfreeze_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """解冻分支(用户重新进入冻结的分支时调用)"""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    branch.is_frozen = False
    branch.last_message_at = datetime.now(timezone.utc)
    db.commit()

    return {"status": "ok"}


@router_sessions.post("/{session_id}/check-frozen-branches")
async def check_frozen_branches(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """检查并冻结超过5个对话（10条消息）未继续的分支"""
    session = db.query(CharacterChatSession).filter(
      CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_favorited == False  # 收藏的分支不冻结
    ).all()

    frozen_count = 0

    branch_ids = [b.id for b in branches]
    if not branch_ids:
        return {"status": "ok", "frozen_count": 0}

    stats = db.query(
        CharacterChatMessage.branch_id,
        func.count(CharacterChatMessage.id).label("msg_count"),
        func.max(CharacterChatMessage.created_at).label("last_msg_at"),
    ).filter(
        CharacterChatMessage.branch_id.in_(branch_ids)
    ).group_by(CharacterChatMessage.branch_id).all()

    stats_map = {s.branch_id: s for s in stats}

    for branch in branches:
        s = stats_map.get(branch.id)
        if not s or s.msg_count < 10:
            continue
        if s.last_msg_at:
            messages_after = db.query(CharacterChatMessage).filter(
                CharacterChatMessage.session_id == session_id,
                CharacterChatMessage.created_at > s.last_msg_at
            ).count()
            if messages_after >= 10 and not branch.is_frozen:
                branch.is_frozen = True
                frozen_count += 1

    db.commit()

    return {"status": "ok", "frozen_count": frozen_count}


@router_sessions.get("/{session_id}/branch-tree")
async def get_branch_tree(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Return all branches and their message pairs for storyline visualization."""
    def clean_storyline_preview(text: Optional[str], *, default: str = "") -> str:
        if not text:
            return default
        raw = str(text).strip()
        if re.fullmatch(r"`*\s*html\s*`*", raw, flags=re.IGNORECASE):
            return default
        if re.match(r"^(?:html\s*)?(?:<!?doc(?:type)?|<html\b|<head\b|<body\b|<script\b|<style\b)", raw, flags=re.IGNORECASE):
            return default
        cleaned = re.sub(r"<palink-html>[\s\S]*?</palink-html>", " ", raw, flags=re.IGNORECASE)
        cleaned = re.sub(r"(`{3,})html\s*[\r\n]+[\s\S]*?[\r\n]+\1", " ", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"(?:^|\s)(?:html\s*)?(?:<!?doc(?:type)?|<html\b|<head\b|<body\b|<script\b|<style\b)[\s\S]*$", " ", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"(?:html\s*)?(?:<!DOCTYPE\s+html|<html\b)[\s\S]*?</html\s*>", " ", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"<(?:script|style)\b[\s\S]*?</(?:script|style)>", " ", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?/?>", " ", cleaned)
        cleaned = re.sub(r"`{3,}", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if re.fullmatch(r"html", cleaned, flags=re.IGNORECASE):
            return default
        return cleaned or default

    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).order_by(CharacterChatSessionBranch.created_at).all()

    if not branches:
        existing = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).first()
        if existing:
            branches = [existing]
        else:
            main_branch = CharacterChatSessionBranch(
                session_id=session_id,
                branch_name="分支 1",
                is_active=True,
            )
            db.add(main_branch)
            db.commit()
            db.refresh(main_branch)
            branches = [main_branch]

    all_messages = (
        db.query(
            CharacterChatMessage.id,
            CharacterChatMessage.role,
            CharacterChatMessage.content,
            CharacterChatMessage.branch_id,
            CharacterChatMessage.short_title,
            CharacterChatMessage.created_at,
        )
        .filter(
            CharacterChatMessage.session_id == session_id,
            CharacterChatMessage.branch_id.in_([b.id for b in branches]),
        )
        .order_by(CharacterChatMessage.created_at)
        .all()
    )

    msg_by_branch = {}
    for msg in all_messages:
        msg_by_branch.setdefault(msg.branch_id, []).append(msg)

    result_branches = []
    for branch in branches:
        msgs = msg_by_branch.get(branch.id, [])
        pairs = []
        pending_user = None
        for msg in msgs:
            if msg.role == "user":
                if is_smart_card_trigger_message(msg.content):
                    continue
                pending_user = msg
            elif msg.role == "assistant":
                if pending_user:
                    # Strip <think>...</think> blocks for summary
                    ai_display = re.sub(r"<thinking>[\s\S]*?</thinking>", "", msg.content).strip()
                    node_title = clean_storyline_preview(msg.short_title, default="开始") or clean_storyline_preview(ai_display[:20], default="开始")
                    user_summary = clean_storyline_preview(pending_user.content[:80])
                    ai_summary = clean_storyline_preview(ai_display[:80])
                    pairs.append({
                        "pair_id": f"pair_{pending_user.id}",
                        "user_msg_id": pending_user.id,
                        "ai_msg_id": msg.id,
                        "node_title": node_title,
                        "user_summary": user_summary,
                        "ai_summary": ai_summary,
                        "created_at": msg.created_at.isoformat() if msg.created_at else None,
                    })
                    pending_user = None
                else:
                    ai_display = re.sub(r"<thinking>[\s\S]*?</thinking>", "", msg.content).strip()
                    node_title = clean_storyline_preview(msg.short_title, default="开始") or clean_storyline_preview(ai_display[:20], default="开始")
                    ai_summary = clean_storyline_preview(ai_display[:80])
                    pairs.append({
                        "pair_id": f"ai_{msg.id}",
                        "user_msg_id": None,
                        "ai_msg_id": msg.id,
                        "node_title": node_title,
                        "user_summary": None,
                        "ai_summary": ai_summary,
                        "created_at": msg.created_at.isoformat() if msg.created_at else None,
                    })
        result_branches.append({
            "id": branch.id,
            "branch_name": branch.branch_name,
            "parent_branch_id": branch.parent_branch_id,
            "parent_message_id": branch.parent_message_id,
            "is_active": branch.is_active,
          "is_frozen": branch.is_frozen,
            "is_favorited": branch.is_favorited,
            "last_message_at": branch.last_message_at.isoformat() if branch.last_message_at else None,
            "created_at": branch.created_at.isoformat() if branch.created_at else None,
            "nodes": pairs,
        })

    active_branch = next((b for b in branches if b.is_active), None)

    character_info = None
    if session.character_id:
        char = db.query(Character).filter(Character.id == session.character_id).first()
        if char:
            character_info = {
                "id": char.id,
                "name": char.name,
                "avatar": char.avatar or "",
                "first_mes": char.first_mes or "",
                "background": char.background or "",
                "user_nickname": char.user_nickname or "",
            }

    return {
        "branches": result_branches,
        "active_branch_id": active_branch.id if active_branch else None,
        "character_info": character_info,
    }


@router_sessions.get("/{session_id}/branches/{branch_id}/delete-preview")
async def delete_branch_preview(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    # 检查是否为唯一分支
    total_branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).count()

    def _collect_descendant_branch_ids(bid: str, collected: list):
        all_branches = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).all()
        children_map: dict = {}
        for b in all_branches:
            if b.parent_branch_id:
                children_map.setdefault(b.parent_branch_id, []).append(b.id)
        stack = [bid]
        while stack:
            cur = stack.pop()
            for child_id in children_map.get(cur, []):
                if child_id not in collected:
                    collected.append(child_id)
                    stack.append(child_id)

    branch_ids = [branch_id]
    _collect_descendant_branch_ids(branch_id, branch_ids)

    message_count = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.branch_id.in_(branch_ids)
    ).count()

    return {
        "branch_ids": branch_ids,
        "branch_count": len(branch_ids),
        "message_count": message_count,
        "branch_name": branch.branch_name,
        "is_active": branch.is_active,
        "is_only_branch": total_branches <= len(branch_ids),
    }


@router_sessions.delete("/{session_id}/branches/{branch_id}")
async def delete_branch(
    session_id: str,
    branch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id == branch_id,
        CharacterChatSessionBranch.session_id == session_id
    ).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    # 检查是否为唯一分支（不允许删除唯一分支）
    total_branches = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id
    ).count()

    def _collect_descendant_branch_ids(bid: str, collected: list):
        all_branches = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).all()
        children_map: dict = {}
        for b in all_branches:
            if b.parent_branch_id:
                children_map.setdefault(b.parent_branch_id, []).append(b.id)
        stack = [bid]
        while stack:
            cur = stack.pop()
            for child_id in children_map.get(cur, []):
                if child_id not in collected:
                    collected.append(child_id)
                    stack.append(child_id)

    branch_ids_to_delete = [branch_id]
    _collect_descendant_branch_ids(branch_id, branch_ids_to_delete)

    # 如果删除的是唯一分支，拒绝操作
    if total_branches <= len(branch_ids_to_delete):
        raise HTTPException(status_code=400, detail="Cannot delete the only branch. Please create a new branch first.")

    was_active = branch.is_active

    db.query(CharacterChatMessage).filter(
        CharacterChatMessage.branch_id.in_(branch_ids_to_delete)
    ).delete(synchronize_session=False)

    # [ORPHAN-MEM-FIX] 级联清理被删分支的向量记忆（conversation_memories.branch_id
    # 为裸 TEXT 无 ForeignKey；记忆按 branch 维度写入，随分支一并删除）
    from sqlalchemy import text as _sa_text
    _mem_ph = ", ".join([f":b{i}" for i in range(len(branch_ids_to_delete))])
    _mem_params = {f"b{i}": bid for i, bid in enumerate(branch_ids_to_delete)}
    db.execute(
        _sa_text(f"DELETE FROM conversation_memories WHERE branch_id IN ({_mem_ph})"),
        _mem_params,
    )

    db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.id.in_(branch_ids_to_delete)
    ).delete(synchronize_session=False)

    # 如果删除了活动分支，自动切换到剩余的第一个分支
    if was_active:
        remaining = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id
        ).first()
        if remaining:
            remaining.is_active = True

    db.commit()
    return {"status": "ok", "deleted_branches": branch_ids_to_delete, "was_active": was_active}


# ───────────────────────────────────────────────
# Character Chat (Streaming)
# ───────────────────────────────────────────────

class ExtensionPromptInput(BaseModel):
    """ST 1.18.0 extension_prompts 单条输入。

    与前端 useCharacterChat.ts 发送的 extension_prompts 字段对齐。
    position 枚举（与 ST script.js:491-496 完全一致）：
      -1 = NONE          不注入
       0 = IN_PROMPT     作为 system prompt 追加到末尾，不按 depth
       1 = IN_CHAT       按 depth 注入到 chat history
       2 = BEFORE_PROMPT 作为 system prompt 插入到最前，不按 depth
    role：ST extension_prompt_roles 0=SYSTEM/1=USER/2=ASSISTANT（int 或 str 均可）
    """
    identifier: str
    content: Optional[str] = None
    position: int = -1
    depth: int = 4
    role: Union[int, str] = "system"
    # P2-7 修复: scan 字段对齐 ST 1.18.0 extension_prompt.scan
    # 当 scan=true 时，content 在注入前执行 macro 替换
    scan: Optional[bool] = False
    filter: Optional[Dict[str, Any]] = None


class CharacterChatRequest(BaseModel):
    character_id: str
    message: str
    session_id: Optional[str] = None
    model: str
    temperature: float = 0.7
    top_p: float = 0.95
    max_tokens: int = 2048
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    min_p: float = 0.05
    top_k: int = 40
    repetition_penalty: float = 1.1
    dialogue_mode: str = "first_person"
    preset_id: Optional[int] = None
    branch_id: Optional[str] = None
    user_nickname: Optional[str] = None
    images: List[str] = []
    files: List[str] = []
    response_length: Optional[str] = None
    smart_card_trigger: bool = False
    smart_card_context: Optional[str] = None
    extension_prompts: List[ExtensionPromptInput] = []
    # Task 3.4.2: 前端序列化的插件 function tool（OpenAI tool calling 格式）
    tools: Optional[List[Dict[str, Any]]] = None
    # D8 修复: 群聊装配路径接通 (ST 1.18.0 群聊支持)
    group_id: Optional[str] = None  # 群聊 ID，非空时触发群聊分支
    current_speaker_id: Optional[str] = None  # 当前发言者 ID（群聊场景）
    # Task 7: ST generate_interceptor 消息重排同步
    # 前端 ST 扩展（如 vectors_rearrangeChat）重排 window.chat 后，
    # 将重排后的消息 ID 顺序通过此字段传递给后端，后端按此顺序装配 prompt。
    # 空列表表示使用默认顺序（按 created_at 升序）。
    message_order: List[str] = []
    # P0-3: ST generate_interceptor 消息排除同步（与 WS interceptor_result 对齐）。
    # 前端拦截器 splice 删除的消息 ID，装配时从历史排除（不改动 DB）。
    excluded_message_ids: List[str] = []


class SmartCardGenerateRequest(BaseModel):
    character_id: str
    prompt: str = ""
    session_id: Optional[str] = None
    branch_id: Optional[str] = None
    model: str
    mode: str = "quiet"
    temperature: float = 0.7
    top_p: float = 0.95
    max_tokens: int = 1024
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    dialogue_mode: str = "first_person"
    user_nickname: Optional[str] = None
    include_history: bool = True
    # P0-1 修复: ST generateQuietPrompt 路径透传 extension_prompts。
    # 之前 Pydantic 静默丢弃前端 setExtensionPrompt 注入的 quietPrompts，
    # 导致 vectors / smart-card 扩展提示完全失效。
    # 参考: ST 1.18.0 script.js generateQuietPrompt → body.extension_prompts
    extension_prompts: List[ExtensionPromptInput] = []
    # Task 7: ST generate_interceptor 消息重排同步（与 CharacterChatRequest 对齐）
    message_order: List[str] = []


@router_chat.post("/api/character-chat/smart-card-generate")
async def smart_card_generate(
    req: SmartCardGenerateRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )

    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    try:
        ensure_model_available(req.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid model") from exc

    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    prompt_lang = user_setting.prompt_language if user_setting else "auto"
    user_nickname = req.user_nickname or user.username or "User"
    mode = (req.mode or "quiet").strip().lower()
    prompt = _replace_placeholders(req.prompt or "", user_nickname, char.name or "")

    enable_thinking = None
    try:
        from ..services.unified_model_registry import find_model
        _, model_data = find_model(req.model)
        if model_data and isinstance(model_data, dict):
            enable_thinking = model_data.get("enable_thinking")
    except Exception as e:
        logger.warning(f"Failed to get model config for smart-card generation: {e}")

    if mode == "raw":
        if not prompt.strip():
            return {"success": True, "content": "", "usage": {}}
        messages = [{"role": "user", "content": prompt}]
    else:
        session_id = req.session_id or ""
        branch_id = req.branch_id or ""
        if session_id:
            existing_session = db.query(CharacterChatSession).filter(
                CharacterChatSession.id == session_id,
                CharacterChatSession.user_id == user.id,
                CharacterChatSession.character_id == char.id,
            ).first()
            if not existing_session:
                raise HTTPException(status_code=404, detail="Session not found")
            if not branch_id:
                active_branch = db.query(CharacterChatSessionBranch).filter(
                    CharacterChatSessionBranch.session_id == session_id,
                    CharacterChatSessionBranch.is_active == True,
                ).first()
                branch_id = active_branch.id if active_branch else ""

        assembly = await assemble_roleplay_prompt(
            PromptAssemblyRequest(
                db=db,
                user=user,
                char=char,
                session_id=session_id,
                branch_id=branch_id,
                message="",
                images=[],
                model=req.model,
                user_nickname=user_nickname,
                dialogue_mode=req.dialogue_mode or "first_person",
                max_tokens=req.max_tokens,
                smart_card_trigger=True,
                smart_card_context=prompt.strip() if prompt.strip() else None,
                include_title_instruction=False,
                include_user_message=False,
                # P0-1 修复: 透传 quiet 路径 extension_prompts，对齐 ST
                # generateQuietPrompt 行为，使 setExtensionPrompt 注入生效
                extension_prompts=list(req.extension_prompts or []),
                # Task 7: 透传 generate_interceptor 消息重排顺序
                message_order=list(req.message_order or []),
            ),
            PromptAssemblyDeps(
                build_system_prompt=_build_char_system_prompt,
                replace_placeholders=_replace_placeholders,
                get_full_branch_history=_get_full_branch_history if req.include_history else (lambda *_args, **_kwargs: []),
                get_ancestor_branch_ids=_get_ancestor_branch_ids,
                contains_chinese=_contains_chinese,
                apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
                apply_regex_scripts=_apply_regex_scripts,
                apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
            ),
        )
        messages = assembly.messages

    completion = await complete_text_completion(
        model_id=req.model,
        messages=messages,
        temperature=req.temperature,
        top_p=req.top_p,
        max_tokens=max(1, min(int(req.max_tokens or 1024), 8192)),
        frequency_penalty=req.frequency_penalty,
        presence_penalty=req.presence_penalty,
        timeout=60.0,
        enable_thinking=enable_thinking,
    )
    return {
        "success": True,
        "content": completion.get("content") or "",
        "usage": completion.get("usage") or {},
    }


@router_chat.post("/api/character-chat")
async def character_chat(
    req: CharacterChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        return await _character_chat_impl(req, request, user, db)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.debug("[CHARACTER-CHAT-ERROR] %s: %s\n%s", type(e).__name__, e, tb)
        raise


async def _character_chat_impl(
    req: CharacterChatRequest,
    request: Request,
    user: User,
    db: Session,
):
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )
    char = db.query(Character).filter(Character.id == req.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    user_nickname = req.user_nickname or user.username or "用户"
    smart_card_trigger = bool(req.smart_card_trigger)
    smart_card_context = (
        clean_smart_card_trigger_context(req.smart_card_context or req.message)
        if smart_card_trigger
        else ""
    )
    if smart_card_trigger:
        req.message = clean_smart_card_trigger_context(req.message)
    is_init = req.message.strip() == "__INIT__"

    if not is_init:
        try:
            ensure_model_available(req.model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid model")

    # ── Ensure session ──────────────────────────────────────────────────
    session_id = req.session_id
    is_new_session = False
    if not session_id or session_id == "":
        session_id = str(uuid.uuid4())
        is_new_session = True
        initial_title = char.name
        if not is_init and not smart_card_trigger and (req.message or "").strip():
            try:
                initial_title = await generate_compact_title(
                    db,
                    req.message,
                    fallback_model_id=req.model,
                    max_len=10,
                )
            except Exception as e:
                logger.warning(f"Character session compact title fallback used: {e}")
                db.rollback()
        new_session = CharacterChatSession(
            id=session_id,
            character_id=char.id,
            user_id=user.id,
            title=initial_title,
            dialogue_mode=req.dialogue_mode,
        )
        # MVU 变量引擎：从角色卡 extensions 初始化会话变量
        try:
            from app.services.mvu_engine import (
                MvuEngine,
                merge_character_book_entries,
            )
            char_ext_raw: dict = {}
            if getattr(char, "extensions", None):
                try:
                    raw_ext = char.extensions
                    char_ext_raw = json.loads(raw_ext) if isinstance(raw_ext, str) else (raw_ext if isinstance(raw_ext, dict) else {})
                except (json.JSONDecodeError, TypeError):
                    pass
            # character_book 存在 world_books 表而非 extensions，需合并其 entry content
            # 供 build_initial_stat_data 提取 <initvar>（头像 URL/服饰/内心想法等初始值）。
            wb_entries = [
                str(stage.content or "")
                for wb in (char.world_books or [])
                if getattr(wb, "type", "") == "character_book"
                for stage in (wb.entries or [])
            ]
            char_ext_raw = merge_character_book_entries(char_ext_raw, wb_entries)
            init_vars = MvuEngine.init_session_variables(char_ext_raw)
            if init_vars.get("stat_data"):
                new_session.chat_metadata = json.dumps(
                    {"variables": init_vars}, ensure_ascii=False
                )
        except Exception:
            logger.warning("MVU session init failed", exc_info=True)
        db.add(new_session)
        db.commit()
    else:
        existing_session = db.query(CharacterChatSession).filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == char.id,
        ).first()
        if not existing_session:
            raise HTTPException(status_code=404, detail="Session not found")

        existing_session.updated_at = datetime.now(timezone.utc)
        db.commit()

    # ── Ensure active branch ────────────────────────────────────────────
    branch_id = req.branch_id
    if not branch_id:
        active_branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.is_active == True
        ).first()
        if active_branch:
            branch_id = active_branch.id
        else:
            if is_new_session:
                existing = db.query(CharacterChatSessionBranch).filter(
                    CharacterChatSessionBranch.session_id == session_id
                ).first()
                if existing:
                    branch_id = existing.id
                    if not existing.is_active:
                        existing.is_active = True
                        db.commit()
                else:
                    main_branch = CharacterChatSessionBranch(
                        session_id=session_id,
                        branch_name="分支 1",
                        is_active=True,
                    )
                    db.add(main_branch)
                    db.commit()
                    db.refresh(main_branch)
                    branch_id = main_branch.id
    else:
        branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == branch_id,
            CharacterChatSessionBranch.session_id == session_id,
        ).first()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

    # ── Memory context ───────────────────────────────────────────────
    memory_mode = "disabled"
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if user_setting and user_setting.memory_mode:
        memory_mode = user_setting.memory_mode

    # ── Get model config for thinking mode ─────────────────────────────
    enable_thinking = None
    try:
        from ..services.unified_model_registry import find_model
        _, model_data = find_model(req.model)
        if model_data and isinstance(model_data, dict):
            enable_thinking = model_data.get("enable_thinking")
    except Exception as e:
        logger.warning(f"Failed to get model config for thinking mode: {e}")


    # ── Handle __INIT__ (send character's first message) ────────────────
    if is_init:
        # SillyTavern renders first_mes first and exposes alternate_greetings as
        # swipes. Smart cards such as <GameStart> rely on that first render to
        # bootstrap their own UI before choosing an alternate opening.
        first_mes = _replace_placeholders(char.first_mes or "", user_nickname, char.name or "")
        first_mes = _apply_persist_regex_to_display_text(
            first_mes,
            db,
            char,
            user_name=user_nickname,
            placement=REGEX_PLACEMENT_AI_OUTPUT,
            depth=0,
        )
        # B-7 修复: first_mes 为空时提升第一个 alternate greeting（ST getFirstMessage
        # 的 swipes.shift() 语义），避免空 first_mes 角色无首条消息。
        # R-6 修复: 提升的 greeting 同样应用 AI_OUTPUT 显示正则——ST script.js:7695
        # 对 alternateGreetings 逐个 getRegexedString(greeting, AI_OUTPUT)，此前提升
        # 分支跳过正则导致占位符/宏不展开。_character_alternate_greetings 已做
        # 占位符替换，此处补齐显示正则（与上方正常 first_mes 分支一致）。
        alt_greetings = _character_alternate_greetings(char, user_nickname)
        if not first_mes and alt_greetings:
            first_mes = alt_greetings[0]
            first_mes = _apply_persist_regex_to_display_text(
                first_mes,
                db,
                char,
                user_name=user_nickname,
                placement=REGEX_PLACEMENT_AI_OUTPUT,
                depth=0,
            )
            alt_greetings = alt_greetings[1:]
        if not first_mes:
            return {"session_id": session_id, "message": ""}

        init_short_title = rule_based_compact_title(first_mes, max_len=10)
        # Save the character's first message directly
        db.add(CharacterChatMessage(
            session_id=session_id,
            branch_id=branch_id,
            role="assistant",
            content=first_mes,
            short_title=init_short_title,
            model=req.model,
            **_st_message_kwargs(
                role="assistant",
                content=first_mes,
                char_name=char.name or "Character",
                user_name=user_nickname,
                swipes=[first_mes] + [item for item in alt_greetings],
            ),
        ))
        db.commit()

        async def init_stream():
            yield f"data: {json.dumps({'session_id': session_id, 'branch_id': branch_id})}\n\n"
            # Stream the first message in chunks
            # But if the message contains HTML (like from BanG City), send it whole
            if "```html" in first_mes:
                yield f"data: {json.dumps({'content': first_mes})}\n\n"
            else:
                chunk_size = 20
                for i in range(0, len(first_mes), chunk_size):
                    yield f"data: {json.dumps({'content': first_mes[i:i+chunk_size]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            init_stream(),
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── Regular message ─────────────────────────────────────────────────
    # ST 1.18.0 context template — load the preset's bound template name
    # (if any) and pass it down so prompt assembly can wrap messages.
    context_template_name: Optional[str] = None
    if req.preset_id:
        try:
            _preset_for_template = db.query(GenerationPreset).filter(
                GenerationPreset.id == req.preset_id,
                (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
            ).first()
            if _preset_for_template and _preset_for_template.context_template_name:
                context_template_name = _preset_for_template.context_template_name
        except Exception as tmpl_err:
            logger.warning("Failed to load context_template_name from preset %s: %s", req.preset_id, tmpl_err)

    assembly = await assemble_roleplay_prompt(
        PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message=req.message,
            images=req.images or [],
            model=req.model,
            user_nickname=user_nickname,
            dialogue_mode=req.dialogue_mode or "first_person",
            response_length=req.response_length,
            max_tokens=req.max_tokens,
            smart_card_trigger=smart_card_trigger,
            smart_card_context=smart_card_context,
            context_template_name=context_template_name,
            extension_prompts=list(req.extension_prompts or []),
            # D8 修复: 群聊装配路径接通，透传 group_id / current_speaker_id
            group_id=req.group_id,
            current_speaker_id=req.current_speaker_id,
            # Task 7: 透传 generate_interceptor 消息重排顺序
            message_order=list(req.message_order or []),
            # P0-3: 透传 interceptor 消息排除
            excluded_message_ids=list(req.excluded_message_ids or []),
        ),
        PromptAssemblyDeps(
            build_system_prompt=_build_char_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=_get_ancestor_branch_ids,
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        ),
    )
    messages = assembly.messages
    memory_mode = assembly.memory_mode
    effective_max_tokens = assembly.effective_max_tokens
    logger.debug("[PromptAssembly] %s", assembly.debug_dict())

    # Save user message
    _user_msg_row = None
    if not smart_card_trigger:
        _user_msg_row = CharacterChatMessage(
            session_id=session_id,
            branch_id=branch_id,
            role="user",
            content=req.message,
            model=req.model,
            **_st_message_kwargs(
                role="user",
                content=req.message,
                char_name=char.name or "Character",
                user_name=user_nickname,
            ),
        )
        db.add(_user_msg_row)

    # 更新分支的最后消息时间
    if branch_id:
        branch = db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.id == branch_id
        ).first()
        if branch:
            branch.last_message_at = datetime.now(timezone.utc)
            branch.is_frozen = False  # 有新消息时解冻

    # [MEM-UPSERT] flush 取回用户消息主键，供记忆写入按 message_id 关联；
    # smart_card_trigger / regenerate / swipe 场景无本轮用户消息 → 保持 None。
    if _user_msg_row is not None:
        db.flush()
        sse_user_message_id = _user_msg_row.id
    else:
        sse_user_message_id = None
    db.commit()

    async def event_generator() -> AsyncGenerator[str, None]:
        from ..services.stream_builder import StreamResult, stream_chat_deltas
        result = StreamResult()
        assistant_message_id = None
        last_saved_content_len = 0
        last_saved_reasoning_len = 0
        last_flush_ts = 0.0
        # Phase 3 extra 字段: gen_id 自动生成 + reasoning_duration 计时
        # ST 1.18.0 对齐: bookmarks.js:419 在生成时自动分配 gen_id 用于 swipe 分组
        # reasoning_duration 记录 LLM 思考链耗时（秒），供 ST 前端 reasoning 面板显示
        import uuid as _uuid_mod
        stream_gen_id = _uuid_mod.uuid4().hex[:8]
        stream_start_ts = time.monotonic()
        try:
            save_db = SessionLocal()
        except Exception as db_err:
            logger.error(f"Failed to create database session: {db_err}")
            yield f"data: {json.dumps({'content': 'Error: Database connection failed', 'error': True}, ensure_ascii=False)}\n\n"
            return

        def persist_snapshot(force: bool = False):
            nonlocal assistant_message_id
            nonlocal last_saved_content_len
            nonlocal last_saved_reasoning_len
            nonlocal last_flush_ts

            has_content = result.has_content
            if not has_content:
                return

            content_delta = len(result.full_content) - last_saved_content_len
            reasoning_delta = len(result.full_reasoning) - last_saved_reasoning_len
            changed = content_delta > 0 or reasoning_delta > 0

            if not force:
                if not changed:
                    return
                if content_delta < 80 and reasoning_delta < 80 and (time.monotonic() - last_flush_ts) < 1.0:
                    return

            # [THINK-DEDUP] full_content 而非 final_text()（final_text 自带 think 前缀，
            # 与下方 4572 行的再拼接形成双  thinking，见 websocket.py 同名修复）
            final_raw = result.full_content
            # [THINK-IN-CONTENT-FIX] 同 websocket.py：模型可能把思维链直接写进 content
            # （reasoning 字段为空，content 里带  thinking... response 块），在拼
            # reasoning 前缀之前剥离，避免污染入库正文。剥离后为空时保留原始。
            _clean_raw = re.sub(r"<think[\s\S]*?</think\s*>", "", final_raw, flags=re.IGNORECASE).strip()
            if _clean_raw:
                final_raw = _clean_raw
            final = _apply_persist_regex_to_display_text(
                final_raw,
                save_db,
                char,
                user_name=user_nickname,
                placement=REGEX_PLACEMENT_AI_OUTPUT,
                depth=0,
            )
            if result.full_reasoning:
                regexed_reasoning = _apply_plugin_regex_scripts(
                    result.full_reasoning,
                    db,
                    placement=REGEX_PLACEMENT_REASONING,
                    is_markdown=False,
                    is_prompt=False,
                    depth=0,
                    skip_extensions=char.extensions,
                    user_name=user_nickname,
                    char_name=char.name or "Character",
                )
                # ST 标准顺序：GLOBAL → SCOPED → PRESET
                regexed_reasoning = _apply_regex_scripts(
                    regexed_reasoning,
                    char.extensions,
                    placement=REGEX_PLACEMENT_REASONING,
                    is_markdown=False,
                    is_prompt=False,
                    depth=0,
                    user_name=user_nickname,
                    char_name=char.name or "Character",
                )
                preset_scripts = _extract_preset_regex_scripts_from_character(char)
                if preset_scripts:
                    regexed_reasoning = _apply_regex_scripts(
                        regexed_reasoning,
                        {"regex_scripts": preset_scripts},
                        placement=REGEX_PLACEMENT_REASONING,
                        is_markdown=False,
                        is_prompt=False,
                        depth=0,
                        user_name=user_nickname,
                        char_name=char.name or "Character",
                    )
                # [REASONING-SEPARATE] 思考不再内联包裹进 content，仅经 msg_extra.reasoning 持久化
            token_count = result.token_count()

            # Phase 3 extra 字段: reasoning 双写 + gen_id + per-swipe 元数据
            # ST 1.18.0 对齐: reasoning 同时写入 content 内联(包裹符号, 兼容旧前端)
            # 和 extra.reasoning(供 ST Native 前端 reasoning 面板使用)
            # 读取路径: extra.reasoning 优先, 回退到 content 内联解析(兼容历史消息)
            msg_extra: dict = {}
            msg_extra["gen_id"] = stream_gen_id
            if result.full_reasoning:
                msg_extra["reasoning"] = regexed_reasoning
                msg_extra["reasoning_type"] = "thinking"
                msg_extra["reasoning_duration"] = round(time.monotonic() - stream_start_ts, 3)
            # per-swipe 元数据: 捕获生成时的 model/token_count (ST 1.18.0 swipe_info[].extra)
            msg_extra["model"] = req.model
            msg_extra["token_count"] = token_count

            try:
                if assistant_message_id is None:
                    msg = CharacterChatMessage(
                        session_id=session_id,
                        branch_id=branch_id,
                        role="assistant",
                        content=final,
                        model=req.model,
                        tokens=token_count,
                        prompt_tokens=result.prompt_tokens,
                        reasoning_tokens=result.effective_reasoning_tokens(),
                        **_st_message_kwargs(
                            role="assistant",
                            content=final,
                            char_name=char.name or "Character",
                            user_name=user_nickname,
                            extra=msg_extra,
                            gen_id=stream_gen_id,
                        ),
                    )
                    save_db.add(msg)
                    save_db.commit()
                    save_db.refresh(msg)
                    assistant_message_id = msg.id
                else:
                    msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == assistant_message_id).first()
                    if msg is None:
                        msg = CharacterChatMessage(
                            session_id=session_id,
                            branch_id=branch_id,
                            role="assistant",
                            content=final,
                            model=req.model,
                            tokens=token_count,
                            prompt_tokens=result.prompt_tokens,
                            reasoning_tokens=result.effective_reasoning_tokens(),
                            **_st_message_kwargs(
                                role="assistant",
                                content=final,
                                char_name=char.name or "Character",
                                user_name=user_nickname,
                                extra=msg_extra,
                                gen_id=stream_gen_id,
                            ),
                        )
                        save_db.add(msg)
                        save_db.commit()
                        save_db.refresh(msg)
                        assistant_message_id = msg.id
                    else:
                        msg.model = req.model
                        msg.tokens = token_count
                        msg.prompt_tokens = result.prompt_tokens
                        msg.reasoning_tokens = result.effective_reasoning_tokens()
                        if not msg.name:
                            msg.name = char.name or "Character"
                        msg.is_user = False
                        msg.is_system = False
                        _sync_message_content_to_active_swipe(msg, final, extra=msg_extra)
                        save_db.commit()

                last_saved_content_len = len(result.full_content)
                last_saved_reasoning_len = len(result.full_reasoning)
                last_flush_ts = time.monotonic()
            except Exception as persist_error:
                save_db.rollback()
                logger.warning(f"Failed to persist assistant snapshot: {persist_error}")

        async def maybe_auto_generate_image_event():
            if not save_db or assistant_message_id is None or not result.has_content:
                return None
            if result.full_content.strip().startswith("Error:"):
                return None
            try:
                assistant_msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == assistant_message_id).first()
                current_user = save_db.query(User).filter(User.id == user.id).first()
                if not assistant_msg or not current_user:
                    return None
                context_messages = (
                    save_db.query(CharacterChatMessage)
                    .filter(
                        CharacterChatMessage.session_id == session_id,
                        CharacterChatMessage.branch_id == assistant_msg.branch_id,
                        CharacterChatMessage.id <= assistant_msg.id,
                    )
                    .order_by(CharacterChatMessage.id.desc())
                    .limit(8)
                    .all()
                )
                image = await maybe_generate_image_for_message(
                    save_db,
                    current_user,
                    assistant_msg,
                    list(reversed(context_messages)),
                    target="character",
                    character=char,
                )
                if not image:
                    return None
                return {
                    "type": "message_image_generated",
                    "message_id": assistant_msg.id,
                    "image": image_result_to_dict(image),
                    "image_url": image.image_url,
                    "content": assistant_msg.content,
                }
            except Exception as image_error:
                save_db.rollback()
                logger.warning(f"Auto character image generation failed: {image_error}")
                return {
                    "type": "message_image_generation_failed",
                    "message_id": assistant_message_id,
                    "error": "自动图片生成失败",
                }

        try:
            initial_events = []
            if is_new_session:
                initial_events.append({"session_id": session_id, "branch_id": branch_id})

            # ST 1.18.0 logit_bias / ban_sequences — load preset (if any) and
            # build the merged bias dict. Silently skipped when preset_id is
            # absent or preset has no bias fields populated.
            preset_for_bias = None
            if req.preset_id:
                try:
                    preset_for_bias = db.query(GenerationPreset).filter(
                        GenerationPreset.id == req.preset_id,
                        (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
                    ).first()
                except Exception as bias_err:
                    logger.warning("Failed to load preset %s for logit_bias: %s", req.preset_id, bias_err)
            logit_bias_dict = _build_logit_bias(preset_for_bias) if preset_for_bias else None

            stream = stream_text_completion(
                model_id=req.model,
                messages=messages,
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=effective_max_tokens,
                frequency_penalty=req.frequency_penalty,
                presence_penalty=req.presence_penalty,
                min_p=req.min_p,
                top_k=req.top_k,
                repetition_penalty=req.repetition_penalty,
                timeout=30.0,
                request_id=None,
                user_id=user.id,
                # Task 3.4.3: 传递前端 function tool。SSE 路径为单向流，无法
                # 接收前端 tool_call_response，因此不传 tool_executor；若模型
                # 返回 tool_calls 将走 MCP 降级（前端工具会失败但不阻塞生成）。
                # WebSocket 路径才是 function tool 的完整实现路径。
                tools=req.tools,
                enable_thinking=enable_thinking,
                logit_bias=logit_bias_dict,
            )

            async for sse_event in stream_chat_deltas(stream, result, initial_events=initial_events, enable_thinking=enable_thinking):
                persist_snapshot()
                try:
                    yield sse_event
                except Exception:
                    persist_snapshot(force=True)
                    raise

            persist_snapshot(force=True)
        except asyncio.CancelledError:
            if not result.has_content:
                result.full_content = "Error: 请求已中断，未收到模型回复。"
            persist_snapshot(force=True)
            raise
        except ServiceError as e:
            logger.exception("Character chat stream service error")
            if not result.has_content:
                result.full_content = f"Error: {e.message}"
            else:
                result.full_content += f"\n\n[{e.message}]"
            yield f"data: {json.dumps({'content': result.full_content, 'error': True}, ensure_ascii=False)}\n\n"
            persist_snapshot(force=True)
        except Exception as e:
            logger.exception("Character chat stream error")
            err_msg = "推理过程中发生错误，请稍后重试。"
            if not result.has_content:
                result.full_content = f"Error: {err_msg}"
            else:
                result.full_content += f"\n\n[推理中断: {err_msg}]"
            yield f"data: {json.dumps({'content': result.full_content, 'error': True}, ensure_ascii=False)}\n\n"
            persist_snapshot(force=True)
        finally:
            try:
                persist_snapshot(force=True)

                if assistant_message_id is not None:
                    try:
                        msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == assistant_message_id).first()
                        if msg and msg.short_title is None:
                            title_match = re.search(r"\[标题[:：]\s*(.{1,15})\s*\]", result.full_content)
                            if title_match:
                                extracted_title = title_match.group(1).strip()
                                clean_content = re.sub(r"\s*\[标题[:：]\s*.{1,15}\s*\]\s*$", "", result.full_content).strip()
                                msg.short_title = extracted_title
                                _sync_message_content_to_active_swipe(msg, clean_content)
                                result.full_content = clean_content
                                logger.info(f"[TitleGen] Extracted title from response: '{extracted_title}'")
                            else:
                                logger.info(f"[TitleGen] No title found in response, using fallback")
                                msg.short_title = rule_based_compact_title(result.full_content, max_len=10)
                            save_db.commit()
                            image_event = await maybe_auto_generate_image_event()
                            if image_event:
                                yield f"data: {json.dumps(image_event, ensure_ascii=False)}\n\n"
                    except Exception as e:
                        save_db.rollback()
                        logger.warning(f"Failed to generate short title: {e}")

                if assistant_message_id is not None:
                    try:
                        msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == assistant_message_id).first()
                        if msg and msg.content:
                            yield f"data: {json.dumps({'type': 'final_content', 'content': msg.content, 'message_id': assistant_message_id}, ensure_ascii=False)}\n\n"
                    except Exception:
                        pass

                if memory_mode != "disabled" and result.full_content:
                    try:
                        if not result.full_content.strip().startswith("Error:"):
                            mem_svc = MemoryService(save_db)
                            if mem_svc.is_available():
                                # [MEM-UPSERT] 记忆 = 消息当前内容的镜像：同 message_id
                                # 先删后写（幂等）；无本轮用户消息的场景 id 为 None 跳过删除。
                                if not smart_card_trigger and req.message.strip():
                                    if sse_user_message_id is not None:
                                        delete_by_message_id(save_db, session_id, sse_user_message_id)
                                    mem_svc.store_memory(
                                        user_id=user.id,
                                        session_id=session_id,
                                        role="user",
                                        content=req.message,
                                        branch_id=branch_id,
                                        message_id=sse_user_message_id,
                                    )
                                # [MEMORY-POLLUTION-FIX] assistant 入库前清洗功能块/思维链
                                if assistant_message_id is not None:
                                    delete_by_message_id(save_db, session_id, assistant_message_id)
                                mem_svc.store_memory(
                                    user_id=user.id,
                                    session_id=session_id,
                                    role="assistant",
                                    content=clean_memory_content(result.full_content),
                                    branch_id=branch_id,
                                    message_id=assistant_message_id,
                                )
                                save_db.commit()
                    except Exception as e:
                        save_db.rollback()
                        logger.warning(f"Memory storage failed: {e}")

                # ── PlotLine auto 推进判断（auto 模式自动推进） ─────────────────
                # 在主对话生成完成后，检查是否需要推进剧情阶段。
                # 推进失败不应影响主对话流程，使用 try/except 包裹。
                if result.full_content and not result.full_content.strip().startswith("Error:"):
                    try:
                        spl = save_db.query(SessionPlotLine).filter(
                            SessionPlotLine.session_id == session_id
                        ).first()
                        if spl and spl.stage_transition_mode == "auto":
                            # 获取最近的对话消息用于判断
                            recent_msgs = (
                                save_db.query(CharacterChatMessage)
                                .filter(
                                    CharacterChatMessage.session_id == session_id,
                                    CharacterChatMessage.branch_id == branch_id,
                                )
                                .order_by(CharacterChatMessage.id.desc())
                                .limit(8)
                                .all()
                            )
                            recent_messages = [
                                {"role": m.role, "content": m.content or ""}
                                for m in reversed(recent_msgs)
                            ]

                            # 构建与主对话相同模型的 LLM 调用函数
                            async def _plot_llm_call(prompt: str) -> str:
                                completion = await complete_text_completion(
                                    model_id=req.model,
                                    messages=[{"role": "user", "content": prompt}],
                                    temperature=0.0,
                                    max_tokens=16,
                                    timeout=15.0,
                                )
                                return completion.get("content") or ""

                            # 带超时保护的推进判断
                            try:
                                should_advance = await asyncio.wait_for(
                                    check_plot_transition(
                                        db=save_db,
                                        session_id=session_id,
                                        recent_messages=recent_messages,
                                        llm_call_fn=_plot_llm_call,
                                    ),
                                    timeout=20.0,
                                )
                            except asyncio.TimeoutError:
                                should_advance = False
                                logger.warning(
                                    f"PlotLine transition check timed out for session {session_id}"
                                )

                            if should_advance:
                                advanced = advance_stage(save_db, session_id)
                                if advanced:
                                    # 获取新阶段信息并通知前端
                                    new_spl = save_db.query(SessionPlotLine).filter(
                                        SessionPlotLine.session_id == session_id
                                    ).first()
                                    new_stage = None
                                    if new_spl:
                                        stage = save_db.query(PlotStage).filter(
                                            PlotStage.plot_line_id == new_spl.plot_line_id,
                                            PlotStage.stage_index == new_spl.current_stage_index,
                                        ).first()
                                        if stage:
                                            new_stage = {
                                                "stage_index": stage.stage_index,
                                                "title": stage.title,
                                                "summary": stage.summary,
                                                "content": stage.content,
                                            }
                                    yield f"data: {json.dumps({'type': 'plotline_advanced', 'plotline_advanced': True, 'new_stage': new_stage}, ensure_ascii=False)}\n\n"
                    except Exception as e:
                        save_db.rollback()
                        logger.warning(f"PlotLine auto transition failed: {e}")
            finally:
                if save_db:
                    save_db.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class PromptAssemblyDebugRequest(BaseModel):
    message: str = ""
    images: list[str] = []
    model: Optional[str] = None
    user_nickname: Optional[str] = None
    dialogue_mode: str = "first_person"
    response_length: Optional[str] = None
    max_tokens: int = 2048
    smart_card_trigger: bool = False
    smart_card_context: Optional[str] = None
    # ST 1.18.0 context template binding — name of ContextTemplate to apply.
    # When omitted, assembly uses the "Default" (passthrough) template.
    context_template_name: Optional[str] = None


@router_sessions.post("/{session_id}/debug-prompt-assembly")
async def debug_prompt_assembly(
    session_id: str,
    req: PromptAssemblyDebugRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    char = db.query(Character).filter(Character.id == session.character_id, Character.user_id == user.id).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_active == True,
    ).first()
    branch_id = branch.id if branch else None

    user_nickname = req.user_nickname or user.username or "用户"

    assembly = await assemble_roleplay_prompt(
        PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message=req.message,
            images=req.images,
            model=req.model,
            user_nickname=user_nickname,
            dialogue_mode=req.dialogue_mode,
            response_length=req.response_length,
            max_tokens=req.max_tokens,
            smart_card_trigger=req.smart_card_trigger,
            smart_card_context=req.smart_card_context,
            context_template_name=req.context_template_name,
        ),
        PromptAssemblyDeps(
            build_system_prompt=_build_char_system_prompt,
            replace_placeholders=_replace_placeholders,
            get_full_branch_history=_get_full_branch_history,
            get_ancestor_branch_ids=_get_ancestor_branch_ids,
            contains_chinese=_contains_chinese,
            apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
            apply_regex_scripts=_apply_regex_scripts,
            apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
        ),
    )
    return {
        "session_id": session_id,
        "branch_id": branch_id,
        "assembly": assembly.debug_dict(),
        "messages_preview": [
            {"role": m.get("role"), "content_preview": (m.get("content") or "")[:200]}
            for m in assembly.messages
        ],
    }


# ───────────────────────────────────────────────
# ST 兼容：generateRaw / stopGeneration 端点
# ───────────────────────────────────────────────

class GenerateRawRequest(BaseModel):
    """generateRaw 请求体

    对应 ST 1.18.0 的 generateRaw(promptArray, options)：
    绕过提示词构建管线，直接将 prompt 数组发送给模型。
    """
    messages: List[Dict[str, Any]] = []
    prompt: str = ""
    model: str
    temperature: float = 0.7
    top_p: float = 0.95
    max_tokens: int = 1024
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0


@router_chat.post("/api/chats/generate-raw")
async def chats_generate_raw(
    req: GenerateRawRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """ST generateRaw 后端实现

    接受原始 prompt（messages 数组或 prompt 字符串），
    绕过角色卡 / 世界书 / 历史记录构建，直接调用模型 API。
    返回完整生成结果（非流式）。
    """
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )

    try:
        ensure_model_available(req.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid model") from exc

    if req.messages:
        messages = list(req.messages)
    elif req.prompt:
        messages = [{"role": "user", "content": req.prompt}]
    else:
        return {"success": True, "content": "", "usage": {}}

    enable_thinking = None
    try:
        from ..services.unified_model_registry import find_model
        _, model_data = find_model(req.model)
        if model_data and isinstance(model_data, dict):
            enable_thinking = model_data.get("enable_thinking")
    except Exception as e:
        logger.warning(f"Failed to get model config for generate-raw: {e}")

    try:
        completion = await complete_text_completion(
            model_id=req.model,
            messages=messages,
            temperature=req.temperature,
            top_p=req.top_p,
            max_tokens=max(1, min(int(req.max_tokens or 1024), 8192)),
            frequency_penalty=req.frequency_penalty,
            presence_penalty=req.presence_penalty,
            timeout=60.0,
            enable_thinking=enable_thinking,
        )
    except Exception as e:
        logger.error(f"generate-raw failed: {e}")
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)[:200]}")

    return {
        "success": True,
        "content": completion.get("content") or "",
        "usage": completion.get("usage") or {},
    }


@router_chat.post("/api/chats/stop")
async def chats_stop_generation(
    user: User = Depends(get_current_user),
):
    """ST stopGeneration 后端实现

    客户端通过 AbortController 中止 SSE 流（HTTP 连接断开），
    后端无需主动跟踪生成任务。此端点仅作 ST 兼容占位，
    返回成功响应供前端调用方确认。
    """
    return {"success": True, "stopped": True}


# ───────────────────────────────────────────────
# JSONL Import/Export
# ───────────────────────────────────────────────

@router_sessions.post("/import-jsonl")
async def import_session_jsonl(
    character_id: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导入聊天记录文件到会话

    支持 ST 1.18.0 JSONL（原生格式，兼容 V1），并自动识别第三方格式：
    Character.AI (CAI)、RisuAI、TavernAI/Pygmalion。通过文件扩展名或
    内容结构判断格式，转换为 ST JSONL 后复用现有导入逻辑。
    """
    from ..services.st_sync_service import import_chat_to_session

    char = db.query(Character).filter(
        Character.id == character_id,
        Character.user_id == user.id,
    ).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    content = await file.read()
    try:
        chat_text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File encoding is not valid UTF-8")

    try:
        session_id = import_chat_to_session(
            db, character_id, chat_text, user.id, filename=file.filename or ""
        )
    except ValueError as exc:
        message = str(exc)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=f"Import failed: {message}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Import failed: {str(exc)}")

    message_count = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    ).count()

    return {"session_id": session_id, "message_count": message_count}


# 第三方格式名称 → st_sync_service 内部格式名称
_THIRD_PARTY_FORMAT_MAP = {
    "cai": "cai",
    "risuai": "risuai",
    "tavernai": "tavern",
    "pygmalion": "tavern",
}


@router_chat.post("/api/chats/import-third-party")
async def import_third_party_chat(
    character_id: str = Form(...),
    format: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导入第三方聊天格式文件

    支持格式：cai (Character.AI)、risuai (RisuAI)、tavernai (TavernAI)、pygmalion。
    委托给现有 import_chat_to_session 逻辑，format 参数覆盖自动检测。
    返回导入的 session_id。
    """
    fmt = _THIRD_PARTY_FORMAT_MAP.get((format or "").lower().strip())
    if not fmt:
        raise HTTPException(
            status_code=501,
            detail=f"Unsupported format: {format}. Supported: cai, risuai, tavernai, pygmalion",
        )

    from ..services.st_sync_service import import_chat_to_session

    char = db.query(Character).filter(
        Character.id == character_id,
        Character.user_id == user.id,
    ).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    content = await file.read()
    try:
        chat_text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File encoding is not valid UTF-8")

    try:
        session_id = import_chat_to_session(
            db, character_id, chat_text, user.id,
            filename=file.filename or "",
            format_hint=fmt,
        )
    except ValueError as exc:
        message = str(exc)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=f"Import failed: {message}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Import failed: {str(exc)}")

    message_count = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id
    ).count()

    return {"session_id": session_id, "message_count": message_count, "format": format}


@router_sessions.get("/{session_id}/export.jsonl")
async def export_session_jsonl(
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导出会话为 .jsonl 文件（ST 1.18.0 格式）"""
    from ..services.st_sync_service import export_session_to_jsonl

    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        jsonl_content = export_session_to_jsonl(db, session_id)
    except ValueError as exc:
        message = str(exc)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=f"Export failed: {message}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Export failed: {str(exc)}")

    character = db.query(Character).filter(
        Character.id == session.character_id
    ).first()
    char_name = character.name if character else "character"
    safe_name = re.sub(r"[^\w\-]", "_", char_name)
    filename = f"{safe_name}_{session_id}.jsonl"

    return Response(
        content=jsonl_content.encode("utf-8"),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ───────────────────────────────────────────────
# Continue / Regenerate / Swipe 专用端点
# ───────────────────────────────────────────────

class _ActionRequest(BaseModel):
    model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: int = 2048
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    min_p: Optional[float] = None
    top_k: Optional[int] = None
    repetition_penalty: Optional[float] = None
    preset_id: Optional[int] = None
    response_length: Optional[str] = None
    user_nickname: Optional[str] = None


class ContinueRequest(_ActionRequest):
    # P2-8 修复: 支持可选 continue_prompt 参数（对齐 ST slash-commands.js:1845）。
    # 非空时，续写前会把此 prompt 追加到最后一条 AI 消息内容末尾。
    continue_prompt: Optional[str] = None


class RegenerateRequest(_ActionRequest):
    message_id: int


class SwipeRequest(_ActionRequest):
    message_id: int


class MvuSecondaryRequest(BaseModel):
    """手动触发副 AI 变量更新请求。

    message_id 可选：不传时默认取当前分支最后一条 assistant 消息作为剧情源。
    """
    message_id: Optional[int] = None


class SwipeSwitchRequest(BaseModel):
    swipe_id: int


def _branch_filter_expr(branch_id: Optional[str]):
    """Return a SQLAlchemy filter expression matching the given branch (or NULL)."""
    if branch_id:
        return CharacterChatMessage.branch_id == branch_id
    return CharacterChatMessage.branch_id.is_(None)


def _resolve_session_for_action(
    db: Session, session_id: str, user: User
) -> tuple[CharacterChatSession, Character, Optional[str]]:
    """Verify session ownership and return (session, char, active_branch_id)."""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    char = db.query(Character).filter(
        Character.id == session.character_id,
        Character.user_id == user.id,
    ).first()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")
    branch = db.query(CharacterChatSessionBranch).filter(
        CharacterChatSessionBranch.session_id == session_id,
        CharacterChatSessionBranch.is_active == True,
    ).first()
    branch_id = branch.id if branch else None
    return session, char, branch_id


def _resolve_action_model(req: _ActionRequest, fallback_msg: Optional[CharacterChatMessage]) -> str:
    """Resolve the model id for an action endpoint (request -> message -> default)."""
    model = req.model
    if not model:
        if fallback_msg and fallback_msg.model:
            model = fallback_msg.model
        else:
            model = get_default_ai_model()
    return model


def _ensure_conversation_anchor(messages: List[Dict[str, Any]], char: Character) -> None:
    """[OPENING-REGEN] 重 roll/swipe 开场白时的对话锚点（对齐 ST）。

    移除目标开场白后 messages 无任何 user/assistant 轮（全 system 收尾），
    模型没有"正在对话"的锚点——弱模型会把角色卡定义堆当成待说明材料，
    输出「角色卡设定与扮演规划」类元信息而非剧情（2026-08-27 会话实测）。
    ST script.js:4780 "hack for regeneration of the first message" 空历史时
    补一条空 user 轮，其 OAI 路径更以 user 角色注入 jailbreak 作锚——此处
    对齐该语义，按卡片语言补一条显式开场指令的 user 轮。
    """
    if any(m.get("role") in ("user", "assistant") for m in messages):
        return
    char_name = (char.name or "角色").strip() or "角色"
    is_zh = _contains_chinese((char.name or "") + (char.description or ""))
    if is_zh:
        anchor = (
            f"（对话刚刚开始。请以{char_name}的身份，直接输出一段全新的开场白，"
            "从角色视角展开剧情；不要输出任何说明、规划或元信息。）"
        )
    else:
        anchor = (
            f"(The conversation has just started. As {char_name}, write a brand-new "
            "opening message in character, launching the scene from the character's "
            "perspective. Do not output any explanations, plans, or meta information.)"
        )
    messages.append({"role": "user", "content": anchor})


def _load_context_template_name(db: Session, user: User, preset_id: Optional[int]) -> Optional[str]:
    if not preset_id:
        return None
    try:
        preset = db.query(GenerationPreset).filter(
            GenerationPreset.id == preset_id,
            (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
        ).first()
        if preset and preset.context_template_name:
            return preset.context_template_name
    except Exception as tmpl_err:
        logger.warning("Failed to load context_template_name from preset %s: %s", preset_id, tmpl_err)
    return None


def _regexed_reasoning(result, db: Session, char: Character, user_nickname: str) -> str:
    """[REASONING-SEPARATE] 思考三段正则链（插件 → GLOBAL/SCOPED → PRESET）；无思考返回空串。"""
    if not result.full_reasoning:
        return ""
    regexed_reasoning = _apply_plugin_regex_scripts(
        result.full_reasoning,
        db,
        placement=REGEX_PLACEMENT_REASONING,
        is_markdown=False,
        is_prompt=False,
        depth=0,
        skip_extensions=char.extensions,
        user_name=user_nickname,
        char_name=char.name or "Character",
    )
    regexed_reasoning = _apply_regex_scripts(
        regexed_reasoning,
        char.extensions,
        placement=REGEX_PLACEMENT_REASONING,
        is_markdown=False,
        is_prompt=False,
        depth=0,
        user_name=user_nickname,
        char_name=char.name or "Character",
    )
    preset_scripts = _extract_preset_regex_scripts_from_character(char)
    if preset_scripts:
        regexed_reasoning = _apply_regex_scripts(
            regexed_reasoning,
            {"regex_scripts": preset_scripts},
            placement=REGEX_PLACEMENT_REASONING,
            is_markdown=False,
            is_prompt=False,
            depth=0,
            user_name=user_nickname,
            char_name=char.name or "Character",
        )
    return regexed_reasoning


def _apply_reasoning_regex(final_raw: str, result, db: Session, char: Character, user_nickname: str) -> tuple:
    """[REASONING-SEPARATE] 返回 (纯正文, 正则化思考)；思考不再内联包裹进正文。"""
    final = _apply_persist_regex_to_display_text(
        final_raw,
        db,
        char,
        user_name=user_nickname,
        placement=REGEX_PLACEMENT_AI_OUTPUT,
        depth=0,
    )
    return final, _regexed_reasoning(result, db, char, user_nickname)


async def _run_action_stream(
    *,
    request: Request,
    user: User,
    char: Character,
    session_id: str,
    branch_id: Optional[str],
    messages: list[dict],
    model: str,
    req: _ActionRequest,
    user_nickname: str,
    effective_max_tokens: int,
    initial_events: list[dict],
    persist_fn,
    memory_mode: str = "vector",
) -> AsyncGenerator[str, None]:
    """Shared streaming + persistence generator for continue/regenerate/swipe.

    ``persist_fn(save_db, result) -> (message_id, final_content)`` is called once
    after the stream completes with a non-error result. It owns all DB writes.
    """
    from ..services.stream_builder import StreamResult, stream_chat_deltas
    enforce_rate_limit(
        request,
        "chat:character",
        settings.CHARACTER_CHAT_RATE_LIMIT_REQUESTS,
        settings.CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    )
    try:
        ensure_model_available(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid model")

    result = StreamResult()
    save_db = SessionLocal()
    try:
        preset_for_bias = None
        if req.preset_id:
            try:
                preset_for_bias = save_db.query(GenerationPreset).filter(
                    GenerationPreset.id == req.preset_id,
                    (GenerationPreset.user_id == user.id) | (GenerationPreset.user_id == None),
                ).first()
            except Exception as bias_err:
                logger.warning("Failed to load preset %s for logit_bias: %s", req.preset_id, bias_err)
        logit_bias_dict = _build_logit_bias(preset_for_bias) if preset_for_bias else None

        enable_thinking = None
        try:
            from ..services.unified_model_registry import find_model
            _, model_data = find_model(model)
            if model_data and isinstance(model_data, dict):
                enable_thinking = model_data.get("enable_thinking")
        except Exception as e:
            logger.warning(f"Failed to get model config for thinking mode: {e}")

        stream = stream_text_completion(
            model_id=model,
            messages=messages,
            temperature=req.temperature if req.temperature is not None else 0.7,
            top_p=req.top_p if req.top_p is not None else 0.95,
            max_tokens=effective_max_tokens,
            frequency_penalty=req.frequency_penalty if req.frequency_penalty is not None else 0.0,
            presence_penalty=req.presence_penalty if req.presence_penalty is not None else 0.0,
            min_p=req.min_p if req.min_p is not None else 0.05,
            top_k=req.top_k if req.top_k is not None else 40,
            repetition_penalty=req.repetition_penalty if req.repetition_penalty is not None else 1.1,
            timeout=30.0,
            request_id=None,
            user_id=user.id,
            tools=None,
            enable_thinking=enable_thinking,
            logit_bias=logit_bias_dict,
        )

        async for sse_event in stream_chat_deltas(stream, result, initial_events=initial_events, enable_thinking=enable_thinking):
            try:
                yield sse_event
            except Exception:
                break
    except asyncio.CancelledError:
        if not result.has_content:
            result.full_content = "Error: 请求已中断，未收到模型回复。"
    except ServiceError as e:
        logger.exception("Action stream service error")
        if not result.has_content:
            result.full_content = f"Error: {e.message}"
        else:
            result.full_content += f"\n\n[{e.message}]"
        # U-5 修复: 统一 N12 error 契约（type:'error' + message），错误文本不再
        # 塞进 content——前端 useCharacterChat action 回调按 type:'error' 消费并
        # toast，content 携带错误文本会被当正文渲染
        yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': e.message}, ensure_ascii=False)}\n\n"
    except Exception as e:
        logger.exception("Action stream error")
        err_msg = "推理过程中发生错误，请稍后重试。"
        if not result.has_content:
            result.full_content = f"Error: {err_msg}"
        else:
            result.full_content += f"\n\n[推理中断: {err_msg}]"
        # U-5 修复: 同上，统一 type:'error' 载荷契约
        yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': err_msg}, ensure_ascii=False)}\n\n"
    finally:
        try:
            final_body = (result.full_content or "").strip()
            if final_body and not final_body.startswith("Error:"):
                message_id, final_content = persist_fn(save_db, result)
                # [MEM-UPSERT] 记忆 = 消息当前内容的镜像：同 message_id 先删后写。
                # 覆盖：continue 追加重叠(P3)、swipe 重roll 旧内容残留(P4)；
                # user 轮不受动作流改写 → 无 user 记忆写入。
                if message_id is not None and memory_mode != "disabled":
                    try:
                        mem_svc = MemoryService(save_db)
                        if mem_svc.is_available():
                            delete_by_message_id(save_db, session_id, message_id)
                            mem_svc.store_memory(
                                user_id=user.id,
                                session_id=session_id,
                                role="assistant",
                                content=clean_memory_content(final_content or ""),
                                branch_id=branch_id,
                                message_id=message_id,
                            )
                            save_db.commit()
                    except Exception as mem_err:
                        save_db.rollback()
                        logger.warning(f"[MEM-UPSERT] action stream memory update failed: {mem_err}")
                if message_id is not None:
                    yield f"data: {json.dumps({'type': 'final_content', 'content': final_content, 'message_id': message_id}, ensure_ascii=False)}\n\n"
            elif not final_body and (result.full_reasoning or "").strip():
                # [NO-CONTENT-FINAL] 动作流版：reasoning-only 不落库（对齐 websocket 主路径行为）
                logger.error(
                    "[NO-CONTENT-FINAL-ACTION] session=%s type=%s reasoning_len=%d（reasoning-only，不落库）",
                    session_id, getattr(req, "type", "action") if hasattr(req, "type") else "action",
                    len(result.full_reasoning or ""),
                )
                yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': '模型未输出正文，仅返回思考链，已丢弃本次生成。请重试或切换模型。'}, ensure_ascii=False)}\n\n"
        except Exception as e:
            save_db.rollback()
            logger.warning(f"Action persist failed: {e}")
            # U-1 修复: persist 失败此前被静默吞掉——增量已显示但 final_content
            # 永不到达，刷新即丢失。补发 N12 契约 error 事件让前端 toast 提示重试
            yield f"data: {json.dumps({'type': 'error', 'error': True, 'message': '回复保存失败，请重试'}, ensure_ascii=False)}\n\n"
        finally:
            save_db.close()


def _action_deps() -> PromptAssemblyDeps:
    return PromptAssemblyDeps(
        build_system_prompt=_build_char_system_prompt,
        replace_placeholders=_replace_placeholders,
        get_full_branch_history=_get_full_branch_history,
        get_ancestor_branch_ids=_get_ancestor_branch_ids,
        contains_chinese=_contains_chinese,
        apply_plugin_regex_scripts=_apply_plugin_regex_scripts,
        apply_regex_scripts=_apply_regex_scripts,
        apply_prompt_regex_to_messages=_apply_prompt_regex_to_messages,
    )


@router_sessions.post("/{session_id}/continue")
async def continue_session(
    session_id: str,
    req: ContinueRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """续写最后一条 assistant 消息（不添加新的 user 消息）。"""
    session, char, branch_id = _resolve_session_for_action(db, session_id, user)
    user_nickname = req.user_nickname or user.username or "用户"

    last_assistant = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        _branch_filter_expr(branch_id),
        CharacterChatMessage.role == "assistant",
    ).order_by(CharacterChatMessage.id.desc()).first()
    if not last_assistant:
        raise HTTPException(status_code=400, detail="No assistant message to continue")

    # P2-8 修复: 如果传入 continue_prompt，先追加到最后一条 AI 消息内容末尾
    # （对齐 ST slash-commands.js:1845 — /continue <prompt> 在续写前把 prompt
    # 追加到 AI 消息，使生成从此 prompt 之后继续）。
    _continue_prompt_applied = False
    if req.continue_prompt and req.continue_prompt.strip():
        prompt_text = req.continue_prompt.strip()
        last_assistant.content = (last_assistant.content or "") + prompt_text
        # 同步到当前 swipe
        _sync_message_content_to_active_swipe(last_assistant, last_assistant.content)
        db.commit()
        db.refresh(last_assistant)
        _continue_prompt_applied = True

    model = _resolve_action_model(req, last_assistant)
    context_template_name = _load_context_template_name(db, user, req.preset_id)

    assembly = await assemble_roleplay_prompt(
        PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message="",
            images=[],
            model=model,
            user_nickname=user_nickname,
            dialogue_mode=session.dialogue_mode or "first_person",
            response_length=req.response_length,
            max_tokens=req.max_tokens,
            is_continue=True,
            include_user_message=False,
            include_title_instruction=False,
            context_template_name=context_template_name,
        ),
        _action_deps(),
    )
    messages = assembly.messages
    effective_max_tokens = assembly.effective_max_tokens

    last_assistant_id = last_assistant.id

    def persist_fn(save_db, result):
        # [REASONING-SEPARATE] 续写正文追加到原消息；续写产生的思考追加进 extra.reasoning（不再内联包裹）
        _, regexed_reasoning = _apply_reasoning_regex(result.full_content, result, save_db, char, user_nickname)
        msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == last_assistant_id).first()
        if msg is None:
            return None, None
        # 续写：将新生成的正文追加到原消息内容末尾
        new_part = _apply_persist_regex_to_display_text(
            result.full_content,
            save_db,
            char,
            user_name=user_nickname,
            placement=REGEX_PLACEMENT_AI_OUTPUT,
            depth=0,
        )
        combined = (msg.content or "") + new_part
        _sync_message_content_to_active_swipe(msg, combined)
        if regexed_reasoning:
            patched_extra = _message_extra(msg)
            prev_reasoning = patched_extra.get("reasoning")
            patched_extra["reasoning"] = ((prev_reasoning + "\n") if prev_reasoning else "") + regexed_reasoning
            patched_extra.setdefault("reasoning_type", "thinking")
            msg.extra = _json_dump_or_none(patched_extra)
        msg.model = model
        msg.tokens = result.token_count()
        msg.prompt_tokens = result.prompt_tokens
        msg.reasoning_tokens = result.effective_reasoning_tokens()
        save_db.commit()
        return msg.id, msg.content

    return StreamingResponse(
        _run_action_stream(
            request=request,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            messages=messages,
            model=model,
            req=req,
            user_nickname=user_nickname,
            effective_max_tokens=effective_max_tokens,
            initial_events=[{"session_id": session_id, "branch_id": branch_id}],
            persist_fn=persist_fn,
            memory_mode=assembly.memory_mode,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router_sessions.post("/{session_id}/regenerate")
async def regenerate_message(
    session_id: str,
    req: RegenerateRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """重新生成指定 assistant 消息，保留原响应为 swipe。"""
    session, char, branch_id = _resolve_session_for_action(db, session_id, user)
    user_nickname = req.user_nickname or user.username or "用户"

    target_msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == req.message_id,
        CharacterChatMessage.session_id == session_id,
    ).first()
    if not target_msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if target_msg.role != "assistant":
        raise HTTPException(status_code=400, detail="Can only regenerate assistant messages")

    # 仅允许重新生成分支内最后一条 assistant 消息（与 ST 行为一致）
    last_assistant = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        _branch_filter_expr(branch_id),
        CharacterChatMessage.role == "assistant",
    ).order_by(CharacterChatMessage.id.desc()).first()
    if not last_assistant or last_assistant.id != target_msg.id:
        raise HTTPException(status_code=400, detail="Can only regenerate the last assistant message")

    model = _resolve_action_model(req, target_msg)
    context_template_name = _load_context_template_name(db, user, req.preset_id)

    assembly = await assemble_roleplay_prompt(
        PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message="",
            images=[],
            model=model,
            user_nickname=user_nickname,
            dialogue_mode=session.dialogue_mode or "first_person",
            response_length=req.response_length,
            max_tokens=req.max_tokens,
            is_continue=False,
            include_user_message=False,
            include_title_instruction=False,
            context_template_name=context_template_name,
        ),
        _action_deps(),
    )
    messages = assembly.messages
    effective_max_tokens = assembly.effective_max_tokens

    # 移除组装消息中最后一条 assistant 消息（即被重新生成的目标），
    # 使模型基于其前的 user 消息重新生成响应。
    last_asst_idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_asst_idx = i
            break
    if last_asst_idx is not None:
        messages = messages[:last_asst_idx] + messages[last_asst_idx + 1:]

    # [OPENING-REGEN] 重 roll 开场白：移除后无任何对话轮 → 补锚点防元信息输出
    _ensure_conversation_anchor(messages, char)

    target_msg_id = target_msg.id

    def persist_fn(save_db, result):
        # [REASONING-SEPARATE] 纯正文入 content/swipe，本轮思考写入 extra.reasoning（不再内联包裹）
        final, regexed_reasoning = _apply_reasoning_regex(result.full_content, result, save_db, char, user_nickname)
        msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == target_msg_id).first()
        if msg is None:
            return None, None
        # 将新生成内容追加为新的 swipe，并切换为当前 swipe
        current_swipes = _message_swipes(msg)
        if not current_swipes:
            current_swipes = [msg.content or ""]
        current_swipes.append(final)
        new_swipe_id = len(current_swipes) - 1
        msg.content = final
        msg.swipe_id = new_swipe_id
        msg.swipes = _json_dump_or_none(current_swipes)
        current_extra = _message_extra(msg)
        if regexed_reasoning:
            current_extra["reasoning"] = regexed_reasoning
            current_extra["reasoning_type"] = "thinking"
        msg.extra = _json_dump_or_none(_compose_message_extra_with_swipe_info(
            current_extra,
            swipes=current_swipes,
            swipe_id=new_swipe_id,
        ))
        msg.model = model
        msg.tokens = result.token_count()
        msg.prompt_tokens = result.prompt_tokens
        msg.reasoning_tokens = result.effective_reasoning_tokens()
        save_db.commit()
        return msg.id, msg.content

    return StreamingResponse(
        _run_action_stream(
            request=request,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            messages=messages,
            model=model,
            req=req,
            user_nickname=user_nickname,
            effective_max_tokens=effective_max_tokens,
            initial_events=[{"session_id": session_id, "branch_id": branch_id}],
            persist_fn=persist_fn,
            memory_mode=assembly.memory_mode,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router_sessions.post("/{session_id}/mvu-secondary")
async def trigger_mvu_secondary(
    session_id: str,
    req: MvuSecondaryRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """手动触发副 AI 变量更新（全手动模式）。

    以指定消息（或当前分支最后一条 assistant 消息）的剧情为源，
    调用副模型解析并生成 <UpdateVariable> patches，应用到会话 stat_data。
    返回应用后的变量与日志；副 AI 未配置/失败时返回空结果（不抛异常）。
    """
    session, char, branch_id = _resolve_session_for_action(db, session_id, user)

    # 定位剧情源消息：优先 req.message_id，否则取当前分支最后一条 assistant
    target_msg = None
    if req.message_id is not None:
        target_msg = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.id == req.message_id,
            CharacterChatMessage.session_id == session_id,
        ).first()
        if target_msg is None:
            raise HTTPException(status_code=404, detail="Message not found")
    else:
        target_msg = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == session_id,
            _branch_filter_expr(branch_id),
            CharacterChatMessage.role == "assistant",
        ).order_by(CharacterChatMessage.id.desc()).first()
        if target_msg is None:
            raise HTTPException(status_code=400, detail="No assistant message to analyze")

    story_text = target_msg.content or ""

    # 角色卡 extensions + character_book 合并（对齐 websocket.py persist_snapshot 逻辑）
    from sqlalchemy.orm import selectinload
    _mvu_char = (
        db.query(Character)
        .options(selectinload(Character.world_books).selectinload(WorldBook.entries))
        .filter(Character.id == char.id)
        .first()
    )
    char_ext_raw: dict = {}
    if _mvu_char is not None and getattr(_mvu_char, "extensions", None):
        try:
            raw_ext = _mvu_char.extensions
            char_ext_raw = json.loads(raw_ext) if isinstance(raw_ext, str) else (raw_ext if isinstance(raw_ext, dict) else {})
        except (json.JSONDecodeError, TypeError):
            pass
    from app.services.mvu_engine import merge_character_book_entries
    wb_entries = [
        str(stage.content or "")
        for wb in ((_mvu_char.world_books) if _mvu_char is not None else [])
        if getattr(wb, "type", "") == "character_book"
        for stage in (wb.entries or [])
    ]
    char_ext_raw = merge_character_book_entries(char_ext_raw, wb_entries)

    # 当前会话 stat_data（chat_metadata.variables）
    cur_vars: dict = {}
    if session.chat_metadata:
        try:
            cur_meta = json.loads(session.chat_metadata)
            if isinstance(cur_meta, dict):
                cur_vars = cur_meta.get("variables") or {}
        except (json.JSONDecodeError, TypeError):
            pass
    if not isinstance(cur_vars, dict) or not cur_vars.get("stat_data"):
        from app.services.mvu_engine import MvuEngine
        cur_vars = MvuEngine.init_session_variables(char_ext_raw)

    # 副 AI 配置检查（未开启/未配置模型 → 返回空结果）
    from app.models.system import UserSetting
    us = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if us is None or not us.mvu_secondary_enabled:
        return {"applied": False, "reason": "secondary_disabled", "variables": cur_vars, "logs": []}
    sec_model = (us.mvu_secondary_model or "").strip()
    if not sec_model:
        return {"applied": False, "reason": "secondary_model_missing", "variables": cur_vars, "logs": []}

    # 调用副模型生成 patches
    from app.services.mvu_engine import extract_schema_defaults, apply_patches
    from app.services.mvu_secondary import run_secondary_mvu
    schema_defaults = extract_schema_defaults(
        char_ext_raw.get("tavern_helper") if isinstance(char_ext_raw, dict) else None
    )
    if not schema_defaults:
        return {"applied": False, "reason": "no_schema", "variables": cur_vars, "logs": []}

    try:
        patches, logs = await run_secondary_mvu(
            secondary_model=sec_model,
            stat_data=cur_vars,
            story_text=story_text,
            schema_defaults=schema_defaults,
        )
    except Exception as exc:
        logger.warning("MVU secondary manual trigger failed: %s", exc)
        return {"applied": False, "reason": "call_failed", "variables": cur_vars, "logs": []}

    if not patches:
        return {"applied": False, "reason": "no_patches", "variables": cur_vars, "logs": logs}

    new_vars, applied = apply_patches(cur_vars, patches)
    if applied:
        # 持久化到会话 chat_metadata.variables
        cur_meta = {}
        if session.chat_metadata:
            try:
                cur_meta = json.loads(session.chat_metadata)
                if not isinstance(cur_meta, dict):
                    cur_meta = {}
            except (json.JSONDecodeError, TypeError):
                pass
        cur_meta["variables"] = new_vars
        session.chat_metadata = json.dumps(cur_meta, ensure_ascii=False)
        db.commit()
        logger.info(
            "MVU secondary manual applied %d patches: %s",
            len(patches), "; ".join(logs[:8]),
        )

    return {"applied": bool(applied), "reason": "ok" if applied else "no_change", "variables": new_vars, "logs": logs}


@router_sessions.post("/{session_id}/swipe")
async def swipe_message(
    session_id: str,
    req: SwipeRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """基于同一 user 消息生成新的候选 assistant 响应，追加到 swipes 数组。"""
    session, char, branch_id = _resolve_session_for_action(db, session_id, user)
    user_nickname = req.user_nickname or user.username or "用户"

    target_msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == req.message_id,
        CharacterChatMessage.session_id == session_id,
    ).first()
    if not target_msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if target_msg.role != "assistant":
        raise HTTPException(status_code=400, detail="Can only swipe assistant messages")

    last_assistant = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        _branch_filter_expr(branch_id),
        CharacterChatMessage.role == "assistant",
    ).order_by(CharacterChatMessage.id.desc()).first()
    if not last_assistant or last_assistant.id != target_msg.id:
        raise HTTPException(status_code=400, detail="Can only swipe the last assistant message")

    model = _resolve_action_model(req, target_msg)
    context_template_name = _load_context_template_name(db, user, req.preset_id)

    assembly = await assemble_roleplay_prompt(
        PromptAssemblyRequest(
            db=db,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            message="",
            images=[],
            model=model,
            user_nickname=user_nickname,
            dialogue_mode=session.dialogue_mode or "first_person",
            response_length=req.response_length,
            max_tokens=req.max_tokens,
            is_continue=False,
            include_user_message=False,
            include_title_instruction=False,
            context_template_name=context_template_name,
        ),
        _action_deps(),
    )
    messages = assembly.messages
    effective_max_tokens = assembly.effective_max_tokens

    last_asst_idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_asst_idx = i
            break
    if last_asst_idx is not None:
        messages = messages[:last_asst_idx] + messages[last_asst_idx + 1:]

    # [OPENING-REGEN] swipe 开场白：移除后无任何对话轮 → 补锚点防元信息输出
    _ensure_conversation_anchor(messages, char)

    target_msg_id = target_msg.id

    def persist_fn(save_db, result):
        # [REASONING-SEPARATE] 纯正文入 content/swipe，本轮思考写入 extra.reasoning（不再内联包裹）
        final, regexed_reasoning = _apply_reasoning_regex(result.full_content, result, save_db, char, user_nickname)
        msg = save_db.query(CharacterChatMessage).filter(CharacterChatMessage.id == target_msg_id).first()
        if msg is None:
            return None, None
        current_swipes = _message_swipes(msg)
        if not current_swipes:
            current_swipes = [msg.content or ""]
        current_swipes.append(final)
        new_swipe_id = len(current_swipes) - 1
        msg.content = final
        msg.swipe_id = new_swipe_id
        msg.swipes = _json_dump_or_none(current_swipes)
        current_extra = _message_extra(msg)
        if regexed_reasoning:
            current_extra["reasoning"] = regexed_reasoning
            current_extra["reasoning_type"] = "thinking"
        msg.extra = _json_dump_or_none(_compose_message_extra_with_swipe_info(
            current_extra,
            swipes=current_swipes,
            swipe_id=new_swipe_id,
        ))
        msg.model = model
        msg.tokens = result.token_count()
        msg.prompt_tokens = result.prompt_tokens
        msg.reasoning_tokens = result.effective_reasoning_tokens()
        save_db.commit()
        return msg.id, msg.content

    return StreamingResponse(
        _run_action_stream(
            request=request,
            user=user,
            char=char,
            session_id=session_id,
            branch_id=branch_id,
            messages=messages,
            model=model,
            req=req,
            user_nickname=user_nickname,
            effective_max_tokens=effective_max_tokens,
            initial_events=[{"session_id": session_id, "branch_id": branch_id}],
            persist_fn=persist_fn,
            memory_mode=assembly.memory_mode,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router_sessions.get("/{session_id}/messages/{message_id}/swipes")
async def get_message_swipes(
    session_id: str,
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取指定消息的所有 swipe 及当前选中的索引。"""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    swipes = _message_swipes(msg)
    if not swipes:
        swipes = [msg.content or ""]
    try:
        current_swipe_id = int(getattr(msg, "swipe_id", 0) or 0)
    except (TypeError, ValueError):
        current_swipe_id = 0
    current_swipe_id = max(0, min(current_swipe_id, len(swipes) - 1))
    return {
        "swipes": swipes,
        "current_swipe_id": current_swipe_id,
        "message_id": msg.id,
    }


@router_sessions.patch("/{session_id}/messages/{message_id}/swipe")
async def switch_message_swipe(
    session_id: str,
    message_id: int,
    req: SwipeSwitchRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """切换当前 swipe，并将消息内容同步到选中的 swipe。"""
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
        CharacterChatSession.user_id == user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    msg = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.id == message_id,
        CharacterChatMessage.session_id == session_id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    swipes = _message_swipes(msg)
    if not swipes:
        swipes = [msg.content or ""]

    new_swipe_id = req.swipe_id
    if new_swipe_id < 0 or new_swipe_id >= len(swipes):
        raise HTTPException(status_code=400, detail="swipe_id out of range")

    # [MEM-SYNC-ON-SWITCH] 进入函数时缓存旧正文，供 commit 前对比内容是否变化
    old_content_before = msg.content or ""

    msg.swipe_id = new_swipe_id
    msg.content = swipes[new_swipe_id]
    current_extra = _message_extra(msg)
    msg.extra = _json_dump_or_none(_compose_message_extra_with_swipe_info(
        current_extra,
        swipes=swipes,
        swipe_id=new_swipe_id,
    ))
    # [MEM-SYNC-ON-SWITCH] 切换即同步：记忆 = 消息当前内容的镜像。
    # 切换导致内容(strip)变化 → 先删该消息全部记忆行，commit 后按新文本后台重嵌；
    # 内容未变（重复切换到同一 swipe）零操作。
    _switched_for_reembed = None
    if (msg.content or "").strip() != old_content_before.strip():
        delete_by_message_id(db, session_id, message_id)
        _switched_for_reembed = (msg.role, msg.content or "")
    # 捕获标量，避免后台线程访问已关闭请求 Session 的 ORM 对象
    _switch_branch_id = msg.branch_id
    _switch_user_id = user.id
    db.commit()
    db.refresh(msg)

    if _switched_for_reembed is not None:
        _reembed_role, _reembed_text = _switched_for_reembed

        def _reembed_switched_message():
            re_db = SessionLocal()
            try:
                svc = MemoryService(re_db)
                if not svc.is_available():
                    return
                text_for_mem = (
                    clean_memory_content(_reembed_text)
                    if _reembed_role == "assistant"
                    else _reembed_text
                )
                if text_for_mem.strip():
                    svc.store_memory(
                        user_id=_switch_user_id,
                        session_id=session_id,
                        role=_reembed_role,
                        content=text_for_mem,
                        branch_id=_switch_branch_id,
                        message_id=message_id,
                    )
                    re_db.commit()
            except Exception:
                re_db.rollback()
                logger.warning("[MEM-SYNC-ON-SWITCH] re-embed after switch failed (message=%s)", message_id)
            finally:
                re_db.close()

        asyncio.create_task(asyncio.to_thread(_reembed_switched_message))
    return {
        "message_id": msg.id,
        "swipe_id": new_swipe_id,
        "content": msg.content,
        "swipes": swipes,
    }
