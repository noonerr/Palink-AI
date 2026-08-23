"""Macro and Variable Runtime Service (Phase 3).

Lightweight backend implementation of SillyTavern-style macro evaluation.
Supports common macros and variable operations.
"""

from __future__ import annotations

import json
import random
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session as DBSession

from ..models.chat_variable import ChatVariable, UserVariable, GlobalVariable
from ..models.character import CharacterChatSession
from .st_seedrandom import st_get_string_hash, st_pick_index


MACRO_PATTERN = re.compile(r"\{\{([^}]+)\}\}")

# world book 的"当前变量状态"模板标签（ST MVU 扩展用），宏替换后需转成参考说明
_STATUS_CURRENT_VAR_RE = re.compile(
    r"<status_current_variable>([\s\S]*?)</status_current_variable>",
    re.IGNORECASE,
)


def _format_status_current_variable_ref(m: re.Match) -> str:
    body = m.group(1).strip()
    if not body:
        return ""
    return (
        "【当前变量状态】（内部数据，仅供 AI 思考判断使用；【严格禁止】把其中任何"
        "内容（如日期时间、天气、数值、角色状态）抄进回复正文——正文只允许写剧情"
        "对话；如需更新变量，必须使用 <UpdateVariable> JSON Patch 格式）\n"
        + body
    )

# ST 1.18.0 {{pick}} 宏专用模式 (macros.js:522): 用于确定性随机选择。
# 匹配 {{pick ::list}} 或 {{pick:list}}，捕获列表字符串。
# 与 MACRO_PATTERN 的区别: 精确捕获 pick 后的列表（含 :: 或 : 分隔）。
_PICK_PATTERN = re.compile(r"\{\{pick\s?::?([^}]+)\}\}", re.IGNORECASE)

# ST 1.18.0 {{random}} 宏专用模式 (macros.js:492): 非确定性随机。
_RANDOM_PATTERN = re.compile(r"\{\{random\s?::?([^}]+)\}\}", re.IGNORECASE)


def _humanize_duration(t1_str: str, t2_str: str) -> str:
    """ST 1.18.0 ``{{timeDiff::t1::t2}}`` (macros.js:580) — moment.duration.humanize(true)。

    解析两个时间字符串，计算差值的 humanize 描述（"a few seconds ago" 风格）。
    ST 使用 moment.duration(t1.diff(t2)).humanize(true)。
    """
    try:
        t1 = _parse_time_str(t1_str)
        t2 = _parse_time_str(t2_str)
        if t1 is None or t2 is None:
            return ""
        delta = t1 - t2
        total_seconds = abs(int(delta.total_seconds()))
        return _humanize_seconds(total_seconds)
    except (ValueError, TypeError):
        return ""


def _parse_time_str(s: str):
    """解析时间字符串，支持 ISO 8601、Unix 时间戳（秒/毫秒）。"""
    s = str(s).strip()
    if not s:
        return None
    # Unix 时间戳
    if s.isdigit():
        ts = int(s)
        if ts > 1e12:  # 毫秒
            ts = ts / 1000
        return datetime.utcfromtimestamp(ts)
    # ISO 8601
    try:
        # 处理带 'Z' 的 ISO 格式
        clean = s.replace("Z", "+00:00")
        return datetime.fromisoformat(clean)
    except (ValueError, TypeError):
        pass
    return None


def _humanize_seconds(total_seconds: int) -> str:
    """moment.duration.humanize(true) 的 Python 近似。

    ST 用 moment.js 的 humanize，输出如 "a few seconds"、"a minute"、"2 hours" 等。
    ``true`` 参数表示带 "ago"/"in" 后缀。这里返回不带方向的人类化描述
    （ST 的 humanize(true) 对 past 返回 "X ago"，对 future 返回 "in X"）。
    """
    if total_seconds < 45:
        return "a few seconds"
    elif total_seconds < 90:
        return "a minute"
    elif total_seconds < 2700:  # 45 分钟
        minutes = round(total_seconds / 60)
        return f"{minutes} minutes"
    elif total_seconds < 5400:  # 90 分钟
        return "an hour"
    elif total_seconds < 79200:  # 22 小时
        hours = round(total_seconds / 3600)
        return f"{hours} hours"
    elif total_seconds < 129600:  # 36 小时
        return "a day"
    elif total_seconds < 2160000:  # 25 天
        days = round(total_seconds / 86400)
        return f"{days} days"
    elif total_seconds < 3888000:  # 45 天
        return "a month"
    elif total_seconds < 29808000:  # 345 天
        months = round(total_seconds / 2592000)
        return f"{months} months"
    elif total_seconds < 47174400:  # 545 天
        return "a year"
    else:
        years = round(total_seconds / 31536000)
        return f"{years} years"


def _split_pick_list(list_string: str) -> list[str]:
    """ST 1.18.0 pick/random 列表拆分逻辑 (macros.js:525-528)。

    - 若列表含 ``::``: 按 ``::`` 拆分（保留各项原样，不 trim）
    - 否则: 按 ``,`` 拆分并 trim 各项（支持 ``\\,`` 转义逗号）
    """
    if "::" in list_string:
        return list_string.split("::")
    # ST 用 ## COMMA ## 占位符处理转义逗号
    placeholder = "##\x00COMMA\x00##"
    escaped = list_string.replace(r"\,", placeholder)
    return [item.strip().replace(placeholder, ",") for item in escaped.split(",")]

# ST 1.18.0 注释宏 {{// ...}} (macros.js:659): 跨行匹配、剩除为空。
# MACRO_PATTERN 的 [^}]+ 无法匹配含换行/嵌套的注释体，故在 evaluate_macros
# 主循环前以独立正则预处理（与 ST 一致：注释在宏求值前被移除）。
_COMMENT_MACRO_PATTERN = re.compile(r"\{\{//[\s\S]*?\}\}")

# ST 1.18.0 遗留尖括号宏 (macros.js:624-628): <USER>/<BOT>/<CHAR>/<GROUP>/<CHARIFNOTGROUP>。
# 在 ST 中这些作为 preEnv 宏对所有被求值文本生效；Palink 无群组上下文，
# <GROUP>/<CHARIFNOTGROUP> 降级为角色名（单聊场景与 ST 行为一致）。
_LEGACY_ANGLE_MACROS = (
    (re.compile(r"<USER>", re.IGNORECASE), "user_name"),
    (re.compile(r"<BOT>", re.IGNORECASE), "char_name"),
    (re.compile(r"<CHARIFNOTGROUP>", re.IGNORECASE), "char_name"),
    (re.compile(r"<CHAR>", re.IGNORECASE), "char_name"),
    (re.compile(r"<GROUP>", re.IGNORECASE), "char_name"),
)


def _apply_pre_macros(text: str, env: "MacroEnv") -> str:
    """ST 1.18.0 preEnv 宏对齐: 先剩除 {{// 注释}}，再替换遗留尖括号宏。"""
    if not text:
        return text
    result = _COMMENT_MACRO_PATTERN.sub("", text)
    for pattern, attr in _LEGACY_ANGLE_MACROS:
        result = pattern.sub(getattr(env, attr), result)
    return result


def _split_macro_args(body: str) -> list[str]:
    """拆分宏参数，对齐 ST 1.18.0 的 ``::`` 分隔约定。

    ST 宏以双冒号 ``::`` 作为参数分隔符（如 ``{{setvar::name::value}}``、
    ``{{getglobalvar::key}}``，见 variables.js:241-259）。旧实现按**单个** ``:``
    切分，会把 ``setvar::name::value`` 拆成 ``['setvar','','name','','value']``，
    导致 args[0]/args[1] 为空字符串 → setvar/setglobalvar 静默失效。

    修正: 优先按 ``::`` 切分；无 ``::`` 时回退按单个 ``:``（兼容 ``{{roll:6}}``
    这类 ST 单冒号宏，macros.js:551）。各段去除首尾空白。
    """
    sep = "::" if "::" in body else ":"
    return [p.strip() for p in body.split(sep)]


class MacroEnv:
    def __init__(
        self,
        db: DBSession,
        session_id: Optional[str] = None,
        user_id: Optional[int] = None,
        user_name: str = "User",
        char_name: str = "Character",
        input_text: str = "",
        scoped_vars: Optional[dict[str, str]] = None,
        character: Optional[Any] = None,
        user_setting: Optional[Any] = None,
        worldbook_em_top: Optional[list[str]] = None,
        worldbook_em_bottom: Optional[list[str]] = None,
        worldbook_outlets: Optional[dict[str, list[str]]] = None,
        # ST 1.18.0 聊天上下文宏支持
        chat_messages: Optional[list[dict[str, Any]]] = None,
        last_message_id: Optional[int] = None,
        # ST 1.18.0 token 限制宏支持
        max_prompt_tokens: Optional[int] = None,
        max_context_tokens: Optional[int] = None,
        max_response_tokens: Optional[int] = None,
        # ST 1.18.0 idle_duration 支持
        last_message_time: Optional[datetime] = None,
        # Phase C 修复: ST 1.18.0 缺失宏所需上下文
        chat_id_hash: Optional[str] = None,  # {{pick}} 确定性种子 (ST getChatIdHash)
        first_included_message_id: Optional[int] = None,  # {{firstIncludedMessageId}}
        first_displayed_message_id: Optional[int] = None,  # {{firstDisplayedMessageId}}
        last_swipe_id: Optional[int] = None,  # {{lastSwipeId}}
        current_swipe_id: Optional[int] = None,  # {{currentSwipeId}}
        last_generation_type: Optional[str] = None,  # {{lastGenerationType}}
        banned_tokens: Optional[list] = None,  # {{banned "word"}} 副作用收集
        story_string_prefix: Optional[str] = "",  # {{storyStringPrefix}}
        story_string_suffix: Optional[str] = "",  # {{storyStringSuffix}}
    ):
        self.db = db
        self.session_id = session_id
        self.user_id = user_id
        self.user_name = user_name
        self.char_name = char_name
        self.input_text = input_text
        self.scoped_vars = scoped_vars or {}
        # Fix-12: 角色卡宏支持所需的对象
        self.character = character
        self.user_setting = user_setting
        # ST 1.18.0 世界书 EMTop/EMBottom/outlet 注入支持
        # - em_top/em_bottom: position 5/6 的世界书条目，通过 {{mesExamples}} 宏
        #   拼接为 em_top + char.mes_example + em_bottom（参考 script.js:4576-4596）
        # - outlets: position 7 的世界书条目，按 outletName 分组，
        #   通过 {{outlet::name}} 宏访问（参考 macros.js:597-600, 668）
        self.worldbook_em_top = worldbook_em_top or []
        self.worldbook_em_bottom = worldbook_em_bottom or []
        self.worldbook_outlets = worldbook_outlets or {}
        # ST 1.18.0 聊天上下文
        self.chat_messages = chat_messages or []
        self.last_message_id = last_message_id
        # ST 1.18.0 token 限制
        self.max_prompt_tokens = max_prompt_tokens
        self.max_context_tokens = max_context_tokens
        self.max_response_tokens = max_response_tokens
        # ST 1.18.0 idle_duration
        self.last_message_time = last_message_time
        # Phase C 修复: 缺失宏上下文
        self.chat_id_hash = chat_id_hash
        self.first_included_message_id = first_included_message_id
        self.first_displayed_message_id = first_displayed_message_id
        self.last_swipe_id = last_swipe_id
        self.current_swipe_id = current_swipe_id
        self.last_generation_type = last_generation_type or "normal"
        self.banned_tokens = banned_tokens if banned_tokens is not None else []
        self.story_string_prefix = story_string_prefix or ""
        self.story_string_suffix = story_string_suffix or ""

    def _get_chat_var(self, key: str) -> Optional[str]:
        if not self.session_id:
            return None
        row = (
            self.db.query(ChatVariable)
            .filter(ChatVariable.session_id == self.session_id, ChatVariable.key == key)
            .first()
        )
        return row.value if row else None

    def _set_chat_var(self, key: str, value: str) -> None:
        if not self.session_id:
            return
        row = (
            self.db.query(ChatVariable)
            .filter(ChatVariable.session_id == self.session_id, ChatVariable.key == key)
            .first()
        )
        if row:
            row.value = value
        else:
            self.db.add(ChatVariable(session_id=self.session_id, key=key, value=value))

    def _get_user_var(self, key: str) -> Optional[str]:
        if not self.user_id:
            return None
        row = (
            self.db.query(UserVariable)
            .filter(UserVariable.user_id == self.user_id, UserVariable.key == key)
            .first()
        )
        return row.value if row else None

    def _set_user_var(self, key: str, value: str) -> None:
        if not self.user_id:
            return
        row = (
            self.db.query(UserVariable)
            .filter(UserVariable.user_id == self.user_id, UserVariable.key == key)
            .first()
        )
        if row:
            row.value = value
        else:
            self.db.add(UserVariable(user_id=self.user_id, key=key, value=value))

    def _get_global_var(self, key: str) -> Optional[str]:
        uid = self.user_id if self.user_id is not None else 0
        row = (
            self.db.query(GlobalVariable)
            .filter(GlobalVariable.user_id == uid, GlobalVariable.key == key)
            .first()
        )
        return row.value if row else None

    def _set_global_var(self, key: str, value: str) -> None:
        uid = self.user_id if self.user_id is not None else 0
        row = (
            self.db.query(GlobalVariable)
            .filter(GlobalVariable.user_id == uid, GlobalVariable.key == key)
            .first()
        )
        if row:
            row.value = value
        else:
            self.db.add(GlobalVariable(user_id=uid, key=key, value=value))

    def _delete_chat_var(self, key: str) -> None:
        if not self.session_id:
            return
        self.db.query(ChatVariable).filter(
            ChatVariable.session_id == self.session_id, ChatVariable.key == key
        ).delete()

    def _delete_user_var(self, key: str) -> None:
        if not self.user_id:
            return
        self.db.query(UserVariable).filter(
            UserVariable.user_id == self.user_id, UserVariable.key == key
        ).delete()

    def _delete_global_var(self, key: str) -> None:
        uid = self.user_id if self.user_id is not None else 0
        self.db.query(GlobalVariable).filter(
            GlobalVariable.user_id == uid, GlobalVariable.key == key
        ).delete()


def _resolve_simple_macro(name: str, env: MacroEnv) -> Optional[str]:
    name_lower = name.lower()
    if name_lower in ("user", "username", "name1"):
        return env.user_name
    if name_lower in ("char", "character", "name2", "bot"):
        return env.char_name
    if name_lower == "input":
        return env.input_text
    if name_lower in ("time", "time_utc"):
        return datetime.utcnow().strftime("%H:%M")
    if name_lower == "date":
        return datetime.utcnow().strftime("%Y-%m-%d")
    if name_lower == "datetime":
        return datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    if name_lower in ("br", "newline"):
        return "\n"
    if name_lower == "ln":
        return "\n"
    if name_lower in ("space", "sp"):
        return " "
    if name_lower == "tab":
        return "\t"
    if name_lower == "noop":
        return ""

    # ST 1.18.0 日期/时间宏 (macros.js:660-667)
    if name_lower == "weekday":
        return datetime.utcnow().strftime("%A")
    if name_lower == "isotime":
        return datetime.utcnow().strftime("%H:%M")
    if name_lower == "isodate":
        return datetime.utcnow().strftime("%Y-%m-%d")

    # ST 1.18.0 token 限制宏 (macros.js:643-648)
    if name_lower in ("maxprompt", "maxprompttokens"):
        return str(env.max_prompt_tokens) if env.max_prompt_tokens is not None else ""
    if name_lower in ("maxcontext", "maxcontexttokens"):
        return str(env.max_context_tokens) if env.max_context_tokens is not None else ""
    if name_lower in ("maxresponse", "maxresponsetokens"):
        return str(env.max_response_tokens) if env.max_response_tokens is not None else ""

    # ST 1.18.0 聊天上下文宏 (macros.js:649-657)
    if name_lower == "lastmessage":
        if env.chat_messages:
            return env.chat_messages[-1].get("content", "")
        return ""
    if name_lower == "lastmessageid":
        return str(env.last_message_id) if env.last_message_id is not None else ""
    if name_lower == "lastusermessage":
        for msg in reversed(env.chat_messages):
            if msg.get("role") == "user":
                return msg.get("content", "")
        return ""
    if name_lower == "lastcharmessage":
        for msg in reversed(env.chat_messages):
            if msg.get("role") == "assistant":
                return msg.get("content", "")
        return ""
    if name_lower == "allchatrange":
        if env.chat_messages:
            return f"0-{len(env.chat_messages) - 1}"
        return ""

    # ST 1.18.0 idle_duration (macros.js:666)
    if name_lower == "idle_duration":
        if env.last_message_time:
            delta = datetime.utcnow() - env.last_message_time
            total_seconds = int(delta.total_seconds())
            if total_seconds < 60:
                return f"{total_seconds}s"
            elif total_seconds < 3600:
                return f"{total_seconds // 60}m"
            else:
                return f"{total_seconds // 3600}h {(total_seconds % 3600) // 60}m"
        return ""

    # Fix-12: 角色卡宏（ST 1.18.0 character card macros）
    char = env.character
    if name_lower in ("description", "charprompt"):
        return getattr(char, "description", None) if char else None
    if name_lower == "personality":
        return getattr(char, "personality", None) if char else None
    if name_lower == "scenario":
        return getattr(char, "scenario", None) if char else None
    if name_lower in ("mesexamples", "mes_example", "mesexample", "example_dialogue"):
        # ST 1.18.0 对齐: position 5 (EMTop) 和 6 (EMBottom) 的世界书条目
        # 通过 {{mesExamples}} 宏注入，组装顺序为:
        # em_top + char.mes_example + em_bottom
        # 参考 SillyTavern-1.18.0/public/script.js:4576-4596 mesExamplesArray 组装
        base = getattr(char, "mes_example", None) if char else None
        parts: list[str] = []
        if env.worldbook_em_top:
            parts.append("\n".join(env.worldbook_em_top))
        if base:
            parts.append(base)
        if env.worldbook_em_bottom:
            parts.append("\n".join(env.worldbook_em_bottom))
        return "\n".join(parts) if parts else None
    if name_lower in ("firstmes", "first_mes"):
        return getattr(char, "first_mes", None) if char else None
    if name_lower in ("systemprompt", "system_prompt"):
        return getattr(char, "system_prompt", None) if char else None
    if name_lower in ("posthistoryinstructions", "post_history_instructions"):
        return getattr(char, "post_history_instructions", None) if char else None
    if name_lower in ("creatornotes", "creator_notes"):
        return getattr(char, "creator_notes", None) if char else None
    if name_lower == "charjailbreak":
        # D9 修复: jailbreak 是 Palink Character 模型中对应 ST 1.18.0 角色卡 jailbreak 的字段
        # (V3: data.extensions.jailbreak，回退 data.jailbreak)。原读取 jailbreak_prompt 为死代码。
        return getattr(char, "jailbreak", None) if char else None
    if name_lower in ("alternategreetings", "alternate_greetings"):
        if char:
            raw = getattr(char, "alternate_greetings", None)
            if raw:
                try:
                    import json as _json
                    greetings = _json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(greetings, list):
                        return "\n\n".join(str(g) for g in greetings)
                except (ValueError, TypeError):
                    pass
        return None
    if name_lower == "tags":
        if char:
            raw = getattr(char, "tags", None)
            if raw:
                try:
                    import json as _json
                    tags = _json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(tags, list):
                        return ", ".join(str(t) for t in tags)
                except (ValueError, TypeError):
                    pass
        return None
    if name_lower == "persona":
        # 从 user_setting 的活跃 persona 读取描述
        if env.user_setting and getattr(env.user_setting, "active_persona_id", None):
            try:
                from ..models import Persona
                persona = (
                    env.db.query(Persona)
                    .filter(Persona.id == env.user_setting.active_persona_id)
                    .first()
                )
                if persona and persona.description:
                    return persona.description
            except Exception:
                pass
        return None
    if name_lower in ("persona_name", "personaname"):
        # 从 user_setting 的活跃 persona 读取名称
        if env.user_setting and getattr(env.user_setting, "active_persona_id", None):
            try:
                from ..models import Persona
                persona = (
                    env.db.query(Persona)
                    .filter(Persona.id == env.user_setting.active_persona_id)
                    .first()
                )
                if persona and persona.name:
                    return persona.name
            except Exception:
                pass
        return None

    # Phase C 修复: ST 1.18.0 缺失宏补齐 (macros.js:653-656, 721-739)
    if name_lower == "ismobile":
        # 后端无移动端概念，固定 false (ST macros.js:738 String(isMobile()))
        return "false"
    if name_lower == "lastgenerationtype":
        return env.last_generation_type or "normal"
    if name_lower == "firstincludedmessageid":
        return str(env.first_included_message_id) if env.first_included_message_id is not None else ""
    if name_lower == "firstdisplayedmessageid":
        return str(env.first_displayed_message_id) if env.first_displayed_message_id is not None else ""
    if name_lower == "lastswipeid":
        return str(env.last_swipe_id) if env.last_swipe_id is not None else ""
    if name_lower == "currentswipeid":
        return str(env.current_swipe_id) if env.current_swipe_id is not None else ""
    if name_lower == "storystringprefix":
        return env.story_string_prefix or ""
    if name_lower == "storystringsuffix":
        return env.story_string_suffix or ""

    return None


def _resolve_complex_macro(parts: list[str], env: MacroEnv) -> Optional[str]:
    if not parts:
        return None
    cmd = parts[0].lower()
    args = parts[1:]

    # ST 1.18.0 outlet 宏: {{outlet::name}} 返回 position 7 世界书条目
    # 参考 SillyTavern-1.18.0/public/scripts/macros.js:597-600, 668
    # 用法: 在角色描述/scenario/author note 等任意字段中引用 {{outlet::village}}
    # 若该 outlet 存在条目则返回 join("\n") 的内容，否则返回空串
    # 注: _split_macro_args 现按 "::" 切分，"outlet::village" 产生 ['outlet', 'village']
    if cmd == "outlet" and args:
        outlet_name = next((a.strip() for a in args if a.strip()), "")
        if outlet_name:
            entries = env.worldbook_outlets.get(outlet_name, [])
            return "\n".join(entries) if entries else ""
        return ""

    # {{format_message_variable::stat_data}} — ST 消息格式化宏（macros.js formatMessageVariable）。
    # Palink 此前不识别该宏 → 模板文字原样进提示词 → AI 误以为要输出
    # <status_current_variable> 快照而非 <UpdateVariable> JSON Patch（2026-08-18 实测 2163）。
    # 这里输出当前会话 stat_data 的 JSON 供 AI 参考变量现状（与 ST 前端渲染行为对齐）。
    if cmd == "format_message_variable" and args:
        key = args[0].strip()
        if key != "stat_data":
            return ""
        try:
            row = (
                env.db.query(CharacterChatSession)
                .filter(CharacterChatSession.id == env.session_id)
                .first()
            )
            if row and row.chat_metadata:
                meta = json.loads(row.chat_metadata) if isinstance(row.chat_metadata, str) else row.chat_metadata
                variables = (meta or {}).get("variables") or {}
                sd = variables.get("stat_data") or {}
                return json.dumps(sd, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return "{}"

    # Phase C 修复: {{banned "word"}} (ST macros.js:443) — 副作用宏，加入禁词列表，返回空串。
    # body 形如 'banned "word"'，_split_macro_args 不拆分引号，故 parts[0] 含完整文本。
    if cmd.startswith("banned"):
        _bm = re.search(r'"([^"]*)"', cmd)
        if _bm and env.banned_tokens is not None:
            env.banned_tokens.append(_bm.group(1))
        return ""

    # Phase C 修复: {{timeDiff::t1::t2}} (ST macros.js:580) — moment.duration.humanize(true)
    if cmd == "timediff" and len(args) >= 2:
        return _humanize_duration(args[0], args[1])

    if cmd in ("getvar", "var") and args:
        key = args[0]
        for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
            val = getter(key)
            if val is not None:
                return val
        return ""

    if cmd == "setvar" and len(args) >= 2:
        key, value = args[0], args[1]
        env._set_chat_var(key, value)
        return ""

    if cmd == "setglobalvar" and len(args) >= 2:
        key, value = args[0], args[1]
        env._set_global_var(key, value)
        return ""

    if cmd == "setuservar" and len(args) >= 2:
        key, value = args[0], args[1]
        env._set_user_var(key, value)
        return ""

    if cmd == "addvar" and len(args) >= 2:
        key, delta = args[0], args[1]
        try:
            current = 0
            for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
                val = getter(key)
                if val is not None:
                    current = float(val)
                    break
            new_val = current + float(delta)
            env._set_chat_var(key, str(int(new_val) if new_val == int(new_val) else new_val))
        except (ValueError, TypeError):
            pass
        return ""

    if cmd == "incvar" and args:
        key = args[0]
        try:
            current = 0
            for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
                val = getter(key)
                if val is not None:
                    current = float(val)
                    break
            env._set_chat_var(key, str(int(current + 1)))
        except (ValueError, TypeError):
            pass
        return ""

    if cmd == "decvar" and args:
        key = args[0]
        try:
            current = 0
            for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
                val = getter(key)
                if val is not None:
                    current = float(val)
                    break
            env._set_chat_var(key, str(int(current - 1)))
        except (ValueError, TypeError):
            pass
        return ""

    if cmd == "delvar" and args:
        key = args[0]
        env._delete_chat_var(key)
        return ""

    if cmd == "exists" and args:
        key = args[0]
        for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
            if getter(key) is not None:
                return "true"
        return "false"

    # {{pick}} 的确定性处理在 evaluate_macros 主循环中以 _PICK_PATTERN
    # 专用正则完成（对齐 ST getPickReplaceMacro），此处不再处理。
    # 保留此处以防 _resolve_complex_macro 被直接调用时仍可回退（非确定性）。
    if cmd == "pick" and args:
        opts = "|".join(args).split("|")
        return random.choice([o.strip() for o in opts if o.strip()])

    # {{random}} 的非确定性处理在 evaluate_macros 主循环中以 _RANDOM_PATTERN
    # 专用正则完成。此处仅作为 _resolve_complex_macro 直接调用的回退。
    if cmd == "random" and args:
        opts = [o for o in args if o]
        return random.choice(opts) if opts else ""

    if cmd == "roll" and args:
        try:
            sides = int(args[0])
            return str(random.randint(1, sides))
        except (ValueError, TypeError):
            return ""

    if cmd == "length" and args:
        return str(len(args[0]))

    if cmd == "lower" and args:
        return args[0].lower()

    if cmd == "upper" and args:
        return args[0].upper()

    if cmd == "trim" and args:
        return args[0].strip()

    if cmd == "substr" and len(args) >= 2:
        text = args[0]
        try:
            start = int(args[1])
            end = int(args[2]) if len(args) > 2 else None
            return text[start:end]
        except (ValueError, TypeError):
            return text

    if cmd == "replace" and len(args) >= 3:
        text, old, new = args[0], args[1], args[2]
        return text.replace(old, new)

    # ST 1.18.0 字符串反转宏 {{reverse:...}} (macros.js:658)。
    # _split_macro_args 会去除段首尾空白；此处用 ':' 重新拼接以保留原文中的冒号。
    if cmd == "reverse" and args:
        return ":".join(args)[::-1]

    # ST 1.18.0 {{datetimeformat format}} (macros.js:665)
    # 使用 moment.js 格式，转换为 Python strftime
    if cmd == "datetimeformat" and args:
        fmt = " ".join(args)  # 重新拼接格式字符串
        # moment.js -> Python strftime 常见格式转换
        fmt = fmt.replace("YYYY", "%Y").replace("YY", "%y")
        fmt = fmt.replace("MMMM", "%B").replace("MMM", "%b").replace("MM", "%m")
        fmt = fmt.replace("DDDD", "%A").replace("DDD", "%a").replace("DD", "%d")
        fmt = fmt.replace("HH", "%H").replace("hh", "%I")
        fmt = fmt.replace("mm", "%M").replace("ss", "%S")
        fmt = fmt.replace("A", "%p")
        try:
            return datetime.utcnow().strftime(fmt)
        except (ValueError, TypeError):
            return ""

    # ST 1.18.0 {{time_UTC+offset}} / {{time_UTC-offset}} (macros.js:667)
    if cmd.startswith("time_utc") and args:
        try:
            offset_str = args[0]
            offset_hours = int(offset_str)
            from datetime import timedelta
            utc_time = datetime.utcnow() + timedelta(hours=offset_hours)
            return utc_time.strftime("%H:%M")
        except (ValueError, TypeError):
            return ""

    # ST 1.18.0 全局变量宏 (variables.js:251-259)。
    # getvar 已会回退查全局，但 ST 另有显式 getglobalvar 只读全局作用域。
    if cmd == "getglobalvar" and args:
        val = env._get_global_var(args[0])
        return val if val is not None else ""

    if cmd == "addglobalvar" and len(args) >= 2:
        key, delta = args[0], args[1]
        try:
            current = env._get_global_var(key)
            new_val = (float(current) if current is not None else 0.0) + float(delta)
            env._set_global_var(key, str(int(new_val) if new_val == int(new_val) else new_val))
        except (ValueError, TypeError):
            pass
        return ""

    if cmd == "incglobalvar" and args:
        key = args[0]
        try:
            current = env._get_global_var(key)
            base = float(current) if current is not None else 0.0
            env._set_global_var(key, str(int(base + 1)))
        except (ValueError, TypeError):
            pass
        return ""

    if cmd == "decglobalvar" and args:
        key = args[0]
        try:
            current = env._get_global_var(key)
            base = float(current) if current is not None else 0.0
            env._set_global_var(key, str(int(base - 1)))
        except (ValueError, TypeError):
            pass
        return ""

    return None


def evaluate_macros(text: str, env: MacroEnv, max_iterations: int = 10) -> str:
    """Evaluate all {{...}} macros in text, iterating until stable or max iterations.

    ST 1.18.0 对齐 (macros.js substituteParams):
      1. 捕获 rawContent = 原始文本（用于 {{pick}} 确定性种子）
      2. 应用 pre-macros（注释移除 + 遗留尖括号宏）
      3. 应用 {{random}}（非确定性，单次）
      4. 应用 {{pick}}（确定性，单次，使用 rawContentHash + offset）
      5. 迭代通用宏求值（变量宏、角色卡宏等）直至稳定
    """
    if not text:
        return text

    # ST 1.18.0: rawContent 在任何替换前捕获 (macros.js:616)
    raw_content = text
    raw_content_hash = st_get_string_hash(raw_content) if env.chat_id_hash is not None else None

    # Step 1: pre-macros (注释移除 + 遗留尖括号宏)
    result = _apply_pre_macros(text, env)

    # Step 2: {{random}} — 非确定性，单次 (macros.js:491-509, 671)
    # ST 在 postEnvMacros 中先于 pick 应用。列表按 :: 或 , 拆分。
    def _random_replace(m: re.Match) -> str:
        opts = _split_pick_list(m.group(1))
        opts = [o for o in opts if o]
        return random.choice(opts) if opts else ""

    result = _RANDOM_PATTERN.sub(_random_replace, result)

    # Step 3: {{pick}} — 确定性，单次 (macros.js:516-544, 672)
    # 种子 = getStringHash(f"{chatIdHash}-{rawContentHash}-{offset}")
    # 仅当 env.chat_id_hash 可用时启用确定性（否则回退非确定性 random.choice）
    if env.chat_id_hash is not None and raw_content_hash is not None:
        def _pick_replace(m: re.Match) -> str:
            opts = _split_pick_list(m.group(1))
            opts = [o for o in opts if o]
            if not opts:
                return ""
            idx = st_pick_index(env.chat_id_hash, raw_content, m.start(), len(opts))
            return opts[idx]
        result = _PICK_PATTERN.sub(_pick_replace, result)
    else:
        # 回退: 无 chat_id_hash 时非确定性（向后兼容）
        def _pick_replace_fallback(m: re.Match) -> str:
            opts = _split_pick_list(m.group(1))
            opts = [o for o in opts if o]
            return random.choice(opts) if opts else ""
        result = _PICK_PATTERN.sub(_pick_replace_fallback, result)

    # Step 4: 迭代通用宏求值（变量宏、角色卡宏、时间宏等）
    for _ in range(max_iterations):
        matches = list(MACRO_PATTERN.finditer(result))
        if not matches:
            break
        replacements: list[tuple[int, int, str]] = []
        for m in matches:
            body = m.group(1)
            # 跳过已被预处理的 pick/random（不应再匹配，但防御性处理）
            if body.lower().startswith("pick") or body.lower().startswith("random"):
                replacements.append((m.start(), m.end(), m.group(0)))
                continue
            parts = _split_macro_args(body)
            resolved: Optional[str] = None
            if len(parts) == 1 and "::" not in body:
                resolved = _resolve_simple_macro(parts[0], env)
            if resolved is None:
                resolved = _resolve_complex_macro(parts, env)
            if resolved is None:
                resolved = m.group(0)
            replacements.append((m.start(), m.end(), resolved))
        if not replacements:
            break
        # Apply replacements from end to start to preserve indices
        new_result = result
        for start, end, value in reversed(replacements):
            new_result = new_result[:start] + value + new_result[end:]
        if new_result == result:
            break
        result = new_result

    # [STATUS-CURRENT-VAR] world book 里
    # <status_current_variable>{{format_message_variable::stat_data}}</status_current_variable>
    # 是"当前变量状态"模板（ST 前端 MVU 扩展渲染用）。宏替换后它变成
    # <status_current_variable>{JSON}</status_current_variable>，AI 会误以为要输出该格式
    # （2026-08-18 实测 2163：AI 输出 stat_data 快照而非 <UpdateVariable> JSON Patch）。
    # 把标签替换为明确的"参考"说明，杜绝误解。
    result = _STATUS_CURRENT_VAR_RE.sub(_format_status_current_variable_ref, result)
    return result


def evaluate_macros_in_messages(
    messages: list[dict[str, Any]],
    env: MacroEnv,
) -> list[dict[str, Any]]:
    """Evaluate macros in all message contents."""
    result: list[dict[str, Any]] = []
    for msg in messages:
        new_msg = dict(msg)
        content = msg.get("content")
        if isinstance(content, str):
            new_msg["content"] = evaluate_macros(content, env)
        elif isinstance(content, list):
            new_content = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    new_part = dict(part)
                    new_part["text"] = evaluate_macros(part.get("text", ""), env)
                    new_content.append(new_part)
                else:
                    new_content.append(part)
            new_msg["content"] = new_content
        result.append(new_msg)
    return result
