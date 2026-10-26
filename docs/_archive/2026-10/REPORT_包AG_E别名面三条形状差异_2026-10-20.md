# REPORT 包AG-E · 别名面三条形状差异按 ST 补齐（2026-10-20）

> **状态：已完成并通过全量门禁**（`gate.sh frontend` rc=0；主脑可逐条独立复跑）。
> 派包：`docs/_active/prompt/PROMPT_对话包_批次D与E与H与I_2026-10-20.md` §批次E；
> 通用红线：`docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md` §0。
> 边界遵守：只改 `runtime-body/part-07.ts`（模板串）+ 其测试（f 包两条改判 + 新增 e 包测试）+ 本报告。
> **未碰** `part-08.ts` / `palink-diag.ts` / `SmartCardCompatController.ts` / `st-command-catalog.ts` / `frontend/dist*` / Docker。

## 0. 一手核实总表（三条都先核 ST 再动，锚点可复核）

参照树：`_reference/sillytavern-1.18.0`（本机一手，非二手转述）。

| # | 形状差异 | ST 一手锚点 | 结论 |
|---|---|---|---|
| ① | 别名键 `delete` 被代理当成 Map 方法直通 | `public/scripts/slash-commands/SlashCommandParser.js` 全文（1357 行）：`static commands = {}`（:44）；写入 API 仅 `addCommand`(:53) / `addCommandObject`(:65) / `addCommandObjectUnsafe`(:78)。对 `public/scripts` 全树 grep `deleteCommand` / `removeCommand`（排除 .min.js）**零命中** | ST 没有任何"删命令"公开路径 ⇒ **保持现状**，注释写清理由，不造"能删"行为 |
| ② | Palink 自有 `help` 与 ST 别名 `help`(→`?`) 撞名 | `public/scripts/slash-commands.js:658-661`（`name: '?'`、`aliases: ['help']`）；`SlashCommandParser.js:79-82`（重名只 `console.trace` 告警）+ :95/:99（照常赋值 ⇒ **后注册者覆盖**） | 有意偏离（比 ST 保守）：**自有 help（主名）优先**，已留注释 + 钉测试 |
| ③ | `commands.get(别名)` 不解析别名 | `SlashCommandParser.js:44`（普通对象）+ :105-107（`get commands()` 是 **parser 实例取值器**，不是 commands 对象的方法）⇒ ST 无 `.get()` | 我们的 `.get` 是**多出来的便利面** ⇒ 实现与 `[]` 同路径（内部一致性） |

## 1. 三条的处置明细

### ① `delete` 占位 —— 保持现状（无产品码行为变更）

ST 既无 `deleteCommand` 静态方法也无实例删除路径（全树 grep 零命中 + 全文通读双向确认）。
按派包口径"ST 没有对应语义就保持现状并写清理由，⛔ 不要自造'能删'的行为"：

- **行为不变**：`commands.delete` 继续是 Map 的删除方法；别名键 `'delete'`(→`del`) 被占位是已知形状差异（f 包既有记账不变）；`deleteProperty`（`delete commands[x]`）维持现状（Map 本体键可删，别名/主名来自宿主种子、视图层删不掉也不新造能力）。
- **写清理由**：`part-07.ts` get 陷阱新增注释段（含 ST 锚点 + "不造 deleteCommand、不摘别名键"的声明），`deleteProperty` 处加了指向注记。
- **测试钉住"没有新增删除能力"**：e 包 ① 组断言 `view/parser` 上均无 `deleteCommand`/`removeCommand`、枚举键里也没有它们；同时断言占位形状原样（`delete` 仍是函数、且不是 `/del` 的 entry）。

### ② `help` 撞名 —— 有意偏离，自有 help 优先

- **偏离记录**：`resolveSlashEntryCompat` 优先级处新增注释：ST 是"后注册者覆盖"（:79-82/:95/:99），我们让 Palink 自有 help（宿主真命令，经 `/help` 解析进主名名单）优先于别名 `help`→`?`——折到 `?` 会让 `/help` 行为漂移。
- **优先级被钉住**：e 包 ② 组三条执行型断言：形态 A（`/help` 贡献主名 ⇒ `view.help.name === 'help'`、不等于 `view['?']`、执行落到 `/help`）；形态 B（不贡献 ⇒ 回归 ST 别名语义，`view.help === view['?']`）；`.get` 路径同样落在自有 help 上（与 `[]` 一致）。⛔ 日后改成别名优先必红（反证 B 已实测）。
- 结论按派包落为"**我们比 ST 更保守**"，不是"照抄 ST 的后注册者覆盖"——本仓 help 是宿主命令，被别名盖掉会让 `/help` 指向 ST 的 `?`。

### ③ `commands.get(别名)` —— 实现同路径（本批唯一的产品码行为变更）

- **实现**：get 陷阱删除 `'get'` 的 Map 直通，新增 `if (prop === 'get') return (name) => resolveSlashEntryCompat(String(name));` —— 与 `commands[name]` 完全同一条解析（Map 本体 > 主名 > 别名），未知名返回 `undefined`（与原 Map.get 对未注册键的行为一致）。
- **报告声明（派包原文要求）**：**ST 无此方法，属我们额外提供的便利面**（`static commands = {}` 普通对象，:105-107 是实例取值器），不对外宣称是 ST 形状。
- **f 包改判（不是删断言）**：`f-package-slash-enum-contract.test.ts` 原两条"现状记账"（`view.get('delete')` / `view.get('del')` 恒 `undefined`，注释里预判过"把 view.get 改成也解析别名时它会红"）按新事实改判为 `toBe(view.del)`，并保留占位键/同对象其余断言；同块注释里的方法名清单同步去掉 `get`（它已不占位）。改判依据与一手锚点写进了测试注释。

## 2. 验收证据（原始行）

**新测试单跑**（`npx vitest run .../e-package-slash-alias-shape-deltas.test.ts`）：

```
 ✓ src/components/ui/custom/smart-card-runtime/__tests__/e-package-slash-alias-shape-deltas.test.ts (11 tests) 15ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

**受影响既有测试 + 两个守卫**（5 文件 44 用例，全绿；含改判后的 f 包 16 用例）：

```
 ✓ src/.../__tests__/runtime-body-template-literal-guard.test.ts (7 tests) 82ms
 ✓ src/.../__tests__/z-package-slash-aliases-contract.test.ts (6 tests) 11ms
 ✓ src/.../__tests__/e-package-slash-alias-shape-deltas.test.ts (11 tests) 15ms
 ✓ src/.../__tests__/f-package-slash-enum-contract.test.ts (16 tests) 34ms
 ✓ src/.../__tests__/generated-script-parse-guard.test.ts (4 tests) 26ms
 Test Files  5 passed (5)
      Tests  44 passed (44)
```

**全量门禁**（`bash scripts/gate.sh frontend`，rc=0）：

```
 Test Files  109 passed (109)
      Tests  1463 passed | 3 skipped (1466)
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest
  全部门禁通过。
```

（3 skipped 为存量，非本批新增；本批两个文件 0 skip、0 fail。）

**计数口径**（派包要求 `Object.keys(commands)` 不得改变）：

- 默认夹具（本批 e 包）精确钉 **469** = 293 权威主名 ∪ 176 别名（交集 0；`/help` 解析出的 Palink 自有 `help` 同时落在主名与别名两侧，只计一次）。改前改后都是 469（本批只动 get 陷阱取值路径，`ownKeys` 一行未碰——diff 可证）。
- 真机口径 **509** 不变：枚举面唯一数据源是 `ownKeys`（本批未动）+ 宿主 `/help` 实况 + 插件注册项，均不受 `.get` 取值路径影响。

**字面量守卫未被放宽**：`runtime-body-template-literal-guard` 7 用例全绿（反引号计数 2/`${` 白名单/奇数反斜杠三条判据全过）；新增注释里**没有写反引号、没有未登记 `${`**，白名单一行未改。

## 3. 两组反证（原始输出 + 还原后 git status）

**反证 A**（条目③非恒真）：把 `if (prop === 'get')` 临时退回 `target['get']` Map 直通 ⇒

```
 ❯ e-package-slash-alias-shape-deltas.test.ts (11 tests | 4 failed)
     × 优先级在 .get 路径上同样成立 …
     × 别名经 .get 解析到主名同一个对象 …
     × 主名 / 未知名 / 非字符串入参的形状与 [] 一致
     × 源码留痕：get 分支记录了"ST 无 .get、这是额外便利面"及同路径处置
 ❯ f-package-slash-enum-contract.test.ts (16 tests | 1 failed)
     × ② commands[alias] === commands[base]（同一个对象，不是两份合成项）
```

**反证 B**（条目②优先级非恒真）：在 `resolveSlashEntryCompat` 临时把别名解析挪到主名之前（模拟"顺手改成别名优先"）⇒

```
 ❯ e-package-slash-alias-shape-deltas.test.ts
     × 形态 A：/help 贡献主名 help ⇒ 视图里 help 是自有命令，执行落到 /help
     × 优先级在 .get 路径上同样成立（与 [] 一致，都落在自有 help 上）
 ❯ f-package-slash-enum-contract.test.ts
     × 重名裁决（实测）：help 被宿主主名占住；/help 没带它时别名才折到 ?
```

两组均已还原（`grep TEMP-REVERT` 零命中），复跑 5 文件 44 用例回绿；还原后 `git status --short -- frontend/src docs` 仅本批三个文件（2 改 1 新），无其他在途工作被碰。

## 4. 文件清单（对照批次边界）

| 文件 | 动作 | 属于 |
|---|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-07.ts` | 改（3 处注释段 + get 陷阱 `get` 分支实现 + `deleteProperty` 注记，共 +32/−10 行内） | 条目①②③ |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/f-package-slash-enum-contract.test.ts` | 改（2 条改判 + 1 处注释清单同步） | 条目③连带改判 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/e-package-slash-alias-shape-deltas.test.ts` | 新增（11 用例，三条各一组执行型断言 + 源码留痕断言） | 条目①②③ |
| `docs/_active/report/REPORT_包AG_E别名面三条形状差异_2026-10-20.md` | 新增（本文件） | 交付 |

## 5. 记账连带（HANDOFF §5）核查结论

- **§5.1 台账订正：无对应行可订**。三条差异历来不是 §2 的 D/C 类键（`grep 别名|alias|commands.get|deleteCommand` 于 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` 只命中 `macro_register` 一行，且已由包AA 标记"已实现"）⇒ 本批不产生"已实现"改判；一手锚点已按项目惯例落 `part-07.ts` 源码注释（只进不出，原文未删）。
- **§5.2 `ST_GAP_BY_NAME` 未动**（本批不涉及 TavernHelper 键；`palink-diag.ts` 一行未碰，`st-gap-ledger-guard` 在全量门禁里绿）。
- **§5.3 包H 计数不受影响**：TavernHelper 广度面（13+C+D=134）零改动。
- **§5.4 三口径分报**：权威主名 293 / 别名 176 / 表内键（默认夹具）469、真机 509（未变）——四个数互不混淆。

## 6. 做不到 / 没做清单（允许存在，不许藏）

- **真机（:16000）复跑 `Object.keys(commands)` 读数：未做**。理由：本批唯一可能影响枚举的代码路径是 `ownKeys` 陷阱，而它一行未动（diff 可证）；且 e/f 包测试跑的是与生产 iframe **逐字节相同**的求值后载体（`COMPAT_V2_RUNTIME_ARTIFACT`），469 为精确钉。主脑可独立复跑；如需真机旁路读数（`VITE_OUT_DIR=dist_e` + dev 探针），按派包纪律应由主脑裁量后再做。
- **`delete` 别名键的"ST 同形状"修复：按派包口径不做**（ST 无删命令公开路径 ⇒ 保持现状）。
- 本批未新增/未放宽任何守卫与 skip；未动 `frontend/dist*`、未重启 Docker、未点生成、未花 API 余额。
