"""内联 <think> 统一解析器单测（spec: separate-reasoning-pipeline R2）。"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.utils import split_inline_think, strip_inline_think
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def test_split_standard():
    reasoning, content = split_inline_think("<think>思路A</think>正文B")
    assert reasoning == "思路A"
    assert content == "正文B"


def test_split_with_prefix_text():
    """think 前有文字：文字并入 content（保留上下文完整性）。"""
    reasoning, content = split_inline_think("前言<think>思路</think>正文")
    assert reasoning == "思路"
    assert "前言" in content and "正文" in content


def test_unclosed_think_all_reasoning():
    """未闭合（本次线上病例 id=2241 形态）：全部视为思考、正文为空。"""
    reasoning, content = split_inline_think("<think>只有思考没有闭合")
    assert "只有思考没有闭合" in reasoning
    assert content == ""


def test_multiple_blocks_first_wins():
    """多次出现：取首个块为 reasoning，其余留在 content。"""
    reasoning, content = split_inline_think("<think>第一段</think>中间<think>第二段</think>结尾")
    assert reasoning == "第一段"
    assert "第二段" in content and "结尾" in content


def test_no_think_returns_original():
    text = "普通正文，没有任何标签。"
    reasoning, content = split_inline_think(text)
    assert reasoning == ""
    assert content == text


def test_empty_and_none_safe():
    assert split_inline_think("") == ("", "")
    assert split_inline_think(None) == ("", "")


def test_case_insensitive_and_attributes():
    """大小写不敏感 + 开标签带属性（与历史清洗正则同语义）。"""
    reasoning, content = split_inline_think("<THINK class=x>思路</Think >正文")
    assert reasoning == "思路"
    assert content == "正文"


def test_strip_removes_all_blocks():
    text = "<think>A</think>开头<Think >B</think>结尾"
    out = strip_inline_think(text)
    assert out == "开头结尾"


def test_strip_keeps_unclosed_unchanged():
    """strip 与历史清洗正则语义一致：未闭合块不动（行为等价保护）。"""
    text = "<think>未闭合的思考保留"
    assert strip_inline_think(text) == text


def test_strip_plain_text_unchanged():
    assert strip_inline_think("干净正文") == "干净正文"
