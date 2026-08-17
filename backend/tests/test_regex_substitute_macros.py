"""ST 1.18.0 substituteRegex 宏集合扩展测试。

验证 _substitute_regex_params 支持的宏从 5 个扩展到 15+ 个:
- 用户/角色名类: {{user}}/{{char}}/{{character}}/{{name1}}/{{name2}}/{{persona}}/{{personaName}}
- 时间/日期类: {{time}}/{{date}}/{{datetime}}/{{weekday}}/{{isotime}}/{{isodate}}/{{time_utc}}
- 控制类: {{newline}}/{{br}}/{{ln}}/{{space}}/{{tab}}/{{noop}}

注: 角色卡类宏 ({{description}}/{{mesExamples}} 等) 依赖 character 上下文，
此处不测试，留作 follow-up（需 PromptAssemblyDeps 重构）。

参考:
- SillyTavern-1.18.0/public/script.js:2922 substituteParams
- SillyTavern-1.18.0/public/scripts/extensions/regex/engine.js:398-409, 444, 460
"""
from __future__ import annotations

import re
import sys
import os

# 让 backend 目录可被导入
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.character_ext import _substitute_regex_params


def test_basic_user_char_macros():
    """基本 5 个宏仍正常工作（向后兼容）。"""
    text = "Hello {{user}}, you are talking to {{char}} ({{character}})."
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert "Alice" in result
    assert "Bob" in result
    assert "{{user}}" not in result
    assert "{{char}}" not in result
    assert "{{character}}" not in result


def test_name1_name2_macros():
    """{{name1}}/{{name2}} 别名正常工作。"""
    text = "{{name1}} -> {{name2}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert result == "Alice -> Bob"


def test_persona_macro_fallback_to_user_name():
    """{{persona}} 在无 db 上下文时降级为 user_name。"""
    text = "Persona: {{persona}}, Name: {{personaName}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert "Alice" in result
    assert "{{persona}}" not in result
    assert "{{personaName}}" not in result


def test_time_macros_return_non_empty():
    """时间类宏应返回非空字符串。"""
    text = "Time: {{time}}, Date: {{date}}, Weekday: {{weekday}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert "{{time}}" not in result
    assert "{{date}}" not in result
    assert "{{weekday}}" not in result
    # 验证 time 格式 HH:MM
    assert re.search(r"\d{2}:\d{2}", result), f"time format invalid: {result!r}"
    # 验证 date 格式 YYYY-MM-DD
    assert re.search(r"\d{4}-\d{2}-\d{2}", result), f"date format invalid: {result!r}"


def test_isotime_isodate_formats():
    """{{isotime}} 应为 HH:MM:SS, {{isodate}} 应为 ISO 8601 格式。"""
    text = "{{isotime}} | {{isodate}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert "{{isotime}}" not in result
    assert "{{isodate}}" not in result
    assert re.search(r"\d{2}:\d{2}:\d{2}", result), f"isotime invalid: {result!r}"


def test_datetime_macro():
    """{{datetime}} 应为 YYYY-MM-DD HH:MM 格式。"""
    text = "Now: {{datetime}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert "{{datetime}}" not in result
    assert re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", result), f"datetime invalid: {result!r}"


def test_control_macros():
    """控制类宏: {{newline}}/{{br}}/{{ln}} → \\n, {{space}} → ' ', {{tab}} → \\t, {{noop}} → ''。"""
    result = _substitute_regex_params(
        "Line1{{newline}}Line2{{br}}Line3{{ln}}Line4",
        user_name="Alice",
        char_name="Bob",
    )
    assert result == "Line1\nLine2\nLine3\nLine4"

    result = _substitute_regex_params("a{{space}}b", user_name="A", char_name="B")
    assert result == "a b"

    result = _substitute_regex_params("a{{tab}}b", user_name="A", char_name="B")
    assert result == "a\tb"

    result = _substitute_regex_params("a{{noop}}b", user_name="A", char_name="B")
    assert result == "ab"


def test_case_insensitive_matching():
    """宏匹配应 case-insensitive（{{USER}}, {{User}}, {{user}} 都替换）。"""
    text = "{{USER}} {{User}} {{user}}"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert result == "Alice Alice Alice"


def test_macro_with_special_regex_chars_in_value():
    """宏值含正则特殊字符（如 $, \\）时不应被 re.sub 解释。"""
    # 用户名含 $1, \g<name> 等正则特殊序列
    result = _substitute_regex_params(
        "Hello {{user}}",
        user_name="Test$1\\g<name>",
        char_name="Bob",
    )
    assert result == "Hello Test$1\\g<name>", f"special chars broken: {result!r}"


def test_empty_text_returns_empty():
    """空字符串输入应返回空。"""
    assert _substitute_regex_params("", user_name="Alice", char_name="Bob") == ""
    assert _substitute_regex_params(None, user_name="Alice", char_name="Bob") == ""


def test_no_macros_returns_original():
    """无宏时返回原文。"""
    text = "Just a normal text without macros"
    result = _substitute_regex_params(text, user_name="Alice", char_name="Bob")
    assert result == text
