# SCEP：角色扮演弱网/渲染性能优化（缓存、预加载与渲染修复）

> 项目：Palink-AI（SillyTavern 兼容前端）
> 文档类型：Software Change Execution Plan（变更执行计划）
> 编写日期：2026-08-14
> 关联文档：`docs/performance-improvements-spec.md`（既有性能审计，本文档为其角色扮演场景的落地方案）
> 状态：待执行（已完成全量代码审计）

---

## 0. 一句话目标

修复角色扮演场景在**弱网环境下的四个系统性体验问题**：① 角色卡列表偶发"完全不加载、只显示添加新卡，上传/刷新都无效"；② 每次进入对话都要等很久（含插件渲染的角色信息面板）；③ 面板字体每次都是"先系统默认、再逐个蹦出来"；④ 上下滑动疯狂掉帧、输入延迟。核心手段：**API 层加超时/重试/失败态、进入聊天的读接口加缓存、消息列表修复 memo 失效、智能卡字体 CORS 与预取修复、后端高频接口加缓存与 SQL 裁剪**。

---

## 1. 背景与现状

### 1.1 用户的核心体验反馈（已确认）

> 「在弱网环境，角色卡有几率直接不加载，一个都不显示，爆出『添加新卡』；上传了也没用，刷新了也不显示。」
> 「每一次进入对话都要等很长很长时间，插件渲染的前端页面（角色信息面板）也要等很久，插件显示也要等很久。」
> 「角色面板里的字体，先显示系统默认字体，然后一个字一个字加载出指定字体。」
> 「上下滑动页面帧率疯狂往下掉，输入还有延迟。」
> 「**不是首次加载这样，是每次加载都这样。**」

最后一句是关键约束：所有问题都是**系统性的、每次请求都会复现**，而非冷启动预热问题。据此反推，慢的根因必然是「每次请求都会执行的固定开销」或「缓存每次都失效/失败」。

### 1.2 已完成的既有工作（勿重复/勿破坏）

- `frontend/src/services/api.ts` 已有**内存 TTL 缓存**（`_cache` + `cacheTtlMs`）+ **in-flight 去重**（`_inflight`）+ **代次失效**（`_cacheGeneration`，防 stale set race），但**只有显式传 `cacheTtlMs` 的 GET 才会缓存**，目前仅约 5 处使用。
- 后端 `backend/app/core/cache.py` 已有线程安全 `TTLCache`（`max_size=500`、代次机制），但 `@cached` 仅 4 处使用（character_list 30s / models 5s / user_settings 30s / worldbook_list 15s）。
- 智能卡面板已有较完整的资源预取体系（`smart-card-runtime/`：resourcePlan、DNS-prefetch、`<link rel="preload">`、warmup `force-cache`、磁盘缓存 + `Cache-Control: private, max-age=86400`）。
- `useCharacterChat.ts` 流式更新已有 rAF 节流（`scheduleStreamUpdate`）。
- `performance-improvements-spec.md` 已列出 P0-01/P0-02/P1-01/P1-02 等前端问题，但**只覆盖 `ChatViewDesktop`/`useChatView`，角色扮演侧（`CharacterChat.tsx`）的同款问题尚未修复**。

### 1.3 未完成（本 SCEP 主线）

弱网下角色扮演的**全链路可靠性 + 性能**修复，覆盖前端 API 层、消息列表渲染、智能卡面板/字体、后端接口四个层面（详见 §3 与 §4）。

---

## 2. 为什么这么做（动机与约束）

### 2.1 用户约束（最高优先级，来自用户规则与对话）

- 不明确指定修改某段代码时，不修改、保留原样；每次改动需与用户要求直接相关，不影响其他功能/UI。
- 每次修改后需重新创建容器验证生效；每次较大版本更新前自动备份。
- 不得引入新问题；改动要**最小侵入**。
- 本 SCEP 为执行蓝图，**每一项改动都需要用户确认后按阶段逐步实施**，每阶段独立验证、可回滚。

### 2.2 为什么「每次加载都慢」是系统性根因，而非网络抖动

调研确认（详见 §4 证据）：

1. **前端 API 层无超时/无重试**：`request()` 的 `fetch` 无 AbortController 超时，弱网下请求要么无限挂起、要么失败即放弃；失败后 UI 无错误态、无重试入口 → 列表"不加载"**每次都可能复现**。
2. **`_inflight` 挂起 promise 阻塞**：首请求挂起不 settle 时，后续同 key 调用复用同一挂起 promise → **一直不显示**。
3. **进入聊天 6~7 个读接口全部无缓存**：detail / sessions / worldbook / messages / memory / branches / branch-tree，前端内存缓存未启用、后端 `@cached` 未覆盖 → **每次进入都全量网络往返**。
4. **智能卡字体在生产环境 CORS 失败**：`iframe-js` 沙箱（`sandbox="allow-scripts"`，opaque origin）下字体请求带 `Origin: null`，后端 `CORS_ORIGINS` 为显式域名列表时**不返回 `Access-Control-Allow-Origin`** → 字体请求失败、浏览器不缓存失败 → **每次 srcDoc 重建都重新请求字体**，配合 `font-display: swap` 呈现"先默认字体、再逐个换字"。
5. **消息列表 memo 全部失效**：每条消息传内联箭头函数 `onRegenerate`/`onEdit`，父组件任何重渲染（输入、滚动、流式、sessionVariables 更新）都让**全部消息全量重渲染**（含 MarkdownRenderer + 部分 iframe）→ **滚动掉帧、输入延迟每次都在**。
6. **后端每次请求的固定开销**：worldbook 每次聊天请求全量加载全部条目（含 `content` 大字段）+ 关键词扫描 + 逐个 tokenizer encode；`get_character` 详情无缓存 + 6 次 `json.loads` + 整卡 sha256；`get_characters` `fields=basic` 是"伪裁剪"（SQL 全列 SELECT、无 LIMIT、每角色 5 次 `json.loads` 后丢弃）；无 branch 的 messages / branch-tree 全量加载会话消息。

### 2.3 为什么「字体」问题优先修 CORS 而非"加预加载"

- 调研确认资源 URL **确定性、无 cache-busting**（`variant` 恒为 `ui`），resourcePlan 有 LRU 缓存，srcDoc 只有内容变化才重建，后端磁盘缓存 + `max-age=86400` 均生效。
- 因此「每次字体都重新加载」**唯一成立路径**就是生产环境 opaque sandbox 下的字体 **CORS 失败**（失败请求不入浏览器缓存）。
- 修 CORS（后端对 `Origin: null` 字体响应补 `ACAO`）后，字体请求成功入缓存 → 之后每次重建都命中缓存 → 从根上消除"每次重新下载"。这是**后端一行头**的成本，收益最大。

---

## 3. 要做什么（范围）

### 3.1 In Scope

| 编号 | 层面 | 内容 | 优先级 |
|------|------|------|--------|
| F-A1 | 前端 API | `request()` 增加超时（15s AbortController）+ GET 幂等请求自动重试（1~2 次、指数退避） | P0 |
| F-A2 | 前端 API | `_inflight` 挂起保护：超时/失败时确保 `_inflight` 被清理，避免挂起 promise 阻塞后续同 key 请求 | P0 |
| F-A3 | 前端列表 | 角色列表加载**失败态**：区分"无角色"与"加载失败"，失败显示错误提示 + 手动重试按钮 | P0 |
| F-A4 | 前端进入链 | `handleStartChat` 中读接口并发化 + 加 `cacheTtlMs`：角色详情 30s、sessions 30s、worldbook list 60s、首屏 messages 10s、memory stats 30s、branch-tree 60s（CRUD 后按现有 `invalidateCache` 失效） | P0 |
| F-B1 | 前端渲染 | 消息列表**稳定回调**：`onRegenerate`/`onEdit`/`onGenerateImage` 改为 useCallback 包装（依赖 `idx` 或改事件委托 data-attribute），恢复 `Message` memo 生效 | P0 |
| F-B2 | 前端渲染 | 智能卡 iframe **视口懒加载**：`IntersectionObserver` 进入视口才挂载 iframe（长对话多条智能卡时显著降低滚动开销） | P1 |
| F-C1 | 后端智能卡 | `smart_card_assets.py` 对 `Origin: null`（opaque sandbox）的**字体响应补充 `Access-Control-Allow-Origin`**，使字体请求成功并入浏览器缓存 | P0 |
| F-C2 | 前端智能卡 | 资源计划提高**字体 preload 优先级**：放宽 `SMART_CARD_HIGH_FONT_LIMIT`（当前=1，仅 1 个字体高优）或对面板关键字体首帧 preload | P1 |
| B-D1 | 后端缓存 | `get_character` 详情加 `@cached(ttl_seconds=30, key_prefix="character_detail")`，`update_character` 时失效 | P0 |
| B-D2 | 后端缓存 | worldbook **候选条目池**缓存：`build_worldbook_context` 的 6 次查询 + 全量条目加载按 `(user_id, session_id, character_id)` 做 15~30s 内存缓存 | P1 |
| B-D3 | 后端 SQL | `get_characters` `fields=basic` 时 **SQL 列裁剪**（只 SELECT 轻量列）+ SQL `LIMIT` 分页，消除缓存未命中时的全列全表开销 | P1 |
| B-D4 | 后端 SQL | 无 branch 回退路径的 messages、branch-tree 改为 SQL `ORDER BY DESC LIMIT` 而非 Python 全量截断 | P1 |
| B-D5 | 后端 SQL | `check_frozen_branches` 循环内 COUNT 合并进 GROUP BY（消除 N+1） | P2 |

### 3.2 Out of Scope（本次不做）

- 不做 Service Worker / IndexedDB 持久化缓存（大工程，标为后续独立 SCEP）。
- 不做消息列表完整虚拟化（react-window 等）——改动面大、与现有智能卡/混合删除交互耦合深；先以 F-B1 恢复 memo + F-B2 iframe 懒加载缓解，效果不足再单独立项。
- 不改 `performance-improvements-spec.md` 中与角色扮演无关的项（KaTeX 字体、CSS 去重等）。
- 不碰 `st-compat`/`st-native` 模式（按 AGENTS.md 约定，palink-native 唯一维护）。
- 不实现 worldbook 扫描结果整体缓存（依赖会话内最近消息，不能整体缓存；只缓存"候选条目池"）。

---

## 4. 方案设计（核心架构）

### 4.1 总览：问题 → 根因 → 修复 映射表

```
症状                                     根因（证据行号）                                    修复
─────────────────────────────────────────────────────────────────────────────────────────
① 角色卡列表偶发不加载/上传刷新无效    request() 无超时无重试 + 失败无错误态无重试入口       F-A1/F-A2/F-A3
                                      + _inflight 挂起 promise 阻塞
② 进入对话/插件面板很慢（每次）        6~7 个读接口无缓存 + 串行 + 面板 runtime config       F-A4 + B-D1/B-D2
                                      首次等网络 + 后端每次固定开销（worldbook 全量）
③ 面板字体先默认后逐个换字（每次）     iframe opaque sandbox 字体 CORS 失败→不入缓存          F-C1/F-C2
                                      + font-display:swap + 字体 preload 仅 1 个
④ 滚动掉帧 + 输入延迟（每次）          onRegenerate/onEdit 内联箭头→memo 全失效             F-B1/F-B2
                                      →全部消息全量重渲染（含 iframe）+ 无虚拟化
```

### 4.2 F-A1/F-A2：API 层超时与重试（`frontend/src/services/api.ts`）

```typescript
// request() 内：包一层带超时的 fetch
const controller = new AbortController();
const timeoutId = window.setTimeout(() => controller.abort(), RETRY_TIMEOUT_MS /* 15_000 */);
try {
  const res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
  ...
} finally { clearTimeout(timeoutId); }
```

- 重试仅对 **GET 且非 AbortError 的用户主动取消**场景：网络错误（TypeError）或 5xx 时重试，最多 `MAX_RETRIES = 2`，退避 `500ms * 2^attempt`。
- **不做**：对 4xx（含 401）重试；对 `options.signal` 已由调用方提供的请求重试（尊重调用方取消语义）。
- `_inflight`：在 promise `finally` 中已删除条目（现有逻辑），超时 abort 后 promise reject → finally 执行 → 挂起阻塞自然解除；再叠加"超时后删除 inflight"的显式保护，防止任何遗漏路径。
- 新增 `Retry-After` 尊重（可选）：若响应 429/503 且带 `Retry-After`，按该值等待。

### 4.3 F-A3：角色列表失败态（`CharacterView.tsx` + `CharacterList.tsx`）

- `loadCharacters` 增加 `loadError` state：catch 时 `setLoadError(true)`，成功时 `setLoadError(false)`。
- `CharacterList` 增加 `loadFailed` + `onRetry` props：
  - `loadFailed && characters.length === 0` → 渲染"加载失败"卡片（区别于"暂无角色"）：提示 + 「重试」按钮（调用 `onRetry`）。
  - 空状态仅在"请求成功但确实无角色"时显示"暂无角色"。
- `onRetry` = `loadCharacters`（先 `invalidateCache('/api/characters')` 强制刷新，避免命中 30s 缓存中的空结果）。

### 4.4 F-A4：进入聊天读接口缓存与并发化（`CharacterView.tsx`）

- `handleStartChat`：
  - `api.get('/api/characters/${character.id}', { cacheTtlMs: 30_000 })`（角色详情，CRUD 后现有 `invalidateCache('/api/characters')` 已覆盖失效）。
  - `loadSessions`：`api.get(..., { cacheTtlMs: 30_000 })`；新建/删除会话后 `invalidateCache('/api/characters/${id}/sessions')`。
  - `loadMessages` 首屏 `limit=10`：`{ cacheTtlMs: 10_000 }`（短 TTL，兼顾"重新进入秒开"与"新消息不 stale"）。
  - `loadMemoryStats` / branches / branch-tree：`{ cacheTtlMs: 30_000 }`，切换分支/发送消息后调用方已有刷新动作。
  - `handleStartChat` 内 detail 与 sessions 改为 `Promise.all` 并行。
- 注意：`api.get` 的缓存是**内存级**，刷新页面即失效——F-A4 解决的是**会话内重复进入/切角色**的重复往返，配合 B-D1/B-D2 后端缓存解决"刷新后每次都要等"。

### 4.5 F-B1：消息列表稳定回调（`CharacterChat.tsx`）

- 用 `useCallback` 包裹按索引操作的处理器，避免每条消息创建新闭包：
  - `const handleRegenerateAt = useCallback((idx: number) => { ... }, [wrappedHandleRegenerate])` → `onRegenerate={handleRegenerateAt}`（`Message` 内改用 `onRegenerate()` 直接调用，不需要参数）。
  - 同理 `handleEditAt = useCallback((id, idx) => (newContent) => handleEditMessage(id, idx, newContent), [...])`。
  - `onGenerateImage` / `onToggleWholeMessageSelect` / `onToggleMessagePartSelect` / `onSelectAllPartsInMessage` 等：若当前实现是内联箭头，同样收敛为 useCallback（**只收敛，不改变语义**）。
- 收益：`Message` 的自定义 memo 比较器（`Message.tsx` L1383-1389 比较 `onRegenerate`/`onEdit` 引用）重新生效 → 父组件无关重渲染不再级联全部消息。

### 4.6 F-B2：智能卡 iframe 视口懒加载（`CharacterCardRenderer.tsx`）

- 在消息列表中的智能卡渲染处用 `IntersectionObserver`（或已有滚动容器复用）：**进入视口前渲染轻量占位**，进入视口后再挂载 `CharacterCardRenderer`。
- 只对**非最后一条 / 非全屏**的智能卡做懒加载；当前正在生成的最后一条始终立即渲染。
- 复用既有 `Message.tsx` 中对未完成 HTML 的轻量占位逻辑（L1096 附近），避免"未完成 → iframe 突变"抖动。

### 4.7 F-C1：智能卡字体 CORS 修复（`backend/app/api/smart_card_assets.py`）

- 在 `smart_card_assets.py` 的字体响应分支（约 L236-237 已放行 `Origin: null` 请求后），对响应头补充：
  ```python
  # 对 opaque sandbox（Origin: null）的字体请求，允许任意源读取
  if request_origin == "null":
      headers["Access-Control-Allow-Origin"] = "*"
  ```
- 仅作用于字体（`font/` 类 Content-Type）响应；图片/CSS 走 no-cors 加载不受影响。注意 `allow_credentials` 为 True 时 `ACAO: *` 与 credentials 冲突——字体请求本身不带 cookie，需确认该响应路径未设 `Access-Control-Allow-Credentials`（若有，则改为反射 `Origin: null` 而非 `*`）。
- 修复后：字体请求成功 → 浏览器私有缓存（`private, max-age=86400`）命中 → srcDoc 重建不再重新下载。

### 4.8 F-C2：字体 preload 优先级（`smart-card-runtime/resource.ts` + `shared.ts`）

- 现状：`SMART_CARD_HIGH_FONT_LIMIT = 1`，仅 1 个字体进入 high 计划，其余 `deferred`（`resource.ts` L102-104）。
- 方案：`SMART_CARD_HIGH_FONT_LIMIT` 提至 3~4（面板典型 1~3 个字体），并让 `@font-face` 主字体（CSS 中首个/被 `font-family` 引用最多的）进入首帧 `<link rel="preload" as="font">`。
- 收益：面板字体与面板首帧并行下载，弱网下"默认字体→换字"窗口缩短。

### 4.9 B-D1：角色详情后端缓存（`backend/app/api/character.py`）

- `get_character` 加 `@cached(ttl_seconds=30, key_prefix="character_detail")`；`update_character`/`delete_character`/导入解析处调用 `invalidate_user_cache("character_detail", user.id)`。
- 缓存键自动纳入 `user.id` + `character_id`（`cache.py` `_build_key`），互不串扰。

### 4.10 B-D2：worldbook 候选条目池缓存（`backend/app/services/worldbook_service.py`）

- 在 `build_worldbook_context`（L1352）中，将 **L1398-L1464 的 6 次查询 + 全量条目加载**结果按 `(user_id, session_id, character_id)` 键缓存 15~30s（复用 `TTLCache`；或按调用方特征做短 TTL）。
- **只缓存"候选条目池"**，关键词扫描/命中结果不缓存（依赖会话内最近消息）。
- 世界书条目增删改/会话关联变更时主动失效（现有 `worldbook_list` 失效点扩展或新增失效前缀）。

### 4.11 B-D3/B-D4/B-D5：后端 SQL 优化

- B-D3 `get_characters`：`fields=basic` 时按 `_CHARACTER_LIST_HEAVY_FIELDS` 清单构造 `with_entities(...)` 列裁剪；分页改为 SQL `LIMIT/OFFSET`（保留 `total` 用一次 `COUNT`）。
- B-D4：无 branch 回退路径（`character_ext.py` L2834-2851）与 branch-tree（L3729-3737）改为 `order_by(created_at.desc()).limit(n)` 后反转，避免 Python 全量截断。
- B-D5 `check_frozen_branches`：循环内 `messages_after.count()` 合并进外层 GROUP BY 聚合。

---

## 5. 后果与风险评估

### 5.1 正向后果

- 弱网下角色卡列表不再"无响应式空列表"：有错误态 + 重试入口。
- 进入对话的重复往返大幅减少：前端 TTL 缓存（会话内）+ 后端缓存（跨刷新）。
- 字体"每次重新下载"根因（CORS）消除，配合 preload 优先级提升，换字窗口缩短。
- 消息列表 memo 恢复生效 → 滚动/输入期间的 CPU 与掉帧显著改善。

### 5.2 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| API 重试导致重复请求/重复写入 | 低 | 仅对 GET 幂等请求重试；POST/PUT/DELETE/PATCH 一律不重试。 |
| 超时 abort 误杀慢但正常的请求 | 低 | 超时 15s 远大于正常带宽；仅网络错误/5xx 重试，4xx 不重试；重试计数封顶 2 次。 |
| 前端缓存引入 stale 数据（聊天消息） | 中 | 首屏 messages 用短 TTL（10s）；发送/切换分支后调用方已有刷新；CRUD 后 `invalidateCache` 覆盖。 |
| `ACAO: *` 与 credentials 冲突 | 中 | 先核实字体响应是否携带 `Access-Control-Allow-Credentials`；若带则改为反射 `Origin: null` 而非 `*`。 |
| 智能卡懒加载影响"正在生成的最后一条" | 低 | 最后一条/全屏智能卡豁免懒加载，始终立即渲染。 |
| `useCallback` 收敛改变行为 | 低 | 只收敛不改变语义；Message 内回调调用签名保持一致；部署后对照原行为逐项验证。 |
| 后端缓存键粒度/失效遗漏 | 中 | 复用 `cache.py` 既有键机制；新增失效点逐一挂钩（update/delete/import/解析）；测试覆盖。 |
| 部署后 chunk hash 未更新 | 中 | 严格走 `npm run build`（宿主 frontend/）→ `docker compose restart frontend`；后端 `docker compose restart backend`；不使用单独 `docker compose build`（volume mount 遮蔽镜像层）。 |

### 5.3 非目标澄清

- 本 SCEP 不承诺"离线可用"（无 SW/IndexedDB）；目标是弱网下**每次进入更快、失败可见可重试、渲染不卡**。
- 虚拟化、Service Worker 等大项在 §3.2 明确 Out of Scope，需用户另行确认后再立项。

---

## 6. 详细执行步骤

### 阶段 0：备份基线（每次较大更新前必做）

- 对每个**即将改动**的文件，改动前复制为 `backups/scep-rp-perf/<YYYYMMDD-HHMMSS>/<相对路径>`。
- 备份目录纳入 `.gitignore` 或仅本地保留；不提交/不 stash 现有仓库 WIP。

### 阶段 1（P0）：前端 API 层 —— 超时 + 重试 + 挂起保护

- 文件：`frontend/src/services/api.ts`
- 步骤：
  1. 新增常量 `API_TIMEOUT_MS = 15000`、`API_MAX_RETRIES = 2`、退避函数。
  2. 重构 `request()`：创建 `AbortController`，合并外部 `signal`（若调用方传入，则用 `AbortSignal.any` 或监听合并）；超时 abort；`finally` 清理 timeout。
  3. GET 网络错误/5xx 时重试（注意 `_inflight` 去重逻辑与重试的相互作用：重试只发生在单个 promise 内部，`_inflight` 仍只记一个条目，避免并发出多个相同请求）。
  4. 在 `api.get` 的 `finally` 中确保 `_inflight` 删除（现有已做，补显式保护）。
- 验证：`cd frontend && npx tsc --noEmit`；`npm run build`；dev 下用 DevTools 限速模拟弱网验证"失败后自动重试、最终失败 UI 可感知"。

### 阶段 2（P0）：角色列表失败态 + 重试

- 文件：`frontend/src/components/views/CharacterView.tsx`、`frontend/src/components/views/character/CharacterList.tsx`
- 步骤：
  1. `CharacterView` 新增 `listLoadError` state；`loadCharacters` 成功/失败置位。
  2. `CharacterList` 新增 `loadFailed?: boolean`、`onRetry?: () => void` props；渲染失败态卡片（icon + 文案 + 重试按钮），区别于"暂无角色"。
  3. 重试按钮点击 → `invalidateCache('/api/characters')` + `loadCharacters()`。
- 验证：模拟后端 500 / 断网，确认列表显示失败态而非"暂无角色"；恢复网络点重试可加载。

### 阶段 3（P0）：进入聊天读接口缓存 + 并发

- 文件：`frontend/src/components/views/CharacterView.tsx`
- 步骤：按 §4.4 给各 `api.get` 加 `cacheTtlMs`；`handleStartChat` 中 detail/sessions 并行；新增会话/删除会话/切换分支处补充 `invalidateCache`。
- 验证：进入同一角色聊天两次，第二次 Network 面板中 detail/sessions/messages 命中缓存（无网络请求或 304/内存命中）；发送消息后 messages 重新拉取。

### 阶段 4（P0）：消息列表稳定回调（恢复 memo）

- 文件：`frontend/src/components/views/character/CharacterChat.tsx`
- 步骤：按 §4.5 收敛 `onRegenerate`/`onEdit`/`onGenerateImage` 等回调为 useCallback；确认 `Message.tsx` memo 比较器各字段引用稳定（含 `models`/`chatMessages`/`t`/`globalRegexScripts` 等透传引用是否稳定，必要时父层用 `useMemo` 固定）。
- 验证：React DevTools Profiler 中滚动/输入时 Message 组件不再全量重渲染（仅受影响消息）；`npx tsc --noEmit`。

### 阶段 5（P0）：智能卡字体 CORS 修复

- 文件：`backend/app/api/smart_card_assets.py`
- 步骤：
  1. 定位字体响应构造处（约 L911-921），确认当前头集合。
  2. 对 `Origin: null` 的字体请求补 `Access-Control-Allow-Origin`（`*` 或反射 `null`，取决于是否带 credentials 头）。
  3. 补单测：`backend/tests/` 模拟 opaque sandbox 字体请求，断言响应含 ACAO。
- 验证：`cd backend && python -m pytest tests/`；生产环境（CORS_ORIGINS 显式域名）下强刷后 Network 面板字体请求状态 200 且带 ACAO；二次进入命中 `from disk cache`。

### 阶段 6（P1）：后端缓存与 SQL 优化

- 文件：`backend/app/api/character.py`、`backend/app/services/worldbook_service.py`、`backend/app/api/character_ext.py`
- 步骤：按 §4.9~§4.11 依次实施 B-D1 → B-D2 → B-D3 → B-D4 → B-D5；每个小项独立验证（pytest + 手工）。
- 验证：`python -m pytest tests/` 全绿；进入聊天第二次请求时 backend 日志显示命中缓存（或 SQL 查询数下降）。

### 阶段 7（P1）：智能卡 iframe 懒加载 + 字体 preload 提权

- 文件：`frontend/src/components/views/character/CharacterChat.tsx`（或 `Message.tsx`）、`frontend/src/components/ui/custom/smart-card-runtime/shared.ts`（`SMART_CARD_HIGH_FONT_LIMIT`）
- 步骤：按 §4.6/§4.8 实施；注意最后一条智能卡豁免。
- 验证：长对话多条智能卡时滚动帧率对比（DevTools Performance 录制）；字体 Network 时间线提前。

### 阶段 8：构建、部署与回归

- `cd frontend && npx tsc --noEmit && npm run build`
- 后端：`python -m pytest tests/` 全绿。
- 部署：`docker compose restart frontend`；`docker compose restart backend`。
- 回归清单见 §8。

---

## 7. 备份与回滚策略

- **备份**：阶段 0 规定的带时间戳副本。每次 `Edit`/`Write` 前先复制。
- **回滚**：
  - 单文件：用对应时间戳备份覆盖。
  - 整轮：用 `backups/scep-rp-perf/<ts>/` 下文件覆盖工作区 + `docker compose restart` 相关容器。
- **验证点回滚**：每个阶段结束即做一次构建/测试验证，失败立即回滚该阶段文件。

---

## 8. 完成标准

1. **角色卡列表**：弱网/接口失败时显示"加载失败 + 重试"，不再误显示"暂无角色"；重试成功后列表正常。
2. **进入对话**：同一会话内重复进入，detail/sessions/worldbook/branch-tree 等读接口命中前端/后端缓存（Network 无重复请求或显著减少往返）。
3. **字体**：生产环境强刷后字体请求带 `Access-Control-Allow-Origin` 且状态 200；二次进入命中浏览器缓存；"先默认字体再逐个换字"窗口明显缩短。
4. **渲染**：滚动/输入期间消息列表不再全量重渲染（Profiler 验证）；帧率不再随滚动"疯狂往下掉"。
5. **后端**：`get_character` 详情/worldbook 条目池命中缓存；无 branch 会话与 branch-tree 不再全量加载消息；`check_frozen_branches` 无 N+1。
6. **回归**：`python -m pytest tests/` 全绿；`npx tsc --noEmit` 通过；角色聊天发送/流式/切换分支/记忆压缩/智能卡面板/世界书/剧情线功能均正常；`st-native` 模式不受影响。

---

## 9. 决策记录（Decisions）

- **D1**：API 层重试仅限 GET 幂等请求，超时 15s、最多 2 次退避重试。理由：POST/PUT/DELETE/PATCH 重试有重复写入风险；GET 重试成本低收益高（弱网瞬断场景）。
- **D2**：消息列表先修 memo（稳定回调）而非直接上虚拟化。理由：虚拟化与智能卡 iframe、混合删除、CatchUp 动画耦合深，改动面大；memo 恢复是同类问题在 ChatViewDesktop 已验证的低风险路径，可先量化收益。
- **D3**：字体问题优先修后端 CORS 而非仅加预加载。理由：调研证实资源 URL 稳定、缓存机制健全，"每次重新下载"唯一成立路径是 opaque sandbox 字体 CORS 失败导致不入缓存；修 CORS 是一行头的根治。
- **D4**：前端读接口缓存 TTL 采用"短 TTL + CRUD 后 invalidateCache"组合而非长 TTL。理由：聊天数据时效性强（消息、记忆、分支），长 TTL 会造成 stale；短 TTL + 显式失效兼顾"秒开"与"不陈旧"。
- **D5**：worldbook 只缓存"候选条目池"，不缓存关键词扫描/命中结果。理由：扫描依赖会话内最近消息动态变化，缓存扫描结果会导致世界书内容不更新。
- **D6**：后端缓存键沿用 `cache.py` 的 `_build_key`（自动纳入 user.id 与参数），失效点与 CRUD 挂钩。理由：多用户隔离正确、防 stale set race 代次机制已具备，避免引入第二套缓存体系。
- **D7**：智能卡 iframe 懒加载豁免"正在生成的最后一条"。理由：最后一条是流式重点观察对象，延迟挂载会造成"生成内容看不到"的体验断层。