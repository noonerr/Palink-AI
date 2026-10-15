# REPORT · 大堂前置 slash 命令下沉（S5 前置）

> 任务：把大堂轨 `runSlashCommand` 里的 Palink 专有命令实现下沉为共享函数，供沙箱轨共用，为 S5 删大堂清前置。
> 分支：`slash-sink`（worktree `D:\项目\_palink-wt\slash-sink`，**未 merge**）
> 基线：`e0751ca`（代码基线 = 任务书所述 96085b9，其上多一个 docs 提交）
> 日期：2026-10-15

## 1. 结论

7 个处理分支 / 9 个命令名已下沉到 `frontend/src/lib/sillytavern/slash-commands-compat.ts` 的
`runPalinkSlashCommands(command, deps?)`，大堂轨与沙箱轨共调同一份。**S5 删大堂后这批命令不再随大堂消失。**

- 大堂轨**原实现未删**，改为调用共享函数并显式注入自己的 `sessionId` 与 `palinkBridge.resolveMessageAnchor`
  ⇒ 与下沉前逐行同源（机械 diff 证据见 §3）。
- 沙箱轨 `triggerSlash` 前置共享实现：命中即返回，未命中才落 `SlashCommandEngine`（原有兜底未被吃掉）。
- 语义**零变更**：唯一有意差异是错误日志前缀（返回值一致），已逐条登记（§4）。

## 2. 改动清单（4 文件）

| 文件 | 性质 | 说明 |
|------|------|------|
| `frontend/src/lib/sillytavern/slash-commands-compat.ts` | **新增** | 共享实现（7 分支 / 9 命令名）+ 共享版 `fetchSessionMessagesShared` / `resolveMessageAnchorShared` |
| `frontend/src/lib/plugin-system/sandbox.ts` | 改 | `triggerSlash` 前置 `runPalinkSlashCommands`（+1 import） |
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | 改 | `runSlashCommand` 内联实现体删除，改为调用共享函数；`generationEngine` import 随之下沉移除 |
| `frontend/src/lib/sillytavern/__tests__/slash-commands-sink.test.ts` | **新增** | 23 条守卫（含 window 哨兵反证 + 插件真路径 + 大堂等价 + 源码层） |

## 3. 旧实现 → 新实现 对照表

命令清单（7 分支 / 9 命令名）与逐条落点：

| # | 分支 | 命令名 | 旧实现位置 | 新实现位置 | 匹配正则（**未改**） | 返回值（**未改**） | 副作用（**未改**） |
|---|------|--------|-----------|-----------|--------------------|--------------------|--------------------|
| ① | 分支/存档创建 | `/branch-create {mesId}`、`/checkpoint-create mesId=X {name}` | `sillyTavernPluginRuntime.ts:646-659` | `slash-commands-compat.ts` 分支① | `/^\/branch-create\s+(\d+)/`、`/^\/checkpoint-create\s+mesId=(\d+)(?:\s+(.*))?$/i` | `''` | POST `/api/character-sessions/{sid}/branches`（`same_level:false` + `parent_branch_id`/`parent_message_id`/`branch_name`）+ 派发 `palink:switchBranch` |
| ② | 分支/存档跳转 | `/checkpoint-go {mesId}` | `:660-671` | 分支② | `/^\/checkpoint-go\s+(\d+)/` | `''` | POST `…/branches/{branchId}/switch?limit=10[&up_to_message_id=…]` + 派发 `palink:switchBranch`（带 `branchId`/`messageId`） |
| ③ | 同级分叉 | `/chat-fork` | `:672-677` | 分支③ | `/^\/chat-fork\b/` | `''` | POST `…/branches`（`same_level:true`）+ 派发 `palink:switchBranch` |
| ④ | 聊天文件名 | `/getchatname` | `:678-681` | 分支④ | `/^\/getchatname\b/` | `palink-session-{sid}.jsonl`（无会话时 `''`） | 无 |
| ⑤ | 模型读写 | `/model [arg]` | `:682-693` | 分支⑤ | `/^\/model(?:\s\|$)/i` | `Model: {arg}` / `Current model: {m}` / `quiet=true` 形态回裸名 | `generationEngine.setContext({model})` |
| ⑥ | profile/preset 映射为模型 | `/profile [arg]`、`/preset [arg]` | `:694-703` | 分支⑥ | `/^\/(profile\|preset)(\s\|$)/i` | set→`''`；get→当前模型名或 `''` | `generationEngine.setContext({model})` |
| ⑦ | 预设列表占位 | `/profile-list` | `:704-707` | 分支⑦ | `/^\/profile-list\b/` | `''` | **`recordStubHit('slash:profile-list', …)`**（保留） |
| — | 未命中兜底 | 其余命令 | `:708-711` | 调用方自行处理 | — | 调用方返回 `null` → 委托 `SlashCommandEngine` | — |

### 机械 diff 证据（"只搬不改语义"）

对旧实现体（`git show HEAD:…sillyTavernPluginRuntime.ts` 第 646-707 行）与新实现体做归一缩进后的逐行 diff，**全文差异仅 3 处**：

1. `palinkBridge.resolveMessageAnchor(floorId)` → `resolveAnchor(floorId)`（2 处，分支①②）——
   大堂轨注入的正是同一个 `palinkBridge.resolveMessageAnchor`（`deps.resolveMessageAnchor`），
   沙箱轨用共享缺省实现，行为等价。
2. 末尾新增 `return null`（未命中信号）+ `catch` 尾（见 §4 唯一有意差异）。

其余 60 余行（正则、请求体拼装、事件 detail 形状、`recordStubHit` 键名与文案）**逐字节一致**。

同理对 `fetchSessionMessages` / `resolveMessageAnchor` 两段做 diff，差异只有：
上下文来源由 `this.context`（大堂）改为 `resolveGlobalContext()`（全局 ST runtime）、
调用对象由 `palinkBridge.fetchSessionMessages()` 改为 `fetchSessionMessagesShared()`、日志前缀变化。
空值判定（`!sessionId \|\| !uuid` → `''`）、`Array.isArray` 兜底、`try/catch → null` 降级均一致。

## 4. 语义差异登记（逐条，全量=1 条）

| # | 差异 | 是否影响行为 | 处置 |
|---|------|-------------|------|
| D1 | 异常日志前缀：旧 `[SillyTavernPluginRuntime] runSlashCommand failed:` → 新 `[Palink slash-commands] runPalinkSlashCommands failed:`；`resolveMessageAnchor` 同步换前缀 | **否**（返回值都是 `''`，副作用一致） | 接受。共享模块不再属于大堂轨，沿用大堂前缀会误导排查 |

除此之外**无**返回值 / 正则 / 副作用差异。特别说明两条**不是**差异、容易误判的点：

- **`sessionId` 缺省解析**：大堂轨显式注入（含显式 `undefined` ⇒ 仍按"无会话"处理），
  沙箱轨不注入 ⇒ 走全局 ST runtime 的 `context.chatId`。`CharacterChat` 每次渲染同时喂两个 runtime
  （`CharacterChat.tsx:1773-1778`），故同一会话下两者取值一致。
- **无会话时的命中判据**：会话类命令（①②③）匹配到命令名但无 `sessionId` 时**按未命中处理**
  （继续落引擎）——这是旧实现 `&& sessionId` 的 falsy 判定照搬，不是本次引入。

## 5. 大堂上下文隐式依赖 · 逐条核查

任务书要求核查 `/model` `/profile` `/preset` 对 `generationEngine`（COT 换模型）的依赖是否做成
"只在大堂可用"。结论：**不是隐式依赖，三条命令已完全可用**。

| 命令 | 原依赖 | 下沉后 | 是否仍依赖大堂 |
|------|--------|--------|--------------|
| `/model`、`/profile`、`/preset` | `generationEngine` 模块单例（`services/generation-engine.ts`） | 同一单例（共享模块直接 import） | **否**。`generationEngine` 是共享服务，沙箱轨 `generateRaw`/`generate` 已在用同一实例 |
| 分支①②③④ | `this.context.chatId`、`palinkBridge.resolveMessageAnchor`、`window` 事件 | 显式 `deps` 注入（大堂）/ 全局 runtime 解析（沙箱） | **否**（大堂轨显式注入，无隐式全局读取） |

`window.dispatchEvent(new CustomEvent('palink:switchBranch' | 'palink:chatMessagesUpdated'))` 在两轨都在的主 window 上派发，
监听方（故事线侧栏 / `CharacterView`）不在沙箱内，故无隔离问题。

顺带清理：大堂轨的 `import { generationEngine }` 随 `/model` 段下沉一并移除（tsc 证无其他引用）。

## 6. 门禁结果（worktree 内实跑）

| 门禁 | 基线（改动前） | 完工 | 判定 |
|------|--------------|------|------|
| `npx vitest run`（全量） | 78 文件 / **1012 passed** / 3 skipped / 0 failed | 79 文件 / **1035 passed** / 3 skipped / 0 failed | ✅ 用例数**未减少**（+23 新增），failed=0 |
| `npx tsc --noEmit` | exit 0 | exit 0 | ✅ |
| `npx eslint`（两个新文件） | — | 0 problems | ✅ |
| `npx eslint`（两个既有文件） | 47 problems（42 err / 5 warn，主工作区实测） | 47 problems（同上） | ✅ 未新增 |

四个点名守卫（实跑，`Test Files 4 passed (4) / Tests 53 passed (53)`）：

| 守卫 | 结果 |
|------|------|
| `st-plugin-import-wrapper-collision.test.ts` | ✅ 16 tests passed |
| `getcontext-parity.test.ts` | ✅ 19 tests passed，`getContext Contract: 145/145 passed`，允许的 no-op `19/19`（预算 20，**未新增 no-op**，`PALINK_ALLOWED_NO_OPS` 未动） |
| `st-module-shim-contract.test.ts` | ✅ 6 tests passed |
| `sandbox-dep-decouple.test.ts` | ✅ 12 tests passed（GDEP1 三件套未被本次改动破坏；`sandbox.ts` 仍保留 `executeSlashCommandCompat(` 字面量供其源码层守卫匹配） |

新增守卫 `slash-commands-sink.test.ts`：✅ 23 tests passed（A 逐命令行为 10 条 / B 哨兵反证+插件真路径 6 条 /
C 大堂等价 4 条 / D 源码层 4 条——含"守卫自身有效"防假绿 1 条）。

## 7. 改坏证明（红 → 绿，两项）

按项目规矩"声称测试守住某行为须做改坏证明"，两项均实测：

| 改坏 | 手法 | 结果 | 还原 |
|------|------|------|------|
| **A：共享实现改回读大堂 window 桥** | 在 `slash-commands-compat.ts` 注入 `const bridge = window.__palinkBridge`，让锚点解析取 `bridge.resolveMessageAnchor`、`/getchatname` 走 `bridge.runSlashCommand` | **11 red**（含"共享实现在 window 桥存在时仍走原生实现"、"/branch-create 不用假锚点 -999"、两条沙箱真路径、"共享实现自身不读 window 桥"源码守卫） | 还原后 **23 passed** |
| **B：沙箱前置层删除** | 把 `triggerSlash` 退回 `executeSlashCommandCompat(_command)` 单一委托（模拟"没下沉"） | **3 red**（沙箱轨插件真路径 ×2 + 源码层守卫"沙箱轨 triggerSlash 前置了共享实现"） | 还原后 **23 passed** |

结论：新增测试对"沙箱轨拿到这批命令"与"不依赖大堂 window 桥"两项行为**确有守卫力**，非假绿。

## 8. 遗留项登记（不在本次授权范围，需主控决策）

| # | 遗留项 | 现状 | 影响 | 建议 |
|---|--------|------|------|------|
| **L1** | **getContext 轨的 `triggerSlash` 未接入共享实现** | `getContext.ts:2508` 仍是 `executeSlashCommandCompat(args[0])`（纯引擎） | S5 后 **getContext 轨**插件调 `/branch-create` `/chat-fork` `/getchatname` 等仍会落到"未知命令"。本次任务书只授权"大堂轨与沙箱轨都调它"，且接第三轨会**改变 getContext 轨既有语义**，故未动 | 一行改法：与 `sandbox.ts` 同款前置 `runPalinkSlashCommands`。**这是三轨一致性的最后一块拼图，建议 S5 前单独决策** |
| **L2** | `setChatMessages` 未落库（GDEP1 的 L1 遗留，本次未触碰） | 沙箱 `setChatMessages` 只写内存态，经 `recordStubHit('setChatMessages:persist')` 登记降级 | 刷新后丢 | 与本任务无关，另议 |
| **L3** | 沙箱轨 `/model` 等的 COT 语义未做真机验证 | 本次为静态下沉，未接真机（任务书标注不需真机） | 需真机确认 Galgame 加强模式在沙箱轨的快照→切换→恢复闭环 | S5 后真机复验一次即可 |

> 未静默丢任何命令：9 个命令名全部落在共享实现里，并有逐条断言（§3 表格 + 测试 A 组）。

## 9. S5 删大堂时的操作说明

- 共享模块 `lib/sillytavern/slash-commands-compat.ts` **不 import 任何大堂轨文件**，
  与 `utils/sillyTavernPluginRuntime.ts` 之间无依赖方向 ⇒ S5 可整文件保留，也可整目录删除大堂轨而它不受影响。
- 沙箱轨已不读 `window.__palinkBridge`（源码层守卫钉死），删大堂注入脚本不会让这批命令降级为空。
- 大堂轨 `runSlashCommand` 在 S5 可直接随 `palinkBridge` 一起删，无需再搬运实现。

## 10. 复现命令

```bash
# worktree：D:\项目\_palink-wt\slash-sink（node_modules 为指向主工作区的目录联接）
cd frontend && npx vitest run                                   # 79 files / 1035 passed / 3 skipped
cd frontend && npx vitest run src/lib/sillytavern/__tests__/slash-commands-sink.test.ts   # 23 passed
cd frontend && npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-plugin-import-wrapper-collision.test.ts \
  src/lib/sillytavern/__tests__/getcontext-parity.test.ts \
  src/lib/plugin-system/__tests__/st-module-shim-contract.test.ts \
  src/lib/sillytavern/__tests__/sandbox-dep-decouple.test.ts   # 4 files / 53 passed
cd frontend && npx tsc --noEmit                                # exit 0
py scripts/docs/gen_docs_catalog.py && py scripts/docs/gen_docs_catalog.py --check
```