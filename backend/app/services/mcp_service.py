import logging
import json
import os
import uuid
from datetime import datetime, timezone
from contextlib import AsyncExitStack
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

MCP_CONFIG_FILE = "mcp_servers.json"
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
    "docker", "pip", "pip3",
}

ALLOWED_COMMAND_PATH_PREFIXES = (
    "/usr/local/bin/",
    "/usr/bin/",
    "/opt/",
)

_active_connections: dict = {}


def _validate_mcp_command(command: str) -> bool:
    base_name = os.path.basename(command)
    if base_name in ALLOWED_MCP_COMMANDS:
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


async def connect_server(server: dict) -> dict:
    server_id = server.get("id")
    transport_type = server.get("type", "sse")
    url = server.get("url", "")
    headers = server.get("headers", {}) or {}

    if server_id in _active_connections:
        await disconnect_server(server_id)

    if transport_type == "stdio":
        return await _connect_stdio(server)

    exit_stack = AsyncExitStack()
    try:
        from mcp.client.session import ClientSession
        if transport_type == "streamable-http":
            from mcp.client.streamable_http import streamablehttp_client
            transport = await exit_stack.enter_async_context(
                streamablehttp_client(url, headers=headers)
            )
            read_stream, write_stream = transport[0], transport[1]
        else:
            from mcp.client.sse import sse_client
            transport = await exit_stack.enter_async_context(
                sse_client(url, headers=headers)
            )
            read_stream, write_stream = transport[0], transport[1]

        session = await exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        _active_connections[server_id] = {
            "session": session,
            "exit_stack": exit_stack,
            "config": server,
        }
        logger.info(f"MCP server connected: {server.get('name', server_id)}")
        return {"status": "connected", "server_id": server_id}
    except Exception as e:
        try:
            await exit_stack.aclose()
        except Exception:
            pass
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
        from mcp.client.session import ClientSession
        from mcp.client.stdio import stdio_client, StdioServerParameters

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
        await session.initialize()

        _active_connections[server_id] = {
            "session": session,
            "exit_stack": exit_stack,
            "config": server,
        }
        logger.info(f"MCP stdio server connected: {server.get('name', server_id)}")
        return {"status": "connected", "server_id": server_id}
    except Exception as e:
        try:
            await exit_stack.aclose()
        except Exception:
            pass
        logger.error(f"Failed to connect MCP stdio server {server_id}: {e}")
        raise


async def disconnect_server(server_id: str) -> dict:
    conn = _active_connections.pop(server_id, None)
    if conn:
        try:
            await conn["exit_stack"].aclose()
            logger.info(f"MCP server disconnected: {server_id}")
        except Exception as e:
            logger.error(f"Error disconnecting MCP server {server_id}: {e}")
        return {"status": "disconnected", "server_id": server_id}
    return {"status": "not_found", "server_id": server_id}


async def list_server_tools(server_id: str) -> list:
    conn = _active_connections.get(server_id)
    if not conn:
        raise ValueError(f"MCP server not connected: {server_id}")
    session = conn["session"]
    server_name = conn["config"].get("name", server_id)

    result = await session.list_tools()
    tools = []
    for tool in result.tools:
        tools.append({
            "type": "mcp",
            "identifier": f"{server_id}__{tool.name}",
            "serverId": server_id,
            "serverName": server_name,
            "name": tool.name,
            "description": tool.description or "",
            "inputSchema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
        })
    return tools


async def call_server_tool(server_id: str, tool_name: str, args: dict = None) -> dict:
    conn = _active_connections.get(server_id)
    if not conn:
        raise ValueError(f"MCP server not connected: {server_id}")
    session = conn["session"]
    result = await session.call_tool(tool_name, arguments=args or {})

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
        "isError": result.isError if hasattr(result, "isError") else False,
    }


async def get_all_tools_openai_format() -> list:
    servers = get_mcp_servers()
    all_tools = []
    for server in servers:
        if not server.get("enabled", True):
            continue
        server_id = server.get("id")
        if server_id not in _active_connections:
            continue
        try:
            mcp_tools = await list_server_tools(server_id)
            for tool in mcp_tools:
                openai_tool = {
                    "type": "function",
                    "function": {
                        "name": f"mcp__{server_id}__{tool['name']}",
                        "description": tool["description"],
                        "parameters": tool.get("inputSchema", {}),
                    }
                }
                all_tools.append(openai_tool)
        except Exception as e:
            logger.error(f"Failed to get tools from server {server_id}: {e}")
    return all_tools


async def execute_tool_call(tool_name: str, arguments: dict) -> dict:
    parts = tool_name.split("__")
    if len(parts) != 3 or parts[0] != "mcp":
        raise ValueError(f"Invalid MCP tool name format: {tool_name}")

    server_id = parts[1]
    actual_tool_name = parts[2]

    if server_id not in _active_connections:
        config = None
        for s in get_mcp_servers():
            if s.get("id") == server_id:
                config = s
                break
        if config:
            await connect_server(config)
        else:
            raise ValueError(f"MCP server not found: {server_id}")

    return await call_server_tool(server_id, actual_tool_name, arguments)


def is_connected(server_id: str) -> bool:
    return server_id in _active_connections


def get_connected_ids() -> list:
    return list(_active_connections.keys())


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
