"""Stage 4: 聊天导入多格式转换器测试。

覆盖 ST 1.18.0 支持的 5 种 JSON 格式:
1. Oobabooga (data_visible 数组)
2. Agnai (messages 数组)
3. CAI Tools (histories，可能含多个独立聊天)
4. Kobold Lite (savedsettings + actions)
5. RisuAI (type === 'risuChat')

参考: SillyTavern-1.18.0/src/endpoints/chats.js:110-308
"""
from __future__ import annotations

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest


# ---------------------------------------------------------------------------
# Test 1: Oobabooga 格式
# ---------------------------------------------------------------------------

def test_import_ooba_chat_basic():
    """Oobabooga 格式: data_visible 是 [[user, char], ...] 二维数组。"""
    from app.services.chat_import_converters import import_ooba_chat

    json_data = {
        "data_visible": [
            ["Hello", "Hi there!"],
            ["How are you?", "I'm good!"],
        ]
    }
    result = import_ooba_chat("User", "Char", json_data)

    # 第一项是 header
    assert result[0] == {
        "chat_metadata": {},
        "user_name": "unused",
        "character_name": "unused",
    }
    # 接下来是 4 条消息（user/char 交替）
    assert len(result) == 5
    assert result[1]["name"] == "User"
    assert result[1]["is_user"] is True
    assert result[1]["mes"] == "Hello"
    assert result[2]["name"] == "Char"
    assert result[2]["is_user"] is False
    assert result[2]["mes"] == "Hi there!"
    assert result[3]["mes"] == "How are you?"
    assert result[4]["mes"] == "I'm good!"


def test_import_ooba_chat_handles_missing_char_msg():
    """Oobabooga: 某行只有 user 消息（char 为空）时只输出 user 消息。"""
    from app.services.chat_import_converters import import_ooba_chat

    json_data = {
        "data_visible": [
            ["Solo user message", ""],
            ["", "Solo char message"],
        ]
    }
    result = import_ooba_chat("U", "C", json_data)
    # header + 2 messages (空字符串被跳过)
    assert len(result) == 3
    assert result[1]["mes"] == "Solo user message"
    assert result[2]["mes"] == "Solo char message"


def test_import_ooba_chat_empty_data_visible():
    """Oobabooga: data_visible 为空数组时只返回 header。"""
    from app.services.chat_import_converters import import_ooba_chat

    result = import_ooba_chat("U", "C", {"data_visible": []})
    assert len(result) == 1
    assert "chat_metadata" in result[0]


# ---------------------------------------------------------------------------
# Test 2: Agnai 格式
# ---------------------------------------------------------------------------

def test_import_agnai_chat_basic():
    """Agnai 格式: messages 数组，userId 非空表示用户消息。"""
    from app.services.chat_import_converters import import_agnai_chat

    json_data = {
        "messages": [
            {"userId": "user1", "msg": "Hello from user"},
            {"userId": "", "msg": "Hello from char"},
            {"userId": "user1", "msg": "Second user msg"},
        ]
    }
    result = import_agnai_chat("User", "Char", json_data)

    assert len(result) == 4  # header + 3 messages
    assert result[1]["is_user"] is True
    assert result[1]["mes"] == "Hello from user"
    assert result[2]["is_user"] is False
    assert result[2]["mes"] == "Hello from char"
    assert result[3]["is_user"] is True


def test_import_agnai_chat_missing_msg_skipped():
    """Agnai: msg 为 None 的消息被跳过。"""
    from app.services.chat_import_converters import import_agnai_chat

    json_data = {
        "messages": [
            {"userId": "user1", "msg": "valid"},
            {"userId": "user1"},  # no msg
            {"userId": "", "msg": "valid char"},
        ]
    }
    result = import_agnai_chat("U", "C", json_data)
    assert len(result) == 3  # header + 2 valid messages


# ---------------------------------------------------------------------------
# Test 3: CAI Tools 格式（多聊天）
# ---------------------------------------------------------------------------

def test_import_cai_chat_returns_multiple_chats():
    """CAI Tools: histories.histories 数组，每个 history 转为独立聊天。"""
    from app.services.chat_import_converters import import_cai_chat

    json_data = {
        "histories": {
            "histories": [
                {
                    "msgs": [
                        {"src": {"is_human": True}, "text": "Hello from user 1"},
                        {"src": {"is_human": False}, "text": "Hello from char 1"},
                    ]
                },
                {
                    "msgs": [
                        {"src": {"is_human": False}, "text": "Char starts chat 2"},
                    ]
                },
            ]
        }
    }
    result = import_cai_chat("User", "Char", json_data)

    # 返回 list[list[dict]]，每个内部 list 是一个独立聊天
    assert isinstance(result, list)
    assert len(result) == 2  # 两个独立聊天
    # 第一个聊天: header + 2 messages
    assert len(result[0]) == 3
    assert result[0][1]["mes"] == "Hello from user 1"
    assert result[0][1]["is_user"] is True
    assert result[0][2]["mes"] == "Hello from char 1"
    assert result[0][2]["is_user"] is False
    # 第二个聊天: header + 1 message
    assert len(result[1]) == 2
    assert result[1][1]["mes"] == "Char starts chat 2"
    assert result[1][1]["is_user"] is False


def test_import_cai_chat_empty_histories():
    """CAI Tools: histories.histories 为空数组时返回空列表。"""
    from app.services.chat_import_converters import import_cai_chat

    result = import_cai_chat("U", "C", {"histories": {"histories": []}})
    assert result == []


# ---------------------------------------------------------------------------
# Test 4: Kobold Lite 格式
# ---------------------------------------------------------------------------

def test_import_kobold_lite_chat_basic():
    """Kobold Lite: actions 数组，通过 INPUT/OUTPUT token 标识用户/角色。"""
    from app.services.chat_import_converters import import_kobold_lite_chat

    json_data = {
        "savedsettings": {
            "chatname": "KoboldUser",
            "chatopponent": "KoboldChar||$||extra_data",
        },
        "actions": [
            "{{[INPUT]}}What is your name?",
            "{{[OUTPUT]}}My name is KoboldChar.",
            "{{[INPUT]}}Nice to meet you.",
        ],
        "prompt": "{{[INPUT]}}System prompt here.",
    }
    result = import_kobold_lite_chat("DefaultUser", "DefaultChar", json_data)

    # header + prompt + 3 actions = 5 items
    assert len(result) == 5
    # prompt 在最前
    assert result[1]["is_user"] is True
    assert result[1]["mes"] == "System prompt here."
    # 用户名/角色名从 savedsettings 读取（覆盖传入参数）
    assert result[1]["name"] == "KoboldUser"
    # 第一个 action
    assert result[2]["is_user"] is True
    assert result[2]["mes"] == "What is your name?"
    assert result[2]["name"] == "KoboldUser"
    # 第二个 action (char)
    assert result[3]["is_user"] is False
    assert result[3]["mes"] == "My name is KoboldChar."
    assert result[3]["name"] == "KoboldChar"


def test_import_kobold_lite_chat_no_prompt():
    """Kobold Lite: 没有 prompt 时只转换 actions。"""
    from app.services.chat_import_converters import import_kobold_lite_chat

    json_data = {
        "savedsettings": {"chatname": "U", "chatopponent": "C"},
        "actions": [
            "{{[INPUT]}}msg1",
            "{{[OUTPUT]}}msg2",
        ],
    }
    result = import_kobold_lite_chat("U", "C", json_data)
    # header + 2 actions
    assert len(result) == 3
    assert result[1]["mes"] == "msg1"
    assert result[2]["mes"] == "msg2"


# ---------------------------------------------------------------------------
# Test 5: RisuAI 格式
# ---------------------------------------------------------------------------

def test_import_risu_chat_basic():
    """RisuAI: data.message 数组，role='user' 表示用户。"""
    from app.services.chat_import_converters import import_risu_chat

    json_data = {
        "type": "risuChat",
        "data": {
            "message": [
                {"role": "user", "name": "Alice", "time": 1700000000000, "data": "Hello"},
                {"role": "assistant", "name": "Bob", "time": 1700000001000, "data": "Hi"},
                {"role": "user", "data": "Second user msg"},  # no name, fallback
            ]
        }
    }
    result = import_risu_chat("DefaultUser", "DefaultChar", json_data)

    # header + 3 messages
    assert len(result) == 4
    assert result[1]["name"] == "Alice"
    assert result[1]["is_user"] is True
    assert result[1]["mes"] == "Hello"
    assert "T" in result[1]["send_date"]  # ISO format

    assert result[2]["name"] == "Bob"
    assert result[2]["is_user"] is False
    assert result[2]["mes"] == "Hi"

    # 没有名字时回退到 user_name/character_name
    assert result[3]["name"] == "DefaultUser"
    assert result[3]["is_user"] is True


def test_import_risu_chat_empty_messages():
    """RisuAI: data.message 为空时只返回 header。"""
    from app.services.chat_import_converters import import_risu_chat

    json_data = {"type": "risuChat", "data": {"message": []}}
    result = import_risu_chat("U", "C", json_data)
    assert len(result) == 1
    assert "chat_metadata" in result[0]


# ---------------------------------------------------------------------------
# Test 6: detect_and_convert 自动检测
# ---------------------------------------------------------------------------

def test_detect_and_convert_ooba():
    """detect_and_convert 自动识别 Oobabooga 格式。"""
    from app.services.chat_import_converters import detect_and_convert

    json_data = {"data_visible": [["u1", "c1"]]}
    result = detect_and_convert("U", "C", json_data)
    assert isinstance(result, list)
    assert isinstance(result[0], dict)  # header
    assert len(result) == 3  # header + 2 messages


def test_detect_and_convert_cai_returns_list_of_lists():
    """detect_and_convert 识别 CAI Tools 并返回 list[list[dict]]。"""
    from app.services.chat_import_converters import detect_and_convert

    json_data = {
        "histories": {
            "histories": [
                {"msgs": [{"src": {"is_human": True}, "text": "hi"}]}
            ]
        }
    }
    result = detect_and_convert("U", "C", json_data)
    assert isinstance(result, list)
    assert isinstance(result[0], list)  # 多聊天格式


def test_detect_and_convert_kobold_lite():
    """detect_and_convert 识别 Kobold Lite 格式。"""
    from app.services.chat_import_converters import detect_and_convert

    json_data = {
        "savedsettings": {"chatname": "U", "chatopponent": "C"},
        "actions": ["{{[INPUT]}}msg"],
    }
    result = detect_and_convert("U", "C", json_data)
    assert isinstance(result, list)
    assert isinstance(result[0], dict)


def test_detect_and_convert_agnai():
    """detect_and_convert 识别 Agnai 格式。"""
    from app.services.chat_import_converters import detect_and_convert

    json_data = {"messages": [{"userId": "u1", "msg": "hi"}]}
    result = detect_and_convert("U", "C", json_data)
    assert isinstance(result, list)
    assert len(result) == 2  # header + 1 message


def test_detect_and_convert_risu():
    """detect_and_convert 识别 RisuAI 格式。"""
    from app.services.chat_import_converters import detect_and_convert

    json_data = {
        "type": "risuChat",
        "data": {"message": [{"role": "user", "data": "hi"}]},
    }
    result = detect_and_convert("U", "C", json_data)
    assert isinstance(result, list)
    assert len(result) == 2


def test_detect_and_convert_unknown_raises():
    """detect_and_convert 对未知格式抛出 ValueError。"""
    from app.services.chat_import_converters import detect_and_convert

    with pytest.raises(ValueError, match="Incorrect chat format"):
        detect_and_convert("U", "C", {"unknown_field": "foo"})
