# 双运行时 ST 兼容架构策略（dual-frontend-st-compat-strategy）

> 状态：规划中（已按代码现状校准）
> 创建日期：2026-07-17
> 关联文档：`checklist.md`（验收清单）、`tasks.md`（任务拆解）、`../../../SILLYTAVERN_NATIVE_LAYER_PLAN.md`（原生层落地计划）、`../../../SILLYTAVERN_INTEGRATION_ANALYSIS.md`（差距分析）

---

## 0. 一句话定位

Palink 是**单前端、双运行时模式**架构：在同一个 `frontend/` 应用内，通过 `CharacterChat.tsx` 模式切换提供「iframe ST 兼容模式」与「原生 React 模式」。ST 兼容能力**长期目标**是收敛到单一可禁用边界，新增兼容一律按 ST 公开规范独立实现，存量移植代码按阶段替换。

---

## 1. 现状基线（已核对代码）

本 spec 的所有路径与端点均以下列代码事实为准：

### 1.1 前端（单一应用：`frontend/`，Vite + React + Tailwind）

| 类别 | 真实位置 | 说明 |
| --- | --- | --- |
| ST 兼容运行时 | `frontend/src/lib/sillytavern/runtime.ts` | `SillyTavernRuntime`，含基础事件/斜杠命令/变量 |
| 消息格式化 | `frontend/src/lib/sillytavern/formatting.ts`（431 行） | messageFormatter，当前主线程执行 |
| 宏系统 | `frontend/src/lib/sillytavern/macros/` | 仅 15 个基础宏，缺完整解析器 |
| 正则引擎 | `frontend/src/lib/sillytavern/regex/engine.ts`（368 行） | **已含 LRU 缓存**，仅缺预设管理 |
| getContext 门面 | `frontend/src/lib/sillytavern/getContext.ts` | ST 扩展 API 兼容门面 |
| iframe 兼容组件 | `frontend/src/components/sillytavern/SillyTavernIframe.tsx` | SmartCard iframe 模式，已用 postMessage |
| 角色卡渲染 | `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | 已用 postMessage |
| 模式切换入口 | `frontend/src/components/views/character/CharacterChat.tsx`（2,737 行） | 兼容模式 / 原生模式切换点 |

> 注意：顶层 `src/` 目录是历史残留垃圾文件，**不是前端源码**。真前端是 `frontend/src/`。

### 1.2 后端 ST 兼容（分散在多文件，未隔离）

- `backend/app/api/silly_tavern.py`（1,289 行，19 端点）
- `backend/app/api/st_groups.py`（群聊，对应 ST `group-chats.js`）
- `backend/app/api/st_resources.py`（ST 资源）
- `backend/app/api/st_sync.py`（同步）
- 角色列表端点：`GET /api/characters`（`backend/app/api/character.py:49`，前缀 `/api/characters` + `@router.get("")`）
  - **已有 `@cached(ttl_seconds=30)` 缓存**
  - **一次性返回全字段**：description / personality / scenario / first_mes / mes_example / system_prompt / creator_notes / post_history_instructions / alternate_greetings / tags / extensions / preset_data / ui_config …（无分页、无大字段裁剪）

### 1.3 历史包袱

- 仓库内含完整 `SillyTavern-1.18.0/` 源码副本。
- `SILLYTAVERN_INTEGRATION_ANALYSIS.md`（2026-06-12）明确列出了从 ST 源码「可直接移植的代码」清单（macros / world-info / slash-commands / variables / group-chats 等）。
- 即：**现状是「公开规范实现 + 移植代码」混合**，不是纯接口兼容。

---

## 2. 核心认知纠偏（重写为诚实表述）

| 旧误区 | 事实校准 |
| --- | --- |
| Palink 纯粹基于 ST 公开规范实现 | 现状为混合：含公开规范实现，也含从 ST 源码移植的代码；仓库存有 ST 1.18.0 源码副本 |
| 「双前端并行」= 两个独立前端应用 | 实为**单前端 + 双运行时模式**（iframe 兼容模式 / 原生模式），靠 `CharacterChat.tsx` 切换 |
| ST 兼容代码隔离在 `src/st-compat/` | 该路径不存在；真实分散在 `frontend/src/lib/sillytavern/` + 后端 `silly_tavern*.py` 多文件 |
| 兼容层已可独立启用/禁用 | 目前未做开关化；需在阶段三建立边界与开关 |

**原则（今后执行准绳）**：

1. **新增合规**：今后新增 ST 兼容能力一律按 ST 公开规范（角色卡数据结构 / API 契约 / 渲染语义）独立实现，不再从 ST 源码移植。
2. **存量收敛**：把散落的兼容代码逐步收敛到 `frontend/src/lib/sillytavern/`（前端）+ `backend/app/api/silly_tavern*.py`（后端）单一边界，外部仅依赖公共接口。
3. **单前端双模式**：原生模式作为 iframe 兼容模式的**新选项**并存（与 `SILLYTAVERN_NATIVE_LAYER_PLAN.md` 一致），不另起第二个前端应用。
4. **可禁用**：兼容层最终可整体开关，关闭后原生模式不受影响。

---

## 3. 架构策略

### 3.1 单前端双运行时

```
                ┌──────────────────────────────────────┐
                │           Palink 后端 API             │
                │  (单一数据源 / 单一契约 / WebSocket)   │
                └──────────────────┬───────────────────┘
                                   │
                ┌──────────────────┴───────────────────┐
                │        单一前端 frontend/             │
                │  CharacterChat.tsx ── 模式切换 ──┐    │
                │                                  │    │
                │   ┌──────────────────┐  ┌────────▼──────────┐
                │   │ iframe ST 兼容模式 │  │  原生 React 模式   │
                │   │ lib/sillytavern/  │  │  lib/(event-bus/  │
                │   │ SillyTavernIframe │  │  macro/slash/...) │
                │   │ (短期优化)        │  │  services/*        │
                │   └──────────────────┘  │  components/roleplay│
                │                         │  (中期新建)         │
                │                         └────────────────────┘
                └──────────────────────────────────────┘
```

- **iframe 兼容模式（短期）**：承接现有 ST 接口形态与 iframe 能力，聚焦性能与渲染保真，存量用户无感。
- **原生模式（中期）**：按 `SILLYTAVERN_NATIVE_LAYER_PLAN.md` 在 `frontend/src/lib/`（event-bus / macro-engine / slash-engine / variables / regex-pipeline …）+ `frontend/src/services/` + `frontend/src/components/roleplay/` 新建原生层，不依赖 ST jQuery/FontAwesome。
- 两模式**共享同一后端**与同一应用状态，通过事件总线 + 共享 services 保持一致（非"两个前端各自持久化"）。

### 3.2 兼容层边界与隔离

- 前端边界：`frontend/src/lib/sillytavern/` + `frontend/src/components/sillytavern/`。
- 后端边界：`backend/app/api/silly_tavern*.py`（`silly_tavern` / `st_groups` / `st_resources` / `st_sync`）。
- 阶段三为该边界引入运行时开关，外部禁止反向依赖其内部实现。

---

## 4. 三阶段实施计划

### 阶段一（短期）：iframe 兼容模式性能优化

目标：在不改变兼容语义前提下消除存量瓶颈。**注意以下均基于已核对的真实端点/文件。**

- **1.1 角色列表分页 + 大字段裁剪**
  - 端点为 `GET /api/characters`（**非** `/api/characters/all`），已有 `@cached(ttl_seconds=30)`。
  - 新增 `page` / `page_size` 查询参数；列表响应裁剪 `description` / `mes_example` / `creator_notes` / `post_history_instructions` 等大字段，改为按需 `GET /api/characters/{id}` 拉取完整卡。
  - 注意保留现有 30s 缓存键策略，避免缓存与分页冲突（缓存键需含分页参数）。
  - 验收：100+ 角色列表加载 < 1s。
- **1.2 正则预编译缓存（补强，非从零）**
  - 前端 `regex/engine.ts` 已有 LRU 缓存，**本项补的是**：后端加载 ST 设置时预编译正则并缓存、前端缓存命中策略与失效广播。
  - 验收：重复渲染命中缓存、无重复编译开销。
- **1.3 消息格式化移入 Web Worker**
  - 迁移源：`frontend/src/lib/sillytavern/formatting.ts`（当前主线程）。
  - 项目已有 postMessage 通道（`SillyTavernIframe.tsx` / `CharacterCardRenderer.tsx` / `SillyTavernCompatRuntime.ts`），评估复用 vs 新建专用 worker。
  - 支持流式增量格式化，长消息渲染不阻塞主线程。
- **1.4 ST 格式角色卡渲染适配**
  - 参考 ST 公开角色卡渲染规范，在 Palink 前端实现兼容渲染器（HTML/表格/面板）。
  - 现有 iframe 功能不受影响；复杂交互走轻量插件。

### 阶段二（中期）：原生模式开发

目标：建立不依赖 ST 技术栈的原生层。**与 `SILLYTAVERN_NATIVE_LAYER_PLAN.md` 对齐，避免重复造轮子。**

- **2.1 原生基础设施层**：`frontend/src/lib/` 下新建 event-bus / macro-engine（Chevrotain）/ slash-engine / variables / regex-pipeline / preset-manager / plugin-system / popup-system。
- **2.2 原生应用服务层**：`frontend/src/services/` 下 message-manager / generation-engine / prompt-injection / group-chat / worldbook-engine。
  - ⚠️ 后端 `prompt_manager.py` / `personas.py` / `st_groups.py` **已存在**，本阶段重点是前端原生 UI 与 service 编排，非新建后端。
- **2.3 原生角色卡格式 + 提示词装配可视化**
  - 定义 Palink 原生角色卡格式（兼容 ST V2/V3 字段）+ 双向转换器。
  - 提示词装配可视化（调试用），不依赖 ST prompt manager UI。

### 阶段三（长期）：双模式互通 + 兼容层解耦

- **3.1 双模式数据互通**
  - iframe 兼容模式 ↔ 原生模式经同一后端 + 事件总线保持一致；WebSocket 事件双模式广播。
  - 验收：iframe 内编辑 → 原生模式即时可见。
- **3.2 兼容层边界化与可禁用**
  - 兼容代码收敛到 §3.2 边界；引入运行时开关，可独立禁用 ST 兼容模式，原生模式不受影响。
  - 为最终移除兼容层留出退路。

---

## 5. 验收标准（摘要，详见 checklist.md）

- 阶段一：`GET /api/characters` 分页 < 1s、大字段裁剪、Worker 不阻塞主线程、ST 角色卡正常渲染、iframe 不受影响。
- 阶段二：原生模式独立可用、原生/ST 格式无损互转、脱离 ST 技术栈、不重复实现已有后端（prompt_manager/personas/st_groups）。
- 阶段三：双模式数据实时同步、兼容层可独立禁用、WebSocket 双模式广播正常。

---

## 6. 风险与回退

- **兼容语义漂移**：新增能力须有 ST 公开规范依据，禁止复制实现细节。
- **缓存与分页冲突**：1.1 须把分页参数纳入 `@cached` 键，否则会返回错页。
- **双模式状态分裂**：阶段三前禁止任一模式各自持久化，写操作必经同一后端。
- **与原生层计划重复**：阶段二须严格对照 `SILLYTAVERN_NATIVE_LAYER_PLAN.md` 的文件清单，避免重复造轮子。
- **兼容层无法退场**：从阶段一即冻结兼容层边界，禁止原生代码反向依赖 `lib/sillytavern/` 内部。

---

## 7. 关联文档

- `SILLYTAVERN_NATIVE_LAYER_PLAN.md`：原生层文件清单与工期（阶段二依据）。
- `SILLYTAVERN_INTEGRATION_ANALYSIS.md`：ST 差距分析（功能完整度参照）。
- 同目录 `sillytavern-card-full-spec`：ST 角色卡公开规范参考。
- 同目录 `align-st-html-rendering-faithful` / `align-st-rendering-deep`：渲染保真对齐。
- 同目录 `backend-st-native-gap-audit` / `st-parity-*` 系列：后端兼容差距审计。
