"""[OPENING-REGEN] 重 roll/swipe 开场白对话锚点守卫（ST 1.18.0 对齐）。

背景（2026-08-28 排查）：重 roll 开场白时，regenerate/swipe 端点把目标消息
移除后 messages 只剩 system 轮（无任何 user/assistant 对话轮），模型没有
"正在对话"锚点 → 弱模型输出「角色卡设定与扮演规划」类元信息而非剧情
（会话 b7b9a8e6 消息 2249 实证）。

ST 1.18.0 同场景机制（源码核实）：
1. newChatMessage "[Start a new Chat]"（openai.js:107）无条件插在 chatHistory
   最前（openai.js:1069-1070）——空历史时也在场
2. script.js:4780 "hack for regeneration of the first message"（chat2.push('')）
   保证 prompt 以对话侧收尾

运行: python -m pytest tests/test_opening_regen_anchor.py -q
"""

import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.character_ext import _ensure_conversation_anchor  # noqa: E402

ST_MARKER = "[Start a new Chat]"


def _char(name: str = "猫神", description: str = "一只黑猫") -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description)


def test_all_system_messages_gets_marker_and_user_anchor():
    """重 roll 开场白场景（全 system）→ ST 标记 + user 锚点双注入。

    顺序对齐 ST：标记在最终提醒（≈ post-history）之前，user 锚点收尾。
    """
    messages = [
        {"role": "system", "content": "你是猫神"},
        {"role": "system", "content": "【最后提醒】只以猫神的身份回复"},
    ]
    _ensure_conversation_anchor(messages, _char())
    # ST newChatMessage 标记：插在最后一条 system（最终提醒）之前
    marker_idx = next(i for i, m in enumerate(messages) if m["content"] == ST_MARKER)
    final_reminder_idx = next(i for i, m in enumerate(messages) if "最后提醒" in m["content"])
    assert messages[marker_idx]["role"] == "system"
    assert marker_idx < final_reminder_idx
    # user 锚点收尾（ST 空 user 轮 hack 的显式版）
    assert messages[-1]["role"] == "user"
    assert "开场白" in messages[-1]["content"]
    assert "猫神" in messages[-1]["content"]


def test_messages_with_user_turn_untouched():
    """正常重 roll（历史含 user 轮）→ 不追加标记与锚点。"""
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "你好"},
        {"role": "system", "content": "reminder"},
    ]
    before = list(messages)
    _ensure_conversation_anchor(messages, _char())
    assert messages == before


def test_messages_with_assistant_turn_untouched():
    """历史含 assistant 轮（如插件深度注入）→ 不追加。"""
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "hi"},
    ]
    before = list(messages)
    _ensure_conversation_anchor(messages, _char())
    assert messages == before


def test_marker_not_duplicated_when_template_already_injected():
    """模板 chat_start 已注入（装配期插在开场白前，移除后保留）→ 不重复插入。"""
    messages = [
        {"role": "system", "content": "你是猫神"},
        {"role": "system", "content": ST_MARKER},
        {"role": "system", "content": "【最后提醒】"},
    ]
    _ensure_conversation_anchor(messages, _char())
    assert sum(1 for m in messages if m["content"] == ST_MARKER) == 1
    assert messages[-1]["role"] == "user"


def test_empty_messages_get_marker_and_anchor():
    """极端：messages 为空 → 标记 + 锚点仍注入（不崩溃）。"""
    messages = []
    _ensure_conversation_anchor(messages, _char())
    assert messages[0]["role"] == "system" and messages[0]["content"] == ST_MARKER
    assert messages[-1]["role"] == "user"


def test_english_card_gets_english_anchor():
    """英文卡（auto 语言判定）→ 英文锚点 + ST 英文标记。"""
    messages = [{"role": "system", "content": "You are a wizard"}]
    _ensure_conversation_anchor(messages, _char(name="Merlin", description="An old wizard"))
    assert any(m["content"] == ST_MARKER for m in messages)
    assert messages[-1]["role"] == "user"
    assert "opening message" in messages[-1]["content"]
