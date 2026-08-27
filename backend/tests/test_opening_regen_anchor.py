"""[OPENING-REGEN] 重 roll/swipe 开场白对话锚点守卫。

背景（2026-08-28 排查）：重 roll 开场白时，regenerate/swipe 端点把目标消息
移除后 messages 只剩 system 轮（无任何 user/assistant 对话轮），模型没有
"正在对话"锚点 → 弱模型输出「角色卡设定与扮演规划」类元信息而非剧情
（会话 b7b9a8e6 消息 2249 实证）。ST script.js:4780 对同场景有
"hack for regeneration of the first message"（空历史补一条 user 轮）。

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


def _char(name: str = "猫神", description: str = "一只黑猫") -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description)


def test_all_system_messages_gets_user_anchor():
    """重 roll 开场白场景（全 system）→ 追加一条 user 锚点轮。"""
    messages = [
        {"role": "system", "content": "你是猫神"},
        {"role": "system", "content": "【最后提醒】只以猫神的身份回复"},
    ]
    _ensure_conversation_anchor(messages, _char())
    assert messages[-1]["role"] == "user"
    assert "开场白" in messages[-1]["content"]
    assert "猫神" in messages[-1]["content"]


def test_messages_with_user_turn_untouched():
    """正常重 roll（历史含 user 轮）→ 不追加。"""
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


def test_english_card_gets_english_anchor():
    """英文卡（auto 语言判定）→ 英文锚点。"""
    messages = [{"role": "system", "content": "You are a wizard"}]
    _ensure_conversation_anchor(messages, _char(name="Merlin", description="An old wizard"))
    assert messages[-1]["role"] == "user"
    assert "opening message" in messages[-1]["content"]
