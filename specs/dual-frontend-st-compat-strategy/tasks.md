# 双运行时 ST 兼容架构策略 - 任务清单

> 已按代码现状校准（2026-07-17）。真实端点 `GET /api/characters`；兼容代码在 `frontend/src/lib/sillytavern/` + 后端 `silly_tavern*.py`；单前端双模式，非双前端。

## 阶段一：iframe 兼容模式性能优化（短期）

- [ ] 1.1 角色列表分页 + 大字段裁剪
  - [ ] 端点 `GET /api/characters`（`backend/app/api/character.py:49`，已有 `@cached(ttl_seconds=30)`）新增 page/page_size
  - [ ] **缓存键纳入分页参数**，避免错页
  - [ ] 列表裁剪 description/mes_example/creator_notes/post_history_instructions 等大字段
  - [ ] 前端按需 `GET /api/characters/{id}` 拉取完整卡
  - [ ] 验证：100+ 角色时列表加载 < 1s

- [ ] 1.2 正则预编译缓存（补强，非从零）
  - [ ] 前端 `frontend/src/lib/sillytavern/regex/engine.ts`（368 行）已含 LRU 缓存，确认现状
  - [ ] 后端加载 ST 设置时预编译正则并缓存
  - [ ] 前端缓存命中策略与失效广播
  - [ ] 验证：重复渲染命中缓存、无重复编译

- [ ] 1.3 消息格式化移入 Web Worker
  - [ ] 迁移源 `frontend/src/lib/sillytavern/formatting.ts`（431 行，当前主线程）
  - [ ] 评估复用现有 postMessage 通道（SillyTavernIframe/CharacterCardRenderer/SillyTavernCompatRuntime）vs 新建专用 worker
  - [ ] 流式输出增量格式化，主线程 postMessage 异步取结果
  - [ ] 验证：长消息渲染时 UI 不卡顿

- [x] 1.4 ST 格式角色卡渲染适配
  - [x] 参考 ST 公开角色卡渲染规范
  - [x] 在 Palink 前端实现兼容渲染器（HTML/表格/面板）
  - [x] 复杂交互通过轻量插件支持，现有 iframe 功能不受影响
  - [x] 验证：ST 格式角色卡在 Palink 前端正常渲染

## 阶段二：原生模式开发（中期，对齐 SILLYTAVERN_NATIVE_LAYER_PLAN.md）

- [ ] 2.1 原生基础设施层 `frontend/src/lib/`
  - [ ] event-bus / macro-engine(Chevrotain) / slash-engine / variables / regex-pipeline / preset-manager / plugin-system / popup-system
  - [ ] 不依赖 ST jQuery/FontAwesome 技术栈

- [ ] 2.2 原生应用服务层 `frontend/src/services/`
  - [ ] message-manager / generation-engine / prompt-injection / group-chat / worldbook-engine
  - [ ] ⚠️ 后端 `prompt_manager.py` / `personas.py` / `st_groups.py` 已存在，本阶段做前端 service 编排，非新建后端

- [ ] 2.3 原生角色卡格式 + 提示词装配可视化
  - [ ] 定义 Palink 原生角色卡格式（兼容 ST V2/V3 字段）
  - [ ] 双向转换器：Palink ↔ ST 格式，验证无损互转
  - [ ] 提示词装配可视化（调试用），不依赖 ST prompt manager UI

## 阶段三：双模式互通 + 兼容层解耦（长期）

- [ ] 3.1 双模式数据互通
  - [ ] iframe 兼容模式 ↔ 原生模式经同一后端 + 事件总线同步
  - [ ] WebSocket 事件双模式广播
  - [ ] 验证：ST iframe 编辑 → 原生模式即时可见

- [ ] 3.2 兼容层边界化与可禁用
  - [ ] 兼容代码收敛到 `frontend/src/lib/sillytavern/` + `frontend/src/components/sillytavern/` + 后端 `silly_tavern*.py`
  - [ ] 明确接口边界，外部不依赖内部实现
  - [ ] 可独立启用/禁用 ST 兼容模式，原生模式不受影响
  - [ ] 为移除 ST 兼容层留出退路
