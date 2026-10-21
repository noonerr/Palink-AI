# REPORT — 批次E2：宿主沙箱两处「帧内已修、宿主漏修」与 debugger.css 的 @import（2026-10-21）

> **状态：已完工，待主脑验收**（未重建 dist、未启停 Docker、未上线、未调付费 API）
> 任务书：`docs/_active/prompt/PROMPT_对话包_批次E2_宿主沙箱两处照抄与debuggercss_2026-10-21.md`
> 起因：`docs/_active/report/REPORT_控制台报错九类定性_2026-10-21.md` 的 B3 / B5 / B10
> 分支：`three-tracks-merge-20261012`，开工时 HEAD = `34bf60e`

---

## 0. 开工现场与边界

### 0.1 开工前 `git status --porcelain`（原样，去掉路径转义里的引号后）

```text
 M .workbuddy-ai/memory/2026-10-18.md
 M .workbuddy-ai/memory/MEMORY.md
?? "_BACKUPS/2026-10-05_KaTeX延迟加载前/"
?? "_BACKUPS/2026-10-05_MVU插件能力补全批次A/"
?? "_BACKUPS/2026-10-05_dist重建前_MVU初始化补API/"
?? "_BACKUPS/2026-10-05_dist重建前_MVU批次A/"
?? "_BACKUPS/2026-10-05_dist重建前_记忆修复+MVU批次/"
?? "_BACKUPS/2026-10-05_ios历史回退复现/"
?? "_BACKUPS/2026-10-05_删除离屏跳绘机制前/"
?? "_BACKUPS/2026-10-05_变量自动清理_MVU对齐/"
?? "_BACKUPS/2026-10-05_变量面板与插件变量接线/"
?? "_BACKUPS/2026-10-05_状态栏跟随变量修复/"
?? "_BACKUPS/2026-10-05_窄屏宽度与高度上限修复前/"
?? "_BACKUPS/2026-10-06_dist重建前_SillyTavern桥接/"
?? "_BACKUPS/2026-10-06_dist重建前_卡消息id回退/"
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
?? "_BACKUPS/2026-10-09_记忆预算配比/"
?? "_BACKUPS/2026-10-10_记忆档位注释一致性/"
?? "_BACKUPS/2026-10-10_验证体系与缺陷修复/"
?? "_BACKUPS/2026-10-11_记忆阶段0_止血立矩子/"
?? "_BACKUPS/2026-10-12_命令行环境修复/"
?? "_BACKUPS/2026-10-13_S1收尾G7与T2/"
```

要点：开工时 **没有** P3 的未提交改动（`preset_overlay.py` / `prompt_manager.py` / `part-07.ts` /
`SmartCardCompatController.ts` / `CharacterCardRenderer.tsx` / `types/index.ts` / `test_p3_*` 全部干净；
P3 已于 `101f7c0` 入库）。共享树基线干净，故未使用隔离 worktree，直接在共享树跑门禁。

### 0.2 红线遵守

- 未碰 `runtime-body/part-07.ts`、`SmartCardCompatController.ts`、`CharacterCardRenderer.tsx`、
  `preset_overlay.py`、`prompt_manager.py`、`character_message_builder.py`、`types/index.ts`。
- 未碰 `st-plugins/**`（第三方插件原文）、未重建 `frontend/dist`、未启停 Docker、未建表/加列/迁移。
- 未新增 skip / `|| true` / `continue-on-error`。

---

## 1. ① 每条做了什么 + 文件:行号

### E2-1 宿主 sandbox 的 `extension_settings` 补齐 ST 预置命名空间

**改动 1：名单常量 + 补齐函数**
`frontend/src/lib/sillytavern/extension-settings-store.ts:40`（常量）、`:81`（函数）

- `ST_EXTENSION_SETTINGS_PRESET_NAMESPACES = ['quickReply','quickReplyV2','translate','memory','regex']`
  —— 与帧内 `part-01.ts:751` 的数组逐键、逐序一致。
- `ensureStExtensionSettingsPresets(target = globalExtensionSettings)`：
  只补「缺失 / 非对象 / 该是数组却不是数组」的键，已有数据原样保留；
  `disabledExtensions`、`regex_presets` 钉成数组。
  **只写名单内键**，名单外未知键仍由 Proxy 返回 `undefined`。

**改动 2：宿主沙箱调用点**
`frontend/src/lib/plugin-system/sandbox.ts:3091`

- 在 `migrateLegacyExtensionSettings()` 之后、创建 Proxy 之前调用
  `ensureStExtensionSettingsPresets()`。
  顺序是刻意的：先迁移旧隔离存储，再补空壳；反过来会让预置的空对象挡住待迁移数据。
- Proxy 本体（`sandbox.ts:3092-3117`）未改：`hasOwnProperty` 命中返回预置对象，
  名单外仍走 `:3108` 的 `return undefined`。没有改成「什么都返回 {}」。

### E2-2 转译器 export 规则改用活绑定

**改动 1：规则 11（TDZ 主修）**
`frontend/src/lib/plugin-system/sandbox.ts:2625-2651`

- 旧：`module.exports.X = X;`（在 export 语句位置立即求值）。
- 新：`Object.defineProperty(module.exports, "X", { enumerable: true, configurable: true, get: function () { return X; } });`
- 与帧内 `runtime-body/part-02.ts:700-707` 同形；宿主多一个 `configurable: true`（原因见 §7-③）。

**改动 2：规则 8b（同类活绑定缺口，顺带修）**
`frontend/src/lib/plugin-system/sandbox.ts:2596-2605`

- `export let X;`（无初始化）旧实现 `module.exports.X = X;` 导出的是 `undefined` 快照；
  新实现同样用 getter，后续对 `X` 赋值可被导入方看见。
- 触发文件：`st-plugins/quick-reply/index.js:52` 一类无初始化导出（真实源码里该插件的
  `quickReplyApi` 是 import 来的，但这条例外规则本身仍应修）。

**改动 3：hoistedExports 追加段**
`frontend/src/lib/plugin-system/sandbox.ts:2657-2663`

- 末尾追加函数/类导出时，若名字已被规则 11 的 getter 定义，则跳过；
  否则 `export { Klass }; export class Klass {}` 会对 getter-only 属性赋值，
  严格模式抛 `Cannot set property ... which has only a getter`，并中断后续所有 hoisted 导出。
- 这处是首轮测试实测发现后补的（见 §3-E2-2 的 stderr 记录）。

**逐条检查结论（同函数其它 export 规则）**

| 规则 | 写法 | 是否有「早引用撞 TDZ」 | 处置 |
|---|---|---|---|
| 0 `export * from` | `Object.assign(module.exports, require(...))` | 否（require 即时求值） | 不动 |
| 1 `export { a } from 'path'` | `var {a}=require(); module.exports.a=a` | 否 | 不动 |
| 2/3/4/5 import | `var` 声明 | 否 | 不动 |
| 6 side-effect import | `require(...)` | 否 | 不动 |
| 7 `export default X` | `module.exports.default = X` | 否（ES 语义本来就在该点求值） | 不动 |
| 8 `export const X = v` | `const X = module.exports.X = v` | 否（声明与导出同一语句） | 不动 |
| 8b `export let X;` | 旧：立即赋值；新：getter | 不抛 TDZ，但导出的是 undefined 快照（同类活绑定缺口） | **改了** |
| 9 `export function X` | 记录名字，末尾导出 | 否（函数声明提升） | 不动（末尾追加加 hasOwnProperty 守卫） |
| 10 `export class X` | 记录名字，末尾导出 | 否（类在末尾赋值时已初始化） | 不动（同上） |
| 11 `export { a, b as c }` | 旧：立即赋值 | **是（真机 B5）** | **改了** |

### E2-3 `debugger.css` 的 `@import` 重写为插件资产 URL

**改动**
`frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts:978-1003`
（`rewriteStPluginCssUrlsCompat`，原 `:978-982` 的 url-only 版本）

- 新增两条 `@import` 重写（裸字符串形式 + `url(...)` 形式），行为与既有 `url()`
  重写同源：相对路径 → `stPluginAssetUrlCompat(plugin.id, resolveStPluginAssetPathCompat(...))`
  = `/api/plugins/<uuid>/asset/<path>`。
- `https:` / `//` / `/` / `data:` / `blob:` / `#` 原样保留，不越权改写。
- 改写后仍保持 `@import url(...)` 形态且位于样式表首部；后续 `url()` 规则不会二次改写绝对路径。
- 未改 `part-07.ts`；改前确认 `part-01.ts` 工作区干净（最后改动 commit `c5086b6`，无在途改动）。

**为什么选 (a) 重写而不是 (b) 取证面降噪**

- `st-plugins/regex/style.css:1` 的 `debugger.css` 在后端 `resources.assets` 里真实存在
  （`.tmp_probe/errtriage_plugins_config.json`：Regex 插件 `db0c6324-…` 的 assets = `['debugger.css']`，
  见 `backend/app/api/plugins.py:409-414` 的资产收集与 `:1870-1898` 的 asset 端点返回 `text/css`）。
- 重写是一处正则级、零新机制、保留 CSS 语义；选 (b) 需要在取证记录器里维护已知项白名单与计数，
  代码面更大，且会把「样式表引用坏了」这件事长期藏起来。
- 重写后每帧仍会请求 `debugger.css`（最多 14 次/轮），但响应是 200 `text/css`，不再触发 strict MIME 拒绝。
- 宿主轨 `sandbox.ts:222-251 sanitizePluginCss` 本来就会**剥掉** `@import`（`:227`），
  宿主 CSS 注入不会发这个请求 —— 任务书提醒的「宿主轨如有同款 CSS 注入需同批检查」已核查：
  **宿主无此病，未改**。

---

## 2. ② 可执行测试的用例数与断言要点

| 文件 | 用例 | 载体/入口 | 断言要点 |
|---|---|---|---|
| `frontend/src/lib/plugin-system/__tests__/extension-settings-preset-namespaces.test.ts` | 6 | **真实 `new PluginSandbox().executePluginCode`** | 5 个命名空间是对象且 `{}`；`regex_presets`/`disabledExtensions` 是 `[]`；未知键 `=== undefined` 且不被读出时创建；已有数据原样保留（同一引用）；字符串/null/数组形状被纠正；宿主常量与 `part-01.ts` 数组逐键逐序相等；帧内两个数组守卫文本在 |
| `frontend/src/lib/plugin-system/__tests__/export-live-binding-transpile.test.ts` | 6 | **真实 `executePluginCode`** | `export { MODULE_NAME }` 早于 `const` 不抛 TDZ；`st-plugins/memory/index.js` 真实片段跑通；导出后重新赋值读得到新值（活绑定）；规则 8b `export let X;` 也是活绑定；`export const X` + `export { X }` 不抛 redefine；`export class` 与 `as default` 未坏 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/css-import-asset-rewrite-contract.test.ts` | 6 | **求值后产物 `COMPAT_V2_RUNTIME_ARTIFACT`** 切片执行 | 真实 `st-plugins/regex/style.css` 首行变成 `@import url("/api/plugins/db0c…/asset/debugger.css")`；裸字符串 / 无引号 url / 带引号 url+媒体查询三种形式；外链/data/blob/协议相对/根路径不改写；既有 `url()` 相对路径重写回归；URL 形状与仓内 `debugger.css` 真实存在 |

合计 **18 个新用例，全部执行型**（非「源码里含有某字符串」）。E2-1 的「两份名单一致」是唯一文本提取型守卫
（帧内在模板字符串里不能 import，这是任务书明确要求的防漂手段），其余行为均走真实沙箱。
相关既有守卫同批复跑：`runtime-body-template-literal-guard`（7）、`generated-script-parse-guard`（4）、
`runtime-source-carrier-fidelity`（17）、`style-removal-forensics-contract`（5），**34/34 绿**。

---

## 3. ③ 反证：先红 → 还原 → 再绿

### E2-1 去掉预置名单

- 动作：注释 `sandbox.ts:3091` 的 `ensureStExtensionSettingsPresets();`。
- 红（3 failed | 3 passed）：
  - `quickReply 必须是对象: expected undefined to be type of 'object'`
  - `expected [] to include 'quickReply'`
  - `expected 'oops' to deeply equal {}`
- 恢复：取消注释；复跑 **6/6 绿**。

### E2-2 规则 11 改回立即赋值

- 动作：把 `Object.defineProperty(module.exports, ... get ...)` 临时换回 `module.exports.${exported} = ${local};`。
- 红（4 failed | 2 passed），stderr 与真机同文：
  - `ReferenceError: Cannot access 'MODULE_NAME' before initialization`（最小复现 + 真实 memory 片段，各 1）
  - `ReferenceError: Cannot access 'value' before initialization`（活绑定用例）
  - `ReferenceError: Cannot access 'Klass' before initialization`（class 用例）
- 恢复：换回 defineProperty；复跑 **6/6 绿**。
- 首轮实现还暴露一个宿主特有问题（已修）：`export { Klass }` 的 getter 定义在末尾
  `module.exports.Klass = Klass` 之前时，后者会抛
  `TypeError: Cannot set property Klass of #<Object> which has only a getter`；
  已在 hoistedExports 追加段加 `hasOwnProperty` 跳过。

### E2-3 去掉 @import 重写（临时还原为 url-only 版本）

- 动作：把 `part-01.ts` 的 `rewriteStPluginCssUrlsCompat` 临时还原成只处理 `url()` 的旧实现。
- 红（1 failed | 5 passed）：
  - `真实 st-plugins/regex/style.css：首行 @import "debugger.css" 改成绝对资产 URL`
    → `AssertionError: expected false to be true`。
- 副产物发现：`@import url(debugger.css)` 与 `@import url("debugger.css")` 两例在旧实现下**仍然绿**，
  因为既有 `url()` 规则本来就会改写它们 —— 真正漏掉的只有**裸字符串形式**
  `@import "debugger.css"`，而 regex 插件正好用的是这一种。
- 恢复：贴回两条 `@import` 重写；复跑 **6/6 绿**。

---

## 4. ④ 门禁

- `bash scripts/gate.sh frontend`：**rc=0**（脚本末行「全部门禁通过」；复跑日志 `/tmp/e2_gate_frontend.log` 记录 `GATE_RC=0`）
- 前端 tsc：`npx tsc --noEmit` → **rc=0，零输出**
- 前端 vitest：**118 files passed / 1566 passed + 3 skipped / failed = 0 / errors = 0**
  （3 个 skip 是转换前既有 `it.skip`，本批未新增）
- 共享树无 P3 在途改动，故无需按文件归因；未使用 worktree。

---

## 5. ⑤ 预期上线后报错变化表（主脑用 `.tmp_probe/errtriage_full.js` 对照）

> 口径：以 `REPORT_控制台报错九类定性_2026-10-21.md` 复跑（`ERR_COUNT=208`）的桶与次数为基线。
> 本批未上线、未复跑实机，下表是「代码路径改变后应当发生什么」的预测，不是实测。

| 桶 | 报错原文（摘要） | 基线次数 | 预期上线后 | 依据 / 风险 |
|---|---|---|---|---|
| B3 | Chat Translation init `TypeError: Cannot convert undefined or null to object`（`Object.hasOwn(undefined)`） | 1 | **→ 0** | 宿主 `ensureStExtensionSettingsPresets()` 在 Proxy 创建前把 `translate` 种子为 `{}`；`Object.hasOwn({}, ...)` 不再抛。若该插件随后因别的字段报错，会是**另一条**错误原文，不是这条 |
| B3 同因 | Memory `Object.keys(undefined)`（若本轮未单独成桶） | 0/未分桶 | **→ 0（同因）** | 同一份名单里的 `memory` 也被种子为 `{}`；帧内 7/7 早已如此 |
| B5 | Summarize `ReferenceError: Cannot access 'MODULE_NAME' before initialization` | 1 | **→ 0** | 规则 11 改成 getter 后，export 语句位置不再读未初始化的 const；真实 memory 片段已同入口跑通 |
| B10 | `Refused to apply style from '…/characters/debugger.css' because its MIME type ('text/html') …` | 14 | **→ 0** | `@import "debugger.css"` 被改写成 `/api/plugins/db0c6324-2b5e-41ae-9221-43ef24b1a3ba/asset/debugger.css`；后端资产表里有该文件（text/css）。**风险点**：请求次数不会归零（仍可能 14 次/轮），只是响应从 `text/html` 变 `text/css`；若 asset 端点因鉴权/路由返回 404，错误会**换形**为 404/401 —— 这正是上线后要看的 |
| B1 | 401 Unauthorized（bootstrap 3 端点） | 5 | 5 不变 | 环境噪音，不在本批 |
| B2a | 404 `/st/locales/zh-cn.json` | 2 | 2 不变 | 不在本批 |
| B2b+B6 | 404 `/api/quick-replies/save` + `QR could not be saved` | 1+1 | 不变 | 后端缺 ST 兼容端点，不在本批 |
| B4 | `[Plugin Regex] RegexPresetManager: Could not find preset select element` | 1 | 1 不变 | 宿主 init 与设置面板挂载时序竞态，不在本批 |
| B7 | `style_removal[node_removed]` | 168 | 168 不变 | 卡脚本行为 + 取证面限流，不在本批 |
| B8 | Music.js 外链失败族 | 14 | 14 不变 | 外网资产不可达，不在本批 |
| B9 | Live2DManager `PIXI.live2d 未就绪` | 0（回归轮 7） | 不变 | 卡侧用户脚本，不在本批 |

**总量预期**：208 − 1（B3）− 1（B5）− 14（B10）≈ **192**；若 Memory 的
`Object.keys(undefined)` 本轮另计，再减去对应条数。B10 的「请求 200 但仍刷新」不算错误，
不应计入 ERROR 行数。

反证对照口径：若上线后 **B3/B5/B10 任一仍按原次数出现**，说明
①dist 没真正重建、或 ②宿主/帧内加载的不是这份代码（先查容器内 bundle 指纹），
不要先怀疑修复逻辑。

---

## 6. ⑥ 没做的事与原因

1. **未重建 `frontend/dist`、未启停 Docker、未上线、未调付费 API** —— 任务书红线；实机判据由主脑跑。
2. **未碰 `part-07.ts` / `SmartCardCompatController.ts` / `CharacterCardRenderer.tsx` / P3 后端文件** —— 避免与外部 agent 撞车。
3. **未改 `st-plugins/**`** —— 第三方插件原文；`debugger.css` 的坏引用在注入器侧解决，不改别人的文件。
4. **未做取证面降噪/白名单** —— 选了 E2-3 方案 (a) 重写；不消音、不加计数器。
5. **未跑 `bash scripts/gate.sh backend`** —— 本批零后端改动；按任务要求只跑 frontend。
6. **未做浏览器实机验证** —— 只有主脑能上线；本报告 §5 给出可对照的预期表。
7. **未新增 `docs/` 以外的文件**；报告即本文件。

---

## 7. ⑦ 与本件不一致处（否证/偏差，单列）

> 结论：**任务书的三个缺陷前提均成立，没有需要停下回报的否证**。以下是照抄时发现、
> 必须在宿主侧偏离「逐字照抄帧内」的地方，以及两处口径澄清。

1. **规则 11 不能逐字照抄帧内实现**（实现偏差，已处理）：
   帧内 `normalizeStExportListCompat` 的 `Object.defineProperty(exports, …, { enumerable, get })`
   是**不可配置**的；宿主转译器的规则顺序是「规则 8（`export const X` → 数据属性）先跑、
   规则 11 后跑」，同一模块若 `export const X` 后再 `export { X }`，非 configurable 的
   defineProperty 会抛 `Cannot redefine property: X`。故宿主加了 `configurable: true`。
   另外帧内没有「末尾 hoisted 导出再赋一次」的段落，宿主有；已在追加段加
   `hasOwnProperty` 跳过，否则 `export { Klass }; export class Klass {}` 会抛
   `Cannot set property ... only a getter`（首轮测试实测）。
   → 这是宿主实现细节，不改变「活绑定」这一照抄目标。

2. **规则 8b 也改了**（任务书要求「顺带检查同函数其它规则」）：
   `export let X;` 的立即赋值不抛 TDZ，但导出的是 `undefined` 快照，属同一类活绑定缺口。
   已改成 getter；若主脑认为超出「只做三条」边界，可单独回退这一处（不影响规则 11 与 B5）。

3. **`st-plugins/summarize` 在仓内不存在**（口径澄清）：
   任务书写「`st-plugins` 里 memory/summarize 那个 `index.js`」。实际仓内只有
   `st-plugins/memory/index.js`；Summarize 的源码只在 DB 插件里（探针配置里 `ffb782eb-…`）。
   故真实源码用例用的是 **memory/index.js:34-36**（帧内注释点名的就是它），未去动 DB/插件源码。

4. **E2-3 真正漏掉的只有裸字符串 `@import "…"` 形式**（口径澄清）：
   `@import url(debugger.css)` / `@import url("debugger.css")` 在旧实现下已被既有 `url()`
   重写覆盖（反证时这两例仍绿）。regex 插件恰好用的是裸字符串形式，所以「一处正则」成立，
   但新增规则的实际作用面比任务书描述窄；本批仍把 `url(...)` 形式一并纳入，避免将来插件换写法。

5. **宿主轨没有同款 CSS 注入病**（核查结论）：
   `sandbox.ts:222-251 sanitizePluginCss` 在 `:227` 直接剥掉 `@import`，宿主 `<style>`
   不会发 `debugger.css` 请求。任务书说「宿主轨如有同款 CSS 注入需同批检查」——已查，无病，未改。

6. **`disabledExtensions` 的既有种子在 `loadFromStorage`**（口径澄清）：
   `extension-settings-store.ts:56` 早就在加载时补过 `disabledExtensions=[]`，但只在首次
   `loadFromStorage()` 生效；本批的 `ensureStExtensionSettingsPresets()` 在每次沙箱创建时
   重新断言，并把 `regex_presets` 一并纳入。不是新缺陷，只是把保证点前移。

---

## 8. 提交

按任务书临时索引提交，逐项 pathspec，先 `git status` 复核后只暂存本批路径：

- 代码 + 3 份测试 + 本报告：`c9dba97`
  `feat(批次E2): 宿主沙箱补 ST 预置命名空间与 export 活绑定，帧内 @import 改指插件资产`
  （7 files changed, 799 insertions(+), 10 deletions(-)）
- 目录刷新：`d1493ec`
  `chore(docs): 复生成 _CATALOG.md（批次E2 报告入库后 tracked 数 412→413）`
- `py scripts/docs/gen_docs_catalog.py --check` → `OK 415 docs, catalog up to date`（rc=0）。
- 未包含：`.workbuddy-ai/memory/*`（他人在途改动）、`_BACKUPS/**`（永久排除）、
  P3 文件（本批一行未碰）。
