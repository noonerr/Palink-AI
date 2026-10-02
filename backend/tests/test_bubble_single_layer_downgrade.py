"""[SHELL-SINGLE-LAYER 2026-10-02] 两层→单层外壳改写回归（用户拍板⑤）。

SPEC：docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md 决定⑤。
错配实锤：v7.x 规范要求 <now_plot><content> 两层嵌套，卡「正文美化」正则用
单层反向引用 /<(story|Lnterleaving|now_plot|content|正文)>([\s\S]*?)<\/\1>/gi
——配外层时内层 <content> 原样漏进渲染框（消息 2466 上下各露一对 content
记号）；模型只写一半时配不上、整块不出框（消息 2468）。

改写范围（用户拍板）：只挂「无 @bubble 渲染能力」的降级路径
（_downgrade_bubble_injections），不动有宿主的卡。
"""

import os
import re
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import app.services.roleplay_prompt_assembly as assembly  # noqa: E402

# 真实形态（逐字取证自 plugin_scripts「对话渲染系统 v7.1」DEFAULT_FORMAT_RULE，
# 2026-10-02）：@bubble 三段 + [正文标签规则] + [背景标签规则] + 输出结构 + 示例。
V71_SPEC = """[对话渲染格式规范]
当角色产生想法、进行对白时必须严格使用以下格式（全部在同一行内）：

@bubble:角色名|情绪|“对白”

格式规则：
1. @bubble: 是固定前缀，不可更改
2. 角色名、情绪、台词之间用 | 分隔

[正文标签规则]
<content> 标签外面必须包一层 <now_plot> 标签。

[背景标签规则（强制）]
场景切换时，必须在 <content> 内的正文开头输出背景标签：
- 格式: <background scene="场景名" />
- 每次场景发生变化时都必须输出，不可省略

输出结构：
<now_plot>
<content>
（正文内容）
</content>
</now_plot>

示例：
<now_plot>
<content>
诺亚傻站着愣了半秒，忽闪着大眼睛直勾勾盯着我。

@bubble:城崎诺亚|欣喜|“咦？真的吗？”

她似乎在脑海里搜索了相关的经验。

@bubble:？？？|兴奋|“喂！你们！”
</content>
</now_plot>"""

# 卡「正文美化」正则的 Python 移植（与 characters.extensions.regex_scripts 逐字同源）
CARD_REGEX = re.compile(r"<(story|Lnterleaving|now_plot|content|正文)>([\s\S]*?)<\/\1>", re.IGNORECASE)


def _downgraded():
    return assembly._downgrade_two_layer_shell_to_single(
        assembly._strip_bubble_marker_instructions(V71_SPEC)
    )


class TestSingleLayerDowngrade:
    def test_bubble_sections_removed(self):
        out = _downgraded()
        assert "@bubble" not in out
        assert "对话渲染格式规范" not in out
        assert "情绪词" not in out

    def test_rule_line_rewritten(self):
        out = _downgraded()
        assert "标签外面必须包一层" not in out
        assert "单层" in out and "<now_plot>" in out

    def test_background_rule_no_content_mention(self):
        out = _downgraded()
        assert "在 <content> 内的正文开头" not in out
        assert "必须在正文开头输出背景标签" in out
        assert '<background scene="场景名" />' in out  # 背景标签规则本体保留

    def test_output_structure_single_layer(self):
        out = _downgraded()
        assert "<content>" not in out and "</content>" not in out
        # 摘行后可能留下空行，用空白容忍断言
        assert re.search(r"<now_plot>\s*（正文内容）\s*</now_plot>", out)

    def test_example_prose_survives(self):
        out = _downgraded()
        assert "诺亚傻站着愣了半秒" in out

    def test_noop_when_no_known_patterns(self):
        text = "普通注入文本，没有外壳要求。<p>html</p>"
        assert assembly._downgrade_two_layer_shell_to_single(text) == text
        assert assembly._downgrade_two_layer_shell_to_single("") == ""


class TestCardRegexCompatibility:
    """验收线 #2 的前置单测：改写后的规范产出喂卡正则，捕获组不得含内层标签。"""

    def test_scaffold_matches_card_regex_cleanly(self):
        out = _downgraded()
        matches = CARD_REGEX.findall(out)
        assert matches, "改写后的输出结构必须能被卡正则命中"
        for _tag, captured in matches:
            assert "<content>" not in captured and "</content>" not in captured

    def test_two_layer_original_leaks_inner_tags(self):
        # 反向锚定：未改写的两层结构喂卡正则，外层匹配的捕获组含内层标签
        # （= 2466「上下露一对 content 记号」的成因复现）
        matches = CARD_REGEX.findall(V71_SPEC)
        assert matches
        assert any("<content>" in cap for _tag, cap in matches)

    def test_model_single_layer_output_matches(self):
        # 规范改成单层后，模型按新规范输出的形态必须被卡正则命中 ≥1 次
        model_output = "<now_plot>\n温热的触感从肩膀上传来。\n\n【声音：少女声线】\n</now_plot>"
        assert len(CARD_REGEX.findall(model_output)) >= 1


class TestDowngradeScope:
    def test_applied_only_in_downgrade_path(self, monkeypatch):
        # 降级路径（无支持）：内容被单层化
        merged = {"fmt": {"identifier": "fmt", "content": V71_SPEC, "position": 0, "depth": 0,
                          "role": "system", "scan": False, "filter": {}}}
        entries = [merged["fmt"]]
        kept, dropped = assembly._downgrade_bubble_injections(merged, entries)
        assert (kept, dropped) == (1, 0)
        assert "<content>" not in merged["fmt"]["content"]

    def test_noop_guard_returns_original_object_content(self):
        # 匹配不到已知句式时返回原文本（不丢尾空白语义）
        text = "保持原样\n\n\n多空行折叠"
        out = assembly._downgrade_two_layer_shell_to_single(text)
        assert out == "保持原样\n\n多空行折叠"
