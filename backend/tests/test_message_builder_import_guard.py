"""character_message_builder 装配路径导入守卫。

背景（2026-08-28 线上报障）：L224 调用 strip_inline_think 但文件从未导入
（51991d6 引入调用时遗漏），regenerate 等 SSE 端点装配历史时抛
NameError: name 'strip_inline_think' is not defined → 500。
既有测试均为源码 grep 式弱断言，无法捕获此类运行时 NameError。
本测试真实调用 build_character_chat_messages 走 assistant 历史分支。

运行: python -m pytest tests/test_message_builder_import_guard.py -q
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.services.character_message_builder import build_character_chat_messages  # noqa: E402


def _mk_msg(role: str, content: str, mid: str = "m1") -> SimpleNamespace:
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


def test_assistant_history_does_not_raise_name_error():
    """带 assistant 历史的装配不再抛 NameError（strip_inline_think 已导入）。"""
    history = [
        _mk_msg("user", "hi"),
        _mk_msg("assistant", "<think>chain</think>reply text"),
    ]
    messages = _build(history)  # 修复前此处抛 NameError
    assert any(m["role"] == "assistant" and "reply text" in m["content"] for m in messages)


def test_think_block_stripped_from_assistant_history():
    """思维链剥离语义保持：<think> 不进入 prompt。"""
    history = [_mk_msg("assistant", "<think>secret</think>visible body")]
    messages = _build(history)
    assistant_contents = [m["content"] for m in messages if m["role"] == "assistant"]
    assert assistant_contents and "secret" not in assistant_contents[0]
    assert "visible body" in assistant_contents[0]
