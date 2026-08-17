"""ST-Compat 完整装配序集成测试.

基于 ST 1.18.0 PromptManager.js promptManagerDefaultPromptOrder (Index 0-11)
逐位置验证 build_st_compat_messages 的输出顺序、标记、字段格式。

此测试不依赖真实 ST golden vector（由 test_st_compat_golden_vector.py 负责），
而是基于 ST 1.18.0 源码逻辑推导预期输出，确保装配序在代码层面正确。

ST 1.18.0 默认 prompt order (PromptManager.js:2086-2136):
    Index 0:  main (system)
    Index 1:  worldInfoBefore (system)
    Index 2:  personaDescription (system)
    Index 3:  charDescription (system)
    Index 4:  charPersonality (system)
    Index 5:  scenario (system)
    Index 6:  enhanceDefinitions (disabled — skip)
    Index 7:  nsfw (empty — skip)
    Index 8:  worldInfoAfter (system)
    Index 9:  dialogueExamples (system, with [Example Chat] marker)
    Index 10: chatHistory (with [Start a new Chat] marker at start)
    Index 11: jailbreak / post-history instructions (system)
"""

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.character_message_builder import build_st_compat_messages  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# Mock helpers
# ---------------------------------------------------------------------------

def _make_char(**overrides):
    """构造 mock Character 对象（模拟 Elara 图书管理员）。"""
    defaults = dict(
        name="Elara",
        description="A mysterious librarian who guards ancient tomes.",
        personality="Reserved, intellectual, secretly warm.",
        scenario="You visit the Grand Library seeking a forbidden book.",
        mes_example="<START>\n{{user}}: I'm looking for the Codex.\n{{char}}: *eyes narrow* \"Restricted.\"",
        system_prompt="",
        post_history_instructions="",
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_history_msg(role, content, name=None, extra=None):
    """构造历史消息对象。"""
    return SimpleNamespace(
        role=role,
        content=content,
        name=name,
        extra=json.dumps(extra) if extra else None,
    )


def _make_db_with_history(history):
    """构造返回指定历史的 mock db（branch_id=None 路径）。"""
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    # build_st_compat_messages 内部 all()[::-1] 反转，所以这里返回倒序
    query.all.return_value = list(reversed(history))
    db.query.return_value = query
    return db


def _build(char=None, history=None, **kwargs):
    """调用 build_st_compat_messages 并返回 messages。"""
    char = char or _make_char()
    db = _make_db_with_history(history) if history else _make_db_with_history([])
    base = dict(
        db=db,
        char=char,
        user_nickname="User",
        session_id="sess-1",
        branch_id=None,
        message="hello",
        images=[],
        system_prompt_override=None,
        world_info_before="",
        world_info_after="",
        persona_description="",
        jailbreak="",
        authors_note="",
        authors_note_depth=4,
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda t, u, c: t.replace("{{user}}", u).replace("{{char}}", c),
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda u, check_size=False: u,
        include_user_message=True,
    )
    base.update(kwargs)
    return build_st_compat_messages(**base)


def _contents(messages):
    """提取所有 str content。"""
    return [m.get("content") for m in messages if isinstance(m.get("content"), str)]


def _index_of(messages, substring):
    """返回第一个包含 substring 的消息索引，找不到返回 -1。"""
    for i, m in enumerate(messages):
        c = m.get("content")
        if isinstance(c, str) and substring in c:
            return i
    return -1


# ---------------------------------------------------------------------------
# Index 0-11 完整装配序验证
# ---------------------------------------------------------------------------

def test_full_assembly_order_basic_char():
    """验证 basic_char 场景完整装配序（Index 0/3/4/5/9/10/11）。

    ST 1.18.0 PromptManager 装配序：
        main → charDescription → charPersonality → scenario
        → dialogueExamples → chatHistory → jailbreak
    """
    history = [
        _make_history_msg("user", "Hello"),
        _make_history_msg("assistant", "Hi there"),
    ]
    msgs = _build(
        history=history,
        jailbreak="SYSTEM JAILBREAK",
    )

    idx_main = _index_of(msgs, "next reply")
    idx_desc = _index_of(msgs, "mysterious librarian")
    idx_pers = _index_of(msgs, "Reserved, intellectual")
    idx_scen = _index_of(msgs, "Grand Library")
    idx_examples = _index_of(msgs, "[Example Chat]")
    idx_chat_start = _index_of(msgs, "[Start a new Chat]")
    idx_history_user = _index_of(msgs, "Hello")
    idx_history_asst = _index_of(msgs, "Hi there")
    idx_current = _index_of(msgs, "hello")
    idx_jailbreak = _index_of(msgs, "SYSTEM JAILBREAK")

    # 所有段都应存在
    assert idx_main >= 0, "Index 0 (main) missing"
    assert idx_desc >= 0, "Index 3 (charDescription) missing"
    assert idx_pers >= 0, "Index 4 (charPersonality) missing"
    assert idx_scen >= 0, "Index 5 (scenario) missing"
    assert idx_examples >= 0, "Index 9 (dialogueExamples) missing"
    assert idx_chat_start >= 0, "[Start a new Chat] marker missing"
    assert idx_history_user >= 0, "chatHistory user msg missing"
    assert idx_history_asst >= 0, "chatHistory assistant msg missing"
    assert idx_current >= 0, "current user message missing"
    assert idx_jailbreak >= 0, "Index 11 (jailbreak) missing"

    # 顺序验证：main < desc < pers < scen < examples < chat_start < history < jailbreak
    assert idx_main < idx_desc, f"main({idx_main}) should be before charDescription({idx_desc})"
    assert idx_desc < idx_pers, f"charDescription({idx_desc}) should be before charPersonality({idx_pers})"
    assert idx_pers < idx_scen, f"charPersonality({idx_pers}) should be before scenario({idx_scen})"
    assert idx_scen < idx_examples, f"scenario({idx_scen}) should be before dialogueExamples({idx_examples})"
    assert idx_examples < idx_chat_start, f"dialogueExamples({idx_examples}) should be before [Start a new Chat]({idx_chat_start})"
    assert idx_chat_start < idx_history_user, f"[Start a new Chat]({idx_chat_start}) should be before history({idx_history_user})"
    assert idx_history_user < idx_history_asst, f"history user({idx_history_user}) should be before history assistant({idx_history_asst})"
    assert idx_history_asst < idx_current, f"history assistant({idx_history_asst}) should be before current message({idx_current})"
    assert idx_current < idx_jailbreak, f"current message({idx_current}) should be before jailbreak({idx_jailbreak})"


def test_full_assembly_order_with_worldbook():
    """验证含世界书 before/after 的装配序（Index 0/1/3/4/5/8/9/10/11）。

    ST 1.18.0 PromptManager 装配序：
        main → worldInfoBefore → charDescription → charPersonality → scenario
        → worldInfoAfter → dialogueExamples → chatHistory → jailbreak
    """
    msgs = _build(
        world_info_before="WORLD_INFO_BEFORE",
        world_info_after="WORLD_INFO_AFTER",
        jailbreak="JAILBREAK",
    )

    idx_main = _index_of(msgs, "next reply")
    idx_wi_before = _index_of(msgs, "WORLD_INFO_BEFORE")
    idx_desc = _index_of(msgs, "mysterious librarian")
    idx_pers = _index_of(msgs, "Reserved, intellectual")
    idx_scen = _index_of(msgs, "Grand Library")
    idx_wi_after = _index_of(msgs, "WORLD_INFO_AFTER")
    idx_examples = _index_of(msgs, "[Example Chat]")
    idx_chat_start = _index_of(msgs, "[Start a new Chat]")
    idx_jailbreak = _index_of(msgs, "JAILBREAK")

    assert idx_main < idx_wi_before < idx_desc < idx_pers < idx_scen < idx_wi_after < idx_examples < idx_chat_start < idx_jailbreak, \
        f"装配序错误: main={idx_main} wi_before={idx_wi_before} desc={idx_desc} pers={idx_pers} " \
        f"scen={idx_scen} wi_after={idx_wi_after} examples={idx_examples} chat_start={idx_chat_start} jailbreak={idx_jailbreak}"


def test_full_assembly_order_with_persona():
    """验证含 persona 的装配序（Index 0/1/2/3/4/5/8/10/11）。

    ST 1.18.0: personaDescription 在 Index 2（worldInfoBefore 之后，charDescription 之前）
    """
    msgs = _build(
        world_info_before="WI_BEFORE",
        persona_description="PERSONA_DESC",
        world_info_after="WI_AFTER",
    )

    idx_main = _index_of(msgs, "next reply")
    idx_wi_before = _index_of(msgs, "WI_BEFORE")
    idx_persona = _index_of(msgs, "PERSONA_DESC")
    idx_desc = _index_of(msgs, "mysterious librarian")

    assert idx_main < idx_wi_before < idx_persona < idx_desc, \
        f"persona 应在 worldInfoBefore 之后、charDescription 之前: " \
        f"main={idx_main} wi_before={idx_wi_before} persona={idx_persona} desc={idx_desc}"


# ---------------------------------------------------------------------------
# 标记验证
# ---------------------------------------------------------------------------

def test_example_chat_marker_present():
    """验证 [Example Chat] 标记在 dialogueExamples 前存在（ST openai.js:109）。"""
    msgs = _build()
    contents = _contents(msgs)
    assert any("[Example Chat]" in c for c in contents), "dialogueExamples 应以 [Example Chat] 标记开头"


def test_start_new_chat_marker_present():
    """验证 [Start a new Chat] 标记在 chatHistory 开头存在（ST openai.js:107）。"""
    msgs = _build()
    contents = _contents(msgs)
    assert any("[Start a new Chat]" in c for c in contents), "chatHistory 应以 [Start a new Chat] 标记开头"


def test_example_chat_before_chat_history():
    """验证 dialogueExamples 在 chatHistory 之前（旧代码 bug 修复验证）。"""
    history = [_make_history_msg("user", "HISTORY_MARKER_MSG")]
    msgs = _build(history=history)

    idx_examples = _index_of(msgs, "[Example Chat]")
    idx_history = _index_of(msgs, "HISTORY_MARKER_MSG")

    assert idx_examples >= 0 and idx_history >= 0
    assert idx_examples < idx_history, \
        f"dialogueExamples({idx_examples}) 应在 chatHistory({idx_history}) 之前"


def test_jailbreak_after_chat_history():
    """验证 jailbreak (Index 11) 在 chatHistory 之后（ST PromptManager 默认 order）。"""
    history = [_make_history_msg("user", "HISTORY_MARKER")]
    msgs = _build(history=history, jailbreak="JAILBREAK_MARKER")

    idx_history = _index_of(msgs, "HISTORY_MARKER")
    idx_current = _index_of(msgs, "hello")
    idx_jailbreak = _index_of(msgs, "JAILBREAK_MARKER")

    assert idx_history < idx_current < idx_jailbreak, \
        f"jailbreak({idx_jailbreak}) 应在 chatHistory({idx_history}) 和 current({idx_current}) 之后"


# ---------------------------------------------------------------------------
# D3: wi_format 包裹验证
# ---------------------------------------------------------------------------

def test_wi_format_wraps_before():
    """D3: wi_format 包裹 worldInfoBefore（ST openai.js:780-792 formatWorldInfo）。"""
    msgs = _build(
        world_info_before="WI_CONTENT",
        wi_format="[World Info: {0}]",
    )
    contents = _contents(msgs)
    assert any("[World Info: WI_CONTENT]" in c for c in contents), \
        "worldInfoBefore 应被 wi_format 包裹"


def test_wi_format_wraps_after():
    """D3: wi_format 包裹 worldInfoAfter。"""
    msgs = _build(
        world_info_after="WI_AFTER_CONTENT",
        wi_format="<WI>{0}</WI>",
    )
    contents = _contents(msgs)
    assert any("<WI>WI_AFTER_CONTENT</WI>" in c for c in contents), \
        "worldInfoAfter 应被 wi_format 包裹"


def test_wi_format_empty_no_wrap():
    """D3: 空 wi_format 时不包裹（返回原值）。"""
    msgs = _build(
        world_info_before="RAW_WI_CONTENT",
        wi_format="",
    )
    contents = _contents(msgs)
    assert any("RAW_WI_CONTENT" in c for c in contents)
    assert not any("{0}" in c for c in contents), "空 wi_format 不应产生包裹标记"


def test_wi_format_not_applied_to_depth_entries():
    """A-6: wi_format 仅用于 worldInfoBefore/After，depth 条目 (pos=4 atDepth) 不包裹。"""
    msgs = _build(
        worldbook_depth_entries=[(2, "DEPTH_WI_CONTENT", 0)],
        wi_format="[DepthWI: {0}]",
    )
    contents = _contents(msgs)
    assert any("DEPTH_WI_CONTENT" in c for c in contents), \
        "depth 条目应原样注入"
    assert not any("[DepthWI: DEPTH_WI_CONTENT]" in c for c in contents), \
        "depth 条目不应用 wi_format 包裹（ST 仅 worldInfoBefore/After）"


# ---------------------------------------------------------------------------
# D10: dynamic_context_parts 注入验证
# ---------------------------------------------------------------------------

def test_dynamic_context_parts_injected():
    """D10: dynamic_context_parts 注入到 chatHistory 之前。"""
    history = [_make_history_msg("user", "HISTORY_MARKER")]
    msgs = _build(
        history=history,
        dynamic_context_parts=["MEMORY_PART_1", "PLOTLINE_PART_2"],
    )

    idx_dynamic = _index_of(msgs, "MEMORY_PART_1")
    idx_dynamic2 = _index_of(msgs, "PLOTLINE_PART_2")
    idx_chat_start = _index_of(msgs, "[Start a new Chat]")

    assert idx_dynamic >= 0, "dynamic_context_parts 未注入"
    assert idx_dynamic2 >= 0, "dynamic_context_parts 第二部分未注入"
    # dynamic_context_parts 在 chatHistory 之前（[Start a new Chat] 之前）
    assert idx_dynamic < idx_chat_start, \
        f"dynamic_context_parts({idx_dynamic}) 应在 chatHistory({idx_chat_start}) 之前"


def test_dynamic_context_parts_empty_not_injected():
    """D10: 空 dynamic_context_parts 不注入。"""
    msgs = _build(dynamic_context_parts=[])
    contents = _contents(msgs)
    # 不应有额外 system 消息（除了正常的装配段）
    assert len(msgs) <= 10  # main + desc + pers + scen + examples + chat_start + current + ... 无多余


def test_dynamic_context_parts_merged():
    """D10: 多个 dynamic_context_parts 用空行合并为一条 system 消息。"""
    msgs = _build(
        dynamic_context_parts=["PART_A", "PART_B", "PART_C"],
    )
    # 找到包含 PART_A 的消息
    dynamic_msg = None
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str) and "PART_A" in c:
            dynamic_msg = m
            break
    assert dynamic_msg is not None
    # 三个部分应在同一条消息中
    content = dynamic_msg["content"]
    assert "PART_A" in content
    assert "PART_B" in content
    assert "PART_C" in content


# ---------------------------------------------------------------------------
# D7: scenario_format / personality_format 在装配序中的位置
# ---------------------------------------------------------------------------

def test_scenario_format_in_assembly_order():
    """D7: scenario_format 包裹后的 scenario 仍在 Index 5 位置。"""
    msgs = _build(
        scenario_format="[SCN: {{scenario}}]",
        personality_format="[PER: {{personality}}]",
    )

    idx_pers = _index_of(msgs, "[PER:")
    idx_scen = _index_of(msgs, "[SCN:")

    assert idx_pers >= 0 and idx_scen >= 0
    assert idx_pers < idx_scen, "charPersonality 应在 scenario 之前"


# ---------------------------------------------------------------------------
# 群聊 nudge 在 jailbreak 之前（ST insertAtEnd(groupNudgeMessage,'chatHistory')）
# ---------------------------------------------------------------------------

def test_group_nudge_after_jailbreak():
    """D5/A-8: 群聊 nudge 在 chatHistory 之后、jailbreak (Index 11) 之前注入。

    ST 1.18.0 openai.js:883-894 insertAtEnd(groupNudgeMessage,'chatHistory')，
    默认顺序 chatHistory=10 < jailbreak=11 → nudge 位于 jailbreak 之前。"""
    history = [_make_history_msg("user", "HISTORY_MARKER")]
    msgs = _build(
        history=history,
        is_group=True,
        jailbreak="JAILBREAK_MARKER",
        group_nudge="NUDGE_MARKER",
    )

    idx_history = _index_of(msgs, "HISTORY_MARKER")
    idx_jailbreak = _index_of(msgs, "JAILBREAK_MARKER")
    idx_nudge = _index_of(msgs, "NUDGE_MARKER")

    assert idx_history >= 0 and idx_jailbreak >= 0 and idx_nudge >= 0
    assert idx_history < idx_nudge < idx_jailbreak, \
        f"group_nudge({idx_nudge}) 应在 chatHistory({idx_history}) 之后、jailbreak({idx_jailbreak}) 之前"


# ---------------------------------------------------------------------------
# Author's note position 验证
# ---------------------------------------------------------------------------

def test_authors_note_position_1_in_chat_history():
    """ST 1.18.0: position=1 (IN_CHAT) 时 author's note 在 chatHistory 内按 depth 插入。

    迁移 0056 后的 ST extension_prompt_types 语义：
        -1=NONE, 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
    旧 Palink position=0 (depth insertion) 已迁移为 1 (IN_CHAT)。
    """
    history = [
        _make_history_msg("user", "MSG_1"),
        _make_history_msg("assistant", "MSG_2"),
        _make_history_msg("user", "MSG_3"),
        _make_history_msg("assistant", "MSG_4"),
    ]
    msgs = _build(
        history=history,
        authors_note="AUTHOR_NOTE_MARKER",
        authors_note_position=1,
        authors_note_depth=2,
    )

    idx_an = _index_of(msgs, "AUTHOR_NOTE_MARKER")
    idx_last = _index_of(msgs, "MSG_4")

    assert idx_an >= 0, "author's note 未注入"
    # depth=2 意味着从末尾数第 2 条之前插入
    assert idx_an < idx_last, f"author's note({idx_an}) 应在最后一条历史({idx_last}) 之前"


def test_authors_note_position_0_after_jailbreak():
    """ST 1.18.0: position=0 (IN_PROMPT) 时 author's note 在 jailbreak 之后。

    迁移 0056 后的 ST extension_prompt_types 语义：
        -1=NONE, 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
    旧 Palink position=1 (after post-history) 已迁移为 0 (IN_PROMPT)。
    """
    msgs = _build(
        jailbreak="JAILBREAK_MARKER",
        authors_note="AUTHOR_NOTE_MARKER",
        authors_note_position=0,
    )

    idx_jailbreak = _index_of(msgs, "JAILBREAK_MARKER")
    idx_an = _index_of(msgs, "AUTHOR_NOTE_MARKER")

    assert idx_jailbreak >= 0 and idx_an >= 0
    assert idx_jailbreak < idx_an, f"author's note({idx_an}) 应在 jailbreak({idx_jailbreak}) 之后"


def test_authors_note_position_2_before_prompt():
    """ST 1.18.0: position=2 (BEFORE_PROMPT) 时 author's note 作为第一条 system 消息。

    迁移 0056 后的 ST extension_prompt_types 语义：
        -1=NONE, 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
    旧 Palink position=4 (top of chat) 已迁移为 2 (BEFORE_PROMPT)。
    """
    msgs = _build(
        authors_note="AUTHOR_NOTE_MARKER",
        authors_note_position=2,
    )

    # 第一条消息应包含 author's note
    first_msg = msgs[0]
    assert "AUTHOR_NOTE_MARKER" in first_msg.get("content", ""), \
        f"position=2 (BEFORE_PROMPT) 时 author's note 应在第一条，实际第一条: {first_msg.get('content', '')[:50]}"


# ---------------------------------------------------------------------------
# Worldbook depth entries (pos=4) 注入位置
# ---------------------------------------------------------------------------

def test_worldbook_depth_entry_injected_at_depth():
    """G6: worldbook depth entry 按 depth 从末尾插入 chatHistory。"""
    history = [
        _make_history_msg("user", "MSG_1"),
        _make_history_msg("assistant", "MSG_2"),
        _make_history_msg("user", "MSG_3"),
        _make_history_msg("assistant", "MSG_4"),
    ]
    msgs = _build(
        history=history,
        worldbook_depth_entries=[(2, "DEPTH_WI_MARKER", 0)],  # depth=2, role=system
    )

    idx_depth = _index_of(msgs, "DEPTH_WI_MARKER")
    idx_msg3 = _index_of(msgs, "MSG_3")
    idx_msg4 = _index_of(msgs, "MSG_4")

    assert idx_depth >= 0, "depth entry 未注入"
    # depth=2 意味着在倒数第 2 条之前插入
    assert idx_depth < idx_msg4, f"depth entry({idx_depth}) 应在 MSG_4({idx_msg4}) 之前"


def test_worldbook_depth_entry_role_mapping():
    """G6: worldbook depth entry 的 role 映射 (0=system, 1=user, 2=assistant)。"""
    msgs = _build(
        worldbook_depth_entries=[
            (1, "DEPTH_SYSTEM", 0),
            (1, "DEPTH_USER", 1),
            (1, "DEPTH_ASSISTANT", 2),
        ],
    )
    roles = {m.get("content"): m.get("role") for m in msgs if isinstance(m.get("content"), str)}
    assert roles.get("DEPTH_SYSTEM") == "system"
    assert roles.get("DEPTH_USER") == "user"
    assert roles.get("DEPTH_ASSISTANT") == "assistant"


# ---------------------------------------------------------------------------
# ST 默认 main prompt 验证
# ---------------------------------------------------------------------------

def test_st_default_main_prompt():
    """验证 ST 默认 main prompt 内容（openai.js default_main_prompt）。"""
    msgs = _build()
    first_system = msgs[0]
    assert first_system["role"] == "system"
    assert "next reply" in first_system["content"].lower()
    assert "Elara" in first_system["content"], "main prompt 应替换 {{char}} 为角色名"
    assert "User" in first_system["content"], "main prompt 应替换 {{user}} 为用户名"


def test_char_system_prompt_overrides_default():
    """验证角色卡 system_prompt 覆盖默认 main prompt。"""
    msgs = _build(
        system_prompt_override="CUSTOM_SYSTEM_PROMPT",
    )
    contents = _contents(msgs)
    assert "CUSTOM_SYSTEM_PROMPT" in contents
    # 默认 main prompt 不应出现
    assert not any("next reply" in c.lower() for c in contents), \
        "角色卡 system_prompt 应覆盖默认 main prompt"


# ---------------------------------------------------------------------------
# macro 替换验证（{{char}} / {{user}}）
# ---------------------------------------------------------------------------

def test_macro_replacement_in_assembly():
    """验证 {{char}} 和 {{user}} 在装配过程中被替换。

    注意: world_info_before/after 的宏替换发生在 worldbook_service 扫描阶段，
    不在 build_st_compat_messages 内部。因此测试仅验证 builder 内部做宏替换的段
    （main prompt, charDescription, jailbreak, new_chat_marker 等）。
    """
    msgs = _build(
        jailbreak="JB: {{char}} for {{user}}",
        group_nudge="Nudge: {{char}} only",
        is_group=True,
    )
    contents = _contents(msgs)
    joined = " ".join(contents)
    # 宏应被替换
    assert "Elara" in joined
    assert "User" in joined
    # jailbreak 和 nudge 中的宏应被替换
    assert "JB: Elara for User" in joined
    assert "Nudge: Elara only" in joined
    # 不应残留未替换的宏（在 builder 内部处理的部分）
    assert "{{char}}" not in joined
    assert "{{user}}" not in joined
