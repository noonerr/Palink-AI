# 智能卡亮色模式对比度自动增强 SPEC

> **change-id**: `light-mode-contrast-enhancement`
> **日期**: 2026-08-09
> **状态**: ✅ 已完成（2026-08-11 同步文档；功能经用户实测确认"确实增强了"）
> **范围**: 仅在**亮色模式**（`data-theme="light"`）下，对智能卡内"可读性不足"的文本做**非破坏性**对比度增强；暗色模式与卡片原始样式完全不动。
> **边界**: 不修改卡片源 HTML / 源 `<style>`；不改布局与结构；不改变卡片作者有意的多色设计方案（只调整读不清的部分）。

---

## 一、背景与目标

### 1.1 问题
角色卡（如"[美化]猫神对话框"生成的 `.nk-msg` 对话框）自带 `<style>` 硬编码了**为暗色模式优化**的配色（半透明紫渐变背景 + 浅紫字 `#d8cce8`）。在 Palink 亮色模式下，这类浅色文字在浅色背景上对比度极低，难以阅读。

### 1.2 目标
1. **亮色模式下**自动检测智能卡内低对比度文本，实时提高其可读性。
2. **不破坏**卡片作者的多色设计方案——只调"读不清楚"的颜色，读得清的颜色原样保留。
3. **暗色模式**（`data-theme="dark"`）下不注入任何覆盖，完全按卡片固有样式显示。
4. 自动调整时给用户**明确提示**，且可**一键关闭**该功能。

---

## 二、调研结论（先立事实）

### 2.1 主题机制：单点可判断
- 主题统一写在 `<html>` 上：`data-theme="light|dark"` + `.dark` class，由 [ThemeProvider.tsx](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/ThemeProvider.tsx#L55-L66) 维护，持久化于 `localStorage["palink-theme"]`。
- **结论**：CSS（`html[data-theme="light"] …`）与 JS（`document.documentElement.dataset.theme`）都能精确判断当前主题。这是"只在亮色生效、暗色零副作用"的可靠锚点。

### 2.2 智能卡有两条渲染路径（必须分别处理）
| 路径 | 触发 | 卡片 DOM 位置 | 覆盖可行性 |
|------|------|--------------|-----------|
| **内联渲染** | `.nk-msg` 经 [sanitizeStCompatHtml](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L180-L186) 注入 `.mes_text`；`InlineHtmlRenderer` 经 `prepareInlineHtml` 插入主文档 | 主文档 DOM 内 | 直接 CSS/JS 覆盖，最简 |
| **iframe 渲染** | `IframeRenderer`（`srcDoc`），`CharacterCardRenderer` 分流 | 同源 iframe `contentDocument`（sandbox 含 `allow-same-origin`/无 sandbox） | 父页面可访问 `iframe.contentDocument`；亦有 `buildSmartCardImmersiveBridge` 注入 iframe 脚本先例可复用 |

- **关键事实**：内联 iframe 同源（`allow-scripts allow-same-origin`），父页面可直接读/写其 `contentDocument`，无需跨域桥接。
- **关键事实**：`.nk-msg` 走内联路径，本次主要痛点集中在此；但方案需同时覆盖 iframe 路径，避免"内联卡修好了、进 iframe 卡又看不清"。

### 2.3 现有可复用能力
- [buildSmartCardImmersiveBridge](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L1164-L1306) 已含颜色解析原语：`normalizeColor`、`alphaOfColor`、`colorsFromElement`（向上遍历取背景）、`isVisibleElement`、`visibleSampleElements`。**可提取为共享对比度检测工具**，避免重复实现。
- `SMART_CARD_UI_TEXT` 多语言文案结构（[shared.ts](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/shared.ts#L58-L110)）可承载提示文案。

---

## 三、方案设计

### 3.1 总体架构（三条独立能力，互不耦合）

```
┌─ ① 对比度检测器（纯函数，可复用）──────────────────────┐
│  parseVisibleColor / resolveEffectiveBackground /        │
│  relativeLuminance / contrastRatio                        │
└──────────────────────────────────────────────────────────┘
┌─ ② 对比度增强器（运行时，作用于两种渲染路径）──────────┐
│  遍历卡片文本元素 → 逐元素算对比度 → 覆盖不达标的        │
│  内联: 主文档直接覆盖    iframe: contentDocument 覆盖     │
└──────────────────────────────────────────────────────────┘
┌─ ③ 提示 + 开关（UI 层）─────────────────────────────────┐
│  卡片角标提示（可关闭） + 全局设置开关                    │
└──────────────────────────────────────────────────────────┘
```

### 3.2 ① 对比度检测器（纯函数模块）
新增共享工具（建议 `smart-card-runtime/contrast.ts`），导出：

- **`resolveEffectiveBackground(el)`**：从元素自身沿祖先链向上，逐层取 `backgroundColor`；遇半透明色用 **alpha 合成** 混入父级背景；遇 `linear-gradient` 退化为取渐变的**主导底色**（取第一段稳定色或 `background-color` 兜底）。返回 `{ r,g,b }` 或 `null`。
- **`relativeLuminance(rgb)`**：WCAG 相对亮度。
- **`contrastRatio(fg, bg)`**：`(L1+0.05)/(L2+0.05)`。
- **`isReadable(color, bg, minRatio=4.5)`**：宽泛判定。
- **`adjustForContrast(color, bg, minRatio)`**：在"保持原色相/尽量接近原色"前提下把亮度向远离背景方向偏移，直到满足 `minRatio`；返回新 `rgb`。多色字体由此"只变亮度、不变色相"。

> 复用 `normalizeColor`/`alphaOfColor`/`colorsFromElement` 的解析逻辑，抽到该模块，避免与 bridge 内联脚本重复。

### 3.3 ② 对比度增强器（核心）
运行时机：卡片渲染后 + `MutationObserver`（节流，覆盖流式输出）+ 主题切换时。

**逐元素策略（用户已确认）**：
1. 收集卡片容器内可见文本元素（跳过 `opacity<0.05`、`visibility:hidden`、无文本、`aria-hidden` 装饰，及 `data-palink-contrast-skip`）。
2. 对每个元素：`color = computedStyle.color`；`bg = resolveEffectiveBackground(el)`；`ratio = contrastRatio(color, bg)`。
3. `ratio >= 4.5` → 保留原样（多色字体中读得清的部分不动）。
4. `ratio < 4.5` → `adjustForContrast` 得出新色，注入覆盖。

**覆盖方式（非破坏）**：
- 不修改卡片源 HTML / 源 `<style>`。
- 内联路径：向卡片容器追加一个 `<style data-palink-contrast>`，用高特性选择器（如 `html[data-theme="light"] .palink-inline-card #id .nk-msg {...}`）或对目标元素写入 `style.color`（带 `data-palink-contrast-adjusted` 标记）。
- iframe 路径：父页面 `iframe.contentDocument` 内做同样检测与覆盖（同源可直接访问）。
- **暗色模式**：检测器/覆盖逻辑整体不运行；已注入的覆盖 `<style>`/inline 样式在切回暗色时**移除**，恢复卡片原始样式。

**防误判启发式**：
- 跳过透明度过低、无可见文本、尺寸过小（`<8px`）的元素。
- 对 `linear-gradient` 背景退化处理，避免整段误判。
- 检测到 `data-palink-contrast-skip` 属性的元素一律跳过（卡片作者可主动豁免）。

### 3.4 ③ 提示 + 开关（UI 层）
- **卡片角标提示（用户已确认）**：当某卡片实际调整了 ≥1 处文本颜色时，在该卡片顶部/角落显示**可关闭**的小标签：如"已优化 N 处低对比文字 · 切换暗色模式可查看原始样式"。角标样式配色跟随主题，不遮挡卡片内容。
- **全局开关（用户已确认）**：设置页新增"亮色模式下自动增强卡片对比度"开关，默认开启；关闭后不注入任何覆盖、不显示角标。持久化于 `localStorage`（沿用 `palink-theme` 同风格的 key，如 `palink-auto-contrast`）。文案进 `SMART_CARD_UI_TEXT`（zh/en）。

---

## 四、涉及文件（预计）

| 文件 | 动作 | 说明 |
|------|------|------|
| `smart-card-runtime/contrast.ts` | 新增 | 对比度纯函数模块（检测/亮度/调整） |
| `smart-card-runtime/contrast-enhancer.ts` | 新增 | 运行时增强器：遍历 + MutationObserver + 覆盖注入/移除 |
| `Message.tsx` | 改动 | 内联 `.mes_text` 卡片挂载增强器；角标提示挂载点 |
| `CharacterCardRenderer.tsx` / `InlineCardRenderer.tsx` | 改动 | iframe/内联卡片挂载增强器，复用现有 ref/shims |
| `shared.ts` | 改动 | 新增提示文案（`SMART_CARD_UI_TEXT`） |
| 设置页组件 | 改动 | 新增全局开关 |
| `ThemeProvider.tsx` | 不动 | 仅作主题状态来源，不修改 |

> 具体改动点以二次核对为准；本 spec 阶段不落码。

---

## 五、风险与未决

| # | 风险 | 说明 | 缓解 |
|---|------|------|------|
| R1 | **半透明渐变背景解析** | `.nk-msg` 是半透明紫渐变，`getComputedStyle` 的 `background-color` 可能为 `rgba(...,0.x)`，`background-image` 为 `linear-gradient` | alpha 合成 + 渐变退化为底色；以"文本色 vs 合成后底色"计算 |
| R2 | **装饰性低对比文字误判** | 水印/注脚/渐变标题本就有意低对比 | 启发式过滤 + `data-palink-contrast-skip` 豁免 + 全局开关可关 |
| R3 | **覆盖与卡片作者高优先级样式的层叠冲突** | 卡片内可能有 `!important`/高特性选择器 | 覆盖用足够高特性 + `!important`，且仅限亮色模式、仅限已标记元素 |
| R4 | **流式输出闪烁** | 文本实时增长，检测反复触发 | MutationObserver 节流（rAF/定时） |
| R5 | **切主题时序** | 切回暗色需及时移除覆盖避免残留 | 主题变更即触发增强器 re-run：亮色注入、暗色清除 |
| R6 | **性能** | 长消息大量元素逐元素计算 | 限制最大遍历元素数；结果按选择器缓存，仅处理变化子树 |

---

## 六、验收标准
1. 亮色模式下，含 `.nk-msg` 的卡片文字清晰可读，无需手动改。
2. 多色字体中仅低对比部分被调整，读得清的颜色保持原样。
3. 切回暗色模式，卡片恢复本文档定义的固有样式（与开启功能前一致）。
4. 自动调整时卡片出现可关闭角标提示；关闭全局开关后不再调整、不再提示。
5. 不改动卡片源 HTML/`<style>`，不影响布局与其他元素。

---

## 七、实施清单（✅ 已完成，2026-08-11 文档同步）
1. ✅ 新增 `contrast.ts` 纯函数模块 —— `smart-card-runtime/contrast.ts`：`relativeLuminance`/`contrastRatio`（WCAG 0.2126/0.7152/0.0722）、`ensureContrast`（HSL 仅步进 L，最多 24 步，minRatio 4.5）
2. ✅ 新增 `contrast-enhancer.ts` —— `smart-card-runtime/contrast-enhancer.ts`：`PALINK_AUTO_CONTRAST_STORAGE_KEY`、MutationObserver（32ms 节流）、主题监听（`data-theme`）、`clearOverrides` 原色恢复、`data-palink-contrast-skip` 豁免、600 元素/4000 walker 上限
3. ✅ 接入内联 `.mes_text` 路径与 iframe/内联卡片渲染器 —— `Message.tsx`（内联路径挂载 L707-723 + 角标 UI L1010-1023 + 开关事件 L539-555）、`CharacterCardRenderer.tsx`（iframe 路径挂载）
4. ✅ 卡片角标提示组件 + `SMART_CARD_UI_TEXT` 文案 —— `shared.ts`（zh/en 角标文案）
5. ✅ 设置页全局开关 + 持久化 —— `SettingsView.tsx`（`palink-auto-contrast` localStorage，默认开启，L400 初始化 / L467-480 开关）
6. ✅ 亮/暗主题切换的注入/清除联动 —— `contrast-enhancer.ts` 主题监听（`data-theme` 变化重判：亮色注入 / 暗色清除）
7. ✅ 自测两条渲染路径 + 多色字体 + 装饰性低对比 + 流式输出 —— 实测：开场白 5 处低对比文字被增强（`rgba(200,170,220,0.6)` → 深薰衣草紫），徽章计数与 DOM 一致，用户确认生效

> 安全机制：600 元素/4000 walker 上限、`data-palink-contrast-skip` 豁免属性、inline style 覆盖 + 原色恢复（`clearOverrides`）、`!important` 高特性防层叠冲突。