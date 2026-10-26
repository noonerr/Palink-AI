# REPORT — 查验：worldbook 前端旧引擎「四件」删除清单复核

> 状态：已完工待审读（只读查验·2026-10-26）

---

## 背景

ASM-3 世界书引擎统一（提交 `9d14fdf`，2026-10-24）把插件面 `getWorldInfoPrompt` 改接后端同源扫描端点（`POST /api/character-sessions/{sid}/worldbook-scan`），前端 `lib/worldbook` 自算引擎「从插件可见路径断开但文件未删」（提交信息自述：「遗留：前端 lib/worldbook 引擎文件未删（只断开插件可见路径，删否另批）」）。待办记录于 `docs/_active/HANDOFF_主脑交接_ST三面一致工程_2026-10-25.md:66`：「**前端 worldbook 引擎文件删除评估**（ASM-3 只断开未删）」。

本次是删除前的最后一道只读复核，结论将直接支撑删码决策。任务给定的评估前提：「四件+测试零活引用可删（唯一调用链挂在死函数上）；manager 面有活消费者必须留」。

## 方法

全部结论基于本会话实际执行的命令与读到的文件；只读，未改任何代码/数据/容器。

1. 文档口径定位：`grep -rl "ASM-3" docs/_active/`（命中 4 件）；`git show 9d14fdf --stat`；读 SPEC/交接书/主脑记忆流水的 worldbook 相关段。
2. 符号级引用复核：对 `frontend/src/lib/worldbook/` 全部 7 个文件的 24 个导出符号与 6 种路径引用形式，在 `frontend/src`、`backend/app`、`scripts`、`frontend/scripts`、`st-plugins` 五个范围逐一 `grep -rn`，`__tests__` 单独归类。
3. 死函数判定：对候选函数名全仓 grep 调用方，并读函数体上下文确认。
4. 快照有效性：`git status --short -- frontend/src/lib/worldbook/` 输出为空，四件未被并行施工改动（最后触及提交 `2ed4362` 减重 L1）；本报告行号以当前工作区为准。

## 发现

### 1. 「四件」是哪四个（⚠ 名单为推断，文档无逐件列名 —— 待主脑裁定）

`frontend/src/lib/worldbook/` 共 7 个 ts 文件（实测 `wc -l`，合计 1376 行）：

| 文件 | 行数 | 性质 |
|---|---|---|
| scanner.ts | 341 | **四件之一（推断）** |
| budget.ts | 225 | **四件之一（推断）** |
| recursive.ts | 96 | **四件之一（推断）** |
| timed-effects.ts | 132 | **四件之一（推断）** |
| manager.ts | 320 | 管理器（任务明示「必须留」） |
| types.ts | 240 | 类型定义（SPEC 明示「保留」） |
| index.ts | 22 | barrel（re-export 全部，删除作业需连带改） |
| __tests__/scanner-logic-contract.test.ts | 137 | 唯一测试（8 个 it） |

**推断依据**（三条证据互洽，但 docs 中找不到「四件」的逐件列名原文）：
- `docs/_active/spec/SPEC_ST三面一致对齐施工计划_2026-10-24.md:67`：「前端 `lib/worldbook` 计算引擎退役（**类型定义保留**）」——把 types.ts 排除在外，剩计算引擎文件。
- `docs/_active/report/REPORT_重复造轮子审计_2026-10-23.md:52`：把前端第二套引擎分件为「**扫描** 348 + **递归** 96 + **预算** 209 + **计时效果** 132 + **管理器** 320」——四件计算件 + manager 分立。
- 任务给定约束「manager 面有活消费者必须留」→ manager.ts 排除。
- 注意：docs 里另有两组「四件」均与本案无关，勿混淆——P2-24「内容层四件」（体检报告，指校准去重/时间槽/记忆保洁/@activate，HANDOFF:59-63）；VER1b「四件套核验」（指 character/session/branch/branch_msgs，REPORT_VER1b:27）。

### 2. 「唯一调用链挂在死函数上」——核实**成立**（行为层），且死函数有两个，不是一个

**主死函数：`buildWorldBookContextForChat`**（`frontend/src/hooks/useCharacterChat.ts:150-172`）
- 函数体内 `:167` 调用 `stWorldBookManagerSingleton.scanAndBuildContext(...)`——这是 `scanAndBuildContext` 在全仓的**唯一调用点**（grep `scanAndBuildContext` 全部命中：useCharacterChat.ts:167、runtime.ts:861 注释、getContext.ts:2476 注释、ASM-3 测试注释 :7、manager.ts:120 定义、backend/app/api/worldbook.py:946 注释；无一为活调用）。
- `buildWorldBookContextForChat` 本身**全仓零调用**（grep 命中仅定义 :150 与 :1340 注释）；:1337-1340 注释自认：「不再在前端拼接世界书上下文——palink-native 后端 _append_worldbook_context 已是唯一权威注入点……buildWorldBookContextForChat() 函数定义保留（供 UI 预览/调试），此处不调用。」

**次死函数：`loadCharacterWorldBooks`**（`frontend/src/lib/sillytavern/getContext.ts:1324-1373`，export 函数）
- 内部 `:1334` 调用 `stWorldBookManager.reset()`，而 `manager.ts:295-298` 的 `reset()` 调 `this.recursiveScanner.reset()` 与 `this.timedEffects.reset()`——即 recursive/timed-effects 的这条外部链也挂在死函数上。
- `loadCharacterWorldBooks` 全仓 grep 仅命中定义与自身 warn 行（:1360/:1370），**零调用方**。

**getWorldInfoPrompt 旧引擎路径已被 ASM-3 断开**：`git show 9d14fdf` diff 显示旧实现里的 `stWorldBookManager.scanAndBuildContext(...)` / `getActiveEntries()` 调用整段删除，新实现只调后端端点且失败时「故意不回退前端引擎」（现 getContext.ts:2476-2479 注释）。

### 3. 「零活引用可删」——**行为层成立，文件层不成立**：四件被 manager.ts 活文件 import 并无条件实例化，直接删四个文件必打红 tsc

四件各自的全仓引用矩阵（`grep -rn`，frontend/src + backend/app + scripts + frontend/scripts；st-plugins 另查零命中）：

| 文件 | 引用位置（路径:行） | 引用性质 | 测试引用 |
|---|---|---|---|
| scanner.ts | manager.ts:15,42,61（import+字段+构造实例化）；manager.ts:154,269,278（方法调用，均在 scanAndBuildContext/previewScan/updateConfig 内）；recursive.ts:7,18（四件内互引）；index.ts:5（barrel re-export） | 全部位于 manager.ts 活文件与四件互引 | scanner-logic-contract.test.ts:19,67（`new WorldBookScanner()`，8 个 it） |
| budget.ts | manager.ts:17,44,63（import+字段+构造实例化）；manager.ts:166,265,281（方法调用，同上三方法内）；scanner.ts:13,318（四件内互引，`estimateEntriesTokens`）；index.ts:7 | 同上 | 0 |
| recursive.ts | manager.ts:16,43,62（import+字段+构造实例化）；manager.ts:152,262,296（方法调用，scanAndBuildContext/previewScan/reset 内）；index.ts:6 | 同上 | 0 |
| timed-effects.ts | manager.ts:18,45,64（import+字段+构造实例化）；manager.ts:138,145,161,297,304,311（方法调用，scanAndBuildContext/reset/exportTimedEffectsState/importTimedEffectsState 内）；index.ts:8 | 同上 | 0 |

关键事实：
- `manager.ts` 构造函数（:59-65）**无条件**实例化四件；manager.ts 本身是活文件（见第 4 条）⇒ 四件的类/工厂符号（`WorldBookScanner`/`createScanner`/`RecursiveScanner`/`createRecursiveScanner`/`BudgetManager`/`createBudgetManager`/`TimedEffectsManager`/`createTimedEffectsManager` 全部八个）在**编译层是活引用**。`import type` 除外——manager 对四件是**值 import**。
- 四件内部互引成环链：recursive→scanner（recursive.ts:7）、scanner→budget（scanner.ts:13）。
- `index.ts:5-8` barrel re-export 四件（消费方 runtime.ts:7 / getContext.ts:32 只取 manager 符号，但删四件后 barrel 的 re-export 行必须同步删）。
- manager 方法触碰四件实例的分布：`scanAndBuildContext`（:137-166，唯一外部链在死函数①）、`previewScan`（:256-270，全仓零调用）、`updateConfig`（:275-283，manager 版全仓零调用——grep 命中均为 ImageGenerationTab 的 api.* 同名方法）、`reset`（:295-298，唯一外部调用点 getContext.ts:1334 在死函数②内）、`exportTimedEffectsState`/`importTimedEffectsState`（:303-312，全仓零调用）。
- 纯数据面方法（不碰四件）：`loadWorldBook`/`unloadWorldBook`/`setActiveWorldBooks`/`getWorldBooks`/`getWorldBook`/`getActiveEntries`/`resetCache`/`getConfig`。
- backend/scripts/frontend-scripts 零引用：`backend/app/api/worldbook.py:946,956` 与 `backend/app/services/worldbook_service.py:201` 的 `TimedEffectsManager` 是**后端自有同名类**（worldbook_service.py:201 定义）与注释，非前端引用；frontend/scripts 零命中；st-plugins 零命中。
- 排除项：`frontend/src/lib/slash-engine/commands.ts:401` 的 `context.getWorldBook()` 是 slash-engine 自有 `CommandContext` 可选字段（:370 定义），不 import lib/worldbook，与本链无关。

### 4. 「manager 面有活消费者必须留」——核实**成立**

- `runtime.ts:1043`：`export const stWorldBookManagerSingleton: WorldBookManager = createWorldBookManager()`（经 `runtime.ts:7` 从 barrel import）。
- `getContext.ts` 插件面活方法调用 manager 纯数据面方法：`loadWorldInfo`（:2443-2445 → `_loadWorldBookByName` :1288-1311 内 :1296 `loadWorldBook`、:1305 `setActiveWorldBooks`）；`getWorldInfoNames`（:3128-3135 内 :3131 `getWorldBooks`）。这两者是 ST st-context 契约面方法（ST 插件可调），ASM-3 后仍是活的。
- ASM-3 新测试 `__tests__/getcontext-worldinfo-backend-source.test.ts:187,213` 以 `stWorldBookManagerSingleton.loadWorldBook/setActiveWorldBooks` 作 decoy（反证插件侧不再吃前端引擎）。
- `getContext.ts:1221` 另导出别名 `stWorldBookManager`、`runtime.ts:570` 有 `getWorldBookManager()` getter——两者当前全仓零外部调用方（前者仅文件内使用，后者仅定义+注释），留 manager 不受影响。
- 结论：manager.ts 必须留 ✓；且留 manager 就**必须处理它对四件的 8 个符号 import**，这是删除作业的核心手术面。

## 最终删除清单

| 文件路径 | 活引用数（编译层） | 测试引用数 | 风险评级 | 删或不删 |
|---|---|---|---|---|
| frontend/src/lib/worldbook/scanner.ts | 3 处活文件（manager.ts、recursive.ts、index.ts） | 1 文件（scanner-logic-contract.test.ts，8 it） | **中** | **不可单删**——manager.ts:15,42,61 值引用；须与 manager.ts 手术同批删 |
| frontend/src/lib/worldbook/budget.ts | 3 处活文件（manager.ts、scanner.ts、index.ts） | 0 | **中** | **不可单删**——manager.ts:17,44,63 值引用；须与 manager.ts 手术同批删 |
| frontend/src/lib/worldbook/recursive.ts | 2 处活文件（manager.ts、index.ts） | 0 | **中** | **不可单删**——manager.ts:16,43,62 值引用；须与 manager.ts 手术同批删 |
| frontend/src/lib/worldbook/timed-effects.ts | 2 处活文件（manager.ts、index.ts） | 0 | **中** | **不可单删**——manager.ts:18,45,64 值引用；须与 manager.ts 手术同批删 |
| frontend/src/lib/worldbook/__tests__/scanner-logic-contract.test.ts | —（测试） | 自身 | 低 | **可删**（随四件同批，测的唯一对象是 scanner.ts） |
| frontend/src/lib/worldbook/manager.ts | 多处活消费者（runtime.ts:1043；getContext.ts:1296,1305,3131 插件面；ASM-3 测试） | 1（decoy 用例） | — | **必须留**（任务约束 + 本次核实成立）；但需**同批手术**：剥离 :15-18 import、:42-45 字段、:61-64 实例化、:137-166/:256-270/:275-283/:295-298/:303-312 引擎方法体，保留数据面方法 |
| frontend/src/lib/worldbook/index.ts | runtime.ts:7、getContext.ts:32 | 0 | 低 | **留**，同批删 :5-8 四行 re-export |
| frontend/src/lib/worldbook/types.ts | useCharacterChat.ts:33、getContext.ts:33 等多处 type import | 1 | — | **留**（SPEC:67 明示类型定义保留） |

**对评估前提的裁定口径**：
- 「唯一调用链挂在死函数上」——**成立**（行为层）。且死函数有两个：`buildWorldBookContextForChat`（useCharacterChat.ts:150，主链）与 `loadCharacterWorldBooks`（getContext.ts:1324，reset 链）。⚠ 任务背景只提了一个，特此补充。
- 「零活引用可删」——**行为层成立、文件层不成立**。四件作为文件有 manager.ts 的值 import + barrel re-export + 四件互引，**直接删四个文件会打红 tsc**；「可删」成立的完整表述是：**删四件 + 删 scanner-logic-contract.test.ts + 手术 manager.ts（剥离引擎成员，保留数据面）+ 改 index.ts barrel**，四者必须同批，共约 794 行引擎 + 137 行测试 + manager.ts 约 100 行引擎成员。

## 结论与建议

1. **「四件」名单按推断执行**：scanner/budget/recursive/timed-effects（依据 SPEC:67 + 重复造轮子审计:52 + manager 约束）。文档无逐件列名原文，**此名单本身标「待主脑裁定」**。
2. **删除可行，但不是纯文件删除**：必须同批附带 manager.ts 手术与 index.ts/test 联动，建议按上表「同批删除包」整包施工；manager.ts 数据面方法（loadWorldBook/setActiveWorldBooks/getWorldBooks/unloadWorldBook/getWorldBook/getActiveEntries/resetCache）有插件面活消费者，**绝不可连带删**。
3. **两个死函数的处置待拍板**：`buildWorldBookContextForChat`（useCharacterChat.ts:150-172，含其 ScanContext import :33）与 `loadCharacterWorldBooks`（getContext.ts:1324-1373）随四件删除后永久不可达，可否随批删除**待主脑裁定**（后者是 export 函数，历史上曾被设计为「NativeRoleplayChat 挂载时调用」，其注释口径已过时）。
4. manager.ts 手术时顺带可议（非本批范围）：`previewScan`/`updateConfig`/`exportTimedEffectsState`/`importTimedEffectsState`/`resetCache`/`getConfig` 六个方法当前全仓零调用。
5. 验证口径建议（施工时用，本次未跑）：删后 `cd frontend && npx tsc --noEmit` + `npx vitest run` 只认 `failed = 0`；ASM-3 测试 getcontext-worldinfo-backend-source.test.ts 必须保持绿（它是「插件视图=唯一真相源」的守卫）。
6. 流程提醒：本报告落在 `docs/_active/report/`，按 AGENTS.md 文档目录规矩，**入库提交前需跑 `py scripts/docs/gen_docs_catalog.py`**（本查验为只读纪律，未代跑——刷目录会改 `_CATALOG.md`，超出「除报告文件外禁改」边界，留给主脑执行）。

## 证据命令清单（本会话实跑）

- `grep -rl "ASM-3" docs/_active/` → 4 文件命中
- `git show 9d14fdf --stat` → 4 files changed（无删除）；`git show 9d14fdf -- frontend/src/lib/sillytavern/getContext.ts` → 旧 scanAndBuildContext 路径整段删除
- `grep -n "^export" frontend/src/lib/worldbook/*.ts` → 24 个导出符号
- `grep -rn "WorldBookScanner\|createScanner\|parseDecorators\|BudgetManager\|estimateEntryTokens\|estimateEntriesTokens\|RecursiveScanner\|TimedEffectsManager" frontend/src backend/app scripts frontend/scripts` → 见发现 3 矩阵
- `grep -rn "stWorldBookManagerSingleton\|createWorldBookManager\|scanAndBuildContext\|getActiveEntries\|loadCharacterWorldBooks\|buildWorldBookContextForChat\|getWorldBookManager\|_loadWorldBookByName" frontend/src backend/app scripts frontend/scripts` → 见发现 2/4
- `git status --short -- frontend/src/lib/worldbook/` → 空（快照干净，未被并行施工改动）
