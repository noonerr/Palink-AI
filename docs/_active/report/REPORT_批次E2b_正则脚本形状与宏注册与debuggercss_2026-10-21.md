# REPORT — 批次E2b：正则脚本形状 / 宏注册 / debugger.css 内联（2026-10-21）

> **状态：已完工，待主脑验收**（未重建 `frontend/dist`、未启停 Docker、未上线、未调付费 API）
> 任务书：`docs/_active/prompt/PROMPT_对话包_批次E2b_正则脚本形状与宏注册与debuggercss_2026-10-21.md`（主脑派单原文）
> 起因：批次E2 上线后主脑实机探针 `.tmp_probe/errtriage_full.js` 暴露的三条问题
> 分支：`three-tracks-merge-20261012`，开工 HEAD = `f373801`（E2 实机复验文档入库后）

---

## 0. 开工现场与边界

### 0.1 共享树里有并行 agent 的在途改动（本批一行未碰）

开工时 `git status --porcelain` 除本批目标文件外，还有另一条工作流的未提交改动：
`CharacterCardRenderer.tsx`、`PresetManager.tsx`、`CharacterView.tsx`、`ChatManagerDialogs.tsx`、
`PromptSettings.tsx`、`RoleplayEngineTab.tsx`、`lib/promptPresetSelection.ts` 及两个新增测试目录。
本批**没有修改**其中任何文件（红线文件 `CharacterCardRenderer.tsx` 也未碰）。
门禁是在这棵共享树上跑的 —— 见 §3，结果全绿；提交时只逐项 pathspec 暂存本批文件。

### 0.2 红线遵守

- 未碰 `SmartCardCompatController.ts`、`runtime-body/part-07.ts`、`preset_overlay.py`、`prompt_manager.py`、
  `CharacterCardRenderer.tsx`。
- 未改 `st-plugins/**` 第三方源码；`debugger.css` 只读。
- 未重建 `frontend/dist`、未启停 Docker、未上线、未调付费 API、未建表/加列。
- 未新增 skip / `|| true` / `continue-on-error`。

---

## 1. ① 三条各改到哪（文件:行号）

### E2b-1 `extension_settings.regex` 必须是数组（E2 回归）

**宿主 store** `frontend/src/lib/sillytavern/extension-settings-store.ts`

- `:46` `ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES = ['quickReply','quickReplyV2','translate','memory']`
- `:54` `ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES = ['regex']`
- `:57` `ST_EXTENSION_SETTINGS_PRESET_NAMESPACES` 保留为合并键名列表（兼容只关心键名的调用方）
- `:69` `NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY = '__palink_extension_settings_normalized_backup'`
- `:73` `preserveNormalizedPresetValue()`：脏值写 localStorage + `console.warn` 点名
- `:136` `ensureStExtensionSettingsPresets()`：对象型只补 `{}`，数组型只补 `[]`；
  `regex` 已有非数组（对象/字符串/null）→ 归一为 `[]`，原值进备份。

**宿主沙箱调用点** `frontend/src/lib/plugin-system/sandbox.ts:3103` 未变（函数内部按类型处理）。

**帧内同一份名单** `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts:757-788`

- `:757` `ST_PLUGIN_PRESET_OBJECT_NAMESPACES_COMPAT = ['quickReply','quickReplyV2','translate','memory']`
- `:758` `ST_PLUGIN_PRESET_ARRAY_NAMESPACES_COMPAT = ['regex']`
- `:763-787` 数组型分支：非数组脏值先存 `window.__palinkExtensionSettingsNormalized[key]`，
  再发 `st_extension_settings_preset_normalized`（severity=info，宿主 toast 闸门不放行）后写 `[]`。
- `:789` 既有 `regex_presets` / `disabledExtensions` 数组契约不变。

**原值保留的选择与理由**

- 宿主：落 `localStorage['__palink_extension_settings_normalized_backup']`，不塞回 `extension_settings`。
  原因是后者对插件可见，`Object.keys(extension_settings)` 的消费方会多看见一条假命名空间；
  备份只给排障人看，不应参与插件语义。localStorage 与 `extension_settings` 持久化同环境，刷新后仍可查。
- 帧内：`window.__palinkExtensionSettingsNormalized`（内存快照）+ 一条 info 诊断（带 key/type）。
  帧内 `localStorage` 在 `about:srcdoc` 下可能因 origin 策略不可用，故不依赖它。
- 两处都**不静默**：宿主有 `console.warn`（生产 terser 保留 warn），帧内有 `st:diagnostic` 通道。

### E2b-2 `macros.register is not a function`

**文件** `frontend/src/lib/plugin-system/sandbox.ts:5410-5446`（`'macros/macro-system.js'` shim）

- `macros.registry` = 真 `MacroRegistry`（`@/lib/macro-engine`，与 `substituteParamsExtended` 同一张表）
- `macros.register(name, options)` → `MacroRegistry.registerMacro`，成功即记账
- `macros.unregister(name)` → `MacroRegistry.unregisterMacro`
- `macros.registerAlias(target, alias, options)` → `MacroRegistry.registerMacroAlias`
- `macros.category` = 真 `MacroCategory`
- `:5441-5445` `registerCleanup(pluginId, …)`：插件卸载时撤回它注册的宏，重载不残留旧 handler。
- `:11-13` 新增 `import { MacroRegistry, MacroCategory } from '@/lib/macro-engine'`。

**实际调用面（先 grep 再实现）**

- `st-plugins/memory/index.js:1120` `macros.register('summary', { category: MacroCategory.CHAT, description, handler })`
- `st-plugins/stable-diffusion/index.js:5978/5983` `macros.register('charPrefix' / 'charNegativePrefix', { category: MacroCategory.PROMPTS, … })`
- 仓内没有插件调用 `macros.unregister` / `registerAlias` / `macros.registry`；这三项按任务书要求做成薄包装，
  没有照抄整套 ST API（未提供 engine/lexer/parser/envBuilder 等无人调用的导出）。
- `MacroCategory` 旧 shim 是**编造枚举**（GLOBAL/PERSONA/INSTRUCT…），而 ST 1.18 用的是
  UTILITY/RANDOM/NAMES/CHARACTER/CHAT/TIME/VARIABLE/PROMPTS/STATE/MISC/UNCATEGORIZED。
  stable-diffusion 读的 `MacroCategory.PROMPTS` 在旧 shim 里恰好是 `undefined`，本批一并改成真枚举。

**为什么不是假接通**：注册写入 `MacroRegistry`，而 `substituteParamsExtended` → `evaluateMacros` 查的正是这张表。
测试从**真实 `PluginSandbox.executePluginCode`** 里注册，再在测试侧调生产 `substituteParamsExtended` 求值。

### E2b-3 `debugger.css` 仍 14 次

**选择：方案 (a) 注入时内联；对解析不到的相对 `@import` 叠加方案 (b) 剥离 + 诊断计数。**
理由：debugger.css 的内容在仓内真实存在（`st-plugins/regex/debugger.css`，5199 字节），
唯一问题是它不在插件 `source_data` 里、站点也不下发该目录。能拿到内容时内联是唯一既不请求、
又不丢样式的做法；对将来其它「仓内也没有」的相对导入，保留 (b) 的显式剥离与 `info` 诊断，
不让它重新变成 MIME 错误，也不静默消音。

**构建期资源**

- 新增 `frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts`：`debugger.css` 的字符串副本
  （2026-10-21 生成，5199 字节原文逐字节一致）。
- 新增 `frontend/src/lib/sillytavern/bundled-plugin-css.ts`：
  `BUNDLED_ST_PLUGIN_CSS` 表、插件名归一、相对路径解析、`inlineBundledStPluginCssImports()`。
- **为什么不用 `?raw`**：`bundled-plugin-css.ts` 会进入 `vite.config.ts` 的配置期导入链
  （`vite-plugins/smart-card-runtime-asset.ts` → `SillyTavernCompatRuntime`），该链由 esbuild 在
  Vite 插件生效前解析，`?raw` 查询串没有插件接手。生成模块是纯 TS，配置期与浏览器产物都能吃。
  已实际构建验证（§3）。

**帧内注入** `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts:1008-1065`

- `:1014` 构建期 CSS 表经 `${JSON.stringify(BUNDLED_ST_PLUGIN_CSS)}` 注入模板（已登记进
  `runtime-body-template-literal-guard` 白名单）。
- `:1019-1036` 按 `plugin.name / manifest.name / runtime.namespace` 归一插件名查表。
- `:1039-1052` `@import` 解析：能内联 → 内容替换（保留 `@media` / `@layer` 条件）；
  外链/data:/blob:/根路径 → 原样保留；相对但查不到 → 剥离 + `st_plugin_css_import_unresolved`（info）。
- `:1054-1065` 旧的「@import 改写成 /api/plugins/... URL」两条正则**已删除**；
  既有 `url()` 相对路径重写保留（图片等资产不受影响）。
- 结果：注入的 `<style>` 里不再有任何 `@import`，浏览器不会对 debugger.css 发请求，
  同时 debugger 面板样式（`#regex_debugger_rules` 等）真实生效。

**宿主轨同步** `frontend/src/lib/plugin-system/sandbox.ts:234-238`、`:5658`

- `sanitizePluginCss(css, pluginHint = '')`：先尝试内联构建期 CSS，再走既有消毒。
- `injectPluginCSS(pluginId, css)` 传入插件名（manager 传的是插件 `name`，如 `Regex`）。
- 宿主轨此前把 `@import` 一律剥掉、debugger 样式静默丢；本批让宿主也拿到同一份内联内容。
  无插件名时维持旧口径（剥掉、不内联），安全兜底不变。

---

## 2. ② 可执行测试与反证结果

### 2.1 新增/改写测试（4 文件 29 用例，全部可执行）

| 文件 | 用例 | 载体/入口 | 断言要点 |
|---|---|---|---|
| `frontend/src/lib/plugin-system/__tests__/extension-settings-preset-namespaces.test.ts` | 9 | 真实 `new PluginSandbox().executePluginCode` + **真实 `st-plugins/regex/engine.js` 函数源** | 对象型 4 键为 `{}`、`regex` 为 `[]`；已有数组同引用保留；脏值归一 + localStorage 备份；真实 `getScriptsByType(GLOBAL)` 返回数组且 `.forEach` 不抛；对象形状反证抛 `TypeError`；两份名单逐键逐类型一致 |
| `frontend/src/lib/plugin-system/__tests__/macro-system-register.test.ts` | 7 | 真实 `executePluginCode` + 生产 `substituteParamsExtended` | `macros.register/unregister/registerAlias/registry` 均在；四种注册路径的宏真的参与求值；`MacroCategory.PROMPTS === 'prompts'`；`cleanupPlugin` 撤回宏 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/css-import-inline-contract.test.ts` | 9 | **求值后产物 `COMPAT_V2_RUNTIME_ARTIFACT`** 切片执行 + 宿主 `sanitizePluginCss` | 真实 `style.css` 的 `@import "debugger.css"` 被内容替换；`url()`/带 media 两种写法；外链不改写；解析不到 → 剥离 + info 诊断；既有 `url()` 重写回归；宿主轨同样内联 |
| `frontend/src/lib/sillytavern/__tests__/bundled-plugin-css.generated.test.ts` | 4 | 真实导出 | 生成模块与 `st-plugins/regex/debugger.css` 逐字节相等；插件名/manifest 名/大小写查表；相对路径解析；helper 内联真实 style.css |

**既有守卫同步更新（不是放宽，是口径随契约改）**

- `runtime-body-template-literal-guard.test.ts:48`：白名单新增
  `${JSON.stringify(BUNDLED_ST_PLUGIN_CSS)}`，并写明来源是构建期表、不是运行时用户数据。
- `st-plugin-import-wrapper-collision.test.ts:230-232`：旧断言要求五个键在同一数组
  `'quickReply', …, 'regex'`；改成断言「对象四键」+「`ST_PLUGIN_PRESET_ARRAY_NAMESPACES_COMPAT = ['regex']`」，
  防止名单又退回混排。
- `palink-diag-silent-point-guards.test.ts` 的 part-01 静默 catch 基线未被抬高：本批新增代码里
  3 个初版 `try/catch` 已全部去掉（改用快照 + 直接 `reportDiagnostic`），计数仍是 11。

### 2.2 反证：先红 → 还原 → 再绿

| 项 | 临时改动 | 红的结果 | 还原后 |
|---|---|---|---|
| E2b-1 | `ensureStExtensionSettingsPresets` 数组分支临时改回 `target[key] = {}`（E2 原写法） | **3 failed / 6 passed**：`regex 必须是数组: expected false to be true`；脏值用例同；真实 engine 用例 `未设置 regex 时…` 红 | 9/9 绿 |
| E2b-2 | shim 里 `register` 临时改名为 `registerDisabled`（模拟旧空壳） | **5 failed / 2 passed**，沙箱日志原文 `TypeError: macros.register is not a function`（与真机同文） | 7/7 绿 |
| E2b-3 | `BUNDLED_ST_PLUGIN_CSS['regex/debugger.css']` 临时置空串（模拟构建期内容缺席） | **5 failed / 4 passed**：真实 style.css 不再含 `#regex_debugger_rules`；宿主内联用例同红 | 9/9 绿 |

还原后四文件复跑 **29/29 passed**。E2b-1 的红证明同时覆盖了「对象形状下真实 engine 的
`.forEach` 抛 `TypeError`」这条负向对照（该用例始终绿，用来证明真实函数确实会因为对象而炸）。

---

## 3. ③ 门禁

- `bash scripts/gate.sh frontend` → **rc=0**（输出末行「全部门禁通过」）
- `npx tsc --noEmit` → **rc=0，零输出**
- `npx vitest run` → **122 files passed / 1592 passed + 3 skipped / failed = 0 / errors = 0**
  （3 个 skip 是转换前既有 `it.skip`，本批未新增）
- 生产构建验证（**未**写 `frontend/dist`）：`npx vite build --outDir C:/Users/Pall/AppData/Local/Temp/palink-e2b-build`
  → **rc=0 / built in 36.32s**；产物 `palink-smart-card-runtime-*.js` 内含 `#regex_debugger_rules`，
  主 `index-*.js` 也含宿主内联所需内容 ⇒ 构建期字符串模块在配置期/浏览器产物两条链都能用。
- 文档目录：`py scripts/docs/gen_docs_catalog.py --check` → **`OK 418 docs, catalog up to date`（rc=0）**。
  本报告与 `_CATALOG.md` 同笔入库后，按仓库惯例再复生成一次 `_CATALOG.md`
  （报告的入库状态从「未入库」变「已跟踪」，tracked 414→415）。

---

## 4. ④ 预期上线后报错变化（主脑用同一份探针核对）

基线：`REPORT_批次E2_宿主沙箱两处照抄与debuggercss_2026-10-21.md` 文末实机复验
（`ERR_COUNT=219`、`CNT_OTHER=8`、`CNT_B10=14`、`DEBUGGER_CSS_NET_REQUESTS=14`）。

| 探针键 / 原文 | 基线 | 预期上线后 | 依据与风险 |
|---|---|---|---|
| `CNT_B10_debugger_css_mime`（`Refused to apply style … debugger.css`） | 14 | **→ 0** | 帧内 `<style>` 已内联 debugger.css，样式表里不再有 `@import`；连请求都不会发 |
| `DEBUGGER_CSS_NET_REQUESTS` | 14 | **→ 0** | 同上。比 E2 的「200 但请求 14 次」更彻底：本批不请求 |
| `SAMPLE_OTHER*`（`[PluginSandbox] 插件 Summarize 钩子 init 执行失败: TypeError: macros.register is not a function`） | SAMPLE_OTHER0/1（2 条） | **→ 0（按原文计）** | `macros.register` 已是真函数并接进 `MacroRegistry`。**风险**：Summarize init 越过这一跳后可能撞下一个未补的 shim，那会是**新的错误原文**，不是本条 |
| `SAMPLE_OTHER*`（`Unhandled promise rejection / PAGEERROR: getScriptsByType(...).forEach is not a function`） | SAMPLE_OTHER2/3/4（3 条，另有同因重复） | **→ 0** | 宿主 `extension_settings.regex` 现在是 `[]`；帧内同一份名单也已改 `[]`。`getScriptsByType(GLOBAL)` 返回数组，`loadRegexScripts` 的 `.forEach` 正常 |
| `CNT_B4_regex_preset`（`Could not find preset select element`） | 2 | 2 不变 | 与本批无关（插件 init 与设置面板挂载时序竞态） |
| `CNT_B7_style_removal` / `CNT_B8_musicjs` | 168 / 14 | 不变 | 卡脚本行为 / 外网资产，不在本批 |
| `CNT_B3_translate_init` / `CNT_B5_summarize_tdz` | 0 / 0 | **保持 0** | E2 已修，本批未碰装配链 |

**新增诊断不是错误**：本批只在「regex 脏值被归一」和「相对 `@import` 查不到」两条路径发
`severity: 'info'` 的 `st:diagnostic`；宿主 `handleSmartCardCompatDiagnostic` 只 `console.warn`、
不弹 toast，探针只统计 `console` 的 `type === 'error'`，不会进 `ERR_COUNT`。
当前实机配置里含 `@import` 的插件 CSS 只有 Regex 的 `style.css`（其余插件 0 条，已核对
`.tmp_probe/errtriage_plugins_config.json`），因此 `st_plugin_css_import_unresolved` 预期为 0。

---

## 5. ⑤ 没做的事与原因

1. **未重建 `frontend/dist`、未启停 Docker、未上线、未调付费 API** —— 任务书红线；实机计数由主脑跑。
2. **未改 `st-plugins/**`** —— 第三方插件原文；debugger.css 的坏引用在注入器侧解决。
3. **未再尝试「改 URL」** —— E2 的 `/api/plugins/<id>/asset/debugger.css` 已被实机否证（404 text/html），
   本批已把那两条 @import URL 重写正则删除。
4. **未修 B4（RegexPresetManager 找不到 select）** —— 不在本批三条内；改它需要动插件挂载时序。
5. **未给其它插件的相对 `@import` 建白名单** —— 当前实机配置里只有 Regex 一条；将来出现时会被
   剥离并发 `st_plugin_css_import_unresolved`，按诊断补进 `BUNDLED_ST_PLUGIN_CSS` 即可。
6. **未跑 `bash scripts/gate.sh backend`** —— 本批零后端改动；任务书只要求 frontend。
7. **未做浏览器实机验证** —— 只有主脑能上线；§4 是可对照的预测表，不是实测。

---

## 6. ⑥ 否证主脑：前提是否成立

**结论：三条缺陷前提全部成立，没有需要停下回报的否证。** 以下是两处必须写清的口径偏差：

1. **B10 的 14 条来自帧内，不是宿主 `sanitizePluginCss`**（范围澄清，不是否证）。
   任务书把修法位置写成「宿主把插件 CSS 写进 `<style>` 的那一处（sandbox.ts:223 / :5631）」，
   但 E2 报告与实机样本（`@LOC:about:srcdoc`）都指向帧内 `injectStPluginCssCompat`。
   宿主轨 `sanitizePluginCss` 早就把 `@import` 剥掉，**从未发过 debugger.css 请求**，所以它不是 14 条错误的来源。
   本批两处都做了内联：帧内修掉 14 条，宿主轨顺带让 debugger 面板样式不再静默丢失。
2. **`MacroCategory` 的问题比任务书写的更大一点**（顺带修，已记录）。
   旧 shim 不只是「macros 是空对象」：它的 `MacroCategory` 是编造枚举，缺少 stable-diffusion 实际使用的
   `PROMPTS`（`st-plugins/stable-diffusion/index.js:5979/5984` 会拿到 `undefined`）。本批换成
   `@/lib/macro-engine` 的真枚举，覆盖实际调用面。
3. **`st-plugins/summarize` 仍然不在仓内**（沿用 E2 的口径澄清）。
   真机报错的 Summarize 源码只存在于 DB 插件（探针配置 `ffb782eb-…`），仓内没有；
   本批测试用 memory / stable-diffusion 的真实调用形状覆盖 `macros.register` 契约。
4. **`?raw` 未实测**（实现选择澄清）。任务书允许「`?raw` 或生成模块方式」；本批选生成模块，
   原因是该模块进入 vite 配置期导入链，`?raw` 在 esbuild 配置加载阶段没有插件接手（架构推断）。
   生产构建已用生成模块实测通过（§3），没有把未验证的 `?raw` 路径留在仓里。

---

## 7. 提交

按任务书临时索引提交，逐项 pathspec，未使用 `git add -A`；共享树里其它 agent 的在途文件未被暂存。

- 代码 + 测试：`1c28e87`
  `fix(批次E2b): regex 预置改数组、macros/macro-system 接真注册表、debugger.css 构建期内联`
  （12 files changed, 853 insertions(+), 196 deletions(-)；含 1 个测试文件改名：
  `css-import-asset-rewrite-contract.test.ts` → `css-import-inline-contract.test.ts`）
- 文档笔：本报告 + `docs/_CATALOG.md`（418 docs），紧随 `1c28e87` 单独提交；
  报告入库后按仓库惯例再复生成 `_CATALOG.md`（tracked 414→415），单独一笔 `chore(docs)`。
- 门禁在提交前跑：`bash scripts/gate.sh frontend` rc=0、`failed=0 / errors=0`（见 §3）。
