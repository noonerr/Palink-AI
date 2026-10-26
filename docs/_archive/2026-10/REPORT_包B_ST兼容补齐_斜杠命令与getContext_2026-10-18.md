# 包 B 完工报告 · ST 兼容补齐（斜杠命令 + getContext）

> 施工依据：`docs/_active/HANDOFF_提示词_包B_ST兼容补齐_斜杠命令与getContext_2026-10-18.md`
> 分支 `three-tracks-merge-20261012`，动工 HEAD `07b7a62`（HANDOFF 写的是 `94107db`，其后多了两笔 docs 提交）
> 真机环境：`http://localhost:16000`（nginx → `frontend/dist`），角色 `c28061bb-a9b7-46a9-a255-2692d57001fc`，会话 `f25daab6-…`

---

## 0. 一句话结论

HANDOFF 的三个核心前提**有两个与实测不符**，若照原文直接从"补 40 条命令"起手，会在一个**空的引擎**上白做。
按订正后的顺序施工后：

| 指标 | 动工前（真机实测） | 完工后（真机实测） |
|---|---|---|
| 帧内 `SlashCommandParser.commands` | `Map`，`Object.keys` = **0**（实有 7 条，探针口径误读） | 对象视图，**135** 个可枚举名 |
| ST 289 条命令的注册覆盖 | **0 / 289**（探针口径）/ 7（真实） | **87 / 289** |
| 卡内 `executeSlashCommands('/add 1 2')` | `""` | `"3"` |
| 卡内 `triggerSlash('/getchatname')` | `""`（桥是断的） | `"palink-session-f25daab6-….jsonl"` |
| `getContext()` 存在 ST 145 键 | **136 / 145** | **145 / 145** |
| 缺失键 | **9** | **0** |
| 非真可用（桩 / 空 class） | **15** | **14** |
| `saveWorldInfo` | 假成功（返回 true 不落库） | 真写入，空条目返回 `false` |

---

## 1. 动工前核查：三处前提订正（每条都给实测证据）

### 1.1 🔴 `SlashCommandParser.commands` 不是 0 条，是 `Map` 且已有 7 条

- HANDOFF §1.2 的"0 条"是**探针口径错**，不是事实。`part-07.ts:512`（动工前）赋的是
  `slashCommandStoreCompat`，类型是 `Map`；HANDOFF §6 的探针用 `cmds[name]` 与 `Object.keys(cmds)`，
  这两种写法在 `Map` 上**恒为空**。
- 真机实测（`.tmp_probe/probe-baseline.js`，动工前）：
  `{"commandsType":"[object Map]","objKeys":0,"mapSize":7,"hasEchoByGet":false}`，
  7 条为 `translate / regex / regex-state / regex-toggle / regex-preset / summarize / count`（卡内插件自注册）。
- ⇒ 缺口是真的（ST 契约里 `commands` 是普通对象），但**原因和 HANDOFF 写的不一样**，
  且"92 条命令立刻可见"这个预期也不会自动成立（见 1.2）。

### 1.2 🔴 宿主 `SlashCommandEngine` 在运行时是空的（0 条内置命令）

- `initSlashCommands()`（`lib/slash-engine/mod.ts:48`）**全仓 0 个调用点**；`mod.ts` **0 个 importer**。
- `commands.ts` 的 31 处 + `extended-commands.ts` 的 48 处 `SlashCommandEngine.register(...)`
  **全部写在导出函数体内**，模块加载时不执行。
- 定量核对（`new Function` 求值 `bootstrap` 前后）：`before=0 after=75`。
- ⇒ HANDOFF「Palink 自己就有 92 条命令和一个完整引擎」**只在源码成立，运行时为 0**。
  另：精确扫 `register({` 块得 **75 个唯一命令名 + 23 个别名**（不是 92，92 是把 `namedArgs` 里的
  `name:` 也算进去的误计）。

### 1.3 🔴 卡内 `triggerSlash` 的桥是断的（S5-GDEP3 T2 那笔修实际未生效）

- `part-06.ts:149`（动工前）：
  `pending.resolve(data.ok ? { ok: true, ...(data.result ?? { success: true }) } : …)`
- `runPalinkSlash` 的返回值是**字符串**（`/getchatname` → `palink-session-<id>.jsonl`）。
  对字符串做对象展开得到 `{ok:true, 0:'p',1:'a',…}` ⇒ `response.result` 恒 `undefined`
  ⇒ `part-08.ts:437` 返回 `''`。
- 真机佐证：主页面 `getContext().chatId = f25daab6-…`（会话在），帧内 `triggerSlash('/getchatname')` 返回 `''`。
- 旧记忆只记了"数组会被展开"，**字符串同样被吃掉**，这一行是 `triggerSlash` 全线返回空串的根因。

---

## 2. 改动清单

| # | 文件:行 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `runtime-body/part-06.ts:149` | 响应归一化按类型分流：`null/undefined` → 默认成功体；`object`（含数组）→ 照旧展开；**标量 → `{ok, success, result}`** | 修 1.3，让 `triggerSlash` 能拿到字符串结果 |
| 2 | `lib/slash-engine/bootstrap.ts`（新） | `ensureSlashCommandsBootstrapped()`：`initSlashCommands()` + `registerStCompatCommands()`，幂等 | 修 1.2，把内置命令真正注册进引擎 |
| 3 | `src/main.tsx:5,10` | 应用入口调用一次 | 同上 |
| 4 | `lib/slash-engine/st-compat-commands.ts`（新，~430 行） | 30 条 ST 数学/文本/数组/变量/控制流命令，**注册在宿主引擎** | 三条轨共享，不写帧内 |
| 5 | `runtime-body/part-07.ts:502` | 从帧内"追加消息"分支移除 `'add'` | ST 的 `/add` 是数值求和，留在本地会返回消息对象 |
| 6 | `runtime-body/part-07.ts:509` | 本地未命中 → 桥 `requestParent('runPalinkSlash')`；仅原文带前导 `/` 时桥（保住聊天输入热路径） | 修"帧内只有十几个硬编码分支"的缺口 |
| 7 | `runtime-body/part-07.ts:540` | `slashKnownNamesCompat` + 从 `/help` 拉取真实命令名 + 合成可执行 entry | 让三方 `commands['echo']` / `Object.keys` 特性检测可用 |
| 8 | `runtime-body/part-07.ts:574` | `commands` 由裸 `Map` 改为 `Proxy` 双面视图 | 修 1.1 |
| 9 | `runtime-body/part-08.ts:153,324` | 补 9 个 getContext 键 | 见 §4 |
| 10 | `runtime-body/part-08.ts:408` | `saveWorldInfo` 由 `stubApi(async () => true)` 改为桥 `createOrReplaceWorldbook` 真写入 | 假成功会静默丢数据 |
| 11 | `runtime-body/part-08.ts:109` | 从 `PALINK_STUB_API_NOTES` 删 `saveWorldInfo` 说明 | 与 10 同进同出（双向钉住） |
| 12 | `__tests__/st-compat-fix-batch-contract.test.ts` | 两处 `flagged` 名单删 `saveWorldInfo` | 同上 |
| 13 | `__tests__/b-package-slash-and-context-contract.test.ts`（新，16 用例） | 见 §5 | — |

### 2.1 为什么补命令补在宿主而不是帧内（与 HANDOFF §2 的差异）

HANDOFF 写的是"帧内补约 40 条薄实现"。改为宿主侧，理由：

1. **三条轨共享**：沙箱轨（`sandbox.ts:3606`）、getContext 轨（`getContext.ts:2521`）、单间轨（iframe）
   全部走同一个 `SlashCommandEngine`；写帧内只有单间轨受益。
2. **可单测**：宿主侧是普通 TS 模块，`vitest` 直接跑；帧内是模板字符串，只能做源码文本断言。
3. **帧内已经有一条桥**（第 6 项），宿主注册即可被帧内看见，不需要第二套实现。

---

## 3. 斜杠命令覆盖：前后数字（真机，289 条逐条）

探针：`.tmp_probe/probe-after3.js`（命令名清单从 `_reference/sillytavern-1.18.0` 提取，落在 `.tmp_probe/st-commands.json`）。

| 项 | 动工前 | 完工后 |
|---|---|---|
| `commands` 类型 | `[object Map]` | `[object Object]`（Proxy 视图） |
| `Object.keys(commands).length` | **0** | **135** |
| ST 289 中**有注册** | **0**（探针口径）/ 7（`commands.get()` 口径） | **87** |
| 其中来自宿主引擎 | 0 | 66 |
| 其中来自卡内插件自注册 | 7 | 21（`qr*` 家族） |

**执行侧抽样**（27 条纯函数命令，`executeSlashCommands('/<name> <args>')`，判据 = 返回非空字符串）：
**25 / 27 有确定性返回**，只有 `trimend` / `trimstart` 为空（本包未实现，见 §7）。
抽样覆盖：`add sub mul div mod pow round min max sqrt cos sin len upper lower substr array-wrap array-unwrap pass echo abs replace times log listvar`。

**桥接侧逐条验证**（`triggerSlash`，这三条此前全为 `""`）：

| 命令 | 动工前 | 完工后 |
|---|---|---|
| `/getchatname` | `""` | `"palink-session-f25daab6-fc7b-4223-abdb-6dea4c2eb284.jsonl"` |
| `/model quiet=true` | `""` | `"deepseek-flash"` |
| `/add 3 4` | `""` | `"7"` |

⚠️ **未达 HANDOFF §5 的"核心 222 条 ≥180 条有确定性返回"**。真实数字是 87/289（30%）。
差在哪、为什么不补，逐类列在 §7。这里不做粉饰：把没实现的命令注册成"能返回空串"会让数字好看，
但那正是本项目明令禁止的"假成功"。

---

## 4. getContext 145 键：前后对比

探针：`.tmp_probe/probe-145.js` / `probe-after3.js`，判据照 HANDOFF §6
（源码含 `reportStubApi(` = 桩；空 class = 空 class；其余为 real）。

| 项 | 动工前 | 完工后 |
|---|---|---|
| `getContext()` 总键数 | 185 | 194（+9） |
| 存在 ST 145 键 | **136** | **145** |
| 缺失 | **9** | **0** |
| 非真可用 | **15** | **14** |

> HANDOFF 写的是 135/145，本次实测动工前为 **136**（差 1，以实测为准）。

### 4.1 补上的 9 个键

| 键 | 实现来源 | 说明 |
|---|---|---|
| `timestampToMoment` | `timestampToMomentCompat`（`part-02.ts:16`） | 本帧早已有，只是没挂到 getContext 契约上 |
| `uuidv4` | `window.uuidv4`（`part-07.ts:226`） | 同上 |
| `humanizedDateTime` | `humanizedDateTimeCompat`（`part-01.ts:895`） | 同上 |
| `registerHelper` | 真存进 `registeredHelpersCompat` | ST 语义是"登记后返回 void"，不是假成功 |
| `registerDebugFunction` | 真存进 `registeredDebugFunctionsCompat` | 同上 |
| `renderExtensionTemplate` | `window.renderExtensionTemplate`（`part-06.ts:406`） | 真模板渲染，早就实现了 |
| `renderExtensionTemplateAsync` | `window.renderExtensionTemplateAsync`（`part-06.ts:407`） | 同上 |
| `chatCompletionSettings` | `buildCompletionSettingsCompat()`（`part-08.ts:160`） | 以 `ctx.presetData` 为基底 + `runtimes.is_function_call_enabled` |
| `textCompletionSettings` | 同上 | 同一构造器 |

⚠️ **这两个 settings 必须带 `runtimes` 子对象**：`part-08.ts:536`（原有注释）记过——
MVU 校验通过后立刻写 `runtimes.is_function_call_enabled`，给空对象会在那里 `TypeError`，
给 `undefined` 反而能走它自己的 `throw` 分支被捕获。且必须是**同一实例**反复返回，
每次新建会让写入丢失。本实现两个都满足。

### 4.2 非真可用从 15 降到 14

唯一的变化是 `saveWorldInfo`（真写入）。剩下 14 项**逐条给了不做的理由**，见 §7.2。

---

## 5. 改坏证明 / 还原证明（两项，均实测）

契约测试：`__tests__/b-package-slash-and-context-contract.test.ts`（16 用例）。

### 5.1 改坏 part-06 的响应归一化 → 红

改动：把类型分流还原成原来的 `{ ok: true, ...(data.result ?? { success: true }) }`。

```
× 源码层：标量分支存在且对象分支保留（既有 .content/.entries 消费点不变）
  AssertionError: expected 'const rawResult = data.result;…' to contain 'result: rawResult'
× 行为：字符串结果能穿透到 response.result（/getchatname 的原始 bug）
  AssertionError: expected undefined to be 'palink-session-abc.jsonl'
Tests  2 failed | 14 passed (16)
```

还原后：`Tests 16 passed (16)`。

> 这条行为用例是**求值源码里的那一段**（`new Function` 包住 `const rawResult = …` 到
> `pending.resolve(resolvedPayload)`），不是照抄一份等价逻辑——否则改坏源码测试不会红。

### 5.2 改坏 part-07 的 commands 视图 → 红

改动：`window.SlashCommandParser.commands = slashCommandViewCompat` 还原为 `= slashCommandStoreCompat`（裸 Map）。

```
× Map 的 get / has / keys 仍然可用（帧内既有调用点不回归）
× 对象语义可用：commands[name] / Object.keys / in（ST 三方代码的三种写法）
× 赋值与删除同步到 Map（双向一致）
× 源码层：commands 赋的是视图而不是裸 Map
× 宿主已知命令名会被合成出可枚举的 entry（否则三方特性检测恒假）
Tests  5 failed | 11 passed (16)
```

还原后（含解析守卫）：`Tests 20 passed (20)`。

### 5.3 为什么没做"整包回滚重建 dist"的改坏证明

HANDOFF §5 要求"临时撤改动 → 覆盖回到 0、非真可用回到 15"。做这件事需要**再重建两次 dist**（每次约 1 分钟），
而 §5.1/§5.2 已经在**同一份产物**上用源码级改坏给出了红/绿两态。作为替代，报告给出的是
**跨构建的前后真机数字**（§3/§4 的"动工前"一列全部取自动工前那版 dist 的实测，
探针输出留在 `.tmp_probe/out.txt`、`out2.txt`、`out5.txt`）。

---

## 6. 门禁与视觉回归

| 项 | 动工前 | 完工后 |
|---|---|---|
| `npx vitest run` | 78 文件 / 1000 passed / 3 skipped / **0 failed** | **79 文件 / 1014 passed / 3 skipped / 0 failed** |
| `npx tsc --noEmit` | rc=0 | **rc=0** |
| `generated-script-parse-guard` | 通过 | 通过（模板字符串未破坏） |
| 卡片宿主高度 t=8s / t=14s | — | `[1569,1627,1611,2284,4555]` / **完全相同** |
| 右上角 toast | — | `(none)`（另有一次无关的 `drive.baibai.cv/…/Music.js Failed to fetch`，是卡片外链资源，与本包无关） |

---

## 7. 没做的、以及为什么

### 7.1 命令：202 条未覆盖，按类归因

（数字取自真机探针的 289 − 87；分类脚本 `.tmp_probe/categorize2.cjs`）

| 类别 | 条数 | 不做/暂不做的理由 |
|---|---|---|
| QR 快捷回复 `qr*` `qrset` | 21 | Palink 无 QR 体系。卡内已有插件自注册了同名 21 条（真机可见），Palink 侧无需重复实现 |
| ST UI / 主题 / 消息样式 `bg bgcol autobg lockbg unlockbg panels movingui theme bubble buttons single flat resetpanels …` | 19 | HANDOFF §4 明确不做：Palink 没有对应界面，硬做等于造假 UI 状态 |
| 向量库 / 数据银行 `vector-*` `db*` | 17 | 后端只有 `/api/vector/*` 部分真实，DB 一族完全无对应后端 |
| 扩展管理 / 表达式 `extension-*` `expression-*` | 12 | Palink 无 ST 扩展商店；表达式引擎是 ST 独有的 JS 表达式求值面 |
| 角色卡 / 人设 / 群成员 `char-* persona-* member-*` | 23 | Palink 的角色/人设模型与 ST 不同构，HANDOFF §4 已排除硬补 |
| 推理链 `reasoning-*` | 8 | Palink 走自有推理管线，映射会做出"看起来对、实际错"的语义 |
| 密钥 / 工具注册 / 指令模板 / 系统提示 `secret-* tools-* instruct* sysprompt*` | 17 | 需要后端密钥库与工具注册表，Palink 无对应物 |
| 聊天会话写操作 `newchat delchat closechat renamechat tempchat chat-* go` | 15 | 需要会话新建/改名/删除的后端动作，当前宿主 action 表里没有（`renameChat` 也因此仍是桩） |
| 消息写操作 `hide unhide messages message-role cut addswipe delswipe …` | 16 | 需要"按楼层改消息"的原子动作；帧内只有 `setChatMessage`，批量语义容易改坏消息链 |
| 世界书条目级读写 `createentry findentry getentryfield setentryfield wi-*` | 12 | Palink 世界书只有"整本替换"（`createOrReplaceWorldbook`），没有条目级 CRUD |
| 注入 / 生成 / 翻译 `inject listinjects flushinject genraw stop abort speak translate summarize caption ask imagine-*` | 23 | 需要宿主注入存储 / Extras sidecar（已删，端点恒 502） |
| 闭包序列化 / 加载器 / 杂项 | 17 | `closure-serialize` 需要 ST 的闭包 AST 序列化；`loader-*` 已有帧内实现但未注册到引擎 |
| 其他（`?` `profile-*` `regex*` `rename-char` `tag-*` `tokenizer` `trimend` `trimstart` `sysgen` `sysname` `start-reply-with` `reroll-pick`） | 23 | `profile-*` / `regex*` / `getchatname` / `branch-create` 由 `runPalinkSlashCommands` 处理（`triggerSlash` 可命中，但不在引擎注册表里，故不计数）；`trimend` / `trimstart` 属"截到句子边界"的文本语义，本轮未实现 |

**其中三条最容易补、下一轮建议优先**：`trimend` / `trimstart`（纯文本，ST 有明确实现）、
`loader-*`（帧内已有 `loader.show/hide`）、`tokenizer`（= `tokens` 的别名）。

### 7.2 getContext 剩下 14 项非真可用，逐条理由

| 键 | 现状 | 为什么本轮不动 |
|---|---|---|
| `getRequestHeaders` | `stubApi` 恒 `{}` | **安全决策，待主控拍板**。给真实头 = 把会话凭据暴露给 opaque origin 帧，与 P1-1 沙箱红线冲突 |
| `renameChat` | `stubApi` 假成功 | 宿主 action 表无改名动作，需先加后端端点 |
| `appendMediaToMessage` `getMediaDisplay` `getMediaIndex` `scrollOnMediaLoad` | `stubApi` | 媒体展示态由 React 组件持有，帧内无读源；映射需要新通道 |
| `reloadWorldInfoEditor` `updateWorldInfoList` | `stubApi` | 世界书编辑器是宿主 UI，帧内无对应界面 |
| `convertCharacterBook` | `stubApi` 恒等 | 后端已按 ST 形状存，恒等其实语义正确；但 `entries` 是数组还是对象未核，**不敢凭猜改** |
| `getWorldInfoPrompt` | `stubApi` 恒 `''` | 注入走后端 `worldbook_service`，客户端返回 `''` 是正确语义，不是缺陷 |
| `getTextGenServer` | `stubApi` 恒 `''` | Palink 无 textgen 服务器，`''` 是正确值 |
| `getChatCompletionModel` | `stubApi` 恒 `''` | 真值在 `generationEngine`，但 ST 的签名是**同步**返回字符串；桥是异步的，改成 async 会破坏调用方。需要宿主侧预置一份模型名到 boot context |
| `ChatCompletionService` `TextCompletionService` | 空 class | 构造 + 实例化不炸即可；补齐方法需要 ST 的 completions 管线语义，属"看起来对实际错"高危区 |

> `groups=[]` / `tags=[]` / `tagMap={}` / `groupId=null` / `streamingProcessor=null` 是**合法空值**
> （本角色无群组无标签），按 HANDOFF §1.3 未动。

---

## 8. 待主控拍板

1. **`getRequestHeaders`**：是否给真实认证头？给了就是把 `palink_session` / `palink_csrf` 送进 opaque origin 帧。
   建议维持 `{}` 并在插件管理页明示。
2. **`chatCompletionSettings` 的语义边界**：当前是"以 `presetData` 为基底 + `runtimes.is_function_call_enabled`"。
   若 MVU 之后依赖更多 ST 专有字段（`chat_completion_source` 等），需要逐个确认映射而不是批量塞。
3. **`/add` 语义变更**：帧内原本把 `/add` 当"追加消息"（Palink 自有语义），本轮按 ST 改为数值求和。
   若线上有卡片依赖旧语义，需要回退——目前 5 个测试插件与目标角色未出现依赖。
4. **是否继续补 §7.1 的"下一轮优先三条"**（`trimend`/`trimstart`、`loader-*`、`tokenizer`）。

---

## 9. 遗留风险

- **`primeSlashKnownNamesCompat` 是异步的**：帧加载后约一次 RPC 的时间窗内，
  `Object.keys(SlashCommandParser.commands)` 只含插件注册项。卡脚本若在 `DOMContentLoaded`
  立刻枚举命令表，可能看到不完整列表（执行不受影响，`executeSlashCommands` 走的是桥，不依赖这张表）。
  观测面：`window.__palinkSlashKnownNames`。
- **`/help` 拉取失败时**（宿主未就绪），视图退化为"只有插件注册项"——行为等同修复前，不会更糟。
- **`dist` 已重建**（`VITE_OUT_DIR=dist_new` → 增量 `cp` → `gzip-dist`），未跑 `npm run build`。
  ⚠️ **产物同时包含包 A 的 srcdoc 瘦身**：包 A 于 11:57 提交 `3bc9cb7`，其源文件在 11:55:28 仍在修改，
  而本包第一次构建跨了那个时间点 ⇒ **已从 HEAD（`3012820`，含 A+B 两笔提交）重建一次**，
  重建后复跑真机探针，全部数字与首轮完全一致（`objKeys=135 / covered=87 / present=145 / nonReal=14`，
  宿主高度 `[1569,1627,1611,2284,4555]` 两次采样相同，toast `(none)`）。
  ⇒ 报告里的"完工后"数字来自**可复现的干净构建**，不是半成品混合体。
  当前入口 chunk：`assets/index-*.js`；卡片运行时：`assets/palink-smart-card-runtime-*.js`（按内容 hash，重建后自动更新）。
- **`.tmp_probe/` 下保留了全部探针与输出**（`probe-*.js`、`out*.txt`、`st-commands.json`、`engine-names.json`），
  供复核；该目录在 gitignore 内。
