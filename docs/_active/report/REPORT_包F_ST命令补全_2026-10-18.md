# REPORT 包F — ST 斜杠命令补全 + 枚举口径修复（2026-10-18）

> 状态：**已完工待验收**（代码已入库两笔 commit，容器未重建 ⇒ 真机 16000 仍是旧码，见 §5）
> 任务书：`docs/_active/HANDOFF_提示词_包F_ST命令补全_2026-10-18.md`
> 背景基线：`docs/_active/report/REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`
> 接手说明：上一位同包 agent 预算耗尽、零提交；本包直接复用了它留下的静态真值表
> （`frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json` + README），
> 未重做抽取。

## 1. 一句话结论

F-1 把「命令枚举口径」从 *宿主 `/help` 文本* 改成 *ST 1.18 权威名单（宿主注入）+ `/help` 补漏*，
真机覆盖数 **covered_in 87/289 → 289/289**、`Object.keys(commands)` **135 → 340**；
F-2 在宿主引擎补了 **6 条**可验证的真实现（4 条 A 类纯函数 + 2 条 B 类薄转发），
其余 202 条按 C/D 类不注册（存在性有、执行为 Unknown command，不是假成功）。

**交接单的「A 类约 90 条」这个口径与 ST 1.18 参照源码不符**，不符项逐条见 §4。

## 2. 改前 / 改后实测（真机，露缇雅 `c28061bb-a9b7-46a9-a255-2692d57001fc`，7 帧）

探针：`.tmp_probe/probe-parity3.js`（原样）+ `.tmp_probe/probe-parity3-f.js`（我加的变体：
把入口换成被测地址，并在帧内实调 4 条命令取样）。运行方式：`playwright-cli open <url>` 与
`run-code --filename=…` 写在同一条 bash 命令里，输出重定向到文件再读。

| 指标 | 改前 | 改后 |
|---|---|---|
| `cmdKeysLen`（`Object.keys(commands)`） | 135 | **340** |
| `covered_in`（289 名中 `in commands` 命中） | 87 | **289**（验收线 ≥180） |
| `covered_keys` | 87 | **289** |
| `covered_hasVal` | 87 | **289**（与 covered_in 相等，不虚） |
| `notInCount` | 202 | **0** |
| 帧内 `/trimend Hello, world! I am from` | `""` | **`"Hello, world!"`** |
| 帧内 `/trimstart This is a sentence. And here is another.` | `""` | **`"And here is another."`** |
| 帧内 `/add 10 20 30` | `"60"` | `"60"`（包B 既有，不变） |
| 帧内 `/bg blue`（C 类） | `""` | `""`（引擎报 Unknown，折成空串 ⇒ 不假成功） |

⚠️ **改前/改后不是同一个入口**，这是本次实测最重要的口径说明：

- 改前那列跑在 **`http://localhost:16000`**（docker nginx → `frontend/dist`，旧码），两次跑
  都稳定给出 87/135，与交接单 §1 基线逐字相符。
- 改后那列**不能**跑 16000：本包边界是「不碰 `frontend/dist`、不 `npm run build`、不重建镜像」，
  而 16000 服务的正是 dist ⇒ 它永远显示 87。为了拿到真浏览器的改后数，我在
  `.tmp_probe/vite.fprobe.config.ts`（未入库）里复用仓库 `vite.config.ts` 的插件与别名，
  只把 dev server 的 `/api` 代理指向已跑着的 `localhost:16000`（原配置 target 是 docker 内网
  主机名 `backend:8000`，宿主机解析不到），起 `npx vite --config … --port 5199` 后跑同一个探针。
  ⇒ **改后数据 = 真 Chromium + 真 iframe + 真 postMessage 桥 + 当前工作区源码**。
  全程零计费：加载角色页不触发生成端点，`/translate`、`/summarize` 的真机取样未做（见 §6 待办）。
- dev server 用完已 `taskkill` 关闭（PID 57616），`.tmp_probe/` 产物不入库。
- **主脑重建 dist 后必须在 16000 复跑一次**这张表，才算"上线生效"（AGENTS.md「提交 ≠ 上线」）。

srcdoc 单帧字节数：**未变**。走的是宿主注入（`getStCompatCommandNames` 动作），
293 个名字没有进模板串；契约测试 `F-1 源码接线` 一条直接断言模板里不含名单字面量。

## 3. F-1 改了什么（commit `0988a7d`）

1. `frontend/src/lib/slash-engine/st-command-catalog.ts`（新）：293 个权威名，
   与静态真值表逐字相等，漂移由测试拦。
2. `frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts`：
   新增只读动作 `getStCompatCommandNames`，返回 `{ names: [...] }`。
   **必须包对象**：帧内 `requestParent` v2 对顶层数组/字符串做对象展开（MEMORY.md
   「智能卡关键接缝」），裸数组会变成索引键。
3. `runtime-body/part-07.ts`：`primeSlashKnownNamesCompat` 先取种子名单、再接 `/help` 补漏；
   Proxy 的 `has()` 与 `in` 判定口径对齐（此前 `view.has('bg')` 假而 `'bg' in view` 真，自相矛盾）。
   未实现的名单项仍是 `synthesizeSlashEntryCompat` 合成 entry ⇒ 执行照旧 Unknown command。
4. fixtures 入库：
   - `frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json` —— **探针口径 289 名**，
     从 `.tmp_probe/st289.json` 搬来（原文件留在探针目录，其他 agent 还在用）。
     后续维护：升 ST 参照源码 → 重跑抽取器刷新静态真值表 → 若探针名单要跟着变，
     改这个 JSON 并同步 `.tmp_probe/probe-parity3.js` 里内联的那份数组。
   - `frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json` + `README.md`
     —— **权威来源**（core 220 / extension 73 / 唯一名 293 / aliases 176），
     抽取器 `.tmp_probe/extract_st_commands_E1.py`（`py … --write` 可重跑）。
     两份不一致时**以静态真值表为准**，`st289` 只当探针分母；README 已写明差集恰为
     `/`、`break`、`breakpoint`、`parser-flag` 四个解析器内部名。

## 4. F-2 补了什么、以及「交接单与 ST 源码不符」清单（commit `6a07b76`）

补进宿主引擎的 6 条（注册位置 `lib/slash-engine/st-compat-commands.ts`，**未写帧内**）：

| 命令 | 类别 | ST 出处 | Palink 落点 |
|---|---|---|---|
| `trimend` | A | `utils.js:883` + `slash-commands.js:2881` | 逐字移植（标点集合、空白回退、无标点只 trimEnd 都不改） |
| `trimstart` | A | `utils.js:914` + `slash-commands.js:2858` | 逐字移植，**含 ST 的怪癖**：`first` 起点取 `indexOf('.')`，为 -1 时 `!`/`?`/换行都不当切点，未"顺手修好" |
| `clipboard-get` | A | `slash-commands.js:3506` | `navigator.clipboard.readText`；无 API 或读失败 → warn/console.error + 空串 |
| `clipboard-set` | A | `slash-commands.js:3527` | `copyText` 两级口径（Clipboard API → textarea+execCommand 回退），返回空串（ST 明写） |
| `translate` | B | `extensions/translate/index.js:779-803` | `POST /api/extra/translate`（有 provider 时 `/api/translate/<provider>`），包C `st_extras.py:422/535/557` |
| `summarize` | B | `extensions/memory/index.js:1085-1105` | `POST /api/summarize {text, params.prompt}` → `{summary}`（包C `st_extras.py:378/383`） |

转发端点真实性核验（零计费）：`curl -X POST -d '{}'` 空体，
`/api/extra/translate` `/api/summarize` `/api/extra/caption` 均回 **403**（需登录），
对照组 `/api/nope-probe` 回 **404** ⇒ 三条路由确实注册在应用上，且空体不会触发模型调用。

### 4.1 交接单与 ST 1.18 参照源码不符（这些名字**不是**注册命令名，一律未实现）

交接单 §3.2 的 A 类清单里，下列名字在 `st-slash-commands-1.18.0.json` 的
`commands`（293）与 `aliases`（176）中都查不到，或只是别名：

| 交接单写的名字 | 静态抽取结果 | 处置 |
|---|---|---|
| `matches` | 不存在；ST 1.18 只有 `match`（`variables.js`） | **未实现**（`match` 包B 已做）；不造 `matches` 别名 |
| `titlecase` | 不存在（core/extension/aliases 全无） | 未实现。这是更新版 ST 才有的命令，硬编=自发明 |
| `array-foreach` | 不存在 | 未实现 |
| `array-map` / `array-filter` / `array-length` | 不存在（ST 1.18 只有 `array-wrap` / `array-unwrap`） | 未实现（后两条包B 已做） |
| `split` / `join` / `trim` | 不存在于 ST 权威表；它们是 **Palink 自有命令** | 不动、不覆盖（Palink 语义优先） |
| `delglobalvar` | 不存在于 ST；是 **Palink 自有命令** | 不动 |
| `listglobalvars` | 不存在；ST 用 `listvar scope=global` | 未实现（避免造 ST 没有的名字） |
| `wait` | 只是别名（`delay` 的 alias） | 不单独注册；`delay` 已在 Palink 引擎 |
| `getglobalvar` / `setglobalvar` / `addglobalvar` | 存在，但**包B 时已注册** | 已在引擎，非本包新增 |
| `sub mul div mod pow round min max sqrt cos sin` | 存在，已注册 | 同上（交接单把它们当"待补"，实际包B 已完成） |
| `echo` `flushinject` `listinjects` `context` `api` `api-url` | 存在；`echo` 已在引擎 | 后 4 条见 §4.2 |
| `abort` `beep` `input` `setinput` | 存在 | 见 §4.2 |
| `cut` `del` `comment` | 存在，但语义是**会话/消息操作**（`doMesCut` / `doDelMode` / `sendCommentMessage`），交接单归入"文本类"不成立 | 见 §4.2 |

⇒ 交接单「202 条未覆盖里约 90 条是纯逻辑 A 类」的判断，与参照源码静态抽取不符：
**实际可纯逻辑移植的只剩 4 条**（`trimstart` `trimend` `clipboard-get` `clipboard-set`），
其余都要 UI、会话对象、私有数据模型或后端能力。

### 4.2 未补项逐族理由（名字在场、实现缺席）

按族列出（族名 + 该族全部命令名，由脚本从权威真值表与引擎注册表现场对账生成）：
| 族 | 条数 | 为何不补 | 命令名（逐条，脚本对账生成） |
|---|---|---|---|
| D 类 · ST 私有数据模型 | 39 | Palink 没这套对象，注册即写一条假记录（交接单 §3.1 D 类） | `checkpoint-create` `checkpoint-exit` `checkpoint-get` `checkpoint-go` `checkpoint-list` `checkpoint-parent` `closure-deserialize` `closure-serialize` `char-create` `char-delete` `char-duplicate` `char-find` `char-get` `char-update` `persona-create` `persona-delete` `persona-duplicate` `persona-get` `persona-lock` `persona-set` `persona-sync` `persona-update` `profile-create` `profile-genstream` `profile-get` `profile-list` `profile-update` `tag-add` `tag-exists` `tag-import` `tag-list` `tag-remove` `secret-delete` `secret-id` `secret-read` `secret-rename` `secret-write` `rename-char` `proxy` |
| D 类 · 世界书 / 提示词条目读写 | 13 | 书对象绑在会话上，宿主引擎回调拿不到会话；Palink 世界书走后端 REST，不在命令引擎里 | `getcharbook` `getchatbook` `getpersonabook` `getglobalbooks` `getentryfield` `setentryfield` `getpromptentry` `setpromptentry` `createentry` `findentry` `wi-get-timed-effect` `wi-set-timed-effect` `prompt-post-processing` |
| D 类 · 向量库 / 表达式数据集扩展 | 24 | 后端（包C）没有这些集合，实现即造假数据源 | `db` `db-add` `db-delete` `db-disable` `db-enable` `db-get` `db-ingest` `db-list` `db-purge` `db-search` `db-update` `expression-classify` `expression-fallback` `expression-folder-override` `expression-last` `expression-list` `expression-set` `expression-upload` `vector-chats-state` `vector-files-state` `vector-max-entries` `vector-query` `vector-threshold` `vector-worldinfo-state` |
| C 类 · quick-reply / 群成员 / 扩展开关 / regex | 39 | ST 自家扩展的状态机与 DOM 开关面板（交接单 §3.1 C 类） | `qr` `qr-arg` `qr-chat-set` `qr-chat-set-off` `qr-chat-set-on` `qr-contextadd` `qr-contextclear` `qr-contextdel` `qr-create` `qr-delete` `qr-get` `qr-list` `qr-set` `qr-set-create` `qr-set-delete` `qr-set-list` `qr-set-off` `qr-set-on` `qr-set-update` `qr-update` `qrset` `member-add` `member-count` `member-disable` `member-down` `member-enable` `member-get` `member-peek` `member-remove` `member-up` `extension-disable` `extension-enable` `extension-exists` `extension-state` `extension-toggle` `regex` `regex-preset` `regex-state` `regex-toggle` |
| C 类 · UI / DOM / 样式 / 弹窗 / 声音 | 32 | 卡内沙箱没有这些 DOM（`bg`/`panels`/`theme`/`loader-*`/`popup`/`ask`/`input`/`setinput`…） | `bg` `bgcol` `autobg` `lockbg` `unlockbg` `buttons` `panels` `resetpanels` `movingui` `theme` `css-var` `popup` `ask` `input` `setinput` `hide` `unhide` `show-gallery` `list-gallery` `pick-icon` `beep` `bubble` `flat` `single` `pm-render` `chat-render` `loader-hide` `loader-show` `loader-stop` `loader-wrap` `vn` `yt-script` |
| C 类 · 会话 / 消息运行时 | 51 | 要聊天对象、消息索引或 swipe 数组；宿主引擎只有命令表，没有 chat 句柄（交接单把 `comment`/`cut`/`del` 误归"文本类"） | `comment` `cut` `del` `messages` `message-name` `message-role` `chat-jump` `chat-manager` `chat-reload` `closechat` `newchat` `delchat` `delname` `renamechat` `tempchat` `branch-create` `addswipe` `delswipe` `go` `trigger` `test` `forcesave` `sendas` `start-reply-with` `stop-strings` `note` `note-depth` `note-frequency` `note-position` `note-role` `reasoning-collapse` `reasoning-expand` `reasoning-format` `reasoning-get` `reasoning-parse` `reasoning-set` `reasoning-template` `reasoning-toggle` `inject` `flushinject` `listinjects` `instruct` `instruct-off` `instruct-on` `instruct-state` `sysprompt` `sysprompt-off` `sysprompt-on` `sysprompt-state` `sysgen` `sysname` |
| C 类 · 生成链路与 ST 私有设置 | 23 | 引擎侧无 `_abortController`（ST 由解析器注入）、无 `power_user` / `extension_settings` / `mainApi` / 绘图与 TTS 扩展；`is-mobile` 需要 UAParser，硬编 UA 正则=自发明 | `abort` `regenerate` `genraw` `impersonate` `reroll-pick` `count` `tokenizer` `trimtokens` `is-mobile` `api` `api-url` `context` `imagine` `imagine-comfy-workflow` `imagine-source` `imagine-style` `speak` `tools-invoke` `tools-list` `tools-register` `tools-unregister` `stop` `reload-page` |
| 解析器内部名 | 4 | ST 用 fromProps 注册的 parser 自身项，不是用户命令；在场即可，无需实现 | `/` `?` `breakpoint` `parser-flag` |
| B 类 · 包C 端点已在但入参取不到 | 1 | `/api/extra/caption` 需要"当前消息的第 N 张图"（`mesId`/`index`），宿主引擎拿不到消息媒体 | `caption` |
| Palink 专有命令 | 1 | 由 `runPalinkSlashCommands` 先命中，不经 `SlashCommandEngine` 注册 ⇒ 静态对账里显示为"未注册"，实际可用 | `getchatname` |

对账（脚本现场跑，不是手数）：ST 权威 293 名中 **66 名在宿主引擎有真注册**（包B 60 名 + 包F 新增 6 名），**227 名仅“在场未实现”**；上表合计 227 = 227，零遗漏、零重复。

> “在场未实现” ≠ 缺口：F-1 之后它们在 `Object.keys(commands)` / `in` / `has` 上与 ST 一致，执行统一得到引擎的 `Unknown command: /x`，帧内 `executeSlashCommandCompat` 再折成空串（`part-07.ts` 既有口径）。这正是交接单 §2.2 要的「存在性与 ST 一致、执行不假成功」。

## 5. 门禁与反证

### 5.1 静态门禁

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit`（F-1 提交后） | **rc=0**，0 error |
| `npx tsc --noEmit`（F-2 之后） | rc=2，**2 处报错全在包G 的未跟踪文件** `src/components/ui/custom/smart-card-runtime/__tests__/g-getcontext-and-libs-contract.test.ts`（TS2339 `window.world_names`、TS2349 `never` 不可调用）；包F 自有文件 0 报错 |
| `npx vitest run`（F-1 提交前全量） | **83 文件 / 1056 passed / 3 skipped / failed=0 / errors=0** |
| `npx vitest run`（F-2 之后全量） | 85 文件 / **1105 passed / 3 skipped / 3 failed**；3 条 failed 全在包G 的 `g-getcontext-and-libs-contract.test.ts`（并行 agent 的 WIP，本包未触碰） |
| 包F 自有 4 个测试文件 | `st-command-catalog-contract` 15 例、`st-compat-commands-f2-contract` 20 例、`f-package-slash-enum-contract` 8 例、`b-package-slash-and-context-contract` 16 例 ⇒ **全绿** |

⚠️ 验收口径只认 `failed = 0` 且 `errors = 0`。当前工作区里有包G 的在建测试文件，
**全量门禁此刻必然不是 0**，这不是包F 的产物；包F 的 pathspec 在 F-1 提交时是全绿的
（上表第一/第三行）。主脑合并收尾时需要包G 自己把它的 3 条红修掉。

### 5.2 新增契约测试（交接单 §5.2 的 3 类）

1. **A/B 类每条新命令一个确定性用例** → `st-compat-commands-f2-contract.test.ts`（20 例）。
   期望值全部抄自 ST 源码并写明出处：`trimend` 用 utils.js:878 的 JSDoc 示例
   （`'Hello, world! I am from' → 'Hello, world!'`）、`trimstart` 用 slash-commands.js:2858
   的 helpString 示例（`'This is a sentence. And here is another sentence.' → 'And here is another sentence.'`），
   并额外锁住 `trimstart` 的 ST 怪癖（无 `.` 时 `!`/`?` 不切）。
   薄转发两条用 `vi.mock('@/services/api')` 打桩 ⇒ 测试零网络、零计费，断言打到
   `/api/extra/translate` / `/api/translate/google` / `/api/summarize` 的 URL 与 body。
2. **枚举口径测试** → 真机 `covered_keys = 289/289`（§2），源码级
   `f-package-slash-enum-contract.test.ts` 求值的正是 part-07 的真源码：
   `Object.keys(view)` 命中 289、`in` / `has` / `for...in` 同步、ownKeys 下限 293。
3. **红线测试** → `st-command-catalog-contract.test.ts` 对 C/D 类各抽 5 条
   （`bg bgcol panels theme chat-render` / `checkpoint-create closure-serialize char-create persona-delete db-search`）
   断言 `SlashCommandEngine.getCommand(name)` 为假 **且**执行输出含 `Unknown command`。

### 5.3 反证（§5.4 要求，两次输出都贴）

**(a) F-2 三条新命令**：临时删掉 `register('trimend')`、`register('clipboard-set')`、
`register('translate')` 三段注册（脚本按花括号配平切除，改前已备份
`.tmp_probe/st-compat-commands.F_backup.ts`，还原用 `cp`，未走 git 破坏性命令）。

改坏 ⇒ 必红：

```text
 ❯ src/lib/slash-engine/__tests__/st-compat-commands-f2-contract.test.ts (20 tests | 10 failed)
 Test Files  1 failed (1)
      Tests  10 failed | 10 passed (20)
rc=1
```

失败的 10 例：`trimend` 3 例、`clipboard-set` 1 例、`translate` 5 例、注册口径 1 例
（“新命令都注册进了宿主引擎”）。

还原 ⇒ 必绿：

```text
 Test Files  1 passed (1)
      Tests  20 passed (20)
rc=0
```

**(b) F-1 枚举种子**：把 part-07 里 `if (typeof seedName === 'string' && seedName) slashKnownNamesCompat.add(seedName);`
临时改成 `if (false && …)`（备份 `.tmp_probe/part-07.F_backup.ts`，`cp` 还原）：

```text
 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)      # prime 覆盖 / in·has·for-in / 合成桥 /help 并入
rc=1
```

还原后本包 4 个测试文件全绿（§5.1 末行）。值得记一笔的是：改坏时**“源码层含
`requestParent('getStCompatCommandNames')` 字符串”那两条仍然绿** ⇒ 证明守住行为的是
那 4 条求值真源码的用例，不是字面量断言。

## 6. 剩余项（下一位可直接接手）

1. **重建 dist 后在 16000 复跑 §2 那张表**（本包边界不许我 build）。判据：
   `cmdKeysLen ≥ 289`、`covered_in = 289`、`/trimend Hello, world! I am from` → `Hello, world!`。
   命令：`playwright-cli open http://localhost:16000/` 与 `run-code --filename=.tmp_probe/probe-parity3.js`
   写同一条 bash 命令，输出重定向到文件再读（`### Result` 在顶部）。
2. **`/translate`、`/summarize` 的真机取样**：dev server 那轮只做了枚举，没真调计费端点。
   复跑时必须 `page.route` 本地 fulfill `/api/extra/translate`、`/api/summarize`，不转发上游（红线）。
3. **`caption`**：包C 端点已在（`/api/extra/caption`，空体 403）。缺的是"从当前消息取第 N 张图"
   的引擎侧入参 —— 要么给 `SlashCommandEngine` 传会话句柄（改引擎签名，影响三条轨），
   要么在帧内 `part-07` 加一条本地分支（只有单间轨受益）。**本包两条都没做**，因为没有实测过
   任一条的代价，不做无把握的大改。
4. **`listvar scope=global`**：ST 的 `listglobalvars` 语义其实是 `listvar` 的 scope 参数，
   Palink `listvar` 未实现 `scope` namedArg（`variables.js:904-933` 有）。约 10 行，可单独收尾。
5. **aliases 未下发**：本次只把 293 个权威**命令名**注入帧内；176 个 alias 不在
   `Object.keys(commands)` 里（ST 亦然，alias 走 `getAliases`），如后续有插件按 alias 探测再说。
   > **订正（2026-10-20 主控，一手读 ST 源码后推翻本条括号的判断）**：`getAliases` 在
   > `_reference/sillytavern-1.18.0` 与 `/d/SillyTavern-release` 两棵树里**全树 0 命中**；
   > 别名是命令实例字段 `public/scripts/slash-commands/SlashCommand.js:56`，且注册时
   > **`SlashCommandParser.js:97-100`** 逐个 `this.commands[alias] = command` ⇒
   > **ST 的 `Object.keys(commands)` 本来就含别名**，本条括号写反了。
   > 真实偏离方向是**我们比 ST 少**这 175/176 个别名键。本条"如后续有插件按 alias 探测再说"因此作废，
   > 由 `pkg-AA` 按方案 A 补齐（同一对象、两个计数口径）。
   > ⚠️ 连带：主脑 2026-10-19 把这句错话抄进了排期 §2 第 9 条的"订正"里，等于**用订正传播错误**，
   > 已在那份文件上做二次订正。规矩回写：**二手结论进订正说明之前，自己读一遍源码。**
6. **包G 并行冲突提醒**：`.tmp_probe/F_*` 是本包产物（探针输出、备份、临时配置），不入库、可清理。

## 7. 边界与红线自查

- 命令**只注册进宿主** `lib/slash-engine/st-compat-commands.ts`，帧内零新增命令（§4 要求）。
- 未注册任何假实现：C/D 类不在引擎里，执行报 `Unknown command`；`has`/`in` 只反映"名字存在"。
- 与 Palink 已有命令同名的（`abs` `random` `sort` `pick` `length` `split` `join` `trim`
  `delglobalvar` 等）**一个都没覆盖** —— `register()` 遇到重名直接跳过（既有守卫）。
  本包 6 条新命令注册前均不在引擎里（测试“新命令都注册进了宿主引擎”反向守住）。
- `runtime-body/part-07.ts` 改动避开模板串三坑（裸反引号 / `${}` / 裸 `
`）：
  第一版注释里写了反引号，被 esbuild 直接打回（`Expected ";" but found "'x'"`），
  已改为纯单引号；`generated-script-parse-guard.test.ts` 4 例绿。
- 未碰 `frontend/dist`、未 `npm run build`、未重建后端镜像、未动包G 的 `part-08.ts`。
- 提交只用 `git commit -F <消息文件> -o -- <pathspec>`，两笔各 8 / 2 个文件，零 `git add -A`。
- fixtures 两份的用途差异写进了 `fixtures/README.md`（谁权威、差集是什么、怎么重跑抽取器）。

## 8. 同名冲突清单（交接单 §3.2 要求"发现冲突写报告"）

| ST 权威名 | Palink 已有同名 | 处理 |
|---|---|---|
| `abs` `random` `sort` `pick` `length` | Palink 内置（语义不同，如 `length` 是字符串长度、`pick` 是随机取一） | **不覆盖**（包B 已立规，本包沿用） |
| `split` `join` `trim` `delglobalvar` `downcase` `upcase` | 这些**根本不是 ST 1.18 的注册命令名**，是 Palink 自有 | 无需处理；交接单把它们列进 A 类待补是错的（§4.1） |
| `continue` `count` `test` `import` `go` `single` `flat` `bubble` | 名字在 ST 权威表里，但 Palink 引擎**没有**同名命令 | 不存在覆盖问题，只是"在场未实现"（§4.2） |

