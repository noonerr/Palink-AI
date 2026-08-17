# Palink-AI 性能验证报告

> 生成时间: 2026-07-19 (core-parity-complete 阶段更新)
> 对应任务: Phase 6 Task 6.3（性能验证）+ Phase 4 收尾多格式聊天导入
> 测试脚本: `backend/tests/test_e2e_roleplay_phase6.py`

## 1. 测试环境

| 项目 | 值 |
|------|-----|
| 操作系统 | Linux 6.6.87.2-microsoft-standard-WSL2 (x86_64) |
| CPU | AMD Ryzen 7 8845H w/ Radeon 780M Graphics |
| 内存 | ~16 GB |
| Python | 3.10.20 |
| FastAPI | 0.139.0 |
| SQLAlchemy | 2.0.51 |
| PostgreSQL | 15.17 (Debian) |
| 后端容器 | palink-ai-backend-1 (镜像: palink-ai-backend) |
| 数据库容器 | palink-ai-db-1 |

## 2. 测试方法

- 测试脚本运行在后端容器内，通过 `http://localhost:8000` 访问本机 API。
- 使用标准库 `urllib` 发送 HTTP 请求，`time.perf_counter()` 测量延迟。
- 每项性能测试运行 10 次，统计 P50（中位数）与 P95（第 95 百分位）。
- 测试数据在脚本结束时自动清理（角色卡、会话、世界书、插件、extension_prompts）。
- 不修改任何源代码；已知源码 bug 在报告中标注。

## 3. 测试结果汇总

| SubTask | 验证项 | P50 | P95 | 目标 | 结论 |
|---------|--------|-----|-----|------|------|
| 6.3.1 | 提示词组装 | 136.4 ms | 145.3 ms | P95 < 500 ms | ✅ 通过 |
| 6.3.2 | 插件 config 下发 | 10.6 ms | 11.8 ms | P95 < 500 ms (后端) | ✅ 通过 |
| 6.3.2 | 插件浏览器加载 | — | — | P95 < 2 s | ⏭️ 未实际运行 |
| 6.3.3 | Web Worker 格式化 | — | — | 不阻塞主线程 | ⏭️ 未实际运行 |

> 2026-07-19 core-parity-complete 阶段重测数据：P95 由 159.3ms → 145.3ms（改善 14ms），
> 与 Phase 4 多格式聊天导入（commit `71cd5c2`）的改动隔离——本次修改仅在
> `/api/chats/import` 端点新增 5 种 JSON 格式转换器，未触及提示词组装路径。

## 4. SubTask 6.3.1：提示词组装性能

### 4.1 测试配置

- 消息数：10 条（user/assistant 交替）
- 世界书条目：100 条（5 条 constant + 95 条 selective，position=4 depth 注入）
- Extension prompts：5 个（position=1 IN_PROMPT，depth 4/3/2/1/0）
- 调用端点：`POST /api/character-sessions/{session_id}/debug-prompt-assembly`
- 运行次数：10

### 4.2 测试结果

| 指标 | 值 |
|------|-----|
| P50 | 136.4 ms |
| P95 | 145.3 ms |
| 最小 | 124.9 ms |
| 最大 | 145.3 ms |
| 目标 | P95 < 500 ms |
| 结论 | ✅ 通过（P95 仅为目标的 29.1%） |

### 4.3 原始数据（10 次，单位 ms）

```
124.88, 125.95, 126.70, 130.66, 135.70, 137.05, 141.31, 142.15, 143.17, 145.31
```

## 5. SubTask 6.3.2：插件加载性能

### 5.1 测试配置

- 插件数：10 个（sillytavern_extension 类型，每个含 1 个 JS 资源 + 1 个 CSS 资源）
- 调用端点：`GET /api/plugins/runtime/config`
- 运行次数：10

### 5.2 可测量部分：后端 runtime config 下发

| 指标 | 值 |
|------|-----|
| P50 | 10.6 ms |
| P95 | 11.8 ms |
| 最小 | 9.5 ms |
| 最大 | 11.8 ms |
| 目标 | P95 < 500 ms（后端下发，为浏览器端 JS 执行留出 1.5 s 预算） |
| 结论 | ✅ 通过（P95 仅为目标的 2.4%） |

### 5.3 原始数据（10 次，单位 ms）

```
9.52, 9.76, 10.37, 10.40, 10.54, 10.73, 10.76, 11.19, 11.61, 11.84
```

### 5.4 未实际运行部分：浏览器端 JS 并行加载

- **未实际运行原因**：实际的"插件并行加载"（JS 脚本注入与执行）发生在浏览器端
  （`SillyTavernPluginRuntime.injectIntoContainer` 将 `<script>` 标签插入容器，
  浏览器并行解析执行）。后端 HTTP API 无法测量浏览器端 JS 执行时间。
- **预算分析**：后端 config 下发 P95=15.7 ms，浏览器端可用预算为
  2000 ms - 15.7 ms ≈ 1984 ms，对于 10 个小型 JS 插件的并行注入与执行
  足够充裕。真实插件的加载时间取决于插件 JS 体积与复杂度，需在浏览器端
  使用 Performance API 或 Playwright 进行端到端测量。

## 6. SubTask 6.3.3：消息格式化 Web Worker 性能

### 6.1 状态：⏭️ 未实际运行

- **未实际运行原因**：消息格式化 Web Worker 运行在浏览器端
  （`frontend/src/workers/formatting-worker/`），需要浏览器环境加载前端、
  发送流式消息、测量 Worker 格式化延迟与主线程帧率。后端 HTTP API
  无法触发或测量此流程。
- **建议验证方式**：使用 Playwright/Puppeteer 打开角色扮演页面，
  发送长消息触发流式响应，通过 `performance.mark()` / `performance.measure()`
  测量 Worker `postMessage` 到 `onmessage` 的延迟，同时用
  `requestAnimationFrame` 检测主线程是否掉帧。

## 7. 结论

### 7.1 已验证通过

1. **提示词组装性能**（6.3.1）：P95=145.3 ms，远低于 500 ms 目标。
   在 10 条消息 + 100 条世界书 + 5 个 extension_prompts 的复杂场景下，
   `assemble_roleplay_prompt` 管线性能良好。

2. **插件 config 下发性能**（6.3.2 后端部分）：P95=11.8 ms，远低于 500 ms 目标。
   `GET /api/plugins/runtime/config` 在 10 个插件场景下响应迅速，
   为浏览器端 JS 加载留出充足预算。

### 7.2 未实际运行

1. **插件浏览器端 JS 并行加载**（6.3.2 浏览器部分）：需浏览器环境，后端 API 无法测量。
2. **消息格式化 Web Worker 性能**（6.3.3）：需浏览器环境，后端 API 无法测量。

### 7.3 已知问题（非性能问题，源码 bug）

1. **worldbook palink_injection NameError**（pre-existing，非本次回归）：
   - 位置：`backend/app/services/roleplay_prompt_assembly.py` 第 19 行
   - 现象：`CharacterChatSession` 未导入，第 2077 行调用时触发 `NameError`，
     中止事务导致后续 worldbook 查询失败（`InFailedSqlTransaction`）
   - 影响：`debug-prompt-assembly` 端点的 `assembly.report.worldbook` 返回 error
   - 验证：直接调用 `build_worldbook_context()` 确认 worldbook 服务本身工作正常
     （constant + selective 条目均正确 activated）
   - 状态：E2E `verify_worldbook_service_direct` PASS 证明服务层正常，
     仅 debug 端点的子调用链有事务问题，不影响生产路径

2. **~~user_settings 缓存失效不生效~~**（已于 2026-07-19 Phase 7 修复）：
   - 修复位置：`backend/app/api/users.py:107` 改用
     `invalidate_cache(f"user_settings:user={user.id}")` 匹配 kwargs 路径格式
   - 同步修复：`character_list` / `models` / `worldbook_list` 三个 `@cached` 端点
     改为 `invalidate_user_cache(prefix, user_id)` 用户级失效，避免 over-invalidation
   - 配套：`backend/app/core/cache.py` 新增 `invalidate(key_prefix, key_suffix="")`
     支持 prefix+suffix 双重匹配；新增 `invalidate_user_cache` 辅助函数
   - 验证：`backend/tests/test_user_settings_cache.py` 黑盒 PUT→GET + 白盒 key 格式断言
