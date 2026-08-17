"""ST-Compat names_behavior four-mode tests (D2 修复).

验证 build_st_compat_messages 的 names_behavior 四态注入逻辑与 ST 1.18.0 一致
(openai.js:204-209 / openai.js:586-603):
    NONE(-1): 不前缀、不加 name 字段
    DEFAULT(0): 群聊非用户消息或 force_avatar 时拼 Name: content
    COMPLETION(1): 添加 name 字段，content 不变
    CONTENT(2): 非 narrator 时拼 Name: content

覆盖 spec 中 6 个 Scenario。
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


def _make_char():
    return SimpleNamespace(
        name="Alice",
        description="desc",
        personality="pers",
        scenario="scen",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )


def _make_history_msg(role, content, name=None, force_avatar=False, msg_type=""):
    """构造带 name/extra 的历史消息对象。"""
    extra = {}
    if force_avatar:
        extra["force_avatar"] = True
    if msg_type:
        extra["type"] = msg_type
    return SimpleNamespace(
        role=role,
        content=content,
        name=name,
        extra=json.dumps(extra) if extra else None,
    )


def _make_db_with_history(history):
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    # order_by desc 后 all() 返回倒序，函数内 [::-1] 反转回正序
    query.all.return_value = list(reversed(history))
    db.query.return_value = query
    return db


def _build(history, names_behavior=0, is_group=False, user_name="User"):
    return build_st_compat_messages(
        db=_make_db_with_history(history),
        char=_make_char(),
        user_nickname=user_name,
        session_id="sess-1",
        branch_id=None,
        message="new msg",
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
        names_behavior=names_behavior,
        is_group=is_group,
        user_name=user_name,
        narrator_type="narrator",
    )


def _find_content(messages, substring):
    """查找包含 substring 的消息 content。"""
    for m in messages:
        c = m.get("content")
        if isinstance(c, str) and substring in c:
            return m
    return None


def test_none_mode_no_prefix():
    """Scenario: NONE(-1) 不前缀、不加 name 字段。"""
    history = [_make_history_msg("assistant", "hi from bob", name="Bob")]
    msgs = _build(history, names_behavior=-1, is_group=True)
    m = _find_content(msgs, "hi from bob")
    assert m is not None
    assert m["content"] == "hi from bob"  # 无 "Bob: " 前缀
    assert "name" not in m


def test_default_mode_group_prefix():
    """Scenario: DEFAULT(0) 群聊非用户消息加 Name: 前缀。"""
    history = [_make_history_msg("assistant", "hi from bob", name="Bob")]
    msgs = _build(history, names_behavior=0, is_group=True, user_name="User")
    m = _find_content(msgs, "hi from bob")
    assert m is not None
    assert m["content"] == "Bob: hi from bob"
    assert "name" not in m


def test_default_mode_single_chat_no_prefix():
    """Scenario: DEFAULT(0) 单聊不加前缀（与 ST 1.18.0 单聊行为一致）。"""
    history = [_make_history_msg("assistant", "hi from bob", name="Bob")]
    msgs = _build(history, names_behavior=0, is_group=False, user_name="User")
    m = _find_content(msgs, "hi from bob")
    assert m is not None
    assert m["content"] == "hi from bob"  # 单聊不加前缀


def test_default_mode_force_avatar_prefix():
    """Scenario: DEFAULT(0) + force_avatar 且非用户且非 narrator 时加前缀。"""
    history = [_make_history_msg("user", "forced msg", name="Carol", force_avatar=True)]
    msgs = _build(history, names_behavior=0, is_group=False, user_name="User")
    m = _find_content(msgs, "forced msg")
    assert m is not None
    assert m["content"] == "Carol: forced msg"


def test_completion_mode_name_field():
    """Scenario: COMPLETION(1) 添加 name 字段，content 不变。"""
    history = [_make_history_msg("assistant", "hi from bob", name="Bob")]
    msgs = _build(history, names_behavior=1, is_group=True)
    m = _find_content(msgs, "hi from bob")
    assert m is not None
    assert m["content"] == "hi from bob"  # content 不变
    assert m.get("name") == "Bob"  # 添加 name 字段


def test_content_mode_prefix():
    """Scenario: CONTENT(2) 非 narrator 时拼 Name: content。"""
    history = [_make_history_msg("assistant", "hi from bob", name="Bob")]
    msgs = _build(history, names_behavior=2, is_group=False)
    m = _find_content(msgs, "hi from bob")
    assert m is not None
    assert m["content"] == "Bob: hi from bob"


def test_narrator_exempt_default():
    """Scenario: NARRATOR 类型在 DEFAULT 模式下不前缀。"""
    history = [_make_history_msg("user", "narration", name="Narrator", force_avatar=True, msg_type="narrator")]
    msgs = _build(history, names_behavior=0, is_group=False, user_name="User")
    m = _find_content(msgs, "narration")
    assert m is not None
    assert m["content"] == "narration"  # narrator 不加前缀


def test_narrator_exempt_content():
    """Scenario: NARRATOR 类型在 CONTENT 模式下不前缀。"""
    history = [_make_history_msg("user", "narration", name="Narrator", msg_type="narrator")]
    msgs = _build(history, names_behavior=2, is_group=False)
    m = _find_content(msgs, "narration")
    assert m is not None
    assert m["content"] == "narration"  # narrator 不加前缀
