# REPORT 批次SG：补 `SillyTavern` 全局对象（2026-10-21）

> 状态：**已完工待验收**
> 施工范围：`frontend/src/lib/plugin-system/sandbox.ts` + 新增测试；未动后端、未重建 dist、未启停容器。
> 代码提交：`0d310fb`（本报告随后以 docs 提交补入仓库）。
> 真机复验（Kimi Thinking Prefill）按计划由主脑上线后执行，本报告只写预期与下一步。

## 1. 结论

插件沙箱现在提供 ST 1.18.0 的全局对象：

```js
globalThis.SillyTavern = {
  libs: { jQuery, $, Handlebars, toastr, marked, DOMPurify },
  getContext: __sandbox.getContext,
};
```

并且**同时**在插件作用域里声明了同名 `var SillyTavern` —— 这是关键：只挂 `globalThis`
修不掉 `ReferenceError: SillyTavern is not defined`（理由见 §6-否证 A）。

## 2. 改动点（只此两处生产代码 + 一个测试）

| 文件 | 位置 | 内容 |
|---|---|---|
| `frontend/src/lib/plugin-system/sandbox.ts` | `buildWrappedCode` 的 prelude，`sandbox.ts:2940-2951`（IIFE 内、`${transpiledCode}` 之前） | `var SillyTavern = { libs: __sandbox.SillyTavernLibs, getContext: __sandbox.getContext };` + `globalThis.SillyTavern = SillyTavern;` |
| 同上 | `createSandboxGlobal`，`sandbox.ts:3142-3152` | 把原先在 `:3950` 附近的 `sandboxLibs` 清单**上移**为唯一来源（jQuery/$/Handlebars/toastr/marked/DOMPurify），下方注入 `sandboxedWindow` 的循环改为复用同一引用，避免两处清单漂移 |
| 同上 | `sandbox.ts:3155-3156` | sandbox 对象新增 `SillyTavernLibs: sandboxLibs`，仅供 prelude 组装 `SillyTavern.libs` |
| `frontend/src/lib/plugin-system/__tests__/sg-sillytavern-global.test.ts` | 新增 | 7 个可执行用例（jsdom + 真实 `PluginSandbox.executePluginCode`） |

为什么 `var` 声明和 `globalThis` 赋值两者都要：

- `var SillyTavern` 让插件顶层裸标识符（Kimi 首行）可解析；
- `globalThis.SillyTavern = ...` 让 `window.SillyTavern` / `globalThis.SillyTavern` 两条路径
  与 ST 行为一致。此处的 `globalThis` 已被 prelude 上面的 `var globalThis = __sandbox.window`
  遮蔽为 **sandboxedWindow**，写入落进 `pluginGlobals` 隔离 Map，**没有碰宿主 `window`**
  （`createSandboxedWindow` 的 set trap 对非白名单属性只做 `pluginGlobals.set`）。

## 3. `libs` 包含什么，以及 ST 有而我们没有的清单

### 3.1 我们实际提供（6 项，全部是真实注入对象）

| 键 | 实体 | 来源 |
|---|---|---|
| `jQuery` | 真实 jQuery 的包装函数（已解包沙箱 Proxy 入参） | `import jQuery from 'jquery'`（`package.json` ^4.0.0） |
| `$` | 与 `jQuery` **同一引用** | 同上 |
| `Handlebars` | 真实 Handlebars | `import Handlebars from 'handlebars'` |
| `toastr` | 真实 toastr | `import toastr from 'toastr'` |
| `marked` | 真实 marked | `import { marked } from 'marked'` |
| `DOMPurify` | 真实 DOMPurify | `import DOMPurify from 'dompurify'` |

`Object.keys(SillyTavern.libs)` 精确等于
`['$', 'DOMPurify', 'Handlebars', 'jQuery', 'marked', 'toastr']`（测试钉住，多一个少一个都红）。

⚠️ `select2` **没有**放进 `libs`：本沙箱的 select2 是 jQuery 插件（`$.fn.select2`）+
`window.select2` 布尔可用标志，不是独立库对象；ST 的 `libs` 里也没有它。

### 3.2 ST 1.18.0 的权威 `libs` 是 25 键（`_reference/sillytavern-1.18.0/public/lib.js:84-110`）

与我们重叠的只有 **2 个**：`DOMPurify`、`Handlebars`。

**ST 有而我们没有（23 个，全部诚实为 `undefined`，没有造假对象）：**

`lodash`、`Fuse`、`hljs`、`localforage`、`css`（@adobe/css-tools）、`Bowser`、
`DiffMatchPatch`、`Readability`、`isProbablyReaderable`、`SVGInject`、`showdown`、
`moment`、`seedrandom`、`Popper`、`droll`、`morphdom`、`slideToggle`、`chalk`、
`yaml`、`chevrotain`、`gzipSync`、`gzip`、`sha256`

**我们有而 ST 的 `libs` 没有（4 个，Palink 超集）：** `jQuery`、`$`、`toastr`、`marked`
（ST 里 jQuery/$/toastr 是独立全局，不在 `libs` 内；`marked` 是 Palink 自有，ST 用 showdown）。

## 4. 测试与反证（7 passed）

文件：`frontend/src/lib/plugin-system/__tests__/sg-sillytavern-global.test.ts`
运行：`cd frontend && npx vitest run src/lib/plugin-system/__tests__/sg-sillytavern-global.test.ts`
结果：**7 passed / 0 failed**（实跑输出：`Tests 7 passed (7)`）。

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 真实插件形态（Kimi 首行） | `const { eventSource, event_types } = SillyTavern.getContext();` 能执行；两者非 undefined；`eventSource.on` 是函数；`event_types` 键数 > 0；`eventSource === require('script.js').eventSource` |
| 2 | `SillyTavern.libs.jQuery` 类型 | `typeof libs.jQuery === 'function'`；`libs.$ === libs.jQuery`；`libs.jQuery.fn` 是对象且带版本串；Handlebars/DOMPurify/toastr/marked 各自关键方法是函数 |
| 3 | libs 诚实性 | `libs.lodash / libs.Fuse / libs.moment` 均为 **undefined**；键集合精确 6 项 |
| 4 | 与既有 `getContext()` 同形 | 两者的 `Object.keys().sort()` 完全一致；`SillyTavern.getContext === getContext`；`event_source`/`event_types`/`chat` 可读（`chat` 为 object） |
| 5 | 不是“什么都返回”的 Proxy | `Object.keys(SillyTavern)` 精确 `['getContext','libs']`；不存在的顶层/lib 属性为 undefined；原型是 `Object.prototype`；`window.SillyTavern === SillyTavern === globalThis.SillyTavern` |
| 6 | 不污染宿主 | 执行插件前后宿主 `window.SillyTavern` 均为 undefined |
| 7 | **反证** | 取生产 `buildWrappedCode` 的真实文本，正则**整块剥离**批次SG 那段后用同一 Kimi 首行执行：模块体不再执行，`window.__lastPluginRuntimeError.message` 含 `SillyTavern is not defined`；对照未剥离时 `typeof SillyTavern === 'object'` |

反证用例同时断言“剥离后文本里不再有 `var SillyTavern`”，并在剥离前断言标记仍存在于生产 prelude，
防止将来有人改标记导致反证静默失效。

## 5. 门禁

运行：`bash scripts/gate.sh frontend`（本机 Git Bash）

- `前端 tsc --noEmit`：**通过**（另单独跑 `npx tsc --noEmit` rc=0）
- `前端 vitest`：**127 files passed / 1655 passed + 3 skipped (1658)**
- **failed = 0，errors = 0**
- 门禁脚本汇总：`全部门禁通过。`，`GATE_RC=0`

（3 skipped 是仓内既有 `it.skip`，与本次无关；`agents.md` 记录的基线同为 3。）

## 6. 否证主脑

> 按纪律，凡主脑给的“一手事实”都复核了一遍，下列四处与任务书描述不符或不足。

**A（关键）：只写 `globalThis.SillyTavern = {...}` 修不掉 Kimi 的报错。**
`new Function` 的作用域链是「插件 IIFE 局部 → 真实全局对象」，**不会**去查 `sandboxedWindow`
的属性；而 prelude 里 `var globalThis = __sandbox.window` 只改变了 `globalThis` 这个标识符，
不改变裸标识符的解析路径。Kimi 首行是裸 `SillyTavern`，若只挂 `globalThis` 仍会
`ReferenceError`。故本批同时加了 `var SillyTavern`，并用可执行反证把两者绑定
（剥离整块 → 同一段代码报 `SillyTavern is not defined`）。

**B：ST 1.18.0 的 `libs` 里没有 jQuery / `$` / toastr。**
一手核对 `_reference/sillytavern-1.18.0/public/lib.js:84-110`，default export 恰为 25 键
（lodash、Fuse、DOMPurify、hljs、localforage、Handlebars、css、Bowser、DiffMatchPatch、
Readability、isProbablyReaderable、SVGInject、showdown、moment、seedrandom、Popper、droll、
morphdom、slideToggle、chalk、yaml、chevrotain、gzipSync、gzip、sha256）。
jQuery/$/toastr 在 ST 里是 `window.*` 独立全局。任务书把它们说成“ST 的 libs 里有”不准确；
我们仍按“真实注入即放入”的口径保留这 4 个 Palink 超集键（对插件是纯增益，不覆盖 ST 语义）。

**C：`DOMPurify` 与 `lodash` 在插件沙箱里都不是“垫片”。**
`DOMPurify` 是真实 npm 依赖（`package.json` `dompurify ^3.4.14`，`sandbox.ts:15` 直接 import）；
`lodash` 在插件沙箱里**根本不存在**——既无 import、也无 `_` 垫片，只有模块级
`deepMergeObjects()` 在语义上对齐 `_.mergeWith`（`sandbox.ts:65`）。
前端 `package.json` 也没有 lodash 依赖。因此 `libs.lodash = undefined` 是诚实缺口，
本批**没有**为了凑 ST 的 25 键造垫片。

**D：`select2` 不是可放进 `libs` 的库对象。**
沙箱只做了两件事：`select2Factory(window.jQuery)` 扩展 `$.fn.select2`，以及
`window.select2 = select2Ready`（布尔）。ST 的 `libs` 同样不含 select2，故未列入。

## 7. 没做的与原因

1. **补齐 ST 的另外 23 个 libs 键**：本批明确“不造假、只放真实注入”。这 23 个需要真实 npm
   依赖或 CDN 懒加载（iframe 轨 `runtime-body/part-08.ts` 已有一套 25 键懒加载实现），
   属于独立批次；直接 `import` 会显著增大插件沙箱 chunk。→ 未做。
2. **注入 lodash**：`package.json` 无依赖，且引入完整 lodash 会增大 bundle；
   `SillyTavern.libs.lodash` 若成为真实插件的下一个报错点，建议单独立项（真依赖或经审计的 lite 版）。
3. **真机复验 Kimi Thinking Prefill**：按任务分工由主脑上线后执行；本批只做到 jsdom 可执行证据。
4. **不改 `OPEN_ISSUES.md` #1 的状态**：验收口径要求真机复验后才算关闭，留待主脑。
5. **未动**任何禁用清单文件（`preset_overlay.py` / `prompt_manager.py` / `character_message_builder.py` /
   `resolveSmartCardHostSessionId` / 设置界面 / `runtime-body/part-01.ts`），未建表、未改 dist、
   未启停 Docker、未调付费 API。

## 8. 真实插件复验预期与下一步

**预期（主脑上线后）：** Kimi Thinking Prefill 1.1.0 的两条
`ReferenceError: SillyTavern is not defined`（`initSetting` 与 PAGEERROR）消失；
`initSetting` 能继续往下执行。

**若还有后续报错，最可能的三个点（按概率）：**

1. `SillyTavern.libs.lodash` / `moment` / `yaml` 为 `undefined` —— 本批诚实缺口，
   若插件直接 `SillyTavern.libs.lodash.get(...)` 会变成
   `Cannot read properties of undefined`。**这是预期下一步的首选**。
2. `SillyTavern.getContext()` 上的冷门字段缺失 —— 我们的 context 是
   「PluginContext 自有键 → sandbox eventSource/extensionSettings → `buildStContext()` 兜底」
   的惰性 Proxy；`buildStContext()` 未覆盖的键返回 undefined（ST 语义），
   需按 Kimi 实际读的字段逐个补。
3. `event_types` 的事件名与它订阅的事件不一致 —— 需要拿到它的控制台堆栈再定位。

**判据：** 复验时请同时看「控制台是否还有 `SillyTavern is not defined`」与
「插件是否进入 initSetting 的下一步」，只看前者会把“换了个错”误判成修好。

## 9. 开工前 `git status --porcelain`（一手）

开工时工作树已存在的改动（**非本批产生**）：

```
 M .workbuddy-ai/memory/2026-10-18.md
 M .workbuddy-ai/memory/MEMORY.md
?? "_BACKUPS/2026-10-05_KaTeX延迟加载前/"
?? "_BACKUPS/2026-10-05_MVU插件能力补齐批次A/"
?? "_BACKUPS/2026-10-05_dist重建前_MVU初始化补API/"
?? "_BACKUPS/2026-10-05_dist重建前_MVU批次A/"
?? "_BACKUPS/2026-10-05_dist重建前_记忆修复+MVU批次/"
?? "_BACKUPS/2026-10-05_ios历史回退复现/"
?? "_BACKUPS/2026-10-05_删除离屏跳绘机制前/"
?? "_BACKUPS/2026-10-05_变量自动清理_MVU对齐/"
?? "_BACKUPS/2026-10-05_变量面板与插件变量接线/"
?? "_BACKUPS/2026-10-05_状态栏跟随变量修复/"
?? "_BACKUPS/2026-10-05_宽屏宽度与高度上限修复前/"
?? "_BACKUPS/2026-10-06_dist重建前_SillyTavern桥接/"
?? "_BACKUPS/2026-10-06_dist重建前_卡片消息id回退/"
?? "_BACKUPS/2026-10-06_dist重建前_控制台治理/"
?? "_BACKUPS/2026-10-06_dist重建前_沙箱权限与同名书/"
?? "_BACKUPS/2026-10-06_流式渲染与思考框四修复/"
?? "_BACKUPS/2026-10-07_dist重建前/"
?? "_BACKUPS/2026-10-07_dist重建前_对话页性能四修复/"
?? "_BACKUPS/2026-10-07_对话页性能四问题修复/"
?? "_BACKUPS/2026-10-07_智能卡休眠闪屏修复/"
?? "_BACKUPS/2026-10-07_记忆向量pgvector迁移/"
?? "_BACKUPS/2026-10-07_记忆注入元组解包修复/"
?? "_BACKUPS/2026-10-07_记忆语义切分阈值/"
?? "_BACKUPS/2026-10-08_服务器性能优化_ollama与线程池/"
?? "_BACKUPS/2026-10-09_DeepSeek密钥切换/"
?? "_BACKUPS/2026-10-09_向量A批_嵌入不再阻塞事件循环/"
?? "_BACKUPS/2026-10-09_记忆检索修复/"
?? "_BACKUPS/2026-10-09_记忆预分配比/"
?? "_BACKUPS/2026-10-10_记忆档位注释一致性/"
?? "_BACKUPS/2026-10-10_验证体系与缺陷修复/"
?? "_BACKUPS/2026-10-11_记忆阶段0_止血立竿子/"
?? "_BACKUPS/2026-10-12_命令行环境修复/"
?? "_BACKUPS/2026-10-13_S1收尾G7与T2/"
```

本批实际改动（`git status --porcelain | grep -v '^?? "_BACKUPS'`）：

```
 M .workbuddy-ai/memory/2026-10-18.md        ← 开工前已存在，非本批
 M .workbuddy-ai/memory/MEMORY.md            ← 开工前已存在，非本批
 M frontend/src/lib/plugin-system/sandbox.ts
?? frontend/src/lib/plugin-system/__tests__/sg-sillytavern-global.test.ts
```

---

## 上线实测（2026-10-21 傍晚 · 主脑自己跑，**真实插件复验**）

上线：`dist` 归档（**8622** 文件，改前入口 `index-BiIprpTC.js`）→ 构建 **1m37s**
→ 只增不删覆盖（8622 → **8691**）→ gzip **3772** → 站点 200，新入口 **`index-y1h404Oz.js`**。
本次零后端改动，**未重建镜像**。

### 复验方式（真插件，不是自造）
把之前禁用掉的真实第三方插件 **Kimi Thinking Prefill 1.1.0** 重新启用 → 打开角色页 → 抓控制台。
（测完已再次禁用，运行配置回到 6 个插件。）

| 判据 | 改前 | 改后 |
|---|---|---|
| `ReferenceError: SillyTavern is not defined` | **有**（`initSetting` + PAGEERROR 两处） | **消失** |
| 控制台错误**种类** | **11** | **6** |
| 剩余种类 | — | 404（locales / quick-replies）、401（登录前）、RegexPresetManager 竞态、QR save、WebSocket 提示、卡侧 `style_removal` |
| 卡片帧零回归 | — | 7/7 帧 `pluginCss=5 nonEmpty=5`、`th=153`、`read5=5`、`ctx=196` |

⚠️ 边界：Kimi **现在能干净加载**，但它真正干的活是"注入 reasoning_content 预填"，
要在真实生成时才生效——那需要调模型（付费），**本批没有验证它的功能**，只验证了"不再在加载期炸"。

### 总结这条缺口
ST 的全局对象只有 `{ libs, getContext }` 两个字段（`script.js:292-295`）；
我们两样本来都有，**缺的只是把它们挂成那个全局名**。施工方额外发现：只写 `globalThis.SillyTavern` 不够——
插件用裸标识符 `SillyTavern.xxx` 时仍会 `ReferenceError`，必须在沙箱 prelude 里同时声明 `var SillyTavern`。
`libs` 只装了我们**真实注入**的 6 个库（jQuery / $ / Handlebars / toastr / marked / DOMPurify），
ST 权威 25 键里其余 23 键诚实留空——没有造假。
