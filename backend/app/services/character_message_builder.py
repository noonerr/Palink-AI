"""
角色聊天消息构建器 - 稳定前缀优先的提示词结构

方向声明: 项目当前主攻 `build_character_chat_messages`（palink-native 装配）。
`build_st_compat_messages`（st-compat 模式）已于 2026-09 删除。详见根目录 AGENTS.md。
"""
import json
import logging
import re
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from ..models import Character, CharacterChatMessage, UserSetting
from ..core import settings
from ..utils import strip_inline_think

logger = logging.getLogger(__name__)


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


# [PROMPT-EVERY-TURN 2026-10-02] 历史擦标签从「全删」改「白名单删」。
# 旧兜底正则 `<[^>]+>` 把卡协议的自定义记号一并吃掉：<UpdateVariable>/<initvar>
# 随历史蒸发，模型在后续轮次失去变量输出模式的参照（与 2026-09-30「MVU 初始变量
# 断链」修复同源的显示层半边）。现改为只删已知显示标签，其余自定义标签原样保留。
# 注意 `\b[^>]*/?>` 必须兼容自闭合形态——露缇雅1.2 开场白（消息 2464）实测标签族
# 含 <background scene="…" /> 与 <StatusPlaceHolderImpl/>。
_DISPLAY_TAG_WHITELIST_RE = re.compile(
    r"</?(?:style|script|br|p|div|span|section|article|li|tr|h[1-6]"
    r"|ul|ol|table|thead|tbody|tfoot|td|th|font|b|i|u|s|em|strong"
    r"|hr|center|small|big|sub|sup|pre|code|blockquote|figure|figcaption"
    r"|img|a|video|audio|iframe|palink-html)\b[^>]*/?>",
    re.IGNORECASE,
)
# [HISTORY-KEEP-SHELL 2026-10-02] 外壳记号（now_plot/content/story/Lnterleaving/正文/
# cg/background）**不再从历史里擦掉** —— 推翻 2026-10-02 早先的「决定②：只放行变量块，
# 外壳不恢复原样」。
#
# 理由（A/B/C + 稳态四组实测，卡 4af0c6d3，机器断言取卡内「正文美化」真实正则）：
#   · 擦除会把上一轮**唯一**的正例主动改写成裸文范例，模型随后照抄裸文——
#     turn2 出框率 20% vs 放开后 75%，turn3 0% vs 88%，且衰减消失（turn3 不再低于 turn2）。
#   · 证据形态：克隆会话里只有首轮那条真出框（frames=1/leak=0），擦除后历史帧数归零。
#   · 已知边界（本层不做归一，故意不兜底）：历史里若存在**两层**范例
#     （`<now_plot><content>…</content></now_plot>`，如消息 2466），它原样进 prompt，
#     其自身显示指纹为 frames=1/**leak=1**（卡正则是单层反向引用，捕到外层时内层
#     标签落进捕获组）；单层范例为 frames=1/leak=0。稳态采样里模型自身输出
#     0/13 无漏标记，故当前风险被约束在"范例文本"层面，未扩散到生成侧。
#     ⚠️ 因此本层**不得**被当成"历史清洗兜底"，需要归一应另立议题在生成/显示侧解决。
_HTML_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")


def clean_display_markup_for_prompt(text: str) -> str:
    """Remove display-only HTML from stored assistant history.

    [PROMPT-EVERY-TURN 2026-10-02 + HISTORY-KEEP-SHELL] 只删白名单内的显示标签；
    自定义变量块（<UpdateVariable>/<initvar>）、状态栏占位符
    （<StatusPlaceHolderImpl/>）与**外壳记号**（<now_plot> 等）都保留，模型在后续
    轮次能从历史读到变量模式与输出结构正例。不扩大为格式治理，也不新增其他清洗。
    """
    value = str(text or "")
    value = re.sub(r"<style\b[^>]*>[\s\S]*?</style\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<script\b[^>]*>[\s\S]*?</script\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<palink-html>[\s\S]*?</palink-html>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"```html\s*[\s\S]*?```", "\n", value, flags=re.IGNORECASE)
    value = _HTML_COMMENT_RE.sub("", value)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"</(?:p|div|section|article|li|tr|h[1-6])\s*>", "\n", value, flags=re.IGNORECASE)
    value = _DISPLAY_TAG_WHITELIST_RE.sub("", value)
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

    顺序：稳定角色提示词 -> 示例 -> 历史 -> 历史后指令 -> 动态上下文 -> 用户系统指令 -> 当前用户消息。
    尾部不再追加 system（2026-09-27 身份层 ST 化：final_reminder 已删，末条必为 user 轮）。

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

    # A2 修复: mes_example 按 <START> 拆块组织（ST parseMesExamples +
    # populateDialogueExamples 语义），对齐 st-compat 函数族行为：
    # 多组示例对话各自以 [Example Chat] 标记 + example_user/example_assistant
    # name 字段展开为多条 system 消息。仅移植组织语义，
    # _split_example_blocks/_parse_example_chat 函数体保持原样。
    if char.mes_example:
        _example_text = _replace_placeholders(char.mes_example, user_nickname, _char_name_for_sub) or ""
        for _block in _split_example_blocks(_example_text):
            _parsed_msgs = _parse_example_chat(_block, user_nickname, _char_name_for_sub)
            if not _parsed_msgs:
                continue
            messages.append({"role": "system", "content": _ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT})
            for _msg_name, _msg_content in _parsed_msgs:
                _msg_obj: Dict[str, Any] = {"role": "system", "content": _msg_content}
                if _msg_name:
                    _msg_obj["name"] = _msg_name
                messages.append(_msg_obj)

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
        # T2（2026-09-27 身份层 ST 化）：标题指令并入 auxiliary（system_prompt
        # 尾部），不再单独 append 到 user 之后——保证 messages[-1] 是 user 轮
        # （对齐 ST：default_jailbreak_prompt 为空故默认不追加尾部 system）。
        if is_zh:
            title_instruction = "请在回复末尾用 [标题: 11个字概括本次对话] 的格式输出一个简短的标题。"
        else:
            title_instruction = "Please include a brief title at the end of your response in the format [Title: 11-character summary of this conversation]."
        if messages and messages[0].get("role") == "system":
            messages[0]["content"] = (messages[0]["content"] or "") + "\n\n" + title_instruction
        else:
            # 极端兜底：首条不是 system（正常装配不会发生）时退回独立 system 追加
            messages.append({"role": "system", "content": title_instruction})

    # 状态栏探测 / 提醒分支已整体移除（2026-08-18）：Palink 原生 <status> 状态栏
    # 系统删除，不再注入探测指令与状态栏提醒（与 MVU 卡 <UpdateVariable> 冲突）。

    # T2（2026-09-27 身份层 ST 化）：尾部 final_reminder 整块删除——
    # "只以{char.name}的身份回复"是一次身份断言且落在 prompt 最末；
    # "不要复述角色卡"与已删的【角色卡遵循】小节同源（ST 无对应）。

    # ST 1.18.0 context template wrapping — applied after the existing
    # message assembly so the original Palink prompt structure is preserved.
    # The Default template (and missing template) is a passthrough.
    # A6 修复: V3 卡独立 jailbreak 消费进 jailbreak 槽（优先级
    # context_template > 卡自带 > 无）；与 PHI 相同的 V2 回退拷贝不重复消费。
    _card_jailbreak = (getattr(char, "jailbreak", None) or "").strip()
    _phi_text = (char.post_history_instructions or "").strip()
    if _card_jailbreak and _phi_text and _card_jailbreak == _phi_text:
        _card_jailbreak = ""
    messages = _apply_context_template(
        messages,
        context_template=context_template,
        char_name=char.name or "",
        user_name=user_nickname,
        replace_placeholders=_replace_placeholders,
        card_jailbreak=_card_jailbreak,
    )

    # T2 守卫（2026-09-27 身份层 ST 化）：prompt 不以 system 结尾（对齐 ST
    # openai.js:920-923 "末条是 assistant 时补一条 user"的语义方向）。
    # 正常装配末条必为 user；若将来有路径在尾部追加 system（回归），在此报警。
    if messages and messages[-1].get("role") == "system":
        logger.warning(
            "[PROMPT-TAIL-GUARD] assembled prompt ends with a system message "
            "(session=%s, tail=%.80r) — post-history class instructions should "
            "go into postHistoryInstructions slots, not the tail",
            session_id, messages[-1].get("content", ""),
        )

    return messages


def _apply_context_template(
    messages: List[Dict[str, Any]],
    *,
    context_template: Optional[Any],
    char_name: str,
    user_name: str,
    replace_placeholders: callable,
    card_jailbreak: str = "",
) -> List[Dict[str, Any]]:
    """Wrap the assembled messages with context template fields.

    Backward-compatibility contract:
      - context_template is None → passthrough (unchanged), unless a card
        jailbreak is provided (see below)
      - context_template.name == "Default" → passthrough (unchanged)
      - otherwise:
          * template.system_prompt (if non-empty) is inserted as a leading
            system message (after macro placeholder replacement)
          * template.jailbreak (if non-empty) is inserted as a system
            message immediately after the first system message
          * template.chat_start (if non-empty) is inserted as a system
            separator just before the first user/assistant message

    A6 修复: ``card_jailbreak``（V3 卡独立 jailbreak）在模板未提供 jailbreak
    时消费进同一槽位（优先级 context_template > 卡自带 > 无，对齐 ST prompt
    manager 语义）。
    """
    tmpl_name = getattr(context_template, "name", None)
    tmpl_is_wrapping = (
        context_template is not None and tmpl_name and tmpl_name != "Default"
    )
    if not tmpl_is_wrapping and not card_jailbreak:
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
    # A6 修复: 槽位内容优先级 context_template > 卡自带 jailbreak > 无。
    effective_jailbreak = tmpl_jailbreak or (card_jailbreak or "").strip()
    if effective_jailbreak:
        rendered_jb = replace_placeholders(effective_jailbreak, user_name, char_name)
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

# ST 1.18.0 默认 main prompt 统一由 core.default_prompts.ST_DEFAULT_MAIN_PROMPT
# 提供（2026-09-27 身份层 ST 化：此处旧 _ST_DEFAULT_MAIN_PROMPT 为零引用死常量，
# 且含宏列表不支持的 {{charIfNotGroup}}，已删除，勿再留两份）。

# ST 1.18.0 默认标记（openai.js:107-109）
_ST_DEFAULT_NEW_CHAT_PROMPT = "[Start a new Chat]"
_ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT = "[Example Chat]"


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


def apply_mvu_reply_to_session(
    db: Session,
    character_id: Optional[str],
    session_id: str,
    reply_text: str,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """MVU 变量引擎共用入口：解析 reply_text 中的 <UpdateVariable> JSON Patch
    并落库到会话 chat_metadata.variables。

    WS 主路径（websocket.py persist_snapshot）与 SSE 生成收尾（普通对话/
    regenerate/swipe/continue 四入口）同调本函数，调用契约（对齐 WS 既有行为）：
    - 先解析落库（本函数），调用方随后 strip_update_variable_blocks 剥正文——
      顺序必须是"先解析、后剥离"，stat_data 基于剥离前原文；
    - 本函数不 commit，由调用方随消息落库同事务提交；
    - 会话不存在时返回 (None, [])，调用方据此跳过 extra.variables 回写；
    - 变更日志非空时打 "MVU variables updated" info（与 WS 原实现一致）。

    角色卡 extensions + character_book 合并逻辑与原 WS persist_snapshot 一致：
    char 可能来自已 close 的调用方会话（WS 场景实例 detached），直接访问
    world_books 会触发 lazy load 异常，故统一按 id 重查并 eager load。
    """
    from sqlalchemy.orm import selectinload

    from ..models import CharacterChatSession, WorldBook
    from .mvu_engine import MvuEngine, merge_character_book_entries

    _mvu_char = None
    if character_id:
        try:
            _mvu_char = (
                db.query(Character)
                .options(
                    selectinload(Character.world_books).selectinload(WorldBook.entries)
                )
                .filter(Character.id == character_id)
                .first()
            )
        except Exception:
            _mvu_char = None
    char_ext_raw: Dict[str, Any] = {}
    if _mvu_char is not None and getattr(_mvu_char, "extensions", None):
        try:
            raw_ext = _mvu_char.extensions
            char_ext_raw = json.loads(raw_ext) if isinstance(raw_ext, str) else (raw_ext if isinstance(raw_ext, dict) else {})
        except (json.JSONDecodeError, TypeError):
            pass
    # character_book 存在 world_books 表而非 extensions，需合并其 entry content
    # 供 build_initial_stat_data 提取 <initvar>（头像 URL/服饰/内心想法等初始值）。
    wb_entries = [
        str(stage.content or "")
        for wb in ((_mvu_char.world_books) if _mvu_char is not None else [])
        if getattr(wb, "type", "") == "character_book"
        for stage in (wb.entries or [])
    ]
    char_ext_raw = merge_character_book_entries(char_ext_raw, wb_entries)

    sess = (
        db.query(CharacterChatSession)
        .filter(CharacterChatSession.id == session_id)
        .first()
    )
    if sess is None:
        return None, []
    cur_meta: Dict[str, Any] = {}
    if sess.chat_metadata:
        try:
            cur_meta = json.loads(sess.chat_metadata)
            if not isinstance(cur_meta, dict):
                cur_meta = {}
        except (json.JSONDecodeError, TypeError):
            pass
    cur_vars = cur_meta.get("variables")
    if not isinstance(cur_vars, dict) or not cur_vars.get("stat_data"):
        # [T1 2026-09-30] 传角色卡的**列值**（live 值）优先于 extensions 里的导入快照
        cur_vars = MvuEngine.init_session_variables(
            char_ext_raw,
            first_mes=getattr(_mvu_char, "first_mes", None),
            alternate_greetings=getattr(_mvu_char, "alternate_greetings", None),
        )
    new_vars, logs = MvuEngine.update_from_reply(
        cur_vars,
        reply_text,
        char_ext_raw,
        first_mes=getattr(_mvu_char, "first_mes", None),
        alternate_greetings=getattr(_mvu_char, "alternate_greetings", None),
    )
    cur_meta["variables"] = new_vars
    sess.chat_metadata = json.dumps(cur_meta, ensure_ascii=False)
    if logs:
        logger.info("MVU variables updated: %s", "; ".join(logs[:8]))
    return new_vars, logs
