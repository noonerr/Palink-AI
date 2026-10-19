# REPORT 包AA · 别名进表 / listvar 照 ST / TavernHelper 宏成员键（2026-10-20）

> **状态：已完工待验收（由主脑复验后上线）。**
> 本包**没有**重建 `frontend/dist`、**没有**点生成、**没有**花用户 API 余额、**没有**动容器；
> 上线动作（重建前端产物）留给主脑复验后执行。

- 收尾 agent：pkg-AA2（前一位 pkg-AA 源码写完即中断，本包补测试 + 记账 + 提交）
- 分支：`three-tracks-merge-20261012`
- 任务书：`docs/_active/HANDOFF_提示词_紧要批次甲类第一批与三项小收尾_2026-10-19.md`
- 中断现场：`_BACKUPS/2026-10-20_包AA中断现场/aa-uncommitted.patch`（+ 同目录 `probe/`）
- 对账产物：`.tmp_probe/AA/reconcile_out.txt`、`.tmp_probe/AA/alias_map.json`（176 条 alias→base）

## 0. 三笔提交（源码 + 测试成对）

| 笔 | 内容 | 提交 | 涉及文件 |
|---|---|---|---|
| A | 别名进 `commands` 表 | `8ac5568` | `lib/slash-engine/st-command-catalog.ts`、`SmartCardCompatController.ts`、`runtime-body/part-07.ts`（别名 6 个 hunk）、`__tests__/f-package-slash-enum-contract.test.ts` |
| B | `/listvar` 缺省与 `chat` 改判照 ST | `fe11053` | `lib/slash-engine/st-compat-commands.ts`、`__tests__/st-compat-commands-listvar-scope.test.ts` |
| C | `TavernHelper.registerMacroLike` 成员键 + 四项记账 | `e40aa65` | `part-07.ts`（H 段成员键 1 个 hunk）、`__tests__/h-tavernhelper-134-contract.test.ts`、`palink-diag.ts`（只改注释）、`REPORT_包H_TavernHelper广度_2026-10-18.md`、`SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` |

> 拆分说明：`part-07.ts` 同时承载 A（别名）与 C（成员键）两段改动，用
> `git apply --cached .tmp_probe/AA2/p7_alias.patch`（按 hunk 切分，7 个 hunk 里第 1 个属 C、其余 6 个属 A）
> 做到"源码与测试同笔入库"，`git add -A` 一次没用过。

## 1. 一手锚点（全部是照做依据，不是事后编的期望值）

**别名进表** —— `public/scripts/slash-commands/SlashCommandParser.js`（本机 `/d/SillyTavern-release`
与 `_reference/sillytavern-1.18.0` 同一份 1.18.0）：
- `:95` `this.commands[command.name] = command;`（主名进表）
- `:97-100` `command.aliases.forEach((alias) => { this.commands[alias] = command; });`
  ⇒ **别名同样是 `commands` 的键，且与主名指向同一个对象**（不是两份）
- `:79-82` 重名只 `console.trace` 告警、照样赋值 ⇒ 冲突不丢弃
- `SlashCommand.js:56` `aliases = []`（别名是命令实例上的纯字符串数组，`SlashCommandParser` 没有
  静态 `aliases`、也没有 `getAliases()` —— 已由 `z-package-slash-aliases-contract.test.ts` 6/6 钉住）

**`/listvar` 的 `scope`** —— `public/scripts/variables.js`：
- `:902-932` 注册处；`:914` `defaultValue: 'all'`；`:916` `forceEnum: true`；`:918-920` `enumList = all|local|global`
- `:263-302` 实现处；`:268` `scope = String(args?.scope || '').toLowerCase().trim() || 'all'`
- `:273-274` `includeLocal` / `includeGlobal` 判定；`:291-294` 载荷 `[{key,value,scope}]`（先 local 后 global）
- 非法值不抛错：`SlashCommandArgument.js:55`（forceEnum 定义）+ `SlashCommandAutoCompleteNameResult.js:119/188`
  （只喂自动补全）⇒ 未知 scope 走 `:273-274` 双假 = 空串

**宏成员键** —— `st-plugins/third-party/JS-Slash-Runner-main/@types/function/index.d.ts:98`
`readonly registerMacroLike` 就写在 **TavernHelper 的成员清单**里（同清单含 `deleteLorebook` 等）；
底层实现在 `runtime-body/part-03.ts` 的 `registerMacroLikeCompat`（窗口全局形态 2026-10-19 包Z 批次三已有）。

**Palink 侧落点**：
- `frontend/src/lib/slash-engine/st-command-catalog.ts:104` `ST_118_COMMAND_ALIASES`（176 条，`Object.freeze`）
- `:284` `getStCompatCommandAliases()`、`:289` `getStCompatCommandNames()`
- `SmartCardCompatController.ts:872` `result = { names: ..., aliases: ... }`
- `part-07.ts` 函数锚点：`slashKnownAliasesCompat` / `slashSynthEntryCacheCompat` 声明、
  `resolveSlashEntryCompat`（真注册 > 主名 > 别名折主名）、`primeSlashKnownNamesCompat`（种子带 aliases）、
  Proxy 的 `ownKeys` / `has` / `get`；H 段 `registerMacroLike: th134Bridge('registerMacroLike')`
  （⛔ 该文件是模板串：全程不写反引号与 `${`，注释里也不行）

## 2. 三个口径分开的数字（禁止混成一个数）

| 口径 | 数 | 从哪来 / 谁观测 |
|---|---|---|
| **权威主名数** | **293** | `ST_118_COMMAND_NAMES.length`；帧内 `window.__palinkSlashSeedNamesCount` **必须仍是 293**（本包没动这个口径） |
| **别名数（单独口径）** | **176** | `ST_118_COMMAND_ALIASES` 键数；帧内 `window.__palinkSlashSeedAliasCount` = 176 |
| **表内键数 `Object.keys(commands)`** | **469** | 293 ∪ 176（交集为 0，见 §3 复核）；本包前是 293 口径、包F 前只有 135 |
| **真实现数** | **≈93 / 289（本包未改变）** | 枚举面 ≠ 实现数：锚点 `docs/_active/report/REPORT_包K_富卡生态扩样_2026-10-18.md:95`（"289 ✅（⚠️ 枚举面，不是实现数，真实现 ≈93）"）与 `docs/_active/HANDOFF_分包派遣提示词_2026-10-18.md:13`。⇒ 表里能枚举到 469 个键 ≠ 宿主真实现了 469 条；帧内合成项的 callback 一律转发宿主（`executeSlashCommandCompat`），宿主不认的就返回未知，**本包没有把它伪装成成功**。 |

## 3. 别名对账复核（我不信探针文本，按导入的表重算了一遍）

对 `st-command-catalog.ts` 实际解析的结果，与 `.tmp_probe/AA/reconcile_out.txt` 逐条对上：

```
names= 293 uniqNames= 293 pairs= 176 uniqKeys= 176
intersection= []                      ← 主名与别名交集为 0（reconcile: intersection_names_aliases=0）✅ 复核通过
basesNotNames= []                     ← 每个别名都指向名单内的主名（reconcile: alias_base_not_authoritative=0）
unionTableKeys= 469                   ← reconcile: union_keys=469
multiBaseAliases= []                  ← 一个别名只会来自一处；5 个多主名别名（bind/lock/dupe/server/persona-data）
                                         已在 catalog 里按"后注册者赢"的 ST 语义定死单一 base
aliasEqualToBase= 0 selfRef= []       ← 没有 alias 与 base 同名
```

两棵参照树（`_reference/sillytavern-1.18.0` 与 `D:/SillyTavern-release`）扫出来的主名集与别名集
完全相等（`RESULT two_trees_bases_equal=True aliases_equal=True`），`fixture_aliases=176`。

## 4. 三条改判与新增覆盖（不删用例、不写恒真断言）

### 4.1 listvar（`st-compat-commands-listvar-scope.test.ts`，单跑 12 passed）
主脑撤销了自己写错的验收条件「不给 scope 与改前逐字节一致」，原 4 条"回归面"用例按 ST 行号改判：
1. 不给 scope ⇒ 等价 `scope=all`（`:914` + `:268`），并**反证**旧形状不再出现（`not.toBe(legacyOutput())`）；
2. `scope=chat` ⇒ 空串（`:918-920` 无 chat ⇒ `:273-274` 双假），与 `scope=bogus` 同口径；
3. `scope=local` ⇒ 只出局部表对象 `{"hp":"10"}`，且**不等于**缺省（缺省已是 all）；
4. 空表走缺省 ⇒ `[]`（`:291-294` 两组皆空）；单边分支仍为 `{}`。
   声明面同步收紧：`enumList` 从 `arrayContaining` 改为**恰好** `['all','local','global']` 且 `not.toContain('chat')`。

### 4.2 别名（`f-package-slash-enum-contract.test.ts`，单跑 16 passed）
新增 7 条执行型用例（全部 `new Function` 求值 `COMPAT_V2_RUNTIME_ARTIFACT` 里的真源码，不拿源码文本断言）：
① 枚举视图出现别名键（`Object.keys` / `in` / `has` / `for...in` 四种写法，抽样 `listchatvar`/`addchatvar`/
`background`/`dupe`/`persona-data`）；② `commands[alias] === commands[base]`（引用相等，174 条逐条断言）；
③ 主名口径仍 293、别名口径 176、两套账不串（别名键不出现在主名名单里，除 §4.4 的 `help`）；
④ 别名执行走**同一条**桥：`view.listchatvar.callback('scope=global')` → 宿主收到 `'/listvar scope=global'`，
且 `view.listchatvar.callback === view.listvar.callback`（不存在"能枚举但执行报未知"的分裂）；
另 2 条反证（宿主不下发 aliases ⇒ 退回 293 表形状、`AliasCount=0`；别名 base 不在名单 ⇒ 不凭空造键）
+ 1 条重名裁决实测。

### 4.3 宏成员键（`h-tavernhelper-134-contract.test.ts`，单跑 40 passed）
D 名单移出 `registerMacroLike`（注释引 `@types/function/index.d.ts:98` + `part-03.ts` 两条依据），
并加**正向**断言：`registered.has('registerMacroLike') === true` 与产物里存在
`registerMacroLike: th134Bridge('registerMacroLike')`（桥不是空壳）。
`z-package-macro-register.test.ts` 单跑 10 passed（注册生效 / `{unregister}` / 同 source+flags 去重 /
注销后失效 / 与 `{{}}` 宏先后顺序 / 非 RegExp 不注册 / 回调抛错不吞正文）。

### 4.4 实测发现的三处形状差异（记在测试注释里，没有靠改断言掩盖）
1. **`delete` 键被 Map 方法占位**：本仓视图是 Map 的 Proxy，`part-07.ts:1136-1143` 把
   `get/has/set/delete/clear/keys/values/entries/forEach` 直通 Map 本体；ST 的 `commands` 是普通对象、
   没这批方法 ⇒ `commands['delete']`（ST 里是 `del` 的别名）在属性路径上取到的是 Map 方法。
   键仍**可枚举**（`Object.keys`/`in`/`has` 都认），断言按现状钉住并写明差异。
2. **Palink 自有命令名 `help` 与 ST 别名 `help`（→ `?`）重名**：`resolveSlashEntryCompat` 优先级
   「真注册 > 主名 > 别名」，`/help` 解析会把 `help` 并进主名名单 ⇒ 该键被 `/help` 占住；
   `/help` 没贡献该名的形态下别名才折回 `?` 并与 `view['?']` 同一对象。两种形态各一条断言。
3. **Map 方法路径不解析合成项**：`view.get('del')` 与 `view.get('delete')` 都是 `undefined`
   （只有真注册进 `slashCommandStoreCompat` 的才走 `get`）。断言写的是"现状 = undefined"，
   不是恒真；若以后让 `get` 也走别名/合成解析，这条会红并提醒改口径。

## 5. 反证（每条改动至少一次；原始输出照抄，改坏 → 红 → 还原 → 校验和一致）

```
### 反证1 listvar 缺省改回 local            sed: rawScope || 'all'  → rawScope || 'local'
     × 不给 scope 等价于 scope=all（ST :914 defaultValue + :268 的 || "all"） 7ms
     × scope=local 只出局部表对象，且不等于缺省（缺省已是 all，两组载荷） 1ms
     × 空表走缺省（all）时形状是 []（ST :291-294 两组都为空） 1ms
 Test Files  1 failed (1)

### 反证2 ownKeys 去掉别名键                part-07: 删 `...slashKnownAliasesCompat.keys(),`
     × ① 枚举视图（Object.keys / in / has / for...in）都出现别名键 6ms
     × ② commands[alias] === commands[base]（同一个对象，不是两份合成项） 8ms
 Test Files  1 failed (1)

### 反证3 别名不返回缓存对象                part-07: `if (cached) return cached;` → 每次 new
     × ② commands[alias] === commands[base]（同一个对象，不是两份合成项） 6ms
     × ④ 别名执行走同一条桥（不许"能枚举但执行报未知"的分裂） 1ms
 Test Files  1 failed (1)

### 反证4 宿主不下发 aliases                SmartCardCompatController: 去掉 `, aliases: ...`
     × 宿主：控制器有 getStCompatCommandNames 落点，且返回对象包一层 names + aliases 6ms
 Test Files  1 failed (1)

### 反证5 摘掉 TavernHelper.registerMacroLike 成员键
     × D 类键一个都没注册（假实现红线；名单逐条来自报告 §3 分类全表） 4ms
 Test Files  1 failed (1)
```

还原后的校验和（`md5sum -c` 对照改坏前的快照，四个源文件全部 OK，工作区随后只剩测试/文档改动）：

```
frontend/src/lib/slash-engine/st-command-catalog.ts: OK
frontend/src/lib/slash-engine/st-compat-commands.ts: OK
frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-07.ts: OK
frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts: OK
```

三笔提交落地后 `git status --short -- frontend/src` 为空（本包范围内文件全部入库）。

## 6. 门禁与单文件读数

- `bash scripts/gate.sh frontend` → **`GATE_RC=0`**；
  `✓ 前端 tsc --noEmit` / `✓ 前端 vitest` / 「全部门禁通过」；
  `Test Files 101 passed (101)`、`Tests 1358 passed | 3 skipped (1361)` ⇒ **failed = 0、errors = 0**
  （3 例是转换前既有的 `it.skip`，不是本轮新增；日志 `grep -cE "^ *(FAIL|×)"` = 0）。
  原始日志：`.tmp_probe/AA2/gate.log`。
- 每个测试文件**单独跑**（0 用例的文件等于不存在，故逐条给数）：

| 文件 | 单跑结果 |
|---|---|
| `lib/slash-engine/__tests__/st-compat-commands-listvar-scope.test.ts` | 12 passed (12) |
| `smart-card-runtime/__tests__/f-package-slash-enum-contract.test.ts` | 16 passed (16) |
| `smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts` | 40 passed (40) |
| `smart-card-runtime/__tests__/z-package-slash-aliases-contract.test.ts` | 6 passed (6) |
| `smart-card-runtime/__tests__/z-package-macro-register.test.ts` | 10 passed (10) |
| `smart-card-runtime/__tests__/st-gap-ledger-guard.test.ts` | 17 passed (17)（D 组未因保留键名而红） |

## 7. 记账（四项，已全部随 C 笔 `e40aa65` 入库）

1. `h-tavernhelper-134-contract.test.ts`：D 名单移出该键 + 依据行号 + 正向断言。
2. `REPORT_包H_TavernHelper广度_2026-10-18.md`：**原文零删改**，两处下面加订正段 ——
   §3 终值（C 45→46、D 76→75，13+46+75=134 仍闭合）与 §4 算术表（上界 58→59，
   并写明"58 + 30 = 88"那段按旧口径保留原文、复算请用 59 + 30 ≈ 89，仍 < 110，本节结论不变）。
3. `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2 `macro_register` 行：标注
   "已实现（2026-10-20）：窗口全局形态 = 包Z 批次三、成员形态 = 包AA C"，附一手依据与本报告文件名。
4. `palink-diag.ts`：`ST_GAP_BY_NAME` 的 `registerMacroLike` **键名保留**（删键会红
   `st-gap-ledger-guard` 的 D 组，且历史卡调用仍按该 id 聚合），只在其
   `[ST-GAP:macro_register]` 注释里补"成员形态已实现于 2026-10-20 包AA C（`e40aa65`）"。

## 8. 遗留 / 交回主脑的事

- **上线**：本包只提交源码与测试，未重建 `frontend/dist`。按 AGENTS.md「提交 ≠ 上线」，
  主脑复验通过后需重建前端产物并确认容器在服务新指纹。
- §4.4 的三处形状差异是真缺口（尤其 `delete` 键被 Map 方法占位、`commands.get(alias)` 不解析别名），
  要不要照 ST 把 Proxy 的属性路径与 Map 方法路径分家，属**新议题**，本包擅自没改产品代码。
- 真实现数 ≈93/289 未动：表里 469 个键的"可枚举 ≠ 可实现"这条口径要继续在路线图里挂着，
  别被本包的 469 数字盖过去。
- `.tmp_probe/AA2/`（hunk 切分用的 `p7_alias.patch` 与 `gate.log`）为 gitignore 内的对账产物，未入库。
