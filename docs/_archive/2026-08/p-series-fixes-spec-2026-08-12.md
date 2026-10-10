# P 系列修复 Spec（智能卡渲染 + 移动端细节）

> 状态: **DONE（2026-08-12 全部落地并验证）**
> 生成时间: 2026-08-12
> 来源: `docs/MOBILE_ST_COMPAT_VERIFY_2026-08-12.md` §4（问题 2-10）+ §5.2（R-4~R-7）
> 前置: 面 A/B/C、K-1~K-10、S-1~S-5/S-8~S-10 已修复；K-5/K-9 已落地
> 目标: 解决智能卡渲染与移动端全部残余差异，**不破坏已有插件兼容路径**

---

## 0. 决策记录

| 决策项 | 结论 |
|---|---|
| 渲染路径 | **双路径保留**（开场白内联 + 历史 iframe），不合并为单路径（改动面大、回归风险高）；R-4 通过"开场白内联补隔离文档"收敛差异 |
| 沙箱安全（问题 4） | **降级为 opaque-origin + 存储 postMessage 代理**，放弃 `allow-same-origin`（ST 语义超集能力保留，但脚本无法再直读父页 localStorage）|
| 流式渲染（问题 5）| 流式期间 smart-card 块改**增量 iframe 刷新**（`postContextToFrame` 通道复用），不做逐 token markdown 渲染 |
| 执行顺序 | 按影响面从大到小：P1 安全 → P1 渲染 → P2 移动端细节；每项独立提交 + 构建验证 |

> 执行说明（与实际落地差异）：
> - R-4 最终采用「默认关闭内联 flag，桌面端统一 iframe」收敛（`shouldUseInlineCardRendering` 恢复 flag 门控），比"开场白内联补隔离文档"改动更小、效果等价。
> - 问题 5 最终采用「流式 HTML/卡片内容渲染轻量占位，结束后进 iframe」，未做增量 iframe 刷新（复杂度/收益比低）。

---

## 1. P1-1 问题 4：智能卡 iframe 同源沙箱可逃逸（安全）

### 1.1 现状
- [CharacterCardRenderer.tsx:943-945](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L943-L945)：`sandbox = effectiveMode === 'static-html' ? '' : 'allow-scripts allow-same-origin'`
- 同源 iframe 内卡片脚本可直读父页面 `localStorage`（含 JWT `palink_token`）
- 任意被投毒角色卡（PNG 内嵌 HTML+JS）可窃取会话
- 浏览器 console 实测警告：`An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing`

### 1.2 ST 对照
- ST 1.18.0 用 `innerHTML` 渲染角色卡，**不执行脚本**（script.js:3669）——无此通道
- Palink 是超集能力（`trusted-native` / `iframe-js` 需执行卡片脚本），因此必须自己隔离

### 1.3 方案
1. **iframe sandbox 改为 `allow-scripts`（去掉 `allow-same-origin`）** → opaque origin，存储 API 一律抛错
2. **存储代理 shim**：在 [buildShim](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L328) 注入 `localStorage`/`sessionStorage`/`indexedDB` 代理，读写经 `postMessage` 转发父窗口 `sandboxedLocalStorage`（复用 [createSandboxedStorage](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L930) 已有实现模式）
3. **同源依赖排查**：卡片脚本可能依赖 `contentDocument` 直读（对比度增强器 [CharacterCardRenderer.tsx:441](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L441)）——`handleFrameLoad` 的 `frame.contentDocument` 在 opaque-origin 下返回 null，对比度增强器需改为走卡片内 shim 上报主题色，或对 trusted-native 保留同源
4. **保留 trusted-native 例外**：`trusted-native`（用户显式信任的卡）维持 `allow-same-origin`，未信任卡走隔离

### 1.4 验收
- 未信任卡 iframe 内 `localStorage.getItem` 经代理返回父页可读键；`document.cookie` 不可读父页 cookie
- `sandbox` 属性不再含 `allow-same-origin`（除 trusted-native）
- 状态栏/开场白/沉浸式全屏实测不回归（酒馆助手、Galgame 卡）

---

## 2. P1-2 问题 3：safeBottom 恒 0，iPhone 底部安全区失效

### 2.1 现状
- [viewport-theme.ts:246-249](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/viewport-theme.ts#L246-L249)：`safeBottom: 0` 硬编码，从不读 `env(safe-area-inset-bottom)`
- [adapter-css.ts:19-20](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/adapter-css.ts#L19-L20)：`--palink-safe-bottom:0px` 与 JS 侧 `safeTop=48` 不一致
- 卡片 CSS 用 `var(--palink-safe-bottom)` / `env(safe-area-inset-bottom)` 时底部按钮贴近 Home 条

### 2.2 方案
1. `collectSmartCardViewportContext`：safeBottom 读 `env(safe-area-inset-bottom)`（`getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-bottom)')`，解析为 px 数字，iOS 竖屏约 34）
2. 同步更新 `adapter-css.ts` 的 `--palink-safe-bottom` 为真实值；iframe 内 CSS 变量经 viewport-theme 的 postMessage 通道下发（已有机制）
3. 非 iOS/桌面端保持 0（不引入副作用）

### 2.3 验收
- iOS 模拟（iPhone 390×844）下 `--palink-safe-bottom` = `34px`，桌面端 = `0px`
- 用 safe-area 变量的卡片底部按钮不再贴底

---

## 3. P1-3 问题 2：内联 iframe 无滚动兜底 + 无 touch-action

### 3.1 现状
- [CharacterCardRenderer.tsx:1147-1163](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L1147-L1163)：内联 iframe `scrolling="no"` + `overflow:hidden`，未设 `touch-action`；沉浸式分支才有 `touchAction:'manipulation'`
- 高度测量失效（字体晚加载等）时卡片内容超出且不可内部滚动；iOS 触摸与外层聊天滚动冲突

### 3.2 方案
1. iframe style 增加 `touchAction: 'manipulation'`（与沉浸式分支一致）
2. 兜底滚动：iframe 容器 `<div data-palink-smart-card-frame>` 在高度测量异常（`scrollHeight > offsetHeight`）时允许内部滚动——给 iframe 加 `overflowY: 'auto'` 切换；正常态保持 `hidden`（避免滚动条闪现）
3. 高度测量异常判定复用已有 `readFrameHeight`（[CharacterCardRenderer.tsx:920-928](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L920-L928)）轮询的稳定性：连续 3 次 `scrollHeight > frameHeight + 8` 才切换，避免字体加载瞬间抖动

### 3.3 验收
- 慢字体/延迟图片场景下内联卡片可内部滚动；正常场景无滚动条
- 移动端触摸滚动卡片与外层聊天列表不互相抢占

---

## 4. P1-4 R-7：首帧上下文竞态

### 4.1 现状
- [CharacterCardRenderer.tsx:354-361](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L354-L361)：srcDoc 刻意排除 `bootContextSignature`（防止晚到的 characterExtensions 触发整页重建）
- 副作用：**首帧加载期**卡片脚本读 `characterExtensions` 等初始上下文是空的（R-7 实测）
- 补偿通道 `postContextToFrame`（context-update）依赖 `onLoad` 后才发，存在加载竞态窗口

### 4.2 方案
1. srcDoc **首次构建**时嵌入 `__PALINK_BOOT_CONTEXT__` JSON（含 `characterExtensions`/`globalRegexScripts`/`stPluginRuntimeConfig`/`variables`），仅首次；后续热更新走 postMessage（行为不变）
2. shim 内 `bootContextSignature` 逻辑读取该全局：存在则直接用，不存在等 `context-update`
3. `handleFrameLoad` 后立即 `postLiveContext()`（已有）→ 消除竞态窗口

### 4.3 验收
- 硬刷新首帧：卡片脚本 `getContext().characterExtensions` 非空
- 上下文晚到仍走热更新，不触发 srcDoc 重建（无 ERR_ABORTED、无高度闪烁）

---

## 5. P1-5 R-4：双路径渲染漂移

### 5.1 现状
- 开场白（messageIndex=0）强制内联 [Message.tsx:739-741](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L739-L741)；历史消息走 iframe
- 内联路径脚本跑在主页面全局、iframe 路径跑在隔离文档 → 同一卡脚本全局（事件/变量）不共享，行为不一致
- 移动端 `shouldUseInlineCardRendering()` 恒 false（[inline-flags.ts:79-83](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/inline/inline-flags.ts#L79-L83)），一律 iframe——**移动端无此问题**

### 5.2 方案（最小收敛）
1. **桌面端开场白也走 iframe**：移除 `forceInlineGreeting` 分支，仅保留全屏 launcher（`cardAllowsImmersive`）走沉浸式 iframe；开场白统一为 iframe 路径 → 双路径退化为"最新消息 iframe + 历史消息 iframe"，全局共享问题消失
2. 内联渲染（`InlineCardRenderer`）保留为 PoC 可选路径（localStorage flag 显式开启时使用），默认关闭
3. 验证开场白内联 → iframe 切换后样式/行为一致（`sourceFingerprint` 不变 → iframeKey 稳定，无重建抖动）

### 5.3 验收
- 开场白与历史消息渲染路径一致；样式/脚本行为无差异
- 全屏 launcher 开场白仍全屏
- 移动端不受影响（原本就走 iframe）

---

## 6. P1-6 R-5：内联 DOMPurify FORBID_TAGS 含 form

### 6.1 现状
- [adapter-css.ts:154](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/adapter-css.ts#L154)：`FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form']`——内联渲染的角色卡表单被删除

### 6.2 方案
- 从 FORBID_TAGS 移除 `form`（保留 script/iframe/object/embed/base 不变）
- 表单可用性依赖的 `input/select/textarea/button` 已在 ADD_TAGS（[adapter-css.ts:140-144](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/adapter-css.ts#L140-L144)）
- 安全：内联渲染仅在桌面安全环境 + 显式 flag 开启，与 iframe 沙箱无关；移除 form 不引入脚本执行面

### 6.3 验收
- 含 `<form>` 的卡片内联渲染时表单元素保留、可交互
- script/iframe/object 仍被删除

---

## 7. P1-7 R-6：alternate greeting 提升时未应用 AI_OUTPUT 正则

### 7.1 现状
- [character_ext.py:4334-4341](file:///d:/项目/Palink-AI/backend/app/api/character_ext.py#L4334-L4341)：`first_mes` 为空提升 `alt_greetings[0]` 时**未走** `_apply_persist_regex_to_display_text`
- ST [script.js:7690](file:///d:/项目/Palink-AI/frontend/dist_bak_20260806_230848/st/script.js#L7690)：first_mes 与 alternateGreetings 均 `getRegexedString(greeting, AI_OUTPUT)`

### 7.2 方案
- 提升分支（4337-4339）对 `alt_greetings[0]` 应用与 first_mes 相同的 `_apply_persist_regex_to_display_text`（placement=AI_OUTPUT、depth=0）
- 注意与下方 4343-4346 保存逻辑的幂等性（提升后的文本保存为 message，不应二次应用）

### 7.3 验收
- 空 first_mes + alternate greeting 含占位符（`{{user}}` 等）/正则规则时，开场消息正确展开
- 后端测试新增用例（test_e2e_roleplay_phase6 或独立）

---

## 8. P2-1 问题 5：流式输出期间卡片不渲染，结束后突变 iframe

### 8.1 现状
- [Message.tsx:1049-1053](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L1049-L1053)：流式时 `SmoothOutput`（markdown 文本），smart-card 块结束后才一次性进入 iframe

### 8.2 方案
- 流式期间识别到 smart-card 前缀（`<html`/已知 card 签名）时，渲染**轻量占位**（卡片名/加载动画）+ 内容累计
- 结束后照常进入 iframe（保留现有 `pipelineResult.kind === 'smart-card'` 分流）
- 不做逐 token iframe 刷新（复杂度高、收益低，移动端无内联缓解）

### 8.3 验收
- 流式过程有占位反馈（不再白屏等待）；结束后 iframe 正常渲染
- 非卡片内容流式行为不变

---

## 9. P2-2 问题 6：沉浸式全屏在键盘弹出时高度不收缩

### 9.1 现状
- [CharacterCardRenderer.tsx:457-478](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L457-L478)：`keyboardLooksOpen` 时跳过视口更新（`stableViewportSizeRef` 锁定），固定高度覆盖层可能遮挡键盘输入区

### 9.2 方案
- 键盘打开时：`stableViewportSizeRef.height` 取 `visualViewport.height`（收缩），仍保留 `IFRAME_VIEWPORT_MIN_HEIGHT` 下限；仅当锁定的 `stableAvailableHeightRef` 逻辑用于 availableHeight 场景
- 键盘关闭后恢复 `max(innerHeight, visualHeight)`

### 9.3 验收
- 沉浸式全屏下点击输入框，覆盖层高度收缩到键盘上方；关闭键盘后恢复

---

## 10. P2-3 问题 7/8/9/10：移动端细节批量

| # | 问题 | 方案 | 位置 |
|---|---|---|---|
| 7 | mg-form-box 滚动无 iOS 惯性 | 全局样式补 `-webkit-overflow-scrolling: touch`（已有 mobile-styles 内追加）| [mobile-styles.css](file:///d:/项目/Palink-AI/frontend/public/st/css/mobile-styles.css) |
| 8 | 消息操作按钮触控目标 <44px | 消息操作按钮 `p-1` → `min-w-11 min-h-11`（或 `h-11 w-11`）| [Message.tsx:1147-1153](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L1147-L1153)、[CodeBlock.tsx:268-283](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CodeBlock.tsx) |
| 9 | 多卡并存 160ms 轮询开销 | `readFrameHeight` 改 `ResizeObserver` 优先，轮询降为 300ms 兜底 | [CharacterCardRenderer.tsx:920-928](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L920-L928) |
| 10 | 对比度角标遮挡卡片右上角 | 角标移入卡片内部（`top-1 right-1`），或随折叠按钮并列排布 | CharacterCardRenderer 对比度增强器挂载处 |

### 10.1 验收
- 7：iOS 模拟滚动表单列表有惯性
- 8：按钮触控目标 ≥44px
- 9：多卡页面 CPU 开销下降（DevTools Performance 采样）
- 10：右上角角标不遮挡卡片内容/按钮

---

## 11. 执行计划与验证

### 11.1 提交拆分（每项独立 commit，构建 + tsc 通过）

| 顺序 | 项 | 改动文件 | 风险 |
|---|---|---|---|
| 1 | P1-1 问题 4（沙箱隔离）| CharacterCardRenderer.tsx + shim | 高（影响全部智能卡）|
| 2 | P1-7 R-6（后端正则）| character_ext.py + 后端测试 | 低 |
| 3 | P1-4 R-7（首帧竞态）| CharacterCardRenderer.tsx | 中 |
| 4 | P1-5 R-4（双路径收敛）| Message.tsx + inline-flags.ts | 中 |
| 5 | P1-3 问题 2（滚动兜底）| CharacterCardRenderer.tsx | 低 |
| 6 | P1-2 问题 3（safeBottom）| viewport-theme.ts + adapter-css.ts | 低 |
| 7 | P1-6 R-5（form 标签）| adapter-css.ts | 低 |
| 8 | P2 批量（5/6/7/8/9/10）| Message.tsx / CodeBlock.tsx / viewport / styles | 低 |

### 11.2 回归基线
- 后端：`pytest tests/test_st_contract.py tests/test_e2e_roleplay_phase6.py tests/test_st_*`（容器内）
- 前端：`npx tsc --noEmit` + `npm run build`
- 手动：桌面端角色卡（状态栏/开场白/沉浸式）、移动端模拟 390×844、酒馆助手插件、Galgame 卡

### 11.3 验证局限
- 无真机 iOS WebView，safeBottom/惯性/键盘行为以 Chrome 移动模拟 + 代码审查为准，需真机复测（与验证文档 §10 一致）

---

## 12. 参考

- 验证文档：`docs/MOBILE_ST_COMPAT_VERIFY_2026-08-12.md` §4、§5.2
- 运行时重写 spec：`docs/smart-card-runtime-rewrite-spec.md`（背景/双路径事实依据）
- 相关代码：`CharacterCardRenderer.tsx`、`Message.tsx`、`smart-card-runtime/{viewport-theme,adapter-css,inline/inline-flags}.ts`、`backend/app/api/character_ext.py`
