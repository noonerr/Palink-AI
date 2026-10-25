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
from ..core.silent_failure import record as _record_silent_failure
from ..models.character import CharacterChatSession
from .st_seedrandom import st_get_string_hash, st_pick_index


MACRO_PATTERN = re.compile(r"\{\{([^}]+)\}\}")

# world book 的"当前变量状态"模板标签（ST MVU 扩展用），宏替换后需转成参考说明。
# 单复数写法均容（<status_current_variable> / <status_current_variables>，卡侧两种
# 形态都在场；重写函数只取 body 捕获组，不依赖标签名单复数）。
_STATUS_CURRENT_VAR_RE = re.compile(
    r"<status_current_variables?>([\s\S]*?)</status_current_variables?>",
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
        first_included_message: Optional[str] = None,  # {{firstIncludedMessage}}（内容形态，ST macros.js:663）
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
        self.first_included_message = first_included_message
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
    # {{time}} 为站点本地时区（对齐 ST 本地时间语义；容器需 TZ 环境变量配合），
    # {{time_utc}} 保持 UTC 语义——两者此前被误并为同一 UTC 分支
    if name_lower == "time":
        return datetime.now().strftime("%H:%M")
    if name_lower == "time_utc":
        return datetime.utcnow().strftime("%H:%M")
    if name_lower == "date":
        return datetime.now().strftime("%Y-%m-%d")
    if name_lower == "datetime":
        return datetime.now().strftime("%Y-%m-%d %H:%M")
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

    # ST 1.18.0 日期/时间宏 (macros.js:660-667)——本地时区语义
    if name_lower == "weekday":
        return datetime.now().strftime("%A")
    if name_lower == "isotime":
        return datetime.now().strftime("%H:%M")
    if name_lower == "isodate":
        return datetime.now().strftime("%Y-%m-%d")

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

    # ST 1.18.0 idle_duration (macros.js:666)；{{idleDuration}} 为 ST 宏名
    # （lower 归一 idleduration），此前仅注册 idle_duration → ST 卡该宏泄漏
    if name_lower in ("idle_duration", "idleduration"):
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
            except Exception as _persona_exc:
                # [SILENT-FAIL 2026-10-22] 吞掉 = `{{persona}}` 求值失败 ⇒ 宏原样
                # 漏进提示词（模型看到字面量 "{{persona}}"），且完全无记录。
                _record_silent_failure(
                    "macro.resolve_persona_description", _persona_exc,
                    session_id=getattr(env, "session_id", None),
                )
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
            except Exception as _persona_exc:
                # [SILENT-FAIL 2026-10-22] 同上：`{{persona_name}}` 漏成字面量。
                _record_silent_failure(
                    "macro.resolve_persona_name", _persona_exc,
                    session_id=getattr(env, "session_id", None),
                )
        return None

    # Phase C 修复: ST 1.18.0 缺失宏补齐 (macros.js:653-656, 721-739)
    if name_lower == "ismobile":
        # 后端无移动端概念，固定 false (ST macros.js:738 String(isMobile()))
        return "false"
    if name_lower == "lastgenerationtype":
        return env.last_generation_type or "normal"
    if name_lower == "firstincludedmessageid":
        return str(env.first_included_message_id) if env.first_included_message_id is not None else ""
    if name_lower == "firstincludedmessage":
        # ST 1.18.0 {{firstIncludedMessage}}：第一条纳入 prompt 的消息**内容**
        # （macros.js:663-664，chat[firstIncludedMessageId].mes）。与
        # {{firstIncludedMessageId}}（id 形态）是两个宏，此前 Palink 只有 id 形态。
        return env.first_included_message or ""
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

    # 批次 F（双宏引擎收敛子集）: 补齐前端 macro-engine 已有而后端缺失、
    # 且 MacroEnv 有数据源的 ST 宏——此前 ST 卡写这些宏在权威 prompt 侧
    # 原样泄漏（D-9 拍板后端为唯一权威，前端全量而后端缺失即 prompt 侧漏宏）。
    if name_lower in ("greeting", "charfirstmessage"):
        # ST charFirstMessage/greeting（macro-engine env-macros.ts aliases）
        return getattr(char, "first_mes", None) if char else None
    if name_lower in ("charversion", "version", "char_version"):
        # ST charVersion/version/char_version → 角色版本号
        return getattr(char, "character_version", None) if char else None
    if name_lower == "mesexamplesraw":
        # {{mesExamplesRaw}}: 原始示例文本（不经 EMTop/EMBottom 拼装，
        # 与 {{mesExamples}} 的区别即 ST mesExamplesMode=raw 语义）
        return getattr(char, "mes_example", None) if char else None
    if name_lower == "original":
        # {{original}}: 宏替换前的原始消息文本（对齐 ST 一次性消耗语义，
        # Palink 侧数据源为本次输入原文）
        return env.input_text or None

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
        except Exception as _stat_exc:
            # [SILENT-FAIL 2026-10-22] 吞掉 = `{{getvar::stat_data}}` 一类宏返回 "{}"，
            # 模型拿到的是空变量而不是真值，且无任何记录。
            _record_silent_failure(
                "macro.resolve_session_stat_data", _stat_exc,
                session_id=getattr(env, "session_id", None),
            )
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

    # [A2] ST 1.18.0 变量宏命名兼容四件套
    # (variable-macros.js:119-136 hasvar / :267-284 hasglobalvar /
    #  :139-156 deletevar / :287-304 deleteglobalvar)。
    # 旧名 {{exists}}/{{delvar}} 保留不删（存量卡兼容）。
    if cmd == "hasvar" and args:
        key = args[0]
        for getter in [env._get_chat_var, env._get_user_var, env._get_global_var]:
            if getter(key) is not None:
                return "true"
        return "false"

    if cmd == "hasglobalvar" and args:
        return "true" if env._get_global_var(args[0]) is not None else "false"

    if cmd == "deletevar" and args:
        env._delete_chat_var(args[0])
        return ""

    if cmd == "deleteglobalvar" and args:
        env._delete_global_var(args[0])
        return ""

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
            return datetime.now().strftime(fmt)
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


# ============================================================
# [A2] ST 1.18.0 条件块宏 {{if cond}}then{{else}}other{{/if}}
# （core-macros.js:130-225；块级求值，先于通用迭代宏求值）
# ============================================================

_IF_OPEN_RE = re.compile(r"\{\{\s*if\b", re.IGNORECASE)
_IF_CLOSE_RE = re.compile(r"\{\{\s*/\s*if\s*\}\}", re.IGNORECASE)
_ELSE_RE = re.compile(r"\{\{\s*else\s*\}\}", re.IGNORECASE)
# 变量简写 .name（getvar）/$name（getglobalvar），对齐 MacroLexer.js:26
# MACRO_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/
_VAR_SHORTHAND_RE = re.compile(r"^([.$])([a-zA-Z](?:[\w\-]*[\w])?)$")
# ST utils.js:1020-1022 isFalseBoolean
_FALSE_BOOLEAN = ("off", "false", "0")


def _scan_macro_head(text: str, start: int):
    """从 start（指向 '{{'）扫描到配对的 '}}'，跟踪内部 {{ }} 嵌套。

    返回 (head_end, inner)；未闭合返回 (start, None)。
    用于正确切出含嵌套宏的条件，如 {{if {{getvar::x}}}}。
    """
    depth = 0
    i = start
    n = len(text)
    while i < n - 1:
        two = text[i:i + 2]
        if two == "{{":
            depth += 1
            i += 2
            continue
        if two == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                return i, text[start + 2:i - 2]
            continue
        i += 1
    return start, None


def _split_if_args(body: str) -> list[str]:
    """按顶层 :: 拆分 if 宏参数（嵌套 {{...}} 内的 :: 不作分隔）。

    ST 配对规则（core-macros.js:113-115）：1 参数 = scoped 块形态（条件），
    2 参数 = 行内形态 {{if cond::content}}。等长掩码保持索引以精确切分。
    """
    if not body:
        return [""]
    masked_parts: list[str] = []
    depth = 0
    i = 0
    n = len(body)
    while i < n:
        two = body[i:i + 2]
        if two == "{{":
            depth += 1
            masked_parts.append("\x00\x00")
            i += 2
            continue
        if two == "}}" and depth > 0:
            depth -= 1
            masked_parts.append("\x00\x00")
            i += 2
            continue
        masked_parts.append("\x00" if depth > 0 else body[i])
        i += 1
    masked = "".join(masked_parts)
    seps = [j for j in range(n - 1) if masked[j:j + 2] == "::"]
    if not seps:
        return [body]
    parts: list[str] = []
    prev = 0
    for j in seps:
        parts.append(body[prev:j])
        prev = j + 2
    parts.append(body[prev:])
    return [p.strip() for p in parts]


def _eval_if_condition(raw_cond: str, env: "MacroEnv", depth: int) -> bool:
    """ST core-macros.js:159-193 条件求值（基础语义）。

    流程: ! 取反 → resolve 嵌套宏 → 变量简写 .name/$name → 裸零参简单宏名
    → falsy = 空串 或 isFalseBoolean("off"/"false"/"0")。
    不做 JS 表达式全量等价（计划 A2 拍板取舍）。
    """
    cond = raw_cond.strip()
    inverted = bool(re.match(r"^\s*!", cond))
    if inverted:
        cond = re.sub(r"^\s*!\s*", "", cond)
    if depth > 0:
        cond = evaluate_macros(cond, env, max_iterations=depth)
    m = _VAR_SHORTHAND_RE.match(cond)
    if m:
        macro = "getvar" if m.group(1) == "." else "getglobalvar"
        if depth > 0:
            cond = evaluate_macros("{{%s::%s}}" % (macro, m.group(2)), env, max_iterations=depth)
        else:
            cond = ""
    elif cond and " " not in cond and "{" not in cond and "}" not in cond:
        # 裸宏名（仅零参简单宏可解析，对齐 ST minArgs===0 判定 core-macros.js:185-188）
        simple = _resolve_simple_macro(cond, env)
        if simple is not None:
            cond = simple
    is_falsy = cond == "" or str(cond).strip().lower() in _FALSE_BOOLEAN
    if inverted:
        is_falsy = not is_falsy
    return not is_falsy


def _find_if_blocks(text: str) -> list[tuple[int, int, str, str, "str | None"]]:
    """收集文本中所有顶层 if 块（不递归内层块）。

    返回 (start, end, cond_raw, then_raw, else_raw_or_None)；
    分支文本保持原始形态（ST delayArgResolution：未选中分支不求值）。
    未闭合的 {{if 不消费、原样保留。仅 1 参数的 scoped if 参与配对深度
    （行内形态不影响配对，core-macros.js:113-115 同款规则）。
    """
    blocks: list[tuple[int, int, str, str, "str | None"]] = []
    pos = 0
    n = len(text)
    while pos < n:
        m = _IF_OPEN_RE.search(text, pos)
        if not m:
            break
        head_end, inner = _scan_macro_head(text, m.start())
        if inner is None:
            pos = m.end()
            continue
        body = re.sub(r"(?i)^if\b\s*", "", inner).strip()
        if not body:
            pos = head_end
            continue
        args = _split_if_args(body)
        if len(args) == 1:
            # scoped 形态: {{if cond}}...{{else}}...{{/if}}，配对扫描
            depth = 1
            j = head_end
            else_span: "tuple[int, int] | None" = None
            close_span: "tuple[int, int] | None" = None
            while j < n:
                events = []
                m_if = _IF_OPEN_RE.search(text, j)
                m_close = _IF_CLOSE_RE.search(text, j)
                m_else = _ELSE_RE.search(text, j)
                if m_if:
                    events.append((m_if.start(), "if", m_if))
                if m_close:
                    events.append((m_close.start(), "close", m_close))
                if m_else:
                    events.append((m_else.start(), "else", m_else))
                if not events:
                    break
                events.sort(key=lambda e: e[0])
                _, kind, ev = events[0]
                if kind == "close":
                    depth -= 1
                    if depth == 0:
                        close_span = (ev.start(), ev.end())
                        break
                    j = ev.end()
                elif kind == "if":
                    h2, inner2 = _scan_macro_head(text, ev.start())
                    if inner2 is not None:
                        b2 = re.sub(r"(?i)^if\b\s*", "", inner2).strip()
                        if b2 and len(_split_if_args(b2)) == 1:
                            depth += 1
                    j = h2 if inner2 is not None else ev.end()
                else:
                    # 只认最外层（depth==1）的第一个 else 为本块分支分割点
                    if depth == 1 and else_span is None:
                        else_span = (ev.start(), ev.end())
                    j = ev.end()
            if close_span is None:
                pos = m.end()
                continue
            body_start = head_end
            body_end = close_span[0]
            if else_span is not None:
                then_raw = text[body_start:else_span[0]]
                else_raw: "str | None" = text[else_span[1]:body_end]
            else:
                then_raw = text[body_start:body_end]
                else_raw = None
            blocks.append((m.start(), close_span[1], body, then_raw, else_raw))
            pos = close_span[1]
        elif len(args) == 2:
            # 行内形态: {{if cond::content}}（无 {{/if}} 配对；content 内
            # 取首个 {{else}} 做分支分割——低频形态不做嵌套深度跟踪）
            e = _ELSE_RE.search(args[1])
            if e:
                blocks.append((m.start(), head_end, args[0], args[1][:e.start()], args[1][e.end():]))
            else:
                blocks.append((m.start(), head_end, args[0], args[1], None))
            pos = head_end
        else:
            pos = head_end
    return blocks


def _process_if_blocks(text: str, env: "MacroEnv", depth: int) -> str:
    """块级求值全部 {{if}} 条件块（evaluate_macros Step 1.5 接入）。

    ST core-macros.js delayArgResolution 语义：条件先求值，只对选中分支
    做宏展开（未选分支的副作用宏不执行）；分支结果 strip（近似 ST
    trimContent，MacroCstWalker.js:55）。depth 递减传递防递归失控，
    轮数上限 10 保证收敛（每轮顶层块数单调减少）。
    """
    if depth <= 0:
        return text
    for _ in range(10):
        blocks = _find_if_blocks(text)
        if not blocks:
            break
        for start, end, cond_raw, then_raw, else_raw in reversed(blocks):
            truthy = _eval_if_condition(cond_raw, env, depth - 1)
            chosen = then_raw if truthy else else_raw
            if chosen is None:
                replacement = ""
            elif depth - 1 > 0:
                replacement = evaluate_macros(chosen, env, max_iterations=depth - 1).strip()
            else:
                replacement = chosen.strip()
            text = text[:start] + replacement + text[end:]
    return text


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

    # Step 1.5: [A2] {{if}}/{{else}}/{{/if}} 条件块块级求值
    # （ST core-macros.js:134-213，置于迭代求值前：未选分支的宏不展开，
    # delayArgResolution；块内残留宏由 Step 4 迭代继续处理。max_iterations
    # 递减传递防递归失控。）
    result = _process_if_blocks(result, env, max_iterations)

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
