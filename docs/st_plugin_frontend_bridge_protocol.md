# ST 插件前后端桥接协议（P0，前端适配依据）

- 日期：2026-07-29
- 状态：后端已实现，待前端接入
- 参考基准：SillyTavern 1.18.0 `public/scripts/extensions.js`

本文档定义前端沙箱执行 ST 扩展 JS 时与后端交互的三个 P0 契约。

---

## 1. loading_order 排序（P0-1，后端已生效）

`GET /api/plugins/runtime/config` 返回的 `plugins` 数组**已按 ST 语义排序**：

- 排序规则（对齐 `extensions.js:49 sortManifestsByOrder`）：
  1. manifest 含可解析 `loading_order` 的插件在前，按数值升序；数值相同按 `display_name` 字典序；
  2. 无 `loading_order` 的插件（含非 ST 插件）在后，保持 `created_at` 顺序。

**前端义务**：必须按数组顺序依次注入/执行插件 JS（`sillyTavernPluginRuntime.injectIntoContainer` 与 `PluginSandbox` 均需遵守），不得并行乱序注入——依赖 `shared.js` 或前序扩展全局符号的扩展依赖此顺序。

## 2. generate_interceptor 透传（P0-2，后端已生效）

`runtime/config` 新增两处：

1. 每个插件 payload 新增顶层字段：
   - `namespace`: string — 该插件的 extension_settings 命名空间；
   - `generate_interceptor`: string | null — manifest 声明的拦截器全局函数名。
2. 响应新增顶层数组（已按 loading_order 排好序，仅含 `execute_scripts=true` 的插件）：

```json
"generation_interceptors": [
  {"plugin_id": "…", "namespace": "Vector Storage", "function": "vectors_rearrangeChat"}
]
```

**前端义务**（对齐 `extensions.js:2015-2040 runGenerationInterceptors`）：每次触发生成前，按数组顺序：

```js
let aborted = false; let immediately = false;
const abort = (im) => { aborted = true; immediately = !!im; };
for (const { function: fnName } of interceptors) {
  const fn = globalThis[fnName];          // 沙箱内为沙箱 globalThis
  if (typeof fn !== 'function') continue;
  await fn(chat, contextSize, abort, type); // chat 为消息数组副本，可原地修改
  if (aborted) break;
}
```

`chat` 数组元素须至少含 `{ id, name, is_user, mes }`（id = 后端消息 ID，字符串）。拦截器执行后 diff 出结果，经协议 3 回传。

## 3. interceptor_result 回传（P0-3，后端已生效）

### 3.1 WebSocket 路径（`chat_request`）

`chat_request` 消息体新增可选字段：

```json
{
  "type": "chat_request",
  "…": "…",
  "interceptor_result": {
    "message_order": ["msgId1", "msgId2"],      // 可选：拦截器重排后的完整消息 ID 顺序
    "excluded_message_ids": ["msgId3"],          // 可选：拦截器 splice 删除的消息 ID
    "abort": false                                // 可选：任一拦截器调用了 abort()
  }
}
```

后端行为：

| 字段 | 行为 |
|---|---|
| `message_order` | 装配时按此顺序重排 DB 历史（未列出的消息保持原相对顺序、排在末尾）。优先级高于旧版顶层 `message_order` 字段（Task 7 遗留，仍兼容）。 |
| `excluded_message_ids` | 装配时从历史中排除这些消息。**仅影响本次 prompt，不改动落库数据**。 |
| `abort: true` | 用户消息正常落库，但跳过本轮 AI 生成，并向会话广播：`{"type": "generation_aborted", "reason": "interceptor", "session_id": "…"}`。前端收到后应结束加载态。 |

排除与重排可同时使用：先排除、后重排。两个 builder 路径（palink-native `build_character_chat_messages` / st-compat `build_st_compat_messages`）行为一致。

### 3.2 HTTP 路径（`CharacterChatRequest`）

`POST` 角色聊天请求体新增 `excluded_message_ids: string[]`（`message_order` 原已存在）。HTTP 路径无 abort 语义（前端判定 abort 后不发请求即可）。

### 3.3 前端 diff 算法建议

拦截器跑完后，对比执行前 `chat` 快照与执行后数组：

- 执行后 ID 集合缺失的 → `excluded_message_ids`；
- ID 顺序变化（排除已删除项后）→ `message_order`（传完整顺序，不要只传变动段）；
- 拦截器新插入的无 ID 消息（如 SD 触发图占位）→ 当前协议不支持注入，暂用 `extension_prompts`（position=IN_CHAT + depth）表达，后续 P1 再评估。

## 4. 已知边界（前端适配时须知）

- `generate_interceptor` 在沙箱 `globalThis` 上查找；page 注入模式（`sillyTavernPluginRuntime`）则在真实 `window` 上查找。两条执行路径的前端需统一约定，不要重复调用同一拦截器。
- 后端 fallback 路由 `/api/plugins/{id}/{path}` 仍固定 404（registerEndpoint handler 只在前端存在）。
- `requires` / `dependencies` 后端尚未做解析告警（P1），前端暂不能假设依赖已满足。
- manifest `hooks` 生命周期（P1）尚未实现。
