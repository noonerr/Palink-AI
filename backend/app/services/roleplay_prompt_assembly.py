"""Unified roleplay prompt assembly service.

This module is the backend seam for Palink's ST-compatible roleplay runtime.
It intentionally preserves the existing prompt behavior while making the
assembly steps explicit and reusable by HTTP and WebSocket character chat.

方向声明: 项目当前主攻 `palink-native` 装配（build_character_chat_messages）。
`st-compat`（本文件 ST_COMPAT_MODES 分支 → build_st_compat_messages）与
`st-native`（iframe）均已封存冷处理、待删除，除非用户明确要求不要优化它们。
详见根目录 AGENTS.md。
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session
from fastapi import HTTPException

from ..memory_module.service import MemoryService
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
from ..services.character_message_builder import build_character_chat_messages, build_st_compat_messages
from ..services.plotline_service import build_plotline_context
from ..services.worldbook_service import build_worldbook_context, WorldbookContextResult
from ..services.macro_service import MacroEnv, evaluate_macros, evaluate_macros_in_messages
from ..utils import build_memory_context, balance_custom_tags, normalize_image_url

logger = logging.getLogger(__name__)

REGEX_PLACEMENT_WORLD_INFO = 5

DEFAULT_CONTEXT_TEMPLATE_NAME = "Default"

# ST 兼容装配模式：silly_tavern_mode 取这些值时，装配使用 ST 1.18.0 对齐的
# build_st_compat_messages 管线。compat 为历史过渡模式（iframe 别名），
# 语义上同样应按 ST 排序装配。
ST_COMPAT_MODES = {"st-compat", "compat"}


def _is_st_compat_mode(st_mode: Optional[str]) -> bool:
    return (st_mode or "").strip().lower() in ST_COMPAT_MODES


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
    # E-8 修复: 请求级缓存——装配路径对同一用户 InstructTemplate 加载 2 次
    # （st-compat skip_examples 检查 + 最终 instruct 包装）。
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
BuildSystemPromptFn = Callable[[Character, str, str, str, Optional[UserSetting]], str]
GetFullBranchHistoryFn = Callable[..., list]
GetAncestorBranchIdsFn = Callable[[Session, str, str], list]
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
    dialogue_mode: str = "first_person"
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
    except Exception:  # pragma: no cover - 极端情况下回退到旧逻辑
        pass
    # 无模型时回退到原有行为（tiktoken cl100k_base 或启发式估算）
    global _count_tokens_fn
    if _count_tokens_fn is None:
        try:
            from ..api.tokenizer import count_tokens as _count_tokens_fn  # type: ignore
        except Exception:  # pragma: no cover - 极端情况下回退到本地估算
            _count_tokens_fn = _local_estimate_tokens
    return _count_tokens_fn(value)


def _local_estimate_tokens(text: str) -> int:
    """本地回退估算（与原 _estimate_tokens 公式一致）。"""
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


def _get_openai_max_context_override(user_setting: Optional[Any]) -> Optional[int]:
    """P1-2 修复: 从 UserSetting.silly_tavern_settings 读取用户配置的
    ``openai_max_context``（对齐 ST 1.18.0 oai_settings.openai_max_context）。

    ST 1.18.0 中 ``openai_max_context`` 是用户在前端配置的上下文窗口大小
    （如 8192/16384/32768），优先级高于模型注册表。Palink 默认使用模型
    注册表的 ``context_length``，但当用户显式设置了 ST 兼容配置时，
    应尊重该值以对齐 ST 的 token 预算行为。

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
        oai = st.get("oai_settings", {})
        if not isinstance(oai, dict):
            return None
        value = oai.get("openai_max_context")
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return None


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
    st_mode: str,
) -> bool:
    """P1-1 修复：判断是否需要把角色卡字段抽取为独立可重排消息。

    仅当同时满足以下条件时返回 True：
    1. 当前处于 palink-native 模式（st-compat 路径已内置分离装配，无需此处理）；
    2. 已绑定 PromptPreset 且其 prompt_order 包含至少一个角色卡字段标识符
       （charDescription / charPersonality / scenario / worldInfoBefore / worldInfoAfter）。

    默认行为（无 preset 或 preset 不含角色卡字段）保持不变，system_prompt 仍为
    合并形态，避免影响未使用 prompt_order 的常规角色对话。
    """
    if _is_st_compat_mode(st_mode):
        return False
    if preset is None:
        return False
    order_ids = _preset_order_identifiers(preset)
    return bool(order_ids & _CHAR_FIELD_ST_IDS)


def _extract_char_field_messages_for_order(
    req: "PromptAssemblyRequest",
    preset: Optional[PromptPreset],
    st_mode: str,
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
    if not _should_split_char_fields_for_order(preset, st_mode):
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
        if m.get("_palink_char_field_proxy"):
            priority = _TRIM_PRIORITY_SMART_CARD  # 复用较低优先级（30）
            trimmable = True
        elif identifier == PROMPT_ID_SYSTEM_PROMPT:
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


def _apply_st_compat_history_trim_inner(
    messages: list[dict[str, Any]],
    token_budget: int,
    report: list[PromptAssemblyReportItem],
    pin_examples: bool = False,
) -> list[dict[str, Any]]:
    """D4 修复: st-compat 路径的 chat_history token 裁剪（内部实现）。

    与 ST 1.18.0 openai.js 的 TokenBudgetExceededError + reserveBudget 语义一致：
    - 仅对 chat_history 做按 token 裁剪
    - 保留强制项（main/worldInfoBefore/personaDescription/charDescription/
      charPersonality/scenario/worldInfoAfter/dialogueExamples/jailbreak/authorsNote）
    - 从 chat_history 中间裁剪最旧消息，保留开头 N 条 + 末尾 M 条

    A-10 修复: 示例/历史的预算竞争由外层 _apply_st_compat_history_trim 处理
    （pin_examples=false 时示例区段在调用本函数前已被抽离），本函数只裁剪 chat_history。

    识别 chat_history 区段：从 [Start a new Chat] 标记开始到 jailbreak 之前。
    """
    # 估算总 token 数（E-2 修复: 一次性计算每消息 token，避免裁剪循环内
    # 反复全量 re-encode 造成的 O(n²) 开销）
    per_msg = [_estimate_tokens(str(m.get("content", ""))) for m in messages]
    total_tokens = sum(per_msg)
    if total_tokens <= token_budget:
        return messages

    # 识别 chat_history 区段：找到 [Start a new Chat] 标记
    history_start_idx = -1
    for i, m in enumerate(messages):
        content = str(m.get("content", ""))
        if "[Start a new Chat]" in content or "[Start a new Group Chat" in content:
            history_start_idx = i
            break

    if history_start_idx < 0:
        # 找不到标记，不裁剪
        return messages

    # 识别 jailbreak 位置（chat_history 结束点）：st-compat 末尾可能有多条
    # 强制 system 消息（jailbreak + author's note pos1/2 + group nudge），均需排除在可裁剪区之外。
    # 从末尾向前跳过所有带 _st_trailing_guard 标记的消息，history_end_idx 定位到
    # 第一条末尾强制项之前。
    # A-11 修复: builder 已为 jailbreak/group nudge/AN pos0/IN_PROMPT extension_prompts
    # 打 _st_trailing_guard 标记。原「跳过最多 _MAX_TRAILING_MANDATORY=4 条 system」
    # 数量启发式在强制项超过 4 条时会把 jailbreak 误裁；而 chatHistory 以 depth 注入
    # 的 system 结尾时又会把可裁剪条目误判为强制项（裁剪不充分）。标记法两者皆解。
    history_end_idx = len(messages)
    for i in range(len(messages) - 1, history_start_idx, -1):
        if messages[i].get("_st_trailing_guard") is True:
            history_end_idx = i
        else:
            break

    # 提取 chat_history 区段
    history_messages = messages[history_start_idx:history_end_idx]
    if len(history_messages) <= 3:
        # 历史太短，不裁剪
        return messages

    # 计算强制项 token 数（非 chat_history 部分）
    mandatory_tokens = sum(per_msg[:history_start_idx]) + sum(per_msg[history_end_idx:])

    # P1-2 修复: 剩余预算 = token_budget - 强制项 token（对齐 ST 1.18.0 openai.js
    #  的 canAfford 行为）。原 0.7 比例会重复扣减动态上下文预算（mandatory_tokens
    #  已包含 worldbook/memory 等），导致历史被过度裁剪。修复后使用全部剩余预算。
    history_budget = token_budget - mandatory_tokens
    if history_budget <= 0:
        # 强制项已超预算，不裁剪历史（与 ST TokenBudgetExceededError 一致）
        report.append(
            PromptAssemblyReportItem(
                "st_compat_trim",
                "skipped",
                detail=f"mandatory_tokens={mandatory_tokens} exceeds budget",
            )
        )
        return messages

    # E-2 修复: 前缀和数组，裁剪循环内 O(1) 计算任意区间的 token 数
    n = len(history_messages)
    prefix = [0] * (n + 1)
    for i in range(n):
        prefix[i + 1] = prefix[i] + per_msg[history_start_idx + i]

    # 计算当前历史 token 数
    history_tokens = prefix[n]
    if history_tokens <= history_budget:
        return messages

    # 从中间裁剪：保留开头 N 条 + 末尾 M 条
    # 策略：保留开头 1 条（[Start a new Chat]）+ 末尾若干条，直到符合预算
    keep_start = 1  # 保留 [Start a new Chat] 标记
    keep_end = n - 1

    while keep_end > 0:
        kept_tokens = prefix[keep_start] + (prefix[n] - prefix[n - keep_end])
        if kept_tokens <= history_budget:
            break
        keep_end -= 1

    # 重建 messages
    trimmed_history = history_messages[:keep_start] + (history_messages[-keep_end:] if keep_end > 0 else [])
    new_messages = messages[:history_start_idx] + trimmed_history + messages[history_end_idx:]

    trimmed_count = len(history_messages) - len(trimmed_history)
    report.append(
        PromptAssemblyReportItem(
            "st_compat_trim",
            "trimmed",
            detail=f"trimmed={trimmed_count} history messages; original={history_tokens}; budget={history_budget}",
        )
    )
    return new_messages


def _apply_st_compat_history_trim(
    messages: list[dict[str, Any]],
    token_budget: int,
    report: list[PromptAssemblyReportItem],
    pin_examples: bool = False,
) -> list[dict[str, Any]]:
    """A-10 修复: st-compat 路径 chat_history 裁剪入口（含 pin_examples 预算竞争）。

    ST 1.18.0 openai.js:1327-1334 语义：
    - pin_examples=true : 先填示例再填历史（示例保留预算，历史被裁剪）
    - pin_examples=false: 先填历史再填示例（历史保留预算，示例用剩余预算尽力保留）

    此前 pin_examples=false 时整段删除示例块（[Example Chat] 标记+内容全部丢弃），
    与 ST「尽力保留能塞下的块」不符。修复：抽离示例区段 → 调用 inner 裁剪剩余
    （含 chatHistory）→ 用剩余预算从前往后把示例塞回（放不下的尾部才丢弃）。
    """
    # 仅在 pin_examples=false 且总预算超限时抽离示例区段；pin_examples=true 时
    # 示例属于强制项（inner 的 mandatory_tokens 统计），保持原行为。
    if not pin_examples and sum(_estimate_tokens(str(m.get("content", ""))) for m in messages) > token_budget:
        example_msgs: list[dict[str, Any]] = []
        example_start = -1
        for i, m in enumerate(messages):
            if m.get("role") == "system" and "[Example Chat]" in str(m.get("content", "")):
                example_start = i
                break
        if example_start >= 0:
            example_end = example_start
            while example_end + 1 < len(messages):
                _nx = messages[example_end + 1]
                _nx_content = str(_nx.get("content", ""))
                if (
                    _nx.get("role") != "system"
                    or "[Start a new Chat]" in _nx_content
                    or "[Start a new Group Chat" in _nx_content
                ):
                    break
                example_end += 1
            example_msgs = messages[example_start:example_end + 1]
            # 抽离示例，剩余消息交给 inner 裁剪（chatHistory 获得全部预算）
            remainder = messages[:example_start] + messages[example_end + 1:]
            trimmed = _apply_st_compat_history_trim_inner(remainder, token_budget, report, pin_examples=False)
            # 尽力塞回示例：从前往后累计，放不下的尾部丢弃
            remaining_budget = token_budget - sum(_estimate_tokens(str(m.get("content", ""))) for m in trimmed)
            kept: list[dict[str, Any]] = []
            for _ex in example_msgs:
                _ex_tokens = _estimate_tokens(str(_ex.get("content", "")))
                if _ex_tokens <= remaining_budget:
                    kept.append(_ex)
                    remaining_budget -= _ex_tokens
                else:
                    break
            if not kept:
                # 示例完全放不下（尽力后仍整段丢弃）
                report.append(
                    PromptAssemblyReportItem(
                        "st_compat_trim",
                        "trimmed",
                        detail=(
                            f"pin_examples=false; example block could not fit "
                            f"({len(example_msgs)} msg, budget exhausted)"
                        ),
                    )
                )
                return trimmed
            # 示例原本位于 chatHistory（[Start a new Chat] 标记）之前 → 塞回标记前
            insert_idx = len(trimmed)
            for i, m in enumerate(trimmed):
                _c = str(m.get("content", ""))
                if "[Start a new Chat]" in _c or "[Start a new Group Chat" in _c:
                    insert_idx = i
                    break
            result = trimmed[:insert_idx] + kept + trimmed[insert_idx:]
            report.append(
                PromptAssemblyReportItem(
                    "st_compat_trim",
                    "refilled",
                    detail=f"pin_examples=false; kept {len(kept)}/{len(example_msgs)} example message(s)",
                )
            )
            return result
    return _apply_st_compat_history_trim_inner(messages, token_budget, report, pin_examples=pin_examples)


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
) -> bool:
    """检查 filter 字段是否允许在当前 character_id / session_id 注入。
    - character_ids 非空时，character_id 必须在列表中
    - session_ids 非空时，session_id 必须在列表中
    - 任一字段为空 / 缺失表示不限制
    """
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


def _collect_extension_prompts(
    req: "PromptAssemblyRequest",
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
        }

    # 3. 按 filter 过滤
    char_id = str(req.char.id) if req.char is not None and req.char.id is not None else ""
    sess_id = str(req.session_id) if req.session_id else ""
    result: list[dict[str, Any]] = []
    for entry in merged.values():
        if not _ext_filter_allows(entry.get("filter") or {}, char_id, sess_id):
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

        不处理 {{user}}（留给下游 build_st_compat_messages._sub 解析为用户名）。
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
    st_mode: str = "palink-native",
) -> Optional[str]:
    """ST activateNaturalOrder 等价实现（B1 NATURAL）。

    1. 提及强制：用户输入提及某成员名 → 强制激活；命中成员排除上一位发言者
       （除非 allow_self_responses），与 ST 提及循环 `character.name === bannedUser`
       （group-chats.js:1259）一致。
    2. 概率激活：每个 talkativeness>0 的成员按 random()<=talkativeness 激活；
       排除上一位发言者（除非 allow_self_responses）；talkativeness=0 永不主动激活。
    3. 回退：无人激活 → 从 talkativeness>0 成员随机；再无 → 全体随机（仍回避 last）。
    4. follower 衰减：仅 palink-native 生效（st-compat 严格对齐 ST 1.18.0，
       ST 无 follower_members 概念，故忽略该字段，无衰减）。
    """
    if not members:
        return None
    allow_self = bool(getattr(group, "allow_self_responses", False))
    last = _get_last_group_speaker_id(db, group, members)
    follower_ids: set = set()
    if not _is_st_compat_mode(st_mode):
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

    # st-compat 模式对标 ST 1.18.0，其 group_activation_strategy 枚举仅定义
    # NATURAL=0/LIST=1/MANUAL=2/POOLED=3（见参考源
    # SillyTavern-1.18.0/.../public/scripts/group-chats.js:122），不含 4/5。
    # 4(TALKATIVE)/5(VOTING) 为 Palink 原生扩展，st-compat 收到时回退 NATURAL(0)
    # 属正确对齐行为（非缺口），并记 warning。
    st_mode = "palink-native"
    try:
        _us = req.db.query(UserSetting).filter(UserSetting.user_id == req.user.id).first()
        if _us is not None:
            st_mode = getattr(_us, "silly_tavern_mode", "palink-native") or "palink-native"
    except Exception as exc:
        logger.warning("UserSetting lookup failed for st_mode detection (group_id=%s): %s", req.group_id, exc)
    if _is_st_compat_mode(st_mode) and strategy in (_GROUP_ACTIVATION_TALKATIVE, _GROUP_ACTIVATION_VOTING):
        logger.warning(
            "st-compat mode does not support native group strategy %s; falling back to NATURAL(0) (group_id=%s)",
            strategy,
            req.group_id,
        )
        strategy = 0

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
                req.db, group, members, req.message or "", st_mode=st_mode
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


async def _assemble_roleplay_prompt_impl(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
) -> PromptAssemblyResult:
    """Actual prompt assembly implementation (called with model contextvar set)."""
    db = req.db
    user_nickname = req.user_nickname or req.user.username or "User"
    user_setting = db.query(UserSetting).filter(UserSetting.user_id == req.user.id).first()
    memory_mode = "disabled"
    if user_setting and user_setting.memory_mode:
        memory_mode = user_setting.memory_mode

    prompt_lang = user_setting.prompt_language if user_setting else "auto"
    system_prompt = deps.build_system_prompt(
        req.char,
        user_nickname,
        req.dialogue_mode or "first_person",
        prompt_lang,
        user_setting,
    )
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

    # Persona description injection (ST 1.18.0). When the active persona has
    # persona_show=True and a non-empty description, inject it into the prompt
    # according to persona_description_position:
    #   0 = in story (depth insertion, depth=4)
    #   1 = after post-history (append to system_prompt)
    #   2 = last in chat (append as final system message)
    #   3 = inactive (skip)
    persona_depth_entry: Optional[DepthInjection] = None
    persona_last_message: Optional[str] = None
    persona_full_text: Optional[str] = None  # st-compat 用: 完整 persona 文本 (ST 固定 Index 2)
    try:
        active_persona_id = getattr(user_setting, "active_persona_id", None) if user_setting else None
        if active_persona_id:
            active_persona = db.query(Persona).filter(
                Persona.id == active_persona_id,
                Persona.user_id == req.user.id,
            ).first()
        else:
            active_persona = None
        if active_persona is not None and active_persona.persona_show and (active_persona.description or "").strip():
            persona_text = f"[Persona: {active_persona.description.strip()}]"
            persona_position = 3
            pos_val = getattr(active_persona, "persona_description_position", None)
            if pos_val is not None:
                try:
                    persona_position = int(pos_val)
                except (TypeError, ValueError):
                    persona_position = 3
            if persona_position == 3:
                report.append(PromptAssemblyReportItem(
                    "persona_description",
                    "skipped",
                    "inactive (position=3)",
                ))
            elif persona_position == 0:
                # ST 对齐: 统一队列记录（depth=4, order=100）
                # Palink 特有映射: ST persona 走 prompt-order 固定槽，此处按
                # 数字前缀 key 置于 AN 之前（背景设定先于指令性内容）
                persona_depth_entry = DepthInjection(
                    depth=4,
                    content=persona_text,
                    role=_ROLE_NAME_TO_INT["system"],
                    source="persona_description",
                    sort_key=_KEY_PERSONA_DEPTH,
                )
                persona_full_text = persona_text
                report.append(PromptAssemblyReportItem(
                    "persona_description",
                    "included",
                    detail=f"position=0 (in-story); depth=4",
                    tokens_estimate=_estimate_tokens(persona_text),
                ))
            elif persona_position == 1:
                system_prompt = system_prompt + "\n\n" + persona_text
                persona_full_text = persona_text
                report.append(PromptAssemblyReportItem(
                    "persona_description",
                    "included",
                    detail=f"position=1 (after post-history); appended to system_prompt",
                    tokens_estimate=_estimate_tokens(persona_text),
                ))
            elif persona_position == 2:
                persona_last_message = persona_text
                persona_full_text = persona_text
                report.append(PromptAssemblyReportItem(
                    "persona_description",
                    "included",
                    detail=f"position=2 (last in chat); queued for message insertion",
                    tokens_estimate=_estimate_tokens(persona_text),
                ))
            else:
                report.append(PromptAssemblyReportItem(
                    "persona_description",
                    "skipped",
                    detail=f"unknown position={persona_position}",
                ))
        else:
            report.append(PromptAssemblyReportItem(
                "persona_description",
                "skipped",
                detail="no active persona / persona_show=False / empty description",
            ))
    except Exception as exc:
        logger.warning("Persona description injection lookup failed: %s", exc)
        report.append(PromptAssemblyReportItem(
            "persona_description",
            "skipped",
            detail=f"lookup_error: {exc}",
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
    # 注意：st-compat 路径使用 char_system_prompt（不是 system_prompt），所以
    #       prepend/append 到 system_prompt 对 st-compat 无效；st-compat 的
    #       IN_PROMPT/BEFORE_PROMPT 在 build_st_compat_messages 内部处理。
    ext_depth_entries: list[DepthInjection] = []  # IN_CHAT(1) 用 —— ST 对齐: 与世界书/AN/persona 统一队列
    ext_chat_messages: list[dict[str, str]] = []  # {"role": str, "content": str} — 保留以兼容引用，IN_CHAT 改走 ext_depth_entries
    ext_in_prompt_entries: list[tuple[str, str]] = []  # (content, role) for IN_PROMPT(0)
    ext_before_prompt_entries: list[tuple[str, str]] = []  # (content, role) for BEFORE_PROMPT(2)
    try:
        ext_prompts = _collect_extension_prompts(req)
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
                # 追加到 system prompt 末尾（不按 depth）
                # 暂存到 ext_in_prompt_entries，等 system_prompt 构建完成后追加
                ext_in_prompt_entries.append((content, role))
                report.append(PromptAssemblyReportItem(
                    "extension_prompt",
                    "included",
                    detail=f"identifier={identifier}; position=0 (IN_PROMPT, end of system prompt); role={role}",
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
    # ST 1.18.0 对齐: 分离 worldInfoBefore (pos=0) 和 worldInfoAfter (pos=1)
    st_wi_before_parts: list[str] = []
    st_wi_after_parts: list[str] = []
    # G4 修复: 分离 ANTop (pos=2) 和 ANBottom (pos=3)
    st_wi_an_top_parts: list[str] = []
    st_wi_an_bottom_parts: list[str] = []
    _part_count_before = len(dynamic_context_parts)
    _is_st_compat = bool(user_setting and _is_st_compat_mode(getattr(user_setting, "silly_tavern_mode", "")))
    # E-1 修复: 世界书扫描（N+1 查询 + token 编码）是纯同步重活，移入线程池，
    # 避免阻塞事件循环（与 persist_snapshot 的 to_thread 模式一致）。
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
        st_wi_before_parts=st_wi_before_parts,
        st_wi_after_parts=st_wi_after_parts,
        st_wi_an_top_parts=st_wi_an_top_parts,  # G4 修复
        st_wi_an_bottom_parts=st_wi_an_bottom_parts,  # G4 修复
        skip_dynamic_context=_is_st_compat,  # st-compat 模式下 worldbook 通过 ST 位置注入，不重复添加到 dynamic_context_parts
        char_name=_macro_char_name,
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
    await _append_memory_context(req, deps, memory_mode, dynamic_context_parts, report)
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
    _context_window_override = _get_openai_max_context_override(user_setting)
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
    # st-compat 路径在 build_st_compat_messages 内部已处理，并在分支内 clear() 此列表。
    # palink-native 路径在下方 messages 构建完成后注入（见 line ~3990 处）。

    # ST 1.18.0 extension_prompts BEFORE_PROMPT(2): 一次性 prepend 到 system_prompt 之前
    # 多条目按原序拼接（与 st-compat 路径的 "\n\n".join 行为一致），避免逐条 prepend 导致逆序。
    # 注意：st-compat 路径使用 char_system_prompt（不是 system_prompt），此 prepend 对 st-compat
    # 无效；st-compat 的 BEFORE_PROMPT 在 build_st_compat_messages 内部处理。
    if ext_before_prompt_entries:
        _ep_before_text = "\n\n".join(t for t, _ in ext_before_prompt_entries)
        system_prompt = _ep_before_text + "\n\n" + system_prompt

    # ST 1.18.0 兼容模式分支：silly_tavern_mode 为 "st-compat"/"compat" 时，
    # 使用 ST 的精确装配序（角色字段分离、无 Palink 特有内容）。
    st_mode = getattr(user_setting, "silly_tavern_mode", "palink-native") if user_setting else "palink-native"
    if _is_st_compat_mode(st_mode):
        # ST 1.18.0 对齐: 使用分离的世界书条目 (pos=0 → worldInfoBefore, pos=1 → worldInfoAfter)
        # 低危项修复: 条目间分隔符对齐 ST world-info.js:5146-5147（join('\n')，非 '\n\n'）
        world_info_before = "\n".join(st_wi_before_parts) if st_wi_before_parts else ""
        world_info_after = "\n".join(st_wi_after_parts) if st_wi_after_parts else ""
        # 角色卡 system_prompt 作为 ST 的 systemPromptOverride
        char_system_prompt = (req.char.system_prompt or "").strip() or None
        # D1 修复: st-compat 群聊时把发言者身份（group_profile_part）注入到 ST system prompt。
        # palink-native 模式已在上方 system_prompt 注入；此处补齐 st-compat 分支，避免成员身份丢失。
        if group_profile_part:
            char_system_prompt = (char_system_prompt or "") + "\n\n" + group_profile_part
        # Persona description (st-compat): ST 将 persona 固定在 Index 2 (personaDescription),
        # 无 persona_position 概念。因此始终注入完整 persona 文本, 避免 position==1 时丢失,
        # 且 position==3 (inactive) 时 persona_full_text 为 None 不注入。
        persona_desc = persona_full_text or ""
        # Author's note (G3 修复: 传递 position 给 build_st_compat_messages)
        an_text = author_note_text or ""
        # ST 1.18.0: depth only applies to IN_CHAT (position 1).
        an_depth = author_note_depth if author_note_position_int == 1 else 4

        # G7 修复: 检查 instruct 模板的 skip_examples 设置
        _st_instruct_tmpl = _load_instruct_template(db, user_setting, cache=req._cache)
        _st_skip_examples = bool(getattr(_st_instruct_tmpl, "skip_examples", False)) if _st_instruct_tmpl else False

        # D1 修复: jailbreak 合并逻辑 (ST 1.18.0 openai.js:1495-1506)
        # 优先级: 角色卡 jailbreak (高) → 用户全局 jailbreak (中) → context_template.jailbreak (低)
        char_jailbreak = (getattr(req.char, "jailbreak", None) or "").strip()
        # A-2 修复: 角色卡无独立 jailbreak 字段时以 PHI 兜底（V2 卡兼容，与
        # convert_chara_card_to_character 的 V2 回退语义一致）
        if not char_jailbreak:
            char_jailbreak = (getattr(req.char, "post_history_instructions", None) or "").strip()
        user_jailbreak = (getattr(user_setting, "jailbreak", None) or "").strip() if user_setting else ""
        # 读取 prefer_character_jailbreak (ST 1.18.0 power_user.prefer_character_jailbreak, 默认 True)
        prefer_char_jb = True
        if user_setting and user_setting.power_user:
            try:
                _pu = json.loads(user_setting.power_user) if isinstance(user_setting.power_user, str) else user_setting.power_user
                if isinstance(_pu, dict):
                    prefer_char_jb = _pu.get("prefer_character_jailbreak", True)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        # A-1 修复: forbid_overrides 守卫 (ST openai.js:1496-1504)。
        # 用户设置 extension_settings.system_prompt.forbid_overrides=true 时，
        # 角色卡 jailbreak 不得覆盖用户/模板配置（跳过 override 分支）。
        forbid_overrides = False
        if user_setting and user_setting.silly_tavern_settings:
            try:
                _st_raw = user_setting.silly_tavern_settings
                _st_data = json.loads(_st_raw) if isinstance(_st_raw, str) else _st_raw
                if isinstance(_st_data, dict):
                    _ext_sec = _st_data.get("extension_settings") or {}
                    if isinstance(_ext_sec, dict):
                        _sp_sec = _ext_sec.get("system_prompt") or {}
                        if isinstance(_sp_sec, dict):
                            forbid_overrides = bool(_sp_sec.get("forbid_overrides", False))
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        # A-1 修复: 对齐 ST PromptManager 的 prompt 禁用/守卫语义
        # (PromptManager.js:949-953 isPromptDisabledForActiveCharacter +
        # openai.js:1488/1498 systemPrompt.forbid_overrides !== true)。
        # 数据源: PromptPreset.prompt_disabled（禁用标识符数组）与
        # PromptPreset.entries（prompt 定义，含 identifier/forbid_overrides）。
        # 此前仅读 extension_settings.system_prompt.forbid_overrides（数据路径
        # 不存在 → 死代码），且缺 isPromptDisabledForActiveCharacter 分支。
        _prompt_disabled_ids: set[str] = set()
        _main_forbid = False
        _jb_forbid = False
        if prompt_preset is not None:
            try:
                _pd_raw = getattr(prompt_preset, "prompt_disabled", None)
                if _pd_raw:
                    _pd_list = json.loads(_pd_raw) if isinstance(_pd_raw, str) else _pd_raw
                    if isinstance(_pd_list, list):
                        _prompt_disabled_ids = {str(x) for x in _pd_list if x}
                _entries_raw = getattr(prompt_preset, "entries", None)
                if _entries_raw:
                    _entries_list = json.loads(_entries_raw) if isinstance(_entries_raw, str) else _entries_raw
                    if isinstance(_entries_list, list):
                        for _entry in _entries_list:
                            if not isinstance(_entry, dict):
                                continue
                            _id = str(_entry.get("identifier", "") or "")
                            if _id in ("main", "jailbreak") and _entry.get("forbid_overrides") is True:
                                if _id == "main":
                                    _main_forbid = True
                                else:
                                    _jb_forbid = True
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        # A-1: isPromptDisabledForActiveCharacter —— main/jailbreak 在
        # prompt_disabled 中时角色卡覆盖不生效（ST: promptOrderEntry.enabled=false）。
        _main_prompt_disabled = "main" in _prompt_disabled_ids
        _jb_prompt_disabled = "jailbreak" in _prompt_disabled_ids
        # main override (system_prompt_override) 禁用/守卫时不覆盖
        if (_main_prompt_disabled or _main_forbid) and char_system_prompt:
            report.append(
                PromptAssemblyReportItem(
                    "prompt_manager",
                    "skipped",
                    detail="main override disabled by prompt config (disabled/forbid_overrides)",
                )
            )
            char_system_prompt = None
        # A-2 修复: prefer=true 时用角色卡 jailbreak（含 PHI 兜底）；prefer=false 时
        # 仅用用户全局 jailbreak，不再向索引 11 注入 PHI（ST: 此时 jailbreak 槽为空或用户配置值）
        # A-1 修复: forbid_overrides=true 或 prompt 被禁用时跳过角色卡覆盖（与 ST 语义一致）
        use_char_jb = (
            prefer_char_jb
            and char_jailbreak
            and not forbid_overrides
            and not _jb_prompt_disabled
            and not _jb_forbid
        )
        jailbreak_for_st = char_jailbreak if use_char_jb else user_jailbreak

        # D2 修复: 读取 names_behavior (ST 1.18.0 oai_settings.names_behavior, 默认 0=DEFAULT)
        _names_behavior = 0
        _wi_format = ""  # D3 修复: wi_format (ST 1.18.0 oai_settings.wi_format, 默认空串)
        # D5/D6/D7 修复: 群聊 nudge + pin_examples + scenario/personality_format
        _pin_examples = False
        _scenario_format = "{{scenario}}"
        _personality_format = "{{personality}}"
        _new_group_chat_prompt = "[Start a new group chat. Group members: {{group}}]"
        # F2 修复: ST 1.18.0 默认 group_nudge_prompt (openai.js:114)。此前读错键名
        # group_nudge 且默认空串 → 群聊 nudge 从未生效。{{char}} 由 builder _sub 替换。
        _group_nudge = '[Write the next reply only as {{char}}.]'
        if user_setting and user_setting.silly_tavern_settings:
            try:
                _st_settings = json.loads(user_setting.silly_tavern_settings) if isinstance(user_setting.silly_tavern_settings, str) else user_setting.silly_tavern_settings
                if isinstance(_st_settings, dict):
                    _oai = _st_settings.get("oai_settings", {})
                    if isinstance(_oai, dict):
                        _names_behavior = int(_oai.get("names_behavior", 0))
                        _wi_format = _oai.get("wi_format", "") or ""
                        # A-7 修复: 用户显式设为空串表示禁用该字段，不得被 or 强转回默认值
                        _scenario_raw = _oai.get("scenario_format")
                        _scenario_format = _scenario_raw if isinstance(_scenario_raw, str) else "{{scenario}}"
                        _personality_raw = _oai.get("personality_format")
                        _personality_format = _personality_raw if isinstance(_personality_raw, str) else "{{personality}}"
                        _ngcp_raw = _oai.get("new_group_chat_prompt")
                        _new_group_chat_prompt = _ngcp_raw if isinstance(_ngcp_raw, str) else "[Start a new group chat. Group members: {{group}}]"
                        _group_nudge = _oai.get("group_nudge_prompt")
                        if not isinstance(_group_nudge, str):
                            _group_nudge = '[Write the next reply only as {{char}}.]'
                    # pin_examples 在 power_user 中
                    _pu = _st_settings.get("power_user", {})
                    if isinstance(_pu, dict):
                        _pin_examples = bool(_pu.get("pin_examples", False))
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        # C2 修复: 按 generation_mode 构建合并卡（APPEND=启用成员 / APPEND_DISABLED=含禁用成员），
        # 对齐 ST 1.18.0 combineGroupIntoSingleCard。仅在 APPEND/APPEND_DISABLED 模式生效；
        # SWAP(0) 时 group_combined_card 保持 None，builder 走单发言者卡逻辑。
        group_combined_card: Optional[dict] = None
        if req.group_id and group_generation_mode in (1, 2):
            try:
                _g_for_card = _cached_request_group(req, req.group_id)
                if _g_for_card is not None:
                    if group_generation_mode == 2:
                        _card_members = _load_all_members(db, _g_for_card)  # APPEND_DISABLED: 含禁用成员
                    else:
                        _card_members = _load_members(db, _g_for_card)  # APPEND: 仅启用成员
                    group_combined_card = _build_group_combined_card(_g_for_card, _card_members)
            except Exception as gcc_err:
                logger.warning("Failed to build group combined card (group_id=%s): %s", req.group_id, gcc_err)

        # ST 1.18.0 extension_prompts: 复用 palink-native 的收集逻辑（DB+req 合并 + filter 过滤）
        _st_ext_prompts = _collect_extension_prompts(req)
        # E-1 修复: st-compat 消息组装（token 编码 + 历史加载）为纯同步重活，
        # 移入线程池避免阻塞事件循环（与 _append_worldbook_context 一致）。
        messages = await asyncio.to_thread(
            build_st_compat_messages,
            db=db,
            char=req.char,
            user_nickname=user_nickname,
            session_id=req.session_id,
            branch_id=req.branch_id,
            message=req.message,
            images=req.images or [],
            system_prompt_override=char_system_prompt,
            world_info_before=world_info_before,
            world_info_after=world_info_after,
            persona_description=persona_desc,
            jailbreak=jailbreak_for_st,  # D1 修复: 不再硬编码空串
            authors_note=an_text if author_note_position_int != -1 else "",
            authors_note_depth=an_depth,
            authors_note_position=author_note_position_int,  # G3 修复
            dynamic_context_parts=dynamic_context_parts,
            prompt_lang=prompt_lang,
            user_setting=user_setting,
            _replace_placeholders=deps.replace_placeholders,
            _get_full_branch_history=deps.get_full_branch_history,
            _contains_chinese=deps.contains_chinese,
            normalize_image_url=lambda img_url, check_size=False: normalize_image_url(
                img_url, check_size=check_size, user_id=req.user.id,
            ),
            include_user_message=(req.include_user_message and not req.smart_card_trigger and not req.is_continue),
            token_budget=token_budget,
            context_template=context_template,
            recent_messages_budget=group_recent_budget,
            worldbook_depth_entries=depth_entries,
            worldbook_em_top=wb_em_top_entries,  # G5 修复
            worldbook_em_bottom=wb_em_bottom_entries,  # G5 修复
            skip_examples=_st_skip_examples,  # G7 修复
            worldbook_an_top=st_wi_an_top_parts,  # G4 修复
            worldbook_an_bottom=st_wi_an_bottom_parts,  # G4 修复
            # D2 修复: names_behavior 四态 + 群聊名字
            names_behavior=_names_behavior,
            is_group=bool(getattr(req, "group_id", None)),
            speaker_char=speaker_char,  # D3 修复: 群聊 {{char}} 绑定发言者
            user_name=req.user.username if req.user else "",
            narrator_type="narrator",
            # D3 修复: wi_format 包裹
            wi_format=_wi_format,
            # D5/D6/D7 修复: 群聊 nudge + pin_examples + scenario/personality_format
            pin_examples=_pin_examples,
            scenario_format=_scenario_format,
            personality_format=_personality_format,
            new_group_chat_prompt=_new_group_chat_prompt,
            group_nudge=_group_nudge,
            group_members=group_member_names,  # D4 修复: 启用成员名列表（None 时 builder 回退主角色名）
            # C1/C2 修复: 透传群生成模式与合并卡，对齐 ST 三模式
            generation_mode=group_generation_mode,
            group_combined_card=group_combined_card,
            extension_prompts=_st_ext_prompts,
            message_order=req.message_order,  # Task 7: generate_interceptor 消息重排
            excluded_message_ids=req.excluded_message_ids,  # P0-3: interceptor 消息排除
            generation_type=getattr(req, "generation_type", None),  # A-8 修复: impersonate 豁免 group nudge
        )
        report.append(PromptAssemblyReportItem("message_builder", "included", detail=f"st-compat; messages={len(messages)}"))
        # ST-compat 已在 build_st_compat_messages 内部处理所有注入（世界书 depth、作者备注、Persona），
        # 清空这些条目避免外层 _insert_depth_prompt 重复注入 (G1/G2 修复)
        depth_entries.clear()
        author_note_depth_entry = None  # G1: 防止作者备注双重注入
        persona_depth_entry = None  # G2: 防止 Persona 双重注入
        persona_last_message = None  # G2: 防止 Persona 双重注入
        # st-compat 路径已在 build_st_compat_messages 内部完成 extension_prompts 四态注入，
        # 清空共享段的 ext_depth_entries / ext_chat_messages / ext_in_prompt_entries / ext_before_prompt_entries
        # 避免下方 3342/3360/3178/3187 重复注入
        ext_depth_entries.clear()
        ext_chat_messages.clear()
        ext_in_prompt_entries.clear()
        ext_before_prompt_entries.clear()
    else:
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
        )
        report.append(PromptAssemblyReportItem("message_builder", "included", detail=f"messages={len(messages)}"))

    # P1-1 修复: palink-native 路径下，当 prompt_preset.prompt_order 包含角色卡字段
    # 标识符（charDescription/charPersonality/scenario）时，把这些字段抽取为独立
    # system 消息插入 messages 数组首位（紧跟 system_prompt 之后），使其可被
    # _apply_full_prompt_order 按 prompt_order 重排。st-compat 路径已内置分离装配，
    # _extract_char_field_messages_for_order 返回空列表，不影响其行为。
    if not _is_st_compat_mode(st_mode):
        _char_field_msgs = _extract_char_field_messages_for_order(
            req, prompt_preset, st_mode, _macro_char_name,
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

    # ── ST 1.18.0 extension_prompts IN_PROMPT(0) palink-native 注入 ──
    # 对齐 ST openai.js position='end'（system prompt 末尾）语义：追加到
    # messages[0]（system 消息）文本末尾。st-compat 路径已 clear() 此列表，
    # 不会重复注入。
    # [INJ-CLOSE-TAG-GUARD] 修复（2026-08-19 实证）：此前实现是"作为独立消息
    # append 到 messages 末尾"，把 system 注入放到 prompt 最后一条（紧贴模型
    # 续写位置）。前端插件（对话渲染系统 v7.1）经 setExtensionPrompt(position=0)
    # 注入格式规则即走此路径，实测 deepseek-v4-flash 100% 空响应（立刻 EOS
    # completion_tokens=1，或把剧情正文写进 reasoning 不写 content，用户侧表现
    # 为第二轮对话 100% 思维链乱码且正文不输出）。对照实验（各 3 次）：
    # append 末尾 0/3，追加到 system prompt 末尾 3/3 正常。
    if ext_in_prompt_entries:
        for _ep_content, _ep_role in ext_in_prompt_entries:
            _inserted = False
            if messages and messages[0].get("role") == "system" and isinstance(messages[0].get("content"), str):
                messages[0] = {
                    **messages[0],
                    "content": (messages[0].get("content") or "") + "\n\n" + _ep_content,
                }
                _inserted = True
            if not _inserted:
                # messages[0] 非 system 或 content 非 str（多模态）：插到最前，
                # 仍避免落到 prompt 末尾（末尾 system 注入会诱发空响应）。
                messages.insert(0, {"role": _ep_role, "content": _ep_content})
            report.append(
                PromptAssemblyReportItem(
                    "extension_prompt_in_prompt",
                    "included",
                    detail=f"appended to system prompt (role={_ep_role})",
                    tokens_estimate=_estimate_tokens(_ep_content),
                )
            )

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
        messages = deps.apply_prompt_regex_to_messages(messages, db, req.char, user_nickname, user_id=req.user.id if req.user else None)
        report.append(PromptAssemblyReportItem("prompt_regex", "included"))
    else:
        report.append(PromptAssemblyReportItem("prompt_regex", "skipped"))

    # ── 状态栏指令已整体移除（2026-08-18）──
    # Palink 原生 <status> 状态栏指令注入（含 user tail / system prompt / 探测保存）
    # 已全部删除：与 MVU 卡的 <UpdateVariable> 指令冲突，导致 AI 输出 <status>
    # 而 MVU 引擎不认 → stat_data 永不更新。保留 status_bar_detector 的剥离函数
    # （strip_and_parse_status_marker）仅作历史残留标签清理，不再注入任何指令。

    # ── MVU 变量更新指令（user tail 注入，2026-08-18）──
    # MVU 卡（酒馆助手体系）的"变量输出格式"指令位于 worldbook 拼接消息的中间
    # 偏后（实测：13KB 消息 @8813，其后还有 ~4.7KB 场景描述），模型注意力常无法
    # 覆盖 → AI 不输出 <UpdateVariable> → stat_data 永不更新 → 面板恒显示初始值。
    # 参考此前 status_bar_user_tail 验证过的策略：推理模型对最近一条 user 消息
    # 末尾的指令遵循度最高，因此把精简的变量更新指令贴到最后一条 user 消息末尾
    # （仅 MVU 卡注入；格式与 worldbook 的 <UpdateVariable> 一致，双保险不冲突）。
    try:
        from ..services.status_bar_detector import _card_has_mvu_scripts
        if _card_has_mvu_scripts(req.char):
            _mvu_instr = (
                "\n\n【变量更新指令 - 强制，不可省略】\n"
                "本卡使用 <UpdateVariable> 变量系统。你必须在【每条回复的最末尾】"
                "用 <UpdateVariable> 标签输出本次剧情引起的变量变化，格式：\n"
                "<UpdateVariable>\n"
                "<Analysis>（英文，80 词以内：时间流逝计算、是否允许戏剧性更新、"
                "逐字段对照 check 规则分析）</Analysis>\n"
                "<JSONPatch>\n"
                '[{"op":"delta","path":"/桃汐/好感度","value":5},'
                '{"op":"replace","path":"/世界信息/日期时间","value":"2026年08月18日 09:00"}]\n'
                "</JSONPatch>\n"
                "</UpdateVariable>\n"
                "规则：\n"
                "- 支持操作：replace / delta / insert / remove / move（RFC 6902）\n"
                "- path 格式：/角色名/字段名（如 /桃汐/好感度、/世界信息/日期时间）\n"
                "- 以 _ 开头的字段为只读，禁止更新；未变化的字段不要输出\n"
                "- 【必须完整】所有因本回合剧情而变化的字段都要输出——包括角色的"
                "好感度、关系、性欲值、服饰、内心想法、发情期等，不能只更新世界信息\n"
                "- 【严格禁止】把变量状态（日期时间、天气、数值等）写进回复正文，"
                "正文只写剧情对话；变量只通过 <UpdateVariable> 输出\n"
                "- 此标签不受「禁止 XML 标签」规则限制\n"
            )
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
        else:
            report.append(PromptAssemblyReportItem("mvu_user_tail", "skipped", "not an MVU card"))
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
    prompt_sources = _collect_prompt_sources(messages, req.char) if not _is_st_compat_mode(st_mode) else []
    # Task 3.5.2: apply full prompt_order reordering when a preset with
    # prompt_order is bound. This reorders the actual messages array (not
    # just dynamic_context_parts) by their ST 1.18.0 prompt identifier.
    # G12 修复: st-compat 跳过重排，装配序已由 builder 固定。
    if prompt_preset is not None and not _is_st_compat_mode(st_mode):
        messages, prompt_sources = _apply_full_prompt_order(
            messages, prompt_sources, prompt_preset, report
        )
    # Task 3.5.3: dynamically trim low-priority sources when over budget.
    # Uses the token budget computed from the model's context window
    # (Task 3.5.1). Non-trimmable sources (system_prompt, recent messages,
    # user message) are always retained.
    # G8/G12 修复: st-compat 跳过基于标识符的裁剪和重排，
    # 因为其装配序已由 builder 固定，分类器无法正确识别 ST 标记。
    # D4 修复: st-compat 启用 chat_history token 裁剪子集。
    if not _is_st_compat_mode(st_mode):
        messages, total_tokens_estimate = _apply_dynamic_trimming(
            messages, prompt_sources, token_budget, report
        )
    else:
        # st-compat: 仅对 chat_history 做按 token 裁剪，保留强制项
        # D6/A-10 修复: 传入 pin_examples 控制示例/历史预算竞争
        messages = _apply_st_compat_history_trim(messages, token_budget, report, pin_examples=_pin_examples)
        # A-11: 剥离 builder 打标的 _st_trailing_guard 内部字段（仅供 trim 识别
        # 末尾强制项，不得进入 API 请求体）
        for _m in messages:
            if isinstance(_m, dict) and "_st_trailing_guard" in _m:
                _m.pop("_st_trailing_guard", None)
        total_tokens_estimate = sum(_estimate_tokens(str(m.get("content", ""))) for m in messages)

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
        sys_prompt = (instruct_template.system_prompt or "").strip()
        if sys_prompt:
            if messages and messages[0].get("role") == "system":
                existing = messages[0].get("content", "")
                if isinstance(existing, str):
                    messages[0] = {**messages[0], "content": f"{sys_prompt}\n\n{existing}"}
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
    st_wi_before_parts: Optional[list[str]] = None,
    st_wi_after_parts: Optional[list[str]] = None,
    st_wi_an_top_parts: Optional[list[str]] = None,  # G4 修复: ANTop (pos=2)
    st_wi_an_bottom_parts: Optional[list[str]] = None,  # G4 修复: ANBottom (pos=3)
    skip_dynamic_context: bool = False,  # st-compat 模式下跳过 dynamic_context_parts 注入
    char_name: str = "",  # 角色名（用于正则宏替换）
) -> None:
    """注入世界书上下文到 prompt 中。

    ST 1.18.0 对齐: 把 wb_result 的 8 个 position 全部传出去:
    - position 0-3 → dynamic_context_parts (wb_result.text) [skip_dynamic_context=True 时跳过]
    - position 4 (atDepth) → depth_entries
    - position 5 (EMTop) → em_top_entries (经 {{mesExamples}} 宏注入)
    - position 6 (EMBottom) → em_bottom_entries (经 {{mesExamples}} 宏注入)
    - position 7 (outlet) → outlet_entries (经 {{outlet::name}} 宏注入)

    st-compat 模式下应设置 skip_dynamic_context=True，worldbook 内容通过
    st_wi_before_parts/st_wi_after_parts/depth_entries 等 ST 位置注入，
    避免与 dynamic_context_parts 重复。

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
        recent_msgs = [{"role": m.role, "content": m.content} for m in recent_for_wb]
        if req.is_init:
            recent_msgs = [{"role": "user", "content": req.message or ""}]
        elif req.message and not req.smart_card_trigger and not req.is_continue:
            recent_msgs.append({"role": "user", "content": req.message})

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
        group_chars_arg = None
        if req.group_id and _g_mode is not None and group_wi_strategy in ("all", "group"):
            try:
                _enabled = _load_members(db, _g_mode)
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
        )
        if wb_result.text:
            wb_text = wb_result.text
            wb_text = deps.apply_plugin_regex_scripts(
                wb_text,
                req.db,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                is_prompt=False,
                depth=0,
                skip_extensions=req.char.extensions,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
                # P2-9 修复: 透传 user_id 以读取 extension_settings.regex_scripts
                user_id=req.user.id if req.user else None,
            )
            wb_text = deps.apply_regex_scripts(
                wb_text,
                req.char.extensions,
                placement=REGEX_PLACEMENT_WORLD_INFO,
                is_markdown=False,
                is_prompt=False,
                depth=0,
                user_name=user_nickname,
                char_name=char_name or (req.char.name or "Character"),
            )
            wb_text = deps.replace_placeholders(wb_text, user_nickname, req.char.name or "")
            if not skip_dynamic_context:
                dynamic_context_parts.append(wb_text)
            report.append(
                PromptAssemblyReportItem(
                    "worldbook",
                    "included",
                    detail=f"entries={len([r for r in wb_result.debug_report if r.status == 'activated'])}",
                    tokens_estimate=wb_result.total_tokens,
                )
            )
            # Merge worldbook debug report
            for r in wb_result.debug_report:
                report.append(
                    PromptAssemblyReportItem(
                        f"worldbook_entry_{r.entry_id}",
                        r.status,
                        detail=f"title={r.title}; reason={r.reason}; keywords={r.matched_keywords}",
                        tokens_estimate=r.tokens_estimate,
                    )
                )
            # ST 1.18.0 对齐: 分离 worldInfoBefore (pos=0) 和 worldInfoAfter (pos=1)
            if st_wi_before_parts is not None:
                for content in wb_result.entries_by_position.get(0, []):
                    st_wi_before_parts.append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
                        )
                    )
            if st_wi_after_parts is not None:
                for content in wb_result.entries_by_position.get(1, []):
                    st_wi_after_parts.append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
                        )
                    )
            # G4 修复: 分离 ANTop (pos=2) 和 ANBottom (pos=3)
            if st_wi_an_top_parts is not None:
                for content in wb_result.entries_by_position.get(2, []):
                    st_wi_an_top_parts.append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
                        )
                    )
            if st_wi_an_bottom_parts is not None:
                for content in wb_result.entries_by_position.get(3, []):
                    st_wi_an_bottom_parts.append(
                        balance_custom_tags(
                            deps.replace_placeholders(content, user_nickname, req.char.name or "")
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
        else:
            report.append(PromptAssemblyReportItem("worldbook", "skipped", "no matched entries"))
        nested.commit()
    except Exception as exc:
        logger.warning("World book context injection failed: %s", exc)
        if nested is not None:
            try:
                nested.rollback()
            except Exception:
                try:
                    req.db.rollback()
                except Exception:
                    pass
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
        if nested is not None:
            try:
                nested.rollback()
            except Exception:
                try:
                    req.db.rollback()
                except Exception:
                    pass
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
    except Exception:
        # 探测失败不阻塞正常记忆流程
        active = False
    _ST_VEC_YIELD_CACHE[user_id] = (now, active)
    return active


async def _append_memory_context(
    req: PromptAssemblyRequest,
    deps: PromptAssemblyDeps,
    memory_mode: str,
    dynamic_context_parts: list[str],
    report: list[PromptAssemblyReportItem],
) -> None:
    user_nickname = req.user_nickname or req.user.username or "User"
    if memory_mode == "disabled" or req.is_init:
        report.append(PromptAssemblyReportItem("memory", "skipped", memory_mode))
        return

    # ST 向量插件活跃 → Palink 记忆自动让步
    if _st_vector_data_active(req.db, req.user.id):
        report.append(
            PromptAssemblyReportItem(
                "memory", "skipped", "yielded to ST vector storage (st-vec:: active)"
            )
        )
        return

    nested = None
    try:
        nested = req.db.begin_nested()
        mem_svc = MemoryService(req.db)
        if mem_svc.is_available():
            ancestor_branch_ids = deps.get_ancestor_branch_ids(req.db, req.session_id, req.branch_id) if req.branch_id else []
            mem_ctx = await mem_svc.get_context(
                user_id=req.user.id,
                query=req.smart_card_context if req.smart_card_trigger else req.message,
                session_id=req.session_id,
                max_tokens=1500,
                branch_ids=ancestor_branch_ids if ancestor_branch_ids else None,
                memory_mode=memory_mode,
            )
            if mem_ctx and mem_ctx.memories:
                memory_text = build_memory_context(mem_ctx, max_tokens=1500)
                if memory_text:
                    memory_text = deps.replace_placeholders(memory_text, user_nickname, req.char.name or "")
                    dynamic_context_parts.append(memory_text)
                    report.append(
                        PromptAssemblyReportItem(
                            "memory",
                            "included",
                            detail=f"mode={memory_mode}",
                            tokens_estimate=_estimate_tokens(memory_text),
                        )
                    )
                else:
                    report.append(PromptAssemblyReportItem("memory", "skipped", "empty context"))
            else:
                report.append(PromptAssemblyReportItem("memory", "skipped", "no memories"))
        else:
            report.append(PromptAssemblyReportItem("memory", "skipped", "service unavailable"))
        nested.commit()
    except Exception as exc:
        logger.warning("Memory context retrieval failed: %s", exc)
        if nested is not None:
            try:
                nested.rollback()
            except Exception:
                try:
                    req.db.rollback()
                except Exception:
                    pass
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
    同 (depth, order, role) 的多条合并为单条消息 join('\\n')。
    语义对齐 ST openai.js populationInjectionPrompts / script.js doChatInject /
    getExtensionPrompt（详见 DepthInjection 处常量区注释）。
    """
    user_nickname = req.user_nickname or req.user.username or "User"
    next_messages = list(messages)
    inserted_any = False

    records: list[DepthInjection] = list(depth_entries or [])

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
            insert_index = max(0, len(next_messages) - head.depth)
            next_messages.insert(insert_index, {"role": _ROLE_INT_TO_NAME.get(head.role, "system"), "content": merged_content})
            inserted_any = True
            i = j

    if not inserted_any:
        report.append(PromptAssemblyReportItem("depth_prompt", "skipped"))

    return next_messages
