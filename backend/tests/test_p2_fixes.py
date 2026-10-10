"""P2 缺口修复契约测试。

覆盖审计报告（docs/st-plugin-compat-spec/backend-plugin-single-chat-audit.md）
中 P2 修复点的契约验证：

- P2-4: /swipe 新 swipe 触发生成（slash_command_service.py）
- P2-6: /var 双向命令（slash_command_service.py）
- P2-7: extension_prompts.scan 字段（model + migration）
- P2-8: /continue 可选 prompt 参数（slash_command_service）
- P2-9: regex CRUD 表与 extension_settings 双向同步（character_ext）
- P2-10: WI MIN_ACTIVATIONS→RECURSION 回退（worldbook_service）

测试方式：单元测试 + 真实导入 + 行为断言，不依赖真实 LLM 调用。

【测试诚实化 2026-10-10】本文件原有 36 处 pytest.skip 已全部处置：
- 18 处 ``try/except ImportError: pytest.skip("... 不可导入")``：改为模块级
  ``importlib.import_module`` 真实导入。模块缺失/改名会在 collection 阶段直接
  报错，不再静默跳过。其中 ``_build_haystack`` / ``_scan_entries`` /
  ``_apply_plugin_regex_scripts`` 三条原本只查形参签名，已升级为真实调用 +
  返回值断言。
- 18 处 ``if not os.path.exists(path): pytest.skip("... 不存在")``：整条用例
  （含 docstring）删除。这些用例断言的是「源码文件在不在 / 文本有没有出现」，
  文件一挪位置就静默跳过，无法发现真实行为回归。

已删除覆盖的修复点（如需回归保护，应在前端侧或用 FastAPI TestClient 重建）：
P2-1（stream_builder model_reasoning 发射）、P2-2（runtime.ts
GENERATION_AFTER_COMMANDS 事件命名）、P2-3（stream_builder [DONE] 信号）、
P2-5（character_ext delete/edit 端点的 is_locked 403 检查）。
"""

import glob
import importlib
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# 真实导入（不再 try/except ImportError 静默跳过）：任一模块缺失或改名都会在
# collection 阶段抛错，测试变红而不是变绿。
slash_command_service = importlib.import_module("app.services.slash_command_service")
worldbook_service = importlib.import_module("app.services.worldbook_service")
character_ext = importlib.import_module("app.api.character_ext")
extension_prompt_model = importlib.import_module("app.models.extension_prompt")
worldbook_model = importlib.import_module("app.models.worldbook")


# ---------------------------------------------------------------------------
# P2-4: /swipe 新 swipe 触发生成
# ---------------------------------------------------------------------------
class TestP24SwipeGeneration:
    """验证 /swipe 命令在创建新 swipe 时触发生成。"""

    def test_swipe_new_triggers_generation(self):
        """/swipe new 创建新 swipe 时 send_to_chat=True。"""
        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello"]), swipe_id=0,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )
        ctx.db.commit = MagicMock()

        with pytest.MonkeyPatch().context() as m:
            m.setattr(
                slash_command_service, "_get_active_branch",
                lambda db, sid: SimpleNamespace(id="b1"),
            )
            m.setattr(
                slash_command_service, "_get_last_ai_message",
                lambda db, sid, bid: mock_msg,
            )

            result = slash_command_service._cmd_swipe(["new"], ctx)
            assert result.send_to_chat is True, \
                "/swipe new 创建新 swipe 时应 send_to_chat=True 触发生成"

    def test_swipe_right_existing_does_not_trigger_generation(self):
        """/swipe right 切换到已有 swipe 时 send_to_chat=False。"""
        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello", "world"]), swipe_id=0,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )
        ctx.db.commit = MagicMock()

        with pytest.MonkeyPatch().context() as m:
            m.setattr(
                slash_command_service, "_get_active_branch",
                lambda db, sid: SimpleNamespace(id="b1"),
            )
            m.setattr(
                slash_command_service, "_get_last_ai_message",
                lambda db, sid, bid: mock_msg,
            )

            result = slash_command_service._cmd_swipe(["right"], ctx)
            assert result.send_to_chat is False, \
                "/swipe right 切换到已有 swipe 时应 send_to_chat=False"

    def test_swipe_left_does_not_trigger_generation(self):
        """/swipe left 不触发生成。"""
        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello", "world"]), swipe_id=1,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )
        ctx.db.commit = MagicMock()

        with pytest.MonkeyPatch().context() as m:
            m.setattr(
                slash_command_service, "_get_active_branch",
                lambda db, sid: SimpleNamespace(id="b1"),
            )
            m.setattr(
                slash_command_service, "_get_last_ai_message",
                lambda db, sid, bid: mock_msg,
            )

            result = slash_command_service._cmd_swipe(["left"], ctx)
            assert result.send_to_chat is False, \
                "/swipe left 应 send_to_chat=False"


# ---------------------------------------------------------------------------
# P2-6: /var 双向命令
# ---------------------------------------------------------------------------
class TestP26VarCommand:
    """验证 /var 命令的双向 get/set 语义。"""

    def test_var_command_registered(self):
        """/var 命令已在注册表中注册。"""
        handler = slash_command_service.SlashCommandRegistry.get("var")
        assert handler is not None, "/var 命令应已注册"

    def test_var_command_get_semantics(self):
        """/var <key> 不带 value 时执行 get 操作。"""
        mock_session = SimpleNamespace(id="test", character=None)
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )

        # mock MacroEnv — _get_chat_var 返回 "hello"
        with pytest.MonkeyPatch().context() as m:
            mock_env = MagicMock()
            mock_env._get_chat_var.return_value = "hello"
            mock_env._get_user_var.return_value = None
            mock_env._get_global_var.return_value = None
            m.setattr(slash_command_service, "MacroEnv", lambda **kwargs: mock_env)

            result = slash_command_service._cmd_var(["mykey"], ctx)
            assert result.response == "hello"
            assert result.send_to_chat is False
            mock_env._set_chat_var.assert_not_called()

    def test_var_command_set_semantics(self):
        """/var <key> <value> 带 value 时执行 set 操作。"""
        mock_session = SimpleNamespace(id="test", character=None)
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )

        with pytest.MonkeyPatch().context() as m:
            mock_env = MagicMock()
            m.setattr(slash_command_service, "MacroEnv", lambda **kwargs: mock_env)

            result = slash_command_service._cmd_var(["mykey", "myvalue"], ctx)
            assert result.response == "myvalue"
            assert result.modified is True
            mock_env._set_chat_var.assert_called_once_with("mykey", "myvalue")

    def test_var_command_no_args_returns_usage(self):
        """/var 无参数时返回 usage。"""
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=None,
            input_text="",
        )

        result = slash_command_service._cmd_var([], ctx)
        assert "Usage" in result.response
        assert result.send_to_chat is False

    def test_var_command_get_returns_empty_when_not_found(self):
        """/var <key> 变量不存在时返回空字符串。"""
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=SimpleNamespace(id="test", character=None),
            input_text="",
        )

        with pytest.MonkeyPatch().context() as m:
            mock_env = MagicMock()
            mock_env._get_chat_var.return_value = None
            mock_env._get_user_var.return_value = None
            mock_env._get_global_var.return_value = None
            m.setattr(slash_command_service, "MacroEnv", lambda **kwargs: mock_env)

            result = slash_command_service._cmd_var(["nonexistent"], ctx)
            assert result.response == ""


# ---------------------------------------------------------------------------
# P2-7: extension_prompts.scan 字段
# ---------------------------------------------------------------------------
class TestP27ExtensionPromptScan:
    """验证 extension_prompts.scan 字段对齐 ST 1.18.0 extension_prompt.scan 语义。"""

    def test_model_has_scan_column(self):
        """ExtensionPrompt 模型应包含 scan 字段。"""
        ExtensionPrompt = extension_prompt_model.ExtensionPrompt
        assert hasattr(ExtensionPrompt, "scan"), \
            "ExtensionPrompt 模型应有 scan 字段"
        col = ExtensionPrompt.__table__.columns.get("scan")
        assert col is not None, "extension_prompts.scan column 应存在"

    def test_migration_file_exists(self):
        """应有对应的数据库迁移文件添加 scan 列。"""
        migration_pattern = os.path.join(
            _BACKEND_DIR, "alembic", "versions", "*extension_prompt_scan*"
        )
        matches = glob.glob(migration_pattern)
        assert len(matches) > 0, \
            "应存在添加 extension_prompts.scan 列的迁移文件"


# ---------------------------------------------------------------------------
# P2-8: /continue 可选 prompt 参数
# ---------------------------------------------------------------------------
class TestP28ContinuePrompt:
    """验证 /continue 命令支持可选 prompt 参数。"""

    def test_slash_command_result_has_continue_fields(self):
        """SlashCommandResult 应有 is_continue 和 continue_prompt 字段。"""
        result = slash_command_service.SlashCommandResult()
        assert hasattr(result, "is_continue"), \
            "SlashCommandResult 应有 is_continue 字段"
        assert hasattr(result, "continue_prompt"), \
            "SlashCommandResult 应有 continue_prompt 字段"
        assert result.is_continue is False, \
            "is_continue 默认应为 False"
        assert result.continue_prompt is None, \
            "continue_prompt 默认应为 None"

    def test_continue_no_args_sets_is_continue(self):
        """/continue 无参数时 is_continue=True, continue_prompt=None。"""
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(), session_id="test", user_id=1, user_name="TestUser",
            character=None, session=None, input_text="",
        )
        result = slash_command_service._cmd_continue([], ctx)
        assert result.is_continue is True
        assert result.continue_prompt is None
        assert result.send_to_chat is False

    def test_continue_with_args_sets_continue_prompt(self):
        """/continue <prompt> 时 continue_prompt=拼接后的 prompt。"""
        ctx = slash_command_service.SlashCommandContext(
            db=MagicMock(), session_id="test", user_id=1, user_name="TestUser",
            character=None, session=None, input_text="",
        )
        result = slash_command_service._cmd_continue(["continue", "from", "here"], ctx)
        assert result.is_continue is True
        assert result.continue_prompt == "continue from here"
        assert result.send_to_chat is False


# ---------------------------------------------------------------------------
# P2-9: regex CRUD 表与 extension_settings 双向同步
# ---------------------------------------------------------------------------
class TestP29RegexSync:
    """验证 regex 脚本从 extension_settings.regex_scripts 读取并应用。"""

    def test_apply_plugin_regex_scripts_accepts_user_id(self):
        """P2-9: user_id 真实生效——透传给 _load_extension_settings_regex_scripts
        并应用其返回的脚本。

        原用例只断言函数签名里有 user_id 形参；改为真实调用：
        - 传 user_id=7 时 loader 收到 7，且其返回的脚本被实际应用（hello → HELLO）；
        - 不传 user_id 时 loader 完全不被调用（保持原有行为，原文返回）。
        """
        script = {
            "scriptName": "st-ext-regex",
            "findRegex": "hello",
            "replaceString": "HELLO",
            "trimStrings": [],
            "placement": [2],
            "disabled": False,
            "markdownOnly": False,
            "promptOnly": False,
            "runOnEdit": False,
            "substituteRegex": 0,
            "minDepth": None,
            "maxDepth": None,
            "order": 0,
        }
        seen: list = []

        def _fake_loader(db, user_id):
            seen.append(user_id)
            return [script]

        with pytest.MonkeyPatch().context() as m:
            m.setattr(character_ext, "_load_plugin_regex_script_dicts", lambda db: [])
            m.setattr(
                character_ext, "_load_extension_settings_regex_scripts", _fake_loader,
            )
            applied = character_ext._apply_plugin_regex_scripts(
                "hello world", MagicMock(), is_markdown=False, user_id=7,
            )
            skipped = character_ext._apply_plugin_regex_scripts(
                "hello world", MagicMock(), is_markdown=False,
            )

        assert seen == [7], \
            "user_id 应真实透传给 _load_extension_settings_regex_scripts"
        assert applied == "HELLO world", \
            "extension_settings.regex_scripts 中的脚本应被实际应用"
        assert skipped == "hello world", \
            "user_id=None 时不应读取 extension_settings（保持原有行为）"


# ---------------------------------------------------------------------------
# P2-10: WI MIN_ACTIVATIONS→RECURSION 回退
# ---------------------------------------------------------------------------
def _make_stage(stage_id: str, keys: list, content: str, **overrides) -> object:
    """构造 WorldBookStage 实例（P2-10 用例共用）。"""
    base = dict(
        id=stage_id, world_book_id="wb", stage_index=0,
        title=f"entry-{stage_id}", content=content,
        keys=json.dumps(keys), secondary_keys=json.dumps([]),
        position=4, depth=4,
        selective=False, selective_logic=0,
        probability=100, constant=False, enabled=True,
        exclude_recursion=False, prevent_recursion=False,
        scan_depth=None,
    )
    base.update(overrides)
    return worldbook_model.WorldBookStage(**base)


class TestP210MinActivationsRecursionFallback:
    """验证 MIN_ACTIVATIONS→RECURSION 回退对齐 ST scan_state 状态机。"""

    def test_build_haystack_accepts_recurse_buffer(self):
        """P2-10: recurse_buffer 的内容应真实并入 haystack。

        原用例只断言形参名存在；改为真实调用：不传 recurse_buffer 时 buffer 内容
        不在 haystack 中，传入后必须出现在 haystack 中。
        """
        entry = _make_stage("a", ["griffin"], "Griffin lore")
        recent = [{"role": "user", "content": "nothing here"}]

        without_buffer = worldbook_service._build_haystack(entry, recent, None)
        with_buffer = worldbook_service._build_haystack(
            entry, recent, None, recurse_buffer=["the griffin flies"],
        )

        assert "the griffin flies" not in without_buffer, \
            "未传 recurse_buffer 时不应包含 buffer 内容"
        assert "the griffin flies" in with_buffer, \
            "传入 recurse_buffer 时其内容应并入 haystack"

    def test_scan_entries_accepts_recurse_buffer(self):
        """P2-10: recurse_buffer 应真实使条目被 _scan_entries 激活。

        条目关键词 "griffin" 不在聊天消息中、只在 recurse_buffer 中：
        不传 recurse_buffer 时不激活，传入后激活。
        """
        entry = _make_stage("a", ["griffin"], "Griffin lore")
        recent = [{"role": "user", "content": "nothing here"}]

        activated_without = worldbook_service._scan_entries(
            [entry], recent, None, None, 0, set(), 0, [],
        )
        activated_with = worldbook_service._scan_entries(
            [entry], recent, None, None, 0, set(), 0, [],
            recurse_buffer=["the griffin flies"],
        )

        assert [e.id for e in activated_without] == [], \
            "无 recurse_buffer 时条目不应被激活"
        assert [e.id for e in activated_with] == ["a"], \
            "recurse_buffer 中的关键词应使条目被激活"

    def test_fallback_activates_entries_via_content(self):
        """MIN_ACTIVATIONS 找到的条目内容应触发 RECURSION 回退激活其他条目。

        场景: 条目 A 的关键词在聊天消息中（被 MIN_ACTIVATIONS 找到），
        条目 B 的关键词在条目 A 的内容中（需要 RECURSION 回退才能激活）。
        """
        WI_POS_AT_DEPTH = 4
        # 条目 A: 关键词 "dragon" 在远距离聊天消息中
        entry_a = worldbook_model.WorldBookStage(
            id="a", world_book_id="wb", stage_index=0,
            title="entry-a", content="The griffin flies high",
            keys=json.dumps(["dragon"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )
        # 条目 B: 关键词 "griffin" 在条目 A 的内容中（不在聊天消息中）
        entry_b = worldbook_model.WorldBookStage(
            id="b", world_book_id="wb", stage_index=1,
            title="entry-b", content="Griffin lore discovered",
            keys=json.dumps(["griffin"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )

        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[0]["content"] = "I saw a dragon."  # 远距离，需要 MIN_ACTIVATIONS 扩展

        activated, report = worldbook_service._recursive_scan(
            entries=[entry_a, entry_b],
            recent_messages=recent,
            char=None, timed_mgr=None, message_index=0,
            min_activations=1,
            min_activations_depth_max=20,
        )

        # 条目 A 应被 MIN_ACTIVATIONS 激活
        activated_ids = {e.id for e in activated}
        assert "a" in activated_ids, \
            "条目 A 应被 MIN_ACTIVATIONS 激活（关键词 dragon 在聊天消息中）"
        # P2-10: 条目 B 应被 RECURSION 回退激活（关键词 griffin 在条目 A 的内容中）
        assert "b" in activated_ids, \
            "条目 B 应被 RECURSION 回退激活（关键词 griffin 在条目 A 的内容中）"

    def test_fallback_respects_exclude_recursion(self):
        """exclude_recursion 条目的内容不进入递归 buffer。"""
        WI_POS_AT_DEPTH = 4
        # 条目 A: exclude_recursion=True，内容不进入递归 buffer
        entry_a = worldbook_model.WorldBookStage(
            id="a", world_book_id="wb", stage_index=0,
            title="entry-a", content="The griffin flies high",
            keys=json.dumps(["dragon"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=True, prevent_recursion=False,
            scan_depth=None,
        )
        entry_b = worldbook_model.WorldBookStage(
            id="b", world_book_id="wb", stage_index=1,
            title="entry-b", content="Griffin lore discovered",
            keys=json.dumps(["griffin"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )

        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[0]["content"] = "I saw a dragon."

        activated, report = worldbook_service._recursive_scan(
            entries=[entry_a, entry_b],
            recent_messages=recent,
            char=None, timed_mgr=None, message_index=0,
            min_activations=1,
            min_activations_depth_max=20,
        )

        activated_ids = {e.id for e in activated}
        assert "a" in activated_ids, "条目 A 应被激活"
        # 条目 B 不应被激活，因为条目 A 的内容被 exclude_recursion 排除
        assert "b" not in activated_ids, \
            "条目 B 不应被激活（条目 A 的 exclude_recursion=True，内容不进入递归 buffer）"

    def test_fallback_not_triggered_when_min_activations_zero(self):
        """min_activations=0 时不触发 RECURSION 回退（保持原有行为）。"""
        WI_POS_AT_DEPTH = 4
        entry_a = worldbook_model.WorldBookStage(
            id="a", world_book_id="wb", stage_index=0,
            title="entry-a", content="The griffin flies high",
            keys=json.dumps(["dragon"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )
        entry_b = worldbook_model.WorldBookStage(
            id="b", world_book_id="wb", stage_index=1,
            title="entry-b", content="Griffin lore discovered",
            keys=json.dumps(["griffin"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )

        recent = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        recent[9]["content"] = "I saw a dragon."  # 在 DEFAULT_SCAN_DEPTH 范围内

        activated, report = worldbook_service._recursive_scan(
            entries=[entry_a, entry_b],
            recent_messages=recent,
            char=None, timed_mgr=None, message_index=0,
            min_activations=0,  # 默认关闭
        )

        # 条目 A 应被常规扫描激活（关键词在 DEFAULT_SCAN_DEPTH 范围内）
        activated_ids = {e.id for e in activated}
        assert "a" in activated_ids, "条目 A 应被常规扫描激活"
        # 条目 B 应被常规递归激活（内容追加到 recent_messages 后被扫描到）
        # 注意：常规递归通过追加 system 消息实现，不走 recurse_buffer 路径
        assert "b" in activated_ids, \
            "条目 B 应被常规递归激活（min_activations=0 时走原有递归路径）"
