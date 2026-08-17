# 智能卡渲染运行时重写 Spec（轻量隔离方向）

> 状态: DRAFT（待其他 agent 接手执行）
> 生成时间: 2026-08-07
> 目标: 消除 `CharacterCardRenderer.tsx` 手写 ST 兼容层（258KB 单文件）带来的"缝缝补补 + 兼容性折腾"，改为**轻量隔离**渲染，同时**绝不破坏任何插件功能**。

---

## 0. 背景与决策记录

### 0.1 问题根源

`frontend/src/components/ui/custom/CharacterCardRenderer.tsx` 已膨胀到 **258KB 单文件**。它维护了一套手写的 ST 全局模拟层：

- `buildShim()`：把角色卡 HTML 塞进 iframe，用 JS 模拟 ST 的 `getContext`/jQuery/事件/变量等全局变量
- `buildSillyTavernCompatRuntimeV2Shim()`：另一个 ST 兼容运行时（`smart-card-runtime/SillyTavernCompatRuntime.ts`，299KB）
- iframe 高度自适应（postMessage 主通道 + 轮询兜底）、资源代理、沉浸式全屏、CSP、MVU 等大量补丁

这套"追着 ST 打补丁"的模拟层是**维护黑洞**，也是"截断/跳高/ERR_ABORTED"等问题的来源。

### 0.2 需求决策（已与用户确认）

| 决策项 | 结论 |
|---|---|
| 卡片来源 | **来源可信、威胁低**（用户自己写的/可信导入，基本不遇恶意卡） |
| 隔离级别 | **轻量隔离**（卡片 JS 保留执行，但不需要完整 ST 兼容环境） |
| 插件功能 | **绝不能受影响**（Galgame 读 `.mes_text`、Tavern Helper 读 `stat_data` 等） |
| 多租户安全 | 仍要求（但威胁低，可降级为轻量隔离） |
| 核心诉求 | **停止维护手写 ST 兼容层**，不再折腾兼容性 |

### 0.3 架构上的关键事实（决定可行性）

项目中存在**两条完全独立的渲染路径**：

1. **内联 `.mes_text` 路径**（插件兼容路径）：
   - [Message.tsx L932-935](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L932-L935)：`isCharacterChat && !isUser && !useNativeStRendering && isHtmlOrCard && pipelineResult?.kind !== 'smart-card'` → `dangerouslySetInnerHTML` 直接注入 `.mes_text`
   - Galgame 等 ST 插件读 `.mes_text` 的原始 HTML 渲染 overlay —— **这条路径绝不能动**

2. **智能卡 iframe 路径**（重写对象）：
   - [Message.tsx L938](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L938)：`<CharacterCardRenderer>` 处理 `pipelineResult?.kind === 'smart-card'`
   - 这是 258KB shim 所在的路径，是本次重写的唯一对象

**结论：两路独立 → "轻量隔离去掉智能卡 shim 复杂度"与"插件不受影响"可以同时成立。** spec 的所有改动必须严格限定在路径 2，路径 1 完全不动。

---

## 1. 目标架构

### 1.1 现状（问题结构）

```
Message.tsx
  ├─ 内联 .mes_text 路径  ──→ 插件兼容（Galgame/Tavern Helper）  ← 不动
  └─ 智能卡 iframe 路径  ──→ CharacterCardRenderer.tsx (258KB)
                              ├─ buildShim()                 （手写 ST 全局模拟）
                              ├─ buildSillyTavernCompatRuntimeV2Shim()（手写 ST 兼容运行时）
                              ├─ iframe 高度自适应            （postMessage+轮询）
                              ├─ smart-card-assets 资源代理    （CSP/字体/图片）
                              ├─ 沉浸式全屏 overlay
                              └─ MVU / 变量 / 事件 等补丁
```

### 1.2 目标（轻量隔离）

```
Message.tsx
  ├─ 内联 .mes_text 路径  ──→ 插件兼容（Galgame/Tavern Helper）  ← 不动
  └─ 智能卡 iframe 路径  ──→ CharacterCardRenderer.tsx（大幅精简）
                              ├─ 轻量 iframe 隔离（运行卡片 JS，裁剪浏览器原生能力）
                              ├─ 保留：卡片 JS 执行、静态 HTML/CSS/图渲染
                              ├─ 保留：iframe 高度自适应（现有机制，验证可用则保留）
                              └─ 删除：手写 ST 全局模拟层（buildShim / V2Shim 的 ST 模拟部分）
```

### 1.3 轻量隔离的含义

- **不隔离内容来源**（来源可信，不做完整 ST 兼容）
- **隔离浏览器原生能力**：卡片 JS 无法读 `localStorage`（拿不到 token）、无法 `fetch` 同源 `/api/*`（多租户隔离的最底线）
- **卡片 JS 仍可执行**：页面内交互、DOM 操作、动态更新等正常
- **不模拟 ST 全局**：删除 `getContext`/`Generate`/`eventOn` 等 ST 全局模拟；若卡片确实调用这些，走"显式白名单桥接"（少量、可控），而非整套模拟

> 注意：完整 ST 兼容运行时（`buildSillyTavernCompatRuntimeV2Shim`）不应被"原样保留为黑盒"。它是本次重写要**移除**的对象。若个别卡片强依赖 ST 全局，应通过**最小白名单桥接**提供，而不是回归整套 shim。

---

## 2. 分步实施计划

### 阶段 A：摸底与基线（只读，不改代码）

- [ ] A1. 通读 `CharacterCardRenderer.tsx` 全部 5,800+ 行，标注每个功能块归属（shim / 高度 / 资源 / 沉浸式 / MVU）
- [ ] A2. 通读 `smart-card-runtime/SillyTavernCompatRuntime.ts`（299KB）与 `SmartCardCompatController.ts`（44KB），确认哪些是"ST 全局模拟"（可删）、哪些是"业务能力"（保留）
- [ ] A3. 梳理 `CharacterCardRenderer.tsx` 的导出面（`SmartCardAction`、`looksLikeSmartCardHtml`、`InlineHtmlRenderer` 等），确认哪些被 Message.tsx 等外部引用
- [ ] A4. 确认智能卡 iframe 路径的触发条件（`pipelineResult?.kind === 'smart-card'` 来自哪里），列出会走该路径的输入形态
- [ ] A5. 建立回归基线：记录当前可用的智能卡样例、Galgame/Tavern Helper 插件行为、已知 bugs

### 阶段 B：定义轻量隔离运行时（新文件，不复用旧 shim）

- [ ] B1. 新建 `frontend/src/components/ui/custom/smart-card-runtime/LightweightCardRuntime.ts`：
  - 提供最小 iframe 骨架（沙箱开关、能力裁剪）
  - 不模拟 ST 全局；卡片 JS 在 iframe 内原生执行
- [ ] B2. 定义"能力白名单桥接"接口（仅当确认有卡片需要时）：
  - 例如 `postMessage` 上报 + 父组件白名单处理，替代整套 ST 全局模拟
- [ ] B3. 定义 iframe 高度自适应的最小实现（复用现有 postMessage+轮询机制，验证可用则保留，不可用则重写为纯测量）

### 阶段 C：重构 CharacterCardRenderer.tsx（核心）

- [ ] C1. 从 `CharacterCardRenderer.tsx` **移除** `buildShim()` 与 `buildSillyTavernCompatRuntimeV2Shim()` 的 ST 全局模拟部分
- [ ] C2. **保留**卡片 HTML/CSS/图渲染、iframe 高度自适应、资源加载（若轻量隔离下仍需要资源代理则保留，否则移除以减负）
- [ ] C3. 将 `CharacterCardRenderer.tsx` 从"单文件怪物"拆分为可维护的模块（如 `renderer.tsx` / `runtime.ts` / `measure.ts` / `assets.ts` / `immersive.tsx`），保持对外导出面不变
- [ ] C4. 确保 `SmartCardAction`、`looksLikeSmartCardHtml` 等对外契约不变，Message.tsx 无需改动

### 阶段 D：插件兼容回归验证（硬性验收）

- [ ] D1. **Galgame 插件**：确认智能卡改造后，Galgame 仍能通过 `.mes_text` 读到原始 HTML 并渲染 overlay（走内联路径，理论上不受影响，需实测）
- [ ] D2. **Tavern Helper 面板**：确认好感度/状态面板仍正常（走 `stat_data` + schema 动态生成，依赖 Message.tsx 内联路径，需实测）
- [ ] D3. **角色卡 HTML 内联渲染**：确认非智能卡的 HTML 消息仍走 `.mes_text` 内联（`sanitizeStCompatHtml`），CSS 不重新 scope
- [ ] D4. 确认**智能卡 iframe 路径**改造后，卡片 JS 交互（点按钮、动态更新）仍正常

### 阶段 E：多租户轻量隔离验证

- [ ] E1. 验证卡片 JS 在 iframe 内无法读取 `localStorage` 中的 `palink_token`
- [ ] E2. 验证卡片 JS 无法 `fetch` 同源 `/api/*`（或无法以用户身份调用）
- [ ] E3. 验证多账号切换后，iframe 内容正确隔离、无串号

### 阶段 F：构建与回归

- [ ] F1. `npm run build`（frontend/）成功，无 TS/构建错误
- [ ] F2. 恢复 `docker compose build frontend` 后 `docker compose restart frontend`（注意：volume mount 会覆盖 dist，见注意事项 §5.1）
- [ ] F3. 前端全量功能回归（聊天、角色、智能卡、插件、设置）

---

## 3. TodoList（执行清单）

| # | 任务 | 优先级 | 归属阶段 |
|---|---|---|---|
| 1 | 通读 CharacterCardRenderer.tsx 并标注功能块 | P0 | A1 |
| 2 | 通读 smart-card-runtime 两个文件，划分"ST模拟/业务能力" | P0 | A2 |
| 3 | 梳理对外导出面（SmartCardAction/looksLikeSmartCardHtml/InlineHtmlRenderer） | P0 | A3 |
| 4 | 确认智能卡路径触发条件与输入形态 | P0 | A4 |
| 5 | 建立回归基线（样例卡/插件行为/已知bug） | P0 | A5 |
| 6 | 新建 LightweightCardRuntime.ts（沙箱+能力裁剪） | P0 | B1 |
| 7 | 定义白名单桥接接口（按需） | P1 | B2 |
| 8 | 定义高度自适应最小实现 | P0 | B3 |
| 9 | 移除 buildShim / V2Shim 的 ST 全局模拟 | P0 | C1 |
| 10 | 保留并核实卡片渲染 / 高度 / 资源能力 | P0 | C2 |
| 11 | 拆分单文件为模块，保持导出面不变 | P0 | C3 |
| 12 | 确认 Message.tsx 无需改动 | P0 | C4 |
| 13 | Galgame 插件回归 | P0 | D1 |
| 14 | Tavern Helper 面板回归 | P0 | D2 |
| 15 | 角色卡 HTML 内联渲染回归 | P0 | D3 |
| 16 | 智能卡 JS 交互回归 | P0 | D4 |
| 17 | token 隔离验证 | P0 | E1 |
| 18 | 同源 API 隔离验证 | P0 | E2 |
| 19 | 多账号切换隔离验证 | P1 | E3 |
| 20 | npm run build 成功 | P0 | F1 |
| 21 | 容器重建/重启并验证 | P0 | F2 |
| 22 | 前端全量回归 | P1 | F3 |

---

## 4. 注意事项（Hard Constraints，来自项目记忆）

### 4.1 绝不破坏的路径（插件兼容红线）

- **角色聊天 HTML 消息必须内联渲染**：`isCharacterChat && !isUser && !useNativeStRendering` 的 HTML 消息必须 `dangerouslySetInnerHTML` 进 `.mes_text`（`sanitizeStCompatHtml`：strip script/iframe/object/embed/base/form，保留 style/div/span），**NOT** 在 iframe 里。ST 插件（Galgame）读 `.mes_text` 原始 HTML 渲染 overlay。
- **CSS 必须不重新 scope**：作者用 `.mes_text .xxx` 选择器，只有 `.mes_text` 作为容器元素本身时才能匹配。
- **HTML 检测必须用 `isHtmlCardContent`**（检测 `<div>/<span>/<style>` 等），**不要**用 `looksLikeSmartCardHtml`（太窄，会漏掉 `<div style=...>` 无 `<style>` 标签的情况，导致消息落入 FramelessContent 分支、无 `.mes_text` class、HTML 被转义成文本、ST 插件读不到）。

### 4.2 多租户安全底线（轻量隔离也必须满足）

- 卡片 JS **不得**读取 `localStorage` 中的 `palink_token`
- 卡片 JS **不得**以用户身份调用同源 `/api/*`
- 多账号切换后 iframe 内容必须正确隔离

### 4.3 部署（关键，易踩坑）

- 前端容器用 volume mount `./frontend/dist:/usr/share/nginx/html:ro`，**volume 会覆盖镜像里的 dist**。
- 部署前端改动：先在 host 上 `npm run build`（更新 `./frontend/dist`），再 `docker compose restart frontend`。
- `docker compose build frontend --no-cache` **单独执行不会**更新对外服务的内容（被 volume 遮蔽）。
- **调试 iframe 高度/脚本错误时**：若源码 `CharacterCardRenderer.tsx` 在最后一次 `npm run build` 之后又被编辑，dist 里仍是旧的 shim 字节。对比源码与 dist `index-*.js` 的 LastWriteTime。Stale dist 会出现 `SyntaxError: Unexpected token ')'`（TS 类型注解泄漏进 buildShim 模板串）和 `data-palink-height` 为 null → iframe 锁死在默认高度 → 内容截断。

### 4.4 其他历史雷区（改造时避免回归）

- iframe 高度更新逻辑必须直接 `setHeight(clamped)`（非 `Math.max`），允许双向收缩/展开
- `measure()` 必须定义 `vhDriven` 变量，避免 `ReferenceError`
- vh 驱动布局要防反馈循环（vhDriven 时直接上报高度，不加增量）
- 排除 `position: fixed` 装饰层（`.starfield`/`.falling-stars`）出高度扫描，防正反馈无限增高
- 高度最新值必须写入 `body[data-palink-height]`，父组件优先读该值，消除周期抖动
- HTML 面板内容过 `stripHtmlFenceLeftovers` 防御清洗，防残留 ```html 文本
- esbuild 处理 CSS 注释里的反引号，防被误判为模板字符串导致构建失败
- 沉浸式 overlay 高度用 `Math.max(visualHeight, innerHeight, 320)`，不用硬编码 760，防小视口溢出
- `Message.tsx` 与 `CharacterCardRenderer` 的沉浸式正则必须一致，避免"检测到 true 但内联渲染"的不一致
- 生产构建必须移除 `__palinkDebug` 临时调试代码

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 移除 ST 全局模拟后，部分卡片强依赖 `getContext`/`Generate` 等而失效 | 卡片功能降级 | 阶段 B 白名单桥接按需提供；回归基线提前识别依赖卡 |
| 轻量隔离误伤插件路径 | 插件崩溃 | 严格限定改动在智能卡路径；4.1 路径完全不动；D 阶段实测 |
| 拆分单文件引入 TS/构建错误 | 构建失败 | 保持对外导出面不变；F1 构建验证 |
| iframe 高度机制重构后回归截断/抖动 | 显示异常 | 复用现有已验证机制优先；4.4 雷区逐条核对 |
| 重新创建容器后 dist 未更新 | 线上不生效 | 严格按 4.3 流程：build → restart frontend |

---

## 6. 验证方案

### 6.1 功能验证
- [ ] 智能卡正常渲染（HTML/CSS/图）
- [ ] 卡片 JS 交互正常（点按钮、动态更新）
- [ ] iframe 高度自适应（展开/收缩无截断、无抖动）
- [ ] 沉浸式全屏（若保留）正常

### 6.2 插件验证（硬性）
- [ ] Galgame overlay 正常（读 `.mes_text`）
- [ ] Tavern Helper 好感度/状态面板正常（读 `stat_data`）
- [ ] 角色卡 HTML 内联渲染正确（`.mes_text`、CSS 不 scope）

### 6.3 安全验证
- [ ] 卡片 JS 读不到 `localStorage.palink_token`
- [ ] 卡片 JS 无法同源调用 `/api/*`
- [ ] 多账号切换正确隔离

### 6.4 构建/部署验证
- [ ] `npm run build` 无错误
- [ ] `docker compose restart frontend` 后页面正常
- [ ] 前端全量回归通过

---

## 7. 回滚方案

由于本次改动大，回滚依托**物理备份**（git 有大量未提交改动，不可靠）：

### 备份位置
```
d:\项目\Palink-AI\.backup\pre-st-runtime-rewrite\20260807-171116\
├─ custom\
│  ├─ CharacterCardRenderer.tsx      (264,562 B)
│  ├─ Message.tsx                    (54,323 B)
│  ├─ SillyTavernIframe.tsx          (6,541 B)
│  ├─ TavernHelperPanel.tsx / .css
│  └─ smart-card-runtime\            (SillyTavernCompatRuntime.ts 299KB / SmartCardCompatController.ts 44KB / __tests__)
├─ st-public\
│  ├─ index.html / bridge.js / palink-smart-card.js / script.js / lib.js
└─ dist\                             (852 files，当前线上产物)
```

### 回滚步骤
1. 停止前端容器
2. 用备份覆盖被改动的源码文件（custom/ 下对应文件）
3. 恢复 `frontend/dist`（从备份 dist/ 复制回去）
4. `docker compose restart frontend`
5. 验证页面恢复

### 回滚触发条件
- 智能卡渲染大面积失效
- 插件（Galgame/Tavern Helper）功能被破坏且无法修复
- 构建失败无法解决
- 多租户隔离出现漏洞（token 泄露）

---

## 8. 工作量与验收

- **原则**：减少需要维护的"ST 兼容"代码，而非新增。理想的完成形态是 `CharacterCardRenderer.tsx` 大幅瘦身 + 移除手写 ST 全局模拟层。
- **验收标准**：
  1. `CharacterCardRenderer.tsx` 尺寸显著下降（不再是用 shim 模拟 ST 全局）
  2. 插件功能（Galgame/Tavern Helper）经实测完全正常
  3. 多租户轻量隔离验证通过（读不到 token、无法同源调 API）
  4. 前端构建与部署正常，无回归