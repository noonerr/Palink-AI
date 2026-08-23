"""标签平衡守卫（balance_custom_tags）单测。

背景：角色卡世界书/插件注入常带不平衡自定义标签，推理模型遇到后
把全部输出写进 <think> 并复读尾部指令（正文为空）。
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.utils import balance_custom_tags
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def test_unclosed_chinese_tag_gets_closed():
    """实测主病灶：<猫神> 开标签无配对闭合 → 文末补 </猫神>。"""
    text = '【格式强调】必须用<猫神>标签包裹。示例：<猫神>呼呼呼喵~'
    out = balance_custom_tags(text)
    assert out.endswith("</猫神>")
    assert "<猫神>" in out


def test_orphan_close_tag_stripped():
    """孤立闭合标签（如 think 开头出现的 </p>、</Input>）→ 剥离。"""
    assert balance_custom_tags("正文开头</p>继续叙述") == "正文开头继续叙述"
    assert balance_custom_tags("</Input>由你直接开始扮演") == "由你直接开始扮演"


def test_balanced_html_untouched():
    text = '<div style="a:1"><span>你好</span></div>'
    assert balance_custom_tags(text) == text


def test_void_tags_not_paired():
    text = "第一行<br>第二行<img src='x'>结束"
    assert balance_custom_tags(text) == text


def test_bare_user_tag_closed():
    """「角色总览」条目：与<user>在女仆咖啡店有过一面之缘。"""
    text = "与<user>在女仆咖啡店有过一面之缘"
    out = balance_custom_tags(text)
    assert out.endswith("</user>")
    assert "与<user>在女仆咖啡店有过一面之缘" in out


def test_real_catgirl_card_case():
    """组合复现：未闭合 <猫神> + 孤立 </p> 同时存在。"""
    text = (
        "【格式强调】用<猫神>标签包裹。示例：<猫神>呼呼呼喵~\n"
        "</p>\n剧情继续。"
    )
    out = balance_custom_tags(text)
    assert "</p>" not in out          # 孤立闭合被剥离
    assert out.endswith("</猫神>")     # 未闭合被补齐


def test_plain_text_unchanged():
    assert balance_custom_tags("没有任何标签的普通文本。") == "没有任何标签的普通文本。"
    assert balance_custom_tags("") == ""
    assert balance_custom_tags(None) == ""  # None 按空串处理（契约恒返回 str）


def test_multiple_missing_closes_nested_order():
    """多个未闭合：后开的先闭。"""
    text = "<外层><内层>内容"
    out = balance_custom_tags(text)
    assert out.endswith("</内层></外层>")


def test_comparison_less_than_not_treated_as_tag():
    """数学比较 'a < b' 不应误判为标签。"""
    text = "如果 x < y 那么成立"
    assert balance_custom_tags(text) == text
