"""
角色聊天消息构建器 - 稳定前缀优先的提示词结构

方向声明: 项目当前主攻 `build_character_chat_messages`（palink-native 装配）。
`build_st_compat_messages`（st-compat 模式）已封存冷处理、待删除，除非用户
明确要求不要优化它。详见根目录 AGENTS.md。
"""
import json
import re
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from ..models import Character, CharacterChatMessage, UserSetting
from ..core import settings


def parse_system_commands(text: str) -> Tuple[str, List[str]]:
    """
    解析 @...@ 格式的系统指令
    返回: (清理后的文本, 系统指令列表)
    """
    commands = []
    # 匹配 @content@ 格式
    pattern = r'@([^@]+?)@'
    
    def extract_command(match):
        cmd = match.group(1).strip()
        if cmd:
            commands.append(cmd)
        return ''
    
    cleaned_text = re.sub(pattern, extract_command, text)
    # 清理多余空格
    cleaned_text = re.sub(r'\s+', ' ', cleaned_text).strip()
    
    return cleaned_text, commands


_SMART_CARD_LAUNCH_LINE_PATTERNS = [
    re.compile(r"^\s*\u8bf7\u6839\u636e\u4ee5\u4e0a\u8bbe\u5b9a\u5f00\u59cb\u6e38\u620f[\u3002.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*\u6839\u636e\u4ee5\u4e0a\u8bbe\u5b9a\u5f00\u59cb\u6e38\u620f[\u3002.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*\u5f00\u59cb\u6e38\u620f[\u3002.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*\u8bf7\u5f00\u59cb\u6e38\u620f[\u3002.!！?？]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*please\s+(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!?]*\s*$", re.IGNORECASE),
    re.compile(r"^\s*(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!?]*\s*$", re.IGNORECASE),
]


def clean_smart_card_trigger_context(text: str) -> str:
    """Remove UI-only launch phrases from smart-card generated context."""
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept_lines = [
        line for line in lines
        if not any(pattern.match(line) for pattern in _SMART_CARD_LAUNCH_LINE_PATTERNS)
    ]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()


def is_smart_card_trigger_message(text: str) -> bool:
    """Return True for legacy user messages saved from smart-card launch buttons."""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return clean_smart_card_trigger_context(text) != normalized


def clean_display_markup_for_prompt(text: str) -> str:
    """Remove SillyTavern display-only HTML that may have been stored by older builds."""
    value = str(text or "")
    value = re.sub(r"<style\b[^>]*>[\s\S]*?</style\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<script\b[^>]*>[\s\S]*?</script\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<palink-html>[\s\S]*?</palink-html>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"```html\s*[\s\S]*?```", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"</(?:p|div|section|article|li|tr|h[1-6])\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    value = re.sub(r"[ \t]{2,}", " ", value)
    return value.strip()


def build_character_chat_messages(
    db: Session,
    char: Character,
    user_nickname: str,
    session_id: str,
    branch_id: str,
    message: str,
    images: List[str],
    system_prompt: str,
    dynamic_context_parts: List[str],
    prompt_lang: str,
    user_setting: Optional[UserSetting],
    _replace_placeholders: callable,
    _get_full_branch_history: callable,
    _contains_chinese: callable,
    normalize_image_url: callable,
    include_user_message: bool = True,
    include_title_instruction: bool = False,
    context_template: Optional[Any] = None,
    recent_messages_budget: Optional[int] = None,
    # D3 修复: 群聊当前发言者角色（绑定 {{char}}）
    speaker_char: Optional[Character] = None,
    is_group: bool = False,
    # D2 修复: 群聊历史消息按发言者名归属（与 st-compat DEFAULT names_behavior 对齐）
    user_name: str = "",
    # Task 7: ST generate_interceptor 消息重排同步。
    # 前端 ST 扩展（如 vectors_rearrangeChat）重排后的消息 ID 顺序（字符串）。
    # 非空时按此顺序重排从 DB 加载的 history，空列表表示使用默认 created_at 顺序。
    message_order: Optional[List[str]] = None,
    # P0-3: ST generate_interceptor 消息排除同步。前端拦截器 splice 掉的消息 ID，
    # 装配时从 history 中排除（仅影响本次 prompt，不改动 DB）。
    excluded_message_ids: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    构建角色聊天消息列表。

    顺序：稳定角色提示词 -> 示例 -> 历史 -> 历史后指令 -> 动态上下文 -> 用户系统指令 -> 当前用户消息 -> 最终提醒。

    当传入 context_template（ST 1.18.0 上下文模板）且模板名称不为 "Default" 时，
    会用模板字段包装现有输出，但不会改变核心消息组装顺序：
      - 模板的 system_prompt（若有）作为前置 system 消息插入
      - 模板的 jailbreak（若有）作为后置 system 消息插入
      - 模板的 chat_start（若有）作为分隔标记插入到首条 user/assistant 消息之前
    Default 模板（或缺省）保持原有行为，确保向后兼容。

    recent_messages_budget：群聊专用消息预算，仅保留最近 N 条消息用于上下文。
    当为 None 或 <=0 时回退到全局 CHARACTER_CHAT_HISTORY_LIMIT（单聊行为不变）。
    """
    # 解析系统指令
    cleaned_message, system_commands = parse_system_commands(message)

    # 群聊消息预算：仅当 recent_messages_budget 为正整数时覆盖全局历史限制，
    # 否则保持单聊原有的 CHARACTER_CHAT_HISTORY_LIMIT 行为。
    history_limit = (
        recent_messages_budget
        if (isinstance(recent_messages_budget, int) and recent_messages_budget > 0)
        else settings.CHARACTER_CHAT_HISTORY_LIMIT
    )

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]

    # D3 修复: 群聊时 {{char}} 绑定到当前发言者
    _char_name_for_sub = (speaker_char.name if (is_group and speaker_char is not None) else char.name) or ""

    if char.mes_example:
        messages.append({
            "role": "system",
            "content": f"Example dialogue:\n{_replace_placeholders(char.mes_example, user_nickname, _char_name_for_sub)}",
        })

    if branch_id:
        history = _get_full_branch_history(
            db,
            session_id,
            branch_id,
            limit=history_limit,
        )
    else:
        history = (
            db.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session_id,
                CharacterChatMessage.branch_id == None,
            )
            .order_by(CharacterChatMessage.created_at.desc())
            .limit(history_limit)
            .all()[::-1]
        )

    # P1-6 修复: 装配路径过滤 is_hidden 消息（对齐 ST prompt 整理时跳过隐藏消息）
    # is_hidden=True 的消息仍会通过 _get_full_branch_history 返回给前端显示，
    # 但不会进入 LLM 装配。参考: ST 1.18.0 prompt-manager.js filterHiddenMessages
    history = [m for m in history if not getattr(m, "is_hidden", False)]

    # P0-3: ST generate_interceptor 消息排除同步（前端拦截器 splice 删除的消息）。
    if excluded_message_ids:
        _excluded = {str(mid) for mid in excluded_message_ids}
        history = [m for m in history if str(getattr(m, "id", "")) not in _excluded]

    # Task 7: ST generate_interceptor 消息重排同步。
    # 前端 ST 扩展（如 vectors_rearrangeChat）重排 window.chat 后，将重排后的
    # 消息 ID 顺序通过 message_order 传递。此处按该顺序重排 history，使后端
    # 装配的 prompt 与前端重排结果一致。未出现在 message_order 中的消息保持
    # 原相对顺序（Python sort 稳定，sentinel 为 inf）。
    if message_order:
        _order_index = {str(mid): i for i, mid in enumerate(message_order)}
        history.sort(key=lambda m: _order_index.get(str(getattr(m, "id", "")), len(_order_index)))

    legacy_smart_card_contexts = set()
    for m in history:
        # ST 1.18.0 IGNORE_SYMBOL 对齐: 跳过 extra.ignore=true 的消息
        # Palink 用 boolean 字段 extra.ignore 替代 Symbol.for('ignore')
        # 参考 ST 1.18.0 prepareOpenAIMessages/history 滤除 isIgnore 标记
        try:
            m_extra_raw = getattr(m, "extra", None)
            if m_extra_raw:
                m_extra = json.loads(m_extra_raw) if isinstance(m_extra_raw, str) else m_extra_raw
                if isinstance(m_extra, dict) and m_extra.get("ignore") is True:
                    continue
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        msg_content = m.content
        if m.role == "user" and is_smart_card_trigger_message(msg_content):
            legacy_context = clean_smart_card_trigger_context(msg_content)
            if legacy_context and legacy_context not in legacy_smart_card_contexts:
                legacy_smart_card_contexts.add(legacy_context)
                messages.append({
                    "role": "system",
                    "content": "[Smart card selected start context]\n" + legacy_context,
                })
            continue
        if m.role == "assistant":
            msg_content = strip_inline_think(msg_content).strip()
            msg_content = clean_display_markup_for_prompt(msg_content)
            if not msg_content:
                msg_content = m.content
        # D2 修复: 群聊历史消息按发言者名归属（"Name: content"），与 st-compat
        # DEFAULT names_behavior 对齐；用户消息（msg_name==user_name）不加前缀。
        if is_group and m.role != "user":
            _m_name = getattr(m, "name", None) or ""
            if _m_name and _m_name != user_name:
                msg_content = f"{_m_name}: {msg_content}"
        messages.append({"role": m.role, "content": msg_content})

    if char.post_history_instructions and char.post_history_instructions.strip():
        phi_text = _replace_placeholders(char.post_history_instructions, user_nickname, _char_name_for_sub)
        messages.append({"role": "system", "content": phi_text})

    if images and include_user_message:
        content_payload = [{"type": "text", "text": cleaned_message}]
        for img_url in images:
            normalized_img_url = normalize_image_url(img_url, check_size=True)
            content_payload.append({
                "type": "image_url",
                "image_url": {"url": normalized_img_url},
            })
        user_msg = {"role": "user", "content": content_payload}
    else:
        user_msg = {"role": "user", "content": cleaned_message}

    is_zh = prompt_lang == "zh" or (prompt_lang == "auto" and _contains_chinese((char.name or "") + (char.description or "")))
    personality_summary = (char.personality or "").strip()[:200]

    dynamic_parts = [part for part in dynamic_context_parts if part]
    if personality_summary:
        if is_zh:
            dynamic_parts.append(f"【角色校准】你是{char.name or '角色'}。将当前局势融入回复，但语气、价值观和反应方式必须持续贴合角色性格：{personality_summary}")
        else:
            dynamic_parts.append(f"[Character Calibration] You are {char.name or 'the character'}. Integrate the current situation, but keep voice, values, and reactions aligned with this personality: {personality_summary}")

    if dynamic_parts:
        messages.append({"role": "system", "content": "\n\n".join(dynamic_parts)})

    # 添加用户系统指令
    if system_commands:
        is_zh = prompt_lang == "zh" or (prompt_lang == "auto" and _contains_chinese((char.name or "") + (char.description or "")))
        for cmd in system_commands:
            if is_zh:
                messages.append({"role": "system", "content": f"【用户系统指令】{cmd}"})
            else:
                messages.append({"role": "system", "content": f"[User System Instruction] {cmd}"})

    if include_user_message:
        messages.append(user_msg)

    if include_title_instruction:
        if is_zh:
            messages.append({"role": "system", "content": "请在回复末尾用 [标题: 11个字概括本次对话] 的格式输出一个简短的标题。"})
        else:
            messages.append({"role": "system", "content": "Please include a brief title at the end of your response in the format [Title: 11-character summary of this conversation]."})

    if is_zh:
        final_reminder = f"""【最后提醒】
1. 只以{char.name or '角色'}的身份回复，不要自称AI或助手
2. 不要复述角色卡；用措辞、动作、情绪和选择体现角色"""
    else:
        final_reminder = f"""[Final Reminder]
1. Respond only as {char.name or 'the character'}, never as an AI or assistant
2. Do not recite the character card; embody it through wording, actions, emotions, and choices"""

    # 状态栏探测 / 提醒分支已整体移除（2026-08-18）：Palink 原生 <status> 状态栏
    # 系统删除，不再注入探测指令与状态栏提醒（与 MVU 卡 <UpdateVariable> 冲突）。

    messages.append({"role": "system", "content": final_reminder})

    # ST 1.18.0 context template wrapping — applied after the existing
    # message assembly so the original Palink prompt structure is preserved.
    # The Default template (and missing template) is a passthrough.
    messages = _apply_context_template(
        messages,
        context_template=context_template,
        char_name=char.name or "",
        user_name=user_nickname,
        replace_placeholders=_replace_placeholders,
    )

    return messages


def _apply_context_template(
    messages: List[Dict[str, Any]],
    *,
    context_template: Optional[Any],
    char_name: str,
    user_name: str,
    replace_placeholders: callable,
) -> List[Dict[str, Any]]:
    """Wrap the assembled messages with context template fields.

    Backward-compatibility contract:
      - context_template is None → passthrough (unchanged)
      - context_template.name == "Default" → passthrough (unchanged)
      - otherwise:
          * template.system_prompt (if non-empty) is inserted as a leading
            system message (after macro placeholder replacement)
          * template.jailbreak (if non-empty) is inserted as a system
            message immediately after the first system message
          * template.chat_start (if non-empty) is inserted as a system
            separator just before the first user/assistant message
    """
    if context_template is None:
        return messages
    tmpl_name = getattr(context_template, "name", None)
    if not tmpl_name or tmpl_name == "Default":
        return messages

    next_messages: List[Dict[str, Any]] = list(messages)

    tmpl_system_prompt = (getattr(context_template, "system_prompt", None) or "").strip()
    tmpl_jailbreak = (getattr(context_template, "jailbreak", None) or "").strip()
    tmpl_chat_start = (getattr(context_template, "chat_start", None) or "").strip()

    # 1) Prepend template.system_prompt as the very first system message.
    if tmpl_system_prompt:
        rendered = replace_placeholders(tmpl_system_prompt, user_name, char_name)
        # Insert after the existing first system message so the original
        # system_prompt remains the primary "story" content.
        insert_at = 1 if (next_messages and next_messages[0].get("role") == "system") else 0
        next_messages.insert(insert_at, {"role": "system", "content": rendered})

    # 2) Insert jailbreak as a system message after the leading system block.
    if tmpl_jailbreak:
        rendered_jb = replace_placeholders(tmpl_jailbreak, user_name, char_name)
        # Find the index after the last leading system message.
        insert_at = 0
        for idx, m in enumerate(next_messages):
            if m.get("role") == "system":
                insert_at = idx + 1
            else:
                break
        next_messages.insert(insert_at, {"role": "system", "content": rendered_jb})

    # 3) Insert chat_start separator before the first user/assistant message.
    if tmpl_chat_start:
        for idx, m in enumerate(next_messages):
            if m.get("role") in ("user", "assistant"):
                next_messages.insert(idx, {"role": "system", "content": tmpl_chat_start})
                break

    return next_messages


# ---------------------------------------------------------------------------
# ST 1.18.0 兼容消息构建器
# ---------------------------------------------------------------------------

# ST 1.18.0 默认 main prompt（openai.js:101 / PromptManager.js:2007）
_ST_DEFAULT_MAIN_PROMPT = (
    "Write {{char}}'s next reply in a fictional chat between "
    "{{charIfNotGroup}} and {{user}}."
)

# ST 1.18.0 默认标记（openai.js:107-109）
_ST_DEFAULT_NEW_CHAT_PROMPT = "[Start a new Chat]"
_ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT = "[Example Chat]"


def _sanitize_name(name: str) -> str:
    """ST 1.18.0 PromptManager.sanitizeName (PromptManager.js:1342-1350).

    A-4 修复: 合法名（/^[a-zA-Z0-9_]{1,64}$/）原样保留；非法名才替换非字母数字为 _，
    且结果截断到 64 字符（OpenAI API name 字段限制）。
    """
    if not name:
        return ""
    import re as _re
    if _re.fullmatch(r'[a-zA-Z0-9_]{1,64}', name):
        return name
    return _re.sub(r'[^a-zA-Z0-9_]', '_', name)[:64]


def _apply_wi_format(content: str, wi_format: str) -> str:
    """ST 1.18.0 formatWorldInfo (openai.js:780-792).

    空 format 返回原值，否则用 wi_format.replace("{0}", content) 包裹。
    """
    if not content:
        return ""
    if not wi_format or not wi_format.strip():
        return content
    return wi_format.replace("{0}", content)


def _apply_field_format(text: str, fmt: str, placeholder: str, sub_func) -> str:
    """D7 修复: ST 1.18.0 scenario_format / personality_format (openai.js:1359-1360).

    A-7 修复: 空 fmt 时 ST 返回字段原值（``scenario && scenario_format ? ... : scenario``），
    而不是空串（空串会导致字段被整体省略）。
    """
    if not text:
        return ""
    if not fmt or not fmt.strip():
        return text
    # 替换占位符，然后应用宏替换
    result = fmt.replace(placeholder, text)
    return sub_func(result)


def _split_example_blocks(example_text: str) -> List[str]:
    """ST 1.18.0 parseMesExamples (script.js:3442-3456) 的块切分。

    将 mes_example / 世界书 EMTop/EMBottom 文本按 <START> 拆分为独立示例块。
    空文本或纯 <START> 返回空列表；不以 <START> 开头时补一个前缀以对齐 ST。
    """
    if not example_text or not example_text.strip():
        return []
    text = example_text.strip()
    if text.upper() == "<START>":
        return []
    if not text.upper().startswith("<START>"):
        text = "<START>\n" + text
    blocks = re.split(r"<START>", text, flags=re.IGNORECASE)
    # ST parseMesExamples: split().slice(1) —— 丢弃首个 <START> 之前的内容
    blocks = blocks[1:]
    result: List[str] = []
    for block in blocks:
        block = block.strip()
        if block:
            result.append(block)
    return result


def _parse_example_chat(
    block_text: str,
    user_name: str,
    char_name: str,
    group_names: Optional[List[str]] = None,
) -> List[Tuple[str, str]]:
    """ST 1.18.0 parseExampleIntoIndividual (openai.js:720-778) 的忠实移植。

    将单个 <START> 示例块展开为 (name, content) 消息列表：
    - 连续行合并为一条消息（直到说话人切换）
    - 说话人行前缀 ``Name:`` 被剥离
    - 用户消息 name=example_user，角色/群成员消息 name=example_assistant
    - 无说话人前缀的行仍计入当前消息（与 ST 行为一致）

    A-6 修复: 相对旧实现，本实现不再把每一行拆成独立消息，
    对齐 ST 的多行合并语义。
    """
    result: List[Tuple[str, str]] = []
    if not block_text:
        return result

    lines = block_text.split("\n")
    cur_msg_lines: List[str] = []
    in_user = False
    in_bot = False
    bot_name = char_name or ""
    group_prefixes = [f"{n}:" for n in (group_names or []) if n]

    def add_msg(name: str, system_name: str) -> None:
        if not cur_msg_lines:
            return
        parsed = "\n".join(cur_msg_lines)
        prefix = f"{name}:"
        if prefix and parsed.startswith(prefix):
            parsed = parsed[len(prefix):]
        parsed = parsed.strip()
        cur_msg_lines.clear()
        if not parsed:
            return
        result.append((system_name, parsed))

    user_prefix = f"{user_name}:" if user_name else ""
    char_prefix = f"{char_name}:" if char_name else ""

    for cur in lines:
        if user_prefix and cur.startswith(user_prefix):
            in_user = True
            if in_bot:
                add_msg(bot_name, "example_assistant")
            in_bot = False
        elif (char_prefix and cur.startswith(char_prefix)) or any(
            cur.startswith(gp) for gp in group_prefixes
        ):
            if char_prefix and not cur.startswith(char_prefix) and group_prefixes:
                bot_name = cur.split(":")[0]
            in_bot = True
            if in_user:
                add_msg(user_name, "example_user")
            in_user = False
        cur_msg_lines.append(cur)

    if in_user:
        add_msg(user_name, "example_user")
    elif in_bot:
        add_msg(bot_name, "example_assistant")

    return result


def build_st_compat_messages(
    db: Session,
    char: Character,
    user_nickname: str,
    session_id: str,
    branch_id: Optional[str],
    message: str,
    images: List[str],
    system_prompt_override: Optional[str],
    world_info_before: str,
    world_info_after: str,
    persona_description: str,
    jailbreak: str,
    authors_note: str,
    authors_note_depth: int,
    dynamic_context_parts: List[str],
    prompt_lang: str,
    user_setting: Optional[UserSetting],
    _replace_placeholders: callable,
    _get_full_branch_history: callable,
    _contains_chinese: callable,
    normalize_image_url: callable,
    include_user_message: bool = True,
    token_budget: int = 4096,
    context_template: Optional[Any] = None,
    recent_messages_budget: Optional[int] = None,
    worldbook_depth_entries: Optional[List[Tuple[int, str, int]]] = None,  # G6 修复: (depth, content, role)
    authors_note_position: int = 1,  # ST 1.18.0 extension_prompt_types: -1=NONE, 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
    worldbook_em_top: Optional[List[str]] = None,  # G5 修复: 世界书 EMTop 条目
    worldbook_em_bottom: Optional[List[str]] = None,  # G5 修复: 世界书 EMBottom 条目
    skip_examples: bool = False,  # G7 修复: instruct skip_examples 时不注入示例
    worldbook_an_top: Optional[List[str]] = None,  # G4 修复: 世界书 ANTop (pos=2)
    worldbook_an_bottom: Optional[List[str]] = None,  # G4 修复: 世界书 ANBottom (pos=3)
    # D2 修复: names_behavior 四态 + 群聊名字 (ST 1.18.0 openai.js:204-209 / openai.js:586-603)
    names_behavior: int = 0,  # -1=NONE, 0=DEFAULT, 1=COMPLETION, 2=CONTENT
    is_group: bool = False,  # 是否群聊场景
    user_name: str = "",  # ST name1 (用户名)
    narrator_type: str = "narrator",  # ST system_message_types.NARRATOR
    # D3 修复: wi_format 包裹 (ST 1.18.0 openai.js:780-792 formatWorldInfo)
    wi_format: str = "",  # 世界书条目格式串，空串表示不包裹
    # D5/D6/D7 修复: 群聊 nudge + pin_examples + scenario/personality_format
    pin_examples: bool = False,  # ST 1.18.0 power_user.pin_examples
    scenario_format: str = "{{scenario}}",  # ST 1.18.0 oai_settings.scenario_format (openai.js:112)
    personality_format: str = "{{personality}}",  # ST 1.18.0 oai_settings.personality_format (openai.js:113)
    new_group_chat_prompt: str = "[Start a new group chat. Group members: {{group}}]",  # ST 1.18.0 openai.js:108
    group_nudge: str = "",  # ST 1.18.0 groupNudge prompt
    group_members: Optional[List[str]] = None,  # 群聊成员名列表
    speaker_char: Optional[Character] = None,  # D3 修复: 群聊当前发言者角色（绑定 {{char}}）
    generation_mode: int = 0,  # C1 修复: ST 群生成模式 (0=SWAP/1=APPEND/2=APPEND_DISABLED)
    group_combined_card: Optional[Dict[str, str]] = None,  # C2 修复: combineGroupIntoSingleCard 合并卡
    extension_prompts: Optional[List[Dict[str, Any]]] = None,  # ST 1.18.0 extension_prompts (已合并 DB+req+filter)
    # Task 7: ST generate_interceptor 消息重排同步（与 build_character_chat_messages 对齐）
    message_order: Optional[List[str]] = None,
    # P0-3: ST generate_interceptor 消息排除同步（与 build_character_chat_messages 对齐）
    excluded_message_ids: Optional[List[str]] = None,
    # A-8 修复: 生成类型（swipe/continue/impersonate/quiet/normal/None）——impersonate 时豁免 group nudge
    generation_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """ST 1.18.0 兼容消息构建器。

    严格复现 ST PromptManager.js promptManagerDefaultPromptOrder 的装配序：
      Index 0:  main (system)
      Index 1:  worldInfoBefore (system)
      Index 2:  personaDescription (system)
      Index 3:  charDescription (system)
      Index 4:  charPersonality (system)
      Index 5:  scenario (system)
      Index 6:  enhanceDefinitions (disabled by default — skip)
      Index 7:  nsfw / auxiliary (empty by default — skip)
      Index 8:  worldInfoAfter (system)
      Index 9:  dialogueExamples (system, with [Example Chat] markers)
      Index 10: chatHistory (with [Start a new Chat] at start)
      Index 11: jailbreak / post-history instructions (system)

    Author's note 按 ST 行为注入：position==0 时在 chatHistory 内按 depth 插入。

    不包含任何 Palink 特有内容（无身份锁定、无语音描述、无状态栏探测、
    无标题指令、无角色校准、无最终提醒）。
    """
    char_name = char.name or "Character"
    # D3 修复: 群聊时将 {{char}} 绑定到当前发言者（speaker_char），对齐 ST 1.18.0 群聊语义
    if is_group and speaker_char is not None:
        _sp_name = getattr(speaker_char, "name", None)
        if _sp_name:
            char_name = _sp_name

    # 宏替换辅助
    def _sub(text: str) -> str:
        if not text:
            return ""
        result = text.replace("{{char}}", char_name)
        # D5 修复: {{charIfNotGroup}} 群聊内解析为 {{user}}，单聊解析为 {{char}}
        # （ST 1.18.0 语义：群聊场景用用户名替代角色名）
        if is_group:
            result = result.replace("{{charIfNotGroup}}", user_nickname)
        else:
            result = result.replace("{{charIfNotGroup}}", char_name)
        result = result.replace("{{user}}", user_nickname)
        return result

    # 解析 context_template 的 chat_start 标记
    # D5 修复: 群聊时使用 new_group_chat_prompt (ST 1.18.0 openai.js:883-894)
    if is_group:
        new_chat_marker = new_group_chat_prompt
        # 替换 {{group}} 为成员名列表
        if group_members:
            new_chat_marker = new_chat_marker.replace("{{group}}", ", ".join(group_members))
        else:
            new_chat_marker = new_chat_marker.replace("{{group}}", char_name)
    else:
        new_chat_marker = _ST_DEFAULT_NEW_CHAT_PROMPT
        if context_template is not None:
            cs = (getattr(context_template, "chat_start", None) or "").strip()
            if cs:
                new_chat_marker = cs

    messages: List[Dict[str, Any]] = []

    # --- Index 0: main prompt (system) ---
    main_prompt = system_prompt_override or _ST_DEFAULT_MAIN_PROMPT
    if context_template is not None:
        tmpl_name = getattr(context_template, "name", None)
        if tmpl_name and tmpl_name != "Default":
            tmpl_sys = (getattr(context_template, "system_prompt", None) or "").strip()
            if tmpl_sys:
                main_prompt = tmpl_sys
    main_content = _sub(main_prompt)
    if main_content.strip():
        messages.append({"role": "system", "content": main_content.strip()})

    # --- Index 1: worldInfoBefore (system) ---
    # D3 修复: 应用 wi_format 包裹 (ST 1.18.0 openai.js:780-792)
    if world_info_before and world_info_before.strip():
        messages.append({"role": "system", "content": _apply_wi_format(world_info_before.strip(), wi_format)})

    # --- Index 2: personaDescription (system) ---
    if persona_description and persona_description.strip():
        messages.append({"role": "system", "content": persona_description.strip()})

    # --- Index 3: charDescription (system) ---
    # C2 修复: APPEND/APPEND_DISABLED 群模式使用合并卡（含所有/含禁用成员）替换单卡字段
    if is_group and generation_mode in (1, 2) and group_combined_card:
        _card_desc = (group_combined_card.get("description") or "").strip()
    else:
        _card_desc = (char.description or "").strip()
    if _card_desc:
        messages.append({"role": "system", "content": _sub(_card_desc)})

    # --- Index 4: charPersonality (system) ---
    # D7 修复: 应用 personality_format 包裹 (ST 1.18.0 openai.js:1359-1360)
    # C2 修复: APPEND/APPEND_DISABLED 群模式使用合并卡的 personality 字段
    if is_group and generation_mode in (1, 2) and group_combined_card:
        _card_pers = (group_combined_card.get("personality") or "").strip()
    else:
        _card_pers = (char.personality or "").strip()
    if _card_pers:
        personality_text = _apply_field_format(_card_pers, personality_format, "{{personality}}", _sub)
        if personality_text:
            messages.append({"role": "system", "content": personality_text})

    # --- Index 5: scenario (system) ---
    # D7 修复: 应用 scenario_format 包裹 (ST 1.18.0 openai.js:1359-1360)
    # C2 修复: APPEND/APPEND_DISABLED 群模式使用合并卡的 scenario 字段
    if is_group and generation_mode in (1, 2) and group_combined_card:
        _card_scen = (group_combined_card.get("scenario") or "").strip()
    else:
        _card_scen = (char.scenario or "").strip()
    if _card_scen:
        scenario_text = _apply_field_format(_card_scen, scenario_format, "{{scenario}}", _sub)
        if scenario_text:
            messages.append({"role": "system", "content": scenario_text})

    # --- Index 6: enhanceDefinitions (disabled by default — skip) ---
    # --- Index 7: nsfw / auxiliary (empty by default — skip) ---

    # --- Index 8: worldInfoAfter (system) ---
    # D3 修复: 应用 wi_format 包裹 (ST 1.18.0 openai.js:780-792)
    if world_info_after and world_info_after.strip():
        messages.append({"role": "system", "content": _apply_wi_format(world_info_after.strip(), wi_format)})

    # Author's note 注入 (ST 1.18.0 extension_prompt_types 对齐)
    #   -1 = NONE          (不注入)
    #    0 = IN_PROMPT      (jailbreak 之后，作为 system prompt 末尾)
    #    1 = IN_CHAT        (chatHistory 内按 depth 插入)
    #    2 = BEFORE_PROMPT  (main prompt 之前，作为第一条 system 消息)
    an_content = ""
    if authors_note and authors_note.strip():
        an_content = _sub(authors_note.strip())

    # G4 修复: 拼接 ANTop + author's note + ANBottom
    # ST world-info.js:5111-5114: ANTop 在作者备注上方，ANBottom 在下方
    an_parts: List[str] = []
    if worldbook_an_top:
        an_parts.extend(worldbook_an_top)
    if an_content:
        an_parts.append(an_content)
    if worldbook_an_bottom:
        an_parts.extend(worldbook_an_bottom)
    an_content = "\n\n".join(an_parts) if an_parts else ""

    # ── ST 1.18.0 extension_prompts 四态注入 (与 author_note 独立) ──
    # position 枚举（ST script.js:491-496）: -1=NONE 0=IN_PROMPT 1=IN_CHAT 2=BEFORE_PROMPT
    #   IN_PROMPT(0) → 并入 system prompt（messages[0]）文本末尾（对齐 ST
    #                  getPromptPosition(IN_PROMPT)='end' 语义；2026-08-19 修复，
    #                  见下方 IN_PROMPT 注入处注释，不再 append 到 messages 末尾）
    #   IN_CHAT(1)   → 按 depth 插入到 history_messages
    #   BEFORE_PROMPT(2) → 插入到 messages[0] 作为 system prompt start（不按 depth）
    ep_before_prompt: List[str] = []
    ep_in_prompt: List[Tuple[str, str]] = []        # (content, role) — 不按 depth
    ep_in_chat: List[Tuple[int, str, str]] = []      # (depth, content, role)
    for ep in (extension_prompts or []):
        try:
            pos = int(ep.get("position", -1))
        except (TypeError, ValueError):
            continue
        content = (ep.get("content") or "").strip()
        if not content or pos == -1:  # NONE(-1) 跳过
            continue
        # P2-7 修复: scan=true 时对 content 执行 macro 替换
        # 对齐 ST 1.18.0 extension_prompt.scan 语义
        if ep.get("scan"):
            content = _sub(content)
        try:
            depth = max(0, int(ep.get("depth", 4)))
        except (TypeError, ValueError):
            depth = 4
        role_raw = ep.get("role", "system")
        if isinstance(role_raw, bool):
            role_str = "system"
        elif isinstance(role_raw, int):
            role_str = {0: "system", 1: "user", 2: "assistant"}.get(role_raw, "system")
        else:
            role_str = str(role_raw or "system").strip().lower()
            if role_str not in ("system", "user", "assistant"):
                role_str = "system"
        if pos == 2:  # BEFORE_PROMPT
            ep_before_prompt.append(content)
        elif pos == 0:  # IN_PROMPT
            ep_in_prompt.append((content, role_str))
        elif pos == 1:  # IN_CHAT
            ep_in_chat.append((depth, content, role_str))

    # position 2: BEFORE_PROMPT (main prompt 之前，作为第一条 system 消息)
    # ST 1.18.0 getPromptPosition(BEFORE_PROMPT)='start' → 插入到 prompt 集合最前
    if an_content and authors_note_position == 2:
        messages.insert(0, {"role": "system", "content": an_content})

    # --- Index 9: dialogueExamples (system, with [Example Chat] markers) ---
    # G5 修复: 拼接 EMTop + mes_example + EMBottom (ST 1.18.0 world-info.js:5093-5143)
    # G7 修复: skip_examples=True 时不注入示例 (ST PromptManager shouldIncludeExamples)
    # ST 1.18.0 行为: example chat 被展开为多条 system 消息，每条对话单独一条
    if not skip_examples:
        example_blocks: List[str] = []
        # EMTop 条目 → 作为示例块（before 位置），与 ST script.js:4591-4592 unshift 一致
        for em in (worldbook_em_top or []):
            example_blocks.extend(_split_example_blocks(em))
        # mes_example: 按 <START> 拆块 (ST parseMesExamples)
        # C2 修复: APPEND/APPEND_DISABLED 群模式使用合并卡的 mes_example 字段
        if is_group and generation_mode in (1, 2) and group_combined_card:
            _card_ex = (group_combined_card.get("mes_example") or "").strip()
        else:
            _card_ex = (char.mes_example or "").strip()
        if _card_ex:
            example_text = _replace_placeholders(_card_ex, user_nickname, char_name) or ""
            example_blocks.extend(_split_example_blocks(example_text))
        # EMBottom 条目 → 作为示例块（after 位置），与 ST script.js:4593-4594 push 一致
        for em in (worldbook_em_bottom or []):
            example_blocks.extend(_split_example_blocks(em))

        _example_group_names = group_members if is_group else None
        for block in example_blocks:
            parsed_msgs = _parse_example_chat(block, user_nickname, char_name, _example_group_names)
            if not parsed_msgs:
                continue
            # ST populateDialogueExamples: 每个 <START> 块前插入 [Example Chat] 标记
            messages.append({"role": "system", "content": _ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT})
            for msg_name, msg_content in parsed_msgs:
                msg_obj: Dict[str, Any] = {"role": "system", "content": msg_content}
                # A-5 修复: ST 示例消息带 name 字段 (openai.js:1111 setName，
                #           example_user/example_assistant)
                if msg_name:
                    msg_obj["name"] = msg_name
                messages.append(msg_obj)

    # --- Index 10: chatHistory (with [Start a new Chat] at start) ---
    history_limit = (
        recent_messages_budget
        if (isinstance(recent_messages_budget, int) and recent_messages_budget > 0)
        else settings.CHARACTER_CHAT_HISTORY_LIMIT
    )

    if branch_id:
        history = _get_full_branch_history(db, session_id, branch_id, limit=history_limit)
    else:
        history = (
            db.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session_id,
                CharacterChatMessage.branch_id == None,
            )
            .order_by(CharacterChatMessage.created_at.desc())
            .limit(history_limit)
            .all()[::-1]
        )

    # P1-6 修复: 装配路径过滤 is_hidden 消息（对齐 ST prompt 整理时跳过隐藏消息）
    history = [m for m in history if not getattr(m, "is_hidden", False)]

    # P0-3: ST generate_interceptor 消息排除同步（与 build_character_chat_messages 对齐）
    if excluded_message_ids:
        _excluded = {str(mid) for mid in excluded_message_ids}
        history = [m for m in history if str(getattr(m, "id", "")) not in _excluded]

    # Task 7: ST generate_interceptor 消息重排同步（与 build_character_chat_messages 对齐）
    if message_order:
        _order_index = {str(mid): i for i, mid in enumerate(message_order)}
        history.sort(key=lambda m: _order_index.get(str(getattr(m, "id", "")), len(_order_index)))

    # ST: [Start a new Chat] 标记在 chatHistory 最前面
    history_messages: List[Dict[str, Any]] = []
    if new_chat_marker:
        history_messages.append({"role": "system", "content": _sub(new_chat_marker)})

    for m in history:
        # ST IGNORE_SYMBOL 对齐
        m_extra = {}
        try:
            m_extra_raw = getattr(m, "extra", None)
            if m_extra_raw:
                m_extra = json.loads(m_extra_raw) if isinstance(m_extra_raw, str) else m_extra_raw
                if isinstance(m_extra, dict) and m_extra.get("ignore") is True:
                    continue
        except (json.JSONDecodeError, TypeError, ValueError):
            m_extra = {}
        if not isinstance(m_extra, dict):
            m_extra = {}
        msg_content = m.content or ""
        if m.role == "assistant":
            msg_content = re.sub(r"<think[\s\S]*?</think\s*>", "", msg_content, flags=re.IGNORECASE).strip()
            msg_content = clean_display_markup_for_prompt(msg_content)
            if not msg_content:
                msg_content = m.content or ""

        # D2 修复: names_behavior 四态注入逻辑 (ST 1.18.0 openai.js:586-603)
        msg_name = getattr(m, "name", None) or ""
        force_avatar = bool(m_extra.get("force_avatar", False))
        msg_type = m_extra.get("type", "")

        # A-3 修复: NARRATOR 类型消息以 system role 发送 (ST openai.js:580-583)
        msg_role = m.role
        if msg_type == narrator_type:
            msg_role = "system"
        msg_obj: Dict[str, Any] = {"role": msg_role, "content": msg_content}

        if names_behavior == -1:  # NONE: 不前缀、不加 name 字段
            pass
        elif names_behavior == 0:  # DEFAULT
            # ST: (selected_group && name !== name1) || (force_avatar && name !== name1 && type !== NARRATOR)
            should_prefix = (
                (is_group and msg_name and msg_name != user_name) or
                (force_avatar and msg_name and msg_name != user_name and msg_type != narrator_type)
            )
            if should_prefix:
                msg_obj["content"] = f"{msg_name}: {msg_content}"
        elif names_behavior == 1:  # COMPLETION: 添加 name 字段，content 不变
            if msg_name:
                msg_obj["name"] = _sanitize_name(msg_name)
        elif names_behavior == 2:  # CONTENT
            # ST: type !== NARRATOR 时拼 Name: content
            if msg_name and msg_type != narrator_type:
                msg_obj["content"] = f"{msg_name}: {msg_content}"

        history_messages.append(msg_obj)

    # Current user message (ST: 作为 history 的最后一条)
    if include_user_message and message:
        cleaned_message, _ = parse_system_commands(message)
        if images:
            content_payload = [{"type": "text", "text": cleaned_message}]
            for img_url in images:
                normalized_img_url = normalize_image_url(img_url, check_size=True)
                content_payload.append({"type": "image_url", "image_url": {"url": normalized_img_url}})
            history_messages.append({"role": "user", "content": content_payload})
        else:
            history_messages.append({"role": "user", "content": cleaned_message})

    # Author's note depth 插入 (ST 1.18.0: 仅 position==1 / IN_CHAT 时在 chatHistory 内按 depth 插入)
    # ST: 在 chatHistory 内按 depth 从末尾计数插入
    if an_content and authors_note_position == 1 and authors_note_depth > 0:
        # depth 从 history_messages 末尾计数（不含 [Start a new Chat] 标记）
        # ST 的 depth 是相对于 messages 数组（已反转后）的位置
        insert_idx = max(1, len(history_messages) - authors_note_depth)
        history_messages.insert(insert_idx, {"role": "system", "content": an_content})
    # position 0 (IN_PROMPT) 在 jailbreak 之后处理; position 2 (BEFORE_PROMPT)
    # 已在上方作为 main-prompt 之前的首条消息处理。此处仅处理 position==1 的 depth 插入。

    # extension_prompts IN_CHAT(1): 按 depth 插入到 history_messages (与 author_note 独立)
    # ST 1.18.0 openai.js:810-852。depth 降序插入（先插大的 depth），避免索引偏移
    if ep_in_chat:
        for _ep_depth, _ep_content, _ep_role in sorted(ep_in_chat, key=lambda x: x[0], reverse=True):
            if _ep_depth > 0:
                _ep_idx = max(1, len(history_messages) - _ep_depth)
                history_messages.insert(_ep_idx, {"role": _ep_role, "content": _ep_content})
            else:
                history_messages.append({"role": _ep_role, "content": _ep_content})

    # Worldbook depth entries (WI_POS_AT_DEPTH=4) 注入
    # ST: 在 chatHistory 内按 depth 从末尾计数插入，与 author's note 类似
    # G6 修复: 使用条目的 role (0=system, 1=user, 2=assistant)
    # A-6 修复: wi_format 仅应用于 worldInfoBefore/After (ST openai.js:1367-1368)，
    #           depth 条目不应用 formatWorldInfo 包裹
    _ROLE_MAP = {0: "system", 1: "user", 2: "assistant"}
    if worldbook_depth_entries:
        for wb_depth, wb_content, wb_role in sorted(worldbook_depth_entries, key=lambda x: x[0]):
            role_str = _ROLE_MAP.get(wb_role, "system")
            formatted_content = wb_content
            if wb_depth > 0:
                insert_idx = max(1, len(history_messages) - wb_depth)
                history_messages.insert(insert_idx, {"role": role_str, "content": formatted_content})
            else:
                # depth==0: 追加到 history 末尾
                history_messages.append({"role": role_str, "content": formatted_content})

    # D10 修复: dynamic_context_parts 接入 (memory/plotline/Palink 注入)
    # ST 1.18.0 extension_prompts IN_CHAT 注入位置：chatHistory 之前
    if dynamic_context_parts:
        dynamic_content = "\n\n".join(p.strip() for p in dynamic_context_parts if p and p.strip())
        if dynamic_content:
            # 作为 system 消息注入到 chatHistory 之前
            messages.append({"role": "system", "content": _sub(dynamic_content)})

    messages.extend(history_messages)

    # D5/A-8 修复: 群聊 nudge 注入。
    # ST 1.18.0 openai.js:883-894 用 insertAtEnd(groupNudgeMessage,'chatHistory') →
    # nudge 位于 chatHistory 之后、jailbreak(Index 11) 之前；此前方块在 messages 最末
    # （IN_PROMPT extension_prompts 之后），与 ST 顺序不一致。
    # impersonate 类型生成不注入（ST noGroupNudgeTypes=['impersonate']）。
    if is_group and group_nudge and group_nudge.strip():
        _gen_type = (generation_type or "").strip().lower()
        if _gen_type != "impersonate":
            nudge_content = _sub(group_nudge.strip())
            if nudge_content:
                # A-11: _st_trailing_guard 标记末尾强制项，供 st-compat trim 精确
                # 识别（替代"跳过最多 N 条 system"数量启发式，见 _apply_st_compat_history_trim_inner）。
                messages.append({"role": "system", "content": nudge_content, "_st_trailing_guard": True})

    # --- Index 11: jailbreak / post-history instructions (system) ---
    # D1 修复: 修正覆盖语义，与 ST 1.18.0 openai.js:1495-1506 一致
    # A-2 修复: 移除 char.post_history_instructions 无条件回退注入——角色卡 PHI 的
    # V2 兼容已在调用点（roleplay_prompt_assembly）合并进 jailbreak 参数；
    # prefer_character_jailbreak=false 时 ST 索引 11 为空或用户配置值，不注入 PHI。
    jailbreak_content = ""
    if jailbreak and jailbreak.strip():
        # 第一优先级: 调用处传入的合并结果 (char.jailbreak 或 user_setting.jailbreak)
        jailbreak_content = _sub(jailbreak.strip())
    elif context_template is not None:
        # 第二优先级: context_template.jailbreak (仅当 jailbreak 参数为空时使用)
        tmpl_jb = (getattr(context_template, "jailbreak", None) or "").strip()
        if tmpl_jb:
            jailbreak_content = _sub(tmpl_jb)
    if jailbreak_content:
        # A-11: 见 nudge 处注释
        messages.append({"role": "system", "content": jailbreak_content, "_st_trailing_guard": True})

    # position 0: IN_PROMPT (after post-history / jailbreak 之后，作为 system prompt 末尾)
    # ST 1.18.0 getPromptPosition(IN_PROMPT)='end' → 追加到 prompt 集合末尾
    if an_content and authors_note_position == 0:
        # A-11: 见 nudge 处注释
        messages.append({"role": "system", "content": an_content, "_st_trailing_guard": True})

    # extension_prompts IN_PROMPT(0): 追加到 system prompt（messages[0]）文本末尾
    # ST 1.18.0 openai.js getPromptPosition(IN_PROMPT)='end'（system prompt 末尾）。
    # [INJ-CLOSE-TAG-GUARD] 2026-08-19 修复：此前误实现为 append 到 messages 末尾
    # （在 jailbreak 之后 = prompt 最后一条 system 注入，紧贴模型续写位置），实测
    # deepseek-v4-flash 100% 空响应（立刻 EOS completion_tokens=1，或把剧情正文
    # 写进 reasoning 不写 content，用户侧表现为第二轮对话 100% 思维链乱码且正文
    # 不输出——前端"对话渲染系统 v7.1"插件 setExtensionPrompt(position=0) 即走
    # 此路径）。对照实验（各 3 次真实调用）：append 末尾 0/3，追加到 system
    # prompt 末尾 3/3 正常。
    if ep_in_prompt:
        for _ep_content, _ep_role in ep_in_prompt:
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

    # extension_prompts BEFORE_PROMPT(2): 作为最前的 system 消息 (author_note 优先)
    # author_note_position 已是 ST 枚举（-1/0/1/2），== 2 即 BEFORE_PROMPT。
    # author_note 在 [0] 时 ep 插入到 index 1，否则 index 0
    if ep_before_prompt:
        _ep_text = "\n\n".join(ep_before_prompt)
        _ep_idx = 1 if (an_content and authors_note_position == 2) else 0
        messages.insert(_ep_idx, {"role": "system", "content": _ep_text})

    return messages
