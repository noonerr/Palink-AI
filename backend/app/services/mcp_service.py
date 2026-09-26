import asyncio
import logging
import json
import os
import ipaddress
import socket
import uuid
import hashlib
import re
from datetime import datetime, timezone
from contextlib import AsyncExitStack
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

MCP_CONFIG_FILE = "mcp_servers.json"
# [AUDIT-2026-09-25] 连接/列工具/调用此前全无超时：一个挂死的 MCP server
# 会无限期挂住整条生成流。对齐前端插件路径的 60s。
MCP_OPERATION_TIMEOUT_SECONDS = 60.0
SUPPORTED_TRANSPORT_TYPES = {"stdio", "sse", "streamable-http"}
LOBE_MCP_API = "https://mcp.lobehub.com/api/mcp"
MCP_REGISTRY_API = "https://registry.modelcontextprotocol.io"

ALLOWED_ENV_KEYS = {
    "API_KEY", "MODEL_NAME", "BASE_URL",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "PORT", "HOST", "DEBUG", "LOG_LEVEL",
    "TEMPERATURE", "MAX_TOKENS",
}

ALLOWED_MCP_COMMANDS = {
    "npx", "node", "python", "python3", "uvx", "uv",
}

ALLOWED_COMMAND_PATH_PREFIXES = (
    "/usr/local/bin/",
    "/usr/bin/",
    "/opt/",
)

_active_connections: dict = {}
_connection_errors: dict[str, str] = {}
_tool_name_registry: dict[str, tuple[str, str]] = {}
_tool_name_reverse_registry: dict[tuple[str, str], str] = {}
_OPENAI_TOOL_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")
_OPENAI_TOOL_NAME_MAX_LENGTH = 64
# [AUDIT-2026-09-25] _active_connections 此前无锁：两个并发 ensure 对同一 server
# 都走 check-then-act，后连上者会覆盖前者的 session，前者的 exit_stack（stdio
# 子进程）泄漏成孤儿。所有连接态变更都必须持锁。
_connection_lock = asyncio.Lock()


async def _await_with_timeout(awaitable, what: str):
    try:
        return await asyncio.wait_for(awaitable, timeout=MCP_OPERATION_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise TimeoutError(f"MCP {what} timed out after {int(MCP_OPERATION_TIMEOUT_SECONDS)}s") from exc


def _tool_input_schema(tool) -> dict:
    """mcp 2.x 把 ``Tool.inputSchema`` 改名为 ``input_schema``。

    旧代码只读旧名 + ``hasattr`` 兜底，读不到就静默用空 dict——所有 MCP 工具
    都以「无参数说明书」的形态暴露给模型（实测确证的无声失败）。两个名字都
    按序探测，兼容 1.x / 2.x。
    """
    for attr in ("input_schema", "inputSchema"):
        value = getattr(tool, attr, None)
        if value:
            return value
    return {}


def _tool_is_error(result) -> bool:
    """mcp 2.x 把 ``CallToolResult.isError`` 改名为 ``is_error``。

    同类无声失败：旧代码读不到一律当成功，工具真失败时模型会把错误文本
    当事实继续编。返回 True 表示服务端明确报错。
    """
    for attr in ("is_error", "isError"):
        value = getattr(result, attr, None)
        if value is not None:
            return bool(value)
    return False


def _normalize_transport_type(raw: str) -> str:
    """传输类型归一化。此前任意未知值都会静默落到 SSE 分支。"""
    value = (raw or "sse").strip().lower().replace("_", "-")
    if value in {"streamable-http", "streamablehttp", "http", "streamable http"}:
        return "streamable-http"
    if value not in SUPPORTED_TRANSPORT_TYPES:
        raise ValueError(
            f"Unsupported MCP transport type: {raw!r} (supported: stdio / sse / streamable-http)"
        )
    return value


def _safe_tool_name_fragment(value: str, fallback: str) -> str:
    safe = _OPENAI_TOOL_NAME_RE.sub("_", value or "").strip("_")
    return safe or fallback


def _build_openai_tool_name(server_id: str, actual_tool_name: str, digest_length: int = 12) -> str:
    digest = hashlib.sha1(f"{server_id}\0{actual_tool_name}".encode("utf-8")).hexdigest()[:digest_length]
    server_part = _safe_tool_name_fragment(server_id, "server")[:8].strip("_-") or "server"
    tool_part = _safe_tool_name_fragment(actual_tool_name, "tool")

    prefix = f"mcp_{server_part}_"
    suffix = f"_{digest}"
    max_tool_length = _OPENAI_TOOL_NAME_MAX_LENGTH - len(prefix) - len(suffix)
    if max_tool_length < 1:
        prefix = "mcp_"
        max_tool_length = _OPENAI_TOOL_NAME_MAX_LENGTH - len(prefix) - len(suffix)

    truncated_tool = tool_part[:max_tool_length].rstrip("_-") or "tool"
    return f"{prefix}{truncated_tool}{suffix}"


def _register_openai_tool_name(server_id: str, actual_tool_name: str) -> str:
    mapping_key = (server_id, actual_tool_name)
    existing_name = _tool_name_reverse_registry.get(mapping_key)
    if existing_name and _tool_name_registry.get(existing_name) == mapping_key:
        return existing_name

    digest = hashlib.sha1(f"{server_id}\0{actual_tool_name}".encode("utf-8")).hexdigest()
    for digest_length in (12, 16, 20, 24, 32, 40):
        candidate = _build_openai_tool_name(server_id, actual_tool_name, digest_length)
        owner = _tool_name_registry.get(candidate)
        if owner is None or owner == mapping_key:
            _tool_name_registry[candidate] = mapping_key
            _tool_name_reverse_registry[mapping_key] = candidate
            return candidate

    candidate = f"mcp_{digest[:60]}"
    owner = _tool_name_registry.get(candidate)
    if owner is not None and owner != mapping_key:
        raise RuntimeError(f"MCP tool name collision for {server_id}:{actual_tool_name}")
    _tool_name_registry[candidate] = mapping_key
    _tool_name_reverse_registry[mapping_key] = candidate
    return candidate


def _resolve_legacy_tool_name(tool_name: str) -> Optional[tuple[str, str]]:
    parts = tool_name.split("__", 2)
    if len(parts) == 3 and parts[0] == "mcp":
        return parts[1], parts[2]
    return None


def _allow_private_urls_in_development() -> bool:
    try:
        from ..utils import allow_internal_service_urls
        return allow_internal_service_urls()
    except Exception:
        return False


def _import_mcp_client_session():
    try:
        from mcp.client.session import ClientSession
        return ClientSession
    except ModuleNotFoundError:
        from mcp import ClientSession
        return ClientSession


def _import_mcp_stdio():
    try:
        from mcp.client.stdio import stdio_client, StdioServerParameters
    except ModuleNotFoundError:
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client
    return stdio_client, StdioServerParameters


def _is_safe_mcp_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    if _allow_private_urls_in_development():
        return True
    lowered = host.lower()
    if lowered in {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::]", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"} or lowered.endswith(".local"):
        return False

    def _is_private_ip(ip_str: str) -> bool:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
            return ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved or ip_obj.is_unspecified
        except ValueError:
            return False

    if _is_private_ip(host):
        return False
    try:
        addr_info = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    for info in addr_info:
        if _is_private_ip(info[4][0]):
            return False
    return True


def _validate_mcp_command(command: str) -> bool:
    base_name = os.path.basename(command)
    stem, ext = os.path.splitext(base_name)
    if base_name in ALLOWED_MCP_COMMANDS or (stem in ALLOWED_MCP_COMMANDS and ext.lower() in {".exe", ".cmd", ".bat"}):
        return True
    if os.path.isabs(command):
        for prefix in ALLOWED_COMMAND_PATH_PREFIXES:
            if command.startswith(prefix):
                return True
        try:
            project_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
            if command.startswith(project_dir + os.sep):
                return True
        except Exception:
            pass
    return False


def _validate_mcp_cwd(cwd: str) -> bool:
    if not cwd:
        return True
    try:
        real_cwd = os.path.realpath(cwd)
    except Exception:
        return False
    normalized = os.path.normpath(real_cwd)
    if ".." in normalized.split(os.sep):
        return False
    if real_cwd != normalized:
        return False
    return True


def _config_path() -> str:
    from ..core.config import settings
    return os.path.join(settings.DATA_DIR, MCP_CONFIG_FILE)


def get_mcp_servers() -> list:
    path = _config_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("servers", [])
        except Exception:
            pass
    return []


def save_mcp_servers(servers: list) -> None:
    path = _config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"servers": servers}, f, ensure_ascii=False, indent=2)


def add_server(server_data: dict) -> dict:
    servers = get_mcp_servers()
    entry = {
        "id": server_data.get("id") or str(uuid.uuid4()),
        "name": server_data.get("name", ""),
        "description": server_data.get("description", ""),
        "type": server_data.get("type", "sse"),
        "url": server_data.get("url", ""),
        "command": server_data.get("command", ""),
        "args": server_data.get("args", []),
        "cwd": server_data.get("cwd", ""),
        "env": server_data.get("env", {}),
        "headers": server_data.get("headers", {}),
        "enabled": server_data.get("enabled", True),
        "identifier": server_data.get("identifier", ""),
        "author": server_data.get("author", ""),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    servers.append(entry)
    save_mcp_servers(servers)
    return entry


def update_server(server_id: str, updates: dict) -> Optional[dict]:
    servers = get_mcp_servers()
    for server in servers:
        if server.get("id") == server_id:
            allowed_keys = {"name", "description", "type", "url", "command", "args", "cwd", "env", "headers", "enabled", "identifier", "author"}
            for key in allowed_keys:
                if key in updates:
                    server[key] = updates[key]
            save_mcp_servers(servers)
            return server
    return None


def remove_server(server_id: str) -> Optional[dict]:
    servers = get_mcp_servers()
    for i, server in enumerate(servers):
        if server.get("id") == server_id:
            removed = servers.pop(i)
            save_mcp_servers(servers)
            return removed
    return None


async def _enter_streamable_http_transport(exit_stack: AsyncExitStack, url: str, headers: dict):
    """建立 streamable-http 传输并返回 (read_stream, write_stream)。

    mcp 2.0.0 把 ``streamablehttp_client`` 改名为 ``streamable_http_client``
    （旧名 ImportError，配了即崩），且 headers 不再作函数参数、改经
    ``http_client`` 传入。两代签名在这里收敛，任一版本可用。
    """
    try:
        from mcp.client.streamable_http import streamable_http_client as connect_v2
    except ImportError:
        from mcp.client.streamable_http import streamablehttp_client as connect_v1
        transport = await exit_stack.enter_async_context(connect_v1(url, headers=headers))
        return transport[0], transport[1]

    if headers:
        from mcp.client.streamable_http import create_mcp_http_client
        http_client = create_mcp_http_client(headers=headers)
        await exit_stack.enter_async_context(http_client)
        transport = await exit_stack.enter_async_context(connect_v2(url, http_client=http_client))
    else:
        transport = await exit_stack.enter_async_context(connect_v2(url))
    return transport[0], transport[1]


async def connect_server(server: dict) -> dict:
    async with _connection_lock:
        return await _connect_server_locked(server)


async def _connect_server_locked(server: dict) -> dict:
    server_id = server.get("id")
    transport_type = _normalize_transport_type(server.get("type", "sse"))
    url = server.get("url", "")
    headers = server.get("headers", {}) or {}

    if server_id in _active_connections:
        await _disconnect_server_locked(server_id)

    if transport_type == "stdio":
        return await _connect_stdio(server)

    if url and not _is_safe_mcp_url(url):
        raise ValueError(f"MCP server URL blocked (SSRF protection): {url}")

    exit_stack = AsyncExitStack()
    try:
        ClientSession = _import_mcp_client_session()
        if transport_type == "streamable-http":
            read_stream, write_stream = await _enter_streamable_http_transport(exit_stack, url, headers)
        else:
            from mcp.client.sse import sse_client
            transport = await exit_stack.enter_async_context(
                sse_client(url, headers=headers)
            )
            read_stream, write_stream = transport[0], transport[1]

        session = await exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await _await_with_timeout(session.initialize(), "initialize")

        _active_connections[server_id] = {
            "session": session,
            "exit_stack": exit_stack,
            "config": server,
        }
        _connection_errors.pop(server_id, None)
        logger.info(f"MCP server connected: {server.get('name', server_id)}")
        return {"status": "connected", "server_id": server_id}
    except Exception as e:
        try:
            await exit_stack.aclose()
        except Exception:
            pass
        _connection_errors[server_id] = str(e)
        logger.error(f"Failed to connect MCP server {server_id}: {e}")
        raise


async def _connect_stdio(server: dict) -> dict:
    server_id = server.get("id")
    command = server.get("command", "")
    args = server.get("args", [])
    env = server.get("env", {})
    cwd = server.get("cwd", "")

    if not command:
        raise ValueError("stdio server requires 'command' field")

    if not _validate_mcp_command(command):
        logger.warning(f"MCP stdio command blocked by security policy: {command}")
        raise ValueError(f"Command not allowed by security policy: {command}")

    if cwd and not _validate_mcp_cwd(cwd):
        logger.warning(f"MCP stdio cwd blocked by security policy: {cwd}")
        raise ValueError(f"Working directory not allowed by security policy: {cwd}")

    filtered_env = {k: v for k, v in env.items() if k in ALLOWED_ENV_KEYS}
    process_env = {**os.environ, **filtered_env}

    exit_stack = AsyncExitStack()
    try:
        ClientSession = _import_mcp_client_session()
        stdio_client, StdioServerParameters = _import_mcp_stdio()

        server_params = StdioServerParameters(
            command=command,
            args=args,
            env=process_env if env else None,
            cwd=cwd or None,
        )

        transport = await exit_stack.enter_async_context(stdio_client(server_params))
        read_stream, write_stream = transport[0], transport[1]

        session = await exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await _await_with_timeout(session.initialize(), "initialize")

        _active_connections[server_id] = {
            "session": session,
            "exit_stack": exit_stack,
            "config": server,
        }
        _connection_errors.pop(server_id, None)
        logger.info(f"MCP stdio server connected: {server.get('name', server_id)}")
        return {"status": "connected", "server_id": server_id}
    except Exception as e:
        try:
            await exit_stack.aclose()
        except Exception:
            pass
        _connection_errors[server_id] = str(e)
        logger.error(f"Failed to connect MCP stdio server {server_id}: {e}")
        raise


async def disconnect_server(server_id: str) -> dict:
    async with _connection_lock:
        return await _disconnect_server_locked(server_id)


async def _disconnect_server_locked(server_id: str) -> dict:
    conn = _active_connections.pop(server_id, None)
    _connection_errors.pop(server_id, None)
    if conn:
        try:
            await conn["exit_stack"].aclose()
            logger.info(f"MCP server disconnected: {server_id}")
        except Exception as e:
            logger.error(f"Error disconnecting MCP server {server_id}: {e}")
        return {"status": "disconnected", "server_id": server_id}
    return {"status": "not_found", "server_id": server_id}


async def disconnect_all_servers() -> int:
    """断开全部 MCP 连接（应用关闭时调用）。

    此前无任何清理钩子：stdio 型 MCP server 的子进程会随连接常驻，
    后端重启也不回收。
    """
    async with _connection_lock:
        count = 0
        for server_id in list(_active_connections.keys()):
            try:
                await _disconnect_server_locked(server_id)
                count += 1
            except Exception:
                logger.exception("Failed to disconnect MCP server %s on shutdown", server_id)
        return count


async def list_server_tools(server_id: str) -> list:
    conn = _active_connections.get(server_id)
    if not conn:
        raise ValueError(f"MCP server not connected: {server_id}")
    session = conn["session"]
    server_name = conn["config"].get("name", server_id)

    result = await _await_with_timeout(session.list_tools(), "list_tools")
    tools = []
    for tool in result.tools:
        openai_name = _register_openai_tool_name(server_id, tool.name)
        tools.append({
            "type": "mcp",
            "identifier": f"{server_id}__{tool.name}",
            "serverId": server_id,
            "serverName": server_name,
            "name": tool.name,
            "openaiName": openai_name,
            "description": getattr(tool, "description", "") or "",
            "inputSchema": _tool_input_schema(tool),
        })
    return tools


async def ensure_server_connected(server: dict) -> bool:
    server_id = server.get("id")
    if not server_id:
        return False
    async with _connection_lock:
        if server_id in _active_connections:
            return True
        try:
            await _connect_server_locked(server)
            return True
        except Exception as e:
            _connection_errors[server_id] = str(e)
            logger.warning("MCP server %s is enabled but could not connect: %s", server_id, e)
            return False


async def call_server_tool(server_id: str, tool_name: str, args: dict = None) -> dict:
    conn = _active_connections.get(server_id)
    if not conn:
        raise ValueError(f"MCP server not connected: {server_id}")
    session = conn["session"]
    result = await _await_with_timeout(session.call_tool(tool_name, arguments=args or {}), "call_tool")

    content_parts = []
    for item in result.content:
        if hasattr(item, "text"):
            content_parts.append(item.text)
        elif hasattr(item, "data"):
            content_parts.append(f"[image: {getattr(item, 'mimeType', 'unknown')}]")
        elif hasattr(item, "resource"):
            content_parts.append(str(item.resource))

    return {
        "content": "\n".join(content_parts),
        "isError": _tool_is_error(result),
    }


async def get_all_tools_openai_format() -> list:
    servers = get_mcp_servers()
    all_tools = []
    for server in servers:
        if not server.get("enabled", True):
            continue
        server_id = server.get("id")
        if not await ensure_server_connected(server):
            continue
        try:
            mcp_tools = await list_server_tools(server_id)
            for tool in mcp_tools:
                openai_name = tool.get("openaiName") or _register_openai_tool_name(server_id, tool["name"])
                openai_tool = {
                    "type": "function",
                    "function": {
                        "name": openai_name,
                        "description": tool["description"],
                        "parameters": tool.get("inputSchema", {}),
                    }
                }
                all_tools.append(openai_tool)
        except Exception as e:
            _connection_errors[server_id] = str(e)
            logger.error(f"Failed to get tools from server {server_id}: {e}")
    return all_tools


async def execute_tool_call(tool_name: str, arguments: dict) -> dict:
    resolved = _tool_name_registry.get(tool_name) or _resolve_legacy_tool_name(tool_name)
    if not resolved:
        raise ValueError(f"Invalid MCP tool name format: {tool_name}")

    server_id, actual_tool_name = resolved

    if server_id not in _active_connections:
        config = None
        for s in get_mcp_servers():
            if s.get("id") == server_id:
                config = s
                break
        if not config:
            raise ValueError(f"MCP server not found: {server_id}")
        if not await ensure_server_connected(config):
            raise ValueError(
                f"MCP server failed to connect: {server_id} "
                f"({_connection_errors.get(server_id, 'unknown error')})"
            )

    return await call_server_tool(server_id, actual_tool_name, arguments)


def is_connected(server_id: str) -> bool:
    return server_id in _active_connections


def get_connected_ids() -> list:
    return list(_active_connections.keys())


def get_connection_errors() -> dict:
    return dict(_connection_errors)


async def search_marketplace(query: str, limit: int = 20) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{LOBE_MCP_API}/search", params={"q": query, "limit": limit})
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.error(f"LobeHub marketplace search failed: {e}")
        return {"items": [], "error": str(e)}


async def get_marketplace_detail(identifier: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{LOBE_MCP_API}/plugins/{identifier}")
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.error(f"LobeHub marketplace detail failed: {e}")
        return {"error": str(e)}


async def list_marketplace(category: str = "", cursor: str = "", limit: int = 20) -> dict:
    try:
        params = {"limit": limit}
        if category:
            params["category"] = category
        if cursor:
            params["cursor"] = cursor
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{LOBE_MCP_API}/list", params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.error(f"LobeHub marketplace list failed: {e}")
        return {"items": [], "error": str(e)}
