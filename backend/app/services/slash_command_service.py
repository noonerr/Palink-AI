"""Slash Command Runtime Service (Phase 4).

Lightweight backend implementation of SillyTavern-style slash commands.
Only implements core commands that affect prompt assembly or session state.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session as DBSession

from ..models.character import (
    Character,
    CharacterChatSession,
    CharacterChatMessage,
    CharacterChatSessionBranch,
)
from ..models.worldbook import WorldBook, WorldBookStage
from ..models.chat_variable import ChatVariable, UserVariable, GlobalVariable
from ..services.macro_service import MacroEnv

logger = logging.getLogger(__name__)

SlashCommandHandler = Callable[[list[str], "SlashCommandContext"], "SlashCommandResult"]


@dataclass
class SlashCommandResult:
    send_to_chat: bool = True
    system_message: Optional[str] = None
    response: Optional[str] = None
    modified: bool = False
    extra_messages: list[dict[str, Any]] = field(default_factory=list)
    # P0-3 修复: /gen 命令专用 — 当 gen_prompt 非空时，调用方（websocket/
    # character_ext）应使用此 prompt 调用 LLM 生成，结果作为 slash_response
    # 返回给前端。不写入 chat history，对齐 ST /gen 语义（slash-commands.js:2210）。
    gen_prompt: Optional[str] = None
    # P1-16 修复: /impersonate 命令专用 — 标记生成的文本应作为用户消息
    # 而非 AI 消息返回（对齐 ST slash-commands.js:1945）。调用方检测此标记后，
    # 可把生成文本作为用户消息插入输入框（ST 行为）或直接发送。
    is_impersonate: bool = False
    # P2-8 修复: /continue 命令专用 — 标记触发续写而非新轮生成（对齐 ST
    # slash-commands.js:1845）。调用方检测此标记后，应调用 continue 生成
    # 路径（追加到最后一条 AI 消息），而非创建新 AI 消息。
    is_continue: bool = False
    # P2-8 修复: /continue <prompt> 的可选 prompt 参数（对齐 ST slash-commands.js:1845）。
    # 非空时，调用方应在续写前把此 prompt 追加到最后一条 AI 消息内容末尾，
    # 使生成从此 prompt 之后继续。
    continue_prompt: Optional[str] = None


@dataclass
class SlashCommandContext:
    db: DBSession
    session_id: str
    user_id: int
    user_name: str
    character: Optional[Character]
    session: Optional[CharacterChatSession]
    input_text: str = ""


class SlashCommandRegistry:
    _commands: dict[str, SlashCommandHandler] = {}

    @classmethod
    def register(cls, name: str, handler: SlashCommandHandler) -> None:
        cls._commands[name.lower()] = handler

    @classmethod
    def get(cls, name: str) -> Optional[SlashCommandHandler]:
        return cls._commands.get(name.lower())

    @classmethod
    def list_commands(cls) -> list[str]:
        return sorted(cls._commands.keys())


def _parse_command(text: str) -> tuple[str, list[str]]:
    if not text.startswith("/"):
        return "", []
    parts = text[1:].strip().split()
    if not parts:
        return "", []
    cmd = parts[0].lower()
    args: list[str] = []
    current = ""
    in_quote = False
    for part in parts[1:]:
        if part.startswith('"') and not in_quote:
            if part.endswith('"') and len(part) > 1:
                args.append(part[1:-1])
            else:
                current = part[1:]
                in_quote = True
        elif in_quote:
            if part.endswith('"'):
                current += " " + part[:-1]
                args.append(current)
                current = ""
                in_quote = False
            else:
                current += " " + part
        else:
            args.append(part)
    if in_quote and current:
        args.append(current)
    return cmd, args


# ========== Core command implementations ==========

def _cmd_sys(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /sys <message>")
    content = " ".join(args)
    return SlashCommandResult(
        send_to_chat=False,
        system_message=content,
        response=f"[System message added]",
    )


def _cmd_note(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /note <text>")
    content = " ".join(args)
    # Author note is stored in session chat_metadata (per-chat JSON dict)
    if ctx.session:
        try:
            ext = json.loads(ctx.session.chat_metadata) if ctx.session.chat_metadata else {}
        except (json.JSONDecodeError, TypeError):
            ext = {}
        ext["author_note"] = content
        ctx.session.chat_metadata = json.dumps(ext, ensure_ascii=False)
        ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False,
        response=f"[Author note set]",
        modified=True,
    )


def _set_note_field(args: list[str], ctx: SlashCommandContext, field: str, label: str) -> SlashCommandResult:
    """Phase G: 存储 /note 子命令参数到 session.chat_metadata (per-chat JSON)，对齐 ST。"""
    if not args:
        return SlashCommandResult(send_to_chat=False, response=f"Usage: /{label} <value>")
    try:
        value = int(args[0])
    except (ValueError, TypeError):
        return SlashCommandResult(send_to_chat=False, response=f"[Invalid value: {args[0]}, must be integer]")
    if ctx.session:
        try:
            ext = json.loads(ctx.session.chat_metadata) if ctx.session.chat_metadata else {}
        except (json.JSONDecodeError, TypeError):
            ext = {}
        ext[field] = value
        ctx.session.chat_metadata = json.dumps(ext, ensure_ascii=False)
        ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False,
        response=f"[{label} set to {value}]",
        modified=True,
    )


def _cmd_note_position(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    """ST 1.18.0 /note-position — accepts string aliases (authors-note.js
    setNotePositionCommand) or integers.

    ST extension_prompt_types:
        -1 = NONE           (aliases: none, inactive)
         0 = IN_PROMPT      (aliases: after, scenario)
         1 = IN_CHAT        (aliases: chat)
         2 = BEFORE_PROMPT  (aliases: before, before_scenario)
    """
    if not args:
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /note-position <after|chat|before|none|-1|0|1|2>",
        )
    raw = args[0].strip().lower()
    # ST string aliases (authors-note.js validPositions + none/inactive for NONE)
    st_aliases = {
        "after": 0,
        "scenario": 0,
        "chat": 1,
        "before": 2,
        "before_scenario": 2,
        "none": -1,
        "inactive": -1,
    }
    labels = {-1: "NONE", 0: "IN_PROMPT (after)", 1: "IN_CHAT (chat/depth)", 2: "BEFORE_PROMPT (before)"}
    if raw in st_aliases:
        value = st_aliases[raw]
    else:
        try:
            value = int(raw)
        except (ValueError, TypeError):
            return SlashCommandResult(
                send_to_chat=False,
                response=f"[Invalid position: {args[0]}. Use after/chat/before/none or -1/0/1/2]",
            )
        if value not in (-1, 0, 1, 2):
            return SlashCommandResult(
                send_to_chat=False,
                response=f"[Invalid position: {value}. Must be -1 (none), 0 (after), 1 (chat/depth), or 2 (before)]",
            )
    if ctx.session:
        try:
            ext = json.loads(ctx.session.chat_metadata) if ctx.session.chat_metadata else {}
        except (json.JSONDecodeError, TypeError):
            ext = {}
        ext["author_note_position"] = value
        ctx.session.chat_metadata = json.dumps(ext, ensure_ascii=False)
        ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False,
        response=f"[note-position set to {value} ({labels[value]})]",
        modified=True,
    )


def _cmd_note_depth(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    return _set_note_field(args, ctx, "author_note_depth", "note-depth")


def _cmd_note_frequency(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    return _set_note_field(args, ctx, "author_note_frequency", "note-frequency")


def _cmd_name(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /name <new_name>")
    new_name = args[0]
    if ctx.character:
        ctx.character.name = new_name
        ctx.db.commit()
        return SlashCommandResult(
            send_to_chat=False,
            response=f"[Character name set to {new_name}]",
            modified=True,
        )
    return SlashCommandResult(send_to_chat=False, response="No character found.")


def _cmd_persona(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /persona <description>")
    desc = " ".join(args)
    if ctx.character:
        ctx.character.personality = desc
        ctx.db.commit()
        return SlashCommandResult(
            send_to_chat=False,
            response="[Character personality updated]",
            modified=True,
        )
    return SlashCommandResult(send_to_chat=False, response="No character found.")


def _cmd_impersonate(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    # P1-16 修复: /impersonate 应以 AI 视角生成用户回复（对齐 ST slash-commands.js:1945）
    # 之前错误地把消息作为 extra_messages 写入用户消息并触发生成（send_to_chat=True），
    # 这等同于 /send 行为而非 impersonate。
    # 正确语义: 以当前角色身份生成一段"用户可能说的话"，作为 AI 生成内容返回，
    # 不写入 chat history，结果通过 slash_response 返回给前端，
    # 前端可作为用户消息插入输入框（ST 行为）或直接发送。
    # 由于 SlashCommandResult 不支持直接调用 LLM，这里设置 gen_prompt，
    # 调用方（websocket/character_ext）检测后调用 LLM 生成，
    # 但需要标记 is_impersonate 让调用方知道以用户视角生成。
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /impersonate <message>")
    content = " ".join(args)
    # 构造 impersonate 提示词: 让 LLM 以用户视角回复
    # 参考 ST 1.18.0 slash-commands.js:1980 - impersonate 调用 generateQuietPrompt
    # with instructed names, 以 user 角色生成
    impersonate_prompt = (
        f"[System: You are now impersonating the user. "
        f"Write a reply as the user would, based on the context.]\n\n"
        f"Context: {content}\n\n"
        f"Write the user's reply:"
    )
    return SlashCommandResult(
        send_to_chat=False,
        gen_prompt=impersonate_prompt,
        is_impersonate=True,
        response=None,
    )


def _cmd_trigger(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    # P1-15 新增: /trigger 命令（对齐 ST slash-commands.js:2700）
    # 语义: 触发指定的世界书条目或扩展事件，不写入 chat history。
    # 用法:
    #   /trigger <entry_name>        - 触发指定名称的世界书条目
    #   /trigger list                - 列出当前会话可触发的条目
    #   /trigger <extension_name> <event_name> - 触发扩展事件（未来扩展）
    # 当前实现: 支持世界书条目触发（写入 chat_metadata.triggered_entries），
    # 调用方装配时会读取此标记强制激活对应条目。
    if not args:
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /trigger <entry_name> | /trigger list",
        )
    sub_cmd = args[0].lower()
    if sub_cmd == "list":
        # 列出当前会话角色关联的世界书条目名称
        try:
            from ..models.worldbook import WorldBook, WorldBookEntry
            char = ctx.character
            if not char:
                return SlashCommandResult(
                    send_to_chat=False,
                    response="No character bound to session.",
                )
            wb = ctx.db.query(WorldBook).filter(
                WorldBook.character_id == char.id
            ).first()
            if not wb:
                return SlashCommandResult(
                    send_to_chat=False,
                    response="No worldbook bound to character.",
                )
            entries = ctx.db.query(WorldBookEntry).filter(
                WorldBookEntry.worldbook_id == wb.id
            ).all()
            names = [e.name or e.comment or f"#{e.id}" for e in entries]
            return SlashCommandResult(
                send_to_chat=False,
                response="Triggerable entries:\n" + "\n".join(names) if names else "No entries.",
            )
        except Exception as exc:
            return SlashCommandResult(
                send_to_chat=False,
                response=f"List failed: {exc}",
            )
    # 触发指定条目: 记录到 chat_metadata，由装配路径读取
    entry_name = " ".join(args)
    try:
        from ..models.worldbook import WorldBook, WorldBookEntry
        char = ctx.character
        if not char:
            return SlashCommandResult(
                send_to_chat=False,
                response="No character bound to session.",
            )
        wb = ctx.db.query(WorldBook).filter(
            WorldBook.character_id == char.id
        ).first()
        if not wb:
            return SlashCommandResult(
                send_to_chat=False,
                response="No worldbook bound to character.",
            )
        entry = ctx.db.query(WorldBookEntry).filter(
            WorldBookEntry.worldbook_id == wb.id,
            (WorldBookEntry.name == entry_name) | (WorldBookEntry.comment == entry_name),
        ).first()
        if not entry:
            return SlashCommandResult(
                send_to_chat=False,
                response=f"Entry not found: {entry_name}",
            )
        # 记录触发标记到 chat_metadata（由装配路径强制激活）
        # 使用 session 的 chat_metadata JSON 字段
        import json as _json
        meta_raw = getattr(ctx.session, "chat_metadata", None) or "{}"
        try:
            meta = _json.loads(meta_raw) if isinstance(meta_raw, str) else dict(meta_raw)
        except Exception:
            meta = {}
        triggered = meta.setdefault("palink_triggered_entries", [])
        if entry.id not in triggered:
            triggered.append(entry.id)
        meta["palink_triggered_entries"] = triggered
        # 持久化到 session
        try:
            ctx.session.chat_metadata = _json.dumps(meta)
            ctx.db.commit()
        except Exception:
            ctx.db.rollback()
        return SlashCommandResult(
            send_to_chat=False,
            response=f"[Triggered: {entry_name}]",
            modified=True,
        )
    except Exception as exc:
        return SlashCommandResult(
            send_to_chat=False,
            response=f"Trigger failed: {exc}",
        )


def _cmd_setvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if len(args) < 2:
        return SlashCommandResult(send_to_chat=False, response="Usage: /setvar <key> <value>")
    key, value = args[0], " ".join(args[1:])
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
        user_name=ctx.user_name,
        char_name=ctx.character.name if ctx.character else "Character",
    )
    macro_env._set_chat_var(key, value)
    ctx.db.commit()
    return SlashCommandResult(send_to_chat=False, response=f"Set chat variable: {key}={value}", modified=True)


def _cmd_getvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /getvar <key>")
    key = args[0]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
        user_name=ctx.user_name,
        char_name=ctx.character.name if ctx.character else "Character",
    )
    value = macro_env._get_chat_var(key)
    if value is None:
        value = macro_env._get_user_var(key)
    if value is None:
        value = macro_env._get_global_var(key)
    return SlashCommandResult(
        send_to_chat=False,
        response=f"{key}={value if value is not None else '<unset>'}",
    )


def _cmd_incvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /incvar <key>")
    key = args[0]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
    )
    try:
        current = 0
        val = macro_env._get_chat_var(key)
        if val is not None:
            current = float(val)
        new_val = int(current + 1)
        macro_env._set_chat_var(key, str(new_val))
        ctx.db.commit()
        return SlashCommandResult(send_to_chat=False, response=f"Incremented {key}={new_val}", modified=True)
    except (ValueError, TypeError):
        return SlashCommandResult(send_to_chat=False, response=f"Invalid value for {key}")


def _cmd_decvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /decvar <key>")
    key = args[0]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
    )
    try:
        current = 0
        val = macro_env._get_chat_var(key)
        if val is not None:
            current = float(val)
        new_val = int(current - 1)
        macro_env._set_chat_var(key, str(new_val))
        ctx.db.commit()
        return SlashCommandResult(send_to_chat=False, response=f"Decremented {key}={new_val}", modified=True)
    except (ValueError, TypeError):
        return SlashCommandResult(send_to_chat=False, response=f"Invalid value for {key}")


def _cmd_addvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if len(args) < 2:
        return SlashCommandResult(send_to_chat=False, response="Usage: /addvar <key> <delta>")
    key, delta_str = args[0], args[1]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
    )
    try:
        current = 0
        val = macro_env._get_chat_var(key)
        if val is not None:
            current = float(val)
        delta = float(delta_str)
        new_val = current + delta
        macro_env._set_chat_var(key, str(int(new_val) if new_val == int(new_val) else new_val))
        ctx.db.commit()
        return SlashCommandResult(send_to_chat=False, response=f"Added {delta} to {key}={new_val}", modified=True)
    except (ValueError, TypeError):
        return SlashCommandResult(send_to_chat=False, response=f"Invalid number for {key} or {delta_str}")


def _cmd_wi(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if len(args) < 2:
        return SlashCommandResult(send_to_chat=False, response="Usage: /wi <keyword> <content>")
    keyword = args[0]
    content = " ".join(args[1:])
    if not ctx.character:
        return SlashCommandResult(send_to_chat=False, response="No character found.")
    wb = (
        ctx.db.query(WorldBook)
        .filter(WorldBook.character_id == ctx.character.id)
        .first()
    )
    if not wb:
        wb = WorldBook(
            title=f"{ctx.character.name}'s World Book",
            character_id=ctx.character.id,
            user_id=ctx.user_id,
        )
        ctx.db.add(wb)
        ctx.db.flush()
    stage = WorldBookStage(
        world_book_id=wb.id,
        title=keyword,
        content=content,
        keys=json.dumps([keyword]),
        constant=False,
        enabled=True,
    )
    ctx.db.add(stage)
    ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False,
        response=f"[World Info entry added: {keyword}]",
        modified=True,
    )


def _cmd_world(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /world <description>")
    desc = " ".join(args)
    if ctx.character:
        ctx.character.scenario = desc
        ctx.db.commit()
        return SlashCommandResult(
            send_to_chat=False,
            response="[Scenario/world description updated]",
            modified=True,
        )
    return SlashCommandResult(send_to_chat=False, response="No character found.")


def _cmd_help(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    commands = SlashCommandRegistry.list_commands()
    return SlashCommandResult(
        send_to_chat=False,
        response="Available commands: " + ", ".join(f"/{c}" for c in commands),
    )


# ========== Helper functions ==========

def _get_active_branch(db: DBSession, session_id: str) -> Optional[CharacterChatSessionBranch]:
    """Return the active branch for a session, falling back to the most recent one."""
    branch = (
        db.query(CharacterChatSessionBranch)
        .filter(
            CharacterChatSessionBranch.session_id == session_id,
            CharacterChatSessionBranch.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not branch:
        branch = (
            db.query(CharacterChatSessionBranch)
            .filter(CharacterChatSessionBranch.session_id == session_id)
            .order_by(CharacterChatSessionBranch.created_at.desc())
            .first()
        )
    return branch


def _get_last_ai_message(
    db: DBSession, session_id: str, branch_id: Optional[str]
) -> Optional[CharacterChatMessage]:
    query = db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session_id,
        CharacterChatMessage.is_user == False,  # noqa: E712
    )
    if branch_id:
        query = query.filter(CharacterChatMessage.branch_id == branch_id)
    return query.order_by(CharacterChatMessage.id.desc()).first()


def _read_chat_metadata(session: Optional[CharacterChatSession]) -> dict:
    if not session or not session.chat_metadata:
        return {}
    try:
        meta = json.loads(session.chat_metadata)
        return meta if isinstance(meta, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _write_chat_metadata(session: Optional[CharacterChatSession], meta: dict) -> None:
    if session:
        session.chat_metadata = json.dumps(meta, ensure_ascii=False)


# ========== Chat flow commands ==========

def _cmd_send(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    # P0-2 修复: /send 仅写入用户消息，不触发 AI 生成（对齐 ST slash-commands.js:1731）。
    # 之前返回 send_to_chat=True 导致上游 websocket.py:1466 错误触发 _gen 生成，
    # 并且会把 "/send xxx" 整条命令文本作为用户消息重复保存。
    # 修复后通过 extra_messages 返回消息内容，调用方保存后跳过生成。
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /send <message>")
    content = " ".join(args)
    branch = _get_active_branch(ctx.db, ctx.session_id)
    msg = CharacterChatMessage(
        session_id=ctx.session_id,
        branch_id=branch.id if branch else None,
        role="user",
        content=content,
        is_user=True,
        is_system=False,
    )
    ctx.db.add(msg)
    ctx.db.commit()
    # send_to_chat=False: 不触发 AI 生成；extra_messages 告知调用方消息已落库
    # （调用方不会再重复保存 extra_messages，因为 _cmd_send 已自行 commit；
    # extra_messages 仅用于广播 new_message 事件到前端）
    return SlashCommandResult(
        send_to_chat=False,
        response=None,
        extra_messages=[{"role": "user", "content": content, "_already_persisted": True}],
    )


def _cmd_gen(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    # P0-3 修复: /gen 真实生成 — 解析 prompt 参数，设置 gen_prompt 让调用方
    # 调用 LLM 生成，结果作为 slash_response 返回（不写入 chat history）。
    # 对齐 ST slash-commands.js:2210: /gen [named args] <prompt>
    # 支持的 named args（对齐 ST）:
    #   as=character|user|neutral  (默认 neutral，对 Palink 后端不影响，仅前端展示)
    #   length=short|medium|long   (默认继承当前会话)
    #   mode=raw|quiet             (默认 quiet，raw 表示不装配 chat history)
    if not args:
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /gen [as=character|user|neutral] [length=...] <prompt>",
        )
    # 解析 named args（key=value 形式）
    named_args: dict[str, str] = {}
    positional: list[str] = []
    for arg in args:
        if "=" in arg and not arg.startswith('"'):
            key, _, value = arg.partition("=")
            if key and value and key.replace("-", "_").isidentifier():
                named_args[key.lower()] = value
                continue
        positional.append(arg)
    if not positional:
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /gen <prompt>",
        )
    prompt = " ".join(positional).strip()
    if not prompt:
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /gen <prompt>",
        )
    # gen_prompt 非空 + send_to_chat=False: 调用方检测到后用此 prompt 调用 LLM
    # 生成（不装配 chat history），结果作为 slash_response 返回。
    return SlashCommandResult(
        send_to_chat=False,
        gen_prompt=prompt,
        response=None,
    )


def _cmd_continue(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    # P2-8 修复: /continue 支持可选 prompt 参数（对齐 ST slash-commands.js:1845）。
    # - /continue           → 无 prompt，直接续写最后一条 AI 消息
    # - /continue <prompt>  → 把 prompt 追加到最后一条 AI 消息末尾后续写
    # 不再添加 "continuing" system 消息和 user 消息；改用 is_continue 标记
    # 让 websocket 调用 continue 生成路径（追加到最后一条 AI 消息）。
    prompt = " ".join(args).strip() if args else None
    return SlashCommandResult(
        send_to_chat=False,
        is_continue=True,
        continue_prompt=prompt,
    )


def _cmd_retry(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    branch = _get_active_branch(ctx.db, ctx.session_id)
    last_ai = _get_last_ai_message(ctx.db, ctx.session_id, branch.id if branch else None)
    if last_ai:
        ctx.db.delete(last_ai)
        ctx.db.commit()
    return SlashCommandResult(send_to_chat=True, system_message="retrying")


def _cmd_swipe(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    direction = args[0].lower() if args else "right"
    if direction not in ("left", "right", "new"):
        return SlashCommandResult(
            send_to_chat=False,
            response="Usage: /swipe [left|right|new]",
        )
    branch = _get_active_branch(ctx.db, ctx.session_id)
    last_ai = _get_last_ai_message(ctx.db, ctx.session_id, branch.id if branch else None)
    if not last_ai:
        return SlashCommandResult(send_to_chat=False, response="No message to swipe")

    try:
        swipes = json.loads(last_ai.swipes) if last_ai.swipes else []
        if not isinstance(swipes, list):
            swipes = []
    except (json.JSONDecodeError, TypeError):
        swipes = []
    if not swipes:
        swipes = [last_ai.content or ""]

    current = last_ai.swipe_id or 0
    # P2 修复: 跟踪是否创建了新 swipe，新 swipe 需要触发生成
    needs_generation = False
    if direction == "left":
        current = max(0, current - 1)
    elif direction == "right":
        if current + 1 < len(swipes):
            current += 1
        else:
            swipes.append("")
            current = len(swipes) - 1
            needs_generation = True
    elif direction == "new":
        swipes.append("")
        current = len(swipes) - 1
        needs_generation = True

    last_ai.swipe_id = current
    last_ai.swipes = json.dumps(swipes, ensure_ascii=False)
    if current < len(swipes) and swipes[current]:
        last_ai.content = swipes[current]
    ctx.db.commit()
    return SlashCommandResult(
        # P2 修复: 创建新 swipe 时触发生成（对齐 ST swipe 行为）
        send_to_chat=needs_generation,
        response=f"Swipe {current + 1}/{len(swipes)}",
        modified=True,
    )


def _cmd_branch(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        branches = (
            ctx.db.query(CharacterChatSessionBranch)
            .filter(CharacterChatSessionBranch.session_id == ctx.session_id)
            .order_by(CharacterChatSessionBranch.created_at.asc())
            .all()
        )
        if not branches:
            return SlashCommandResult(send_to_chat=False, response="No branches")
        lines = [
            f"- {b.branch_name}{' (active)' if b.is_active else ''}" for b in branches
        ]
        return SlashCommandResult(
            send_to_chat=False, response="Branches:\n" + "\n".join(lines)
        )

    action = args[0].lower()
    if action == "create" and len(args) >= 2:
        name = args[1]
        ctx.db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == ctx.session_id,
            CharacterChatSessionBranch.is_active == True,  # noqa: E712
        ).update({"is_active": False})
        branch = CharacterChatSessionBranch(
            session_id=ctx.session_id,
            branch_name=name,
            is_active=True,
        )
        ctx.db.add(branch)
        ctx.db.commit()
        return SlashCommandResult(
            send_to_chat=False, response=f"Branch created: {name}", modified=True
        )
    if action == "switch" and len(args) >= 2:
        name = args[1]
        branch = (
            ctx.db.query(CharacterChatSessionBranch)
            .filter(
                CharacterChatSessionBranch.session_id == ctx.session_id,
                CharacterChatSessionBranch.branch_name == name,
            )
            .first()
        )
        if not branch:
            return SlashCommandResult(
                send_to_chat=False, response=f"Branch not found: {name}"
            )
        ctx.db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == ctx.session_id,
            CharacterChatSessionBranch.is_active == True,  # noqa: E712
        ).update({"is_active": False})
        branch.is_active = True
        ctx.db.commit()
        return SlashCommandResult(
            send_to_chat=False, response=f"Switched to branch: {name}", modified=True
        )
    return SlashCommandResult(
        send_to_chat=False,
        response="Usage: /branch [list|create <name>|switch <name>]",
    )


# ========== Session setting commands ==========

def _cmd_model(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        meta = _read_chat_metadata(ctx.session)
        current = meta.get("model", "default")
        return SlashCommandResult(send_to_chat=False, response=f"Model: {current}")
    model_name = args[0]
    if ctx.session:
        meta = _read_chat_metadata(ctx.session)
        meta["model"] = model_name
        _write_chat_metadata(ctx.session, meta)
        ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False, response=f"Model: {model_name}", modified=True
    )


def _cmd_preset(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        meta = _read_chat_metadata(ctx.session)
        current = meta.get("preset", "default")
        return SlashCommandResult(send_to_chat=False, response=f"Preset: {current}")
    preset_name = args[0]
    if ctx.session:
        meta = _read_chat_metadata(ctx.session)
        meta["preset"] = preset_name
        _write_chat_metadata(ctx.session, meta)
        ctx.db.commit()
    return SlashCommandResult(
        send_to_chat=False, response=f"Preset: {preset_name}", modified=True
    )


def _cmd_delvar(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /delvar <key>")
    key = args[0]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
    )
    macro_env._delete_chat_var(key)
    ctx.db.commit()
    return SlashCommandResult(send_to_chat=False, response="Deleted", modified=True)


def _cmd_var(args: list[str], ctx: SlashCommandContext) -> SlashCommandResult:
    """P2 修复: /var 双向命令 — 对齐 ST variables.js varCallback。

    双向语义：
    - /var <key>         → 读取变量（chat → user → global 回退）
    - /var <key> <value> → 设置 chat 变量
    """
    if not args:
        return SlashCommandResult(send_to_chat=False, response="Usage: /var <key> [value]")
    key = args[0]
    macro_env = MacroEnv(
        db=ctx.db,
        session_id=ctx.session_id,
        user_id=ctx.user_id,
        user_name=ctx.user_name,
        char_name=ctx.character.name if ctx.character else "Character",
    )
    # 带 value 时：set 变量
    if len(args) >= 2:
        value = " ".join(args[1:])
        macro_env._set_chat_var(key, value)
        ctx.db.commit()
        return SlashCommandResult(send_to_chat=False, response=value, modified=True)
    # 不带 value 时：get 变量（chat → user → global 回退）
    value = macro_env._get_chat_var(key)
    if value is None:
        value = macro_env._get_user_var(key)
    if value is None:
        value = macro_env._get_global_var(key)
    return SlashCommandResult(send_to_chat=False, response=str(value) if value is not None else "")


# ========== Registration ==========

SlashCommandRegistry.register("sys", _cmd_sys)
SlashCommandRegistry.register("system", _cmd_sys)
SlashCommandRegistry.register("note", _cmd_note)
SlashCommandRegistry.register("an", _cmd_note)
# Phase G: /note 子命令，对齐 ST 1.18.0 per-chat position/depth/frequency 存储
SlashCommandRegistry.register("note-position", _cmd_note_position)
SlashCommandRegistry.register("note-depth", _cmd_note_depth)
SlashCommandRegistry.register("note-frequency", _cmd_note_frequency)
SlashCommandRegistry.register("name", _cmd_name)
SlashCommandRegistry.register("rename", _cmd_name)
SlashCommandRegistry.register("persona", _cmd_persona)
SlashCommandRegistry.register("impersonate", _cmd_impersonate)
SlashCommandRegistry.register("trigger", _cmd_trigger)
SlashCommandRegistry.register("setvar", _cmd_setvar)
SlashCommandRegistry.register("getvar", _cmd_getvar)
SlashCommandRegistry.register("incvar", _cmd_incvar)
SlashCommandRegistry.register("decvar", _cmd_decvar)
SlashCommandRegistry.register("addvar", _cmd_addvar)
SlashCommandRegistry.register("wi", _cmd_wi)
SlashCommandRegistry.register("world", _cmd_world)
SlashCommandRegistry.register("help", _cmd_help)
SlashCommandRegistry.register("send", _cmd_send)
SlashCommandRegistry.register("say", _cmd_send)
SlashCommandRegistry.register("gen", _cmd_gen)
SlashCommandRegistry.register("generate", _cmd_gen)
SlashCommandRegistry.register("continue", _cmd_continue)
SlashCommandRegistry.register("cont", _cmd_continue)
SlashCommandRegistry.register("retry", _cmd_retry)
SlashCommandRegistry.register("regenerate", _cmd_retry)
SlashCommandRegistry.register("swipe", _cmd_swipe)
SlashCommandRegistry.register("branch", _cmd_branch)
SlashCommandRegistry.register("model", _cmd_model)
SlashCommandRegistry.register("preset", _cmd_preset)
SlashCommandRegistry.register("delvar", _cmd_delvar)
# P2 修复: /var 双向命令（get/set），对齐 ST variables.js varCallback
SlashCommandRegistry.register("var", _cmd_var)


# ========== Public API ==========

def execute_slash_command(
    text: str,
    ctx: SlashCommandContext,
) -> SlashCommandResult:
    cmd, args = _parse_command(text)
    if not cmd:
        return SlashCommandResult(send_to_chat=True)
    handler = SlashCommandRegistry.get(cmd)
    if not handler:
        return SlashCommandResult(
            send_to_chat=False,
            response=f"Unknown command: /{cmd}",
        )
    try:
        return handler(args, ctx)
    except Exception as exc:
        logger.exception("Slash command /%s failed", cmd)
        return SlashCommandResult(
            send_to_chat=False,
            response=f"Command error: {exc}",
        )


def is_slash_command(text: str) -> bool:
    return bool(text.strip().startswith("/"))
