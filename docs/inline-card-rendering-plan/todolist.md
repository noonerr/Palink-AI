# 智能卡完全内联改造 — TodoList（执行清单）

> 与 spec.md 配套使用。优先级: P0 = 必须完成; P1 = 强烈建议; P2 = 可选
> **v2 更新（2026-08-07 深夜）**：阶段 A/B/C 已完成，PoC 已落地且特性开关默认关闭。
> 阶段 D 需要人工在浏览器里验证，阶段 E 按 C6 决策**推迟到 D 全绿之后**再单独立项。

## 阶段 A：摸底与基线（只读，不改代码）
- [x] A1 (P0) 通读 Message.tsx smart-card/内联/statusBars 分支，画渲染决策树
- [x] A2 (P0) 通读 sillyTavernDisplayPipeline.ts，确认 smart-card 判定边界
- [x] A3 (P0) 通读 CharacterCardRenderer.tsx 拆分后模块，标注每块能力去向
- [x] A4 (P0) 盘点 smart-card-runtime/ 各模块哪些依赖 iframe 环境
- [x] A5 (P0) 建立回归基线 → `frontend/scripts/test-inline-card-extract.mjs`（42 断言，8 个真实卡片样本）
- [x] A6 (P0) **备份** → `.backup/pre-inline-card-rendering/20260807-232646/`

## 阶段 B：新内联渲染组件（核心）— 全部完成
- [x] B0 (P0) 特性开关 `inline/inline-flags.ts`（localStorage，默认关闭）
- [x] B1 (P0) 新建 `InlineCardRenderer.tsx` —— React 逃逸区 + 双 effect 分离（见 spec §4.9）
- [x] B2 (P0) 清洗策略 `inline/inline-sanitize.ts` —— **先抽 script 后清洗**，DOMPurify 保持严格（见 spec §4.1 v2 修正）
- [x] B2b (P0) 脚本重放 `inline/inline-script-replay.ts` —— createElement + replaceChild + `palink-card-init`，含指纹守卫
- [x] B3 (P0) ST 全局 `inline/inline-st-globals.ts` —— **增强而非替换**，不覆盖 sillyTavernPluginRuntime 已有全局
- [x] B3b (P0) `stat_data` 扁平→嵌套重组已移植（对应 spec B1）
- [x] B4 (P0) 宿主能力注册表 `inline/inline-host-registry.ts` —— postMessage RPC 降为直接调用

## 阶段 C：Message.tsx 集成 — 完成
- [x] C1 (P0) smart-card 分支按 flag 切换组件（`SmartCardComponent`，props 一字未动）
- [x] C2 (P0) onSmartCardAction 经 host registry 直接调用
- [x] C3 (P0) cardAllowsImmersive 判定未改动（沉浸式仍走 iframe，见 spec C2）
- [x] C4 (P0) 保持 `.mes_text` + dangerouslySetInnerHTML 结构（插件红线）
- [x] C5 (P0) `tsc --noEmit` 零新增错误；`build-vite.mjs` 构建通过（45s）

## 阶段 D：插件兼容回归（硬性验收，**需人工在浏览器验证**）

开启方式：控制台执行
`localStorage.setItem('palink_inline_card_rendering','1'); location.reload();`
关闭：`localStorage.removeItem('palink_inline_card_rendering'); location.reload();`

- [ ] D1 (P0) Galgame 从 .mes_text 读到原始 HTML 并渲染 overlay
- [ ] D2 (P0) Tavern Helper 好感度/状态面板正常
- [ ] D3 (P0) 状态栏（StatusPlaceHolderImpl + 正则）显示并随 AI 输出刷新
- [ ] D4 (P0) 沉浸式 launcher 全屏正确（本期仍走 iframe，应无变化）
- [ ] D5 (P0) MVU 卡片点按钮 / 动态更新 stat_data 正常
- [ ] D6 (P0) **多卡共存**：同屏多条消息各带卡片，确认全局重名不互相打架
- [ ] D7 (P0) **流式**：AI 输出过程中卡片脚本只执行一次（看控制台是否重复打印）
- [ ] D8 (P0) **无 NotFoundError**：反复切换会话/滚动/重生成，控制台不得出现 insertBefore/removeChild 报错
- [ ] D9 (P1) CSS 污染观察：卡片样式是否影响聊天页其他区域（C4 决定不 scope，与 ST 同）

## 阶段 E：删除 iframe 遗留（**按 C6 推迟，D 全绿后单独立项**）
- [ ] E1 (P0) 删除 CharacterCardRenderer iframe 渲染分支
- [ ] E2 (P0) 删除 smart-card-runtime/frame-shim/（legacy-st-sim 92KB / frame-measure 19KB）
- [ ] E3 (P0) 删除 SillyTavernCompatRuntime.ts（299KB）—— **前提：L6026-6105 逻辑已移植**（已完成）
- [ ] E4 (P0) grep 确认无残留引用

## 阶段 F：构建与部署
- [x] F1 (P0) 构建无 TS/构建错误 —— 产物 `frontend/dist_inline_poc/`
- [ ] F2 (P0) 部署（见下方 D1 陷阱）
- [ ] F3 (P1) 前端全量回归

## 不要做（明确禁止）
- 不要复用 sanitizeStCompatHtml（它 FORBID script，会杀死卡片 JS）
- 不要重新 scope 卡片 CSS（决策 C4：不 scope，作者用 .mes_text .xxx 自约束）
- 不要给每张卡包 IIFE（决策 C5：对齐 ST，共享全局作用域）
- 不要让 DOMPurify 放行 `<script>`（改用「先抽后洗」，见 spec §4.1 v2）
- 不要覆盖 sillyTavernPluginRuntime 已挂载的全局（见 spec 修订记录 E）
- 不要删 looksLikeSmartCardHtml / looksLikeRenderableCardHtml / isHtmlCardContent / SmartCardAction
- **不要用 `npm run build`** —— clean-dist.cjs 的 `rmdirSync(dist)` 会打断 docker bind mount。
  用 `VITE_OUT_DIR=dist_xxx node scripts/build-vite.mjs`，再「停容器 → 换目录 → 起容器」
- 不要用 `docker compose build frontend --no-cache` 代替构建 + restart（volume 遮蔽）
