"""ST 1.18.0 ``power_user`` 默认状态（只含配置事实，不含提示词正文）。

来源与口径（批次D1，2026-10-21）
--------------------------------
键名、键的类型、标量/布尔/数值/颜色默认值逐项取自 ST 1.18.0 参照树的
``default/content/settings.json`` → ``power_user``（共 **83** 个顶层键）。
这是 ST 随包附带的「保存态快照」，不是 `public/scripts/power-user.js` 里那份
更大的运行时默认对象；本批按主脑给定的 83 键口径交付，运行时多出的键见
``docs/_active/report/REPORT_批次D1_ST默认状态补齐_2026-10-21.md`` 的否证一节。

版权边界
--------
- ✅ 只取**键名 / 类型 / 标量默认值**（含数字、布尔、颜色、分隔符等配置事实）。
- ⛔ **不搬任何提示词原文或模板正文**：
  - ``context.story_string``（ST 原值是 Handlebars 故事模板）→ ``""``
  - ``sysprompt.content``（ST 原值是一整句系统提示词）→ ``""``
  - ``personas`` / ``persona_descriptions`` / ``movingUIState`` → 只保留空对象
  - ``persona_description`` / ``custom_stopping_strings`` 原值本就是空串
- ``instruct`` 里的 ``input_sequence`` / ``output_sequence`` 等是**格式分隔符**
  （``### Instruction:`` 一类），属于配置事实而非提示词正文，按 ST 原值保留。

使用方式
--------
端点侧请调用 :func:`build_st_power_user_defaults`（返回深拷贝），不要直接修改
``ST_POWER_USER_DEFAULTS``；默认值只负责「补缺」，DB 中已有的键由调用方覆盖。
"""

from __future__ import annotations

import copy
from typing import Any

# ST 1.18.0 default/content/settings.json → power_user（83 个顶层键）。
# 顺序与参照文件一致，便于人工逐行复核；新增/删除键时同步更新此处的计数测试。
ST_POWER_USER_DEFAULTS: dict[str, Any] = {
    "tokenizer": 99,
    "token_padding": 64,
    "collapse_newlines": False,
    "pin_examples": False,
    "strip_examples": False,
    "trim_sentences": False,
    "always_force_name2": True,
    "user_prompt_bias": "",
    "show_user_prompt_bias": True,
    "markdown_escape_strings": "",
    "fast_ui_mode": True,
    "avatar_style": 0,
    "chat_display": 0,
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
    "main_text_color": "rgba(220, 220, 210, 1)",
    "italics_text_color": "rgba(145, 145, 145, 1)",
    "underline_text_color": "rgba(188, 231, 207, 1)",
    "quote_text_color": "rgba(225, 138, 36, 1)",
    "chat_tint_color": "rgba(23, 23, 23, 1)",
    "blur_tint_color": "rgba(23, 23, 23, 1)",
    "user_mes_blur_tint_color": "rgba(30, 30, 30, 0.9)",
    "bot_mes_blur_tint_color": "rgba(30, 30, 30, 0.9)",
    "shadow_color": "rgba(0, 0, 0, 1)",
    "waifuMode": False,
    "movingUI": False,
    "movingUIState": {},
    "movingUIPreset": "Default",
    "noShadows": True,
    "theme": "Dark Lite",
    "auto_swipe": False,
    "auto_swipe_minimum_length": 0,
    "auto_swipe_blacklist": [],
    "auto_swipe_blacklist_threshold": 2,
    "auto_scroll_chat_to_bottom": True,
    "auto_fix_generated_markdown": False,
    "send_on_enter": 0,
    "console_log_prompts": False,
    "allow_name1_display": False,
    "allow_name2_display": False,
    "hotswap_enabled": True,
    "timer_enabled": False,
    "timestamps_enabled": True,
    "timestamp_model_icon": True,
    "mesIDDisplay_enabled": False,
    "hideChatAvatars_enabled": False,
    "max_context_unlocked": False,
    "prefer_character_prompt": True,
    "prefer_character_jailbreak": True,
    "quick_continue": False,
    "continue_on_send": False,
    "trim_spaces": True,
    "relaxed_api_urls": False,
    "instruct": {
        "enabled": False,
        "preset": "Alpaca",
        "input_sequence": "### Instruction:",
        "output_sequence": "### Response:",
        "last_output_sequence": "",
        "system_sequence": "### Input:",
        "stop_sequence": "",
        "wrap": True,
        "macro": True,
        "names_behavior": "force",
        "activation_regex": "",
        "first_output_sequence": "",
        "skip_examples": False,
        "output_suffix": "\n\n",
        "input_suffix": "\n\n",
        "system_suffix": "\n\n",
        "user_alignment_message": "",
        "system_same_as_user": False,
    },
    "sysprompt": {
        "enabled": True,
        "name": "Neutral - Chat",
        # ST 原值是提示词正文，按版权边界置空。
        "content": "",
    },
    "context": {
        "preset": "Default",
        # ST 原值是故事模板正文，按版权边界置空。
        "story_string": "",
        "chat_start": "***",
        "example_separator": "***",
        "use_stop_strings": True,
    },
    "personas": {},
    "default_persona": None,
    "persona_descriptions": {},
    "persona_description": "",
    "persona_description_position": 0,
    "persona_show_notifications": True,
    "custom_stopping_strings": "",
    "custom_stopping_strings_macro": True,
    "fuzzy_search": True,
    "encode_tags": False,
    "experimental_macro_engine": True,
    "enableLabMode": False,
    "enableZenSliders": False,
    "ui_mode": 1,
    "forbid_external_media": True,
    "stscript": {
        "parser": {
            "flags": {
                "1": True,
                "2": True,
            }
        }
    },
}

#: ST 1.18.0 ``default/content/settings.json`` 的 ``power_user`` 顶层键数。
ST_POWER_USER_DEFAULT_KEY_COUNT = 83


def build_st_power_user_defaults() -> dict[str, Any]:
    """返回一份可安全修改的 ``power_user`` 默认值深拷贝。

    调用方（``silly_tavern._default_st_settings``）会先把 DB 中的值合并进来，
    合并过程会原地改嵌套对象，因此不能把模块级常量直接交出去。
    """

    return copy.deepcopy(ST_POWER_USER_DEFAULTS)
