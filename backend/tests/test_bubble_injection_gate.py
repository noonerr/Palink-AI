"""[PLUGIN-ON-DEMAND] @bubble 注入按角色门控回归（2026-09-25 用户拍板）。

背景：「对话渲染系统」类 tavern_helper 脚本全局注入 @bubble 格式规范，
渲染由卡内配套正则 JS 完成——裸卡没有配套，标记无人渲染裸奔。
判定标准（用户拍板）：自动识别配套正则；无配套时丢弃 @bubble 类注入。
"""

import os
import sys
from types import SimpleNamespace

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.api.character_ext as character_ext  # noqa: E402
import app.services.roleplay_prompt_assembly as assembly  # noqa: E402

BUBBLE_SPEC = "[对话渲染格式规范]\n@bubble:角色名|情绪|[对白] …… 每次说话必须带上 @bubble 标记"
# 真实形态（取证于「对话渲染系统 v7.1」DEFAULT_FORMAT_RULE，2026-10-02）：一条注入里
# 同时装着 @bubble 用法说明 **和** 与它无关的 <now_plot> 包裹规则——后者才是卡内
# 「正文美化」正则的消费方，智能卡的图文排版框出自它。
MIXED_SPEC = (
    BUBBLE_SPEC
    + "\n\n[正文标签规则]\n<content> 标签外面必须包一层 <now_plot> 标签。\n\n"
    "输出结构：\n<now_plot>\n<content>\n（正文内容）\n"
    "@bubble:城崎诺亚|欣喜|“咦？真的吗？”\n"
    "</content>\n</now_plot>"
)
PLAIN_INJECTION = {"identifier": "some-other-plugin", "content": "普通插件注入，与 bubble 无关", "position": 1, "depth": 4, "role": "system"}


def _bubble_entry(identifier="bubble-format", content=BUBBLE_SPEC):
    return {"identifier": identifier, "content": content, "position": 1, "depth": 0, "role": "system", "scan": False, "filter": {}}


def _make_req(char_extensions=None, extension_prompts=None, plugin_scope_mode=None, char_id=None):
    """_collect_extension_prompts 的最小请求替身。

    db.query 直接抛错 → DB ExtensionPrompt 加载分支被容错跳过（该分支
    有 try/except 包裹），单测聚焦请求侧注入的过滤逻辑。
    plugin_scope_mode=None → 模拟「列不存在 / 未设置」，应等价 inherit。
    """
    return SimpleNamespace(
        db=SimpleNamespace(query=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no db in unit test"))),
        user=SimpleNamespace(id=42),
        char=SimpleNamespace(id=char_id, extensions=char_extensions, plugin_scope_mode=plugin_scope_mode),
        session_id="sess-1",
        extension_prompts=extension_prompts or [],
    )


def _patch_loaders(monkeypatch, plugin_scripts, ext_scripts):
    monkeypatch.setattr(character_ext, "_load_plugin_regex_script_dicts", lambda db: plugin_scripts)
    monkeypatch.setattr(character_ext, "_load_extension_settings_regex_scripts", lambda db, user_id: ext_scripts)


class TestCardBubbleRegexDetection:
    def test_card_with_bubble_render_regex(self):
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble:[^\\\\n]+", "replaceString": "<div>bubble</div>"}]}'
        assert assembly._char_card_has_bubble_regex(card) is True

    def test_card_without_regex(self):
        assert assembly._char_card_has_bubble_regex('{"regex_scripts": []}') is False
        assert assembly._char_card_has_bubble_regex(None) is False
        assert assembly._char_card_has_bubble_regex("not-json") is False

    def test_disabled_script_not_counts(self):
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble", "disabled": true}]}'
        assert assembly._char_card_has_bubble_regex(card) is False

    def test_prompt_only_script_not_counts(self):
        # promptOnly 脚本只改提示词不做渲染，不构成配套
        card = '{"regex_scripts": [{"scriptName": "气泡注入", "findRegex": "@bubble", "promptOnly": true}]}'
        assert assembly._char_card_has_bubble_regex(card) is False

    def test_english_bubble_and_keyword_hits(self):
        assert assembly._char_card_has_bubble_regex('{"regex_scripts": [{"findRegex": "BubbleChat"}]}') is True
        assert assembly._char_card_has_bubble_regex('{"regex_scripts": [{"scriptName": "对话渲染模板"}]}') is True


class TestThreeSourceSupport:
    """源 2/3（插件正则、用户扩展设置正则）的消费方是 dcRoot iframe，
    [BUBBLE-HOST-GATE 2026-10-01] 起仅当 PALINK_BUBBLE_IFRAME_HOST=1 时成立。"""

    def test_plugin_regex_script_counts(self, monkeypatch):
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")
        _patch_loaders(monkeypatch, plugin_scripts=[
            {"scriptName": "BubbleRender", "findRegex": "@bubble:.*", "replaceString": "<div/>"},
        ], ext_scripts=[])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is True

    def test_extension_settings_regex_counts(self, monkeypatch):
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[
            {"scriptName": "r", "findRegex": "@bubble", "replaceString": "x"},
        ])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is True

    def test_plugin_regex_without_iframe_host_does_not_count(self, monkeypatch):
        # 宿主不可用时插件正则不构成配套（回归红线：这是 2026-10-01 收紧的本意）
        monkeypatch.delenv("PALINK_BUBBLE_IFRAME_HOST", raising=False)
        _patch_loaders(monkeypatch, plugin_scripts=[
            {"scriptName": "BubbleRender", "findRegex": "@bubble:.*", "replaceString": "<div/>"},
        ], ext_scripts=[])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is False

    def test_card_regex_source_needs_no_iframe_host(self, monkeypatch):
        # 源 1（卡自带正则）不走 iframe 门控：正则可能直接产出内联 HTML
        monkeypatch.delenv("PALINK_BUBBLE_IFRAME_HOST", raising=False)
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble", "replaceString": "<div/>"}]}'
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=card) is True

    def test_no_source_no_support(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is False

    def test_loader_failure_falls_back_to_false(self, monkeypatch):
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")
        def _boom(*a, **k):
            raise RuntimeError("boom")
        monkeypatch.setattr(character_ext, "_load_plugin_regex_script_dicts", _boom)
        monkeypatch.setattr(character_ext, "_load_extension_settings_regex_scripts", _boom)
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is False


class TestInjectionGate:
    def test_bubble_injection_dropped_without_support(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(char_extensions=None, extension_prompts=[_bubble_entry(), PLAIN_INJECTION])
        result = assembly._collect_extension_prompts(req)
        ids = [e["identifier"] for e in result]
        assert "bubble-format" not in ids
        assert "some-other-plugin" in ids

    def test_bubble_injection_kept_with_card_companion(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble", "replaceString": "<div/>"}]}'
        req = _make_req(char_extensions=card, extension_prompts=[_bubble_entry()])
        result = assembly._collect_extension_prompts(req)
        assert [e["identifier"] for e in result] == ["bubble-format"]

    def test_bubble_injection_kept_with_plugin_companion(self, monkeypatch):
        monkeypatch.setenv("PALINK_BUBBLE_IFRAME_HOST", "1")
        _patch_loaders(monkeypatch, plugin_scripts=[
            {"scriptName": "BubbleRender", "findRegex": "@bubble:.*", "replaceString": "<div/>"},
        ], ext_scripts=[])
        req = _make_req(char_extensions=None, extension_prompts=[_bubble_entry()])
        result = assembly._collect_extension_prompts(req)
        assert [e["identifier"] for e in result] == ["bubble-format"]

    def test_plain_injection_unaffected_when_no_bubble_entries(self, monkeypatch):
        # 无 bubble 注入时不触发能力判定，普通注入原样通过
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(char_extensions=None, extension_prompts=[PLAIN_INJECTION])
        result = assembly._collect_extension_prompts(req)
        assert [e["identifier"] for e in result] == ["some-other-plugin"]

    def test_none_position_entry_still_overrides_db(self, monkeypatch):
        # position=NONE（运行时禁用）语义不受门控影响
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        entry = _bubble_entry()
        entry["position"] = -1
        req = _make_req(char_extensions=None, extension_prompts=[entry])
        result = assembly._collect_extension_prompts(req)
        assert result == []


class TestScopeModeReader:
    """_character_plugin_scope_mode：读取失败的退化为 inherit（回归红线）。"""

    def test_missing_column_is_inherit(self):
        assert assembly._character_plugin_scope_mode(None) == "inherit"
        assert assembly._character_plugin_scope_mode(SimpleNamespace()) == "inherit"

    def test_none_and_empty_are_inherit(self):
        assert assembly._character_plugin_scope_mode(SimpleNamespace(plugin_scope_mode=None)) == "inherit"
        assert assembly._character_plugin_scope_mode(SimpleNamespace(plugin_scope_mode="")) == "inherit"
        assert assembly._character_plugin_scope_mode(SimpleNamespace(plugin_scope_mode="  ")) == "inherit"

    def test_allowlist_normalized(self):
        assert assembly._character_plugin_scope_mode(SimpleNamespace(plugin_scope_mode="AllowList")) == "allowlist"
        assert assembly._character_plugin_scope_mode(SimpleNamespace(plugin_scope_mode=" ALLOWLIST ")) == "allowlist"

    def test_attribute_access_raising_degrades_to_inherit(self):
        class _Boom:
            @property
            def plugin_scope_mode(self):
                raise RuntimeError("column not migrated")

        assert assembly._character_plugin_scope_mode(_Boom()) == "inherit"

    def test_debug_flag_reader(self, monkeypatch):
        monkeypatch.delenv("BUBBLE_DEBUG", raising=False)
        assert assembly._bubble_debug_forced() is False
        for truthy in ("1", "true", "TRUE", "on", "yes"):
            monkeypatch.setenv("BUBBLE_DEBUG", truthy)
            assert assembly._bubble_debug_forced() is True
        for falsy in ("", "0", "false", "off", "no"):
            monkeypatch.setenv("BUBBLE_DEBUG", falsy)
            assert assembly._bubble_debug_forced() is False


class TestAssemblyDefersToUserChoice:
    """spec §2.5.1：BUBBLE_DEBUG > 用户显式选择 > 装配层自动门控。"""

    def test_allowlist_still_gated_on_bubble_render_support(self, monkeypatch):
        # [BUBBLE-HOST-GATE 2026-10-01] 用户勾了插件 ≠ 这张卡能渲染 @bubble：
        # 纯 @bubble 规范（摘完什么都不剩）仍然整条丢弃
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(), PLAIN_INJECTION],
            plugin_scope_mode="allowlist",
            char_id="card-allow-1",
        )
        result = assembly._collect_extension_prompts(req)
        ids = [e["identifier"] for e in result]
        assert "bubble-format" not in ids
        assert "some-other-plugin" in ids

    def test_inherit_still_drops_bubble_without_support(self, monkeypatch):
        # 回归红线：inherit 行为与改造前完全一致
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry()],
            plugin_scope_mode="inherit",
        )
        assert assembly._collect_extension_prompts(req) == []

    def test_unset_mode_behaves_as_inherit(self, monkeypatch):
        # plugin_scope_mode 列不存在/为 NULL → 与 inherit 一致
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(char_extensions=None, extension_prompts=[_bubble_entry()])
        assert assembly._collect_extension_prompts(req) == []

    def test_debug_escape_hatch_overrides_everything(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        monkeypatch.setenv("BUBBLE_DEBUG", "1")
        req = _make_req(char_extensions=None, extension_prompts=[_bubble_entry()])
        assert [e["identifier"] for e in assembly._collect_extension_prompts(req)] == ["bubble-format"]

    def test_debug_escape_hatch_also_wins_over_allowlist(self, monkeypatch):
        # 优先级 1 压过优先级 2：两者都命中时仍保留（结论一致，验证不报错/不误删）
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        monkeypatch.setenv("BUBBLE_DEBUG", "1")
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry()],
            plugin_scope_mode="allowlist",
        )
        assert [e["identifier"] for e in assembly._collect_extension_prompts(req)] == ["bubble-format"]

    def test_allowlist_does_not_disable_companion_detection_fast_path(self, monkeypatch):
        # 有配套正则的卡在 allowlist 下同样保留（结论一致，确保不是「反向」改动）
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble", "replaceString": "<div/>"}]}'
        req = _make_req(
            char_extensions=card,
            extension_prompts=[_bubble_entry()],
            plugin_scope_mode="allowlist",
        )
        assert [e["identifier"] for e in assembly._collect_extension_prompts(req)] == ["bubble-format"]


class TestStripBubbleSection:
    """[BUBBLE-STRIP-NOT-DROP 2026-10-02] 无 @bubble 渲染能力时按段落摘除，不得连带
    砍掉同一条注入里与 @bubble 无关的格式规则。

    取证：露缇雅1.2（a36680d6）勾了酒馆助手，「对话渲染系统 v7.1」的格式规范里
    「<content> 外面必须包一层 <now_plot>」被整条丢弃 → 模型不包标签 → 卡内
    「正文美化」正则无可匹配 → AI 回复没有排版框，只有写死在 first_mes 里的开场白有框。
    """

    def test_pure_bubble_section_dropped_whole(self):
        # 整段正文都含 @bubble → 允许整段丢（MIXED_SPEC 首段即此形）
        out = assembly._strip_bubble_marker_instructions(MIXED_SPEC)
        assert "@bubble" not in out
        assert "对话渲染格式规范" not in out
        assert "<content> 标签外面必须包一层 <now_plot> 标签。" in out
        assert "输出结构：" in out

    def test_removes_stray_bubble_lines_inside_examples(self):
        out = assembly._strip_bubble_marker_instructions(MIXED_SPEC)
        assert "城崎诺亚|欣喜" not in out
        # 示例里的正文与包裹标签结构必须留着，模型照这个结构输出
        assert "<now_plot>\n<content>\n（正文内容）\n</content>\n</now_plot>" in out

    def test_mixed_section_is_not_swallowed_whole(self):
        """[BUBBLE-STRIP-BY-CONTENT 2026-10-02] 段内含非 @bubble 行 → 该段不得被整吞。

        取证（露缇雅1.2，真实上报 1796 字符）：[对话渲染格式规范] 与 [情绪词约束]
        两段里都装着与 @bubble 无关的格式规则。旧「按标题字面量整段删」把它们连同
        规则一起啃掉，到场率只剩 21.4%，模型失去「整体输出结构」要求 → 卡不出框。
        """
        spec = (
            "[情绪词约束]\n"
            "情绪字段必须从以下池选取（禁止自造新词）：\n"
            "欣喜、悲伤\n"
            "@bubble:角色名|情绪|台词\n"
        )
        out = assembly._strip_bubble_marker_instructions(spec)
        assert "情绪词约束" in out  # 段落标题保留
        assert "情绪字段必须从以下池选取（禁止自造新词）：" in out
        assert "欣喜、悲伤" in out
        assert "@bubble" not in out  # 段内 @bubble 行逐行剔除

    def test_pure_bubble_section_dropped_while_neighbor_kept(self):
        spec = (
            "[正文标签规则]\n<content> 标签外面必须包一层 <now_plot> 标签。\n\n"
            "[纯粹的气泡说明]\n@bubble:角色名|情绪|台词\n"
        )
        out = assembly._strip_bubble_marker_instructions(spec)
        assert "纯粹的气泡说明" not in out
        assert "[正文标签规则]" in out
        assert "<content> 标签外面必须包一层 <now_plot> 标签。" in out

    def test_legacy_switch_reproduces_title_based_drop(self, monkeypatch):
        """[BUBBLE-LEGACY-STRIP] A/B 的 B 组逃生门：置 1 时回到旧「按标题整段丢」。"""
        spec = (
            "[对话渲染格式规范]\n"
            "输出结构必须完整：\n"
            "@bubble:角色名|情绪|台词\n"
        )
        monkeypatch.delenv("PALINK_BUBBLE_LEGACY_SECTION_STRIP", raising=False)
        assert "输出结构必须完整：" in assembly._strip_bubble_marker_instructions(spec)
        monkeypatch.setenv("PALINK_BUBBLE_LEGACY_SECTION_STRIP", "1")
        assert assembly._strip_bubble_marker_instructions(spec) == ""

    def test_non_bubble_text_passes_through_unchanged(self):
        text = "[正文标签规则]\n<content> 标签外面必须包一层 <now_plot> 标签。"
        assert assembly._strip_bubble_marker_instructions(text) == text

    def test_empty_and_none_safe(self):
        assert assembly._strip_bubble_marker_instructions("") == ""
        assert assembly._strip_bubble_marker_instructions(None) == ""

    def test_pure_bubble_spec_strips_to_empty(self):
        assert assembly._strip_bubble_marker_instructions(BUBBLE_SPEC) == ""


class TestGateStripsInsteadOfDropping:
    def test_allowlist_card_keeps_injection_with_bubble_stripped(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(content=MIXED_SPEC)],
            plugin_scope_mode="allowlist",
            char_id="a36680d6",
        )
        result = assembly._collect_extension_prompts(req)
        assert [e["identifier"] for e in result] == ["bubble-format"]
        content = result[0]["content"]
        assert "@bubble" not in content
        assert "<now_plot>" in content

    def test_inherit_card_keeps_injection_with_bubble_stripped(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(content=MIXED_SPEC)],
            plugin_scope_mode="inherit",
        )
        result = assembly._collect_extension_prompts(req)
        assert len(result) == 1
        assert "@bubble" not in result[0]["content"]
        assert "<now_plot>" in result[0]["content"]

    def test_pure_bubble_injection_still_dropped_whole(self, monkeypatch):
        # 摘完什么都不剩 → 维持旧行为整条丢弃，不给模型留空段落
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(content=MIXED_SPEC.split("[正文标签规则]")[0])],
            plugin_scope_mode="allowlist",
        )
        assert assembly._collect_extension_prompts(req) == []

    def test_card_with_render_support_gets_untouched_content(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        card = '{"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble", "replaceString": "<div/>"}]}'
        req = _make_req(
            char_extensions=card,
            extension_prompts=[_bubble_entry(content=MIXED_SPEC)],
            plugin_scope_mode="allowlist",
        )
        content = assembly._collect_extension_prompts(req)[0]["content"]
        # 有渲染配套 → 一字不改（结尾裸闭合标签行由 [INJ-CLOSE-TAG-GUARD] 剥除，与本门控无关）
        assert "@bubble:城崎诺亚|欣喜" in content
        assert "[对话渲染格式规范]" in content
        assert "[正文标签规则]" in content

    def test_debug_escape_hatch_keeps_bubble_verbatim(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        monkeypatch.setenv("BUBBLE_DEBUG", "1")
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(content=MIXED_SPEC)],
            plugin_scope_mode="allowlist",
        )
        content = assembly._collect_extension_prompts(req)[0]["content"]
        assert "@bubble:城崎诺亚|欣喜" in content
        assert "[对话渲染格式规范]" in content


def _bubble_entry_in_prompt(content):
    """position=0（IN_PROMPT）注入：避开 [INJ-CLOSE-TAG-GUARD] 对 depth=0 的收尾改写，
    便于断言出参里的长度与最终 content 严格相等。"""
    return {
        "identifier": "bubble-format",
        "content": content,
        "position": 0,
        "depth": 0,
        "role": "system",
        "scan": False,
        "filter": {},
    }


class TestStripEvidence:
    """[PROMPT-STRIP-EVIDENCE 2026-10-02] 降级路径的双计数与 dropped_sections 出参。

    上一轮吞段问题之所以拖了一整轮，直接原因就是证据里只有一个数：注入 385 字符
    看着"有内容"，没人发现原始上报是 1796、被自家逻辑啃掉了 79%。
    """

    def test_stats_double_count_and_dropped_titles(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        spec = MIXED_SPEC
        req = _make_req(
            char_extensions=None, extension_prompts=[_bubble_entry_in_prompt(spec)]
        )
        stats: dict = {}
        result = assembly._collect_extension_prompts(req, stats=stats)
        assert len(result) == 1
        injected = len(result[0]["content"])
        assert stats["entries"]["bubble-format"]["reported"] == len(spec)
        assert stats["entries"]["bubble-format"]["injected"] == injected
        assert stats["dropped_sections"] == ["[对话渲染格式规范]"]
        assert 0 < injected < len(spec)

    def test_whole_entry_dropped_still_counted_as_reported(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None, extension_prompts=[_bubble_entry_in_prompt(BUBBLE_SPEC)]
        )
        stats: dict = {}
        assert assembly._collect_extension_prompts(req, stats=stats) == []
        assert stats["entries"]["bubble-format"] == {
            "reported": len(BUBBLE_SPEC),
            "injected": 0,
        }

    def test_without_stats_behaviour_unchanged(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None, extension_prompts=[_bubble_entry_in_prompt(MIXED_SPEC)]
        )
        assert [
            e["identifier"] for e in assembly._collect_extension_prompts(req)
        ] == ["bubble-format"]
