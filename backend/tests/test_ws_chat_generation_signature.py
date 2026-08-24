"""WS 普通聊天路径 run_chat_generation 签名回归测试。

spec: docs/SPEC_修复验证与系统检查_2026-08-24.md §6.2（N-2）
缺陷: run_chat_generation 签名缺 ``reasoning_effort``/``provider_id`` 两形参，
但函数体 stream_text_completion 调用直接引用 → 每次 WS 普通聊天
(/api/ws/chat chat_request) 到达即抛 NameError，被外层 except 吞掉后客户端收
"Error: Internal error"，整条 WS 普通聊天生成路径不可用。

守卫语义:
1. 签名含两形参且默认 None（对齐 run_character_chat_generation）
2. 最小化 mock 流跑通全函数：无 NameError，且两值原样透传到
   stream_text_completion 调用参数
"""

import asyncio
import inspect
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import websocket as ws_module
    from app.api.websocket import run_chat_generation, run_character_chat_generation
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestRunChatGenerationSignature:
    """N-2 守卫：签名必须包含 reasoning_effort / provider_id 两形参。"""

    def test_signature_has_reasoning_effort_default_none(self):
        params = inspect.signature(run_chat_generation).parameters
        assert "reasoning_effort" in params
        assert params["reasoning_effort"].default is None

    def test_signature_has_provider_id_default_none(self):
        params = inspect.signature(run_chat_generation).parameters
        assert "provider_id" in params
        assert params["provider_id"].default is None

    def test_parity_with_character_chat_generation(self):
        # 与角色扮演侧 run_character_chat_generation 的对应形参语义一致
        params = inspect.signature(run_chat_generation).parameters
        char_params = inspect.signature(run_character_chat_generation).parameters
        for name in ("reasoning_effort", "provider_id"):
            assert params[name].default == char_params[name].default


class TestRunChatGenerationMockFlow:
    """最小化 mock 流验证：两形参透传到 stream_text_completion 且全程无 NameError。"""

    def _run(self):
        captured_kwargs = {}

        def _fake_stream_factory(**kwargs):
            captured_kwargs.update(kwargs)

            async def _gen():
                yield {"content": "你好"}

            return _gen()

        origins = {
            "stream": ws_module.stream_text_completion,
            "db": ws_module.SessionLocal,
            "ws": ws_module.ws_manager,
            "tools": ws_module.get_all_tools_openai_format,
        }
        mock_db = MagicMock(name="save_db")
        mock_db.query.return_value.filter.return_value.first.return_value = None

        async def _no_tools():
            return []

        try:
            ws_module.stream_text_completion = _fake_stream_factory
            ws_module.SessionLocal = lambda: mock_db
            ws_module.ws_manager = SimpleNamespace(
                send_chunk=AsyncMock(),
                send_done=AsyncMock(),
                send_error=AsyncMock(),
                broadcast_to_session=AsyncMock(),
            )
            ws_module.get_all_tools_openai_format = _no_tools

            async def _scenario():
                await run_chat_generation(
                    ss=None,
                    session_id="s-n2",
                    user_id=1,
                    messages=[{"role": "user", "content": "hi"}],
                    model="test-model",
                    is_new_session=True,
                    web_search_results=[],
                    web_search_query="hi",
                    memory_mode="disabled",
                    user_message="hi",
                    enable_tools=False,
                    user_message_id=None,
                    reasoning_effort="medium",
                    provider_id="prov-1",
                )

            asyncio.run(_scenario())
        finally:
            ws_module.stream_text_completion = origins["stream"]
            ws_module.SessionLocal = origins["db"]
            ws_module.ws_manager = origins["ws"]
            ws_module.get_all_tools_openai_format = origins["tools"]

        return captured_kwargs

    def test_no_name_error_and_params_forwarded(self):
        captured = self._run()
        # 全函数跑完无 NameError，正文正常累积（此前在首个 stream_text_completion
        # 调用处即抛 NameError 被吞为 "Error: Internal error"）
        # 两新形参原样透传给底层流式调用
        assert captured.get("reasoning_effort") == "medium"
        assert captured.get("provider_id") == "prov-1"
