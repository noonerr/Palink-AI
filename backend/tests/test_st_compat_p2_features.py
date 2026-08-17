"""ST-Compat P2 特性测试 (D5/D6/D7 修复).

D5: new_group_chat_prompt + group_nudge (ST 1.18.0 openai.js:883-894)
D6: pin_examples 预算竞争（实际逻辑在 _apply_st_compat_history_trim，
    已由 test_st_compat_token_budget.py 覆盖；此处仅验证 builder 接受该参数）
D7: scenario_format / personality_format (ST 1.18.0 openai.js:1359-1360)
"""

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


def _make_char(**overrides):
    defaults = dict(
        name="Alice",
        description="char description",
        personality="brave and clever",
        scenario="a fantasy quest",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_db_empty_history():
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    db.query.return_value = query
    return db


def _build(char=None, **kwargs):
    char = char or _make_char()
    base = dict(
        db=_make_db_empty_history(),
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
        _replace_placeholders=lambda t, u, c: t,
        _get_full_branch_history=lambda *a, **k: [],
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda u, check_size=False: u,
        include_user_message=True,
    )
    base.update(kwargs)
    return build_st_compat_messages(**base)


def _all_contents(messages):
    return [m.get("content") for m in messages if isinstance(m.get("content"), str)]


# ---------------------------------------------------------------------------
# D5: new_group_chat_prompt + group_nudge
# ---------------------------------------------------------------------------

def test_group_uses_new_group_chat_prompt_with_members():
    """D5: 群聊时使用 new_group_chat_prompt，{{group}} 替换为成员名列表。"""
    msgs = _build(
        is_group=True,
        group_members=["Alice", "Bob", "Carol"],
        new_group_chat_prompt="[Start a new group chat. Group members: {{group}}]",
    )
    contents = _all_contents(msgs)
    assert any("[Start a new group chat. Group members: Alice, Bob, Carol]" in c for c in contents), \
        "群聊应使用 new_group_chat_prompt 并替换 {{group}} 为成员名列表"


def test_group_without_members_uses_char_name():
    """D5: 群聊无成员列表时 {{group}} 回退为角色名。"""
    msgs = _build(is_group=True, group_members=None)
    contents = _all_contents(msgs)
    assert any("Alice" in c and "group chat" in c for c in contents)


def test_single_chat_uses_default_marker():
    """D5: 单聊使用默认 [Start a new Chat]，不用群聊标记。"""
    msgs = _build(is_group=False)
    contents = _all_contents(msgs)
    assert any("[Start a new Chat]" in c for c in contents)
    assert not any("group chat" in c for c in contents)


def test_group_nudge_injected_when_group():
    """D5: 群聊 + 非空 group_nudge → 注入 nudge system 消息。"""
    msgs = _build(is_group=True, group_nudge="[Write the next reply only as {{char}}.]")
    contents = _all_contents(msgs)
    # {{char}} 经 _sub 替换为 Alice
    assert any("[Write the next reply only as Alice.]" in c for c in contents), \
        "群聊应注入 group_nudge（宏已替换）"


def test_group_nudge_not_injected_single_chat():
    """D5: 单聊不注入 group_nudge。"""
    msgs = _build(is_group=False, group_nudge="[Write the next reply only as {{char}}.]")
    contents = _all_contents(msgs)
    assert not any("Write the next reply only as" in c for c in contents)


def test_group_nudge_empty_not_injected():
    """D5: 空 group_nudge 不注入。"""
    msgs = _build(is_group=True, group_nudge="")
    contents = _all_contents(msgs)
    assert not any("Write the next reply" in c for c in contents)


# ---------------------------------------------------------------------------
# D7: scenario_format / personality_format
# ---------------------------------------------------------------------------

def test_scenario_format_wraps():
    """D7: 自定义 scenario_format 包裹 scenario 字段。"""
    msgs = _build(scenario_format="[Scenario: {{scenario}}]")
    contents = _all_contents(msgs)
    assert "[Scenario: a fantasy quest]" in contents


def test_personality_format_wraps():
    """D7: 自定义 personality_format 包裹 personality 字段。"""
    msgs = _build(personality_format="[Personality: {{personality}}]")
    contents = _all_contents(msgs)
    assert "[Personality: brave and clever]" in contents


def test_default_format_unwrapped_backward_compat():
    """D7: 默认 format（{{scenario}}/{{personality}}）等价于未包裹（向后兼容）。"""
    msgs = _build(scenario_format="{{scenario}}", personality_format="{{personality}}")
    contents = _all_contents(msgs)
    assert "a fantasy quest" in contents
    assert "brave and clever" in contents
    # 不应有额外包裹标记
    assert not any("[Scenario:" in c for c in contents)


def test_empty_format_inserts_original_value():
    """A-7: 空 format 时插入字段原值（ST openai.js:1359-1360 空串会省略字段的旧语义是错的）。"""
    msgs = _build(scenario_format="", personality_format="")
    contents = _all_contents(msgs)
    # scenario/personality 原文应作为独立 system 消息出现
    assert "a fantasy quest" in contents
    assert "brave and clever" in contents


# ---------------------------------------------------------------------------
# D6: pin_examples 参数被 builder 接受（预算竞争逻辑在 trim 阶段）
# ---------------------------------------------------------------------------

def test_builder_accepts_pin_examples_param():
    """D6: builder 接受 pin_examples 参数不报错。

    注: pin_examples 的真实语义（示例/历史预算竞争）在 _apply_st_compat_history_trim
    中实现，已由 test_st_compat_token_budget.py 的
    test_pin_examples_true_preserves_examples / test_pin_examples_false_drops_examples_first 覆盖。
    """
    msgs_true = _build(pin_examples=True)
    msgs_false = _build(pin_examples=False)
    assert isinstance(msgs_true, list) and len(msgs_true) > 0
    assert isinstance(msgs_false, list) and len(msgs_false) > 0
