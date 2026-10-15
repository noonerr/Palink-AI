# S4 拆单间文件 —— 完工报告

> 状态：已完工待主控合（**不 merge，留 `s4-split` 分支**）
> 日期：2026-10-15
> 工作目录：worktree `D:\项目\_palink-wt\s4-split`（分支 `s4-split`）
> 基线：`9b24724`（= `355e0ce` + 一笔纯文档提交，代码基线未变）
> 回退点：`9b24724`

## 1. 结论

G9 裁决的两个目标文件已按行机械拆分完成，**只拆不改语义**：

| 文件 | 拆前 | 拆后入口 | 新分段 | 最大单文件 |
|---|---|---|---|---|
| `smart-card-runtime/SillyTavernCompatRuntime.ts` | 7315 行 | **292 行** | `runtime-body/part-01..08.ts` | 913 行 |
| `frame-shim/legacy-st-sim.ts` | 2482 行 | **27 行** | `frame-shim/legacy-st-sim-parts/part-a\|b\|c.ts` | 835 行 |

全部新建/改动文件均 ≤ **913 行**，满足 G4「单文件 ≤1200 行」（按「本次改动文件」口径）。

**语义未变有两份独立字节证据**（不是"看代码觉得对"）：

| 证据 | 拆前 SHA-256 | 拆后 SHA-256 | 结果 |
|---|---|---|---|
| `buildSillyTavernCompatRuntimeV2Shim()` 产物（347513 字符） | `f710ed06…beb1eda` | 同 | ✅ 一致 |
| `buildSmartCardCompatRuntimeExternalScript()` 产物（346887 字符） | `1a15e682…f3af3e03d` | 同 | ✅ 一致 |
| 外部化路径（内联引导脚本 + `<script src>`，1230 字符） | `99629d0c…536652ac3` | 同 | ✅ 一致 |
| `CharacterCardRenderer.buildShim()` 产物（136590 字符 / 148408 字节） | `f5d7089b…da6395f2` | 同 | ✅ 一致 |

门禁：`npx tsc --noEmit` = **0**；`npx vitest run` = **77 文件 / 1000 passed / 0 failed / 3 skipped** —— 与基线逐项相同，**用例数未变**。
`st-plugin-import-wrapper-collision.test.ts`（16 用例守卫）= **16/16 绿**。

## 2. 拆分方式（为什么这样做）

两个文件的结构决定了只有一种不碰语义的拆法：**按行切模板字符串文本，再按原顺序拼接**。

- `SillyTavernCompatRuntime.ts` 原第 270-7312 行是**一个**巨型模板字符串（`buildSillyTavernCompatRuntimeBodyScript` 的返回值），内部是注入 iframe 的 JS 源码；只有 3 处宿主插值（第 271 行 `bootHeader`、653 行 `IDB_NS_RUNTIME_SOURCE`、2254 行 `VARIABLES_COMPAT_SOURCE`）。
- `legacy-st-sim.ts` **整文件**就是一个模板字符串常量 `LEGACY_ST_SIM_SEGMENT`（第 15-2481 行）。

切点全部落在行边界，且刻意避开 3 处插值所在行（插值都是单行表达式，不会跨切点）。切出的各段仍是模板字符串，**逐字节搬运**；段内跨段引用的标识符继续靠 IIFE 闭包共享（因此**不能单独求值某一段**，段头注释已写明）。

分段边界（原行号）：

- runtime：`270-1149 / 1150-2029 / 2030-2909 / 2910-3789 / 3790-4679 / 4680-5578 / 5579-6459 / 6460-7312`
- legacy：`15-836 / 837-1658 / 1659-2481`

边界是按"避免把测试关心的区域切碎"选的：`getCompatChatMessages`（原 4207）落在 part-05，`getCharWorldbookNamesCompat`（5557）落在 part-06，`>>> S1-G10 LOREBOOK FAMILY BEGIN/END`（5580/5738）整段落在 part-07，两处 `setCompatFunction('setVariable')`（6293/6499）分落 part-07/part-08。

入口文件保留 TS 头（类型、`detectSillyTavernRuntimeRequirements`、boot payload 白名单、`buildSillyTavernCompatRuntimeV2Shim` 等），只把 body 函数换成按序拼接；`legacy-st-sim.ts` 同理只留拼接壳。

### 2.1 10-14 修过的活逻辑：逐条确认原样保留

要求「原样保留、不许顺手简化」的 6 处，全部在搬运文本内、**零改动**（由字节同一性覆盖，且逐条复核了落点）：

| # | 活逻辑 | 落点 |
|---|---|---|
| 1 | import 变换：与 wrapper 参数同名的本地名改为**对参数赋值** | part-01（原 270-1149） |
| 2 | 入口脚本按 `moduleMode` 变换 + 执行后调 manifest `hooks.activate` | part-01/02 |
| 3 | export 列表用 `Object.defineProperty` 活绑定 getter（防 TDZ） | part-02 |
| 4 | `SlashCommand(Argument\|NamedArgument).fromProps` 三个静态桩 | part-03/04 |
| 5 | `applyStPluginRuntimeConfigCompat` 的 `disabledExtensions` 默认数组 + settings 子对象预建 | part-06 |
| 6 | `ensureStPluginMountPointsCompat`（iframe 内 11 个挂载容器离屏桩） | part-07 |

守卫测试 `st-plugin-import-wrapper-collision.test.ts` 16/16 绿，为这 6 条的接线仍生效提供了独立佐证。

## 3. 必须说明的一处"非纯机械"改动：测试的源码读取路径

⚠️ **这是本次唯一超出"纯文本搬运"的改动，请主控重点看这一节。**

有 5 个契约测试的做法是**读源文件文本**再切片断言（不是 import 模块求值）：

- `frame-getchatmessages-id-lookup.test.ts`
- `frame-security-and-migration-contract.test.ts`
- `getcharworldbooknames-contract.test.ts`
- `lorebook-family-contract.test.ts`
- `worldbook-boot-inline-contract.test.ts`

它们原先 `readFileSync('…/SillyTavernCompatRuntime.ts')`。拆分后目标片段搬到了 `runtime-body/part-0N.ts`，这些测试会直接拿不到内容（`marker not found` / 断言失败）。**这不是 bug，是拆分必然的连带影响。**

处理方式（保持"断言真实源码"的语义不变，不弱化任何断言）：

1. 新增 `__tests__/compat-v2-runtime-source.ts`，导出 `COMPAT_V2_RUNTIME_SOURCE`：按**拆分前原文顺序**（入口文件 + `part-01..08`）把源码文本拼回整段。
2. 5 个测试改为从该模块取 `COMPAT_V2_SOURCE`，**其余断言一字未改**。
3. 为什么用 `readFileSync` 而不是 import 各段常量：各段是模板字符串，import 拿到的是**求值后的产物**；这些测试要的是「源码文本」本身（含尚未求值的插值占位），与拆分前完全一致。

> 判定依据：这些测试原本就依赖"某段文本存在于某个文件里"，拆分改变了文件布局，就必须同步改读取路径；否则等于删掉了 5 组契约覆盖。**改动仅限读取路径，断言与用例数不变。**

另修一处非测试消费方：`scripts/st_frontend_acceptance.cjs` 扫 runtime 源码统计 ST 事件覆盖率，拆分后只读入口文件会**假性暴跌**。已改为入口 + `runtime-body/part-*.ts` 拼接后再扫（该脚本不在 vitest/npm 门禁内，属预防性修复）。

### 3.1 与 SOP §七（「测试要写行为断言，不是源码字符串断言」）的关系

这 5 个是**拆分前就存在的**源码文本契约测试，本次**没有新写**这类测试、也没有新增断言。
按 SOP §七 的适用面（针对**新写**的守卫测试），本次行为层面的守卫由另外两项承担，且都已实测：

- `st-plugin-import-wrapper-collision.test.ts`（16 用例）—— 调真实构建函数 `buildSillyTavernCompatRuntimeV2Shim()`，断言产物行为；
- 四份产物的 SHA-256 逐字节同一性（§1 表）—— 比任何断言都强的「行为未变」证据。

同时 §4 的反证表明：这 5 个源码文本测试**不是空转**，改坏对应片段确实会转红。

## 4. 反证（改坏 → 红；还原 → 绿）

为证明改过读取路径的 5 个测试**不是空转**，逐个人为注入破坏：

| 注入的破坏 | 期望 | 实测 |
|---|---|---|
| part-07 的 `>>> S1-G10 LOREBOOK FAMILY BEGIN` 改名 | `lorebook-family-contract` 红 | ✅ `rc=1`，26 failed |
| 入口文件 `worldbookName: context.worldbookName \|\| ''` 改名 | `worldbook-boot-inline-contract` 红 | ✅ `rc=1`，1 failed |
| part-06 的 `const getCharWorldbookNamesCompat = () => {` 改名 | `getcharworldbooknames-contract` 红 | ✅ `rc=1`，收集期即失败 |
| part-05 的 `const getCompatChatMessages = (messageId) => {` 改名 | `frame-getchatmessages-id-lookup` 红 | ✅ `rc=1`，收集期即失败 |
| part-06 的 `热合并进 chatVariableStore` 整串替换 | `frame-security-and-migration-contract` 红 | ✅ `rc=1`，1 failed |

5/5 全部打红。随后从备份原样还原，复跑：

- 三份 runtime 产物 SHA-256 与拆分前**逐字节一致**；
- `verify-shim-identity.mjs compare` → `✅ 完全一致`；
- 全量门禁回到 **77 / 1000 passed / 3 skipped**。

（顺带记一条方法论：第一次给 `frame-security` 的破坏是**追加**后缀，`toContain` 仍成立 ⇒ 测试不红。改坏证明必须让断言真的失去匹配对象，追加式破坏是假阴性。）

## 5. 文件清单

**新建（12 个）**

```
frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts .. part-08.ts
frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim-parts/part-a.ts, part-b.ts, part-c.ts
frontend/src/components/ui/custom/smart-card-runtime/__tests__/compat-v2-runtime-source.ts
```

**改动（8 个）**

```
M frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts        (7315 → 292 行)
M frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts        (2482 → 27 行)
M frontend/src/components/ui/custom/smart-card-runtime/__tests__/frame-getchatmessages-id-lookup.test.ts
M frontend/src/components/ui/custom/smart-card-runtime/__tests__/frame-security-and-migration-contract.test.ts
M frontend/src/components/ui/custom/smart-card-runtime/__tests__/getcharworldbooknames-contract.test.ts
M frontend/src/components/ui/custom/smart-card-runtime/__tests__/lorebook-family-contract.test.ts
M frontend/src/components/ui/custom/smart-card-runtime/__tests__/worldbook-boot-inline-contract.test.ts
M frontend/scripts/st_frontend_acceptance.cjs
```

## 6. 门禁与验收对照

| 验收项（HANDOFF §3.2） | 结果 |
|---|---|
| 1. 两个目标文件拆后各自 ≤1200 行 | ✅ 292 / 27；新分段最大 913 |
| 2. 门禁 1000 passed / 0 failed / 3 skipped + tsc 0，用例数不变 | ✅ 逐项相同 |
| 3. `verify-shim-identity.mjs` 通过 | ✅ `✅ 完全一致`（SHA `f5d7089b…`） |
| 4. `st-plugin-import-wrapper-collision.test.ts` 16 用例全绿 | ✅ 16/16 |
| 5. 完工不 merge，留 `s4-split` | ✅ 未 merge、未 push |

额外自证：runtime 三份产物的 SHA-256 与拆分前逐字节一致（§1 表）。

## 7. 风险、遗留与给主控的提示

1. **`docs/_CATALOG.md` 必须在主工作区重跑。** worktree 不 checkout 被 `.gitignore` 的文件，而 `gen_docs_catalog.py` 扫文件系统 ⇒ 本分支生成的目录天然比主工作区少 2 份、header 数字不同。**并入主干后必须重跑 `py scripts/docs/gen_docs_catalog.py` 再 `--check`**，不要沿用本分支带来的这一份。
2. **模板字符串雷区仍然存在，且现在有 11 个模板段。** 段内新增注释/代码出现裸反引号或 `${` 会提前终止模板 ⇒ TS1005，且报错常指向注释行。段头注释已写明约束；正则一律 `new RegExp()`。
3. **段不能单独求值。** 各段共享同一个 IIFE 闭包作用域（`getContext` / `parentDocumentStore` / `imageQueue*` 等跨段引用），单独 eval 某一段必然 ReferenceError。
4. **`frontend/dist` 未重建**。本次只改源码与测试，未跑前端构建；按项目约定 `dist` 是 nginx bind mount，构建姿势见 `AGENTS.md`（`VITE_OUT_DIR=dist_new` + 覆盖拷贝 + `gzip-dist.cjs`）。S4 无真机验收需求，故未做。
5. **G4 口径仍是"本次改动文件"。** 全 `frontend/src` 另有 14 个超限文件（`sandbox.ts` 5612 等），本次**未碰**。
6. **未拆 `utils/sillyTavernPluginRuntime.ts`**（G9 裁决，其大堂注入段占 71.42%，S5 删完自然达标）。
7. 后端未改动，后端门禁未跑（本次无后端变更）。
