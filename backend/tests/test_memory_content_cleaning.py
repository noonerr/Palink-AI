"""[MEM-CLEAN] 记忆入库文本清洗：HTML 排版块 / markdown 表格空壳。

2026-09-23 实测依据（102 条存量）：正文 HTML 标签 0 条，但 markdown 表格 28 条
（27%），每条 21%~31% 字符是纯表格符号。用户拍板：
  - 表格：只清纯符号行，**不丢任何文字**；
  - HTML：带 class/style 的块级元素整块丢弃，普通标签只拆不丢，并加"删太多就退回"兜底。
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.utils import clean_memory_content  # noqa: E402


class TestThinkingAndFunctionBlocks:
    def test_thinking_block_removed(self):
        out = clean_memory_content("正文开始\n<thinking>我在想…</thinking>\n正文结束")
        assert "我在想" not in out
        assert "正文开始" in out and "正文结束" in out

    def test_updatevariable_block_removed(self):
        raw = '正文\n<UpdateVariable><Analysis>x</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>'
        out = clean_memory_content(raw)
        assert "UpdateVariable" not in out and "JSONPatch" not in out
        assert "正文" in out

    def test_orphan_tag_cleaned(self):
        out = clean_memory_content("正文</UpdateVariable>残留")
        assert "UpdateVariable" not in out

    # ---- [包U · R4 2026-10-19] 别名面与解析/剥离层同源 ----
    @pytest.mark.parametrize("raw,tag", [
        ('正文\n<update><JSONPatch>[{"op":"replace","path":"/a","value":1}]</JSONPatch></update>', "update"),
        ('正文\n<VariableUpdate>[{"op":"replace","path":"/a","value":1}]</VariableUpdate>', "VariableUpdate"),
        ('正文\n<JSONPatch>[{"op":"replace","path":"/a","value":1}]</JSONPatch>', "JSONPatch"),
        ('正文\n<UPDATEVARIABLE><Analysis>x</Analysis></UPDATEVARIABLE>', "UPDATEVARIABLE"),
    ])
    def test_alias_variable_blocks_removed(self, raw, tag):
        """上游三种别名 + 裸 <JSONPatch> 一律不许整块进向量记忆。

        改前 utils.clean_memory_content 手抄了一份只认 ``<UpdateVariable>`` 的私有正则
        （包Q §3.1 #2/#3），别名块整块进记忆 ⇒ 检索时 [:200] 截出半截标签，
        正是 2026-09-23「残缺标签进记忆→推理模型反复自我审查」的同型事故面。
        """
        out = clean_memory_content(raw)
        assert "正文" in out
        assert tag.lower() not in out.lower(), f"{tag} 标签残留在记忆里"
        assert '"op"' not in out, f"{tag} 的 patch 载荷残留在记忆里"

    @pytest.mark.parametrize("orphan", [
        "</update>", "<update>", "</VariableUpdate>", "<variableupdate>",
        "</JSONPatch>", "<json_patch>", "</UpdateVariable>",
    ])
    def test_orphan_alias_tags_cleaned(self, orphan):
        """截断残留的孤立别名标签同样不许进记忆（第 3 步清扫的别名面）。"""
        out = clean_memory_content(f"正文{orphan}残留")
        assert orphan.lower() not in out.lower()


class TestMarkdownTableScaffold:
    def test_scaffold_rows_removed_text_kept(self):
        raw = (
            "| | |\n"
            "|---|---|\n"
            "| 🧥 衣着 | 轻甲套装擦得锃亮，红色披风在身后猎猎作响 |\n"
            "| 🍰 心情 | 兴奋到快要跳起来 85% |\n"
        )
        out = clean_memory_content(raw)
        assert "|---" not in out, "分隔行必须清掉"
        assert "🚫" not in out
        # 文字一个字都不能丢
        for token in ("🧥 衣着", "轻甲套装擦得锃亮", "红色披风", "🍰 心情", "兴奋到快要跳起来 85%"):
            assert token in out, f"丢失内容: {token}"
        # 首尾竖线去掉，内部保留作分隔
        assert not any(line.strip().startswith("|") for line in out.split("\n"))

    def test_inline_pipe_not_mangled(self):
        """正文里的 |x| 只有 2 个竖线，不该被当表格处理。"""
        out = clean_memory_content("她的属性是 |攻击| 很高")
        assert "|攻击|" in out

    def test_plain_lines_untouched(self):
        out = clean_memory_content("第一行\n第二行\n\n第三行")
        assert out == "第一行\n第二行\n\n第三行"


class TestHtmlHandling:
    def test_styled_block_dropped_entirely(self):
        raw = (
            "她笑了笑，把咖啡推到你面前。\n\n"
            '<div class="status-bar"><span style="color:red">好感度 +5</span>'
            "<table><tr><td>地点</td><td>咖啡馆</td></tr></table></div>\n\n"
            '"味道不错吧？"她歪着头看你。'
        )
        out = clean_memory_content(raw)
        assert "好感度 +5" not in out, "排版块内的 UI 文字不应进记忆"
        assert "<div" not in out and "<span" not in out and "<table" not in out
        assert "她笑了笑" in out and "味道不错吧" in out

    def test_plain_tags_unwrapped_text_kept(self):
        out = clean_memory_content("她<b>很</b>开心，<i>脸颊微红</i>")
        assert "<b>" not in out and "<i>" not in out
        assert "她很开心" in out and "脸颊微红" in out

    def test_script_and_style_dropped(self):
        raw = '正文<style>.a{color:red}</style><script>alert(1)</script>结尾'
        out = clean_memory_content(raw)
        assert "color:red" not in out and "alert(1)" not in out
        assert "正文" in out and "结尾" in out

    def test_html_heavy_content_falls_back_to_unwrap(self):
        """兜底：整条正文都靠 HTML 承载时，不能整条丢空（HTML 卡不失忆）。"""
        raw = (
            '<div class="card"><div class="name">桃汐</div>'
            '<div class="desc">一位爱喝咖啡的猫娘，性格傲娇</div>'
            '<div class="skill">技能：拉花</div></div>'
        )
        out = clean_memory_content(raw)
        assert out.strip(), "不得整条变空"
        assert "桃汐" in out and "猫娘" in out
        assert "<div" not in out
