# 智能卡完全内联渲染改造 Spec（彻底对齐 ST 体验）

> 状态: **v2 已修正 + PoC 已落地（特性开关默认关闭）**
> 修订时间: 2026-08-07 深夜

---

## 修订记录 v2（审阅后修正，冲突处以本节为准）

v1 存在 3 处事实错误、5 处遗漏、1 个部署陷阱，另有 1 项影响架构的新发现。

### A. 事实错误（正文已改正）

| 编号 | v1 原文 | 事实 |
|---|---|---|
| A1 | §4.2 称「内联后 `<script>` 浏览器会自动执行」 | **错。** HTML 规范规定：经 `innerHTML` / `dangerouslySetInnerHTML` 插入的 `<script>`，其 *already started* 标志为 true，**永不执行**。唯一路径是 `document.createElement('script')` 后插入 DOM。项目自己的 `palink-smart-card.js` L486 正是这么做的 |
| A2 | §2.2 称删掉 `frame-shim/`（90KB+18KB）即可 | **漏了 299KB / 6172 行的 `SillyTavernCompatRuntime.ts`**。它同样是注入 iframe 的字符串，且承载 `stat_data` 重组等关键逻辑（L6026-6105） |
| A3 | §5 风险表未提历史事故 | `primitives.ts` L637-640 注释明确记录：**inline-html 路径曾导致 `NotFoundError: insertBefore/removeChild` 崩溃并已回滚**，`resolveHtmlRenderMode` 因此被硬编码为 `iframe-js`。这是本方案最大已知风险，必须正面处理 |

### B. 遗漏（已补入实现）

- **B1** `stat_data` 扁平→嵌套重组（`SillyTavernCompatRuntime.ts` L6026-6094）必须移植到主页面全局，否则状态栏必定全空。后端下发的是 `"桃汐.好感度"` 这类扁平复合 key，而面板读的是嵌套 `stats['桃汐']['好感度']`
- **B2** 头像 UUID 需绝对化，前缀是 **`/api/st/characters/`** 而非 `/characters/`——`nginx.conf` L192-194 明确禁止代理 `/characters/*`（那是前端 SPA 的角色详情路由）
- **B3** `<script type="module">` 必须降级为经典脚本：module 有独立作用域且被 defer，会破坏 C5 要求的多卡共享全局语义
- **B4** 流式输出会反复重渲染，**必须有一次性执行守卫**，否则卡片脚本每来一个 token 就重跑一遍
- **B5** CSP 无需改动：`nginx.conf` L73 已含 `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`，内联脚本本就放行

### C. 技术选型（用户已拍板）

| 编号 | 决策项 | 结论 |
|---|---|---|
| C1 | 特性开关 | `localStorage` flag，PoC 默认关闭，旧路径一行不删 |
| C2 | 沉浸式 launcher | 本期不动，继续走 iframe |
| C3 | 安全边界 | 放行 script，但仍禁 `iframe/object/embed/base/form` |
| C4 | **CSS scope** | **不 scope**（对齐 ST；卡片作者用 `.mes_text .xxx` 自约束） |
| C5 | **多卡作用域** | **完全对齐 ST**：不包 IIFE，共享主页面全局；重名 `const/let` 由既有 `loosenSmartCardGlobalLexicalDeclarations`（const→var）兜底 |
| C6 | 旧代码清理 | PoC 阶段不删，验证通过后单独立项 |

### D. 部署陷阱

- **D1** **禁止 `npm run build`**。它先跑 `scripts/clean-dist.cjs`，内含 `rmdirSync(dist)`，而 `dist` 是 docker bind mount（`./frontend/dist:/usr/share/nginx/html:ro`），删目录会让容器挂载失效。
  正确做法：`VITE_OUT_DIR=dist_xxx node scripts/build-vite.mjs`，再按「停容器 → 换目录 → 起容器」部署。

### E. 新发现（v1 完全未提及，影响架构）

**主页面本来就已经有半套真 ST 运行时。**
`src/utils/sillyTavernPluginRuntime.ts`（由 `CharacterChat.tsx` 装载）已挂载约 20 个全局，含
`window.SillyTavern.getContext`、`window.eventSource`（接真实事件总线 `runtime.on/off/emit`）、
`window.substituteParams`、`window.toastr`、世界书 API 等。

两点影响：

1. 主页面全局注入必须是**增强（augment）而非替换**，一律加 `typeof window.X === 'undefined'` 守卫，否则会打坏插件运行时；
2. 这反而是内联方案的**额外收益**：卡片接到的是主页面上真实存在的运行时，而 iframe 里只能拿到一份仿制品。比 v1 设想的方案更贴近 C5 的「完全对齐 ST」。

---

> 原始状态: DRAFT — 待其他 agent 接手执行
> 原始生成时间: 2026-08-07
> 背景: iframe 沙箱方案（CharacterCardRenderer + 手写 ST 兼容 shim）反复出现高度截断/抖动/资源加载问题，用户确认**放弃沙箱隔离，改为像 SillyTavern 一样完全内联渲染**，换取 100% ST 一致的浏览器自然排版体验。
> 用户明确约束: 卡片 JS 必须保留执行；插件功能（Galgame/Tavern Helper）绝不能受影响。

---

## 0. 核心决策（用户已确认，勿再推翻）

| 决策项 | 结论 |
|---|---|
| 渲染架构 | **完全内联**：智能卡 HTML 直接 `dangerouslySetInnerHTML` 进 `.mes_text`，删掉 iframe |
| 沙箱隔离 | **放弃**（用户接受单用户信任模型：卡片脚本在页面内直接执行） |
| 卡片 JS | **必须保留执行**（这是与 `sanitizeStCompatHtml` 的根本冲突点，见 §4.1） |
| 插件兼容 | **绝不能破坏**（Galgame 读 `.mes_text`、Tavern Helper 读 `stat_data`） |
| 高度测量 | 不再需要（浏览器自然排版）——**这是内联最大的收益** |
| 沉浸式全屏（launcher） | 需保留独立实现（portal overlay），不能随 iframe 一起删 |

---

## 1. 现状分析（为什么内联可行）

### 1.1 内联路径已存在

[Message.tsx L932-935](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L932-L935) 的**非 smart-card HTML 分支**已经在完全内联：

```tsx
) : isCharacterChat && !isUser && !useNativeStRendering && isHtmlOrCard && pipelineResult?.kind !== 'smart-card' ? (
  <div className="markdown-content mes_text w-full break-words overflow-wrap-anywhere"
       dangerouslySetInnerHTML={{ __html: sanitizeStCompatHtml(pipelineResult?.content || displayContent) }}
  />
```

Galgame / Tavern Helper 插件都依赖这条 `.mes_text` 内联路径工作。

### 1.2 唯一走 iframe 的是 smart-card

[Message.tsx L937-965](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L937-L965)：

```tsx
) : pipelineResult?.kind === 'smart-card' ? (
  <CharacterCardRenderer content={pipelineResult.content} onAction={onSmartCardAction} ... />
```

smart-card 的识别（[sillyTavernDisplayPipeline.ts L502-506](file:///d:/项目/Palink-AI/frontend/src/utils/sillyTavernDisplayPipeline.ts#L502-L506)）：

```ts
const kind = looksLikeSmartCardHtml(content)
  ? 'smart-card'
  : looksLikeRenderableCardHtml(content) || /.../i.test(content)
    ? 'html-display'
    : 'markdown';
```

### 1.3 CharacterCardRenderer 现在承担的能力（内联化需要逐项处理）

从 [CharacterCardRenderer.tsx](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx)（拆分后 ~1328 行）盘点：

| 能力 | 内联后去向 |
|---|---|
| 卡片 HTML/CSS/图渲染 | 直接内联进 `.mes_text`（浏览器自然排版） |
| iframe 高度自适应（postMessage+轮询） | **删除**（不再需要） |
| MVU 运行时（`getContext`/`eventOn`/`TavernHelper`/jQuery 模拟） | 需改为主页面全局注入（脚本在页面内执行，不再隔离） |
| smart-card-assets 资源代理（字体/CSS 代理） | 内联后可直接引用外部 URL，代理可保留做缓存或弃用 |
| 沉浸式全屏（launcher portal） | 保留（portal 到 body 的 overlay 机制，内容改为内联） |
| CSP/nonce 脚本注入 | 删除（无沙箱了） |
| `sanitizeStCompatHtml` 清洗 | 需**新清洗策略**（允许 script！） |

---

## 2. 目标架构

### 2.1 改造后

```
Message.tsx
  └─ .mes_text 内联渲染（唯一路径）
       ├─ dangerouslySetInnerHTML( inlineCardHtml )   ← smart-card 也走这里
       ├─ 卡片 <script> 在页面内直接执行（MVU/卡片脚本）
       ├─ 卡片 <style> 生效（作者用 .mes_text .xxx 自约束，不 scope）
       ├─ 沉浸式 launcher → portal overlay（保留）
       └─ Galgame / Tavern Helper 插件照常读 .mes_text
```

### 2.2 待删除的文件/逻辑（v2：**PoC 阶段一律不删**，见 C6）

清单本身补全如下（v1 漏了最大的一块）：

- `CharacterCardRenderer.tsx` 的 iframe 渲染、高度测量、srcDoc 构建、CSP 注入（约 1127 行中的 76%）
- `smart-card-runtime/frame-shim/`：`legacy-st-sim.ts`（92KB）+ `frame-measure.ts`（19KB）
- **`smart-card-runtime/SillyTavernCompatRuntime.ts`（299KB / 6172 行）** ← v1 遗漏（A2）。
  它同样是注入 iframe 的字符串，且 L6026-6105 的 `stat_data` 重组逻辑**必须先移植**到主页面全局才能删
- 不复用 `buildShim` / `buildSillyTavernCompatRuntimeV2Shim` 的 iframe 注入路径

> 按 C6，以上在 PoC 验证通过前**一个字都不删**。当前 PoC 已做到 iframe 路径逐字节零改动。

### 2.3 保留/改造

- `helpers.ts` / `shared.ts` 等纯函数模块：**可复用**（HTML 检测、资源计划等与 iframe 无关的部分）
- 沉浸式 overlay：改为 portal + 内联内容
- ST 全局（`getContext` 等）：改为**主页面全局注入**（替代 iframe 内的 shim）

---

## 3. 分步实施计划

### 阶段 A：摸底与基线（只读）

- [ ] A1. 通读 `Message.tsx` 全部 smart-card / 内联 / statusBars / TavernHelper 相关分支，画出完整渲染决策树
- [ ] A2. 通读 `sillyTavernDisplayPipeline.ts`，确认 smart-card 判定边界（哪些内容会误判/漏判）
- [ ] A3. 通读 `CharacterCardRenderer.tsx` 拆分后模块，标注每块能力的去向（删/留/改）
- [ ] A4. 盘点 `smart-card-runtime/` 各模块哪些依赖 iframe 环境（`window.parent.postMessage`、`frameId` 等）
- [ ] A5. 建立回归基线：记录当前可用的智能卡样例、Galgame/Tavern Helper 插件行为、已知 bugs（含截断问题）

### 阶段 B：新内联渲染组件（核心，新文件）

- [ ] B1. 新建 `InlineCardRenderer.tsx`（替代 CharacterCardRenderer 的 Message.tsx 入口）：
  - 输入 `content`（smart-card HTML）+ 与现在相同的 context props
  - 输出 `dangerouslySetInnerHTML` 进 `.mes_text` 容器
  - 处理卡片 `<script>` 执行（见 §4.1）
  - 处理 `<style>`（保留，不 scope）
  - 处理沉浸式 launcher → portal overlay
- [ ] B2. 新清洗策略 `sanitizeInlineCardHtml`：
  - 与 `sanitizeStCompatHtml` 不同：**允许 script**（用户要求卡片 JS 执行）
  - 仍需剥离的：`<iframe>`/`<object>`/`<embed>`/`<base>`/`<form>`（防嵌套/防表单劫持）
  - 不 scope CSS（作者自约束）
- [ ] B3. ST 全局注入改造：`getContext`/`eventOn`/`TavernHelper`/`Generate` 等从 iframe shim 改为**主页面全局**（挂在 `window` 上），供内联卡片脚本调用。复用现有 `legacy-st-sim.ts` 的逻辑但去掉 iframe 依赖
- [ ] B4. MVU 运行时接入：卡片 `<script>` 执行后，MVU 的 `registerMvuSchema`/`<UpdateVariable>` 解析在主页面跑（后端 `mvu_engine.py` 不变）

### 阶段 C：Message.tsx 集成

- [ ] C1. 将 [Message.tsx L937-965](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L937-L965) 的 smart-card 分支改为渲染 `InlineCardRenderer`
- [ ] C2. 确认 `onSmartCardAction` 仍工作（内联后卡片脚本通过 postMessage 上报动作 → 或改为直接调用）
- [ ] C3. 确认 `cardAllowsImmersive` / `htmlPrefersImmersive` 判定仍一致（沉浸式 launcher 走 portal）
- [ ] C4. 保持 `.mes_text` class 与 dangerouslySetInnerHTML 结构不变（插件兼容红线）

### 阶段 D：插件兼容回归（硬性验收）

- [ ] D1. **Galgame**：内联后 Galgame 仍从 `.mes_text` 读到原始 HTML 并渲染 overlay
- [ ] D2. **Tavern Helper**：好感度/状态面板仍正常（stat_data + schema 动态生成）
- [ ] D3. **状态栏**（`<StatusPlaceHolderImpl/>` + 正则[4]）：内联后仍显示、随 AI 输出刷新
- [ ] D4. **沉浸式 launcher**（开局启动器/星空启动器）：全屏效果正确
- [ ] D5. **MVU 卡片**：点按钮、动态更新 stat_data 正常（脚本在页面内执行）

### 阶段 E：删除 iframe 遗留

- [ ] E1. 删除 `CharacterCardRenderer.tsx` 的 iframe 渲染分支（或整个组件若无人引用）
- [ ] E2. 删除 `smart-card-runtime/frame-shim/`（legacy-st-sim / frame-measure）
- [ ] E3. 清理 `buildShim` / `buildSillyTavernCompatRuntimeV2Shim` 的 iframe 注入路径
- [ ] E4. 确认无残留引用（tsc + grep `CharacterCardRenderer` / `frame-shim`）

### 阶段 F：构建与部署

- [ ] F1. `npm run build` 成功，无 TS/构建错误
- [ ] F2. `docker compose restart frontend`（volume mount 覆盖 dist，见 §5.3）
- [ ] F3. 前端全量回归（聊天、角色、智能卡、状态栏、插件、沉浸式、设置）

---

## 4. 注意事项（Hard Constraints）

### 4.1 卡片 JS 与 sanitize 的根本冲突（最关键）

- 现有 `sanitizeStCompatHtml`（[Message.tsx L177-183](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L177-L183)）**FORBID script**——内联路径用于普通 HTML 时安全
- smart-card **必须保留 script**（用户要求卡片 JS 执行，MVU/状态栏脚本依赖）
- 因此必须**新建** `sanitizeInlineCardHtml`，不能复用 `sanitizeStCompatHtml`
- 这条红线决定：smart-card 内联渲染不能简单走现有的 `isHtmlCardContent` 分支（那个会用 FORBID script 的清洗器）

**v2 修正——不要让 DOMPurify 放行 script。** v1 设想「新建一个允许 script 的 DOMPurify 配置」，
实际不需要也不应该：放行 `<script>` 等于放弃 DOMPurify 对脚本内容的全部约束，且它对 script
内文本的处理在不同版本间行为不一致。正确做法是**先抽后洗**：

1. 先把 `<script>` 抽走，留占位 div（此时 HTML 里已无脚本）
2. 对剩余 HTML 沿用**严格**配置清洗（`FORBID_TAGS: ['script','iframe','object','embed','base','form']`）
3. 渲染后由重放模块显式执行脚本（§4.2）

这样 DOMPurify 配置保持严格，脚本执行路径显式可控，且与 `palink-smart-card.js` 的做法一致。

### 4.2 脚本执行（v2 已改正，原文此处为事实错误）

> ⚠️ v1 原文称「内联后 `<script>` 直接出现在页面，浏览器会自动执行」——**这是错的**（见修订记录 A1）。

HTML 规范规定：经 `innerHTML` / `dangerouslySetInnerHTML` 插入的 `<script>`，其 *already started*
标志为 true，**永远不会执行**。必须显式重放：

1. 注入前把 `<script>` 抽走，原地留占位 `<div data-palink-script="id">`
2. HTML 落 DOM 后遍历占位符，`document.createElement('script')` + `parentNode.replaceChild(script, marker)`
3. 每段脚本插入后同步派发一次 `palink-card-init`，全部插完再补派发一次

以上 1:1 对齐项目自己的 ST 侧实现 `frontend/public/st/palink-smart-card.js` L468-518。

配套要求：

- **`DOMContentLoaded` 必须改写为 `palink-card-init`**：内联渲染发生在 document ready 之后，
  `DOMContentLoaded` 永不再触发，不改写则卡片初始化代码整段不执行（对齐 palink-smart-card.js L442-445）
- **`type="module"` 降级为经典脚本**（B3）
- **需要一次性执行守卫**：流式输出会反复重渲染，用内容指纹比对，指纹未变则整体跳过重放（B4）
- **非 JS 类型的 `<script>` 不得当代码执行**：`application/json`、`text/template` 等数据块要原样还原
  （连同 `id` 等属性），供卡片用 `getElementById().textContent` 读取。
  *注：ST 侧实现没有这层判断，会把 JSON 块丢给 JS 引擎抛 SyntaxError。这是它的缺陷，不属于要对齐的「表现」，我们加固。*
- 若脚本依赖 `document.currentScript` / 相对路径，需验证内联后仍正确

### 4.3 样式隔离（CSS 污染风险）

- 内联后卡片 `<style>` 作用于**整个聊天页**（与 ST 一致，ST 不 scope）
- 作者已用 `.mes_text .xxx` 选择器自约束（项目记忆硬约束）——**不能重新 scope**
- 风险：不同卡片之间 class 冲突 → 属 ST 同样存在的固有行为，接受

### 4.4 多租户安全（已降级，但保留底线）

- 用户接受放弃沙箱（来源可信、威胁低）——**这是不可逆决定**，spec 记录在案
- 但若日后需要，可保留一个可配置开关：`MEMORY_ST_YIELD` 类似的安全回退（可选，非本期）
- **注意**：内联后卡片脚本能读 `localStorage.palink_token`——这是已知取舍

### 4.5 沉浸式全屏（不能随 iframe 一起删）

- launcher（`id="launcher"` / `mg-launcher` 家族）必须保留 portal overlay 机制（[CharacterCardRenderer.tsx L946-1089](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L946-L1089)）
- 判定：`htmlPrefersImmersive` 仅基于显式 launcher 元素，**绝不能用 body{height:100vh}/flex 居中/fixed 样式特征**（项目记忆硬约束）
- 高度用 `Math.max(visualHeight, innerHeight, 320)`，不用硬编码 760

### 4.6 插件兼容红线（项目记忆硬约束）

- 角色聊天 HTML 消息必须内联进 `.mes_text`（Galgame 读原始 HTML）
- CSS 必须不重新 scope（`.mes_text .xxx` 选择器依赖）
- HTML 检测用 `isHtmlCardContent`（检测 `<div>/<span>/<style>` 等），**不要**用 `looksLikeSmartCardHtml` 单独判断（太窄）
- 用户消息气泡：`chatStyle==='bubbles'` 分支固定 `bg-slate-900 text-white`（黑底白字）

### 4.7 部署（项目记忆硬约束）

- 前端容器 volume mount `./frontend/dist:/usr/share/nginx/html:ro`，**volume 覆盖镜像 dist**
- 部署：host 上 `npm run build` → `docker compose restart frontend`
- `docker compose build frontend --no-cache` 单独执行不会更新服务内容（被 volume 遮蔽）
- 调试时对比源码与 dist `index-*.js` 的 LastWriteTime，防 stale dist

### 4.8 清理时避免误删

- `looksLikeSmartCardHtml` / `looksLikeRenderableCardHtml` / `isHtmlCardContent` 是**纯函数**，`html-display` 分支（InlineHtmlRenderer）也在用——不能删
- `onSmartCardAction` 的 action 类型（`SmartCardAction`）仍被 Message.tsx 使用——保留导出
- 删除 iframe 相关代码时用 `grep` 全局确认无残留引用

### 4.9 React DOM 冲突（v2 新增，对应 A3 的历史事故）

`primitives.ts` L637-640 记录：inline-html 路径曾抛
`NotFoundError: Failed to execute 'insertBefore'/'removeChild' on 'Node'` 并被回滚，
`resolveHtmlRenderMode` 因此至今硬编码返回 `iframe-js`。

**根因**：React 认为自己拥有这棵子树，而卡片脚本在运行时增删了 DOM 节点；
下一次 reconcile 时 React 拿着已失效的节点引用去 `removeChild`，直接崩栈。

**解法：React 逃逸区（三条缺一不可）**

1. 宿主 div 始终带一个**内容恒为空串**的 `dangerouslySetInnerHTML`。
   React 一见到 `dangerouslySetInnerHTML` 就完全放弃对该节点子树的 diff；
   且前后都是 `''`，React 不会真的写 DOM
2. 真实内容由 `useLayoutEffect` 通过 ref **手写 `innerHTML`**——React 全程不知情
3. 卸载时 React 只移除宿主 div 本身（整棵子树跟着走），不会逐个 `removeChild`
   那些它没创建过的节点

**另一条必须遵守的规则：两个 effect 必须分开。**

- effect A（内容变化）：重写 `innerHTML` + 重放脚本
- effect B（变量变化）：只刷新 ST 变量并广播事件，**绝不碰 DOM**

合成一个的话，每次变量更新都会擦掉卡片 DOM、丢失卡片内部状态，
而指纹守卫又会跳过脚本重放，结果就是卡片变成一具空壳。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 内联后卡片 CSS 污染聊天页 | UI 异常 | 接受（ST 同样行为）；作者自约束 `.mes_text` |
| 脚本执行时机/顺序问题 | 卡片功能失效 | 参考 palink-smart-card.js 的 MutationObserver 延迟执行方案；palink-card-init 事件替代 DOMContentLoaded |
| 沉浸式 launcher 回归 | 全屏失效 | 保留 portal 机制独立实现；D4 实测 |
| 插件（Galgame/Tavern Helper）回归 | 插件崩溃 | 严格保持 `.mes_text` + dangerouslySetInnerHTML 结构；D 阶段实测 |
| 删除 iframe 遗留误删共用函数 | 构建失败 | grep 确认；F1 构建验证 |
| 多租户安全降级 | token 可被卡片脚本读取 | 用户已接受（来源可信）；spec 记录在案 |
| 大改动回滚困难 | 无法恢复 | 物理备份（§6） |

---

## 6. 回滚方案

git 有大量未提交改动，**必须依赖物理备份**：

### 备份位置（改动前快照）
```
d:\项目\Palink-AI\.backup\pre-inline-card-rendering\<时间戳>\
├─ Message.tsx                    # 改造前完整版
├─ CharacterCardRenderer.tsx      # 拆分后当前版（含 iframe 渲染）
├─ smart-card-runtime\            # 全部模块（含 frame-shim）
├─ sillyTavernDisplayPipeline.ts  # smart-card 判定逻辑
└─ frontend\dist\                 # 当前线上产物
```

### 回滚步骤
1. 停止前端容器
2. 用备份覆盖被改源码（Message.tsx / 新组件 / 删除的文件恢复）
3. 恢复 `frontend/dist`（从备份复制）
4. `docker compose restart frontend`
5. 验证页面恢复

### 回滚触发条件
- 插件（Galgame/Tavern Helper）被破坏且无法修复
- 卡片 JS 大面积执行异常
- 聊天页被卡片 CSS 严重污染无法接受
- 沉浸式 launcher 失效无法修复
- 构建失败无法解决

---

## 7. 验证方案

### 7.1 功能验证
- [ ] 智能卡完整展开（不再截断、不再"点一下才显示"）
- [ ] 卡片 JS 交互正常（MVU 点按钮、动态更新）
- [ ] 沉浸式 launcher 全屏正常
- [ ] 状态栏随 AI 输出刷新

### 7.2 插件验证（硬性）
- [ ] Galgame overlay 正常（读 `.mes_text`）
- [ ] Tavern Helper 面板正常（读 `stat_data`）
- [ ] 角色卡 HTML 内联渲染正确（`.mes_text`、CSS 不 scope）

### 7.3 构建/部署验证
- [ ] `npm run build` 无错误
- [ ] `docker compose restart frontend` 后页面正常
- [ ] 前端全量回归通过

---

## 8. 验收标准

1. **智能卡不再有截断/抖动**（内联 = 浏览器自然排版，从根上消除 iframe 高度问题）
2. **卡片 JS 全部保留执行**（MVU/状态栏脚本在页面内直接跑）
3. **插件功能（Galgame/Tavern Helper）经实测完全正常**
4. **沉浸式 launcher 保留**（portal overlay）
5. **CharacterCardRenderer iframe 相关代码已删除**，无残留引用
6. **前端构建与部署正常**，无回归
