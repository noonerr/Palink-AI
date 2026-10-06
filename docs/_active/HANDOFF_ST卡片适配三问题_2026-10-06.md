# HANDOFF：ST 卡片适配三问题 — 完工交接（2026-10-06）

> **状态：三个问题已修已上线并真机验收通过；第四个（设置按钮）根因已定位，
> 已补「可见性」修复并上线，卡本身崩因未修（第三方 CDN 模块）。**
> 作者：ST 适配排查会话。分支 `st-plugin-compat-20260727`。
>
> **本文件取代** [`HANDOFF_ST卡片适配三问题_2026-10-05.md`](./HANDOFF_ST卡片适配三问题_2026-10-05.md)
> 的结论主体（10-05 版仅其「订正说明」块仍有效，正文四节结论已被本版覆盖）。
> 配套规格：[`spec/SPEC_ST卡片适配核查与修复_2026-10-05.md`](./spec/SPEC_ST卡片适配核查与修复_2026-10-05.md)
>
> ⚠️ **不要相信任何早于本文件的口头汇报或记录**。本轮共 **5 次自我推翻**，
> 其中第 5 次是「修复已实测生效」的假阳性，连交接文档都被它写错过一次。
>
> **⚠️ 本文件已按「只进不出」订正两处**（2026-10-06 深夜，控制台治理会话）：
> ① §2 的「控制台报错消失」**与实测不符**（那条报错仍在），原句保留并加订正块；
> ② §4 由「挂起 / 根因未定位」→「**根因已定位**」，原三假设否证记录保留。
> 新增 §4.4「F12 控制台噪音治理」。订正记录见
> [`.workbuddy-ai/memory/2026-10-06.md`](../../.workbuddy-ai/memory/2026-10-06.md)。

---

## 0. 一分钟版

| 用户反馈 | 结论 | 状态 |
|---|---|---|
| 是不是定向适配（传几张卡适配几张） | **不是**。全仓零卡 UUID / 卡名硬编码 | ✅ 排除，无需改 |
| 回忆相册解锁不了立绘 | 三层原因：① 装配把 at-depth 条目连坐丢弃（**我们的 bug**）② 注入后被当世界书正文裁掉（**我们的 bug**）③ 预算基数取了兜底假值 4096（**配置**） | ✅ ①② 已修已上线；③ 用户已把窗口改为 1048576 |
| 面板变量全是默认值 | 主页面缺 5 个 ST 全局 + 后端按名取书对角色绑定书恒空 | ✅ 已修已上线（19 条恢复） |
| iframe 正文里的设置按钮点不动 | 卡脚本 init 中途抛错死掉（崩在它自己从 CDN 拉的 `legacy_chat.ts:9`）⇒ `setEventsRefs` 永不执行 ⇒ 点击处理器里 ref 为 null 且**无 else 无报错** | ✅ **根因已定位**；已补「可见性」修复并上线，卡本身崩因未修。见 §4 |
| （新）F12 输出太多无意义信息 | 卡被按消息 HTML 块逐帧实例化 ⇒ 同一条日志重复 5~6 次；另有 React 堆栈 / 浏览器原生警告 | ✅ 已上「console governor」去重 + 逃生开关。见 §4.4 |

**相册链路已真机闭环**：新会话 3 条回复中 2 条落库含完整 `<cg>…</cg>`，
卡脚本 `tavern_cg_album_unlocked` 数组长度 = 2（与标签条数对应）。

---

## 1. 相册：三层原因，前两层是真缺陷

### 层 1 — at-depth 条目被正文块连坐丢弃（已修 `f23eeb0`）

`backend/app/services/roleplay_prompt_assembly.py` 的 `_append_worldbook_context` 里，
`depth_entries` / `em_top_entries` / `em_bottom_entries` / `outlet_entries` 四段被写在
`if wb_result.text:` **内侧**（同缩进整块吞进去）。正文一旦被 token 预算裁空，
这四类内容**静默全丢**，报告只显示误导性的 `no matched entries`。

ST 权威口径：`getWorldInfoPrompt` 一次返回**六个互不依赖**的结果
（`d:/SillyTavern-release/public/script.js:4575`），at-depth 走扩展注册表 `IN_CHAT`
（`:4612` `setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE, …)`），从不被 before/after 是否为空左右。

### 层 2 — 注入后被当「世界书正文」优先裁掉（已修 `f23eeb0`）

depth 条目插进 `messages` 之后，`_classify_message_identifier` **没有对应分支**，
落到末尾兜底 → 被标成 `worldInfoBefore`（priority 80，`trimmable=True`）参与动态裁剪。
卡片自己声明的格式规范，超预算时和早期聊天历史一起优先出局。

ST 口径：in-chat 注入排在聊天历史预算裁剪**之前**完成
（`openai.js:1325` 先 `populationInjectionPrompts`，`:1331` 才 `populateChatHistory`），
而 `script.js:4834` 的裁剪只遍历聊天历史数组 —— 注入条目不在其中，**结构上永不被裁**。

修法：`_insert_depth_prompt` 插入时打 `_palink_in_chat_injection` 标记 →
分类器认出它 → priority 100 + `trimmable=False`。
identifier 沿用 `chatHistory`（ST 的 `prompt_order` 枚举里没有 in-chat 注入这一槽位，
借用可避免破坏既有 `PromptPreset.prompt_order` 配置）。

### 层 3 — 预算基数取了兜底假值（配置，非代码缺陷）

世界书 token 预算 = **模型窗口 × `world_info_budget`%**（默认 25）。

⚠️ **这一层差点被我误判成「卡太长，物理上无解」——那个结论是错的。**

`deepseek-flash` 这个 id **不在 `model_specs.json` 清单里**（清单只有 `deepseek-v4-flash`），
于是取 `_DEFAULT_FALLBACK_CONTEXT = 4096`（`unified_model_registry.py:48`）
→ 预算仅 1024，而该书 at-depth 常驻合计 14664 token，首条 2685 即溢出、
一票否决（ST 同语义 `world-info.js:4942`，外部复核确认）。

**4096 是兜底假值，不是真实窗口。** 用户已于 2026-10-05 把 `providers.json`
里该模型改为 1048576，改完立刻正常 —— **不用换模型、不用改卡、不用拆书**。

⚠️ **同一个坑的结构性成因，务必记住**：项目里有两条取窗口的路径，口径不一致——

| 路径 | 函数 | 对假 4096 的处理 |
|---|---|---|
| 管理页面 | `resolve_model_token_limits`（`:90` 优先级注释写得很清楚） | **丢弃假 4096**，去找清单真值 |
| 提示词装配 | `_get_model_context_window` | **直接当真实窗口用** ← 坑在这 |

### ⛔ 三条禁做（我差点都做了）

1. **不要改预算算法去迁就卡** —— 排序（`sortFn = b.order - a.order`）、
   百分比预算、`ignore_budget` 我们已与 ST 一致，改了就是偏离 ST + 对其他卡回退。
2. **不要把 ST 的 `context - replyLength` 口径搬进来** —— 我核过 `script.js:5927`
   方向确实没错，但套上去会让预算从 1024 降到 512，**反而更糟**，已撤回。
3. **不要恢复 `if wb_result.text:` 那层包裹** —— 它是层 1 的根因。

---

## 2. 面板变量恒为默认值（已修 `8275064`，已上线）

两个真 bug 串联：

**① 主页面缺 5 个 ST 全局** —— `getCharWorldbookNames` / `getCharWorldbook` /
`getCurrentCharacterId` / `getAllVariables` / `getChatVariables`。
只有 iframe 轨有，主页面轨从未实现。脚本卡的 `tavern_helper.scripts[]` 由
`card-script-runner` 注入**主页面**执行 ⇒ 受害的正是主页面轨，MVU init 抛
`ReferenceError: getCharWorldbookNames is not defined`。

⚠️ 三个实现陷阱（都是我踩过的）：
- `SUPPLIED` 白名单只决定 `TavernHelper` Proxy **认不认这个键**，不负责实现
- 桥缓存惰性 + MVU 在模块顶层 `await` ⇒ 首版直接读缓存返回 `[]`，
  **冷缓存时必须自己 `refreshCharLorebooks` 一次再答**
- 别用 `messageManager.getCurrentCharacterId()`（零调用方、恒返回空串），
  真源只有 `runtime.context.characterUuid`
- 该文件主体是**注入 iframe 的 JS 模板字符串**，注释里出现反引号会炸一堆 `TS1443`

**② 后端 `/api/worldinfo/get` 对角色绑定书恒返回 `{entries:{}}`** ——
`_resolve_worldbook` 硬过滤 `character_id.is_(None)`。
加 `include_character_bound` 参数，**只开在读端点**。
⛔ **`/edit` 与 `/delete` 必须保持「只认全局书」语义** —— 一并放开会把
「删掉角色绑定世界书」变成可达操作，这是刻意留的红线。

上线实测：`getLorebookEntries('露缇雅1.2')` 0 → **19 条**。

> ⚠️ **订正（2026-10-06 深夜，控制台治理会话）**：本行原写「**控制台报错消失**」，
> **与实测不符**。用户随后提供的完整浏览器日志
> `localhost-1791227114044.log`（769 行）里，`legacy_chat.ts:9` 那条
> `TypeError: Cannot read properties of undefined (reading 'length')` **仍在**，
> 类型/文件/调用链与修复前完全一致。
> 该报错与「按名取书」不是同一条链：它来自**这张卡从远程 CDN 动态拉的第三方模块**
> （日志同屏可见 `[SpriteAnimationManager] GSAP未预装，正在从CDN加载...` →
> `GSAP动态加载成功: 3.12.5`；`legacy_chat.ts` 在全仓 grep 零命中，也不在
> `plugin_scripts` 的两个脚本里）。19 条书的修复是**真的**，但「报错消失」是错的，
> 两者不要混为一谈。详见第 4 节的根因定位与
> [`.workbuddy-ai/memory/2026-10-06.md`](../../.workbuddy-ai/memory/2026-10-06.md)。

---

## 3. 附带堵掉的一个独立隐患（值得警惕）

装配往 message dict 里塞 `_palink_*` 私有标记键（`_palink_prompt_id`、
`_palink_char_field_proxy`，加上我这次新用的 `_palink_in_chat_injection`），
而**全仓原本没有任何剥离机制** —— 这些键会原样随 messages 发给推理 API，
OpenAI 兼容端对 message 对象的未知字段**不保证容忍**（严格实现直接 400）。

已在装配 `return` 前统一剥离全部 `_palink_*` 键。实测 27 条消息零泄漏，
且 `<cg>` 等规范内容不受影响（剥离只删键不删内容）。

发现路径本身值得记：我是因为**改测试**才发现的 —— 两处 `assert out[1] == {"role":…, "content":…}`
整 dict 相等断言变红，顺着查才问出「这键会不会发出去」。

---

## 4. ~~挂起~~ → **根因已定位**：iframe 正文里的设置按钮点不动

> **状态更新（2026-10-06 深夜，控制台治理会话）**：根因**已实测定位**，
> 并已落两层"可见性"修复（未修卡本身）。以下保留原三假设的否证记录（别再重复走），
> 新增「已定位的根因」与「本轮做了什么」。

### 4.0 ★★ 真正的根因：**我们缺 API**（2026-10-06 深夜二次定位，推翻 §4.1 的旧结论）

> ⚠️ **本节的结论取代 §4.1。** §4.1 说的"崩在第三方 CDN 模块"**是错的** ——
> 我只证明了 `legacy_chat.ts` 不在 Palink 源码里、也不在那 2 个 plugin_scripts 里，
> 就往"外部 CDN"上归。**实际它是 MVU 插件的源文件**（webpack 打包，sourcemap 是空壳
> 所以 grep 不到文件名）。留下 §4.1 是因为它的日志证据与调用链分析仍有效。

用户追问「是不是我们缺少 API 支持？」—— **用户是对的。**

**证据链（每步都有出处）：**

1. **报错文案出处**：`MVU: function tools are not supported` 在
   `backend/data/smart_card_assets/0c646fb31a8cd5610d22ccd26323258a430f83a09e6a0a09596b2b1875eabac2.js`
   （307KB，**MVU 插件本体，就在 Palink 自己的资产目录里**）。
   源码是 `const{registerFunctionTool:e}=SillyTavern; return e ? (注册…) : (console.debug('MVU: function tools are not supported'), ()=>{})`
   ⇒ **MVU 想从 `SillyTavern` 上取 `registerFunctionTool`，取不到。**

2. **MVU 一共要 22 个 `SillyTavern.xxx`**（grep 该 bundle 统计）：
   `chat`(23) `callGenericPopup`(13) `POPUP_TYPE`(13) `POPUP_RESULT`(11)
   `getCurrentChatId`(7) `saveChat`(4) `getRequestHeaders`(3) `extensionSettings`(3)
   `chatCompletionSettings`(3) **`ToolManager`(3)** `unregisterFunctionTool`(2)
   `unregisterMacro` `saveSettingsDebounced` `registerMacro` `name2` `loadWorldInfo`
   `getCurrentLocale` `getChatCompletionModel` `getCharacterCardFields`
   `characters` `characterId`。

3. **我们只给 `window.SillyTavern` 挂了 9 个键**（`SillyTavernCompatRuntime.ts:6404-6470`）：
   `libs` / `getContext` / `getCurrentMessageId` / `getChatMessages` / `getGroups` /
   `getGroupChat` / `openThirdPartyExtensionMenu` / `runGenerationInterceptors` /
   `getExtensionPrompts`。⇒ **交集几乎为零。**

4. **但这些 API 我们不是没实现 —— 是挂在别处**：`window.TavernHelper`
   （`:5458` 的 `tavernHelperCompat`，219 个键）上有 **19 个**现成实现，
   含 MVU 要的 `registerFunctionTool` / `ToolManager` / `registerMacro` / `saveChat` /
   `chat` / `characters` / `callGenericPopup` / `POPUP_TYPE` 等。
   只有 3 个 TavernHelper 也没有：`loadWorldInfo` / `getChatCompletionModel` /
   `chatCompletionSettings`。
   ⇒ **"缺 API" 的准确说法是：实现了，但没挂到卡脚本取的那个对象上。**

5. **致命差异在"没有的时候会怎样"（这才是"崩"而不是"降级"的原因）**：
   - `window.TavernHelper` 是 **Proxy**（`:5552-5569`），缺的键回落
     `makeMissingApiFunction`（`:4661`）—— 返回安全 async 函数 + 上报诊断，**不抛异常**；
   - `window.SillyTavern` 此前是**裸对象**，缺的键就是 `undefined`
     ⇒ MVU 那句 `SillyTavern.ToolManager.isToolCallingSupported()` **直接 TypeError**。

6. **为什么崩在设置面板**：MVU 里 3 处 `SillyTavern.ToolManager.isToolCallingSupported()`，
   其中 2 处的文案是 `panel.prompt.toolCallUnsupported`（**面板·提示**），且外层是 Vue 的
   `watch(..., { immediate: true })` —— **组件创建即执行**，所以初始化阶段就撞上，
   不是等用户点才炸。

**修复（已上线，`1b97bc1`）**：给 `window.SillyTavern` 套上与 TavernHelper **同构**的
Proxy，三层回落：① 自己的 9 个键 → ② `tavernHelperCompat` 的 19 个真实现 →
③ `makeMissingApiFunction`（安全空函数 + 上报诊断）。
一次性解决两件事：功能真能用（19 个），且**任何缺口都不再抛 TypeError**（止血）。

⚠️ **影响面是所有卡，不只这一张**：此前靠「`SillyTavern.xxx === undefined`」做特性检测
的卡，现在会拿到实现而改走"支持"分支。**需抽查几张不同的卡做真机回归。**

**仍未修的**：
- 3 个 API TavernHelper 也没有（`loadWorldInfo` / `getChatCompletionModel` /
  `chatCompletionSettings`），走第 ③ 层安全兜底 —— 不崩，但功能不可用；
- `window.ToolManager` 目前是**空壳**（`isToolCallingSupported: () => false`），
  所以 MVU 的工具调用会走**降级分支** —— 不崩，但要真能用需另行实现。

**教训**：「不在我们代码里」≠「是外部的」。中间还有"在我们库里但 grep 路径没覆盖"
这种可能（本例：文件在 `backend/data/`，不在 `frontend/src`，也不在 `plugin_scripts` 表）。
下结论前先把**可能的来源枚举全**，别拿"排除法只排了两处"当"已排除全部"。

---

### 4.0-bis ★★★ 一修是错的，已三修（2026-10-06，用户反馈「不行」后复查）

> ⚠️ **本节订正 §4.0 末尾那段"已修"**。用户真机反馈：桥接上线后卡片**依旧**
> 报 `card_bootstrap_incomplete`，设置面板仍打不开。复查结论：**一修方向对、落点错**，
> 而且它引入的兜底**比不改更糟**。三修已上线（`frontend` 侧，dist 已合并重建）。

**错处一：回落指错了对象。**
一修把 `window.SillyTavern` 的回落指向 `tavernHelperCompat`。实测该对象只有 **57 个键**，
而 MVU 要的那 23 个里只命中 **1 个**（`uuidv4`）。真正装着这些实现的是
**`getContextCompat()`**（ST `getContext()` 契约，220+ 键，命中 ~20 个）——
它是 §4.0 里被我误读成"SillyTavern 的 9 个键"的那个大对象的**真身**
（那个对象字面量从 `:6182` 开始，返回给 `getContext()`，**不是**赋给 `window.SillyTavern`）。
⇒ 一修的 ② 层几乎全部漏到 ③ 层，**等于没修**。

**错处二（更严重）：③ 层的兜底本身有害。**
`makeMissingApiFunction` 返回的是**函数，而函数在 JS 里恒为真**。卡判断"有没有这个能力"
用的是最朴素的特性检测，MVU 原文：
`const{registerFunctionTool:e}=SillyTavern; return e ? 走注册分支 : (提示不支持, 安全空实现)`
- `undefined` ⇒ 走右边，**优雅降级**（改之前就是这个行为，本来是安全的）；
- 给了个空函数 ⇒ 走左边，**炸在更深处**。

⇒ 一修把「缺 API 就优雅降级」改成了「缺 API 就假装支持」。
同一条判据也否决了给 `chatCompletionSettings` 塞空对象：MVU 的 `Aa(e)` 只校验
`typeof e === 'object'`，空对象会通过校验，紧接着写 `e.runtimes.is_function_call_enabled`
⇒ 在那里 TypeError；给 `undefined` 反而走它自己那句 `throw new Error`，被我们捕获，
**不打断初始化**。

**三修的四层回落**（`installSillyTavernCompatProxy`）：
① SillyTavern 自带键 → ② `getContextCompat()` 真实实现 → ③ `tavernHelperCompat`
→ ④ 都没有 ⇒ **返回 `undefined`** + 一条 `sillytavern_api_missing` 诊断（同键只报一次）。

**误报也修了**：`card_bootstrap_incomplete` 的判据原本写死成
`galgame / GalgameUI / TavernHelper_init_done / __galgame_ui_ready`（那**一张卡**的导出名），
换张卡或走别的分支就一直误报；且单点 5 秒判定对异步推送的 4MB 脚本天然过短。
现改为 ① 已知导出白名单 ∪ ② **通用判据**（window 上出现基线之外的新全局键），
5/10/15/20 秒共 4 次，20 秒后才告警，并把**首条卡内错误**写进诊断和浮层提示。

**为什么这轮敢说"修了"**：新增测试直接把 Proxy 段放进 `vm` 跑桩依赖，断言
`SillyTavern.chat` 真拿到 `[{id:1}]`、缺口真为 `undefined`、
且 `missing ? 走注册分支 : 走安全降级` 走的是右边。不是结构断言，是**值断言**。

---

### 4.1 ~~已定位的根因~~（已被 §4.0 取代，保留其日志证据与调用链分析）

日志：`C:\Users\Pall\Downloads\localhost-1791227114044.log`（769 行）。
关键片段（第 509–524 行）：

```
VM50748:78617 MVU: function tools are not supported
VM50748:78617 Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'length')
    at legacy_chat.ts:9:26
    at qo (index.ts:13:9)
    at main.ts:149:24
    at async main.ts:71:23
    at async HTMLDocument.<anonymous> (main.ts:101:70)
legacy_chat.ts:9 Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'length')
```

⇒ **卡脚本 init 中途抛错死掉**，于是它后段的
`setEventsRefs({ showSettingsPanel, … })` **永不执行**
（卡源码 `db_ui_plugin.js:98164`，导出到 `_tmp_st_probe/` 后逐行读过）。
而点击处理器长这样（`:84768`）：

```js
$2(doc).on("click", '#gal-global-overlay [data-action="config"]', function (e) {
  …
  showToast4("正在打开设置...");
  if (_showSettingsPanelRef2) _showSettingsPanelRef2();   // ← ref 仍是 null 就静默什么都没做
});
```

**无 else、无报错** ⇒ 按钮**已经渲染出来**（所以 hover 有反馈、看着像"点了没反应"），
但点下去什么都不发生。这与"读卡源码得到的推断"完全吻合。

**旁证（同一崩溃的副作用，不是环境问题）**：日志里
`__palinkSmartCardCompatV2 is not defined`（681/762/767 行）——
该对象由 `SillyTavernCompatRuntime.ts` 在**卡脚本跑到后段**才创建，
脚本早崩了所以它不存在。**不要去追这个 ReferenceError，它是症状不是病因。**

**⚠️ `legacy_chat.ts` 不属于 Palink 源码**（全仓 grep 零命中，也不在 `plugin_scripts`
的两个脚本里）。它是**这张卡从远程 CDN 动态拉的第三方模块**——同一份日志里可见
`[SpriteAnimationManager] GSAP未预装，正在从CDN加载...` → `GSAP动态加载成功: 3.12.5`。
⇒ 真正修它要动卡本身或改环境对这类远程模块的兼容层，**不是改 Palink 自身代码能直接解决的**。
`legacy_chat.ts:9:26` 具体读的是哪个 `.length` 仍未定（二进制在 CDN 上）。

**已排除：沙箱权限不是原因。** 上一轮补了 `allow-modals allow-forms allow-popups allow-downloads`
并上线，症状不变。（该修复仍有独立价值：卡内百余处 `alert/confirm/prompt`
不再静默失效。）**另一条被排除**：卡自己的 init 锁 `topWindow[INIT_LOCK_FLAG]` 不是问题——
它从未生效（日志里 `跳过重复调用` 命中数 = 0），因为卡被**按消息 HTML 块逐块实例化**，
**每个 iframe 一个 realm**，`topWindow` 是各自的 window，锁跨帧无效。

### 4.2 原三假设的否证记录（别再重复走）

| 假设 | 结果 |
|---|---|
| opaque origin 阻断 IndexedDB | ❌ 否证。`legacy-st-sim.ts:180-257` 有 **80 行内存 IndexedDB 垫片**（我 grep 到 API 名就断言"没实现"，是错的） |
| 让用户点「信任」开关来验证 | ❌ 无效。该开关被 `prefersImmersive` 门控（`CharacterCardRenderer.tsx:1258`），**这张卡上根本不显示**，我给的法子不可执行 |
| 卡脚本在 DB 里被截断到 100000 字符 | ❌ **误报**（外部复核抓出）。截断的只是 `plugins.source_data` 快照字段，脚本本体 **4.2MB 完整**在 `plugin_scripts` 表，`tavern_helper` 运行时链路（`_synthesize_tavern_helper_js_content` → `resources.js`）**只读后者、从不读 `source_data`**。该线索已划掉 |
| 「唯一旁路是硬编码 `trustedNative = true`，需授权改代码」 | ❌ 也不对。取证的真正入口是**用户自己能开 F12**——卡内 console 直接可见（那条 Live2D 警告就是卡里打的），无需任何全局变量。见 §4.3 |

⛔ **不得放宽 sandbox**（`CharacterCardRenderer.tsx:1237`，P1-1 安全决策）：
同源 iframe 内卡脚本可直读 `parent.localStorage` / cookie 会话凭据 ⇒ 任意被投毒角色卡可窃取会话。
本轮补的 `allow-modals` 等四项**都不授予同源**，未触碰该红线。

### 4.3 本轮做了什么（只补「可见性」，不替卡干活）

改动全在 `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`：

1. **卡崩溃可见性守卫**（生成运行时尾部）：
   - 5 秒后若卡的全局导出（`window.galgame` 等 4 个标记）都没出现 ⇒ 报
     `card_bootstrap_incomplete`；
   - 捕获阶段监听 `[data-action="config"]` / `[data-action="open-settings"]` 点击，
     若卡没起来 ⇒ 报 `card_settings_entry_unresponsive` + console 一条 `[卡内错误]`
     + **不依赖卡挂载点的浮层提示**（卡自己的 `showToast4` 实测会因挂载点为空而静默不显示，
     那就等于没提示）。
   - 刻意**不替卡实现设置面板**：那是它私有的 UI 结构与状态，替它做只会做出错的界面。

2. **卡内报错的 console 出口**：`error` / `unhandledrejection` 两个监听现在除了走
   `postMessage` 上报（宿主页 `CharacterCardRenderer.tsx` 收到后转 `onAction`，
   **Palink 当前没有消费方 = 黑洞**），**再在 console 打一条带 `[卡内错误]` 前缀的记录**。
   以后排查在 console 过滤框打「卡内错误」即可只看卡的问题，不必在噪音里捞。

**仍未解决**：卡本身崩在 `legacy_chat.ts:9` 这件事没修（第三方 CDN 模块，见 §4.1）。
本轮之后，**用户至少能看到"为什么点了没反应"**，而不是静默。

**真机验收口径**：若那张卡仍崩，点设置入口应出现浮层
「卡片初始化失败，设置面板暂时打不开（按 F12 搜「卡内错误」看详情）」。
若浮层不出现，说明卡的初始化其实成功了 —— 那要另开方向查。

---

## 4.4 F12 控制台噪音治理（用户 2026-10-06 新要求）

用户原话：「帮我管理一下现在这个 F12…它吐出来很多我感觉没必要的这个信息…数据量太大了」。

**先量化**（769 行日志逐行分类）：`index-*.js` 的 React 内部堆栈 **383 行**（纯堆栈帧）；
卡脚本日志 **59 行**（**同一条重复 5~6 次**）；`content-visibility` 警告 **37 行**；
`Fetch 已完成/失败加载` **65 行**；**真正有信息量的不足 30 行**。

**重复 5~6× 的根因**：卡被**按消息 HTML 块逐块实例化**
（`Message.tsx:1018` 注释明说"CharacterCardRenderer 会对内容中的每个 HTML 块独立判定"），
**每个 iframe 一个 realm** ⇒ 卡自己的 init 锁跨帧无效，**去重只能在 Palink 层做**。

**实现（console governor）**：在生成运行时 IIFE 最前面（早于任何卡代码）包一层
`window.console`：
- `log/info/debug/dir/table/trace`：同一条只放行**首次**，每 20 次播一条
  「已折叠重复日志 xN」（**只去重，不丢首次**）；
- `warn/error/assert/count/...`：**一律原样放行**（告警/报错含唯一数值与时序，折叠会藏 bug）；
- key 表 >500 条清空（防长跑内存增长）；任何内部异常都 `native.apply` 兜底，绝不吞消息；
- 逃生开关：控制台执行 `window.__palinkConsoleVerbose = true` 即全量放行。

**未动（登记备查，属别的会话/别的轨）**：
- `content-visibility` 那 37 行来自 `ChatViewDesktop.tsx:177` /
  `ChatViewMobile.tsx:520,644` 的内联 `contentVisibility: 'auto'`（**别的会话的文件**）。
  浏览器原生提示，无害。注：`index.css:2459` 已在 2026-10-05 删掉 CSS 版跳绘，这三处是残留。
- `legacy-st-sim.ts:157` 的 parent 别名代理**白名单漏项**（`setTimeout` / `requestAnimationFrame` /
  `getComputedStyle` / `confirm` / `matchMedia` / `URL` / `innerHeight` / `devicePixelRatio` /
  `ResizeObserver` / `PIXI` / `Live2DCubismCore` 等未命中一律返回 `undefined`）。
  属 **legacy 轨**（用户这张卡跑的是 compat 轨），跨轨影响面需单独评估。

**回归测试**：新增 `__tests__/console-noise-and-card-crash-guard.test.ts`（7 条）。
console governor 走**真行为断言**（把生成文本里的 governor 段抽出来放 `vm` 跑，
喂假 console 看它压不压）；守卫走结构断言。**已做反证**：把 `if (seen === 0)` 改成
`if (true)`（等于关掉折叠）⇒ 2 条测试立刻红。

---

## 5. 待办（按优先级，都可独立开工）

### P0-新 卡崩在第三方 CDN 模块 —— 本轮只补了可见性，没修因
见 §4.1。`legacy_chat.ts` 是卡从 CDN 拉的，不在 Palink 也不在 `plugin_scripts`。
要真修需：① 拿到该文件定位 `:9:26` 读的哪个 `.length`；或 ② 改环境对远程动态模块的
兼容层。**开工前先确认这是不是同一张卡的普遍问题**（可能只是这一张卡的作者 bug）。

### P1 给「窗口未知」的模型补清单，别让下一个人再踩 4096
`model_specs.json` 里**没有 `deepseek-flash`**，任何没登记的模型都会静默拿到 4096
→ 世界书被整本裁光。修法二选一（或都做）：
- 把常用模型补进 `model_specs.json`
- ⚠️ 更治本：让装配走 `_get_model_context_window` 的两处（`:646`、`:3991`）
  改用 `resolve_model_token_limits`，与管理页口径统一 —— **但要先确认这两处的
  语义是否真该丢假值**，别照抄。

### P2 让「世界书被裁」这件事对用户可见（用户已认同该做）
现在的真实行为是**静默全裁 + 一句误导性的 `no matched entries`**。两级落点：
1. **装配报告**已有 `status=trimmed, reason='budget_exceeded (est=2685, used=0, max=1024)'`
   的逐条明细 —— 前端把 trimmed 条目亮出来即可，成本最低
2. 世界书管理页书籍行显示「本书常驻约 X tok / 当前预算基数 Y」——
   `_estimate_tokens` 与 `_resolve_budget` 都是现成函数

### P3 问题 3（设置按钮）取证 —— 见第 4 节（**根因已定位，可见性修复已上线**）

### P4（新）`dist/assets` 残留分块清理 —— 需用户确认后才能动
`frontend/dist/assets/` 里已积累 **15 个 `index-*.js`** 与 **2 份 smart-card-runtime 分块**
（旧 `c55b75a33025` / 新 `f6301d309d66`）。只有 `index-CIXgeVoa.js` + 新 runtime 分块被入口引用，
其余是历次 `cp -r` 增量合并的只增不删累积（**只增不删是刻意防线：删错即前端白屏**）。
按 §备份与清理规范第 5 条**禁止直删** ⇒ 须走「列清单 → 隔离到 `_QUARANTINE_` → 门禁验证 →
用户确认 → 才删」。**不影响功能**，仅占磁盘。

---

## 6. 交付与部署状态

**4 笔提交**（`st-plugin-compat-20260727`）：

| commit | 内容 |
|---|---|
| `f23eeb0` | 装配两处丢失（层 1 + 层 2）+ 私有键剥离 + 测试断言放宽 |
| `8275064` | 变量面板两处真 bug |
| `1017d6e` | AGENTS.md（新增探针自查条；连带并行会话的「文档存放规范」58 行，用户裁定一并提交） |
| `f583616` | SPEC + 10-05 交接书（含 7 条订正） |

**本轮（控制台治理）改动 —— ⚠️ 尚未提交**：

| 文件 | 内容 |
|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | ① console governor（去重 + 逃生开关）② 卡崩溃可见性守卫 ③ `[卡内错误]` console 出口 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/console-noise-and-card-crash-guard.test.ts` | **新增** 7 条回归测试（含反证） |

**门禁**：前端 `tsc` 干净、`vitest` **61 文件 / 788 passed, 0 failed**
（比上轮 781 多 7 条 ＝ 本批新增）；后端 worldbook+prompt+depth 子集 **280 passed, 0 failed**。
⚠️ 后端**第一轮是 2 failed** —— 是我引入的回归（整 dict 相等断言撞上新增标记键），
已修。别把"最终绿"当成"一次过"。
⚠️ **本批我又被 `generated-script-parse-guard.test.ts` 抓到一个真 bug**：我在生成的 JS
模板里写了 `(label: string, …)` —— **TS 类型标注留在生成文本里**，产出是
`Unexpected token ':'`，注入 iframe 后整段运行时 SyntaxError 静默死亡（正是该守卫文件头
描述的同类坑）。**这个守卫是这类改动必跑的，不是可选。**

**部署**：
- 后端已 `docker compose build backend && up -d backend`，`healthy`，服务在**容器内 8000**
  （`docker port` 无输出是正常的，后端不映射宿主端口，由前端 nginx 反代）
- 库在 `0068 (head)`，`RUN_MIGRATIONS_ON_STARTUP=false` → 启动**不改库**
- 前端：**本轮已重建 dist**（只动 1 个源文件，重建前已确认 `frontend/src` 中
  晚于上次构建的文件**只有本批这 1 个**，未带入并行会话在途改动）。
  入口 `index-CRLrDW-J.js` → **`index-CIXgeVoa.js`**；
  runtime 分块 `c55b75a33025` → **`f6301d309d66`**（4 个新字面量均已线上复核命中）；
  上一批的 `allow-modals` **仍在**（未被覆盖）。三个关键资源均 HTTP 200。
  备份：`_BACKUPS/2026-10-06_dist重建前_控制台治理/`；试构建产物已隔离到
  `_BACKUPS/_QUARANTINE_2026-10-06/`。
- ⚠️ 站点端口是 **14000**（宿主）；**nginx 容器内是 8080**。
  且容器内 `wget localhost` 会 Connection refused，**要用 `127.0.0.1`**。
- ⚠️ `Dockerfile:67` 是 `COPY . .`，build 会连带把工作区里**别人未提交的后端在途改动**
  一起固化进镜像。本轮**未重建后端**（只改前端），故该风险本轮不适用；
  **下次 build 前仍要先做这个比对**。

**工作区遗留（不属于本轮，勿误扫）**：并行会话的 MVU 在途改动
（`mvu_engine.py`/`mvu_secondary.py`/`mvu_cleanup.py`/`VariableChangePanel.tsx`/
`cardVariables.ts`/`mvuSecondaryFeedback.ts`/alembic `0068`/相关测试）、
`docs/` 顶层→`_active`/`_archive` 那批搬迁、`scripts/docs/gen_docs_catalog.py`。
本轮全程用**逐项 pathspec** 提交，`git add -A` 一次也没用过。

**临时探针**：`backend/scripts/_probe_*.py` 共 24 个，其中**只有一部分是我建的**
（`_probe_assembly_v3..v9`、`_probe_order`、`_probe_total`、`_probe_overlay`、
`_probe_classify`、`_probe_final`、`_probe_ctx`、`_probe_model`、`_probe_budget100`、
`_probe_assembly_e2e`、`_new_block`、`_apply_block`）。
⛔ **绝对不要 `rm backend/scripts/_probe_*.py` 一把删** —— 会连带清掉别人的
`_probe_gateway.py`、`_probe_sdk_reuse.py`、`_probe_mvu_plugin_defaults.py`、
`_probe_real_prompt_5x.py`、`_probe_param_matrix.py`、`_probe_wb_activation.py` 等。
其中 `_probe_assembly_v9.py`（逐参数 bisect）和 `_probe_overlay.py`（真实入口端到端）
有复现价值，建议保留或改造进测试。

---

## 7. 方法学教训（给下一个 agent 的真东西）

本轮 **5 次自我推翻**，记下来是因为每一次都可能被重犯：

1. 「`<cg>` 规范没进提示词」—— 只查 `result.text`，而该条目 `position=4`（at-depth）
   **本就不进 text**。读代码得到的绝对结论一律先实测。
2. 「卡内 promptOnly 正则删了规范」—— placement 用错（我拿 `AI_OUTPUT=2` 测，
   而 ST 对世界书内容实际用 `WORLD_INFO(5)`：`d:/SillyTavern-release/public/scripts/world-info.js:5086`）。
   同一条 ext 用 placement=2 会把 `<cg>` 删掉、用 placement=5 则完好。
3. 「爱意=0 < 200 ⇒ 卡设计如此、非 bug」—— 没做越过阈值的实测就下结论。
4. 「刷爱意就能开相册」—— 用**能推动的指标**代替真正原因，且只查了两条并列路径中的一条。
   用户的机制断言（「这个卡是根据互动解锁某一特定场景」）优先级高于我的代码推论。
5. **「修复已实测生效」是假阳性，最严重的一次** —— 探针直调 `build_worldbook_context`
   时**漏传 `max_context_tokens`** → 服务内回退 `DEFAULT_BUDGET=16000` →
   预算 4000 而非生产的 1024 → 我看到「5 条到位」并把它写进了交接文档。
   **真实装配当时是 0 条。** 是外部 agent 复核才抓出来的。
   ⇒ 判据：**能走真实入口（`assemble_roleplay_prompt`）就不要手工重建中间步骤；
   探针必须打印它实际收到的参数，并与生产调用点逐项对照。**
   这条已写进 `AGENTS.md`（`1017d6e`）。

**还有一条**：第 3 层我一度结论成「卡太长、物理上无解、ST 下同样失效」，
用户一句「现在的模型基本都 1M 上下文吧？再不济 128K」直接把它打回 ——
**4096 是我们自己的兜底假值**。我的"无解"结论建立在没核实的一个数字上。
⇒ 给"做不到"的结论前，先确认那个数是从哪来的。
