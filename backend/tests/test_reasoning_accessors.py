"""分离存储访问器单测（get_display_content / get_message_reasoning，Step 1）。"""

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.utils import (
        get_display_content,
        get_message_reasoning,
        strip_inline_think_full,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class _Msg:
    def __init__(self, content=None, extra=None):
        self.content = content
        self.extra = extra


def test_new_format_row():
    """新格式行：content 纯正文 + extra.reasoning 思考，直读不变形。"""
    msg = _Msg(content="正文", extra=json.dumps({"reasoning": "思考", "reasoning_type": "thinking"}))
    assert get_display_content(msg) == "正文"
    assert get_message_reasoning(msg) == "思考"


def test_legacy_dual_write_row_prefers_extra():
    """存量双写行：以 extra.reasoning 为权威（插件正则处理过的展示版本），仅剥离 content。"""
    msg = _Msg(content="<think>旧拆版</think>\n正文", extra=json.dumps({"reasoning": "插件正则版"}))
    assert get_message_reasoning(msg) == "插件正则版"
    assert get_display_content(msg) == "正文"


def test_legacy_single_write_row_extracts_from_content():
    """存量单写行：extra 无 reasoning，从 content 内联块拆出。"""
    msg = _Msg(content="前言<think>思路</think>正文", extra=None)
    assert get_message_reasoning(msg) == "思路"
    assert get_display_content(msg) == "前言正文"


def test_plain_row_identity():
    """普通行（无思考）：原样返回、思考为空。"""
    msg = _Msg(content="你好", extra=None)
    assert get_display_content(msg) == "你好"
    assert get_message_reasoning(msg) == ""


def test_unclosed_block_all_reasoning():
    """未闭合块（线上病例 id=2241 形态）：整段归思考、正文为空。"""
    msg = _Msg(content="<think>只有思考没有闭合", extra=None)
    assert get_message_reasoning(msg) == "只有思考没有闭合"
    assert get_display_content(msg) == ""


def test_prefix_text_with_unclosed_block_keeps_prefix():
    """前导正文 + 尾部未闭合块：正文保留前导，尾部归思考。"""
    msg = _Msg(content="正文A<think>尾巴", extra=None)
    assert get_display_content(msg) == "正文A"
    assert get_message_reasoning(msg) == "尾巴"


def test_multiple_blocks_strip_all_first_is_reasoning():
    """多个闭合块：全部剥离，思维链取首个块。"""
    msg = _Msg(content="<think>一</think>中<think>二</think>尾", extra=None)
    assert get_message_reasoning(msg) == "一"
    assert get_display_content(msg) == "中尾"


def test_invalid_extra_json_falls_back_to_content():
    """extra 为非法 JSON：安全降级，回落到 content 拆分路径。"""
    msg = _Msg(content="<think>思路</think>正文", extra="{not-json")
    assert get_message_reasoning(msg) == "思路"
    assert get_display_content(msg) == "正文"


def test_dict_input_supported():
    """dict 形态消息同样支持（API 序列化中间态兜底）。"""
    msg = {"content": "<think>s</think>c", "extra": json.dumps({"reasoning": "r"})}
    assert get_message_reasoning(msg) == "r"
    assert get_display_content(msg) == "c"


def test_none_content_and_empty_extra():
    msg = _Msg(content=None, extra=None)
    assert get_display_content(msg) == ""
    assert get_message_reasoning(msg) == ""


def test_whitespace_only_extra_reasoning_falls_through():
    """extra.reasoning 为纯空白：视为空，回落到 content 拆分。"""
    msg = _Msg(content="<think>思路</think>正文", extra=json.dumps({"reasoning": "   "}))
    assert get_message_reasoning(msg) == "思路"


def test_strip_inline_think_full_multi_block_and_unclosed_tail():
    """全量剥离：多闭合块 + 尾部未闭合块一并清除（迁移脚本同语义）。"""
    text = "前言<think>一</think>中<think>二</think>尾<think>未闭合尾巴"
    assert strip_inline_think_full(text) == "前言中尾"


def test_strip_inline_think_full_identity_without_tags():
    """无标签时原样返回（不做多余 strip）。"""
    assert strip_inline_think_full("  保持原样  ") == "  保持原样  "
