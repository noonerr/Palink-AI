"""ST 1.18.0 ``power_user`` 运行时默认对象（只含配置事实，不含提示词正文）。

来源与口径（批次D1b，2026-10-21；D1 的 83 键口径已由本批取代）
---------------------------------------------------------------
D1（``4517900``）按 ``default/content/settings.json`` 的 ``power_user`` 保存态快照
补了 **83** 键；那只是「保存下来的设置」，不是 ST 的运行时默认值。
真实运行时默认对象在参照树的 ``public/scripts/power-user.js``：

    export const power_user = { ... }   // 实测 133 个顶层键

ST 加载设置时执行 ``Object.assign(power_user, settings.power_user)``，所以全新安装里
``power_user`` 的键集合就是这份 133 键对象（settings.json 覆盖同名键的值，缺失的键
保留这里的运行时默认）。本批按主脑 D1b 口径**逐键对齐该运行时对象**：

- 顶层键集合 = ``power-user.js`` 的 133 键（**不含** settings.json 独有、运行时对象里
  没有的 ``ui_mode``；D1 曾按保存态收录它，本批移除）；
- 标量/布尔/数值默认值取运行时对象；
- 嵌套对象（``auto_continue`` / ``instruct`` / ``context`` / ``sysprompt`` /
  ``reasoning`` / ``stscript`` 等）的**键集合**取运行时对象；
- 少数在 JS 里不是字面量的键按下述「表达式取值」处理。

表达式取值
----------
- 颜色（``*_color`` 共 10 键）：ST 原值是 ``getComputedStyle(...).getPropertyValue(...)``，
  没有可抄的字面量。此处按 ST 默认主题（Dark Lite）的 CSS 变量值固化，与 D1 的
  9 个颜色值保持一致；新增的 ``border_color`` 取 Dark Lite 主题的 ``rgba(0, 0, 0, 1)``。
- 枚举常量已解析为数值/字符串：``tokenizer=99``（``tokenizers.BEST_MATCH``）、
  ``avatar_style=0``、``chat_display=0``、``send_on_enter=0``、
  ``tag_import_setting=1``、``tag_sort_mode='manual'``、
  ``media_display='list'``、``image_overswipe='generate'`` 等。
- ``theme='Default (Dark) 1.7.1'`` 是运行时对象的字面量（1.18.0 的 default/content/themes
  里没有同名主题文件；ST 自己会被 settings.json 覆盖成 ``Dark Lite``）。本模块以运行时
  对象为准，故保留该字符串。

版权边界
--------
- ✅ 只取**键名 / 类型 / 标量默认值**（数字、布尔、颜色、格式分隔符等配置事实）。
- ⛔ **不搬任何提示词原文或模板正文**：
  - ``context.story_string``（ST 原值是 Handlebars 故事模板）→ ``""``
  - ``sysprompt.content``（ST 原值是一整句系统提示词）→ ``""``
  - ``personas`` / ``persona_descriptions`` / ``movingUIState`` /
    ``model_templates_mappings`` → 只保留空对象
  - ``persona_description`` / ``custom_stopping_strings`` 原值本就是空串
- ``instruct`` 里的 ``input_sequence`` / ``output_sequence`` 等是**格式分隔符**
  （``### Instruction:`` 一类），属于配置事实而非提示词正文，按 ST 原值保留。
- ``reasoning`` 的 ``<think>`` / ``</think>`` 是标签配置，不是提示词正文。

使用方式
--------
端点侧请调用 :func:`build_st_power_user_defaults`（返回深拷贝），不要直接修改
``ST_POWER_USER_DEFAULTS``；默认值只负责「补缺」，DB 中已有的键由调用方覆盖。
"""

from __future__ import annotations

import copy
from typing import Any

# ST 1.18.0 public/scripts/power-user.js → export const power_user（133 个顶层键）。
# 顺序与参照对象一致，便于人工逐行复核；新增/删除键时同步更新此处的计数测试。
ST_POWER_USER_DEFAULTS: dict[str, Any] = {
    "charListGrid": False,
    "tokenizer": 99,
    "token_padding": 64,
    "collapse_newlines": False,
    "pin_examples": False,
    "strip_examples": False,
    "trim_sentences": False,
    "always_force_name2": False,
    "user_prompt_bias": "",
    "show_user_prompt_bias": True,
    "auto_continue": {
        "enabled": False,
        "allow_chat_completions": False,
        "target_length": 400,
    },
    "markdown_escape_strings": "",
    "chat_truncation": 100,
    "streaming_fps": 30,
    "smooth_streaming": False,
    "smooth_streaming_no_think": False,
    "smooth_streaming_speed": 50,
    "stream_fade_in": False,
    "fast_ui_mode": True,
    "avatar_style": 0,
    "chat_display": 0,
    "toastr_position": "toast-top-center",
    "chat_width": 50,
    "never_resize_avatars": False,
    "show_card_avatar_urls": False,
    "play_message_sound": False,
    "play_sound_unfocused": True,
    "auto_save_msg_edits": False,
    "confirm_message_delete": True,
    "sort_field": "name",
    "sort_order": "asc",
    "sort_rule": None,
    "font_scale": 1,
    "blur_strength": 10,
    "shadow_width": 2,
    # 以下 10 个颜色键在 ST 里是 getComputedStyle 表达式，按 Dark Lite 主题 CSS 值固化。
    "main_text_color": "rgba(220, 220, 210, 1)",
    "italics_text_color": "rgba(145, 145, 145, 1)",
    "underline_text_color": "rgba(188, 231, 207, 1)",
    "quote_text_color": "rgba(225, 138, 36, 1)",
    "blur_tint_color": "rgba(23, 23, 23, 1)",
    "chat_tint_color": "rgba(23, 23, 23, 1)",
    "user_mes_blur_tint_color": "rgba(30, 30, 30, 0.9)",
    "bot_mes_blur_tint_color": "rgba(30, 30, 30, 0.9)",
    "shadow_color": "rgba(0, 0, 0, 1)",
    "border_color": "rgba(0, 0, 0, 1)",
    "custom_css": "",
    "waifuMode": False,
    "movingUI": False,
    "movingUIState": {},
    "movingUIPreset": "",
    "noShadows": False,
    "theme": "Default (Dark) 1.7.1",
    "gestures": True,
    "auto_swipe": False,
    "auto_swipe_minimum_length": 0,
    "auto_swipe_blacklist": [],
    "auto_swipe_blacklist_threshold": 2,
    "auto_scroll_chat_to_bottom": True,
    "auto_fix_generated_markdown": True,
    "send_on_enter": 0,
    "console_log_prompts": False,
    "request_token_probabilities": False,
    "show_group_chat_queue": False,
    "allow_name1_display": False,
    "allow_name2_display": False,
    "hotswap_enabled": True,
    "timer_enabled": True,
    "timestamps_enabled": True,
    "timestamp_model_icon": False,
    "mesIDDisplay_enabled": False,
    "hideChatAvatars_enabled": False,
    "max_context_unlocked": False,
    "message_token_count_enabled": False,
    "expand_message_actions": False,
    "enableZenSliders": False,
    "enableLabMode": False,
    "prefer_character_prompt": True,
    "prefer_character_jailbreak": True,
    "quick_continue": False,
    "quick_impersonate": False,
    "continue_on_send": False,
    "trim_spaces": True,
    "relaxed_api_urls": False,
    "world_import_dialog": True,
    "enable_auto_select_input": False,
    "enable_md_hotkeys": False,
    "tag_import_setting": 1,
    "tag_sort_mode": "manual",
    "disable_group_trimming": False,
    "single_line": False,
    "instruct": {
        "enabled": False,
        "preset": "Alpaca",
        "input_sequence": "### Instruction:",
        "input_suffix": "",
        "output_sequence": "### Response:",
        "output_suffix": "",
        "system_sequence": "",
        "system_suffix": "",
        "last_system_sequence": "",
        "first_input_sequence": "",
        "first_output_sequence": "",
        "last_input_sequence": "",
        "last_output_sequence": "",
        "story_string_prefix": "",
        "story_string_suffix": "",
        "stop_sequence": "",
        "wrap": True,
        "macro": True,
        "names_behavior": "force",
        "activation_regex": "",
        "bind_to_context": False,
        "user_alignment_message": "",
        "system_same_as_user": False,
        "separator_sequence": "",
        "sequences_as_stop_strings": True,
    },
    "context": {
        "preset": "Default",
        # ST 原值是故事模板正文，按版权边界置空。
        "story_string": "",
        "chat_start": "***",
        "example_separator": "***",
        "use_stop_strings": True,
        "names_as_stop_strings": True,
        "story_string_position": 0,
        "story_string_role": 0,
        "story_string_depth": 1,
    },
    "instruct_derived": False,
    "context_derived": False,
    "context_size_derived": False,
    "model_templates_mappings": {},
    "chat_template_hash": "",
    "sysprompt": {
        "enabled": True,
        "name": "Neutral - Chat",
        # ST 原值是提示词正文，按版权边界置空。
        "content": "",
        "post_history": "",
    },
    "reasoning": {
        "name": "Think XML",
        "auto_parse": False,
        "add_to_prompts": False,
        "auto_expand": False,
        "show_hidden": False,
        "prefix": "<think>",
        "suffix": "</think>",
        "separator": "\n",
        "max_additions": 1,
    },
    "personas": {},
    "default_persona": None,
    "persona_descriptions": {},
    "persona_description": "",
    "persona_description_position": 0,
    "persona_description_role": 0,
    "persona_description_depth": 2,
    "persona_description_lorebook": "",
    "persona_show_notifications": True,
    "persona_sort_order": "asc",
    "custom_stopping_strings": "",
    "custom_stopping_strings_macro": True,
    "fuzzy_search": False,
    "encode_tags": False,
    "experimental_macro_engine": True,
    "servers": [],
    "bogus_folders": False,
    "zoomed_avatar_magnification": False,
    "show_tag_filters": False,
    "aux_field": "character_version",
    "stscript": {
        "matching": "fuzzy",
        "autocomplete": {
            "state": 2,
            "autoHide": False,
            "style": "theme",
            "font": {
                "scale": 0.8,
            },
            "width": {
                "left": 1,
                "right": 1,
            },
            "select": 3,
            "showInAllMacroFields": False,
        },
        "parser": {
            "flags": {},
        },
    },
    "restore_user_input": True,
    "reduced_motion": False,
    "compact_input_area": True,
    "show_swipe_num_all_messages": False,
    "auto_connect": False,
    "auto_load_chat": False,
    "forbid_external_media": True,
    "external_media_allowed_overrides": [],
    "external_media_forbidden_overrides": [],
    "pin_styles": True,
    "click_to_edit": False,
    "media_display": "list",
    "image_overswipe": "generate",
}

#: ST 1.18.0 ``public/scripts/power-user.js`` 运行时默认对象的顶层键数。
ST_POWER_USER_DEFAULT_KEY_COUNT = 133


def build_st_power_user_defaults() -> dict[str, Any]:
    """返回一份可安全修改的 ``power_user`` 默认值深拷贝。

    调用方（``silly_tavern._default_st_settings``）会先把 DB 中的值合并进来，
    合并过程会原地改嵌套对象，因此不能把模块级常量直接交出去。
    """

    return copy.deepcopy(ST_POWER_USER_DEFAULTS)
