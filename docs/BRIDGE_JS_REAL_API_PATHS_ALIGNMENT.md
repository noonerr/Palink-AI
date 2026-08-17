# bridge.js REAL_API_PATHS 白名单对齐修复 (2026-07-19)

## 问题背景

在 Phase 1-5 完成 ST 后端核心对齐（角色卡/世界书/聊天/正则/getContext）后，
完成审计发现 `frontend/public/st/bridge.js` 中的 `REAL_API_PATHS` 白名单
**未与后端实际注册的端点同步**。

`bridge.js` 的三层判断逻辑：
1. 静态资源 → 静态文件服务
2. Palink-owned API → Palink 后端
3. 其他 `/api/*` → 透明代理到 ST sidecar

问题：Phase 1-5 期间新增了大量 Palink-owned ST 端点
（`/api/characters/import`、`/api/chats/recent`、`/api/worldinfo/list`、
`/api/backgrounds/*`、`/api/avatars/*`、`/api/sprites/*`、`/api/assets/*`、
`/api/quick-replies/*`、`/api/secrets/*`、`/api/extensions/*` 等），
但 `REAL_API_PATHS` 仍停留在 Phase 0 的初始 32 条记录。

## 影响

当 ST 前端 iframe 调用这些"已实现但未白名单"端点时，请求会被**错误地代理到
ST sidecar**，而非路由到 Palink 后端，导致：

1. **数据不一致**：Palink DB 与 ST sidecar 文件系统出现两套独立数据
2. **Palink 实现成为死代码**：后端代码注册了路由但前端永不调用
3. **用户体验不一致**：通过 Palink-native UI 与 ST iframe 操作产生的数据不互通

例如：
- ST 前端调用 `/api/characters/import` → 代理到 ST sidecar → 文件系统创建角色
- Palink DB 不知道这个新角色 → Palink-native 角色扮演页面看不到
- 反过来，Palink-native 创建的角色不会出现在 ST iframe 列表中

## 修复内容

### 1. `frontend/public/st/bridge.js`

`REAL_API_PATHS` 白名单从 32 条扩展到 110 条，按功能分组：

- **Version & CSRF** (4): `/version`, `/csrf-token`, `/api/st/version`, `/api/st/csrf-token`
- **Settings** (2): `/api/settings/get`, `/api/settings/save`
- **Characters** (13): 新增 `import`, `export`, `edit-avatar`, `edit-attribute`
- **Chats — CRUD** (8): 新增 `import`, `export`, `recent`
- **Chats — generation** (3): 新增 `continue`, `regenerate`, `swipe`
- **Chats — group** (5): 新增 `group/info`, `group/import`
- **Chats — message-level** (12): 新增 `hide`, `unhide`, `delete-message`, 等
- **WorldInfo** (7): 新增 `list`, `import`, `export`, `batch-import`
- **Groups** (9)
- **Quick Replies** (6)
- **Backgrounds** (5): st_resources.py
- **Avatars** (3): st_resources.py
- **Sprites** (4): st_resources.py
- **Assets** (4): st_resources.py
- **Secrets** (7): Palink 重定向到 ConnectionProfiles UI
- **Extensions** (4): Palink 重定向到 extension market UI
- **Images** (1)
- **Vector** (4)
- **Speech** (4)
- **Translate & Search** (2)
- **Backends** (3): 新增 `text-completions/generate`

新增 `REAL_API_PREFIXES` 数组用于动态路径前缀匹配：
- `/api/chats/swipe/{index}` → 前缀 `/api/chats/swipe/`
- `/api/images/list/{folder}` → 前缀 `/api/images/list/`

`isPalinkOwnedApi` 函数升级为先精确匹配 `REAL_API_PATHS`，再前缀匹配 `REAL_API_PREFIXES`。

### 2. `backend/tests/test_st_contract.py`

- **扩展 `ST_ENDPOINTS` 列表**：从 35 条扩展到 100+ 条，覆盖所有 Palink 实现的 ST 端点
- **新增 `TestBridgeJsRealApiPathsSync` 测试类**（3 个测试）：
  - `test_bridge_js_file_exists`: 验证 bridge.js 文件存在
  - `test_real_api_paths_non_empty`: 验证白名单非空
  - `test_palink_owned_endpoints_in_bridge_js`: **关键测试**
    - 从 bridge.js 提取 `REAL_API_PATHS` 和 `REAL_API_PREFIXES`
    - 从后端 `api_router` 反射收集所有已注册 ST 端点
    - 过滤 Palink-native 端点（`/api/admin/*`, `/api/character-sessions/*` 等）
    - 验证每个后端 ST 端点都在 bridge.js 白名单中
    - 防止"Palink 实现但未白名单"的回归

## 验证结果

### 后端测试
- `pytest tests/test_st_contract.py` → **42 passed** (vs 36 baseline, +6)
- `pytest tests/ --ignore=tests/test_author_note_position.py` → **238 passed, 36 skipped, 0 failed**
- 新增 `TestBridgeJsRealApiPathsSync` 3 个测试全部通过

### 前端测试
- `runtime-contract.test.ts` → **9 passed**, 1 skipped
- `getcontext-parity.test.ts` → **7 passed** (145/145 子测试)
- `event-contract.test.ts` → **73 passed**, 1 skipped (从 71/73 改善到 73/73)

### 容器状态
4 个服务全部 healthy：
- `palink-ai-frontend-1` healthy (重建后部署新 bridge.js)
- `palink-ai-backend-1` healthy
- `palink-ai-sillytavern-1` healthy
- `palink-ai-db-1` healthy

### HTTP 部署验证
通过 `curl http://localhost:3100/st/bridge.js` 确认：
- `REAL_API_PREFIXES` 数组存在
- `/api/characters/import` 在白名单中
- `/api/backends/text-completions/generate` 在白名单中

## 设计决策

### 端点归属判断

| 端点类型 | 处理方式 | 示例 |
|---------|---------|------|
| Palink DB 读写 | 加入 `REAL_API_PATHS` | `/api/characters/*`, `/api/chats/*`, `/api/worldinfo/*` |
| Palink 文件系统 | 加入 `REAL_API_PATHS` | `/api/backgrounds/*`, `/api/avatars/*`, `/api/sprites/*` |
| Palink 推理引擎 | 加入 `REAL_API_PATHS` | `/api/backends/*`, `/api/chats/continue` |
| Palink 重定向到自家 UI | 加入 `REAL_API_PATHS` | `/api/secrets/*` → ConnectionProfiles, `/api/extensions/*` → extension market |
| Palink-native (非 ST API) | 排除 (Palink 自家用) | `/api/admin/*`, `/api/character-sessions/*`, `/api/personas/*` |
| OpenAI guard | 由 bridge.js guard 处理 | `/api/openai/generate-voice`, `/api/openai/generate-image` |
| 动态路径 | 加入 `REAL_API_PREFIXES` | `/api/chats/swipe/{index}`, `/api/images/list/{folder}` |

### 测试过滤策略

`_collect_backend_registered_st_endpoints` 方法过滤掉 Palink-native 端点：
- `/api/admin/*` — Palink 管理后台
- `/api/auth/*` — Palink 认证
- `/api/character-sessions/*` — Palink-native 会话管理（ST 用 `/api/chats/*`）
- `/api/instruct-templates/*` — Palink-native 模板（ST 存在 settings 里）
- `/api/regex-scripts/*` — Palink-native 正则（ST 存在角色卡 extensions）
- `/api/sessions/*` — Palink-native 会话（ST 用 `/api/chats/*`）
- `/api/themes/*` — Palink-native 主题（ST 存在 settings 里）
- 等共 35+ 个前缀

## 防回归机制

新增的 `test_palink_owned_endpoints_in_bridge_js` 测试会在以下情况失败：
1. 后端新增 ST 端点但未加入 bridge.js `REAL_API_PATHS`
2. bridge.js 中 `REAL_API_PATHS` 字典格式错误导致解析失败
3. `REAL_API_PREFIXES` 数组格式错误

这确保了"Palink 实现的端点必须路由到 Palink 后端"这一架构约束被持续验证。

## 后续工作

虽然这次修复解决了 bridge.js 与后端端点同步问题，但还有一些 ST 1.18.0
功能端点 Palink 尚未实现（由 ST sidecar 透明代理处理）：
- `/api/backups/*` — 聊天备份管理
- `/api/caption/*` — 图像描述（视觉模型）
- `/api/content/*` — 内容管理器
- `/api/data-maid/*` — 数据清理工具
- `/api/files/*` — 聊天附件文件管理
- `/api/moving-ui/*` — 移动 UI 扩展
- `/api/presets/*` — 预设管理
- `/api/stats/*` — 统计信息
- `/api/themes/*` — 主题管理（Palink-native 已有独立实现）
- `/api/thumbnail/*` — 缩略图（Palink 已有 `/api/st/thumbnail`）

这些端点通过 bridge.js Layer 2 透明代理到 ST sidecar 处理，
属于 SPEC 保守原则下的"延缓实现"项。
