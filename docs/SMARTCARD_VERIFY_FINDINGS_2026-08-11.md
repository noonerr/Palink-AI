# 智能卡工作线二次验证问题清单（2026-08-11）

> **整理日期**: 2026-08-11
> **背景**: 对"开场白渲染修复 / 亮色模式对比度增强 / fullscreen spec Phase 2（F8/F9 变量 API）"三项已交付工作进行第三方代码复核，共 3 路验证 + 1 路定位研究，发现问题 4 项（含 1 个真实代码 bug、2 个工程/文档缺口、1 个验证盲区）。
> **状态**: 仅记录，**未修改任何代码**。

---

## 验证结论速览（三项交付工作的真实状态）

| 工作 | 结论 | 证据 |
|---|---|---|
| 开场白渲染修复（Message.tsx） | ✅ 真实完成 | `isGreetingInlineHtml`（Message.tsx L861-863）、状态栏占位符跳过（L662-669）、`forceInlineGreeting` 双保险（L739-741） |
| 亮色模式对比度增强 | ✅ 真实完成（**但 spec 文档未同步，见问题 #3**） | `contrast.ts`（WCAG 公式）、`contrast-enhancer.ts`（MutationObserver）、Message.tsx L707-723/L1010-1023、SettingsView L467-480 |
| fullscreen spec Phase 2（F8/F9） | ✅ 核心实现真实存在（**但含 1 个漏接 bug，见问题 #1；测试未留存，见问题 #2**） | 3 helper（SillyTavernCompatRuntime.ts L1827-1845）+ 4 接入点（L5133-5135/L5577-5579/L5769） |

**共性问题**：三项工作均**无自动化测试留存**（开场白修复无测试、F8/F9"16 项断言"是临时 Node 等价实现未入库、对比度增强无测试）。

---

## 问题 #1（真实代码 bug）F8/F9 实现：global 回退分支漏接 F9 类型归一化

**严重程度**: 中（P2）——行为不一致但影响面窄

**位置**:
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` L1836-1842（`getChatVariableCompat`）
- 对照 spec：`docs/fullscreen-card-functional-parity/spec.md` 五之五实施记录 L220 明确写着"**local/global 命中值应用 F9 归一化**"

**现状代码**（L1836-1842）:
```ts
const getChatVariableCompat = (path: string, fallback?: unknown) => {
  const fromChat = getByPath(chatVariableStore, path);
  if (fromChat !== undefined) return fromChat;                       // chat 原样
  const fromLocal = getByPath(localVariableStore, path);
  if (fromLocal !== undefined) return applyStVariableTypeCompat(fromLocal);  // ✅ local 应用了 F9
  return getByPath(globalVariableStore, path, fallback);             // ❌ global 未应用 F9（L1841）
};
```

**问题描述**: F9 归一化（`applyStVariableTypeCompat`，L1827-1832）只接入了 local 分支，**global 回退分支（L1841）未接入**。对比：`getStScopedVariableCompat`（L1844-1845，`getGlobalVariable` 走的路径）是对任意 store 应用归一化的。

**实际后果**（两条读取路径行为不一致）:
| 场景 | `getVariable(path)`（F8 链，global 命中） | `getGlobalVariable(path)`（直接） |
|---|---|---|
| global 存 `"123"` | 返回 `"123"`（string，**未转换**） | 返回 `123`（number，已转换） |
| global 存 `"  "`（空白） | 返回 `"  "` | 返回 `"  "`（一致） |

即：同一 global 值经两条 API 读取类型不同，ST 卡若同时用两种方式取值会踩到类型不一致；且与 spec 五之五自述"local/global 命中值应用 F9 归一化"的文字不符（实现只归一化了 local）。

**修复方向**（1 行，未执行）:
```ts
return applyStVariableTypeCompat(getByPath(globalVariableStore, path, fallback));
```
修复时建议同步补一个针对 global 分支的留存测试（见问题 #2）。

---

## 问题 #2（工程缺口）F8/F9"16 项断言全过"无测试文件留存，不可复现

**严重程度**: 中（P2）

**位置**:
- spec 自述：`docs/fullscreen-card-functional-parity/spec.md` L237 "与 ST `variables.js:45` 语义对照 | ✅ 16/16 断言全过（**Node 等价实现**）"
- 全仓库 grep `applyStVariableTypeCompat`：仅命中源码（L1827/1840/1845）与 spec.md L219，**无任何测试文件引用**
- `smart-card-runtime/__tests__/` 下仅有 `event-contract.test.ts`（事件类型契约，不含变量断言）；`lib/sillytavern/__tests__/` 3 个文件同样不含

**问题描述**: "16/16 断言"是验证过程中用临时 Node 等价实现跑的，**未留存为仓库内测试**。当前无法通过任何命令复现该验证；后续若有人改动这 3 个 helper，无回归保护。

**修复方向**: 将 F8（chat→local→global→fallback 优先级三场景）与 F9（纯数字串/空串/非数字串/数字类型原样/global 数字串 五场景）固化为 Vitest 测试文件（可放 `frontend/src/components/ui/custom/smart-card-runtime/__tests__/variables-compat.test.ts`），并纳入 CI 命令。

---

## 问题 #3（文档缺口）对比度增强：代码已完整落地，但 spec 仍标注"待评审"

**严重程度**: 低（P3，纯文档不同步）

**位置**:
- `docs/light-mode-contrast-enhancement/spec.md`：状态标注"**待评审（用户已确认三个关键方向：逐元素智能调整/卡片角标提示/全局开关）**"，§七实施清单"待评审通过后执行"**未勾选**
- 但代码已完整实现：
  - `smart-card-runtime/contrast.ts`（WCAG 检测纯函数）
  - `smart-card-runtime/contrast-enhancer.ts`（增强器，含 `PALINK_AUTO_CONTRAST_STORAGE_KEY` L23）
  - `Message.tsx` L707-723（内联路径挂载）、L1010-1023（角标 UI）、L539-555（开关事件）
  - `CharacterCardRenderer.tsx` L413-449（iframe 路径挂载）
  - `SettingsView.tsx` L467-480（全局开关，localStorage `palink-auto-contrast`，默认开启）
  - `shared.ts` L92-93/L132-133（zh/en 角标文案）

**问题描述**: spec 文档状态落后于代码——功能已完工且经用户实测确认（"确实增强了"），但 spec 仍停在"待评审"，§七清单未勾选，导致该工作线的文档记录与其真实完成度不一致。

**修复方向**: 更新 spec 状态为"已完成"，勾选 §七实施清单，补充实施记录（改动文件、验证结果），与 fullscreen spec 的收尾风格一致。

---

## 问题 #4（验证盲区 + 文档瑕疵）fullscreen spec：Phase 日期错位 + WS 帧 extension_prompts 端到端断言缺失

**严重程度**: 低（P3）

**位置**:
- `docs/fullscreen-card-functional-parity/spec.md`：
  - Phase 状态表（L164-172）：**Phase 2 标注完成日期 2026-08-11（L170），而 Phase 3 标注 2026-08-09（L171）**——Phase 3（端到端验证）日期早于 Phase 2（F8/F9）完成日期，实为 Phase 3 的验证对象是 Phase 1（P1 双 store 修复），但表格呈现易误导为"F8/F9 已过端到端验证"
  - 五之四实施记录 L336：明示"活跃 iframe 时 WS 帧内非空 `extension_prompts` 未单独端到端断言（UI 故事线切换限制）"——**验证盲区**（功能已实现，但该特定组合未被端到端覆盖）

**问题描述**:
1. 日期倒挂：F8/F9（Phase 2）的验证实际只在五之五自证（Node 等价实现，见问题 #2），未经过 Phase 3 的"§4.1 三场景 + 回归"端到端验证流程；表格日期显示 Phase 3 在 Phase 2 之前完成，掩盖了这一事实。
2. 已验证的盲区：活跃 iframe 场景下 WS 帧携带非空 extension_prompts 的组合无端到端断言，属已知但未覆盖。

**修复方向**: 修正表格日期标注（明确 Phase 3 验证对象为 Phase 1，F8/F9 的端到端验证待补或在五之五标注"未走 Phase 3 流程"）；如条件允许（故事线 UI 可切换），补充该组合的端到端断言。

---

## 附：三项交付工作的完整验证证据（供追溯）

### 开场白渲染修复（Message.tsx）
- `isGreetingInlineHtml` L861-863：`messageIndex === 0` + 非用户消息 + 非 launcher 卡（`cardAllowsImmersive` L694-700）+ 非 `htmlNeedsIframe`（`html-detect.ts` L73-81）
- 内联分支使用点 L1054-1058（`.mes_text` + DOMPurify `sanitizeStCompatHtml`，保留 `<style>`）
- 状态栏占位符跳过 L662-669（`isGreetingMessage` L660）
- `forceInlineGreeting` L739-741（SmartCardComponent 层双保险）
- 样式链路：卡片内嵌 `<style>` → `sillyTavernDisplayPipeline.ts` L356 `decodeStyleTags(..., {prefix: '.mes_text '})` re-scope → 与 ST 原生 `formatting.ts` scopeCss 行为一致
- 注：开场白修复的"样式定义"来自卡片内嵌 `<style>` 而非 Palink 静态 CSS（首次报告曾疑为仓库内 CSS 定义，验证后澄清）

### 对比度增强
- WCAG 公式：`contrast.ts` `relativeLuminance` L168-170 / `contrastRatio` L173-179（标准 0.2126/0.7152/0.0722）
- 保持色相只调亮度：`ensureContrast` L230-257（HSL 中仅步进 L，最多 24 步，minRatio 4.5）
- MutationObserver：`contrast-enhancer.ts` L217-226（32ms 节流）；主题切换监听 L210-214（`data-theme`）
- 安全机制：600 元素/4000 walker 上限、`data-palink-contrast-skip` 豁免属性、inline style 覆盖 + 原色恢复（`clearOverrides` L126-142）
- 开关：`palink-auto-contrast` localStorage，默认开启（SettingsView L400/L467，contrast-enhancer.ts L23/L60）

### F8/F9 变量 API（SillyTavernCompatRuntime.ts）
- `applyStVariableTypeCompat` L1827-1832：非字符串原样（避免 `Number(true)→1`）；空串/非数字串原样；纯数字串 → Number
- `getChatVariableCompat` L1836-1842：chat → local（F9）→ global（**未 F9，问题 #1**）→ fallback
- `getStScopedVariableCompat` L1844-1845：local/global 作用域读取（F9 已接入）
- 接入点：TavernHelper 兜底 L5133-5135、`setCompatFunction` 注册 L5577-5579、`Mvu.getVariable` 最终版 L5769/L5783
- ST 对照：`variables.js` `resolveVariable` L218-232（local 优先 global）；L45 类型转换
- `getAllVariables` 合并序 `{...global, ...chat, ...local}` 保持不变（L5751-5754/L6125-6130）

---

## 相关文档索引

- 主审计报告（插件系统/性能/安全/隔离）：`docs/DEEP_AUDIT_REPORT_2026-08-09.md`
- 插件问题专项（P-1~P-11，属 plugin-system 子系统，与本次智能卡工作线无交集）：`docs/PLUGIN_ISSUES_REPORT.md`
- 智能卡工作线 spec：`docs/fullscreen-card-functional-parity/spec.md`
- 对比度增强 spec（状态落后于代码，见问题 #3）：`docs/light-mode-contrast-enhancement/spec.md`

> 说明：本清单 4 项问题均属于"智能卡 runtime / fullscreen 工作线"，与插件系统（plugin-system）无关；主审计报告与插件问题专项中无对应待办条目，无需修改。
