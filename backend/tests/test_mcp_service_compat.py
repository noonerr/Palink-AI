"""MCP 服务层 2.x/1.x 字段兼容与连接治理回归（AUDIT-2026-09-25）。

背景：mcp 2.0.0 把 ``Tool.inputSchema`` 改名 ``input_schema``、
``CallToolResult.isError`` 改名 ``is_error``、``streamablehttp_client``
改名 ``streamable_http_client``。旧代码读错名 + hasattr 兜底造成两类
无声失败：所有工具以空 parameters 暴露给模型；工具真失败被当成功。
"""

import asyncio
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.services.mcp_service as mcp_service  # noqa: E402


class _ToolNew:
    """mcp 2.x 形状：input_schema。"""

    def __init__(self, schema):
        self.name = "add"
        self.description = "add two numbers"
        self.input_schema = schema


class _ToolOld:
    """mcp 1.x 形状：inputSchema。"""

    def __init__(self, schema):
        self.name = "add"
        self.description = "add two numbers"
        self.inputSchema = schema


class _ResultNewError:
    """mcp 2.x 形状：is_error。"""

    content = []
    is_error = True


class _ResultOldError:
    """mcp 1.x 形状：isError。"""

    content = []
    isError = True


class _ResultOk:
    content = []
    is_error = False


SCHEMA = {"type": "object", "properties": {"a": {"type": "number"}}}


class TestToolInputSchema:
    def test_reads_renamed_2x_field(self):
        assert mcp_service._tool_input_schema(_ToolNew(SCHEMA)) == SCHEMA

    def test_falls_back_to_1x_field(self):
        assert mcp_service._tool_input_schema(_ToolOld(SCHEMA)) == SCHEMA

    def test_neither_field_returns_empty_dict(self):
        assert mcp_service._tool_input_schema(object()) == {}


class TestToolIsError:
    def test_reads_renamed_2x_field(self):
        assert mcp_service._tool_is_error(_ResultNewError()) is True

    def test_falls_back_to_1x_field(self):
        assert mcp_service._tool_is_error(_ResultOldError()) is True

    def test_success_is_false(self):
        assert mcp_service._tool_is_error(_ResultOk()) is False

    def test_neither_field_defaults_to_false(self):
        assert mcp_service._tool_is_error(object()) is False


class TestNormalizeTransportType:
    @pytest.mark.parametrize("raw,expected", [
        ("stdio", "stdio"),
        ("sse", "sse"),
        ("streamable-http", "streamable-http"),
        ("streamable_http", "streamable-http"),
        ("http", "streamable-http"),
        ("STDIO", "stdio"),
    ])
    def test_known_values(self, raw, expected):
        assert mcp_service._normalize_transport_type(raw) == expected

    @pytest.mark.parametrize("raw", ["websocket", "grpc", "nonsense"])
    def test_unknown_value_raises_instead_of_silent_sse(self, raw):
        with pytest.raises(ValueError, match="Unsupported MCP transport type"):
            mcp_service._normalize_transport_type(raw)


class TestOperationTimeout:
    def test_call_tool_times_out(self, monkeypatch):
        """挂死的 MCP server 不再无限期占住生成流（对齐前端插件 60s）。"""

        class _HangingSession:
            async def call_tool(self, *args, **kwargs):
                await asyncio.sleep(10)

        monkeypatch.setattr(mcp_service, "MCP_OPERATION_TIMEOUT_SECONDS", 0.05)
        mcp_service._active_connections["timeout-srv"] = {
            "session": _HangingSession(),
            "config": {"id": "timeout-srv", "name": "timeout-srv"},
        }
        try:
            with pytest.raises(TimeoutError, match="call_tool timed out"):
                asyncio.run(mcp_service.call_server_tool("timeout-srv", "add", {}))
        finally:
            mcp_service._active_connections.pop("timeout-srv", None)


class TestDisconnectAll:
    def test_closes_every_connection_and_clears_registry(self):
        closed = []

        class _Stack:
            async def aclose(self):
                closed.append(True)

        mcp_service._active_connections["srv-a"] = {"exit_stack": _Stack(), "config": {}}
        mcp_service._active_connections["srv-b"] = {"exit_stack": _Stack(), "config": {}}
        mcp_service._connection_errors["srv-a"] = "stale"
        try:
            count = asyncio.run(mcp_service.disconnect_all_servers())
            assert count == 2
            assert closed == [True, True]
            assert mcp_service._active_connections == {}
            assert "srv-a" not in mcp_service._connection_errors
        finally:
            mcp_service._active_connections.clear()


class TestListServerToolsSchema:
    def test_2x_tool_exposes_real_schema(self, monkeypatch):
        """端到端：list_server_tools 产出的工具不再是无参数黑盒。"""

        class _FakeSession:
            async def list_tools(self):
                class _Result:
                    tools = [_ToolNew(SCHEMA)]
                return _Result()

        monkeypatch.setitem(
            mcp_service._active_connections,
            "schema-srv",
            {"session": _FakeSession(), "config": {"id": "schema-srv", "name": "schema-srv"}},
        )
        try:
            tools = asyncio.run(mcp_service.list_server_tools("schema-srv"))
            assert tools[0]["inputSchema"] == SCHEMA
            assert tools[0]["description"] == "add two numbers"
        finally:
            mcp_service._active_connections.pop("schema-srv", None)
