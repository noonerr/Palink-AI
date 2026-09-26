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
PLAIN_INJECTION = {"identifier": "some-other-plugin", "content": "普通插件注入，与 bubble 无关", "position": 1, "depth": 4, "role": "system"}


def _bubble_entry(identifier="bubble-format"):
    return {"identifier": identifier, "content": BUBBLE_SPEC, "position": 1, "depth": 0, "role": "system", "scan": False, "filter": {}}


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
    def test_plugin_regex_script_counts(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[
            {"scriptName": "BubbleRender", "findRegex": "@bubble:.*", "replaceString": "<div/>"},
        ], ext_scripts=[])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is True

    def test_extension_settings_regex_counts(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[
            {"scriptName": "r", "findRegex": "@bubble", "replaceString": "x"},
        ])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is True

    def test_no_source_no_support(self, monkeypatch):
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        assert assembly._has_bubble_render_support(db=None, user_id=42, char_extensions_raw=None) is False

    def test_loader_failure_falls_back_to_false(self, monkeypatch):
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

    def test_allowlist_keeps_bubble_even_without_render_support(self, monkeypatch):
        # 裸卡 + 无配套渲染正则，但用户手工确认过名单 → 装配层让位，保留
        _patch_loaders(monkeypatch, plugin_scripts=[], ext_scripts=[])
        req = _make_req(
            char_extensions=None,
            extension_prompts=[_bubble_entry(), PLAIN_INJECTION],
            plugin_scope_mode="allowlist",
            char_id="card-allow-1",
        )
        result = assembly._collect_extension_prompts(req)
        ids = [e["identifier"] for e in result]
        assert "bubble-format" in ids  # 不再被自动门控丢掉
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
