# HANDOFF：ST 卡片适配三问题 — 核查结论与修复交接（2026-10-05）

> **状态：已被 10-06 版取代（结论主体作废，仅本「订正说明」块仍有效）。**
> 取代者：[`HANDOFF_ST卡片适配三问题_2026-10-06.md`](./HANDOFF_ST卡片适配三问题_2026-10-06.md)
> —— 该版反映真机验收通过、上线与部署状态，并把「卡太长、物理上无解」这一
> 错误结论纠正为「4096 是我们自己的兜底假值」。**请直接读 10-06 版。**
> 下文第 1～5 节是排查过程的原始记录，按「只进不出」保留，**不作为结论采信**。
>
> 原作者：ST 适配排查。
> 配套规格：[`SPEC_ST卡片适配核查与修复_2026-10-05.md`](./SPEC_ST卡片适配核查与修复_2026-10-05.md)

> ### ⛔ 订正说明（2026-10-05 晚，作者本人复核 + 外部 agent 复核后）
>
> **本文第 1 节第 2 条结论作废，第 1 节第 3 条不受影响。** 以下为准：
>
> 1. **「回忆相册不是 bug / 爱意 ≥ 200 即可解锁」——错，两处错**。
>    - 卡脚本实际是**两条并列解锁路径**：`isAllUnlocked || unlockedSet.has(name)`。
>      爱意 ≥ 200 只是其中一条（全局开册），另一条是**按场景逐个解锁**——
>      扫正文里的 `<cg>名称</cg>` 标签。用户理解的是后者，正确。
>    - 「实测爱意 250 → 205/205」是我 `Mvu.replaceMvuData` 直接注入出来的，
>      **不是互动产生的**，且只验了一条路径。属伪造证据。
> 2. **真因是装配层把卡片的格式规范丢了，连丢两层**（与具体卡无关，任何只靠
>    at-depth 提供指令的世界书都会整本失效）。已修，`f23eeb0`：
>    - `depth/em_top/em_bottom/outlet` 四段被错放进 `if wb_result.text:` 内侧，
>      正文裁空即连坐全丢（ST 六份产物互不依赖，`script.js:4575`/`:4612`）。
>    - 进 messages 后又被分类器落到兜底分支、当成 `worldInfoBefore`
>      （priority 80 / trimmable）参与裁剪。ST 的注入排在 `populateChatHistory`
>      之前（`openai.js:1325` vs `:1331`），结构上永不被裁。
>    - 附带：装配返回前剥离全部 `_palink_*` 私有键，防止发给推理 API。
> 3. **本文原写「实测 5 条到位」是假阳性**，来源：探针 `_probe_assembly_v6.py`
>    直调 `build_worldbook_context` 时**漏传 `max_context_tokens`** → 服务内回退
>    `DEFAULT_BUDGET=16000` → 预算 4000（非生产的 1024）。真实装配当时是 **0 条**。
> 4. **修复后当前仍不通，卡在这一层**：世界书 token 预算 = 模型窗口 × 25%。
>    `deepseek-flash` 未登记真实窗口，取 `_DEFAULT_FALLBACK_CONTEXT=4096`
>    （`unified_model_registry.py:48`）→ 预算 1024，而该书 at-depth 常驻
>    合计 **14664 token**，首条 2685 即溢出、一票否决（ST 同语义，
>    `world-info.js:4942`，外部复核已确认）。**4096 是兜底假值不是真实窗口**，
>    用户已于 2026-10-05 将 `providers.json` 该模型改为 1048576。
> 5. **改完后的实测（真实 `assemble_roleplay_prompt`，无 monkeypatch）**：
>    `worldbook included entries=18`、`worldbook_depth included ×6`、
>    prompt 含 `<cg` / `插图触发` / `变量输出格式` / `变量更新规则` = True。
>    线上镜像（`f23eeb0`+`8275064` build 后）复核一致；私有键泄漏 0 条。
> 5b. **真机验收已通过（2026-10-05 晚，链路闭环）**——卡 `7a3a5dfc`（同名重复导入的一张），
>    新会话 `c976912e`，模型 `deepseek-flash`：
>    - 模型思考文本自述「Need CG markers: minimum 2, max 4 / Let me use: 哭哭 and 摸脸」
>      → **规范确实被读到**（此前它自述 "I don't know the exact schema"）。
>    - 落库正文 3 条中 **2 条含完整 `<cg>…</cg>`**（`content ~*` 布尔判定，未读正文内容）。
>    - 卡脚本写入 `palink:card-storage:v1:7a3a5dfc…:local:tavern_cg_album_unlocked`，
>      **解锁数组长度 = 2**，与标签条数精确对应 → **按场景解锁这条路径通了**。
>    - 相册 UI 目视验收留给用户（按规范不读卡内生成内容）。
> 6. **本文「iframe 设置按钮」一节（问题 3）仍未解决**，但其中
>    「卡脚本在 DB 里被截断到 100000 字符」是**误报**：截断的只是
>    `plugins.py:935` 的 `source_data` 快照字段，脚本本体 4.2MB 完整存于
>    `plugin_scripts` 表，`tavern_helper` 运行时链路只读后者。该线索可划掉，
>    新怀疑方向是 4.2MB 塞进 iframe 后执行中途失败。
> 7. **sandbox 不得放宽**（P1-1 防会话盗取）；本文原建议的「让用户点信任开关
>    验证」在此卡上**不可行**——该开关被 `prefersImmersive` 门控，不会显示。

---

## 1. 三句话结论

1. **没有「定向适配」**：全仓无卡 UUID / 卡名硬编码分支，所有卡走同一条通用链路。
2. **回忆相册不是 bug**：卡内脚本硬门槛「爱意 ≥ 200」。实测爱意提到 250 → 面板 `1/205` → **`205 / 205`**。
3. **面板变量恒为默认值是真 bug，已修已上线**：两处缺陷串联（主页面缺 5 个 ST 全局 + 后端按名取书对角色绑定书恒空）。

---

## 2. 用户三个反馈的最终定性

| # | 用户原话 | 定性 | 处理 |
| --- | --- | --- | --- |
| 1 | 「上传多少卡适配多少，不要特调」 | ✅ 无特调 | 已 grep 验证，无需改 |
| 2 | 「回忆相册没法解锁立绘」 | ✅ **不是缺陷** | 卡设计：爱意 ≥ 200 才开相册。**刷爱意即可** |
| 3 | 「面板变量都是默认值」「设置小按钮点不动」 | 前者=真 bug 已修；后者=未定位 | 见 §5 挂起项 |

---

## 3. 已修（2 文件，已上线，真机验证）

### 3.1 前端 `frontend/src/utils/sillyTavernPluginRuntime.ts`（+约 100 行，纯新增）

主页面轨（`card-script-runner.ts` 注入卡脚本的轨道）缺 5 个 ST/TavernHelper 全局，
iframe 轨有、主页面轨漏了：

| API | 症状 | 修法 |
| --- | --- | --- |
| `getCharWorldbookNames` | MVU init 抛 `ReferenceError` | 接 `__palinkBridge.charLorebooks`，**冷缓存时自己 refresh 再答** |
| `getCharWorldbook` | 同上（连带） | 别名到已有 `getWorldbook` |
| `getCurrentCharacterId` | 相册 `isChatActive()` 第一道门恒挂 | 读 `runtime.context.characterUuid` |
| `getAllVariables` | 卡脚本调用即 undefined | 别名到 `getVariables`（返回副本） |
| `getChatVariables` | 同上 | 同上 |

⚠️ **两个必须知道的坑**：

- **桥缓存是惰性的**。MVU 在模块顶层 `await` 这些 API，而注入时角色 id 未必已进 context
  （见 `CharacterChat.tsx:1746` 注释）。首版实现直接读缓存 → 真机实测返回 `[]` → 等于没修。
  必须冷缓存时 `refreshCharLorebooks` 拉一次再答。
- **不要用 `messageManager.getCurrentCharacterId()`**：全仓零调用方、恒返回空串
  （`CharacterChat.tsx:1579` 注释已核实）。唯一真源是 `runtime.context.characterUuid`。

⚠️ **本文件是 JS 模板字符串**（`setupScript.textContent = \`…\`），
**注释里也不能出现反引号**，否则整个脚本解析失败、`tsc` 会报一堆
`TS1443: Module declaration names may only use ' or " quoted strings`。

### 3.2 后端 `backend/app/api/silly_tavern.py`（`_resolve_worldbook` 加参数）

`POST /api/worldinfo/get` 硬过滤 `WorldBook.character_id.is_(None)`（只查全局书），
对**角色绑定**的世界书恒返回 `{entries:{}}`。

ST 侧不是这样 —— `src/endpoints/worldinfo.js:71` 走 `readWorldInfoFile(dirs, name)`，
**按名字从用户书库取，不分全局/绑定**。

修法：加 `include_character_bound` 开关，**只开在读端点**（`:3388`）。

⚠️ **`/edit`（:3424）与 `/delete`（:3503）必须保持默认全局语义** ——
否则会顺带把「删角色绑定书」变成可达操作。已 grep 复核确认这两处没传该参数。

---

## 4. 上线验证读数（真机，非推断）

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| `getLorebookEntries('露缇雅1.2')` | **0 条** | **19 条** |
| `getCharWorldbookNames()` | `undefined` | `["露缇雅1.2"]` |
| `getCurrentCharacterId()` | `undefined` | `c44f2ae6-…` |
| console `getCharWorldbookNames is not defined` | ❌ 有 | ✅ **消失** |
| 回归：全局书 `galgame界面插件` | 1 条 | 1 条 ✅ |
| 回归：不存在的书 | 0 条 | 0 条 ✅ |
| 回归：爱意值 | 0 | 0（实验已还原）✅ |

**门禁**：`tsc --noEmit` exit 0 ｜ `vitest run` 60 文件 / 781 passed / 3 skipped / 0 failed
｜ `pytest tests/ -q` 1914 passed / 51 skipped / 0 failed
｜ dist 重建上线 `index-BBJkM2rq.js` ｜ backend 容器重建 healthy
｜ 备份 `_BACKUPS/2026-10-05_dist重建前_MVU初始化补API`（已登记 `_INDEX.md`）

---

## 5. 挂起项：iframe 内「设置」按钮点不动（**记录在案，下次必做**）

### 现象
正文卡（`<now_plot><content>` 包裹）内「设置」小按钮点击无响应。
**首条消息（`first_mes`）可点；后续任何一条都不可点。**

### 已排除
- 非卡级特调（无 UUID/卡名硬编码）
- 非事件缺失（`tavern_events` 7 项齐全、`getChatMessages` 正常）
- 非 MVU 报错（该报错已修，按钮仍不可点）

### 已定位事实（省下次功夫）
1. **iframe 与主页面不同源** → 读不到 `contentDocument` → **只能看主页面 console，看不到 iframe 内报错**
2. 页面共 **7 个 iframe**（高 220×4 / 1116 / 220 / 4364 / 591）
3. iframe 变量来自 **localStorage 快照**（`SillyTavernCompatRuntime.ts:595` `persistedChatStore`
   ← `ctx.persistedStorage`），**非实时推送**
4. 主页面变量链是通的（`Mvu.getMvuData()` / `getVariables()` 均返回真实 `stat_data`，9 分组键）
5. 卡脚本跑在**主页面**，不在 iframe 内
6. 相册脚本只用 `topWin.localStorage`（4 处），无 `sessionStorage`
7. console 有 `[Galgame界面插件] [TitleScreenDiag] ensureTitleScreenSettings Object`
   → **该插件活着，其标题屏设置 UI 是「设置」按钮的头号候选**
8. 「首条能点、后续不能」指向「初始化只跑一次」或「最后挂载者赢」的共享状态模式，**尚未定位到具体代码**

### 下次开工的最小动作
1. 查 Galgame 插件设置路径：`ensureTitleScreenSettings` → 用了哪些 TavernHelper API
2. 让用户在页面点一次按钮，抓 iframe console（需先解决跨源，或用 `browser-use` 逐 frame 探针）
3. 查 `SmartCardCompatController.ts` / `shared.ts` 有无「最后挂载者赢」的单例

### 4.3 【2026-10-05 复核新增】iframe sandbox = opaque origin（新头号嫌疑）

真机读到页面全部 7 个 iframe 的属性，**无一例外**：

```html
sandbox="allow-scripts"        ← 没有 allow-same-origin
```

出处 `CharacterCardRenderer.tsx:1248-1252`：

```ts
const sandbox = effectiveMode === 'static-html' ? ''
  : trustedNative ? 'allow-scripts allow-same-origin'
  : 'allow-scripts';
```

⚠️ **这是 P1-1 的刻意安全决策，不是 bug**（同文件 `:1237-1247` 有完整理由）：
早期一律 `allow-scripts allow-same-origin`，同源 iframe 内的卡片脚本可直读
`parent.localStorage` / cookie 里的会话凭据 → **任意被投毒的角色卡可窃取会话**
（浏览器实测警告 "can escape its sandboxing"）。

⇒ **不要为了让设置按钮能点而去放宽 sandbox。** 那等于把会话盗取漏洞装回去。

但它确实是「设置按钮点不动」的头号嫌疑 —— **前提是某条链没被 shim 兜住**。
已核实兜住的部分（别重复查）：

| 能力 | 是否已有 shim | 出处 |
| --- | --- | --- |
| `parent/top` 别名（postMessage 转发 / document 别名 / localStorage / addEventListener） | ✅ | `legacy-st-sim.ts:116-169` `makeAlias` |
| **IndexedDB 内存垫片** | ✅ | `legacy-st-sim.ts:180-257`，注释明写「沙箱 iframe（opaque origin）中浏览器禁止 IndexedDB：Galgame 插件 initDB / BubbleDialogue AvatarDB 初始化第一步即抛 → 插件整体初始化中断」 |
| IndexedDB（iframe 轨另一处） | ✅ | `SillyTavernCompatRuntime.ts:577-579` |

⚠️ **我曾判「IndexedDB 没代理」是错的** —— 只 grep 到 `indexedDB` 字面量就下结论，
没读那 80 行垫片实现。**教训同 §6：grep 到 API 名 ≠ 没实现，必须读实现体。**
⇒ **opaque origin / IndexedDB 这条线基本排除。**

**验证方法（下次，零风险，不动代码）**：
UI 上有「信任」开关，但**当前这张卡上它不显示** ——
`showTrustedControl = prefersImmersive && (mode === 'iframe-js' || mode === 'trusted-native')`
（`CharacterCardRenderer.tsx:1258`），真机全页 176 个可点元素里搜「信任/trust」**零命中**。
所以想用这条路径验证，得先让该卡进入 immersive + iframe-js 模式；
否则只能在 `CharacterCardRenderer.tsx:257/422`（`trustedNative` 判定处）临时硬编码 `true`
做一次性验证 —— **属改代码，需用户授权**。

⚠️ 信任授予是**会话级**的（`storage.ts:6` `SMART_CARD_TRUST_SESSION_TTL_MS = 30min`，
存 sessionStorage，带 expiresAt），刷新/过期即失效，**不能当成永久解法**。

**为什么 agent 自己没测成（别重复踩）**：
授权键格式为 `palink-smart-card-trust:<characterId>:<fingerprint>`（`primitives.ts:223-225`），
其中 `fingerprint` 是**卡片 HTML 源码的哈希**（`hashSmartCardSource`）。
页内无法复算（卡源码只在 React 组件 props 里，不在 DOM），
真机实测 `sessionStorage` 里 `palink-smart-card-trust:*` **一个键都没有**
⇒ **这张卡从未被授予过信任**，说明用户此前也没点过那个开关。
故此验证只能由用户在 UI 上点，或临时在 `CharacterCardRenderer.tsx:257/422`
（`trustedNative` 判定处）硬编码 `true` 做一次性验证 —— 后者属改代码，需用户授权。

### 4.4 卡脚本原文只读到 100000 字符（截断，阻断进一步取证）

`plugins.source_data` 里酒馆助手（JS-Slash-Runner）的 `scripts[0]` 是
「对话渲染系统 v7.1」完整源码（声明含 `正文美化设置`），但：
- 该列在 DB 里**只有 100000 字符**，JSON 未闭合（`json.decoder … Unterminated string`）
- ⇒ 无法解析出完整脚本正文，也就无法静态定位「设置」按钮的点击处理器

⚠️ 这是一个**独立的数据完整性问题**（第三方插件被截断入库），会影响所有
依赖该插件完整源码的排查。是否要修（改列宽 / 改入库路径）**未立项**，
因为需要先确认截断是否已实际破坏插件运行（v7.1 目前看是跑着的：console 有
`[BubbleDialogue] 格式规则+情绪词已通过 injectPrompts 注入`）。

---

## 5.5 附带查明：模型的输出侧行为（读模型自述推理文本得到，非猜测）

页面快照里保存着模型当轮的「深度思考」原文，它自述了两件事，直接解释「面板变量不动」：

1. 某轮模型写：`Let me construct the JSON patch. I don't know the exact schema`
   —— 模型**明确说它不知道变量结构**。
2. 另一轮模型写：`Keep the format: ..., dialogue with |, inner thoughts with *,
   tail【声音：...】, and tag with and .`
   —— 末尾两个词是空的（`tag with` 后面没有内容），说明它**在照抄一个格式模板，
   但模板里的标签名本身被我们的正则剥掉了**，模型只能照着空位填空。

⚠️ 这两条是**卡内格式规范被我们的正则清理掉**的直接证据，与 §3 修好的
「世界书内容取不到」是**两个独立问题**：前者是内容能取到了（已修），
但「提示词里描述格式的那一段」在某个环节被清洗过。

⇒ **下一步该查**：`strip` / sanitize 链上是否有规则误删 `<UpdateVariable>` 字面量本身
（不是删 AI 输出里的标签，而是删**提示词里教模型的格式说明**）。
搜索方向：`backend/app/api/character_ext.py` 的 `apply_plugin_regex_scripts`
与 `_apply_regex_scripts` 在 `is_prompt=True` 时的过滤条件，
以及 `websocket.py:742-778` 附近落库前的剥离是否影响了 prompt 侧素材。

**判定方法（离线可做，零成本）**：用本轮已验证可跑的探针
（`_probe_mvu.py`：容器内跑真实 `build_worldbook_context`）扩展一份，
把 depth_entries 拼成 messages 后，逐条检查 `<UpdateVariable>` 与示例 JSON Patch
字面量是否**完整存在**（本次实测：两者都在 ⇒ 世界书侧没问题，
**说明清洗发生在更后面的环节**，即 `_insert_depth_prompt` 之后的某个处理）。

---

## 6. 我犯过的错（务必别重犯）

本轮 **三次自我推翻**，全部写进 SPEC：

1. **「`<cg>` 规范没进提示词」** —— 错。只查了 `result.text`，而该条目 `position=4`（at-depth）
   **本就不进 text**，走 `depth_entries`（实测 depth=0 落 messages 末尾，紧贴生成前）。
2. **「卡内 promptOnly 正则把规范删了」** —— 错。**placement 用错**：ST 对世界书内容用
   `WORLD_INFO(5)`（`d:/SillyTavern-release/public/scripts/world-info.js:5086`），不是 `AI_OUTPUT(2)`。
   实测同份 ext：placement=2 → `<cg>` 被删；placement=5 → 存活（1034→1034 长度不变）。
   卡作者写 `placement=[2]`（脚本名「对ai隐藏cg标签」）是**正确写法，我们与 ST 行为一致，不要改**。
3. **「爱意=0 < 200 阈值 ⇒ 卡设计如此、非 bug」** —— 结论对，但**没做实验**就下了结论，
   差点让用户拿不到「刷爱意就能开」这个可操作答案。
   **教训：门槛型条件必须做「越过阈值」的对照实测，不能只读源码。**
   （用户一句「早期输出 CG: 就能解锁」直接把我打回重查，才做出那个实验。）

⚠️ 另：`balance_custom_tags`（`backend/app/utils.py:286`）经实测对含 `<cg>` 的文本
`UNCHANGED=True`，**无罪**，不必再查。

---

## 7. 遗留 / 未提交

- **本批未提交 git**。工作树含**并行会话**的 MVU 相关改动（`Message.tsx`、`CharacterChat.tsx`、
  `card-script-runner.ts`、`VariableChangePanel.tsx` 等），不属本批，**未擅自提交**。
  如需提交，按 pathspec 精确暂存本批两个文件（注意共享工作区索引竞态，见
  `_active/` 外的既有 SOP：`commit-tree + update-ref` 路线）。
- console 仍有两条 MVU 报错：`TypeError: … reading 'length'` 与 `不存在任何一条消息，退出`。
  二者**同源**，发生在 MVU 初始化时点（彼时消息尚未注入主页面），属独立议题，**未处理**。
- SUPPLIED 白名单 68 项里另有 **7 项虚列**（`getCharacter` / `replaceScriptInfo` / `eventOnce` /
  `eventEmitAndWait` / `eventRemoveListener` / `eventClearEvent` / `eventClearListener` /
  `eventClearAll` / `builtin`）—— 已核 `d:/SillyTavern-release` 全树**无同名导出**，
  属白名单写了但 ST 侧不存在，暂不实现，另记。
