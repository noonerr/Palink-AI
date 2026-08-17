from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, List

from ..api.dependencies import get_admin
from ..models import User
from ..services.mcp_service import (
    get_mcp_servers, add_server, update_server, remove_server,
    connect_server, disconnect_server, list_server_tools,
    is_connected, get_connected_ids,
    search_marketplace, get_marketplace_detail, list_marketplace,
)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class MCPServerCreate(BaseModel):
    name: str
    description: str = ""
    type: str = "sse"
    url: str = ""
    command: str = ""
    args: List[str] = []
    cwd: str = ""
    env: Dict[str, str] = {}
    headers: Dict[str, str] = {}
    enabled: bool = True
    identifier: str = ""
    author: str = ""


class MCPServerUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    cwd: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    headers: Optional[Dict[str, str]] = None
    enabled: Optional[bool] = None
    identifier: Optional[str] = None
    author: Optional[str] = None


@router.get("/marketplace/search")
async def search_mcp_marketplace(query: str = "", limit: int = 20, user: User = Depends(get_admin)):
    return await search_marketplace(query, limit)


@router.get("/marketplace/list")
async def list_mcp_marketplace(category: str = "", cursor: str = "", limit: int = 20, user: User = Depends(get_admin)):
    return await list_marketplace(category, cursor, limit)


@router.get("/marketplace/{identifier}")
async def get_mcp_marketplace_detail(identifier: str, user: User = Depends(get_admin)):
    result = await get_marketplace_detail(identifier)
    if "error" in result and "name" not in result:
        raise HTTPException(status_code=404, detail=result.get("error", "Not found"))
    return result


@router.get("/servers")
async def get_servers(user: User = Depends(get_admin)):
    servers = get_mcp_servers()
    for s in servers:
        s["status"] = "connected" if is_connected(s.get("id", "")) else "disconnected"
    return {"servers": servers}


@router.post("/servers")
async def create_server(req: MCPServerCreate, user: User = Depends(get_admin)):
    entry = add_server(req.model_dump())
    return entry


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str, user: User = Depends(get_admin)):
    try:
        await disconnect_server(server_id)
    except Exception:
        pass
    removed = remove_server(server_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Server not found")
    return removed


@router.patch("/servers/{server_id}")
async def patch_server(server_id: str, req: MCPServerUpdate, user: User = Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updated = update_server(server_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Server not found")
    if "enabled" in updates:
        if updates["enabled"]:
            try:
                await connect_server(updated)
            except Exception:
                pass
        else:
            try:
                await disconnect_server(server_id)
            except Exception:
                pass
    return updated


@router.post("/servers/{server_id}/connect")
async def connect_mcp_server(server_id: str, user: User = Depends(get_admin)):
    servers = get_mcp_servers()
    server = next((s for s in servers if s.get("id") == server_id), None)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    try:
        result = await connect_server(server)
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/servers/{server_id}/disconnect")
async def disconnect_mcp_server(server_id: str, user: User = Depends(get_admin)):
    return await disconnect_server(server_id)


@router.get("/servers/{server_id}/tools")
async def get_server_tools(server_id: str, user: User = Depends(get_admin)):
    if not is_connected(server_id):
        servers = get_mcp_servers()
        server = next((s for s in servers if s.get("id") == server_id), None)
        if not server:
            raise HTTPException(status_code=404, detail="Server not found")
        try:
            await connect_server(server)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Connection failed: {e}")
    try:
        tools = await list_server_tools(server_id)
        return {"server_id": server_id, "tools": tools}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/servers/{server_id}/test")
async def test_mcp_server(server_id: str, user: User = Depends(get_admin)):
    servers = get_mcp_servers()
    server = next((s for s in servers if s.get("id") == server_id), None)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    try:
        await connect_server(server)
        tools = await list_server_tools(server_id)
        await disconnect_server(server_id)
        return {"status": "ok", "connected": True, "tools": tools}
    except Exception as e:
        try:
            await disconnect_server(server_id)
        except Exception:
            pass
        return {"status": "error", "connected": False, "error": str(e), "tools": []}
