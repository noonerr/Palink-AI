"""Unified roleplay prompt assembly service.

This module is the backend seam for Palink's roleplay runtime.
It intentionally preserves the existing prompt behavior while making the
assembly steps explicit and reusable by HTTP and WebSocket character chat.

方向声明: 项目当前主攻 `palink-native` 装配（build_character_chat_messages）。
`st-compat`/`st-native` 双轨已于 2026-09 删除（含本文件 ST_COMPAT_MODES 分支）。
详见根目录 AGENTS.md。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Optional

from sqlalchemy import func, or_
from sqlalchemy.exc import ResourceClosedError
from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..memory_module.service import MemoryService
from ..memory_module.config import memory_config as _memory_config
from ..core.silent_failure import record as _record_silent_failure
from ..models import Character, GroupChat, GroupChatSession, CharacterChatSession, User, UserSetting, ContextTemplate, Persona, InstructTemplate, PromptPreset
from ..models.character import CharacterChatMessage
from .inference_dispatcher import complete_text_completion
from ..models.extension_prompt import (
    ExtensionPrompt,
    EXTENSION_PROMPT_POSITION_NONE,
    EXTENSION_PROMPT_POSITION_IN_PROMPT,
    EXTENSION_PROMPT_POSITION_IN_CHAT,
    EXTENSION_PROMPT_POSITION_BEFORE_PROMPT,
    EXTENSION_PROMPT_POSITION_MIN,
    EXTENSION_PROMPT_POSITION_MAX,
)
from ..services.character_message_builder import build_character_chat_messages
from ..services.plotline_service import build_plotline_context
from ..services.worldbook_service import build_worldbook_context, WorldbookContextResult
from ..services.macro_service import MacroEnv, evaluate_macros, evaluate_macros_in_messages
# [D-5b 2026-10-25] main 槽与三段卡字段的分槽载体（core 叶子模块，无循环依赖：
# default_prompts 只在函数体内惰性 import services）。
from ..core.default_prompts import CharacterPromptSlots
from ..utils import (
    build_memory_context,
    balance_custom_tags,
    clean_memory_content,
    normalize_image_url,
)

logger = logging.getLogger(__name__)

REGEX_PLACEMENT_WORLD_INFO = 5

DEFAULT_CONTEXT_TEMPLATE_NAME = "Default"

# ── ST 1.18.0 depth 注入统一队列（palink-native 专属） ─────────────────
# 对齐 ST 的三级确定序（openai.js populationInjectionPrompts L801-866 +
# script.js getExtensionPrompt L3242-3270 + doChatInject L5569-5617）：
#   1. depth        — 从最新消息往回数的插入深度
#   2. order        — injection_order，ST 默认 100（openai.js L825）；时间序内
#                     低 order 靠前、高 order 靠近最新消息（降序分桶后整体 reverse）
#   3. role         — 同桶内 system 最靠近最新消息（roles [system,user,assistant]
#                     正序入块 → reverse 后 assistant,user,system）
#   4. sort_key     — ST 扩展注册表按 key 字母序合并（getExtensionPrompt
#                     Object.keys(extension_prompts).sort()）；AN/世界书/角色深度
#                     提示词在 ST 中均经 setExtensionPrompt 进入该注册表，
#                     key 前缀数字即官方排序手段（authors-note.js L26 注释明证）
_INJECTION_ORDER_DEFAULT = 100  # ST Prompt.injection_order 默认值（openai.js L825）

# ST 扩展注册表 key 等价物（ASCII 序：'0_'<'1_'<'2_'<'D'<'c'<小写字母）
_KEY_PALINK_INJECT = "0_palink_injection"   # Palink /inject —— 类比 ST prompt-manager 条目（同 role join 时先于扩展内容）
_KEY_PERSONA_DEPTH = "1_persona_description"  # Palink 特有映射（ST persona 走 prompt-order 固定槽）
_KEY_AN_DEPTH = "2_floating_prompt"          # ST authors-note.js L26 原样
_KEY_CHAR_DEPTH_PROMPT = "DEPTH_PROMPT"      # ST constants.js L50 原样
_KEY_WI_DEPTH_FMT = "customDepthWI_{depth}_{role}"  # ST constants.js L53 原样格式

# 同 (depth, order) 内的时间序 role 排列：assistant→user→system（对齐 ST reverse 后语义）
_ROLE_MERGE_RANK = {2: 0, 1: 1, 0: 2}
_ROLE_NAME_TO_INT = {"system": 0, "user": 1, "assistant": 2}
_ROLE_INT_TO_NAME = {0: "system", 1: "user", 2: "assistant"}


@dataclass
class DepthInjection:
    """统一 depth 注入记录 —— palink-native 全部动态注入的唯一队列条目。"""
    depth: int
    content: str
    role: int  # 0=system 1=user 2=assistant（ST extension_prompt_roles）
    source: str  # report 来源标识（author_note/persona_description/worldbook_depth/extension_prompt/palink_injection/depth_prompt）
    sort_key: str = ""  # ST 注册表 key 等价物；同 (depth, order, role) 内按字母序
    order: int = _INJECTION_ORDER_DEFAULT
    # 入队时已写过 report 的来源（AN/persona//inject/插件）置 False，
    # 避免插入阶段重复上报（worldbook_depth/depth_prompt 历史上在插入时报告）
    report_on_insert: bool = False


def _load_context_template(db: Session, name: Optional[str]) -> Optional[ContextTemplate]:
    """Load a ContextTemplate by name, falling back to "Default".

    Returns None only when no templates exist (e.g. fresh DB before seed runs).
    The returned template drives how `build_character_chat_messages` wraps
    the assembled messages. The Default template preserves existing
    Palink behavior (passthrough).
    """
    target_name = (name or DEFAULT_CONTEXT_TEMPLATE_NAME).strip() or DEFAULT_CONTEXT_TEMPLATE_NAME
    try:
        tmpl = db.query(ContextTemplate).filter(ContextTemplate.name == target_name).first()
        if tmpl is not None:
            return tmpl
        if target_name != DEFAULT_CONTEXT_TEMPLATE_NAME:
            tmpl = db.query(ContextTemplate).filter(ContextTemplate.name == DEFAULT_CONTEXT_TEMPLATE_NAME).first()
            if tmpl is not None:
                return tmpl
    except Exception as exc:
        logger.warning("Failed to load context template %r: %s", target_name, exc)
    return None


def _load_instruct_template(db: Session, user_setting: Optional[UserSetting], cache: Optional[dict] = None) -> Optional[InstructTemplate]:
    """Load the InstructTemplate bound to the user's settings.

    Returns None when instruct mode is disabled, no template is bound, or the
    bound template no longer exists. A None return preserves the existing
    prompt-assembly behavior (no instruct wrapping).
    """
    if not user_setting:
        return None
    if not bool(getattr(user_setting, "instruct_enabled", False)):
        return None
    template_id = getattr(user_setting, "instruct_template_id", None)
    if not template_id:
        return None
    # E-8 修复: 请求级缓存——装配路径最终 instruct 包装需加载 InstructTemplate，
    # 缓存避免同一请求内重复查询。
    if cache is not None:
        key = f"instruct:{template_id}"
        if key in cache:
            return cache[key]
    try:
        tmpl = db.query(InstructTemplate).filter(InstructTemplate.id == template_id).first()
    except Exception as exc:
        logger.warning("Failed to load instruct template id=%r: %s", template_id, exc)
        tmpl = None
    if cache is not None:
        cache[key] = tmpl
    return tmpl


def _apply_instruct_formatting(
    messages: list[dict[str, Any]],
    template: InstructTemplate,
    *,
    is_group_chat: bool = False,
    user_name: str = "",
    char_name: str = "",
) -> list[dict[str, Any]]:
    """Wrap each message's content with the instruct template's prefix/suffix.

    - system messages    → system_sequence + content + system_suffix
    - user messages      → input_prefix + content + input_suffix
    - assistant messages → output_prefix + content + output_suffix

    The first assistant message uses ``first_output_prefix`` (falling back to
    ``output_prefix`` when empty) and the last assistant message uses
    ``last_output_prefix`` (falling back to ``output_prefix`` when empty), as
    in ST 1.18.0. When there is only one assistant message it is both first
    and last, in which case ``first_output_prefix`` takes priority. The suffix
    is always ``output_suffix``.

    Multimodal content (list of parts) has its text parts wrapped in place;
    non-text parts are preserved unchanged. When ``wrap_sequences`` is True a
    trailing newline is appended after the suffix.

    ST 1.18.0 Task 3.6 alignment:
      - ``system_sequence`` / ``system_suffix`` (ST 1.18.0 names) take
        priority over the legacy ``system_sequence_prefix`` /
        ``system_sequence_suffix`` fields (kept for backward compat).
      - ``skip_examples`` (Task 3.6.2): when True, example dialogue messages
        (identified by the "Example dialogue:" prefix) are NOT wrapped with
        instruct sequences — they pass through as plain text, matching ST
        1.18.0's ``formatInstructModeExamples`` skip_examples branch.
      - ``names_behavior`` (Task 3.6.3): controls name injection. 'always'
        prepends ``"{name}: "`` to user/assistant content; 'force' does so
        only in group chat; 'none' never injects names. This replaces the
        obsolete ``names`` / ``names_force_groups`` pair.
      - ``first_input_sequence`` / ``last_input_sequence``: ST 1.18.0
        first/last user input prefixes (fall back to ``input_prefix`` when
        empty).
      - ``system_same_as_user``: when True, system (narrator) messages use
        the user input prefix/suffix instead of the dedicated system
        sequences.
    """
    # ST 1.18.0 system_sequence/system_suffix take priority; fall back to
    # the legacy system_sequence_prefix/system_sequence_suffix for backward
    # compat with pre-Task-3.6 seeds and DB rows.
    sys_prefix = (
        getattr(template, "system_sequence", None)
        or getattr(template, "system_sequence_prefix", None)
        or ""
    )
    sys_suffix = (
        getattr(template, "system_suffix", None)
        or getattr(template, "system_sequence_suffix", None)
        or ""
    )
    in_prefix = template.input_prefix or ""
    in_suffix = template.input_suffix or ""
    out_prefix = template.output_prefix or ""
    out_suffix = template.output_suffix or ""
    first_out_prefix = template.first_output_prefix or ""
    last_out_prefix = template.last_output_prefix or ""
    # ST 1.18.0 first/last input sequences (fall back to input_prefix)
    first_in_prefix = getattr(template, "first_input_sequence", None) or in_prefix
    last_in_prefix = getattr(template, "last_input_sequence", None) or in_prefix
    last_sys_prefix = getattr(template, "last_system_sequence", None) or ""
    wrap = bool(template.wrap_sequences)
    # Task 3.6.2: skip instruct wrapping for example dialogue messages
    skip_examples = bool(getattr(template, "skip_examples", False))
    # Task 3.6.3: names_behavior replaces names_force_for_groups
    names_behavior = (getattr(template, "names_behavior", None) or "force").strip().lower()
    # ST 1.18.0: when True, narrator/system messages use user input sequences
    system_same_as_user = bool(getattr(template, "system_same_as_user", False))

    # Determine whether to include names in the wrapped content.
    # ST 1.18.0 formatInstructModeChat logic:
    #   - 'always' → always include names
    #   - 'force'  → include names only in group chat (or forceAvatar)
    #   - 'none'   → never include names
    include_names = names_behavior == "always" or (
        names_behavior == "force" and is_group_chat
    )

    def _wrap(text: str, prefix: str, suffix: str, name: str = "") -> str:
        # ST 1.18.0: when include_names and name is non-empty, the content
        # becomes "{prefix}{name}: {content}{suffix}" (with separator based
        # on wrap_sequences).
        if include_names and name:
            separator = "\n" if wrap else ""
            return f"{prefix}{separator}{name}: {text}{suffix}" + ("\n" if wrap else "")
        wrapped = f"{prefix}{text}{suffix}"
        return f"{wrapped}\n" if wrap else wrapped

    # Helper to check if a message is an example dialogue (skip_examples)
    # G11 修复: 同时识别 Palink 的 "Example dialogue:" 和 ST 的 "[Example Chat]" 前缀
    def _is_example_message(content: Any) -> bool:
        text = _message_content_to_text(content)
        stripped = text.strip()
        return stripped.startswith("Example dialogue:") or stripped.startswith("[Example Chat]")

    # Locate the first and last assistant message indices so we can apply
    # first_output_prefix / last_output_prefix. When a single assistant
    # message exists it is both first and last; first_output_prefix wins.
    first_assistant_idx: Optional[int] = None
    last_assistant_idx: Optional[int] = None
    for i, m in enumerate(messages):
        if m.get("role") == "assistant":
            if first_assistant_idx is None:
                first_assistant_idx = i
            last_assistant_idx = i

    # Locate the first and last user message indices for
    # first_input_sequence / last_input_sequence.
    first_user_idx: Optional[int] = None
    last_user_idx: Optional[int] = None
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            if first_user_idx is None:
                first_user_idx = i
            last_user_idx = i

    # Locate the last system message index for last_system_sequence.
    last_system_idx: Optional[int] = None
    for i, m in enumerate(messages):
        if m.get("role") == "system":
            last_system_idx = i

    next_messages: list[dict[str, Any]] = []
    for i, m in enumerate(messages):
        role = m.get("role", "user")
        content = m.get("content", "")

        # Task 3.6.2: skip instruct wrapping for example dialogue messages
        if skip_examples and role == "system" and _is_example_message(content):
            next_messages.append(m)
            continue

        if role == "system":
            if system_same_as_user:
                prefix, suffix = in_prefix, in_suffix
            elif i == last_system_idx and last_sys_prefix:
                # ST 1.18.0: last system message uses last_system_sequence
                prefix = last_sys_prefix
                suffix = sys_suffix
            else:
                prefix, suffix = sys_prefix, sys_suffix
            name = ""  # system messages never get name injection
        elif role == "assistant":
            if i == first_assistant_idx and first_out_prefix:
                prefix = first_out_prefix
            elif i == last_assistant_idx and last_out_prefix:
                prefix = last_out_prefix
            else:
                prefix = out_prefix
            suffix = out_suffix
            name = char_name if include_names else ""
        else:
            # ST 1.18.0: first/last user input sequences
            if i == first_user_idx and first_in_prefix and first_in_prefix != in_prefix:
                prefix = first_in_prefix
            elif i == last_user_idx and last_in_prefix and last_in_prefix != in_prefix:
                prefix = last_in_prefix
            else:
                prefix = in_prefix
            suffix = in_suffix
            name = user_name if include_names else ""

        if isinstance(content, str):
            new_content: Any = _wrap(content, prefix, suffix, name)
        elif isinstance(content, list):
            new_parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    part = dict(part)
                    part["text"] = _wrap(part.get("text", ""), prefix, suffix, name)
                new_parts.append(part)
            new_content = new_parts
        else:
            new_content = content
        next_messages.append({**m, "content": new_content})
    return next_messages


# ── Task 3.6.5: Chat completion source detection ────────────────────
# ST 1.18.0 ``chat_completion_sources`` enum (openai.js). Sources in this
# set use role-based message separation (system/user/assistant) and do NOT
# require text Instruct wrapping — the messages are sent as role/content
# pairs directly to the chat completion API. Text completion sources
# (koboldai / text-generation-webui / llamacpp / etc.) or an unset source
# fall back to the legacy behavior of applying the full text Instruct
# wrapping to flatten messages into a single text prompt.
_CHAT_COMPLETION_SOURCES: set[str] = {
    "openai",
    "claude",
    "openrouter",
    "ai21",
    "makersuite",
    "vertexai",
    "mistralai",
    "custom",
    "cohere",
    "perplexity",
    "groq",
    "electronhub",
    "chutes",
    "nanogpt",
    "deepseek",
    "aimlapi",
    "xai",
    "pollinations",
    "moonshot",
    "fireworks",
    "cometapi",
    "azure_openai",
    "zai",
    "siliconflow",
    "workers_ai",
    "minimax",
}


def _should_apply_instruct_wrapping(chat_completion_source: Optional[str]) -> bool:
    """Task 3.6.5: Decide whether text Instruct wrapping should be applied.

    Returns ``False`` for known chat completion APIs (openai/claude/openrouter/
    etc.) — these use role-based message separation and the instruct
    template's text sequences are not needed. Returns ``True`` for text
    completion sources or when ``chat_completion_source`` is None/empty
    (preserves the legacy behavior of applying full text Instruct wrapping).

    Mirrors ST 1.18.0's ``openai.js`` behavior where ``chat_completion_source``
    drives whether ``prepareOpenAIMessages`` (chat) or ``formatInstructMode``
    (text) is used to assemble the final prompt.
    """
    if not chat_completion_source:
        return True
    return chat_completion_source.strip().lower() not in _CHAT_COMPLETION_SOURCES


ReplacePlaceholdersFn = Callable[[str, str, str], str]
ContainsChineseFn = Callable[[str], bool]
# [D-5b 2026-10-25] 生产实现返回 CharacterPromptSlots（main + 三段卡字段槽）；
# 仍返回 str 的调用方（测试替身 / 归档探针）走"合并形态、不拆槽"的兼容分支。
BuildSystemPromptFn = Callable[
    [Character, str, str, str, Optional[UserSetting]],
    "str | CharacterPromptSlots",
]
GetFullBranchHistoryFn = Callable[..., list]
GetAncestorBranchIdsFn = Callable[[Session, str, str], list]
# [MEM-MIRROR 2026-10-05] 分支作用域 [(branch_id, up_to_message_id)]，含分叉点截断
GetAncestorBranchScopesFn = Callable[[Session, str, str], list]
ApplyRegexScriptsFn = Callable[..., str]
ApplyPromptRegexToMessagesFn = Callable[[list, Session, Character, str], list]


@dataclass
class PromptAssemblyDeps:
    build_system_prompt: BuildSystemPromptFn
    replace_placeholders: ReplacePlaceholdersFn
    get_full_branch_history: GetFullBranchHistoryFn
    get_ancestor_branch_ids: GetAncestorBranchIdsFn
    contains_chinese: ContainsChineseFn
    apply_plugin_regex_scripts: ApplyRegexScriptsFn
    apply_regex_scripts: ApplyRegexScriptsFn
    apply_prompt_regex_to_messages: ApplyPromptRegexToMessagesFn
    # [MEM-MIRROR 2026-10-05] 分支作用域（含分叉点截断）。可选：None 时装配层回退到
    # get_ancestor_branch_ids 的旧行为（整条祖先链可见，无分叉截断）。仅在需要
    # 召回按分叉点隔离时由调用方注入 _get_ancestor_branch_scopes。
    get_ancestor_branch_scopes: Optional[GetAncestorBranchScopesFn] = None


@dataclass
class PromptAssemblyRequest:
    db: Session
    user: User
    char: Character
    session_id: str
    branch_id: Optional[str]
    message: str
    images: list[str] = field(default_factory=list)
    model: Optional[str] = None
    user_nickname: Optional[str] = None
    response_length: Optional[str] = None
    max_tokens: int = 2048
    is_init: bool = False
    smart_card_trigger: bool = False
    smart_card_context: Optional[str] = None
    include_title_instruction: bool = True
    include_prompt_regex: bool = True
    include_user_message: bool = True
    # Continue 模式：当 True 时不添加新的 user 消息，最后一条 assistant
    # 消息作为续写起点（用于 /continue 端点，区别于 normal 生成流程）。
    is_continue: bool = False
    # ST 1.18.0 context template binding — name of ContextTemplate to apply
    # when wrapping the assembled messages. NULL falls back to "Default"
    # (passthrough behavior, backward compatible).
    context_template_name: Optional[str] = None
    # 群组聊天支持：当 group_id 非空时启用群组提示词构建分支
    # current_speaker_id 指定当前发言的成员 character_id（用于注入其 profile）
    group_id: Optional[str] = None
    current_speaker_id: Optional[str] = None
    # ST 1.18.0 generateGroupWrapper generation type (group-chats.js:1006-1031)。
    # 取值: swipe/continue/impersonate/quiet/normal/None。当为 swipe/continue/
    # impersonate/quiet 时，选角优先于 activation_strategy（复用被 swipe 发言者 /
    # 随机选角），对齐 ST activateSwipe/activateImpersonate。None=normal 走原策略。
    generation_type: Optional[str] = None
    # ST 1.18.0 group_activation_strategy=MANUAL(2): 当用户未显式指定发言者
    # （current_speaker_id 为空）时跳过 AI 生成，仅持久化用户消息。
    # 实际跳过由 websocket 层 resolve_group_speaker_queue 返回空队列承接，
    # 不通过请求字段透传（避免死字段）。
    # ST 1.18.0 group_chat.allow_self_responses: 允许同一角色连续两次发言
    # （NATURAL/TALKATIVE 默认会排除上一位发言者）。_resolve_group_speaker 从
    # GroupChat 归一化到本字段，供发言调度使用。
    allow_self_responses: bool = False
    # ST 1.18.0 prompt_order — when a PromptPreset id is provided, the
    # assembly reads prompt_order / prompt_disabled from the preset and
    # applies minimal reordering to dynamic_context_parts.
    prompt_preset_id: Optional[str] = None
    # ST 1.18.0 extension_prompts — 运行时由前端 / 插件通过 API 传入的
    # 扩展提示词条目。每个条目按 position/depth/role 注入到 messages 或
    # system_prompt。详见 _inject_extension_prompts。
    # 元素可以是 dict 或 backend.app.api.character_ext.ExtensionPromptInput
    # Pydantic 模型（_collect_extension_prompts 会通过 model_dump() 兼容处理）：
    #   {"identifier": str, "content": str, "position": int, "depth": int,
    #    "role": str, "filter": Optional[Dict[str, Any]]}
    extension_prompts: list[Any] = field(default_factory=list)
    # Task 7: ST generate_interceptor 消息重排同步。
    # 前端 ST 扩展（如 vectors_rearrangeChat）重排 window.chat 后，
    # 将重排后的消息 ID 顺序通过此字段传递给后端，后端按此顺序装配 prompt。
    # 空列表表示使用默认顺序（按 created_at 升序）。
    message_order: list[str] = field(default_factory=list)
    # P0-3: ST generate_interceptor 消息排除同步。
    # 前端拦截器可从 chat 数组中删除消息（原地 splice）；被删除的消息 ID 通过
    # 此字段传递，后端装配时从 DB 历史中排除这些消息（不影响落库数据）。
    # 与 message_order 一起构成 interceptor_result 回传协议的装配侧。
    excluded_message_ids: list[str] = field(default_factory=list)
    # E-8 修复: 请求级缓存（GroupChat / InstructTemplate 等装配路径高频重复
    # 查询的实体），避免单次装配 15-22 次基础 SQL。不进 repr。
    _cache: dict = field(default_factory=dict, repr=False)


@dataclass
class PromptAssemblyReportItem:
    key: str
    status: str
    detail: str = ""
    tokens_estimate: int = 0


@dataclass
class PromptAssemblyResult:
    messages: list[dict[str, Any]]
    system_prompt: str
    dynamic_context_parts: list[str]
    effective_max_tokens: int
    memory_mode: str
    prompt_language: str
    report: list[PromptAssemblyReportItem]
    total_tokens_estimate: int = 0
    token_budget: int = 0
    # ST 1.18.0 instruct mode — stop sequences to pass to the model endpoint.
    # Populated when instruct mode is enabled and the bound template defines a
    # stop_sequence; empty otherwise (preserves existing behavior).
    stop_sequences: list[str] = field(default_factory=list)
    # [PROMPT-EVERY-TURN 2026-10-02] 第 0 步铁证：本轮 extension_prompts 的
    # received（请求体原始携带）/ applied（合并 DB 持久层、@bubble 门控与 filter
    # 后实际注入）条数与字符量。随装配结果带回，由 API 层落库进 assistant 消息
    # extra.ext_prompts（0 条也显式写）——规范缺席不再静默。
    ext_prompts_evidence: dict = field(default_factory=dict)

    def debug_dict(self) -> dict[str, Any]:
        return {
            "message_count": len(self.messages),
            "dynamic_context_count": len(self.dynamic_context_parts),
            "effective_max_tokens": self.effective_max_tokens,
            "memory_mode": self.memory_mode,
            "prompt_language": self.prompt_language,
            "total_tokens_estimate": self.total_tokens_estimate,
            "token_budget": self.token_budget,
            "stop_sequences": list(self.stop_sequences),
            "report": [item.__dict__ for item in self.report],
        }


# 统一 token 估算入口：优先使用 ST 对齐的 tokenizer 服务（按当前模型选择
# tiktoken / sentencepiece / hf-tokenizers），回退到 api.tokenizer 的
# count_tokens（基于 tiktoken cl100k_base / 改进启发式），最后回退到
# 本地估算。采用懒加载避免 services ↔ api 之间的循环导入。
_count_tokens_fn = None

# E-2 修复: 按 (model, text) 进程内 LRU 缓存 token 估算结果。
# 装配路径会对同一条消息内容反复估算（裁剪循环、强制项统计等），
# 缓存避免重复 BPE 编码。lru_cache 线程安全，可供 to_thread 线程池并发访问。
_TOKEN_COUNT_CACHE_MAXSIZE = 4096


@lru_cache(maxsize=_TOKEN_COUNT_CACHE_MAXSIZE)
def _cached_st_token_count(text: str, model: str) -> int:
    """ST 对齐 tokenizer 的缓存包装（E-2 修复）。"""
    from ..services.st_tokenizer_service import get_token_count

    return get_token_count(text, model)


def _estimate_tokens(text: str) -> int:
    value = str(text or "")
    # Phase F: 当模型已设置时，使用 ST 对齐的 tokenizer 进行精确计数
    try:
        from ..services.st_tokenizer_service import get_current_model
        model = get_current_model()
        if model:
            return _cached_st_token_count(value, model)
    except Exception as _tok_exc:  # pragma: no cover - 极端情况下回退到旧逻辑
        # [SILENT-FAIL 2026-10-22] 这是**逐消息/逐 token 调用**的热路径，失败一次就会
        # 失败一万次 ⇒ 用 once=True 只写第一条日志、后续只计数，避免刷屏。
        # 但它必须留痕：tokenizer 挂掉意味着所有预算判断（记忆门控 / 裁剪）都退化，
        # 而装配链会照常出结果 —— 没人知道预算是错的。
        _record_silent_failure("prompt_assembly.estimate_tokens.st_tokenizer", _tok_exc, once=True)
    # 无模型时回退到原有行为（tiktoken cl100k_base 或启发式估算）
    #
    # ⚠️ [TOK-ZH 2026-10-12] cl100k_base 是 OpenAI 的 BPE，对中文几乎一字一 token，
    # 实测在真实语料上**高估 95.2%**（真值 85,266 / cl100k 166,437）。
    # 装配侧的所有预算判断（记忆门控 / token_budget 裁剪）都建立在这个估算上，
    # 高估会直接导致误裁剪与误检索 ⇒ **无模型时优先用中文感知启发式**，
    # 不再走 cl100k。`PALINK_TOK_LEGACY_CL100K=1` 可一键退回旧行为。
    if os.getenv("PALINK_TOK_LEGACY_CL100K", "").strip() in ("1", "true", "yes"):
        global _count_tokens_fn
        if _count_tokens_fn is None:
            try:
                from ..api.tokenizer import count_tokens as _count_tokens_fn  # type: ignore
            except Exception:  # pragma: no cover - 极端情况下回退到本地估算
                _count_tokens_fn = _local_estimate_tokens
        return _count_tokens_fn(value)
    return _local_estimate_tokens(value)


def _local_estimate_tokens(text: str) -> int:
    """本地回退估算。

    ⚠️ [TOK-ZH 2026-10-12] 原式 ``chinese_chars * 2 + english_words`` 对中文
    **每字算 2 token**，而真值约 0.64 ⇒ **高估约 212%**，是整条回退链里最差的一档。
    高估会连锁导致：`_memory_gate_should_skip` 误判"历史装不下"⇒ 每轮白白做一次
    向量检索；`_apply_token_budget` 误触发裁剪 ⇒ 世界书/记忆被砍。
    改为中文感知启发式（中文 0.70 / 非中文 0.38 tok 每字符），
    系数经真实语料 + 真实 deepseek tokenizer 拟合与留出验证，误差 ≤ ~3%。
    """
    try:
        from ..services.st_tokenizer_service import smart_guesstimate
        return smart_guesstimate(str(text or ""))
    except Exception:  # pragma: no cover - 极端情况下退回原式
        value = str(text or "")
        chinese_chars = len([ch for ch in value if "\u4e00" <= ch <= "\u9fff"])
        english_words = len(value.split())
        return chinese_chars * 2 + english_words


def _estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    total = 0
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    total += _estimate_tokens(part.get("text", ""))
        else:
            total += _estimate_tokens(str(content))
    return total


# ── Task 3.5.1: Token budget calculation ──────────────────────────────
# Default context window when model lookup fails or model is unknown.
# Aligns with ST 1.18.0's default openai_max_context fallback.
_DEFAULT_CONTEXT_WINDOW = 8192
# Tokens reserved for the model's response (generation budget) when
# computing the prompt token budget. This is subtracted from the context
# window alongside the user-requested max_tokens.
_TOKEN_BUDGET_RESERVE = 512


def _get_model_context_window(model_id: Optional[str]) -> int:
    """Look up the context window size (in tokens) for a given model.

    Uses the unified model registry to find ``context_length`` on the
    model data. Returns ``_DEFAULT_CONTEXT_WINDOW`` when the model is
    unknown, the registry is unavailable, or the looked-up value is
    non-positive. This mirrors ST 1.18.0's ``openai_max_context`` behavior
    where the context window drives the prompt token budget.
    """
    if not model_id:
        return _DEFAULT_CONTEXT_WINDOW
    try:
        from ..services.unified_model_registry import find_model
        _, model_data = find_model(model_id)
        if model_data and isinstance(model_data, dict):
            ctx = model_data.get("context_length") or model_data.get("context_window")
            if isinstance(ctx, int) and ctx > 0:
                return ctx
            if isinstance(ctx, str) and ctx.isdigit():
                return int(ctx)
    except Exception as exc:
        logger.debug("Failed to look up context window for model %r: %s", model_id, exc)
    return _DEFAULT_CONTEXT_WINDOW


def _compute_prompt_token_budget(
    model_id: Optional[str],
    effective_max_tokens: int,
    context_window_override: Optional[int] = None,
) -> int:
    """Compute the token budget available for the prompt (context + messages).

    ``token_budget = context_window - max_tokens - reserve``

    The reserve covers framing overhead (role tags, separators) that the
    tokenizer may not fully account for. Falls back to
    ``effective_max_tokens`` when the computed budget is non-positive,
    preserving the legacy behavior where the generation max_tokens doubled
    as the prompt budget.

    P1-2 修复: 新增 ``context_window_override`` 参数，对齐 ST 1.18.0
    ``openai_max_context`` 用户配置优先于模型注册表的语义。当用户在
    silly_tavern_settings["oai_settings"]["openai_max_context"] 显式设置
    上下文窗口大小时，该值优先于模型注册表查询结果。
    """
    # P1-2 修复: 用户配置的 openai_max_context 优先于模型注册表
    if isinstance(context_window_override, int) and context_window_override > 0:
        context_window = context_window_override
    else:
        context_window = _get_model_context_window(model_id)
    budget = context_window - int(effective_max_tokens or 0) - _TOKEN_BUDGET_RESERVE
    if budget <= 0:
        # Fallback: use effective_max_tokens as the budget (legacy behavior)
        return max(1, int(effective_max_tokens or _DEFAULT_CONTEXT_WINDOW))
    return budget


def _get_model_context_window_strict(model_id: Optional[str]) -> Optional[int]:
    """与 _get_model_context_window 同源，但**查不到就返回 None**（不回落 8192）。

    存在的理由：硬底只能用「注册表真正知道」的窗口去夹。若拿 8192 这个默认值当底，
    未收录模型（用户自接的新模型）会被误夹到 8K，那是功能回退不是保护。
    """
    if not model_id:
        return None
    try:
        from ..services.unified_model_registry import find_model
        _, model_data = find_model(model_id)
        if model_data and isinstance(model_data, dict):
            ctx = model_data.get("context_length") or model_data.get("context_window")
            if isinstance(ctx, int) and ctx > 0:
                return ctx
            if isinstance(ctx, str) and ctx.isdigit():
                return int(ctx)
    except Exception as exc:
        logger.debug("Failed to look up context window for model %r: %s", model_id, exc)
    return None


def _read_openai_max_context_from_oai(oai: Any) -> Optional[int]:
    """从一份 oai_settings 形状的对象里取 openai_max_context（bool 不算数）。"""
    if not isinstance(oai, dict):
        return None
    value = oai.get("openai_max_context")
    if isinstance(value, bool):            # bool 是 int 子类，显式排除
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _get_openai_max_context_override(
    user_setting: Optional[Any],
    model_id: Optional[str] = None,
    character_id: Optional[str] = None,
) -> Optional[int]:
    """P1-2 修复: 从 UserSetting.silly_tavern_settings 读取用户配置的
    ``openai_max_context``（对齐 ST 1.18.0 oai_settings.openai_max_context）。

    ST 1.18.0 中 ``openai_max_context`` 是用户在前端配置的上下文窗口大小
    （如 8192/16384/32768），优先级高于模型注册表。Palink 默认使用模型
    注册表的 ``context_length``，但当用户显式设置了 ST 兼容配置时，
    应尊重该值以对齐 ST 的 token 预算行为。

    **闸 3（引擎硬底，2026-10-04）**：传入 ``model_id`` 且注册表认识该模型时，
    结果一律 ``min(声明值, 模型真实窗口)``。此前这里**原样采信**声明值，
    意味着填 200 万就能把单次请求的提示词预算顶到 200 万 token —— 插件、
    以及用户自己手滑都越不过这道底。注册表不认识的模型**不夹**（理由见
    _get_model_context_window_strict）。

    **L2 放行（2026-10-04，用户裁定"放 A 半桶 + 生成参数封顶放"）**：
    ``character_id`` 传入时，额外读该卡的按卡影子副本
    ``plugin_extension_settings_by_character[<卡>].chatCompletionSettings``，
    优先级 **卡影子 > 用户设置 > 模型注册表** —— 三层都要过闸 3。
    作用域天然受限：那份影子是按 (用户, 卡) 存的，插件改不到别人的卡、
    也改不到全站默认值；能改到的只有"这张卡自己的窗口请求值"，且被夹住。

    返回 None 表示未配置，调用方应回退到模型注册表查询。
    """
    if not user_setting:
        return None
    st_raw = getattr(user_setting, "silly_tavern_settings", None)
    if not st_raw:
        return None
    try:
        st = json.loads(st_raw) if isinstance(st_raw, str) else st_raw
        if not isinstance(st, dict):
            return None
        raw: Optional[int] = None
        if character_id:
            by_char = st.get("plugin_extension_settings_by_character")
            bucket = by_char.get(str(character_id)) if isinstance(by_char, dict) else None
            if isinstance(bucket, dict):
                raw = _read_openai_max_context_from_oai(bucket.get("chatCompletionSettings"))
        if raw is None:
            raw = _read_openai_max_context_from_oai(st.get("oai_settings"))
        if raw is None:
            return None
        return _clamp_context_window(raw, model_id)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def _clamp_context_window(value: int, model_id: Optional[str]) -> int:
    """把用户/插件声明的上下文窗口夹到模型真实窗口（闸 3）。夹了就留痕。"""
    real = _get_model_context_window_strict(model_id)
    if real is not None and value > real:
        logger.warning(
            "[CTX-CLAMP] openai_max_context %d → %d（模型 %s 的真实窗口）；"
            "来源=用户或插件设置，已被引擎硬底夹住",
            value, real, model_id,
        )
        return real
    return value


def _get_history_reserve(user_setting: Optional[Any]) -> int:
    """P1-2 修复: 从 UserSetting 读取 chat history 预留 token 数。

    ST 1.18.0 没有独立的 ``history_reserve`` 概念（历史与其它提示项共享
    整个 token 预算），Palink 此前硬编码 4096 作为历史预留，导致小窗口
    模型（如 8K）可用上下文过小。修复后：
    - 默认值降为 1024（保留少量历史空间，避免完全无历史）
    - 允许通过 ``silly_tavern_settings["palink_history_reserve"]`` 自定义
    """
    if not user_setting:
        return _DEFAULT_HISTORY_RESERVE
    st_raw = getattr(user_setting, "silly_tavern_settings", None)
    if not st_raw:
        return _DEFAULT_HISTORY_RESERVE
    try:
        st = json.loads(st_raw) if isinstance(st_raw, str) else st_raw
        if isinstance(st, dict):
            value = st.get("palink_history_reserve")
            if isinstance(value, int) and value >= 0:
                return value
            if isinstance(value, str) and value.isdigit():
                return int(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return _DEFAULT_HISTORY_RESERVE


# P1-2 修复: 默认 history_reserve 从 4096 降为 1024。
# 原 4096 硬编码对 8K 上下文模型占用过多（50%），1024 对齐 ST 的"轻量预留"
# 策略，让 _apply_dynamic_trimming 优先级裁剪接管大部分预算管理。
_DEFAULT_HISTORY_RESERVE = 1024


# ── [ASM-4 2026-10-24] 装配层设置开关（既有 silly_tavern_settings JSON 通道）──
# 落点：UserSetting.silly_tavern_settings → extension_settings.palink_assembly 子键。
# 选 extension_settings 而非顶层平铺键的原因：/api/settings/save 对顶层是整块
# 替换（ST 前端 saveSettings 只回传它认识的字段，平铺键会被静默擦掉——P2-2 同源
# 教训），对 extension_settings 做 namespace 级增量合并，开关值不会被前端保存冲掉。
# 不加列、不迁移。
def _read_palink_assembly_flags(user_setting: Optional[Any]) -> dict:
    """读取装配层开关。当前键：
    - ``new_main_chat``（D-7 newMainChat 历史区头，P-DEC-6 默认开）
    解析失败/键缺席一律回落默认值（默认=与 ST 一致）。
    """
    flags: dict = {"new_main_chat": True}
    if user_setting is None:
        return flags
    st_raw = getattr(user_setting, "silly_tavern_settings", None)
    if not st_raw:
        return flags
    # [SILENT-FAIL 2026-10-22] 设置 blob 解析失败回落默认值（开关缺席=开）；
    # 用 record 通道留痕，不走静默吞（test_silent_failure_guard 双棘轮）。
    from ..core.silent_failure import swallow as _sf_swallow

    with _sf_swallow(
        "prompt_assembly.palink_assembly_flags_parse",
        user_id=getattr(user_setting, "user_id", None),
    ):
        st = json.loads(st_raw) if isinstance(st_raw, str) else st_raw
        ext = st.get("extension_settings") if isinstance(st, dict) else None
        pa = ext.get("palink_assembly") if isinstance(ext, dict) else None
        if isinstance(pa, dict) and "new_main_chat" in pa:
            flags["new_main_chat"] = bool(pa.get("new_main_chat"))
    return flags


def _new_main_chat_prompt_text(is_zh: bool, is_group: bool) -> str:
    """D-7 历史区头文案（自写：ST 默认 new_chat_prompt "[Start a new Chat]" 的
    汉化等价表述与英文改写，不照抄 ST 英文原文；群聊对应 new_group_chat_prompt）。"""
    if is_group:
        return "[开始新的群聊对话]" if is_zh else "[Start of a new group conversation]"
    return "[开始新的对话]" if is_zh else "[Start of a new conversation]"


# ── Task 3.5.4: Prompt collection ─────────────────────────────────────
# Standard prompt source identifiers. Mirrors the ST 1.18.0 prompt_order
# identifier set (see openai.js prompt_order) extended with Palink-specific
# sources (smart_card_context, plotline, response_length, group_member_profiles).
# These identifiers are used by _collect_prompt_sources to tag each assembled
# message with its source, enabling full prompt_order reordering and
# priority-based dynamic trimming (Task 3.5.2 / 3.5.3).

# Prompt identifiers aligned with ST 1.18.0 (openai.js prompt_order):
PROMPT_ID_SYSTEM_PROMPT = "main"                  # ST: main system prompt
PROMPT_ID_CHAR_DESCRIPTION = "charDescription"   # ST: character description
PROMPT_ID_PERSONA_DESCRIPTION = "personaDescription"  # ST: persona
PROMPT_ID_CHAR_PERSONALITY = "charPersonality"   # ST: character personality
PROMPT_ID_SCENARIO = "scenario"                  # ST: scenario
PROMPT_ID_WORLD_INFO_BEFORE = "worldInfoBefore"  # ST: world info before
PROMPT_ID_WORLD_INFO_AFTER = "worldInfoAfter"   # ST: world info after
PROMPT_ID_CHAT_HISTORY = "chatHistory"          # ST: chat history
PROMPT_ID_EXAMPLE_DIALOGUE = "exampleDialogue"  # ST: example messages
PROMPT_ID_POST_HISTORY = "postHistoryInstructions"  # ST: post-history
PROMPT_ID_AUTHOR_NOTE = "authorNote"             # ST: author's note
PROMPT_ID_GROUP_PROFILES = "groupMemberProfiles"  # Palink: group profiles
# Palink-specific dynamic context identifiers (kept for backward compat
# with existing PromptPreset.prompt_order values):
PROMPT_ID_WORLDBOOK = "worldbook"                # Palink: worldbook
PROMPT_ID_PLOTLINE = "plotline"                  # Palink: plotline
PROMPT_ID_MEMORY = "memory"                      # Palink: memory
PROMPT_ID_SMART_CARD = "smart_card_context"      # Palink: smart card
PROMPT_ID_RESPONSE_LENGTH = "response_length"    # Palink: response length hint
PROMPT_ID_USER_MESSAGE = "user_message"          # Palink: current user input
PROMPT_ID_FINAL_REMINDER = "final_reminder"      # Palink: final reminder

# Mapping from Palink dynamic_context_part keys to ST-compatible identifiers
# (used when reordering dynamic_context_parts AND the full messages array).
_PALINK_KEY_TO_ST_ID: dict[str, str] = {
    "worldbook": PROMPT_ID_WORLD_INFO_BEFORE,  # worldbook is conceptually world_info_before
    "plotline": PROMPT_ID_PLOTLINE,
    "memory": PROMPT_ID_MEMORY,
    "smart_card_context": PROMPT_ID_SMART_CARD,
    "response_length": PROMPT_ID_RESPONSE_LENGTH,
}

# P1-1 修复: 角色卡字段 ST 标识符集合。当 prompt_preset.prompt_order 包含
# 这些标识符时，palink-native 路径会把角色卡字段抽取为独立 system 消息，
# 使其可被 prompt_order 重排（对齐 ST 1.18.0 openai.js:1461 的分离装配）。
_CHAR_FIELD_ST_IDS: frozenset[str] = frozenset({
    PROMPT_ID_CHAR_DESCRIPTION,
    PROMPT_ID_CHAR_PERSONALITY,
    PROMPT_ID_SCENARIO,
    PROMPT_ID_WORLD_INFO_BEFORE,
    PROMPT_ID_WORLD_INFO_AFTER,
})


def _preset_order_identifiers(preset: Optional[PromptPreset]) -> set[str]:
    """提取 PromptPreset.prompt_order 中出现过的所有标识符。

    P1-1 修复辅助函数：用于判断 preset 是否要求对角色卡字段进行重排。
    """
    if preset is None:
        return set()
    raw_order = getattr(preset, "prompt_order", None)
    if not raw_order:
        return set()
    try:
        prompt_order = json.loads(raw_order) if isinstance(raw_order, str) else raw_order
    except (json.JSONDecodeError, TypeError):
        return set()
    if not isinstance(prompt_order, list):
        return set()
    ids: set[str] = set()
    for item in prompt_order:
        if isinstance(item, str):
            ids.add(item)
        elif isinstance(item, dict) and isinstance(item.get("identifier"), str):
            ids.add(item["identifier"])
    return ids


def _should_split_char_fields_for_order(
    preset: Optional[PromptPreset],
) -> bool:
    """P1-1 修复：判断是否需要把角色卡字段抽取为独立可重排消息。

    当已绑定 PromptPreset 且其 prompt_order 包含至少一个角色卡字段标识符
    （charDescription / charPersonality / scenario / worldInfoBefore / worldInfoAfter）
    时返回 True。

    默认行为（无 preset 或 preset 不含角色卡字段）保持不变，system_prompt 仍为
    合并形态，避免影响未使用 prompt_order 的常规角色对话。
    """
    if preset is None:
        return False
    order_ids = _preset_order_identifiers(preset)
    return bool(order_ids & _CHAR_FIELD_ST_IDS)


def _extract_char_field_messages_for_order(
    req: "PromptAssemblyRequest",
    preset: Optional[PromptPreset],
    char_name: str,
) -> list[dict[str, Any]]:
    """P1-1 修复：把角色卡字段抽取为独立 system 消息，供 prompt_order 重排。

    返回的每个消息形如：
        {"role": "system",
         "content": "<字段内容>",
         "_palink_prompt_id": "<ST 标识符>",
         "_palink_char_field_proxy": True}

    当不需要拆分（_should_split_char_fields_for_order 返回 False）时返回空列表，
    保留原有合并装配行为。

    说明：
    - palink-native 默认把 description/personality/scenario 合并进 system_prompt，
      无法被 prompt_order 重排。此函数把这些字段额外以独立 system 消息形式注入
      messages 数组（紧跟 system_prompt 之后），使其可被 _apply_full_prompt_order
      重排。LLM 会看到字段内容出现在 preset 指定的位置。
    - 字段内容使用原始值（不做宏替换，宏替换在后续 evaluate_macros 阶段统一处理）。
    - worldInfoBefore/worldInfoAfter 字段不在此抽取（它们由 worldbook 扫描结果
      填充，而非角色卡字段），仅当 preset 显式包含其标识符时由外层装配处理。
    """
    if not _should_split_char_fields_for_order(preset):
        return []

    messages: list[dict[str, Any]] = []
    char = req.char
    # 仅抽取角色卡本体字段（description/personality/scenario），不重复抽取
    # worldInfoBefore/worldInfoAfter（这些由世界书扫描结果驱动）。
    field_specs: list[tuple[str, str]] = [
        (PROMPT_ID_CHAR_DESCRIPTION, getattr(char, "description", None) or ""),
        (PROMPT_ID_CHAR_PERSONALITY, getattr(char, "personality", None) or ""),
        (PROMPT_ID_SCENARIO, getattr(char, "scenario", None) or ""),
    ]
    for identifier, value in field_specs:
        text = (value or "").strip()
        if not text:
            continue
        # 仅当 preset 的 prompt_order 显式包含该标识符时才抽取为独立消息，
        # 避免对 preset 未声明的字段产生重复内容。
        order_ids = _preset_order_identifiers(preset)
        if identifier not in order_ids:
            continue
        messages.append({
            "role": "system",
            "content": text,
            "_palink_prompt_id": identifier,
            "_palink_char_field_proxy": True,
        })
    return messages


@dataclass
class PromptSource:
    """Metadata for a single prompt source in the assembled messages array.

    Task 3.5.4: Each source carries its ST 1.18.0 prompt identifier, role,
    content (for token counting), message index, and trimming priority.
    ``priority`` drives dynamic ordering (Task 3.5.3): higher priority
    sources are retained when the token budget is exceeded, while lower
    priority sources are trimmed first.
    """
    identifier: str
    role: str
    content: str
    message_index: int
    token_count: int = 0
    priority: int = 0  # higher = keep; lower = trim first
    trimmable: bool = True


# Trimming priorities (Task 3.5.3). Higher values are retained longer.
# System prompt and the most recent user message are never trimmed.
_TRIM_PRIORITY_SYSTEM = 100        # system_prompt — never trim
_TRIM_PRIORITY_RECENT = 90         # recent chat history (last N messages)
_TRIM_PRIORITY_USER_MSG = 95       # current user message — never trim
_TRIM_PRIORITY_WORLDBOOK = 80      # current worldbook hits
_TRIM_PRIORITY_AUTHORS_NOTE = 70   # author's note
_TRIM_PRIORITY_PERSONA = 65         # persona description
_TRIM_PRIORITY_POST_HISTORY = 60   # post-history instructions
_TRIM_PRIORITY_FINAL_REMINDER = 55 # final reminder system message
_TRIM_PRIORITY_MEMORY = 50         # memory context
_TRIM_PRIORITY_PLOTLINE = 45       # plotline context
_TRIM_PRIORITY_GROUP_PROFILES = 40 # group member profiles
_TRIM_PRIORITY_RESPONSE_LENGTH = 35  # response length hint
_TRIM_PRIORITY_SMART_CARD = 30     # smart card context
_TRIM_PRIORITY_EXAMPLES = 20       # example dialogue — trim first
_TRIM_PRIORITY_EARLY_HISTORY = 10  # early chat history — trim first
_TRIM_PRIORITY_LOW = 0             # default / unknown


def _message_content_to_text(content: Any) -> str:
    """Extract plain text from a message content (str or multimodal list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
        return "\n".join(parts)
    return str(content or "")


def _classify_message_identifier(
    message: dict[str, Any],
    index: int,
    total: int,
    char: Character,
) -> str:
    """Classify a message into its ST 1.18.0 prompt identifier.

    Heuristic classification based on message role, position, and content
    markers. This is used by _collect_prompt_sources to tag each message
    for prompt_order reordering and dynamic trimming.

    P1-1 修复：优先读取消息上的 ``_palink_prompt_id`` 显式标记。该标记由
    ``_extract_char_field_messages_for_order`` 设置，使角色卡字段代理消息
    能被精确识别为 charDescription/charPersonality/scenario 等标识符，
    而不依赖内容启发式判断。
    """
    # P1-1 修复: 显式标记优先（角色卡字段代理消息）
    explicit_id = message.get("_palink_prompt_id")
    if isinstance(explicit_id, str) and explicit_id:
        return explicit_id

    # [IN-CHAT-NOT-TRIMMED 2026-10-05] in-chat 注入（at-depth 世界书 / AN(IN_CHAT) /
    # persona(pos=0) / /inject / 插件 IN_CHAT / 角色 depth_prompt）。
    #
    # ST 把这类内容排在**聊天历史预算裁剪之前**注入：openai.js:1325 先
    # populationInjectionPrompts 拼好 messages，:1331 才 populateChatHistory 走预算；
    # 而 script.js:4834 的裁剪只遍历聊天历史数组，注入条目不在其中 → 结构上永不被裁。
    #
    # 此前本函数没有这个分支，in-chat 注入落到末尾兜底
    # `PROMPT_ID_WORLD_INFO_BEFORE`（优先级 80，trimmable=True），于是超预算时
    # 卡片自己声明的格式规范（MVU 变量更新格式、<cg> 立绘标签规范等）被当成
    # 世界书正文块优先裁掉——模型压根收不到指令，自然产不出对应标签。
    #
    # 返回 chatHistory 而非新标识：ST 的 prompt_order 枚举里没有"in-chat 注入"
    # 这一项（它不在 prompt_order 可排序的槽位里），借用 chatHistory 可避免
    # 破坏既有 PromptPreset.prompt_order 配置；真正的"不裁剪"在
    # _collect_prompt_sources 的优先级分支里单独处理（见 _IN_CHAT 标记）。
    if message.get("_palink_in_chat_injection"):
        return PROMPT_ID_CHAT_HISTORY

    role = message.get("role", "user")
    content = _message_content_to_text(message.get("content", ""))
    content_stripped = content.strip()

    # First system message is the main system prompt
    if index == 0 and role == "system":
        return PROMPT_ID_SYSTEM_PROMPT

    # Example dialogue (injected by build_character_chat_messages)
    if role == "system" and content_stripped.startswith("Example dialogue:"):
        return PROMPT_ID_EXAMPLE_DIALOGUE

    # Post-history instructions
    if role == "system" and char.post_history_instructions and content_stripped == char.post_history_instructions.strip():
        return PROMPT_ID_POST_HISTORY

    # Author note (queued as a final system message)
    if role == "system" and content_stripped.startswith("[Author"):
        return PROMPT_ID_AUTHOR_NOTE

    # Persona description
    if role == "system" and content_stripped.startswith("[Persona:"):
        return PROMPT_ID_PERSONA_DESCRIPTION

    # Group profiles
    if role == "system" and content_stripped.startswith("[当前发言者身份]"):
        return PROMPT_ID_GROUP_PROFILES
    if role == "system" and content_stripped.startswith("[当前可发言成员]"):
        return PROMPT_ID_GROUP_PROFILES

    # Smart card context
    if role == "system" and content_stripped.startswith("[Smart card selected start context]"):
        return PROMPT_ID_SMART_CARD

    # Palink /inject
    if role == "system" and content_stripped.startswith("[Palink injection"):
        return PROMPT_ID_POST_HISTORY

    # Final reminder / detect / status instructions
    if role == "system" and (content_stripped.startswith("[Final Reminder]") or content_stripped.startswith("【最后提醒】")):
        return PROMPT_ID_FINAL_REMINDER
    if role == "system" and content_stripped.startswith("[Character Calibration]"):
        return PROMPT_ID_FINAL_REMINDER
    if role == "system" and content_stripped.startswith("【角色校准】"):
        return PROMPT_ID_FINAL_REMINDER

    # User/assistant messages in chat history
    if role in ("user", "assistant"):
        return PROMPT_ID_CHAT_HISTORY

    # Dynamic context system messages (worldbook, memory, plotline, etc.)
    # — classified by content markers as a fallback
    if role == "system":
        # Heuristic: large system messages in the middle are likely dynamic context
        return PROMPT_ID_WORLD_INFO_BEFORE

    return PROMPT_ID_CHAT_HISTORY


def _collect_prompt_sources(
    messages: list[dict[str, Any]],
    char: Character,
    recent_history_count: int = 4,
) -> list[PromptSource]:
    """Task 3.5.4: Collect all prompt sources into a unified list.

    Tags each message with its ST 1.18.0 prompt identifier, role, content,
    token count, and trimming priority. The returned list parallels the
    ``messages`` array (same length, same order).

    ``recent_history_count`` controls how many of the most recent chat
    history messages are classified as "recent" (high priority, not
    trimmed). Earlier chat history messages get a lower priority.
    """
    total = len(messages)
    sources: list[PromptSource] = []
    # Collect chat history message indices to identify recent vs early
    chat_history_indices: list[int] = []
    for i, m in enumerate(messages):
        identifier = _classify_message_identifier(m, i, total, char)
        if identifier == PROMPT_ID_CHAT_HISTORY:
            chat_history_indices.append(i)

    # Mark the last N chat history messages as "recent" (high priority)
    recent_threshold = max(0, len(chat_history_indices) - recent_history_count)
    chat_history_recent_set = set(chat_history_indices[recent_threshold:])

    for i, m in enumerate(messages):
        identifier = _classify_message_identifier(m, i, total, char)
        role = m.get("role", "user")
        content_text = _message_content_to_text(m.get("content", ""))
        token_count = _estimate_tokens(content_text)

        # Assign trimming priority
        priority = _TRIM_PRIORITY_LOW
        trimmable = True
        # P1-1 修复: 角色卡字段代理消息（_palink_char_field_proxy）使用较低优先级，
        # 使其在 token 超预算时优先被裁剪，避免与 system_prompt 中合并的字段
        # 产生重复内容占用预算。
        if m.get("_palink_in_chat_injection"):
            # [IN-CHAT-NOT-TRIMMED 2026-10-05] 不可裁剪，且不受"最近 N 条"启发式影响
            # （in-chat 注入是卡的固定契约，位置由 depth 决定，与"离模型多近"无关）。
            priority = _TRIM_PRIORITY_SYSTEM
            trimmable = False
        elif m.get("_palink_char_field_proxy"):
            priority = _TRIM_PRIORITY_SMART_CARD  # 复用较低优先级（30）
            trimmable = True
        elif identifier == PROMPT_ID_SYSTEM_PROMPT:
            priority = _TRIM_PRIORITY_SYSTEM
            trimmable = False
        elif identifier in (
            PROMPT_ID_CHAR_DESCRIPTION, PROMPT_ID_CHAR_PERSONALITY, PROMPT_ID_SCENARIO,
        ):
            # [D-5b 2026-10-25] 三槽分立后必须**继承 main 的裁剪地位**。
            # 拆分前这三段在 main 文本内，随 main 一起 priority=100 / 不可裁；
            # 若让它们落到本函数末尾的兜底（charDescription 等标识符没有专门
            # 分支 ⇒ _TRIM_PRIORITY_LOW=0 且 trimmable=True），超预算时它们会
            # **第一批被裁掉**——那就是"拆分导致丢内容"。
            # （ST 侧这三项确实参与预算裁剪，但那是 ST 的既有行为；本批判据是
            #   「拆分本身不加也不丢内容」，故取保守：位置改、待遇不变。）
            priority = _TRIM_PRIORITY_SYSTEM
            trimmable = False
        elif identifier == PROMPT_ID_USER_MESSAGE:
            priority = _TRIM_PRIORITY_USER_MSG
            trimmable = False
        elif identifier == PROMPT_ID_EXAMPLE_DIALOGUE:
            priority = _TRIM_PRIORITY_EXAMPLES
        elif identifier == PROMPT_ID_CHAT_HISTORY:
            if i in chat_history_recent_set:
                priority = _TRIM_PRIORITY_RECENT
                trimmable = False  # never trim recent messages
            else:
                priority = _TRIM_PRIORITY_EARLY_HISTORY
        elif identifier == PROMPT_ID_WORLDBOOK:
            priority = _TRIM_PRIORITY_WORLDBOOK
        elif identifier in (PROMPT_ID_WORLD_INFO_BEFORE, PROMPT_ID_WORLD_INFO_AFTER):
            priority = _TRIM_PRIORITY_WORLDBOOK
        elif identifier == PROMPT_ID_AUTHOR_NOTE:
            priority = _TRIM_PRIORITY_AUTHORS_NOTE
        elif identifier == PROMPT_ID_PERSONA_DESCRIPTION:
            priority = _TRIM_PRIORITY_PERSONA
        elif identifier == PROMPT_ID_POST_HISTORY:
            priority = _TRIM_PRIORITY_POST_HISTORY
        elif identifier == PROMPT_ID_FINAL_REMINDER:
            priority = _TRIM_PRIORITY_FINAL_REMINDER
        elif identifier == PROMPT_ID_MEMORY:
            priority = _TRIM_PRIORITY_MEMORY
        elif identifier == PROMPT_ID_PLOTLINE:
            priority = _TRIM_PRIORITY_PLOTLINE
        elif identifier == PROMPT_ID_GROUP_PROFILES:
            priority = _TRIM_PRIORITY_GROUP_PROFILES
        elif identifier == PROMPT_ID_RESPONSE_LENGTH:
            priority = _TRIM_PRIORITY_RESPONSE_LENGTH
        elif identifier == PROMPT_ID_SMART_CARD:
            priority = _TRIM_PRIORITY_SMART_CARD

        sources.append(PromptSource(
            identifier=identifier,
            role=role,
            content=content_text,
            message_index=i,
            token_count=token_count,
            priority=priority,
            trimmable=trimmable,
        ))
    return sources


def _apply_full_prompt_order(
    messages: list[dict[str, Any]],
    sources: list[PromptSource],
    preset: Optional[PromptPreset],
    report: list[PromptAssemblyReportItem],
) -> tuple[list[dict[str, Any]], list[PromptSource]]:
    """Task 3.5.2: Reorder the full messages array by PromptPreset.prompt_order.

    Reads the preset's ``prompt_order`` JSON array and reorders both
    ``messages`` and ``sources`` by their identifier's position in that
    array. Non-reorderable messages (system_prompt at index 0, user message
    at the end) keep their relative positions. When no preset is bound or
    the preset has no prompt_order, messages are returned unchanged
    (backward compatible).
    """
    if preset is None:
        return messages, sources

    raw_order = getattr(preset, "prompt_order", None)
    if not raw_order:
        return messages, sources

    try:
        prompt_order = json.loads(raw_order) if isinstance(raw_order, str) else raw_order
    except (json.JSONDecodeError, TypeError):
        return messages, sources

    if not isinstance(prompt_order, list) or not prompt_order:
        return messages, sources

    # Build position map: identifier -> order index
    order_index: dict[str, int] = {}
    for i, item in enumerate(prompt_order):
        if isinstance(item, str):
            order_index[item] = i
        elif isinstance(item, dict) and isinstance(item.get("identifier"), str):
            order_index[item["identifier"]] = i
    if not order_index:
        return messages, sources

    # Split messages into: anchored (keep position) and reorderable.
    # Anchored: system_prompt (index 0) and the final user message.
    anchored: list[tuple[int, dict[str, Any], PromptSource]] = []
    reorderable: list[tuple[dict[str, Any], PromptSource]] = []
    final_user_idx: Optional[int] = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            final_user_idx = i
            break

    for i, (msg, src) in enumerate(zip(messages, sources)):
        if i == 0 and src.identifier == PROMPT_ID_SYSTEM_PROMPT:
            anchored.append((i, msg, src))
        elif i == final_user_idx and src.identifier == PROMPT_ID_CHAT_HISTORY:
            anchored.append((i, msg, src))
        else:
            reorderable.append((msg, src))

    # Stable sort reorderable by their identifier's position in prompt_order.
    # Also check Palink alias mapping so both ST identifiers and Palink keys
    # (e.g. "worldbook" and "worldInfoBefore") are honored.
    sentinel = len(order_index) + 1000

    def _order_key(item: tuple[dict[str, Any], PromptSource]) -> int:
        src = item[1]
        # Try the ST identifier directly
        pos = order_index.get(src.identifier)
        if pos is not None:
            return pos
        # Try Palink alias mapping
        for palink_key, st_id in _PALINK_KEY_TO_ST_ID.items():
            if src.identifier == st_id and palink_key in order_index:
                return order_index[palink_key]
        return sentinel

    reorderable.sort(key=_order_key)

    # Reassemble: anchored keep their relative positions, reorderable fill
    # the gaps in sorted order.
    new_messages: list[dict[str, Any]] = []
    new_sources: list[PromptSource] = []
    anchored_iter = iter(anchored)
    reorderable_iter = iter(reorderable)
    anchored_next = next(anchored_iter, None)
    reorderable_next = next(reorderable_iter, None)

    # Reconstruct by walking original positions: anchored messages stay at
    # their original index, reorderable messages fill the remaining slots
    # in sorted order.
    anchored_positions = {a[0] for a in anchored}
    total_len = len(messages)
    for i in range(total_len):
        if i in anchored_positions and anchored_next is not None:
            new_messages.append(anchored_next[1])
            new_sources.append(anchored_next[2])
            anchored_next = next(anchored_iter, None)
        elif reorderable_next is not None:
            new_messages.append(reorderable_next[0])
            new_sources.append(reorderable_next[1])
            reorderable_next = next(reorderable_iter, None)
        elif anchored_next is not None:
            # Fallback: append remaining anchored items
            new_messages.append(anchored_next[1])
            new_sources.append(anchored_next[2])
            anchored_next = next(anchored_iter, None)

    report.append(
        PromptAssemblyReportItem(
            "prompt_order_full",
            "applied",
            detail=f"preset={preset.name}; order_entries={len(order_index)}; reorderable={len(reorderable)}",
        )
    )
    return new_messages, new_sources


def _apply_dynamic_trimming(
    messages: list[dict[str, Any]],
    sources: list[PromptSource],
    token_budget: int,
    report: list[PromptAssemblyReportItem],
) -> tuple[list[dict[str, Any]], int]:
    """Task 3.5.3: Dynamically trim low-priority sources when over budget.

    When the total token count exceeds ``token_budget``, sources are
    removed in ascending priority order (lowest priority first) until the
    budget is met. Non-trimmable sources (system_prompt, recent messages,
    user message) are always retained.

    Returns the trimmed messages array and the new total token estimate.
    """
    total_tokens = sum(s.token_count for s in sources)
    if total_tokens <= token_budget:
        return messages, total_tokens

    # Build (priority, index, source) triples for trimmable sources, sorted
    # ascending by priority so the lowest-priority items are trimmed first.
    trimmable_indexed = sorted(
        [(s.priority, i, s) for i, s in enumerate(sources) if s.trimmable],
        key=lambda t: (t[0], t[2].token_count),
    )

    # Mark indices to remove, lowest priority first, until under budget.
    remove_indices: set[int] = set()
    current_total = total_tokens
    for _, idx, src in trimmable_indexed:
        if current_total <= token_budget:
            break
        remove_indices.add(idx)
        current_total -= src.token_count
        report.append(
            PromptAssemblyReportItem(
                "dynamic_trim",
                "trimmed",
                detail=f"identifier={src.identifier}; priority={src.priority}; tokens={src.token_count}; index={idx}",
            )
        )

    if not remove_indices:
        return messages, total_tokens

    new_messages = [m for i, m in enumerate(messages) if i not in remove_indices]
    report.append(
        PromptAssemblyReportItem(
            "dynamic_ordering",
            "applied",
            detail=f"trimmed={len(remove_indices)}; original_total={total_tokens}; trimmed_total={current_total}; budget={token_budget}",
        )
    )
    return new_messages, current_total


def _load_prompt_preset(db: Session, preset_id: Optional[str]) -> Optional[PromptPreset]:
    """Load a PromptPreset by id. Returns None when preset_id is empty or
    the preset does not exist. Preserves existing behavior when no preset
    is bound (passthrough).
    """
    if not preset_id:
        return None
    try:
        return db.query(PromptPreset).filter(PromptPreset.id == preset_id).first()
    except Exception as exc:
        logger.warning("Failed to load PromptPreset id=%r: %s", preset_id, exc)
        return None


def _apply_prompt_order(
    dynamic_context_parts: list[str],
    part_keys: list[str],
    preset: Optional[PromptPreset],
    report: list[PromptAssemblyReportItem],
) -> list[str]:
    """Optionally reorder dynamic_context_parts by PromptPreset.prompt_order.

    ``part_keys`` parallels ``dynamic_context_parts`` — each entry is the
    report key identifying the part (e.g. "worldbook", "plotline", "memory").
    When the preset defines a ``prompt_order`` JSON array, parts are sorted
    by their key's position in that array (unknown keys keep their relative
    order, appended after known keys). When no preset or no prompt_order is
    set, parts are returned unchanged (backward compatible).
    """
    if preset is None:
        return dynamic_context_parts

    raw_order = getattr(preset, "prompt_order", None)
    if not raw_order:
        report.append(PromptAssemblyReportItem("prompt_order", "skipped", "no prompt_order on preset"))
        return dynamic_context_parts

    try:
        prompt_order = json.loads(raw_order) if isinstance(raw_order, str) else raw_order
    except (json.JSONDecodeError, TypeError):
        report.append(PromptAssemblyReportItem("prompt_order", "skipped", "invalid prompt_order JSON"))
        return dynamic_context_parts

    if not isinstance(prompt_order, list) or not prompt_order:
        report.append(PromptAssemblyReportItem("prompt_order", "skipped", "empty prompt_order"))
        return dynamic_context_parts

    # Build a position map: key -> index in prompt_order (string identifiers).
    order_index: dict[str, int] = {}
    for i, item in enumerate(prompt_order):
        if isinstance(item, str):
            order_index[item] = i
        elif isinstance(item, dict) and isinstance(item.get("identifier"), str):
            order_index[item["identifier"]] = i

    if not order_index:
        report.append(PromptAssemblyReportItem("prompt_order", "skipped", "no identifiable entries"))
        return dynamic_context_parts

    # Stable sort by the key's position in prompt_order. Keys not in
    # prompt_order get a large sentinel so they retain their relative order
    # after known keys.
    sentinel = len(order_index) + 1000
    indexed = list(zip(part_keys, dynamic_context_parts))
    indexed.sort(key=lambda kv: order_index.get(kv[0], sentinel))
    reordered = [part for _, part in indexed]

    report.append(
        PromptAssemblyReportItem(
            "prompt_order",
            "applied",
            detail=f"preset={preset.name}; order_entries={len(order_index)}",
        )
    )
    return reordered


def _apply_token_budget(
    dynamic_context_parts: list[str],
    system_prompt: str,
    token_budget: int,
    report: list[PromptAssemblyReportItem],
    history_reserve: Optional[int] = None,
) -> tuple[list[str], int]:
    """P1-2 修复: history_reserve 默认值改为 None，由调用方通过
    _get_history_reserve(user_setting) 传入用户配置值；为 None 时使用
    _DEFAULT_HISTORY_RESERVE (1024)，不再硬编码 4096。
    """
    if history_reserve is None:
        history_reserve = _DEFAULT_HISTORY_RESERVE
    base_tokens = _estimate_tokens(system_prompt)
    part_tokens = [_estimate_tokens(part) for part in dynamic_context_parts]
    parts_total = sum(part_tokens)
    total = base_tokens + parts_total + history_reserve

    if total <= token_budget:
        return dynamic_context_parts, total

    parts_budget = max(0, token_budget - base_tokens - history_reserve)
    trimmed_parts: list[str] = []
    trimmed_total = base_tokens + history_reserve
    for i, part in enumerate(dynamic_context_parts):
        pt = part_tokens[i]
        if trimmed_total + pt - history_reserve <= parts_budget:
            trimmed_parts.append(part)
            trimmed_total += pt
        else:
            report.append(
                PromptAssemblyReportItem(
                    f"token_budget_trim_{i}",
                    "trimmed",
                    detail=f"part_index={i}; part_tokens={pt}; remaining_budget={parts_budget - (trimmed_total - base_tokens - history_reserve)}",
                )
            )

    report.append(
        PromptAssemblyReportItem(
            "token_budget",
            "applied",
            detail=f"original_total={total}; trimmed_total={trimmed_total}; budget={token_budget}; history_reserve={history_reserve}",
        )
    )
    return trimmed_parts, trimmed_total


def _response_length_guidance(
    response_length: Optional[str],
    prompt_lang: str,
    char: Character,
    contains_chinese: ContainsChineseFn,
) -> tuple[Optional[str], Optional[int]]:
    if not response_length:
        return None, None

    length_hints = {
        "short": "Write a moderate-length response, around 300-500 words. Provide enough detail without being overly verbose.",
        "medium": "Write a detailed and immersive response, around 600-1000 words. Be descriptive, include inner thoughts, sensory details and rich narrative.",
        "long": "Write a very long and deeply immersive response, around 1000 words or more. Be extremely detailed with rich descriptions, deep inner monologue, extensive dialogue, and thorough narrative development.",
    }
    length_hint = length_hints.get(response_length)
    if not length_hint:
        return None, None

    is_zh = prompt_lang == "zh" or (
        prompt_lang == "auto"
        and contains_chinese((char.name or "") + (char.description or ""))
    )
    if is_zh:
        length_hints_zh = {
            "short": "请写一个中等长度的回复，约300-500字。提供足够的细节但不要过于冗长。",
            "medium": "请写一个详细且沉浸感强的回复，约600-1000字。包含丰富的描写、内心想法、感官细节和生动的叙事。",
            "long": "请写一个非常长且深度沉浸的回复，约1000字或更多。包含极其丰富的描写、深度的内心独白、大量的对话和详尽的叙事发展。",
        }
        length_hint = length_hints_zh.get(response_length, length_hint)

    token_caps = {
        "short": 8192,
        "medium": 16384,
        "long": 32768,
    }
    return f"[Response Length Guidance] {length_hint}", token_caps.get(response_length)


# ── ST 1.18.0 extension_prompts 注入 ────────────────────────────
# 详见 spec：fix-st-native-runtime-parity-gaps Phase 3 组 A。
# position 枚举（与 ST script.js:491-496 完全对齐）：
#   -1 = NONE          不注入
#    0 = IN_PROMPT     作为 system prompt 追加到末尾（position='end'），不按 depth
#    1 = IN_CHAT       按 depth 注入到 chat history
#    2 = BEFORE_PROMPT 作为 system prompt 插入到最前（position='start'），不按 depth
# role 枚举（ST script.js:501-505）：0=SYSTEM/1=USER/2=ASSISTANT（int 或 str 均可）


def _normalize_ext_filter(raw: Any) -> dict:
    """归一化 filter 字段为 dict。
    兼容 None、list（旧式 character_ids）、dict 三种形式。
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        return {"character_ids": list(raw)}
    # JSON 字符串
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list):
                return {"character_ids": list(parsed)}
        except (json.JSONDecodeError, TypeError):
            pass
    return {}


def _ext_filter_allows(
    filter_dict: dict,
    character_id: str,
    session_id: str,
    source_key: Optional[str] = None,
) -> bool:
    """检查 filter 字段是否允许在当前 character_id / session_id 注入。

    - character_ids 非空时，character_id 必须在列表中
    - session_ids 非空时，session_id 必须在列表中
    - 任一字段为空 / 缺失表示不限制

    [XCHAR-PROMPT-BLEED 2026-10-03] source_key 分流（跨角色提示词串味修复）：

    `extension_prompts.source_key` 的既有语义是「非 NULL = 插件/卡脚本运行时
    上报的快照行，NULL = 用户手写或历史行」（见 models/extension_prompt.py:49-54
    与 alembic/0066）。本参数据此把"空 filter"的含义按来源一分为二：

    - source_key **非 NULL**（插件来源）：空 filter **不再放行**。插件注册却没绑卡
      = 配置错误，让它暴露，不要静默放行到所有卡的提示词里 —— 那正是「在角色 A
      的卡上生成、提示词里混进角色 B 的内容」的根因：两张卡共用一个池子
      （api/extension_prompts.py:83 查 session_id IS NULL 的全局行），
      合并点 merged[row.identifier] 后写顶掉先写。
      已有 character_ids 且命中 → 放行。
    - source_key 为 **NULL**（用户手写/历史）：保持「空 filter = 全局」原语义，
      **逐字节不变**（存量行全为 NULL → 零回归）。

    请求侧条目（来自前端运行时聚合）本身就没有 source_key，一律按插件来源处理：
    它们要么由当前角色的插件/卡脚本当场注册，要么已在本层按当前角色重新绑定。
    """
    if source_key:
        # 插件来源：必须显式命中 character_ids，空/缺失一律拒绝。
        char_ids = filter_dict.get("character_ids") if isinstance(filter_dict, dict) else None
        if not (isinstance(char_ids, list) and char_ids):
            logger.info(
                "[XCHAR-PROMPT-BLEED] 拒绝未绑定角色的插件注入 (identifier 归属 source_key=%s, char_id=%s): "
                "source_key 非 NULL 的行必须在 filter.character_ids 中绑定角色",
                source_key,
                character_id,
            )
            return False
        if str(character_id) not in [str(c) for c in char_ids]:
            return False
        sess_ids = filter_dict.get("session_ids")
        if isinstance(sess_ids, list) and sess_ids:
            if str(session_id) not in [str(s) for s in sess_ids]:
                return False
        return True

    if not isinstance(filter_dict, dict) or not filter_dict:
        return True
    char_ids = filter_dict.get("character_ids")
    if isinstance(char_ids, list) and char_ids:
        if str(character_id) not in [str(c) for c in char_ids]:
            return False
    sess_ids = filter_dict.get("session_ids")
    if isinstance(sess_ids, list) and sess_ids:
        if str(session_id) not in [str(s) for s in sess_ids]:
            return False
    return True


# [XCHAR-PROMPT-BLEED 2026-10-03] 请求侧（前端运行时现场注册）条目的来源键哨兵。
# 这些条目没有 DB 行的 source_key，但来源语义与「插件注册」一致，故复用非 NULL 分支。
_REQUEST_SIDE_SOURCE_KEY = "__request_side__"


def _normalize_ep_role(role_val) -> str:
    """归一化 extension_prompts 的 role 字段。

    ST extension_prompt_roles: 0=SYSTEM, 1=USER, 2=ASSISTANT。
    接受 int（ST 插件原生发送）或 str（向后兼容）。
    """
    if isinstance(role_val, bool):
        # bool 是 int 子类，先排除避免误判
        return "system"
    if isinstance(role_val, int):
        return {0: "system", 1: "user", 2: "assistant"}.get(role_val, "system")
    val = str(role_val or "system").strip().lower()
    if val not in ("system", "user", "assistant"):
        return "system"
    return val


# 裸闭合 XML 标签行（整行仅一个 </tag>，如 "</content>" / "</now_plot>"）
_BARE_CLOSE_TAG_LINE_RE = re.compile(r"^\s*</[A-Za-z][\w:-]*\s*>\s*$")


def _strip_trailing_bare_close_tags(content: str) -> str:
    """剥离结尾连续的裸闭合标签行（如 "</content>\\n</now_plot>"）。

    背景（2026-08-19 实证）：前端插件（对话渲染系统 v7.1）通过 in_chat depth=0
    把格式规则注入到 prompt 最末尾（紧贴模型续写位置）。当注入文本以裸闭合标签
    </now_plot> 结尾时，推理模型（deepseek-v4-flash）会认为"正文已闭合、输出
    已完成"，直接停止生成（实测 completion_tokens=1 → 空响应 → 三次重试全失败，
    用户侧表现为第二次对话 100% 思维链复述规则/乱码且正文不输出）。
    剥离结尾裸闭合标签行后模型恢复正常输出，且不影响其按 <now_plot><content>
    结构组织正文（对照实验：同位置注入、仅去掉结尾闭合标签 → 正常输出且格式
    遵循完好；depth=1 注入带闭合标签 → 亦正常，佐证触发条件为
    「最末尾位置 + 裸闭合标签结尾」的组合）。
    """
    lines = content.rstrip().split("\n")
    while lines and _BARE_CLOSE_TAG_LINE_RE.match(lines[-1]):
        lines.pop()
    return "\n".join(lines).rstrip()


# ── [PLUGIN-ON-DEMAND] 对话渲染生态注入的按角色门控 ────────────────
#
# 「对话渲染系统」类 tavern_helper 脚本会全局注入 @bubble 格式规范
# （要求模型每次说话都输出 @bubble:角色|情绪|[对白]）。该标记的渲染由
# **卡内的配套渲染正则 JS** 完成（脚本自述），裸卡没有配套 → 标记裸奔
# （2026-09-25 实测）。判定标准（用户拍板：自动识别配套正则）：
# 角色的生效正则（卡内嵌 / 插件全局 / ST 扩展设置三源）中存在启用的、
# 面向展示的脚本其内容命中 bubble/对话渲染/气泡 即视为有配套；
# 无配套时丢弃 @bubble 类注入（其余注入不受影响）。

_BUBBLE_MARKER_RE = re.compile(r"@bubble", re.IGNORECASE)
_BUBBLE_RENDER_HINT_RE = re.compile(r"bubble|对话渲染|气泡", re.IGNORECASE)


def _regex_script_is_display_side(script: dict) -> bool:
    """展示侧脚本（promptOnly 的脚本只改提示词、不做渲染，不算配套）。"""
    if not isinstance(script, dict):
        return False
    if script.get("promptOnly") or script.get("prompt_only"):
        return False
    return True


def _regex_script_mentions_bubble(script: dict) -> bool:
    blob = " ".join(
        str(script.get(key) or "")
        for key in ("scriptName", "script_name", "findRegex", "find", "replaceString", "replace")
    )
    return bool(_BUBBLE_RENDER_HINT_RE.search(blob))


def _card_regex_scripts(extensions_raw) -> list[dict]:
    try:
        ext = json.loads(extensions_raw) if isinstance(extensions_raw, str) else extensions_raw
    except (json.JSONDecodeError, TypeError):
        return []
    scripts = ext.get("regex_scripts") if isinstance(ext, dict) else None
    return [s for s in scripts if isinstance(s, dict)] if isinstance(scripts, list) else []


def _char_card_has_bubble_regex(extensions_raw) -> bool:
    for script in _card_regex_scripts(extensions_raw):
        if script.get("disabled") is True or script.get("enabled") is False:
            continue
        if not _regex_script_is_display_side(script):
            continue
        if _regex_script_mentions_bubble(script):
            return True
    return False


def _has_bubble_render_support(db, user_id, char_extensions_raw) -> bool:
    """
    当前角色是否有 @bubble 配套渲染能力。

    [BUBBLE-HOST-GATE 2026-10-01] 两源的可靠性并不对等：
      · 卡自带正则（源 1）—— 卡自己声明要渲染 @bubble，最可信；正则可能直接产出
        内联 HTML 气泡，不依赖 iframe。
      · 插件 / 用户正则（源 2、3）—— 其消费方是 BubbleDialogue 的 dcRoot **iframe**，
        而 Palink 的 FORBID_TAGS 含 'iframe' → 宿主活不了 → 标记无人渲染。
        故该源仅在宿主可用时成立（PALINK_BUBBLE_IFRAME_HOST=1），否则视为不支持。
    """
    if _char_card_has_bubble_regex(char_extensions_raw):
        return True
    if not _bubble_iframe_host_available():
        return False
    try:
        # 函数级局部导入：character_ext 反向依赖本模块，模块级导入会成环。
        from ..api.character_ext import (
            _load_extension_settings_regex_scripts,
            _load_plugin_regex_script_dicts,
        )
        scripts = list(_load_plugin_regex_script_dicts(db))
        if user_id is not None:
            scripts += list(_load_extension_settings_regex_scripts(db, user_id))
        for script in scripts:
            if not _regex_script_is_display_side(script):
                continue
            if _regex_script_mentions_bubble(script):
                return True
    except Exception as _bubble_exc:
        # [SILENT-FAIL 2026-10-22] 这里吞掉 = 判定「这张卡没有气泡渲染支持」⇒
        # 装配层会把 @bubble 段落从格式规范里摘掉。用户看到的是"卡片渲染格式突然
        # 不对了"，日志里什么也没有。必须留痕。
        _record_silent_failure("prompt_assembly.bubble_render_support_probe", _bubble_exc)
    return False


# 气泡格式段落标题。**仅供日志归类，不再是任何丢弃条件**——见下。
_BUBBLE_SECTION_HEADING_RE = re.compile(r"^\s*\[\s*(?:对话渲染格式规范|情绪词约束)")
_SECTION_HEADING_RE = re.compile(r"^\s*\[")


def _split_bubble_sections(content: str) -> list[tuple[Optional[str], list[str]]]:
    """按 `^\\s*\\[` 把注入文本切成 (标题行, 正文行列表)；首段可能是无标题前言。"""
    sections: list[tuple[Optional[str], list[str]]] = []
    heading: Optional[str] = None
    body: list[str] = []
    for line in (content or "").split("\n"):
        if _SECTION_HEADING_RE.match(line):
            if heading is not None or body:
                sections.append((heading, body))
            heading = line.strip()
            body = []
        else:
            body.append(line)
    if heading is not None or body:
        sections.append((heading, body))
    return sections


def _strip_bubble_marker_instructions_detailed(
    content: str,
) -> tuple[str, list[str]]:
    """摘掉 @bubble 相关内容，返回 (处理后文本, 被整段丢弃的段落标题列表)。

    「对话渲染系统 v7.1」把两件互不相干的事塞进同一条 extension prompt：
      · `<content>` 外面必须包 `<now_plot>` —— 消费方是卡自带「正文美化」正则，
        Palink 能渲染（智能卡的图文排版框就出自它）；
      · `@bubble:角色|情绪|台词` —— 消费方是插件自建的 dcRoot iframe，Palink 渲染不了。

    [BUBBLE-STRIP-BY-CONTENT 2026-10-02] 旧判据用段落标题字面量（[对话渲染格式规范] /
    [情绪词约束]）做整段跳过，假设「这两段只讲 @bubble」。该假设在**运行时上报的
    真实文本**上不成立——两段里都装着非 @bubble 的格式规则。实测（露缇雅1.2，
    `extension_prompts` 真实行 1796 字符）：
      旧判据 → 413 字符 → 单层降级后 385，到场率仅 21.4%，
      写着「整体输出结构/示例」的主段整段消失 → 模型不包 <now_plot> →
      卡「正文美化」正则无可匹配 → AI 回复没有排版框（只有写死在 first_mes 的开场白有框）。
    （此前一轮之所以误判为「降级链不吞规范」，是因为口径选错：拿 `plugin_scripts` 里
    242KB 的脚本源码全文跑剥离函数，而不是运行时上报的那份文本。）

    新判据：先按 `^\\s*\\[` 切段；**只有某段的全部非空正文行都含 @bubble** 才允许
    整段丢弃（标题行本身不参与该判定，否则 `[X]\\n@bubble:…` 这种纯 @bubble 段
    永远丢不掉）。否则保留该段（含标题行），仅逐行剔除含 @bubble 的行。
    标题字符串不再作为任何丢弃条件。

    [BUBBLE-LEGACY-STRIP] `PALINK_BUBBLE_LEGACY_SECTION_STRIP=1` 时走旧「按标题整段丢」
    逻辑，仅用于复现残本做 A/B 对照（B 组）。默认关闭。
    """
    legacy = str(os.environ.get("PALINK_BUBBLE_LEGACY_SECTION_STRIP") or "").strip().lower()
    if legacy in {"1", "true", "on", "yes"}:
        kept_legacy: list[str] = []
        dropped_legacy: list[str] = []
        skipping = False
        for line in (content or "").split("\n"):
            if _BUBBLE_SECTION_HEADING_RE.match(line):
                skipping = True
                dropped_legacy.append((line or "").strip())
                continue
            if skipping:
                if _SECTION_HEADING_RE.match(line):
                    skipping = False  # 进入下一个段落，本行继续按常规判定
                else:
                    continue
            if _BUBBLE_MARKER_RE.search(line):
                continue
            kept_legacy.append(line)
        return (
            re.sub(r"\n{3,}", "\n\n", "\n".join(kept_legacy)).strip(),
            dropped_legacy,
        )

    kept: list[str] = []
    dropped_titles: list[str] = []
    for heading, body in _split_bubble_sections(content):
        non_empty = [line for line in body if line.strip()]
        if (
            heading is not None
            and non_empty
            and all(_BUBBLE_MARKER_RE.search(line) for line in non_empty)
        ):
            dropped_titles.append(heading)
            continue
        if heading is not None:
            kept.append(heading)
        kept.extend(line for line in body if not _BUBBLE_MARKER_RE.search(line))
    return (
        re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip(),
        dropped_titles,
    )


def _strip_bubble_marker_instructions(content: str) -> str:
    """只摘掉注入文本里的 @bubble 相关部分，保留其余格式规则（薄壳，判据见上）。"""
    return _strip_bubble_marker_instructions_detailed(content)[0]


def _downgrade_bubble_injections(
    merged: dict, entries: list[dict], stats: Optional[dict] = None
) -> tuple[int, int]:
    """无 @bubble 渲染能力时的处置：逐条摘掉 @bubble 段落，其余格式规则保留。

    摘完什么都不剩的条目才整体丢弃。返回 (摘除后保留的条数, 整条丢弃的条数)。
    entries 持有 merged 内同一批 dict 的引用，改 content 即改 merged。

    [SHELL-SINGLE-LAYER 2026-10-02] 摘除后再做两层→单层外壳降级（用户拍板⑤：
    只挂本降级路径，不动有 @bubble 宿主的卡——宿主在用时那份输出结构由插件
    自己的渲染器消费）。错配实锤：v7.x 规范要求 <now_plot><content>…两层嵌套，
    而卡「正文美化」正则用单层反向引用 `/<(story|…|now_plot|content|正文)>([\\s\\S]*?)<\\/\\1>/gi`
    ——配外层时内层 <content> 标签原样漏进渲染框（消息 2466 实测上下各露一对
    content 记号）；模型只写一半时配不上、整块不出框（消息 2468）。

    [PROMPT-STRIP-EVIDENCE 2026-10-02] 可选 stats 出参，供 `extra.ext_prompts.applied`
    记录双计数与被丢段落标题（见 `_collect_extension_prompts`）。结构：
      {"entries": {identifier: {"reported": N, "injected": M}}, "dropped_sections": [标题, …]}
    """
    stripped_and_kept = 0
    dropped = 0
    for entry in entries:
        raw = entry.get("content") or ""
        stripped, dropped_titles = _strip_bubble_marker_instructions_detailed(raw)
        if stats is not None:
            stats.setdefault("dropped_sections", []).extend(dropped_titles)
        if stripped:
            single = _downgrade_two_layer_shell_to_single(stripped)
            entry["content"] = single
            stripped_and_kept += 1
            if stats is not None:
                stats.setdefault("entries", {})[entry["identifier"]] = {
                    "reported": len(raw),
                    "injected": len(single),
                }
        else:
            merged.pop(entry["identifier"], None)
            dropped += 1
            if stats is not None:
                stats.setdefault("entries", {})[entry["identifier"]] = {
                    "reported": len(raw),
                    "injected": 0,
                }
    return stripped_and_kept, dropped


# ── [SHELL-SINGLE-LAYER 2026-10-02] 两层→单层外壳改写（仅降级路径）──────────
#
# 针对「对话渲染系统 v7.x」注入文本的保守文本手术：只改写已知句式，匹配不到
# 就原样放行（对其他版本的规范是 no-op）。「输出结构/示例」脚手架里的两层嵌套
# 由「独立行 <content>/</content> 逐行摘除」自然坍缩成单层——
#   <now_plot>\n<content>\n（正文内容）\n</content>\n</now_plot>
#   → <now_plot>\n（正文内容）\n</now_plot>
# 行内提及的 <content> 不动。

_SINGLE_LAYER_RULE_LINE_RE = re.compile(
    r"<content>\s*标签外面必须包一层\s*<now_plot>\s*标签。?",
)
# 注意：替换文本不得再出现字面 `<content>`——改写后的规范全文必须零 content
# 标签，卡正则（同名反引用）才不可能再配出内层记号。
_SINGLE_LAYER_RULE_REPLACEMENT = (
    "正文必须整体包裹在一对 <now_plot> 标签内（单层，标签内直接写正文，"
    "不要再套 content 内层标签）。"
)
_BACKGROUND_RULE_LINE_RE = re.compile(
    r"必须在\s*<content>\s*内的正文开头输出背景标签",
)
_BACKGROUND_RULE_REPLACEMENT = "必须在正文开头输出背景标签"
_BARE_CONTENT_LINE_RE = re.compile(r"^[ \t]*<\/?content>[ \t]*$", re.IGNORECASE | re.MULTILINE)


def _downgrade_two_layer_shell_to_single(content: str) -> str:
    """把 v7.x 规范的两层外壳要求改写为单层 <now_plot>（匹配不到则原样返回）。"""
    value = content or ""
    original = value
    value = _SINGLE_LAYER_RULE_LINE_RE.sub(_SINGLE_LAYER_RULE_REPLACEMENT, value)
    value = _BACKGROUND_RULE_LINE_RE.sub(_BACKGROUND_RULE_REPLACEMENT, value)
    # 示例/输出结构脚手架残留的独立行 <content>/</content> 逐行摘除（两层→单层）
    value = _BARE_CONTENT_LINE_RE.sub("", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    if value == original:
        return content or ""
    return value.strip()


# ── [PLUGIN-ON-DEMAND] 装配层让位（spec §2.5.1）────────────────────────────
#
# 上面这套 @bubble 自动门控是「装配层自动判定」。若用户在导入卡时手工确认过
# 插件名单（plugin_scope_mode='allowlist'），两边可能打架：UI 勾了、装配层
# 又判这张卡不需要。统一优先级（从高到低）：
#   1. BUBBLE_DEBUG 环境变量   —— 调试逃生门，无条件保留
#   2. 这张卡能否渲染 @bubble  —— 由 _has_bubble_render_support 判定（见下）
#   3. 装配层自动门控          —— inherit（含 NULL）时同样按 2 判定
#
# [BUBBLE-HOST-GATE 2026-10-01] 原先 allowlist（用户手工勾选插件）会跳过 2、无条件保留，
# 实测导致"卡根本没要求 @bubble 却被强制注入"（会话 a0accf94）。现改为：
# allowlist 只决定"插件启不启用"，格式规范一律按"这张卡能否渲染"判定。


def _bubble_debug_forced() -> bool:
    """调试逃生门：BUBBLE_DEBUG=1/true/on/yes 时无条件保留 @bubble 类注入。"""
    try:
        raw = (os.environ.get("BUBBLE_DEBUG") or "").strip().lower()
    except Exception:
        return False
    return raw in {"1", "true", "on", "yes"}


def _bubble_iframe_host_available() -> bool:
    """
    [BUBBLE-HOST-GATE 2026-10-01] dcRoot 渲染宿主在 Palink 下是否真的可用。

    插件「对话渲染系统 v7.1」的「正文美化」正则产出的气泡宿主是
    `<iframe srcdoc="…id="dcRoot"…">`，而 Palink 的 ST 兼容消毒配置
    `ST_DOMPURIFY_CONFIG.FORBID_TAGS`（frontend/src/lib/sillytavern/formatting.ts）
    含 `'iframe'` —— iframe 会被消毒掉，宿主活不下来，模型输出的 @bubble
    标记没有任何消费方，只会原样裸在正文里。

    因此：插件/用户正则这一源**只有在宿主确实可用时**才算"有渲染支持"。
    默认关闭（当前 Palink 渲染不了）；将来打通 iframe 白名单后，
    用 `PALINK_BUBBLE_IFRAME_HOST=1` 打开即可恢复，无需改代码。
    """
    try:
        raw = (os.environ.get("PALINK_BUBBLE_IFRAME_HOST") or "").strip().lower()
    except Exception:
        return False
    return raw in {"1", "true", "on", "yes"}


def _character_plugin_scope_mode(character) -> str:
    """读取角色的插件作用域模式：'allowlist'（用户显式名单）/ 'inherit'（默认）。

    任何读取失败（属性不存在 / 列未迁移 / char 是单测替身对象）都退化为
    'inherit'，即行为与改造前逐字一致——绝不因读取失败翻转既有门控结论。
    """
    try:
        raw = getattr(character, "plugin_scope_mode", None)
    except Exception:
        return "inherit"
    if raw is None:
        return "inherit"
    mode = raw if isinstance(raw, str) else str(raw)
    mode = (mode or "").strip().lower()
    return mode or "inherit"


def _collect_extension_prompts(
    req: "PromptAssemblyRequest",
    stats: Optional[dict] = None,
) -> list[dict[str, Any]]:
    """合并请求中的 extension_prompts 与 DB 中的 ExtensionPrompt 记录。

    合并策略：
    1. 从 DB 查询当前 user_id 的全局记录（session_id IS NULL）和
       session_id == req.session_id 的会话级记录，仅取 enabled=True 的。
    2. 用 req.extension_prompts 按 identifier 覆盖 DB 记录（运行时优先）。
    3. 对每条记录按 filter 字段过滤（character_ids / session_ids）。
    4. 跳过 position == NONE(-1) 或 content 为空的条目。
    返回最终待注入的条目列表（dict 形式，含 identifier/content/position/
    depth/role/filter 字段）。

    [PROMPT-STRIP-EVIDENCE 2026-10-02] 可选 stats 出参：@bubble 降级路径（若有）
    会把「每条被降级条目的原始/注入字符数」与「被整段丢弃的段落标题」写进去，
    供装配层算 `extra.ext_prompts.applied` 的 chars_reported / chars_injected /
    dropped_sections。不传则零副作用（既有调用方/单测行为逐字节不变）。
    """
    merged: dict[str, dict[str, Any]] = {}

    # 1. 从 DB 加载（容错：表不存在或查询失败时不影响主流程）
    try:
        db_rows = (
            req.db.query(ExtensionPrompt)
            .filter(ExtensionPrompt.user_id == req.user.id)
            .filter(
                (ExtensionPrompt.session_id.is_(None))
                | (ExtensionPrompt.session_id == req.session_id)
            )
            .all()
        )
        for row in db_rows:
            if not row.enabled:
                continue
            content = (row.content or "").strip()
            if not content:
                continue
            try:
                pos = int(row.position if row.position is not None else EXTENSION_PROMPT_POSITION_NONE)
            except (TypeError, ValueError):
                pos = EXTENSION_PROMPT_POSITION_NONE
            if pos < EXTENSION_PROMPT_POSITION_MIN or pos > EXTENSION_PROMPT_POSITION_MAX:
                continue
            if pos == EXTENSION_PROMPT_POSITION_NONE:
                continue
            try:
                depth = int(row.depth if row.depth is not None else 4)
            except (TypeError, ValueError):
                depth = 4
            merged[row.identifier] = {
                "identifier": row.identifier,
                "content": content,
                "position": pos,
                "depth": max(0, depth),
                "role": _normalize_ep_role(row.role if row.role is not None else "system"),
                # P2-7 修复: 透传 scan 字段（DB 中默认 False）
                "scan": bool(getattr(row, "scan", False)),
                "filter": row.get_filter() if hasattr(row, "get_filter") else {},
                # [XCHAR-PROMPT-BLEED 2026-10-03] 透传来源键：非 NULL 走「必须绑卡」
                # 判定（见 _ext_filter_allows），NULL 保持「空 filter = 全局」原语义。
                "source_key": getattr(row, "source_key", None),
            }
    except Exception as exc:
        logger.warning("ExtensionPrompt DB load failed (user_id=%s): %s", req.user.id, exc)

    # 2. 用 req.extension_prompts 覆盖（运行时优先级最高）
    for raw in (req.extension_prompts or []):
        if not raw:
            continue
        # 兼容 Pydantic 模型 / dict
        if hasattr(raw, "model_dump"):
            entry = raw.model_dump()
        elif isinstance(raw, dict):
            entry = dict(raw)
        else:
            continue
        identifier = (entry.get("identifier") or "").strip()
        if not identifier:
            continue
        content = (entry.get("content") or "").strip()
        if not content:
            continue
        try:
            pos = int(entry.get("position", EXTENSION_PROMPT_POSITION_NONE))
        except (TypeError, ValueError):
            pos = EXTENSION_PROMPT_POSITION_NONE
        if pos < EXTENSION_PROMPT_POSITION_MIN or pos > EXTENSION_PROMPT_POSITION_MAX:
            continue
        if pos == EXTENSION_PROMPT_POSITION_NONE:
            # 显式 NONE 仍然覆盖 DB（即运行时禁用 DB 持久化的条目）
            merged.pop(identifier, None)
            continue
        try:
            depth = int(entry.get("depth", 4))
        except (TypeError, ValueError):
            depth = 4
        role = _normalize_ep_role(entry.get("role", "system"))
        merged[identifier] = {
            "identifier": identifier,
            "content": content,
            "position": pos,
            "depth": max(0, depth),
            "role": role,
            # P2-7 修复: 透传 scan 字段（请求侧 ExtensionPromptInput 已添加）
            "scan": bool(entry.get("scan", False)),
            "filter": _normalize_ext_filter(entry.get("filter")),
            # [XCHAR-PROMPT-BLEED 2026-10-03] 请求侧条目 = 前端运行时聚合的插件/卡脚本
            # 现场注册，无 source_key 概念 → 一律标记为插件来源（见 _ext_filter_allows），
            # 下方统一按当前角色重新绑定 character_ids，使其只能作用于本轮这张卡。
            "source_key": entry.get("source_key") or _REQUEST_SIDE_SOURCE_KEY,
        }

    # 3. [PLUGIN-ON-DEMAND] @bubble 类注入按角色生效：内容带 @bubble 的注入
    # （对话渲染生态的格式规范）仅当角色存在配套渲染时才原样注入；无配套时只摘掉
    # @bubble 段落，同一条注入里其余格式规则（尤其 <now_plot> 包裹规则）必须保留。
    # 其余注入零影响。
    bubble_entries = [
        entry for entry in merged.values()
        if _BUBBLE_MARKER_RE.search(entry.get("content") or "")
    ]
    if bubble_entries:
        # [PLUGIN-ON-DEMAND] 优先级：BUBBLE_DEBUG > 用户显式选择 > 装配层自动门控
        char_obj = getattr(req, "char", None)
        if _bubble_debug_forced():
            logger.info(
                "[PLUGIN-ON-DEMAND] BUBBLE_DEBUG set: keeping %d bubble-format injection(s) "
                "without gate (escape hatch)",
                len(bubble_entries),
            )
        elif _character_plugin_scope_mode(char_obj) == "allowlist":
            # [BUBBLE-HOST-GATE 2026-10-01] 旧行为：用户勾了插件 → 装配层完全让位、
            # 无条件保留 @bubble 注入。实测这是错的 —— "启用插件"不等于"这张卡要 @bubble
            # 格式"，裸卡被强制输出无人渲染的原始标记（会话 a0accf94 取证）。
            # 让位只让到"插件能否被启用"这一层；格式规范仍以「这张卡能否渲染」为准。
            has_support = _has_bubble_render_support(
                req.db, getattr(getattr(req, "user", None), "id", None),
                getattr(char_obj, "extensions", None),
            )
            if has_support:
                logger.info(
                    "[PLUGIN-ON-DEMAND] character %s is allowlist and has bubble render support: "
                    "keeping %d injection(s)",
                    getattr(char_obj, "id", None), len(bubble_entries),
                )
            else:
                kept, dropped = _downgrade_bubble_injections(
                    merged, bubble_entries, stats=stats
                )
                logger.info(
                    "[PLUGIN-ON-DEMAND] character %s is allowlist but has NO bubble render support "
                    "(card declares none; dcRoot iframe host unavailable): "
                    "stripped @bubble from %d injection(s), dropped %d entirely",
                    getattr(char_obj, "id", None), kept, dropped,
                )
        else:
            has_support = _has_bubble_render_support(
                req.db, getattr(getattr(req, "user", None), "id", None),
                getattr(char_obj, "extensions", None),
            )
            if not has_support:
                kept, dropped = _downgrade_bubble_injections(
                    merged, bubble_entries, stats=stats
                )
                logger.info(
                    "[PLUGIN-ON-DEMAND] character has no companion bubble renderer: "
                    "stripped @bubble from %d injection(s), dropped %d entirely",
                    kept, dropped,
                )

    # 4. 按 filter 过滤
    char_id = str(req.char.id) if req.char is not None and req.char.id is not None else ""
    sess_id = str(req.session_id) if req.session_id else ""
    result: list[dict[str, Any]] = []
    for entry in merged.values():
        # [XCHAR-PROMPT-BLEED 2026-10-03] 请求侧条目（插件来源）在此按**当前角色**重新
        # 绑定 character_ids：前端聚合的是「此刻这个角色的插件注册了什么」，来源天然
        # 属于本轮这张卡。绑定后即使前端传来的 filter 为空/缺失，也能通过「必须命中
        # character_ids」的判定，而不会因空 filter 被放行到所有卡。
        if entry.get("source_key") == _REQUEST_SIDE_SOURCE_KEY and char_id:
            flt = _normalize_ext_filter(entry.get("filter"))
            ids = [str(x) for x in (flt.get("character_ids") or [])]
            if char_id not in ids:
                ids.append(char_id)
            flt["character_ids"] = ids
            entry = {**entry, "filter": flt}
        if not _ext_filter_allows(
            entry.get("filter") or {},
            char_id,
            sess_id,
            entry.get("source_key"),
        ):
            continue
        # [INJ-CLOSE-TAG-GUARD] in_chat depth=0 注入的空响应防护（2026-08-19 实证）：
        # depth=0 会把注入放到 messages 最末尾（紧贴模型续写位置）。deepseek-v4-flash
        # 等（推理）模型在「最后一条消息是 system 注入」时高概率立即停止生成
        # （5 次采样 3 次空响应：completion_tokens=1 直接 EOS，或 reasoning 写完
        # 不写正文），若注入内容再以裸闭合标签 </now_plot> 结尾则 100% 停止。
        # 双重防护：① depth 0 → 1（插到最后一条消息之前，5 次采样全部正常，
        # 位置语义仍紧贴最新消息）；② 剥离结尾裸闭合标签行。
        if (
            entry.get("position") == EXTENSION_PROMPT_POSITION_IN_CHAT
            and entry.get("depth") == 0
        ):
            original = entry.get("content") or ""
            cleaned = _strip_trailing_bare_close_tags(original)
            if not cleaned.strip():
                continue  # 全部是闭合标签行，无有效内容，跳过该条
            stripped = cleaned != original
            logger.info(
                "[INJ-CLOSE-TAG-GUARD] in_chat depth=0 extension prompt guarded: "
                "depth 0→1%s (identifier=%s)",
                ", trailing bare close tags stripped" if stripped else "",
                entry.get("identifier"),
            )
            entry = {**entry, "depth": 1, "content": cleaned}
        result.append(entry)
    return result


# 群聊激活策略常量（Palink 扩展，ST 1.18.0 仅定义 0-3）
_GROUP_ACTIVATION_TALKATIVE = 4
_GROUP_ACTIVATION_VOTING = 5


def _load_group_member_ids(group: "GroupChat") -> list[str]:
    """从 GroupChat.member_ids 解析为字符化 id 列表（兼容 str/list 存储）。"""
    raw = getattr(group, "member_ids", None)
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        return [str(m) for m in (parsed or [])]
    if isinstance(raw, list):
        return [str(m) for m in raw]
    return []


def _enabled_member_ids(group: "GroupChat") -> list[str]:
    """返回启用（未禁用）的成员 id 列表，排除 disabled_members。

    ST 1.18.0 group-chat.js: disabled_members 中的角色不参与发言调度与上下文注入。
    """
    member_ids = _load_group_member_ids(group)
    if not member_ids:
        return member_ids
    disabled: set[str] = set()
    raw = getattr(group, "disabled_members", None)
    if raw:
        if isinstance(raw, str):
            try:
                disabled = {str(m) for m in (json.loads(raw) or [])}
            except (json.JSONDecodeError, TypeError):
                disabled = set()
        elif isinstance(raw, list):
            disabled = {str(m) for m in raw}
    if not disabled:
        return member_ids
    return [mid for mid in member_ids if mid not in disabled]


def resolve_group_speaker_queue(
    db: Session,
    group_id: Optional[str],
    current_speaker_id: Optional[str],
    generation_type: Optional[str] = None,
) -> Optional[list]:
    """F1（模块 04 多人串联流式）：解析本轮需要顺序生成的发言者 character_id 列表。

    返回语义：
    - ``None``  : 单发言者路径。由装配内部 ``_resolve_group_speaker`` 解析
                  （NATURAL/POOLED/TALKATIVE/VOTING，或 1:1 非群聊；含
                  swipe/continue/impersonate/quiet 专用选角）。
    - ``[]``    : 空队列。本轮不生成 AI 回复，仅用户消息已落库
                  （MANUAL(2) 且无指定发言者，且非 swipe/continue/impersonate/quiet）。
    - ``list``  : 显式队列（LIST(1) 模式，按名册顺序的全部启用成员）。

    该函数是无副作用的纯查询，便于单测；websocket 编排层据此驱动
    ``_gen`` 内逐发言者的「装配 + 流式生成 + 落库」循环。
    """
    if not group_id:
        return None
    try:
        group = db.query(GroupChat).filter(GroupChat.id == str(group_id)).first()
    except Exception as exc:
        logger.warning("GroupChat lookup failed for speaker queue (group_id=%s): %s", group_id, exc)
        return None
    if group is None:
        return None
    # ST 1.18.0 generateGroupWrapper (group-chats.js:1006-1031): swipe/continue/
    # impersonate/quiet 的选角分支优先于 activation_strategy。这些类型走单发言者
    # 路径（由 _resolve_group_speaker 内 type 分支解析复用/随机发言者），且不触发
    # MANUAL 空队列跳过（即使 MANUAL 也须复用/随机出一位发言者）。Phase B 修复。
    _gen_type = (generation_type or "").lower()
    if _gen_type in ("swipe", "continue", "impersonate", "quiet"):
        return None
    strategy = int(getattr(group, "activation_strategy", 0) or 0)
    if strategy == 1:  # LIST(1)：全部启用成员按名册顺序
        return _enabled_member_ids(group)
    if strategy == 2 and not current_speaker_id:
        # MANUAL(2) 无指定发言者：仅落用户消息，跳过 AI 生成
        return []
    # 其它策略：保持 None，由 _resolve_group_speaker 在装配内解析单发言者
    return None


def _read_talkativeness(character: Character) -> float:
    """读取角色 talkativeness 字段，缺失或非法时回退到 0.5。

    Character.talkativeness 由 migration 0045 添加；在字段尚不存在时通过
    getattr 安全回退。ST 1.18.0 group-chats.js 中 talkativeness 取值范围
    为 [0.0, 1.0]；0 表示在 NATURAL 概率阶段永不主动激活；TALKATIVE 加权中
    随机权重为 0，仅在全员为 0 时回退轮询可能被选中。
    """
    try:
        raw = getattr(character, "talkativeness", "0.5")
        if raw is None or raw == "":
            raw = "0.5"
        return float(raw)
    except (TypeError, ValueError):
        return 0.5


def _get_last_group_speaker_id(
    db: Session,
    group: GroupChat,
    members: list[Character],
) -> Optional[str]:
    """从群聊最近会话的消息中推断上一位发言者的 character_id。

    ST 群聊消息存储 name 字段为发言角色名称；通过名称匹配成员。
    返回 None 表示无法确定（首次发言或无历史）。
    """
    try:
        session = (
            db.query(GroupChatSession)
            .filter(
                GroupChatSession.group_id == group.id,
                GroupChatSession.user_id == group.user_id,
            )
            .order_by(GroupChatSession.updated_at.desc())
            .first()
        )
        if session is None or not session.messages:
            return None
        try:
            msgs = json.loads(session.messages) if isinstance(session.messages, str) else session.messages
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(msgs, list) or not msgs:
            return None
        name_to_id = {(m.name or "").strip(): m.id for m in members if m.name}
        # 从最新消息向前找非 user 的角色发言
        for msg in reversed(msgs):
            if not isinstance(msg, dict):
                continue
            if msg.get("is_user"):
                continue
            speaker_name = (msg.get("name") or "").strip()
            if speaker_name and speaker_name in name_to_id:
                return name_to_id[speaker_name]
        return None
    except Exception as exc:
        logger.warning("Failed to determine last group speaker: %s", exc)
        return None


def _activate_swipe(
    db: Session,
    group: "GroupChat",
    members: list[Character],
    allow_system: bool = False,
) -> Optional[str]:
    """ST 1.18.0 activateSwipe 等价 (group-chats.js:1130-1173)。

    复用被 swipe/continue 消息的发言者：从群聊最近会话历史回溯，找最后一条
    符合要求的角色发言者（按 ``name`` 匹配成员，Palink 无 original_avatar 列）。
      - ``allow_system=False`` (swipe/continue): 跳过 user/system/narrator 消息
      - ``allow_system=True``  (quiet): 仅跳过 user 消息
    找不到时回退 ``random.choice(members)`` (ST ``shuffle(members)[0]``)。
    ``members`` 为空时返回 None。Phase B 修复。
    """
    if not members:
        return None
    try:
        session = (
            db.query(GroupChatSession)
            .filter(
                GroupChatSession.group_id == group.id,
                GroupChatSession.user_id == group.user_id,
            )
            .order_by(GroupChatSession.updated_at.desc())
            .first()
        )
        name_to_id = {(m.name or "").strip(): m.id for m in members if m.name}
        if session is not None and session.messages:
            try:
                msgs = json.loads(session.messages) if isinstance(session.messages, str) else session.messages
            except (json.JSONDecodeError, TypeError):
                msgs = []
            if isinstance(msgs, list):
                for msg in reversed(msgs):
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("is_user"):
                        continue
                    if not allow_system and msg.get("is_system"):
                        continue
                    speaker_name = (msg.get("name") or "").strip()
                    if speaker_name and speaker_name in name_to_id:
                        return name_to_id[speaker_name]
    except Exception as exc:
        logger.warning("activateSwipe failed (group_id=%s): %s", getattr(group, "id", None), exc)
    # 回退：随机选一个成员 (ST shuffle(members)[0])
    return random.choice(members).id


def _activate_impersonate(members: list[Character]) -> Optional[str]:
    """ST 1.18.0 activateImpersonate 等价 (group-chats.js:1114-1121): 随机选 1 个成员。

    ``members`` 为空时返回 None。Phase B 修复。
    """
    if not members:
        return None
    return random.choice(members).id


def _select_talkative_speaker(
    db: Session,
    group: GroupChat,
    members: list[Character],
    allow_self_responses: bool = False,
) -> str:
    """TALKATIVE 策略：按 talkativeness 加权随机选择发言者。

    - 读取每个成员的 talkativeness（缺失回退 0.5）
    - 全部为 0 时回退到轮询（NATURAL 行为）：选择上一位发言者之后的下一个成员
    - 尽量避免连续两次选择同一发言者（剔除上一位后仍有候选时加权选择）
    - 使用 random.choices(weights=...) 进行加权随机
    """
    if not members:
        raise HTTPException(status_code=400, detail="No group members available for TALKATIVE selection")
    if len(members) == 1:
        return members[0].id

    last_speaker_id = _get_last_group_speaker_id(db, group, members)
    talkativeness = [_read_talkativeness(m) for m in members]

    # 全部 talkativeness 为 0 时回退到轮询（NATURAL 行为）
    if all(t <= 0 for t in talkativeness):
        if last_speaker_id:
            for i, m in enumerate(members):
                if m.id == last_speaker_id:
                    next_idx = (i + 1) % len(members)
                    return members[next_idx].id
        return random.choice(members).id

    # 加权随机：尽量避免连续选择同一发言者（allow_self_responses 时允许连发）
    candidates = list(members)
    weights = list(talkativeness)
    if last_speaker_id and len(candidates) > 1 and not allow_self_responses:
        filtered = [(m, w) for m, w in zip(candidates, weights) if m.id != last_speaker_id]
        if filtered:
            candidates = [m for m, _ in filtered]
            weights = [w for _, w in filtered]

    # 保证权重非负
    weights = [max(0.0, w) for w in weights]
    # 若剔除后权重全为 0，等概率选择
    if all(w <= 0 for w in weights):
        return random.choice(candidates).id

    chosen = random.choices(candidates, weights=weights, k=1)[0]
    return chosen.id


# follower_members 在 NATURAL 概率阶段的衰减系数（ST 1.18.0 跟随成员被动、少主动）
FOLLOWER_DAMPING = 0.3


def _load_members(db: Session, group: "GroupChat") -> list[Character]:
    """加载启用（未禁用）的群成员 Character 列表（B5 修复：排除 disabled_members）。"""
    ids = _enabled_member_ids(group)
    if not ids:
        return []
    try:
        return db.query(Character).filter(Character.id.in_([str(i) for i in ids])).all()
    except Exception as exc:
        logger.warning("GroupChat member characters lookup failed (group_id=%s): %s", getattr(group, "id", None), exc)
        return []


def _load_all_members(db: Session, group: "GroupChat") -> list[Character]:
    """加载 member_ids 全量成员（含 disabled），用于 APPEND_DISABLED(2) 合并卡。"""
    ids = _load_group_member_ids(group)
    if not ids:
        return []
    try:
        return db.query(Character).filter(Character.id.in_([str(i) for i in ids])).all()
    except Exception as exc:
        logger.warning("GroupChat all-member lookup failed (group_id=%s): %s", getattr(group, "id", None), exc)
        return []


def _build_group_combined_card(group: "GroupChat", members: list[Character]) -> dict:
    """ST 1.18.0 combineGroupIntoSingleCard 等价（C2）。

    对齐 group-chats.js:497-571 的 getGroupCharacterCardsLazy / collectField /
    customTransform / replaceAndPrepareForJoin：
      - 每个字段按成员拼接，包裹 generation_mode_join_prefix/suffix；
      - prefix/suffix/值内 <FIELDNAME> 替换为字段名、{{char}} 替换为成员名
        （customTransform）；ST 不自动前缀成员名；
      - mes_example 逐成员若未以 <START> 开头则补 "<START>\n"；
      - chat_metadata.scenario / chat_metadata.mes_example 非空时整体覆盖对应字段
        （baseChatReplace 覆盖优先于逐成员收集）。

    members 由调用方按 generation_mode 预选（APPEND=启用成员；APPEND_DISABLED=全量）。
    """
    raw_meta = getattr(group, "chat_metadata", None)
    meta: dict = {}
    if raw_meta:
        try:
            meta = json.loads(raw_meta) if isinstance(raw_meta, str) else raw_meta
        except (json.JSONDecodeError, TypeError):
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    # Phase D 修复 (F6): 优先读顶层字段，回退 chat_metadata.meta（向后兼容存量数据）
    prefix = getattr(group, "generation_mode_join_prefix", None) or meta.get("generation_mode_join_prefix") or ""
    suffix = getattr(group, "generation_mode_join_suffix", None) or meta.get("generation_mode_join_suffix") or ""

    def _custom_transform(value: str, field_name: str, char_name: str) -> str:
        """等价 ST customTransform：<FIELDNAME>→fieldName（大小写不敏感）；{{char}}→char_name。

        不处理 {{user}}（留给下游宏替换解析为用户名）。
        """
        if not value:
            return ""
        value = re.sub(r"<FIELDNAME>", field_name, value, flags=re.IGNORECASE)
        value = value.replace("{{char}}", char_name)
        return value

    def _prepare(value: str, char_name: str, field_name: str, preprocess=None) -> str:
        """等价 ST replaceAndPrepareForJoin：trim → preprocess → prefix + value + suffix。

        成员名不自动前缀（与 ST 一致）。
        """
        value = (value or "").strip()
        if not value:
            return ""
        if callable(preprocess):
            value = preprocess(value)
        pre = _custom_transform(prefix, field_name, char_name)
        suf = _custom_transform(suffix, field_name, char_name)
        body = _custom_transform(value, field_name, char_name)
        return f"{pre}{body}{suf}"

    def _field(field_name: str, getter, preprocess=None) -> str:
        parts: list[str] = []
        for m in members:
            val = getter(m) or ""
            part = _prepare(val, m.name or "", field_name, preprocess)
            if part:
                parts.append(part)
        return "\n".join(parts)

    # 字段名映射（对齐 ST collectField 的 fieldName 参数）
    description = _field("Description", lambda m: m.description)
    personality = _field("Personality", lambda m: m.personality)
    scenario_override = (meta.get("scenario") or "").strip()
    scenario = scenario_override if scenario_override else _field("Scenario", lambda m: m.scenario)
    mes_example_override = (meta.get("mes_example") or "").strip()
    if mes_example_override:
        mes_example = mes_example_override
    else:
        mes_example = _field(
            "Example Messages",
            lambda m: m.mes_example,
            preprocess=lambda x: x if x.startswith("<START>") else f"<START>\n{x}",
        )

    return {
        "description": description,
        "personality": personality,
        "scenario": scenario,
        "mes_example": mes_example,
    }


def _members_mentioned_in_text(members: list[Character], text: str) -> list[Character]:
    """ST group-chats.js extractAllWords 类似：用户输入提及某成员名时返回命中的成员。

    大小写无关；拉丁名按词边界匹配（避免 "Ann" 误匹配 "Anna"），中文名按子串匹配。
    空文本返回空列表。
    """
    if not text:
        return []
    lowered = text.lower()
    hit: list[Character] = []
    for m in members:
        name = (m.name or "").strip()
        if not name:
            continue
        # 词边界匹配（排除 CJK/字母数字相邻），失败则退化为子串匹配（覆盖中文名）
        boundary = r"(?<![A-Za-z0-9\u4e00-\u9fff])" + re.escape(name) + r"(?![A-Za-z0-9\u4e00-\u9fff])"
        if re.search(boundary, lowered, flags=re.IGNORECASE) or name.lower() in lowered:
            hit.append(m)
    # 去重（保持顺序）
    seen: set = set()
    unique: list[Character] = []
    for m in hit:
        if m.id not in seen:
            seen.add(m.id)
            unique.append(m)
    return unique


def _select_natural_speaker(
    db: Session,
    group: GroupChat,
    members: list[Character],
    user_text: str,
) -> Optional[str]:
    """ST activateNaturalOrder 等价实现（B1 NATURAL）。

    1. 提及强制：用户输入提及某成员名 → 强制激活；命中成员排除上一位发言者
       （除非 allow_self_responses），与 ST 提及循环 `character.name === bannedUser`
       （group-chats.js:1259）一致。
    2. 概率激活：每个 talkativeness>0 的成员按 random()<=talkativeness 激活；
       排除上一位发言者（除非 allow_self_responses）；talkativeness=0 永不主动激活。
    3. 回退：无人激活 → 从 talkativeness>0 成员随机；再无 → 全体随机（仍回避 last）。
    4. follower 衰减：follower_members 中的成员 talkativeness 施加 FOLLOWER_DAMPING。
    """
    if not members:
        return None
    allow_self = bool(getattr(group, "allow_self_responses", False))
    last = _get_last_group_speaker_id(db, group, members)
    follower_ids: set = set()
    raw_follower = getattr(group, "follower_members", None)
    if raw_follower:
        try:
            follower_ids = {
                str(x)
                for x in (json.loads(raw_follower) if isinstance(raw_follower, str) else raw_follower)
            }
        except (json.JSONDecodeError, TypeError):
            follower_ids = set()

    def _eff(m: Character) -> float:
        t = _read_talkativeness(m)
        if str(m.id) in follower_ids:
            t = t * FOLLOWER_DAMPING
        return t

    # (1) 提及强制（排除 bannedUser = 上一位发言者，除非 allow_self）
    mentioned = _members_mentioned_in_text(members, user_text)
    if not allow_self and last is not None:
        mentioned = [m for m in mentioned if str(m.id) != str(last)]
    if mentioned:
        return random.choice(mentioned).id

    # (2) 概率激活
    activated = [
        m
        for m in members
        if _eff(m) > 0 and random.random() <= _eff(m) and (allow_self or str(m.id) != str(last))
    ]
    if activated:
        return random.choice(activated).id

    # (3) 回退
    chatty = [m for m in members if _eff(m) > 0]
    pool = chatty if chatty else list(members)
    if not allow_self and last is not None:
        pool = [m for m in pool if m.id != last]
        if not pool:
            pool = chatty if chatty else list(members)
    if not pool:
        return members[0].id
    return random.choice(pool).id


def _collect_spoken_since_last_user(
    db: Session,
    group: GroupChat,
    members: list[Character],
) -> set[str]:
    """从最近一条用户消息之后，收集已发言的成员 id 集合（ST activatePooledOrder）。

    若历史中找不到用户消息，视为全部可候选（返回空集）。异常时返回空集。
    """
    try:
        session = (
            db.query(GroupChatSession)
            .filter(
                GroupChatSession.group_id == group.id,
                GroupChatSession.user_id == group.user_id,
            )
            .order_by(GroupChatSession.updated_at.desc())
            .first()
        )
        if session is None or not session.messages:
            return set()
        msgs = json.loads(session.messages) if isinstance(session.messages, str) else session.messages
        if not isinstance(msgs, list) or not msgs:
            return set()
        name_to_id = {(m.name or "").strip(): str(m.id) for m in members if m.name}
        spoken: set[str] = set()
        found_user = False
        for msg in reversed(msgs):
            if not isinstance(msg, dict):
                continue
            if msg.get("is_user"):
                found_user = True
                break
            speaker_name = (msg.get("name") or "").strip()
            if speaker_name and speaker_name in name_to_id:
                spoken.add(name_to_id[speaker_name])
        return spoken if found_user else set()
    except Exception as exc:
        logger.warning("Failed to collect spoken-since-last-user (group_id=%s): %s", getattr(group, "id", None), exc)
        return set()


def _select_pooled_speaker(
    db: Session,
    group: GroupChat,
    members: list[Character],
) -> Optional[str]:
    """ST activatePooledOrder 等价实现（B4 POOLED）。

    从最近用户消息后尚未发言的成员中随机选一；若全部已发言，则随机选（排除上一位发言者）。
    """
    if not members:
        return None
    spoken = _collect_spoken_since_last_user(db, group, members)
    candidates = [m for m in members if str(m.id) not in spoken]
    if not candidates:
        last = _get_last_group_speaker_id(db, group, members)
        candidates = [m for m in members if str(m.id) != last] or list(members)
    if not candidates:
        return members[0].id
    return random.choice(candidates).id


def _build_voting_context(
    db: Session,
    group: GroupChat,
    members: list[Character],
    limit: int = 10,
) -> str:
    """构建投票提示词的最近消息上下文。

    从群聊最近会话中读取最后 N 条消息，格式化为 "[name]: mes" 形式。
    系统消息会被跳过；用户消息显示为 "[User]: ..."。
    无历史时返回占位文本。
    """
    try:
        session = (
            db.query(GroupChatSession)
            .filter(
                GroupChatSession.group_id == group.id,
                GroupChatSession.user_id == group.user_id,
            )
            .order_by(GroupChatSession.updated_at.desc())
            .first()
        )
    except Exception as exc:
        logger.warning("Failed to load group session for VOTING context (group_id=%s): %s", group.id, exc)
        return "(暂无对话历史)"

    if session is None or not session.messages:
        return "(暂无对话历史)"

    try:
        msgs = json.loads(session.messages) if isinstance(session.messages, str) else session.messages
    except (json.JSONDecodeError, TypeError):
        return "(暂无对话历史)"

    if not isinstance(msgs, list) or not msgs:
        return "(暂无对话历史)"

    name_set = {(m.name or "").strip() for m in members if m.name}
    recent = [m for m in msgs if isinstance(m, dict)][-limit:]
    lines: list[str] = []
    for msg in recent:
        if bool(msg.get("is_system", False)):
            continue
        name = (msg.get("name") or "").strip()
        mes = (msg.get("mes") or "").strip()
        if not mes:
            continue
        is_user = bool(msg.get("is_user", False))
        # 仅显示群成员或用户的发言，过滤未知发言者
        if is_user:
            display_name = "User"
        elif name and name in name_set:
            display_name = name
        else:
            continue
        lines.append(f"[{display_name}]: {mes}")

    return "\n".join(lines) if lines else "(暂无对话历史)"


def _build_voting_prompt(member_names: list[str], recent_context: str) -> str:
    """构建 VOTING 投票提示词。

    让 LLM 模拟每位群成员根据上下文投票选择下一位发言者，
    返回 JSON 格式的投票结果。
    """
    members_str = "\n".join(f"{i + 1}. {name}" for i, name in enumerate(member_names))
    return (
        "你是一个群聊导演。请根据以下最近的对话上下文，模拟每位群成员投票选择最适合的下一位发言者。\n\n"
        f"群成员列表：\n{members_str}\n\n"
        f"最近对话上下文：\n{recent_context}\n\n"
        "投票规则：\n"
        "- 每位成员投一票，选择最适合接续对话的成员\n"
        "- 成员不能投自己\n"
        "- 综合考虑对话内容与成员性格的匹配度\n\n"
        "请返回 JSON 格式的投票结果，格式为：\n"
        '{"votes": {"投票成员名": "被投票的成员名", ...}}\n\n'
        "只返回 JSON，不要其他内容。"
    )


def _parse_voting_response(
    content: str,
    members: list[Character],
) -> dict[str, int]:
    """解析 LLM 投票响应，返回 {character_id: vote_count}。

    优先尝试 JSON 解析；失败时回退到文本中成员名字出现次数统计。
    无效投票（被投票者不在成员列表中）会被忽略。
    """
    name_to_id = {(m.name or "").strip(): m.id for m in members if m.name}
    if not name_to_id:
        return {}

    # 尝试提取 JSON（兼容 markdown 代码块包装）
    json_str = content.strip()
    if "```" in json_str:
        for part in json_str.split("```"):
            candidate = part.strip()
            if candidate.startswith("json"):
                candidate = candidate[4:].strip()
            if candidate.startswith("{"):
                json_str = candidate
                break

    vote_counts: dict[str, int] = {}

    try:
        data = json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        # JSON 解析失败：回退到文本名字计数
        return _extract_votes_from_text(content, name_to_id)

    votes = data.get("votes") if isinstance(data, dict) else None
    if not isinstance(votes, dict):
        return _extract_votes_from_text(content, name_to_id)

    for voter, candidate in votes.items():
        candidate_name = str(candidate).strip() if candidate else ""
        candidate_id = name_to_id.get(candidate_name)
        if candidate_id:
            vote_counts[candidate_id] = vote_counts.get(candidate_id, 0) + 1

    return vote_counts


def _extract_votes_from_text(
    content: str,
    name_to_id: dict[str, str],
) -> dict[str, int]:
    """从自由文本中按成员名字出现次数提取投票结果。"""
    vote_counts: dict[str, int] = {}
    for name, cid in name_to_id.items():
        if not name:
            continue
        count = content.count(name)
        if count > 0:
            vote_counts[cid] = vote_counts.get(cid, 0) + count
    return vote_counts


def _break_tie_by_talkativeness(
    candidate_ids: list[str],
    members: list[Character],
) -> str:
    """平票时按 talkativeness 加权随机选择发言者。

    - 全部 talkativeness 为 0 时等概率随机
    - 否则按 talkativeness 权重做加权随机（复用 _read_talkativeness）
    """
    id_to_member = {m.id: m for m in members}
    candidates = [id_to_member[cid] for cid in candidate_ids if cid in id_to_member]
    if not candidates:
        return candidate_ids[0]
    if len(candidates) == 1:
        return candidates[0].id

    weights = [max(0.0, _read_talkativeness(m)) for m in candidates]
    if all(w <= 0 for w in weights):
        return random.choice(candidates).id

    chosen = random.choices(candidates, weights=weights, k=1)[0]
    return chosen.id


async def _select_voting_speaker(
    db: Session,
    group: GroupChat,
    members: list[Character],
    model_id: Optional[str],
) -> Optional[str]:
    """VOTING 策略：通过 LLM 模拟成员投票选择下一发言者。

    构建投票提示词，让 LLM 模拟每位群成员根据上下文投票。
    得票最多的成员成为发言者；平票时按 talkativeness 加权随机。

    Args:
        db: 数据库会话
        group: 群聊对象
        members: 群成员角色列表
        model_id: 用于投票的 LLM 模型 ID

    Returns:
        被选中的成员 character_id；无法确定时返回 None（调用方回退到 TALKATIVE）
    """
    if not members or not model_id:
        return None

    member_names = [m.name for m in members if m.name]
    if not member_names:
        return None

    recent_context = _build_voting_context(db, group, members)
    prompt = _build_voting_prompt(member_names, recent_context)

    try:
        result = await complete_text_completion(
            model_id=model_id,
            messages=[
                {"role": "system", "content": "You are a group chat director. Respond only with JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=256,
            top_p=0.9,
        )
    except Exception as exc:
        logger.warning("VOTING LLM call failed (group_id=%s): %s", group.id, exc)
        return None

    content = (result.get("content") or "").strip() if isinstance(result, dict) else ""
    if not content:
        return None

    vote_counts = _parse_voting_response(content, members)
    if not vote_counts:
        return None

    max_votes = max(vote_counts.values())
    winners = [mid for mid, cnt in vote_counts.items() if cnt == max_votes]

    if len(winners) == 1:
        return winners[0]

    # 平票：按 talkativeness 加权随机
    return _break_tie_by_talkativeness(winners, members)


def _cached_request_group(req, group_id: Optional[str]) -> Optional[GroupChat]:
    """E-8 修复: 请求级 GroupChat 缓存。

    装配路径对同一群聊在多个阶段重复查询（选角/激活策略/profile 注入/
    预算/合并卡），本 helper 保证单次装配只查一次。
    """
    if not group_id:
        return None
    cache = getattr(req, "_cache", None)
    if cache is None:
        try:
            return req.db.query(GroupChat).filter(GroupChat.id == group_id).first()
        except Exception as exc:
            logger.warning("GroupChat lookup failed (group_id=%s): %s", group_id, exc)
            return None
    key = f"group:{group_id}"
    if key not in cache:
        try:
            cache[key] = req.db.query(GroupChat).filter(GroupChat.id == group_id).first()
        except Exception as exc:
            logger.warning("GroupChat lookup failed (group_id=%s): %s", group_id, exc)
            cache[key] = None
    return cache[key]


async def _resolve_group_speaker(req: PromptAssemblyRequest) -> None:
    """根据群聊激活策略解析当前发言者（原地设置 req.current_speaker_id）。

    - VOTING(5)：通过 LLM 模拟成员投票选择发言者；LLM 失败或无模型时回退到 TALKATIVE
    - TALKATIVE(4)：若 req.current_speaker_id 未指定，按 talkativeness 加权随机选择
    - 其它策略：保持现状（current_speaker_id 由调用方决定）
    """
    if not req.group_id:
        return

    try:
        group = _cached_request_group(req, req.group_id)
    except Exception as exc:
        logger.warning("GroupChat lookup for activation strategy failed (group_id=%s): %s", req.group_id, exc)
        return
    if group is None:
        return

    # B6 修复: 从 GroupChat 归一化 allow_self_responses 到 req（供发言调度使用）
    req.allow_self_responses = bool(getattr(group, "allow_self_responses", False))

    strategy = int(group.activation_strategy or 0)

    # Phase B 修复: ST 1.18.0 generateGroupWrapper (group-chats.js:1006-1031) —
    # swipe/continue/impersonate/quiet 的选角分支优先于 activation_strategy。
    # 使用全部成员（含 disabled，对齐 ST group.members）。
    _gen_type = (getattr(req, "generation_type", None) or "").lower()
    if _gen_type in ("swipe", "continue", "impersonate", "quiet") and not req.current_speaker_id:
        _type_members = _load_all_members(req.db, group)
        if _type_members:
            if _gen_type == "impersonate":
                # activateImpersonate: 随机选 1 个
                req.current_speaker_id = _activate_impersonate(_type_members)
            elif _gen_type == "quiet":
                # quiet: activateSwipe(allowSystem=True).slice(0,1); 空则回退首个成员
                _qspk = _activate_swipe(req.db, group, _type_members, allow_system=True)
                req.current_speaker_id = _qspk or _type_members[0].id
            else:
                # swipe/continue: activateSwipe(allowSystem=False) 复用被 swipe 发言者
                req.current_speaker_id = _activate_swipe(req.db, group, _type_members, allow_system=False)
        return

    if strategy == _GROUP_ACTIVATION_VOTING and not req.current_speaker_id:
        # 加载启用（未禁用）的群成员角色用于 LLM 投票 (B5 修复: 排除 disabled_members)
        member_ids = _enabled_member_ids(group)

        if not member_ids:
            raise HTTPException(status_code=400, detail="No enabled group members available for VOTING selection")

        try:
            members = (
                req.db.query(Character)
                .filter(Character.id.in_([str(mid) for mid in member_ids]))
                .all()
            )
        except Exception as exc:
            logger.warning("GroupChat member characters lookup for VOTING failed: %s", exc)
            return

        if not members:
            return

        # LLM 投票；失败或无模型时回退到 TALKATIVE 加权随机
        selected_id = await _select_voting_speaker(req.db, group, members, req.model)
        if selected_id:
            req.current_speaker_id = selected_id
        else:
            req.current_speaker_id = _select_talkative_speaker(req.db, group, members, allow_self_responses=req.allow_self_responses)
        return

    elif strategy == _GROUP_ACTIVATION_TALKATIVE and not req.current_speaker_id:
        # 加载启用（未禁用）的群成员角色用于加权随机选择 (B5 修复: 排除 disabled_members)
        member_ids = _enabled_member_ids(group)

        if not member_ids:
            raise HTTPException(status_code=400, detail="No enabled group members available for TALKATIVE selection")

        try:
            members = (
                req.db.query(Character)
                .filter(Character.id.in_([str(mid) for mid in member_ids]))
                .all()
            )
        except Exception as exc:
            logger.warning("GroupChat member characters lookup for TALKATIVE failed: %s", exc)
            return

        if not members:
            return

        req.current_speaker_id = _select_talkative_speaker(req.db, group, members, allow_self_responses=req.allow_self_responses)

    elif strategy == 2 and not req.current_speaker_id:
        # ST 1.18.0 group_activation_strategy=MANUAL(2): 用户显式选择发言者。
        # - 若 req.current_speaker_id 已指定（前端/用户已选），保留之并正常生成。
        # - 若未指定：MANUAL 模式无自动选角，跳过 AI 生成（仅持久化用户消息）。
        # 跳过由 websocket 层 resolve_group_speaker_queue 返回空队列承接。
        logger.debug("GroupChat MANUAL strategy with no speaker selected: skipping AI generation (group_id=%s)", req.group_id)

    elif strategy == 0 and not req.current_speaker_id:
        # B1 NATURAL（ST activateNaturalOrder）：提及强制 + 概率激活 + 防连续
        members = _load_members(req.db, group)
        if members:
            req.current_speaker_id = _select_natural_speaker(
                req.db, group, members, req.message or ""
            )

    elif strategy == 3 and not req.current_speaker_id:
        # B4 POOLED（ST activatePooledOrder）：从未发言成员中随机选一
        members = _load_members(req.db, group)
        if members:
            req.current_speaker_id = _select_pooled_speaker(req.db, group, members)

    elif strategy == 1 and not req.current_speaker_id:
        # B2 LIST（ST activateListOrder）：完整语义需模块 04（多人串联流式 F1）。
        # 本分支为单发言者 fallback（当 _resolve_group_speaker 直接调用时）。
        # 多成员一次性响应已由 F1 实现：websocket resolve_group_speaker_queue 对 LIST 返回
        # 全启用成员有序队列，由 _gen 循环逐成员装配+生成。
        members = _load_members(req.db, group)
        if members:
            last = _get_last_group_speaker_id(req.db, group, members)
            ordered = members
            if last is None:
                req.current_speaker_id = ordered[0].id
            else:
                idx = next((i for i, m in enumerate(ordered) if str(m.id) == str(last)), -1)
                nxt = ordered[(idx + 1) % len(ordered)]
                req.current_speaker_id = nxt.id


def _build_group_profile_context(
    req: PromptAssemblyRequest,
    generation_mode: int = 0,
) -> Optional[str]:
    """构建群组成员 profile 上下文片段。

    群组聊天专用分支：当 req.group_id 非空、对应 GroupChat.member_profiles
    非空时，将当前发言者的 profile（description、personality）作为身份说明
    注入；其他成员的 profile 摘要（仅名称+简短描述）作为上下文。

    generation_mode（C1/C2）：APPEND_DISABLED(2) 时「其他成员」摘要保留 disabled 成员
    （仅作上下文，不参与激活；激活侧已由 _load_members 排除）；SWAP(0)/APPEND(1) 仍排除。

    返回 None 表示未启用群组 profile（保持原 1:1 提示词行为不变）。
    """
    if not req.group_id:
        return None

    try:
        group = _cached_request_group(req, req.group_id)
    except Exception as exc:
        logger.warning("GroupChat lookup failed for group_id=%s: %s", req.group_id, exc)
        return None
    if group is None:
        return None

    raw_profiles = group.member_profiles
    if not raw_profiles:
        return None
    try:
        member_profiles = json.loads(raw_profiles) if isinstance(raw_profiles, str) else raw_profiles
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(member_profiles, dict) or not member_profiles:
        return None

    # 加载所有成员角色（用于名称映射与默认 description/personality 兜底）
    member_ids = []
    if isinstance(group.member_ids, str):
        try:
            member_ids = json.loads(group.member_ids) or []
        except (json.JSONDecodeError, TypeError):
            member_ids = []
    elif isinstance(group.member_ids, list):
        member_ids = group.member_ids

    # B5 修复: 排除 disabled_members，不注入到「其他群组成员」上下文
    disabled_ids: set[str] = set()
    raw_disabled = getattr(group, "disabled_members", None)
    if raw_disabled:
        try:
            disabled_ids = {
                str(m)
                for m in (json.loads(raw_disabled) if isinstance(raw_disabled, str) else raw_disabled)
            }
        except (json.JSONDecodeError, TypeError):
            disabled_ids = set()

    members_map: dict[str, Character] = {}
    if member_ids:
        try:
            chars = (
                req.db.query(Character)
                .filter(Character.id.in_([str(mid) for mid in member_ids]))
                .all()
            )
            members_map = {c.id: c for c in chars}
        except Exception as exc:
            logger.warning("GroupChat member characters lookup failed: %s", exc)

    speaker_id = str(req.current_speaker_id) if req.current_speaker_id else None
    speaker_profile = member_profiles.get(speaker_id) if speaker_id else None
    if not isinstance(speaker_profile, dict):
        speaker_profile = {}

    speaker_char = members_map.get(speaker_id) if speaker_id else None
    speaker_name = (speaker_char.name if speaker_char else None) or speaker_profile.get("name") or "当前发言者"

    # 当前发言者的 description / personality，profile 优先，缺失时回退到角色卡
    speaker_desc = (speaker_profile.get("description") or "").strip()
    if not speaker_desc and speaker_char is not None:
        speaker_desc = (speaker_char.description or "").strip()
    speaker_pers = (speaker_profile.get("personality") or "").strip()
    if not speaker_pers and speaker_char is not None:
        speaker_pers = (speaker_char.personality or "").strip()

    parts: list[str] = []
    parts.append(f"[当前发言者身份] {speaker_name}")
    if speaker_desc:
        parts.append(f"描述: {speaker_desc}")
    if speaker_pers:
        parts.append(f"个性: {speaker_pers}")
    # ST 1.18.0 talkativeness: expose the speaker's talkativeness weight so
    # the model understands the scheduling bias. Read safely via getattr.
    speaker_talkativeness = getattr(speaker_char, "talkativeness", "0.5") if speaker_char else "0.5"
    parts.append(f"活跃度: {speaker_talkativeness}")

    # 其他成员摘要（仅名称和简短描述）
    other_lines: list[str] = []
    for mid, prof in member_profiles.items():
        if str(mid) == speaker_id:
            continue
        # B5 修复: 跳过被禁用的成员；APPEND_DISABLED(2) 时保留（仅作上下文，不激活）
        if generation_mode != 2 and str(mid) in disabled_ids:
            continue
        if not isinstance(prof, dict):
            continue
        m_char = members_map.get(str(mid))
        m_name = (m_char.name if m_char else None) or prof.get("name") or str(mid)
        m_desc = (prof.get("description") or "").strip()
        if not m_desc and m_char is not None:
            m_desc = (m_char.description or "").strip()
        if m_desc:
            # 简短描述：限制在 120 字以内避免占用过多上下文
            short_desc = m_desc if len(m_desc) <= 120 else (m_desc[:117] + "...")
            other_lines.append(f"- {m_name}: {short_desc}")
        else:
            other_lines.append(f"- {m_name}")

    if other_lines:
        parts.append("[其他群组成员]")
        parts.extend(other_lines)

    # ST 1.18.0 群聊高级成员管理：当 active_members / follower_members 设置时，
    # 向模型标注当前可主动发言的成员与跟随成员，辅助发言调度。
    try:
        raw_active = getattr(group, "active_members", None)
        if raw_active:
            active_ids = json.loads(raw_active) if isinstance(raw_active, str) else raw_active
            if isinstance(active_ids, list) and active_ids:
                active_names: list[str] = []
                for aid in active_ids:
                    a_char = members_map.get(str(aid))
                    if a_char:
                        active_names.append(a_char.name or str(aid))
                    else:
                        active_names.append(str(aid))
                if active_names:
                    parts.append(f"[当前可发言成员] {', '.join(active_names)}")
    except (json.JSONDecodeError, TypeError):
        pass

    # B6 修复: follower_members 标注为被动跟随成员，辅助模型理解群聊结构
    try:
        raw_follower = getattr(group, "follower_members", None)
        if raw_follower:
            follower_ids = json.loads(raw_follower) if isinstance(raw_follower, str) else raw_follower
            if isinstance(follower_ids, list) and follower_ids:
                follower_names: list[str] = []
                for fid in follower_ids:
                    f_char = members_map.get(str(fid))
                    if f_char:
                        follower_names.append(f_char.name or str(fid))
                    else:
                        follower_names.append(str(fid))
                if follower_names:
                    parts.append(f"[跟随成员] {', '.join(follower_names)}")
    except (json.JSONDecodeError, TypeError):
        pass

    return "\n".join(parts)


async def assemble_roleplay_prompt(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
) -> PromptAssemblyResult:
    db = req.db
    user_nickname = req.user_nickname or req.user.username or "User"
    # Phase F: 设置当前模型名称（contextvar），供 _estimate_tokens 和
    # worldbook_service 的 _estimate_tokens 按 ST 对齐的 tokenizer 进行精确计数。
    # 在函数结束时自动恢复，确保线程安全。
    from ..services.st_tokenizer_service import set_current_model, reset_current_model
    _model_ctx_token = set_current_model(req.model or "")
    try:
        return await _assemble_roleplay_prompt_impl(req, deps)
    finally:
        reset_current_model(_model_ctx_token)


# ── MVU 变量更新指令：让位卡片自己的声明（2026-10-05）──
# 卡片自带的世界书条目（如 `[mvu_update]变量输出格式`）已经把 `<UpdateVariable>`
# 规范写清了；我们再贴一份写死的模板，模板里的示例路径就会被模型当成**本卡的结构定义**
# 照抄 —— 实测 2026-10-05：`露缇雅1.2` 的模型连发 `/露缇雅/好感度`、`/世界信息/日期时间`、
# 自创顶层键 `露缇雅1.2`，最后用一条 `{"op":"replace","path":"/露缇雅/状态","value":"一句话"}`
# 把卡片声明的 object 结构（爱意/魔力值/饥饿度三条进度条的数据源）覆盖成字符串 → 面板恒 0。
# 对齐 ST：ST 对 MVU 卡不做任何额外注入，卡片自己 depth=0 的说明就是最有影响力的一条。


def _messages_declare_mvu_update_spec(messages: list[dict[str, Any]]) -> bool:
    """提示词里是否已有卡片自己声明的变量更新规范。

    判据只来自卡片文本、不含任何角色名/字段名：同一条消息里既出现变量协议标签
    （``<UpdateVariable>`` 系，含上游别名 ``<update>`` / ``<variableupdate>``，
    大小写不敏感）或 ``[mvu_update]`` 记号，又出现 JSON Patch 规范字样，即算已声明。
    看的是**装配结果**而不是数据库，因为条目可能被 token 预算裁掉——被裁掉就等于没声明。

    ⚠️ [包U · R5 2026-10-19] 别名面引用 ``mvu_engine.MVU_UPDATE_TAG_NEEDLES``，
    不再手抄字面 ``"<UpdateVariable>"``。改前卡里若用别名写说明（``<update>`` 等）
    这里判不出「已声明」→ Palink 再贴一份写死的兜底模板 → 模型照抄模板里的示例
    路径，把卡片声明的 object 结构覆盖成字符串（2026-10-05 面板恒 0 事故的同型面）。
    """
    from ..services.mvu_engine import MVU_UPDATE_TAG_NEEDLES as _UPDATE_TAG_NEEDLES

    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(b.get("text", "")) for b in content if isinstance(b, dict)
            )
        if not isinstance(content, str):
            continue
        lowered = content.lower()
        if "[mvu_update]" not in lowered and not any(
            k in lowered for k in _UPDATE_TAG_NEEDLES
        ):
            continue
        if "json patch" in lowered or "jsonpatch" in lowered or '"op"' in lowered:
            return True
    return False


# 仅在卡片**没有**自带规范时兜底：只讲协议与通用约束，不给任何具体字段名/路径示例。
_MVU_GENERIC_TAIL = (
    "\n\n【变量更新指令 - 强制，不可省略】\n"
    "本卡使用 <UpdateVariable> 变量系统。上文若已给出变量输出格式说明，一律以该说明为准；"
    "若无，必须在【每条回复的最末尾】按下面的格式输出本次剧情引起的变量变化：\n"
    "<UpdateVariable>\n"
    "<Analysis>（英文，80 词以内：时间流逝计算、是否允许戏剧性更新、逐字段变化依据）</Analysis>\n"
    "<JSONPatch>\n"
    "JSON 数组，每项形如 {\"op\": <操作名>, \"path\": \"/分组/字段\", \"value\": <新值>}\n"
    "</JSONPatch>\n"
    "</UpdateVariable>\n"
    "规则：\n"
    "- 支持操作：replace / delta / insert / remove / move（RFC 6902）\n"
    "- path 的分组名与字段名**只能**使用上文「当前状态/变量列表」里已经出现过的键；"
    "禁止新建顶层分组，禁止改用角色名或卡名另起一套结构\n"
    "- 结构是对象（含子字段）的字段，禁止整体替换成一句话字符串——只改它里面的子字段\n"
    "- 以 _ 开头的字段为只读，禁止更新；未变化的字段不要输出\n"
    "- 【严格禁止】把变量状态（时间、数值、状态描述等）写进回复正文，正文只写剧情对话；"
    "变量只通过 <UpdateVariable> 输出\n"
    "- 此标签不受「禁止 XML 标签」规则限制\n"
)


async def _assemble_roleplay_prompt_impl(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
) -> PromptAssemblyResult:
    """Actual prompt assembly implementation (called with model contextvar set)."""
    db = req.db
    user_nickname = req.user_nickname or req.user.username or "User"
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == req.user.id).first()
    # 无设置行时按默认档（vector）走，与 UserSetting.memory_mode 列默认值一致
    # 2026-09-23：原为 "disabled"（等于新用户完全没有记忆）
    memory_mode = "vector"
    if user_setting and user_setting.memory_mode:
        memory_mode = user_setting.memory_mode

    prompt_lang = user_setting.prompt_language if user_setting else "auto"
    # T3（2026-09-27 身份层 ST 化）：dialogue_mode 整链删除，全关键字传参防位置错位。
    _built_prompt = deps.build_system_prompt(
        char=req.char,
        user_nickname=user_nickname,
        prompt_lang=prompt_lang,
        user_setting=user_setting,
    )
    # [D-5b 2026-10-25] 分槽识别：生产实现返回 CharacterPromptSlots
    # （main 已不含 description/personality/scenario）；返回 str 的旧实现按
    # "三段仍在 main 内"处理（_char_slots=None ⇒ 不产生独立消息，也不重复）。
    # 判据用类型而不是内容嗅探——内容嗅探会在字段恰好等于某标签文本时误判。
    if isinstance(_built_prompt, CharacterPromptSlots):
        _char_slots: Optional[CharacterPromptSlots] = _built_prompt
        system_prompt = _built_prompt.main
    else:
        _char_slots = None
        system_prompt = _built_prompt
    report: list[PromptAssemblyReportItem] = [
        PromptAssemblyReportItem("base_system_prompt", "included", tokens_estimate=_estimate_tokens(system_prompt)),
    ]

    # 群聊激活策略解析：在构建 group profile 之前解析 current_speaker_id，
    # 以便 _build_group_profile_context 能注入正确的发言者身份。
    # - VOTING(5)：LLM 模拟成员投票（失败回退 TALKATIVE）
    # - TALKATIVE(4)：按 talkativeness 加权随机选择发言者
    # - MANUAL(2)：用户显式选角；未指定发言者时由 websocket 队列返回空队列跳过 AI 生成
    await _resolve_group_speaker(req)

    # MANUAL(2) 无选角跳过 AI 生成由 websocket 层 resolve_group_speaker_queue 返回空队列承接；
    # _resolve_group_speaker 不再设置任何跳过标志。

    # D3 修复: 解析当前发言者角色对象，用于 {{char}} 绑定与 builder 传参
    speaker_char: Optional[Character] = None
    # C1 修复: 读取群生成模式（SWAP=0/APPEND=1/APPEND_DISABLED=2），对齐 ST 三模式
    group_generation_mode: int = 0
    # E1 修复: 群 per-member 世界书策略（ST world_info_character_strategy: one/all/group）
    group_wi_strategy: str = "one"
    _g_mode: Optional[GroupChat] = None
    if req.group_id and req.current_speaker_id:
        try:
            speaker_char = (
                db.query(Character)
                .filter(Character.id == str(req.current_speaker_id))
                .first()
            )
        except Exception as sp_err:
            logger.warning("Failed to resolve speaker character (speaker=%s): %s", req.current_speaker_id, sp_err)
    if req.group_id:
        try:
            _g_mode = _cached_request_group(req, req.group_id)
            if _g_mode is not None:
                group_generation_mode = int(getattr(_g_mode, "generation_mode", 0) or 0)
                # E1: 读取 world_info_character_strategy（默认 one = 仅发言者，不并入群成员字段）
                _meta_raw = getattr(_g_mode, "chat_metadata", None)
                _meta: dict = {}
                if _meta_raw:
                    try:
                        _meta = json.loads(_meta_raw) if isinstance(_meta_raw, str) else _meta_raw
                    except (json.JSONDecodeError, TypeError):
                        _meta = {}
                if isinstance(_meta, dict):
                    group_wi_strategy = str(_meta.get("world_info_character_strategy") or "one")
        except Exception as gm_err:
            logger.warning("Failed to resolve group generation_mode (group_id=%s): %s", req.group_id, gm_err)

    # D3 修复: {{char}} 宏在群聊时绑定发言者名（无发言者则回退主角色）
    _macro_char_name = (speaker_char.name if speaker_char is not None else None) or (req.char.name or "Character")

    # 群组聊天分支：当 group_id 非空且 member_profiles 非空时，
    # 将当前发言者的 profile 注入系统提示词（作为角色身份说明），
    # 其他成员的 profile 摘要作为上下文（仅名称和简短描述）。
    group_profile_part = _build_group_profile_context(req, generation_mode=group_generation_mode)
    if group_profile_part:
        system_prompt = system_prompt + "\n\n" + group_profile_part
        report.append(
            PromptAssemblyReportItem(
                "group_member_profiles",
                "included",
                detail=f"group_id={req.group_id}; speaker={req.current_speaker_id}",
                tokens_estimate=_estimate_tokens(group_profile_part),
            )
        )
    else:
        if req.group_id:
            report.append(PromptAssemblyReportItem("group_member_profiles", "skipped", "no profiles"))

    # Resolve author_note source (priority aligned with ST /note per-chat override):
    #   1. CharacterChatSession.chat_metadata["author_note"] — set by /note slash command (per-chat)
    #   2. GroupChat.author_note                            — group-level override
    #   3. UserSetting.author_note                          — global default
    # F1 修复: /note 命令把 author_note 存入 session.chat_metadata (slash_command_service.py)。
    # 注意：CharacterChatSession 模型无 extensions 列，per-chat 数据存于 chat_metadata(JSON文本)，
    # 与 ST 导入聊天(迁移0056注释的 chat_metadata.note_position)一致。此前装配只读 GroupChat/UserSetting
    # 从不读 session → /note 静默失效；现在统一从 chat_metadata 读取。
    # Phase G: position/depth/frequency 也从 chat_metadata 优先读取（per-chat 覆盖），
    # 对齐 ST 存储；UserSetting 作为全局回退。
    author_note_text: Optional[str] = None
    _session_ext_note: dict = {}
    if req.session_id:
        try:
            _sess_for_note = db.query(CharacterChatSession).filter(
                CharacterChatSession.id == req.session_id
            ).first()
            if _sess_for_note is not None and _sess_for_note.chat_metadata:
                try:
                    _ext_note = json.loads(_sess_for_note.chat_metadata) if isinstance(_sess_for_note.chat_metadata, str) else _sess_for_note.chat_metadata
                    if isinstance(_ext_note, dict):
                        _session_ext_note = _ext_note
                        _snote = _ext_note.get("author_note")
                        if _snote:
                            author_note_text = _snote
                except (json.JSONDecodeError, TypeError):
                    pass
        except Exception as exc:
            logger.warning("Session extensions author_note lookup failed (session=%s): %s", req.session_id, exc)
    if author_note_text is None and req.group_id:
        try:
            group_for_note = _cached_request_group(req, req.group_id)
            if group_for_note is not None and group_for_note.author_note:
                author_note_text = group_for_note.author_note
        except Exception as exc:
            logger.warning("GroupChat author_note lookup failed for group_id=%s: %s", req.group_id, exc)
    if author_note_text is None and user_setting:
        author_note_text = user_setting.author_note or None

    # [ST-ALIGN P0-3] TOP_AN(2) / BOTTOM_AN(3)：把人设描述拼进作者注记，随 AN 的
    # 位置、深度、frequency 一起注入 —— 对齐 ST addPersonaDescriptionExtensionPrompt
    # 的 TOP_AN/BOTTOM_AN 分支（persona 与 AN 合并成一个扩展提示词）。
    # AN 为空时**不合并**，交给下方 persona 分支独立注入，避免人设丢失。
    _persona_an = _resolve_active_persona(db, req, user_setting)
    _persona_merged_into_an = False
    if _persona_an is not None and author_note_text:
        try:
            # ⚠ 解构必须与 _resolve_active_persona 的返回元组长度一致（(text, pos, depth)）。
            # 本段在装配主流程且位于 try 之外，解构错位会抛 ValueError 中断整次装配。
            _p_text, _p_pos, _p_depth = _persona_an
            if _p_pos == _ST_PERSONA_TOP_AN:
                author_note_text = _p_text + "\n\n" + author_note_text
                _persona_merged_into_an = True
            elif _p_pos == _ST_PERSONA_BOTTOM_AN:
                author_note_text = author_note_text + "\n\n" + _p_text
                _persona_merged_into_an = True
        except Exception as _exc:
            logger.warning("Persona TOP_AN/BOTTOM_AN merge failed: %s", _exc)

    # Resolve position (single Integer field, ST 1.18.0 extension_prompt_types):
    #   -1 = NONE          (skip injection)
    #    0 = IN_PROMPT      (after post-history; appended to system prompt end)
    #    1 = IN_CHAT        (in-chat at depth via author_note_depth)
    #    2 = BEFORE_PROMPT  (before story string; prepended to system prompt start)
    # Migration 0056 converted legacy Palink values (0=depth/1=after/2=last/
    # 3=inactive/4=top) to this ST-aligned set. Default 1 = IN_CHAT (ST default).
    # Phase G: 优先从 chat_metadata 读取（per-chat），回退 UserSetting（global）
    author_note_position_int = 1
    if "author_note_position" in _session_ext_note:
        try:
            author_note_position_int = int(_session_ext_note["author_note_position"])
        except (TypeError, ValueError):
            pass
    elif user_setting and user_setting.author_note_position is not None:
        try:
            author_note_position_int = int(user_setting.author_note_position)
        except (TypeError, ValueError):
            author_note_position_int = 1

    # Resolve depth (used when position_int == 1 / IN_CHAT).
    # Phase G: 优先从 chat_metadata 读取（per-chat），回退 UserSetting（global）
    author_note_depth = 4
    if "author_note_depth" in _session_ext_note:
        try:
            author_note_depth = int(_session_ext_note["author_note_depth"])
        except (TypeError, ValueError):
            author_note_depth = 4
    elif user_setting:
        depth_val = getattr(user_setting, "author_note_depth", None)
        if depth_val is not None:
            try:
                author_note_depth = int(depth_val)
            except (TypeError, ValueError):
                author_note_depth = 4

    # Phase G: 优先从 chat_metadata 读取 frequency（per-chat），回退 UserSetting（global）
    author_note_frequency = 0
    if "author_note_frequency" in _session_ext_note:
        try:
            author_note_frequency = int(_session_ext_note["author_note_frequency"])
        except (TypeError, ValueError):
            author_note_frequency = 0
    elif user_setting and user_setting.author_note_frequency is not None:
        author_note_frequency = user_setting.author_note_frequency

    # author_note depth entry — populated when position_int == 1 (IN_CHAT);
    # appended to depth_entries before _insert_depth_prompt runs.
    author_note_depth_entry: Optional[DepthInjection] = None

    if not author_note_text:
        report.append(PromptAssemblyReportItem("author_note", "skipped", "empty"))
    elif author_note_position_int == -1:
        # ST 1.18.0 NONE: skip injection
        report.append(PromptAssemblyReportItem(
            "author_note",
            "skipped",
            "inactive (position_int=-1, NONE)",
        ))
    else:
        # Frequency gating: when frequency > 1, only inject every Nth message.
        should_inject = True
        if author_note_frequency and author_note_frequency > 1:
            try:
                msg_count_q = db.query(CharacterChatMessage).filter(
                    CharacterChatMessage.session_id == req.session_id,
                )
                if req.branch_id:
                    msg_count_q = msg_count_q.filter(CharacterChatMessage.branch_id == req.branch_id)
                else:
                    msg_count_q = msg_count_q.filter(CharacterChatMessage.branch_id.is_(None))
                existing_msg_count = int(msg_count_q.count() or 0)
                if existing_msg_count % int(author_note_frequency) != 0:
                    should_inject = False
            except Exception as exc:
                logger.warning("author_note frequency check failed: %s", exc)

        if not should_inject:
            report.append(PromptAssemblyReportItem(
                "author_note",
                "skipped",
                detail=f"frequency={author_note_frequency}; message_count_not_multiple",
            ))
        else:
            note_text = deps.replace_placeholders(author_note_text, user_nickname, req.char.name or "")
            if author_note_position_int == 1:
                # IN_CHAT: queue for depth insertion into message history.
                # ST 对齐: AN 在 ST 经 setExtensionPrompt('2_floating_prompt') 进注册表
                # （authors-note.js L26），order=100 扩展桶
                author_note_depth_entry = DepthInjection(
                    depth=author_note_depth,
                    content=note_text,
                    role=_ROLE_NAME_TO_INT["system"],
                    source="author_note",
                    sort_key=_KEY_AN_DEPTH,
                )
                report.append(PromptAssemblyReportItem(
                    "author_note",
                    "included",
                    detail=f"position_int=1 (IN_CHAT); depth={author_note_depth}; frequency={author_note_frequency}",
                    tokens_estimate=_estimate_tokens(note_text),
                ))
            elif author_note_position_int == 0:
                # IN_PROMPT: append to system_prompt (after post-history).
                system_prompt = system_prompt + "\n\n" + note_text
                report.append(PromptAssemblyReportItem(
                    "author_note",
                    "included",
                    detail=f"position_int=0 (IN_PROMPT); frequency={author_note_frequency}",
                    tokens_estimate=_estimate_tokens(note_text),
                ))
            elif author_note_position_int == 2:
                # BEFORE_PROMPT: prepend to system_prompt (before story string).
                system_prompt = note_text + "\n\n" + system_prompt
                report.append(PromptAssemblyReportItem(
                    "author_note",
                    "included",
                    detail=f"position_int=2 (BEFORE_PROMPT); frequency={author_note_frequency}",
                    tokens_estimate=_estimate_tokens(note_text),
                ))
            else:
                report.append(PromptAssemblyReportItem(
                    "author_note",
                    "skipped",
                    detail=f"unknown position_int={author_note_position_int}",
                ))

    # Persona description injection (ST 1.18.0) —— 位置枚举见 personas.js:88-97。
    # 解析（_resolve_active_persona）已在作者注记之前完成，TOP_AN/BOTTOM_AN 在
    # 那里已合并进 AN；此处处理其余位置。
    #   0 IN_PROMPT  → 追加到 system_prompt（ST 为独立 userPersona 块）
    #   1 AFTER_CHAR → 已废弃，同 IN_PROMPT 处理
    #   2 TOP_AN     → 已并入 AN 顶部；AN 为空时按 AT_DEPTH 兜底注入
    #   3 BOTTOM_AN  → 已并入 AN 底部；AN 为空时作为最后一条 system 消息兜底
    #   4 AT_DEPTH   → 对话中第 depth 条前（depth=4）
    #   9 NONE       → 不注入
    persona_depth_entry: Optional[DepthInjection] = None
    persona_last_message: Optional[str] = None
    if _persona_an is None:
        report.append(PromptAssemblyReportItem(
            "persona_description",
            "skipped",
            detail="no active persona / persona_show=False / empty description",
        ))
    else:
        persona_text, persona_position, persona_depth = _persona_an
        if _persona_merged_into_an:
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "included",
                detail="position=2/3 (TOP_AN/BOTTOM_AN); merged into author_note",
                tokens_estimate=_estimate_tokens(persona_text),
            ))
        elif persona_position in (_ST_PERSONA_IN_PROMPT, _ST_PERSONA_AFTER_CHAR):
            system_prompt = system_prompt + "\n\n" + persona_text
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "included",
                detail=f"position={persona_position} (IN_PROMPT/AFTER_CHAR); appended to system_prompt",
                tokens_estimate=_estimate_tokens(persona_text),
            ))
        elif persona_position == _ST_PERSONA_TOP_AN:
            # AN 为空兜底：按 AT_DEPTH 注入，避免人设整体丢失
            persona_depth_entry = DepthInjection(
                depth=persona_depth,
                content=persona_text,
                role=_ROLE_NAME_TO_INT["system"],
                source="persona_description",
                sort_key=_KEY_PERSONA_DEPTH,
            )
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "included",
                detail=f"position=2 (TOP_AN); author_note empty → depth={persona_depth} fallback",
                tokens_estimate=_estimate_tokens(persona_text),
            ))
        elif persona_position == _ST_PERSONA_BOTTOM_AN:
            # AN 为空兜底：作为最后一条 system 消息（沿用旧「聊天末尾」语义）
            persona_last_message = persona_text
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "included",
                detail="position=3 (BOTTOM_AN); author_note empty → last system message fallback",
                tokens_estimate=_estimate_tokens(persona_text),
            ))
        elif persona_position == _ST_PERSONA_AT_DEPTH:
            persona_depth_entry = DepthInjection(
                depth=persona_depth,
                content=persona_text,
                role=_ROLE_NAME_TO_INT["system"],
                source="persona_description",
                sort_key=_KEY_PERSONA_DEPTH,
            )
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "included",
                detail=f"position=4 (AT_DEPTH); depth={persona_depth}",
                tokens_estimate=_estimate_tokens(persona_text),
            ))
        elif persona_position == _ST_PERSONA_NONE:
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "skipped",
                detail="inactive (position=9, NONE)",
            ))
        else:
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "skipped",
                detail=f"unknown position={persona_position}",
            ))

    # Palink slash-command injections (/inject) — read from session.chat_metadata.
    # Each entry: {"content": str, "position": int, "depth": int}
    #   position 0 = in-chat (at depth)  → queued as depth_entry
    #   position 1 = after system prompt  → appended to system_prompt
    #   position 2 = before author note   → appended at end of chat (Palink
    #              extension; ST alignment removed the old "last in chat"
    #              author-note target, so these now trail chat history)
    palink_injection_depth_entries: list[DepthInjection] = []
    palink_injection_before_author_note: list[str] = []
    try:
        palink_session = db.query(CharacterChatSession).filter(
            CharacterChatSession.id == req.session_id,
        ).first()
        if palink_session is not None and palink_session.chat_metadata:
            try:
                palink_meta = json.loads(palink_session.chat_metadata)
            except (json.JSONDecodeError, TypeError):
                palink_meta = None
            if isinstance(palink_meta, dict):
                palink_injections = palink_meta.get("palink_injections")
                if isinstance(palink_injections, list):
                    for inj in palink_injections:
                        if not isinstance(inj, dict):
                            continue
                        inj_content = str(inj.get("content") or "").strip()
                        if not inj_content:
                            continue
                        inj_content = balance_custom_tags(inj_content)
                        try:
                            inj_position = int(inj.get("position", 0))
                        except (TypeError, ValueError):
                            inj_position = 0
                        try:
                            inj_depth = int(inj.get("depth", 4))
                        except (TypeError, ValueError):
                            inj_depth = 4
                        if inj_position == 1:
                            system_prompt = system_prompt + "\n\n" + inj_content
                            report.append(PromptAssemblyReportItem(
                                "palink_injection",
                                "included",
                                detail=f"position=1 (after system prompt)",
                                tokens_estimate=_estimate_tokens(inj_content),
                            ))
                        elif inj_position == 2:
                            palink_injection_before_author_note.append(inj_content)
                            report.append(PromptAssemblyReportItem(
                                "palink_injection",
                                "included",
                                detail=f"position=2 (before author note)",
                                tokens_estimate=_estimate_tokens(inj_content),
                            ))
                        else:
                            # position 0 (in-chat at depth) — default
                            # ST 对齐: 类比 prompt-manager 条目（order=100，key 前缀使其先于扩展源）
                            palink_injection_depth_entries.append(DepthInjection(
                                depth=inj_depth,
                                content=inj_content,
                                role=_ROLE_NAME_TO_INT["system"],
                                source="palink_injection",
                                sort_key=_KEY_PALINK_INJECT,
                            ))
                            report.append(PromptAssemblyReportItem(
                                "palink_injection",
                                "included",
                                detail=f"position=0 (in-story); depth={inj_depth}",
                                tokens_estimate=_estimate_tokens(inj_content),
                            ))
    except Exception as exc:
        logger.warning("Palink injection lookup failed: %s", exc)
        report.append(PromptAssemblyReportItem(
            "palink_injection",
            "skipped",
            detail=f"lookup_error: {exc}",
        ))

    # ── ST 1.18.0 extension_prompts 注入 ────────────────────────────
    # 合并请求中的 extension_prompts（req.extension_prompts）与 DB 中的
    # ExtensionPrompt 记录，按 filter 过滤后按 position 分类（ST script.js:491-496）：
    #   BEFORE_PROMPT(2) → 立即 prepend 到 system_prompt（在 build_character_chat_messages 之前）
    #   IN_PROMPT(0)     → 排队为 ext_in_prompt_entries，等 system_prompt 构建完成后追加末尾（不按 depth）
    #   IN_CHAT(1)       → 排队为 ext_depth_entries（统一队列），按 ST 三级序注入 chat history
    #   NONE(-1)         → 跳过（已在 _collect_extension_prompts 中过滤）
    ext_depth_entries: list[DepthInjection] = []  # IN_CHAT(1) 用 —— ST 对齐: 与世界书/AN/persona 统一队列
    ext_chat_messages: list[dict[str, str]] = []  # {"role": str, "content": str} — 保留以兼容引用，IN_CHAT 改走 ext_depth_entries
    ext_in_prompt_entries: list[tuple[str, str]] = []  # (content, role) for IN_PROMPT(0)
    ext_before_prompt_entries: list[tuple[str, str]] = []  # (content, role) for BEFORE_PROMPT(2)

    # [PROMPT-EVERY-TURN 2026-10-02] 第 0 步铁证：received = 请求体原始携带的
    # 条目摘要（前端实时通道是否到场）；applied = 合并 DB 持久层、@bubble 门控
    # 与 filter 后实际注入的条目摘要（0 条也显式记录，缺席不再静默）。
    def _ext_entry_content(raw: Any) -> str:
        if hasattr(raw, "content"):
            return str(getattr(raw, "content", "") or "")
        if isinstance(raw, dict):
            return str(raw.get("content") or "")
        return ""

    _ext_evidence: dict = {
        "received": {
            "count": len(req.extension_prompts or []),
            "total_chars": sum(len(_ext_entry_content(raw)) for raw in (req.extension_prompts or [])),
        },
        "applied": {
            "count": 0,
            "total_chars": 0,
            "chars_reported": 0,
            "chars_injected": 0,
            "dropped_sections": [],
            "identifiers": [],
        },
    }
    try:
        # [PROMPT-STRIP-EVIDENCE 2026-10-02] 降级路径的双计数出参。单一个 chars 是
        # 上一轮吞段问题拖了一整轮的直接原因：注入 385 字符看着"有内容"，没人发现
        # 原始上报是 1796、被自家逻辑啃掉了 79%。
        _degrade_stats: dict = {}
        ext_prompts = _collect_extension_prompts(req, stats=_degrade_stats)
        _entry_stats: dict = _degrade_stats.get("entries") or {}
        _injected_chars = sum(len((entry.get("content") or "")) for entry in ext_prompts)
        _applied_ids = {entry.get("identifier") for entry in ext_prompts}
        # 未进降级路径的条目 reported == injected；被降级/被整条丢弃的按快照回填。
        _degraded_injected = sum(
            st.get("injected", 0)
            for ident, st in _entry_stats.items()
            if ident in _applied_ids
        )
        _degraded_reported = sum(st.get("reported", 0) for st in _entry_stats.values())
        _reported_chars = _injected_chars - _degraded_injected + _degraded_reported
        _ext_evidence["applied"] = {
            "count": len(ext_prompts),
            "total_chars": _injected_chars,
            "chars_reported": _reported_chars,
            "chars_injected": _injected_chars,
            "dropped_sections": list(_degrade_stats.get("dropped_sections") or []),
            "identifiers": [
                {
                    "identifier": entry.get("identifier"),
                    "chars": len(entry.get("content") or ""),
                    "chars_reported": (
                        _entry_stats.get(entry.get("identifier")) or {}
                    ).get("reported", len(entry.get("content") or "")),
                    "position": entry.get("position"),
                }
                for entry in ext_prompts
            ],
        }
        for entry in ext_prompts:
            pos = int(entry.get("position", EXTENSION_PROMPT_POSITION_NONE))
            content = entry.get("content", "")
            role = entry.get("role", "system") or "system"
            depth = int(entry.get("depth", 4) or 4)
            identifier = entry.get("identifier", "")
            # P2-7 修复: scan=true 时对 content 执行 macro 替换
            # 对齐 ST 1.18.0 openai.js: setExtensionPrompt(scan=true) 语义 —
            # 当 scan=true 时，content 中的 {{char}}/{{user}}/{{pick}} 等宏在
            # 注入前求值，使其能动态生成内容并参与递归扫描。
            if entry.get("scan") and req.char is not None:
                try:
                    content = deps.replace_placeholders(
                        content,
                        user_nickname,
                        req.char.name or "",
                    )
                except Exception as exc:
                    logger.warning(
                        "ExtensionPrompt scan macro substitution failed (id=%s): %s",
                        identifier, exc,
                    )
            # ST 1.18.0 真实行为（openai.js:1132-1138, 1445-1456, 810-852）：
            #   BEFORE_PROMPT(2) → 前置到 system_prompt（position='start'）
            #   IN_PROMPT(0)     → 追加到 system_prompt 末尾（position='end'），不按 depth
            #   IN_CHAT(1)       → 按 depth 插入到 chat history
            if pos == EXTENSION_PROMPT_POSITION_BEFORE_PROMPT:
                # 收集到 ext_before_prompt_entries，等 system_prompt 构建完成后一次性 prepend
                # （避免逐条 prepend 导致多条目逆序）
                ext_before_prompt_entries.append((content, role))
                report.append(PromptAssemblyReportItem(
                    "extension_prompt",
                    "included",
                    detail=f"identifier={identifier}; position=2 (BEFORE_PROMPT, before system prompt)",
                    tokens_estimate=_estimate_tokens(content),
                ))
            elif pos == EXTENSION_PROMPT_POSITION_IN_PROMPT:
                # [ASM-4] 排队为独立消息（main 之后落位，见前部装配段 D-12 注释）
                ext_in_prompt_entries.append((content, role))
                report.append(PromptAssemblyReportItem(
                    "extension_prompt",
                    "included",
                    detail=f"identifier={identifier}; position=0 (IN_PROMPT, independent message after main); role={role}",
                    tokens_estimate=_estimate_tokens(content),
                ))
            elif pos == EXTENSION_PROMPT_POSITION_IN_CHAT:
                # 按 depth 注入到 chat history（暂存，等 messages 构建后插入）
                # ST 对齐: order=100（扩展通道固定桶）+ identifier 作注册表 key
                # （ST getExtensionPrompt 按 Object.keys().sort() 字母序合并）
                ext_depth_entries.append(DepthInjection(
                    depth=max(0, depth),
                    content=content,
                    role=_ROLE_NAME_TO_INT.get(str(role).lower(), 0),
                    source="extension_prompt",
                    sort_key=identifier or "zzz_ext",
                ))
                report.append(PromptAssemblyReportItem(
                    "extension_prompt",
                    "included",
                    detail=f"identifier={identifier}; position=1 (IN_CHAT, depth={depth}); role={role}",
                    tokens_estimate=_estimate_tokens(content),
                ))
            # NONE(-1) 已在 _collect_extension_prompts 中过滤，这里不出现
        if not ext_prompts:
            report.append(PromptAssemblyReportItem(
                "extension_prompt",
                "skipped",
                "no entries matched",
            ))
    except Exception as exc:
        logger.warning("Extension prompts injection collect failed: %s", exc)
        report.append(PromptAssemblyReportItem(
            "extension_prompt",
            "error",
            detail=str(exc),
        ))

    effective_max_tokens = int(req.max_tokens or 2048)
    response_length_hint, target_max_tokens = _response_length_guidance(
        req.response_length,
        prompt_lang,
        req.char,
        deps.contains_chinese,
    )
    if target_max_tokens is not None:
        effective_max_tokens = target_max_tokens

    dynamic_context_parts: list[str] = []
    # ST 1.18.0 prompt_order: track the report key for each dynamic_context_part
    # so that _apply_prompt_order can reorder them by PromptPreset.prompt_order.
    dynamic_context_part_keys: list[str] = []

    if req.smart_card_trigger and req.smart_card_context:
        smart_card_part = "[Smart card selected start context]\n" + balance_custom_tags(str(req.smart_card_context))
        dynamic_context_parts.append(smart_card_part)
        dynamic_context_part_keys.append("smart_card_context")
        report.append(
            PromptAssemblyReportItem(
                "smart_card_context",
                "included",
                tokens_estimate=_estimate_tokens(smart_card_part),
            )
        )
    else:
        report.append(PromptAssemblyReportItem("smart_card_context", "skipped"))

    depth_entries: list[DepthInjection] = []  # ST 对齐统一队列（世界书/AN/persona//inject/插件）
    # ST 1.18.0 对齐: 收集世界书 position 5/6/7 条目，传给 MacroEnv 供
    # {{mesExamples}} 和 {{outlet::name}} 宏注入
    wb_em_top_entries: list[str] = []
    wb_em_bottom_entries: list[str] = []
    wb_outlet_entries: dict[str, list[str]] = {}
    # [ASM-4 2026-10-24] D-1+NF-3 拆桶出参：before/after 前部两桶 + ANTop/ANBottom
    # 作者注通道桶（世界书正文不再并入尾部 [World Lore] 混合块）。
    wb_wi_before_parts: list[str] = []
    wb_wi_after_parts: list[str] = []
    wb_an_before_parts: list[str] = []
    wb_an_after_parts: list[str] = []
    _part_count_before = len(dynamic_context_parts)
    # E-1 修复: 世界书扫描（N+1 查询 + token 编码）是纯同步重活，移入线程池，
    # 避免阻塞事件循环（与 persist_snapshot 的 to_thread 模式一致）。
    # A5 修复: 与 _compute_prompt_token_budget 同源取真实上下文上限
    # （用户 openai_max_context 覆盖优先，回退模型注册表 context_length）。
    _wb_ctx_override = _get_openai_max_context_override(
        user_setting, req.model, req.char.id if req.char else None)
    _wb_max_context_tokens = (
        _wb_ctx_override
        if isinstance(_wb_ctx_override, int) and _wb_ctx_override > 0
        else _get_model_context_window(req.model)
    )
    await asyncio.to_thread(
        _append_worldbook_context,
        req,
        deps,
        dynamic_context_parts,
        depth_entries,
        report,
        em_top_entries=wb_em_top_entries,
        em_bottom_entries=wb_em_bottom_entries,
        outlet_entries=wb_outlet_entries,
        char_name=_macro_char_name,
        max_context_tokens=_wb_max_context_tokens,
        # D 批修复: 群聊世界书上下文（此前分支引用非作用域变量致群聊注入整体失效）
        group_chat=_g_mode,
        group_wi_strategy=group_wi_strategy,
        # [ASM-4] D-1+NF-3：拆桶模式（position 0/1/2/3 不再并入尾块）
        wi_before_parts=wb_wi_before_parts,
        wi_after_parts=wb_wi_after_parts,
        an_before_parts=wb_an_before_parts,
        an_after_parts=wb_an_after_parts,
    )
    dynamic_context_part_keys.extend(["worldbook"] * (len(dynamic_context_parts) - _part_count_before))

    _part_count_before = len(dynamic_context_parts)
    await asyncio.to_thread(_append_plotline_context, req, deps, dynamic_context_parts, report)
    dynamic_context_part_keys.extend(["plotline"] * (len(dynamic_context_parts) - _part_count_before))

    if response_length_hint:
        dynamic_context_parts.append(response_length_hint)
        dynamic_context_part_keys.append("response_length")
        report.append(
            PromptAssemblyReportItem(
                "response_length",
                "included",
                detail=str(req.response_length),
                tokens_estimate=_estimate_tokens(response_length_hint),
            )
        )
    else:
        report.append(PromptAssemblyReportItem("response_length", "skipped"))

    _part_count_before = len(dynamic_context_parts)
    # [分层记忆 Phase 1] 实体卡注入 + 1b 长会话门控 + 档位注入预算：
    # 预算在此预计算（_compute_prompt_token_budget 纯函数，与下方
    # _apply_token_budget 调用点重复计算无副作用），供门控判断
    # "历史+已注入是否仍在窗口内"。
    _memory_token_budget = _compute_prompt_token_budget(
        req.model, effective_max_tokens,
        context_window_override=_get_openai_max_context_override(
            user_setting, req.model, req.char.id if req.char else None),
    )
    # [ASM-4 2026-10-24] D-2/D-3 前部桶：实体卡 + 记忆文本（main 之后独立消息）。
    memory_front_parts: list[str] = []
    _memory_budget = _resolve_memory_max_tokens(user_setting)
    # [MEM-BUDGET-CLAMP 2026-10-09] 档位预算不得吃掉 prompt 总预算。
    # 档位表上限 6000，而用户设置缺失时默认 1500；但 prompt 总预算
    # （context_window − max_tokens − reserve）在小窗口模型 / 长 max_tokens 下
    # 可能只剩两三千。此时记忆区按档位吃满会把历史挤没——记忆区是"补充"，
    # 历史才是主线。夹到总预算的 40%（另一个 40% 留给历史，其余给卡片/世界书）。
    # 记忆档位语义在**正常窗口**下逐字不变（预算远大于档位时不触发）。
    _mem_cap = int(_memory_token_budget * _MEMORY_BUDGET_MAX_SHARE)
    if _mem_cap > 0 and _memory_budget > _mem_cap:
        logger.warning(
            "[MEM-BUDGET-CLAMP] 记忆档位预算 %d 超过 prompt 总预算 %d 的 %.0f%%（上限 %d），"
            "已夹到上限——避免记忆区挤占对话历史",
            _memory_budget, _memory_token_budget,
            _MEMORY_BUDGET_MAX_SHARE * 100, _mem_cap,
        )
        _memory_budget = _mem_cap
    report.append(PromptAssemblyReportItem(
        "memory_budget", "included",
        detail=f"resolved={_memory_budget},prompt_budget={_memory_token_budget}",
        tokens_estimate=_memory_budget,
    ))
    await _append_memory_context(
        req, deps, memory_mode, dynamic_context_parts, report,
        memory_max_tokens=_memory_budget,
        token_budget=_memory_token_budget,
        system_prompt=system_prompt,
        history_reserve=_get_history_reserve(user_setting),
        # [ASM-4] D-2/D-3：实体卡与记忆写入前部桶（main 之后独立消息），
        # 不再进尾部混合块。
        front_parts=memory_front_parts,
    )
    dynamic_context_part_keys.extend(["memory"] * (len(dynamic_context_parts) - _part_count_before))

    include_title_instruction = req.include_title_instruction and not req.is_init
    if include_title_instruction:
        report.append(PromptAssemblyReportItem("compact_title_instruction", "included"))
    else:
        report.append(PromptAssemblyReportItem("compact_title_instruction", "skipped"))

    # ST 1.18.0 prompt_order — optionally reorder dynamic_context_parts by
    # PromptPreset.prompt_order when a preset is bound. Minimal: only reorders
    # when req.prompt_preset_id is set and the preset has a prompt_order array.
    prompt_preset = _load_prompt_preset(db, req.prompt_preset_id)
    if prompt_preset is not None:
        dynamic_context_parts = _apply_prompt_order(
            dynamic_context_parts, dynamic_context_part_keys, prompt_preset, report
        )
    elif req.prompt_preset_id:
        report.append(PromptAssemblyReportItem("prompt_order", "skipped", "preset not found"))

    # Task 3.5.1: Token budget calculation using the model's context window.
    # ``token_budget = context_window - max_tokens - reserve``.
    # Falls back to ``effective_max_tokens`` when the model lookup fails or
    # the computed budget is non-positive (preserving legacy behavior).
    # P1-2 修复: 优先使用用户配置的 openai_max_context（对齐 ST 1.18.0），
    # 并把可配置的 history_reserve 传给 _apply_token_budget。
    _context_window_override = _get_openai_max_context_override(
        user_setting, req.model, req.char.id if req.char else None)
    token_budget = _compute_prompt_token_budget(
        req.model, effective_max_tokens, context_window_override=_context_window_override,
    )
    # Read chat_completion_source from the preset (Task 3.6.5) — used to
    # decide whether text Instruct wrapping should be applied. When the
    # source is a known chat completion API, the assembly skips the text
    # Instruct wrapping (messages are sent as role/content pairs, no
    # sequence prefix/suffix needed). NULL preserves the legacy behavior
    # (apply wrapping when instruct mode is enabled).
    chat_completion_source: Optional[str] = None
    if prompt_preset is not None:
        chat_completion_source = getattr(prompt_preset, "chat_completion_source", None) or None
    # P1-2 修复: history_reserve 从用户设置读取，不再硬编码 4096。
    _history_reserve_cfg = _get_history_reserve(user_setting)
    dynamic_context_parts, total_tokens_estimate = _apply_token_budget(
        dynamic_context_parts, system_prompt, token_budget, report,
        history_reserve=_history_reserve_cfg,
    )

    # ST 1.18.0 context template — load the template bound to the preset
    # (or fall back to "Default"). The Default template preserves existing
    # Palink prompt behavior (passthrough); other templates wrap the
    # assembled messages with their chat_start / system_prompt / jailbreak.
    context_template = _load_context_template(db, req.context_template_name)
    if context_template is not None:
        report.append(
            PromptAssemblyReportItem(
                "context_template",
                "included",
                detail=f"name={context_template.name}; builtin={bool(context_template.is_builtin)}",
            )
        )
    else:
        report.append(PromptAssemblyReportItem("context_template", "skipped", "not seeded"))

    # 群聊 recent messages budget：仅对群聊生效，单聊保持全局历史限制不变。
    # 从 GroupChat.recent_messages_budget 读取，None/<=0 时回退到全局限制。
    group_recent_budget: Optional[int] = None
    # D4 修复: 启用成员名列表，用于 {{group}} 宏替换（ST 1.18.0 openai.js:108）
    group_member_names: Optional[list[str]] = None
    if req.group_id:
        try:
            group_for_budget = _cached_request_group(req, req.group_id)
            if group_for_budget is not None:
                budget_val = getattr(group_for_budget, "recent_messages_budget", None)
                if isinstance(budget_val, int) and budget_val > 0:
                    group_recent_budget = budget_val
                    report.append(
                        PromptAssemblyReportItem(
                            "group_recent_messages_budget",
                            "applied",
                            detail=f"budget={budget_val}; group_id={req.group_id}",
                        )
                    )
                else:
                    report.append(
                        PromptAssemblyReportItem(
                            "group_recent_messages_budget",
                            "skipped",
                            detail="budget not set or <=0; fallback to global limit",
                        )
                    )
                # D4 修复: 收集启用（未禁用）成员名列表用于 {{group}} 宏替换
                _g_member_ids = _enabled_member_ids(group_for_budget)
                if _g_member_ids:
                    try:
                        _g_chars = (
                            db.query(Character)
                            .filter(Character.id.in_([str(mid) for mid in _g_member_ids]))
                            .all()
                        )
                        _g_names = [c.name for c in _g_chars if getattr(c, "name", None)]
                        if _g_names:
                            group_member_names = _g_names
                    except Exception as gme:
                        logger.warning("Failed to load group member names (group_id=%s): %s", req.group_id, gme)
        except Exception as exc:
            logger.warning("GroupChat recent_messages_budget lookup failed for group_id=%s: %s", req.group_id, exc)
            report.append(
                PromptAssemblyReportItem(
                    "group_recent_messages_budget",
                    "error",
                    detail=str(exc),
                )
            )

    # ST 1.18.0 extension_prompts IN_PROMPT(0): 追加到 system prompt（messages[0]）
    # 文本末尾，对齐 ST openai.js 的 position='end'（system prompt 末尾）语义。
    # 注意：[INJ-CLOSE-TAG-GUARD] 2026-08-19 修复——此前误实现为"append 独立消息
    # 到 messages 末尾"（prompt 最后一条 = system 注入），导致推理模型 100% 空响应，
    # 详见下方 IN_PROMPT 注入处的修复注释。
    # extension_prompts BEFORE_PROMPT(2): 一次性 prepend 到 system_prompt 之前
    # 多条目按原序拼接（"\n\n".join），避免逐条 prepend 导致逆序。
    if ext_before_prompt_entries:
        _ep_before_text = "\n\n".join(t for t, _ in ext_before_prompt_entries)
        system_prompt = _ep_before_text + "\n\n" + system_prompt

    # ══ [ASM-4 2026-10-24] 前部 ST 分立体系装配（VER-1 §7.2 裁定表施工图）════
    # 应然序列（ST openai.js:1203-1209 + :1256-1275 + :884-886）：
    #   worldInfoBefore → main → worldInfoAfter → charDescription →
    #   charPersonality → scenario（[D-5b 2026-10-25] 三槽已分立，见下）→
    #   相对扩展提示（记忆/实体卡/AN/IN_PROMPT 插件，各自独立消息）→
    #   newMainChat 历史区头 → 聊天历史。
    front_before_msgs: list[dict[str, Any]] = []
    front_after_msgs: list[dict[str, Any]] = []

    # D-1：世界书 before/after 前部两条（桶已各自变换完毕，每桶一条独立消息）。
    if wb_wi_before_parts:
        front_before_msgs.append({
            "role": "system",
            "content": "\n".join(wb_wi_before_parts),
            "_palink_prompt_id": PROMPT_ID_WORLD_INFO_BEFORE,
        })
    if wb_wi_after_parts:
        front_after_msgs.append({
            "role": "system",
            "content": "\n".join(wb_wi_after_parts),
            "_palink_prompt_id": PROMPT_ID_WORLD_INFO_AFTER,
        })

    # ══ [D-5b 2026-10-25] charDescription / charPersonality / scenario 三槽分立 ══
    # ST 应然顺序（openai.js:1203-1209 加列 + :1367-1371 生成）：
    #   worldInfoBefore → main → worldInfoAfter → charDescription
    #   → charPersonality → scenario → personaDescription → 相对扩展提示。
    # 文本由 core 层按槽产出（见 CharacterPromptSlots），这里只负责落位；
    # 合并点已不再内嵌三段，故不存在重复（验收判据②逐段字节对账）。
    # 空段跳过 = ST 语义（preparePromptsForChatCompletion 里空串不产生该消息）。
    # personaDescription 维持现状（无激活 persona 不出现，ASM-4 已确认为既有一致项）。
    if _char_slots is not None:
        for _slot_id, _slot_text in (
            (PROMPT_ID_CHAR_DESCRIPTION, _char_slots.char_description),
            (PROMPT_ID_CHAR_PERSONALITY, _char_slots.char_personality),
            (PROMPT_ID_SCENARIO, _char_slots.scenario),
        ):
            _slot_text = _slot_text or ""
            if not _slot_text.strip():
                report.append(PromptAssemblyReportItem(
                    _slot_id, "skipped",
                    detail="empty character card field (ST: no message produced)",
                ))
                continue
            front_after_msgs.append({
                "role": "system",
                "content": _slot_text,
                "_palink_prompt_id": _slot_id,
            })
            report.append(PromptAssemblyReportItem(
                _slot_id, "included",
                detail=f"independent system message (chars={len(_slot_text)})",
                tokens_estimate=_estimate_tokens(_slot_text),
            ))

    # D-2/D-3：记忆 + 实体卡（memory_front_parts 内相对序：实体卡在前）。
    # ST 官方记忆/向量扩展默认 IN_PROMPT=前部相对 main 独立消息
    # （memory/index.js:114、vectors/index.js:89-90），不再混尾部块。
    for _mem_part in memory_front_parts:
        if _mem_part:
            front_after_msgs.append({
                "role": "system",
                "content": _mem_part,
                "_palink_prompt_id": PROMPT_ID_MEMORY,
            })

    # NF-3：ANTop/ANBottom 并入作者注通道（ST world-info.js:5151-5152：
    # ANWithWI = ANTopEntries + '\n' + originalAN + '\n' + ANBottomEntries，
    # 整体替换 AN 扩展提示并按 AN 自身 position/depth 注入）。
    if wb_an_before_parts or wb_an_after_parts:
        _an_top_text = "\n".join(wb_an_before_parts)
        _an_bottom_text = "\n".join(wb_an_after_parts)
        if author_note_depth_entry is not None:
            # AN 已按 IN_CHAT 排队：合并进同一条（ST 的 ANWithWI 整体替换语义）。
            author_note_depth_entry.content = "\n".join([
                _an_top_text,
                author_note_depth_entry.content,
                _an_bottom_text,
            ]).strip("\n")
            report.append(PromptAssemblyReportItem(
                "author_note_worldinfo", "included",
                detail=(
                    f"ANTop/ANBottom merged into AN channel (top={len(wb_an_before_parts)},"
                    f"bottom={len(wb_an_after_parts)}; position=IN_CHAT depth={author_note_depth_entry.depth})"
                ),
                tokens_estimate=_estimate_tokens(_an_top_text) + _estimate_tokens(_an_bottom_text),
            ))
        else:
            # AN 文本缺席或 AN 走 system_prompt 拼接位（position 0/2）：WI-AN 条目
            # 单独成条，落位对齐 AN 自身的 ST 位置语义——pos 1/缺省=IN_CHAT 深度
            # 注入；pos 0=main 之后独立消息（injectToMain 'end'）；pos 2=main 之前
            # （'start'）；pos -1=NONE 不注入（尊重显式关闭）。AN 文本在 pos 0/2 下
            # 已字符串并入 system_prompt（既有行为，不在本批 8 项内），故 WI-AN
            # 条目无法与其拼成一条，落位相邻即可，残余差异已记录。
            _an_wi_text = "\n".join([_an_top_text, "", _an_bottom_text]).strip("\n")
            if author_note_position_int == 1:
                author_note_depth_entry = DepthInjection(
                    depth=author_note_depth,
                    content=_an_wi_text,
                    role=_ROLE_NAME_TO_INT["system"],
                    source="author_note",
                    sort_key=_KEY_AN_DEPTH,
                )
                report.append(PromptAssemblyReportItem(
                    "author_note_worldinfo", "included",
                    detail=(
                        f"ANTop/ANBottom → AN channel (author_note empty; "
                        f"IN_CHAT depth={author_note_depth})"
                    ),
                    tokens_estimate=_estimate_tokens(_an_wi_text),
                ))
            elif author_note_position_int == 0:
                front_after_msgs.append({"role": "system", "content": _an_wi_text})
                report.append(PromptAssemblyReportItem(
                    "author_note_worldinfo", "included",
                    detail="ANTop/ANBottom → independent message after main (AN position=IN_PROMPT)",
                    tokens_estimate=_estimate_tokens(_an_wi_text),
                ))
            elif author_note_position_int == 2:
                front_before_msgs.append({"role": "system", "content": _an_wi_text})
                report.append(PromptAssemblyReportItem(
                    "author_note_worldinfo", "included",
                    detail="ANTop/ANBottom → independent message before main (AN position=BEFORE_PROMPT)",
                    tokens_estimate=_estimate_tokens(_an_wi_text),
                ))
            else:
                report.append(PromptAssemblyReportItem(
                    "author_note_worldinfo", "skipped",
                    detail=f"AN position={author_note_position_int} (NONE/unknown) — WI-AN entries not injected",
                ))

    # D-12：IN_PROMPT(0) 插件条目改为 main 之后的**独立消息**（ST injectToMain
    # position='end' 是独立 prompt 项，openai.js:1256-1275/:1445），不再字符串级
    # append 进 main 全文末尾（VER-1 D-12 判例：+22 并入 M0）。空响应防护语义
    # 不变：注入落前部 main 之后，远离 prompt 末尾（2026-08-19 事故的触发位是
    # "messages 最末尾的 system"，前部落位与其无关）。
    for _ep_content, _ep_role in ext_in_prompt_entries:
        front_after_msgs.append({
            "role": _ep_role or "system",
            "content": _ep_content,
        })
        report.append(PromptAssemblyReportItem(
            "extension_prompt_in_prompt",
            "included",
            detail=f"independent message after main (IN_PROMPT; role={_ep_role})",
            tokens_estimate=_estimate_tokens(_ep_content),
        ))

    # D-7：newMainChat 历史区头（P-DEC-6 默认开）。开关走既有
    # silly_tavern_settings JSON 通道（extension_settings.palink_assembly 子键，
    # /api/settings/save 对 extension_settings 做 namespace 级增量合并，不会被
    # ST 前端整块覆盖擦掉），不加列不迁移。文案自写（ST 默认 new_chat_prompt
    # 的汉化等价表述，非英文原文照抄）。
    _asm_flags = _read_palink_assembly_flags(user_setting)
    _asm_is_zh = prompt_lang == "zh" or (
        prompt_lang == "auto"
        and deps.contains_chinese((req.char.name or "") + (req.char.description or ""))
    )
    new_main_chat_prompt: Optional[str] = None
    if _asm_flags.get("new_main_chat", True):
        new_main_chat_prompt = _new_main_chat_prompt_text(
            _asm_is_zh, bool(getattr(req, "group_id", None)),
        )
        report.append(PromptAssemblyReportItem(
            "new_main_chat", "included",
            detail="history header enabled (default on; extension_settings.palink_assembly.new_main_chat)",
            tokens_estimate=_estimate_tokens(new_main_chat_prompt),
        ))
    else:
        report.append(PromptAssemblyReportItem(
            "new_main_chat", "skipped",
            "disabled (extension_settings.palink_assembly.new_main_chat=false)",
        ))

    # E-1 修复: palink-native 消息组装（token 编码 + 历史加载）为纯同步重活，
    # 移入线程池避免阻塞事件循环（与 _append_worldbook_context 一致）。
    messages = await asyncio.to_thread(
        build_character_chat_messages,
        db=db,
        char=req.char,
        user_nickname=user_nickname,
        session_id=req.session_id,
        branch_id=req.branch_id,
        message=req.message,
        images=req.images or [],
        system_prompt=system_prompt,
        dynamic_context_parts=dynamic_context_parts,
        prompt_lang=prompt_lang,
        user_setting=user_setting,
        _replace_placeholders=deps.replace_placeholders,
        _get_full_branch_history=deps.get_full_branch_history,
        _contains_chinese=deps.contains_chinese,
        normalize_image_url=lambda img_url, check_size=False: normalize_image_url(
            img_url,
            check_size=check_size,
            user_id=req.user.id,
        ),
        include_user_message=(req.include_user_message and not req.smart_card_trigger and not req.is_continue),
        include_title_instruction=include_title_instruction,
        context_template=context_template,
        recent_messages_budget=group_recent_budget,
        speaker_char=speaker_char,  # D3 修复: 群聊 {{char}} 绑定发言者
        is_group=bool(getattr(req, "group_id", None)),
        user_name=req.user.username if req.user else "",  # D2 修复: 群历史名归属
        message_order=req.message_order,  # Task 7: generate_interceptor 消息重排
        excluded_message_ids=req.excluded_message_ids,  # P0-3: interceptor 消息排除
        # [ASM-4] 前部 ST 分立插槽 + D-7 历史区头
        front_before_main=front_before_msgs,
        front_after_main=front_after_msgs,
        new_main_chat_prompt=new_main_chat_prompt,
    )
    report.append(PromptAssemblyReportItem("message_builder", "included", detail=f"messages={len(messages)}"))

    # P1-1 修复: 当 prompt_preset.prompt_order 包含角色卡字段标识符
    # （charDescription/charPersonality/scenario）时，把这些字段抽取为独立
    # system 消息插入 messages 数组首位（紧跟 system_prompt 之后），使其可被
    # _apply_full_prompt_order 按 prompt_order 重排。
    # [D-5b 2026-10-25] 分槽通道在场时**整段跳过**：三段已经是带
    # _palink_prompt_id 的独立消息（本来就可被 prompt_order 重排），再抽一次
    # 就是第二份内容。P1-1 的代理消息机制本就是为"三段还在 main 里、无法重排"
    # 而设的补丁，main 不再内嵌三段后它失去存在条件。
    # （实测 prompt_presets 表 0 行 ⇒ 该分支当前生产不可达；仍按逻辑正确收口，
    #   不留"哪天有人建了预设就双份"的地雷。）
    _char_field_msgs = (
        [] if _char_slots is not None
        else _extract_char_field_messages_for_order(req, prompt_preset, _macro_char_name)
    )
    if _char_field_msgs:
        # 插入到第 0 条（system_prompt）之后；若 messages 为空则直接 append。
        _insert_at = 1 if messages and messages[0].get("role") == "system" else 0
        for _off, _cmsg in enumerate(_char_field_msgs):
            messages.insert(_insert_at + _off, _cmsg)
        report.append(
            PromptAssemblyReportItem(
                "char_field_split_for_order",
                "included",
                detail=f"split_fields={len(_char_field_msgs)}; preset={prompt_preset.name if prompt_preset else 'n/a'}",
                tokens_estimate=sum(_estimate_tokens(m.get("content", "")) for m in _char_field_msgs),
            )
        )

    # Append author_note depth entry (queued for in-story / position_int == 0)
    # to depth_entries so _insert_depth_prompt inserts it at the configured depth.
    if author_note_depth_entry is not None:
        depth_entries.append(author_note_depth_entry)
    # Append persona description depth entry (position=0 / in-story) so it is
    # inserted at depth=4 alongside other depth entries.
    if persona_depth_entry is not None:
        depth_entries.append(persona_depth_entry)
    # Append Palink /inject depth entries (position=0 / in-story) so they are
    # inserted at their configured depth alongside other depth entries.
    if palink_injection_depth_entries:
        depth_entries.extend(palink_injection_depth_entries)
    # ST 对齐: 插件 extension_prompts IN_CHAT(1) 并入统一队列 —— ST 中所有动态源
    # （AN/世界书 atDepth/角色深度提示词/插件）都汇入同一扩展注册表按 key 字母序合并，
    # 不存在独立第二管线。
    if ext_depth_entries:
        depth_entries.extend(ext_depth_entries)

    messages = _insert_depth_prompt(messages, req, deps, depth_entries, report)

    # ── ST 1.18.0 extension_prompts IN_CHAT 旧追加分支（保留兼容） ───
    # 任务 4.2 后 IN_CHAT(1) 改走 ext_depth_entries（按 depth 插入），
    # ext_chat_messages 不再被填充（除非未来有新逻辑），此处自然不会执行。
    # 保留以避免引用错误。
    for ext_msg in ext_chat_messages:
        messages.append({"role": ext_msg.get("role", "system"), "content": ext_msg.get("content", "")})
        report.append(
            PromptAssemblyReportItem(
                "extension_prompt_in_chat",
                "included",
                detail=f"role={ext_msg.get('role', 'system')}",
                tokens_estimate=_estimate_tokens(ext_msg.get("content", "")),
            )
        )

    # ── ST 1.18.0 extension_prompts IN_PROMPT(0) ──
    # [ASM-4 2026-10-24] D-12 改制：IN_PROMPT 条目已在前部装配段改为 main 之后的
    # **独立消息**（经 build_character_chat_messages 的 front_after_main 插槽落位），
    # 此处旧的"字符串级 append 进 messages[0]"实现删除。
    # 历史背景保留（空响应防护的成因证据）：2026-08-19 此前实现是"作为独立消息
    # append 到 messages 末尾"，把 system 注入放到 prompt 最后一条（紧贴模型续写
    # 位置）。前端插件（对话渲染系统 v7.1）经 setExtensionPrompt(position=0) 注入
    # 格式规则即走此路径，实测 deepseek-v4-flash 100% 空响应（立刻 EOS
    # completion_tokens=1，或把剧情正文写进 reasoning 不写 content）。当时的修复是
    # 追加到 system prompt 末尾；本批按 ST injectToMain 'end' 语义进一步落位为
    # main 之后的独立消息——仍在 prompt 前部、远离末尾续写位，防护语义不变。
    # Persona description position=2 (last in chat): append as the final
    # system message after depth insertion so it is the last chat entry.
    if persona_last_message is not None:
        messages.append({"role": "system", "content": persona_last_message})

    # Palink /inject (before author note): append as system messages at the
    # end of chat. (ST alignment removed the old "last in chat" author-note
    # position; these injected messages now simply trail the chat history.)
    for _palink_inj_text in palink_injection_before_author_note:
        messages.append({"role": "system", "content": _palink_inj_text})

    if req.include_prompt_regex and messages:
        # [S-1s 2026-10-25] 报告项此前**从不传 tokens_estimate** ⇒ 这一行恒 tok=0，
        # 审计 S-1 就从"0 token"推出"卡内正则一条都没生效"，而实测该轮 6 条卡内
        # 正则里 2 条真实命中、13 条消息 21 处替换（见 REPORT_ASM1 §1）。
        # 补两个读数，各管一件事：
        #   · changed_messages —— "有没有动过"。token 估算器是量化的，
        #     改 1 个字符的净 token 就是 0；只有命中计数才能把"改了但没改变
        #     token 量"与"一个字都没动"区分开（这才是"恒 0 误导审计"的真解）。
        #   · tokens_estimate  —— "动了多少"，取净变化的绝对值。格式类正则常是
        #     净删（剥标签），负数塞进这一列会让读报表的人以为出异常，
        #     净增/净删由 detail 里带符号的 net_tokens 说明。
        _pr_texts_before = [_message_content_to_text(m.get("content")) for m in messages]
        _pr_before_chars = sum(len(t) for t in _pr_texts_before)
        _pr_before_tokens = sum(_estimate_tokens(t) for t in _pr_texts_before)
        messages = deps.apply_prompt_regex_to_messages(messages, db, req.char, user_nickname, user_id=req.user.id if req.user else None)
        _pr_texts_after = [_message_content_to_text(m.get("content")) for m in messages]
        _pr_after_chars = sum(len(t) for t in _pr_texts_after)
        _pr_after_tokens = sum(_estimate_tokens(t) for t in _pr_texts_after)
        _pr_changed = sum(
            1 for a, b in zip(_pr_texts_before, _pr_texts_after) if a != b
        )
        _pr_net = _pr_after_tokens - _pr_before_tokens
        report.append(PromptAssemblyReportItem(
            "prompt_regex",
            "included",
            detail=(
                f"changed_messages={_pr_changed};"
                f" chars={_pr_before_chars}->{_pr_after_chars};"
                f" net_tokens={_pr_net:+d}; touched_tokens={abs(_pr_net)}"
            ),
            tokens_estimate=abs(_pr_net),
        ))
    else:
        report.append(PromptAssemblyReportItem("prompt_regex", "skipped"))

    # ── 状态栏指令已整体移除（2026-08-18）──
    # Palink 原生 <status> 状态栏指令注入（含 user tail / system prompt / 探测保存）
    # 已全部删除：与 MVU 卡的 <UpdateVariable> 指令冲突，导致 AI 输出 <status>
    # 而 MVU 引擎不认 → stat_data 永不更新。保留 status_bar_detector 的剥离函数
    # （strip_and_parse_status_marker）仅作历史残留标签清理，不再注入任何指令。

    # ── MVU 变量更新指令（user tail 注入，2026-08-18；2026-10-05 改为让位卡片声明）──
    # 保留原判断：MVU 卡的"变量输出格式"若只落在 worldbook 拼接消息的中间偏后
    # （实测：13KB 消息 @8813，其后还有 ~4.7KB 场景描述），模型注意力常覆盖不到
    # → 不输出 <UpdateVariable> → stat_data 永不更新。尾部提醒这一**方向**是对的。
    # 但原来那份模板写死了另一张卡的示例路径与字段名，模型会照它自创结构，把卡片
    # 自己声明的结构覆盖掉（成因与本批 commit message 及报告所述，含 `entry.depth or 4`
    # 让卡片 depth=0 说明落不到位的路由 bug）。故改为：卡片已声明（且真的进了提示词）
    # 就什么都不加，对齐 ST；只有没声明时才贴不含字段名的通用兜底。
    try:
        from ..services.status_bar_detector import _card_has_mvu_scripts
        if not _card_has_mvu_scripts(req.char):
            report.append(PromptAssemblyReportItem("mvu_user_tail", "skipped", "not an MVU card"))
        elif _messages_declare_mvu_update_spec(messages):
            report.append(PromptAssemblyReportItem(
                "mvu_user_tail", "skipped", "card declares update spec in prompt",
            ))
        else:
            _mvu_instr = _MVU_GENERIC_TAIL
            for _m in reversed(messages):
                if _m.get("role") == "user":
                    if isinstance(_m.get("content"), str):
                        _m["content"] = _m["content"].rstrip() + _mvu_instr
                    elif isinstance(_m.get("content"), list):
                        for _b in reversed(_m["content"]):
                            if isinstance(_b, dict) and _b.get("type") == "text":
                                _b["text"] = _b.get("text", "").rstrip() + _mvu_instr
                                break
                    break
            report.append(PromptAssemblyReportItem("mvu_user_tail", "included", tokens_estimate=_estimate_tokens(_mvu_instr)))
    except Exception as _mvu_e:
        logger.warning("mvu user tail injection failed: %s", _mvu_e)

    # Macro evaluation (Phase 3) — Task 1.12 角色卡宏补全
    #
    # 这里对 assembled messages 与 system_prompt 做一次最终的宏替换遍历，
    # 覆盖 ST 1.18.0 角色卡核心宏：
    #   {{char}}         → req.char.name（角色名）
    #   {{user}}         → user_nickname（用户名/Persona 名）
    #   {{description}}  → req.char.description（角色描述）
    #   {{persona}}      → 当前活跃 Persona 的描述（从 UserSetting.active_persona_id 查询）
    #   {{mesExamples}}  → req.char.mes_example（角色对话示例，原始字段）
    #   {{scenario}}     → req.char.scenario（角色场景）
    #   {{first_mes}}    → req.char.first_mes（角色首条消息）
    #   {{personality}}  → req.char.personality（角色性格）
    #
    # 宏替换生效位置（对应 Task 1.12 SubTask 1.12.2）：
    #   1. prompt 组装：system_prompt 与 messages 全部经过 evaluate_macros*
    #      处理（见下方两行调用）。包括 author_note、persona 注入、
    #      palink /inject 注入、depth_prompt、instruct 包装前的内容。
    #   2. worldbook 扫描：worldbook 文本（wb_result.text）在
    #      _append_worldbook_context 中先经 deps.replace_placeholders
    #      处理 {{user}}/{{char}}，然后作为 system message 一部分加入
    #      dynamic_context_parts → messages，最终被这里的
    #      evaluate_macros_in_messages 二次遍历，覆盖 {{description}}、
    #      {{persona}}、{{mesExamples}}、{{scenario}}、{{first_mes}} 等
    #      角色卡宏（这些宏不被 _replace_placeholders 剥离）。
    #   3. message 示例展开：{{mesExamples}} 在被解析后返回
    #      req.char.mes_example 原始字段（ST 1.18.0 行为对齐），其内部的
    #      <START> 分隔与 {{user}}/{{char}} 占位符也会在本次遍历中被递归
    #      替换（evaluate_macros 最多迭代 10 次直至稳定）。
    #
    # MacroEnv 携带 character 与 user_setting，使 _resolve_simple_macro
    # 能访问角色字段与活跃 Persona（见 macro_service.py Fix-12 实现）。

    # Phase C3 修复: 为 ST 1.18.0 缺失宏填充上下文 (macros.js:649-657, 721-739)
    # 查询最后一条消息以获取 id/swipe_id/timestamp，供以下宏使用:
    #   {{lastMessageId}} {{lastSwipeId}} {{currentSwipeId}} {{idle_duration}}
    #   {{firstIncludedMessageId}} {{firstDisplayedMessageId}} {{lastGenerationType}}
    #   {{pick}} 确定性种子（chat_id_hash）
    _macro_last_msg_id: Optional[int] = None
    _macro_last_msg_time: Optional[Any] = None
    _macro_last_swipe_id: Optional[int] = None
    _macro_current_swipe_id: Optional[int] = None
    _macro_first_included_id: Optional[int] = None
    _macro_first_included_content: Optional[str] = None
    _macro_first_displayed_id: Optional[int] = None
    try:
        _last_db_msg = (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == req.session_id)
            .order_by(CharacterChatMessage.created_at.desc())
            .first()
        )
        if _last_db_msg is not None:
            _macro_last_msg_id = getattr(_last_db_msg, "id", None)
            _macro_last_msg_time = getattr(_last_db_msg, "created_at", None)
            _macro_last_swipe_id = getattr(_last_db_msg, "swipe_id", None)
            # currentSwipeId: ST 返回最后一条消息的 swipe_id（当前选中的 swipe 索引）
            _macro_current_swipe_id = _macro_last_swipe_id
            # 解析 swipes 数组以获取 lastSwipeId（swipes 数量 - 1）
            _swipes_raw = getattr(_last_db_msg, "swipes", None)
            if _swipes_raw:
                try:
                    _swipes_list = json.loads(_swipes_raw) if isinstance(_swipes_raw, str) else _swipes_raw
                    if isinstance(_swipes_list, list) and _swipes_list:
                        _macro_last_swipe_id = len(_swipes_list) - 1
                except (json.JSONDecodeError, TypeError):
                    pass
        # firstDisplayedMessageId: 第一条消息的 id（ST chat[0].id）
        _first_db_msg = (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == req.session_id)
            .order_by(CharacterChatMessage.created_at.asc())
            .first()
        )
        if _first_db_msg is not None:
            _macro_first_displayed_id = getattr(_first_db_msg, "id", None)
            # {{firstIncludedMessage}} 内容形态（ST 语义：chat[firstIncludedMessageId].mes）
            _macro_first_included_content = getattr(_first_db_msg, "content", None) or None
        # firstIncludedMessageId: 实际纳入 prompt 的第一条消息 id
        # 简化: 与 firstDisplayedMessageId 一致（精确值需要跟踪裁剪后的首条消息）
        _macro_first_included_id = _macro_first_displayed_id
    except Exception as _e:
        logger.debug("Macro context extraction failed: %s", _e)

    # chat_id_hash: ST getStringHash(chatId)，用于 {{pick}} 确定性种子
    # 优先从 chat_metadata 读取缓存值，否则用 session_id 计算
    _macro_chat_id_hash: Optional[int] = None
    try:
        _ps = locals().get("palink_session")
        _cm_raw = getattr(_ps, "chat_metadata", None) if _ps is not None else None
        if _cm_raw:
            _cm = json.loads(_cm_raw) if isinstance(_cm_raw, str) else _cm_raw
            if isinstance(_cm, dict) and _cm.get("chat_id_hash") is not None:
                _macro_chat_id_hash = int(_cm["chat_id_hash"])
        if _macro_chat_id_hash is None:
            from .st_seedrandom import st_get_string_hash
            _macro_chat_id_hash = st_get_string_hash(req.session_id)
    except Exception:
        from .st_seedrandom import st_get_string_hash
        _macro_chat_id_hash = st_get_string_hash(req.session_id)

    # story_string_prefix/suffix: 从 context_template.story_string 解析
    # ST 在 text completion 模式下用 story_string 模板组装 system prompt，
    # {{storyStringPrefix}}/{{storyStringSuffix}} 返回模板中占位符前后的文本。
    # 低优先级宏，当前返回空串（chat completion 模式不使用 story_string）。
    _macro_story_prefix = ""
    _macro_story_suffix = ""

    macro_env = MacroEnv(
        db=db,
        session_id=req.session_id,
        user_id=req.user.id,
        user_name=user_nickname,
        char_name=_macro_char_name,
        input_text=req.message or "",
        character=req.char,
        user_setting=user_setting,
        worldbook_em_top=wb_em_top_entries,
        worldbook_em_bottom=wb_em_bottom_entries,
        worldbook_outlets=wb_outlet_entries,
        # ST 1.18.0 聊天上下文宏支持
        chat_messages=messages,
        last_message_id=_macro_last_msg_id,
        last_message_time=_macro_last_msg_time,
        # ST 1.18.0 token 限制宏支持
        max_prompt_tokens=token_budget,
        max_context_tokens=token_budget + effective_max_tokens,
        max_response_tokens=effective_max_tokens,
        # Phase C3 修复: ST 1.18.0 缺失宏上下文 (macros.js:649-657, 721-739)
        chat_id_hash=_macro_chat_id_hash,
        first_included_message_id=_macro_first_included_id,
        first_included_message=_macro_first_included_content,
        first_displayed_message_id=_macro_first_displayed_id,
        last_swipe_id=_macro_last_swipe_id,
        current_swipe_id=_macro_current_swipe_id,
        last_generation_type=(getattr(req, "generation_type", None) or "normal"),
        banned_tokens=[],  # 收集 {{banned "word"}} 副作用
        story_string_prefix=_macro_story_prefix,
        story_string_suffix=_macro_story_suffix,
    )
    messages = evaluate_macros_in_messages(messages, macro_env)
    system_prompt = evaluate_macros(system_prompt, macro_env)
    report.append(PromptAssemblyReportItem("macro_evaluation", "included"))

    # ── Task 3.5.2 + 3.5.3 + 3.5.4: Prompt collection, full prompt_order,
    # and dynamic trimming ──────────────────────────────────────────────
    # After all messages are assembled (including depth inserts, author
    # notes, extension prompts, status bar tail, and macro evaluation), we
    # collect prompt sources, optionally reorder by the preset's
    # prompt_order, and dynamically trim low-priority sources when the
    # total token count exceeds the budget. This aligns with ST 1.18.0's
    # Prompt Manager behavior where the full prompt collection is ordered
    # and budgeted as a single unit.
    prompt_sources = _collect_prompt_sources(messages, req.char)
    # Task 3.5.2: apply full prompt_order reordering when a preset with
    # prompt_order is bound. This reorders the actual messages array (not
    # just dynamic_context_parts) by their ST 1.18.0 prompt identifier.
    if prompt_preset is not None:
        messages, prompt_sources = _apply_full_prompt_order(
            messages, prompt_sources, prompt_preset, report
        )
    # Task 3.5.3: dynamically trim low-priority sources when over budget.
    # Uses the token budget computed from the model's context window
    # (Task 3.5.1). Non-trimmable sources (system_prompt, recent messages,
    # user message) are always retained.
    messages, total_tokens_estimate = _apply_dynamic_trimming(
        messages, prompt_sources, token_budget, report
    )

    # ST 1.18.0 instruct mode — wrap the assembled messages with the bound
    # InstructTemplate's prefix/suffix sequences. Applied after macro
    # evaluation so the template control sequences (e.g. [INST], <|im_start|>)
    # are not treated as macros. When instruct mode is disabled the message
    # structure is left untouched (existing behavior preserved).
    #
    # Task 3.6.5: OpenAI Chat Completion mode does NOT apply text Instruct
    # wrapping. When ``chat_completion_source`` is set to a known chat
    # completion API (openai/claude/openrouter/etc.), the messages are sent
    # as role/content pairs without text sequence wrapping — only the
    # instruct template's ``system_prompt`` is injected as a system message.
    # When ``chat_completion_source`` is None (unset) or a text-completion
    # source, the full text Instruct wrapping is applied (legacy behavior).
    instruct_template = _load_instruct_template(db, user_setting, cache=req._cache)
    stop_sequences: list[str] = []
    if instruct_template is not None:
        # Inject the instruct template's system_prompt as a system-level
        # instruction. If the first message is already a system message, the
        # system_prompt is prepended to its content; otherwise a new system
        # message is inserted at position 0 (matching ST 1.18.0 behavior).
        # [ASM-4] 前部插槽在场时 messages[0] 是 worldInfoBefore 而非 main——
        # 按 builder 打的 "main" 标记定位，缺席时回退 messages[0]（旧行为）。
        sys_prompt = (instruct_template.system_prompt or "").strip()
        if sys_prompt:
            _main_insert_idx: Optional[int] = None
            for _mi, _mm in enumerate(messages):
                if _mm.get("_palink_prompt_id") == PROMPT_ID_SYSTEM_PROMPT:
                    _main_insert_idx = _mi
                    break
            if _main_insert_idx is None and messages and messages[0].get("role") == "system":
                _main_insert_idx = 0
            if _main_insert_idx is not None:
                existing = messages[_main_insert_idx].get("content", "")
                if isinstance(existing, str):
                    messages[_main_insert_idx] = {**messages[_main_insert_idx], "content": f"{sys_prompt}\n\n{existing}"}
                else:
                    messages.insert(_main_insert_idx, {"role": "system", "content": sys_prompt})
            else:
                messages.insert(0, {"role": "system", "content": sys_prompt})

        # Task 3.6.5: determine whether to apply text Instruct wrapping.
        # Chat completion APIs (openai/claude/openrouter/etc.) use role-based
        # message separation and do not need text sequence wrapping. Text
        # completion APIs (koboldai/text-generation-webui/etc.) require the
        # wrapping to flatten messages into a single text prompt.
        apply_text_wrapping = _should_apply_instruct_wrapping(chat_completion_source)
        if apply_text_wrapping:
            messages = _apply_instruct_formatting(
                messages,
                instruct_template,
                is_group_chat=bool(req.group_id),
                user_name=user_nickname,
                char_name=_macro_char_name,
            )
            report.append(
                PromptAssemblyReportItem(
                    "instruct_mode",
                    "included",
                    detail=(
                        f"template={instruct_template.name}; "
                        f"stop_sequence={'yes' if instruct_template.stop_sequence else 'no'}; "
                        f"wrap_sequences={bool(instruct_template.wrap_sequences)}; "
                        f"skip_examples={bool(getattr(instruct_template, 'skip_examples', False))}; "
                        f"names_behavior={getattr(instruct_template, 'names_behavior', 'force')}; "
                        f"chat_completion_source={chat_completion_source or 'unset'}"
                    ),
                )
            )
        else:
            # Chat completion mode: skip text Instruct wrapping but still
            # expose the stop_sequence (ST 1.18.0 behavior for chat APIs).
            report.append(
                PromptAssemblyReportItem(
                    "instruct_mode",
                    "included",
                    detail=(
                        f"template={instruct_template.name}; "
                        f"text_wrapping=skipped (chat_completion_source={chat_completion_source}); "
                        f"system_prompt_injected=yes"
                    ),
                )
            )

        # Stop sequences: add the instruct template's stop_sequence.
        if instruct_template.stop_sequence:
            stop_sequences.append(instruct_template.stop_sequence)
        # ST 1.18.0 sequences_as_stop_strings: when True, non-empty instruct
        # sequences are added to the stop strings. This is only relevant for
        # text completion mode (chat completion APIs handle stop sequences
        # via the API's stop parameter, not via content embedding).
        if apply_text_wrapping and bool(getattr(instruct_template, "sequences_as_stop_strings", True)):
            for seq in (
                instruct_template.input_suffix,
                instruct_template.output_suffix,
                getattr(instruct_template, "system_suffix", None) or instruct_template.system_sequence_suffix,
            ):
                seq_str = (seq or "").strip()
                if seq_str and seq_str not in stop_sequences:
                    stop_sequences.append(seq_str)
    else:
        report.append(PromptAssemblyReportItem("instruct_mode", "skipped"))

    # [PRIVATE-KEY-STRIP 2026-10-05] 装配内部私有标记键必须在离开装配层前剥掉。
    # _classify_message_identifier / _collect_prompt_sources 靠这些键做裁剪分类
    # （_palink_in_chat_injection / _palink_prompt_id / _palink_char_field_proxy），
    # 但装配结果会原样交给推理 API —— OpenAI 兼容端对 message 对象的未知字段
    # 不保证容忍（严格实现直接 400）。分类与裁剪均已在本行之前完成，剥离无副作用；
    # 全仓仅本文件读这些键（已 grep 确认），下游无消费者。
    for _pm in messages:
        if isinstance(_pm, dict):
            for _pk in [k for k in _pm if isinstance(k, str) and k.startswith("_palink_")]:
                _pm.pop(_pk, None)

    return PromptAssemblyResult(
        messages=messages,
        system_prompt=system_prompt,
        dynamic_context_parts=dynamic_context_parts,
        effective_max_tokens=effective_max_tokens,
        memory_mode=memory_mode,
        prompt_language=prompt_lang,
        report=report,
        total_tokens_estimate=total_tokens_estimate,
        token_budget=token_budget,
        stop_sequences=stop_sequences,
        ext_prompts_evidence=_ext_evidence,
    )


def _append_worldbook_context(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
    dynamic_context_parts: list[str],
    depth_entries: list[DepthInjection],  # ST 对齐统一队列（atDepth 条目包装为 DepthInjection）
    report: list[PromptAssemblyReportItem],
    em_top_entries: Optional[list[str]] = None,
    em_bottom_entries: Optional[list[str]] = None,
    outlet_entries: Optional[dict[str, list[str]]] = None,
    char_name: str = "",  # 角色名（用于正则宏替换）
    # A5 修复: 真实模型上下文上限（世界书百分比预算基数；None 时服务内回退 16000 兜底）
    max_context_tokens: Optional[int] = None,
    # D 批修复: 群聊上下文入参（此前分支内引用主装配局部变量 _g_mode/group_wi_strategy
    # 与裸 db，均不在本函数作用域 → 群聊请求必 NameError 被外层 except 吞掉，
    # 群聊世界书注入整体失效）。缺省时按 req.group_id 现场解析兜底。
    group_chat: Optional["GroupChat"] = None,
    group_wi_strategy: str = "one",
    # [ASM-4 2026-10-24] D-1+NF-3 拆桶出参（VER-1 §7.2 / VER1b 主脑裁定）。
    # 四个列表任一传入（非 None）即进入拆桶模式：position 0/1（before/after）与
    # position 2/3（ANTop/ANBottom）不再并入 [World Lore] 尾块，各自变换后写入
    # 对应桶——对齐 ST world-info.js:5094-5152（before/after 前部两桶夹 main、
    # ANTop/ANBottom 并入作者注扩展提示）。全部缺省（None）= 旧合并行为，
    # 直接调用方（群聊修复组等既有测试）零改动。
    wi_before_parts: Optional[list[str]] = None,
    wi_after_parts: Optional[list[str]] = None,
    an_before_parts: Optional[list[str]] = None,
    an_after_parts: Optional[list[str]] = None,
) -> None:
    """注入世界书上下文到 prompt 中。

    ST 1.18.0 对齐: 把 wb_result 的 8 个 position 全部传出去:
    - position 0/1 → wi_before_parts / wi_after_parts（拆桶模式）或
      dynamic_context_parts（旧合并模式，与其他 position 一同进 [World Lore] 尾块）
    - position 2/3（ANTop/ANBottom）→ an_before_parts / an_after_parts（拆桶模式，
      由装配层并入作者注通道）或旧合并模式尾块
    - position 4 (atDepth) → depth_entries
    - position 5 (EMTop) → em_top_entries (经 {{mesExamples}} 宏注入)
    - position 6 (EMBottom) → em_bottom_entries (经 {{mesExamples}} 宏注入)
    - position 7 (outlet) → outlet_entries (经 {{outlet::name}} 宏注入)

    参考: SillyTavern-1.18.0/public/scripts/world-info.js:5093-5143
    """
    user_nickname = req.user_nickname or req.user.username or "User"
    nested = None
    try:
        nested = req.db.begin_nested()

        # Bug #2 修复: 查询用户 active persona description，传给 worldbook
        # 用于 match_persona_description 关键词匹配（ST 1.18.0 world-info.js:299-301）
        persona_desc_text: Optional[str] = None
        # Phase E: 读取 ST 1.18.0 MIN_ACTIVATIONS 全局设置
        # (world_info_min_activations / world_info_min_activations_depth_max)
        # 存储于 silly_tavern_settings["world_info_settings"]，默认 0=关闭
        wi_min_activations = 0
        wi_min_activations_depth_max = 0
        # Phase G: ST 1.18.0 world_info_character_strategy 默认 character_first(1)
        wi_char_strategy = 1
        # A4 修复: ST world_info_depth 默认对齐 ST=2。
        # C2 修复（批次 C）: world_info_recursive 默认 false（world-info.js:75，
        # 原 true 为误记）；存量用户显式配置过的值原样生效。
        wi_world_info_depth = 2
        wi_recursive = False
        # V-3 (2026-08-25): 世界书向量检索总开关，默认 false 存量零突变
        wi_vectorized_enabled = False
        # C1 修复（批次 C）: ST world_info_budget 默认 25（%语义，world-info.js:73）、
        # world_info_budget_cap 默认 0=不钳制（world-info.js:81）。
        # 书级 budget_tokens/budget_cap 优先，此处作全局兜底。
        wi_budget: Optional[float] = 25.0
        wi_budget_cap = 0
        # C3 修复（批次 C）: ST world_info_include_names 默认 true（world-info.js:74）
        wi_include_names = True
        # C5 修复（批次 C）: ST world_info_case_sensitive / world_info_match_whole_words
        # 默认 false（world-info.js:77-78）；条目级 NULL 继承此全局值
        wi_case_sensitive = False
        wi_match_whole_words = False
        try:
            us = req.db.query(UserSetting).filter(UserSetting.user_id == req.user.id).first()
            if us:
                if us.active_persona_id:
                    ap = req.db.query(Persona).filter(
                        Persona.id == us.active_persona_id,
                        Persona.user_id == req.user.id,
                    ).first()
                    if ap and ap.description:
                        persona_desc_text = ap.description
                # Phase E: 从 silly_tavern_settings 读取 WI MIN_ACTIVATIONS 设置
                if us.silly_tavern_settings:
                    try:
                        _st_raw = json.loads(us.silly_tavern_settings) if isinstance(us.silly_tavern_settings, str) else us.silly_tavern_settings
                        if isinstance(_st_raw, dict):
                            _wis = _st_raw.get("world_info_settings", {})
                            if isinstance(_wis, dict):
                                wi_min_activations = int(_wis.get("world_info_min_activations", 0) or 0)
                                wi_min_activations_depth_max = int(_wis.get("world_info_min_activations_depth_max", 0) or 0)
                                # Phase G: ST 1.18.0 world_info_character_strategy
                                # (world-info.js:4496) 默认 1=character_first
                                wi_char_strategy = int(_wis.get("world_info_character_strategy", 1) or 1)
                                # A4 修复: world_info_depth（ST 默认 2）
                                # C2 修复（批次 C）: recursive 总开关默认 false（world-info.js:75）
                                wi_world_info_depth = int(_wis.get("world_info_depth", 2) or 2)
                                wi_recursive = bool(_wis.get("world_info_recursive", False))
                                # V-3 (2026-08-25): vectorized 检索总开关（默认 false，
                                # 用户显式开启才生效；top_k/threshold 由 env 覆盖）
                                wi_vectorized_enabled = bool(_wis.get("vectorized_enabled", False))
                                # C1 修复（批次 C）: 全局百分比预算 + cap（书级值优先，此处兜底）
                                try:
                                    wi_budget = float(_wis.get("world_info_budget", 25))
                                except (TypeError, ValueError):
                                    wi_budget = 25.0
                                wi_budget_cap = int(_wis.get("world_info_budget_cap", 0) or 0)
                                # C3 修复（批次 C）: include_names（"name: content" 拼接）
                                wi_include_names = bool(_wis.get("world_info_include_names", True))
                                # C5 修复（批次 C）: 全局大小写敏感 / 全词匹配（entry NULL 继承）
                                wi_case_sensitive = bool(_wis.get("world_info_case_sensitive", False))
                                wi_match_whole_words = bool(_wis.get("world_info_match_whole_words", False))
                    except (json.JSONDecodeError, TypeError, ValueError):
                        pass
        except Exception as exc:
            logger.warning("Active persona description lookup for worldbook failed: %s", exc)

        # Phase E: min_activations>0 时需加载更多聊天消息供 advanceScan 扩展扫描深度
        # ST: buffer.advanceScan() 递增 getDepth()，让条目看到更多聊天历史
        # 默认加载 8 条；min_activations>0 时按 depth_max 扩展（depth_max=0 时回退 100 条上限）
        _wb_msg_limit = 8
        if wi_min_activations > 0:
            if wi_min_activations_depth_max > 0:
                _wb_msg_limit = wi_min_activations_depth_max + 8
            else:
                _wb_msg_limit = 100  # depth_max=0 时 ST 回退 chat.length，此处用 100 作合理上限
        recent_for_wb = (
            req.db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == req.session_id)
            .filter(CharacterChatMessage.is_hidden == False)
            .order_by(CharacterChatMessage.created_at.desc())
            .limit(_wb_msg_limit)
            .all()[::-1]
        )
        # C3 修复（批次 C）: 消息 dict 携带 name 字段（ST script.js:4565
        # include_names 时 "name: content" 拼接的数据来源；m.name 为 ST 对齐
        # 写入路径落库的发言人名，缺失时为空串 → haystack 退化为纯 content）
        recent_msgs = [
            {"role": m.role, "content": m.content, "name": m.name or ""}
            for m in recent_for_wb
        ]
        if req.is_init:
            recent_msgs = [{"role": "user", "content": req.message or "", "name": user_nickname or ""}]
        elif req.message and not req.smart_card_trigger and not req.is_continue:
            recent_msgs.append({"role": "user", "content": req.message, "name": user_nickname or ""})

        # D-1 修复（2026-08-23）: 世界书 delay 的 ST chat.length 绝对语义
        # （world-info.js:665-676）需要真实聊天消息总数——recent_for_wb 是截断
        # 窗口不能充当。计数口径对齐 ST chat 数组（含 hidden，不含未落库的本轮
        # 新消息；is_init 时为 1）。COUNT 查询失败时回退窗口长度。
        try:
            from sqlalchemy import func as _sa_func

            _wb_persisted_count = (
                req.db.query(_sa_func.count(CharacterChatMessage.id))
                .filter(CharacterChatMessage.session_id == req.session_id)
                .scalar()
            ) or 0
        except Exception as exc:
            logger.warning("worldbook chat_length count failed: %s", exc)
            _wb_persisted_count = len(recent_for_wb)
        if req.is_init:
            _wb_chat_length = 1
        elif req.message and not req.smart_card_trigger and not req.is_continue:
            _wb_chat_length = _wb_persisted_count + 1
        else:
            _wb_chat_length = max(_wb_persisted_count, len(recent_msgs))

        # E1 修复: 群聊 per-member 世界书（strategy=all/group 时，将启用成员字段并入 WI haystack）
        # D 批修复: 群对象与策略改由入参传入（调用方=主装配已求值），db 用 req.db；
        # 入参缺省且 req.group_id 在场时现场解析，保证直接调用本函数的路径同样可用。
        _wb_group_chat = group_chat
        if _wb_group_chat is None and req.group_id:
            try:
                _wb_group_chat = _cached_request_group(req, req.group_id)
            except Exception as gc_err:
                logger.warning(
                    "Failed to resolve group chat for worldbook (group_id=%s): %s",
                    req.group_id, gc_err,
                )
                _wb_group_chat = None
        group_chars_arg = None
        if req.group_id and _wb_group_chat is not None and group_wi_strategy in ("all", "group"):
            try:
                _enabled = _load_members(req.db, _wb_group_chat)
                # 排除主角色 req.char（其字段已由单 char haystack 覆盖），避免重复计入
                _main_id = str(req.char.id) if getattr(req.char, "id", None) else None
                group_chars_arg = [c for c in _enabled if str(c.id) != _main_id]
            except Exception as gcc_err:
                logger.warning("Failed to load group_chars for worldbook (group_id=%s): %s", req.group_id, gcc_err)
        wb_result = build_worldbook_context(
            db=req.db,
            session_id=req.session_id,
            user_id=req.user.id,
            recent_messages=recent_msgs,
            character=req.char,
            persona_description=persona_desc_text,
            group_chars=group_chars_arg,
            # Phase E: 透传 MIN_ACTIVATIONS 状态机参数
            min_activations=wi_min_activations,
            min_activations_depth_max=wi_min_activations_depth_max,
            # Phase G: 透传 world_info_character_strategy 插入排序策略
            world_info_character_strategy=wi_char_strategy,
            # D-1 修复: delay 的 chat_length 绝对判定需要真实消息总数
            chat_length=_wb_chat_length,
            # A4 修复: world_info_depth 全局扫描深度 + recursive 总开关
            world_info_depth=wi_world_info_depth,
            enable_recursive=wi_recursive,
            # V-2/V-3 (2026-08-25): vectorized 检索开关透传（top_k/threshold 走 env 默认）
            vectorized_enabled=wi_vectorized_enabled,
            # C1 修复（批次 C）: 全局百分比预算兜底 + cap 钳制（书级值优先）
            world_info_budget=wi_budget,
            world_info_budget_cap=wi_budget_cap,
            # C3 修复（批次 C）: include_names（haystack "name: content" 拼接）
            include_names=wi_include_names,
            # C5 修复（批次 C）: 全局大小写敏感 / 全词匹配（entry NULL 继承）
            world_info_case_sensitive=wi_case_sensitive,
            world_info_match_whole_words=wi_match_whole_words,
            # A5 修复: 百分比预算基数传真实上下文上限（16000 仅作兜底）
            max_context_tokens=max_context_tokens,
        )
# ── [WB-INDEP 2026-10-05] 世界书六份产物相互独立 ──────────────────
        # ST getWorldInfoPrompt（script.js:4575）一次返回 worldInfoString /
        # worldInfoBefore / worldInfoAfter / worldInfoExamples / worldInfoDepth /
        # outletEntries 六个**互不依赖**的结果；at-depth 条目走扩展注册表 IN_CHAT
        # （script.js:4612 setExtensionPrompt CUSTOM_WI_DEPTH_ROLE），从不被
        # before/after 正文块是否为空所左右。
        #
        # 此前 depth / em_top / em_bottom / outlet 四段被错放在 `if wb_result.text:`
        # 内侧。正文块一旦被 token 预算裁空（默认 25% 对长书即可能裁空），整本
        # at-depth 指令随之静默丢失——表现为卡片级的格式规范（MVU 变量更新格式、
        # <cg> 立绘标签规范等）压根没进 prompt，模型自然产不出对应标签。
        # 该缺陷与具体卡无关：任何"只靠 at-depth 提供指令"的世界书都会整本失效。
        _wb_has_output = bool(
            wb_result.text
            # [ASM-4] 拆桶模式下 bulk 内容以 entries_by_position 为准（text 只是
            # 它的 join 形态，一并保留判断兼容旧结果对象）。
            or wb_result.entries_by_position
            or wb_result.depth_entries
            or wb_result.em_top_entries
            or wb_result.em_bottom_entries
            or wb_result.outlet_entries
        )
        # 报告与逐条明细不依赖 text：有 depth-only 命中时同样要报出来，
        # 否则用户看到的是误导性的 "no matched entries"。
        by_source: dict[str, list[str]] = {}
        for _meta in (wb_result.book_sources or {}).values():
            by_source.setdefault(_meta.get("source") or "global", []).append(
                _meta.get("name") or "(未命名)",
            )
        detail_parts = [
            f"entries={len([r for r in wb_result.debug_report if r.status == 'activated'])}"
        ]
        for _src in ("chat", "character", "global"):
            if by_source.get(_src):
                detail_parts.append(f"{_src}:{','.join(by_source[_src])}")
        for r in wb_result.debug_report:
            report.append(
                PromptAssemblyReportItem(
                    f"worldbook_entry_{r.entry_id}",
                    r.status,
                    detail=(
                        f"book={r.book_name}; source={r.lore_source}; "
                        f"title={r.title}; reason={r.reason}; keywords={r.matched_keywords}"
                    ),
                    tokens_estimate=r.tokens_estimate,
                )
            )
        # [ASM-4 2026-10-24] WI 内容变换管线（拆桶/合并两模式共用，与旧实现逐参相同：
        # 插件正则 → 卡正则 → 宏替换，placement=WORLD_INFO、is_prompt=True、depth=0）。
        def _wb_transform(text: str) -> str:
            transformed = deps.apply_plugin_regex_scripts(
                text,
                req.db,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                # C4a 修复（批次 C）: ST world-info.js:5086 WI 内容正则 isPrompt:true
                # （promptOnly 脚本作用于 WI 内容；markdownOnly 不作用于 prompt 侧）
                is_prompt=True,
                depth=0,
                skip_extensions=req.char.extensions,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
                # P2-9 修复: 透传 user_id 以读取 extension_settings.regex_scripts
                user_id=req.user.id if req.user else None,
            )
            transformed = deps.apply_regex_scripts(
                transformed,
                req.char.extensions,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                # C4a 修复（批次 C）: 同上，isPrompt=True 对齐 ST
                is_prompt=True,
                depth=0,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
            )
            return deps.replace_placeholders(transformed, user_nickname, req.char.name or "")

        _split_mode = (
            wi_before_parts is not None
            or wi_after_parts is not None
            or an_before_parts is not None
            or an_after_parts is not None
        )
        if _split_mode:
            # [ASM-4 2026-10-24] D-1+NF-3 拆桶：entries_by_position 已分位
            # （worldbook_service :2149-2183），旧实现 sorted 全部 join 进一条
            # "[World Lore]" 尾块——before/after 夹 main 的语义与 ANTop/ANBottom
            # 的作者注通道语义都被压平（VER-1 D-1 判例 + VER1b NF-3 c795d62a 判例）。
            # 桶内 join 用 "\n"（ST world-info.js:5146-5147 join('\n')；anBefore/anAfter
            # 在 ST 侧也是数组 join('\n') 后并入作者注，:5151-5152）。
            _ebp = wb_result.entries_by_position or {}
            _bucket_raw = {
                0: list(_ebp.get(0, []) or []),
                1: list(_ebp.get(1, []) or []),
                2: list(_ebp.get(2, []) or []),
                3: list(_ebp.get(3, []) or []),
            }
            # 防御：位置枚举（0-3）外的残留 key——旧实现会把它并进尾块，这里归入
            # after 桶保内容不丢（正常数据不会出现；出现即数据形状异常）。
            _pos_extra = [
                c for k in sorted(_ebp.keys()) if k not in (0, 1, 2, 3)
                for c in (_ebp.get(k, []) or [])
            ]
            _bucket_targets = {
                0: wi_before_parts, 1: wi_after_parts,
                2: an_before_parts, 3: an_after_parts,
            }
            for _pos_key, _raw in _bucket_raw.items():
                if not _raw:
                    continue
                _bucket_text = _wb_transform("\n".join(_raw))
                if _bucket_text.strip():
                    _target = _bucket_targets.get(_pos_key)
                    if _target is not None:
                        _target.append(_bucket_text)
                    # 目标桶未传（调用方只要部分桶）时内容并入 after 桶兜底，
                    # 不允许静默丢弃。
                    elif wi_after_parts is not None:
                        wi_after_parts.append(_bucket_text)
            if _pos_extra and wi_after_parts is not None:
                _extra_text = _wb_transform("\n\n".join(_pos_extra))
                if _extra_text.strip():
                    wi_after_parts.append(_extra_text)
            report.append(
                PromptAssemblyReportItem(
                    "worldbook",
                    "included" if _wb_has_output else "skipped",
                    detail=(
                        f"split=before({len(_bucket_raw[0])})/after({len(_bucket_raw[1])})"
                        f"/anTop({len(_bucket_raw[2])})/anBottom({len(_bucket_raw[3])}); "
                        + "; ".join(detail_parts)
                    ),
                    tokens_estimate=wb_result.total_tokens,
                )
            )
        elif wb_result.text:
            wb_text = _wb_transform(wb_result.text)
            dynamic_context_parts.append(wb_text)
            report.append(
                PromptAssemblyReportItem(
                    "worldbook",
                    "included",
                    detail="; ".join(detail_parts),
                    tokens_estimate=wb_result.total_tokens,
                )
            )
        # Collect depth entries from worldbook
        # ST 对齐: 包装为统一队列记录，key 对齐 ST customDepthWI_{depth}_{role}
        # （constants.js L53）；同 key 多条按收集序稳定排列
        for wb_depth, wb_content, wb_role in wb_result.depth_entries:
            depth_entries.append(DepthInjection(
                depth=wb_depth,
                content=balance_custom_tags(
                    deps.replace_placeholders(wb_content, user_nickname, req.char.name or "")
                ),
                role=wb_role if isinstance(wb_role, int) else _ROLE_NAME_TO_INT.get(str(wb_role).lower(), 0),
                source="worldbook_depth",
                sort_key=_KEY_WI_DEPTH_FMT.format(depth=wb_depth, role=wb_role),
                report_on_insert=True,
            ))
        # ST 1.18.0 对齐: 把 EMTop/EMBottom/outlet 条目传递给 MacroEnv
        # 通过 {{mesExamples}} 和 {{outlet::name}} 宏注入到 prompt 中
        # 注意: 这些条目也需要经过 replace_placeholders 处理 {{user}}/{{char}}
        if em_top_entries is not None:
            for content in wb_result.em_top_entries:
                em_top_entries.append(
                    balance_custom_tags(
                        deps.replace_placeholders(content, user_nickname, req.char.name or "")
                    )
                )
        if em_bottom_entries is not None:
            for content in wb_result.em_bottom_entries:
                em_bottom_entries.append(
                    balance_custom_tags(
                        deps.replace_placeholders(content, user_nickname, req.char.name or "")
                    )
                )
        if outlet_entries is not None:
            for outlet_name, contents in wb_result.outlet_entries.items():
                if outlet_name not in outlet_entries:
                    outlet_entries[outlet_name] = []
                for content in contents:
                    outlet_entries[outlet_name].append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
                        )
                    )
        if not _wb_has_output:
            report.append(PromptAssemblyReportItem("worldbook", "skipped", "no matched entries"))
        nested.commit()
    except Exception as exc:
        logger.warning("World book context injection failed: %s", exc)
        # [SILENT-FAIL 2026-10-22] 世界书整段没注入是最难查的一类：卡"不认设定"，
        # 而日志里只有一行没有 request_id 的 WARNING。
        _record_silent_failure(
            "prompt_assembly.worldbook",
            exc,
            session_id=getattr(req, "session_id", None),
            character_id=getattr(getattr(req, "char", None), "id", None),
        )
        if nested is not None:
            try:
                nested.rollback()
            except Exception as _rb_exc:
                _record_silent_failure(
                    "prompt_assembly.worldbook.savepoint_rollback",
                    _rb_exc,
                    session_id=getattr(req, "session_id", None),
                )
                try:
                    req.db.rollback()
                except Exception as _outer_exc:
                    _record_silent_failure(
                        "prompt_assembly.worldbook.session_rollback",
                        _outer_exc,
                        session_id=getattr(req, "session_id", None),
                    )
        report.append(PromptAssemblyReportItem("worldbook", "error", str(exc)))


def _append_plotline_context(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
    dynamic_context_parts: list[str],
    report: list[PromptAssemblyReportItem],
) -> None:
    user_nickname = req.user_nickname or req.user.username or "User"
    if req.is_init:
        report.append(PromptAssemblyReportItem("plotline", "skipped", "init"))
        return

    nested = None
    try:
        nested = req.db.begin_nested()
        pl_context = build_plotline_context(req.db, req.session_id, req.user.id)
        if pl_context:
            pl_context = deps.replace_placeholders(pl_context, user_nickname, req.char.name or "")
            dynamic_context_parts.append(pl_context)
            report.append(
                PromptAssemblyReportItem(
                    "plotline",
                    "included",
                    tokens_estimate=_estimate_tokens(pl_context),
                )
            )
        else:
            report.append(PromptAssemblyReportItem("plotline", "skipped", "inactive"))
        nested.commit()
    except Exception as exc:
        logger.warning("Plot line context injection failed: %s", exc)
        # [SILENT-FAIL 2026-10-22] 剧情线整段没进提示词，用户只会觉得"AI 不按剧情走"。
        _record_silent_failure(
            "prompt_assembly.plotline",
            exc,
            session_id=getattr(req, "session_id", None),
        )
        if nested is not None:
            try:
                nested.rollback()
            except Exception as _rb_exc:
                _record_silent_failure(
                    "prompt_assembly.plotline.savepoint_rollback",
                    _rb_exc,
                    session_id=getattr(req, "session_id", None),
                )
                try:
                    req.db.rollback()
                except Exception as _outer_exc:
                    _record_silent_failure(
                        "prompt_assembly.plotline.session_rollback",
                        _outer_exc,
                        session_id=getattr(req, "session_id", None),
                    )
        report.append(PromptAssemblyReportItem("plotline", "error", str(exc)))


# T5 (ST 插件兼容·双轨让步): 当用户在用 ST 向量插件（存在 st-vec:: 集合数据）时，
# 自动跳过 Palink 记忆注入，避免双记忆系统同时注入导致内容重复。
# MEMORY_ST_YIELD=false 可关闭让步（运维级开关，默认开启）。
# 检测结果按 user_id 进程内缓存 60s，避免每条消息查库。
_ST_VEC_YIELD_CACHE: dict[int, tuple[float, bool]] = {}
_ST_VEC_YIELD_TTL = 60.0


def _st_vector_data_active(db, user_id: int) -> bool:
    import os as _os
    import time as _time

    if _os.getenv("MEMORY_ST_YIELD", "true").lower() != "true":
        return False

    cached = _ST_VEC_YIELD_CACHE.get(user_id)
    now = _time.monotonic()
    if cached and (now - cached[0]) < _ST_VEC_YIELD_TTL:
        return cached[1]

    active = False
    try:
        from sqlalchemy import text as _sa_text

        row = db.execute(
            _sa_text(
                "SELECT 1 FROM conversation_memories "
                "WHERE user_id = :user_id AND session_id LIKE 'st-vec::%' LIMIT 1"
            ),
            {"user_id": user_id},
        ).first()
        active = row is not None
    except Exception as _vec_probe_exc:
        # 探测失败不阻塞正常记忆流程 —— 但**必须留记录**：探测失败 = 判定为"没在用
        # ST 向量插件" ⇒ Palink 记忆照常注入 ⇒ 双记忆系统同时注入、内容重复。
        # 这条以前静默，用户只会看到"记忆里出现两遍同样的内容"。
        _record_silent_failure(
            "prompt_assembly.st_vector_yield_probe",
            _vec_probe_exc,
            user_id=user_id,
        )
        active = False
    _ST_VEC_YIELD_CACHE[user_id] = (now, active)
    return active


# ── [分层记忆 Phase 1] 实体卡 / 长会话门控 / 注入预算档位 ──
# spec: docs/SPEC_分层记忆注入_2026-09-02.md §4.1 / §4.1b（2026-09-03 施工）。
# 档位：0=紧凑 750 / 1=标准 4000（默认）/ 2=加量 6000 / 3=尽量多 8000。
# 〔2026-10-10 订正〕本行原写「1=标准 1500（默认=历史硬编码值，存量零变化）/
# 2=加量 3000 / 3=尽量多 6000」，与紧随其下的 2026-10-09 重定记录**自相矛盾**，现同步为终值。
# 超预算时 _apply_token_budget 兜底裁剪
# （记忆区优先级低于人设/最近历史），放大档位不会撑爆 prompt。
# ⚠️ 2026-10-09 重定档位（原 `(750, 1500, 3000, 6000)`，默认 1500）。
# 依据 p55 五档细扫（53 题 × 5 档，deepseek-flash 判分，逐题配对）：
#   750 0.500 / 1500 0.509 / 2500 0.575 / **4000 0.698** / 6000 0.679
#   4000 vs 1500 = **+0.189，z=3.04，p=0.0024**（高度显著）
#   4000 复跑得 0.604（同配置两轮 0.698/0.604 ⇒ 跑间噪声约 ±0.09），
#   两轮均值 0.651 仍明显高于 1500 的 0.509。
#   6000 与 4000 差 -0.019（z=-0.34，p=0.73）⇒ **两者等效的平台**，
#   但 6000 多花约 47% 的 prompt token ⇒ 取 4000 作默认。
# ⇒ 本表第二项（默认档，index 1）由 1500 改为 **4000**。
#
# 这与 2026-10-09 早先报告「1500 是甜点、放大反而掉分 -0.08」**相反**，原因是
# 那份是**修复前**测的：检索不精准时，放大预算等于多塞噪声，故越大越差；
# 查询构造 + 关键词路两项修复落地后，多给预算才是真信息 ⇒ 甜点上移。
# **结论：预算甜点依赖检索精度，检索修好后必须重扫，不能沿用旧结论。**
# ⚠️ [单位契约 2026-10-10] 本表的单位是**内部口径**，**不是真实 token**。
#   换算关系：1 内部单位 = `len(text) // 2`（见 utils.py 的 cost 计算），
#   而中文实测约 0.66 token/字 ⇒ 1 内部单位 ≈ **1.37 真实 token**。
#   ⇒ 本表写 4000，实际注入约 **5490 真实 token**。
#
#   **为什么叫 INTERNAL_UNITS 而不叫 TOKENS**（原名是 _MEMORY_BUDGET_LEVEL_TOKENS）：
#   原名让"4000"看起来像真实 token 预算，会诱导后人按真实 token 推理，
#   进而误判 prompt 占用。改名后名字不再撒谎，**数值一个字没改、行为零变更**。
#
# ⚠️ **本表与 utils.py 的计量口径是绑定的，改一个必须同时改另一个**：
#   若把 cost 改成真实 token 估算（0.66/字）而不同步放大本表，
#   实际注入量会从 5490 掉回 4000，等于偷偷缩小预算 27% ⇒ 分数退步。
#   反之若只放大本表不改 cost，预算会翻倍。二者必须等比联动（×1.37）。
_MEMORY_BUDGET_LEVEL_INTERNAL_UNITS = (750, 4000, 6000, 8000)
# [MEM-BUDGET-CLAMP 2026-10-09] 记忆区最多占 prompt 总预算的多少。
#
# ⚠️ 2026-10-09 订正：此处原写「实测记忆区注入 2455~2709 tok」，**该数字是错的**。
# 它来自 p51 探针，而 p51 复用了上一轮脚本遗留的 `MemoryService` 60 秒缓存
# （命中后返回的是上一次的 `[Relevant Memories]` 段）。用 `enable_cache=False`
# 复测：档位 1500 + 邻居扩展 30% ⇒ 实际 **1943 tok / 20 条**，不是 2455~2709。
# 教训：量记忆注入量之前必须先关缓存，否则量到的是上一轮的残渣。
#
# 夹取的本意不变：小窗口模型（如 8K）下 prompt 总预算可能只剩两三千，
# 此时记忆区按档位吃满会把历史挤没 —— 记忆是"补充"，历史是主线，
# 故夹一个上限防止挤占。**正常窗口（≥32K）下预算远大于档位，不触发。**
_MEMORY_BUDGET_MAX_SHARE = 0.4
# 实体卡压平文本上限（token），超限逐行截断并 report。
_MEMORY_ENTITY_CARD_MAX_TOKENS = 400


def _resolve_memory_max_tokens(user_setting: Optional[Any]) -> int:
    """[PHASE-1] 档位 → 记忆区注入上限。NULL/越界/无属性 = 标准档 4000
    （2026-10-10 订正：原写 1500，档位表 2026-10-09 已重定为 (750,4000,6000,8000)）。

    ⚠️ **返回值的单位是「内部口径」，不是真实 token**（2026-10-10 正名）：
    1 内部单位 ≈ 1.37 真实 token（中文实测 0.66 token/字，而此口径按 0.5 算）。
    ⇒ 返回 4000 意味着实际注入约 5490 真实 token。
    详见本文件 `_MEMORY_BUDGET_LEVEL_INTERNAL_UNITS` 上方的单位契约注释。
    函数名保留 `max_tokens` 是历史原因（调用点散见装配链），勿据函数名推断真实 token。
    """
    try:
        lvl = getattr(user_setting, "memory_budget_level", None)
        if isinstance(lvl, int) and 0 <= lvl < len(_MEMORY_BUDGET_LEVEL_INTERNAL_UNITS):
            return _MEMORY_BUDGET_LEVEL_INTERNAL_UNITS[lvl]
    except Exception as _budget_exc:
        # [SILENT-FAIL 2026-10-22] 吞掉 = 用户设的档位被静默忽略、退回标准档，
        # 表现为"我明明调了记忆档位却没变化"。低severity但必须可见，用 WARNING。
        _record_silent_failure(
            "prompt_assembly.memory_budget_level_resolve",
            _budget_exc,
            level=logging.WARNING,
            user_setting_type=type(user_setting).__name__,
        )
    return _MEMORY_BUDGET_LEVEL_INTERNAL_UNITS[1]


def _flatten_stat_value(value: Any, _depth: int = 0) -> str:
    """stat_data 叶子值 → 紧凑文本：bool 转是/否，list 以「、」连接，dict 内联，
    空值返回空串；叶子截断 120 字防长文本撑爆实体卡。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, dict):
        # 深度语义：组 > 字段 > 内联子字段 一共三层；更深的畸形嵌套整支丢弃
        # （真实 stat_data 形如 /组/字段 与 /组/字段/{子字段}，两层已够用）
        if _depth > 1:
            return ""
        parts = []
        for k, v in value.items():
            if not k or str(k).startswith("_"):
                continue
            inner = _flatten_stat_value(v, _depth + 1)
            if inner:
                parts.append(f"{k}={inner}")
        return "，".join(parts)
    if isinstance(value, (list, tuple)):
        items = [_flatten_stat_value(v, _depth + 1) for v in value]
        items = [i for i in items if i]
        return "、".join(items)
    text = str(value).strip()
    if not text or text.lower() in ("null", "none", "nan"):
        return ""
    return text.replace("\n", " ")[:120]


def _flatten_stat_data(stat_data: Any) -> str:
    """[PHASE-1] 把 MVU stat_data 压平成中文键值行。

    压平而非注入原始 JSON：省 token，且降低结构化数据被主模型当成指令
    的概率。跳过 _ 开头（MVU 只读内部字段）与空值；dict 组展开为
    「组名：字段=值；…」行。输出示例：
        世界信息：日期时间=第一天·夜；地点=咖啡馆
        桃汐：好感度=50；服饰=常服
    """
    if not isinstance(stat_data, dict):
        return ""
    lines: list[str] = []
    for group_name, group in stat_data.items():
        if not group_name or str(group_name).startswith("_"):
            continue
        if isinstance(group, dict):
            pairs = []
            for field_name, value in group.items():
                if not field_name or str(field_name).startswith("_"):
                    continue
                v = _flatten_stat_value(value)
                if v:
                    pairs.append(f"{field_name}={v}")
            if pairs:
                lines.append(f"{group_name}：{'；'.join(pairs)}")
        else:
            v = _flatten_stat_value(group)
            if v:
                lines.append(f"{group_name}：{v}")
    return "\n".join(lines)


# ── [ST-ALIGN P0-3] Persona 注入位置：ST 1.18 persona_description_positions ──
# ST 真值（personas.js:88-97）：
#   IN_PROMPT=0, AFTER_CHAR=1(废弃), TOP_AN=2, BOTTOM_AN=3, AT_DEPTH=4, NONE=9
#
# Palink 旧值域（0=对话中depth4 / 1=system_prompt尾 / 2=聊天尾 / 3=不注入）与 ST
# **数值冲突**：ST 的 2(TOP_AN) 会被当成"聊天尾"注入到错误一端、3(BOTTOM_AN)
# 会被当成"不注入"静默丢失人设、4(AT_DEPTH) 走 unknown 分支跳过。
# 自有前端此前只写 0/1/2/3 故自洽，但 silly_tavern.py 会从 ST power_user 原样
# 同步 persona_description_position 入库，导入 ST 配置即触发错位。
# 自 2026-09-08 起后端统一按 ST 枚举解释（前端同步改用 ST 值）。
_ST_PERSONA_IN_PROMPT = 0
_ST_PERSONA_AFTER_CHAR = 1      # 废弃，按 IN_PROMPT 处理
_ST_PERSONA_TOP_AN = 2
_ST_PERSONA_BOTTOM_AN = 3
_ST_PERSONA_AT_DEPTH = 4
_ST_PERSONA_NONE = 9
# AT_DEPTH 深度：ST 由 persona_description_depth 可配，Palink 暂固定 4
# （与 author_note_depth 默认一致）。可配化登记为 P1。
_PERSONA_AT_DEPTH_DEFAULT = 4


def _resolve_active_persona(
    db: Session,
    req: "PromptAssemblyRequest",
    user_setting: Optional[UserSetting],
) -> Optional[tuple]:
    """解析当前生效 persona 的注入文本与 ST 位置枚举。

    返回 `(persona_text, st_position, at_depth)`；以下情况返回 None（宁缺勿错）：
    无 active_persona_id / persona 不存在 / persona_show=False /
    description 为空 / 任何查询异常。只读，不写库。
    """
    try:
        active_persona_id = getattr(user_setting, "active_persona_id", None) if user_setting else None
        if not active_persona_id or req.user is None:
            return None
        active_persona = db.query(Persona).filter(
            Persona.id == active_persona_id,
            Persona.user_id == req.user.id,
        ).first()
        if active_persona is None or not active_persona.persona_show:
            return None
        desc = (active_persona.description or "").strip()
        if not desc:
            return None
        pos_val = getattr(active_persona, "persona_description_position", None)
        try:
            pos = int(pos_val) if pos_val is not None else _ST_PERSONA_NONE
        except (TypeError, ValueError):
            pos = _ST_PERSONA_NONE
        # AT_DEPTH 的可配深度（ST persona_description_depth，personas.js:632），
        # 脏值/负值回退默认 4
        depth_val = getattr(active_persona, "persona_description_depth", None)
        try:
            depth = int(depth_val) if depth_val is not None else _PERSONA_AT_DEPTH_DEFAULT
        except (TypeError, ValueError):
            depth = _PERSONA_AT_DEPTH_DEFAULT
        if depth < 0:
            depth = _PERSONA_AT_DEPTH_DEFAULT
        return (f"[Persona: {desc}]", pos, depth)
    except Exception as exc:
        logger.warning("Persona description lookup failed: %s", exc)
        return None


def _load_session_stat_data(db: Session, session_id: str, group_id: Optional[str] = None) -> Any:
    """[PHASE-1] 读取当前会话的 MVU stat_data：群聊优先群组变量
    （GroupChat.chat_metadata，群聊装配走 _g_mode 同源）、回退会话变量
    （CharacterChatSession.chat_metadata）。

    脏数据全防御：chat_metadata 非法 JSON / 非 dict / variables 或 stat_data
    非 dict / 行不存在 / 列 NULL——任何形态返回 None 静默跳过，绝不抛异常
    （装配主流程宁缺勿错）。只读，不写库。"""
    candidates: list[tuple[str, str]] = []
    if group_id:
        candidates.append(("group", group_id))
    candidates.append(("session", session_id))
    for kind, sid in candidates:
        try:
            if kind == "group":
                row = db.query(GroupChat).filter(GroupChat.id == sid).first()
            else:
                row = db.query(CharacterChatSession).filter(CharacterChatSession.id == sid).first()
            meta = json.loads(row.chat_metadata) if (row is not None and row.chat_metadata) else None
            if not isinstance(meta, dict):
                continue
            variables = meta.get("variables")
            if not isinstance(variables, dict):
                continue
            stat = variables.get("stat_data")
            if isinstance(stat, dict) and stat:
                return stat
        except Exception:
            continue
    return None


def _load_effective_stat_data(
    db: Session,
    session_id: str,
    group_id: Optional[str] = None,
    branch_id: Optional[str] = None,
) -> Any:
    """[ST-ALIGN P0-2] 读取「当前生效」的 MVU stat_data：消息级快照优先，回落会话级。

    对齐 ST 1.18：变量镜像存在每条消息的 extra.variables，swipe / 重生成 /
    切分支时自动取该消息对应的版本，变量随分支回退。

    Palink 此前只读 session 级 chat_metadata.variables（见
    _load_session_stat_data），导致 swipe / 重生成后：
      - 前端状态栏按消息读（Mvu.getMvuData({type:'message'})）→ 显示正确
      - 后端注入给模型的 stat_data 仍是最新值 → 模型看到的状态
        与用户眼前显示的分支状态不一致

    数据其实一直是齐的：websocket.py 落库时同时写了
    cur_meta["variables"]（session 级）与 msg_extra["variables"]（消息级），
    只是装配侧没读消息级。这里补上读取优先级即可，无 schema 变更。

    群聊保持原行为（群组变量源不同，不做消息级回退，避免引入回归）。
    只读，不写库；任何异常回落旧逻辑（宁缺勿错）。"""
    if group_id:
        return _load_session_stat_data(db, session_id, group_id)

    try:
        q = db.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == session_id,
        )
        if branch_id:
            q = q.filter(CharacterChatMessage.branch_id == branch_id)
        else:
            q = q.filter(CharacterChatMessage.branch_id.is_(None))
        # 只回看最近若干条：stat_data 每轮都会写，命中通常在 1-2 条内。
        # [MVU-LOOKBACK 2026-10-05] 窗口由 settings.MVU_STAT_LOOKBACK_LIMIT 控制
        # （默认 30，此前为硬编码字面量 30；同文件 CHARACTER_CHAT_HISTORY_LIMIT
        # 一直是可配置的，口径不一致）。取不到配置时回落 30，保持原行为不变。
        # ⚠️ 与变量清理联动：清理侧「保留最近楼层数」必须 ≥ 本值，见 core/config.py。
        _lookback = int(
            getattr(_memory_settings(), "MVU_STAT_LOOKBACK_LIMIT", 30) or 30
        )
        if _lookback < 1:
            _lookback = 30
        rows = q.order_by(CharacterChatMessage.created_at.desc()).limit(_lookback).all()
        for row in rows:
            extra = getattr(row, "extra", None)
            # [EXTRA-STR-FIX 2026-10-05] `extra` 列是 **Text**（存 JSON 字符串），
            # 不是 JSON 类型列 —— 原实现直接 `isinstance(extra, dict)` 判断，
            # 对字符串**恒为 False** → 循环永远 continue → 本函数**从未取到过消息级快照**，
            # 一直静默回落会话级。后果：swipe / 重生成 / 切分支时，模型看到的
            # stat_data 仍是最新值，与用户眼前的分支状态不一致 ——
            # 正是本函数文档里声称要修的那个问题（[ST-ALIGN P0-2]），修复本身成了空转。
            # 探针实测（2026-10-05）：`type(row.extra).__name__ == 'str'`，
            # `_load_effective_stat_data` 返回会话级值而非消息级。
            if isinstance(extra, str):
                try:
                    extra = json.loads(extra)
                except (json.JSONDecodeError, TypeError):
                    continue
            if not isinstance(extra, dict):
                continue
            variables = extra.get("variables")
            if not isinstance(variables, dict):
                continue
            stat = variables.get("stat_data")
            if isinstance(stat, dict) and stat:
                return stat
    except Exception as _stat_exc:
        # 宁缺勿错：任何异常都回落到 session 级 stat_data（控制流不变）。
        # 但此前整段静默，出问题时只能看到「变量没跟着 swipe 回退」而无从定位。
        logger.warning(
            "Failed to load message-level stat_data, falling back to session level "
            "(session_id=%r, branch_id=%r): %s",
            session_id, branch_id, _stat_exc,
        )

    return _load_session_stat_data(db, session_id, group_id)


def _memory_gate_should_skip(
    system_prompt_tokens: int,
    injected_tokens: int,
    history_chars: int,
    history_reserve: int,
    token_budget: int,
    history_truncated: bool = False,
) -> bool:
    """[PHASE-1b] True = 历史完整落在窗口内 且 装得进预算 → 跳过检索。

    两个条件必须同时成立，缺一不可（2026-09-22 修正，原实现只有第二个条件）：

    1. ``history_truncated``（历史已被窗口裁剪）为真时**一律不跳过**。
       窗口只装 ``history_limit`` 条（`CHARACTER_CHAT_HISTORY_LIMIT`，群聊取
       ``GroupChat.recent_messages_budget``），超出部分的原文不可能出现在
       prompt 里，其记忆必须靠检索补回。
    2. 预算比较：历史按 1 字≈1 token 高估（中文 tokenizer 实际约 0.6-0.7），
       宁可误开检索、不误关丢记忆。

    **修正动机**：原判据把「会话历史总字符数」与「模型上下文预算」直接相比。
    对注册 ``context_length=1000000`` 的模型（如 deepseek-v4-flash），预算高达
    995392，需历史 > 约 99 万字符才检索；而实测全库最大会话历史仅 2321 字符
    → 恒真跳过，向量记忆**从未注入**。且此 return 位于 mode 分派之前，
    rule 模式的最近 N 条也被一并砍掉。
    """
    if history_truncated:
        return False
    return (system_prompt_tokens + injected_tokens + int(history_chars) + history_reserve) <= token_budget


@lru_cache(maxsize=1)
def _memory_settings() -> Any:
    """延迟导入 settings（避免模块级导入环）。"""
    from ..core.config import settings
    return settings


def _resolve_history_window_limit(req: Any) -> int:
    """本轮实际注入的历史窗口上限（条）。

    与 ``build_character_chat_messages`` 的取数口径保持一致：群聊取
    ``GroupChat.recent_messages_budget``，未设置/<=0 时回退全局
    ``CHARACTER_CHAT_HISTORY_LIMIT``；单聊直接用全局值。
    """
    base = int(getattr(_memory_settings(), "CHARACTER_CHAT_HISTORY_LIMIT", 24) or 24)
    if not getattr(req, "group_id", None):
        return base
    try:
        group = _cached_request_group(req, req.group_id)
        budget_val = getattr(group, "recent_messages_budget", None)
        if isinstance(budget_val, int) and budget_val > 0:
            return budget_val
    except Exception as exc:
        logger.debug("history window limit lookup failed (group_id=%s): %s", req.group_id, exc)
    return base


# [MEM-QUERY] 语义检索的查询窗口：取最近几条消息拼成查询。
# 原先只用「本轮用户一句话」当查询，实测用户消息平均 29 字（101 条里 12 条不足
# 10 字）。拿 29 字去召回整段剧情里的旧语义块，命中集基本靠碰 —— 同一轮换用
# 「最近 4 条拼接」实测 top8 里 6 条发生变化，且相似度区间从
# 1.0000~0.6208（自评命中自己）收窄到 0.8869~0.7668（真有信息量）。
# 口径与世界书向量检索同源（SPEC_世界书向量召回接通与防护：查询文本 = 最近 4 条消息拼接）。
_MEM_QUERY_WINDOW_MESSAGES = 4
# 查询文本上限：嵌入模型的输入截断前先收口，避免长轮次把查询撑成整段历史
_MEM_QUERY_MAX_CHARS = 600

# [MEM-QUERY-2026-10-09] 查询侧才需要剥的行内标签：声音/语气指令。
# 只用于查询文本（入库侧不剥，因为实测重嵌前后检索指标完全一致，不值得动存量）。
_RE_QUERY_VOICE_TAG = re.compile(r"【[^】]{0,12}声音[^】]{0,40}】")


def _clean_query_text(text: str) -> str:
    """[MEM-QUERY-2026-10-09] 查询侧文本纯化。

    记忆**入库**侧走的是 `utils.clean_memory_content`（已剥 `<UpdateVariable>` /
    `<thinking>` / 排版 HTML / 表格空壳），但**查询**侧一直是消息原文 —— 两边不同源。
    实测本会话 227 条记忆里功能标签与残余 HTML 均为 0 条，脏的只有查询：
    窗口查询 600 字里中位夹着 3 处 `【声音：…】`／标签。

    这里只多剥一项 `【声音：…】`（入库侧没剥，但它对检索无信息量：实测把库重新
    纯化并重嵌 227 条后指标**一行没变**，所以不值得为它重嵌存量，只在查询侧剥）。

    纯化查询的独立贡献：中位排名 17 → 13（2026-10-09 p40 变体②）。
    """
    s = clean_memory_content(text)
    s = _RE_QUERY_VOICE_TAG.sub("", s)
    return s.strip()


def _build_memory_query(db, session_id, branch_id, current_message: str) -> str:
    """[MEM-QUERY] 构造语义检索查询；失败原样返回本轮消息。

    ⚠️ **2026-10-09 实测订正**（详见
    `docs/_active/report/REPORT_记忆最优解复核_关键词路与查询构造_2026-10-09.md`）：

    原实现「最近 N 条拼接 + 尾截 600」**比只用本轮消息更差** —— 那 600 字里本轮
    问题只占 **3.4%**（n=50 中位），96% 是上一条 assistant 回复的尾巴，还夹着
    `<UpdateVariable>` 与 `【声音：…】`。同一批题上：

        窗口查询        top1  6.2%   单次 3009ms
        本轮消息(清洗后) top1 22.9%   单次  619ms   ← 更准且快 4.8 倍

    默认模式 `current`：用**清洗后的本轮消息**；仅当它过短（< `MEMORY_QUERY_MIN_CHARS`
    字，生产实测 12/101 条用户消息不足 10 字）时，才回退拼接最近 1 条消息的尾部补足
    语境。旧行为由 `MEMORY_QUERY_MODE=window` 一键恢复。
    """
    base = (current_message or "").strip()
    if _memory_config.QUERY_MODE != "window":
        cleaned = _clean_query_text(base)
        if len(cleaned) >= _memory_config.QUERY_MIN_CHARS or not cleaned:
            return cleaned or base
        # 过短：补最近 1 条消息的尾部（不是整条，避免再次稀释）
        try:
            q = db.query(CharacterChatMessage.content).filter(
                CharacterChatMessage.session_id == session_id,
            )
            if branch_id:
                q = q.filter(CharacterChatMessage.branch_id == branch_id)
            else:
                q = q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
            prev = q.order_by(
                CharacterChatMessage.created_at.desc(), CharacterChatMessage.id.desc()
            ).limit(1).scalar()
        except Exception as prev_err:
            logger.debug("memory query fallback lookup failed: %s", prev_err)
            prev = None
        prev_tail = _clean_query_text(prev or "")[-_memory_config.QUERY_FALLBACK_CHARS:]
        # 本轮消息常常**已经落库**（成为"最近一条"）⇒ 不剥就会拼两遍，
        # 白白把查询的一半预算还给同一句话（旧窗口实现里有同款去重，别丢）。
        if prev_tail and cleaned and prev_tail.endswith(cleaned):
            prev_tail = prev_tail[: -len(cleaned)].rstrip()
        return (prev_tail + "\n" + cleaned).strip() if prev_tail else cleaned
    # ── window：2026-10-07 的旧行为（保留作一键回退）──
    try:
        q = db.query(CharacterChatMessage.content, CharacterChatMessage.role).filter(
            CharacterChatMessage.session_id == session_id,
        )
        if branch_id:
            q = q.filter(CharacterChatMessage.branch_id == branch_id)
        else:
            q = q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
        recent = q.order_by(
            CharacterChatMessage.created_at.desc(), CharacterChatMessage.id.desc()
        ).limit(_MEM_QUERY_WINDOW_MESSAGES).all()
    except Exception as query_err:
        # 与同函数 exclude-recent 的口径一致：查不到就不改行为，不静默清空查询
        logger.debug("memory query window lookup failed: %s", query_err)
        return base

    parts = [str(r[0] or "").strip() for r in reversed(recent) if str(r[0] or "").strip()]
    if base and (not parts or parts[-1][:80] != base[:80]):
        parts.append(base)
    if not parts:
        return base
    text = "\n".join(parts)
    if len(text) > _MEM_QUERY_MAX_CHARS:
        text = text[-_MEM_QUERY_MAX_CHARS:]
    return text


def _release_memory_savepoint(nested: Any, req: PromptAssemblyRequest) -> None:
    """[F-6 2026-10-25] 收尾释放 SAVEPOINT——**释放问题不得冒充检索失败**。

    成因（实测定位，非推测）：``_tables_initialized`` 是进程级全局，
    所以**每个进程的第一次**装配会走 ``MemoryStorage.__init__`` →
    ``_init_tables()``，其结尾在**调用方同一条会话**上 ``self.db.commit()``
    （建表/迁移落盘）。而本函数上游刚 ``begin_nested()`` 开了 SAVEPOINT ⇒
    那次 commit 把 SAVEPOINT 连带释放，收尾裸 ``nested.commit()`` 必抛
    ``ResourceClosedError("This transaction is closed")``，被外层 except
    报成 ``memory error``。记忆正文此刻**已经注入成功**（实测 W1：
    ``memory included tok=7127`` 排在 error 之前），所以坏的是那条**误导读数**
    ——历史上它把排查一路带偏成"重启后第一次装配必丢记忆"。

    两条已试过并**回退**的修法，别再走：
    ① 给 ``_init_tables()`` 自建短会话：DDL 换到另一条会话会等本会话
      SAVEPOINT 持有的 memory 表锁，实测把连接拖到服务端
      ``idle_in_transaction_session_timeout``(本机=1min) 击杀，
      症状从"一条误报"升级成"整次装配炸掉"。
    ② 把 ``MemoryService(req.db)`` 构造挪到 ``begin_nested()`` 之前：
      同样触发①那类时序，实测冷启动直接
      ``server closed the connection unexpectedly``，比误报严重。
    根治应是把记忆建表/迁移移到应用启动期（或复用 alembic 链），
    属动启动语义，本批未授权 ⇒ 记入交付报告遗留项。

    本守卫的边界：只放行"SAVEPOINT 已不在"这一种情况（``is_active`` 为假，
    或 commit 抛 ResourceClosedError），其它异常照原样上抛给外层 except，
    真·检索失败仍然会报 ``memory error``——不许顺手把真失败也一起咽掉。
    """
    if nested is None:
        return
    if not getattr(nested, "is_active", True):
        _record_silent_failure(
            "prompt_assembly.memory.savepoint_already_released",
            None,
            once=True,
            level=logging.WARNING,
            session_id=getattr(req, "session_id", None),
        )
        return
    try:
        nested.commit()
    except ResourceClosedError as rel_exc:
        _record_silent_failure(
            "prompt_assembly.memory.savepoint_already_released",
            rel_exc,
            once=True,
            level=logging.WARNING,
            session_id=getattr(req, "session_id", None),
        )


async def _append_memory_context(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
    memory_mode: str,
    dynamic_context_parts: list[str],
    report: list[PromptAssemblyReportItem],
    memory_max_tokens: int = 1500,
    token_budget: Optional[int] = None,
    system_prompt: str = "",
    history_reserve: Optional[int] = None,
    # [ASM-4 2026-10-24] D-2/D-3 前部出参：传入（非 None）时实体卡与记忆文本写入
    # 此桶（装配层将其落位为 main 之后的**独立消息**，ST 官方记忆扩展默认
    # IN_PROMPT 相对 main 独立消息，memory/index.js:114）；None 时写入
    # dynamic_context_parts（旧尾部合并行为，直接调用方兼容零改动）。
    front_parts: Optional[list[str]] = None,
) -> None:
    user_nickname = req.user_nickname or req.user.username or "User"
    # [ASM-4] D-2/D-3 落位桶：front_parts 在场 → main 之后独立消息；否则旧尾块。
    _mem_sink = front_parts if front_parts is not None else dynamic_context_parts
    if memory_mode == "disabled" or req.is_init:
        report.append(PromptAssemblyReportItem("memory", "skipped", memory_mode))
        return

    # [PHASE-1 实体卡] MVU 卡把会话 stat_data 压平注入记忆区顶部——装配侧
    # 此前只注入 <UpdateVariable> 更新指令、从不注入当前值，模型每轮盲猜
    # 时间/地点/好感度。非 MVU 卡 / 无数据 / 异常全部静默跳过（宁缺勿错）。
    # 不受 ST 向量让步影响（是状态数据不是检索结果），不受 1b 门控影响。
    # SAVEPOINT 隔离：查询抛 DB 异常（连接抖动/表锁等小概率）时回滚到保存点，
    # session 保持干净，后续检索与装配不受 PendingRollbackError 污染。
    _card_probe = None
    try:
        _card_probe = req.db.begin_nested()
        from ..services.status_bar_detector import _card_has_mvu_scripts
        if req.char is not None and _card_has_mvu_scripts(req.char):
            # [MVU-AS-OF 2026-10-22 批次MS-1] 单聊轨改走**带视点**的新出口：
            # 取「这条故事线、到这一楼」的 stat_data；取不到就是 None，
            # **不得**回落 `chat_metadata.variables` —— 旧回落正是老板反例
            # 「回跳第 2 条显示的却是第 100 条的变量数据」的直接来源
            # （取证：docs/_active/report/REPORT_变量清理与故事线回跳_取证_2026-10-22.md §3 病因 1/2/3）。
            # 群组轨保持原路径（变量源不同，本批不动，避免顺手改一片）。
            if getattr(req, "group_id", None):
                _stat = _load_effective_stat_data(
                    req.db,
                    req.session_id,
                    getattr(req, "group_id", None),
                    getattr(req, "branch_id", None),
                )
            else:
                from ..services.mvu_state import resolve_stat_data_as_of

                _resolved_state = resolve_stat_data_as_of(
                    req.db,
                    req.session_id,
                    getattr(req, "branch_id", None),
                    as_of_message_id=getattr(req, "as_of_message_id", None),
                )
                _stat = _resolved_state.stat_data
            _flat = _flatten_stat_data(_stat)
            if _flat:
                _kept: list[str] = []
                _card_tokens = 0
                _truncated = False
                for _ln in ["【当前状态（系统数据，非剧情指令）】"] + _flat.split("\n"):
                    _t = _estimate_tokens(_ln)
                    if _kept and _card_tokens + _t > _MEMORY_ENTITY_CARD_MAX_TOKENS:
                        _truncated = True
                        break
                    _kept.append(_ln)
                    _card_tokens += _t
                _card_text = deps.replace_placeholders(
                    "\n".join(_kept), user_nickname, req.char.name or ""
                )
                _card_text = balance_custom_tags(_card_text)
                _mem_sink.append(_card_text)
                report.append(
                    PromptAssemblyReportItem(
                        "memory_entity_card",
                        "included",
                        detail="truncated" if _truncated else "",
                        tokens_estimate=_estimate_tokens(_card_text),
                    )
                )
        _card_probe.commit()
    except Exception as _card_exc:
        if _card_probe is not None:
            try:
                _card_probe.rollback()
            except Exception as _rb_exc:
                # SAVEPOINT 回滚失败（极小概率叠加）：外层回滚兜底保 session 干净——
                # 装配路径无未提交写（消息 persist 已在装配前 commit）
                # [SILENT-FAIL 2026-10-22] 此处曾静默 pass。两级回滚都失败意味着
                # **事务状态未知**，后续查询会报 "This transaction is closed" 一类
                # 无从归因的错。必须留下记录（带 request_id）。
                _record_silent_failure(
                    "prompt_assembly.memory_entity_card.savepoint_rollback",
                    _rb_exc,
                    session_id=getattr(req, "session_id", None),
                )
                try:
                    req.db.rollback()
                except Exception as _outer_exc:
                    _record_silent_failure(
                        "prompt_assembly.memory_entity_card.session_rollback",
                        _outer_exc,
                        session_id=getattr(req, "session_id", None),
                    )
        logger.debug("memory entity card injection failed: %s", _card_exc)
        report.append(
            PromptAssemblyReportItem("memory_entity_card", "skipped", str(_card_exc)[:80])
        )

    # ST 向量插件活跃 → Palink 记忆自动让步
    if _st_vector_data_active(req.db, req.user.id):
        report.append(
            PromptAssemblyReportItem(
                "memory", "skipped", "yielded to ST vector storage (st-vec:: active)"
            )
        )
        return

    # [PHASE-1b 长会话门控] 记忆检索按 session_id 过滤=会话内记忆：历史 +
    # 已注入块仍装得进预算时，窗口原文已覆盖全部记忆内容，检索召回=纯重复
    # （exclude_recent 只排最近 5 条，第 6 条起双份注入）。预算装不下才检索。
    # 估算失败视为超预算照常检索（宁误开勿误关）。token_budget=None 时门控
    # 关闭（兼容旧调用与测试直调路径），行为与改造前一致。
    if token_budget is not None:
        # 门控查询同样走 SAVEPOINT（独立于实体卡：门控炸不连累实体卡已注入
        # 的结果，实体卡炸也不影响门控判断），估算失败视为超预算照常检索
        # （宁误开勿误关）。token_budget=None 时门控关闭（兼容旧调用与测试
        # 直调路径），行为与改造前一致。
        _gate_probe = None
        _hist_chars = -1  # -1 = 估算失败 → 不门控（照常检索）
        _msg_count = -1   # -1 = 计数失败 → 按"已裁剪"处理（宁误开勿误关）
        try:
            _gate_probe = req.db.begin_nested()
            _hist_q = req.db.query(
                func.sum(func.length(CharacterChatMessage.content))
            ).filter(CharacterChatMessage.session_id == req.session_id)
            if req.branch_id:
                _hist_q = _hist_q.filter(CharacterChatMessage.branch_id == req.branch_id)
            else:
                _hist_q = _hist_q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
            # 隐藏消息不进 prompt（ST 语义），不计入历史；NULL 视为未隐藏
            _hist_q = _hist_q.filter(
                or_(CharacterChatMessage.is_hidden == False, CharacterChatMessage.is_hidden == None)  # noqa: E712
            )
            _hist_chars = int(_hist_q.scalar() or 0) + len(str(req.message or ""))
            # 当前用户消息也在窗口内且不属"历史"，同系数并入估算，
            # 消除"历史偏小 → 误跳过"的系统性偏差

            # [PHASE-1b 修正] 历史是否被窗口裁剪：窗口只装 _history_limit 条，
            # 超出部分的原文不在 prompt 内，其记忆必须靠检索补回。
            # 口径对齐 build_character_chat_messages 的取数（不排除隐藏消息）。
            _cnt_q = req.db.query(func.count(CharacterChatMessage.id)).filter(
                CharacterChatMessage.session_id == req.session_id
            )
            if req.branch_id:
                _cnt_q = _cnt_q.filter(CharacterChatMessage.branch_id == req.branch_id)
            else:
                _cnt_q = _cnt_q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
            _msg_count = int(_cnt_q.scalar() or 0)
            _gate_probe.commit()
        except Exception as _gate_err:
            if _gate_probe is not None:
                try:
                    _gate_probe.rollback()
                except Exception as _rb_exc:
                    # [SILENT-FAIL 2026-10-22] 同上：两级回滚都失败必须留记录。
                    _record_silent_failure(
                        "prompt_assembly.memory_gate.savepoint_rollback",
                        _rb_exc,
                        session_id=getattr(req, "session_id", None),
                    )
                    try:
                        req.db.rollback()
                    except Exception as _outer_exc:
                        _record_silent_failure(
                            "prompt_assembly.memory_gate.session_rollback",
                            _outer_exc,
                            session_id=getattr(req, "session_id", None),
                        )
            logger.debug("memory gate history estimate failed: %s", _gate_err)
        if _hist_chars >= 0:
            # [ASM-4] 前部桶（实体卡/记忆落位 main 后）的已注入量同样计入门控，
            # 防止重定向后 _injected_tokens 低估 → 误开检索（宁误开勿误关方向不变）。
            _injected_tokens = sum(_estimate_tokens(_p) for _p in dynamic_context_parts)
            if front_parts is not None:
                _injected_tokens += sum(_estimate_tokens(_p) for _p in front_parts)
            _reserve = history_reserve if history_reserve is not None else _DEFAULT_HISTORY_RESERVE
            # 计数失败时按"已裁剪"处理（宁误开勿误关）
            _history_limit = _resolve_history_window_limit(req)
            _truncated = _msg_count < 0 or _msg_count > _history_limit
            if _memory_gate_should_skip(
                _estimate_tokens(system_prompt), _injected_tokens, _hist_chars, _reserve, token_budget,
                history_truncated=_truncated,
            ):
                report.append(
                    PromptAssemblyReportItem(
                        "memory", "skipped",
                        f"history within window+budget (gate, msgs={_msg_count}/{_history_limit})"
                    )
                )
                return

    nested = None
    try:
        # [F-6 2026-10-25] 本行往下的 nested 会被冷启动的建表流程连带释放，
        # 成因与修法见 _release_memory_savepoint 的 docstring——收尾必须走那个
        # 守卫，不许回到裸 nested.commit()。
        nested = req.db.begin_nested()
        mem_svc = MemoryService(req.db)
        if mem_svc.is_available():
            ancestor_branch_ids = deps.get_ancestor_branch_ids(req.db, req.session_id, req.branch_id) if req.branch_id else []
            # [MEM-MIRROR 2026-10-05] 分叉点截断（RC-2）：把「可见分支集合」升级为
            # 「带分叉点的作用域」，使记忆可见范围与对话历史 _get_full_branch_history_paged
            # 的 fork_limits 严格对齐 —— 否则新分支会召回到父分支分叉点之后
            # （= 用户已放弃的剧情线）写入的记忆。
            # RC-3：原写法 `branch_ids=ancestor_branch_ids if ancestor_branch_ids else None`
            # 在祖先为空时**静默退化**为整会话全分支召回（storage.py 的 elif 分支无
            # branch 过滤），且无任何告警 —— 等于把隔离关掉。现改为：deps 提供 scopes
            # 时一律走 scopes（空列表 = 主聊天 → 只认 trunk）；branches 场景但 scopes
            # 意外为空（数据异常）时只认当前分支 + 告警，不再退化成全会话。
            branch_scopes: Optional[list] = None
            # getattr 兜底：deps 是依赖袋，测试/脚本会用 SimpleNamespace 构造，
            # 不保证带这个新字段。缺失时按旧行为（branch_ids）走，不炸召回。
            _scopes_fn = getattr(deps, "get_ancestor_branch_scopes", None)
            if _scopes_fn is not None:
                if req.branch_id:
                    branch_scopes = _scopes_fn(req.db, req.session_id, req.branch_id)
                    if not branch_scopes:
                        # 分支行查不到 = 数据异常：只认自己，宁窄勿宽 + 显式告警
                        logger.warning(
                            "[MEM-MIRROR] 分支作用域为空（session=%s branch=%s）：降级为仅当前分支召回",
                            req.session_id, req.branch_id,
                        )
                        branch_scopes = [(req.branch_id, None)]
                else:
                    # 主聊天（branch_id 为空）→ 只认 trunk（branch_id IS NULL），
                    # 不再把整会话所有分支的记忆召回来
                    branch_scopes = []
            # D3 修复: ST protect 语义 —— 最近 5 条消息的记忆镜像不再重复注入
            # （对话历史窗口已含原文，重复召回浪费 token）；查询失败静默回退
            # 不排除（宁多勿缺）。分支内取当前分支消息，主聊天取 branch_id 为空的消息。
            exclude_message_ids: list = []
            try:
                _mem_recent_q = req.db.query(CharacterChatMessage.id).filter(
                    CharacterChatMessage.session_id == req.session_id,
                )
                if req.branch_id:
                    _mem_recent_q = _mem_recent_q.filter(CharacterChatMessage.branch_id == req.branch_id)
                else:
                    _mem_recent_q = _mem_recent_q.filter(CharacterChatMessage.branch_id == None)  # noqa: E711
                exclude_message_ids = [
                    row[0] for row in _mem_recent_q
                    .order_by(CharacterChatMessage.created_at.desc(), CharacterChatMessage.id.desc())
                    .limit(5)
                    .all()
                ]
            except Exception as mem_recent_err:
                logger.debug("memory exclude-recent lookup failed: %s", mem_recent_err)
                exclude_message_ids = []
            # [T-跨卡串味修复 2026-10-03] 传角色维度：记忆表原先只有
            # user_id/session_id，session_id 为空时（分支3）退化成用户级全量
            # 召回 → A 卡的会话被塞 B 卡的记忆。req.char 即当前会话所属角色
            # （PromptAssemblyRequest.char），群聊发言人也属该会话。
            # 防御取 id：char 为 None 或轻量替身（无 id）时降级为 None（旧行为）。
            _mem_char = getattr(req, "char", None)
            _mem_char_id = getattr(_mem_char, "id", None) if _mem_char is not None else None
            memory_character_id = str(_mem_char_id) if _mem_char_id else None
            # [MEM-QUERY] 智能卡触发时查询已由卡片上下文给定；普通轮次改用
            # 最近几条消息拼出的窗口查询（见 _build_memory_query 的实测理由）。
            _mem_query = (
                req.smart_card_context if req.smart_card_trigger
                else _build_memory_query(
                    req.db, req.session_id, req.branch_id, req.message
                )
            )
            mem_ctx = await mem_svc.get_context(
                user_id=req.user.id,
                query=_mem_query,
                session_id=req.session_id,
                max_tokens=memory_max_tokens,
                # scopes 优先；未提供 scopes 的调用方沿用旧 branch_ids 行为。
                # ⚠️ 不再 `if ancestor_branch_ids else None`（那会把隔离静默关掉，RC-3）
                branch_scopes=branch_scopes,
                branch_ids=ancestor_branch_ids if branch_scopes is None else None,
                memory_mode=memory_mode,
                exclude_message_ids=exclude_message_ids or None,
                character_id=memory_character_id,
            )
            if mem_ctx and mem_ctx.memories:
                # [NEIGHBOR-BUDGET 2026-10-09] 渲染预算要跟着邻居扩展一起放大，
                # 否则多捞回来的相邻块会在 build_memory_context 里被"整条跳过"
                # 重新砍掉——而且砍的是排序最后的（= 最新的 = STM），等于白捞。
                _mem_render_tokens = memory_max_tokens
                if _memory_config.NEIGHBOR_EXPAND and _memory_config.NEIGHBOR_EXTRA_RATIO > 0:
                    _mem_render_tokens += int(
                        memory_max_tokens * _memory_config.NEIGHBOR_EXTRA_RATIO
                    )
                memory_text = build_memory_context(mem_ctx, max_tokens=_mem_render_tokens)
                if memory_text:
                    memory_text = deps.replace_placeholders(memory_text, user_nickname, req.char.name or "")
                    _mem_sink.append(memory_text)
                    report.append(
                        PromptAssemblyReportItem(
                            "memory",
                            "included",
                            # [T-跨卡串味修复] scope 显式回传：scope=user 表示
                            # 降级到用户级召回（跨角色串味风险面），可观测。
                            detail=f"mode={memory_mode},scope={getattr(mem_ctx, 'scope', 'session')}",
                            tokens_estimate=_estimate_tokens(memory_text),
                        )
                    )
                else:
                    report.append(PromptAssemblyReportItem("memory", "skipped", "empty context"))
            else:
                report.append(PromptAssemblyReportItem("memory", "skipped", "no memories"))
        else:
            report.append(PromptAssemblyReportItem("memory", "skipped", "service unavailable"))
        # [F-6] 收尾交给专用释放路径：SAVEPOINT 已被检索链内部的外层 commit 释放时
        # 只留痕，不进 except 分支 ⇒ 不再产生 "memory error / This transaction is closed"
        # 这条误导性读数。
        _release_memory_savepoint(nested, req)
    except Exception as exc:
        logger.warning("Memory context retrieval failed: %s", exc)
        # [SILENT-FAIL 2026-10-22] 这条 WARNING 没有 request_id，用户报"这次回复不记得
        # 之前的事"时无法对到具体请求。补一条带 request_id 的结构化记录。
        _record_silent_failure(
            "prompt_assembly.memory_context",
            exc,
            session_id=getattr(req, "session_id", None),
            memory_mode=locals().get("memory_mode"),
        )
        if nested is not None:
            try:
                nested.rollback()
            except Exception as _rb_exc:
                _record_silent_failure(
                    "prompt_assembly.memory.savepoint_rollback",
                    _rb_exc,
                    session_id=getattr(req, "session_id", None),
                )
                try:
                    req.db.rollback()
                except Exception as _outer_exc:
                    _record_silent_failure(
                        "prompt_assembly.memory.session_rollback",
                        _outer_exc,
                        session_id=getattr(req, "session_id", None),
                    )
        report.append(PromptAssemblyReportItem("memory", "error", str(exc)))


def _insert_depth_prompt(
    messages: list[dict[str, Any]],
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
    depth_entries: list[DepthInjection],
    report: list[PromptAssemblyReportItem],
) -> list[dict[str, Any]]:
    """ST 1.18.0 对齐的 depth 统一注入（palink-native）。

    把角色卡 depth_prompt + 世界书 atDepth + AN(IN_CHAT) + persona(pos=0) +
    /inject + 插件 IN_CHAT 全部按三级确定序插入 chat history：
        depth 降序 → order 升序 → role(assistant→user→system) → key 字母序
    同 (depth, order, role) 的多条合并为单条消息 join('\n')。
    语义对齐 ST openai.js populationInjectionPrompts / script.js doChatInject /
    getExtensionPrompt（详见 DepthInjection 处常量区注释）。

    [ASM-4 2026-10-24] D-9：锚点改纯聊天历史口径——按 builder 打的
    _palink_history_start/end 私有标记定位历史区，插入位 = 历史末梢 + 1 - depth；
    标记缺席时回退旧的"数组总长倒数"算式（直调兼容）。
    """
    user_nickname = req.user_nickname or req.user.username or "User"
    next_messages = list(messages)
    inserted_any = False

    records: list[DepthInjection] = list(depth_entries or [])

    # [ASM-4 2026-10-24] D-9：锚点改纯聊天历史口径（VER-1 §7.2 裁定：随尾块拆分
    # 同步修正插入算式，禁止单独修）。ST populationInjectionPrompts 只在聊天数组
    # 上 splice（openai.js:801-866，主提示词/世界书/扩展在另一容器，结构上不可能
    # 被越过或计入）；旧算式 len(messages)-depth 把数组里所有消息（含尾部动态块/
    # 前部扩展消息）都当历史槽，depth N ≈ ST depth N+1（VER-1 D-9 判例：24 楼
    # 窗口偏移 1 槽）。
    # 新口径按 **role ∈ (user, assistant) 的聊天消息** 计槽（ST 聊天数组的成员
    # 恰为聊天消息；PHI/尾部块/区头等 system 件在 ST 中均在注入数组之外）：
    # depth=0 → 最后一条聊天消息之后；depth=N → 从末往前第 N 条聊天消息之前；
    # depth 超过聊天消息数 → 钳到历史区首条（对齐 ST 倒序 splice 越界的净效果）。
    # builder 在历史区首条消息上打 _palink_history_start 私有标记（出栈前随
    # _palink_ 键统一剥离）作钳制下限；标记缺席（直调旧形态）回退旧算式。
    _anchor_start: Optional[int] = None
    for _i, _m in enumerate(next_messages):
        if isinstance(_m, dict) and _m.get("_palink_history_start"):
            _anchor_start = _i
            break

    def _chat_slots(msgs: list[dict[str, Any]]) -> list[int]:
        """当前数组中聊天消息（user/assistant）的下标升序表（每轮重扫，天然消化
        前序注入造成的位移）。"""
        return [
            _i for _i, _m in enumerate(msgs)
            if isinstance(_m, dict) and _m.get("role") in ("user", "assistant")
        ]

    # Character depth prompt —— ST 中经 setExtensionPrompt('DEPTH_PROMPT') 进注册表
    # （script.js L4426），此处并入统一队列参与同一三级排序
    if req.char.extensions:
        try:
            ext_data = json.loads(req.char.extensions) if isinstance(req.char.extensions, str) else req.char.extensions
        except (json.JSONDecodeError, TypeError):
            ext_data = None
        depth_prompt = ext_data.get("depth_prompt") if isinstance(ext_data, dict) else None
        if isinstance(depth_prompt, dict) and depth_prompt.get("prompt", "").strip():
            dp_text = deps.replace_placeholders(depth_prompt["prompt"], user_nickname, req.char.name or "")
            dp_depth = depth_prompt.get("depth", 4)
            dp_role_raw = depth_prompt.get("role", "system")
            try:
                dp_depth = int(dp_depth)
            except (TypeError, ValueError):
                dp_depth = 4
            records.append(DepthInjection(
                depth=dp_depth,
                content=dp_text,
                role=_ROLE_NAME_TO_INT.get(str(dp_role_raw).lower(), 0),
                source="depth_prompt",
                sort_key=_KEY_CHAR_DEPTH_PROMPT,
                report_on_insert=True,
            ))

    # ── ST 1.18.0 三级确定序 ──────────────────────────────────────
    # 执行序 = 时间序（chronological 数组从后往前插，同 depth 后插者靠后）：
    #   1. depth 降序（深的先插）
    #   2. order 升序（低 order 靠前/远离最新消息；高 order 靠近最新消息）
    #   3. 同 (depth, order) 内 role: assistant→user→system（system 最贴近最新消息，
    #      对齐 ST roles [system,user,assistant] 正序入块 + 整体 reverse 的净效果）
    #   4. 同 (depth, order, role) 内 sort_key 字母序（对齐 ST getExtensionPrompt
    #      Object.keys().sort()），并合并为单条消息 join('\n')（ST 扩展通道语义）
    if records:
        records.sort(key=lambda r: (-r.depth, r.order, _ROLE_MERGE_RANK.get(r.role, 2), r.sort_key))
        # [ASM-4] D-9 钳制下限：有历史区标记时钳到历史区首条（newMainChat 区头
        # 之后的真实历史起点——ST 中 newMainChat 在注入数组之外、insertAtStart
        # 合并，注入不会越过它）；无标记回退旧下限（首条 system 之后）。
        if _anchor_start is not None:
            _floor = _anchor_start
        elif next_messages and next_messages[0].get("role") == "system":
            _floor = 1
        else:
            _floor = 0
        i = 0
        while i < len(records):
            head = records[i]
            j = i
            merged_parts: list[str] = []
            while (
                j < len(records)
                and records[j].depth == head.depth
                and records[j].order == head.order
                and records[j].role == head.role
            ):
                merged_parts.append(records[j].content)
                if records[j].report_on_insert:
                    report.append(
                        PromptAssemblyReportItem(
                            head.source,
                            "included",
                            detail=f"depth={head.depth}; order={head.order}; role={_ROLE_INT_TO_NAME.get(head.role, 'system')}; key={records[j].sort_key}",
                            tokens_estimate=_estimate_tokens(records[j].content),
                        )
                    )
                j += 1
            merged_content = "\n".join(p for p in merged_parts if p)
            # ST 对齐下限：in-chat 注入只锚在「聊天历史」上，永不越过主提示词块。
            # ST 里 in-chat 注入操作的是倒序聊天历史数组（openai.js:800-866
            # populationInjectionPrompts），主提示词/世界书/卡字段在另一个容器
            # chatCompletion 里，直到 populateChatHistory（:1331-1336）才合流，
            # 所以 ST 结构上不可能越过主提示词；历史比 depth 短时倒序 splice
            # 只会在末尾追加，转回正序 = 落到聊天历史第一条之前，仍在主提示词之后。
            # [ASM-4] D-9 新算式（历史区标记在场时）：
            #   depth=0 → 最后一条聊天消息之后（数组末尾，当前 user 消息之后，
            #             与 ST script.js:5606 正常发送语义一致）；
            #   depth=N → 从末往前第 N 条聊天消息之前（倒序数组 splice(N) 的
            #             正序等价）；
            #   depth > 聊天消息数 → 钳到首条聊天消息之前（= 旧注释描述的越界
            #             净效果），再经 max(_floor, …) 保底不越过历史区首。
            _chat_idx = _chat_slots(next_messages)
            if _anchor_start is not None and _chat_idx:
                _n_chat = len(_chat_idx)
                if head.depth <= 0:
                    insert_index = _chat_idx[-1] + 1
                elif head.depth <= _n_chat:
                    insert_index = _chat_idx[_n_chat - head.depth]
                else:
                    insert_index = max(_floor, _chat_idx[0])
            else:
                # 标记缺席（直调旧形态/纯 system 数组）：旧算式兜底，行为不变。
                insert_index = max(_floor, len(next_messages) - head.depth)
            insert_index = max(_floor, insert_index)
            # [IN-CHAT-NOT-TRIMMED 2026-10-05] 打标记，让 _collect_prompt_sources 认出
            # 这是 in-chat 注入而非世界书正文块（ST 见下方说明）。
            next_messages.insert(insert_index, {
                "role": _ROLE_INT_TO_NAME.get(head.role, "system"),
                "content": merged_content,
                "_palink_in_chat_injection": True,
            })
            inserted_any = True
            i = j

    if not inserted_any:
        report.append(PromptAssemblyReportItem("depth_prompt", "skipped"))

    return next_messages
