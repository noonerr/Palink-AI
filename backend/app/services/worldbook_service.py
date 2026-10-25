"""WorldBook service - ST-grade engine (Phase 2).

Replaces the keyword-only backend pass with SillyTavern-like behavior:
- recursive scanning
- scan depth per entry
- primary/secondary keys with AND/OR/NOT logic
- probability
- ordering and priority
- token budget
- insertion position and depth injection
- sticky, cooldown, delay
- character/global/session worldbook layering
- debug report showing why each entry activated or skipped

MIN_ACTIVATIONS 状态机 (Phase E 已实现):
    ST 1.18.0 ``world-info.js:4991-5005`` 的 ``scan_state.MIN_ACTIVATIONS``
    状态机用于在激活条目数不足时扩展扫描深度继续扫描。该状态机依赖全局
    用户设置 ``world_info_min_activations`` (默认 0=关闭) 和
    ``world_info_min_activations_depth_max``。默认值 0 时状态机不激活，
    扫描行为与 ST 一致。

    实现要点 (``_recursive_scan``):
    1. ``min_activations > 0`` 时强制 ``max_depth=0``（禁用常规递归），
       对齐 ST world-info.js:6122-6125 (n!=0 → max_recursion_steps=0)。
    2. 常规扫描完成后，若激活条目数 < min，递增扫描深度继续扫描，
       上限为 ``min_activations_depth_max``（0 时回退到聊天长度）。
    3. ``min_activations=0``（默认）时行为与重构前完全一致。
    4. 即使 ``enable_recursive=False``，``min_activations>0`` 时仍走
       ``_recursive_scan`` 路径（ST 的 MIN_ACTIVATIONS 不依赖
       ``world_info_recursive``）。

    调用方 ``build_worldbook_context`` 透传 ``min_activations`` /
    ``min_activations_depth_max``，由 ``roleplay_prompt_assembly.py`` 从
    ``silly_tavern_settings["world_info_settings"]`` 读取。
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from ..core.silent_failure import record as _record_silent_failure

from ..models.worldbook import (
    WorldBook,
    WorldBookStage,
    WorldBookBlueprint,
    SessionWorldBook,
    SessionWorldBookEntryState,
    WorldBookEntryVector,
)
from ..models.character import CharacterChatSession, Character
from ..services.worldbook_import_utils import normalize_worldbook_position

logger = logging.getLogger(__name__)

# EJS/underscore 模板语法块（妈妈文学等卡片的常驻条目内容），后端无 JS 渲染器，
# 注入 prompt 前必须剥离，避免模板代码残骸进入模型上下文。
_EJS_BLOCK_RE = re.compile(r"<%(?:_|=|-|#|!)?[\s\S]*?%>", re.IGNORECASE)


def strip_template_syntax(text) -> str:
    """剥离 EJS/underscore 模板语法块（<%_ ... _%> / <% ... %> / <%= ... %> 等）。

    仅作用于注入文本；扫描匹配与 @@ 装饰器解析仍使用原始内容。
    剥离后清理多余空行，其余内容原样保留。
    """
    if not text:
        return ""
    cleaned = _EJS_BLOCK_RE.sub("", str(text))
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()

# 装饰器样孤行：单 token 的 @name / @@name 行（如卡侧控制器条目首行的
# @activate 残留标记）。平台装饰器语法是双 @@（见 _parse_decorators），
# 单 @ 全仓无消费方，两者都不构成实质注入文本。
_DECORATOR_LONE_LINE_RE = re.compile(r"^@{1,2}[A-Za-z_][A-Za-z0-9_]*$")
# 纯标点/空白行：不含任何字母、数字或汉字。
_PUNCT_ONLY_LINE_RE = re.compile(r"^[\W_]+$")


def _is_decoration_only(text: str) -> bool:
    """判断剥离模板后的条目内容是否已无实质文本。

    所有非空行都只是装饰器样孤行（@name / @@name 单 token 行）或纯标点/空白
    时视为空内容。口径刻意收窄：任何一行还带实质文本（哪怕 EJS 剥离后
    遗留的静态残骨架）即不算空、照常注入。
    """
    for line in (text or "").split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if _DECORATOR_LONE_LINE_RE.match(stripped):
            continue
        if _PUNCT_ONLY_LINE_RE.match(stripped):
            continue
        return False
    return True

# WorldInfoLogic constants
WI_LOGIC_AND_ANY = 0
WI_LOGIC_NOT_ALL = 1
WI_LOGIC_NOT_ANY = 2
WI_LOGIC_AND_ALL = 3

# WorldInfoPosition constants
WI_POS_BEFORE_CHAR = 0
WI_POS_AFTER_CHAR = 1
WI_POS_BEFORE_AN = 2
WI_POS_AFTER_AN = 3
WI_POS_AT_DEPTH = 4
WI_POS_EM_TOP = 5
WI_POS_EM_BOTTOM = 6
WI_POS_OUTLET = 7  # named outlet (entry.outlet_name)

DEFAULT_BUDGET = 16000
DEFAULT_SCAN_DEPTH = 4
DEFAULT_MAX_RECURSION = 5


def _estimate_tokens(text: str) -> int:
    """Estimate token count for worldbook budget calculation.

    Phase F: 优先使用 ST 对齐的 tokenizer 服务（按当前模型选择 tokenizer），
    回退到原有的 CJK+英文词数估算。

    当 ``roleplay_prompt_assembly`` 设置了当前模型 contextvar 时，
    使用对应的 tokenizer（tiktoken/sentencepiece/hf-tokenizers）进行精确计数；
    否则回退到原有的启发式估算（保持向后兼容）。
    """
    # Phase F: 当模型已设置时，使用 ST 对齐的 tokenizer 进行精确计数
    try:
        from .st_tokenizer_service import get_current_model, get_token_count
        model = get_current_model()
        if model:
            return get_token_count(str(text or ""), model)
    except Exception as _tok_exc:  # pragma: no cover - 极端情况下回退到旧逻辑
        # [SILENT-FAIL 2026-10-22] 热路径（逐条目估算），用 once=True 只写第一条日志。
        # 必须留痕：世界书的 token 预算与扫描深度判断全建立在这个估算上，
        # tokenizer 挂掉时预算会按 CJK 启发式算，命中条数会悄悄变少。
        _record_silent_failure("worldbook.estimate_tokens.st_tokenizer", _tok_exc, once=True)
    value = str(text or "")
    chinese_chars = len([ch for ch in value if "\u4e00" <= ch <= "\u9fff"])
    english_words = len([w for w in value.split() if any(c.isascii() and c.isalpha() for c in w)])
    return chinese_chars * 2 + english_words


@dataclass
class WorldbookEntryReport:
    entry_id: str
    title: str
    status: str
    reason: str = ""
    matched_keywords: list[str] = field(default_factory=list)
    tokens_estimate: int = 0
    # Enriched debug metadata (populated without altering core scan logic)
    recursion_depth: int = -1  # recursion depth at which the entry was evaluated
    position: Optional[int] = None  # final insertion position (WI_POS_*)
    probability_roll: Optional[int] = None  # actual probability roll (only set when rolled)
    # A1 修复: 条目级 useProbability 开关状态（None=旧数据/未评估）
    use_probability: Optional[bool] = None
    # [WB-CHAR-ISOLATION 2026-10-03] 条目所属书的 lore 来源
    # （chat/character/global）与书名——装配报告据此回答
    # "这条设定为什么会出现在这次提示词里"。post-process 填充。
    world_book_id: str = ""
    lore_source: str = ""
    book_name: str = ""


@dataclass
class WorldbookContextResult:
    text: Optional[str]
    debug_report: list[WorldbookEntryReport]
    total_tokens: int
    budget_used: int
    entries_by_position: dict[int, list[str]] = field(default_factory=dict)
    # G6 修复: depth_entries 现为三元组 (depth, content, role)
    # role: 0=system, 1=user, 2=assistant (默认 0)
    depth_entries: list[tuple[int, str, int]] = field(default_factory=list)
    em_top_entries: list[str] = field(default_factory=list)
    em_bottom_entries: list[str] = field(default_factory=list)
    outlet_entries: dict[str, list[str]] = field(default_factory=dict)
    # [WB-CHAR-ISOLATION 2026-10-03] 可见性：本轮注入了哪些书、每本什么来源。
    # world_book_id -> {"name": 书名, "source": chat/character/global, "type": 行类型}
    # 用户据此一眼看出"这书为什么进来了"，并决定是否改绑角色。
    book_sources: dict[str, dict] = field(default_factory=dict)


class TimedEffectsManager:
    def __init__(self, db: DBSession, session_id: str):
        self.db = db
        self.session_id = session_id
        self.sticky_to_cooldown_entries: set[str] = set()
        # E-3 修复: 请求级条目状态缓存（entry_id -> state），扫描前一次 SQL
        # 批量加载全部状态，消除每条目 2-3 次独立查询的 N+1 开销。
        # None 表示尚未加载；惰性加载后变为 dict。
        self._states_cache: Optional[dict[str, SessionWorldBookEntryState]] = None

    def _load_all_states(self) -> dict[str, SessionWorldBookEntryState]:
        """E-3 修复: 惰性批量加载本会话全部条目状态（1 次 SQL 替代逐条目查询）。"""
        if self._states_cache is None:
            states = (
                self.db.query(SessionWorldBookEntryState)
                .filter(SessionWorldBookEntryState.session_id == self.session_id)
                .all()
            )
            self._states_cache = {s.entry_id: s for s in states}
        return self._states_cache

    def get_state(self, entry_id: str) -> Optional[SessionWorldBookEntryState]:
        return self._load_all_states().get(entry_id)

    def can_activate(self, entry: WorldBookStage, message_index: int, chat_length: Optional[int] = None) -> bool:
        """检查条目是否可激活（不含关键词匹配层）。

        Bug #3 修复: ST 1.18.0 ``world-info.js:4733-4745`` 的判定顺序：
            1. ``isDelay`` → 跳过 (delay 优先级最高，无视 sticky)
            2. ``isCooldown && !isSticky`` → 跳过 (sticky 激活时 cooldown 被忽略)
            3. 其他情况 → 可进入关键词/sticky 强制激活判定

        D-1 修复（2026-08-23）: delay 改为 ST chat_length 绝对语义
        （``world-info.js:665-676`` ``#checkDelayEffect``）：
        ``entry.delay > 0 且 chat.length < entry.delay`` → 本轮抑制。
        无状态、无计数器，随聊天消息数增长自动解除。废弃旧「激活才初始化
        delay_remaining 计数」模型——该模型下 delay 条目被 can_activate 永久
        拦截、永远到不了 record_activation，整个会话不可激活（死锁）。
        """
        effective_chat_length = (
            chat_length if chat_length is not None else (message_index + 1)
        )
        if entry.delay and entry.delay > 0 and effective_chat_length < entry.delay:
            return False
        state = self.get_state(entry.id)
        if not state:
            return True
        # D-1 修复: delay 已改为 chat_length 绝对判定（见 docstring），
        # 旧 state.delay_remaining 计数不再消费；存量行残留值随 update_after_message
        # 不再递减、也不参与判定（列保留仅为 schema 兼容）。
        # Bug #3 修复: isCooldown && !isSticky → suppress
        is_sticky_active = (state.sticky_remaining or 0) > 0
        if (state.cooldown_remaining or 0) > 0 and not is_sticky_active:
            return False
        return True

    def is_sticky_active(self, entry: WorldBookStage) -> bool:
        """检查条目是否处于 sticky 激活期。

        Bug #3 修复: 用于在 ``_scan_entries`` 中实现 ST 1.18.0
        ``world-info.js:4787-4791`` 的 sticky 强制激活路径：
        当 ``sticky_remaining > 0`` 时条目无条件激活（跳过关键词匹配）。
        """
        state = self.get_state(entry.id)
        if not state:
            return False
        return (state.sticky_remaining or 0) > 0

    def record_activation(self, entry: WorldBookStage, message_index: int) -> None:
        state = self.get_state(entry.id)
        if not state:
            state = SessionWorldBookEntryState(
                session_id=self.session_id,
                entry_id=entry.id,
                sticky_remaining=entry.sticky or 0,
                cooldown_remaining=entry.cooldown or 0,
                # D-1 修复: delay 为 chat_length 绝对语义，不再落计数器
                delay_remaining=0,
                last_activated_message_index=message_index,
            )
            self.db.add(state)
            self._load_all_states()[entry.id] = state
        else:
            state.sticky_remaining = entry.sticky or 0
            state.cooldown_remaining = entry.cooldown or 0
            state.last_activated_message_index = message_index

    def reset_state(self, entry_id: str) -> None:
        """删除条目的会话状态，使其下一次扫描按全新状态参与判定。

        用于支持 ``@@reset`` 装饰器：在条目被处理时清空 sticky/cooldown/delay。
        """
        state = self.get_state(entry_id)
        if state:
            self.db.delete(state)
            self._load_all_states().pop(entry_id, None)

    def _get_entry(self, entry_id: str) -> Optional[WorldBookStage]:
        return (
            self.db.query(WorldBookStage)
            .filter(WorldBookStage.id == entry_id)
            .first()
        )

    def update_after_message(self) -> None:
        self.sticky_to_cooldown_entries.clear()
        # E-3 修复: 从缓存读取并快照，迭代期间不修改 dict（删除项循环后统一移除）
        states = list(self._load_all_states().values())
        expired_keys: list[str] = []
        for state in states:
            # D-1 修复: delay_remaining 不再递减——delay 为 chat_length 绝对语义，
            # 无需按消息递减的计数器（列保留仅为 schema 兼容）。
            if state.sticky_remaining and state.sticky_remaining > 0:
                state.sticky_remaining -= 1
                if state.sticky_remaining <= 0:
                    entry = self._get_entry(state.entry_id)
                    if entry and entry.cooldown and entry.cooldown > 0:
                        state.cooldown_remaining = entry.cooldown
                        self.sticky_to_cooldown_entries.add(state.entry_id)
                continue
            if state.cooldown_remaining and state.cooldown_remaining > 0:
                state.cooldown_remaining -= 1
            if (
                (not state.sticky_remaining or state.sticky_remaining <= 0)
                and (not state.cooldown_remaining or state.cooldown_remaining <= 0)
                and (not state.delay_remaining or state.delay_remaining <= 0)
            ):
                # [WB-STATE-FIX] 过期状态行不再删除：同一事务内对相同
                # (session_id, entry_id) 先 delete 后 insert 时，SQLAlchemy 的
                # flush 顺序是 insert 先于 delete → INSERT 撞上未删除的旧行 →
                # UniqueViolation → build_worldbook_context 抛异常 → 世界书注入
                # 失败 → 提示词缺世界书 → 模型空响应/思维链重复/变量输出不全
                # （2026-08-18 实锤：第二次对话起每次生成必挂 uq_session_entry_state）。
                # remaining 全 0 的过期行保留不影响语义（can_activate 判定可激活）。
                continue
        for key in expired_keys:
            self._load_all_states().pop(key, None)


def _parse_json_list(value) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return [str(k) for k in parsed if k is not None]
    except (json.JSONDecodeError, TypeError):
        return []


def _parse_extensions_json(entry: WorldBookStage) -> dict:
    """解析 WorldBookStage.extensions_json 为 dict；空/非法时返回空 dict。"""
    raw = getattr(entry, 'extensions_json', None)
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _parse_entities(entry: WorldBookStage) -> list:
    """从 extensions_json 提取 ST 1.18.0 ``entities`` 字段。

    ST 1.18.0 在世界书条目的 ``extensions.entities`` 中存储实体引用列表
    （字符串或对象数组），用于按实体过滤条目激活。返回原列表（未做字符串化），
    以便调用方按需进一步处理。
    """
    ext = _parse_extensions_json(entry)
    entities = ext.get('entities')
    if isinstance(entities, list):
        return entities
    return []


def _parse_bundle(entry: WorldBookStage) -> Optional[str]:
    """从 extensions_json 提取 ST 1.18.0 ``bundle`` 字段。

    ``bundle`` 为字符串标识符，用于将相关条目打包成一组（与 ``group`` 不同，
    bundle 用于组织呈现/导出）。返回 bundle 名称；未设置返回 None。
    """
    ext = _parse_extensions_json(entry)
    bundle = ext.get('bundle')
    if bundle is None:
        return None
    bundle = str(bundle).strip()
    return bundle or None


def _parse_match_chat_metadata(entry: WorldBookStage) -> bool:
    """从 extensions_json 提取 ST 1.18.0 ``match_chat_metadata`` 标志。

    为 True 时，条目的关键词匹配范围应包含会话的 ``chat_metadata``
    （如 note_prompt/variables/hidden_bots 等）。
    """
    ext = _parse_extensions_json(entry)
    return bool(ext.get('match_chat_metadata', False))


def _parse_decorators(content: str) -> dict:
    """解析条目内容中的装饰器（ST 兼容）。

    支持的装饰器：
    - @@activate：强制激活该条目（跳过关键词匹配）
    - @@dont_activate：强制跳过该条目
    - @@include <text>：标记要包含的内容（暂存，供调用方按需使用）
    - @@exclude：将该条目从激活结果中排除（与 @@dont_activate 类似，
      语义上更强：明确标记为“不参与”，便于调试区分）
    - @@reset：当条目被处理时重置其 sticky/cooldown/delay 状态，
      使其在下一次扫描中按全新状态参与判定
    - @@no_recall：条目仍可被激活（用于触发递归扫描），但其内容
      不会被加入到最终的上下文输出中
    """
    decorators = {
        'activate': False,
        'dont_activate': False,
        'include': None,
        'exclude': False,
        'reset': False,
        'no_recall': False,
    }

    if not content:
        return decorators

    for line in content.split('\n'):
        line = line.strip()
        if not line.startswith('@@'):
            continue
        if line == '@@activate':
            decorators['activate'] = True
        elif line == '@@dont_activate':
            decorators['dont_activate'] = True
        elif line.startswith('@@include '):
            decorators['include'] = line[len('@@include '):].strip()
        elif line == '@@exclude':
            decorators['exclude'] = True
        elif line == '@@reset':
            decorators['reset'] = True
        elif line == '@@no_recall':
            decorators['no_recall'] = True

    return decorators


# M-9 修复: 编译结果缓存改为有界 LRU（原无界 dict 会无限累积）。
# lru_cache 线程安全（to_thread 线程池并发访问可用）。
_REGEX_KEY_RE = re.compile(r"^/(.+)/([gimsuy]*)$")


@lru_cache(maxsize=1024)
def _compile_regex_key(key: str) -> Optional[re.Pattern]:
    result: Optional[re.Pattern] = None
    if key and key.startswith("/"):
        m = _REGEX_KEY_RE.match(key)
        if m:
            pattern_str, flags_str = m.group(1), m.group(2)
            flags = 0
            for f in flags_str:
                if f == "i":
                    flags |= re.IGNORECASE
                elif f == "m":
                    flags |= re.MULTILINE
                elif f == "s":
                    flags |= re.DOTALL
                elif f == "u":
                    flags |= re.UNICODE
            try:
                result = re.compile(pattern_str, flags)
            except re.error:
                result = None
    return result


def _match_key(haystack: str, needle: str, case_sensitive: bool, whole_words: bool) -> bool:
    """Check whether ``needle`` matches ``haystack`` using ST 1.18.0 semantics.

   修复点 (Bug #7): ST 1.18.0 ``world-info.js:347-360`` 使用 ``\\W`` 边界
    (非单词字符) 而非 Python ``\\b`` (Unicode word boundary)。Python ``\\b``
    会将中文字符视为 ``\\w``，导致中文关键词两侧无法形成边界，匹配失败。
    使用 ``(?:^|\\W)...(?:$|\\W)`` + ``re.ASCII`` 标志复刻 JS ``\\W`` 语义。

    修复点 (Bug #1 相关): 此函数仅做单关键词匹配，selectiveLogic 由调用方
    在 secondary keys 层应用（参考 ``world-info.js:4802-4810`` 的 primary
    ``find`` 行为与 ``4827-4866`` 的 secondary 逻辑分支）。

    ST 多词 key 行为 (``world-info.js:350-353``): ``keyWords.length > 1`` 时
    直接 ``includes`` 而非 word boundary。
    """
    if not needle or not haystack:
        return False
    regex = _compile_regex_key(needle)
    if regex is not None:
        return bool(regex.search(haystack))
    text = haystack
    key = needle
    if not case_sensitive:
        text = text.lower()
        key = key.lower()
    if whole_words:
        # ST 1.18.0: 多词 key 直接 includes，单词 key 用 \W 边界
        # (world-info.js:350-353)
        key_words = key.split()
        if len(key_words) > 1:
            return key in text
        # Bug #7 修复: \W (非单词字符) 边界匹配，re.ASCII 让 \W 等价 [^A-Za-z0-9_]
        # 这样中文字符被视为 \W，可在中文文本中形成边界
        pattern = r"(?:^|\W)(" + re.escape(key) + r")(?:$|\W)"
        flags = re.ASCII
        if not case_sensitive:
            flags |= re.IGNORECASE
        return bool(re.search(pattern, text, flags))
    return key in text


def _substitute_wi_key(key: str, char_name: str, user_name: str) -> str:
    """P1-14 修复: 对 WI key 进行轻量宏替换（对齐 ST 1.18.0 world-info.js substituteParams）。

    ST 在 WI key 匹配前会对 key 进行宏替换，使条目可以使用 {{char}} {{user}}
    等宏作为 key。例如 key="{{char}}" 在扫描时替换为当前角色名 "Alice"。

    此处只替换最常用的宏，完整宏替换由 macro_service.evaluate_macros 处理。
    避免引入完整 MacroEnv 依赖（WI 扫描是高频路径，需保持轻量）。
    """
    if not key or "{{" not in key:
        return key
    result = key
    # 基本宏替换（参考 ST 1.18.0 macros.js substituteParams 中的常见宏）
    replacements = {
        "{{char}}": char_name,
        "{{Char}}": char_name,
        "{{CHAR}}": char_name,
        "{{user}}": user_name,
        "{{User}}": user_name,
        "{{USER}}": user_name,
    }
    for macro, value in replacements.items():
        if macro in result:
            result = result.replace(macro, value or "")
    return result


def _match_primary_keys(
    entry: WorldBookStage,
    haystack: str,
    char_name: str = "",
    user_name: str = "",
    # C5 修复（批次 C）: 全局大小写敏感/全词匹配设置（entry 级 NULL 时继承）
    global_case_sensitive: bool = False,
    global_match_whole_words: bool = False,
) -> tuple[bool, list[str]]:
    """匹配 primary keys。

    Bug #1 修复: ST 1.18.0 ``world-info.js:4802-4810`` 中 primary keys 使用
    ``entry.key.find(key => matchKeys(...))`` —— 任意一个 primary key 匹配
    即激活（固定 AND_ANY 语义）。``selectiveLogic`` 只应用于 secondary keys
    (``world-info.js:4827-4866``)，不应在 primary 层应用。

    P1-14 修复: 匹配前对 key 进行宏替换（{{char}} {{user}} 等），对齐 ST
    ``world-info.js`` 中 ``substituteParams(key)`` 行为。
    """
    keys = _parse_json_list(entry.keys)
    if not keys:
        return False, []
    # C5 修复（批次 C）: ST entry.caseSensitive ?? world_info_case_sensitive
    # （world-info.js:269）、entry.matchWholeWords ?? world_info_match_whole_words
    # （:347）——条目级 NULL 继承全局设置；显式值优先。默认 False 保持存量行为。
    case_sensitive = entry.case_sensitive if entry.case_sensitive is not None else global_case_sensitive
    match_whole_words = entry.match_whole_words if entry.match_whole_words is not None else global_match_whole_words
    matches: list[str] = []
    for key in keys:
        # P1-14: 宏替换后再匹配
        expanded_key = _substitute_wi_key(key, char_name, user_name)
        if _match_key(haystack, expanded_key, case_sensitive, match_whole_words):
            matches.append(key)
    # ST primary keys 固定 AND_ANY: 任一匹配即通过
    return len(matches) > 0, matches


def _match_secondary_keys(
    entry: WorldBookStage,
    haystack: str,
    char_name: str = "",
    user_name: str = "",
    # C5 修复（批次 C）: 全局大小写敏感/全词匹配设置（entry 级 NULL 时继承）
    global_case_sensitive: bool = False,
    global_match_whole_words: bool = False,
) -> tuple[bool, list[str]]:
    """匹配 secondary keys 并应用 selectiveLogic。

    Bug #1 修复: ST 1.18.0 ``world-info.js:4827-4866`` 中 selectiveLogic
    应用在 secondary keys 层，支持 AND_ANY / NOT_ALL / NOT_ANY / AND_ALL
    四种逻辑，且对 AND_ANY / NOT_ALL 使用短路求值。

    - AND_ANY: 任一 secondary key 匹配即激活 (短路)
    - NOT_ALL: 任一 secondary key 不匹配即激活 (短路)
    - NOT_ANY: 全部 secondary key 不匹配才激活
    - AND_ALL: 全部 secondary key 匹配才激活

    P1-14 修复: 匹配前对 key 进行宏替换（{{char}} {{user}} 等）。
    """
    keys = _parse_json_list(entry.secondary_keys)
    if not keys:
        return True, []
    matches: list[str] = []
    logic = entry.selective_logic if entry.selective_logic is not None else WI_LOGIC_AND_ANY
    # C5 修复（批次 C）: 同 primary keys——条目级 NULL 继承全局设置
    case_sensitive = entry.case_sensitive if entry.case_sensitive is not None else global_case_sensitive
    match_whole_words = entry.match_whole_words if entry.match_whole_words is not None else global_match_whole_words

    # 短路求值需要边匹配边判断
    has_any_match = False
    has_all_match = True
    for key in keys:
        # P1-14: 宏替换后再匹配
        expanded_key = _substitute_wi_key(key, char_name, user_name)
        key_matched = _match_key(haystack, expanded_key, case_sensitive, match_whole_words)
        if key_matched:
            matches.append(key)
            has_any_match = True
            # AND_ANY 短路: 任一匹配即通过
            if logic == WI_LOGIC_AND_ANY:
                return True, matches
        else:
            has_all_match = False
            # NOT_ALL 短路: 任一不匹配即通过
            if logic == WI_LOGIC_NOT_ALL:
                return True, matches

    # 完成遍历后处理 NOT_ANY / AND_ALL / NOT_ALL
    if logic == WI_LOGIC_NOT_ANY:
        return not has_any_match, matches
    if logic == WI_LOGIC_AND_ALL:
        return has_all_match, matches
    if logic == WI_LOGIC_NOT_ALL:
        # NOT_ALL 短路未触发 → 全部匹配 → 不通过
        return False, matches
    # AND_ANY 兜底 (理论上已被短路返回)
    return has_any_match, matches


def _build_haystack(
    entry: WorldBookStage,
    recent_messages: list[dict],
    char: Optional[Character],
    chat_metadata: Optional[str] = None,
    persona_description: Optional[str] = None,
    group_chars: Optional[list] = None,
    # Phase E: ST 1.18.0 buffer.getDepth() 全局扫描深度（advanceScan 递增）。
    # 仅对未设置自定义 scan_depth 的条目生效（对齐 ST: entry.scanDepth ?? getDepth()）。
    # None 时回退 DEFAULT_SCAN_DEPTH（保持原有行为不变）。
    global_scan_depth: Optional[int] = None,
    # P2-10 修复: ST 1.18.0 world-info.js:289-291 recurseBuffer.
    # RECURSION 状态扫描时包含此 buffer（已激活条目的内容），
    # MIN_ACTIVATIONS 状态不包含（由调用方控制是否传入）。
    recurse_buffer: Optional[list[str]] = None,
    # C3 修复（批次 C）: ST world_info_include_names（world-info.js:74 默认 true，
    # script.js:4565）——True 时聊天消息按 "name: content" 拼入 haystack，
    # 使 "Alice:" 类带名字前缀的 key 可命中；False 时纯 content。
    include_names: bool = True,
) -> str:
    """构建条目匹配的文本池。

    Bug #2 修复: ST 1.18.0 ``world-info.js:299-301`` 中
    ``matchPersonaDescription`` 启用时，需将用户 active persona 的 description
    纳入 haystack。原实现遗漏此字段，导致 ``match_persona_description=True``
    的条目永远无法被关键词触发。
    persona_description 由调用方从 ``Persona`` 表查询后传入。
    """
    parts: list[str] = []
    # Phase E: 对齐 ST world-info.js:280 `let depth = entry.scanDepth ?? this.getDepth()`
    # entry.scan_depth (自定义) 优先；未设置时用 global_scan_depth (MIN_ACTIVATIONS 状态机
    # 递增的全局深度)，再回退 DEFAULT_SCAN_DEPTH (保持原有默认行为)。
    if entry.scan_depth is not None:
        depth = entry.scan_depth
    elif global_scan_depth is not None:
        depth = global_scan_depth
    else:
        depth = DEFAULT_SCAN_DEPTH
    recent = recent_messages[-depth:] if len(recent_messages) >= depth else recent_messages
    # C3 修复（批次 C）: include_names=True 时消息按 "name: content" 拼接
    # （ST script.js:4565 `${x.name}: ${x.mes}`）；消息无 name 字段时退化为
    # 纯 content（存量消息结构零突变）。
    if include_names:
        for m in recent:
            _name = str(m.get("name") or "").strip()
            _content = str(m.get("content", ""))
            parts.append(f"{_name}: {_content}" if _name else _content)
    else:
        parts.extend(str(m.get("content", "")) for m in recent)

    # Feature: match_chat_metadata (ST 1.18.0) - 将会话 chat_metadata 纳入匹配范围
    if chat_metadata and _parse_match_chat_metadata(entry):
        try:
            md = json.loads(chat_metadata) if isinstance(chat_metadata, str) else chat_metadata
            if isinstance(md, dict):
                # 将可序列化值拼接成可搜索文本（变量、note 等）
                md_text = json.dumps(md, ensure_ascii=False, sort_keys=True)
                parts.append(md_text)
        except (json.JSONDecodeError, TypeError):
            # 非法 JSON 时退化为原字符串
            parts.append(str(chat_metadata))

    # Bug #2 修复: matchPersonaDescription - 用户 active persona 描述
    if entry.match_persona_description and persona_description:
        parts.append(persona_description)

    if char:
        if entry.match_character_description and char.description:
            parts.append(char.description)
        if entry.match_character_personality and char.personality:
            parts.append(char.personality)
        if entry.match_character_depth_prompt and char.extensions:
            try:
                ext = json.loads(char.extensions) if isinstance(char.extensions, str) else char.extensions
                if isinstance(ext, dict):
                    dp = ext.get("depth_prompt", {})
                    if isinstance(dp, dict) and dp.get("prompt"):
                        parts.append(dp["prompt"])
            except (json.JSONDecodeError, TypeError):
                pass
        if entry.match_scenario and char.scenario:
            parts.append(char.scenario)
        if entry.match_creator_notes and char.creator_notes:
            parts.append(char.creator_notes)

    # E1 修复: 群聊 per-member 世界书（ST world_info_character_strategy='all'/'group'）。
    # 将所有启用成员的 description/personality/depth_prompt/scenario/creator_notes
    # 并入 haystack（受同一 match_* 标志门控），使群成员字段也能触发 WI 条目。
    if group_chars:
        for gc in group_chars:
            if gc is None or not hasattr(gc, "description"):
                continue
            if entry.match_character_description and gc.description:
                parts.append(gc.description)
            if entry.match_character_personality and gc.personality:
                parts.append(gc.personality)
            if entry.match_character_depth_prompt and gc.extensions:
                try:
                    ext = json.loads(gc.extensions) if isinstance(gc.extensions, str) else gc.extensions
                    if isinstance(ext, dict):
                        dp = ext.get("depth_prompt", {})
                        if isinstance(dp, dict) and dp.get("prompt"):
                            parts.append(dp["prompt"])
                except (json.JSONDecodeError, TypeError):
                    pass
            if entry.match_scenario and gc.scenario:
                parts.append(gc.scenario)
            if entry.match_creator_notes and gc.creator_notes:
                parts.append(gc.creator_notes)

    # P2-10 修复: ST 1.18.0 world-info.js:289-291 recurseBuffer
    # RECURSION 状态扫描时包含递归 buffer（已激活条目的内容），
    # 使后续条目能通过这些内容被触发（关键词在条目内容中而非聊天消息中的场景）。
    # MIN_ACTIVATIONS 状态由调用方不传入 recurse_buffer 来排除（对齐 ST 行为）。
    if recurse_buffer:
        parts.extend(recurse_buffer)

    return "\n".join(parts)


def _scan_entries(
    entries: list[WorldBookStage],
    recent_messages: list[dict],
    char: Optional[Character],
    timed_mgr: Optional[TimedEffectsManager],
    message_index: int,
    visited: set[str],
    recursion_depth: int,
    report: list[WorldbookEntryReport],
    trigger_type: Optional[str] = None,
    character_name: str = '',
    character_tags: Optional[list[str]] = None,
    chat_metadata: Optional[str] = None,
    persona_description: Optional[str] = None,
    group_chars: Optional[list] = None,
    # Phase E: 透传给 _build_haystack 的全局扫描深度
    global_scan_depth: Optional[int] = None,
    # P2-10 修复: 透传给 _build_haystack 的递归 buffer（RECURSION 状态使用）
    recurse_buffer: Optional[list[str]] = None,
    # D-1 修复: ST chat.length 绝对语义的聊天消息总数
    # （world-info.js:665-676；None 时回退 len(recent_messages)）
    chat_length: Optional[int] = None,
    # V-2 (2026-08-25): vectorized 接线——开关开启时 vectorized 条目不参与
    # 关键词扫描，命中向量检索的直接激活，未命中的不注入（对齐 ST 语义）。
    # 开关关闭时整段旁路，vectorized 列被完全忽略（存量零突变）。
    # P3 (2026-09-29): vector_degraded_books = 本轮检索不可信的书集合，
    # 其中有关键词的条目回退关键词匹配，不再静默消失。
    vectorized_enabled: bool = False,
    vector_hits: Optional[dict[str, float]] = None,
    vector_degraded_books: Optional[set[str]] = None,
    # C3 修复（批次 C）: 透传给 _build_haystack 的 include_names
    include_names: bool = True,
    # C5 修复（批次 C）: 全局大小写敏感/全词匹配（entry 级 NULL 继承）
    global_case_sensitive: bool = False,
    global_match_whole_words: bool = False,
) -> list[WorldBookStage]:
    activated: list[WorldBookStage] = []
    # Remember where this call's reports begin, so we can enrich them with
    # recursion_depth and insertion position after the scan loop completes.
    report_start = len(report)
    _entry_position_map = {e.id: e.position for e in entries}

    for entry in entries:
        if entry.id in visited:
            continue
        if entry.enabled is False:
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason="disabled",
                )
            )
            continue
        # A3 修复: ST world-info.js 中 preventRecursion 不在扫描阶段跳过条目，
        # 仅排除其自身内容进入其他条目的递归扫描 buffer；条目本身正常激活注入
        # （排除点见 _recursive_scan 的 new_content_parts / recurse_buffer_parts 收集处）。

        # Feature: delay_until_recursion - skip entry until recursion depth reaches N
        delay_until = entry.delay_until_recursion or 0
        if delay_until > 0 and recursion_depth < delay_until:
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason=f"delay_until_recursion={delay_until},current={recursion_depth}",
                )
            )
            continue

        # P3 对齐（2026-08-23）: ST world-info.js:4758-4760 — RECURSION 轮跳过
        # exclude_recursion 条目（sticky 激活期豁免）。INITIAL 轮不受影响；
        # ST 中该检查位于 constant 分支（:4781）之前，故 constant 条目同样被抑制。
        if recursion_depth > 0 and entry.exclude_recursion:
            if not (timed_mgr and timed_mgr.is_sticky_active(entry)):
                report.append(
                    WorldbookEntryReport(
                        entry_id=entry.id,
                        title=entry.title or "",
                        status="skipped",
                        reason="exclude_recursion",
                    )
                )
                continue

        # Feature: triggers - filter by generation type
        triggers = _parse_json_list(entry.triggers)
        if triggers and trigger_type and trigger_type not in triggers:
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason=f"trigger_mismatch:{trigger_type}",
                )
            )
            continue

        # Feature: characterFilter - 按角色 names/tags 过滤
        char_filter = _parse_json_list(entry.character_filter)
        if char_filter:
            current_char_name = character_name or ''
            current_char_tags = character_tags or []
            if current_char_name not in char_filter and not any(
                tag in char_filter for tag in current_char_tags
            ):
                report.append(
                    WorldbookEntryReport(
                        entry_id=entry.id,
                        title=entry.title or "",
                        status="skipped",
                        reason="character_filter_mismatch",
                    )
                )
                continue

        if timed_mgr and not timed_mgr.can_activate(entry, message_index, chat_length=chat_length):
            state = timed_mgr.get_state(entry.id)
            reason_parts: list[str] = []
            # D-1 修复: delay 原因为 chat_length 绝对判定（非状态行计数）
            if entry.delay and entry.delay > 0:
                _eff_len = chat_length if chat_length is not None else len(recent_messages)
                if _eff_len < entry.delay:
                    reason_parts.append(f"delay={entry.delay},chat_length={_eff_len}")
            if state:
                if state.cooldown_remaining and state.cooldown_remaining > 0:
                    reason_parts.append(f"cooldown={state.cooldown_remaining}")
                    if entry.id in timed_mgr.sticky_to_cooldown_entries:
                        reason_parts.append("sticky_to_cooldown")
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason="timed_effect:" + ",".join(reason_parts) if reason_parts else "timed_effect",
                )
            )
            continue

        # Feature: decorators - 解析内容中的 @@activate / @@dont_activate / @@exclude / @@reset 装饰器
        decorators = _parse_decorators(entry.content or '')
        # @@reset：清空条目状态，使其按全新状态参与后续判定
        if decorators.get('reset') and timed_mgr:
            timed_mgr.reset_state(entry.id)
        # @@dont_activate / @@exclude：强制跳过该条目
        if decorators.get('dont_activate') or decorators.get('exclude'):
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason="decorator_exclude" if decorators.get('exclude') else "decorator_dont_activate",
                )
            )
            continue
        if decorators.get('activate'):
            activated.append(entry)
            visited.add(entry.id)
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="activated",
                    reason="decorator_activate",
                    tokens_estimate=_estimate_tokens(entry.content),
                )
            )
            if timed_mgr:
                timed_mgr.record_activation(entry, message_index)
            continue

        if entry.constant:
            activated.append(entry)
            visited.add(entry.id)
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="activated",
                    reason="constant",
                    tokens_estimate=_estimate_tokens(entry.content),
                )
            )
            if timed_mgr:
                timed_mgr.record_activation(entry, message_index)
            continue

        # Bug #3 修复: ST 1.18.0 world-info.js:4787-4791 sticky 强制激活路径
        # 当 sticky_remaining > 0 时条目无条件激活，跳过关键词匹配
        # (can_activate 已确保 sticky 激活时 cooldown 不阻断进入此处)
        if timed_mgr and timed_mgr.is_sticky_active(entry):
            activated.append(entry)
            visited.add(entry.id)
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="activated",
                    reason="sticky_active",
                    tokens_estimate=_estimate_tokens(entry.content),
                )
            )
            # 续期 sticky (与 ST 行为一致: 每次激活刷新 sticky 计时)
            if timed_mgr:
                timed_mgr.record_activation(entry, message_index)
            continue

        # V-2 (2026-08-25) / P3 (2026-09-29): vectorized 条目被向量库接管——
        # 开关开启时不再参与常规关键词扫描（对齐 ST）。命中向量检索 → 跳过
        # 关键词匹配直接激活（后续 budget/decorators/group_scoring 管线天然
        # 复用）；未命中 → 不注入。开关关闭时不进入此分支，vectorized 列被
        # 完全忽略（存量零突变）。
        # P3 降级回退（SPEC §3）：该书本轮检索不可信（degraded_books 标记）
        # 且条目有一级关键词时，不按"未命中"吞掉，而是回退下方常规关键词
        # 匹配——嵌入服务挂掉/向量未就绪时，有关键词的条目仍按老规矩工作。
        _p3_degraded_fallback = False
        if vectorized_enabled and entry.vectorized:
            score = (vector_hits or {}).get(entry.id)
            if score is None:
                _wb_id = getattr(entry, "world_book_id", None)
                _degraded = _wb_id is not None and _wb_id in (vector_degraded_books or set())
                if _degraded and _parse_json_list(entry.keys):
                    # P3: 降级回退——不 continue，落入下方常规关键词匹配管线
                    _p3_degraded_fallback = True
                else:
                    report.append(
                        WorldbookEntryReport(
                            entry_id=entry.id,
                            title=entry.title or "",
                            status="skipped",
                            reason=(
                                "vectorized_degraded_no_keywords"
                                if _degraded
                                else "vectorized_no_match"
                            ),
                        )
                    )
                    continue
            else:
                activated.append(entry)
                visited.add(entry.id)
                report.append(
                    WorldbookEntryReport(
                        entry_id=entry.id,
                        title=entry.title or "",
                        status="activated",
                        reason=f"vectorized_hit(score={score:.4f})",
                        tokens_estimate=_estimate_tokens(entry.content),
                    )
                )
                if timed_mgr:
                    timed_mgr.record_activation(entry, message_index)
                continue

        haystack = _build_haystack(entry, recent_messages, char, chat_metadata=chat_metadata, persona_description=persona_description, group_chars=group_chars, global_scan_depth=global_scan_depth, recurse_buffer=recurse_buffer, include_names=include_names)
        # P1-14: 传入 char_name/user_name 用于 key 宏替换
        wi_char_name = character_name or (char.name if char else "")
        wi_user_name = ""  # _scan_entries 当前签名无 user_name 参数，留空回退
        primary_ok, primary_matches = _match_primary_keys(entry, haystack, char_name=wi_char_name, user_name=wi_user_name, global_case_sensitive=global_case_sensitive, global_match_whole_words=global_match_whole_words)
        if not primary_ok:
            report.append(
                WorldbookEntryReport(
                    entry_id=entry.id,
                    title=entry.title or "",
                    status="skipped",
                    reason="primary_keys_mismatch",
                )
            )
            continue

        if entry.selective:
            sec_ok, sec_matches = _match_secondary_keys(entry, haystack, char_name=wi_char_name, user_name=wi_user_name, global_case_sensitive=global_case_sensitive, global_match_whole_words=global_match_whole_words)
            if not sec_ok:
                report.append(
                    WorldbookEntryReport(
                        entry_id=entry.id,
                        title=entry.title or "",
                        status="skipped",
                        reason="secondary_keys_mismatch",
                    )
                )
                continue
            matched = list(set(primary_matches + sec_matches))
        else:
            matched = primary_matches

        prob = entry.probability if entry.probability is not None else 100
        # A1 修复: ST entry.useProbability — False 时无视 probability 必现；
        # True（含旧数据 None 回退）时按现行 probability% 滚动逻辑不变。
        use_prob = entry.use_probability if entry.use_probability is not None else True
        if use_prob and prob < 100:
            # Roll only when a probability gate is active. Kept inside the
            # `prob < 100` branch to preserve RNG consumption (short-circuit
            # equivalence with the previous `prob < 100 and random()...` form).
            roll = random.random() * 100
            if roll >= prob:
                report.append(
                    WorldbookEntryReport(
                        entry_id=entry.id,
                        title=entry.title or "",
                        status="skipped",
                        reason=f"probability={prob}%,roll={int(roll)}",
                        probability_roll=int(roll),
                        use_probability=use_prob,
                    )
                )
                continue

        activated.append(entry)
        visited.add(entry.id)
        report.append(
            WorldbookEntryReport(
                entry_id=entry.id,
                title=entry.title or "",
                status="activated",
                # P3: 降级回退的条目在 report 里如实标注，与常规 keyword_match 区分
                reason=(
                    "vectorized_degraded_keyword_fallback"
                    if _p3_degraded_fallback
                    else "keyword_match"
                ),
                matched_keywords=matched,
                tokens_estimate=_estimate_tokens(entry.content),
                use_probability=use_prob,
            )
        )
        if timed_mgr:
            timed_mgr.record_activation(entry, message_index)

    # Enrich reports created during this scan pass with recursion depth and
    # the entry's insertion position. Pure metadata; does not alter decisions.
    for _r in report[report_start:]:
        _r.recursion_depth = recursion_depth
        _r.position = _entry_position_map.get(_r.entry_id)

    return activated


def _recursive_scan(
    entries: list[WorldBookStage],
    recent_messages: list[dict],
    char: Optional[Character],
    timed_mgr: Optional[TimedEffectsManager],
    message_index: int,
    max_depth: int = DEFAULT_MAX_RECURSION,
    trigger_type: Optional[str] = None,
    character_name: str = '',
    character_tags: Optional[list[str]] = None,
    chat_metadata: Optional[str] = None,
    persona_description: Optional[str] = None,
    group_chars: Optional[list] = None,
    # Phase E 修复: ST 1.18.0 MIN_ACTIVATIONS 状态机 (world-info.js:4991-5005)
    min_activations: int = 0,
    min_activations_depth_max: int = 0,
    # D-1 修复: ST chat.length 绝对语义（透传给 _scan_entries → can_activate）
    chat_length: Optional[int] = None,
    # A4 修复: ST world_info_depth 全局扫描深度（设置层默认对齐 ST=2）。
    # 仅对未设置自定义 scan_depth 的条目生效（entry.scanDepth ?? getDepth()）；
    # None 时回退 DEFAULT_SCAN_DEPTH（既有行为，存量直接调用方不受影响）。
    global_scan_depth: Optional[int] = None,
    # V-2 (2026-08-25): vectorized 接线参数，透传给每轮 _scan_entries
    # P3 (2026-09-29): degraded_books 同路透传（检索不可信的书 → 关键词回退）
    vectorized_enabled: bool = False,
    vector_hits: Optional[dict[str, float]] = None,
    vector_degraded_books: Optional[set[str]] = None,
    # C3/C5 修复（批次 C）: include_names 与全局匹配开关，透传给每轮 _scan_entries
    include_names: bool = True,
    global_case_sensitive: bool = False,
    global_match_whole_words: bool = False,
) -> tuple[list[WorldBookStage], list[WorldbookEntryReport]]:
    """递归扫描世界书条目，对齐 ST 1.18.0 scan_state 状态机。

    ST 状态机: INITIAL → RECURSION → MIN_ACTIVATIONS → NONE
    - 当 ``min_activations > 0`` 时强制 ``max_depth=0``（禁用常规递归），
      对齐 ST world-info.js:6122-6125 (min_activations!=0 → max_recursion=0)。
    - 常规递归完成后，若激活条目数 < ``min_activations``，递增全局扫描深度
      (``global_scan_depth``，等价 ST ``buffer.advanceScan()``) 继续扫描，
      让未设置自定义 ``scan_depth`` 的条目看到更多聊天历史从而可能匹配新关键词。
      上限 ``min_activations_depth_max`` 或聊天长度，对齐 :4991-5005。
    - MIN_ACTIVATIONS 阶段**不追加递归内容**（ST world-info.js:322-325 明确
      排除 recurseBuffer），仅扩展聊天历史扫描范围。
    - ``min_activations=0``（默认）时行为与重构前完全一致。
    - P2-10 修复: MIN_ACTIVATIONS→RECURSION 回退。MIN_ACTIVATIONS 完成后，
      已激活条目的内容进入递归 buffer，ST 转换到 RECURSION 状态扫描 buffer，
      可能触发更多条目（关键词在条目内容中而非聊天消息中的场景）。
    """
    visited: set[str] = set()
    report: list[WorldbookEntryReport] = []
    all_activated: list[WorldBookStage] = []
    current_depth = 0

    # Phase E: min_activations>0 时强制 max_depth=0（ST world-info.js:6122-6125）
    effective_max_depth = 0 if min_activations > 0 else max_depth

    # ── 常规递归扫描 (INITIAL → RECURSION) ──
    while current_depth < effective_max_depth:
        activated = _scan_entries(
            entries,
            recent_messages,
            char,
            timed_mgr,
            message_index,
            visited,
            current_depth,
            report,
            trigger_type,
            character_name,
            character_tags,
            chat_metadata,
            persona_description,
            group_chars,
            chat_length=chat_length,
            global_scan_depth=global_scan_depth,
            vectorized_enabled=vectorized_enabled,
            vector_hits=vector_hits,
            vector_degraded_books=vector_degraded_books,
            include_names=include_names,
            global_case_sensitive=global_case_sensitive,
            global_match_whole_words=global_match_whole_words,
        )
        if not activated:
            break

        # Collect new content for recursive scanning
        # A3 修复: prevent_recursion 条目内容不进入递归匹配源（对齐 ST）
        new_content_parts: list[str] = []
        for e in activated:
            if not e.exclude_recursion and not e.prevent_recursion and e.content:
                new_content_parts.append(e.content)

        if not new_content_parts:
            all_activated.extend(activated)
            break

        all_activated.extend(activated)
        recent_messages = list(recent_messages)
        recent_messages.append({"role": "system", "content": "\n".join(new_content_parts)})
        current_depth += 1

    # ── MIN_ACTIVATIONS 状态机 (world-info.js:4991-5005) ──
    # 常规扫描完成后，若 min_activations>0 且激活数不足，递增全局扫描深度继续扫描。
    # ST 行为: buffer.advanceScan() 扩展聊天历史范围（getDepth = world_info_depth + skew），
    # 让未设置自定义 scanDepth 的条目看到更多聊天消息从而可能匹配新关键词。
    # 关键: MIN_ACTIVATIONS 不追加递归内容（world-info.js:322-325 明确排除 recurseBuffer）。
    #
    # Bug #E2 修复: ST 1.18.0 world-info.js:4747-4761 中 MIN_ACTIVATIONS 状态**不是**
    # RECURSION 状态。ST 的 scanState 判定：
    #   - ``scanState !== RECURSION && delayUntilRecursion && !isSticky`` → 跳过
    #     (MIN_ACTIVATIONS 期间 delayUntilRecursion 条目仍被跳过)
    #   - ``scanState === RECURSION && excludeRecursion && !isSticky`` → 跳过
    #     (MIN_ACTIVATIONS 期间 excludeRecursion 条目**不**被跳过)
    #   - ``preventRecursion`` 不在扫描阶段跳过条目，仅排除其内容进入递归 buffer
    #     (MIN_ACTIVATIONS 期间 preventRecursion 条目应正常激活)
    # 因此 MIN_ACTIVATIONS 扫描必须传 ``recursion_depth=0``（等价 scanState !== RECURSION），
    # 不能递增 current_depth。原实现递增 current_depth 导致 prevent_recursion 条目
    # 被错误跳过，与 ST 行为不一致。
    if min_activations > 0:
        # MIN_ACTIVATIONS 始终使用 recursion_depth=0（非 RECURSION 状态）
        ma_recursion_depth = 0
        # 初次扫描（depth=0）若 effective_max_depth=0 时未执行过
        # 不追加递归内容（max_recursion_steps 已强制为 0）
        if effective_max_depth == 0 and current_depth == 0:
            activated = _scan_entries(
                entries, recent_messages, char, timed_mgr, message_index,
                visited, ma_recursion_depth, report, trigger_type,
                character_name, character_tags, chat_metadata,
                persona_description, group_chars,
                global_scan_depth=(
                    global_scan_depth if global_scan_depth is not None else DEFAULT_SCAN_DEPTH
                ),
                chat_length=chat_length,
                vectorized_enabled=vectorized_enabled,
                vector_hits=vector_hits,
                include_names=include_names,
                global_case_sensitive=global_case_sensitive,
                global_match_whole_words=global_match_whole_words,
            )
            if activated:
                all_activated.extend(activated)
            current_depth = 1

        # MIN_ACTIVATIONS 扩展循环: 递增 global_scan_depth (advanceScan) 继续扫描
        # 不追加递归内容（ST MIN_ACTIVATIONS 排除 recurseBuffer）
        # recursion_depth 始终为 0（MIN_ACTIVATIONS ≠ RECURSION）
        #
        # Bug #P2-10 修复: 原实现在 `if not activated: break` 处提前退出，
        # 导致远距离关键词（需要更大深度才能看到）永远无法被激活。
        # ST 的 advanceScan 会持续递增深度，即使当前深度未找到新条目，
        # 更深的扫描可能看到更多聊天历史从而匹配新关键词。
        # 循环终止条件由 depth_max / chat_length / min_activations 三重保证。
        _ma_chat_length = len(recent_messages)
        current_global_depth = (
            global_scan_depth if global_scan_depth is not None else DEFAULT_SCAN_DEPTH
        )
        while len(all_activated) < min_activations:
            current_global_depth += 1  # buffer.advanceScan()
            # ST over_max 检查 (world-info.js:4995-4998):
            #   (n_depth_max > 0 && getDepth() > n_depth_max) || (getDepth() > chat.length)
            if min_activations_depth_max > 0 and current_global_depth > min_activations_depth_max:
                break
            if current_global_depth > _ma_chat_length:
                break
            activated = _scan_entries(
                entries, recent_messages, char, timed_mgr, message_index,
                visited, ma_recursion_depth, report, trigger_type,
                character_name, character_tags, chat_metadata,
                persona_description, group_chars,
                global_scan_depth=current_global_depth,
                chat_length=chat_length,
                vectorized_enabled=vectorized_enabled,
                vector_hits=vector_hits,
                include_names=include_names,
                global_case_sensitive=global_case_sensitive,
                global_match_whole_words=global_match_whole_words,
            )
            if activated:
                all_activated.extend(activated)
            # 不 break：即使当前深度未找到新条目，更深的扫描可能匹配
            # 不递增 ma_recursion_depth：MIN_ACTIVATIONS 不是 RECURSION 状态

    # ── P2-10 修复: MIN_ACTIVATIONS→RECURSION 回退 (world-info.js scan_state) ──
    # ST 1.18.0 状态机: MIN_ACTIVATIONS 找到新条目后，其内容进入 recurseBuffer，
    # ST 转换到 RECURSION 状态扫描 recurseBuffer，可能触发更多条目（关键词在
    # 条目内容中而非聊天消息中的场景）。原 Palink 实现缺少此回退，导致
    # MIN_ACTIVATIONS 找到的条目内容无法触发其他条目。
    #
    # 对齐 ST world-info.js:289-291:
    #   if (recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS)
    #       result += JOINER + recurseBuffer.join(JOINER)
    #
    # 注意: 虽然 ST 在 min_activations>0 时强制 max_recursion_steps=0（禁用
    # 常规 INITIAL→RECURSION 转换），但 MIN_ACTIVATIONS→RECURSION 是独立的状态
    # 转换路径，不受 max_recursion_steps 限制。此回退允许 MIN_ACTIVATIONS 期间
    # 找到的条目内容参与递归扫描，对齐 ST 行为。
    if min_activations > 0 and all_activated:
        # 收集所有已激活条目的内容（非 exclude_recursion / 非 prevent_recursion）作为递归 buffer
        # A3 修复: prevent_recursion 条目内容同样排除出递归匹配源（对齐 ST）
        recurse_buffer_parts: list[str] = []
        for e in all_activated:
            if not e.exclude_recursion and not e.prevent_recursion and e.content:
                recurse_buffer_parts.append(e.content)

        if recurse_buffer_parts:
            # RECURSION 回退扫描: 使用递归 buffer 扫描未访问的条目
            # recursion_depth=1（RECURSION 状态），使 delay_until_recursion=1
            # 的条目能被激活，exclude_recursion 条目被跳过（对齐 ST 行为）
            # 限制最多 DEFAULT_MAX_RECURSION 轮以防无限循环
            fallback_depth = 1
            while fallback_depth <= DEFAULT_MAX_RECURSION:
                new_activated = _scan_entries(
                    entries, recent_messages, char, timed_mgr, message_index,
                    visited, fallback_depth, report, trigger_type,
                    character_name, character_tags, chat_metadata,
                    persona_description, group_chars,
                    global_scan_depth=(
                        global_scan_depth if global_scan_depth is not None else DEFAULT_SCAN_DEPTH
                    ),
                    recurse_buffer=recurse_buffer_parts,
                    chat_length=chat_length,
                    vectorized_enabled=vectorized_enabled,
                    vector_hits=vector_hits,
                    vector_degraded_books=vector_degraded_books,
                    include_names=include_names,
                    global_case_sensitive=global_case_sensitive,
                    global_match_whole_words=global_match_whole_words,
                )
                if not new_activated:
                    break
                all_activated.extend(new_activated)
                # 追加新条目内容到递归 buffer（链式触发）
                # A3 修复: prevent_recursion 条目内容不参与链式追加
                for e in new_activated:
                    if not e.exclude_recursion and not e.prevent_recursion and e.content:
                        recurse_buffer_parts.append(e.content)
                fallback_depth += 1

    return all_activated, report


def _resolve_budget(
    budget_tokens,
    budget_cap: int,
    max_context_tokens: Optional[int],
    default_tokens: int,
) -> int:
    """Resolve effective budget tokens.

    - budget_tokens may be a percentage string ("10%") or a number/string of fixed tokens.
    - If percentage, compute from max_context_tokens (falls back to default_tokens).
    - If budget_cap > 0, apply min(result, budget_cap) as a hard upper limit.
    - If budget_tokens is unset/empty, fall back to default_tokens (existing behavior).
    """
    resolved = default_tokens

    if budget_tokens is not None and str(budget_tokens).strip() != "":
        bt = str(budget_tokens).strip()
        if bt.endswith("%"):
            try:
                pct = float(bt[:-1])
            except (ValueError, TypeError):
                pct = 0.0
            ctx_tokens = max_context_tokens if max_context_tokens and max_context_tokens > 0 else default_tokens
            resolved = int(ctx_tokens * (pct / 100.0))
        else:
            try:
                resolved = int(bt)
            except (ValueError, TypeError):
                resolved = default_tokens

    cap = budget_cap or 0
    if cap > 0 and resolved > cap:
        resolved = cap

    return max(0, resolved)


def _apply_budget(
    entries: list[WorldBookStage],
    max_tokens: int,
    report: list[WorldbookEntryReport],
) -> list[WorldBookStage]:
    """Apply token budget trimming with ST 1.18.0 ignoreBudget semantics.

    Bug #6 修复: ST 1.18.0 ``world-info.js:4898-4907, 4942`` 中
    ``ignoreBudget=True`` 的条目免受 token 预算截断：
    1. ignoreBudget 条目总是保留（不计入 used 预算）
    2. 非 ignoreBudget 条目按顺序填充预算
    3. 当非 ignoreBudget 条目导致超预算时，标记 token_budget_overflowed
    4. overflowed 后剩余的非 ignoreBudget 条目被 trimmed；ignoreBudget
       条目仍然保留
    """
    if not entries:
        return []

    result: list[WorldBookStage] = []
    used = 0
    token_budget_overflowed = False

    for entry in entries:
        # Bug #6: ignoreBudget 条目免预算
        if entry.ignore_budget:
            result.append(entry)
            continue

        # 非 ignoreBudget 条目：超预算则 trimmed
        if token_budget_overflowed:
            for r in report:
                if r.entry_id == entry.id and r.status == "activated":
                    r.status = "trimmed"
                    r.reason = "budget_exceeded"
            continue

        est = _estimate_tokens(entry.content)
        if used + est > max_tokens:
            token_budget_overflowed = True
            for r in report:
                if r.entry_id == entry.id and r.status == "activated":
                    r.status = "trimmed"
                    r.reason = f"budget_exceeded (est={est}, used={used}, max={max_tokens})"
            continue

        result.append(entry)
        used += est

    return result


def _resolve_vector_top_k(
    explicit: Optional[int] = None,
    settings_value: Optional[int] = None,
) -> int:
    """V-3/P1 (2026-09-29): top_k 解析优先级——显式参数 > world_info_settings.vector_top_k
    > env WI_VECTOR_TOP_K > 默认 3。

    P1（SPEC_世界书向量召回接通与防护 §3）: 默认从 5 收紧到 3，且 settings 层
    优先于 env（env 仅作兜底）。越界值钳制到 1~10。
    """
    if explicit is not None and explicit > 0:
        return int(explicit)
    if settings_value is not None:
        try:
            return max(1, min(10, int(settings_value)))
        except (TypeError, ValueError):
            pass
    try:
        value = int(os.getenv("WI_VECTOR_TOP_K", "3"))
        return max(1, min(10, value)) if value > 0 else 3
    except ValueError:
        return 3


def _resolve_vector_threshold(
    explicit: Optional[float] = None,
    settings_value: Optional[float] = None,
) -> float:
    """V-3/P1 (2026-09-29): 相似度阈值解析优先级——显式参数 >
    world_info_settings.vector_threshold > env WI_VECTOR_THRESHOLD > 默认 0.55。

    P1（SPEC §3）: 默认从 0.25 提到 0.55——本项目 bge-m3 实测无关查询
    top1=0.459、0.3 阈值下 77 条里 75 条过阈（memory_module/config.py
    MIN_SIMILARITY 注释），0.25 一旦开关打开就是"每轮无脑塞 5 条不相干设定"。
    世界书条目短、误召代价高，比记忆的 0.5 更保守。
    **换嵌入模型后必须重测校准，勿沿用此值。** 越界值钳制到 0~1。
    """
    if explicit is not None:
        return max(0.0, min(1.0, float(explicit)))
    if settings_value is not None:
        try:
            return max(0.0, min(1.0, float(settings_value)))
        except (TypeError, ValueError):
            pass
    try:
        value = float(os.getenv("WI_VECTOR_THRESHOLD", "0.55"))
        return max(0.0, min(1.0, value)) if 0.0 <= value <= 1.0 else 0.55
    except ValueError:
        return 0.55


def _read_vector_params_from_settings(
    db: DBSession,
    user_id: int,
) -> tuple[Optional[int], Optional[float]]:
    """P1 (2026-09-29): 从 ``silly_tavern_settings["world_info_settings"]`` 读取
    ``vector_top_k`` / ``vector_threshold``（优先级链中的 settings 层）。

    键缺失/非法返回 None，走 env 兜底。UserSetting 通常已被装配层在同一
    session 中加载过，此处走 SQLAlchemy identity map，不产生额外 SQL。
    任何异常只 warning，绝不阻塞装配。
    """
    try:
        from ..models import UserSetting

        us = db.query(UserSetting).filter(UserSetting.user_id == user_id).first()
        if us is None or not us.silly_tavern_settings:
            return None, None
        raw = (
            json.loads(us.silly_tavern_settings)
            if isinstance(us.silly_tavern_settings, str)
            else us.silly_tavern_settings
        )
        wis = raw.get("world_info_settings") if isinstance(raw, dict) else None
        if not isinstance(wis, dict):
            return None, None
        top_k: Optional[int] = None
        threshold: Optional[float] = None
        try:
            tk = wis.get("vector_top_k")
            if tk is not None and str(tk).strip() != "":
                top_k = int(tk)
        except (TypeError, ValueError):
            top_k = None
        try:
            tv = wis.get("vector_threshold")
            if tv is not None and str(tv).strip() != "":
                threshold = float(tv)
        except (TypeError, ValueError):
            threshold = None
        return top_k, threshold
    except Exception as exc:
        logger.warning("worldbook vector params settings read failed: %s", exc)
        return None, None


def _vector_query_text(recent_messages: list[dict]) -> str:
    """V-2: 以最近 4 条消息 content 拼接作为向量检索查询文本（截断至 ~2000 字符）。"""
    tail = [str(m.get("content") or "") for m in list(recent_messages)[-4:]]
    text = "\n".join(part for part in tail if part)
    return text[:2000]


# P2 (2026-09-29): 检索路径懒触发的后台同步——单飞去重（同一本书同一时刻最多一个线程）
_LAZY_SYNC_INFLIGHT: set[str] = set()
_LAZY_SYNC_LOCK = threading.Lock()


def _book_vectors_ready(svc, world_book_id: str) -> bool:
    """P2 (2026-09-29, SPEC §3): 该书向量是否就绪——向量行数 ≥ vectorized 条目数。

    只做两次计数（ORM 写法跨 SQLite/PG 方言），**不做内容哈希脏检查**：
    内容变更的收敛由书级 PUT / 导入的既有后台触发（api/worldbook.py
    _schedule_worldbook_vector_sync）负责，检索路径绝不做嵌入重活。
    表不存在 / 查询失败一律按未就绪处理（未就绪 → 降级 + 懒触发补齐）。
    """
    try:
        stage_count = (
            svc.db.query(WorldBookStage)
            .filter(
                WorldBookStage.world_book_id == world_book_id,
                WorldBookStage.vectorized.is_(True),
            )
            .count()
        )
        if stage_count == 0:
            return True
        vec_count = (
            svc.db.query(WorldBookEntryVector)
            .filter(
                WorldBookEntryVector.entry_id.in_(
                    svc.db.query(WorldBookStage.id).filter(
                        WorldBookStage.world_book_id == world_book_id,
                        WorldBookStage.vectorized.is_(True),
                    )
                )
            )
            .count()
        )
        return vec_count >= stage_count
    except Exception as exc:
        logger.warning(
            "worldbook vector readiness check failed (book=%s): %s", world_book_id, exc,
        )
        return False


def _fire_lazy_vector_sync(world_book_id: str) -> None:
    """P2: 检索路径懒触发的后台同步（daemon 线程 + 独立 SessionLocal，单飞去重）。

    全局开关经 API/直写打开（无 UI 时代）或绕过编辑 API 的写入导致书未就绪时，
    首轮检索在此补齐，下一轮生效；绝不阻塞当前对话轮。与 api/worldbook.py 的
    _fire_vector_sync 语义一致，但服务层没有事件循环，用普通 daemon 线程。
    """
    from ..core.database import SessionLocal
    from .worldbook_vector_service import WorldBookVectorService

    with _LAZY_SYNC_LOCK:
        if world_book_id in _LAZY_SYNC_INFLIGHT:
            return
        _LAZY_SYNC_INFLIGHT.add(world_book_id)

    def _worker(bid: str) -> None:
        try:
            WorldBookVectorService(SessionLocal()).sync_worldbook_vectors(bid)
        except Exception as exc:
            logger.warning("worldbook lazy background sync failed (book=%s): %s", bid, exc)
        finally:
            with _LAZY_SYNC_LOCK:
                _LAZY_SYNC_INFLIGHT.discard(bid)

    threading.Thread(
        target=_worker,
        args=(world_book_id,),
        daemon=True,
        name=f"wb-vec-sync-{world_book_id[:8]}",
    ).start()


def _collect_vector_hits(
    db: DBSession,
    entries: list[WorldBookStage],
    recent_messages: list[dict],
    top_k: Optional[int] = None,
    threshold: Optional[float] = None,
) -> tuple[dict[str, float], set[str]]:
    """V-2/P3 (2026-09-29): 对每本含 vectorized 条目的世界书执行向量检索。

    返回 ``({entry_id: score}, degraded_books)``。degraded_books 内的书，
    本轮检索结果**不可信**（向量未就绪/查询异常/查询文本为空），接管分支应
    对其中有关键词的条目回退关键词匹配，不得静默吞掉（SPEC §3 P3）——
    否则嵌入服务一挂，勾选了向量的设定就"既不关键词也不向量"地消失。

    P2 (2026-09-29, SPEC §3): 装配路径**零 sync、只查**——原"检索前懒同步
    整本书"会把首次开启的存量嵌入压在对话请求里。改为只做两次计数的就绪
    检测（_book_vectors_ready），未就绪 → 本轮按降级处理并懒触发后台同步
    （_fire_lazy_vector_sync，单飞去重），下一轮生效；任何失败均降级，
    绝不阻塞主对话。
    """
    books_with_vec: list[str] = []
    seen_books: set[str] = set()
    for entry in entries:
        wb_id = getattr(entry, "world_book_id", None)
        if getattr(entry, "vectorized", False) and wb_id and wb_id not in seen_books:
            seen_books.add(wb_id)
            books_with_vec.append(wb_id)
    if not books_with_vec:
        return {}, set()

    query_text = _vector_query_text(recent_messages)
    if not query_text.strip():
        # P3: 查询文本为空（开场首轮空消息等）→ 本轮检索做不了，按降级处理，
        # 让有关键词的条目走关键词匹配，而非被当成"真未命中"吞掉。
        return {}, set(books_with_vec)

    effective_top_k = _resolve_vector_top_k(top_k)
    effective_threshold = _resolve_vector_threshold(threshold)

    # [EMB-DEDUP 2026-10-07] 查询文本对所有书是同一份——嵌入**一次**，把向量
    # 传给每本书的 query_entries。原实现对每本书各嵌一遍（挂 N 本 vectorized
    # 书 = 每轮 N 次一模一样的嵌入调用）。嵌入失败/维度不符 → 全部书按 P3
    # 降级（回退关键词），与原先逐书失败的净效果一致。
    from ..memory_module.embedder import embed_text
    from ..memory_module.config import memory_config
    from .worldbook_vector_service import WorldBookVectorService, _flatten_embedding
    try:
        query_vec = _flatten_embedding(embed_text(query_text))
    except Exception as exc:
        logger.warning("worldbook vector query embedding failed (all books degraded): %s", exc)
        return {}, set(books_with_vec)
    if len(query_vec) != memory_config.VECTOR_DIMENSION:
        logger.warning(
            "worldbook vector query 维度 %s ≠ 声明 %s（嵌入器疑似降级），"
            "全部书本轮降级（P3 回退关键词）",
            len(query_vec), memory_config.VECTOR_DIMENSION,
        )
        return {}, set(books_with_vec)

    svc = WorldBookVectorService(db)
    hits: dict[str, float] = {}
    degraded_books: set[str] = set()
    for wb_id in books_with_vec:
        # P2: 就绪检测（两次计数）——未就绪 → 本轮降级 + 懒触发后台补齐。
        # 装配路径绝不调 sync_worldbook_vectors（嵌入重活不压在对话请求里）。
        if not _book_vectors_ready(svc, wb_id):
            degraded_books.add(wb_id)
            _fire_lazy_vector_sync(wb_id)
        try:
            book_hits, book_degraded = svc.query_entries(
                wb_id, query_text, top_k=effective_top_k, threshold=effective_threshold,
                query_vec=query_vec,
            )
            for entry_id, score in book_hits:
                # 多本书场景下同一 entry 只保留更高分
                if entry_id not in hits or score > hits[entry_id]:
                    hits[entry_id] = float(score)
            if book_degraded:
                degraded_books.add(wb_id)
        except Exception as exc:
            logger.warning("worldbook vector query degraded (book=%s): %s", wb_id, exc)
            degraded_books.add(wb_id)
    return hits, degraded_books


def _sort_by_insertion_strategy(
    activated: list[WorldBookStage],
    book_lore_source: dict[str, str],
    strategy: int,
) -> list[WorldBookStage]:
    """ST 1.18.0 ``getSortedEntries`` (world-info.js:4496-4513) — 插入排序策略。

    按世界书 lore 来源分层排序激活条目，对齐 ST 的
    ``world_info_character_strategy`` 设置：

    - **chatLore** 始终最前，**personaLore** 次之（world-info.js:4513）
    - ``strategy=0`` (evenly): character + global 合并后按 order 降序
    - ``strategy=1`` (character_first, **默认**): character 在前，global 在后，各自按 order 降序
    - ``strategy=2`` (global_first): global 在前，character 在后，各自按 order 降序

    ST ``sortFn = (a, b) => b.order - a.order`` (world-info.js:88) → **降序**
    (order 越大越先插入文本)。Palink 此前为升序，本修复对齐 ST 降序。

    ``priority`` 作为 Palink 扩展的第三级 tiebreaker（仅同 tier 同 order 时生效），
    不影响 ST 对齐（ST 同 order 时依赖稳定排序保留策略拼接顺序）。
    """
    # Lore tier: chat=0, persona=1, character/global per strategy
    if strategy == 0:  # evenly: character 与 global 同 tier，合并排序
        _char_global_tier = {"character": 2, "global": 2}
    elif strategy == 2:  # global_first
        _char_global_tier = {"character": 3, "global": 2}
    else:  # character_first (默认, strategy=1 或未知值)
        _char_global_tier = {"character": 2, "global": 3}

    def _key(e: WorldBookStage):
        source = book_lore_source.get(getattr(e, "world_book_id", ""), "global")
        if source == "chat":
            tier = 0
        elif source == "persona":
            tier = 1
        else:
            tier = _char_global_tier.get(source, 2)
        # ST sortFn: b.order - a.order → 降序 (higher order first)
        return (tier, -(e.order or 0), -(e.priority or 5))

    activated.sort(key=_key)
    return activated


def _apply_group_scoring(
    activated: list[WorldBookStage],
    reports: list[WorldbookEntryReport],
) -> list[WorldBookStage]:
    if not activated:
        return activated

    no_group: list[WorldBookStage] = []
    groups: dict[str, list[WorldBookStage]] = {}
    for entry in activated:
        if not entry.group:
            no_group.append(entry)
            continue
        groups.setdefault(entry.group, []).append(entry)

    result: list[WorldBookStage] = list(no_group)

    for group_entries in groups.values():
        # Bug #4 修复: ST 1.18.0 world-info.js:5324-5330
        # groupOverride 行为：组内有任意 entry 设置 group_override=True 时，
        # 选择 order 最小（最高优先级）的 override entry 作为唯一 winner，
        # 淘汰组内其他全部 entry（包括非 override 的）。原实现错误地保留全部。
        prio_candidates = [e for e in group_entries if e.group_override]
        if prio_candidates:
            # ST sortFn: 按 order 升序排序
            prio_candidates.sort(key=lambda e: e.order or 0)
            winner = prio_candidates[0]
            result.append(winner)
            # 淘汰组内其他全部 entry
            for e in group_entries:
                if e.id == winner.id:
                    continue
                for r in reports:
                    if r.entry_id == e.id and r.status == "activated":
                        r.status = "eliminated"
                        r.reason = "group_override_eliminated"
            continue

        # Feature: min_activations - if group activated count < min_activations,
        # eliminate the entire group (only consider entries that set min_activations > 0)
        min_required = 0
        for e in group_entries:
            ma = e.min_activations or 0
            if ma > min_required:
                min_required = ma
        if min_required > 0 and len(group_entries) < min_required:
            for e in group_entries:
                for r in reports:
                    if r.entry_id == e.id and r.status == "activated":
                        r.status = "eliminated"
                        r.reason = f"min_activations_not_met(required={min_required},actual={len(group_entries)})"
            continue

        constant_entries = [e for e in group_entries if e.constant]
        candidates = [e for e in group_entries if not e.constant]

        if not candidates:
            result.extend(constant_entries)
            continue

        # group_weight 显式为 0 的条目不参与随机选择，但保留在激活列表中（跳过随机淘汰）；
        # group_weight 未设置（None）默认 100，仍参与随机选择。
        zero_weight = [e for e in candidates if e.group_weight == 0]
        random_candidates = [e for e in candidates if e.group_weight != 0]

        if not random_candidates:
            # 全部 weight=0：全部保留，不进行随机淘汰
            result.extend(constant_entries)
            result.extend(zero_weight)
            continue

        if len(random_candidates) == 1:
            result.extend(constant_entries)
            result.extend(zero_weight)
            result.append(random_candidates[0])
            continue

        weights = [
            (e.group_weight if (e.group_weight or 0) > 0 else 100) for e in random_candidates
        ]
        chosen = random.choices(random_candidates, weights=weights, k=1)[0]

        result.extend(constant_entries)
        result.extend(zero_weight)
        result.append(chosen)

        for e in random_candidates:
            if e.id != chosen.id:
                for r in reports:
                    if r.entry_id == e.id and r.status == "activated":
                        r.status = "eliminated"
                        r.reason = "group_scoring_eliminated"

    return result


def build_worldbook_context(
    db: DBSession,
    session_id: str,
    user_id: int,
    recent_messages: list | None = None,
    character: Optional[Character] = None,
    message_index: int = 0,
    max_tokens: int = DEFAULT_BUDGET,
    enable_timed_effects: bool = True,
    enable_recursive: bool = True,
    trigger_type: Optional[str] = None,
    max_context_tokens: Optional[int] = None,
    character_name: str = '',
    character_tags: Optional[list[str]] = None,
    persona_description: Optional[str] = None,
    group_chars: Optional[list] = None,
    # Phase E 修复: ST 1.18.0 MIN_ACTIVATIONS 状态机 (world-info.js:4991-5005)
    # world_info_min_activations > 0 时，激活条目数不足则递增扫描深度继续扫描；
    # world_info_min_activations_depth_max 为深度上限（0=回退到聊天长度）。
    # 默认 0 时状态机不激活，扫描行为与 ST 一致。
    min_activations: int = 0,
    min_activations_depth_max: int = 0,
    # Phase G 修复: ST 1.18.0 world_info_character_strategy (world-info.js:4496-4510)
    # 插入排序策略: 0=evenly, 1=character_first(ST 默认), 2=global_first。
    # 控制激活条目按 lore 来源分层的排序顺序，对齐 ST getSortedEntries。
    world_info_character_strategy: int = 1,
    # D-1 修复（2026-08-23）: ST chat.length 绝对语义的聊天消息总数
    # （world-info.js:665-676 #checkDelayEffect）。delay 条目按
    # ``chat_length < entry.delay`` 判定抑制；None 时回退 len(recent_messages)
    # （调用方 recent_messages 通常有截断窗口，生产方应显式传入真实总数）。
    chat_length: Optional[int] = None,
    # A4 修复: ST world_info_depth 全局扫描深度（设置层默认对齐 ST=2）。
    # None 时回退 DEFAULT_SCAN_DEPTH；仅影响未设置自定义 scan_depth 的条目。
    world_info_depth: Optional[int] = None,
    # V-3 (2026-08-25) / P1 (2026-09-29): vectorized 检索总开关——WI 全局设置
    # silly_tavern_settings["world_info_settings"]["vectorized_enabled"]，
    # 默认 False 存量零突变。top_k/threshold 解析优先级：显式参数 >
    # world_info_settings（vector_top_k / vector_threshold）> env
    # WI_VECTOR_TOP_K / WI_VECTOR_THRESHOLD > 默认（3 / 0.55，P1 收紧）。
    vectorized_enabled: bool = False,
    vector_top_k: Optional[int] = None,
    vector_threshold: Optional[float] = None,
    # C1 修复（批次 C）: ST world_info_budget 全局百分比预算（world-info.js:73
    # 默认 25）。书级 budget_tokens 全空时以此兜底（"25%" 百分比语义，基数
    # max_context_tokens，对齐 :4624 budget = round(budget*maxContext/100)）。
    # None=不启用全局兜底（直接调用方保持现行 16000 兜底行为不变）。
    world_info_budget: Optional[float] = None,
    # C1 修复（批次 C）: ST world_info_budget_cap（world-info.js:81 默认 0=不
    # 钳制，:4626-4628 cap>0 时 min(budget, cap)）。书级 budget_cap 优先。
    world_info_budget_cap: int = 0,
    # C3 修复（批次 C）: ST world_info_include_names（world-info.js:74 默认
    # true，script.js:4565）——True 时消息按 "name: content" 拼入 haystack。
    include_names: bool = True,
    # C5 修复（批次 C）: ST world_info_case_sensitive / world_info_match_whole_words
    # （world-info.js:77-78 默认 false；:269/:347 entry null ?? global 继承）。
    world_info_case_sensitive: bool = False,
    world_info_match_whole_words: bool = False,
) -> WorldbookContextResult:
    """
    ST-grade worldbook context builder.

    Returns a WorldbookContextResult with text, debug report, and positional entries.

    Bug #2 修复: 新增 ``persona_description`` 参数，用于 ``match_persona_description``
    匹配。调用方应查询用户 active persona 的 description 后传入；未传入时
    ``match_persona_description=True`` 的条目不会因 persona 内容触发（与 ST
    一致：未配置 persona 时该字段无效果）。

    Phase E 修复: ``min_activations`` / ``min_activations_depth_max`` 对齐 ST
    1.18.0 ``world_info_min_activations`` / ``world_info_min_activations_depth_max``
    全局状态机。当 ``min_activations > 0`` 时：
      1. 强制 ``max_recursion_steps=0``（禁用常规递归，world-info.js:6122-6125）
      2. 常规扫描完成后，若激活条目数 < min，递增扫描深度继续扫描
         （上限 depth_max 或聊天长度，world-info.js:4991-5005）
    即使 ``enable_recursive=False``，``min_activations>0`` 时仍走 ``_recursive_scan``
    路径以运行状态机（ST 的 MIN_ACTIVATIONS 不依赖 world_info_recursive）。
    """
    session = (
        db.query(CharacterChatSession)
        .filter(
            CharacterChatSession.id == session_id,
            CharacterChatSession.user_id == user_id,
        )
        .first()
    )
    if not session:
        return WorldbookContextResult(
            text=None,
            debug_report=[
                WorldbookEntryReport(
                    entry_id="",
                    title="",
                    status="error",
                    reason="session_not_found",
                )
            ],
            total_tokens=0,
            budget_used=0,
        )

    # ── [WB-CHAR-ISOLATION 2026-10-03] 三源判定（对齐 ST 1.18.0）────────────
    # ST 的世界书来自三个**各自独立、都有明确绑定维度**的来源，注入时合并：
    #   1. 卡内嵌   character.data.extensions.world / data.character_book → 随卡走，天然隔离
    #   2. 角色附加 world_info.charLore[] = { name: 角色文件名, extraBooks: [书名] }
    #   3. 全局勾选 world_info.globalSelect ← selected_world_info（用户手动勾的全局书）
    # ST **没有**「书默认隐式全局」这回事（world-info.js:1132/:4376/:6039-6052）。
    #
    # 本函数据此把 Palink 的四类 WorldBook 行映射到上述来源：
    #   chat       SessionWorldBook 显式关联      → "chat"       （会话源，最高优先）
    #   character  character_id == 本会话角色      → "character"  （同时覆盖 ST 的
    #               「卡内嵌 type=character_book」与「角色附加 charLore」两种语义，
    #               两者都是"绑定到这张卡"，注入后果一致，lore tier 也相同）
    #   global     character_id IS NULL           → "global"     （ST 的 globalSelect 语义）
    #
    # ⚠ 存量书决策（见下方 GLOBAL-SCOPE 块注释）：character_id IS NULL 的书
    # 仍按 global 注入，**不因"没绑角色"就静默消失**（零回归），但装配报告会
    # 标出它的来源，用户可据此手动改绑。
    world_book_ids: list[str] = []
    book_lore_source: dict[str, str] = {}
    swb = db.query(SessionWorldBook).filter(SessionWorldBook.session_id == session_id).first()
    if swb:
        world_book_ids.append(swb.world_book_id)
        book_lore_source[swb.world_book_id] = "chat"

    if session.character_id:
        # 源 1 + 源 2：绑了本角色的书。character_id 是唯一的绑定维度
        # （type="character_book" 只是卡内嵌书的类型标记，不参与筛选——它在
        # Palink 里同样是 character_id 指向本卡的行，已被此查询覆盖）。
        # ⚠ 必须带 user_id 过滤：绑定维度的语义是"本用户的这本书给本卡"，
        # 只按 character_id 匹配会把同一 user 之外的行拖进来（历史脏数据/越权 FK）。
        char_wbs = (
            db.query(WorldBook.id)
            .filter(
                WorldBook.character_id == session.character_id,
                WorldBook.user_id == user_id,
            )
            .all()
        )
        for (wb_id,) in char_wbs:
            if wb_id not in world_book_ids:
                world_book_ids.append(wb_id)
                book_lore_source[wb_id] = "character"

    # 源 3 已删除（2026-10-03，用户裁定）：**不注入「未绑定角色」的书**。
    #
    # 用户实际用法：所有世界书都是随角色卡导入的，每本都该绑定到具体角色。
    # 此前把 `character_id IS NULL` 当作「全局书」无条件注入，是方向反了 ——
    # 它没让漏网的书少散播，反而把漏网的那些继续散播给所有卡。
    # ST 1.18 也没有「没绑就算全局」这回事：`globalSelect` 是用户手动勾选集，
    # 而非「未绑定」的代名词。
    #
    # 未绑定的书视为**待归属**：装配层会把它们列进装配报告的 warn 项，
    # 便于用户去世界书管理页补绑，而不是静默生效或静默消失。
    unbound_wbs = (
        db.query(WorldBook.id, WorldBook.name)
        .filter(
            WorldBook.character_id.is_(None),
            WorldBook.user_id == user_id,
        )
        .all()
    )
    if unbound_wbs:
        logger.warning(
            "[WB-UNBOUND %d 本世界书未绑定任何角色，本次未注入"
            "（请在世界书管理页绑定到对应角色）：%s]",
            len(unbound_wbs),
            ", ".join(f"{n or wb}" for wb, n in unbound_wbs),
        )

    # Load WorldBook records to read budget_tokens / budget_cap fields
    loaded_wbs: list[WorldBook] = (
        db.query(WorldBook).filter(WorldBook.id.in_(world_book_ids)).all()
    ) if world_book_ids else []

    # [WB-CHAR-ISOLATION 2026-10-03] 构建 book_sources 可见性表：每本被注入的
    # 书 → 书名 + lore 来源 + 行类型。与 budget 解析共用同一次查询（零额外 SQL）。
    book_sources: dict[str, dict] = {}
    for wb in loaded_wbs:
        book_sources[wb.id] = {
            "name": wb.name,
            "source": book_lore_source.get(wb.id, "global"),
            "type": wb.type or "world_book",
            # character_id 非空 = 按角色绑定（ST charLore/卡内嵌）；为空 = 全局源
            "character_id": wb.character_id,
        }

    if not world_book_ids:
        return WorldbookContextResult(
            text=None,
            debug_report=[],
            total_tokens=0,
            budget_used=0,
            book_sources=book_sources,
        )

    entries: list[WorldBookStage] = (
        db.query(WorldBookStage)
        .filter(WorldBookStage.world_book_id.in_(world_book_ids))
        .all()
    )
    if not entries:
        return WorldbookContextResult(
            text=None,
            debug_report=[],
            total_tokens=0,
            budget_used=0,
            book_sources=book_sources,
        )

    # Phase G: ST 1.18.0 getSortedEntries (world-info.js:4478-4527) 在扫描前
    # 按策略排序全部条目。此排序决定扫描顺序（影响递归激活：先激活的条目内容
    # 会进入 haystack 供后续条目匹配）与最终插入顺序。此前 Palink 用 DB 查询
    # 顺序扫描，与 ST 的 character_first 默认策略不一致。
    entries = _sort_by_insertion_strategy(entries, book_lore_source, world_info_character_strategy)

    msgs = list(recent_messages) if recent_messages else []
    timed_mgr: Optional[TimedEffectsManager] = None
    if enable_timed_effects:
        timed_mgr = TimedEffectsManager(db, session_id)
        timed_mgr.update_after_message()

    # characterFilter：未显式传入时从 character 派生 name/tags
    effective_char_name = character_name or ''
    effective_char_tags: list[str] = list(character_tags) if character_tags else []
    if (not effective_char_name or not effective_char_tags) and character:
        if not effective_char_name:
            effective_char_name = character.name or ''
        if not effective_char_tags and character.tags:
            effective_char_tags = _parse_json_list(character.tags)

    # V-2 (2026-08-25): vectorized 检索命中集合。开关开启且存在 vectorized 条目
    # 时，以最近 4 条消息拼接为查询做语义检索；嵌入失败/服务不可用静默降级为
    # "本轮无命中"（_collect_vector_hits 与此处双重兜底），绝不阻塞主对话。
    vector_hits: dict[str, float] = {}
    vector_degraded_books: set[str] = set()
    # P1 (2026-09-29): 解析优先级 explicit > settings > env > 默认（3 / 0.55）。
    # settings 层在本函数内部读取 world_info_settings（identity map 命中，
    # 不额外打 SQL），装配层 roleplay_prompt_assembly 保持零接触。
    _settings_top_k, _settings_threshold = (None, None)
    if vectorized_enabled:
        _settings_top_k, _settings_threshold = _read_vector_params_from_settings(db, user_id)
        try:
            vector_hits, vector_degraded_books = _collect_vector_hits(
                db, entries, msgs,
                top_k=_resolve_vector_top_k(vector_top_k, _settings_top_k),
                threshold=_resolve_vector_threshold(vector_threshold, _settings_threshold),
            )
        except Exception as exc:
            logger.warning("worldbook vector retrieval degraded (no hits this turn): %s", exc)
            vector_hits = {}
            # P3: 整链异常时按"全部相关书降级"处理——有关键词的条目回退关键词匹配
            vector_degraded_books = {
                e.world_book_id for e in entries
                if getattr(e, "vectorized", False) and getattr(e, "world_book_id", None)
            }

    # Phase E: min_activations>0 时强制走 _recursive_scan 路径以运行状态机，
    # 即使 enable_recursive=False（ST 的 MIN_ACTIVATIONS 不依赖 world_info_recursive）
    # D-1 修复: chat_length 未显式传入时回退 len(msgs)（截断窗口近似值）
    effective_chat_length = chat_length if chat_length is not None else len(msgs)
    if enable_recursive or min_activations > 0:
        activated, report = _recursive_scan(
            entries, msgs, character, timed_mgr, message_index,
            trigger_type=trigger_type,
            character_name=effective_char_name,
            character_tags=effective_char_tags,
            chat_metadata=session.chat_metadata,
            persona_description=persona_description,
            group_chars=group_chars,
            min_activations=min_activations,
            min_activations_depth_max=min_activations_depth_max,
            chat_length=effective_chat_length,
            global_scan_depth=world_info_depth,
            vectorized_enabled=vectorized_enabled,
            vector_hits=vector_hits,
            vector_degraded_books=vector_degraded_books,
            include_names=include_names,
            global_case_sensitive=world_info_case_sensitive,
            global_match_whole_words=world_info_match_whole_words,
        )
    else:
        visited: set[str] = set()
        report = []
        activated = _scan_entries(
            entries, msgs, character, timed_mgr, message_index, visited, 0, report,
            trigger_type=trigger_type,
            character_name=effective_char_name,
            character_tags=effective_char_tags,
            chat_metadata=session.chat_metadata,
            persona_description=persona_description,
            group_chars=group_chars,
            chat_length=effective_chat_length,
            global_scan_depth=world_info_depth,
            vectorized_enabled=vectorized_enabled,
            vector_hits=vector_hits,
            vector_degraded_books=vector_degraded_books,
            include_names=include_names,
            global_case_sensitive=world_info_case_sensitive,
            global_match_whole_words=world_info_match_whole_words,
        )

    # Apply group scoring (before sorting)
    activated = _apply_group_scoring(activated, report)

    # Phase G 修复: ST 1.18.0 world_info_character_strategy 插入排序
    # (world-info.js:4496-4513)。chatLore 最前，personaLore 次之，
    # character/global 按 strategy 分层排序。sortFn: b.order - a.order (降序)。
    # 此前 Palink 用升序 (e.order or 0) 且无 lore 分层，与 ST 默认 character_first 不一致。
    activated = _sort_by_insertion_strategy(
        activated, book_lore_source, world_info_character_strategy,
    )

    # Feature: budget percentage + budget_cap - resolve effective budget from loaded world books.
    # First non-empty budget_tokens wins; first non-zero budget_cap wins.
    resolved_budget_tokens = None
    resolved_budget_cap = 0
    for wb in loaded_wbs:
        if resolved_budget_tokens is None and wb.budget_tokens:
            resolved_budget_tokens = wb.budget_tokens
        if resolved_budget_cap == 0 and wb.budget_cap and wb.budget_cap > 0:
            resolved_budget_cap = wb.budget_cap
    # C1 修复（批次 C）: 书级 budget_tokens 全空时用全局百分比兜底——
    # world_info_budget（数字 25）转 "25%" 百分比字符串语义，基数 max_context_tokens
    # （对齐 ST world-info.js:4624 budget = round(world_info_budget*maxContext/100)）。
    if resolved_budget_tokens is None and world_info_budget is not None:
        resolved_budget_tokens = f"{world_info_budget}%"
    # C1: 书级 cap 全空时全局 cap 兜底（>0 时钳制上限，对齐 :4626-4628）
    if resolved_budget_cap == 0 and world_info_budget_cap and world_info_budget_cap > 0:
        resolved_budget_cap = int(world_info_budget_cap)
    effective_budget = _resolve_budget(
        resolved_budget_tokens, resolved_budget_cap, max_context_tokens, max_tokens,
    )

    # Apply budget
    activated = _apply_budget(activated, effective_budget, report)

    # Group by position
    # @@no_recall：条目仍可被激活（已用于递归扫描），但其内容不进入最终上下文
    entries_by_position: dict[int, list[str]] = {}
    depth_entries: list[tuple[int, str, int]] = []  # G6: (depth, content, role)
    em_top_entries: list[str] = []
    em_bottom_entries: list[str] = []
    outlet_entries: dict[str, list[str]] = {}
    for entry in activated:
        entry_decorators = _parse_decorators(entry.content or '')
        if entry_decorators.get('no_recall'):
            # 标记为 no_recall 的条目不计入任何位置输出
            for r in report:
                if r.entry_id == entry.id and r.status == "activated":
                    r.reason = (r.reason + ";no_recall" if r.reason else "no_recall")
            continue
        # P3 修复: 注入前剥离 EJS/underscore 模板语法（如 <%_ if (v('...')) { _%>）。
        # 扫描匹配仍使用原始 entry.content（上方 _parse_decorators 同理）。
        entry_content = strip_template_syntax(entry.content or '')
        # 剥离后仅剩装饰器样孤行/纯标点（如卡侧控制器条目 = 首行 @activate +
        # EJS 模板被剥成空）＝无实质内容，整条跳过注入，避免孤行残渣拼进
        # 位置桶/深度列表（空内容条目跳过的自然延伸）。
        if _is_decoration_only(entry_content):
            for r in report:
                if r.entry_id == entry.id and r.status == "activated":
                    r.reason = (r.reason + ";stripped_empty" if r.reason else "stripped_empty")
            continue
        pos = entry.position if entry.position is not None else WI_POS_AT_DEPTH
        if pos == WI_POS_AT_DEPTH:
            # G6 修复: 包含 role (0=system, 1=user, 2=assistant)
            # ⚠️ depth=0 是 ST 的合法值（= 插到对话最末尾，紧贴模型下一次输出），
            # 必须只在 None 时兜默认 4。原 `entry.depth or 4` 把 0 吃成 4，导致
            # 卡片自带的 `[mvu_update]变量更新规则/输出格式`（position=4, depth=0）
            # 落点比 ST 远 4 个楼层，让位给后端写死的变量指令（2026-10-05 实测
            # debug-prompt-assembly：插入报告 depth=4、条目落在 index 8 而非末尾）。
            _depth_value = 4 if entry.depth is None else entry.depth
            depth_entries.append((_depth_value, entry_content, entry.role or 0))
        elif pos == WI_POS_EM_TOP:
            em_top_entries.append(entry_content)
        elif pos == WI_POS_EM_BOTTOM:
            em_bottom_entries.append(entry_content)
        elif pos == WI_POS_OUTLET:
            outlet_name = (entry.outlet_name or "default").strip() or "default"
            outlet_entries.setdefault(outlet_name, []).append(entry_content)
        else:
            entries_by_position.setdefault(pos, []).append(entry_content)

    contents: list[str] = []
    for pos in sorted(entries_by_position.keys()):
        contents.extend(entries_by_position[pos])

    # Depth entries are handled separately by the caller (roleplay_prompt_assembly)
    # Do NOT append them here to avoid duplicate injection.

    total_tokens = sum(_estimate_tokens(c) for c in contents)

    text = "[World Lore]\n" + "\n\n".join(contents) if contents else None

    # [WB-CHAR-ISOLATION 2026-10-03] 给每条 report 打上所属书的来源与书名。
    # 在此处（而非扫描期）回填：报告会被 _apply_group_scoring / _apply_budget
    # 改写 status/reason，末态才是用户真正看到的。
    # entry_id -> world_book_id 由已加载的 entries 反查（零额外 SQL）。
    # 同样覆盖 _scan_entries 与 _recursive_scan 两条产出路径。
    _entry_book: dict[str, str] = {e.id: e.world_book_id for e in entries}
    for r in report:
        wb_id = r.world_book_id or _entry_book.get(r.entry_id, "")
        meta = book_sources.get(wb_id)
        if meta:
            r.world_book_id = wb_id
            r.lore_source = meta["source"]
            r.book_name = meta["name"]

    return WorldbookContextResult(
        text=text,
        debug_report=report,
        total_tokens=total_tokens,
        budget_used=effective_budget,
        entries_by_position=entries_by_position,
        depth_entries=depth_entries,
        em_top_entries=em_top_entries,
        em_bottom_entries=em_bottom_entries,
        outlet_entries=outlet_entries,
        book_sources=book_sources,
    )


# Backward-compatible wrapper returning Optional[str]
def build_worldbook_context_legacy(
    db: DBSession,
    session_id: str,
    user_id: int,
    recent_messages: list | None = None,
) -> Optional[str]:
    result = build_worldbook_context(
        db=db,
        session_id=session_id,
        user_id=user_id,
        recent_messages=recent_messages,
    )
    return result.text


# ──────────────────────────────────────────────
# Blueprints (ST 1.18.0)
# ──────────────────────────────────────────────

@dataclass
class BlueprintApplyResult:
    created_count: int
    skipped_count: int
    created_entry_ids: list[str] = field(default_factory=list)
    skipped_comments: list[str] = field(default_factory=list)


def apply_blueprint(db: DBSession, worldbook_id: str, blueprint_id: int) -> BlueprintApplyResult:
    """应用世界书蓝图：基于蓝图定义批量创建关联条目，并应用触发逻辑。

    - 幂等：通过 comment 去重，重复应用不会创建重复条目
    - 失败时回滚已创建的条目
    - trigger_logic.auto_activate=True → 创建的条目设为常驻（constant）
    """
    blueprint = db.query(WorldBookBlueprint).filter(WorldBookBlueprint.id == blueprint_id).first()
    if not blueprint:
        raise ValueError(f"Blueprint {blueprint_id} not found")

    worldbook = db.query(WorldBook).filter(WorldBook.id == worldbook_id).first()
    if not worldbook:
        raise ValueError(f"World book {worldbook_id} not found")

    # 解析蓝图定义
    try:
        entries_def = json.loads(blueprint.entries_json) if blueprint.entries_json else []
    except (json.JSONDecodeError, TypeError):
        entries_def = []
    if not isinstance(entries_def, list):
        entries_def = []

    try:
        trigger_logic = json.loads(blueprint.trigger_logic) if blueprint.trigger_logic else {}
    except (json.JSONDecodeError, TypeError):
        trigger_logic = {}
    if not isinstance(trigger_logic, dict):
        trigger_logic = {}

    auto_activate = bool(trigger_logic.get("auto_activate", False))

    # 现有条目 comment 集合（用于幂等去重）
    existing_stages = (
        db.query(WorldBookStage)
        .filter(WorldBookStage.world_book_id == worldbook_id)
        .all()
    )
    existing_comments = {(s.title or "").strip() for s in existing_stages}
    # 计算下一个 stage_index
    next_stage_index = max((s.stage_index or 0 for s in existing_stages), default=-1) + 1

    created_stages: list[WorldBookStage] = []
    skipped_comments: list[str] = []
    now = datetime.now(timezone.utc)

    try:
        for entry_def in entries_def:
            if not isinstance(entry_def, dict):
                continue
            comment = str(entry_def.get("comment", "") or "").strip()
            # 幂等去重：comment 已存在则跳过
            if comment and comment in existing_comments:
                skipped_comments.append(comment)
                continue

            content = str(entry_def.get("content", "") or "").strip()
            if not content:
                continue
            if len(content) > 50000:
                content = content[:50000]

            keys = entry_def.get("key", [])
            secondary_keys = entry_def.get("keysecondary", [])
            is_constant = bool(entry_def.get("constant", False)) or auto_activate

            # extensions 保留原始扩展 + 触发逻辑元数据
            extensions = entry_def.get("extensions", {})
            if not isinstance(extensions, dict):
                extensions = {}
            if trigger_logic:
                extensions = {**extensions, "blueprint_trigger_logic": trigger_logic}

            stage = WorldBookStage(
                id=str(uuid.uuid4()),
                world_book_id=worldbook_id,
                stage_index=next_stage_index,
                title=comment or f"Entry {next_stage_index}",
                content=content,
                summary=None,
                transition_hint=None,
                priority=10 if is_constant else 5,
                token_count=len(content) // 4,
                keys=json.dumps(keys, ensure_ascii=False) if keys else None,
                secondary_keys=json.dumps(secondary_keys, ensure_ascii=False) if secondary_keys else None,
                scan_depth=entry_def.get("scanDepth", 4),
                position=normalize_worldbook_position(entry_def.get("position", 4)),
                selective=bool(entry_def.get("selective", False)),
                probability=entry_def.get("probability", 100),
                constant=is_constant,
                group=entry_def.get("group"),
                extensions_json=json.dumps(extensions, ensure_ascii=False) if extensions else None,
                created_at=now,
            )
            db.add(stage)
            created_stages.append(stage)
            existing_comments.add(comment)  # 防止蓝图内同 comment 重复
            next_stage_index += 1
    except Exception:
        # 回滚已创建的条目
        for s in created_stages:
            db.delete(s)
        db.flush()
        raise

    db.commit()
    worldbook.updated_at = now
    db.commit()

    return BlueprintApplyResult(
        created_count=len(created_stages),
        skipped_count=len(skipped_comments),
        created_entry_ids=[s.id for s in created_stages],
        skipped_comments=skipped_comments,
    )
