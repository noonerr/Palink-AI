"""ST-Compat jailbreak index 11 tests (D1 修复).

验证 build_st_compat_messages 的 jailbreak 覆盖语义与 ST 1.18.0 一致：
    优先级: jailbreak 参数 (高) → char.post_history_instructions (中) → context_template.jailbreak (低)

覆盖 spec 中 4 个 Scenario:
    1. 角色卡 jailbreak 优先
    2. 用户全局 jailbreak 回退
    3. context_template 回退
    4. 全空时索引 11 不注入
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
    """构造 mock Character 对象。"""
    defaults = dict(
        name="TestChar",
        description="char description",
        personality="char personality",
        scenario="char scenario",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_db_empty_history():
    """构造返回空历史的 mock db。"""
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    db.query.return_value = query
    return db


def _build(jailbreak="", char=None, context_template=None):
    """调用 build_st_compat_messages 并返回 messages。"""
    char = char or _make_char()
    return build_st_compat_messages(
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
        jailbreak=jailbreak,
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
        context_template=context_template,
    )


def _last_system_content(messages):
    """返回最后一条 system 消息的 content（jailbreak 位于索引 11，即末尾附近）。"""
    for m in reversed(messages):
        if m.get("role") == "system":
            return m.get("content")
    return None


def test_jailbreak_param_highest_priority():
    """Scenario 1: jailbreak 参数（角色卡/用户合并结果）优先。"""
    char = _make_char(post_history_instructions="PHI content")
    msgs = _build(jailbreak="MERGED JAILBREAK", char=char)
    assert "MERGED JAILBREAK" in _last_system_content(msgs)
    assert "PHI content" not in _last_system_content(msgs)


def test_phi_not_injected_when_jailbreak_empty():
    """A-2: jailbreak 参数为空时不再回退注入 PHI（ST: prefer=false 时索引 11 为空）。"""
    char = _make_char(post_history_instructions="PHI content")
    msgs = _build(jailbreak="", char=char)
    last = _last_system_content(msgs)
    assert "PHI content" not in (last or "")


def test_context_template_fallback():
    """Scenario 3: jailbreak 与 PHI 均空时回退到 context_template.jailbreak。"""
    char = _make_char(post_history_instructions=None)
    tmpl = SimpleNamespace(jailbreak="TEMPLATE JB", name="Default", system_prompt=None, chat_start=None)
    msgs = _build(jailbreak="", char=char, context_template=tmpl)
    assert "TEMPLATE JB" in _last_system_content(msgs)


def test_context_template_fallback_when_phi_present():
    """A-2: jailbreak 参数空时 context_template.jailbreak 作为兜底；PHI 不再自动注入。"""
    char = _make_char(post_history_instructions="PHI content")
    tmpl = SimpleNamespace(jailbreak="TEMPLATE JB", name="Default", system_prompt=None, chat_start=None)
    msgs = _build(jailbreak="", char=char, context_template=tmpl)
    last = _last_system_content(msgs)
    assert "TEMPLATE JB" in last
    assert "PHI content" not in last


def test_no_jailbreak_when_all_empty():
    """Scenario 4: 三个来源均为空时不注入索引 11。"""
    char = _make_char(post_history_instructions=None)
    msgs = _build(jailbreak="", char=char)
    # 最后一条 system 消息不应是 jailbreak（应为主 prompt 或无）
    # 由于有 main prompt，检查不存在 jailbreak 类内容
    contents = " ".join(m.get("content", "") for m in msgs if m.get("role") == "system")
    assert "JAILBREAK" not in contents.upper() or "jailbreak" not in contents.lower()
