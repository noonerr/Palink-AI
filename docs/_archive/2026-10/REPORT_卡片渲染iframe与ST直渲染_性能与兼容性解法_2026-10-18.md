# 角色卡渲染：iframe vs ST 直渲染 —— 能否解决？

> 日期：2026-10-18｜性质：**只读调研 + 真机实测**，未改任何生产代码
> 权威基准：`_reference/sillytavern-1.18.0/`（ST 1.18.0 官方源码）
> 实测对象：`http://localhost:16000`，角色 `c28061bb…`，5 卡 / 7 iframe
> 触发问题：「他们直接渲染，我们用 iframe，导致性能和兼容性问题，能否解决？」

---

## 0. 一页速览

| 问题 | 答案 |
|---|---|
| ST 真的"直接渲染"吗？ | **是**，但前提是 **ST 核心根本不执行卡内脚本**（`tavern_helper`/`runScript` 全仓 0 命中，卡片 `<script>` 被 DOMPurify 剥掉） |
| Palink 为什么必须 iframe？ | 因为 Palink 要做 **ST 不做的事**：执行卡内脚本。隔离是这个超集能力的代价 |
| 性能问题的根因是 iframe 吗？ | **不是。** 实测：每帧 srcdoc 893KB，其中**卡片真正的内容只占 3%（~28KB）**，97% 是内联的兼容运行时 + 启动数据 |
| 能解决吗？ | **能，而且不用改架构**：把那 97% 抽成共享静态资源即可，实测可把 6.26MB → ~0.2MB（**约 30 倍**） |
| 能不能完全改成直渲染？ | **只有放弃"执行卡内脚本"才能**。这是硬性取舍，没有两全 |

**一句话**：你感觉到的"iframe 慢"，97% 是**我们把 880KB 运行时塞进了每张卡的 srcdoc**造成的，不是 iframe 本身。先修这个（一周，零风险），架构层面的取舍再议。

---

## 1. 事实澄清：ST 到底怎么做的

### 1.1 ST 的消息渲染路径（直渲染，无 iframe）

```
getMessageTextHTML()            script.js:2464
  └─ messageFormatting()        script.js:1753
     └─ messageElement.find('.mes_text').html(messageHTML)   script.js:2637
```

jQuery `.html()` = 裸 `innerHTML`，**直接进主页面 DOM，同 origin**。整条链路无任何 iframe。
（`updateMessageBlock` `script.js:1978`、编辑完成 `script.js:8260/8351`、流式 `streaming-display.js:281` 同理。）

### 1.2 🔴 关键事实：ST 核心**不执行**卡内脚本

| 关键词 | 在 ST 1.18.0 `public/` 下的命中 |
|---|---|
| `tavern_helper` | **0** |
| `runScript` / `executeScript` | **0** |
| `character_book` 脚本执行 | 0（只当**世界书数据**转换：`world-info.js:5579/5634`） |
| `eval(` / `new Function` 用于卡片内容 | **0** |
| `<script>` 插入 | 只用于**加载扩展**（`extensions.js:813-838`，`script.src` 固定为 `/scripts/extensions/${name}/${manifest.js}` 本地路径） |

`globalThis.SillyTavern = { libs, getContext }`（`script.js:292`）注释明写 **「API OBJECT FOR EXTERNAL WIRING」**——是给**扩展**的，不是给卡片的。
卡片里的 `<script>` 走不到任何执行路径，被 `DOMPurify.sanitize` 直接剥离。

> **结论**：`tavern_helper` 一类卡内脚本在 ST 里**不是核心功能**，是第三方扩展（STScript / card-script 类扩展）额外注入的能力。
> **Palink 在 iframe 里原生跑卡脚本，是在做 ST 核心不做的事——属于超集能力，不是"对齐 ST"。**

### 1.3 ST 的安全模型：DOMPurify 单点 + CSP 关闭

- 消毒：`DOMPurify.sanitize(mes, config)`（`script.js:1908`，配置 `script.js:1899-1906`）
- **CSP：服务端显式关闭** —— `src/server-main.js:104-105` 的 `helmet({ contentSecurityPolicy: false })`
- 信任模型：**ST 相信 DOMPurify 能挡住 XSS，所以敢同 origin**。Palink 用 opaque origin iframe，是**不把 DOMPurify 当作可信边界**。

### 1.4 🔴 口径订正：ST **做了** CSS 作用域，不是靠作者自约束

ST 的三件套（`script.js:1907-1909`，实现在 `chats.js`）：

```js
mes = encodeStyleTags(mes);                        // chats.js:536  <style> → <custom-style> URL 编码
mes = DOMPurify.sanitize(mes, config);
mes = decodeStyleTags(mes, { prefix: '.mes_text ' }); // chats.js:551
```

`decodeStyleTags` 内部：
- `sanitizeRule()`（`chats.js:556-562`）——**每条规则的每个选择器强制拼 `.mes_text ` 前缀**
- `sanitizeSelector()`（`chats.js:569`）——`.className` → `.custom-className`（`chats.js:589-595`）
- 递归处理 `:has()/:not()/:where()/:is()` 内的嵌套选择器（`chats.js:571-579`）
- 类名前缀同样作用于 HTML 属性（`chats.js:1922-1932`，白名单例外 `fa-`/`note-`/`monospace`）

⇒ `body { background: red }` 会被改写成 `.mes_text body { … }`，**匹配不到任何元素，不污染页面**。

⚠️ **本项目 `inline/inline-sanitize.ts` 头部的决策 C4「不 scope，卡片作者用 `.mes_text .xxx` 自约束，与 SillyTavern 行为一致」——这个前提已被证伪。**
ST **不是**靠作者自约束，是**自动加前缀**。若将来走直渲染路线，必须先把这三件套补齐。

---

## 2. 性能病灶实测（这才是重点）

### 2.1 每帧 srcdoc 893,604 字节的**逐块拆解**

| # | 块 | 字节 | 占比 | 说明 |
|---|---|---|---|---|
| 1 | `legacyShim`（内联 `<script>`） | **495,138** | **55%** | `buildShim()` = `legacy-st-sim`（2452 行）。**未外部化** |
| 2 | `window.__palinkBoot__`（内联 `<script>`） | **359,675** | **40%** | compat v2 的**启动数据**：context + `chatMessages` + **`characterExtensions`** + `presetData` |
| 3 | 运行时（外部 `<script src>`） | — | — | `/assets/palink-smart-card-runtime-0274569ea4e2.js`（383 KB）✅ **已外部化** |
| 4 | `cardScriptBootstrap` | 9,143 | 1% | |
| 5 | 卡脚本（`populateLutiyaData`） | 7,242 | 1% | |
| — | 卡片 `<style>` ×3 | 11,370 | 1% | 卡片真正的 CSS |
| — | `<body>` | ~10,320 | 1% | 卡片真正的 HTML |

**7 帧合计 srcdoc = 6,258,832 字节（6.26 MB）**；而 7 帧里**真正的卡片内容只有 ~210~224 个 DOM 节点、7~11 KB CSS**。

⇒ **97% 的字节是运行时和启动数据在 7 份之间反复复制。**

### 2.2 为什么 359KB 启动数据这么大

`buildSmartCardCompatRuntimeBootPayload`（`SillyTavernCompatRuntime.ts:165-243`）把整个 context JSON 化塞进去，
其中 `characterExtensions`（`SillyTavernCompatRuntime.ts:191`）实测 = **角色的全部 extensions ≈ 351 KB**：

| extensions 子项 | 字节 |
|---|---|
| `palink_raw_card_data` | 178,490 |
| `regex_scripts` | 74,666 |
| `tavern_helper`（3 段卡脚本） | 50,912 |
| `palink_sillytavern` | 46,836 |
| 其余（depth_prompt / narramem / odysseia 等） | ~1,000 |

⚠️ **这 359KB 对同一角色的 7 张卡是完全相同的**——只有 `messageId`/`messageContent` 不同。
而卡脚本/regex 其实**已经有独立的下发通道**：`postPluginScriptsToFrame` / `postCardScriptsToFrame`
（`CharacterCardRenderer.tsx:618-622`）——启动数据里这份是**冗余副本**。

（帧内确实同步读 `ctx.characterExtensions`：`part-03.ts:436` regex、`part-04.ts:119`、`part-05.ts:885-888`、
`legacy-st-sim part-b.ts:215`。所以不能直接删，要**改成共享/按需**。）

---

## 3. 解法（三档，按"性价比 × 风险"排序）

### 🟢 C 档：立刻能做（约 1 周，不动架构、不碰安全边界）

| 动作 | 收益 | 风险 |
|---|---|---|
| **C-1** legacyShim 外部化：照抄 compat v2 已验证的 `externalRuntimeUrl` 机制（`SillyTavernCompatRuntime.ts:244-247` + `runtime-url.ts` + Vite virtual module），把 495KB 也变成 `<script src>` 静态资源 | **−495 KB/帧** | 低（同机制已跑通 383KB 那份） |
| **C-2** 启动数据瘦身：`characterExtensions` 不再进 boot payload，改由已有的 `postCardScriptsToFrame`/`postPluginScriptsToFrame` 下发并**在帧内缓存**；`chatMessages` 只传必要字段 | **−300 KB/帧** | 中（要改帧内同步读取点，见 §2.2 的 4 处） |
| **C-3** srcdoc → `src`：把 893KB 的 `srcdoc` 换成一个**共享的静态 frame HTML**（`/assets/palink-smart-card-frame.html`），卡片内容由 postMessage 注入 | **6.26 MB → 一份 ~900KB（7 帧共享）**，且 V8 code cache 跨帧复用 | 中（要处理加载时序） |

**C-1 + C-2 做完**：srcdoc 893KB → **~30 KB**，7 帧 6.26MB → **~0.2 MB**，约 **30 倍**。
**再加 C-3**：7 份编译产物 → 1 份。

> C 档**不解决**"父侧摸不到卡 DOM"的兼容性问题，但把"性能"这一半彻底解决了。

### 🟡 D 档：信任分级（解决"父侧全盲"这一整类兼容性问题）

- 用户**显式信任**的卡 → iframe 加 `allow-same-origin`，父页可读 `contentDocument`
- 未信任 → 维持 `allow-scripts` only（opaque origin）

收益：今天装的**帧内样式守护可以直接换成父侧守护**（更好写、更好测）；卡片 UI 与页面 UI 能真正联动。
代价：信任授予流程要显式化（已有 `readSmartCardTrustGrant` / `writeSmartCardTrustGrant` 可复用）。

### 🔴 A 档：按内容分流（架构改动）

- 检测消息 HTML 是否含可执行脚本 / 角色是否配了 tavern_helper
- **纯 HTML/CSS 卡 → 直渲染进消息 DOM**（抄 ST 的 DOMPurify + `.mes_text ` 前缀 + `custom-` 类名三件套）
- **有脚本的卡 → 继续 iframe**

前提：**必须先补 §1.4 的 CSS 作用域三件套**（否则 `body {}` / `.mes_text {}` 会污染整页）。
本例 7 帧里 5 帧是相册卡、2 帧是大卡，全部依赖角色级脚本 ⇒ **本例分流收益为 0**，要看其他卡型的数据才能评估普遍收益。

### 🔴 B 档：脚本沙箱单例化（架构改动，风险最高）

- 整个角色只开 **1 个**脚本 iframe（跑 tavern_helper / regex / 插件）
- 所有卡片 HTML 直渲染
- 帧数 **7 → 1**

风险：卡脚本若用 `document.querySelector('.xxx')` 找**自己卡内**的元素会失效（脚本的 `document` 是沙箱的）。
本例相册脚本恰好大量用 `topDoc`（它本就想要父页），但**需要真机统计所有卡的比例**才能下结论。

### ⛔ 做不到的事

**完全"和 ST 一样直接渲染"做不到**，除非放弃执行卡内脚本。
ST 敢直接渲染是因为它**不执行**——这是**硬性取舍，没有两全方案**。
若要保留卡脚本能力，隔离成本（iframe 或等价沙箱）必然存在；能做的是**把成本从"每帧 880KB"压到"全局一份"**。

---

## 4. 推荐路径

```
先做 C（1 周，30 倍性能收益，零架构风险）
  ├─ C-1 legacyShim 外部化            ← 有现成机制可抄，最稳
  ├─ C-2 boot payload 瘦身            ← 有现成下发通道可复用
  └─ C-3 srcdoc → 共享静态 frame       ← 压到"全局一份"
再做 D（信任分级，彻底解决父侧不可见）
最后用真机数据决定 A / B 要不要做
  └─ 判据：统计"卡脚本是否依赖自己卡内 DOM"的比例；
           若 <20% 依赖，B 档值得做；若 >50%，老实留在 iframe + C/D 优化。
```

**每步的验收口径**（照本项目既有纪律）：
- 真机复跑 `probe-srcdoc.js` / `probe-blocks.js`，对比 srcdoc 总字节与各块占比；
- 卡片视觉与交互不变（用 `probe5/probe7` 同款脚本比对 t=2s / t=9s 截图与宿主高度）；
- 门禁全绿 + **改坏证明会红 / 还原回绿**。

---

## 5. 附：本次实测产物

| 文件 | 内容 |
|---|---|
| `.tmp_probe/probe-perf.js` / `out-perf.txt` | 7 帧 srcdoc 总计 6,258,832 字节、每帧 DOM 节点数 |
| `.tmp_probe/probe-srcdoc.js` | srcdoc 的 script/style/body 分段字节 |
| `.tmp_probe/probe-blocks.js` | **逐 script 块识别来源**（legacyShim 495KB / boot 359KB / 外部 383KB / bootstrap / 卡脚本） |
| `_reference/sillytavern-1.18.0/public/script.js` | ST 渲染链（1753 / 1907-1909 / 2637 / 292） |
| `_reference/sillytavern-1.18.0/public/scripts/chats.js` | ST CSS 作用域三件套（536 / 551 / 1901） |
| `_reference/sillytavern-1.18.0/src/server-main.js` | ST CSP 关闭（104-105） |
