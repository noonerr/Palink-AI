"""
ST Native 同步服务 - Palink DB 与 ST DATA_ROOT 双向同步

设计原则:
- Palink DB 为权威数据源
- ST DATA_ROOT 为镜像，可随时重建
- 基于时间戳的增量同步
- 同步操作幂等
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy.orm import Session, selectinload

from ..character_card import convert_character_to_chara_card
from ..core import settings as app_settings
from ..models import (
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
    ChatVariable,
    GroupChat,
    GroupChatSession,
    Persona,
    User,
    WorldBook,
    WorldBookStage,
)


logger = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json_loads(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _safe_json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "null"


def _st_data_root_for_user(user: User) -> Optional[Path]:
    """获取用户的 ST DATA_ROOT 目录"""
    base = getattr(app_settings, "ST_NATIVE_DATA_ROOT", None)
    if not base:
        return None
    base_path = Path(base)
    try:
        base_path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    user_dir = base_path / f"palink-{user.id}"
    try:
        user_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return user_dir


def _characters_dir(data_root: Path) -> Path:
    path = data_root / "characters"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _chats_dir(data_root: Path) -> Path:
    path = data_root / "chats"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _worlds_dir(data_root: Path) -> Path:
    path = data_root / "worlds"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _variables_dir(data_root: Path) -> Path:
    path = data_root / "variables"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _avatar_key(character_id: str) -> str:
    return f"palink-{str(character_id).strip()}.png"


def _session_file_name(session_id: str, with_suffix: bool = False) -> str:
    name = f"palink-session-{str(session_id).strip()}"
    return f"{name}.jsonl" if with_suffix else name


def _world_file_name(world_book_id: str) -> str:
    return f"palink-world-{str(world_book_id).strip()}.json"


def _write_text(path: Path, content: str) -> bool:
    """原子写入文件：写入临时文件后 os.replace 原子替换。

    避免同步过程中 ST sidecar 读到截断的 JSON。
    临时文件与目标文件在同一目录，确保 os.replace 在同分区下原子生效。
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp_path, str(path))
            return True
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError:
        return False


def _write_json(path: Path, data: Any) -> bool:
    return _write_text(path, _safe_json_dumps(data))


def _read_text(path: Path) -> Optional[str]:
    """同步读取文件文本内容，失败返回 None。"""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _delete_file(path: Path) -> bool:
    """同步删除文件，文件不存在或删除失败返回 False。"""
    try:
        if path.exists():
            path.unlink()
        return True
    except OSError:
        return False


def _read_json(path: Path) -> Optional[Any]:
    text = _read_text(path)
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


# ───────────────────────────────────────────────
# 文件 I/O 异步包装（避免阻塞 FastAPI 事件循环）
#
# 这些异步版本使用 asyncio.to_thread 包装同步文件 I/O 操作。
# 在异步上下文中直接调用文件 I/O 时，应优先使用这些异步版本。
# 通过 async_sync_*_to_st 调用的同步函数已经在线程池中执行，
# 内部无需再用这些异步包装。
# ───────────────────────────────────────────────

async def _write_text_async(path: Path, content: str) -> bool:
    """_write_text 的异步包装，在线程池中执行避免阻塞事件循环。"""
    import asyncio
    return await asyncio.to_thread(_write_text, path, content)


async def _write_json_async(path: Path, data: Any) -> bool:
    """_write_json 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(_write_json, path, data)


async def _read_text_async(path: Path) -> Optional[str]:
    """_read_text 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(_read_text, path)


async def _read_json_async(path: Path) -> Optional[Any]:
    """_read_json 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(_read_json, path)


async def _delete_file_async(path: Path) -> bool:
    """_delete_file 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(_delete_file, path)


def _worldbook_to_charbook(wb: Optional[WorldBook]) -> Optional[dict[str, Any]]:
    if not wb:
        return None
    entries: dict[str, Any] = {}
    for i, stage in enumerate(wb.entries or []):
        entry = {
            "key": _safe_json_loads(stage.keys, []),
            "keysecondary": _safe_json_loads(stage.secondary_keys, []),
            "content": stage.content or "",
            "comment": stage.title or "",
            "constant": bool(stage.constant),
            "selective": bool(stage.selective),
            "selectiveLogic": stage.selective_logic if isinstance(stage.selective_logic, int) else 0,
            "scanDepth": stage.scan_depth if isinstance(stage.scan_depth, int) else 4,
            "position": stage.position if isinstance(stage.position, int) else 4,
            "probability": stage.probability if stage.probability is not None else 100,
            "order": stage.order if isinstance(stage.order, int) else (stage.stage_index or 0),
            "depth": stage.depth if isinstance(stage.depth, int) else 4,
            "disable": not bool(stage.enabled),
            "caseSensitive": bool(stage.case_sensitive),
            "matchWholeWords": bool(stage.match_whole_words),
            "useProbability": stage.probability is not None and stage.probability < 100,
            "excludeRecursion": bool(stage.exclude_recursion),
            "preventRecursion": bool(stage.prevent_recursion),
            "matchPersonaDescription": bool(stage.match_persona_description),
            "matchCharacterDescription": bool(stage.match_character_description),
            "matchCharacterPersonality": bool(stage.match_character_personality),
            "matchCharacterDepthPrompt": bool(stage.match_character_depth_prompt),
            "matchScenario": bool(stage.match_scenario),
            "matchCreatorNotes": bool(stage.match_creator_notes),
            "group": stage.group or "",
            "groupOverride": bool(stage.group_override),
            "groupWeight": stage.group_weight if isinstance(stage.group_weight, int) else 0,
            "sticky": stage.sticky if isinstance(stage.sticky, int) else 0,
            "cooldown": stage.cooldown if isinstance(stage.cooldown, int) else 0,
            "delay": stage.delay if isinstance(stage.delay, int) else 0,
            "vectorized": bool(stage.vectorized),
            "addMemo": bool(stage.add_memo),
            "decorators": _safe_json_loads(stage.decorators, []),
            # Bug #6: ST 1.18.0 ignoreBudget (extensions.ignore_budget)
            # 顶层字段由 stage.ignore_budget 提供；extensions 中的 ignore_budget
            # 由 _safe_json_loads(stage.extensions_json) 自然保留（如有）。
            "ignoreBudget": bool(getattr(stage, "ignore_budget", False)),
        }
        extensions = _safe_json_loads(stage.extensions_json, {})
        if isinstance(extensions, dict) and extensions:
            entry["extensions"] = extensions
        entries[str(i)] = entry
    return {
        "name": wb.name,
        "description": wb.description or "",
        "entries": entries,
        "extensions": {},
        "recursive_scanning": False,
    }


def _build_character_card(character: Character) -> dict[str, Any]:
    wb = next((item for item in (character.world_books or []) if item.type == "character_book"), None)
    return convert_character_to_chara_card(character, world_book_data=_worldbook_to_charbook(wb))


def _st_iso_utc(dt: Any) -> str:
    """Format a datetime like ST getMessageTimeStamp() (RossAscends-mods.js:192).

    ST writes message ``send_date`` via ``Date.toISOString()`` → UTC ISO-8601 with
    millisecond precision and a trailing ``Z``. Emitting Python's default
    ``isoformat()`` (microseconds, no ``Z``) drops the UTC indicator, so ST would
    render the timestamp in the browser's local timezone. Naive datetimes are
    assumed to be UTC (Palink stores created_at as UTC).
    """
    if not hasattr(dt, "isoformat"):
        return str(dt or "")
    aware = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    return aware.strftime("%Y-%m-%dT%H:%M:%S.") + f"{aware.microsecond // 1000:03d}Z"


def _message_to_st_jsonl(message: CharacterChatMessage, index: int, character: Character, user: User) -> dict[str, Any]:
    is_user = bool(message.is_user) if message.is_user is not None else message.role == "user"
    is_system = bool(message.is_system) if message.is_system is not None else message.role == "system"
    swipes_raw = _safe_json_loads(message.swipes, [])
    swipes = [str(item or "") for item in swipes_raw] if isinstance(swipes_raw, list) and swipes_raw else [message.content or ""]
    try:
        swipe_id = max(0, min(int(message.swipe_id or 0), len(swipes) - 1))
    except (TypeError, ValueError):
        swipe_id = 0
    extra = _safe_json_loads(message.extra, {})
    if not isinstance(extra, dict):
        extra = {}
    swipe_info = extra.get("swipe_info")
    if not isinstance(swipe_info, list):
        swipe_info = [{"send_date": message.created_at.isoformat() if message.created_at else "", "extra": {}} for _ in swipes]
    clean_extra = {k: v for k, v in extra.items() if k != "swipe_info"}
    result = {
        "id": message.id,
        "mesid": message.mesid if isinstance(message.mesid, int) else index,
        "name": message.name or (user.username if is_user else "System" if is_system else character.name),
        "is_user": is_user,
        "is_system": is_system,
        "is_name": clean_extra.get("is_name"),
        "send_date": _st_iso_utc(message.created_at) if message.created_at else "",
        "mes": message.content or "",
        "swipes": swipes,
        "swipe_id": swipe_id,
        "swipe_info": swipe_info,
        "extra": clean_extra,
        "is_hidden": bool(message.is_hidden),
        "is_locked": bool(message.is_locked),
    }
    # ST 1.18.0 persists these as TOP-LEVEL message fields, not under extra:
    # gen_started/gen_finished (script.js:6736-6737) and force_avatar/
    # original_avatar (script.js:5835). Palink stashes them in extra on import;
    # lift them back so ST reads them at the expected location on round-trip.
    for _top_key in ("gen_started", "gen_finished", "force_avatar", "original_avatar"):
        _val = clean_extra.pop(_top_key, None)
        if _val is not None:
            result[_top_key] = _val
    return result


def _chat_header(session: CharacterChatSession, character: Character, user: User, branch: Optional[CharacterChatSessionBranch]) -> dict[str, Any]:
    # 从 session.chat_metadata 加载已持久化的 ST 元数据（note_prompt/hidden_bots/taint/variables 等）
    base_metadata: dict[str, Any] = {}
    raw_meta = getattr(session, "chat_metadata", None)
    if raw_meta:
        try:
            base_metadata = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta if isinstance(raw_meta, dict) else {})
        except (json.JSONDecodeError, TypeError):
            base_metadata = {}
    # 合并：base_metadata 为底，Palink 内部路由字段覆盖
    merged: dict[str, Any] = {**base_metadata}
    merged.update({
        "palink_session_id": session.id,
        "palink_character_id": character.id,
        "palink_branch_id": branch.id if branch else None,
    })
    # talkativeness: Palink DB 为权威源（character.talkativeness），
    # 确保 ST sidecar 加载聊天后与 Palink DB 状态一致。
    char_talkativeness = getattr(character, "talkativeness", None)
    if char_talkativeness is not None:
        merged["talkativeness"] = str(char_talkativeness)
    elif "talkativeness" not in merged:
        merged["talkativeness"] = "0.5"
    # last_modified_date: 从 Palink DB session.updated_at 同步
    if getattr(session, "updated_at", None) is not None:
        merged["last_modified_date"] = session.updated_at.isoformat()
    return {
        "user_name": user.username or "User",
        "character_name": character.name,
        "create_date": (session.created_at or datetime.now(timezone.utc)).isoformat(),
        "chat_metadata": merged,
    }


def _active_branch(db: Session, session: CharacterChatSession) -> Optional[CharacterChatSessionBranch]:
    return (
        db.query(CharacterChatSessionBranch)
        .filter(
            CharacterChatSessionBranch.session_id == session.id,
            CharacterChatSessionBranch.is_active.is_(True),
        )
        .order_by(CharacterChatSessionBranch.created_at.desc())
        .first()
    )


def _chat_messages(db: Session, session: CharacterChatSession, branch: Optional[CharacterChatSessionBranch]) -> list[CharacterChatMessage]:
    query = db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == session.id)
    if branch:
        query = query.filter(CharacterChatMessage.branch_id == branch.id)
    else:
        query = query.filter(CharacterChatMessage.branch_id.is_(None))
    return query.order_by(CharacterChatMessage.created_at, CharacterChatMessage.id).all()


def sync_character_to_st(db: Session, user: User, character: Character) -> dict[str, Any]:
    """同步单个角色卡到 ST DATA_ROOT"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}

    card = _build_character_card(character)
    characters_dir = _characters_dir(data_root)
    avatar_key = _avatar_key(character.id)

    card_path = characters_dir / f"{avatar_key}.json"
    if not _write_json(card_path, card):
        return {"ok": False, "reason": "write_card_failed"}

    avatar_path = characters_dir / avatar_key
    avatar_url = character.avatar or ""
    if avatar_url and not avatar_path.exists():
        try:
            if avatar_url.startswith("data:"):
                header, _, b64 = avatar_url.partition(",")
                if b64:
                    avatar_path.write_bytes(base64.b64decode(b64))
            elif avatar_url.startswith("/"):
                static_root = Path(getattr(app_settings, "STATIC_DIR", "static"))
                source = static_root / avatar_url.lstrip("/")
                if source.exists():
                    shutil.copyfile(source, avatar_path)
        except (OSError, ValueError):
            pass

    for wb in character.world_books or []:
        if wb.type == "character_book":
            continue
        sync_worldbook_to_st(db, user, wb)

    sessions = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.user_id == user.id,
            CharacterChatSession.character_id == character.id,
        )
        .all()
    )
    synced_sessions = 0
    for session in sessions:
        result = sync_session_to_st(db, user, character, session)
        if result.get("ok"):
            synced_sessions += 1

    return {
        "ok": True,
        "character_id": character.id,
        "avatar_key": avatar_key,
        "sessions_synced": synced_sessions,
        "synced_at": _utc_now_iso(),
    }


def sync_session_to_st(
    db: Session,
    user: User,
    character: Character,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch] = None,
) -> dict[str, Any]:
    """同步单个会话到 ST DATA_ROOT"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}

    if branch is None:
        branch = _active_branch(db, session)

    messages = _chat_messages(db, session, branch)
    chats_dir = _chats_dir(data_root)
    char_chat_dir = chats_dir / (character.name or "character")
    char_chat_dir.mkdir(parents=True, exist_ok=True)
    file_name = _session_file_name(session.id, with_suffix=True)
    chat_path = char_chat_dir / file_name

    # 查询 ChatVariable 表，合并到 JSONL header 的 chat_metadata.variables，
    # 确保 ST 插件从 JSONL 元数据读取变量时与 Palink DB 保持同步。
    variables = (
        db.query(ChatVariable)
        .filter(ChatVariable.session_id == session.id)
        .all()
    )

    lines: list[str] = []
    header = _chat_header(session, character, user, branch)
    if variables:
        header["chat_metadata"]["variables"] = {v.key: v.value for v in variables}
    lines.append(_safe_json_dumps(header))
    for index, message in enumerate(messages):
        lines.append(_safe_json_dumps(_message_to_st_jsonl(message, index, character, user)))

    if not _write_text(chat_path, "\n".join(lines) + "\n"):
        return {"ok": False, "reason": "write_chat_failed"}

    if variables:
        variables_data = {
            "chat_metadata": {
                "variables": {v.key: v.value for v in variables},
                "palink_session_id": session.id,
            }
        }
        vars_path = _variables_dir(data_root) / f"{_session_file_name(session.id)}.json"
        _write_json(vars_path, variables_data)

    return {
        "ok": True,
        "session_id": session.id,
        "file_name": file_name,
        "message_count": len(messages),
        "synced_at": _utc_now_iso(),
    }


def sync_worldbook_to_st(db: Session, user: User, world_book: WorldBook) -> dict[str, Any]:
    """同步世界书到 ST DATA_ROOT"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}

    worlds_dir = _worlds_dir(data_root)
    file_name = _world_file_name(world_book.id)
    world_path = worlds_dir / file_name

    entries: dict[str, Any] = {}
    for i, stage in enumerate(world_book.entries or []):
        entries[str(i)] = {
            "key": _safe_json_loads(stage.keys, []),
            "keysecondary": _safe_json_loads(stage.secondary_keys, []),
            "content": stage.content or "",
            "comment": stage.title or "",
            "constant": bool(stage.constant),
            "selective": bool(stage.selective),
            "selectiveLogic": stage.selective_logic if isinstance(stage.selective_logic, int) else 0,
            "position": stage.position if isinstance(stage.position, int) else 4,
            "depth": stage.depth if isinstance(stage.depth, int) else 4,
            "order": stage.order if isinstance(stage.order, int) else (stage.stage_index or 0),
            "probability": stage.probability if stage.probability is not None else 100,
            "disable": not bool(stage.enabled),
            "caseSensitive": bool(stage.case_sensitive),
            "matchWholeWords": bool(stage.match_whole_words),
            "excludeRecursion": bool(stage.exclude_recursion),
            "preventRecursion": bool(stage.prevent_recursion),
            "sticky": stage.sticky if isinstance(stage.sticky, int) else 0,
            "cooldown": stage.cooldown if isinstance(stage.cooldown, int) else 0,
            "delay": stage.delay if isinstance(stage.delay, int) else 0,
            "group": stage.group or "",
            "groupOverride": bool(stage.group_override),
            "groupWeight": stage.group_weight if isinstance(stage.group_weight, int) else 0,
            "vectorized": bool(stage.vectorized),
            "addMemo": bool(stage.add_memo),
            "decorators": _safe_json_loads(stage.decorators, []),
            "extensions": _safe_json_loads(stage.extensions_json, {}),
        }

    world_data = {
        "name": world_book.name,
        "description": world_book.description or "",
        "entries": entries,
        "extensions": {},
        "recursive_scanning": False,
    }

    if not _write_json(world_path, world_data):
        return {"ok": False, "reason": "write_world_failed"}

    return {
        "ok": True,
        "world_id": world_book.id,
        "file_name": file_name,
        "entry_count": len(entries),
        "synced_at": _utc_now_iso(),
    }


# ST 中 WorldInfo 与 WorldBook 同义，提供别名保持端点调用语义一致
def sync_worldinfo_to_st(db: Session, user: User, world_book: WorldBook) -> dict[str, Any]:
    """同步 WorldInfo/世界书到 ST DATA_ROOT（sync_worldbook_to_st 的别名）。"""
    return sync_worldbook_to_st(db, user, world_book)


def sync_chat_to_st(
    db: Session,
    user: User,
    character: Character,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch] = None,
) -> dict[str, Any]:
    """同步单个聊天会话到 ST DATA_ROOT（sync_session_to_st 的别名）。

    保留 sync_session_to_st 作为规范名称，同时提供 sync_chat_to_st
    以匹配 ST sidecar 中的"chat"概念。
    """
    return sync_session_to_st(db, user, character, session, branch)


def sync_group_to_st(db: Session, user: User, group: GroupChat) -> dict[str, Any]:
    """同步群聊到 ST DATA_ROOT（stub）。

    群聊消息当前存储在 GroupChatSession.messages JSON 字段中，
    ST sidecar 通过 /api/chats/group/* 端点直接读取 DB，无需落盘 JSONL。
    此 stub 保留接口契约，未来如需落盘可在此实现。
    """
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}
    return {
        "ok": True,
        "group_id": group.id,
        "synced_at": _utc_now_iso(),
        "note": "group chat sync is a no-op; ST sidecar reads group sessions via /api/chats/group/*",
    }


def sync_persona_to_st(db: Session, user: User, persona: Persona) -> dict[str, Any]:
    """同步 Persona 到 ST DATA_ROOT（stub）。

    Persona 数据通过 /api/settings/get 和 /api/personas 端点直接从 DB 读取，
    ST sidecar 不需要独立的 persona 文件。此 stub 保留接口契约。
    """
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}
    return {
        "ok": True,
        "persona_id": persona.id,
        "synced_at": _utc_now_iso(),
        "note": "persona sync is a no-op; ST sidecar reads personas via /api/personas",
    }


def sync_all_for_user(db: Session, user: User, character_id: Optional[str] = None) -> dict[str, Any]:
    """同步用户的所有数据到 ST DATA_ROOT"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable", "synced": 0}

    query = db.query(Character).filter(Character.user_id == user.id)
    if character_id:
        query = query.filter(Character.id == character_id)
    characters = query.all()

    results = []
    for character in characters:
        result = sync_character_to_st(db, user, character)
        results.append(result)

    success_count = sum(1 for r in results if r.get("ok"))
    return {
        "ok": True,
        "total": len(characters),
        "synced": success_count,
        "failed": len(characters) - success_count,
        "details": results,
        "synced_at": _utc_now_iso(),
        "data_root": str(data_root),
    }


def get_sync_status(db: Session, user: User) -> dict[str, Any]:
    """获取同步状态"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {
            "available": False,
            "reason": "data_root_unconfigured",
        }

    characters_dir = _characters_dir(data_root)
    chats_dir = _chats_dir(data_root)
    worlds_dir = _worlds_dir(data_root)

    character_files = list(characters_dir.glob("palink-*.png.json")) if characters_dir.exists() else []
    chat_files = []
    if chats_dir.exists():
        for char_dir in chats_dir.iterdir():
            if char_dir.is_dir():
                chat_files.extend(list(char_dir.glob("palink-session-*.jsonl")))
    world_files = list(worlds_dir.glob("palink-world-*.json")) if worlds_dir.exists() else []

    db_characters = db.query(Character).filter(Character.user_id == user.id).count()
    db_sessions = (
        db.query(CharacterChatSession)
        .join(Character)
        .filter(Character.user_id == user.id)
        .count()
    )

    return {
        "available": True,
        "data_root": str(data_root),
        "st_character_files": len(character_files),
        "st_chat_files": len(chat_files),
        "st_world_files": len(world_files),
        "db_characters": db_characters,
        "db_sessions": db_sessions,
        "last_check": _utc_now_iso(),
    }


_SMART_CARD_TAG_PATTERNS = [
    re.compile(r"<GameStart\b[^>]*>[\s\S]*?</GameStart\s*>", re.IGNORECASE),
]

# 仅移除标签本身、保留内部 HTML 内容的 pattern（Palink 包裹标签）
_SMART_CARD_WRAPPER_PATTERNS = [
    re.compile(r"</?palink-html\b[^>]*>", re.IGNORECASE),
    re.compile(r"</?palink-ui\b[^>]*>", re.IGNORECASE),
    re.compile(r"</?palink-card\b[^>]*>", re.IGNORECASE),
]

_SMART_CARD_LAUNCH_LINE_PATTERNS = [
    re.compile(r"^\s*请根据以上设定开始游戏[。.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*根据以上设定开始游戏[。.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*开始游戏[。.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*请开始游戏[。.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*please\s+(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!?]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!?]*\s*$", re.IGNORECASE),
]


def clean_smart_card_markup(text: str, keep_inner_text: bool = True) -> str:
    """清理 SmartCard 渲染层标签

    处理策略：
    - ``<GameStart>`` 等场景控制标签：整块移除（keep_inner_text 时提取纯文本）
    - ``<palink-html>`` / ``<palink-ui>`` / ``<palink-card>`` 包裹标签：
      仅移除标签本身，保留内部完整 HTML 内容。ST Native iframe 能处理标准
      HTML（table/div/style 等），Palink 不应替 ST 做内容剥离。
    - ``<style>`` / ``<script>`` 不在此清理：ST Native iframe 有自己的安全过滤，
      Palink 主应用的 formatMessage 管线也会通过 DOMPurify 处理。
    """
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")

    # GameStart 等场景控制标签：整块处理
    for pattern in _SMART_CARD_TAG_PATTERNS:
        if keep_inner_text:
            value = pattern.sub(lambda m: _extract_inner_text(m.group(0)), value)
        else:
            value = pattern.sub("", value)

    # palink-html/ui/card 包裹标签：仅移除标签本身，保留内部 HTML
    for pattern in _SMART_CARD_WRAPPER_PATTERNS:
        value = pattern.sub("", value)

    lines = value.split("\n")
    kept_lines = [
        line for line in lines
        if not any(pattern.match(line) for pattern in _SMART_CARD_LAUNCH_LINE_PATTERNS)
    ]
    value = "\n".join(kept_lines)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def _extract_inner_text(tag_content: str) -> str:
    """提取标签内部的纯文本"""
    inner = re.sub(r"^<[^>]+>", "", tag_content)
    inner = re.sub(r"</[^>]+>$", "", inner)
    inner = re.sub(r"<[^>]+>", "", inner)
    return inner.strip()


def is_smart_card_message(message: CharacterChatMessage) -> bool:
    """判断消息是否为 SmartCard 产生的消息"""
    extra = _safe_json_loads(message.extra, {})
    if not isinstance(extra, dict):
        return False
    if extra.get("smart_card") or extra.get("palink_ui"):
        return True
    content = message.content or ""
    if any(pattern.search(content) for pattern in _SMART_CARD_TAG_PATTERNS):
        return True
    return bool(any(pattern.search(content) for pattern in _SMART_CARD_WRAPPER_PATTERNS))


def is_plugin_message(message: CharacterChatMessage) -> bool:
    """判断消息是否为插件产生的消息"""
    extra = _safe_json_loads(message.extra, {})
    if not isinstance(extra, dict):
        return False
    return bool(extra.get("plugin_name") or extra.get("plugin_source") or extra.get("tool_call_id"))


def clean_message_for_st_sync(content: str, message: CharacterChatMessage) -> str:
    """同步到 ST 前清理消息内容"""
    cleaned = clean_smart_card_markup(content, keep_inner_text=True)
    return cleaned


def sync_plugin_messages_to_session(
    db: Session,
    user: User,
    character: Character,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch] = None,
) -> dict[str, Any]:
    """同步插件产生的消息到 ST 会话文件"""
    data_root = _st_data_root_for_user(user)
    if not data_root:
        return {"ok": False, "reason": "data_root_unavailable"}

    if branch is None:
        branch = _active_branch(db, session)

    all_messages = _chat_messages(db, session, branch)
    plugin_messages = [m for m in all_messages if is_plugin_message(m)]

    if not plugin_messages:
        return {"ok": True, "plugin_messages": 0, "synced_at": _utc_now_iso()}

    chats_dir = _chats_dir(data_root)
    char_chat_dir = chats_dir / (character.name or "character")
    char_chat_dir.mkdir(parents=True, exist_ok=True)
    plugin_file = char_chat_dir / f"{_session_file_name(session.id)}-plugins.jsonl"

    lines: list[str] = []
    for index, message in enumerate(plugin_messages):
        record = _message_to_st_jsonl(message, index, character, user)
        extra = record.get("extra") if isinstance(record.get("extra"), dict) else {}
        extra["palink_plugin"] = True
        record["extra"] = extra
        record["mes"] = clean_message_for_st_sync(message.content or "", message)
        lines.append(_safe_json_dumps(record))

    if not _write_text(plugin_file, "\n".join(lines) + "\n"):
        return {"ok": False, "reason": "write_plugin_file_failed"}

    return {
        "ok": True,
        "plugin_messages": len(plugin_messages),
        "file": str(plugin_file),
        "synced_at": _utc_now_iso(),
    }


# ───────────────────────────────────────────────
# JSONL Import/Export (standalone, external ST file <-> DB)
# ───────────────────────────────────────────────

def _st_msg_role(item: dict[str, Any]) -> str:
    """从 ST 消息对象推断角色"""
    if item.get("is_system"):
        return "system"
    if item.get("is_user"):
        return "user"
    return "assistant"


def _st_msg_content(item: dict[str, Any]) -> str:
    """提取 ST 消息内容"""
    value = item.get("mes")
    if value is None:
        value = item.get("content") or item.get("message") or item.get("text") or ""
    return str(value)


def _st_msg_swipes(item: dict[str, Any], content: str) -> list[str]:
    """提取 swipes，兼容 V1 格式（无 swipes 字段时用 [content]）"""
    swipes = item.get("swipes")
    if isinstance(swipes, list) and swipes:
        return [str(entry or "") for entry in swipes]
    return [content]


def _st_msg_extra(item: dict[str, Any], swipes: list[str], swipe_id: int) -> dict[str, Any]:
    """构建 extra 字段，兼容 V1 格式（无 swipe_info/extra 时自动补全）"""
    extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
    extra = dict(extra)
    swipe_info = item.get("swipe_info")
    if not isinstance(swipe_info, list):
        swipe_info = [{"send_date": item.get("send_date") or "", "extra": {}} for _ in swipes]
    while len(swipe_info) < len(swipes):
        swipe_info.append({"send_date": item.get("send_date") or "", "extra": {}})
    extra["swipe_info"] = swipe_info
    for key in (
        "is_name",
        "force_avatar",
        "original_avatar",
        "avatar",
        "gen_id",
        # ST 1.18.0 top-level generation timing (script.js:6736-6737). Palink has
        # no dedicated columns; stash in extra so export can lift them back to
        # top-level, preserving round-trip fidelity.
        "gen_started",
        "gen_finished",
        "group_id",
        "group_name",
        "selected_group",
        "groups",
    ):
        if item.get(key) is not None:
            extra[key] = item.get(key)
    return extra


def _parse_st_send_date(value: str) -> Optional[datetime]:
    """尝试解析 ST send_date 字段为 datetime，失败返回 None"""
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except (ValueError, TypeError):
        return None


def import_jsonl_to_session(db: Session, character_id: str, jsonl_content: str, user_id: int) -> str:
    """从 ST 格式 JSONL 字符串导入会话到 DB

    解析 JSONL，创建新的 CharacterChatSession 和消息。
    第一行可能是 chat_metadata（无 mes 字段），后续行是消息。
    兼容 V1 格式（无 swipes 字段，自动转换为 V2）。
    跳过空行和无效 JSON 行（log 警告但不报错）。

    Returns: 新创建的 session_id
    Raises: ValueError - character/user 不存在
    """
    character = db.query(Character).filter(
        Character.id == character_id,
        Character.user_id == user_id,
    ).first()
    if not character:
        raise ValueError("Character not found")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise ValueError("User not found")

    chat_metadata: dict[str, Any] = {}
    message_items: list[dict[str, Any]] = []

    for line_num, raw_line in enumerate(jsonl_content.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("JSONL import: skipped invalid JSON at line %d", line_num)
            continue
        if not isinstance(item, dict):
            logger.warning("JSONL import: skipped non-object at line %d", line_num)
            continue
        # First line may be chat_metadata (has "chat_metadata" key and no "mes")
        if "chat_metadata" in item and "mes" not in item:
            raw_meta = item.get("chat_metadata")
            if isinstance(raw_meta, dict):
                chat_metadata = dict(raw_meta)
            elif isinstance(raw_meta, str):
                try:
                    decoded = json.loads(raw_meta)
                    if isinstance(decoded, dict):
                        chat_metadata = decoded
                except (json.JSONDecodeError, TypeError):
                    pass
            continue
        message_items.append(item)

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    title = chat_metadata.get("title") or character.name

    chat_metadata["palink_session_id"] = session_id
    chat_metadata["palink_character_id"] = character.id

    new_session = CharacterChatSession(
        id=session_id,
        character_id=character.id,
        user_id=user.id,
        title=title,
        dialogue_mode="first_person",
        chat_metadata=_safe_json_dumps(chat_metadata),
        created_at=now,
        updated_at=now,
    )
    db.add(new_session)
    db.flush()

    main_branch = CharacterChatSessionBranch(
        session_id=session_id,
        branch_name="分支 1",
        is_active=True,
        created_at=now,
        last_message_at=now,
    )
    db.add(main_branch)
    db.flush()

    for index, item in enumerate(message_items):
        content = _st_msg_content(item)
        role = _st_msg_role(item)
        swipes = _st_msg_swipes(item, content)
        try:
            swipe_id = max(0, min(int(item.get("swipe_id") or 0), len(swipes) - 1))
        except (TypeError, ValueError):
            swipe_id = 0
        if swipe_id < len(swipes):
            swipes[swipe_id] = content
        extra = _st_msg_extra(item, swipes, swipe_id)

        created_at = _parse_st_send_date(item.get("send_date") or "") or now

        mesid_raw = item.get("mesid", index)
        try:
            mesid = int(mesid_raw) if str(mesid_raw).isdigit() else index
        except (TypeError, ValueError):
            mesid = index

        msg = CharacterChatMessage(
            session_id=session_id,
            branch_id=main_branch.id,
            role=role,
            content=content,
            name=item.get("name"),
            is_user=bool(item.get("is_user")) if item.get("is_user") is not None else role == "user",
            is_system=bool(item.get("is_system")) if item.get("is_system") is not None else role == "system",
            mesid=mesid,
            swipe_id=swipe_id,
            swipes=_safe_json_dumps(swipes),
            extra=_safe_json_dumps(extra),
            created_at=created_at,
        )
        db.add(msg)

    db.commit()
    return session_id


# ───────────────────────────────────────────────
# 第三方聊天格式转换（CAI / RisuAI / TavernAI / Pygmalion → ST JSONL）
# ───────────────────────────────────────────────

def _make_st_message(
    text: str,
    is_user: bool,
    name: str = "",
    is_system: bool = False,
    send_date: str = "",
    swipes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """构建一条 ST 格式消息字典，供 import_jsonl_to_session 解析。"""
    content = str(text or "")
    swipe_list = [str(s or "") for s in swipes] if swipes else [content]
    if content and content not in swipe_list:
        swipe_list[0] = content
    return {
        "name": name or "",
        "is_user": bool(is_user),
        "is_system": bool(is_system),
        "is_name": bool(name),
        "send_date": send_date or "",
        "mes": content,
        "swipes": swipe_list,
        "swipe_id": 0,
        "swipe_info": [{"send_date": send_date or "", "extra": {}} for _ in swipe_list],
        "extra": {},
    }


def _to_iso_send_date(value: Any) -> str:
    """将时间戳（unix 秒/毫秒 或 ISO 字符串）转为 ISO 字符串，失败返回空串。"""
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)):
        try:
            ts = value / 1000 if value > 1e12 else value
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (OSError, ValueError, OverflowError):
            return ""
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
        except (ValueError, TypeError):
            return value
    return ""


def convert_cai_to_st_format(data: Any) -> list[dict[str, Any]]:
    """转换 Character.AI 聊天记录为 ST 消息数组。

    支持的输入结构：
    - {"messages": [ {...} ]} 或 {"history": {"messages": [ {...} ]}}
    - [ {...}, {...} ] 直接的消息数组

    每条消息识别字段：
    - 内容：text / message / content
    - 是否用户：is_human / src__is_human / author == "user" / src == "user"
    - 名称：name / src / src_name / character_name
    - 时间：timestamp / creation_timestamp / created_at
    """
    messages_raw: list[Any] = []
    if isinstance(data, dict):
        if isinstance(data.get("messages"), list):
            messages_raw = data["messages"]
        elif isinstance(data.get("history"), dict) and isinstance(data["history"].get("messages"), list):
            messages_raw = data["history"]["messages"]
    elif isinstance(data, list):
        messages_raw = data

    result: list[dict[str, Any]] = []
    for item in messages_raw:
        if not isinstance(item, dict):
            continue
        text = item.get("text") or item.get("message") or item.get("content") or ""
        is_human = item.get("is_human")
        if is_human is None:
            is_human = item.get("src__is_human")
        if is_human is None:
            author = str(item.get("author") or item.get("src") or "").lower()
            is_human = author == "user" or author == "human"
        name = (
            item.get("name")
            or item.get("src_name")
            or item.get("src")
            or item.get("character_name")
            or ""
        )
        send_date = _to_iso_send_date(
            item.get("timestamp") or item.get("creation_timestamp") or item.get("created_at")
        )
        if not str(text).strip() and not str(name):
            continue
        result.append(_make_st_message(str(text), bool(is_human), str(name), send_date=send_date))
    return result


def convert_risuai_to_st_format(data: Any) -> list[dict[str, Any]]:
    """转换 RisuAI 聊天记录为 ST 消息数组。

    支持的输入结构：
    - {"type": "risu", "chats": [ {"messages": [...]} ]}
    - {"chats": [ {"messages": [...]} ]}
    - {"messages": [ {...} ]}

    每条消息识别字段：
    - 内容：data / text / content
    - 角色：role ("char" / "user" / "assistant" / "system")
    - 名称：name（可选）
    - 时间：timestamp / time / createdAt
    """
    chat_groups: list[Any] = []
    if isinstance(data, dict):
        if isinstance(data.get("chats"), list):
            chat_groups = data["chats"]
        elif isinstance(data.get("messages"), list):
            chat_groups = [{"messages": data["messages"]}]
    elif isinstance(data, list):
        chat_groups = [{"messages": data}]

    result: list[dict[str, Any]] = []
    for group in chat_groups:
        if not isinstance(group, dict):
            continue
        msgs = group.get("messages")
        if not isinstance(msgs, list):
            continue
        for item in msgs:
            if not isinstance(item, dict):
                continue
            text = item.get("data") or item.get("text") or item.get("content") or ""
            role = str(item.get("role") or "").lower()
            is_user = role in ("user", "human")
            is_system = role in ("system", "narrator", "narration")
            name = item.get("name") or ""
            send_date = _to_iso_send_date(
                item.get("timestamp") or item.get("time") or item.get("createdAt")
            )
            if not str(text).strip() and not str(name):
                continue
            result.append(_make_st_message(str(text), is_user, str(name), is_system, send_date))
    return result


def convert_tavern_to_st_format(data: Any) -> list[dict[str, Any]]:
    """转换 TavernAI / Pygmalion 聊天记录为 ST 消息数组。

    支持的输入结构：
    - {"chat": [ {...} ]} 或 {"messages": [ {...} ]}
    - [ {...}, {...} ] 直接的消息数组
    - Pygmalion 纯文本格式（含 "Name:" 前缀的行块）

    每条消息识别字段：
    - 内容：mes / text / message / content
    - 是否用户：is_user（缺失则按 name 推断）
    - 名称：name / character_name
    - 时间：send_date / timestamp
    """
    result: list[dict[str, Any]] = []
    messages_raw: list[Any] = []

    if isinstance(data, dict):
        if isinstance(data.get("chat"), list):
            messages_raw = data["chat"]
        elif isinstance(data.get("messages"), list):
            messages_raw = data["messages"]
    elif isinstance(data, list):
        messages_raw = data

    for item in messages_raw:
        if not isinstance(item, dict):
            continue
        text = item.get("mes") or item.get("text") or item.get("message") or item.get("content") or ""
        is_user = item.get("is_user")
        is_system = bool(item.get("is_system"))
        name = item.get("name") or item.get("character_name") or ""
        send_date = _to_iso_send_date(item.get("send_date") or item.get("timestamp"))
        if is_user is None:
            lname = str(name).strip().lower()
            is_user = lname in ("you", "user", "me")
        if not str(text).strip() and not str(name):
            continue
        result.append(_make_st_message(str(text), bool(is_user), str(name), is_system, send_date))

    # Pygmalion 纯文本兜底：未解析出消息时尝试按 "Name:" 前缀分块
    if not result and isinstance(data, str):
        result = _convert_pygmalion_plain_text(data)
    return result


_PYGMALION_LINE_PREFIX = re.compile(r"^([A-Za-z][A-Za-z0-9_\u4e00-\u9fa5 .'\-]{0,40}):\s*(.*)$")


def _convert_pygmalion_plain_text(text: str) -> list[dict[str, Any]]:
    """解析 Pygmalion 风格纯文本对话（"Name: 内容" 行块）。"""
    result: list[dict[str, Any]] = []
    current_name = ""
    current_buf: list[str] = []

    def flush():
        nonlocal current_name, current_buf
        if not current_name and not current_buf:
            return
        body = "\n".join(current_buf).strip()
        if body:
            lname = current_name.strip().lower()
            is_user = lname in ("you", "user", "me")
            result.append(_make_st_message(body, is_user, current_name.strip()))
        current_name = ""
        current_buf = []

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\n")
        match = _PYGMALION_LINE_PREFIX.match(line)
        if match:
            flush()
            current_name = match.group(1)
            current_buf = [match.group(2)] if match.group(2) else []
        else:
            current_buf.append(line)
    flush()
    return result


def _looks_like_json(text: str) -> bool:
    """快速判断文本是否以 JSON 对象/数组开头。"""
    t = text.lstrip()
    return t[:1] in ("{", "[")


def detect_chat_format(content: str, filename: str = "") -> str:
    """检测聊天记录格式。

    返回值：'st_jsonl' / 'cai' / 'risuai' / 'tavern'
    检测顺序：文件名提示 → 单 JSON 结构特征 → JSONL/纯文本回退。
    """
    stripped = content.strip()
    name = (filename or "").lower()

    # 文件名扩展名提示（优先级最高）
    if name.endswith(".cai.json") or "character.ai" in name:
        return "cai" if _looks_like_json(stripped) else "st_jsonl"
    if "risu" in name:
        return "risuai" if _looks_like_json(stripped) else "st_jsonl"

    # 尝试整体 JSON（CAI / RisuAI / Tavern JSON）
    data: Any = None
    try:
        data = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        data = None

    if data is not None:
        if isinstance(data, dict):
            if data.get("type") in ("risu", "risuai"):
                return "risuai"
            if isinstance(data.get("chats"), list):
                return "risuai"
            msgs = data.get("messages")
            if isinstance(msgs, list) and msgs and isinstance(msgs[0], dict):
                first = msgs[0]
                if "is_human" in first or "src__is_human" in first:
                    return "cai"
                if "mes" in first or "is_user" in first:
                    return "tavern"
                if "data" in first and "role" in first:
                    return "risuai"
            if isinstance(data.get("history"), dict) and isinstance(data["history"].get("messages"), list):
                return "cai"
            if isinstance(data.get("chat"), list):
                return "tavern"
        elif isinstance(data, list) and data and isinstance(data[0], dict):
            first = data[0]
            if "is_human" in first or "src__is_human" in first:
                return "cai"
            if "mes" in first or "is_user" in first:
                return "tavern"
            if "data" in first and "role" in first:
                return "risuai"

    # Pygmalion 纯文本（非 JSON 且首行匹配 "Name:" 前缀）
    if data is None and stripped:
        first_line = stripped.splitlines()[0]
        if _PYGMALION_LINE_PREFIX.match(first_line):
            return "tavern"

    # 默认按 ST JSONL 处理（import_jsonl_to_session 会逐行解析）
    return "st_jsonl"


def convert_to_st_messages(data: Any, fmt: str) -> list[dict[str, Any]]:
    """按指定格式调用对应转换器，返回 ST 消息数组。"""
    if fmt == "cai":
        return convert_cai_to_st_format(data)
    if fmt == "risuai":
        return convert_risuai_to_st_format(data)
    if fmt == "tavern":
        return convert_tavern_to_st_format(data)
    # st_jsonl / 未知：若传入为列表则按 ST 消息处理，否则返回空
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def import_chat_to_session(
    db: Session,
    character_id: str,
    content: str,
    user_id: int,
    filename: str = "",
    format_hint: str = "",
) -> str:
    """通用聊天记录导入：自动检测格式 → 转换为 ST JSONL → 复用现有导入逻辑。

    format_hint: 可选，显式指定格式（'cai'/'risuai'/'tavern'/'st_jsonl'），
                 提供时覆盖自动检测。
    Returns: 新创建的 session_id
    Raises: ValueError - character/user 不存在或格式不支持
    """
    fmt = format_hint if format_hint else detect_chat_format(content, filename)
    if fmt == "st_jsonl":
        # 原生 ST JSONL 直接走现有导入路径
        return import_jsonl_to_session(db, character_id, content, user_id)

    # 第三方格式：解析为 JSON 再转换
    try:
        data: Any = json.loads(content.strip())
    except (json.JSONDecodeError, ValueError) as exc:
        # Pygmalion 纯文本兜底（data 为原始字符串）
        if fmt == "tavern":
            data = content
        else:
            raise ValueError(f"Failed to parse chat file as JSON: {exc}")

    st_messages = convert_to_st_messages(data, fmt)
    if not st_messages:
        raise ValueError(f"No messages converted from format '{fmt}'")

    # 序列化为 ST JSONL（首行 header + 消息行），复用现有导入逻辑
    header = {
        "user_name": "",
        "character_name": "",
        "create_date": _utc_now_iso(),
        "chat_metadata": {
            "palink_import_format": fmt,
            "palink_character_id": character_id,
        },
    }
    lines: list[str] = [_safe_json_dumps(header)]
    for index, msg in enumerate(st_messages):
        msg.setdefault("mesid", index)
        lines.append(_safe_json_dumps(msg))

    return import_jsonl_to_session(db, character_id, "\n".join(lines) + "\n", user_id)



def export_session_to_jsonl(db: Session, session_id: str) -> str:
    """导出会话为 ST 格式 JSONL 字符串

    第一行 chat_metadata（含 palink_session_id 等），后续行消息。
    Raises: ValueError - session/character/user 不存在
    """
    session = db.query(CharacterChatSession).filter(
        CharacterChatSession.id == session_id,
    ).first()
    if not session:
        raise ValueError("Session not found")

    character = db.query(Character).filter(Character.id == session.character_id).first()
    if not character:
        raise ValueError("Character not found")

    user = db.query(User).filter(User.id == session.user_id).first()
    if not user:
        raise ValueError("User not found")

    branch = _active_branch(db, session)
    messages = _chat_messages(db, session, branch)

    # Merge persisted chat_metadata with Palink-internal routing fields
    metadata: dict[str, Any] = {}
    raw_metadata = getattr(session, "chat_metadata", None)
    if raw_metadata:
        if isinstance(raw_metadata, dict):
            metadata = dict(raw_metadata)
        elif isinstance(raw_metadata, str):
            try:
                decoded = json.loads(raw_metadata)
                if isinstance(decoded, dict):
                    metadata = decoded
            except (json.JSONDecodeError, TypeError):
                metadata = {}
    metadata["palink_session_id"] = session.id
    metadata["palink_character_id"] = character.id
    metadata["palink_branch_id"] = branch.id if branch else None

    header = {
        "user_name": user.username or "User",
        "character_name": character.name,
        "create_date": (session.created_at or datetime.now(timezone.utc)).isoformat(),
        "chat_metadata": metadata,
    }

    lines: list[str] = [_safe_json_dumps(header)]
    for index, message in enumerate(messages):
        lines.append(_safe_json_dumps(_message_to_st_jsonl(message, index, character, user)))

    return "\n".join(lines) + "\n"


# ───────────────────────────────────────────────
# Group Chat JSONL Conversion (ST <-> Palink)
# ───────────────────────────────────────────────

def _build_group_message_extra(msg: dict[str, Any]) -> dict[str, Any]:
    """构建群聊消息的 extra 字段，保留群聊特有字段。

    群聊特有字段：is_name, type, force_avatar。
    同时保留原始 extra 中的所有字段（含 variables 等），确保 round-trip 不丢数据。
    """
    raw_extra = msg.get("extra")
    extra = dict(raw_extra) if isinstance(raw_extra, dict) else {}
    # 群聊特有字段：从消息顶层提取并写入 extra（ST 群聊消息约定）
    if "is_name" in msg and "is_name" not in extra:
        extra["is_name"] = msg["is_name"]
    elif "is_name" not in extra:
        extra["is_name"] = bool(msg.get("name"))
    if "type" in msg and "type" not in extra:
        extra["type"] = msg["type"]
    if "force_avatar" in msg and "force_avatar" not in extra:
        extra["force_avatar"] = msg["force_avatar"]
    return extra


def convert_group_chat_to_jsonl(messages: list) -> str:
    """将群聊消息列表转换为 ST JSONL 格式字符串。

    每行是一个 JSON 对象，包含：name, is_user, is_system, send_date, mes, extra。
    群聊特有：extra.is_name, extra.type, extra.force_avatar。

    保留 chat_metadata 和 variables：
    - 若消息 extra 中含 variables，原样保留在 extra 中
    - 若消息含 swipes/swipe_id/swipe_info 等字段，原样输出以支持 round-trip

    Args:
        messages: 群聊消息字典列表（Palink GroupChatSession.messages 反序列化后的列表）

    Returns:
        JSONL 字符串（每行一个 JSON 对象，末尾换行）；空列表返回空字符串
    """
    if not isinstance(messages, list):
        return ""
    lines: list[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        record: dict[str, Any] = {
            "name": str(msg.get("name") or ""),
            "is_user": bool(msg.get("is_user", False)),
            "is_system": bool(msg.get("is_system", False)),
            "send_date": str(msg.get("send_date") or ""),
            "mes": str(msg.get("mes") or ""),
            "extra": _build_group_message_extra(msg),
        }
        # 保留 round-trip 所需的扩展字段
        for key in ("swipes", "swipe_id", "swipe_info", "mesid", "id", "is_hidden", "is_locked"):
            if key in msg:
                record[key] = msg[key]
        lines.append(_safe_json_dumps(record))
    return "\n".join(lines) + "\n" if lines else ""


def convert_jsonl_to_group_chat(jsonl_content: str) -> list:
    """将 ST JSONL 字符串转换为 Palink 群聊消息列表。

    解析 JSONL，每行一个 JSON 对象。第一行可能是 chat_metadata header
    （含 chat_metadata 字段且无 mes 字段），会被跳过（群聊元数据应存储在
    GroupChat.chat_metadata 字段，不在消息列表中）。

    保留 chat_metadata 和 variables：
    - chat_metadata header 行被跳过（由调用方单独处理）
    - 消息中的 extra.variables 等字段原样保留在消息对象中

    跳过空行和无效 JSON 行（log 警告但不报错）。

    Args:
        jsonl_content: ST JSONL 格式字符串

    Returns:
        Palink 消息字典列表（每项含 name, is_user, is_system, send_date, mes, extra 等）
    """
    if not jsonl_content:
        return []
    messages: list[dict[str, Any]] = []
    for line_num, raw_line in enumerate(jsonl_content.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("Group JSONL import: skipped invalid JSON at line %d", line_num)
            continue
        if not isinstance(item, dict):
            logger.warning("Group JSONL import: skipped non-object at line %d", line_num)
            continue
        # 跳过 chat_metadata header 行（无 mes 字段但含 chat_metadata）
        if "mes" not in item and "chat_metadata" in item:
            continue
        messages.append(item)
    return messages


# ───────────────────────────────────────────────
# 异步包装（避免阻塞 FastAPI 事件循环）
# ───────────────────────────────────────────────

async def async_sync_character_to_st(db: Session, user: User, character: Character) -> dict[str, Any]:
    """sync_character_to_st 的异步包装，在线程池执行避免阻塞事件循环。

    注意：调用方需确保 db session 的线程安全，建议在 to_thread 内部
    使用独立 session（通过 sessionmaker 创建），而非共享主请求 session。
    """
    import asyncio
    return await asyncio.to_thread(sync_character_to_st, db, user, character)


async def async_sync_session_to_st(
    db: Session,
    user: User,
    character: Character,
    session: CharacterChatSession,
    branch: Optional[CharacterChatSessionBranch] = None,
) -> dict[str, Any]:
    """sync_session_to_st 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(sync_session_to_st, db, user, character, session, branch)


async def async_sync_worldbook_to_st(db: Session, user: User, world_book: WorldBook) -> dict[str, Any]:
    """sync_worldbook_to_st 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(sync_worldbook_to_st, db, user, world_book)


async def async_sync_all_for_user(
    db: Session,
    user: User,
    character_id: Optional[str] = None,
) -> dict[str, Any]:
    """sync_all_for_user 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(sync_all_for_user, db, user, character_id)


async def async_sync_group_to_st(db: Session, user: User, group: GroupChat) -> dict[str, Any]:
    """sync_group_to_st 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(sync_group_to_st, db, user, group)


async def async_sync_persona_to_st(db: Session, user: User, persona: Persona) -> dict[str, Any]:
    """sync_persona_to_st 的异步包装。"""
    import asyncio
    return await asyncio.to_thread(sync_persona_to_st, db, user, persona)


def trigger_sync_background(
    db_factory,
    user_id: int,
    sync_type: str,
    character_id: Optional[str] = None,
    session_id: Optional[str] = None,
    world_book_id: Optional[str] = None,
) -> None:
    """在后台触发同步任务（非阻塞）。

    用法：在写操作端点的 db.commit() 后调用此函数，
    它会创建独立 db session 并在线程池中执行同步。

    Args:
        db_factory: SQLAlchemy sessionmaker（用于创建独立 session）
        user_id: 用户 ID
        sync_type: 同步类型 ("character" / "session" / "worldbook" / "all")
        character_id: 角色 ID（sync_type=character/session/all 时使用）
        session_id: 会话 ID（sync_type=session 时使用）
        world_book_id: 世界书 ID（sync_type=worldbook 时使用）
    """
    import threading

    def _worker():
        try:
            db = db_factory()
            try:
                from ..models import User
                user = db.query(User).filter(User.id == user_id).first()
                if not user:
                    logger.warning("trigger_sync_background: user %s not found", user_id)
                    return

                if sync_type == "character" and character_id:
                    character = db.query(Character).filter(Character.id == character_id).first()
                    if character:
                        sync_character_to_st(db, user, character)
                elif sync_type == "session" and character_id and session_id:
                    character = db.query(Character).filter(Character.id == character_id).first()
                    session = db.query(CharacterChatSession).filter(CharacterChatSession.id == session_id).first()
                    if character and session:
                        sync_session_to_st(db, user, character, session)
                elif sync_type == "worldbook" and world_book_id:
                    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id).first()
                    if wb:
                        sync_worldbook_to_st(db, user, wb)
                elif sync_type == "all":
                    sync_all_for_user(db, user, character_id)
            finally:
                db.close()
        except Exception as e:
            logger.warning("trigger_sync_background failed: %s (type=%s, char=%s, session=%s, wb=%s)",
                           e, sync_type, character_id, session_id, world_book_id)

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()


# 后台异步任务引用集合，防止 asyncio.create_task 创建的任务被 GC 回收
_background_sync_tasks: set = set()


async def trigger_async_sync(
    db_factory,
    user_id: int,
    sync_type: str,
    character_id: Optional[str] = None,
    session_id: Optional[str] = None,
    world_book_id: Optional[str] = None,
    group_id: Optional[str] = None,
    persona_id: Optional[str] = None,
) -> None:
    """在后台异步触发同步任务（非阻塞）。

    使用 asyncio.create_task 创建后台任务，适用于 FastAPI 异步端点。
    失败时记录日志但不影响主请求。

    与 trigger_sync_background（threading 版本）的区别：
    - 本函数在事件循环中执行，与 FastAPI 异步端点更协调
    - 内部调用 async_sync_*_to_st，文件 I/O 仍通过 asyncio.to_thread 卸载到线程池

    Args:
        db_factory: SQLAlchemy sessionmaker（用于创建独立 session）
        user_id: 用户 ID
        sync_type: 同步类型 ("character" / "session" / "worldbook" / "group" / "persona" / "all")
        character_id: 角色 ID
        session_id: 会话 ID
        world_book_id: 世界书 ID
        group_id: 群聊 ID
        persona_id: Persona ID
    """
    import asyncio

    async def _worker():
        try:
            db = db_factory()
            try:
                user = db.query(User).filter(User.id == user_id).first()
                if not user:
                    logger.warning("trigger_async_sync: user %s not found", user_id)
                    return

                if sync_type == "character" and character_id:
                    character = db.query(Character).filter(Character.id == character_id).first()
                    if character:
                        await async_sync_character_to_st(db, user, character)
                elif sync_type == "session" and character_id and session_id:
                    character = db.query(Character).filter(Character.id == character_id).first()
                    session = db.query(CharacterChatSession).filter(CharacterChatSession.id == session_id).first()
                    if character and session:
                        await async_sync_session_to_st(db, user, character, session)
                elif sync_type == "worldbook" and world_book_id:
                    wb = db.query(WorldBook).filter(WorldBook.id == world_book_id).first()
                    if wb:
                        await async_sync_worldbook_to_st(db, user, wb)
                elif sync_type == "group" and group_id:
                    group = db.query(GroupChat).filter(GroupChat.id == group_id).first()
                    if group:
                        await async_sync_group_to_st(db, user, group)
                elif sync_type == "persona" and persona_id:
                    persona = db.query(Persona).filter(Persona.id == persona_id).first()
                    if persona:
                        await async_sync_persona_to_st(db, user, persona)
                elif sync_type == "all":
                    await async_sync_all_for_user(db, user, character_id)
            finally:
                db.close()
        except Exception as e:
            logger.warning(
                "trigger_async_sync failed: %s (type=%s, char=%s, session=%s, wb=%s, group=%s, persona=%s)",
                e, sync_type, character_id, session_id, world_book_id, group_id, persona_id,
            )

    try:
        task = asyncio.create_task(_worker())
        _background_sync_tasks.add(task)
        task.add_done_callback(_background_sync_tasks.discard)
    except RuntimeError:
        # 无运行中的事件循环，回退到 threading 版本
        trigger_sync_background(
            db_factory, user_id, sync_type,
            character_id=character_id,
            session_id=session_id,
            world_book_id=world_book_id,
        )
