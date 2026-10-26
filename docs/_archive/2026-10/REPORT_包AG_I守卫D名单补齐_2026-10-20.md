# REPORT 包AG · 批次 I — 守卫 D 名单补齐（27 个漏列键）

> 状态：**完成**。守卫 `forbidden` 24 → 51 键，对账脚本 ③ 从 `FAIL` 转 `PASS`（`FAIL=0 WARN=2`、rc=0）；
> 守卫单跑 47/47 绿；`bash scripts/gate.sh frontend` **rc=0**（tsc 绿 + 108 文件 1452 passed / 3 skipped）；
> 两组反证各红一次并已还原（md5 一致）。
> **唯一未提交项**：`palink-diag.ts` 的注释 4 行留在工作区（该文件正被批次 D 改着，`-o -- palink-diag.ts`
> 会把 D 的 277 行在途改动一并卷进我的提交）—— 详见 §7。
> 任务书：`docs/_active/prompt/PROMPT_对话包_批次D与E与H与I_2026-10-20.md` 的**批次 I**（D/E/H 不在本报告范围）。
> 复核方：主脑（Qoder「分配分包派遣任务」会话）。

---

## 1. 一句话结论

对账脚本点名的 27 个漏列键**逐条**进了 `h-tavernhelper-134-contract.test.ts` 的 `forbidden` 名单，
加完守卫**仍然全绿** —— 即这 27 个键此刻确实都**没有**注册（这正是"D 类"的定义），
没有出现"加进去就变红"的情形，因此**没有触发铁律里的"停下回报"分支**，也没有删键/放宽名单/改产品码。

## 2. 改了什么（逐条）

| 文件 | 改动 | 一手锚点 |
|---|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts` | `forbidden` 数组补 27 键（24 → 51），按族分组并加批次I 说明块（含"加键变红 = 已注册 = 必须改判而非删键"的反向红线） | 说明块 `:239-247`；数组 `:248-272`；27 键见 `:257-271` |
| `frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts` | **只改注释文字**：把"th134-names.json / st289-names.json"写成两份 fixture 的**实际路径**（`st289-names.json` 确实存在，4818 字节，在 `src/lib/slash-engine/__tests__/fixtures/`） | `:94-97` |

27 个键逐族（= 对账脚本 ③ 明细的机器输出，非手抄）：

| 族 | 族表键数 | 原先盯 | 补 | 补进来的键 |
|---|---|---|---|---|
| ST 预设体系 | 16 | 6 | **10** | `builtin_prompt_default_order` `createOrReplacePreset` `createPreset` `deletePreset` `getPresetNames` `getProxyPresetNames` `importRawPreset` `renamePreset` `replacePreset` `updatePresetWith` |
| 酒馆助手音频播放器 | 8 | 3 | **5** | `appendAudioList` `getCurrentAudio` `pauseAudio` `replaceAudioList` `setAudioSettings` |
| tavern regex 族 | 5 | 2 | **3** | `isCharacterTavernRegexesEnabled` `replaceTavernRegexes` `updateTavernRegexesWith` |
| ST 扩展安装体系 | 9 | 4 | **5** | `getExtensionStatus` `getExtensionType` `reinstallExtension` `uninstallExtension` `updateExtension` |
| ST 原始对象导入器 | 2 | 1 | **1** | `importRawTavernRegex` |
| 预设提示词类型判定 | 3 | 0 | **3** | `isPresetNormalPrompt` `isPresetPlaceholderPrompt` `isPresetSystemPrompt` |

**加之前做过的事（防"加进去才炸"）**：27 键逐个在 `runtime-body/` + `frame-shim/` 里 grep，
**27/27 全部 0 命中**（含 `legacy-st-sim-parts`）。这条是"D 类"的判据：没注册才该进 D 名单。

## 3. 验收：对账脚本前后两次原始输出

命令：`node scripts/docs/st-gap-ledger-reconcile.mjs`
（改前那份是用 `git show HEAD:<守卫路径>` 临时还原成 HEAD 版跑出来的，跑完立刻还原我的版本，md5 见 §5）

### 3.1 改前（rc=1）

```text
最终分类: A=13  C=70  D=51  (A+C+D=134)
守卫: D 名单 24 键, 正向锚点 22 键, 并集 46

[PASS] fixture — 权威分母 th134-names.json = 134 个唯一键
[PASS] ② 分类闭合 — A=13 C=70 D=51，合计 134，键名零重复
[WARN] ②b 声明值核对 — 报告声明的 C/D 与键名实测不符（需主脑定，脚本不自行改判）
[PASS] ① 台账可用 — 17 个 id 与 ST_GAP_IDS 双向对齐，每个 id 都有键名或族表说明
[PASS] ③b 守卫自身过期 — D 名单 24 键全部仍是 D 类
[FAIL] ③ 守卫漏列 — 守卫（D 名单 ∪ 正向锚点）没覆盖到 27 个 D 类键 —— 这些键被塞成空壳时守卫看不见
[PASS] ④ 名字表 — 101 个名字：74 个命中 134 分母且 id 全在 ST_GAP_IDS；27 个是斜杠命令形状
[WARN] ④c 斜杠侧分母缺失 — 27 个名字只能按"斜杠命令形状"校验，无法对权威 289 分母逐条核

③ 守卫漏列明细（族 → 漏掉的键名）:
  酒馆助手音频播放器（Palink TTS 是逐条消息合成，没有曲列表/播放队列状态机） (5/8 漏): appendAudioList, getCurrentAudio, pauseAudio, replaceAudioList, setAudioSettings
  ST 预设体系（Palink 模型/预设结构不同，补了是"形状对语义错"） (10/16 漏): builtin_prompt_default_order, createOrReplacePreset, createPreset, deletePreset, getPresetNames, getProxyPresetNames, importRawPreset, renamePreset, replacePreset, updatePresetWith
  tavern regex 族 (3/5 漏): isCharacterTavernRegexesEnabled, replaceTavernRegexes, updateTavernRegexesWith
  ST 扩展安装体系（Palink 无扩展安装/权限模型，口径 c 已拍板） (5/9 漏): getExtensionStatus, getExtensionType, reinstallExtension, uninstallExtension, updateExtension
  ST 原始对象导入器（新建聊天 / 新建正则对象，写侧父动作不存在） (1/2 漏): importRawTavernRegex
  预设提示词类型判定（依附 ST 预设对象模型） (3/3 漏): isPresetNormalPrompt, isPresetPlaceholderPrompt, isPresetSystemPrompt

SUMMARY: FAIL=1 WARN=2 ⇒ 不平（exit 1）
```

### 3.2 改后（rc=0）

```text
最终分类: A=13  C=70  D=51  (A+C+D=134)
守卫: D 名单 51 键, 正向锚点 22 键, 并集 73

[PASS] fixture — 权威分母 th134-names.json = 134 个唯一键
[PASS] ② 分类闭合 — A=13 C=70 D=51，合计 134，键名零重复
[WARN] ②b 声明值核对 — 报告声明的 C/D 与键名实测不符（需主脑定，脚本不自行改判）
[PASS] ① 台账可用 — 17 个 id 与 ST_GAP_IDS 双向对齐，每个 id 都有键名或族表说明
[PASS] ③b 守卫自身过期 — D 名单 51 键全部仍是 D 类
[PASS] ③ 守卫漏列 — D 类 51 键全部被守卫覆盖（D 名单 ∪ 正向锚点）
[PASS] ④ 名字表 — 101 个名字：74 个命中 134 分母且 id 全在 ST_GAP_IDS；27 个是斜杠命令形状
[WARN] ④c 斜杠侧分母缺失 — 27 个名字只能按"斜杠命令形状"校验，无法对权威 289 分母逐条核

SUMMARY: FAIL=0 WARN=2 ⇒ 平（exit 0）
```

⇒ ③ 的 `FAIL` 消失，`③b 守卫自身过期` 同时从"24 键"变"51 键全部仍是 D 类"（说明补进来的键没有一个是已归 C/A 的）。
**剩下 2 个 WARN 都是包AE 已交给主脑定的口径问题（F-2 声明值、F-3 斜杠侧分母），本批无权改判，一字未动。**

## 4. 门禁

`bash scripts/gate.sh frontend`（rc=0）原始行：

```text
 Test Files  108 passed (108)
      Tests  1452 passed | 3 skipped (1455)
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest
  全部门禁通过。
```

**108 而不是基线 107 的原因（已核，不是我加的文件）**：批次 D 的并行会话新增了未跟踪的
`__tests__/palink-diag-upload.test.ts`（`git status` 里 `??`），它进了这次全量跑。
我没有新增测试文件，只改了一个既有测试的数组 + 一处注释。

单跑用例数（改后）：

| 命令 | 结果 |
|---|---|
| `npx vitest run .../h-tavernhelper-134-contract.test.ts` | **47 passed (47)** |
| `npx vitest run .../st-gap-ledger-reconcile.test.ts` | **6 passed (6)**（③ 的债务白名单在"漏列减少"时按设计允许，未报红） |
| `npx vitest run .../generated-script-parse-guard.test.ts` | **4 passed (4)** |

> 说明：`st-gap-ledger-reconcile.test.ts` 的 `KNOWN_GUARD_GAPS`（27 键白名单）本批**没有删**
> —— 不在授权边界内。它现在的语义退化成"空债务"，但断言 `newGaps ⊆ 白名单` 仍成立，
> 所以门禁是绿的。**建议主脑在定 F-1 收尾时把该白名单清空**（清空后语义才回到"任何漏列即红"）。

## 5. 两组反证（各自独立的一次红）

### 5.1 反证一（验收指定）：把 27 里一个键在帧内注册掉 ⇒ 守卫必红

手法：`runtime-body/part-07.ts` 的 `tavernHelperTh134Compat` 对象首行临时插
`pauseAudio: function () { return null; },`（备份 `.tmp_probe/I_part-07.bak`，`cp` 还原，未用任何 git 破坏性命令）。

```text
 FAIL  .../h-tavernhelper-134-contract.test.ts > A fixture 与注册口径 > D 类键一个都没注册（假实现红线；名单逐条来自报告 §3 分类全表）
AssertionError: expected [ 'pauseAudio' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "pauseAudio",
+ ]

 ❯ .../h-tavernhelper-134-contract.test.ts:273:56
 Test Files  1 failed (1)
      Tests  1 failed | 46 passed (47)
```

还原后：`md5sum part-07.ts` = `ffcca060a032571c619733ea90760a6a`（与备份一致），
`git status --short -- .../runtime-body/` **空**（无输出），复跑 `47 passed (47)`。

### 5.2 反证二（对账脚本层）：从名单里抽掉一个键 ⇒ ③ 必红

手法：临时删 `'getExtensionType'`（备份 `.tmp_probe/I_guard_full.ts`，还原后 md5 `e66884f3…` 一致）。

```text
守卫: D 名单 50 键, 正向锚点 22 键, 并集 72
[FAIL] ③ 守卫漏列 — 守卫（D 名单 ∪ 正向锚点）没覆盖到 1 个 D 类键 —— 这些键被塞成空壳时守卫看不见
        {"gaps":[{"family":"ST 扩展安装体系（Palink 无扩展安装/权限模型，口径 c 已拍板）","familySize":9,"missing":["getExtensionType"]}],"totalMissing":1}
  ST 扩展安装体系（Palink 无扩展安装/权限模型，口径 c 已拍板） (1/9 漏): getExtensionType
SUMMARY: FAIL=1 WARN=2 ⇒ 不平（exit 1）
```

还原后：脚本 `SUMMARY: FAIL=0 WARN=2 ⇒ 平（exit 0）`；守卫 `47 passed (47)`。

⇒ 两组红的方向相反、互相补足：**注册了 ⇒ 守卫红**；**名单又漏了 ⇒ 对账脚本红**。
任何一侧被人改坏都能被抓住。

## 6. 边界对照（本批只碰了什么）

| 文件 | 本批 | 说明 |
|---|---|---|
| `__tests__/h-tavernhelper-134-contract.test.ts` | **改** | 唯一授权修改的守卫文件（`forbidden` + 注释） |
| `palink-diag.ts` | **改（仅注释 4 行）** | 任务书明令"只改注释文字" |
| `runtime-body/part-07.ts` | 临时改→**已还原** | 反证一，md5 一致、`git status` 干净 |
| `runtime-body/part-08.ts` / `part-01.ts` | **未碰** | 属批次 H |
| 后端任何文件 | **未碰** | 属批次 D |
| `scripts/docs/st-gap-ledger-reconcile.mjs` | **未碰** | 见 §8-② |
| `st-gap-ledger-reconcile.test.ts` | **未碰** | 见 §4 说明 |

## 7. 没做到 / 未提交（不藏）

1. **`palink-diag.ts` 的注释改动没有进我的提交**。原因：该文件此刻被批次 D 并行改着
   （`git diff --stat` = `277 insertions(+), 4 deletions(-)`，其中只有 4 行是我的）。
   用 `git commit -o -- palink-diag.ts` 会把 D 的在途改动一并卷进批次 I 的提交，破坏"逐笔对照本批边界"，
   也会让 D 的后续提交变成空提交。⇒ 选择留在工作区，**建议由批次 D 提交该文件时一并带走**（我这 4 行在
   `:94-97`，与 D 的改动不冲突）。主脑若要求批次 I 单独提交它，请先让 D 落盘。
2. **`④c` WARN 的文案现在过期了，但我没改**：`scripts/docs/st-gap-ledger-reconcile.mjs:372` 与 `:374`
   把"仓库里没有 st289-names.json（palink-diag.ts:83 注释引用了它）"和那句旧注释**硬编码**在脚本里。
   事实是：文件存在（4818 字节），旧注释也已按本批要求写准路径。脚本属包AE 交付物、不在批次 I 边界内，
   故只记录。建议主脑定 F-3 口径时同批订正这两行。
3. **没有替包H 报告/台账改任何计数**（明令禁止）。守卫 D 名单 51 键与 D 类实测 51 键现在**数值相等**，
   但两边的口径来源不同（一个是族表+订正段算出来的，一个是我按脚本输出补的），
   若将来 D 类再改判，**必须三层同批**（正向锚点 + 台账行 + 包H 计数）。

## 8. 复跑方式

```bash
node scripts/docs/st-gap-ledger-reconcile.mjs            # 期望 FAIL=0 WARN=2，rc=0
cd frontend && npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts   # 期望 47 passed
cd frontend && npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-gap-ledger-reconcile.test.ts       # 期望 6 passed
bash scripts/gate.sh frontend                            # 期望 rc=0
```
