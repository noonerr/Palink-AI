"""世界书 EJS/underscore 模板语法剥离测试.

角色卡（如"妈妈文学"卡）的常驻世界书条目内容含 <%_ if (v('...') === '是') { _%> 等
JS 模板语法，后端无 JS 渲染器，注入前必须剥离，避免模板代码残骸进入模型上下文。
"""
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.worldbook_service import strip_template_syntax
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestStripTemplateSyntax:
    def test_removes_ejs_condition_block(self):
        text = "<%_ if (v('世界.位置.区域') === '耶特米王国') { _%>\n地点名称: 黑岩台地\n<%_ } _%>"
        cleaned = strip_template_syntax(text)
        assert "<%" not in cleaned
        assert "地点名称: 黑岩台地" in cleaned

    def test_removes_short_ejs_tags(self):
        text = "值: <%= value %> 结束"
        cleaned = strip_template_syntax(text)
        assert "<%" not in cleaned
        assert "值: 结束" in cleaned

    def test_preserves_normal_content(self):
        text = "普通文本\n- 项目一\n- 项目二"
        assert strip_template_syntax(text) == text

    def test_handles_multiline_ejs_blocks(self):
        text = "A\n<%_ if (cond) { _%>\nB\n<%_ } else { _%>\nC\n<%_ } _%>\nD"
        cleaned = strip_template_syntax(text)
        assert "<%" not in cleaned
        assert "A" in cleaned and "D" in cleaned

    def test_empty_and_none(self):
        assert strip_template_syntax("") == ""
        assert strip_template_syntax(None) == ""

    def test_collapses_excess_blank_lines(self):
        text = "A\n\n\n\n\n<%_ if (x) { _%>\n\n\n\n<%_ } _%>\n\n\nB"
        cleaned = strip_template_syntax(text)
        assert "\n\n\n\n\n" not in cleaned
