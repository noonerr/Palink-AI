# goal-design.md — 后端 ST 插件完整兼容（Phase 3/4/5）设计文档

> 阶段 3 交付物。对应 goal-plan.md 子任务 T2–T6 的技术设计。
> 基准：SillyTavern 1.18.0 `src/endpoints/vectors.js`、`public/scripts/utils.js (getStringHash/cyrb53)`。
> 明确非目标：regex 双向转换器（用户已确认跳过）、connection-manager 后端实体、ST-iframe 跨模式同步。

---

## 1. T2 — Vector 端点补齐（/list、/query-multi、/purge、/purge-all）

### 1.1 关键事实（已核实）

- **hash 由 ST 客户端计算**（cyrb53，`getStringHash`），随 `/insert` 的 `items[].hash` 上传；服务端仅存储/回传。**后端不需要复现 hash 算法。**
- ST 合同（`src/endpoints/vectors.js`）：
  | 路由 | 请求 | 响应 |
  |---|---|---|
  | `/api/vector/insert` | `{collectionId, items:[{hash,text,index}], source}` | `200 ok` |
  | `/api/vector/list` | `{collectionId, source}` | `number[]`（已存 hash 数组）|
  | `/api/vector/query` | `{collectionId, searchText, topK, threshold, source}` | `{metadata:[...], hashes:[...]}` |
  | `/api/vector/query-multi` | `{collectionIds:[...], searchText, topK, threshold}` | `Record<collectionId,{metadata,hashes}>` |
  | `/api/vector/delete` | `{collectionId, hashes:[...], source}` | `200 ok` |
  | `/api/vector/purge` | `{collectionId}` | `200 ok` |
  | `/api/vector/purge-all` | `{}` | `200 ok` |

- **现状**：Palink 已有 `/index`、`/query`、`/insert`、`/delete` 四个端点，但请求模型是**自有格式**（`VectorInsertRequest{items:[{text,metadata}]}` 等），不含 `collectionId`/`hash` 字段 → 与 ST Vector Storage 扩展**并不真正兼容**。

### 1.2 设计决策

**D1（兼容策略）：现有 4 端点做「双格式识别」，新增 4 端点纯 ST 格式。**
- 现有端点的 Pydantic 模型加可选字段：`collectionId: Optional[str]`、`items[].hash: Optional[int]`、`items[].index: Optional[int]`、`searchText`/`topK`/`threshold`/`hashes` 等别名。请求含 `collectionId` 时按 ST 语义处理并返回 ST 形状；否则维持原有 Palink 形状（向后兼容自有前端调用与 `test_st_contract.py`）。
- 判别函数：`_is_st_vector_payload(body) = body.collectionId is not None`。

**D2（存储映射）：复用 `conversation_memories` 表，零迁移。**
- `session_id = f"st-vec::{collectionId}"`（带前缀避免与真实会话冲突；`/purge` 按该前缀精确删，`/purge-all` 按 `session_id LIKE 'st-vec::%'` 删，天然不会误删正常记忆）。
- `topics`（JSON 列）存 ST 元数据：`{"st_hash": <int>, "st_index": <int>, "st_source": <str>}`。ST 语义下写入 dict；Palink 语义下仍是 list——读取侧用 `isinstance` 区分。
- `role = "system"`，`content = item.text`，embedding 由 `embed_text` 生成。
- 幂等：insert 前先按 `(user_id, session_id, topics.st_hash)` 去重（应用层：先 `/list` 集合内已有 hash，跳过重复项——与 ST 客户端行为一致，客户端本身也会先 diff）。

**D3（查询形状）：**
- ST 语义 `/query` 响应：`{"metadata":[{hash,text,index,score,...}], "hashes":[...]}`；`threshold` 映射到 `semantic_search(min_similarity=threshold)`。
- `/query-multi`：循环 collectionIds 各查一次（N 通常 ≤3：chat/文件/世界书），拼 `Record`。
- `/list`：`SELECT topics FROM conversation_memories WHERE user_id=:u AND session_id=:c` 提取 `st_hash`，返回**裸数组** `number[]`（ST 客户端 `response.json()` 直接当数组用，不能包 `{data:...}`）。

**D4（响应码）**：ST 端点成功一律 `200` + ST 形状；memory 模块不可用时返回 `503` + `{"error":"memory module disabled"}`（ST 客户端对非 2xx 会 toast 报错，语义正确）。**不使用** development-standards 的 `{success,data}` 包裹——ST 合同优先（该标准 §2.4 自身允许「外部合同优先」例外）。

### 1.3 bridge.js 更新

`frontend/public/st/bridge.js` 的 `REAL_API_PATHS` 追加：
```
'/api/vector/list', '/api/vector/query-multi', '/api/vector/purge', '/api/vector/purge-all'
```
同步方式：修改 `public/st/bridge.js` 后复制到 `dist/st/bridge.js`（该文件为静态资源，无需前端整体构建；若 docker 镜像内嵌 dist 则随 T8 重建生效）。

---

## 2. T3 — /api/settings/save 增量合并 extension_settings

### 2.1 问题

`/api/settings/save`（silly_tavern.py:2536）现为 `silly_tavern_settings = json.dumps(payload)` **整体覆盖**。ST 扩展只改 `extension_settings` 后调 save 时，若 payload 缺少其他键会破坏已存设置；反之 Phase 1 前端 store 想单独持久化 extension_settings 也无入口。

### 2.2 设计

- `/api/settings/save` 改为**深度合并策略（仅对 extension_settings 键）**：
  1. 读旧 `silly_tavern_settings` → `old`。
  2. `merged = payload`；若 `payload` 含 `extension_settings`：`merged["extension_settings"] = {**old.get("extension_settings", {}), **payload["extension_settings"]}`（namespace 级浅合并——与 ST 自身行为一致，ST 也是整 namespace 覆盖）。
  3. 若 `payload` **不含** `extension_settings` 但 `old` 有 → 保留 `old` 的（防止旧调用方擦除扩展设置）。
  4. 其余顶层键维持现状（payload 优先，整体替换语义不变）。
- `/api/settings/get`（:2471）确保返回体包含 `extension_settings`（若存在于 silly_tavern_settings 中）。
- 前端 `extension-settings-store.ts` 后续可在 `saveExtensionSettingsDebounced` 中 POST `{extension_settings: globalExtensionSettings}` 到该端点（本轮仅做后端能力，前端接线为可选增强，不在 T3 验收内）。

---

## 3. T4 — /api/extensions/* 真实代理

### 3.1 现状

silly_tavern.py:7008-7040 的 `/api/extensions/discover|install|update|delete` 为**硬编码 stub**（返回空/假成功）。

### 3.2 设计

- 全部改为经 `st_native_proxy` 机制转发到 ST sidecar（`app_settings.ST_NATIVE_SERVICE_URL`），保持 ST 原始路径（`/api/extensions/install` 等），透传 body 与响应。
- 实现方式：提取 `st_native_proxy` 的核心转发逻辑为内部协程 `_forward_to_st_native(path, method, body, headers) -> Response`，extensions 端点与原 proxy 共用。
- sidecar 不可用（connect error/timeout）时返回 `502` + `{"error": "ST native service unavailable", "detail": ...}`——**明确 JSON 错误**而非假成功，让 ST 扩展管理 UI 呈现真实失败。
- `discover` 特殊处理：sidecar 不可用时降级返回 `[]`（ST 前端启动即调 discover，502 会刷屏；空数组=「无第三方扩展」是安全降级）。

---

## 4. T5 — memory_module 门控修正（Phase 4 让步）

### 4.1 问题与修正

规格原案 `MEMORY_ENABLED 默认 false` 存在逻辑缺陷：`MemoryService.is_available()` 短路后**用户开关永远不可达**。修正为：

- **env 默认 true**：`MEMORY_ENABLED`（memory_module/config.py），仅作全局总闸（运维级）。
- **用户级开关**：`UserSetting.memory_mode` 已存在（system.py）。在 `_append_memory_context`（roleplay_prompt_assembly.py:4044）现有 `memory_mode == "disabled"` 跳过逻辑之上，增加规则：**当 ST 向量集合存在活跃数据时自动让步**——即若本会话对应 `st-vec::` 集合有记录且用户开启了 ST 向量插件，跳过 Palink 自动记忆注入，避免双记忆系统同时注入内容重复。
- 让步检测：轻量 `EXISTS` 查询 `session_id LIKE 'st-vec::%' AND user_id=:u`，结果按 (user_id) 进程内缓存 60s，避免每条消息查库。
- 用户显式 `memory_mode` 值优先于自动让步（`"always"` 强制注入、`"disabled"` 强制关闭、默认 `"auto"` 走让步逻辑）。

---

## 5. T6 — slash /clear 保护

- 前端 slash-engine（palink-native 模式）：`/clear` 等破坏性命令执行前检查目标会话是否有未备份消息，弹确认（一次性，`window.confirm` 级别即可，不引 UI 依赖）。
- 后端若存在 slash registry 端点则同步加保护；初查未见后端 slash 执行入口 → 执行时若确认后端无此面，仅做前端，记录到执行日志。

---

## 6. T7/T8 — 验证设计

- **T7**：`backend` 内 `pytest tests/test_st_contract.py` + 新增 `tests/test_st_vectors_full.py`（覆盖 8 端点 ST 形状：insert→list 回读 hash→query 命中→delete 按 hash→purge 清空→purge-all；query-multi 两集合）。前端 `npx tsc --noEmit`（基线：仅 NativeRoleplayChat.tsx 6 个既有错误，不得新增）。
- **T8**：`docker compose build backend && up -d`，curl 冒烟：8 个 vector 端点 + settings/save 合并行为 + extensions/discover 降级。
- **T9**：回填 `docs/st_plugin_compat/` 规格（hash 客户端计算事实、门控修正、双格式端点决策），写 `goal-verification-report.md`。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 现有 4 端点改双格式回归自有前端 | 判别仅基于 `collectionId is not None`，旧调用不含该字段→路径不变；pytest 既有 contract 测试守护 |
| `/list` 裸数组响应被网关/中间件包裹 | 冒烟测试直接断言 `isinstance(resp.json(), list)` |
| topics 列 dict/list 混用 | 所有读取点（storage.semantic_search 的消费方）grep 核查后再动；ST 数据仅存于 `st-vec::` 会话，正常记忆流程不读它 |
| settings 合并破坏 ST iframe 设置 | 合并仅增不减；备份 silly_tavern.py（T1）；保留旧值兜底分支 |
| 回滚 | T1 备份至 `.workbuddy/backups/st-plugin-compat-20260727/`；git 单独 commit per 子任务 |

---

## 8. 执行顺序（Stage 4）

T1 备份 → T2（端点+bridge.js）→ T3 → T4 → T5 → T6 → T7 测试 → T8 docker 重建冒烟 → T9 回填。每子任务独立 git commit。
