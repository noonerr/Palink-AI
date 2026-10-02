"""[PROMPT-EVERY-TURN 2026-10-02 + HISTORY-KEEP-SHELL 2026-10-02] 历史清洗白名单回归。

SPEC：docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md P2。
旧兜底正则 `<[^>]+>` 把 <UpdateVariable>/<initvar> 一并吃掉，模型后续轮次
失去变量模式参照。改白名单后的双向断言（验收线 #3）：
**变量块/状态栏占位符/外壳记号存活** + **显示标签擦净**，两个方向都不许过头。

[HISTORY-KEEP-SHELL] 外壳记号原属"擦净"那一侧，2026-10-02 由 A/B/C + 稳态四组实测
推翻（用户拍板改默认）：擦除会把上一轮唯一正例改写成裸文范例，模型随后照抄裸文
（turn3 出框率 0% → 88%）。现外壳与变量块同列"必须存活"。

夹板形态取证自真实落库消息 2464（露缇雅1.2 开场白）：
标签族 = story, cg, initvar, UpdateVariable, StatusPlaceHolderImpl（自闭合），
另含 <background scene="…" /> 自闭合外壳（2468 swipe0 实测）。
"""

import os
import re
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import app.services.character_message_builder as builder  # noqa: E402
from app.services.character_message_builder import clean_display_markup_for_prompt  # noqa: E402

# 卡「正文美化」正则的 Python 移植（与 characters.extensions.regex_scripts 逐字同源）
CARD_REGEX = re.compile(
    r"<(story|Lnterleaving|now_plot|content|正文)>([\s\S]*?)<\/\1>", re.IGNORECASE
)
# 两层范例（消息 2466 实测形态：外层 now_plot + 内层 content）
TWO_LAYER_ENTRY = (
    "<now_plot>\n<content>\n叙述正文。\n</content>\n</now_plot>"
)
# 单层范例（消息 2497 实测形态）
SINGLE_LAYER_ENTRY = "<now_plot>\n叙述正文。\n</now_plot>"


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


class TestShellKeptInHistory:
    """[HISTORY-KEEP-SHELL 2026-10-02] 外壳记号必须随历史存活（推翻旧「擦净」方向）。"""

    def test_shell_tags_all_kept(self):
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        for tag in ("story", "cg", "now_plot", "content", "background", "Lnterleaving", "正文"):
            if f"<{tag}>" in GREETING_LIKE:
                assert f"<{tag}>" in out, tag
        assert "<story>" in out and "</story>" in out
        assert "<cg>露出魔纹1</cg>" in out  # 标记与内容一并保住
        assert "露出魔纹1" in out

    def test_unclosed_shell_kept(self):
        # 2468 swipe0 形态：只开不闭 —— 原样保留，本层不做归一
        out = clean_display_markup_for_prompt('<now_plot>\n<content>\n<background scene="哥哥的卧室" />\n正文')
        assert "<now_plot>" in out and "<content>" in out
        assert '<background scene="哥哥的卧室" />' in out
        assert "正文" in out

    def test_shell_with_attributes_self_closing_kept(self):
        out = clean_display_markup_for_prompt('<background scene="庭院" />\n叙述')
        assert '<background scene="庭院" />' in out
        assert "叙述" in out


class TestTwoLayerHistoryBoundary:
    """[HISTORY-KEEP-SHELL] 已知边界的固化断言（零成本实测于库内 2466/2497）。

    本层**故意不兜底**：历史里的两层范例原样进 prompt。这里把两侧指纹钉住，
    避免将来有人误以为装配层会做归一 —— 真需要归一应另立议题在生成/显示侧解决。

    实测口径（`--history-cell 2466,2497`，卡真实正则，零模型请求）：
      两层范例（2466）→ frames=1, **leak=1**（内层 <content> 落进捕获组）
      单层范例（2497）→ frames=1, leak=0
    """

    @staticmethod
    def _leak(text: str) -> tuple[int, int]:
        matches = CARD_REGEX.findall(text)
        leaks = sum(
            1 for _tag, cap in matches if re.search(r"</?content>", cap, re.IGNORECASE)
        )
        return len(matches), leaks

    def test_two_layer_entry_passes_through_and_leaks_inner_tag(self):
        out = clean_display_markup_for_prompt(TWO_LAYER_ENTRY)
        assert "<now_plot>" in out and "<content>" in out  # 未归一
        frames, leaks = self._leak(out)
        assert frames == 1 and leaks == 1

    def test_single_layer_entry_is_clean(self):
        out = clean_display_markup_for_prompt(SINGLE_LAYER_ENTRY)
        frames, leaks = self._leak(out)
        assert frames == 1 and leaks == 0

    def test_display_html_still_stripped_alongside_shell(self):
        out = clean_display_markup_for_prompt('<div>x</div><story>y</story>')
        assert "<div>" not in out and "x" in out  # 显示标签照旧擦
        assert "<story>" in out  # 外壳照旧留


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
        # 方向一：变量块、占位符、外壳记号都必须在（HISTORY-KEEP-SHELL 后同列）
        assert "<UpdateVariable>" in out and "<initvar>" in out and "<StatusPlaceHolderImpl/>" in out
        assert "<story>" in out and "<cg>露出魔纹1</cg>" in out
        # 方向二：正文零变化 + 空行已折叠（防止改过头回到旧「全删」）
        assert "露缇雅睁开眼" in out and "帮帮我" in out
        assert "\n\n\n" not in out

    def test_whitespace_normalized(self):
        out = clean_display_markup_for_prompt("a\n\n\n\n\nb")
        assert "\n\n\n" not in out

    def test_legacy_full_strip_length_delta_small(self):
        # 白名单版保留的只是标签文本本身，正文零变化；变量块 YAML 全文在内
        out = clean_display_markup_for_prompt(GREETING_LIKE)
        assert len(out) > 150
        assert "2026" in out and "魔力值: 60" in out


def test_builder_module_exposes_compiled_patterns():
    # 防回归：白名单正则必须存在且已预编译（性能口径）
    assert builder._DISPLAY_TAG_WHITELIST_RE is not None
    assert builder._DISPLAY_TAG_WHITELIST_RE.search("<StatusPlaceHolderImpl/>") is None
    # [HISTORY-KEEP-SHELL] 外壳擦除常量已随「改默认」一并删除，别再长回来
    assert not hasattr(builder, "_SHELL_TAG_STRIP_RE")
    assert not hasattr(builder, "_history_keep_shell_tags")
