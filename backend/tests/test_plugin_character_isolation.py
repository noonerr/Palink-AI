"""[PLUGIN-ON-DEMAND] runtime/config 按角色隔离回归（2026-09-26 用户拍板）。

背景：卡内扩展来源插件（含 8-28 例外放行的 tavern_helper「酒馆助手」）此前
对所有角色常驻下发。新规则：卡的 extensions 自带酒馆助手生态声明
（tavern_helper.scripts 非空）→ 下发；裸卡 → 不下发。
非卡内扩展来源插件（用户显式安装）永远不受影响；
plugin.config.global_runtime === true 的显式全局插件保留（逃生门）；
character_id 缺省/角色不存在 → 行为与旧版一致。
"""

import json
import os
import sys
from types import SimpleNamespace

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.plugins import (  # noqa: E402
    _character_card_entitles_card_extension_plugins,
    _filter_runtime_config_for_character,
    _detect_rule_match,
    _builtin_detect_reason,
    _card_declared_plugin_names,
    detect_required_plugins,
)

CARD_WITH_SCRIPTS = json.dumps({"tavern_helper": {"scripts": [{"name": "对话渲染系统", "content": "..."}]}})
CARD_BARE = json.dumps({"depth_prompt": {"prompt": "x"}})


class _FakeQuery:
    def __init__(self, first=None, all_rows=None):
        self._first = first
        self._all = all_rows or []

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._first

    def all(self):
        return self._all


class _FakeDB:
    def __init__(self, character=None, plugins=None, plugin_states=None):
        self._character = character
        self._plugins = plugins or []
        self._plugin_states = plugin_states or []

    def query(self, model):
        name = getattr(model, "__name__", "")
        if name == "Character":
            return _FakeQuery(first=self._character)
        if name == "CharacterPluginState":
            return _FakeQuery(all_rows=self._plugin_states)
        # Plugin 查询（global_runtime 逃生门 / exclude_from_scope 逃生门）
        return _FakeQuery(all_rows=self._plugins)


def _plugin_row(plugin_id: str, config: str):
    return SimpleNamespace(id=plugin_id, config=config)


def _state_row(plugin_id: str, enabled: bool = True):
    return SimpleNamespace(plugin_id=plugin_id, enabled=enabled)


def _detect_plugin(plugin_id, name="酒馆助手", plugin_type="tavern_helper", config="{}"):
    return SimpleNamespace(id=plugin_id, name=name, plugin_type=plugin_type, config=config)


def _payload():
    return {
        "plugins": [
            {"id": "p-tavern", "name": "酒馆助手"},
            {"id": "p-user", "name": "用户自装插件"},
        ],
        "extension_settings": {},
    }


class TestCardEntitlement:
    def test_card_with_scripts_entitles(self):
        assert _character_card_entitles_card_extension_plugins(CARD_WITH_SCRIPTS) is True

    def test_bare_card_does_not(self):
        assert _character_card_entitles_card_extension_plugins(CARD_BARE) is False
        assert _character_card_entitles_card_extension_plugins(None) is False
        assert _character_card_entitles_card_extension_plugins("not-json") is False

    def test_empty_scripts_list_does_not(self):
        assert _character_card_entitles_card_extension_plugins(
            json.dumps({"tavern_helper": {"scripts": []}})
        ) is False


class TestFilterRuntimeConfigForCharacter:
    def test_no_character_id_unchanged(self):
        payload = _payload()
        db = _FakeDB(character=SimpleNamespace(extensions=CARD_BARE))
        result = _filter_runtime_config_for_character(db, payload, None)
        assert result is payload

    def test_character_not_found_unchanged(self):
        payload = _payload()
        db = _FakeDB(character=None)
        result = _filter_runtime_config_for_character(db, payload, "missing-id")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern", "p-user"]

    def test_entitled_card_keeps_everything(self):
        payload = _payload()
        db = _FakeDB(character=SimpleNamespace(extensions=CARD_WITH_SCRIPTS), plugins=[])
        result = _filter_runtime_config_for_character(db, payload, "card-1")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern", "p-user"]

    def test_bare_card_drops_card_extension_plugin_only(self):
        payload = _payload()
        db = _FakeDB(
            character=SimpleNamespace(extensions=CARD_BARE),
            plugins=[_plugin_row("p-tavern", '{"global_runtime": false}')],
        )
        result = _filter_runtime_config_for_character(db, payload, "card-2")
        assert [p["id"] for p in result["plugins"]] == ["p-user"]

    def test_global_runtime_true_plugin_survives_on_bare_card(self):
        payload = _payload()
        db = _FakeDB(
            character=SimpleNamespace(extensions=CARD_BARE),
            plugins=[_plugin_row("p-tavern", '{"global_runtime": true}')],
        )
        result = _filter_runtime_config_for_character(db, payload, "card-2")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern", "p-user"]

    def test_user_installed_plugins_never_dropped(self):
        payload = _payload()
        db = _FakeDB(
            character=SimpleNamespace(extensions=CARD_BARE),
            plugins=[],  # 数据库里没有卡内扩展来源插件（如已卸载）
        )
        result = _filter_runtime_config_for_character(db, payload, "card-2")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern", "p-user"]

    def test_no_card_extension_rows_unchanged(self):
        payload = _payload()
        db = _FakeDB(character=SimpleNamespace(extensions=CARD_BARE), plugins=[])
        result = _filter_runtime_config_for_character(db, payload, "card-2")
        assert result is payload


class TestAllowlistScope:
    """用户手工确认名单（plugin_scope_mode='allowlist'）优先于后端自动判定。"""

    def test_allowlist_keeps_enabled_and_infrastructure_exempt(self):
        db = _FakeDB(
            character=SimpleNamespace(id="c1", extensions=CARD_BARE, plugin_scope_mode="allowlist"),
            plugin_states=[_state_row("p-user")],
            plugins=[_plugin_row("p-tavern", '{"exclude_from_scope": true}')],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c1")
        assert sorted(p["id"] for p in result["plugins"]) == ["p-tavern", "p-user"]

    def test_allowlist_drops_unchecked_plugin(self):
        # 裸卡 + 只勾了 p-user → 卡内扩展来源的 p-tavern 不下发
        db = _FakeDB(
            character=SimpleNamespace(id="c2", extensions=CARD_BARE, plugin_scope_mode="allowlist"),
            plugin_states=[_state_row("p-user")],
            plugins=[_plugin_row("p-tavern", "{}")],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c2")
        assert [p["id"] for p in result["plugins"]] == ["p-user"]

    def test_allowlist_empty_drops_everything_but_exempt(self):
        # 用户全部取消勾选 → 只剩基础设施插件
        db = _FakeDB(
            character=SimpleNamespace(id="c3", extensions=CARD_BARE, plugin_scope_mode="allowlist"),
            plugin_states=[],
            plugins=[_plugin_row("p-tavern", '{"exclude_from_scope": true}')],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c3")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern"]

    def test_allowlist_overrides_auto_gate(self):
        # 关键优先级用例：裸卡自动判定本会丢掉 p-tavern，但用户勾了 → 保留
        db = _FakeDB(
            character=SimpleNamespace(id="c4", extensions=CARD_BARE, plugin_scope_mode="allowlist"),
            plugin_states=[_state_row("p-tavern")],
            plugins=[_plugin_row("p-tavern", '{"global_runtime": false}')],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c4")
        assert [p["id"] for p in result["plugins"]] == ["p-tavern"]

    def test_mode_is_case_insensitive(self):
        db = _FakeDB(
            character=SimpleNamespace(id="c5", extensions=CARD_BARE, plugin_scope_mode="AllowList"),
            plugin_states=[_state_row("p-user")],
            plugins=[],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c5")
        assert [p["id"] for p in result["plugins"]] == ["p-user"]

    def test_inherit_still_uses_auto_gate(self):
        # 回归红线：inherit 下行为与改造前一致（裸卡丢 p-tavern）
        db = _FakeDB(
            character=SimpleNamespace(id="c6", extensions=CARD_BARE, plugin_scope_mode="inherit"),
            plugin_states=[_state_row("p-tavern")],  # 名单存在但模式是 inherit → 不生效
            plugins=[_plugin_row("p-tavern", '{"global_runtime": false}')],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c6")
        assert [p["id"] for p in result["plugins"]] == ["p-user"]

    def test_missing_column_is_inherit(self):
        # 列不存在（SimpleNamespace 无该属性）→ 退化为 inherit，不炸
        db = _FakeDB(
            character=SimpleNamespace(id="c7", extensions=CARD_BARE),
            plugin_states=[_state_row("p-tavern")],
            plugins=[_plugin_row("p-tavern", '{"global_runtime": false}')],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c7")
        assert [p["id"] for p in result["plugins"]] == ["p-user"]


class TestRequiredPluginDetectionGaps:
    """补充下方 TestDetectRequiredPlugins 未覆盖的边角：声明优先级、contains
    语义不对称、卡内正则不算插件信号、脏数据不抛异常。

    三条识别路径的优先级：卡内显式声明 > 插件自定义 detect 规则 > 内置兜底。
    """

    def _run(self, plugins, extensions, **char_fields):
        char = SimpleNamespace(extensions=extensions, **char_fields)
        db = _FakeDB(character=char, plugins=plugins)
        return detect_required_plugins(db, char)

    def test_declared_by_plugin_id(self):
        # 声明既可按 name 也可按 id（下方已有 name 用例，这里钉死 id 路径）
        ext = {"palink": {"required_plugins": ["p-tavern"]}}
        rows = self._run([_detect_plugin("p-tavern")], ext)
        assert [(r["plugin_id"], r["source"], r["reason"]) for r in rows] == [
            ("p-tavern", "declared", "卡内显式声明")
        ]

    def test_declared_wins_over_detected(self):
        # 同时满足声明与规则 → declared 优先（唯一 source，不重复）
        ext = {"palink": {"required_plugins": ["p-tavern"]}, "tavern_helper": {"scripts": [{"name": "s"}]}}
        rows = self._run([_detect_plugin("p-tavern")], ext)
        assert len(rows) == 1
        assert rows[0]["source"] == "declared"

    def test_contains_on_list_is_exact_element_match(self):
        # 语义钉死：contains 命中 list 时是「元素全等」，不是子串。
        # 写规则时给 list 配部分字符串会静默不命中——这里用反例把它固定住。
        config = json.dumps({"detect": {"any_of": [{"json_path": "tavern_helper.scripts", "contains": "对话渲染"}]}})
        ext = {"tavern_helper": {"scripts": ["对话渲染系统 v7.1"]}}
        rows = self._run([_detect_plugin("p-y", name="Y", plugin_type="sillytavern_extension", config=config)], ext)
        assert rows == []  # 部分字符串 ≠ 元素全等

        config_exact = json.dumps({"detect": {"any_of": [{"json_path": "tavern_helper.scripts", "contains": "对话渲染系统 v7.1"}]}})
        rows = self._run([_detect_plugin("p-y", name="Y", plugin_type="sillytavern_extension", config=config_exact)], ext)
        assert rows and rows[0]["source"] == "detected"

    def test_text_pattern_matches_character_text_fields(self):
        config = json.dumps({"detect": {"any_of": [{"text_pattern": "魔法"}]}})
        rows = self._run(
            [_detect_plugin("p-z", name="Z", plugin_type="sillytavern_extension", config=config)],
            {},
            description="这是一个魔法世界",
        )
        assert rows and rows[0]["source"] == "detected"

    def test_card_regex_scripts_are_not_a_plugin_signal(self):
        # 契约：卡内正则走 GLOBAL/SCOPED/PRESET 三层，天然按卡隔离，
        # 不参与「需要哪些插件」的识别——避免把正则卡误判成插件卡。
        ext = {"regex_scripts": [{"scriptName": "气泡渲染", "findRegex": "@bubble"}]}
        rows = self._run([_detect_plugin("p-tavern")], ext)
        assert rows == []

    def test_malformed_extensions_do_not_raise(self):
        assert self._run([_detect_plugin("p-tavern")], "not-json") == []
        assert self._run([_detect_plugin("p-tavern")], None) == []

    def test_malformed_plugin_config_does_not_raise(self):
        rows = self._run([_detect_plugin("p-bad", config="not-json")], {"tavern_helper": {"scripts": [{}]}})
        assert rows and rows[0]["source"] == "detected"

    def test_allowlist_preserves_other_payload_keys(self):
        db = _FakeDB(
            character=SimpleNamespace(id="c8", extensions=CARD_BARE, plugin_scope_mode="allowlist"),
            plugin_states=[_state_row("p-user")],
            plugins=[],
        )
        result = _filter_runtime_config_for_character(db, _payload(), "c8")
        assert result["extension_settings"] == {}


class TestDetectRuleMatch:
    def test_json_path_non_empty_list(self):
        ext = {"tavern_helper": {"scripts": [{"name": "x"}]}}
        assert _detect_rule_match({"json_path": "tavern_helper.scripts", "non_empty": True}, ext, "") is True

    def test_json_path_non_empty_absent(self):
        assert _detect_rule_match({"json_path": "a.b", "non_empty": True}, {}, "") is False

    def test_contains_in_string(self):
        assert _detect_rule_match({"json_path": "palink.kind", "contains": "bubble"}, {"palink": {"kind": "bubble-card"}}, "") is True

    def test_contains_in_list(self):
        assert _detect_rule_match({"json_path": "tags", "contains": "bubble"}, {"tags": ["a", "bubble"]}, "") is True

    def test_text_pattern(self):
        assert _detect_rule_match({"text_pattern": "@bubble"}, {}, "说话请带 @bubble 标记") is True
        assert _detect_rule_match({"text_pattern": "@bubble"}, {}, "普通卡") is False

    def test_non_dict_rule_and_empty_rule(self):
        assert _detect_rule_match(None, {}, "") is False
        assert _detect_rule_match({}, {}, "") is False


class TestBuiltinDetectReason:
    def test_tavern_helper_with_scripts(self):
        plugin = _detect_plugin("p1")
        ext = {"tavern_helper": {"scripts": [{"name": "s"}]}}
        assert _builtin_detect_reason(plugin, ext, "") == "卡内自带酒馆助手脚本"

    def test_tavern_helper_via_bubble_text(self):
        plugin = _detect_plugin("p1")
        assert _builtin_detect_reason(plugin, {}, "正文含 @bubble") == "卡正文出现 @bubble 标记"

    def test_non_tavern_helper_never_matches(self):
        plugin = _detect_plugin("p2", plugin_type="sillytavern_extension")
        assert _builtin_detect_reason(plugin, {"tavern_helper": {"scripts": [{}]}}, "@bubble") is None

    def test_empty_scripts_list_not_matched(self):
        plugin = _detect_plugin("p1")
        assert _builtin_detect_reason(plugin, {"tavern_helper": {"scripts": []}}, "") is None


class TestCardDeclaredPlugins:
    def test_declared_names(self):
        assert _card_declared_plugin_names({"palink": {"required_plugins": ["A", 2]}}) == ["A", "2"]

    def test_absent_or_malformed(self):
        assert _card_declared_plugin_names({}) == []
        assert _card_declared_plugin_names({"palink": "x"}) == []
        assert _card_declared_plugin_names({"palink": {"required_plugins": "x"}}) == []


class TestDetectRequiredPlugins:
    def test_declared_source_wins(self):
        db = _FakeDB(plugins=[_detect_plugin("p1", name="酒馆助手")])
        char = SimpleNamespace(
            extensions=json.dumps({"palink": {"required_plugins": ["酒馆助手"]}}),
            name="卡", description="", personality="",
        )
        out = detect_required_plugins(db, char)
        assert [r["plugin_id"] for r in out] == ["p1"]
        assert out[0]["source"] == "declared"

    def test_detect_rule_source(self):
        cfg = json.dumps({"detect": {"any_of": [{"json_path": "tavern_helper.scripts", "non_empty": True}]}})
        db = _FakeDB(plugins=[_detect_plugin("p9", name="任意插件", plugin_type="sillytavern_extension", config=cfg)])
        char = SimpleNamespace(
            extensions=json.dumps({"tavern_helper": {"scripts": [{"name": "s"}]}}),
            name="", description="",
        )
        out = detect_required_plugins(db, char)
        assert [r["plugin_id"] for r in out] == ["p9"]
        assert out[0]["source"] == "detected"
        assert out[0]["reason"] == "命中插件识别规则"

    def test_builtin_fallback(self):
        db = _FakeDB(plugins=[_detect_plugin("p1")])
        char = SimpleNamespace(extensions="{}", name="", description="", first_mes="说话带 @bubble")
        out = detect_required_plugins(db, char)
        assert [r["plugin_id"] for r in out] == ["p1"]
        assert out[0]["reason"] == "卡正文出现 @bubble 标记"

    def test_no_match_returns_empty(self):
        db = _FakeDB(plugins=[_detect_plugin("p1")])
        char = SimpleNamespace(extensions="{}", name="普通卡", description="无生态声明")
        assert detect_required_plugins(db, char) == []

    def test_multiple_plugins_independent(self):
        # 两张卡各自的命中互不干扰（识别器是纯函数、不写库）
        db = _FakeDB(plugins=[_detect_plugin("p1"), _detect_plugin("p2", name="B")])
        hit = SimpleNamespace(extensions=json.dumps({"tavern_helper": {"scripts": [{}]}}), name="")
        miss = SimpleNamespace(extensions="{}", name="")
        assert len(detect_required_plugins(db, hit)) == 2
        assert detect_required_plugins(db, miss) == []
