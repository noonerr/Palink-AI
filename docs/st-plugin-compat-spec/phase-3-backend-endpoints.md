# Phase 3: 后端端点补齐

## 目标

补齐 ST 插件依赖的后端 API 端点，让 Class C 插件（vectors/expressions/gallery/assets/connection-manager）能在 palink-native 模式运行，不必走 ST Native。

## Why

当前后端端点缺口：

| 端点 | 当前状态 | 依赖的扩展 |
|---|---|---|
| `/api/extensions/install\|update\|delete\|discover` | stub 返回错误（silly_tavern.py:7008-7040） | assets 扩展 |
| `/api/vector/list` | 未实现 | vectors |
| `/api/vector/query-multi` | 未实现 | vectors |
| `/api/vector/purge` | 未实现 | vectors |
| `/api/vector/purge-all` | 未实现 | vectors |
| `/api/vector/*` | 委托 Palink memory_module（与 ST vectors 双轨） | vectors（需改为 ST 主导） |
| `/api/connection*` | bridge.js 拦截重定向（无后端实现） | connection-manager |
| `/api/images/*` | 已实现（silly_tavern.py:5896-5930） | gallery |
| `/api/sprites/*` | 已实现（st_resources.py:375-504） | expressions |
| `/api/assets/*` | 已实现（st_resources.py:557-628） | assets |
| `/api/chats/attachments/*` | 未实现 | attachments |

## What Changes

### 改动点

#### 1. MODIFIED: `/api/extensions/install|update|delete|discover` 真实实现

**文件**：`backend/app/api/silly_tavern.py`（行 7008-7040）

**当前 stub**：
```python
@router.post("/api/extensions/install")
async def st_extensions_install(...):
    return {"success": False, "error": "Use Palink extension market"}
```

**改为真实安装**（代理到 ST sidecar 或本地安装）：

```python
@router.post("/api/extensions/install")
async def st_extensions_install(
    request: Request,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    ST 1.18.0 /api/extensions/install
    body: { url: string }
    代理到 ST sidecar 执行真实安装，或本地 git clone
    """
    url = body.get("url")
    if not url:
        return {"success": False, "error": "url is required"}

    # 路径校验（拒绝空、..、CRLF、绝对 URL）
    if not is_valid_extension_url(url):
        return {"success": False, "error": "invalid url"}

    try:
        # 方案 A：代理到 ST sidecar
        result = await proxy_to_st_sidecar(
            "/api/extensions/install",
            method="POST",
            body={"url": url},
            user=current_user,
        )
        return result

        # 方案 B：本地安装（git clone 到 public/st/scripts/extensions/）
        # ext_name = url.rsplit('/', 1)[-1].replace('.git', '')
        # ext_path = f"frontend/public/st/scripts/extensions/{ext_name}"
        # subprocess.run(["git", "clone", url, ext_path], check=True)
        # return {"success": True, "extension_name": ext_name}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/api/extensions/update")
async def st_extensions_update(...):
    # 代理到 ST sidecar
    ...


@router.post("/api/extensions/delete")
async def st_extensions_delete(...):
    # 代理到 ST sidecar
    ...


@router.get("/api/extensions/discover")
async def st_extensions_discover(...):
    # 代理到 ST sidecar
    ...
```

**决策点**：方案 A（代理到 sidecar）vs 方案 B（本地安装）
- 建议：方案 A，与 bridge.js 的 Layer 2 代理逻辑一致

#### 2. MODIFIED: `/api/vector/*` 让 ST vectors 主导

**文件**：`backend/app/api/silly_tavern.py`（行 6240-6391）

**当前实现**：委托 Palink `MemoryService`（与 ST vectors 双轨）

**改为**：代理到 ST sidecar 的 `/api/vector/*`，让 ST vectors 扩展完全接管

```python
@router.post("/api/vector/index")
async def st_vector_index(
    request: Request,
    body: dict = Body(...),
    current_user = Depends(get_current_user),
):
    """ST vectors 扩展的 /api/vector/index — 代理到 ST sidecar"""
    return await proxy_to_st_sidecar(
        "/api/vector/index",
        method="POST",
        body=body,
        user=current_user,
    )


@router.post("/api/vector/query")
async def st_vector_query(...):
    return await proxy_to_st_sidecar("/api/vector/query", ...)


@router.post("/api/vector/insert")
async def st_vector_insert(...):
    return await proxy_to_st_sidecar("/api/vector/insert", ...)


@router.post("/api/vector/delete")
async def st_vector_delete(...):
    return await proxy_to_st_sidecar("/api/vector/delete", ...)


# 新增缺失端点
@router.post("/api/vector/list")
async def st_vector_list(...):
    return await proxy_to_st_sidecar("/api/vector/list", ...)


@router.post("/api/vector/query-multi")
async def st_vector_query_multi(...):
    return await proxy_to_st_sidecar("/api/vector/query-multi", ...)


@router.post("/api/vector/purge")
async def st_vector_purge(...):
    return await proxy_to_st_sidecar("/api/vector/purge", ...)


@router.post("/api/vector/purge-all")
async def st_vector_purge_all(...):
    return await proxy_to_st_sidecar("/api/vector/purge-all", ...)


@router.post("/api/vector/hash")
async def st_vector_hash(...):
    return await proxy_to_st_sidecar("/api/vector/hash", ...)
```

**注意**：Palink 的 `memory_module` 不再介入 `/api/vector/*`，但仍可通过 `/api/memory/*` 独立使用。

#### 3. ADDED: `/api/connection*` 代理到 ST sidecar

**文件**：`backend/app/api/silly_tavern.py`

**当前**：bridge.js 行 184-192 在 nativeMode 下拦截返回 `{error:'redirect_to_palink_settings'}`，无后端实现。

**改为**：实现 `/api/connection*` 端点，代理到 ST sidecar：

```python
@router.get("/api/connection")
async def st_connection_list(
    request: Request,
    current_user = Depends(get_current_user),
):
    """ST connection-manager 扩展的连接列表 — 代理到 ST sidecar"""
    return await proxy_to_st_sidecar("/api/connection", method="GET", user=current_user)


@router.post("/api/connection")
async def st_connection_create(...):
    return await proxy_to_st_sidecar("/api/connection", method="POST", ...)


@router.put("/api/connection/{profile_id}")
async def st_connection_update(...):
    return await proxy_to_st_sidecar(f"/api/connection/{profile_id}", method="PUT", ...)


@router.delete("/api/connection/{profile_id}")
async def st_connection_delete(...):
    return await proxy_to_st_sidecar(f"/api/connection/{profile_id}", method="DELETE", ...)
```

**bridge.js 改动**：移除 `/api/connection*` 的 `isStNativeManagedApi` 拦截（行 184-192），让请求走 Layer 2 代理。

#### 4. ADDED: `/api/chats/attachments/*` 端点

**文件**：`backend/app/api/silly_tavern.py`

**新建**：attachments 扩展依赖的端点

```python
@router.post("/api/chats/attachments/upload")
async def st_attachments_upload(
    request: Request,
    file: UploadFile = File(...),
    current_user = Depends(get_current_user),
):
    """上传附件"""
    # 保存到 data/attachments/{user_id}/{chat_id}/
    ...


@router.get("/api/chats/attachments/{chat_id}")
async def st_attachments_list(
    chat_id: str,
    current_user = Depends(get_current_user),
):
    """列出指定聊天的附件"""
    ...


@router.delete("/api/chats/attachments/{attachment_id}")
async def st_attachments_delete(
    attachment_id: str,
    current_user = Depends(get_current_user),
):
    """删除附件"""
    ...
```

#### 5. MODIFIED: `bridge.js` 移除拦截

**文件**：`frontend/public/st/bridge.js`（行 184-192）

**当前**：`isStNativeManagedApi` 拦截 `/api/connection*`、`/api/keys*`、`/api/tts/provider*`、`/api/sd/provider*`、`/api/tts/load`、`/api/sd/get-models`

**改为**：移除 `/api/connection*` 的拦截，让请求走 Layer 2 代理到 ST sidecar

```javascript
function isStNativeManagedApi(apiPath) {
  // 移除 /api/connection* — 让 ST connection-manager 扩展能跑
  return (
    // apiPath.startsWith('/api/connection') ||  // 移除
    apiPath.startsWith('/api/keys') ||
    apiPath.startsWith('/api/tts/provider') ||
    apiPath.startsWith('/api/sd/provider') ||
    apiPath === '/api/tts/load' ||
    apiPath === '/api/sd/get-models'
  );
}
```

**决策点**：`/api/keys*`/`/api/tts/provider*`/`/api/sd/provider*` 是否也移除拦截？
- 建议：保留拦截，因为这些是 Palink 已有的连接管理功能，与 ST 扩展冲突时优先 Palink
- 若要完整兼容 ST 的 tts/sd 扩展，需在 Phase 4 决策

#### 6. ADDED: `proxy_to_st_sidecar` 统一代理函数

**文件**：`backend/app/api/silly_tavern.py`

```python
async def proxy_to_st_sidecar(
    path: str,
    method: str = "GET",
    body: Optional[dict] = None,
    user = None,
) -> dict:
    """
    代理请求到 ST sidecar
    """
    from app.services.st_sidecar_client import StSidecarClient

    client = StSidecarClient()
    # 注入 X-Palink-* 头
    headers = {
        "X-Palink-User-Id": str(user.id) if user else "",
        "X-Palink-Username": user.username if user else "",
        "X-Palink-Is-Admin": str(user.is_admin if user else False),
    }
    response = await client.request(path, method=method, body=body, headers=headers)
    return response
```

## 验收标准

### 单元测试
- [ ] `backend/tests/test_st_extensions_endpoints.py`
  - test `/api/extensions/install` 代理到 sidecar
  - test `/api/extensions/update` 代理到 sidecar
  - test `/api/extensions/delete` 代理到 sidecar
  - test `/api/extensions/discover` 代理到 sidecar
- [ ] `backend/tests/test_st_vector_endpoints.py`
  - test `/api/vector/index` 代理到 sidecar（不再委托 memory_module）
  - test `/api/vector/list` 端点存在
  - test `/api/vector/query-multi` 端点存在
  - test `/api/vector/purge` 端点存在
  - test `/api/vector/purge-all` 端点存在
- [ ] `backend/tests/test_st_connection_endpoints.py`
  - test `/api/connection` GET/POST/PUT/DELETE 都代理到 sidecar
- [ ] `backend/tests/test_st_attachments_endpoints.py`
  - test 上传/列出/删除附件

### 集成测试
- [ ] vectors 扩展能调用 `/api/vector/list`/`query-multi`/`purge`/`purge-all`
- [ ] connection-manager 扩展能 CRUD profile
- [ ] assets 扩展能安装/更新/删除/发现扩展
- [ ] attachments 扩展能上传/列出/删除附件

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误

## 风险与注意事项

1. **ST sidecar 可用性**：代理到 sidecar 需确保 sidecar 容器正常运行。若 sidecar 不可用，需返回友好错误。
2. **api_key 安全**：connection-manager 的 api_key 通过 sidecar 明文存储，接受（兼容优先）。
3. **`/api/vector/*` 双轨问题**：改为 ST sidecar 代理后，Palink `memory_module` 的 `/api/memory/vector/*` 仍可用，但 `/api/vector/*` 不再委托 `memory_module`。需确认无其他代码依赖此委托。
4. **bridge.js 拦截顺序**：移除 `/api/connection*` 拦截后，需确保 Layer 2 代理能正确处理。
5. **附件存储路径**：`/api/chats/attachments/*` 的文件存储路径需与 `message.extra.files` 对齐。
6. **路径校验**：`/api/extensions/install` 的 url 需严格校验，拒绝恶意 URL。

## 完成判定

- `/api/extensions/install|update|delete|discover` 真实代理到 sidecar
- `/api/vector/*` 全部端点代理到 sidecar（不再委托 memory_module）
- `/api/connection*` 端点存在并代理到 sidecar
- `/api/chats/attachments/*` 端点实现
- bridge.js 移除 `/api/connection*` 拦截
- vectors/connection-manager/assets/attachments 扩展能调用所需 API
- 全量回归 0 failure

---

## 实施结果（As-Built，2026-07-28，分支 st-plugin-compat-20260727）

> 以下为实际落地方案，若与上文预案冲突，以本节为准。

### 关键决策修正

1. **`/api/vector/*` 未走 sidecar 代理，改为 Palink 后端原生双格式实现**（优于预案）：
   - 判别器：请求体含 `collectionId` → ST 格式分支；不含 → 保留 Palink 旧格式（向后兼容）。
   - 存储：复用 `conversation_memories` 表，`session_id = "st-vec::<collectionId>"` 前缀隔离；ST 元数据存 `topics` dict `{"st_hash","st_index","st_source"}`（与 Palink list 形态用 `isinstance(topics, dict)` 区分）。
   - **hash 由客户端计算**（ST `public/scripts/utils.js` 的 `cyrb53(getStringHash)`），服务端只存储/回显，无需实现 hash 算法。
2. **新增 4 端点**：`/api/vector/list`（裸 `number[]`）、`/api/vector/query-multi`（`Record<collectionId,{metadata,hashes}>`）、`/api/vector/purge`、`/api/vector/purge-all`（仅删 `st-vec::` 前缀，不碰正常记忆）。
3. **查询实现陷阱（已修复，commit 2b6c71f）**：不可复用 `MemoryStorage.semantic_search`——其内部将行转 `MemoryEntry`（pydantic `topics: List[str]`），ST dict topics 校验失败被静默跳过 → 查询恒空。`_st_vec_query_collection` 改用原始 SQL + numpy 余弦相似度。
4. **extensions 4 端点真实代理**：`_forward_extensions_to_st_native`（httpx 非流式转发 sidecar）；`install/update/delete` 上游错误透传、sidecar 不可达 → 502 JSON；`discover` 为 **GET**（对齐 ST `extensions.js:480`），sidecar 不可达降级 200 + `[]`。
5. **bridge.js**：`REAL_API_PATHS` 增补 `query-multi/list/purge/purge-all` 4 路径（`frontend/public/st/bridge.js` + 同步 `dist`）。
6. **connection-manager / attachments 未在本轮实施**（无插件实际阻塞，后续按需）。

### 验证结果

- `tests/test_st_vectors_full.py`：9 passed（容器内）。
- `tests/test_st_contract.py` 回归：39 passed / 3 skipped。
- `tests/smoke_st_vectors.py` 端到端冒烟（重建容器后）：**11/11 通过**，discover 实际透传 sidecar 系统扩展列表。
- 相关 commits：`2bd90d2`（向量端点）、`6647596`（extensions 代理）、`2b6c71f`（查询修复+测试）、`f04d175`（冒烟）。
