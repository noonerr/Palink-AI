# REPORT — 批次P3：预设三键改**同步**契约 + 数据源改指 `generation_presets`（2026-10-21）

> **未达交付线：6.1 ①②③④（实机四项）、6.3② 的"实机 n 变回 0"那一条、6.4 的"CharacterCardRenderer.tsx diff 为空"那一条。**
> 这三条/四项没做到的原因**不是代码没写**，而是用户本轮明令「⛔ 不许启动或重启 Docker、不许重建
> `frontend/dist`、不许上线」—— 实机跑的是**部署前**的产物，本批的代码没进 dist 也没进后端镜像，
> 所以 6.1 那四条**物理上不可能在本轮取到改后读数**。可做的替代证据全部做了，见 §7.1。

执行件：`docs/_active/prompt/PROMPT_对话包_批次P3_预设三键改同步并接到用户在用的那份表_2026-10-21.md`。
上游底本：`docs/_active/report/REPORT_上线实测_包P与批次Q1与批次P2_2026-10-21.md` §2（主脑实机取证）。

---

## 1. 做了什么（文件:行号）

### P3-A 三个预设键改**同步**（帧内）

| 文件 | 行 | 改动 |
|---|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-07.ts` | 701 | 新增 `readPresetSnapshotCompat()`：读 `ctx.presetSnapshot`，缺快照 ⇒ `th134Warn` + `palinkDiagRecord({kind:'missing_api', name:'preset_snapshot_not_ready'})` 留痕后返回 null（**定义在 `tavernHelperTh134Compat` 对象字面量之外** —— 字面量里不能插语句） |
| 同上 | 907 / 912 / 917 | `getPresetNames` / `getLoadedPresetName` / `getPreset` 由 `async () => requestParent(...)` 改成**同步箭头**，读快照。失败语义：names ⇒ `[]`、loadedName ⇒ `null`（⛔ 不许 `undefined`）、getPreset 取不到 ⇒ **抛错**（d.ts `@throws`） |
| `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 212 | boot 载荷新增 `presetSnapshot: context.presetSnapshot \|\| null` |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | 360 / 417 / 444 / 448 / 483 / 503 | 宿主拉快照进 `presetSnapshot` state，并塞进 `liveContext`（→ context-update 热更）与 `bootContext`（→ srcdoc 内联） |
| `frontend/src/types/index.ts` | 317 / 416 | 新增 `SmartCardPresetSnapshot` 类型 + `CharacterSmartCardContext.presetSnapshot` |

### P3-B 数据源改指 `generation_presets`（后端）

| 文件 | 行 | 改动 |
|---|---|---|
| `backend/app/services/preset_overlay.py` | 49 | 新增 `PRESET_STORE = "generation_presets"` + 改指理由与共享行红线（文件头注释） |
| 同上 | 95 / 100 | 新增**唯一归属查询入口** `owned_generation_presets()` / `resolve_owned_generation_preset_by_id()`；SQL `user_id = :x` 天然排除 `user_id IS NULL` 的共享行 |
| 同上 | 209 | `set_selected_preset_name` 校验表改 `GenerationPreset`（键位仍是 `UserSetting.silly_tavern_settings` 的 `palink_prompt_preset.selected_name`，**零迁移**） |
| 同上 | 249 / 279 | `resolve_global_preset` / `resolve_global_preset_source` 改解析 `GenerationPreset`；**三层回落语义一字未改，只换表** |
| 同上 | 303 | `_preset_view`：`entries ← prompts_data`、`config ←` 生成参数那一坨；`id` 字符串化 |
| 同上 | 334 | `effective_preset` 响应新增 `base_store`（= `generation_presets`） |
| 同上 | 371 / 390 | 新增 `_st_preset_shape()` 与 `build_preset_snapshot()`（名单 + 当前生效份 + 按名索引一次算好，**只含本人行**） |
| 同上 | 460 | `write_overlay` 换基改解析 `GenerationPreset`；共享行/他人行 ⇒ `preset_not_found`（404） |
| `backend/app/api/prompt_manager.py` | 151 | 新增只读端点 `GET /api/prompt-manager/presets/snapshot`（声明在 `PUT /presets/{preset_id}` **之前**，否则被当 preset_id 吃掉） |
| 同上 | 253 | `base_preset_id` 收 `int \| str`（`GenerationPreset.id` 是整数主键），服务层统一转 int |
| 同上 | 100 / 122 / 245 | 三处 docstring 同步"解析表改指 / 共享行不可选 / 永不写 `generation_presets`" |

⛔ **没碰**：`/api/prompt-manager/presets` 四件套（保留、语义未改，本链只是不再依赖它）、
sandbox 表达式、`host-origin-policy.ts`、`backend/app/models/`、`core/migrations.py`。

---

## 2. 判据逐条（原样输出）

### 2.1 实机（❌ 未达 —— 部署被本轮硬约束挡住）

```
$ playwright-cli -s=p3-baseline run-code --filename=.tmp_probe/PQ_preset_shape.js
### Result
"A=getPresetNames:type=object tag=[object Promise] thenable=true len=n/a
 B=getLoadedPresetName:type=object tag=[object Promise] thenable=true len=n/a
 C=getPreset:type=object tag=[object Promise] thenable=true len=n/a
 AWAIT_NAMES=ok isArray=true n=0
 AWAIT_PRESET=keys=extensions,prompts,prompts_unused,settings"
```
这与主脑报告 §2.1 的**改前读数逐字一致** ⇒ 线上跑的仍是批次P2 的代码，本批未部署。

```
$ playwright-cli -s=p3-baseline run-code --filename=.tmp_probe/PQ_after_regression.js
FRAME_COUNT=7
F0..F6: styles=25 nonEmpty=25 withId=7 scripts=18 th=148 ctx=196
BILLING_BLOCKED=1
```
（同上：这是**未部署基线**，不是改后读数；主脑上线后可直接与这两段对。）

库侧前提复核（本批开工前自己在库里跑的）：
```
prompt_presets=0
generation_presets=27
shared_null_user=0
```
⇒ 主脑 §2.2 的前提**成立**，`generation_presets` 27 行 / 共享行当前 0 行（但 `presets.py:114-115` 的查询条件允许它出现，红线照立）。

### 2.2 门禁（✅）

```
$ bash scripts/gate.sh backend
2295 passed, 23 skipped, 431 warnings in 169.60s (0:02:49)
  ✓ 后端 pytest 通过
  ℹ️ junitxml 显示 failures=0 errors=0
```
```
$ bash scripts/gate.sh frontend
  ✓ 前端 tsc --noEmit
      Tests  1548 passed | 3 skipped (1551)
  ✓ 前端 vitest 通过
```
```
$ bash scripts/gate.sh docs
  ✓ 文档目录一致性
  ✓ ST 上游引用可复核（failed = 0）
$ py scripts/docs/gen_docs_catalog.py --check
[docs-catalog] OK     413 docs, catalog up to date
```
```
$ node scripts/docs/st-gap-ledger-reconcile.mjs
最终分类: A=13  C=74  D=47  (A+C+D=134)
[PASS] ② 分类闭合 — A=13 C=74 D=47，合计 134，键名零重复
[PASS] ②b 声明值核对 — 重放结果与订正段声明一致：C=74 / D=47（声明取自「批次P3：预设三键改同步 + 数据源改指（不挪档位）」原文）
SUMMARY: FAIL=0 WARN=0 ⇒ 平（exit 0）
```
```
$ cd frontend && npx tsc --noEmit   → 无输出（干净）
```

---

## 3. 反证（先红、再还原、再绿）

### ① 三键改回返回 Promise ⇒ "不得是 thenable" 三条红（✅）

改法：`part-07.ts` 三成员 `X: () => {` / `getPreset: (presetName) => {` → `async` 版本。
```
× getPresetNames 的返回值不得是 thenable
× getLoadedPresetName 的返回值不得是 thenable
× getPreset 的返回值不得是 thenable（'in_use'）
AssertionError: expected 'function' not to be 'function' // Object.is equality
 ❯ p2-preset-read-keys-frame.test.ts:116:36   （另两条 :123 / :130）
      Tests  16 failed | 3 passed (19)
```
还原后：`Tests  19 passed (19)`。

### ② 基座解析退回 `PromptPreset` ⇒ 实机 n 变回 0（⚠️ 实机未做，测试级等价反证已做）

实机那一条**本轮不可达**（要部署）。做了等价的测试级反证：把 `build_preset_snapshot` 的名单查询
退回 `prompt_presets` ⇒ 快照名单变空：
```
E       AssertionError: assert [] == ['平衡']
E         Right contains one more item: '平衡'
E       tests\test_p3_preset_generation_source.py:215: AssertionError
E       AssertionError: assert [] == ['我自己的']
E       tests\test_p3_preset_generation_source.py:200: AssertionError
FAILED tests/test_p3_preset_generation_source.py::test_shared_row_is_absent_from_snapshot
FAILED tests/test_p3_preset_generation_source.py::test_snapshot_shape_is_st_preset
```
（另做过一次更狠的：把 `owned_generation_presets` 整体退回 `PromptPreset` ⇒ 17 例红。）
还原后：`13 passed`。

### ③ 摘掉共享行（`user_id IS NULL`）拒绝逻辑 ⇒ 越权用例红（✅）

改法：`owned_generation_presets` 的条件加上 `| (GenerationPreset.user_id == None)`。
```
E       AssertionError: {"source":"session","name":"共享预设", ... "is_session_copy":true}
E       assert 200 == 404
E       tests\test_p3_preset_generation_source.py:153   （换基用共享行 id）
E       tests\test_p3_preset_generation_source.py:171   （换基用共享行名字）
E       AssertionError: {"selected_name":"不可选的共享预设", ...}
E       assert 200 == 404
E       tests\test_p3_preset_generation_source.py:181   （选中共享行）
E       assert <GenerationPreset object> is None        （共享行顶上来当回落）
E       AssertionError: assert '共享不进名单' not in ['共享不进名单', '我自己的']
FAILED test_shared_row_cannot_be_used_as_overlay_base / test_shared_row_by_name_is_also_rejected / ...（共 5 条）
```
还原后：`13 passed`。

---

## 4. 共享行越权用例的实测结果（✅）

`backend/tests/test_p3_preset_generation_source.py`（13 例全绿）里四条越权相关：

| 用例 | 断言 | 结果 |
|---|---|---|
| `test_shared_row_cannot_be_used_as_overlay_base` | 拿共享行 id 换基 ⇒ **404**，且 `chat_variables` 里**一个覆盖层行都不许落**（`rows == []`） | ✅ 404 + 零落行 |
| `test_shared_row_by_name_is_also_rejected` | 按**名**换基同样 404（这条路最容易漏：`presets.py` 的列表是含共享行的） | ✅ 404 |
| `test_shared_row_is_not_selectable_as_global` | 共享行不可被"选中"为全局默认 | ✅ 404 |
| `test_shared_row_never_becomes_global_fallback` / `test_shared_row_is_absent_from_snapshot` | 本人一份都没有时共享行**不许顶上来**；快照名单只含本人那份 | ✅ None / `names == ["我自己的"]` |

---

## 5. 台账追加节的位置

- `docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` → **§2.7**（追加在文末，即 §2.3 之后；§2.3/§2.3.1/§2.6 一行没动）。
- `scripts/docs/st-gap-ledger-reconcile.mjs` → `MOVES` 新增一条 **`keys: []` 的说明条目**（`批次P3：预设三键改同步 + 数据源改指（不挪档位）`），`CHRONO` 末尾加 `'批次P3'`。
  ⚠️ 只加说明不加移动 ⇒ A/C/D **仍闭合到 13/74/47 = 134**（加了假移动 ②b 立刻红，已验证不红）。
- `docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md` → **§10 订正段**（追加，行 407-434），
  里面写了 `C = 74 → 74`、`D = 47 → 47`、`13 + 74 + 47 = 134`（②b 的声明值从这里抠）。

---

## 6. 测试

| 文件 | 例数 | 说明 |
|---|---|---|
| `frontend/.../__tests__/p2-preset-read-keys-frame.test.ts` | **19** | 执行型，用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`。含**三条 thenable 断言**（本次 P1 的正面判据）+ 快照缺失 ⇒ `[]`/`null` + `palinkDiag` 留痕 + 三键不发起 requestParent |
| `frontend/.../__tests__/p3-preset-snapshot-source.test.ts` | **9**（新增） | 宿主侧：URL（带/不带 session_id、`__pending__`、编码）、⛔不再消费 `/api/prompt-manager/presets`、蛇形→驼峰搬运、缺数据保留空容器与 null |
| `frontend/.../__tests__/p2-preset-read-keys-parent.test.ts` | **14** | 数据源改指后同步更新：mock 改到 `/presets/snapshot`，并新增一条"不得再打 `/api/prompt-manager/presets`" |
| `frontend/.../__tests__/h-tavernhelper-134-contract.test.ts` | **47** | **守卫改写（未删）**：旧断言"三键有 `requestParent` 直连桥"改同步后必然失效 ⇒ 改成钉 ① 键还在 ② `X: (` 同步箭头 ③ `X: async` 不存在 ④ 无直连桥 ⑤ `ctx.presetSnapshot` 在场 |
| `backend/tests/test_p3_preset_generation_source.py` | **13**（新增） | 改指锚点 + `prompt_presets` 行不再被消费 + 4 条共享行越权 + 快照形状 + 零迁移自证 |
| `backend/tests/test_preset_selection_global.py` / `test_session_preset_overlay.py` / `test_preset_overlay_internal_key_isolation.py` | 8 / 6 / 5 | 预设行随数据源一起改到 `generation_presets`（`_mk_preset` + 断言），语义不变 |

用到求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT` 的文件：
`p2-preset-read-keys-frame.test.ts`、`h-tavernhelper-134-contract.test.ts`（本批改动的两个）。

模板串守卫（帧内改了模板串，必跑）：
```
✓ runtime-body-template-literal-guard.test.ts (7 tests)
✓ generated-script-parse-guard.test.ts (4 tests)
✓ runtime-source-carrier-fidelity.test.ts (17 tests)
```

---

## 7. 没做的事与原因 / 否证主脑

### 7.1 没做的事

1. **实机四项（6.1 全部）**：被用户本轮硬约束挡住（不许启动/重启 Docker、不许重建 `frontend/dist`、不许上线）。
   ⇒ 本批代码**没有进 dist、也没有进后端镜像**，实机只能读到批次P2 的产物（§2.1 的读数已逐字复现）。
   **主脑上线后请自己复跑** `.tmp_probe/PQ_preset_shape.js` 与 `PQ_after_regression.js`；预期
   `thenable=false` ×3、`AWAIT_NAMES` 是**同步数组且 n ≥ 1**（admin 在 `generation_presets` 里有 3 行：平衡/自由/严谨）。
2. **6.3② 的实机部分**（基座退回 `PromptPreset` ⇒ 实机 n→0）：同上，做了测试级等价反证。
3. **6.4「`CharacterCardRenderer.tsx` diff 为空」**：❌ 没做到，因为**要把快照送进帧内 ctx 就必须改这个文件**
   （它是 srcdoc 构建与 context-update 投递的唯一宿主）。见 §8 的专项自证：**`sandbox` 表达式零改动**，
   且 `host-origin-policy.ts` diff 为空。

### 7.2 否证主脑（与执行件描述不一致的地方，1 条）

- 执行件 §P3-A 写"**宿主在 boot 上下文里带一份预设快照**"。实测本仓的 `srcDoc` useMemo
  **刻意不依赖 `bootContext`**（`CharacterCardRenderer.tsx:517-523` 的原注释：依赖它会让晚到数据触发
  iframe 整页重载 + 高度闪烁）⇒ **快照若晚于首帧到达，boot 内联那份不会被补进去**。
  ⇒ 真正保证到达帧内的是 **context-update 通道**（`postContextToFrame` → 帧内 `Object.assign(ctx, …)`）。
  两条通道写同一个 ctx 键，帧内不区分来源；语义上等价，但"boot 内联即可首帧可用"这句**在本仓不成立**，
  已在 SPEC §2.7 里标为实测偏差。未改设计（改它会引入 iframe 重载回归）。

### 7.3 一个实现选择（不是否证，供主脑裁定）

为了"名单与按名解析同源" + "共享行在服务端就被挡掉（父侧拿不到 `user_id`，挡不了）"，
新增了一个只读端点 `GET /api/prompt-manager/presets/snapshot`。执行件没预见到这个端点。
若主脑认为不该加面，可改成父侧拼装（代价：名单/按名两次拉取可能不同源 + 共享行只能靠父侧猜）。

---

## 8. 边界自证（原样输出）

```
$ git diff HEAD <新树> -- backend/app/models backend/app/core/migrations.py
=== A: models + migrations (应为零输出) ===
[END_A]                       ← 零输出 = 零迁移
```
```
$ git diff HEAD <新树> -- frontend/src/components/ui/custom/smart-card-runtime/host-origin-policy.ts
=== B: host-origin-policy (应为零输出) ===
[END_B]                       ← 零输出 = 没碰主机档
```
```
$ git diff HEAD <新树> -- .../CharacterCardRenderer.tsx | grep -in "sandbox"
[END_C rc=1]                  ← grep 无命中 = sandbox 表达式零改动
$ git diff --name-only HEAD <新树> | grep -Ei "frontend/dist|/models/|migrations.py"
[END_D rc=1]                  ← 无 dist、无 models、无 migrations
```
`CharacterCardRenderer.tsx` 的 47 行改动**全部是 presetSnapshot**（拉快照 / 进 liveContext /
进 bootContext / 进 boot 签名 / 两处 useMemo 依赖），逐处见 §1 表格。

---

## 9. 自查结果（执行件 §6 逐条）

### 6.1 功能面（实机）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 三键 `thenable=false` | ❌ **未做到** | 用户本轮明令不许重建 `frontend/dist` / 不许重启 Docker / 不许上线 ⇒ 线上仍是批次P2 产物。探针实测 `thenable=true` ×3（§2.1 原样输出，与主脑改前读数逐字一致）。**替代证据**：执行型单测（真产物 `COMPAT_V2_RUNTIME_ARTIFACT`）`p2-preset-read-keys-frame.test.ts` 19 例全绿，含三条 `expect(v && typeof v.then).not.toBe('function')`（:116/:123/:130） |
| 2 | `AWAIT_NAMES` 同步数组且 `n >= 1` | ❌ **未做到** | 同上（未部署）。探针实测 `AWAIT_NAMES=ok isArray=true n=0`。**替代证据**：后端 `test_snapshot_shape_is_st_preset` 断言 `names == ['平衡']`（即 ≥1）；admin 在 `generation_presets` 有 3 行（psql 实测） |
| 3 | `getPreset()` 键集合仍是四键 | ❌ **未做到**（实机） | 未部署。**替代证据**：后端 `test_snapshot_shape_is_st_preset` 断言 `sorted(keys) == ['extensions','prompts','prompts_unused','settings']`；帧内 `getPreset` 只透传快照里的整份对象，不改形状 |
| 4 | 逐帧回归 `FRAME_COUNT=7` / `th>=148` / `ctx=196` / `styles=25 nonEmpty=25` | ❌ **未做到**（改后） | 未部署；**改前基线**已取：`FRAME_COUNT=7`、F0–F6 `styles=25 nonEmpty=25 th=148 ctx=196`（§2.1），供主脑上线后对比。本批未动帧数/键数相关代码，前端 `th` 键数仍 148（`h-tavernhelper-134-contract` 断言 ≥55 且 134 表全覆盖） |
| 5 | 零 API 成本；未启动/重启 Docker；未重建 dist | ✅ | 全程只跑本地 pytest/vitest/tsc 与只读探针；`docker ps` 全程 5 个容器 `Up (healthy)`，本批**未执行**任何 `docker compose build/up/restart`；`frontend/dist` 未重建（只改 `src/`） |

### 6.2 门禁与账

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `bash scripts/gate.sh backend` rc=0 | ✅ | `2295 passed, 23 skipped` + `junitxml 显示 failures=0 errors=0` + `全部门禁通过` |
| 2 | `bash scripts/gate.sh frontend` rc=0 | ✅ | `✓ 前端 tsc --noEmit` + `Tests 1548 passed \| 3 skipped (1551)` + `全部门禁通过` |
| 3 | `bash scripts/gate.sh docs` rc=0；`py scripts/docs/gen_docs_catalog.py --check` | ✅ | `✓ 文档目录一致性` + `✓ ST 上游引用可复核（failed = 0）` + `[docs-catalog] OK 414 docs, catalog up to date` |
| 4 | `node scripts/docs/st-gap-ledger-reconcile.mjs` FAIL=0 WARN=0 且闭合 134 | ✅ | `最终分类: A=13 C=74 D=47 (A+C+D=134)`；`SUMMARY: FAIL=0 WARN=0 ⇒ 平（exit 0）` |
| 5 | `npx tsc --noEmit` 干净 | ✅ | frontend 目录内执行，无输出 |

### 6.3 反证

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 三键改回 Promise ⇒ 三条"不得是 thenable"红 | ✅ | `Tests 16 failed \| 3 passed (19)`，三条 `AssertionError: expected 'function' not to be 'function'`（:116/:123/:130）；还原后 `19 passed` |
| 2 | 基座退回 `PromptPreset` ⇒ 实机 `n` 变回 0 | ⚠️ **实机未做** | 部署被禁。**测试级等价反证已做**：`assert [] == ['平衡']` / `assert [] == ['我自己的']`（即 n=0）红；还原后 `13 passed` |
| 3 | 摘掉共享行拒绝 ⇒ 越权用例红 | ✅ | 5 条红（换基 id / 换基名 / 选中 / 回落 / 名单），含 `assert 200 == 404`；还原后 `13 passed` |

### 6.4 边界自查

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `git show --stat <提交>` 只含自己文件 | ✅ | 20 文件，`20 files changed, 1553 insertions(+), 200 deletions(-)`；无 `frontend/dist`、无 `backend/models/`、无 `migrations.py`（`git diff --name-only HEAD <树> \| grep -Ei "dist\|/models/\|migrations.py"` ⇒ 无命中，rc=1） |
| 2 | `models` + `migrations.py` diff 为空 | ✅ | §8 A：零输出 |
| 3 | `CharacterCardRenderer.tsx` + `host-origin-policy.ts` diff 为空 | ❌ **未做到**（前者） | `host-origin-policy.ts` 零输出 ✅；`CharacterCardRenderer.tsx` **有 47 行改动**（要把快照送进 ctx 必须改它）❌。**补偿证据**：该 diff 里 `grep -in sandbox` **零命中** ⇒ sandbox 表达式未动（§8 C） |
| 4 | 模板串守卫全绿 | ✅ | `runtime-body-template-literal-guard.test.ts (7 tests)`、`generated-script-parse-guard.test.ts (4 tests)` 全绿；另跑 `runtime-source-carrier-fidelity.test.ts (17 tests)` |
| 5 | 执行型测试用求值后载体 | ✅ | `p2-preset-read-keys-frame.test.ts`、`h-tavernhelper-134-contract.test.ts` 均 `import { COMPAT_V2_RUNTIME_ARTIFACT }` |
| 6 | 临时索引提交 + `unset` 后再 `reset` | ✅ | `GIT_INDEX_FILE=$PWD/.tmp_probe/_p3_index` → `read-tree HEAD` → 逐项 `git add` → `write-tree` → `commit-tree` → **`unset GIT_INDEX_FILE`** → `update-ref` → `git reset -q HEAD -- <自己的 path>`；提交后无幽灵 `MM`/`D` |

### 6.5 一句话

**该做的都做了，实机四项卡在"不许部署"这一条硬约束上 —— 上线后请主脑自己复跑
`.tmp_probe/PQ_preset_shape.js` 与 `.tmp_probe/PQ_after_regression.js`，预期 `thenable=false` ×3、
`AWAIT_NAMES` 为同步数组且 `n >= 1`（admin 在 `generation_presets` 有 3 行）。**
