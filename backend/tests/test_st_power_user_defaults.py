"""批次D1：ST 1.18.0 ``power_user`` 默认状态（83 键）回归。

为什么要有
----------
真实第三方插件的 ``loadSettings()`` 直接读 ``power_user.<key>``（JS-Slash-Runner
读 ``chat_truncation`` / ``persona_description_depth``，表达式扩展读 ``reduced_motion``）。
此前端点只硬编码 8 个键，其余全是 ``undefined`` ⇒ 插件 init 中途抛错整条死掉。

本文件守三件事：
1. 默认模块恰好 83 个顶层键，且每个键的类型与 ST 1.18.0
   ``default/content/settings.json`` 一致（期望表逐键写死，不依赖参照树在场）；
2. ``POST /api/settings/get`` 返回的 ``power_user`` 也是这 83 键；
3. DB 里已有的值优先于默认值 —— ``user_settings.power_user`` 列与
   ``silly_tavern_settings`` blob 两条持久化路径都要覆盖。

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

# ST 1.18.0 default/content/settings.json → power_user 的键名与类型表。
# 生成口径：json.load 后逐键取 type()（bool 先于 int 判断，None 记 none）。
# 只用于断言类型，不参与运行时默认值。
EXPECTED_TYPES: dict[str, str] = {
    "tokenizer": "int",
    "token_padding": "int",
    "collapse_newlines": "bool",
    "pin_examples": "bool",
    "strip_examples": "bool",
    "trim_sentences": "bool",
    "always_force_name2": "bool",
    "user_prompt_bias": "str",
    "show_user_prompt_bias": "bool",
    "markdown_escape_strings": "str",
    "fast_ui_mode": "bool",
    "avatar_style": "int",
    "chat_display": "int",
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
    "chat_tint_color": "str",
    "blur_tint_color": "str",
    "user_mes_blur_tint_color": "str",
    "bot_mes_blur_tint_color": "str",
    "shadow_color": "str",
    "waifuMode": "bool",
    "movingUI": "bool",
    "movingUIState": "dict",
    "movingUIPreset": "str",
    "noShadows": "bool",
    "theme": "str",
    "auto_swipe": "bool",
    "auto_swipe_minimum_length": "int",
    "auto_swipe_blacklist": "list",
    "auto_swipe_blacklist_threshold": "int",
    "auto_scroll_chat_to_bottom": "bool",
    "auto_fix_generated_markdown": "bool",
    "send_on_enter": "int",
    "console_log_prompts": "bool",
    "allow_name1_display": "bool",
    "allow_name2_display": "bool",
    "hotswap_enabled": "bool",
    "timer_enabled": "bool",
    "timestamps_enabled": "bool",
    "timestamp_model_icon": "bool",
    "mesIDDisplay_enabled": "bool",
    "hideChatAvatars_enabled": "bool",
    "max_context_unlocked": "bool",
    "prefer_character_prompt": "bool",
    "prefer_character_jailbreak": "bool",
    "quick_continue": "bool",
    "continue_on_send": "bool",
    "trim_spaces": "bool",
    "relaxed_api_urls": "bool",
    "instruct": "dict",
    "sysprompt": "dict",
    "context": "dict",
    "personas": "dict",
    "default_persona": "none",
    "persona_descriptions": "dict",
    "persona_description": "str",
    "persona_description_position": "int",
    "persona_show_notifications": "bool",
    "custom_stopping_strings": "str",
    "custom_stopping_strings_macro": "bool",
    "fuzzy_search": "bool",
    "encode_tags": "bool",
    "experimental_macro_engine": "bool",
    "enableLabMode": "bool",
    "enableZenSliders": "bool",
    "ui_mode": "int",
    "forbid_external_media": "bool",
    "stscript": "dict",
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
    def test_expected_table_itself_is_83_keys(self):
        """守卫自身的前提：期望表不是 82/84，否则下面两条断言会一起漂。"""
        assert len(EXPECTED_TYPES) == 83

    def test_defaults_are_exactly_83_keys_with_reference_types(self):
        assert ST_POWER_USER_DEFAULT_KEY_COUNT == 83
        assert len(ST_POWER_USER_DEFAULTS) == 83
        assert set(ST_POWER_USER_DEFAULTS) == set(EXPECTED_TYPES)
        mismatched = {
            key: (EXPECTED_TYPES[key], _type_name(ST_POWER_USER_DEFAULTS[key]))
            for key in EXPECTED_TYPES
            if _type_name(ST_POWER_USER_DEFAULTS[key]) != EXPECTED_TYPES[key]
        }
        assert mismatched == {}, f"类型与 ST 1.18.0 不一致: {mismatched}"

    def test_builder_returns_independent_deep_copy(self):
        """端点会原地合并 DB 值，默认常量不能被一次请求改脏。"""
        first = build_st_power_user_defaults()
        first["instruct"]["enabled"] = True
        first["personas"]["someone"] = "someone"
        first["auto_swipe_blacklist"].append("x")

        second = build_st_power_user_defaults()

        assert second["instruct"]["enabled"] is False
        assert second["personas"] == {}
        assert second["auto_swipe_blacklist"] == []

    def test_prompt_bodies_are_not_copied(self):
        """版权边界：提示词/模板正文不得从 ST 搬进仓库。"""
        assert ST_POWER_USER_DEFAULTS["sysprompt"]["content"] == ""
        assert ST_POWER_USER_DEFAULTS["context"]["story_string"] == ""
        assert ST_POWER_USER_DEFAULTS["persona_description"] == ""
        assert ST_POWER_USER_DEFAULTS["custom_stopping_strings"] == ""


class TestEndpoint:
    def test_settings_get_returns_83_power_user_keys(self, client, auth_headers):
        power_user = _get_power_user(client, auth_headers)

        assert len(power_user) == 83, f"实际 {len(power_user)} 键"
        assert set(power_user) == set(EXPECTED_TYPES)
        mismatched = {
            key: (EXPECTED_TYPES[key], _type_name(power_user[key]))
            for key in EXPECTED_TYPES
            if _type_name(power_user[key]) != EXPECTED_TYPES[key]
        }
        assert mismatched == {}, f"端点返回的类型与 ST 1.18.0 不一致: {mismatched}"

    def test_db_power_user_column_overrides_defaults(self, client, auth_headers, db_session, test_user):
        """``user_settings.power_user`` 列有值时，必须覆盖默认值而不是被默认值盖掉。"""
        setting = UserSetting(
            user_id=test_user.id,
            power_user=json.dumps({"tokenizer": 7, "theme": "User Theme"}),
        )
        db_session.add(setting)
        db_session.commit()

        power_user = _get_power_user(client, auth_headers)

        assert power_user["tokenizer"] == 7
        assert power_user["theme"] == "User Theme"
        assert len(power_user) == 83, "覆盖已有键不应改变键总数"

    def test_silly_tavern_settings_blob_overrides_defaults(self, client, auth_headers, db_session, test_user):
        """ST 前端保存走 ``silly_tavern_settings`` blob，同样必须覆盖默认值。"""
        setting = UserSetting(
            user_id=test_user.id,
            silly_tavern_settings=json.dumps(
                {"power_user": {"font_scale": 3, "sort_order": "desc"}}
            ),
        )
        db_session.add(setting)
        db_session.commit()

        power_user = _get_power_user(client, auth_headers)

        assert power_user["font_scale"] == 3
        assert power_user["sort_order"] == "desc"
        assert len(power_user) == 83, "覆盖已有键不应改变键总数"
