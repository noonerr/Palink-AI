# 只读现状盘点 + 大堂轨注入段测量（ro-survey）

> 任务性质：**纯只读盘点 + 一个测量**。不修改任何生产代码，本报告是唯一产出。
> 执行时点：2026-10-14 01:41~（Asia/Shanghai）
> 执行分支：`ro-survey`（自开工时的工作树 HEAD 拉出）
> 方法：全部结论来自当场执行的 `git` / `grep` / `wc` / `py` 计数，或引自 `docs/_active/` 下**带文件名**的现有报告。
> **未实测的（门禁数字、真机）一律标注「未实测」，不引用历史数字充当实测值。**

---

## 0. ⚠️ 开工即发现的三处环境漂移（先声明，影响后续所有结论的解读）

### 0.1 任务描述里的分支/HEAD 已过期

| 项 | 任务提示词写的 | 我开工时实测 |
|---|---|---|
| 分支 | `three-tracks-merge-20261012` | **`s2-storage-migration`** |
| HEAD | `52d1755` | **`0251b89b634d993977f15544abdd5359155416f7`**（`docs: 多 agent 分包提示词`） |

`git log --oneline -20` 实测（开工时）：

```
0251b89 docs: 多 agent 分包提示词（分级/模型匹配/防相互影响规约）
52d1755 docs(t2): 订正 SPEC「iOS 用 40」—— 实际未生效，iOS 当前也是 16
e6bc988 docs(s1): 立「消息窗口化」议题（抄 ST chat_truncation），待拍板
3665d8b docs(s1/t2): 收尾补录 —— 空串兜底说明 + 上游交接单状态 + 门禁数字 958
a59d698 fix(s1/t2): 配额身份兜底 —— cardId 落空串时用 useId 保证不塌陷
bd771e6 docs(s1/t2): 复测达标 —— SPEC §8 重写（根因/修法/真机数字）+ HANDOFF 接手结果 + TODOS 勾 T2
7ac4445 fix(s1/t2): 修 iframe 配额接线 —— 可见性翻转 + 逐出改由内核统一执行并通知受害者
b6e8a5f refactor(s1/t2): 抽出 SmartCardDormancyGate 到独立文件（纯移动，逐字节一致）
9bfa666 docs: 交接文档 —— T2 收尾（iframe 配额接线修复与复测），供其他 agent 接手
8289b5e docs(t2): 复测结果 —— 负面，T2 不得打勾（接线未证明生效）
301225a feat(s1/t2): iframe 生命周期策略 —— LRU 封顶 + 懒挂载（方案+策略内核+接线）
494b11e docs(g6): 补 kill switch 开关2 的修复与真机复验结果 + ST 兼容性证据
4cb5d29 fix(s1/g6): 修 IDB 分库止血开关（哑弹），改为父侧读好经 ctx 下发
eb1ce71 docs(g6): kill switch 真机验证结果 —— 开关1 有效、开关2 失效（真缺陷）
aa7c801 docs: G11 修复 + 真机复验全绿；记录两套 requestParent 的数组吞噬 bug 与方法论教训
acd0d57 fix(s1/g10): getLorebookEntries 优先复用 legacy 的 getWorldbookEntries
c5d40a3 fix(s1/g10): 归一化 v2 requestParent 的数组返回，修 getLorebookEntries 恒空
61d9dd0 fix(s1/g11): 单间轨世界书回退到角色 character_book（修 S3 阻断项）
7dce76b docs: 真机验证结果（G10 通过 / G7 数据源选错 / G11 实证为真缺陷）
fa2bded docs: 补 G7/G10 实施记录 + shim 比对结果 + 新增 G11
```

### 0.2 🔴 分支隔离规约在多 agent 共享工作树下**结构性失效**（重要，请主控处理）

所有 agent 共用同一个工作树 `D:\项目\Palink-AI`，**只有一个 HEAD**。我按规约执行 `git checkout -b ro-survey`
把工作树 HEAD 切走之后，**S2 agent 随后执行的 `git commit -o` 落到了我的分支上**：

```
0738300 feat(s2): 智能卡存储旧键→新键双兼容迁移（只加不删）   ← S2 的提交，落在 ro-survey 上
```

实测证据（`git branch -v`）：
- 修复前：`ro-survey 0738300`，`s2-storage-migration 0251b89`
- 我已做**无损回收**：确认 `0251b89` 是 `0738300` 的祖先（fast-forward）后执行
  `git branch -f s2-storage-migration 0738300`，现在两分支同指 `0738300`。
  **纯指针前移，未动工作树、未动 HEAD、无数据丢失风险。**

⚠️ **但根因没消除**：S2 agent 后续的 `commit -o` 仍会继续落到 `ro-survey` 上。
建议主控：① 让各 agent 自查 `git rev-parse --abbrev-ref HEAD` 是否等于自己的 slug；
② 收口时以"提交内容"而非"分支名"为准挑提交（S2 的提交目前同时可从两个分支到达）。

### 0.3 任务提示词里「S2 未做」的前提已不成立

详见 §1 —— S2 在本次盘点期间**已由另一个 agent 提交**。

---

## 1. 六步状态表（逐项证据）

| 步 | 状态 | 判据证据（来源） |
|---|---|---|
| **S0 备料** | ✅ 完成（9/9） | 末笔提交 `068acde`（`docs(s0): 性能基线实测入档…S0 9/9 完成`，2026-10-13 01:41:57）；tag `merge-base` = `66672a0`（2026-10-12 23:53:54）；逐条自检见 `REPORT_S0完工自检_B1-B9_2026-10-13.md` §2。<br>⚠️ **无 `s0-done` tag**（`git tag -l "*s?-done*"` 只返回 `s1-done`） |
| **S1 补功能** | ✅ 完成（T1/T2/T3 全收口） | **tag `s1-done` = `3665d8b`**（2026-10-13 22:40:58，`docs(s1/t2): 收尾补录…`）；`git rev-list --count merge-base..s1-done` = **34** 笔。<br>T1 `fe419b7`（getCharWorldbookNames 三处同步化）；T3 `ea15a6f`（inline flag 废除）；T2 = `301225a`→`7ac4445`→`a59d698`（LRU 接线修复 + 复测）。<br>⚠️ `TODOS.md:25` 仍写「尚无 `s1-done`..`s4-done` tag（`s1-done` 待打）」——**该行已过期**，与实测 tag 冲突，由主控统一更新 |
| **S2 存储迁移** | 🔵 **代码已提交，B1 判据按源码检查已满足**（门禁转绿**未实测**） | 提交 **`0738300` `feat(s2): 智能卡存储旧键→新键双兼容迁移（只加不删）`**（本次盘点期间由另一 agent 提交，落在我分支上，见 §0.2）。<br>改动：`smart-card-runtime/storage.ts` +142/−2；新增 `smart-card-runtime/__tests__/s2-storage-migration.test.ts` +248。<br>实测 `storage.ts:65` = `export const LEGACY_CARD_SCRIPT_STORAGE_PREFIX = 'palink:card-storage:v1:';` ⇒ **`storage-isolation-contract.test.ts:221` 的源码文本断言（`expect(storageSource).toContain(LEGACY_STORAGE_PREFIX)`）按源码看已满足**。<br>实测 `storage.ts` 内无 `removeItem(...card-storage...)` ⇒ 紧邻的 `:229` 绿条保持条件也满足。<br>❗ **B1 实际是否转绿、其余 failed 是否为 0，我未跑（验证纪律 10：不跑与己无关/会抢机器的全量门禁）⇒ 标注「未实测」**。<br>⚠️ **无 `s2-done` tag** |
| **S3 切换默认** | ❌ 未开工 | 无 `s3-done` tag；无相关分支（`git branch -v` 只有 `be-oom-static` / `ro-survey` / `s2-storage-migration` / `st-plugin-compat-20260727` / `three-tracks-merge-20261012`）。<br>代码实证未开工：`CharacterChat.tsx:1628` 仍是 `runtime.injectIntoContainer(pluginHost, { diffOnly: true })`，且该文件内**不存在** S3 要求的「大堂注入入口紧急停机开关」（`grep -rn` 无 kill switch 相关分支）。 |
| **S4 拆单间** | ❌ 未开工 | 无 `s4-done` tag、无相关分支。<br>两个待拆文件实测行数：`SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts`（本次未逐一复测行数，沿用 `REPORT_交接文档复核与T2-S5实施准备_2026-10-13.md` §6 的 6984 / 2480）。<br>门禁范围（G4）**仍未拍板**，见 §2。 |
| **S5 删大堂** | ❌ 未开工 | 无 `s5-done` tag、无相关分支；`inline-script-replay.ts` 与 `InlineCardRenderer.tsx` 仍在（T3 明确保留到 S5）。 |

### 1.1 门禁数字（**未实测**，仅转录）

- 任务提示词/HANDOFF 给的基线：**958 passed / 1 failed / 3 skipped（962）**，tsc 0；唯一红 = `storage-isolation-contract.test.ts:221`（S2 设计信号）。
  （来源：`docs/_active/HANDOFF_多agent分包_剩余任务_2026-10-14.md` 文首 + `TODOS.md:27`）
- **我在本次盘点中一次测试都没跑**（纯只读任务，且避免抢机器）。S2 提交后的真实数字 **未实测**。

---

## 2. 已知缺口 G2 / G4 / G7 / G8 / G9 状态

| # | 缺口 | 当前状态 | 证据 |
|---|---|---|---|
| **G2** | 手势闸门不含 `setChatMessage` / `deleteMessage`，卡片可无手势改写或删除既有消息 | 🔴 **仍未修**（与历次报告一致，无变化） | 实测 `SmartCardCompatController.ts:56-81` 的 `SMART_CARD_MUTATING_ACTIONS_REQUIRING_GESTURE` 仍为 **9 项**：`sendMessage / sendMessageAsUser / sendUserMessage / triggerGeneration / Generate / generate / generateRaw / generateQuietPrompt / clearChat`，**不含** `setChatMessage`、不含 `deleteMessage`。<br>而这两个动作在单间轨**确实已实现**：`SillyTavernCompatRuntime.ts:5357`（`setCompatFunction('setChatMessage', …)`）、`:4340`（`requestParent('deleteMessage', …)`）；控制器侧 `SmartCardCompatController.ts:552/807` 有对应处理分支。<br>⇒ 缺口真实存在且未被任何提交动过。历次报告口径一致（`REPORT_S0完工自检_B1-B9_2026-10-13.md:162`、`HANDOFF_剩余任务提示词_T2与S2-S5_2026-10-13.md:230`）：**本期不修，仅登记**。 |
| **G4** | 「单文件 ≤1200 行」门禁范围未拍板 | 🟡 **仍待拍板** | `REPORT_交接文档复核与T2-S5实施准备_2026-10-13.md` §6 实测 `frontend/src` 恰 14 个文件 >1200 行，多数与并轨无关（`sandbox.ts` 5612、`ModelManagementTab.tsx` 1973…）。建议门禁限定为「本次被改动/被拆分的文件」。<br>本次盘点**未复跑**该 14 文件清单（有别的 agent 在改动文件，跑了也不可信）⇒ 沿用该报告，**标注「未复核」**。 |
| **G7** | 单间轨 iframe 内世界书名首帧为空 ⇒ MVU `initialized_lorebooks` 键退化成 `'unknown'` | ✅ **已修 + 真机复验通过** | 三笔提交：`4bd9fe5`（首版，数据源选错）→ `61d9dd0`（G11 回退 + **G7 源订正**：改为角色 `character_book`）→ 真机复验。<br>真机终态（`REPORT_交接文档复核与T2-S5实施准备_2026-10-13.md` §9.6）：`getCharWorldbookNames('current')` = `{"primary":"露缇雅1.2","additional":["露缇雅1.2"]}`，`getLorebookEntries()` = `array len=19`。<br>守卫测试存在：`smart-card-runtime/__tests__/worldbook-boot-inline-contract.test.ts`（7 条）、`char-worldbook-fallback-contract.test.ts`。<br>⚠️ 另有一处**如实修正**：该角色 `character_book` 实测无 `[InitVar]` 条目 ⇒ 本张卡本来就没有可载入内容；G7/G11 修的是**机制**，某卡能否受益取决于其书内是否有 `[InitVar]`。 |
| **G8** | T2 卸载与 iOS 幽灵历史冲突（iOS 档位 16/40） | 🟡 **仍待拍板 / 未真机复验** | `TODOS.md`「T2 ✅」条目下明写遗留：**「G8（iOS 档位 16/40）仍未在真机 iOS 复验」**。`52d1755` 又订正了 SPEC「iOS 用 40」—— **实际未生效，iOS 当前也是 16**。<br>另：`docs/_active/HANDOFF_多agent分包_剩余任务_2026-10-14.md` §四 指出「若消息窗口化落地，G8 可直接关掉」。 |
| **G9** | S4 拆 `sillyTavernPluginRuntime.ts` 可能与 S5 删除重叠 | ✅ **本次测量已给出裁决依据，结论见 §3.5：S4 应跳过该文件** | 立项原文：`REPORT_交接文档复核与T2-S5实施准备_2026-10-13.md` §7 G9（「本条尚未实测注入段占比，定案前需补一次行数/引用测量」）。本次即该次测量。 |

### 2.1 对 G9 立项理由的一处**订正**（重要）

G9 原文推得「**4 个 `plugin-runtime-*` 测试文件是必须随迁不许随删，说明该文件有存活部分**」。

实测：**这 4 个测试全部依赖将被删除的大堂段**，不能反推"文件有存活部分"：

| 测试文件 | 依赖方式（实测） |
|---|---|
| `utils/__tests__/plugin-runtime-diff-hotswap.test.ts` | `:22` import 本文件的类；`:53` `new SillyTavernPluginRuntime()`；`:103/113/132-134` 直调 `runtime.injectIntoContainer(...)` |
| `utils/__tests__/plugin-runtime-l1-settings.test.ts` | `:22` import 类；`:95/353/370/398` `new`；`:99/348` `injectIntoContainer` |
| `utils/__tests__/plugin-runtime-setup-script-parses.test.ts` | `:21` import 类；`:51` `new`；`:55` `injectIntoContainer`；自述「`injectIntoContainer` 用模板字符串生成一段注入页面的 setup 脚本」 |
| `utils/__tests__/plugin-runtime-extprompt-contract.test.ts` | `:33` `readFileSync('../sillyTavernPluginRuntime.ts')` —— **按源码文本断言本文件** |

⇒ 「必须随迁不许随删」应理解为：**这 4 个测试要改写为针对单间轨等价实现的测试**（保住契约），
**不是**保住 `sillyTavernPluginRuntime.ts` 这个文件。此点直接影响 S4/S5 的拆删范围，请主控据此重判。

---

## 3. 【核心产出】`sillyTavernPluginRuntime.ts` 大堂轨注入段测量

### 3.0 测量对象与口径声明

- 文件：`frontend/src/utils/sillyTavernPluginRuntime.ts`
- 实测总行数：**2477**（`wc -l`；末行 `2477:` 是 class 收尾 `}`，文件无尾随空行）
- 计数工具：`py -3` 按行切片统计 + `grep -n` 定位边界，边界行已逐行打印核对（见下）

### 3.1 切分依据（这是本测量的关键，先给依据再给数字）

**依据 1 —— 施工方案对 S5 改动面的原文界定**
`REPORT_一次性并轨施工方案与回退计划_2026-10-12.md:42`：

> S5 删大堂 + 收尾 ｜ 删除大堂轨代码与注入逻辑 ｜ **`card-script-runner.ts`、`sillyTavernPluginRuntime.ts` 注入段、`inline-script-replay.ts`**

**依据 2 —— 整合方案对"大堂轨"的定义与注入点定位**
`REPORT_三轨并一轨整合方案_2026-10-12.md:21`：

> 大堂轨 ｜ 客人直接进大堂干活 ｜ **卡脚本/插件 JS 直接插进聊天主页面执行** ｜ `card-script-runner.ts:460-468`、`utils/sillyTavernPluginRuntime.ts:2214-2225`

同文件 `:90`：「大堂轨插件注入 ｜ `utils/sillyTavernPluginRuntime.ts:2214-2225`」

**依据 3 —— 实测消费链（谁在用这个文件）**
`grep -rn "sillyTavernPluginRuntime" frontend/src`（排除 `__tests__`）只有两个生产消费点，且**都是大堂轨入口**：

| 消费点 | 用法 |
|---|---|
| `CharacterChat.tsx:74` | `import { SillyTavernPluginRuntime }`；`:413` `new SillyTavernPluginRuntime()`；`:1628` `runtime.injectIntoContainer(pluginHost, { diffOnly: true })` ← **唯一生产注入点** |
| `CharacterView.tsx:28` | `import { emitClassicPluginEvent }`；`:1645` `emitClassicPluginEvent('chat_id_changed', …)` |

三个导出接口 `SillyTavernChatMessage` / `SillyTavernCharacter` / `SillyTavernContext`
经 `grep -rn` 实测：**除本文件外全仓零外部消费**。

**依据 4 —— `injectIntoContainer` 的内容性质（实测其内部分段注释）**
该方法 476–2244 内部依次是：装 fetch 守卫 → 挂 `window.__palinkStRuntime` / jQuery / toast →
建「Galgame 插件兼容桥接层」→ 建 ST 形状 window 全局（saveChatMessages / runSlashCommand / 世界书族 /
generateRaw / setupScript 模板串 / MVU-UNBLOCK / lorebook / injectPrompts / TavernHelper 命名空间…）
→ 注入 setup `<script>` → 注入插件 CSS / JS `<script>`。
⇒ **整段性质唯一：把第三方脚本插进主页面执行**，即施工方案所说的"大堂轨代码与注入逻辑"。

### 3.2 分段表（区间完整平铺 1–2477，无遗漏无重叠）

| 区间 | 内容 | 行数 | 占比 | 是否属大堂轨 |
|---|---|---|---|---|
| 1–79 | 模块头：import + 导出接口（`RuntimePlugin*`/`RuntimeConfig`/`SillyTavern*Context`） | 79 | 3.19% | ❓ 候选存活（但**实测外部零消费**） |
| 80 | 间隔空行 | 1 | 0.04% | — |
| 81–113 | fetch 守卫注释块 + `emitClassicPluginEvent`（导出函数） | 33 | 1.33% | ✅ 是（S5 明列要删的消费点 `CharacterView.tsx`） |
| 114 | 间隔空行 | 1 | 0.04% | — |
| 115–189 | `installGlobalFetchGuard` / `restoreGlobalFetchGuard`（**只为插件注入期替换 `window.fetch`**） | 75 | 3.03% | ✅ 是 |
| 190–194 | 间隔含 `SETUP_PLUGIN_ID` 常量（191–192，服务于注入）+ 空行 | 5 | 0.20% | ✅ 是 |
| 195–220 | `InjectIntoContainerOptions` + `computePluginDiff`（纯函数） | 26 | 1.05% | ❓ 候选存活（但 `computePluginDiff` 的唯一非测试调用点在本文件 `:2172`，位于注入段内） |
| 221 | 间隔空行 | 1 | 0.04% | — |
| 222–239 | `SELF_EMITTED_EVENTS`（本轨事件去重表） | 18 | 0.73% | ✅ 是 |
| 240–241 | 间隔空行 | 2 | 0.08% | — |
| **476–2244** | **`injectIntoContainer`（核心注入段）** | **1769** | **71.42%** | ✅ **是** |
| 242–308 | class 字段（56 个字段中 47 行是注释；字段本身服务于注入账本） | 67 | 2.70% | ✅ 是 |
| 309–475 | class 注入前方法（`loadRuntimeConfig`/`setContext`/`on`/`off`/`emit`/`getExtensionSettings`…） | 167 | 6.74% | ✅ 是 |
| 2245–2477 | class 注入后方法（`rebindRetainedEntries`/`cleanupGalgameState`/`unloadPlugin`/`unloadAll`/`reload`/`saveExtensionSettings`…）+ 类收尾 | 233 | 9.40% | ✅ 是 |
| **合计（class 242–2477）** | | **2236** | **90.27%** | ✅ 是 |

> 边界已逐行核对：`475` = 空行；`476` = `  injectIntoContainer(container: HTMLElement, options: InjectIntoContainerOptions = {}) {`；
> `2243` = `    this.emit('EXTENSIONS_LOADED');`；`2244` = `  }`（方法闭合）。

### 3.3 三个口径的答案（**推荐用中口径**）

| 口径 | 定义 | 行数 | 占比 |
|---|---|---|---|
| **窄口径** | 整合方案字面给出的注入点（`sillyTavernPluginRuntime.ts:2214-2225`）<br>⇒ 实测当前实际对应 **2212–2229**（`createElement('script')` → `finally` 收尾，18 行） | 18 | **0.73%** |
| **★ 中口径（推荐）** | **`injectIntoContainer` 方法整体 476–2244** —— 施工方案「`sillyTavernPluginRuntime.ts` 注入段」的自然落地 | **1769** | **71.42%** |
| **宽口径** | 大堂轨设施全集 = 81–2477（注入段 + 其全部支撑设施：fetch 守卫、事件广播、去重表、整个 class） | 2397 | **96.77%** |
| （参考）整个文件 | 1–2477 | 2477 | 100% |

**有效代码行**（剔除空行与整行注释）交叉验证：全文 1720 行；`injectIntoContainer` 1288 行 = **74.88%**；
class 整体 1562 行 = 90.81%。⇒ 两种计法（总行 / 有效行）结论一致：**注入段约占七成**。

### 3.4 可能存活的部分（**极小**）

严格候选 = `1–79`（模块头 + 导出接口）+ `195–220`（`InjectIntoContainerOptions` + `computePluginDiff`）
= **103 行 = 4.16%**（有效代码行 81）。

⚠️ 但实测削弱了这个"存活"判断：
- 三个导出接口全仓**零外部消费**；
- `computePluginDiff` 唯一非测试调用点在 `:2172`（注入段内部）；
- `InjectIntoContainerOptions` 只被 `injectIntoContainer` 签名使用。

⇒ **若大堂轨删除，这 103 行里没有一行有独立存活理由**（除非刻意保留 `computePluginDiff` 供单间轨复用）。
**更现实的结论是：整个文件随 S5 一起删，占比按宽口径 ≈ 96.8%（或就按 100% 估）。**

### 3.5 ⇒ 对 G9 的裁决建议

> **S4 应跳过 `sillyTavernPluginRuntime.ts`。**

理由（全部为本次实测）：注入段 71.42%、连同支撑设施 96.77%，而可能存活段仅 4.16% 且无独立消费方。
现在拆它 = 拆一个 S5 要整体删除的文件，**纯浪费且与 S5 的删除 commit 冲突**。
正确顺序：**先 S5 删，删完若还有残留再按残留行数决定是否拆**。
（与 `HANDOFF_多agent分包_剩余任务_2026-10-14.md` §五「乙2 — S4 拆大文件」已写的「⚠️ `sillyTavernPluginRuntime.ts`（约 2477）先别拆」一致，本次为其补上了实测依据。）

---

## 4. 测量过程中发现的、S5 必须处理的两处**跨轨反向依赖**（新发现，历次报告未见）

这两条都是「单间轨依赖大堂轨注入的 window 全局」，**S5 删大堂会直接让它们静默降级**，建议在 S5 施工单里加进去。

### 4.1 🔴 `getContext.ts` 委托 4 个 API 给大堂轨注入的 window 桥

`frontend/src/lib/sillytavern/getContext.ts:2275-2310`（实测原文）：

```ts
// N9 修复（批次 F）: 补齐经典/沙箱轨已有而 Ctx 轨缺失的 4 个 API——
// 委托 sillyTavernPluginRuntime 注入的 window 桥（triggerSlash/
// getChatMessages/setChatMessages 于 runtime.ts:731-881 定义），
// 桥缺失时诚实降级 warn 而非插件侧 ReferenceError。
triggerSlash:      async (...) => { ... w.triggerSlash       ? ... : console.warn('[Palink getContext] triggerSlash bridge unavailable'); return ''; },
getChatMessages:   (...)      => { ... : console.warn('[Palink getContext] getChatMessages bridge unavailable');   return undefined; },
setChatMessages:   (...)      => { ... : console.warn('[Palink getContext] setChatMessages bridge unavailable');   return undefined; },
saveChatConditional: async (...) => { ... : await _persistChatMetadata(chatId); },   // 有 Palink 语义退化
```

⇒ `triggerSlash` / `getChatMessages` / `setChatMessages` 三个在 **S5 后一律返回 `''` / `undefined` 并打 warn**。
（`saveChatConditional` 有 Palink 侧退化，不受影响。）

⚠️ 前置未核实项：`getContext.ts` 这个 Ctx 轨是否就是单间轨 iframe 内实际使用的 `getContext`、
以及 S3 之后大堂注入是否仍会执行 —— **本次未核实**（需看 `SillyTavernCompatRuntime.ts` 内 `getContext` 的来源）。
⇒ 结论只给到「存在这条依赖、S5 前必须确认」，**不下"一定会坏"的结论**。

### 4.2 🟡 `legacy-st-sim.ts` 读 `window.__palinkStRuntime`

`smart-card-runtime/frame-shim/legacy-st-sim.ts:1102-1108`（实测原文）：

```ts
// 防御性补全：避免覆盖 sillyTavernPluginRuntime 已设置好的 stat_data。
stat_data: ctx?.stat_data || window.__palinkStRuntime?.context?.stat_data || {},
```

可选链 ⇒ 不会抛错，但 S5 后会稳定退化为 `{}`。
（`grep -rn "window.__palinkStRuntime" frontend/src` 全仓仅 3 处命中：本处 + 本文件自身 `:973`/`:2069-2070`。）

---

## 5. 未核实清单（不许当结论用）

| 项 | 为什么未核实 |
|---|---|
| 门禁真实数字（958/1/3、S2 提交后是否 959/0/3） | 纯只读任务 + 验证纪律 10（不跑全量门禁抢机器）。所有门禁数字均为转录，标注**未实测** |
| `tsc --noEmit` 是否 0 | 未跑，同上 |
| S4 的 14 个 >1200 行文件清单 | 有别的 agent 正在改文件，复跑不可信；沿用 `REPORT_交接文档复核…` §6 |
| `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` 当前精确行数 | 同上，沿用 6984 / 2480 |
| §4.1 的两条依赖在 S3/S5 后是否真的会坏 | 未核实 `getContext` 在单间轨的实际装配路径 |
| S0 是否有 `s0-done` tag | 实测**没有**；是否存在其他等效完工标记未查 |

---

## 6. 一句话结论

六步里 **S0 ✅ / S1 ✅（tag `s1-done`=@`3665d8b`）/ S2 代码已提交（`0738300`，B1 源码判据满足、门禁未实测）/ S3 S4 S5 均未开工**；
G2 未修、G4 待拍板、G7 已修且真机通过、G8 待拍板且未真机复验、**G9 本次给出答案：注入段 1769 行占 71.42%，连同支撑设施 96.77%，S4 应跳过该文件**。
另发现两处「单间轨反向依赖大堂轨 window 全局」的隐藏耦合（§4），S5 施工前必须确认。

---

## 附：本次执行过的命令（可复现）

```bash
git status --short | head -30 ; git rev-parse HEAD ; git rev-parse --abbrev-ref HEAD
git log --oneline -20 ; git tag -l "*s?-done*" ; git tag -l
git log -1 --format="%H %ci %s" s1-done  ;  git log -1 --format="%h %ci %s" merge-base 068acde
git rev-list --count merge-base..s1-done
git branch -v                     # 发现 S2 提交落到 ro-survey
git branch -f s2-storage-migration 0738300     # 无损回收（先 merge-base --is-ancestor 校验为 FF）
git show --stat --oneline 0738300

cd frontend
wc -l src/utils/sillyTavernPluginRuntime.ts                       # 2477
grep -n "^  \(private \|public \|...\)*\(async \|get \|set \)\?[a-zA-Z_$][a-zA-Z0-9_$]*\s*[(<]" src/utils/sillyTavernPluginRuntime.ts
grep -n "" src/utils/sillyTavernPluginRuntime.ts | sed -n '474,478p;2242,2250p'   # 边界核对
py -3 -c "<按区间切片统计行数/占比/空行/注释行>"

grep -rn "sillyTavernPluginRuntime" --include=*.ts --include=*.tsx src | grep -v __tests__
grep -rn "SillyTavernContext\|SillyTavernChatMessage\|SillyTavernCharacter\b" --include=*.ts --include=*.tsx src
grep -rn "window\.__palinkStRuntime" --include=*.ts --include=*.tsx src
sed -n '2275,2310p' src/lib/sillytavern/getContext.ts
sed -n '1100,1110p' src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts
sed -n '50,90p' src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts   # G2
```
