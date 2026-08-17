"""P0 阻断性缺口修复契约测试。

覆盖审计报告（docs/st-plugin-compat-spec/backend-plugin-single-chat-audit.md）
中三个 P0 修复点：

- P0-1: SmartCardGenerateRequest 缺 extension_prompts 字段（character_ext.py）
- P0-2: /send 命令错误触发生成（slash_command_service.py + websocket.py + character_ext.py）
- P0-3: /gen 命令是存根（slash_command_service.py + websocket.py + character_ext.py）

测试方式：单元测试 + Pydantic schema 验证，不依赖真实 LLM 调用。
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api.character_ext import ExtensionPromptInput, SmartCardGenerateRequest  # noqa: E402
    from app.services.slash_command_service import (  # noqa: E402
        SlashCommandContext,
        SlashCommandResult,
        _cmd_gen,
        _cmd_send,
        execute_slash_command,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc


pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# Mock 构造工具
# ---------------------------------------------------------------------------
def _make_ctx(**overrides):
    """构造 SlashCommandContext mock，db 为 MagicMock。"""
    defaults = dict(
        db=MagicMock(),
        session_id="test-session-id",
        user_id=1,
        user_name="Tester",
        character=SimpleNamespace(name="Alice"),
        session=SimpleNamespace(chat_metadata="{}"),
        input_text="",
    )
    defaults.update(overrides)
    return SlashCommandContext(**defaults)


def _mock_active_branch(db):
    """让 _get_active_branch 返回 mock branch，避免 _cmd_send 走真实 DB。"""
    branch = SimpleNamespace(id="branch-1", session_id="test-session-id", is_active=True)
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.first.return_value = branch
    db.query.return_value = query
    return branch


# ---------------------------------------------------------------------------
# P0-1: SmartCardGenerateRequest.extension_prompts
# ---------------------------------------------------------------------------
class TestP01SmartCardExtensionPrompts:
    """验证 SmartCardGenerateRequest 接受 extension_prompts 字段并对齐 ST 四态枚举。"""

    def test_default_extension_prompts_is_empty_list(self):
        """默认值为空 list，不影响现有调用方。"""
        req = SmartCardGenerateRequest(
            character_id="c1",
            model="gpt-4",
        )
        assert req.extension_prompts == []

    def test_accepts_extension_prompts_field(self):
        """能从请求体接受 extension_prompts 字段（对齐 ST generateQuietPrompt）。"""
        req = SmartCardGenerateRequest(
            character_id="c1",
            model="gpt-4",
            mode="quiet",
            extension_prompts=[
                {
                    "identifier": "vectors",
                    "content": "injected text",
                    "position": 1,
                    "depth": 4,
                    "role": "system",
                }
            ],
        )
        assert len(req.extension_prompts) == 1
        ep = req.extension_prompts[0]
        assert isinstance(ep, ExtensionPromptInput)
        assert ep.identifier == "vectors"
        assert ep.content == "injected text"
        assert ep.position == 1
        assert ep.depth == 4
        assert ep.role == "system"

    def test_extension_prompts_preserve_st_position_enum(self):
        """ST 1.18.0 extension_prompt_types 四态：NONE(-1)/IN_PROMPT(0)/IN_CHAT(1)/BEFORE_PROMPT(2)。"""
        for position in (-1, 0, 1, 2):
            req = SmartCardGenerateRequest(
                character_id="c1",
                model="gpt-4",
                extension_prompts=[
                    {"identifier": f"p{position}", "position": position}
                ],
            )
            assert req.extension_prompts[0].position == position

    def test_extension_prompts_role_accepts_int_and_str(self):
        """ST extension_prompt_roles 0=SYSTEM/1=USER/2=ASSISTANT，支持 int 或 str。"""
        for role in (0, 1, 2, "system", "user", "assistant"):
            req = SmartCardGenerateRequest(
                character_id="c1",
                model="gpt-4",
                extension_prompts=[
                    {"identifier": f"r{role}", "role": role}
                ],
            )
            assert req.extension_prompts[0].role == role


# ---------------------------------------------------------------------------
# P0-2: /send 命令不触发生成
# ---------------------------------------------------------------------------
class TestP02SendNoGeneration:
    """验证 /send 仅写库不触发 AI 生成（对齐 ST slash-commands.js:1731）。"""

    def test_send_returns_send_to_chat_false(self):
        """_cmd_send 必须返回 send_to_chat=False，避免上游 _gen 触发生成。"""
        ctx = _make_ctx()
        _mock_active_branch(ctx.db)
        result = _cmd_send(["hello", "world"], ctx)
        assert result.send_to_chat is False, (
            "/send 必须返回 send_to_chat=False，否则上游 websocket.py:1688 会错误触发 _gen 生成"
        )

    def test_send_returns_extra_messages_with_already_persisted_flag(self):
        """extra_messages 包含用户消息内容 + _already_persisted 标记。"""
        ctx = _make_ctx()
        _mock_active_branch(ctx.db)
        result = _cmd_send(["hello"], ctx)
        assert len(result.extra_messages) == 1
        em = result.extra_messages[0]
        assert em["role"] == "user"
        assert em["content"] == "hello"
        assert em.get("_already_persisted") is True, (
            "_already_persisted 标记用于告知调用方不要重复保存（_cmd_send 已自行 commit）"
        )

    def test_send_empty_args_returns_usage_response(self):
        """无参数时返回 usage 提示，不写库不触发任何副作用。"""
        ctx = _make_ctx()
        result = _cmd_send([], ctx)
        assert result.send_to_chat is False
        assert "Usage" in (result.response or "")
        assert result.extra_messages == []
        ctx.db.add.assert_not_called()

    def test_send_persists_user_message_to_db(self):
        """_cmd_send 应通过 db.add + db.commit 把用户消息写入 DB。"""
        ctx = _make_ctx()
        _mock_active_branch(ctx.db)
        _cmd_send(["persisted message"], ctx)
        ctx.db.add.assert_called_once()
        added_obj = ctx.db.add.call_args[0][0]
        assert added_obj.role == "user"
        assert added_obj.content == "persisted message"
        assert added_obj.is_user is True
        ctx.db.commit.assert_called_once()

    def test_send_via_execute_slash_command(self):
        """通过 execute_slash_command 入口验证 /send 与 /say 别名都正确路由。"""
        ctx = _make_ctx()
        _mock_active_branch(ctx.db)
        for cmd in ("/send hello", "/say world"):
            ctx.input_text = cmd
            result = execute_slash_command(cmd, ctx)
            assert result.send_to_chat is False, f"命令 {cmd} 不应触发生成"
            assert result.gen_prompt is None, f"命令 {cmd} 不应设置 gen_prompt"


# ---------------------------------------------------------------------------
# P0-3: /gen 命令真实生成
# ---------------------------------------------------------------------------
class TestP03GenRealGeneration:
    """验证 /gen 解析 prompt 并通过 gen_prompt 触发 LLM 生成（对齐 ST slash-commands.js:2210）。"""

    def test_gen_returns_send_to_chat_false(self):
        """_cmd_gen 必须返回 send_to_chat=False（不进入 chat history 装配路径）。"""
        ctx = _make_ctx()
        result = _cmd_gen(["summarize", "this"], ctx)
        assert result.send_to_chat is False

    def test_gen_sets_gen_prompt_with_positional_args(self):
        """位置参数拼接为 prompt，设置 gen_prompt 字段。"""
        ctx = _make_ctx()
        result = _cmd_gen(["Tell", "me", "a", "joke"], ctx)
        assert result.gen_prompt == "Tell me a joke"
        assert result.response is None

    def test_gen_empty_args_returns_usage(self):
        """无参数时返回 usage 提示，不设置 gen_prompt。"""
        ctx = _make_ctx()
        result = _cmd_gen([], ctx)
        assert result.gen_prompt is None
        assert "Usage" in (result.response or "")

    def test_gen_parses_named_args_and_excludes_from_prompt(self):
        """named args（key=value）从 prompt 中排除（对齐 ST /gen as=character <prompt>）。"""
        ctx = _make_ctx()
        result = _cmd_gen(["as=character", "length=short", "write", "a", "poem"], ctx)
        assert result.gen_prompt == "write a poem"
        # named args 不出现在 prompt 中
        assert "as=" not in result.gen_prompt
        assert "length=" not in result.gen_prompt

    def test_gen_preserves_quoted_strings_with_equals(self):
        """带引号的参数（含 = 号）不当作 named arg 解析。"""
        ctx = _make_ctx()
        result = _cmd_gen(['"key=value"', "is", "valid"], ctx)
        assert result.gen_prompt == '"key=value" is valid'

    def test_gen_via_execute_slash_command(self):
        """通过 execute_slash_command 入口验证 /gen 与 /generate 别名。"""
        ctx = _make_ctx()
        for cmd in ("/gen hello", "/generate world"):
            ctx.input_text = cmd
            result = execute_slash_command(cmd, ctx)
            assert result.send_to_chat is False
            assert result.gen_prompt is not None
            assert result.gen_prompt in ("hello", "world")


# ---------------------------------------------------------------------------
# SlashCommandResult.gen_prompt 字段契约
# ---------------------------------------------------------------------------
class TestSlashCommandResultGenPromptField:
    """验证 SlashCommandResult.gen_prompt 字段默认值与序列化。"""

    def test_default_gen_prompt_is_none(self):
        """默认值为 None，不影响现有命令。"""
        result = SlashCommandResult()
        assert result.gen_prompt is None

    def test_gen_prompt_can_be_set(self):
        """可以设置 gen_prompt 字段。"""
        result = SlashCommandResult(gen_prompt="test prompt")
        assert result.gen_prompt == "test prompt"

    def test_existing_commands_have_none_gen_prompt(self):
        """现有命令（/continue /retry）不应设置 gen_prompt。"""
        from app.services.slash_command_service import _cmd_continue, _cmd_retry
        ctx = _make_ctx()
        # /continue 不需要参数
        cont_result = _cmd_continue([], ctx)
        assert cont_result.gen_prompt is None
        # /retry 不需要参数
        retry_result = _cmd_retry([], ctx)
        assert retry_result.gen_prompt is None
