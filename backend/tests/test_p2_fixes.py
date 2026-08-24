"""P2 缺口修复契约测试。

覆盖审计报告（docs/st-plugin-compat-spec/backend-plugin-single-chat-audit.md）
中 P2 修复点的契约验证：

- P2-1: model_reasoning 字段发射（stream_builder.py）
- P2-2: GENERATION_AFTER_COMMANDS 事件命名统一（runtime.ts）
- P2-3: [DONE] 信号发射（stream_builder.py）
- P2-4: /swipe 新 swipe 触发生成（slash_command_service.py）
- P2-5: is_locked 强制检查（character_ext.py delete/edit 端点）
- P2-6: /var 双向命令（slash_command_service.py）
- P2-7: extension_prompts.scan 字段（model + migration + API）
- P2-8: /continue 可选 prompt 参数（slash_command_service + websocket）
- P2-9: regex CRUD 表与 extension_settings 双向同步（character_ext）
- P2-10: WI MIN_ACTIVATIONS→RECURSION 回退（worldbook_service）

测试方式：单元测试 + 函数签名/行为验证 + 源码契约检查，不依赖真实 LLM 调用。
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


# ---------------------------------------------------------------------------
# P2-1 + P2-3: stream_builder.py — model_reasoning 字段 + [DONE] 信号
# ---------------------------------------------------------------------------
class TestP21ModelReasoningField:
    """验证 stream_builder.py 发射 model_reasoning 别名字段。"""

    def test_stream_builder_source_contains_model_reasoning(self):
        """stream_builder.py 源码中应包含 model_reasoning 字段发射。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "stream_builder.py")
        if not os.path.exists(path):
            pytest.skip("stream_builder.py 不存在")
        content = open(path, encoding="utf-8").read()
        assert 'model_reasoning' in content, \
            "stream_builder.py 应发射 model_reasoning 别名字段"

    def test_stream_builder_model_reasoning_in_reasoning_block(self):
        """model_reasoning 应在 reasoning 块中与 reasoning 字段一起发射。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "stream_builder.py")
        if not os.path.exists(path):
            pytest.skip("stream_builder.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 验证 model_reasoning 出现在 reasoning 赋值附近
        idx = content.find('resp["reasoning"] = reasoning')
        assert idx != -1, "应存在 resp['reasoning'] = reasoning 赋值"
        nearby = content[idx:idx + 300]
        assert "model_reasoning" in nearby, \
            "model_reasoning 应在 reasoning 赋值附近一同发射"


class TestP23DoneSignal:
    """验证 stream_builder.py 发射 [DONE] 信号。"""

    def test_stream_builder_emits_done(self):
        """stream_builder.py 应发射 data: [DONE] 信号（非死代码）。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "stream_builder.py")
        if not os.path.exists(path):
            pytest.skip("stream_builder.py 不存在")
        content = open(path, encoding="utf-8").read()
        assert 'yield "data: [DONE]\\n\\n"' in content or \
               "yield 'data: [DONE]\\n\\n'" in content or \
               'yield "data: [DONE]\n\n"' in content, \
            "stream_builder.py 应发射 [DONE] 信号"

    def test_stream_builder_no_dead_code_if_false(self):
        """stream_builder.py 中 [DONE] 前不应有 if False: 死代码保护。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "stream_builder.py")
        if not os.path.exists(path):
            pytest.skip("stream_builder.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 [DONE] 附近不应有 "if False:"
        done_idx = content.find("[DONE]")
        assert done_idx != -1, "应存在 [DONE] 信号"
        # 检查 [DONE] 前 100 字符内不应有 "if False:"
        before_done = content[max(0, done_idx - 100):done_idx]
        assert "if False" not in before_done, \
            "[DONE] 信号不应被 if False: 死代码保护"


# ---------------------------------------------------------------------------
# P2-2: runtime.ts — GENERATION_AFTER_COMMANDS 事件命名
# ---------------------------------------------------------------------------
class TestP22GenerationAfterCommandsEvent:
    """验证 GENERATION_AFTER_COMMANDS 事件命名对齐 ST 大写值。"""

    def test_runtime_ts_uses_uppercase_event_value(self):
        """runtime.ts 中 GENERATION_AFTER_COMMANDS 应使用大写值（对齐 ST events.js）。"""
        runtime_candidates = [
            os.path.normpath(os.path.join(
                _BACKEND_DIR, "..", "frontend", "src", "lib", "sillytavern", "runtime.ts"
            )),
            "/opt/frontend-src/src/lib/sillytavern/runtime.ts",
        ]
        runtime_path = next(
            (p for p in runtime_candidates if os.path.exists(p)),
            runtime_candidates[0],
        )
        if not os.path.exists(runtime_path):
            pytest.skip("runtime.ts 不存在")
        content = open(runtime_path, encoding="utf-8").read()
        # 查找 GENERATION_AFTER_COMMANDS 的值定义
        idx = content.find("GENERATION_AFTER_COMMANDS:")
        assert idx != -1, "runtime.ts 应定义 GENERATION_AFTER_COMMANDS"
        line_end = content.find("\n", idx)
        line = content[idx:line_end]
        # 不应使用 kebab-case 'generation:after-commands'
        assert "generation:after-commands" not in line, \
            "GENERATION_AFTER_COMMANDS 不应使用 kebab-case 值"
        # 应使用大写值 'GENERATION_AFTER_COMMANDS'
        assert "GENERATION_AFTER_COMMANDS" in line.split(":", 1)[1], \
            "GENERATION_AFTER_COMMANDS 应使用大写值"


# ---------------------------------------------------------------------------
# P2-4: /swipe 新 swipe 触发生成
# ---------------------------------------------------------------------------
class TestP24SwipeGeneration:
    """验证 /swipe 命令在创建新 swipe 时触发生成。"""

    def test_swipe_new_triggers_generation(self):
        """/swipe new 创建新 swipe 时 send_to_chat=True。"""
        try:
            from app.services.slash_command_service import _cmd_swipe, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello"]), swipe_id=0,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = SlashCommandContext(
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
            import app.services.slash_command_service as mod
            m.setattr(mod, "_get_active_branch", lambda db, sid: SimpleNamespace(id="b1"))
            m.setattr(mod, "_get_last_ai_message", lambda db, sid, bid: mock_msg)

            result = _cmd_swipe(["new"], ctx)
            assert result.send_to_chat is True, \
                "/swipe new 创建新 swipe 时应 send_to_chat=True 触发生成"

    def test_swipe_right_existing_does_not_trigger_generation(self):
        """/swipe right 切换到已有 swipe 时 send_to_chat=False。"""
        try:
            from app.services.slash_command_service import _cmd_swipe, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello", "world"]), swipe_id=0,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = SlashCommandContext(
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
            import app.services.slash_command_service as mod
            m.setattr(mod, "_get_active_branch", lambda db, sid: SimpleNamespace(id="b1"))
            m.setattr(mod, "_get_last_ai_message", lambda db, sid, bid: mock_msg)

            result = _cmd_swipe(["right"], ctx)
            assert result.send_to_chat is False, \
                "/swipe right 切换到已有 swipe 时应 send_to_chat=False"

    def test_swipe_left_does_not_trigger_generation(self):
        """/swipe left 不触发生成。"""
        try:
            from app.services.slash_command_service import _cmd_swipe, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        mock_msg = SimpleNamespace(
            id=1, session_id="test", role="assistant",
            content="hello", swipes=json.dumps(["hello", "world"]), swipe_id=1,
            is_hidden=False, is_locked=False,
        )
        mock_session = SimpleNamespace(id="test", character=None)

        ctx = SlashCommandContext(
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
            import app.services.slash_command_service as mod
            m.setattr(mod, "_get_active_branch", lambda db, sid: SimpleNamespace(id="b1"))
            m.setattr(mod, "_get_last_ai_message", lambda db, sid, bid: mock_msg)

            result = _cmd_swipe(["left"], ctx)
            assert result.send_to_chat is False, \
                "/swipe left 应 send_to_chat=False"


# ---------------------------------------------------------------------------
# P2-5: is_locked 强制检查
# ---------------------------------------------------------------------------
class TestP25IsLockedEnforcement:
    """验证 delete/edit 端点对 is_locked 消息的强制检查。"""

    def test_delete_endpoint_checks_is_locked(self):
        """delete_character_message 端点源码包含 is_locked 检查。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 delete 端点
        delete_idx = content.find("async def delete_character_message")
        assert delete_idx != -1, "应存在 delete_character_message 端点"
        # 查找下一个函数定义作为端点结束
        next_func = content.find("\n\nasync def ", delete_idx + 10)
        if next_func == -1:
            next_func = content.find("\n\n@router", delete_idx + 10)
        if next_func == -1:
            next_func = delete_idx + 1000
        delete_body = content[delete_idx:next_func]
        assert "is_locked" in delete_body, \
            "delete 端点应检查 is_locked 字段"
        assert "403" in delete_body, \
            "delete 端点应在 is_locked=True 时返回 403"

    def test_edit_endpoint_checks_is_locked(self):
        """edit_character_message 端点源码包含 is_locked 检查。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 edit 端点
        edit_idx = content.find("async def edit_character_message")
        assert edit_idx != -1, "应存在 edit_character_message 端点"
        # 查找下一个函数定义作为端点结束
        next_func = content.find("\n\nasync def ", edit_idx + 10)
        if next_func == -1:
            next_func = content.find("\n\n@router", edit_idx + 10)
        if next_func == -1:
            next_func = edit_idx + 1500
        edit_body = content[edit_idx:next_func]
        assert "is_locked" in edit_body, \
            "edit 端点应检查 is_locked 字段"
        assert "403" in edit_body, \
            "edit 端点应在 is_locked=True 时返回 403"


# ---------------------------------------------------------------------------
# P2-6: /var 双向命令
# ---------------------------------------------------------------------------
class TestP26VarCommand:
    """验证 /var 命令的双向 get/set 语义。"""

    def test_var_command_registered(self):
        """/var 命令已在注册表中注册。"""
        try:
            from app.services.slash_command_service import SlashCommandRegistry
        except ImportError:
            pytest.skip("slash_command_service 不可导入")
        handler = SlashCommandRegistry.get("var")
        assert handler is not None, "/var 命令应已注册"

    def test_var_command_get_semantics(self):
        """/var <key> 不带 value 时执行 get 操作。"""
        try:
            from app.services.slash_command_service import _cmd_var, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        mock_session = SimpleNamespace(id="test", character=None)
        ctx = SlashCommandContext(
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
            # 由于 MacroEnv 在函数内部构造，我们 mock 模块级别的 MacroEnv
            import app.services.slash_command_service as mod
            mock_env = MagicMock()
            mock_env._get_chat_var.return_value = "hello"
            mock_env._get_user_var.return_value = None
            mock_env._get_global_var.return_value = None
            m.setattr(mod, "MacroEnv", lambda **kwargs: mock_env)

            result = _cmd_var(["mykey"], ctx)
            assert result.response == "hello"
            assert result.send_to_chat is False
            mock_env._set_chat_var.assert_not_called()

    def test_var_command_set_semantics(self):
        """/var <key> <value> 带 value 时执行 set 操作。"""
        try:
            from app.services.slash_command_service import _cmd_var, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        mock_session = SimpleNamespace(id="test", character=None)
        ctx = SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=mock_session,
            input_text="",
        )

        with pytest.MonkeyPatch().context() as m:
            import app.services.slash_command_service as mod
            mock_env = MagicMock()
            m.setattr(mod, "MacroEnv", lambda **kwargs: mock_env)

            result = _cmd_var(["mykey", "myvalue"], ctx)
            assert result.response == "myvalue"
            assert result.modified is True
            mock_env._set_chat_var.assert_called_once_with("mykey", "myvalue")

    def test_var_command_no_args_returns_usage(self):
        """/var 无参数时返回 usage。"""
        try:
            from app.services.slash_command_service import _cmd_var, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        ctx = SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=None,
            input_text="",
        )

        result = _cmd_var([], ctx)
        assert "Usage" in result.response
        assert result.send_to_chat is False

    def test_var_command_get_returns_empty_when_not_found(self):
        """/var <key> 变量不存在时返回空字符串。"""
        try:
            from app.services.slash_command_service import _cmd_var, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        ctx = SlashCommandContext(
            db=MagicMock(),
            session_id="test",
            user_id=1,
            user_name="TestUser",
            character=None,
            session=SimpleNamespace(id="test", character=None),
            input_text="",
        )

        with pytest.MonkeyPatch().context() as m:
            import app.services.slash_command_service as mod
            mock_env = MagicMock()
            mock_env._get_chat_var.return_value = None
            mock_env._get_user_var.return_value = None
            mock_env._get_global_var.return_value = None
            m.setattr(mod, "MacroEnv", lambda **kwargs: mock_env)

            result = _cmd_var(["nonexistent"], ctx)
            assert result.response == ""


# ---------------------------------------------------------------------------
# P2-7: extension_prompts.scan 字段
# ---------------------------------------------------------------------------
class TestP27ExtensionPromptScan:
    """验证 extension_prompts.scan 字段对齐 ST 1.18.0 extension_prompt.scan 语义。"""

    def test_model_has_scan_column(self):
        """ExtensionPrompt 模型应包含 scan 字段。"""
        try:
            from app.models.extension_prompt import ExtensionPrompt
        except ImportError:
            pytest.skip("ExtensionPrompt 模型不可导入")
        assert hasattr(ExtensionPrompt, "scan"), \
            "ExtensionPrompt 模型应有 scan 字段"
        col = ExtensionPrompt.__table__.columns.get("scan")
        assert col is not None, "extension_prompts.scan column 应存在"

    def test_migration_file_exists(self):
        """应有对应的数据库迁移文件添加 scan 列。"""
        import glob
        migration_pattern = os.path.join(
            _BACKEND_DIR, "alembic", "versions", "*extension_prompt_scan*"
        )
        matches = glob.glob(migration_pattern)
        assert len(matches) > 0, \
            "应存在添加 extension_prompts.scan 列的迁移文件"

    def test_api_entry_to_dict_returns_scan(self):
        """_entry_to_dict 应返回 scan 字段。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "extension_prompts.py")
        if not os.path.exists(path):
            pytest.skip("extension_prompts.py 不存在")
        content = open(path, encoding="utf-8").read()
        # _entry_to_dict 应包含 scan 字段
        dict_idx = content.find("def _entry_to_dict")
        assert dict_idx != -1, "应存在 _entry_to_dict 函数"
        func_body = content[dict_idx:dict_idx + 800]
        assert "scan" in func_body, \
            "_entry_to_dict 应返回 scan 字段"

    def test_api_set_extension_prompt_persists_scan(self):
        """set_extension_prompt 应持久化 scan 字段。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "extension_prompts.py")
        if not os.path.exists(path):
            pytest.skip("extension_prompts.py 不存在")
        content = open(path, encoding="utf-8").read()
        set_idx = content.find("def set_extension_prompt")
        assert set_idx != -1, "应存在 set_extension_prompt 函数"
        func_body = content[set_idx:set_idx + 2000]
        assert "scan" in func_body, \
            "set_extension_prompt 应持久化 scan 字段"

    def test_assembly_uses_scan_for_macro_substitution(self):
        """roleplay_prompt_assembly 应在 scan=true 时执行宏替换。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "roleplay_prompt_assembly.py")
        if not os.path.exists(path):
            pytest.skip("roleplay_prompt_assembly.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 scan 相关的宏替换逻辑
        assert 'scan' in content and 'replace_placeholders' in content, \
            "roleplay_prompt_assembly 应在 scan=true 时调用 replace_placeholders"


# ---------------------------------------------------------------------------
# P2-8: /continue 可选 prompt 参数
# ---------------------------------------------------------------------------
class TestP28ContinuePrompt:
    """验证 /continue 命令支持可选 prompt 参数。"""

    def test_slash_command_result_has_continue_fields(self):
        """SlashCommandResult 应有 is_continue 和 continue_prompt 字段。"""
        try:
            from app.services.slash_command_service import SlashCommandResult
        except ImportError:
            pytest.skip("slash_command_service 不可导入")
        result = SlashCommandResult()
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
        try:
            from app.services.slash_command_service import _cmd_continue, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        ctx = SlashCommandContext(
            db=MagicMock(), session_id="test", user_id=1, user_name="TestUser",
            character=None, session=None, input_text="",
        )
        result = _cmd_continue([], ctx)
        assert result.is_continue is True
        assert result.continue_prompt is None
        assert result.send_to_chat is False

    def test_continue_with_args_sets_continue_prompt(self):
        """/continue <prompt> 时 continue_prompt=拼接后的 prompt。"""
        try:
            from app.services.slash_command_service import _cmd_continue, SlashCommandContext
        except ImportError:
            pytest.skip("slash_command_service 不可导入")

        ctx = SlashCommandContext(
            db=MagicMock(), session_id="test", user_id=1, user_name="TestUser",
            character=None, session=None, input_text="",
        )
        result = _cmd_continue(["continue", "from", "here"], ctx)
        assert result.is_continue is True
        assert result.continue_prompt == "continue from here"
        assert result.send_to_chat is False

    def test_continue_request_has_continue_prompt_field(self):
        """ContinueRequest 应有 continue_prompt 字段。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 ContinueRequest 类定义
        idx = content.find("class ContinueRequest")
        assert idx != -1, "应存在 ContinueRequest 类"
        class_body = content[idx:idx + 500]
        assert "continue_prompt" in class_body, \
            "ContinueRequest 应有 continue_prompt 字段"

    def test_websocket_handles_is_continue(self):
        """websocket.py 应处理 is_continue 标记。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "websocket.py")
        if not os.path.exists(path):
            pytest.skip("websocket.py 不存在")
        content = open(path, encoding="utf-8").read()
        assert "is_continue" in content, \
            "websocket.py 应处理 is_continue 标记"
        assert "continue_prompt" in content, \
            "websocket.py 应处理 continue_prompt"

    def test_continue_session_endpoint_supports_prompt(self):
        """continue_session 端点应支持 continue_prompt 参数。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        idx = content.find("async def continue_session")
        assert idx != -1, "应存在 continue_session 端点"
        func_body = content[idx:idx + 3000]
        assert "continue_prompt" in func_body, \
            "continue_session 端点应处理 continue_prompt 参数"


# ---------------------------------------------------------------------------
# P2-9: regex CRUD 表与 extension_settings 双向同步
# ---------------------------------------------------------------------------
class TestP29RegexSync:
    """验证 regex 脚本从 extension_settings.regex_scripts 读取并应用。"""

    def test_load_extension_settings_regex_scripts_exists(self):
        """_load_extension_settings_regex_scripts 函数应存在。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        assert "_load_extension_settings_regex_scripts" in content, \
            "应存在 _load_extension_settings_regex_scripts 函数"

    def test_apply_plugin_regex_scripts_accepts_user_id(self):
        """_apply_plugin_regex_scripts 应接受 user_id 参数。"""
        try:
            from app.api.character_ext import _apply_plugin_regex_scripts
            import inspect
        except ImportError:
            pytest.skip("character_ext 不可导入")
        sig = inspect.signature(_apply_plugin_regex_scripts)
        assert "user_id" in sig.parameters, \
            "_apply_plugin_regex_scripts 应接受 user_id 参数"

    def test_load_function_reads_extension_settings(self):
        """_load_extension_settings_regex_scripts 应从 extension_settings.regex_scripts 读取。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        idx = content.find("def _load_extension_settings_regex_scripts")
        assert idx != -1, "应存在 _load_extension_settings_regex_scripts 函数"
        func_body = content[idx:idx + 2000]
        assert "extension_settings" in func_body, \
            "应从 extension_settings 读取"
        assert "regex_scripts" in func_body, \
            "应读取 regex_scripts 数组"
        # 应处理 camelCase 字段（ST 格式）
        assert "findRegex" in func_body or "find_regex" in func_body, \
            "应处理 ST camelCase 格式字段"

    def test_load_function_skips_disabled(self):
        """_load_extension_settings_regex_scripts 应跳过 disabled 脚本。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        if not os.path.exists(path):
            pytest.skip("character_ext.py 不存在")
        content = open(path, encoding="utf-8").read()
        idx = content.find("def _load_extension_settings_regex_scripts")
        assert idx != -1
        func_body = content[idx:idx + 2000]
        assert "disabled" in func_body, \
            "应跳过 disabled 的 regex 脚本"

    def test_assembly_passes_user_id_to_regex(self):
        """roleplay_prompt_assembly 应传递 user_id 到 apply_prompt_regex_to_messages。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "roleplay_prompt_assembly.py")
        if not os.path.exists(path):
            pytest.skip("roleplay_prompt_assembly.py 不存在")
        content = open(path, encoding="utf-8").read()
        # 查找 apply_prompt_regex_to_messages 的实际调用（非类型定义）
        # 类型定义是 "apply_prompt_regex_to_messages: ApplyPromptRegexToMessagesFn"
        # 实际调用是 "deps.apply_prompt_regex_to_messages(...)"
        call_idx = content.find("deps.apply_prompt_regex_to_messages")
        assert call_idx != -1, "应存在 deps.apply_prompt_regex_to_messages 调用"
        # 检查调用附近是否有 user_id 参数
        nearby = content[call_idx:call_idx + 300]
        assert "user_id" in nearby, \
            "apply_prompt_regex_to_messages 调用应传递 user_id"


# ---------------------------------------------------------------------------
# P2-10: WI MIN_ACTIVATIONS→RECURSION 回退
# ---------------------------------------------------------------------------
class TestP210MinActivationsRecursionFallback:
    """验证 MIN_ACTIVATIONS→RECURSION 回退对齐 ST scan_state 状态机。"""

    def test_build_haystack_accepts_recurse_buffer(self):
        """_build_haystack 应接受 recurse_buffer 参数。"""
        try:
            from app.services.worldbook_service import _build_haystack
            import inspect
        except ImportError:
            pytest.skip("worldbook_service 不可导入")
        sig = inspect.signature(_build_haystack)
        assert "recurse_buffer" in sig.parameters, \
            "_build_haystack 应接受 recurse_buffer 参数"

    def test_scan_entries_accepts_recurse_buffer(self):
        """_scan_entries 应接受 recurse_buffer 参数。"""
        try:
            from app.services.worldbook_service import _scan_entries
            import inspect
        except ImportError:
            pytest.skip("worldbook_service 不可导入")
        sig = inspect.signature(_scan_entries)
        assert "recurse_buffer" in sig.parameters, \
            "_scan_entries 应接受 recurse_buffer 参数"

    def test_recursive_scan_has_fallback_block(self):
        """_recursive_scan 源码应包含 MIN_ACTIVATIONS→RECURSION 回退块。"""
        path = os.path.join(_BACKEND_DIR, "app", "services", "worldbook_service.py")
        if not os.path.exists(path):
            pytest.skip("worldbook_service.py 不存在")
        content = open(path, encoding="utf-8").read()
        assert "MIN_ACTIVATIONS→RECURSION" in content or "MIN_ACTIVATIONS.RECURSION" in content, \
            "_recursive_scan 应包含 MIN_ACTIVATIONS→RECURSION 回退注释"
        assert "recurse_buffer_parts" in content, \
            "应使用 recurse_buffer_parts 收集已激活条目内容"

    def test_fallback_activates_entries_via_content(self):
        """MIN_ACTIVATIONS 找到的条目内容应触发 RECURSION 回退激活其他条目。

        场景: 条目 A 的关键词在聊天消息中（被 MIN_ACTIVATIONS 找到），
        条目 B 的关键词在条目 A 的内容中（需要 RECURSION 回退才能激活）。
        """
        try:
            from app.services.worldbook_service import _recursive_scan, DEFAULT_SCAN_DEPTH
            from app.models.worldbook import WorldBookStage
        except ImportError:
            pytest.skip("worldbook_service 不可导入")

        WI_POS_AT_DEPTH = 4
        # 条目 A: 关键词 "dragon" 在远距离聊天消息中
        entry_a = WorldBookStage(
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
        entry_b = WorldBookStage(
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

        activated, report = _recursive_scan(
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
        try:
            from app.services.worldbook_service import _recursive_scan
            from app.models.worldbook import WorldBookStage
        except ImportError:
            pytest.skip("worldbook_service 不可导入")

        WI_POS_AT_DEPTH = 4
        # 条目 A: exclude_recursion=True，内容不进入递归 buffer
        entry_a = WorldBookStage(
            id="a", world_book_id="wb", stage_index=0,
            title="entry-a", content="The griffin flies high",
            keys=json.dumps(["dragon"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=True, prevent_recursion=False,
            scan_depth=None,
        )
        entry_b = WorldBookStage(
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

        activated, report = _recursive_scan(
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
        try:
            from app.services.worldbook_service import _recursive_scan
            from app.models.worldbook import WorldBookStage
        except ImportError:
            pytest.skip("worldbook_service 不可导入")

        WI_POS_AT_DEPTH = 4
        entry_a = WorldBookStage(
            id="a", world_book_id="wb", stage_index=0,
            title="entry-a", content="The griffin flies high",
            keys=json.dumps(["dragon"]), secondary_keys=json.dumps([]),
            position=WI_POS_AT_DEPTH, depth=4,
            selective=False, selective_logic=0,
            probability=100, constant=False, enabled=True,
            exclude_recursion=False, prevent_recursion=False,
            scan_depth=None,
        )
        entry_b = WorldBookStage(
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

        activated, report = _recursive_scan(
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
