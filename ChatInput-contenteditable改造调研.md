# ChatInput textarea → contenteditable 改造可行性调研

> 背景：iOS 26 的 Safari / WebApp 对网页文本框强制显示系统"辅助条"（Form Assistant，含 Previous/Next/Done），Apple 未提供任何关闭开关。排查确认：聊天页仅 `ChatInput` 一个可聚焦文本字段（file input 为 `display:none` 不计数），故该辅助条为系统默认行为，非多余字段触发。业界唯一根治方案是将 `textarea` 改为 `contenteditable`（ChatGPT 做法）。本文评估该方案在本项目的适配度、改动范围与多端可行性。

- 调研日期：2026-08-31（结论已存入项目记忆）
- 状态：**已否决·封存（2026-09-02 Phase 0 真机证伪）**

> **⚠️ 2026-09-02 Phase 0 真机验证结论（iOS 27.0，用户实测，测试页 /kb-test.html）：前提不成立，方案封存。**
> textarea / input / contenteditable="true" / contenteditable="plaintext-only" **四种全部弹出辅助条**——与检索证据一致：辅助条是系统级 UI，对任何可编辑元素都出现，纯网页无 opt-out（w3c/editing#545 未实现；唯一根治 = 原生壳 WKWebView 重写 inputAccessoryView）。
> 「ChatGPT 无辅助条」系其原生 App，非网页。textarea→contenteditable 改造收益归零，**不做**（省下约 2 天 + 中文 IME 回归风险）。
> 剩余路径：① 接受现状（iOS Safari 里所有网页都有这条）；② 辅助条 ˄ 折叠状态的记忆性待确认（测试页第 ⑤ 项，随时可测）；③ 将来若做原生壳（TestFlight/App Store 的 WKWebView 壳），一行原生代码可永久去除。
> 测试页保留于 frontend/public/kb-test.html（随构建自带），iOS 大版本升级后可复测。
>
> **第二轮深挖（2026-09-02，应用户要求穷尽检索）——仍无网页侧方案，结论加固：**
> 1. 该条自 iOS 18 就存在，iOS 26 只是 Done→✓ 换皮（Liquid Glass 重设计）；[MacRumors](https://forums.macrumors.com/threads/what-is-the-odd-bar-above-keyboard-merged.2465255/) / [Apple Discussions](https://discussions.apple.com/thread/256177528) 用户共识：系统级，用户自己也关不掉。
> 2. [SO「How to remove the Done bar in HTML」](https://stackoverflow.com/questions/65475463/how-to-remove-the-done-bar-above-the-ios-keyboard-in-html)：网页侧 HTML/CSS/JS 无解，唯一途径 = 原生 inputAccessoryView。
> 3. [Safari 27 beta Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes) 与 [WebKit WWDC26 博客](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)逐条查过：**没有**新增 web 侧辅助条控制 API。
> 4. PWA 独立模式：检索只挖出一堆 PWA 键盘相关 bug（[键盘卡死](https://ferdychristant.com/keyboard-stuck-in-ios-add-to-homescreen-app-54aac3a37ff3)等），**无**独立模式隐藏辅助条的迹象。
> 5. 原生壳两行代码方案（WKWebView `inputAccessoryView` 覆写 / `inputAssistantItem` 清空按钮组）：[SO 37800488](https://stackoverflow.com/questions/37800488/how-to-hide-the-keyboard-assistant-bar)、[Turbo iOS 实践](https://www.karlentwistle.com/turbo_native/2024/09/14/turbo-native-ios-custom-keyboard-toolbar.html)。
> 6. 待测小项：辅助条 ˄ 折叠状态是否被系统记住（kb-test.html 第⑤项，30 秒）——若记住，是唯一的无代码缓解。
- 结论：**可行，范围小（3 个文件），但含一个必须写对的难点（受控 contenteditable 的光标恢复 + 中文 IME）**

---

## 1. 结论速览

| 维度 | 评估 |
|------|------|
| 是否可行 | 是 |
| 改动范围 | 小——3 个文件，约 150 行新增 |
| 父组件是否要动 | 否（4 个调用方只依赖 `value` / `onChange` 契约） |
| 键盘避让体系是否要动 | 否（已天然兼容 contenteditable） |
| ST 插件桥接是否要动 | 否（走隐藏虚拟元素，与真实 DOM 解耦） |
| 最大风险点 | 受控 contenteditable 的光标恢复 + 中文输入法 |
| 多端可行性 | iOS 全支持；桌面/Android 需回归；旧版 Firefox 降级不崩 |

---

## 2. 适配度分析

### 2.1 已天然兼容（零改动）

**(1) 键盘检测 `hooks/useVirtualKeyboard.ts:11-16`**
```js
const isEditableFocused = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
};
```
`isEditableFocused()` 已含 `el.isContentEditable`。键盘高度计算、`html.palink-kb-open` 挂载、1.5s focus 轮询兜底 —— 全部零改动。

**(2) 键盘避让 CSS `index.css:1379 / 1384 / 1388`**
```css
html:has(:is(textarea, input, [contenteditable="true"]):focus) nav[data-dock="true"] { ... }
html:has(:is(textarea, input, [contenteditable="true"]):focus) [data-palink-chat-composer="true"] {
  bottom: 0 !important;
}
```
三条规则的选择器已含 `[contenteditable="true"]`，覆盖 dock 隐藏、dock 下滑动画、composer 吸底。说明此前已做过防御性覆盖。

**(3) 4 个父组件只依赖 string 契约**
`ChatInput` 的调用方为 `CharacterChat`（经 `ChatInputArea`）、`ChatViewMobile`、`ChatViewDesktop`、`WelcomeContent`。它们均只传入 `value: string` + `onChange(value: string)`。只要组件对外 props 契约不变，内部替换 `textarea` 不影响任何父组件。

**(4) ST 插件桥接走隐藏虚拟元素（无真实 DOM 耦合）**
`sillyTavernPluginRuntime.ts:1140` 用 `makeHidden('send_textarea', 'textarea')` 在 `document.body` 上创建 `display:none` 的虚拟 `textarea`，供 Galgame 等插件读取 `.value`。真实输入框变化由 `NativeRoleplayChat.tsx:602` 同步过去。与本项目真实输入框的 DOM 完全解耦，不受影响。

### 2.2 必须改动（仅 3 个文件）

| 文件 | 位置 | 改动 | 量级 |
|------|------|------|------|
| `ChatInput.tsx` | 内部 `textarea`（283-308，约 25 行） | 替换为 `contenteditable` 编辑器；`autoResize`（172-178）的 `scrollHeight` 逻辑可删除（div 自增高，加 `max-height` + `overflow-y:auto` 即可） | 新增约 150 行 |
| `CharacterChat.tsx` | `:1164` 与 `:1211` | 唯一的真实 DOM 硬耦合 `querySelector('[data-palink-chat-composer="true"] textarea')?.focus()`，改查 `[data-chat-input-editor]` 自定义属性 | 2 行 |
| `index.css` | `:1379 / :1384 / :1388` | ⚠️ 反直觉坑：若用 `contenteditable="plaintext-only"`，`[contenteditable="true"]` 选择器**匹配不到**（属性值是 `plaintext-only`），三条规则会失效、dock 栏不隐藏。需改为 `[contenteditable]:not([contenteditable="false"])` | 3 行 |

---

## 3. 真正的难点（不是范围，是正确度）

### 3.1 受控 contenteditable 的光标恢复（核心风险）
React 受控 contenteditable 有经典陷阱：父组件 `setState` → 重渲染重写 `innerText` → 光标跳到末尾。项目里有两个外部程序化改写 `value` 的路径：
- 智能卡 `setInputDraft`（`CharacterChat.tsx:1161`、`:1208`）
- 发送后 `setInputValue('')`（`useCharacterChat.ts:1122` 等）

必须实现「仅当 `el.innerText !== value` 才写 DOM + 写完后用 `Selection/Range` 还原光标偏移」，约 40–60 行。写不好即"中文每敲一字光标跳末尾"，体验比辅助条更糟。

### 3.2 IME（中文输入法）
现有 `handleKeyDown` 用 `isComposing` 阻止回车误发（ChatInput.tsx:89）。contenteditable 上 `isComposing` 仍可用，但 WebKit 与 Blink 的 `compositionend` / `input` 触发顺序不同，中文是本项目主场景，**必须真机验证**。

### 3.3 兜底三件套
- **onPaste**：`contenteditable="true"` 粘网页会带入 HTML/样式；即使 `plaintext-only`，仍应在 `onPaste` 里 `preventDefault` + 读 `clipboardData.getData('text/plain')` 兜底。
- **Enter**：各浏览器默认插入 `<div>` 或 `<br>`（行为不一），需 `preventDefault` 后手动插入 `\n`。
- **placeholder**：contenteditable 无原生 placeholder，用 `::before { content: attr(data-placeholder) }` + 空态判断；清空后常残留 `<br>`，`:empty` 匹配不到，需 JS 维护 `data-empty` 属性。

### 3.4 拖放 / 粘贴图片
现有上传走 file input + 容器 `handleDrop`（ChatInput.tsx:147）。contenteditable 自身会成为 drop target 并插入文件/`<img>`，需要在编辑器上 `preventDefault` 让事件冒泡到容器；可顺势支持粘贴图片（`clipboardData.files`），但需防止插入 `<img>`。

### 3.5 无障碍 / 语义
失去 `<textarea>` 原生语义，需补 `role="textbox"`、`aria-multiline="true"`、`aria-label`。

---

## 4. 浏览器 / 多端兼容性矩阵

`contenteditable="plaintext-only"` 支持情况（MDN）：

| 平台 | 支持版本 | 本项目风险 |
|------|---------|-----------|
| iOS Safari / WKWebView | 4.2+ | 目标端，全支持 |
| Android Chrome | 51+ | 无辅助条问题，但需回归百度/讯飞输入法（历史上在 contenteditable 有光标错乱） |
| 桌面 Chrome / Edge / Safari | 51+ / 5+ | 支持 |
| Firefox | 136+（2025-02） | 旧版 ESR（115/128）降级为普通 contenteditable（可粘富文本），不崩溃，靠 onPaste 兜底 |

> 注意：桌面端共用同一 `ChatInput`（`ChatViewDesktop`），改造会一并影响桌面端——这是唯一需要权衡的回归面。建议灰度阶段桌面端先保持 `textarea`。

---

## 5. 推荐实施路径（未实施）

**第 0 步（10 分钟，先做，零风险）**
1. 现有 `ChatInput.tsx` 的 textarea 上 `autocomplete` / `autocorrect` / `autocapitalize` / `spellcheck` **一个都没加**。先补成 `off` 并确认组件不在任何 `<form>` 内——可能直接缓解，值得一试。
2. 真机放一个 `contenteditable="plaintext-only"` 测试 div，确认 iOS 26 确实不弹辅助条。**这两件事不验证，后续工作量都建立在假设上。**

**第 1 步（灰度，仅移动端）**
给 `ChatInput` 加 `useContentEditable` prop，由 `ChatInputArea` 已拿到的 `isMobile` 决定渲染哪套。桌面端保持 `textarea`，回归风险归零。移动端跑两周无问题再全量。

**第 2 步（全量）**
移动端稳定后删除 `textarea` 分支。

**前置建议**：正式动工前，先写**独立最小 demo 页**把光标恢复 + 中文 IME 跑通，不要直接在 `ChatInput` 内改。

---

## 6. 被忽略的低风险前置验证（可能直接降优先级）

辅助条左侧的 `˄` 可折叠。**若折叠状态会被记住**（一次折叠后长期不再弹出），日常体感已接近可接受，本次改造的边际收益随之降低。这点值得先确认，可能直接把优先级降下来。

---

## 7. 涉及文件清单（速查）

| 文件 | 角色 | 是否改 |
|------|------|--------|
| `frontend/src/components/ui/custom/ChatInput.tsx` | 主输入框，本次改造核心 | 改（内部替换） |
| `frontend/src/components/views/character/CharacterChat.tsx` | `:1164` / `:1211` 两处 focus 选择器 | 改（2 行） |
| `frontend/src/index.css` | `:1379/1384/1388` 三条 `:is()` 规则 | 改（3 行，plaintext-only 兼容） |
| `frontend/src/hooks/useVirtualKeyboard.ts` | 键盘检测 | 不改（已兼容） |
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | ST 插件桥接 `#send_textarea` | 不改（虚拟元素解耦） |
| `frontend/src/components/views/character/chat/ChatInputArea.tsx` | 移动/桌面装配层 | 不改（仅透传 props） |
| `frontend/src/components/views/ChatViewMobile.tsx`<br>`.../ChatViewDesktop.tsx`<br>`.../WelcomeContent.tsx` | 父组件调用方 | 不改（string 契约） |

---

## 8. 一句话给决策层

> 这不是"高风险重写"——状态层、键盘体系、插件体系全都不动，真实改动收敛在 1 个组件内约 150 行。真正的成本是一个必须写对的受控光标逻辑，和一轮真机 IME 回归。在动手前，先用零风险的两步验证（补 4 个 textarea 属性 + 真机确认 plaintext-only 不弹条）确认前提成立。
