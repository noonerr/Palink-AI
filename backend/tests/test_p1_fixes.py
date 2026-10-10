"""P1 重要缺口修复契约测试。

覆盖审计报告（docs/st-plugin-compat-spec/backend-plugin-single-chat-audit.md）
中 P1 修复点的契约验证：

- P1-1: palink-native 角色卡字段 prompt_order 重排
- P1-2: token 预算基准（openai_max_context 优先 + history_reserve 可配置 + 0.7 比例修正）
- P1-3: MESSAGE_STREAMING_STARTED/STOPPED 事件触发
- P1-4: impersonate 生成端点
- P1-5: swipe 删除端点
- P1-6: is_hidden 消息过滤
- P1-7: extensionPrompt store 合并
- P1-8: global variables 同步层
- P1-14: WI 扫描中 macro 替换
- P1-15: /trigger 命令
- P1-16: /impersonate 命令语义

测试方式：单元测试 + 函数签名/行为验证，不依赖真实 LLM 调用。
"""

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.roleplay_prompt_assembly import (  # noqa: E402
        _apply_token_budget,
        _classify_message_identifier,
        _collect_prompt_sources,
        _compute_prompt_token_budget,
        _extract_char_field_messages_for_order,
        _get_history_reserve,
        _get_openai_max_context_override,
        _preset_order_identifiers,
        _should_split_char_fields_for_order,
        PROMPT_ID_CHAR_DESCRIPTION,
        PROMPT_ID_CHAR_PERSONALITY,
        PROMPT_ID_SCENARIO,
        PROMPT_ID_SYSTEM_PROMPT,
        PROMPT_ID_WORLD_INFO_BEFORE,
        _CHAR_FIELD_ST_IDS,
        _DEFAULT_HISTORY_RESERVE,
        PromptAssemblyReportItem,
    )
    _IMPORT_ASSEMBLY = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_ASSEMBLY = False
    _IMPORT_ERROR = exc

try:
    from app.services.slash_command_service import (  # noqa: E402
        SlashCommandContext,
        SlashCommandResult,
        _cmd_impersonate,
        _cmd_trigger,
    )
    _IMPORT_SLASH = True
except Exception as exc:  # pragma: no cover
    _IMPORT_SLASH = False
    _SLASH_ERROR = exc

try:
    from app.services.worldbook_service import _substitute_wi_key  # noqa: E402
    _IMPORT_WB = True
except Exception as exc:  # pragma: no cover
    _IMPORT_WB = False
    _WB_ERROR = exc


pytestmark = pytest.mark.skipif(not _IMPORT_ASSEMBLY, reason=f"装配模块导入失败: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------
def _make_char(description="", personality="", scenario="", name="Alice"):
    """构造角色 mock 对象。"""
    return SimpleNamespace(
        name=name,
        description=description,
        personality=personality,
        scenario=scenario,
        post_history_instructions="",
    )


def _make_preset(prompt_order=None, name="test-preset"):
    """构造 PromptPreset mock。"""
    preset = SimpleNamespace(name=name)
    if prompt_order is None:
        preset.prompt_order = None
    elif isinstance(prompt_order, str):
        preset.prompt_order = prompt_order
    else:
        preset.prompt_order = json.dumps(prompt_order)
    return preset


def _make_user_setting(silly_tavern_settings=None):
    """构造 UserSetting mock。"""
    us = SimpleNamespace()
    if silly_tavern_settings is None:
        us.silly_tavern_settings = None
    elif isinstance(silly_tavern_settings, str):
        us.silly_tavern_settings = silly_tavern_settings
    else:
        us.silly_tavern_settings = json.dumps(silly_tavern_settings)
    return us


def _make_request(char=None, **overrides):
    """构造 PromptAssemblyRequest mock。"""
    defaults = dict(
        char=char or _make_char(),
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ---------------------------------------------------------------------------
# P1-1: palink-native 角色卡字段 prompt_order 重排
# ---------------------------------------------------------------------------
class TestP11CharFieldPromptOrder:
    """验证 palink-native 路径下角色卡字段可被 prompt_order 重排。"""

    def test_should_split_returns_false_without_preset(self):
        """未绑定 preset 时不拆分（保留默认合并行为）。"""
        assert _should_split_char_fields_for_order(None) is False

    def test_should_split_returns_false_when_no_char_field_ids(self):
        """preset 不含角色卡字段标识符时不拆分。"""
        preset = _make_preset(["main", "chatHistory", "worldInfoBefore"])
        # worldInfoBefore 在 _CHAR_FIELD_ST_IDS 中，应返回 True
        # 改为不含任何角色卡字段
        preset2 = _make_preset(["main", "chatHistory"])
        assert _should_split_char_fields_for_order(preset2) is False

    def test_should_split_returns_true_when_preset_has_char_description(self):
        """preset 包含 charDescription 时应拆分。"""
        preset = _make_preset(["main", "charDescription", "chatHistory"])
        assert _should_split_char_fields_for_order(preset) is True

    def test_should_split_returns_true_when_preset_has_personality(self):
        """preset 包含 charPersonality 时应拆分。"""
        preset = _make_preset(["main", "charPersonality"])
        assert _should_split_char_fields_for_order(preset) is True

    def test_should_split_returns_true_when_preset_has_scenario(self):
        """preset 包含 scenario 时应拆分。"""
        preset = _make_preset(["scenario", "main"])
        assert _should_split_char_fields_for_order(preset) is True

    def test_extract_char_field_messages_returns_empty_when_not_needed(self):
        """不需要拆分时返回空列表。"""
        req = _make_request(_make_char(description="desc", personality="pers"))
        # 无 preset
        messages = _extract_char_field_messages_for_order(req, None, "Alice")
        assert messages == []

    def test_extract_char_field_messages_includes_description(self):
        """拆分时把 description 抽取为独立 system 消息。"""
        char = _make_char(description="A brave knight", personality="kind", scenario="medieval")
        req = _make_request(char)
        preset = _make_preset(["main", "charDescription", "charPersonality", "scenario"])
        messages = _extract_char_field_messages_for_order(req, preset, "Alice")
        ids = [m.get("_palink_prompt_id") for m in messages]
        assert PROMPT_ID_CHAR_DESCRIPTION in ids
        assert PROMPT_ID_CHAR_PERSONALITY in ids
        assert PROMPT_ID_SCENARIO in ids
        # 每条消息都是 system 角色
        for m in messages:
            assert m["role"] == "system"
            assert m["_palink_char_field_proxy"] is True

    def test_extract_char_field_messages_skips_empty_fields(self):
        """空字段不抽取。"""
        char = _make_char(description="desc", personality="", scenario="")
        req = _make_request(char)
        preset = _make_preset(["charDescription", "charPersonality", "scenario"])
        messages = _extract_char_field_messages_for_order(req, preset, "Alice")
        assert len(messages) == 1
        assert messages[0]["_palink_prompt_id"] == PROMPT_ID_CHAR_DESCRIPTION
        assert messages[0]["content"] == "desc"

    def test_extract_char_field_messages_skips_ids_not_in_preset_order(self):
        """preset 未声明的字段不抽取（避免重复内容）。"""
        char = _make_char(description="desc", personality="pers", scenario="scen")
        req = _make_request(char)
        # preset 只声明 charDescription
        preset = _make_preset(["main", "charDescription", "chatHistory"])
        messages = _extract_char_field_messages_for_order(req, preset, "Alice")
        assert len(messages) == 1
        assert messages[0]["_palink_prompt_id"] == PROMPT_ID_CHAR_DESCRIPTION
        # personality 和 scenario 不在 preset 中，不抽取
        ids = [m["_palink_prompt_id"] for m in messages]
        assert PROMPT_ID_CHAR_PERSONALITY not in ids
        assert PROMPT_ID_SCENARIO not in ids

    def test_classify_message_identifier_reads_explicit_marker(self):
        """_classify_message_identifier 优先读取 _palink_prompt_id 标记。"""
        char = _make_char()
        msg = {
            "role": "system",
            "content": "test",
            "_palink_prompt_id": PROMPT_ID_CHAR_DESCRIPTION,
        }
        result = _classify_message_identifier(msg, 1, 5, char)
        assert result == PROMPT_ID_CHAR_DESCRIPTION

    def test_classify_message_identifier_falls_back_when_no_marker(self):
        """无 _palink_prompt_id 标记时回退到启发式判断。"""
        char = _make_char()
        msg = {"role": "system", "content": "test system prompt"}
        # index 0 且 system → main
        result = _classify_message_identifier(msg, 0, 5, char)
        assert result == PROMPT_ID_SYSTEM_PROMPT

    def test_preset_order_identifiers_handles_string_list(self):
        """prompt_order 为字符串列表时正确提取。"""
        preset = _make_preset(["main", "charDescription", "chatHistory"])
        ids = _preset_order_identifiers(preset)
        assert ids == {"main", "charDescription", "chatHistory"}

    def test_preset_order_identifiers_handles_dict_list(self):
        """prompt_order 为 dict 列表（含 identifier 字段）时正确提取。"""
        preset = _make_preset([
            {"identifier": "main", "enabled": True},
            {"identifier": "charDescription", "enabled": False},
        ])
        ids = _preset_order_identifiers(preset)
        assert ids == {"main", "charDescription"}

    def test_preset_order_identifiers_returns_empty_for_invalid_json(self):
        """非法 JSON 返回空集合。"""
        preset = SimpleNamespace(prompt_order="not-valid-json")
        ids = _preset_order_identifiers(preset)
        assert ids == set()

    def test_collect_prompt_sources_tags_proxy_messages(self):
        """_collect_prompt_sources 正确标记代理消息并赋予低优先级。"""
        char = _make_char()
        messages = [
            {"role": "system", "content": "main prompt"},
            {"role": "system", "content": "description text",
             "_palink_prompt_id": PROMPT_ID_CHAR_DESCRIPTION, "_palink_char_field_proxy": True},
            {"role": "user", "content": "hello"},
        ]
        sources = _collect_prompt_sources(messages, char)
        assert len(sources) == 3
        assert sources[0].identifier == PROMPT_ID_SYSTEM_PROMPT
        assert sources[1].identifier == PROMPT_ID_CHAR_DESCRIPTION
        assert sources[1].trimmable is True  # 代理消息可裁剪


# ---------------------------------------------------------------------------
# P1-2: token 预算基准修复
# ---------------------------------------------------------------------------
class TestP12TokenBudget:
    """验证 token 预算基准修复。"""

    def test_compute_budget_uses_model_registry_by_default(self):
        """无 override 时使用模型注册表查询。"""
        # 使用未知模型 ID，应回退到 _DEFAULT_CONTEXT_WINDOW (8192)
        budget = _compute_prompt_token_budget("unknown-model-xyz", effective_max_tokens=1024)
        # 8192 - 1024 - 512 = 6656
        assert budget == 6656

    def test_compute_budget_uses_override_when_provided(self):
        """有 context_window_override 时优先使用。"""
        budget = _compute_prompt_token_budget(
            "unknown-model-xyz", 1024, context_window_override=16384,
        )
        # 16384 - 1024 - 512 = 14848
        assert budget == 14848

    def test_compute_budget_override_takes_precedence_over_model(self):
        """override 优先于模型注册表。"""
        # 即使模型存在，override 也应优先
        budget_with_override = _compute_prompt_token_budget(
            "gpt-4", 1024, context_window_override=32768,
        )
        # 32768 - 1024 - 512 = 31232
        assert budget_with_override == 31232

    def test_compute_budget_ignores_non_positive_override(self):
        """非正数 override 被忽略，回退到模型注册表。"""
        budget = _compute_prompt_token_budget(
            "unknown-model-xyz", 1024, context_window_override=0,
        )
        # 回退到 _DEFAULT_CONTEXT_WINDOW (8192)
        assert budget == 6656

        budget_neg = _compute_prompt_token_budget(
            "unknown-model-xyz", 1024, context_window_override=-1,
        )
        assert budget_neg == 6656

    def test_compute_budget_falls_back_when_non_positive(self):
        """计算预算非正时回退到 effective_max_tokens。"""
        # context_window=100, max_tokens=100, reserve=512 → budget < 0
        budget = _compute_prompt_token_budget(
            "unknown-model-xyz", 100, context_window_override=100,
        )
        # 回退到 max(1, 100) = 100
        assert budget == 100

    def test_get_openai_max_context_override_returns_none_when_no_setting(self):
        """无 UserSetting 时返回 None。"""
        assert _get_openai_max_context_override(None) is None

    def test_get_openai_max_context_override_returns_none_when_no_st_settings(self):
        """UserSetting 无 silly_tavern_settings 时返回 None。"""
        us = _make_user_setting(None)
        assert _get_openai_max_context_override(us) is None

    def test_get_openai_max_context_override_reads_from_oai_settings(self):
        """从 oai_settings.openai_max_context 读取。"""
        us = _make_user_setting({
            "oai_settings": {"openai_max_context": 16384},
        })
        assert _get_openai_max_context_override(us) == 16384

    def test_get_openai_max_context_override_handles_string_value(self):
        """字符串数字值也能解析。"""
        us = _make_user_setting({
            "oai_settings": {"openai_max_context": "32768"},
        })
        assert _get_openai_max_context_override(us) == 32768

    def test_get_openai_max_context_override_returns_none_for_invalid(self):
        """非法值返回 None。"""
        us = _make_user_setting({
            "oai_settings": {"openai_max_context": "not-a-number"},
        })
        assert _get_openai_max_context_override(us) is None

        us2 = _make_user_setting({
            "oai_settings": {"openai_max_context": -1},
        })
        assert _get_openai_max_context_override(us2) is None

    def test_get_openai_max_context_override_handles_missing_oai_settings(self):
        """silly_tavern_settings 无 oai_settings 键时返回 None。"""
        us = _make_user_setting({"power_user": {"pin_examples": True}})
        assert _get_openai_max_context_override(us) is None

    def test_default_history_reserve_is_1024(self):
        """P1-2 修复: 默认 history_reserve 从 4096 降为 1024。"""
        assert _DEFAULT_HISTORY_RESERVE == 1024

    def test_get_history_reserve_returns_default_when_no_setting(self):
        """无 UserSetting 时返回默认值。"""
        assert _get_history_reserve(None) == _DEFAULT_HISTORY_RESERVE

    def test_get_history_reserve_reads_custom_value(self):
        """从 silly_tavern_settings.palink_history_reserve 读取自定义值。"""
        us = _make_user_setting({"palink_history_reserve": 2048})
        assert _get_history_reserve(us) == 2048

    def test_get_history_reserve_handles_string_value(self):
        """字符串数字值也能解析。"""
        us = _make_user_setting({"palink_history_reserve": "512"})
        assert _get_history_reserve(us) == 512

    def test_apply_token_budget_uses_default_reserve_when_none(self):
        """history_reserve=None 时使用 _DEFAULT_HISTORY_RESERVE。"""
        # 使用小预算触发裁剪，使 report 中生成 token_budget 条目
        parts = ["context part " * 200, "another part " * 200]
        report = []
        _apply_token_budget(parts, "system prompt", 50, report, history_reserve=None)
        # 应使用默认 1024
        assert any("history_reserve=1024" in r.detail for r in report if r.key == "token_budget")

    def test_apply_token_budget_uses_custom_reserve(self):
        """history_reserve 自定义值生效。"""
        # 使用小预算触发裁剪，使 report 中生成 token_budget 条目
        parts = ["context part " * 200]
        report = []
        _apply_token_budget(parts, "system prompt", 50, report, history_reserve=2048)
        assert any("history_reserve=2048" in r.detail for r in report if r.key == "token_budget")

    def test_apply_token_budget_trims_when_over_budget(self):
        """超预算时裁剪 dynamic_context_parts。"""
        # 构造一个超预算的场景：system_prompt + parts + reserve > budget
        parts = ["very long context " * 100, "another long part " * 100]
        report = []
        trimmed, total = _apply_token_budget(
            parts, "system prompt", token_budget=50, report=report, history_reserve=10,
        )
        # 应触发裁剪
        assert any(r.key.startswith("token_budget_trim") for r in report)
        assert len(trimmed) <= len(parts)


# ---------------------------------------------------------------------------
# P1-14: WI 扫描中 macro 替换
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _IMPORT_WB, reason=f"worldbook 模块导入失败: {_WB_ERROR if not _IMPORT_WB else ''}")
class TestP14WorldInfoMacroSubstitution:
    """验证 WI 扫描中宏替换功能。"""

    def test_substitute_char_macro(self):
        """{{char}} 宏在 WI key 中被替换。"""
        result = _substitute_wi_key("hello {{char}}", "Alice", "Bob")
        assert result == "hello Alice"

    def test_substitute_user_macro(self):
        """{{user}} 宏在 WI key 中被替换。"""
        result = _substitute_wi_key("hello {{user}}", "Alice", "Bob")
        assert result == "hello Bob"

    def test_substitute_case_variants(self):
        """大小写变体 {{Char}}/{{CHAR}}/{{User}}/{{USER}} 都能替换。"""
        assert _substitute_wi_key("{{Char}}", "Alice", "Bob") == "Alice"
        assert _substitute_wi_key("{{CHAR}}", "Alice", "Bob") == "Alice"
        assert _substitute_wi_key("{{User}}", "Alice", "Bob") == "Bob"
        assert _substitute_wi_key("{{USER}}", "Alice", "Bob") == "Bob"

    def test_substitute_no_macros_returns_unchanged(self):
        """无宏时原样返回。"""
        assert _substitute_wi_key("plain text", "Alice", "Bob") == "plain text"

    def test_substitute_empty_names(self):
        """空名替换为空串。"""
        assert _substitute_wi_key("{{char}}", "", "Bob") == ""
        assert _substitute_wi_key("{{user}}", "Alice", "") == ""

    def test_substitute_multiple_macros(self):
        """多个宏同时替换。"""
        result = _substitute_wi_key("{{char}} talks to {{user}}", "Alice", "Bob")
        assert result == "Alice talks to Bob"

    def test_substitute_no_braces_returns_unchanged(self):
        """无 {{ 模式时快速返回。"""
        assert _substitute_wi_key("no macros here", "Alice", "Bob") == "no macros here"


# ---------------------------------------------------------------------------
# P1-15: /trigger 命令
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _IMPORT_SLASH, reason=f"slash_command 模块导入失败")
class TestP15TriggerCommand:
    """验证 /trigger 命令实现。"""

    def test_trigger_command_exists(self):
        """_cmd_trigger 函数存在且可调用。"""
        assert callable(_cmd_trigger)

    def test_trigger_no_args_returns_usage(self):
        """无参数时返回用法说明。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_trigger([], ctx)
        assert isinstance(result, SlashCommandResult)
        assert result.send_to_chat is False
        assert "usage" in (result.response or "").lower() or "trigger" in (result.response or "").lower()

    def test_trigger_list_returns_response(self):
        """/trigger list 返回响应（不崩溃）。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_trigger(["list"], ctx)
        assert isinstance(result, SlashCommandResult)


# ---------------------------------------------------------------------------
# P1-16: /impersonate 命令语义
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _IMPORT_SLASH, reason=f"slash_command 模块导入失败")
class TestP16ImpersonateCommand:
    """验证 /impersonate 命令以 AI 视角生成用户回复。"""

    def test_impersonate_command_exists(self):
        """_cmd_impersonate 函数存在且可调用。"""
        assert callable(_cmd_impersonate)

    def test_impersonate_no_args_returns_usage(self):
        """无参数时返回用法说明。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_impersonate([], ctx)
        assert isinstance(result, SlashCommandResult)
        assert result.send_to_chat is False
        assert "usage" in (result.response or "").lower() or "impersonate" in (result.response or "").lower()

    def test_impersonate_sets_gen_prompt(self):
        """有参数时设置 gen_prompt 用于生成。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_impersonate(["Hello", "world"], ctx)
        assert isinstance(result, SlashCommandResult)
        assert result.gen_prompt is not None
        assert result.is_impersonate is True
        assert result.send_to_chat is False
        # gen_prompt 应包含用户输入内容
        assert "Hello" in result.gen_prompt or "world" in result.gen_prompt

    def test_impersonate_gen_prompt_contains_impersonate_instruction(self):
        """gen_prompt 包含 impersonate 指令。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_impersonate(["test message"], ctx)
        # 应包含 impersonating/user 相关指令
        assert "impersonat" in result.gen_prompt.lower() or "user" in result.gen_prompt.lower()

    def test_impersonate_does_not_send_to_chat(self):
        """impersonate 不直接发送到聊天。"""
        ctx = SlashCommandContext(
            db=MagicMock(), session_id="s1", user_id=1, user_name="U",
            character=SimpleNamespace(name="C"), session=SimpleNamespace(chat_metadata="{}"),
            input_text="",
        )
        result = _cmd_impersonate(["msg"], ctx)
        assert result.send_to_chat is False


# ---------------------------------------------------------------------------
# P1-3: MESSAGE_STREAMING_STARTED/STOPPED 事件触发（前端契约）
# ---------------------------------------------------------------------------
class TestP13StreamingEvents:
    # 【测试诚实化 2026-10-10】原 test_runtime_ts_emits_streaming_started /
    # test_runtime_ts_emits_streaming_stopped 及辅助 _resolve_runtime_ts 已删除。
    #
    # 理由：它们在 **Python** 测试里 open() **前端** runtime.ts，断言文件文本里含某个事件名字符串。
    # 断言的是「文本在不在」，不是「事件有没有真的被 emit」—— 把字符串写进注释就能骗过它，
    # 文件一挪位置又变成静默 skip。属纯伪测试。
    #
    # 真回归保护应放在前端侧：vitest 里 mock 事件总线，断言 dispatchEvent('message_streaming_started')
    # 被真实调用。见 frontend/src/lib/sillytavern/__tests__/。
    """（原前端文本断言已删除，理由见类内注释。）"""


# ---------------------------------------------------------------------------
# P1-6: is_hidden 消息过滤（验证 character_message_builder 中的过滤逻辑）
# ---------------------------------------------------------------------------
class TestP16IsHiddenFilter:
    # 【测试诚实化 2026-10-10】原 test_character_message_builder_filters_is_hidden 已删除。
    #
    # 理由：它只断言 character_message_builder.py **文件文本里含 "is_hidden" 这个词**，
    # 与「隐藏消息到底有没有被过滤掉」毫无关系。
    #
    # 真实过滤逻辑在 `character_message_builder.py:225`：
    #     history = [m for m in history if not getattr(m, "is_hidden", False)]
    # 但它内嵌在 `build_character_chat_messages` 里（18 个参数 + 4 个注入的 callable），
    # 轻量真测需构造完整 session/character/message 链并 mock 4 个回调，成本超出本批范围。
    # ⇒ **列入待办**：用 `conftest.py:84` 的 `db_session` 构造「1 条 is_hidden + 1 条正常」，
    #    再调该函数断言隐藏消息未进入装配结果。在重建之前，这里不放任何伪断言。
    """（原 is_hidden 文本断言已删除，理由见类内注释。）"""

# ---------------------------------------------------------------------------
# P1-7: extensionPrompt store 合并（验证 CharacterCardRenderer 注册合并读取）
# ---------------------------------------------------------------------------
class TestP17ExtensionPromptStoreMerge:
    """验证两套 extensionPrompt store 合并读取。"""

    # 【测试诚实化 2026-10-10】原 test_character_card_renderer_registers_get_extension_prompts 已删除。
    #
    # 理由：它在 Python 测试里 os.walk() 整个前端目录树，断言**前端源码文本里**出现
    # "getExtensionPrompts" 或 "__palink_extension_prompts" 字符串。
    # 原 docstring 自己就承认这是「断言跟随机械拆分现状」——即断言是为了适配文件拆分而
    # 被迫放宽的，这类断言跟随的是**文件布局**而不是**行为**，拆一次文件就失效一次。
    # 它无法发现「合并读取逻辑被删掉但字符串残留在注释里」这类真实回归。
    #
    # 真回归保护应放在前端侧（vitest 断言 getExtensionPrompts 的真实合并行为）。
    # 与同批 Agent 对 P2-1/2/3/5 的处置口径一致：无法发现真实回归的断言，删掉而不是留着。"""


# ---------------------------------------------------------------------------
# P1-8: global variables 同步层（验证 silly_tavern.py 包含变量端点）
# ---------------------------------------------------------------------------
class TestP18GlobalVariablesSync:
    """验证 ST 兼容变量端点同步层。

    【测试诚实化 2026-10-10】原断言是「open() silly_tavern.py 再 grep 文本」——
    把字符串留在注释里就能绿。现改为对 **运行时 router 对象** 与 **真实模块导入** 断言：
    端点被删、模型被移走都会真红。
    """

    def test_st_variable_endpoints_exist(self):
        """silly_tavern router 应真实注册 /api/variables/global/* 三个端点。"""
        from app.api.silly_tavern import router

        paths = {getattr(r, "path", "") for r in router.routes}
        for expected in (
            "/api/variables/global/get",
            "/api/variables/global/set",
            "/api/variables/global/delete",
        ):
            assert expected in paths, f"silly_tavern router 未注册端点 {expected}"

    def test_global_variable_model_imported(self):
        """GlobalVariable 模型应可从 app.models.chat_variable 真实导入。"""
        from app.models.chat_variable import GlobalVariable

        assert hasattr(GlobalVariable, "__tablename__"), \
            "GlobalVariable 应是 SQLAlchemy 声明式模型（须有 __tablename__）"


# ---------------------------------------------------------------------------
# P1-9: expressions 情感分类端点
# ---------------------------------------------------------------------------
class TestP113ElevenlabsEndpoints:
    """验证 7 个 /api/speech/elevenlabs/* 端点。

    【测试诚实化 2026-10-10】原三条断言全是「open() silly_tavern.py 再数文本」，
    其中 `test_elevenlabs_endpoints_proxies_to_st_sidecar` 更是用 `content.find()`
    截取字符串区间再 grep —— 纯文本游戏。现全部改为对**运行时 router 对象**与
    **真实模块导入**断言。
    """

    _EXPECTED_ENDPOINTS = [
        "/api/speech/elevenlabs/voices",
        "/api/speech/elevenlabs/voice-settings",
        "/api/speech/elevenlabs/synthesize",
        "/api/speech/elevenlabs/history",
        "/api/speech/elevenlabs/history-audio",
        "/api/speech/elevenlabs/voices/add",
        "/api/speech/elevenlabs/recognize",
    ]

    def test_all_elevenlabs_endpoints_exist(self):
        """silly_tavern router 应真实注册全部 7 个 elevenlabs 端点。"""
        from app.api.silly_tavern import router

        paths = {getattr(r, "path", "") for r in router.routes}
        missing = [e for e in self._EXPECTED_ENDPOINTS if e not in paths]
        assert not missing, f"silly_tavern router 缺少端点: {missing}"

    def test_elevenlabs_proxy_function_importable(self):
        """代理函数 _forward_extensions_to_st_native 应可从 silly_tavern 真实导入。

        诚实标注：本断言只保证「代理函数存在且可调用」，
        **不保证 7 个端点都真的调用了它**（那需要逐个端点的集成测试，本批未做）。
        但已强于原来的文本区间 grep。
        """
        from app.api.silly_tavern import _forward_extensions_to_st_native

        assert callable(_forward_extensions_to_st_native)

    def test_elevenlabs_endpoints_count(self):
        """silly_tavern router 里 elevenlabs 端点应不少于 7 个。"""
        from app.api.silly_tavern import router

        count = sum(
            1 for r in router.routes
            if "elevenlabs" in str(getattr(r, "path", ""))
        )
        assert count >= 7, f"应至少注册 7 个 elevenlabs 端点，实际 {count}"
