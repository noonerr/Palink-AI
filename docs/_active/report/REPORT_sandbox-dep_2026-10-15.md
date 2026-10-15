# REPORT — 沙箱轨解耦（sandbox-dep）2026-10-15

> 任务：让沙箱轨（`lib/plugin-system/sandbox.ts`）不再依赖大堂轨注入的 `window` 桥，
> 为 S5 删大堂清前置。
> 基线 HEAD：`9b24724`（docs(handoff): S4/S5 剩余任务交接文档）
> 分支：`sandbox-dep`（worktree `/d/项目/_palink-wt/sandbox-dep`，**不 merge**）
> 范围：仅前端；**未做真机**（真机 5 插件探针由主控统一安排）。

---

## 一、结论速览

| 项 | 结果 |
|---|---|
| `npx vitest run`（全量） | **78 文件 / 1012 passed / 3 skipped / 0 failed** |
| `npx tsc --noEmit` | **0 错误**（输出 0 行） |
| `getcontext-parity.test.ts` | 绿 —— `getContext Contract: 145/145 passed`，no-op 预算 **19/20 未动** |
| `st-module-shim-contract.test.ts` | 绿（6 tests） |
| 新增守卫测试 | `sandbox-dep-decouple.test.ts`（12 tests） |
| 改坏证明 / 还原证明 | **改坏 → 7 red；还原 → 12 green**（见 §五） |
| 遗留项 | 3 条需主控裁决（见 §七），**未自行静默吞掉** |

**受影响的三个 API 已全部改为不读 `window`**：`triggerSlash` / `getChatMessages` /
`setChatMessages`（外加 sandbox 侧同类桥 `sandbox.setChatMessages`，任务单未点名但属同一
"沙箱读 window 桥"缺陷面）。

---

## 二、动工前的坐标复核（任务单给的位置逐条 grep 过）

| 任务单给的坐标 | 复核结果 |
|---|---|
| `getContext.ts:2275-2310` 委托 window 桥 | ✅ 命中（`triggerSlash` :2279 / `getChatMessages` :2287 / `setChatMessages` :2295） |
| `getContext.ts:2277` 注释引用 `runtime.ts:731-881` | ✅ 陈旧 —— 实际定义在 `utils/sillyTavernPluginRuntime.ts` 的 `:1087`(set) / `:1092`(trigger) / `:1479`(get) |
| `getContext.ts:1536` `chat = ctx?.chat ?? messageManager.messages.map(toStMessage)` | ✅ 命中，即原生读源 |
| `sandbox.ts:3081-3102` proxy 未命中回退 `buildStContext()` | ✅ 命中，**无需改**（`buildStContext` 是直接 import，不经 window） |
| `sandbox.ts:3582-3594` 裸 triggerSlash 桥 | ✅ 命中 |
| `sandbox.ts:3547-3564` 沙箱自己的 getChatMessages | ✅ 命中，**按指示未动**（其读源 `window.__palinkChatMessages` 由 `CharacterChat.tsx:1537-1556` 注入，**S5 保留**，非大堂轨） |
| 大堂 `:709-710` `SlashCommandEngine.execute` | ✅ 命中 |
| **任务单未列但同类**：`sandbox.ts:3674-3685` `setChatMessages` 同样读 `window.setChatMessages` | ⚠️ 一并修（否则 S5 后仍静默降级） |
| `CharacterChat.tsx:1775-1778 setContext` 喂 chat | ✅ 命中（`stRuntimeRef.current?.setContext` + `getGlobalSillyTavernRuntime().setContext`），**S5 保留** |

> 订正一条任务单外的错误认知：`getContext().chat` 的喂入方是
> **`lib/sillytavern/runtime.ts`**（`getGlobalSillyTavernRuntime()`，S5 保留），
> 不是 `utils/sillyTavernPluginRuntime.ts`。这一点决定了 `setChatMessages` 的写回目标。

---

## 三、改动清单

### 3.1 `frontend/src/lib/sillytavern/getContext.ts`（+256 / -54）

新增 **[S5-GDEP1 2026-10-15]** 段（模块作用域，`getContext()` 之前），导出三个共享实现：

| 函数 | 作用 |
|---|---|
| `selectStChatMessages(chat?, id?, opts?)` | ST 语义的 `getChatMessages` 选择器。逐条复刻大堂桥 `sillyTavernPluginRuntime.ts:1479-1506`：返回**数组**、`id=-1` 取末条、非法 id 取全量、越界取空、`role==='assistant'` 过滤 `is_user`、`includeSwipes`/`include_swipes` 补 swipes、输出带 `message` 别名与 `swipe_id` 兜底 0。`chat` 缺省时经 `resolveNativeChat()` 自解析（runtime ctx → messageManager） |
| `executeSlashCommandCompat(command)` | 下沉自大堂 `:709-710` 的 `SlashCommandEngine.execute(cmd)` |
| `applyStChatMessages(messages, {runtime})` | 批量写入。`messageManager` 的 add/update/delete 组合 + 同步 `runtime.context.chat`；支持完整数组与部分更新 `[{message_id, swipes, swipe_id}]` 两种形态 |

`getContext()` 返回对象里三项改为共调：

```ts
triggerSlash: async (...args: any[]) => executeSlashCommandCompat(args[0]),
getChatMessages: (id?: any, opts?: any) => selectStChatMessages(chat, id, opts),
setChatMessages: async (messages?: any, _opts?: any) => applyStChatMessages(messages, { runtime }),
```

同时把 `:2277` 的陈旧注释坐标订正（`runtime.ts:731-881` → `utils/sillyTavernPluginRuntime.ts` 的 `:1092`/`:1479`/`:1087`），
并说明三者已解耦。

### 3.2 `frontend/src/lib/plugin-system/sandbox.ts`（+45 / -约 30）

- import 改为多行，新增 `executeSlashCommandCompat` / `applyStChatMessages`（同源于 `getContext.ts`）。
- `sandbox.triggerSlash`：裸 window 桥 → `executeSlashCommandCompat(_command)`。
- `sandbox.setChatMessages`：window 桥 → `applyStChatMessages(_messages)`。
- `sandbox.getChatMessages` / `getLastMessageId`（:3547-3574）**按指示未动**。

### 3.3 新增 `frontend/src/lib/sillytavern/__tests__/sandbox-dep-decouple.test.ts`（12 tests）

两层互补守卫（见 §五）。

---

## 四、三处修法逐条说明

### 4.1 `getChatMessages` → 原生源（方案 1）

读源 = `ctx.chat`（`lib/sillytavern/runtime.ts`，`CharacterChat.tsx:1775-1778` 每次渲染
`setContext` 喂入，**S5 保留**），回退 `messageManager.messages`。ST 语义从
`sillyTavernPluginRuntime.ts:1479-1506` 逐条复刻，**不做扩展**（`role` 仍只实现
`assistant` 分支，与大堂桥一致 —— 保持行为零漂移，已在代码注释里标明是已知边界）。

### 4.2 `triggerSlash` → 共享函数（方案 2）

下沉 `SlashCommandEngine.execute(cmd)`。**与全仓其余 8 个消费点同口径取 `result.output`**：
`getContext.ts:1763`、`getContext.ts:2466`、`sandbox.ts:4266/5413/5427/5440/5445`、
`runtime.ts:651` 全都取 `.output`。

> ⚠️ **顺带发现的大堂轨缺陷（未在本次修复范围，仅登记）**：大堂
> `sillyTavernPluginRuntime.ts:711` 写的是 `String(result ?? '')`，而
> `SlashCommandEngine.execute` 返回 `CommandResult` **对象** ⇒ 该行对绝大多数命令实产
> `"[object Object]"`。本次共享函数**有意不复制**这个 bug（否则"避免逻辑丢失"会变成
> "把 bug 一起搬过来"）。S5 删大堂后该缺陷自然消失；若主控希望保留历史行为，需显式说明。

### 4.3 `setChatMessages` → messageManager 组合（方案 3）+ **明确降级**

Palink 确无"整体覆盖聊天"的原生批量写原语。实现：

1. 读源 `base` = `runtime.context.chat`（非空时）否则 `messageManager.messages`；
2. 部分更新形态 → 按**楼层下标**改 `swipes`/`swipe_id`/`extra.swipes`（ST 的 `message_id` 即 chat 数组下标）；
   完整数组形态 → 整体替换；
3. 写回 `runtime.context.chat`（使随后的 `getChatMessages` 立即可读）；
4. 对齐写回 `messageManager`（add/update/delete 组合）。**仅当 messageManager 本身是读源
   或已有内容时才写**，避免给 `useCharacterChat.ts:152` 的真实消息读取注入合成消息；
5. `dispatchEvent('palink:chatMessagesUpdated')`（`CharacterView.tsx:1654` 监听，与大堂桥同款）。

**🔴 明确降级（不是静默吞掉）**：原大堂桥会把结果 `POST /api/chats/save` **落库**
（COT 格式化 swipe 由此持久），本实现只写内存态，**刷新/重载后丢失**。
该降级通过 `recordStubHit('setChatMessages:persist', …)` 登记进
`window.__palinkCompatStats`（插件管理页降级统计面板可见），并有测试钉住。
是否要把落库一并下沉 → **需主控裁决**（见 §七 L1）。

---

## 五、门禁与反证

### 5.1 门禁命令与结果（在 `/d/项目/_palink-wt/sandbox-dep/frontend` 下执行）

```
npx vitest run
  → Test Files  78 passed (78)
    Tests       1012 passed | 3 skipped (1015)

npx tsc --noEmit
  → TSC_EXIT=0（输出 0 行）

npx vitest run src/lib/sillytavern/__tests__/getcontext-parity.test.ts \
               src/lib/plugin-system/__tests__/st-module-shim-contract.test.ts
  → getContext Contract: 145/145 passed
    Test Files 2 passed (2) / Tests 25 passed (25)
```

`PALINK_ALLOWED_NO_OPS` 仍是 **19 个**（预算 ≤20），**未放宽、未增删**；
`triggerSlash`/`getChatMessages`/`setChatMessages` 本就不在 `ST_REQUIRED_APIS` 145 项内，
故不涉及 no-op 预算。

### 5.2 新增守卫测试的设计（`sandbox-dep-decouple.test.ts`，12 tests）

- **A. 行为层（9 tests）**：`beforeEach` 里**故意在 window 上装哨兵**
  （`window.triggerSlash → 'BRIDGE-TRIGGER'`、`window.getChatMessages → ['BRIDGE-GET']`、
  `window.setChatMessages → 置位 __bridgeSetCalled`）。断言三个 API 的返回值里
  **不得出现哨兵**，且 `__bridgeSetCalled === false`。覆盖：`id=-1`/下标/全量/越界、
  `role=assistant` 过滤、`includeSwipes`、`message` 别名与 `swipe_id` 兜底、
  部分更新形态、messageManager 读源下的 add/update/delete 组合、降级登记。
- **B. 源码层（3 tests）**：读 `sandbox.ts` / `getContext.ts` 源码，
  **剥掉注释后**不得匹配 `(window|w)?.(triggerSlash|getChatMessages|setChatMessages)`，
  且必须含共享调用（`executeSlashCommandCompat(` / `applyStChatMessages(`）。
  第三条是**守卫自证**：把旧实现文本喂给正则必须为 true（防"正则写坏了导致假绿"）。

### 5.3 改坏证明会红 / 还原证明回绿（本机纪律，两项都做了）

用一次性脚本把两文件的实现**逐字还原成改前的 window 桥版本**（保留注释与结构）：

| 步骤 | 结果 |
|---|---|
| `break`（还原成 window 桥）→ `npx vitest run sandbox-dep-decouple.test.ts` | **7 failed \| 5 passed (12)** —— 红的正是行为层 5 条 + 源码层 2 条 |
| `restore`（改回解耦版）→ 同命令 | **12 passed (12)** |

改坏时的红灯清单（可复现）：
`getChatMessages 走原生 chat 源`、`getChatMessages 支持下标/全量/role/includeSwipes`、
`triggerSlash 真的执行 SlashCommandEngine`、`setChatMessages 写原生 runtime.context.chat`、
`setChatMessages 支持部分更新形态`、`sandbox.ts 不再读 window 桥`、`getContext.ts 不再读 window 桥`。

> 未变红的 5 条（如"messageManager 为读源时"、"降级被登记"）是因为它们**直接调用共享函数**
> 而非走被改坏的那三条属性 —— 这是预期，不是守卫漏洞。一次性脚本已删除，未入库。

---

## 六、对既有结论的影响评估（确保不破坏）

- **真机探针结论（init 4/5、7 条斜杠命令）不受影响**：本次改动只在"window 桥缺失时"
  才改变行为；探针运行在大堂轨仍在的当前 HEAD 上时，`window` 桥依然存在，但三个 API
  **已不再读它** —— 因此探针若依赖"桥被调用"这一事实来计数，需主控复验一次。
  ⚠️ **这是本次唯一需要主控在真机上确认的点**：`triggerSlash` 现在直接走
  `SlashCommandEngine`，返回值从大堂的 `"[object Object]"` 变为**真实 `output`**。
  对 7 条斜杠命令的**执行**语义无变化（同一引擎、同一命令注册表），但**返回值**会变。
- **单间轨（iframe / smart-card-runtime）零影响**：未触碰 `smart-card-runtime/` 任何文件；
  `frame-getchatmessages-id-lookup.test.ts`、`frame-security-and-migration-contract.test.ts`
  等 78 个文件全绿。
- **`getcontext-parity` 145/145 与 no-op 预算 19/20 未动**。
- **`st-module-shim-contract` 绿**（其 `moduleBlock` 解析依赖 8 空格缩进，本次未改 moduleMap）。

---

## 七、遗留项（需主控裁决，未自行处置）

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| **L1** | `setChatMessages` **未落库** | 只写内存态（`runtime.context.chat` + `messageManager`），已 `recordStubHit` 登记。原大堂桥会 `POST /api/chats/save` | 若 COT 格式化 swipe 的持久化在 S5 后仍需保留，应把大堂 `saveChatMessages`（`sillyTavernPluginRuntime.ts:549-610`，含 `fetchSessionMessages` + 按 `mesid` 定位 + `slice(1)` 语义）整体下沉；**不宜由本分支顺手引入新的后端写路径**（形状不一致会污染聊天数据，且无真机验证窗口）。**待主控确认** |
| **L2** | 大堂 `runSlashCommand` 的**前置命令段**未下沉 | `/branch-create`、`/checkpoint-go`、`/chat-fork`、`/getchatname`、`/model`、`/profile`、`/preset`、`/profile-list`（`sillyTavernPluginRuntime.ts:646-707`）依赖大堂私有的 `palinkBridge.resolveMessageAnchor` 与 `this.context`。S5 删大堂后这些命令在沙箱轨**会丢失** | 任务单只授权下沉 `:709-710`。若要保 S5 后可用，需另立议题把这 8 条命令 + `resolveMessageAnchor` 下沉（工作量约 70 行 + 1 个 API 依赖） |
| **L3** | 大堂 `:711` 的 `String(result)` 缺陷 | 见 §4.2，本次有意不复制 | 无需动作；S5 删大堂后自然消失。仅作登记 |
| **L4** | 🔴 worktree 的 `docs/_CATALOG.md` **与主工作区不同步** | 实测（2026-10-15 12:05）：worktree 扫到 **325** 份 md（生成于 12:04），主工作区扫到 **330** 份（生成于 11:54）。差异原因有二：① worktree 不 checkout 被 .gitignore 的文件（`docs/_archive/2026-10/COMMIT_MESSAGE.md`、`DELIVERY_PACKAGE.md`）；② **主工作区另有 4 份「已入库但晚于 9b24724」的在途文档**（`REFERENCE_ST上游锚定`、`HANDOFF_S5提示词订正`、`HANDOFF_提示词_S4拆单间`、`HANDOFF_提示词_沙箱轨解耦`，均由并行 agent 在本会话期间提交）。本分支的 `_CATALOG.md` 是 **325 份版本**，主工作区是 **330 份版本** ⇒ **直接 merge 会把目录回退** | **并入主工作区后必须重跑** `py scripts/docs/gen_docs_catalog.py` 再 `--check`，**勿沿用分支产物**（见 MEMORY.md 同日条目）。建议主控在合并时对 `docs/_CATALOG.md` 一律取「重跑」而非「取分支版」 |

---

## 八、提交与分支

- 分支 `sandbox-dep`，**未 merge**，**未 push**。
- 提交方式：`git commit -o -F <消息文件> -- <pathspec>`（禁 `git add -A` / `stash -u`）。
- 改动文件：
  - `frontend/src/lib/sillytavern/getContext.ts`
  - `frontend/src/lib/plugin-system/sandbox.ts`
  - `frontend/src/lib/sillytavern/__tests__/sandbox-dep-decouple.test.ts`（新增）
  - `docs/_active/report/REPORT_sandbox-dep_2026-10-15.md`（本文件）
  - `docs/_CATALOG.md`（重跑目录脚本产生，**325 份版本；合并时以重跑结果为准**，见 §七 L4）

---

## 九、与主控交接书的一致性核对

主工作区存在本任务的权威交接书 `docs/_active/HANDOFF_提示词_沙箱轨解耦_2026-10-15.md`
（注意：该文件**晚于** 9b24724 入库，故不在本 worktree 内；已单独读取核对）。逐条对账：

| 交接书「主控验收标准」 | 本次交付 |
|---|---|
| 1. 三个 API 不再依赖 window 桥（判据：grep 实现，数据源来自本轨原生源或共享函数） | ✅ §三；并有 §五 源码层守卫测试钉住 |
| 2. 两条红线测试全绿，no-op 预算未放宽 | ✅ 145/145，`PALINK_ALLOWED_NO_OPS` 仍 19/20，未增删 |
| 3. 门禁 `failed = 0` + `tsc --noEmit` = 0 | ✅ 1012 passed / 0 failed；tsc 0 错误 |
| 4. 报告含「改坏会红 / 还原回绿」两组变异证明 | ✅ §5.3 |
| 5. `setChatMessages` 降级必须明确登记（不能静默） | ✅ §4.3 + `recordStubHit` + 测试钉住 |
| 6. 完工不 merge，留 `sandbox-dep` | ✅ 未 merge、未 push |

另：交接书要求「node_modules 用目录联接共享（mklink /J）」—— 本机 `cmd` 被沙箱拦截，
改用等价的 PowerShell `New-Item -ItemType Junction`，效果一致（已实测 `vitest`/`tsc` 可跑）。

⚠️ **基线漂移提示**：本会话期间主工作区 HEAD 已由 `9b24724` 前进到 `1856d77`
（并行 agent 提交了 S4/S5 系列交接文档）。本分支**仍基于 `9b24724`**（与交接书前置一致）。
合并时若遇 `docs/_CATALOG.md` / `docs/_active/` 冲突，按 §七 L4 处置。
