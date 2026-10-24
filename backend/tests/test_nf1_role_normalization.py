"""NF-1：历史消息 role 空值归一化（2026-10-24）。

背景：全池普查（REPORT_VER1b）发现存量库存在 role=NULL 的孤立消息行
（取证见 REPORT_NF1_role空值消息取证_2026-10-24.md：2026-06-23 已消失的
早期写入路径遗留，当前构造点不可能再产生）。NULL 透传会以 "role":null
直发上游，且漏过 assistant 清洗分支。修复 = 装配循环开头归一为 assistant
并留痕。夹具照抄 test_message_builder_import_guard.py 的现成假件。

运行: cd backend && py -3 -m pytest tests/test_nf1_role_normalization.py -q
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_message_builder import build_character_chat_messages  # noqa: E402


def _mk_msg(role, content, mid="m1"):
    return SimpleNamespace(
        id=mid, role=role, content=content, name=None, extra=None, is_hidden=False,
    )


def _build(history):
    char = MagicMock()
    char.name = "Char"
    char.mes_example = ""
    char.post_history_instructions = ""
    user_setting = MagicMock()
    db = MagicMock()
    return build_character_chat_messages(
        db=db,
        char=char,
        user_nickname="User",
        session_id="sess-1",
        branch_id="branch-1",
        message="hello",
        images=[],
        system_prompt="SYSTEM",
        dynamic_context_parts=[],
        prompt_lang="zh",
        user_setting=user_setting,
        _replace_placeholders=lambda s, u, c: (s or ""),
        _get_full_branch_history=lambda db, sid, bid, limit: history,
        _contains_chinese=lambda s: True,
        normalize_image_url=lambda s: s,
    )


def test_null_role_normalized_to_assistant():
    """role=NULL 的历史行以 assistant 角色进 payload，绝不允许 "role":null 出现。"""
    history = [
        _mk_msg("user", "hi", "m1"),
        _mk_msg(None, "orphan body", "m2"),
    ]
    messages = _build(history)
    assert any(m["role"] == "assistant" and "orphan body" in m["content"] for m in messages)
    assert all(m["role"] in ("user", "assistant", "system") for m in messages)


def test_null_role_gets_assistant_cleanup_branch():
    """归一化发生在分支之前：NULL 行同样吃到 think 剥离（修复前该分支漏剥）。"""
    history = [_mk_msg(None, "<think>secret</think>visible orphan", "m2")]
    messages = _build(history)
    assistant_contents = [m["content"] for m in messages if m["role"] == "assistant"]
    assert assistant_contents and "secret" not in assistant_contents[0]
    assert "visible orphan" in assistant_contents[0]


def test_normal_roles_untouched():
    """常规行零行为变化（回归锚）。"""
    history = [
        _mk_msg("user", "u", "m1"),
        _mk_msg("assistant", "a", "m2"),
    ]
    messages = _build(history)
    assert any(m["role"] == "user" and m["content"] == "u" for m in messages)
    assert any(m["role"] == "assistant" and m["content"] == "a" for m in messages)
