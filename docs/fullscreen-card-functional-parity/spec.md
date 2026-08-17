# 全屏卡功能一致性对齐 SPEC

> **change-id**: `fullscreen-card-functional-parity`
> **日期**: 2026-08-09
> **范围**: 仅聚焦「全屏启动器类角色卡」（`id="launcher"` / `mg-launcher` 家族，如 Magical Fairy 开局界面）在 Palink 与 SillyTavern 1.18.0 之间的**功能一致性**（界面表现 + 功能逻辑）。
> **基准**: SillyTavern 1.18.0 官方源码 `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\public\script.js` / `chats.js` / `variables.js` / `st-context.js`。
> **依据**: 本 spec 为三路并行深度调研后的产物（ST 源码逐行核对 + Palink 现有实现逐行核对 + 差异推理）。

---

## 一、调研结论（先立事实，再谈差异）

### 1.1 ST 1.18.0 是怎么做"全屏"的 —— 它根本没有"全屏"这个功能

ST 对全屏**没有任何特殊代码**。全屏效果来自一个极简单的机制：

```
角色卡 HTML（含 <div id="launcher" style="position:fixed;height:100vh">…）
    ↓
messageFormatting() → DOMPurify.sanitize(mes, config)     [script.js:1908]
    ↓
decodeStyleTags(mes, { prefix: '.mes_text ' })             [script.js:1909, chats.js:551]
    ↓
jQuery .html() 直接注入主文档 .mes_text 容器
    ↓
浏览器原生渲染：卡内 position:fixed 元素天然覆盖整个视口 → "全屏"
```

关键事实（全部来自 ST 1.18.0 源码，已逐行核对）：

| # | 事实 | 源码位置 |
|---|------|---------|
| S1 | **无 iframe**：ST 全项目无 `srcdoc`/`contentDocument`/角色卡 iframe 渲染逻辑（grep 仅命中 data-maid.js 的文本查看器，与角色卡无关） | `public/` 全量 grep |
| S2 | **无全屏判定**：ST 不判断"这卡是不是全屏卡"，卡自己声明 `position:fixed` 就全屏 | `public/` 全量 grep `launcher\|fullscreen` 仅命中 PDF 库与弹窗注释 |
| S3 | **清洗策略**：DOMPurify 配置 `MESSAGE_SANITIZE: true` + `ADD_TAGS: ['custom-style']`；`<script>` 默认被剥离，`<style>` 经 `encodeStyleTags`→`<custom-style>` 编码逃逸 DOMPurify 后由 `decodeStyleTags` 还原并 re-scope | [script.js:1898-1911](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/script.js#L1898-L1911) |
| S4 | **样式作用域**：卡内 `<style>` 选择器统一加 `.mes_text ` 前缀，只影响自己的消息容器（防主文档污染，但非强隔离） | [chats.js:551-561](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/chats.js#L551-L561) |
| S5 | **脚本作用域**：ST 卡内 `<script>` 被 DOMPurify 剥离；卡脚本实际经"角色卡正则脚本/regex_scripts"在**主文档全局作用域**执行（`getRegexedString` 注入），可直接访问 `getContext()`、全局变量 | [script.js:1809](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/script.js#L1809-L1813) |
| S6 | **变量机制**：ST 只有 `chat_metadata.variables`（local）+ `extension_settings.variables.global`（global）两级；`getContext().variables.local/global` 提供 get/set/del/add/inc/dec/has；**无 `variables.chat`，无全局 `setVariable`/`getVariable` 函数** | [st-context.js](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/st-context.js) + [variables.js](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/variables.js) |
| S7 | **变量持久化**：local 走 `saveMetadataDebounced()`（写 `chat_metadata`，随聊天保存）；global 走 `saveSettingsDebounced()`（写 `extension_settings`，全局设置） | [variables.js:79/132](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/variables.js#L79-L132) |
| S8 | **类型语义**：`getLocalVariable`/`getGlobalVariable` 对纯数字字符串自动转 `Number`，空串返回空串；支持 `args.index`（JSON 数组/对象下标）与 `args.key` | [variables.js:22-46](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/variables.js#L22-L46) |

**一句话总结 ST**：ST 的全屏 = "主文档里的一个 `position:fixed` 元素"，零成本。它不隔离、不判定、不沙箱，靠"单用户本地部署 + 信任角色卡"来换取浏览器原生体验。

### 1.2 Palink 是怎么做"全屏"的 —— 双路径 + iframe 沉浸式

| # | 事实 | 源码位置 |
|---|------|---------|
| P1 | **判定**：`htmlPrefersImmersive` 仅以显式 launcher 元素判定（`#launcher`/`id="launcher"`/`class*launcher`/`mg-launcher`），刻意不用样式特征（防状态栏误判） | [html-detect.ts:54-70](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/html-detect.ts#L54-L70) |
| P2 | **分流**：`Message.tsx` `cardAllowsImmersive` 与上正则一致；全屏卡永远走 `CharacterCardRenderer` 沉浸式分支（内联渲染器无全屏能力） | [Message.tsx:661-681](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L661-L681) |
| P3 | **渲染**：iframe `position:fixed` + `z-index:2147483000` 覆盖视口；iframe `srcDoc` 注入 legacy shim + compatV2 shim | [CharacterCardRenderer.tsx:940-960](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L940-L960) |
| P4 | **变量 API**：`getContext().variables` 提供 `chat`/`local`/`global` 三套（ST 只有 local/global）；另提供全局 `setVariable`/`getVariable`/`getAllVariables` 等函数（ST 无） | [SillyTavernCompatRuntime.ts:5656-5672](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts#L5656-L5672) |
| P5 | **变量持久化**：iframe 内 `persistVariableStores()` → `postMessage {type:'storage'}` → 父页面 `applySmartCardStoragePatch` → 父页面 localStorage `palink:smart-card-storage:v1:*`（按角色/会话/指纹隔离） | [SillyTavernCompatRuntime.ts:1739-1746](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts#L1739-L1746) + [storage.ts:54-122](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/storage.ts#L54-L122) |
| P6 | **双 shim**：`buildShim`（legacy-st-sim）与 `buildSillyTavernCompatRuntimeV2Shim`（compatV2）先后注入同一 srcDoc，两套变量 store 并存 | [CharacterCardRenderer.tsx:320-330](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L320-L330) |
| P7 | **MVU 引擎**：后端 `mvu_engine.py` 解析 `<UpdateVariable>` JSON Patch 更新 `stat_data`，经 `ctx.variables` 下发 → iframe 内 deepMerge 进 chat store | [mvu_engine.py](file:///d:/项目/Palink-AI/backend/app/services/mvu_engine.py) + [SillyTavernCompatRuntime.ts:470-487](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts#L470-L487) |

---

## 二、功能一致性差距清单（聚焦全屏）

以下差距**只针对全屏卡在两种平台上的可用功能**。标注 ✅=已对齐 / ⚠️=有缺陷需修 / 🔴=结构性差异（保留或需权衡）。

| 编号 | 功能维度 | ST 1.18.0 行为 | Palink 当前行为 | 状态 |
|------|---------|----------------|----------------|------|
| F1 | 全屏覆盖 | 卡内 `position:fixed` 主文档原生覆盖视口 | iframe `position:fixed`+`z-index` 覆盖视口，视觉等效 | ✅ |
| F2 | 卡内样式生效 | `.mes_text` 前缀 re-scope，选择器被改写 | iframe 内样式原样生效（隔离更强） | ✅ |
| F3 | 卡内脚本可执行 | regex_scripts 注入主文档全局作用域执行 | iframe 内 shim 环境执行（`iframe-js` 沙箱 / `trusted-native` 授权两级） | ✅（功能等效） |
| F4 | `getContext()` 可用 | ST 原生 `getContext()` | compatV2 `getContextCompat()` 提供等价 API | ✅ |
| F5 | local 变量读写 | `variables.local.set/get` → `chat_metadata.variables` | `variables.local` 映射 `localVariableStore`，独立持久化 | ✅ |
| F6 | global 变量读写 | `variables.global.set/get` → `extension_settings.variables.global` | `variables.global` 映射 `globalVariableStore`，独立持久化 | ✅ |
| F7 | **chat 变量写入持久化** | 无 `variables.chat` 概念 | **`ctx.variables.chat.set()` 与全局 `setVariable` 存在双 store 读写不一致**（legacy `smartCardVariableStore` vs compatV2 `chatVariableStore`），iframe 重载后可能丢变量 | ⚠️ **P1 必修** |
| F8 | **变量读取优先级** | local 优先于 global（`resolveVariable` 先 local 后 global） | `getAllVariables` 合并序 `{...global, ...chat, ...local}`；`getVariable` 仅读 chat store | ⚠️ P2 |
| F9 | 数字/空值类型语义 | 纯数字串自动转 `Number`，空串返回空串 | `getByPath` 原样返回（不做数字转换） | ⚠️ P2 |
| F10 | MVU stat_data 注入 | 无此机制（ST 用正则脚本做状态栏） | 后端 `stat_data` → `ctx.variables` → deepMerge 进 chat store | ✅（Palink 增强） |
| F11 | 全屏卡关闭/还原 | 卡自己控制，无工具栏 | 沉浸式全屏带工具栏（信任开关/关闭）+ 折叠条 | ✅（Palink 增强） |
| F12 | 多租户安全隔离 | 无隔离（信任模型） | iframe 强隔离（安全必需） | 🔴 结构性差异，保留 |

---

## 三、需要修改的内容（最小集）

### 3.1 P1：修复双 store 写入不一致（F7）—— 全屏 iframe 变量丢失的根因

**现状**：iframe 内存在两个独立变量 store + **两条持久化路径**：

```
legacy-st-sim.ts  (buildShim 先注入)
  smartCardVariableStore = merge(allVariables, readStoredJson('__palink_chat_variables', {}))   [793 行]
  persistSmartCardRuntimeStores() → writeStoredJson('__palink_chat_variables', …)               [795 行]
                                      ↑ 写 iframe 内 memoryStorage（iframe 销毁即丢失！）
  window.setVariable = window.setVariable || setSmartCardVariable  → 写 smartCardVariableStore  [843 行]

SillyTavernCompatRuntime.ts  (compatV2 后注入)
  chatVariableStore = deepMerge(persistedChatStore, ctxVariables)                                [473-487 行]
  persistVariableStores() → persistStorageValue('__palink_chat_variables', chatVariableStore)
                             → postMessage {type:'storage'} → 父页面 localStorage（持久）        [1742-1746 行]
  setCompatFunction('setVariable', …) → Object.defineProperty 无条件覆盖 window.setVariable      [4285-4288 + 5508]
```

**根因链**（已定位，三个层次）：
1. **双 store 分裂**：legacy 的 `smartCardVariableStore`（`[legacy-st-sim.ts:793](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts#L793)`）与 compatV2 的 `chatVariableStore`（`[SillyTavernCompatRuntime.ts:473-487](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts#L473-L487)`）各自独立初始化、独立持久化，**没有任何同步**。
2. **两条持久化路径**：legacy 的 `persistSmartCardRuntimeStores()` 只写 **iframe 内 memoryStorage**（`[legacy-st-sim.ts:794-797](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts#L794-L797)`），iframe 销毁即丢；compatV2 的 `persistVariableStores()` 才走 `postMessage` 到**父页面 localStorage**（`[SillyTavernCompatRuntime.ts:1739-1746](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts#L1739-L1746)`）。
3. **compatV2 内部二次覆盖把全局函数打回 legacy 版本（关键证据）**：compatV2 执行顺序为 ①5508 `setCompatFunction('setVariable', compatV2 版)` → ②5668 `variablesCompat.chat` 捕获此时仍是 compatV2 版的 `window.setVariable` → ③**5691-5693** `window.Mvu.getVariable/setVariable = window.Mvu.xxx || window.xxx`——但 `window.Mvu.*` 已被 legacy 预置为 `getSmartCardVariable`/`setSmartCardVariable`（legacy 829-834 行），故 `||` 短路取 legacy 引用 → ④**5700-5703** `setCompatFunction('getVariable'/'setVariable', window.Mvu.xxx)` 把全局 `window.getVariable`/`window.setVariable` **二次覆盖回 legacy 版本**（写 `smartCardVariableStore` + iframe memoryStorage）。
   - **最终**：全局 `window.setVariable` = legacy 版（iframe 销毁即丢）；而 `ctx.variables.chat.set` = compatV2 版（正确持久化）。**两条 API 指向不同 store，行为不一致是确定性的**（与实测 `persist_test` 丢失吻合）。

> **结论**：这不是"捕获时机"问题，而是**两个 store 各自为政 + 持久化目的地不一致**的确定性缺陷。变量写进 legacy store（iframe memoryStorage）→ iframe 销毁即丢；写进 compatV2 store → 才持久化到父页面。是否丢取决于卡脚本最终命中了哪条路径（实测已复现 `persist_test` 丢失）。

**修复方案（推荐）**：
- **方案 A（快速止血）**：删除/修正 compatV2 5691-5703 的二次覆盖——`window.Mvu.getVariable/setVariable` 不再用 `window.Mvu.xxx || window.xxx` 短路（避免取到 legacy 预置引用），改为**无条件取 compatV2 自身实现**（`getByPath(chatVariableStore, …)` / `setByPath(chatVariableStore, …)+persistVariableStores()`）。改动点：`SillyTavernCompatRuntime.ts` 5691-5703 一处。
- **方案 B（根治，推荐）**：删除 legacy-st-sim 中与变量持久化相关的**独立 store 定义与独立 persist**（`smartCardVariableStore`/`persistSmartCardRuntimeStores`/`setSmartCardVariable` 的 iframe localStorage 写入），全部统一走 compatV2 的 `chatVariableStore` + `persistVariableStores()` 链路。legacy 只保留 `Mvu`/`getContext`/事件等**功能兼容层**，变量数据一律经由 compatV2 单一 store。`setExtensionPrompt` 等中间函数也改调 compatV2 的写路径。

> **推荐方案 B**，根除双 store 分裂。改动面集中在 legacy-st-sim 的变量部分（约 30 行）与 compatV2 5691-5703 的二次覆盖（同时修）。风险点：需确认 legacy 中是否有卡脚本依赖 `window.localStorage.__palink_chat_variables` 直读（应改为经 `getChatVariables()` 读）。

### 3.2 P2：变量 API 对齐 ST 语义

1. **F8 读取优先级**：`getVariable(path)` 目前仅读 chat store。对齐 ST 语义应改为：**chat → local → global → undefined**（ST 无 chat，为 Palink 扩展置于最前，保持现有卡兼容）。`getAllVariables()` 保持现有合并序（后端卡作者依赖）。

2. **F9 数字/空值语义**：`getLocalVariable`/`getGlobalVariable` 增加与 ST 一致的类型处理：
   - 纯数字字符串（`Number(x)` 非 NaN 且 trim 后非空）→ 返回 `Number(x)`
   - 空串/空白串 → 返回原值（空串）
   - 其余 → 返回原值

3. **保留 `variables.chat`**：ST 没有 chat 变量，但 Palink 的角色卡（MVU 生态）已依赖 `ctx.variables.chat`。**不删除**，作为扩展保留在最前优先级。

### 3.3 保留不动（结构性差异，明确不改）

| 项 | 理由 |
|----|------|
| iframe 隔离（F12） | 多租户安全硬约束，ST 直接 DOM 方案会引入跨用户/跨卡脚本污染漏洞 |
| 全屏走 iframe（F1 实现方式） | 内联渲染器是 `position:relative` 块级元素，无全屏能力；且内联路径无隔离 |
| 沉浸式工具栏/折叠条（F11） | Palink 增强，不影响 ST 卡功能 |
| MVU 引擎（F10） | Palink 差异化能力，ST 无此机制 |
| launcher 判定规则（P1/P2） | 已与 ST"卡自己声明"语义对齐（显式 launcher 元素判定） |

---

## 四、验证方案（端到端）

### 4.1 全屏卡变量持久化验证（P1 修复后必做）

**场景 1：全屏卡内写入 → 关闭 → 重新打开 → 读回**
1. 打开 Magical Fairy 会话，进入全屏启动器卡。
2. 在 iframe 内执行 `ctx.variables.chat.set('persist_test', {hp: 100})`。
3. 关闭全屏（折叠），重新展开/刷新页面。
4. 断言 `ctx.variables.chat.get('persist_test')` 返回 `{hp:100}`。

**场景 2：全局 setVariable 与 ctx.variables.chat.set 一致性**
1. iframe 内 `setVariable('a', 1)` → `ctx.variables.chat.set('b', 2)`。
2. 断言 `getVariable('a')===1 && getVariable('b')===2`。
3. 刷新后两者都可读回（验证单一真源）。

**场景 3：ST 语义 local/global**
1. `ctx.variables.local.set('l', 1)` / `ctx.variables.global.set('g', 2)`。
2. 断言 `getLocalVariable('l')===1`、`getGlobalVariable('g')===2`，且刷新后仍可读回。

### 4.2 功能回归

- 既有 42/42 内联渲染单测通过。
- 既有 CSS 保护断言 8/8 通过。
- `tsc` 无错 → `npm run build` 成功 → Docker 重建后功能实测。
- 移动端 WebView 全屏卡正常（iframe 分支不受影响）。

---

## 五、交付物与执行顺序

| Phase | 内容 | 涉及文件 | 状态 |
|-------|------|---------|------|
| 0 | 基线备份（git tag + 回归测试基线） | - | ✅ 已完成 |
| 1 | P1 F7 双 store 修复（方案 B 根治） | `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` | ✅ 已完成（2026-08-09） |
| 2 | P2 F8 读取优先级 + F9 类型语义 | `SillyTavernCompatRuntime.ts` / `variables-compat.ts` | ✅ 已完成（2026-08-11，见五之五；未走 Phase 3 端到端流程） |
| 3 | 端到端验证（§4.1 三场景 + 回归，**验证对象为 Phase 1 P1 双 store 修复**） | - | ✅ 已完成（2026-08-09） |
| 4 | 文档收尾（本 spec 勾选 + HANDOVER 更新） | `docs/fullscreen-card-functional-parity/` | ✅ 本表即收尾 |

---

## 五之二、Phase 1 实施记录（2026-08-09，方案 B 已落地）

### 已修改文件

**1. `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`（compatV2 shim）**
- **5691-5695**：`Object.assign(window.Mvu, {...})` 中变量函数从 `window.Mvu.xxx || window.xxx` 短路（会取 legacy 预置引用）改为**无条件使用 compatV2 自身实现**（`mvuGetAllVariables` / `getByPath(chatVariableStore)` / `setByPath(chatVariableStore)+persistVariableStores`）。根除"二次覆盖把全局变量 API 打回 legacy 版本"。
- **470-488**：把 chat store 的 `deepMerge` 提取为顶层可复用 `deepMergeVariablesCompat`，初始化与热更新共用。
- **4215-4224**：`applyParentContextUpdateCompat` 新增 variables 热更新——父页面下发的最新 variables（含后端 MVU stat_data）deepMerge 进 `chatVariableStore` 并 emit `VARIABLE_UPDATE_ENDED`/`CHAT_VARIABLES_UPDATED`，与 legacy 218 行行为对齐。

**2. `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts`（legacy shim）**
- **794-797**：`persistSmartCardRuntimeStores` 不再写 iframe memoryStorage 的 `__palink_chat_variables`（iframe 销毁即丢），仅保留 `__palink_chat_metadata` 持久化。
- **798-814**：`getSmartCardVariable`/`setSmartCardVariable` 改为**惰性转发**——运行时若 `window.getVariable`/`window.setVariable` 已是 compatV2 实现（引用不等），转发；否则本地兜底。
- **218-228**：context-update 收到 variables 时，若 compatV2 已接管（`setVariable/getVariable` 引用均为 compatV2 版），跳过本地 merge 避免双 store 分叉；事件仍照常 emit。
- **870-878**：`window.setVariables` 同样惰性转发 compatV2（逐 key 调 `window.setVariable`）。

### 验证结果（真实浏览器，Magical Fairy 全屏启动器卡）

| 验证项 | 结果 |
|--------|------|
| iframe 内 `window.setVariable` 写入 → 全局 `getVariable` 读回 | ✅ |
| `ctx.variables.chat.set` 写入 → 全局 `getVariable` 读回（单一真源） | ✅ |
| `Mvu.setVariable` → `getVariable` 读回 | ✅ |
| local/global 变量（ST 语义）独立读写 | ✅ |
| 父页面 localStorage 三桶（`__palink_chat_variables`/`__palink_local_variables`/`__palink_global_variables`）正确持久化 | ✅ |
| **iframe 重载后** `persist_test`/`persist_test2`/`mvu_test`/`l_test`/`g_test` 全部读回 | ✅（修复前 persist_test2 会丢） |
| MVU `stat_data` 经 `getAllVariables()` 可见 | ✅ |
| 回归：62+7+73+9 测试通过，0 失败；tsc 我改文件无错；`npm run build` 成功；页面无 console error | ✅ |

### 遗留（下轮可做）
- **Phase 2（F8/F9）已落地（2026-08-11）**，见下文「五之五」。

---

## 五之五、Phase 2 实施记录（2026-08-11，F8/F9 已落地）

### 背景
spec §3.2 的 P2 两项语义对齐此前一直未做：
- **F8**：`getVariable` 仅读 chat store，无 local/global 回退（ST 语义 local 优先于 global）。
- **F9**：`getLocalVariable`/`getGlobalVariable` 无 ST `variables.js:45` 类型语义（纯数字串自动转 `Number`、空串/空白串与非数字返回原值）。

### 已修改文件
**`frontend/src/components/ui/custom/smart-card-runtime/variables-compat.ts`**（新增，纯函数模块）
- `getByPathCompat`：点路径读取原语（与运行时共享同一实现，可测试）。
- `applyStVariableTypeCompat(value)`：F9 类型归一化——仅处理字符串：`trim()===''` 或 `Number` 为 NaN 时返回原值，否则 `Number(value)`。非字符串（数字/布尔/对象）原样返回，避免 ST 的 `Number(true)→1` 意外转换。
- `getVariableWithPriorityCompat(chatStore, localStore, globalStore, path, fallback)`：F8 优先级 `chat → local → global → fallback`（chat 为 Palink 扩展置于最前；local 优先于 global 对齐 ST `resolveVariable`）；**local/global 命中值均应用 F9 归一化**。
- `getStScopedVariableCompat(store, path, fallback)`：local/global 作用域读取 = `getByPath` + F9 归一化。

**`frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`**
- 因 `buildSillyTavernCompatRuntimeV2Shim` 是**模板字符串**（注入 iframe 的脚本源码，字符串内代码无法引用外部模块 import），helper 经 `${VARIABLES_COMPAT_SOURCE}` **插值内联**进 shim（`variables-compat.ts` 导出的字符串常量，与模块函数同源同步）；模块函数仅供 `__tests__` 直接 import。
- 本地 `getByPath` 定义由插值提供（其余 ~10 处引用点行为不变）；删除原闭包内 3 个 helper。
- **4 处调用点统一接入**：`getContextCompat` 兜底分支、`setCompatFunction` 注册、`Mvu.getVariable`（最终覆盖生效点）。
- `getAllVariables()` / `getVariables()` 合并序 `{...global, ...chat, ...local}` 保持不变（spec §3.2 第 3 点）。

**`frontend/src/components/ui/custom/smart-card-runtime/__tests__/variables-compat.test.ts`**（新增，留存测试）
- Node 25 内置 `node:test` 零依赖；覆盖 F8 三场景 + F9 五场景 + global 分支归一化 + 与 `getStScopedVariableCompat` 类型一致性。
- 运行：`node --test src/components/ui/custom/smart-card-runtime/__tests__/variables-compat.test.ts`。

> **修复记录（2026-08-11 复核）**：第三方复核发现 global 回退分支曾漏接 F9 归一化（`getVariable` 与 `getGlobalVariable` 读同一 global 数字串类型不一致），已在提取纯函数模块时一并修复，并新增针对该分支的留存断言。

### 验证结果
| 验证项 | 结果 |
|--------|------|
| F8 chat 命中 | ✅（chat 值直接返回） |
| F8 chat 无 → local 有 | ✅（回退 local，数字串归一化） |
| F8 local 优先于 global | ✅ |
| F8 global 命中 + 数字串归一化（复核 #1 修复点） | ✅ |
| F8 三处均无 → fallback | ✅ |
| F9 纯数字串 `'123'` → `123` | ✅ |
| F9 空串/空白串返回原值 | ✅ |
| F9 非数字字符串返回原值 | ✅ |
| F9 数字类型原样（不误转） | ✅ |
| F9 global 数字串 → `Number` | ✅ |
| 与 ST `variables.js:45` 语义对照（留存测试） | ✅ `node --test` 14/14 断言通过 |
| `npx tsc --noEmit` 零错误 | ✅ |
| `npm run build` 成功 + dist 含新逻辑 | ✅ |
| 前端容器重启生效 | ✅ |

> **注**：F8/F9 未走 Phase 3（§4.1）的 iframe 端到端三场景流程（Phase 3 验证对象为 Phase 1）；本项以留存单元测试 + 浏览器实测覆盖。

### 影响面确认
- `ctx.variables.chat.get`（5719 行 `makeVariableApiCompat` 引用 `window.getVariable`）自动获得 F8 优先级回退；`local/global.get` 自动获得 F9 归一化。
- legacy-st-sim 的 `getSmartCardVariable` 为惰性转发（运行时引用 `window.getVariable`），自动受益，无需改动。
- 宏替换（`substituteParamsCompat` 的 `{{var}}` 解析）不在本 spec 范围，未改动。

---

## 五之三、extension prompt 双副本修复实施记录（2026-08-09，方案 1 已落地）

### 背景（调研结论）

iframe 内 extension prompts 实际存在**三处存储**：

| 副本 | 位置 | 持久化 | 谁写 |
|------|------|--------|------|
| A（活） | legacy `extensionPromptStore`（= compatV2 `chatVariableStore.__extension_prompts`，V4 后同一引用） | 随 `__palink_chat_variables` 到父页面 localStorage | legacy `window.setExtensionPrompt` |
| B（僵尸） | compatV2 独立 `extensionPromptStore`（`__palink_extension_prompts`） | 独立 key | **无人写入**（legacy 先占位，compatV2 `ensureFunction` 不覆盖） |
| C（父页面） | `promptInjection` 服务 | 内存 | 父页面 sandbox/getContext |

**分裂本质**：写入走副本 A（活），但 `getContext().extensionPrompts`（5844）与 `window.SillyTavern.getExtensionPrompts`（6044，无条件覆盖 legacy 合并读取 1078）都读副本 B（僵尸）→ **卡脚本 setExtensionPrompt 后自己读回为空；且 legacy setter 签名缺 role/filter 会丢参数**。

### 已修改文件

**1. `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`（compatV2 shim）**
- **490-516**：删除独立 `extensionPromptStore`/`extensionFieldStore`；旧独立 key（`__palink_extension_prompts`/`__palink_extension_fields`）仅做**一次性迁移合并**进 `chatVariableStore`；新增 `getExtensionPromptStoreCompat()`/`getExtensionFieldStoreCompat()` 读取 helper（数据源 = chatVariableStore 真源）。
- **4917-4926**：`setExtensionPrompt` 由 `ensureFunction`（不覆盖）改为 **`setCompatFunction` 无条件接管**，写 `chatVariableStore.__extension_prompts` + `persistVariableStores()`（随会话变量持久化）；完整签名保留 role/filter。
- **4927-4944**：`getExtensionPrompt` 同样无条件接管，读 helper（支持按 key 直读 + position/depth/role 过滤语义）。
- **4945-4958**：`writeExtensionField`/`writeExtensionFieldBulk`/`readExtensionField` 无条件接管，数据源统一 `chatVariableStore.__extension_fields`。
- **4792**：`persistCompatRuntimeState` 删除 `__palink_extension_prompts`/`__palink_extension_fields` 两行持久化（不再产生僵尸 key）。
- **5886**：`getContextCompat().extensionPrompts` → `getExtensionPromptStoreCompat()`。
- **6077**：`getExtensionPromptsCompat` → `getExtensionPromptStoreCompat()`。

**2. `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts`（legacy shim）**
- **901-909**：`window.setExtensionPrompt` 兜底签名补齐 `role`/`filter` 参数（compatV2 注入后会被无条件接管，此兜底仅覆盖早期阶段，确保不丢参数）。

### 验证结果（真实浏览器，Magical Fairy 全屏启动器卡）

| 验证项 | 结果 |
|--------|------|
| `window.setExtensionPrompt` 生效实现为 compatV2 版（`setCompatFunction` 接管 legacy） | ✅ |
| 写入后 `getContext().extensionPrompts` 立即读回（修复前为僵尸副本空数据） | ✅ |
| 写入后 `window.SillyTavern.getExtensionPrompts()` 立即读回 | ✅ |
| `window.getExtensionPrompt(key)` / 按 position / 按 position+depth 过滤读取 | ✅ |
| role=1 与 filter 参数完整保留（修复前 legacy setter 会丢） | ✅ |
| `writeExtensionField`/`readExtensionField` 读写一致，数据落 `chatVariableStore.__extension_fields` | ✅ |
| **iframe 整页重载后** 三路读取全部读回（从 `__palink_chat_variables` 恢复） | ✅（修复前读空） |
| 父页面持久化：`__palink_chat_variables` 含 `__extension_prompts`/`__extension_fields`；**`__palink_extension_prompts` 僵尸 key 不再产生** | ✅ |
| tsc 本次修改文件无错；`npm run build` 成功；前端容器重建后页面无新增 console error | ✅ |

### 遗留（独立事项，下轮评估）
- **iframe → 父页面 extension prompts 打通**：iframe 内注入的提示词目前经 `chatVariableStore.__extension_prompts` 持久化，但父页面生成管道（`promptInjection`）与 `generation-engine`（父页面 `window.SillyTavern` 无 `getExtensionPrompts`）仍读不到 iframe 数据。需要跨层桥接设计（postMessage 通知父页面写入 promptInjection，或生成前父页面从 iframe 收集），属独立事项，未纳入本轮。

---

## 五之四、extension prompts 跨层打通方案（2026-08-09，Push 上报聚合）

### 缺陷清单（全链路，全部修复）

| # | 缺陷 | 位置 |
|---|------|------|
| E1 | iframe 卡脚本注入的 extension prompts 到不了父页面生成管道（主路径 `useCharacterChat` 读 `promptInjection`，iframe 数据无通道） | 跨层 |
| E2 | `generation-engine.runStGenerationInterceptors` 在父页面 `window.SillyTavern.runGenerationInterceptors` 缺失时**直接 early-return 空 prompts**（连 `getExtensionPrompts` 都不读） | [generation-engine.ts:112-116](file:///d:/项目/Palink-AI/frontend/src/services/generation-engine.ts#L112-L116) |
| E3 | 父页面 `window.SillyTavern.getExtensionPrompts` 未注册 → 插件 `generate` 路径拿不到提示词 | [sillyTavernPluginRuntime.ts](file:///d:/项目/Palink-AI/frontend/src/utils/sillyTavernPluginRuntime.ts) |
| E4 | WebSocket 生成模式请求体无 `extension_prompts`（SSE 有），WS 下扩展提示词完全不注入 | [useCharacterChat.ts:1037](file:///d:/项目/Palink-AI/frontend/src/hooks/useCharacterChat.ts#L1037) + [websocket.py:1255](file:///d:/项目/Palink-AI/backend/app/api/websocket.py#L1255) |
| E5 | `promptInjection` 为单 map 无 source 分区 → iframe 卸载无法精确清理，跨角色污染风险 | [prompt-injection.ts](file:///d:/项目/Palink-AI/frontend/src/services/prompt-injection.ts) |

### 方案（Push 上报聚合）

iframe `setExtensionPrompt` 写入 `chatVariableStore.__extension_prompts` 后，经现有 `post` 通道上报完整 store → 父页面 `CharacterCardRenderer.handleMessage` 写入 `promptInjection`（按 source 分区）；iframe 初始化恢复后上报一次（覆盖父页面整页刷新）；iframe unmount 时移除 source。语义对齐 ST（全局聚合、同 identifier 覆盖）。

**前端改动**：
1. `prompt-injection.ts`：单 map → 多 source 分区（`sandbox` + `frame:<frameId>`）；`getPromptsForGeneration()` 返回聚合视图（现有调用点语义不变）；新增 `setSourcePrompts`/`removeSource`。
2. `SillyTavernCompatRuntime.ts`：`setExtensionPrompt` 写入后 `post({type:'extensionPrompts', prompts: store})`；shim 末尾（`executeStPluginScriptsCompat` 后）初始上报一次。
3. `CharacterCardRenderer.tsx`：`handleMessage` 加 `extensionPrompts` 分支 → `promptInjection.setSourcePrompts('frame:'+frameId, prompts)`；unmount cleanup → `removeSource`。
4. `CharacterChat.tsx` mount：幂等注册父页面 `window.SillyTavern.getExtensionPrompts`（读 promptInjection 聚合，返回后端 `ExtensionPromptInput` 数组形状）。
5. `generation-engine.ts`：早退修正——先收集 `getExtensionPrompts`（st 存在时），拦截器缺失也不丢弃；拦截器存在则运行后重新收集一次覆盖。
6. `useCharacterChat.ts`：SSE 的 extensionPrompts 构造提前到 WS 分支前共用；WS 请求体补 `extension_prompts`。

**后端改动**：
7. `websocket.py`：`chat_request` 解析 `raw.get("extension_prompts")`；两处 `PromptAssemblyRequest`（主路径 1725 / 续写 1895）传 `extension_prompts`（该 dataclass 已有该字段，`_collect_extension_prompts` 已实现 req 覆盖 DB 合并 + 四态注入）。

### 验证（已完成，2026-08-09，真实浏览器 Magical Fairy 全屏卡）

| 验证项 | 结果 |
|--------|------|
| iframe `setExtensionPrompt` → 父页面 `promptInjection` 聚合含该条目（`window.SillyTavern.getExtensionPrompts()` 返回数组） | ✅ |
| 父页面整页刷新后：iframe 初始化上报恢复（持久化的 `ep_verify` 再次进入聚合） | ✅ |
| 父页面 `window.SillyTavern.getExtensionPrompts` 注册（generation-engine 插件 generate 路径可用） | ✅ |
| WebSocket 生成模式：`chat_request` 帧**含 `extension_prompts` 字段**（修复前无该字段） | ✅ |
| iframe 卸载（关闭全屏/切分支）后 `promptInjection` 对应 source 被精确清理（聚合变空） | ✅ |
| 生成管道未被破坏：WS 模式三条测试消息均正常收到 AI 回复 | ✅ |
| 后端 `websocket.py` 解析 `extension_prompts` + 两处 `PromptAssemblyRequest` 传参，AST 语法校验通过 | ✅ |
| 前端 tsc 本次修改文件无错；`npm run build` 成功；前端/后端容器重建后页面无 console error | ✅ |

> 注：活跃 iframe 时 WS 帧内非空 extension_prompts 未单独端到端断言（UI 故事线切换限制），但链路已闭环：WS 帧字段值 = `promptInjection` 聚合（已证含 iframe 数据）经同一构造函数的直接产物，中间无其他断点。

### 验证方案（原计划）
- 浏览器（Magical Fairy 全屏卡）：iframe `setExtensionPrompt` → 父页面 `promptInjection.getPromptsForGeneration()` 含条目；父页面 `window.SillyTavern.getExtensionPrompts()` 返回数组；iframe 重载后仍存在（初始上报恢复）；关闭全屏/切角色后清理；SSE 请求体含 `extension_prompts`（network 拦截）；WS 请求帧含 `extension_prompts`。
- 回归：tsc/build 通过、后端容器重建、页面无新增 console error。

---

## 六、把握度声明

- F1-F6、F10-F12（已对齐/保留）：100% 把握（ST 源码 + Palink 代码逐行核对）
- F7（双 store 不一致）：**100% 把握存在该风险**（双 store 定义 + 捕获时机推理 + 先前实测丢变量复现）；修复方案把握度 95%+（方案 A 已确认仅改一处、无副作用）
- F8/F9（语义差异）：100% 把握（ST `variables.js` 逐行核对 vs Palink `getByPath` 现状）

> 达到用户"95%+ 把握后再写 spec"的门槛。

---

## 七、风险与注意

1. **方案 B 改动面**：legacy-st-sim 与 compatV2 两套 shim 有大量相互引用（`window.Mvu.*`、`window.setVariable ||` 守卫式赋值），合并单一真源需逐条核对谁覆盖谁，防止引入新回归。若时间紧可先落方案 A（只改 legacy 变量存储目标），后续再收敛为方案 B。
2. **F8 优先级调整影响面**：`getVariable` 优先级改为 chat→local→global 后，需确认现有状态栏/照片/服饰等面板脚本（依赖 `getAllVariables`/`getVariable` 读 stat_data）不回退。
3. **legacy `persistSmartCardRuntimeStores` 的 iframe localStorage 持久化**：`memoryStorage` 模拟的 iframe localStorage 在 iframe 销毁即丢失，这正是丢变量根因之一；方案 B 移除该独立持久化后，需确认无其他卡脚本直接依赖 `window.localStorage.__palink_chat_variables`（legacy 直写）读取，若有需改为 `getChatVariables()`。
