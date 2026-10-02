"""[PROMPT-EVERY-TURN 2026-10-02] 历史擦标签白名单化回归。

SPEC：docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md P2。
旧兜底正则 `<[^>]+>` 把 <UpdateVariable>/<initvar> 一并吃掉，模型后续轮次
失去变量模式参照。改白名单后双向断言（验收线 #3）：
变量块/状态栏占位符存活 + 外壳记号擦净，两个方向都不许过头。

夹板形态取证自真实落库消息 2464（露缇雅1.2 开场白）：
标签族 = story, cg, initvar, UpdateVariable, StatusPlaceHolderImpl（自闭合），
另含 <background scene="…" /> 自闭合外壳（2468 swipe0 实测）。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import app.services.character_message_builder as builder  # noqa: E402
from app.services.character_message_builder import clean_display_markup_for_prompt  # noqa: E402


GREETING_LIKE = (
    "<story>\n七月的清晨，庭院里的日光穿过枫木树梢。\n\n露缇雅睁开眼。\n"
    "<cg>露出魔纹1</cg>\n"
    "“哥哥……帮帮我。”\n"
    "</story>\n"
    "<UpdateVariable>\n<initvar>\n环境:\n  时间:\n    年: 2026\n"
    "露缇雅:\n  状态:\n    爱意: 5\n    魔力值: 60\n"
    "</initvar>\n</UpdateVariable>\n\n"
    "<StatusPlaceHolderImpl/>"
)


class TestVariableBlockSurvives:
    def test_update_variable_block_kept(self):
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert "<UpdateVariable>" in out and "</UpdateVariable>" in out
        assert "<initvar>" in out and "</initvar>" in out
        assert "爱意: 5" in out and "魔力值: 60" in out

    def test_status_placeholder_self_closing_kept(self):
        # 自闭合形态必须匹配不到删除正则（用户实测：2464 标签族含该标签，
        # 旧骨架正则匹配不到自闭合是已知坑）
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert "<StatusPlaceHolderImpl/>" in out

    def test_unknown_custom_tag_survives(self):
        out = clean_display_markup_for_prompt("正文\n<自定义标记>内容</自定义标记>\n尾部")
        assert "<自定义标记>" in out and "</自定义标记>" in out


class TestShellStripped:
    def test_shell_tags_all_removed(self):
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        for tag in ("story", "cg", "now_plot", "content", "background", "Lnterleaving", "正文"):
            assert f"<{tag}>" not in out, tag
            assert f"</{tag}>" not in out, tag
        assert "露出魔纹1" in out  # cg 内容保留，只擦标记

    def test_unclosed_shell_still_stripped(self):
        # 2468 swipe0 形态：只开不闭
        out = clean_display_markup_for_prompt('<now_plot>\n<content>\n<background scene="哥哥的卧室" />\n正文')
        assert "<now_plot>" not in out and "<content>" not in out
        assert '<background scene="哥哥的卧室" />' not in out
        assert "正文" in out

    def test_shell_with_attributes_self_closing(self):
        out = clean_display_markup_for_prompt('<background scene="庭院" />\n叙述')
        assert "background" not in out
        assert "叙述" in out


class TestCExperimentSwitch:
    """[C-EXPERIMENT 2026-10-02] 历史外壳保留开关（默认关闭 = 「决定②」不变）。

    用途：验证「历史里的裸文参照」是否为多轮跳壳的近因（A/B/C 对照的 C 组）。
    装配层每轮把历史 assistant 回复的 <now_plot>/<content>/story 擦掉，等于把
    上一轮的正例主动改写成裸文，模型随后照抄裸文——本开关就是关掉这一步。
    """

    def test_default_off_keeps_decision_two(self, monkeypatch):
        monkeypatch.delenv("PALINK_HISTORY_KEEP_SHELL_TAGS", raising=False)
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert "<story>" not in out and "</story>" not in out

    def test_switch_on_keeps_shell_tags(self, monkeypatch):
        monkeypatch.setenv("PALINK_HISTORY_KEEP_SHELL_TAGS", "1")
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert "<story>" in out and "</story>" in out
        assert "<cg>露出魔纹1</cg>" in out  # 标记与内容一并保住
        assert "<UpdateVariable>" in out  # 变量块与开关无关，两模式都存活

    def test_switch_on_still_strips_display_html(self, monkeypatch):
        monkeypatch.setenv("PALINK_HISTORY_KEEP_SHELL_TAGS", "1")
        out = clean_display_markup_for_prompt('<div>x</div><story>y</story>')
        assert "<div>" not in out and "x" in out  # 显示标签照旧擦
        assert "<story>" in out


class TestDisplayHtmlStillStripped:
    def test_display_tags_removed(self):
        text = '<div style="x"><span class="y">段落</span><br>下一行<img src="a.png"><table><tr><td>格</td></tr></table></div>'
        out = clean_display_markup_for_prompt(text)
        assert "<" not in out and ">" not in out
        assert "段落" in out and "下一行" in out and "格" in out

    def test_style_script_content_removed(self):
        out = clean_display_markup_for_prompt("前文<style>.a{color:red}</style>中<script>evil()</script>后文")
        assert "color:red" not in out and "evil()" not in out
        assert "前文" in out and "中" in out and "后文" in out

    def test_html_comment_removed(self):
        out = clean_display_markup_for_prompt("前<!-- 注释 -->后")
        assert "注释" not in out
        assert "前后" in out

    def test_code_fence_html_removed(self):
        out = clean_display_markup_for_prompt("前```html\n<div>x</div>\n```后")
        assert "<div>" not in out
        assert "前" in out and "后" in out

    def test_heading_and_list_closing_become_newlines(self):
        out = clean_display_markup_for_prompt("<h1>标题</h1>\n<ul><li>项</li></ul>")
        assert "<" not in out
        assert "标题" in out and "项" in out


class TestBidirectionalGuard:
    """验收线 #3 的单测固化：一个夹板同时断言两个方向，防止改过头。"""

    def test_real_shape_both_directions(self):
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        # 方向一：变量块与占位符必须在
        assert "<UpdateVariable>" in out and "<initvar>" in out and "<StatusPlaceHolderImpl/>" in out
        # 方向二：外壳与显示标签必须净
        assert "<" + "story>" not in out and "<cg>" not in out
        assert "露缇雅睁开眼" in out and "帮帮我" in out

    def test_whitespace_normalized(self):
        out = clean_display_markup_for_prompt("a\n\n\n\n\nb")
        assert "\n\n\n" not in out

    def test_legacy_full_strip_length_delta_small(self):
        # 白名单版保留的只是标签文本本身，正文零变化；变量块 YAML 全文在内
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert len(out) > 150
        assert "2026" in out and "魔力值: 60" in out


def test_builder_module_exposes_compiled_patterns():
    # 防回归：白名单/外壳正则必须存在且已预编译（性能口径）
    assert builder._DISPLAY_TAG_WHITELIST_RE is not None
    assert builder._SHELL_TAG_STRIP_RE is not None
    assert builder._SHELL_TAG_STRIP_RE.search("<now_plot>") is not None
    assert builder._DISPLAY_TAG_WHITELIST_RE.search("<StatusPlaceHolderImpl/>") is None
