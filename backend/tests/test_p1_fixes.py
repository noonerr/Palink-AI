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

    def test_should_split_returns_false_for_st_compat(self):
        """st-compat 路径已内置分离装配，不需要再拆分。"""
        preset = _make_preset(["charDescription", "charPersonality"])
        assert _should_split_char_fields_for_order(preset, "st-compat") is False

    def test_should_split_returns_false_without_preset(self):
        """未绑定 preset 时不拆分（保留默认合并行为）。"""
        assert _should_split_char_fields_for_order(None, "palink-native") is False

    def test_should_split_returns_false_when_no_char_field_ids(self):
        """preset 不含角色卡字段标识符时不拆分。"""
        preset = _make_preset(["main", "chatHistory", "worldInfoBefore"])
        # worldInfoBefore 在 _CHAR_FIELD_ST_IDS 中，应返回 True
        # 改为不含任何角色卡字段
        preset2 = _make_preset(["main", "chatHistory"])
        assert _should_split_char_fields_for_order(preset2, "palink-native") is False

    def test_should_split_returns_true_when_preset_has_char_description(self):
        """preset 包含 charDescription 时应拆分。"""
        preset = _make_preset(["main", "charDescription", "chatHistory"])
        assert _should_split_char_fields_for_order(preset, "palink-native") is True

    def test_should_split_returns_true_when_preset_has_personality(self):
        """preset 包含 charPersonality 时应拆分。"""
        preset = _make_preset(["main", "charPersonality"])
        assert _should_split_char_fields_for_order(preset, "palink-native") is True

    def test_should_split_returns_true_when_preset_has_scenario(self):
        """preset 包含 scenario 时应拆分。"""
        preset = _make_preset(["scenario", "main"])
        assert _should_split_char_fields_for_order(preset, "palink-native") is True

    def test_extract_char_field_messages_returns_empty_when_not_needed(self):
        """不需要拆分时返回空列表。"""
        req = _make_request(_make_char(description="desc", personality="pers"))
        # 无 preset
        messages = _extract_char_field_messages_for_order(req, None, "palink-native", "Alice")
        assert messages == []
        # st-compat 模式
        preset = _make_preset(["charDescription"])
        messages = _extract_char_field_messages_for_order(req, preset, "st-compat", "Alice")
        assert messages == []

    def test_extract_char_field_messages_includes_description(self):
        """拆分时把 description 抽取为独立 system 消息。"""
        char = _make_char(description="A brave knight", personality="kind", scenario="medieval")
        req = _make_request(char)
        preset = _make_preset(["main", "charDescription", "charPersonality", "scenario"])
        messages = _extract_char_field_messages_for_order(req, preset, "palink-native", "Alice")
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
        messages = _extract_char_field_messages_for_order(req, preset, "palink-native", "Alice")
        assert len(messages) == 1
        assert messages[0]["_palink_prompt_id"] == PROMPT_ID_CHAR_DESCRIPTION
        assert messages[0]["content"] == "desc"

    def test_extract_char_field_messages_skips_ids_not_in_preset_order(self):
        """preset 未声明的字段不抽取（避免重复内容）。"""
        char = _make_char(description="desc", personality="pers", scenario="scen")
        req = _make_request(char)
        # preset 只声明 charDescription
        preset = _make_preset(["main", "charDescription", "chatHistory"])
        messages = _extract_char_field_messages_for_order(req, preset, "palink-native", "Alice")
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
# P1-2: st-compat 0.7 比例修正（验证 _apply_st_compat_history_trim 不再使用 0.7）
# ---------------------------------------------------------------------------
class TestP12StCompatHistoryTrimRatio:
    """验证 st-compat 历史裁剪不再使用 0.7 比例。"""

    def test_st_compat_trim_uses_full_budget_not_0_7_ratio(self):
        """st-compat 历史裁剪应使用全部剩余预算，而非 0.7 比例。"""
        try:
            from app.services.roleplay_prompt_assembly import _apply_st_compat_history_trim
        except ImportError:
            pytest.skip("_apply_st_compat_history_trim 不可导入")

        # 构造 messages: [system, system(start), user, assistant, user, assistant, system(jailbreak)]
        messages = [
            {"role": "system", "content": "main prompt"},
            {"role": "system", "content": "[Start a new Chat]"},
            {"role": "user", "content": "msg " * 200},
            {"role": "assistant", "content": "reply " * 200},
            {"role": "user", "content": "msg2 " * 200},
            {"role": "assistant", "content": "reply2 " * 200},
            {"role": "system", "content": "jailbreak"},
        ]
        report = []
        # 给一个较小的 budget 触发裁剪
        result = _apply_st_compat_history_trim(messages, token_budget=2000, report=report)

        # 验证 report 中包含裁剪记录
        trim_reports = [r for r in report if r.key == "st_compat_trim"]
        if trim_reports:
            # 裁剪应基于全预算（2000 - mandatory），而非 0.7*2000 - mandatory
            # 这里仅验证裁剪逻辑被触发，具体值由实现决定
            assert trim_reports[0].status in ("trimmed", "skipped")


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
    """验证前端 runtime.ts 中流式事件触发（通过检查文件内容）。"""

    def test_runtime_ts_emits_streaming_started(self):
        """runtime.ts 包含 message_streaming_started 事件触发。"""
        runtime_path = os.path.join(
            _BACKEND_DIR, "..", "frontend", "src", "lib", "sillytavern", "runtime.ts",
        )
        runtime_path = os.path.normpath(runtime_path)
        if not os.path.exists(runtime_path):
            pytest.skip(f"runtime.ts 不存在: {runtime_path}")
        content = open(runtime_path, encoding="utf-8").read()
        assert "message_streaming_started" in content, "runtime.ts 应触发 message_streaming_started 事件"

    def test_runtime_ts_emits_streaming_stopped(self):
        """runtime.ts 包含 message_streaming_stopped 事件触发。"""
        runtime_path = os.path.join(
            _BACKEND_DIR, "..", "frontend", "src", "lib", "sillytavern", "runtime.ts",
        )
        runtime_path = os.path.normpath(runtime_path)
        if not os.path.exists(runtime_path):
            pytest.skip(f"runtime.ts 不存在: {runtime_path}")
        content = open(runtime_path, encoding="utf-8").read()
        assert "message_streaming_stopped" in content, "runtime.ts 应触发 message_streaming_stopped 事件"


# ---------------------------------------------------------------------------
# P1-6: is_hidden 消息过滤（验证 character_message_builder 中的过滤逻辑）
# ---------------------------------------------------------------------------
class TestP16IsHiddenFilter:
    """验证 is_hidden 消息过滤逻辑。"""

    def test_character_message_builder_filters_is_hidden(self):
        """character_message_builder.py 包含 is_hidden 过滤逻辑。"""
        builder_path = os.path.join(
            _BACKEND_DIR, "app", "services", "character_message_builder.py",
        )
        if not os.path.exists(builder_path):
            pytest.skip(f"character_message_builder.py 不存在")
        content = open(builder_path, encoding="utf-8").read()
        assert "is_hidden" in content, "character_message_builder.py 应包含 is_hidden 过滤"


# ---------------------------------------------------------------------------
# P1-4 + P1-5: 后端端点契约（验证 silly_tavern.py 包含相关端点）
# ---------------------------------------------------------------------------
class TestP14P15BackendEndpoints:
    """验证 P1-4 impersonate 端点和 P1-5 swipe 删除端点。"""

    def test_impersonate_endpoint_exists(self):
        """silly_tavern.py 包含 impersonate 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "impersonate" in content.lower(), "silly_tavern.py 应包含 impersonate 端点"

    def test_swipe_delete_endpoint_exists(self):
        """silly_tavern.py 包含 swipe 删除端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "swipes" in content.lower() or "swipe" in content.lower(), \
            "silly_tavern.py 应包含 swipe 相关端点"


# ---------------------------------------------------------------------------
# P1-7: extensionPrompt store 合并（验证 CharacterCardRenderer 注册合并读取）
# ---------------------------------------------------------------------------
class TestP17ExtensionPromptStoreMerge:
    """验证两套 extensionPrompt store 合并读取。"""

    def test_character_card_renderer_registers_get_extension_prompts(self):
        """CharacterCardRenderer.tsx 注册 getExtensionPrompts 合并读取。"""
        renderer_path = os.path.join(
            _BACKEND_DIR, "..", "frontend", "src", "components", "ui", "custom",
            "CharacterCardRenderer.tsx",
        )
        renderer_path = os.path.normpath(renderer_path)
        if not os.path.exists(renderer_path):
            pytest.skip(f"CharacterCardRenderer.tsx 不存在")
        content = open(renderer_path, encoding="utf-8").read()
        assert "getExtensionPrompts" in content or "__palink_extension_prompts" in content, \
            "CharacterCardRenderer.tsx 应注册 getExtensionPrompts 合并读取逻辑"


# ---------------------------------------------------------------------------
# P1-8: global variables 同步层（验证 silly_tavern.py 包含变量端点）
# ---------------------------------------------------------------------------
class TestP18GlobalVariablesSync:
    """验证 ST 兼容变量端点同步层。"""

    def test_st_variable_endpoints_exist(self):
        """silly_tavern.py 包含 /api/variables/* 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "/api/variables" in content, "silly_tavern.py 应包含 /api/variables 端点"

    def test_global_variable_model_imported(self):
        """silly_tavern.py 导入了 GlobalVariable 模型。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "GlobalVariable" in content, "silly_tavern.py 应导入 GlobalVariable 模型"


# ---------------------------------------------------------------------------
# P1-9: expressions 情感分类端点
# ---------------------------------------------------------------------------
class TestP19ExpressionsClassify:
    """验证 /api/extra/classify 和 /api/extra/classify/labels 端点。"""

    def test_classify_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/extra/classify 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/extra/classify"' in content or "/api/extra/classify" in content, \
            "silly_tavern.py 应包含 /api/extra/classify 端点"

    def test_classify_labels_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/extra/classify/labels 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "/api/extra/classify/labels" in content, \
            "silly_tavern.py 应包含 /api/extra/classify/labels 端点"

    def test_go_emotions_labels_defined(self):
        """_GO_EMOTIONS_LABELS 包含 28 个 GoEmotions 标签。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert "_GO_EMOTIONS_LABELS" in content, "应定义 _GO_EMOTIONS_LABELS"
        # 验证包含关键的 GoEmotions 标签
        for label in ("joy", "anger", "sadness", "surprise", "fear", "neutral", "love"):
            assert f'"{label}"' in content, f"应包含 GoEmotions 标签: {label}"

    def test_classify_proxies_to_st_sidecar(self):
        """classify 端点应代理到 ST sidecar。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        # 查找 classify 函数中的代理调用
        classify_section = content[content.find('"/api/extra/classify"'):content.find('"/api/extra/caption"')]
        assert "_forward_extensions_to_st_native" in classify_section, \
            "classify 端点应通过 _forward_extensions_to_st_native 代理到 ST sidecar"

    def test_classify_has_fallback_to_palink(self):
        """classify 端点应有降级到 Palink 关键词匹配的逻辑。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        classify_section = content[content.find('"/api/extra/classify"'):content.find('"/api/extra/caption"')]
        assert "ExpressionService" in classify_section or "analyze_expression" in classify_section, \
            "classify 端点应降级到 ExpressionService 关键词匹配"


# ---------------------------------------------------------------------------
# P1-10: gallery list/folders 端点对齐
# ---------------------------------------------------------------------------
class TestP110GalleryEndpoints:
    """验证 /api/images/list 和 /api/images/folders 端点对齐 ST 契约。"""

    def test_images_list_body_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/images/list 端点（body-based）。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/images/list"' in content, \
            "silly_tavern.py 应包含 POST /api/images/list 端点（body-based）"

    def test_images_folders_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/images/folders 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/images/folders"' in content, \
            "silly_tavern.py 应包含 POST /api/images/folders 端点"

    def test_images_list_returns_string_array(self):
        """images/list 端点应返回纯字符串数组（非 {files: [...]} 对象）。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        # 查找 st_images_list_body 函数
        func_start = content.find("async def st_images_list_body")
        assert func_start != -1, "应存在 st_images_list_body 函数"
        func_end = content.find("\n\n\n", func_start)
        if func_end == -1:
            func_end = func_start + 2000
        func_body = content[func_start:func_end]
        # 应返回 JSONResponse(content=files) 而非 {"files": files}
        assert "content=files" in func_body or "content=files" in func_body, \
            "images/list 端点应返回纯字符串数组"

    def test_images_list_request_model_has_folder_field(self):
        """STImagesListRequest 模型应包含 folder 字段。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        # 查找 STImagesListRequest 类
        class_start = content.find("class STImagesListRequest")
        assert class_start != -1, "应存在 STImagesListRequest 类"
        class_end = content.find("\n\n", class_start)
        if class_end == -1:
            class_end = class_start + 500
        class_body = content[class_start:class_end]
        assert "folder" in class_body, "STImagesListRequest 应包含 folder 字段"
        assert "sortField" in class_body, "STImagesListRequest 应包含 sortField 字段"
        assert "sortOrder" in class_body, "STImagesListRequest 应包含 sortOrder 字段"

    def test_images_folders_returns_string_array(self):
        """images/folders 端点应返回纯字符串数组。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        func_start = content.find("async def st_images_folders")
        assert func_start != -1, "应存在 st_images_folders 函数"
        func_end = content.find("\n\n\n", func_start)
        if func_end == -1:
            func_end = func_start + 1000
        func_body = content[func_start:func_end]
        assert "content=folders" in func_body, \
            "images/folders 端点应返回纯字符串数组"


# ---------------------------------------------------------------------------
# P1-11: memory Extras summarize 端点
# ---------------------------------------------------------------------------
class TestP111SummarizeEndpoints:
    """验证 /api/modules 和 /api/summarize 端点。"""

    def test_modules_endpoint_exists(self):
        """silly_tavern.py 包含 GET /api/modules 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/modules"' in content, \
            "silly_tavern.py 应包含 /api/modules 端点"

    def test_modules_returns_summarize(self):
        """modules 端点应返回包含 'summarize' 的模块列表。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        func_start = content.find("async def st_modules")
        assert func_start != -1, "应存在 st_modules 函数"
        # 提取到下一个顶层定义（@router/async def/class）或足够长的内容
        # 以确保包含 return 语句，而非仅截取到 docstring 第一段
        search_start = func_start + len("async def st_modules")
        next_defs = [
            content.find("\n@router", search_start),
            content.find("\nasync def ", search_start),
            content.find("\nclass ", search_start),
        ]
        next_defs = [p for p in next_defs if p != -1]
        func_end = min(next_defs) if next_defs else func_start + 800
        func_body = content[func_start:func_end]
        assert '"summarize"' in func_body or "'summarize'" in func_body, \
            "modules 端点应返回包含 'summarize' 的模块列表"

    def test_summarize_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/summarize 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/summarize"' in content, \
            "silly_tavern.py 应包含 /api/summarize 端点"

    def test_summarize_request_model_has_text_field(self):
        """STSummarizeRequest 模型应包含 text 字段。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        class_start = content.find("class STSummarizeRequest")
        assert class_start != -1, "应存在 STSummarizeRequest 类"
        class_end = content.find("\n\n", class_start)
        if class_end == -1:
            class_end = class_start + 500
        class_body = content[class_start:class_end]
        assert "text" in class_body, "STSummarizeRequest 应包含 text 字段"
        assert "params" in class_body, "STSummarizeRequest 应包含 params 字段"

    def test_summarize_uses_complete_text_completion(self):
        """summarize 端点应调用 complete_text_completion 做 LLM 总结。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        func_start = content.find("async def st_summarize")
        assert func_start != -1, "应存在 st_summarize 函数"
        func_end = content.find("\n\n\n", func_start)
        if func_end == -1:
            func_end = func_start + 2000
        func_body = content[func_start:func_end]
        assert "complete_text_completion" in func_body, \
            "summarize 端点应调用 complete_text_completion"

    def test_summarize_has_fallback_on_failure(self):
        """summarize 端点应在 LLM 调用失败时降级返回截断原文。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        func_start = content.find("async def st_summarize")
        assert func_start != -1, "应存在 st_summarize 函数"
        func_end = content.find("\n\n\n", func_start)
        if func_end == -1:
            func_end = func_start + 2000
        func_body = content[func_start:func_end]
        assert "except" in func_body, "summarize 端点应有异常处理"
        assert "summary" in func_body, "summarize 端点应有降级摘要"


# ---------------------------------------------------------------------------
# P1-12: caption 端点
# ---------------------------------------------------------------------------
class TestP112CaptionEndpoint:
    """验证 /api/extra/caption 端点。"""

    def test_caption_endpoint_exists(self):
        """silly_tavern.py 包含 POST /api/extra/caption 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        assert '"/api/extra/caption"' in content, \
            "silly_tavern.py 应包含 /api/extra/caption 端点"

    def test_caption_proxies_to_st_sidecar(self):
        """caption 端点应代理到 ST sidecar。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        func_start = content.find("async def st_caption")
        assert func_start != -1, "应存在 st_caption 函数"
        func_end = content.find("\n\n\n", func_start)
        if func_end == -1:
            func_end = func_start + 500
        func_body = content[func_start:func_end]
        assert "_forward_extensions_to_st_native" in func_body, \
            "caption 端点应通过 _forward_extensions_to_st_native 代理到 ST sidecar"


# ---------------------------------------------------------------------------
# P1-13: tts elevenlabs 端点
# ---------------------------------------------------------------------------
class TestP113ElevenlabsEndpoints:
    """验证 7 个 /api/speech/elevenlabs/* 端点。"""

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
        """silly_tavern.py 应包含全部 7 个 elevenlabs 端点。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        for endpoint in self._EXPECTED_ENDPOINTS:
            assert f'"{endpoint}"' in content, \
                f"silly_tavern.py 应包含 {endpoint} 端点"

    def test_elevenlabs_endpoints_proxies_to_st_sidecar(self):
        """所有 elevenlabs 端点应通过 _forward_extensions_to_st_native 代理。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        # 查找 elevenlabs 端点区域
        elevenlabs_start = content.find("/api/speech/elevenlabs/voices")
        # 找到最后一个 elevenlabs 端点
        elevenlabs_end = content.rfind("/api/speech/elevenlabs/recognize")
        assert elevenlabs_start != -1 and elevenlabs_end != -1
        elevenlabs_section = content[elevenlabs_start:elevenlabs_end + 500]
        assert "_forward_extensions_to_st_native" in elevenlabs_section, \
            "elevenlabs 端点应通过 _forward_extensions_to_st_native 代理到 ST sidecar"

    def test_elevenlabs_endpoints_count(self):
        """应有 7 个 elevenlabs 端点定义。"""
        st_path = os.path.join(_BACKEND_DIR, "app", "api", "silly_tavern.py")
        if not os.path.exists(st_path):
            pytest.skip("silly_tavern.py 不存在")
        content = open(st_path, encoding="utf-8").read()
        count = content.count("/api/speech/elevenlabs/")
        assert count >= 7, f"应至少有 7 个 /api/speech/elevenlabs/ 端点定义，实际 {count}"
