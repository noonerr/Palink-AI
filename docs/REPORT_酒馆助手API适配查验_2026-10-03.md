# 酒馆助手（JS-Slash-Runner）API 适配查验报告

> ⚠️ **2026-10-08 订正（真机实测，3 处）**：本文下列结论已被实测证伪，**原文保留不改**，按下表读取。
> 检测报告：[`_active/report/REPORT_Palink对ST与酒馆助手API适配度检测_2026-10-08.md`](./_active/report/REPORT_Palink对ST与酒馆助手API适配度检测_2026-10-08.md)
>
> | # | 位置 | 原文口径 | 2026-10-08 实测 |
> |---|---|---|---|
> | 1 | §0（:36）、§5.3、§9（:542）、§? 表（:730） | 「`window.TavernHelper` 命名空间**主页面仍缺**」「`typeof TavernHelper` = `undefined`」 | ❌ **已存在且生效**。它是个 Proxy（`Object.keys()` = 0 属设计如此，不是空对象）。10-06 报告 §6.2 已订正，10-08 复核确认。**此项已完成，勿重复施工** |
> | 2 | §0（:50） | 「主页面**没有 Proxy 兜底**」 | ❌ 已不成立。`sillyTavernPluginRuntime.ts:2066-2136` 的 `[GAP-VIS 2026-10-04]` 段已给 `TavernHelper` 加 Proxy，未实现的名字会**记桩并登记进 `__palinkCompatStats`**（缺口可见化） |
> | 3 | §?（:362、:427） | 探针登录 `:13000` | ❌ **13000 已失效**。实测 `docker ps`：`0.0.0.0:14000->8080/tcp`。复算本报告的探针须把端口改成 **14000**，否则连不上 |
>
> 另：本文 §0（:50）「事件总线在主页面只有 4 个事件可达」—— 10-08 实测事件桥**工作正常**
> （`eventOn('generation_started', cb)` → emit → 收到 `["normal"]`，参数已解包）。该条口径需按现状重取。
>
> 其余内容（静态逆向方法、每条结论的取数方式、风险边界）**仍有参考价值**，未改动。

> 日期：2026-10-03
> 范围：Palink 角色扮演功能 × Silly Tavern 插件，重点为**已安装的「酒馆助手」**
> 方法：静态逆向（插件 `@types/` 权威 API 清单 + 前端四套兼容层源码 + 已装插件脚本正文）
> 性质：**查验报告**，未改任何代码。所有数字均给出取数方式，可复算。

---

## 0. 结论速览

> ⚠️ **本节已于 2026-10-04 00:20 按「修复后」状态更新**。修复前（2026-10-03 深夜）的原始结论见 §9.5 / §9.6。

### 0.1 适配度评级

| 评什么 | 评级 | 依据 |
|---|---|---|
| **已装的那两条脚本**（对话渲染系统 v7.1 + Galgame界面插件） | **高 —— 核心功能实测全部可用** | 气泡格式规则注入 ✅、Galgame 面板与 12 个按钮 ✅、相册按钮与弹窗 ✅、变量结构注册 ✅、JS 报错归零 ✅（§9.8） |
| **整个 TavernHelper 接口面**（164 项） | **约 1/4，且不建议追求 100%** | 主页面实际提供 36 项；105 项在四层里全无实现（§5.1） |
| **能否"全 API 兼容"** | **不能，也不该承诺** | 缺失的 105 项里 60+ 是 ST 私有的"管理器" API（角色/预设/人设 CRUD、扩展安装、音频），Palink 有自有实现，硬对齐无收益（§5.1 / §9） |

### 0.2 本轮修好的三件事（真机验证）

| # | 症状 | 根因 | 状态 |
|---|---|---|---|
| ① | 变量系统整片瘫痪 | 卡脚本依赖的 `z`(zod) / `Vue` / `lodash` / `YAML` / `showdown` 一个都没提供 | **已修** |
| ② | 插件在卡片内嵌窗口认不出角色（回退 `default`） | `[PARENT-ALIAS]` 白名单把 `SillyTavern` 挡成 `undefined` | **已修** |
| ③ | **面板/按钮永远不出现** | Palink 每次加载主动删掉插件的启用开关（症状级 workaround） | **已修**（改定向清脏） |

### 0.3 仍未打通（诚实清单）

| 项 | 影响 |
|---|---|
| `window.Mvu` 未挂上 | 卡脚本里**直接调** `Mvu.getMvuData()` 的会失败（如相册按"爱意值"解锁）。引擎内部 `watch(should_enable, …)` 为真才挂，未查清为何未开 |
| Live2D 立绘 | 内嵌窗口是不透明源，同源资源被跨域拦截 |
| `window.TavernHelper` 命名空间 | 主页面仍缺（iframe/沙箱有） |
| 事件只通 4 个 | `GENERATION_STARTED` / `GENERATION_ENDED` 等永不触发（§7） |
| 两处编号不一致 | iframe 用 `slot::0`、主页面用 `slot::<哈希>`（实测暂无副作用） |
| 同一插件两处各跑一遍 | iframe 那份 UI 挂在 iframe 文档里，属"影子实例" |

### 0.4 原始（修复前）结论摘要

| 问题 | 修复前结论 |
|---|---|
| 「酒馆助手」装了什么？ | 1 个插件记录，2 条脚本，合并为 **4,276,579 字节** 的 `index.js` |
| 它跑在哪？ | **不在 iframe，也不在插件沙箱** —— 走**主页面经典轨**（`SillyTavernPluginRuntime` 以 `<script>` 直注） |
| 完整 API 面多大？ | **164 项**（`TavernHelper` 命名空间 134 + iframe 全局 30） |
| 主页面经典轨真正提供了几项？ | **36 项**（其中 19 项有真实逻辑，17 项是世界书/事件类） |
| 会崩吗？ | **多数不会**。脚本普遍用 `typeof X === 'function'` / `?.` 守卫 → 表现为**静默降级**（功能不生效，不报错） |
| 最严重的结构性问题 | ① 主页面**没有 `window.TavernHelper` 命名空间**；② 主页面**没有 Proxy 兜底**（iframe 轨有）；③ 事件总线在主页面**只有 4 个事件可达** |

**一句话**（修复前）：现在这套东西能让"防御性写得好的脚本不崩"，但离"API 全兼容"还差一整层——而且**更完整的那一层（插件沙箱 92 个键）恰好没有被这条插件使用**。

---

## 1. 已安装插件现状（物证）

```
docker compose exec backend python3 -c "..."   # 查 plugins 表
```
输出：
```
total plugins: 1
- 酒馆助手 | id=eb1d50e9-9f19-43ea-a362-75e4266b4991
           | type=tavern_helper
           | source=character_card_extension
           | enabled=True | scripts=2
```

两条脚本：

| # | script_name | type | 字节 |
|---|---|---|---|
| 0 | 对话渲染系统 v7.1 | script | 242,270 |
| 1 | 数据库界面插件(@bubble改造版) | script | 4,034,225 |

后端下发的运行载荷（`_plugin_runtime_payload` 实测）：

```
manifest: {'name': '酒馆助手', 'js': 'index.js', 'loading_order': 100}
runtime:  {'execute_scripts': True, 'script_policy': 'sandbox', 'enabled': True}
resources.js: 1 项 ('index.js', 4,276,579 字节)   # 两条脚本被 IIFE 包裹后拼接
```

> ⚠️ 注意 `script_policy: 'sandbox'` 是**误导性标签**——`tavern_helper` 类型并不会进沙箱，见 §2。

---

## 2. 执行路径：**三处**，不是一处

这是理解全部问题的前提。

| # | 环境 | 入口 | 是否执行本插件 | 兼容层完整度 |
|---|---|---|---|---|
| ① | **主页面（经典轨）** | `frontend/src/utils/sillyTavernPluginRuntime.ts` → `injectIntoContainer()` | ✅ **是** | 弱：47 个全局，**无 TavernHelper 命名空间、无 Proxy 兜底** |
| ② | **智能卡 iframe** | `smart-card-runtime/SillyTavernCompatRuntime.ts` → `executeStPluginScriptsCompat()` | ✅ 是（`execute_scripts===true` 时） | 强：81 键 + **Proxy 兜底 + 宿主启发式回退** |
| ③ | **插件沙箱** | `lib/plugin-system/sandbox.ts` | ❌ **否** | 最强：sandbox 对象 **92 键** + TavernHelper 注入 41 键 |

### 2.1 为什么 ③（最强的）反而不用

`frontend/src/lib/plugin-system/manager.ts:193-202`：

```ts
// tavern_helper 类型插件（如酒馆助手）是大型 IIFE 经典脚本，
// 需要真实 DOM 环境和全局变量（$、document、window 等），
// 由 SillyTavernPluginRuntime 通过 <script> 标签直接注入执行，
// 不在沙箱中运行（沙箱缺少完整全局环境，4MB+ 脚本易出错）。
if (instance.pluginType === 'tavern_helper') {
  instance.status = PluginStatus.LOADED;
  ...
  return true;                 // ← 直接返回，沙箱一行不跑
}
```

**这是一个明确的工程取舍**（4MB 脚本 + 沙箱全局环境不完整），但代价是：**沙箱里那 92 个键（含 `getCharacter` / `getCharData` / `getCharacterNames` / `getButtonEvent` / `iframe_events` / `getMessageId` 等）对这条插件全部不可用。**

### 2.2 主页面经典轨的注入点（物证）

```ts
// sillyTavernPluginRuntime.ts:1471-1474  过滤
const extensions = this.config.plugins.filter(
  (p) => (p.plugin_type === 'sillytavern_extension' || p.plugin_type === 'tavern_helper')
    && (p.source_type !== 'character_card_extension' || p.plugin_type === 'tavern_helper')
);
// :1519-1530  直注
const scriptEl = document.createElement('script');
scriptEl.textContent = jsItem.content;
container.appendChild(scriptEl);
```

调用点：`CharacterChat.tsx:1599`（`loadRuntimeConfig`）+ `:1612`（`injectIntoContainer({diffOnly:true})`）。

---

## 3. API 面总账：164 项

**取数**：插件自带类型定义（权威，与上游 `src/function/index.ts` 一致）

- `@types/function/index.d.ts` → `readonly X: typeof` → **134** 个 `TavernHelper.*` 方法
- `@types/iframe/*.d.ts` → `declare function/const` → **30** 个 iframe 全局
  （`eventOn/eventOff/eventEmit/eventOnce/eventMakeFirst/eventMakeLast/eventRemoveListener/eventClear*/eventOnButton/eventEmitAndWait`、`getButtonEvent`、`getScriptId/getScriptName/getScriptInfo/replaceScriptInfo/getScriptButtons/replaceScriptButtons/updateScriptButtonsWith/appendInexistentScriptButtons/reloadIframe/getIframeName`、`getAllVariables`、`iframe_events`、`tavern_events`、`Mvu`、`SillyTavern`、`TavernHelper`、`EjsTemplate`、`getCurrentMessageId`）

### 3.1 按"哪一层提供"分类

| 分类 | 数量 | 说明 |
|---|---|---|
| **A. 仅主页面经典轨** | 17 | 世界书族 + 事件排序 + `Mvu`/`TavernHelper`/`SillyTavern` 等壳 |
| **B. 仅沙箱轨** | 23 | `getCharacter*` / `getCharData` / `iframe_events` / `getButtonEvent` / `getMessageId` / `insertOrAssignVariables` / `deleteVariable` / 版本号 … |
| **C. 两轨都有** | 19 | `getChatMessages` / `setChatMessages` / `triggerSlash` / `injectPrompts` / `getVariables` / `generateRaw` … |
| **D. 哪一层都没有** | **105** | 见 §5 |

> 口径说明：B/C 里的"沙箱轨"按 `sandbox.ts` 的 `sandbox` 对象（92 键）+ TavernHelper 注入对象（41 键）计。**这 64 项对本插件全部不可达**（§2.1）。

---

## 4. 主页面经典轨实际供给清单（47 个全局）

`SillyTavernPluginRuntime` 的 setupScript（`sillyTavernPluginRuntime.ts:804-1453`）定义的 `window.*`：

```
SillyTavern, toastr, eventSource, event_types, tavern_events,
eventOn, eventOff, eventEmit, eventMakeFirst, eventMakeLast,
getChatMessages, setChatMessages, deleteChatMessages, getLastMessageId,
getCurrentChatId, getCharacters, getCharAvatarPath, getThumbnailUrl,
getRequestHeaders, getWorldbook, getWorldbookNames, getGlobalWorldbookNames,
createWorldbookEntries, createOrReplaceWorldbook, createOrReplaceCharWorldbook,
updateWorldbookWith, rebindGlobalWorldbooks, openCharacterChat,
injectPrompts, uninjectPrompts, setExtensionPrompt, setExtensionSettings,
getExtensionSettings, registerSlashCommand, registerMvuSchema, registerVariableSchema,
renderExtensionTemplateAsync, saveSettingsDebounced,
substitudeMacros, substituteParams, triggerSlash, generateRaw,
this_chid, name2, __palink*（内部桥）
```

**其中真正有后端逻辑的**（非桩）：`getChatMessages`（读 `window.__palinkChatMessages`）、`setChatMessages`（`/api/chats/save`）、`deleteChatMessages`（DELETE 消息接口）、`triggerSlash`（分支/存档/模型命令桥）、`injectPrompts` / `setExtensionPrompt`（接 `prompt-injection` 服务，装配期消费）、`getWorldbook*` / `createOrReplaceWorldbook`、`getThumbnailUrl`、`getCharAvatarPath`、`getCharacters`。

**已明确登记为降级的**：`registerSlashCommand`（`:999-1001` 调 `recordStubHit`，本轨无 SlashCommandEngine，命令不会被执行）。

### 4.1 条件性供给：`inline-st-globals.ts`

`frontend/src/components/ui/custom/smart-card-runtime/inline/inline-st-globals.ts`（`ensureInlineStGlobals()`）**也装在主页面**，但只在 `InlineCardRenderer` 挂载时触发（即**某条消息里含内联卡 HTML** 时）。

它额外提供：`getVariables / getVariable / setVariable / setVariables / Mvu(极简) / waitGlobalInitialized / getChatMessages / setChatMessage / sendMessage / generate / callGenericPopup / getContext / TavernHelper(极简 10 键)`，以及一份 **`NOOP_GLOBALS` 空实现表**（`replaceVariables` / `generateRaw` / `getWorldbook` / `messageFormatting` 等 27 个名字 → 返回 `undefined`）。

> ⚠️ **这是一个"偶发性"供给**：聊天页没有内联卡时，这批全局**完全不存在**。对「酒馆助手」这类不产出内联卡的脚本，它大概率**不触发**。

---

## 5. 缺口清单

### 5.1 全仓（四层都）没有实现的 105 项（按功能域）

> 口径：以下 105 项在 **主页面经典轨 / inline-st-globals / iframe 两套 shim / 插件沙箱** 里**全部零命中**（已逐项回扫 iframe shim 源码确认）。
> 注：`isAdmin` / `getExtensionType` 属沙箱轨（B 类），**不在**本表。

| 功能域 | 数量 | 缺失 API |
|---|---|---|
| **音频** | 8 | `playAudio` `pauseAudio` `getAudioList` `replaceAudioList` `appendAudioList` `getAudioSettings` `setAudioSettings` `getCurrentAudio` |
| **角色 CRUD** | 7 | `builtin` `getCharacterIds` `createCharacter` `createOrReplaceCharacter` `deleteCharacter` `replaceCharacter` `updateCharacterWith` |
| **消息（补全）** | 2 | `createChatMessages` `rotateChatMessages` |
| **扩展管理** | 6 | `getExtensionStatus` `isInstalledExtension` `installExtension` `uninstallExtension` `reinstallExtension` `updateExtension` |
| **生成控制** | 5 | `builtin_prompt_default_order` `getModelList` `getProxyPresetNames` `stopGenerationById` `stopAllGeneration` |
| **导入 raw** | 5 | `importRawCharacter` `importRawChat` `importRawPreset` `importRawWorldbook` `importRawTavernRegex` |
| **世界书条目 / 设置** | 20 | `getLorebookEntries` `replaceLorebookEntries` `updatelorebookEntriesWith` `setLorebookEntries` `createLorebookEntries` `deleteLorebookEntries` `getLorebookSettings` `setLorebookSettings` `getLorebooks` `deleteLorebook` `createLorebook` `getCharLorebooks` `setCurrentCharLorebooks` `getCurrentCharPrimaryLorebook` `getOrCreateChatLorebook` `rebindCharWorldbooks` `getChatWorldbookName` `getOrCreateChatWorldbook` `deleteWorldbook` `replaceWorldbook` |
| **预设** | 15 | `isPresetNormalPrompt` `isPresetSystemPrompt` `isPresetPlaceholderPrompt` `default_preset` `getPresetNames` `getLoadedPresetName` `loadPreset` `createPreset` `createOrReplacePreset` `deletePreset` `renamePreset` `getPreset` `replacePreset` `updatePresetWith` `setPreset` |
| **用户人设** | 11 | `getPersonaNames` `getPersonaIds` `getCurrentPersonaName` `getCurrentPersonaId` `getPersonaAvatarPath` `createPersona` `createOrReplacePersona` `deletePersona` `getPersona` `replacePersona` `updatePersonaWith` |
| **酒馆正则** | 5 | `formatAsTavernRegexedString` `isCharacterTavernRegexesEnabled` `getTavernRegexes` `replaceTavernRegexes` `updateTavernRegexesWith` |
| **iframe 脚本 / 按钮** | 17 | `getScriptButtons` `replaceScriptButtons` `updateScriptButtonsWith` `appendInexistentScriptButtons` `getScriptName` `getScriptInfo` `replaceScriptInfo` `reloadIframe` `getIframeName` `getScriptId` `EjsTemplate` `eventOnButton` `eventOnce` `eventEmitAndWait` `eventClearEvent` `eventClearListener` `eventClearAll` |
| **其他** | 4 | `initializeGlobal` `RawCharacter` `getChatHistoryBrief` `getChatHistoryDetail` |
| **合计** | **105** | |

### 5.2 主页面缺、但**已装脚本真的在用**的 9 项（**这才是要修的重点**）

| API | 全仓状态 | 已装脚本是否用 | 后果 |
|---|---|---|---|
| `Mvu` | 仅 iframe 轨 / inline（极简） | ✅ 44 处 | 状态栏/变量主数据源失效（`Mvu.getMvuData` 不存在） |
| `getVariables` | 仅 inline（条件） | ✅ 13 处 | 角色变量读取失效 |
| `replaceVariables` | 仅 inline（**且是 no-op**） | ✅ 6 处 | 变量写回失效 |
| `getCharacter` | **全仓缺失**（只有 `getCharacters` 复数） | ✅ 3 处 | 读角色卡配置失效 |
| `getCharacterNames` | **全仓缺失** | ✅ 4 处 | 角色名列表为空 |
| `getCharData` | **全仓缺失** | ✅ 6 处 | 角色卡数据读不到 |
| `generate` | 仅 iframe/inline | ✅ 1 处 | 安静生成失效 |
| `waitGlobalInitialized` | 仅 iframe/inline | ✅ 4 处 | 初始化等待退化为立即返回 |
| `iframe_events` | **全仓缺失** | ✅ 2 处 | 流式监听不注册 |

> 关键：`window.getCharacter` / `getCharacterNames` / `getCharData` / `iframe_events` 四个名字，**全仓 grep 零命中**——不是"实现了但没接上"，是**没有**。

### 5.3 结构性问题（比单个 API 更值得修）

1. **主页面没有 `window.TavernHelper` 命名空间。**
   `window.TavernHelper` 只在 4 处被赋值，全在 iframe / 沙箱：
   - `legacy-st-sim.ts:1423`（iframe 模板串）
   - `SillyTavernCompatRuntime.ts:5458`（iframe shim）
   - `sandbox.ts:3895`（沙箱）
   - `inline-st-globals.ts:546`（主页面，**但只在渲染内联卡时**）
   → 经典轨脚本写 `topWindow.TavernHelper.xxx`（已装脚本里 3 处）**必然 undefined**。

2. **主页面没有 Proxy 兜底。**
   iframe 轨有（`SillyTavernCompatRuntime.ts:5441`）：
   ```ts
   const proxy = new Proxy(existingHelper, {
     get(target, prop) {
       if (prop in target) return target[prop];
       if (prop in tavernHelperCompat) return tavernHelperCompat[prop];
       return makeMissingApiFunction('TavernHelper.' + String(prop), { severity: 'warning' });
     }, ...
   });
   ```
   `makeMissingApiFunction` 会 `reportDiagnostic` + `requestParent('unknownApiCall')`，宿主再用启发式回退（`SmartCardCompatController.ts:529`：`get*`→`{}`、`list*`→`[]`、`is*`→`false`、`set*`→`{unsupported:true}`）并**登记到降级统计**。
   **主页面经典轨没有这一层** → 未实现的名字是裸 `ReferenceError`，且**不进 `__palinkCompatStats`，用户和开发者都看不见**。

3. **事件总线在主页面只有 4 个事件可达。**
   经典轨 `window.eventOn` → `window.eventSource.on` → `SillyTavernPluginRuntime.on` → 只写 `this.listeners`。
   而 `runtime.emit(...)` 全仓只有 4 处调用：
   ```
   CharacterChat.tsx:842/854  MESSAGE_SENT
   CharacterChat.tsx:1802     MESSAGE_RECEIVED
   CharacterChat.tsx:1822     CHAT_CHANGED
   CharacterView.tsx:1522     chat_id_changed
   ```
   `lib/event-bus` 上那些 `generation_started` / `generation_ended` / `message_deleted` / `message_swiped` / `message_updated` / 流式事件 **没有桥到经典轨的 listener map**。

---

## 6. 两条已装脚本的逐项对照（最有价值的表）

### 6.1 脚本一「对话渲染系统 v7.1」（242 KB）

实际引用的全局：`injectPrompts`(9) `setExtensionPrompt`(8) `eventOn`(3) `tavern_events`(3) `SillyTavern.getContext`(3) `getButtonEvent`(1)

| API | 主页面经典轨 | 后果 |
|---|---|---|
| `injectPrompts` | ✅ 真实现（→ `setExtensionPrompt` → prompt-injection） | 格式规则注入链路通 |
| `setExtensionPrompt` | ✅ 真实现 | 回退路径可用 |
| `eventOn` + `tavern_events` | ✅ 注册成功 | `CHAT_CHANGED` 会触发 ✅ |
| `SillyTavern.getContext` | ✅ | 可用 |
| **`getButtonEvent`** | ❌ **全仓缺失**（仅沙箱有） | `eventOn(getButtonEvent('对话气泡'), ...)` 因 `typeof` 守卫被跳过 → **「对话气泡」按钮入口不注册，头像管理面板无法从按钮打开** |

### 6.2 脚本二「数据库界面插件(@bubble改造版)」（4 MB）

| API | 引用次数 | 主页面经典轨 | 后果 |
|---|---|---|---|
| `SillyTavern` / `SillyTavern.getContext` | 52 / 50 | ✅ | 可用 |
| `getChatMessages` | 17 | ✅ | 可用 |
| `setChatMessages` | 9 | ✅ | 可用 |
| `deleteChatMessages` | 1 | ✅ | 可用 |
| `getLastMessageId` | 1 | ✅ | 可用 |
| `triggerSlash` | 14 | ✅ | 可用 |
| `generateRaw` | 1 | ✅ | 可用 |
| `getRequestHeaders` | 13 | ✅ | 可用 |
| `substitudeMacros` | 8 | ✅ | 可用 |
| `getWorldbook` / `getWorldbookNames` | 1 / 3 | ✅ | 可用 |
| `eventOn` / `tavern_events` | 17 / 13 | ⚠️ 注册成功，但**仅 4 个事件会触发** | 见 §7 |
| **`Mvu`** | 44 | ❌ 主页面无 | `Mvu.getMvuData` 不存在 → 变量作用域读取整体失效 |
| **`getVariables`** | 13 | ⚠️ 仅内联卡挂载后 | 否则 `typeof` 守卫跳过 → 读不到变量 |
| **`replaceVariables`** | 6 | ⚠️ inline 里是 **no-op** | 写回无效 |
| **`getCharacter`** | 3 | ❌ **全仓缺失** | 读角色卡 galgame 配置失效 |
| **`getCharacterNames`** | 4 | ❌ **全仓缺失** | 角色名候选集为空 |
| **`getCharData`** | 6 | ❌ **全仓缺失** | 角色卡数据读不到 |
| **`generate`** | 1 | ⚠️ 仅 inline | 安静生成失效 |
| **`waitGlobalInitialized`** | 4 | ⚠️ 仅 inline | 退化为立即返回 |
| **`iframe_events`** | 2 | ❌ **全仓缺失** | 流式 token 监听不注册 |

**脚本写法是防御性的**（`typeof X !== "function"` / `topWindow?.TavernHelper?.`），所以**不崩，但功能静默缩水**。

---

## 7. 事件投递缺口

两条脚本注册的事件（静态提取）：

| 事件 | 注册次数 | 经典轨是否 emit | 结果 |
|---|---|---|---|
| `tavern_events.CHAT_CHANGED` | 2 | ✅ `CharacterChat.tsx:1822` | ✅ 触发 |
| `tavern_events.MESSAGE_RECEIVED` | 1 | ✅ `CharacterChat.tsx:1802` | ✅ 触发 |
| `tavern_events.GENERATION_STARTED` | 2 | ❌ | **永不触发** |
| `tavern_events.GENERATION_ENDED` | 3 | ❌ | **永不触发** |
| `iframe_events.STREAM_TOKEN_RECEIVED_FULLY` | 1 | — | **`iframe_events` 未定义，注册被跳过** |
| `getButtonEvent('对话气泡')` | 1 | — | **`getButtonEvent` 未定义，注册被跳过** |

**8 个注册点里只有 2 个能触发。** 这是"面板不出/状态不刷新"类症状的高概率成因。

---

## 8. 与既有文档的关系（含订正）

| 文档 | 状态 | 说明 |
|---|---|---|
| `docs/handover-tavern-helper-2026-07-31.md` | **部分过期** | §5.1「事件总线从未 emit」→ 现在有 4 个事件在 emit；§5.2「`window.__palinkChatMessages` 没暴露」→ **已暴露**（`CharacterChat.tsx:1517-1521`）；§3.3 的"三档 API"表已大幅扩容 |
| `docs/HANDOFF_相册与渲染问题_2026-10-03.md` §四 | **不同轴，不冲突** | 它统计的是**插件 `import` 的 ST 内部 ES 模块符号**缺口（35 个符号 / 15 个 slash-commands 模块未知），属**沙箱轨**；本报告统计的是 **`TavernHelper` 对外 API 面**，属**经典轨**。两份合起来才是全貌 |
| `st-plugins/ADAPTATION.md` | 过期 | 只覆盖 ST 1.18.0 官方 11 个扩展，明确写了"酒馆助手不在本扩展内，需另行逆向" |
| `docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md` | 过期 | 2026-06-27 版，不含 tavern_helper |

---

## 9. 建议的推进顺序（按性价比）

> 前提：**不要承诺"全 API 兼容"**。164 项里角色 CRUD / 预设 / 用户人设 / 扩展安装 / 音频 / 酒馆正则这 60+ 项本质是 ST 私有的"管理器" API，Palink 有自有实现，硬对齐没有收益。
> 真正该做的是：**让缺口可见 + 补齐已装脚本真的在用的那 9 项**。

| 优先 | 动作 | 理由 |
|---|---|---|
| **P0** | 在经典轨补 `window.TavernHelper` 命名空间 + **复用 iframe 轨的 Proxy 兜底**（`installTavernHelperCompatProxy` + `makeMissingApiFunction` + `recordStubHit`） | 一次性解决三个结构性问题：命名空间缺失、无兜底、缺口不可见。补完后 `window.__palinkCompatStats` 会**自动列出**这条插件真正缺什么，后续补 API 从"盲补"变成"按计数补" |
| **P0** | 补 `getButtonEvent`（沙箱轨已有实现，直接搬）+ 经典轨按钮事件派发 | 直接修复脚本一的面板入口 |
| **P1** | 补 `getCharacter` / `getCharacterNames` / `getCharData`（沙箱轨已有实现，搬过来 + 接真实数据） | 4+6+3 = 13 处引用，且是"角色卡配置读取"的主路径 |
| **P1** | 把 `eventBus` 的 `generation_started/ended`、`message_updated/deleted/swiped`、流式事件桥到经典轨 `listeners` | 修复 5 个永不触发的事件注册 |
| **P1** | 主页面补 `iframe_events` 常量表（纯常量，零成本） | 解除流式监听注册的跳过 |
| **P2** | `Mvu` 真实现（对齐 `backend/app/services/mvu_engine.py` 的变量结构） | 44 处引用，是状态栏类脚本的数据源 |
| **P2** | 把 `inline-st-globals` 的 `getVariables/replaceVariables/generate/waitGlobalInitialized` 从"内联卡条件触发"改成"主页面常驻" | 消除偶发性 |
| **P3** | 上述完成后再评估 105 项里是否还有真实需求 | 用 `__palinkCompatStats` 计数驱动，不要预判 |

**回归验证口径**：每补一项，在角色页 Console 跑
```js
window.__palinkCompatStats          // 缺口计数应下降
```
（注意：生产构建 terser `drop_console: true` 会剥掉 `console.*`，但 `__palinkCompatStats` 不经过 console，**线上仍可见**。）

---

## 9.5 真机复现补充（2026-10-03 晚，Playwright + 系统 Chrome 实测）

> 手段：`playwright-core` 驱动系统 Chrome，登录 `:13000`（admin/admin123）→ `/characters` → 打开「露缇雅1.2」会话。
> 本节全部为**运行时实测**，不是静态推断。

### 9.5.1 反直觉结论：相册按钮是**好的**

| 检查项 | 实测 |
|---|---|
| `#tavern-cg-float-btn` | 存在，`position: fixed`，`z-index: 999998`，52×52，位于右下角 (1368, 750) |
| 点击后 | `#tavern-cg-modal` → `display: flex`、`opacity: 1`、class 含 `active` |
| 结论 | **相册悬浮按钮与弹窗链路完全正常，不是问题源** |

（注：`offsetParent === null` 是因为 `position: fixed`，不是不可见——排查时别被这个误导。）

### 9.5.2 真正在报错的两行（决定"功能用不了"）

```
Uncaught ReferenceError: z is not defined
  at https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js:1:362
Uncaught ReferenceError: Vue is not defined
  at https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js:2:332847
```

**这两条直接打死整个变量系统**（变量结构脚本 + MVU 引擎双双加载失败 → `Mvu` 为 `undefined` → 状态栏 / 好感度 / 变量面板全失效）。

**根因（对照上游源码，非猜测）**：JS-Slash-Runner 本来会**免费送**一批全局给脚本——

| 上游机制 | 文件 | 提供什么 |
|---|---|---|
| `initThirdPartyObject()` | `src/third_party_object.ts` | `globalThis.z = zod`、`globalThis.YAML` |
| 脚本 iframe 预置 | `src/iframe/predefine.js` | 从父窗口合并 `_ / z / YAML / showdown / toastr / EjsTemplate / TavernHelper / Mvu / SillyTavern` |
| 脚本 iframe 模板 | `src/iframe/third_party_script.html` | 从 CDN 加载 **Vue + vue-router**（`vue.runtime.global.prod.min.js`） |

**Palink 一个都没提供**：全仓 grep `window.z =` / `window.Vue =` **零命中**；`package.json` 里连 `zod` / `vue` 依赖都没有；`_`（lodash）只有 `get / set / cloneDeep / isEmpty` 四件套。

### 9.5.3 插件在 iframe 里认不出角色

同一份插件在两个环境各跑一次，日志对照：

| 环境 | 日志 | 结果 |
|---|---|---|
| 主页面（`[main]`） | `ensureTitleScreenSettings {charAliases: Array(2), currentCharId: 露缇雅1.2::slot::1333400005}` | ✅ 正确 |
| 智能卡 iframe（`palink-st-extension-…`） | `ensureTitleScreenSettings:skip-fallback-char {charAliases: Array(1), currentCharId: default}` | ❌ 回退 default |

**根因**：插件 `readCharacterDataById()` 对 `Array.isArray(characters)` 走数组分支，且守卫是
`numericId < characters.length`。
- iframe 的 `characters` 是 `[{…}]`（length = 1），而 `characterId = 1333400005` → **守卫不过 → 名字空 → `"default"`**。
- 主页面**碰巧**能过：`sillyTavernPluginRuntime.ts:838` 用 `characters[String(characterId)] = …` 把角色挂进数组，使数组 `length` 变成 **1333400006**（稀疏数组）。

→ 同一份插件，两个环境行为不一致；iframe 里所有"按角色"的配置都读不到。

### 9.5.4 面板本身没有创建

| 元素 | 实测 |
|---|---|
| `#gal-global-overlay` | **不存在** |
| `#galgame-database-container` | **不存在** |
| `.gal-action-btn` | **0 个** |
| `window.__palinkCompatStats` | 只有 `getGlobalWorldbookNames: 1` |

插件脚本确实注入了（`script[data-palink-st-plugin-id="eb1d50e9-…"]` 在 DOM 中，控制台有
`[Galgame界面插件] Phase 1-9 模块加载成功, 版本: 2.2.1`），但**没有产出任何 UI**。

### 9.5.5 Live2D 被 CORS 拦

```
Access to fetch at 'http://localhost:13000/live2d/pixi.min-local.js' from origin 'null'
has been blocked by CORS policy
[Galgame界面插件] Live2DManager: SDK 加载失败
```
iframe 是 opaque origin（`null`），同源资源请求被拦 → Live2D 立绘全废。

### 9.5.6 真机验证带来的修复优先级修正

| 优先 | 动作 | 依据 |
|---|---|---|
| **P0** | 补 `z`(zod v4) / `Vue`(3.5.x) / `YAML` / `showdown` 全局（对齐上游 `predefine.js`） | 两行 ReferenceError 直接打死变量系统 |
| **P0** | 修 iframe 的 `characters`，让 `characters[characterId]` 可解析 | `currentCharId: default` 实测 |
| **P1** | 主页面补 `TavernHelper` 命名空间 + Proxy 兜底 | 见 §5.3 |
| **P1** | 修 Live2D 资源同源/CORS（或改由父页面代理加载） | `origin 'null'` 实测 |
| ~~—~~ | ~~相册按钮~~ | **实测正常，不需要修** |

---

## 9.6 修复实施与复验（2026-10-03 深夜，用户裁定「先修前两项」）

### 9.6.1 改了什么

| # | 文件 | 改动 |
|---|---|---|
| 1 | `frontend/src/lib/sillytavern/st-third-party-globals.ts` | **新增**。从 `testingcf.jsdelivr.net` 装载卡脚本依赖的第三方全局：`_`(lodash 4.17.21) / `Vue`(3.5.13 runtime global) / `showdown`(2.1.0) / `z`(zod **4.4.3**，ESM) / `YAML`(2.8.1，ESM)。幂等、带 8s 超时、失败走 `recordStubHit('st-global:<名>')` 进 `__palinkCompatStats` |
| 2 | `frontend/src/components/views/character/CharacterChat.tsx` | 卡脚本 effect 改成先 `await ensureStThirdPartyGlobals()` 再 `runCardTavernHelperScripts()`（脚本注入即执行 + 按 id 幂等去重，晚到的全局不会让已跑过的脚本重跑），加 `cancelled` 清理 |
| 3 | `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` | `[PARENT-ALIAS]` 新增 `ST_GLOBAL_KEYS` 白名单：`SillyTavern` / `TavernHelper` / `Mvu` / `EjsTemplate` / `YAML` / `showdown` / `toastr` / `z` / `eventSource` / `getVariables` / `getChatMessages` / `getButtonEvent` 等，**返回 iframe 自己的同名全局**（与既有 `jQuery`/`$` 同策略，不暴露真实父帧）；`has` trap 同步扩表 |
| 4 | `frontend/src/lib/sillytavern/__tests__/st-third-party-globals.test.ts` | **新增** 6 例：不覆盖既有实现 / lite `_` 被替换 / 幂等复用同一 Promise / 失败进降级统计 / zod 锚定 v4 且走 ESM / 全部走 jsdelivr 镜像域 |

### 9.6.2 复验结果（同一台真机、同一张卡）

| 检查项 | 改前 | 改后 |
|---|---|---|
| 主页面 `typeof z` | `undefined` | **`object`**（`z.z.ZodObject` = function ✓） |
| 主页面 `typeof Vue` | `undefined` | **`object`** |
| 主页面 `typeof _` | `undefined` | **`function`**（`_.clamp` = function ✓） |
| 主页面 `YAML` / `showdown` | 均 `undefined` | **均 `object`** |
| `pageerror: z is not defined` | **有** | **消失** |
| `pageerror: Vue is not defined` | **有** | **消失** |
| iframe `typeof parent.SillyTavern` | `undefined` | **`object`** |
| iframe `typeof parent.Mvu` / `parent.TavernHelper` | 均 `undefined` | **均 `object`** |
| 插件日志 `currentCharId`（iframe） | **`default`** | **`露缇雅1.2::slot::0`**（认出角色名了） |
| 插件日志 `currentCharId`（主页面） | `露缇雅1.2::slot::1333400005` | 不变 |
| `localStorage` 是否被写坏 | — | **否**（只有卡脚本自己的 `palink:card-storage:v1:*` 命名空间键，无 `galgame-ui-plugin_*` 污染） |

门禁：`tsc --noEmit` **exit 0**；`vitest run` **50 文件 / 665 passed / 3 skipped / 0 failed**（新增 1 文件 6 例后为 51 文件）。

上线核验：容器入口已切到 **`index-BsrhZEHM.js`**，容器内 `grep ST_GLOBAL_KEYS` = **1**（旧产物 = 0）。

### 9.6.3 【最重要】真凶：Palink 每次加载都在**主动删掉**插件的启用开关

复验时发现一个反直觉现象：写入启用标记 → 刷新 → **标记消失**（同一次会话里写一个对照键 `__probe_keep__` 则正常存活）。

追到 `frontend/src/utils/sillyTavernPluginRuntime.ts:1605` 的 `cleanupGalgameState()`：

```ts
// 清理 Galgame 插件持久化状态：… Palink 中角色 ID 映射与原版 ST 不同，
// 插件回退到 "default" 键；一旦 default=true 被写入，每次加载都会自动启用
// Galgame overlay，即使切换角色也不会关闭。… 清理此键，确保插件以初始状态
// （未启用）启动，用户需手动点击启用按钮才能激活 Galgame 模式
try {
  localStorage.removeItem('galgame-ui-plugin_char_enabled');
} catch {}
```

**这是一条「症状级 workaround」**：当年修不了「插件把当前角色认成 `default`」，于是干脆
**每次进对话页都把启用开关删掉**。

| 影响 | 说明 |
|---|---|
| 用户**永远无法保留** Galgame 模式启用状态 | 每次加载被清空 |
| 表现 | **面板/按钮永远不出现** —— 正是用户报的「功能用不了」 |
| 是否 Palink 自己的锅 | 是。插件本体全仓 `removeItem` **零命中**，不是插件删的 |

**根因已在 §9.6.1 第 3 条修好**（iframe 不再回退 `default`），所以这条 workaround 的
**前提已经消失**，而它的副作用还在。改法（本次已实施）：**定向清脏** —— 只删
`default` 这一个键（身份识别失败的产物），保留按角色的正常条目。
即使将来身份解析再回归，`default` 也会被清掉，**原有防护意图保留、误伤去掉**。

### 9.7 本轮改动汇总（5 个文件）

| 文件 | 类型 | 说明 |
|---|---|---|
| `lib/sillytavern/st-third-party-globals.ts` | 新增 | 第三方全局装载器 |
| `lib/sillytavern/__tests__/st-third-party-globals.test.ts` | 新增 | 6 例契约测试 |
| `components/views/character/CharacterChat.tsx` | 改 | 注入卡脚本前 await 全局 |
| `components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` | 改 | `[PARENT-ALIAS]` 扩 `ST_GLOBAL_KEYS` 白名单 |
| `utils/sillyTavernPluginRuntime.ts` | 改 | `cleanupGalgameState()` 整键删除 → 定向清 `default` |

### 9.8 最终复验：面板与按钮**已经出现**（2026-10-03 深夜，同一台真机）

启用标记写入 `{"露缇雅1.2::slot::1333400005":true, "default":true}` → 刷新后：

| 检查项 | 结果 |
|---|---|
| 启用标记 | `{"露缇雅1.2::slot::1333400005":true}` —— **`default` 脏键被清、按角色条目保留** ✅（定向清脏生效） |
| `#gal-global-overlay` | **存在，class 含 `active`** ✅ |
| `.gal-action-btn` | **2 个** ✅ |
| `.gal-open-btn` | **5 个** ✅ |
| 截图可见 | 顶部状态栏（未知地点 / 全屏）、「旁白」正文框、「重绘当前」「自由对话」、底部工具条 `LOG / CLOSE / VIEW / CONFIG / SAVE / LOAD / TL / PREV / AUTO / SKIP / NEXT`、「三剧情选项」 ✅ |

**结论：用户报的「按钮按不了」已修复并真机确认。** 三条因果链全部打通：

1. `z` / `Vue` 缺失 → 变量系统整片瘫痪 → **已补**（§9.6.1 第 1、2 条）
2. iframe 父窗口别名把 `SillyTavern` 挡成 `undefined` → 插件认成 `default` → **已修**（§9.6.1 第 3 条）
3. `cleanupGalgameState()` 每次加载删掉启用开关 → 面板永远不出现 → **已改为定向清脏**（§9.6.3）



### 9.6.4 仍未做（本轮范围外，需用户拍板）

1. **iframe 与主页面的 per-character key 不一致**：iframe 报 `slot::0`（`SillyTavernCompatRuntime.ts:2846/2876` 把 `window.this_chid` 显式设为 0，走 ST 数组索引语义），主页面报 `slot::1333400005`（`pluginCharacterIdFromUuid` 的 UUID 哈希）。
   - 实测当前**无副作用**：两个实例都没有在加载时写 `galgame-ui-plugin_*`，`localStorage` 干净。
   - 但一旦用户在 iframe 侧触发一次写操作，就会用不同的 key 覆盖同一份 `_settings` / `_charEnabledMap`。
   - 统一要动 `this_chid` 语义（影响 iframe 内所有卡脚本的身份），属独立议题。
2. **`window.TavernHelper` 命名空间在主页面仍缺失**（本报告 §5.3 P0 第 3 条），本轮未做。
3. **Live2D 跨域**（§9.5.5）未做。
4. **同一份插件脚本在主页面与 iframe 各跑一遍**（跨环境无去重）——iframe 那份的 UI 挂在 iframe 文档里，用户看不见，属"影子实例"。是否停掉需拍板。

---

## 9.9 溯源：那个「Galgame 插件」到底是哪来的

> 用户追问「这个 Galgame 插件是从哪来的？」。以下是查证结果（全部有物证）。

### 9.9.1 它不是独立插件，是「酒馆助手」这条记录里的**第 2 条脚本**

| 项 | 值 |
|---|---|
| DB 里唯一那条插件记录 | `酒馆助手`（`id=eb1d50e9-9f19-43ea-a362-75e4266b4991`，`plugin_type=tavern_helper`） |
| 记录创建时间 | **2026-07-30 18:00:23** |
| `source_type` | **`character_card_extension`** → 从某张角色卡的 `extensions.tavern_helper.scripts` 提升而来 |
| `user_id` | **`NULL`** → 账号级全局，**不绑定任何角色卡** |
| 脚本 0 | 「对话渲染系统 v7.1」（242,270 字节）—— 管气泡渲染 + 格式规则注入 |
| 脚本 1 | 「数据库界面插件(@bubble改造版)」（4,034,225 字节）—— **就是 Galgame UI** |

脚本 1 的**自报身份**（在它自己的正文里）：

```js
SCRIPT_NAME = "Galgame界面插件"
SCRIPT_ID   = "galgame-ui-plugin"
VERSION     = "2.2.1"
```

DB 里那个「数据库界面插件(@bubble改造版)」是**来源卡给它的名字**，它自己管自己叫「Galgame界面插件」。
控制台日志 `[Galgame界面插件] Phase 1-9 模块加载成功, 版本: 2.2.1` 即出自它。

### 9.9.2 来源卡是 **BanG! City**，而且**那张卡已经不在库里了**

- `docs/handover-tavern-helper-2026-07-31.md:54` 原文：
  > 脚本原始内容备份在 `/tmp/tavern_scripts/combined.js`……**这是唯一备份，原始 `BanG_City.json` 角色卡文件不在仓库里。**
- `.trae/specs/fix-character-ui-rendering/spec.md` 亦以 **BanG! City** 作为该类卡的样例。
- 实测：**当前库里 24 张卡，没有任何一张的 `extensions.tavern_helper.scripts` 含这个脚本**
  （只有 露缇雅1.2 的「相册/MVUbeta/变量结构」和 我被猫娘包围了！的「变量结构/MVU」）。

→ 它是**孤儿「公共复印件」**：来源卡没了，但这条全局插件记录还在，且 `enabled=True`。

### 9.9.3 为什么它对**每一张卡**都生效

`docs/DEEP_AUDIT_REPORT_2026-08-09.md` 与 `TODOS.md:617` 记录了原因：
`tavern_helper` 型插件**豁免**了「卡内扩展来源插件不得全局执行」的守卫
（`[GUARD-TH-EXEMPT]`，2026-08-28 用户拍板），`config.global_runtime:false` 对它不生效。
所以它对所有角色都会注入、都会跑。

### 9.9.4 ⚠️ 只剩 DB 一份，没有第二份

| 备份位置 | 状态 |
|---|---|
| `C:\Users\Pall\AppData\Local\Temp\tavern_scripts\combined.js` | **已不存在** |
| 仓库里的 `BanG_City.json` | **从来没有** |
| 磁盘上任何 `*BanG*` 卡文件 | **搜不到** |
| **DB `plugin_scripts` 表** | **唯一存活副本** |

建议：把这两条脚本从 DB 导出到 `_BACKUPS/` 下的持久位置（现在删库 = 永久丢失）。

### 9.9.5 用户裁定：**保留**（2026-10-04 00:15）

用户给出的判据是：「如果是在酒馆助手里，就保留；如果是在角色卡里，就全部删掉。」

**核实结果 → 在酒馆助手里 → 保留，不做任何删除。**

三条独立证据（2026-10-04 00:15 实测）：

| # | 检查 | 结果 |
|---|---|---|
| ① | `plugins` 表全量 | **1 条**：`eb1d50e9-…` / 酒馆助手 / `tavern_helper` / `enabled=True` |
| ② | `plugin_scripts` 表全量 | **2 行，两行的 `plugin_id` 都 = `eb1d50e9-…`**（即都挂在酒馆助手下）。`order=1` 那行（4,034,225 字节）**含 `Galgame界面插件` + `galgame-ui-plugin` 两个标记** |
| ③ | 角色卡侧 | **全列扫描 21 张卡 → 0 命中**（按 `galgame-ui-plugin` / `Galgame界面插件` 两个标记扫 `Character` 表全部 33 列，含 `extensions` / `palink_raw_card_data` / `preset_data` / `ui_config` 等） |

> ⚠️ 取数口径说明：会话开始时是 24 张卡，复查时 21 张（期间有 3 张被删除，含 `露缇雅1.2 / 3e31f857`、`我被猫娘包围了！` 两份）。上表 ③ 的「21 张」是复查时的实际值。

**补充定性**：`source_type = character_card_extension` 只表示**当初是从某张卡导入的**（即"血统"来自卡），
**不代表现在它存在卡里**。导入时它已被**提升为独立的插件记录**（`user_id=NULL` 账号级），
此后与来源卡解耦 —— 来源卡（BanG! City）现已不在库中，脚本仍完整存在于 `plugin_scripts`。

### 9.9.6 若日后改判据（备查）

| 情形 | 处置 |
|---|---|
| 保持现状 | 不动。Galgame UI 对所有卡可用 |
| 只想让它在 BanG 卡生效 | 需先有那张卡；当前实现不记来源卡，要改导入路径记录 `source_character_id` |
| 想全局下线 | 插件管理里停用该插件，或只停 `order=1` 那条脚本（气泡渲染脚本 0 不受影响） |

---

## 9.10 第二轮修复：变量引擎 / 生成事件 / Live2D（2026-10-04 00:20–01:00）

> 用户指令：「那就请你继续修」。范围 = §9.6.4 列的三项。

### 9.10.1 ① `window.Mvu` 挂载 —— 变量引擎整条加载链

**根因不是"缺 Mvu"，而是 MVU bundle 在模块顶层就撞上一串 Palink 缺失的 API，
第一个就抛错 → 整个模块死掉 → Mvu 永不出现。** 逐层剥出来的链（真机 + 关跨域屏蔽取真实堆栈）：

| 顺序 | 报错 | 缺的是什么 |
|---|---|---|
| 1 | `TypeError: Expected a function` @ `lodash debounce` | `SillyTavern.saveChat`（bundle 顶层 `_.debounce(SillyTavern.saveChat, 1e3)`） |
| 2 | `ReferenceError: getScriptId is not defined` | 脚本身份 + 同名脚本去重机制 |
| 3 | `ReferenceError: getTavernHelperVersion is not defined` | 版本号（MVU 有 `>= 3.4.17` 硬门槛） |
| 4 | 脚本按钮族缺失 | `getButtonEvent` / `getScriptButtons` / `replaceScriptButtons` / `appendInexistentScriptButtons` … |

**修法**（`sillyTavernPluginRuntime.ts` setup 脚本新增 `[MVU-UNBLOCK]` 段）：
补 `SillyTavern.saveChat`(+`saveChatConditional`) / `getScriptId`+`getScriptName`+`getIframeName`+`getScriptInfo`+`reloadIframe`
/ `getTavernHelperVersion`(`'3.4.17'`)+`getTavernVersion` / 脚本按钮族 / `#tavern_helper` 容器
/ `#extensions_settings2` 挂载点。

**实测结果（正式构建、无任何注入桩）**：

| 检查项 | 结果 |
|---|---|
| `typeof window.Mvu` | **`object`** ✅ |
| `Mvu.getMvuData` / `setMvuVariable` | **`function`** ✅ |
| `getMvuData({type:'message',message_id:-1}).stat_data` | **真实数据**：`环境` / `露缇雅` / `世界信息` / `露缇雅1.2` ✅ |
| MVU 设置面板 | `#extensions_settings2 .inline-drawer` **存在** ✅ |
| `#tavern_helper` 容器 | 存在 ✅ |
| `pageerror` | **无** ✅ |

### 9.10.2 ② 生成类事件桥接 —— 面板自动刷新

**根因**：`SillyTavernPluginRuntime.on()` 只写自己的 listeners，而生成类事件由 ST runtime
经 `eventBus` 发出（`EventSourceWrapper.emit` → `eventBus.emit`）。两条轨之间没有桥 →
插件注册的 `GENERATION_STARTED` / `GENERATION_ENDED` **永不触发**。

**修法**：照 `lib/sillytavern/runtime.ts:360` 的同款做法，让 `on()` 同时订阅 `eventBus`：
- **必须解包**：总线把 `...args` 打包成数组当单一 payload，不解包插件会收到 `[message_id]` 而不是 `message_id`。
- **必须排除自 emit 的名字**（`SELF_EMITTED_EVENTS`：MESSAGE_SENT / MESSAGE_RECEIVED / CHAT_CHANGED 及其值形态），否则同一逻辑事件投递两次。
- `off()` 退订同一包装函数；`unloadAll()` 显式退订，避免全局单例 eventBus 长期持有旧实例回调。

**实测**（真机，从 ST runtime 的 eventSource 发事件）：`generation_started` / `generation_ended` / `message_received`
三个事件**全部被 `window.eventOn` 注册的监听器收到**，参数形态正确（`'normal'` / `{message_id:42,…}` / `7`）。

### 9.10.3 ③ Live2D 跨域

**根因**：智能卡 iframe 是 opaque origin，加载父页面源的 `/live2d/*.js` 被判跨源；
响应无 `Access-Control-Allow-Origin` → 浏览器直接拦 → `Live2DManager: SDK 加载失败`。

**修法**（`frontend/nginx.conf`）：新增 `location ^~ /live2d/`，对这一个纯静态第三方运行时目录
加 `Access-Control-Allow-Origin: "*"`。（按源白名单不可行 —— iframe 的 `Origin` 恒为字面量 `"null"`。）

**实测**：

| 检查项 | 改前 | 改后 |
|---|---|---|
| `/live2d/pixi.min-local.js` 响应头 | 无 ACAO | **`access-control-allow-origin: *`** ✅ |
| 控制台 CORS 报错 | 有 | **消失** ✅ |
| `Live2D 2.1.00_1` 加载日志 | 无（被拦） | **出现** ✅ |
| `window.PIXI.live2d.Live2DModel` | — | **`function`**（PIXI 6.5.10） ✅ |
| `window.galgame.Live2DManager.isReady` | — | **`true`** ✅ |

> ⚠️ 残留：iframe 内那个"影子实例"仍会报一次 `PIXI.live2d 未就绪` —— 因为它读的是
> `window.parent.PIXI`，而 iframe 自己的 `window.PIXI` 是空的（PIXI 只在主页面加载）。
> 该实例的 UI 本来就不可见，**不影响用户侧**。

### 9.10.4 本轮改动文件（3 个）

| 文件 | 说明 |
|---|---|
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | 新增 `[MVU-UNBLOCK]` 段（~110 行）+ `SELF_EMITTED_EVENTS` + `on/off` 事件桥 + `unloadAll` 退订 |
| `frontend/nginx.conf` | 新增 `location ^~ /live2d/`（CORS） |
| `_BACKUPS/_INDEX.md` | 台账登记 |

门禁：`tsc --noEmit` **exit 0**；`vitest run` **51 文件 / 671 passed / 3 skipped / 0 failed**。

---

## 9.11 当前缺口盘点（2026-10-04 00:50，运行时实测 + 静态重算）

### 9.11.1 已经就位的（运行时实测）

| 项 | 值 |
|---|---|
| `Mvu` / `z` / `Vue` / `_` / `PIXI` | 全部 object/function ✅ |
| `Mvu.getMvuData().stat_data` | 真实变量：`环境` / `露缇雅` / `世界信息` / `露缇雅1.2` ✅ |
| MVU 设置面板 | `#extensions_settings2 .inline-drawer` 存在 ✅ |
| 脚本按钮 | `getScriptButtons()` 返回 **6 个已注册按钮**（MVU + 对话渲染系统都注册成功）✅ |
| `eventOn` / `getButtonEvent` / `getVariables` / `getTavernHelperVersion` | function ✅ |
| `pageerror` | **无** ✅ |

### 9.11.2 仍然缺的（按对用户的影响排序）

| 优先 | 缺口 | 实测证据 | 影响 |
|---|---|---|---|
| **P0** | **脚本按钮栏 UI 不存在** | 已注册 6 个按钮，但 `#palink-script-buttons` / `.tavern-script-buttons` **查无此元素** | 按钮注册了却**没地方显示** → 「对话气泡」这类按钮仍然点不到 |
| **P0** | **`window.TavernHelper` 总目录缺失** | `typeof TavernHelper` = `undefined` | 卡脚本写 `TavernHelper.xxx` 一律失败（只有解构出来的裸全局可用） |
| **P1** | **变量写入通道** | `updateVariablesWith` = `undefined`；`getVariable` = `undefined`；`setVariable` 的**函数体**就是降级桩：`function(){D("setVariable","卡内脚本回写会话变量未开放（Palink 变量更新走后端 MVU 链路）")}`，调用后 `__palinkCompatStats` 新增 `setVariable:1`（实测） | MVU 能**读**变量但**写**不进去 → 变量面板可显示，AI 输出驱动的变量更新可能落空。⚠️ 这是 Palink **刻意**关闭的边界（变量更新走后端 MVU 链路），需产品拍板 |
| **P1** | 事件族不全 | `eventOnce` / `eventClearAll` / `iframe_events` = `undefined` | 用这几个注册的脚本静默失效 |
| **P1** | 角色读取族 | `getCharacter` / `getCharData` / `getCurrentCharacterId` = `undefined` | 读角色卡配置的脚本失效（沙箱轨有实现，未搬到经典轨） |
| **P2** | iframe 影子实例 | 仍报一次 `PIXI.live2d 未就绪`；per-character key 用 `slot::0`（主页面用 `slot::<哈希>`） | 该实例 UI 不可见，当前无用户可见影响 |
| **P2** | **95 项管理器类 API 全无实现** | 静态重算：`[D] NEITHER = 95`（角色 CRUD 7 / 预设 15 / 人设 11 / 世界书条目 20 / 扩展管理 6 / 音频 8 / 导入 raw 5 / 生成控制 5 / 酒馆正则 5 / 事件 5 / 其他 13） | **不建议做**：Palink 有自有实现，硬对齐无收益 |

### 9.11.3 静态口径变化（本轮前后）

| 口径 | 修复前 | 现在 |
|---|---|---|
| 主页面经典轨提供的 API 数 | 36 / 164 | **46 / 164**（A 27 + C 19） |
| 四层全无实现 | **105** | **95** |
| 主页面 `window.*` 全局数 | 47 | **53** |

---

## 9.12 「补齐全部 API」的风险评估（2026-10-04，用户提问触发）

> 用户问：「这些 API 都是干什么的？全补齐会不会影响整个项目的正常运行？」

### 9.12.1 结论

| 问题 | 答案 |
|---|---|
| 目前的状态会不会影响项目正常运行？ | **不会**。本轮补的全是「全局变量 + 只读桥接 + 前端 UI」，**没有新增任何写数据库的路径**。唯一的"写"仍是早就存在的 `setChatMessages`。 |
| 那"全补齐"呢？ | **会，而且有四类真风险**（见 §9.12.3）。**不建议全补。** |

### 9.12.2 这 95 项是干什么的（按功能族 + 风险）

| 族 | 数量 | 干什么的 | Palink 有没有对应 | 风险 |
|---|---|---|---|---|
| **只读类**（世界书/预设/人设/正则的读） | ~19 | 读现有配置，不写 | ✅ 有 | 🟢 低 |
| **事件族** | 5 | `eventOnce` / `eventClearAll` 等纯前端订阅管理 | — | 🟢 低（零成本） |
| **常量/类型导出** | ~5 | `builtin` / `default_preset` / `EjsTemplate` / `RawCharacter` | — | 🟢 低（空对象即可） |
| **角色 CRUD** | 5 | 建卡/改卡/删卡 | ✅ `characters` 表 + 角色管理页 | 🔴 高（写库+不可逆） |
| **世界书写** | 12 | 增删改世界书条目/设置 | ✅ `world_books` 等 6 张表 | 🔴 高（写库+不可逆） |
| **预设写** | 8 | 增删改/切换生成预设 | ✅ `prompt_presets` + `/presets` 端点 | 🔴 高（写库） |
| **人设写** | 5 | 增删改"我"的身份卡 | ✅ `personas` 表 | 🔴 高（写库） |
| **正则写** | 2 | 改写正则脚本 | ✅ `regex-pipeline` | 🟡 中 |
| **消息写** | 2 | 新建/轮换消息 | ✅ 有 | 🟡 中 |
| **导入 raw** | 5 | 把原始 JSON 灌进系统 | ⚠️ 部分 | 🔴 高（任意数据写入） |
| **扩展安装** | 6 | 装/卸/更新第三方插件 | ✅ `plugins` 表（**管理员操作**） | 🔴 **最高（任意代码执行）** |
| **生成控制** | 5 | 取模型列表 / 停止生成 | ⚠️ 部分 | 🟡 中（接管生成生命周期） |
| **音频** | 8 | 播放/管理背景音 | ⚠️ 只有 TTS，无 BGM 管理 | 🟡 中（文件系统访问） |

### 9.12.3 四条真风险机制

1. **数据源分裂（双写）**：Palink 已有 `prompt_presets` / `personas` / `world_books` / `characters` 表和自己的端点。
   再按 ST 语义补一套写接口，就是**同一批数据两条写路径** —— 字段口径稍有差异就会出现
   「在 A 处改了、B 处不生效」或互相覆盖。
2. **权限模型被绕过**：Palink 的插件管理、角色删除都是**管理员**操作（带权限校验）。
   卡脚本是**普通用户内容**（角色卡自带）。一旦把 `installExtension` / `deleteCharacter` 暴露给它，
   等于**普通用户内容拿到了管理员能力**。
3. **任意代码执行**：`installExtension` / `importRaw*` 的本质是「把外部代码/数据注入系统」。
   当前这个插件的**来源卡（BanG! City）已经不在库里**，等于**来源不明的 4MB 第三方脚本**——
   再给它代码执行接口，风险等级与现在完全不同。
4. **不可逆操作无确认**：`deleteWorldbook` / `deleteCharacter` / `deleteLorebook` 没有二次确认流程。
   卡脚本一句 `deleteWorldbook('x')` 就能删掉用户数据。

### 9.12.4 本轮唯一的安全面变化（如实记录）

`frontend/nginx.conf` 给 `/live2d/` 开了 `Access-Control-Allow-Origin: *`。
影响面：该目录只有 pixi / Live2D 官方运行时（公开 JS，无用户数据、无凭据），
且 iframe 的 `Origin` 恒为字面量 `"null"`，按源白名单不可行。**属可接受取舍，但确实扩大了 1 个目录的读取面。**

### 9.12.5 建议的边界

| 层 | 范围 | 处置 |
|---|---|---|
| **补** | 只读类 + 事件族 + 常量 + 脚本按钮栏 UI + `TavernHelper` 总目录 | ~25 项，1 轮可完成，**零写库风险** |
| **按需** | 生成控制 / 音频 / 正则写 / 消息写 | 有真实卡需要再逐项评估 |
| **不补** | 角色/世界书/预设/人设的写 + 导入 raw + 扩展安装（约 45 项） | 在文档里**明确记「为什么不补」**，避免后续 agent 误以为遗漏 |

---

## 10. 未验证项（需浏览器实跑，本报告未覆盖）

1. ~~**经典轨与 iframe 轨是否真的都在执行同一份脚本**~~ → **已证实：两处都在跑**（主页面 script 节点 + iframe 内 `palink-st-extension-…` 日志），且**跨环境没有去重**。
2. ~~**`ensureInlineStGlobals()` 在这条聊天页到底触发没有**~~ → **已证实触发**：主页面 `typeof getVariables === 'function'`。
3. **`window.__palinkChatMessages` 的实际内容形态**是否满足脚本对 `swipes/swipe_id/extra` 的期待。（仍待验证）
4. **`getChatMessages` 在经典轨返回的数据**是否含脚本需要的 `message_id` 字段。（仍待验证）
5. **哪些缺失 API 是裸调用（未加守卫）** —— 实测未捕获到裸调用导致的 ReferenceError（只有 CDN 的 `z`/`Vue` 两条），说明现有两条脚本守卫得比较完整；**新卡仍需逐个实跑**。
6. **补上 `z`/`Vue` 后变量系统能否真正跑通**（需实施后再验）。

---

## 附：取数命令（可复算）

```bash
# 插件记录与脚本
docker compose exec -T backend python3 -c "
from app.database import SessionLocal
from app.models.plugin import Plugin
db=SessionLocal(); p=db.query(Plugin).filter(Plugin.plugin_type=='tavern_helper').first()
print(p.id,p.name,p.source_type,len(p.scripts)); db.close()"

# 运行载荷
docker compose exec -T backend python3 -c "
from app.api.plugins import _plugin_runtime_payload
from app.models.plugin import Plugin
from app.database import SessionLocal
db=SessionLocal(); p=db.query(Plugin).filter(Plugin.plugin_type=='tavern_helper').first()
pl=_plugin_runtime_payload(p); print(pl['runtime'], pl['manifest'], [len(i['content']) for i in pl['resources']['js']]); db.close()"

# API 面清单（134）
grep -oE "readonly [A-Za-z_]+: typeof" st-plugins/third-party/JS-Slash-Runner-main/@types/function/index.d.ts | wc -l

# 经典轨全局清单（47）
sed -n '804,1453p' frontend/src/utils/sillyTavernPluginRuntime.ts | grep -oE "window\.[A-Za-z_$][A-Za-z0-9_$]*" | sort -u

# 四个"全仓缺失"的名字
grep -rn "window.getCharacter \|window.getCharacterNames\|window.getCharData\|window.iframe_events" frontend/src   # 期望 0 命中
```
