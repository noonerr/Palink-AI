"""批次D1b：ST 1.18.0 ``power_user`` 运行时默认对象（133 键）回归。

为什么要有
----------
真实第三方插件的 ``loadSettings()`` 直接读 ``power_user.<key>``（JS-Slash-Runner
读 ``chat_truncation`` / ``persona_description_depth``，表达式扩展读 ``reduced_motion``）。
D1 只补了 ``default/content/settings.json`` 的保存态 83 键，运行时对象里另外 51 个键
（``chat_truncation`` / ``reduced_motion`` / ``auto_continue`` / ``streaming_fps`` ……）
仍然是 ``undefined``。D1b 按 ``public/scripts/power-user.js`` 的
``export const power_user``（实测 133 个顶层键）逐键对齐。

本文件守四件事：
1. 默认模块恰好 133 个顶层键，且每个键的类型与 ST 1.18.0 ``power-user.js`` 一致
   （期望表逐键写死，不依赖参照树在场）；
2. 运行时独有键有正确的标量/嵌套默认（``chat_truncation`` / ``reduced_motion`` /
   ``auto_continue`` 等），且保存态独有的 ``ui_mode`` 不在默认对象里；
3. ``context`` / ``instruct`` / ``sysprompt`` 的**键集合**与运行时对象一致；
4. ``POST /api/settings/get`` 返回的 ``power_user`` 也是这 133 键，且 DB 里已有的值
   优先于默认值 —— ``user_settings.power_user`` 列与 ``silly_tavern_settings`` blob
   两条持久化路径都要覆盖。

运行（必须在 backend/ 目录内）
------------------------------
``py -m pytest tests/test_st_power_user_defaults.py -q``
"""

from __future__ import annotations

import json

from app.models import UserSetting
from app.services.st_power_user_defaults import (
    ST_POWER_USER_DEFAULT_KEY_COUNT,
    ST_POWER_USER_DEFAULTS,
    build_st_power_user_defaults,
)

# ST 1.18.0 public/scripts/power-user.js → export const power_user 的键名与类型表。
# 生成口径：把对象字面量里的枚举常量解析为数值/字符串、颜色表达式按 Dark Lite 主题
# CSS 值固化、文本正文置空后，逐键取 type()（bool 先于 int 判断，None 记 none）。
# 只用于断言类型，不参与运行时默认值。
EXPECTED_TYPES: dict[str, str] = {
    "charListGrid": "bool",
    "tokenizer": "int",
    "token_padding": "int",
    "collapse_newlines": "bool",
    "pin_examples": "bool",
    "strip_examples": "bool",
    "trim_sentences": "bool",
    "always_force_name2": "bool",
    "user_prompt_bias": "str",
    "show_user_prompt_bias": "bool",
    "auto_continue": "dict",
    "markdown_escape_strings": "str",
    "chat_truncation": "int",
    "streaming_fps": "int",
    "smooth_streaming": "bool",
    "smooth_streaming_no_think": "bool",
    "smooth_streaming_speed": "int",
    "stream_fade_in": "bool",
    "fast_ui_mode": "bool",
    "avatar_style": "int",
    "chat_display": "int",
    "toastr_position": "str",
    "chat_width": "int",
    "never_resize_avatars": "bool",
    "show_card_avatar_urls": "bool",
    "play_message_sound": "bool",
    "play_sound_unfocused": "bool",
    "auto_save_msg_edits": "bool",
    "confirm_message_delete": "bool",
    "sort_field": "str",
    "sort_order": "str",
    "sort_rule": "none",
    "font_scale": "int",
    "blur_strength": "int",
    "shadow_width": "int",
    "main_text_color": "str",
    "italics_text_color": "str",
    "underline_text_color": "str",
    "quote_text_color": "str",
    "blur_tint_color": "str",
    "chat_tint_color": "str",
    "user_mes_blur_tint_color": "str",
    "bot_mes_blur_tint_color": "str",
    "shadow_color": "str",
    "border_color": "str",
    "custom_css": "str",
    "waifuMode": "bool",
    "movingUI": "bool",
    "movingUIState": "dict",
    "movingUIPreset": "str",
    "noShadows": "bool",
    "theme": "str",
    "gestures": "bool",
    "auto_swipe": "bool",
    "auto_swipe_minimum_length": "int",
    "auto_swipe_blacklist": "list",
    "auto_swipe_blacklist_threshold": "int",
    "auto_scroll_chat_to_bottom": "bool",
    "auto_fix_generated_markdown": "bool",
    "send_on_enter": "int",
    "console_log_prompts": "bool",
    "request_token_probabilities": "bool",
    "show_group_chat_queue": "bool",
    "allow_name1_display": "bool",
    "allow_name2_display": "bool",
    "hotswap_enabled": "bool",
    "timer_enabled": "bool",
    "timestamps_enabled": "bool",
    "timestamp_model_icon": "bool",
    "mesIDDisplay_enabled": "bool",
    "hideChatAvatars_enabled": "bool",
    "max_context_unlocked": "bool",
    "message_token_count_enabled": "bool",
    "expand_message_actions": "bool",
    "enableZenSliders": "bool",
    "enableLabMode": "bool",
    "prefer_character_prompt": "bool",
    "prefer_character_jailbreak": "bool",
    "quick_continue": "bool",
    "quick_impersonate": "bool",
    "continue_on_send": "bool",
    "trim_spaces": "bool",
    "relaxed_api_urls": "bool",
    "world_import_dialog": "bool",
    "enable_auto_select_input": "bool",
    "enable_md_hotkeys": "bool",
    "tag_import_setting": "int",
    "tag_sort_mode": "str",
    "disable_group_trimming": "bool",
    "single_line": "bool",
    "instruct": "dict",
    "context": "dict",
    "instruct_derived": "bool",
    "context_derived": "bool",
    "context_size_derived": "bool",
    "model_templates_mappings": "dict",
    "chat_template_hash": "str",
    "sysprompt": "dict",
    "reasoning": "dict",
    "personas": "dict",
    "default_persona": "none",
    "persona_descriptions": "dict",
    "persona_description": "str",
    "persona_description_position": "int",
    "persona_description_role": "int",
    "persona_description_depth": "int",
    "persona_description_lorebook": "str",
    "persona_show_notifications": "bool",
    "persona_sort_order": "str",
    "custom_stopping_strings": "str",
    "custom_stopping_strings_macro": "bool",
    "fuzzy_search": "bool",
    "encode_tags": "bool",
    "experimental_macro_engine": "bool",
    "servers": "list",
    "bogus_folders": "bool",
    "zoomed_avatar_magnification": "bool",
    "show_tag_filters": "bool",
    "aux_field": "str",
    "stscript": "dict",
    "restore_user_input": "bool",
    "reduced_motion": "bool",
    "compact_input_area": "bool",
    "show_swipe_num_all_messages": "bool",
    "auto_connect": "bool",
    "auto_load_chat": "bool",
    "forbid_external_media": "bool",
    "external_media_allowed_overrides": "list",
    "external_media_forbidden_overrides": "list",
    "pin_styles": "bool",
    "click_to_edit": "bool",
    "media_display": "str",
    "image_overswipe": "str",
}

# 嵌套对象的键集合（只比键名，不比正文；来源同 public/scripts/power-user.js）。
EXPECTED_INSTRUCT_KEYS: set[str] = {
    "enabled",
    "preset",
    "input_sequence",
    "input_suffix",
    "output_sequence",
    "output_suffix",
    "system_sequence",
    "system_suffix",
    "last_system_sequence",
    "first_input_sequence",
    "first_output_sequence",
    "last_input_sequence",
    "last_output_sequence",
    "story_string_prefix",
    "story_string_suffix",
    "stop_sequence",
    "wrap",
    "macro",
    "names_behavior",
    "activation_regex",
    "bind_to_context",
    "user_alignment_message",
    "system_same_as_user",
    "separator_sequence",
    "sequences_as_stop_strings",
}
EXPECTED_CONTEXT_KEYS: set[str] = {
    "preset",
    "story_string",
    "chat_start",
    "example_separator",
    "use_stop_strings",
    "names_as_stop_strings",
    "story_string_position",
    "story_string_role",
    "story_string_depth",
}
EXPECTED_SYSPROMPT_KEYS: set[str] = {"enabled", "name", "content", "post_history"}
EXPECTED_AUTO_CONTINUE_KEYS: set[str] = {
    "enabled",
    "allow_chat_completions",
    "target_length",
}


def _type_name(value: object) -> str:
    """与 EXPECTED_TYPES 的生成口径一致：bool 必须先于 int。"""
    if value is None:
        return "none"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, str):
        return "str"
    if isinstance(value, dict):
        return "dict"
    if isinstance(value, list):
        return "list"
    return type(value).__name__


def _get_power_user(client, auth_headers) -> dict:
    resp = client.post("/api/settings/get", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["result"] == "ok"
    settings = json.loads(payload["settings"])
    power_user = settings.get("power_user")
    assert isinstance(power_user, dict), "settings.power_user 必须是对象"
    return power_user


class TestDefaultModule:
    def test_expected_table_itself_is_133_keys(self):
        """守卫自身的前提：期望表不是 132/134，否则下面两条断言会一起漂。"""
        assert len(EXPECTED_TYPES) == 133

    def test_defaults_are_exactly_133_runtime_keys_with_reference_types(self):
        assert ST_POWER_USER_DEFAULT_KEY_COUNT == 133
        assert len(ST_POWER_USER_DEFAULTS) == 133
        assert set(ST_POWER_USER_DEFAULTS) == set(EXPECTED_TYPES)
        mismatched = {
            key: (EXPECTED_TYPES[key], _type_name(ST_POWER_USER_DEFAULTS[key]))
            for key in EXPECTED_TYPES
            if _type_name(ST_POWER_USER_DEFAULTS[key]) != EXPECTED_TYPES[key]
        }
        assert mismatched == {}, f"类型与 ST 1.18.0 运行时对象不一致: {mismatched}"

    def test_saved_state_only_key_is_not_in_runtime_defaults(self):
        """``ui_mode`` 只存在于 settings.json 保存态，运行时对象里没有。"""
        assert "ui_mode" not in ST_POWER_USER_DEFAULTS

    def test_runtime_only_keys_have_reference_values(self):
        """插件实际读取的运行时独有键：不只要存在，值和类型也要对。"""
        assert ST_POWER_USER_DEFAULTS["chat_truncation"] == 100
        assert _type_name(ST_POWER_USER_DEFAULTS["chat_truncation"]) == "int"

        assert ST_POWER_USER_DEFAULTS["reduced_motion"] is False
        assert _type_name(ST_POWER_USER_DEFAULTS["reduced_motion"]) == "bool"

        auto_continue = ST_POWER_USER_DEFAULTS["auto_continue"]
        assert isinstance(auto_continue, dict)
        assert set(auto_continue) == EXPECTED_AUTO_CONTINUE_KEYS
        assert auto_continue == {
            "enabled": False,
            "allow_chat_completions": False,
            "target_length": 400,
        }

        assert ST_POWER_USER_DEFAULTS["streaming_fps"] == 30
        assert ST_POWER_USER_DEFAULTS["smooth_streaming"] is False
        assert ST_POWER_USER_DEFAULTS["smooth_streaming_speed"] == 50
        assert ST_POWER_USER_DEFAULTS["tag_import_setting"] == 1
        assert ST_POWER_USER_DEFAULTS["tag_sort_mode"] == "manual"
        assert ST_POWER_USER_DEFAULTS["media_display"] == "list"
        assert ST_POWER_USER_DEFAULTS["image_overswipe"] == "generate"

    def test_nested_object_key_sets_match_runtime_reference(self):
        """只比键名/标量，不比正文（story_string / sysprompt.content 是空串）。"""
        assert set(ST_POWER_USER_DEFAULTS["instruct"]) == EXPECTED_INSTRUCT_KEYS
        assert set(ST_POWER_USER_DEFAULTS["context"]) == EXPECTED_CONTEXT_KEYS
        assert set(ST_POWER_USER_DEFAULTS["sysprompt"]) == EXPECTED_SYSPROMPT_KEYS

        instruct = ST_POWER_USER_DEFAULTS["instruct"]
        assert instruct["preset"] == "Alpaca"
        assert instruct["input_sequence"] == "### Instruction:"
        assert instruct["output_sequence"] == "### Response:"
        assert instruct["names_behavior"] == "force"
        assert instruct["wrap"] is True
        assert instruct["macro"] is True
        assert instruct["sequences_as_stop_strings"] is True

        context = ST_POWER_USER_DEFAULTS["context"]
        assert context["preset"] == "Default"
        assert context["chat_start"] == "***"
        assert context["example_separator"] == "***"
        assert context["use_stop_strings"] is True
        assert context["names_as_stop_strings"] is True
        assert context["story_string_position"] == 0
        assert context["story_string_role"] == 0
        assert context["story_string_depth"] == 1

        sysprompt = ST_POWER_USER_DEFAULTS["sysprompt"]
        assert sysprompt["enabled"] is True
        assert sysprompt["name"] == "Neutral - Chat"

    def test_builder_returns_independent_deep_copy(self):
        """端点会原地合并 DB 值，默认常量不能被一次请求改脏。"""
        first = build_st_power_user_defaults()
        first["instruct"]["enabled"] = True
        first["personas"]["someone"] = "someone"
        first["auto_swipe_blacklist"].append("x")
        first["auto_continue"]["enabled"] = True
        first["stscript"]["parser"]["flags"]["1"] = True

        second = build_st_power_user_defaults()

        assert second["instruct"]["enabled"] is False
        assert second["personas"] == {}
        assert second["auto_swipe_blacklist"] == []
        assert second["auto_continue"]["enabled"] is False
        assert second["stscript"]["parser"]["flags"] == {}

    def test_prompt_bodies_are_not_copied(self):
        """版权边界：提示词/模板正文不得从 ST 搬进仓库。"""
        assert ST_POWER_USER_DEFAULTS["sysprompt"]["content"] == ""
        assert ST_POWER_USER_DEFAULTS["sysprompt"]["post_history"] == ""
        assert ST_POWER_USER_DEFAULTS["context"]["story_string"] == ""
        assert ST_POWER_USER_DEFAULTS["persona_description"] == ""
        assert ST_POWER_USER_DEFAULTS["custom_stopping_strings"] == ""


class TestEndpoint:
    def test_settings_get_returns_133_power_user_keys(self, client, auth_headers):
        power_user = _get_power_user(client, auth_headers)

        assert len(power_user) == 133, f"实际 {len(power_user)} 键"
        assert set(power_user) == set(EXPECTED_TYPES)
        mismatched = {
            key: (EXPECTED_TYPES[key], _type_name(power_user[key]))
            for key in EXPECTED_TYPES
            if _type_name(power_user[key]) != EXPECTED_TYPES[key]
        }
        assert mismatched == {}, f"端点返回的类型与 ST 1.18.0 运行时对象不一致: {mismatched}"

    def test_db_power_user_column_overrides_defaults(self, client, auth_headers, db_session, test_user):
        """``user_settings.power_user`` 列有值时，必须覆盖默认值而不是被默认值盖掉。"""
        setting = UserSetting(
            user_id=test_user.id,
            power_user=json.dumps(
                {"tokenizer": 7, "theme": "User Theme", "chat_truncation": 250}
            ),
        )
        db_session.add(setting)
        db_session.commit()

        power_user = _get_power_user(client, auth_headers)

        assert power_user["tokenizer"] == 7
        assert power_user["theme"] == "User Theme"
        assert power_user["chat_truncation"] == 250
        assert len(power_user) == 133, "覆盖已有键不应改变键总数"

    def test_silly_tavern_settings_blob_overrides_defaults(self, client, auth_headers, db_session, test_user):
        """ST 前端保存走 ``silly_tavern_settings`` blob，同样必须覆盖默认值。"""
        setting = UserSetting(
            user_id=test_user.id,
            silly_tavern_settings=json.dumps(
                {
                    "power_user": {
                        "font_scale": 3,
                        "sort_order": "desc",
                        "reduced_motion": True,
                    }
                }
            ),
        )
        db_session.add(setting)
        db_session.commit()

        power_user = _get_power_user(client, auth_headers)

        assert power_user["font_scale"] == 3
        assert power_user["sort_order"] == "desc"
        assert power_user["reduced_motion"] is True
        assert len(power_user) == 133, "覆盖已有键不应改变键总数"
