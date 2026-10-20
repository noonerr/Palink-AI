# REPORT 包AE — ST-GAP 总账对账（批次F，2026-10-20）

> 状态：**脚本 + 守卫包装已交付；对账结论 = 不平（1 FAIL / 2 WARN），逐条列在 §4，交主脑定。**
> 任务书：`docs/_active/prompt/PROMPT_对话包_批次F总账对账与批次G模板串守卫_2026-10-20.md` 的**批次 F**（批次 G 不在本报告范围）。
> 边界：**纯只读**。本批没有改台账、没有改包H 报告、没有改 `palink-diag.ts`、没有改 `h-tavernhelper-134-contract.test.ts`、
> 没有改任何产品码；只新增一个脚本 + 一个测试 + 本报告。
> 复核方：主脑（Qoder"分配分包派遣任务"会话）。

---

## 1. 一句话结论

五份权威摆成一张表之后，**唯一真正不平的是 ③：守卫（D 名单 24 键 ∪ 正向锚点 22 键）覆盖不到 27 个 D 类键**
——这正是 2026-10-20 那两起事故的同源形态（守卫名单自己漏列），只不过这次漏得更多：
上一次漏 10 个（人设 8 + 角色库写侧 2 之外的 3+5 之外），这次 D 类实测 **51 键**里守卫只盯着 **24 键**。

另外两条是**口径问题**（不是漏算）：报告声明的 `C=68 / D=53` 与按族表键名闭合出来的 `C=70 / D=51` 差 2 键；
`ST_GAP_BY_NAME` 里有 27 个名字是斜杠命令，压根不在 134 分母里（而任务书 ④ 是按"都在 134 里"写的）。
这三条**一条都没由本批改判**，全部交主脑定（改判要三层同批，见台账 §5）。

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `scripts/docs/st-gap-ledger-reconcile.mjs` | 对账脚本本体（纯只读，Node ESM，无依赖）。人读输出 + `--json` 机器读；不平 `exit 1`，输入/解析级异常 `exit 2` |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/st-gap-ledger-reconcile.test.ts` | 把脚本包成 6 个 vitest 用例（结构性硬断言 4 条 + 债务白名单 1 条 + 守卫自检 1 条） |

脚本读的五份权威（路径写死在 `REL`，任一份改名/移动即 `exit 2`）：

1. 台账族表 `docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2（只取 `### 2.1` 之前那张表）
2. 包H 族表 `docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md` §3 分类行 + 其后所有订正段
3. 代码归类 `frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts` 的 `ST_GAP_IDS` / `ST_GAP_BY_NAME`
4. 守卫名单 `__tests__/h-tavernhelper-134-contract.test.ts` 的 `forbidden` 数组 + 所有 `([...] as const).forEach` 正向锚点
5. 权威分母 `__tests__/fixtures/th134-names.json`（134）

## 3. 现状跑出来的原始输出（`node scripts/docs/st-gap-ledger-reconcile.mjs`，rc=1）

```text
§3 族表原始（按文档行号）:
  :95  C  lorebook 族 ...                      声明 14 / 列出 14
  :96  C  worldbook 族                         声明 9 / 列出 9
  :97  C  variables 族                         声明 4 / 列出 4
  :98  C  chat_message 族                      声明 4 / 列出 4
  :99  C  displayed_message 族                 声明 3 / 列出 3
  :100 C  character 只读族                     声明 7 / 列出 7
  :101 C  工具与全局初始化族                   声明 12 / 列出 12
  :102 C  tavern regex 族                      声明 5 / 列出 5
  :103 A  Palink 兼容层已在 tavernHelperCompat 声明 8 / 列出 8
  :104 A  Palink legacy 轨                     声明 5 / 列出 5
  :105 D  ST 预设体系                          声明 16 / 列出 16
  :106 D  ST 角色库写侧                        声明 7 / 列出 7
  :107 D  ST 人设（persona）体系               声明 11 / 列出 11
  :108 D  酒馆助手音频播放器                   声明 8 / 列出 8
  :109 D  ST 扩展安装体系                      声明 9 / 列出 9
  :110 D  ST 提示词注入槽位                    声明 2 / 列出 2
  :111 D  世界书/lorebook 删除动作缺失         声明 2 / 列出 2
  :112 D  ST 私有 DOM / jQuery 面              声明 1 / 列出 1
  :113 D  ST 宏注册器                          声明 1 / 列出 1
  :114 D  预设提示词类型判定                   声明 3 / 列出 3
  :115 D  ST 原始对象导入器                    声明 2 / 列出 2
  :116 D  按 generation id 中止                声明 1 / 列出 1

订正应用轨迹（顺序 = 时间顺序：§7.2 早于 §3/§4 的 2026-10-20 订正段）:
  C→D  11 键  §7.2 实现期改判：无宿主写通道 C→D
  D→C   1 键  包AA C：registerMacroLike D→C
  D→C   4 键  批次A：写桥四键 D→C
  D→C   3 键  批次B 段①：人设三键 D→C（后被主脑订正为整族 11 键）
  D→C   5 键  批次B 段②：角色库五键 D→C（后被主脑订正为整族 7 键）
  D→C   8 键  主脑复验：人设整族 11 键 D→C
  D→C   2 键  主脑复验：角色库写侧整族 7 键 D→C

最终分类: A=13  C=70  D=51  (A+C+D=134)
守卫: D 名单 24 键, 正向锚点 22 键, 并集 46

[PASS] fixture — 权威分母 th134-names.json = 134 个唯一键
[PASS] ② 分类闭合 — A=13 C=70 D=51，合计 134，键名零重复
[WARN] ②b 声明值核对 — 报告声明的 C/D 与键名实测不符（需主脑定，脚本不自行改判）
        {"declared":{"C":68,"D":53},"computed":{"C":70,"D":51},"note":"族表按键名闭合到 134，声明值来自报告订正段的算术；两者差 2 键"}
[PASS] ① 台账可用 — 17 个 id 与 ST_GAP_IDS 双向对齐，每个 id 都有键名或族表说明
[PASS] ③b 守卫自身过期 — D 名单 24 键全部仍是 D 类
[FAIL] ③ 守卫漏列 — 守卫（D 名单 ∪ 正向锚点）没覆盖到 27 个 D 类键 —— 这些键被塞成空壳时守卫看不见
[PASS] ④ 名字表 — 101 个名字：74 个命中 134 分母且 id 全在 ST_GAP_IDS；27 个是斜杠命令形状
[WARN] ④c 斜杠侧分母缺失 — 27 个名字只能按"斜杠命令形状"校验，无法对权威 289 分母逐条核

③ 守卫漏列明细（族 → 漏掉的键名）:
  酒馆助手音频播放器 (5/8 漏): appendAudioList, getCurrentAudio, pauseAudio, replaceAudioList, setAudioSettings
  ST 预设体系 (10/16 漏): builtin_prompt_default_order, createOrReplacePreset, createPreset, deletePreset,
      getPresetNames, getProxyPresetNames, importRawPreset, renamePreset, replacePreset, updatePresetWith
  tavern regex 族 (3/5 漏): isCharacterTavernRegexesEnabled, replaceTavernRegexes, updateTavernRegexesWith
  ST 扩展安装体系 (5/9 漏): getExtensionStatus, getExtensionType, reinstallExtension, uninstallExtension, updateExtension
  ST 原始对象导入器 (1/2 漏): importRawTavernRegex
  预设提示词类型判定 (3/3 漏): isPresetNormalPrompt, isPresetPlaceholderPrompt, isPresetSystemPrompt

SUMMARY: FAIL=1 WARN=2 ⇒ 不平（exit 1）
```

## 4. 发现的每一处不平

| # | 不平 | 位置 | 处置 |
|---|---|---|---|
| F-1 | **守卫漏列 27 个 D 类键**（6 族，见上表）。D 类实测 51 键，守卫只覆盖 24 键；剩下 27 键**将来被人塞成空壳，`h-tavernhelper-134-contract` 的 D 断言看不见** | `__tests__/h-tavernhelper-134-contract.test.ts:239-247`（`forbidden` 24 键）对照 `REPORT_包H_..._2026-10-18.md:105-116`（D 族表 63 键） | **需主脑定**。补守卫＝改 `h-tavernhelper-134-contract.test.ts`，本批文件边界明令禁止；本批只把差异摆出来，并把它钉成测试里的"债务白名单"（新增漏列即红） |
| F-2 | **声明计数与键名实测差 2 键**：报告声明 `C=68 / D=53`，按族表键名闭合是 `C=70 / D=51`（A=13 一致，总和都 134） | `REPORT_包H_..._2026-10-18.md:179`（"C 50 → 68、D 71 → 53"）；根因同源 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md:68-70`（自认"族数相加是 75"、`importRawCharacter` 被两族重复计） | **需主脑定**。脚本不自行改判：② 只按**键名**判闭合（绿），声明值单列为 ②b WARN |
| F-3 | **④ 的口径与任务书字面不符**：`ST_GAP_BY_NAME` 101 个名字里 27 个是斜杠命令（`char-create` / `persona-lock` / `inject` / `regex` …），不在 134 分母里；且 `palink-diag.ts:83` 注释引用的 `st289-names.json` **仓库里不存在**（`__tests__/fixtures/` 只有 `th134-names.json` 与 `st-libs-25.json`） | `palink-diag.ts:87-248`（27 个 kebab 名）、`palink-diag.ts:83`（引用不存在的 fixture） | **需主脑定**（补 289 fixture，或把 ④ 口径改成"只对 134 面"）。本批实现：134 面逐键核 + 斜杠面按"全小写 kebab 形状"核，驼峰错名仍会红；缺口单列 ④c WARN |
| F-4 | **§7.2 的"14 个键改判 D"数不进族表**：其中 `importRawChat` / `importRawTavernRegex` / `retrieveDisplayedMessage` **本就在 D 族表里**，`setCurrentCharLorebooks` / `rebindCharWorldbooks` 后来被批次A 又挪回 C ⇒ 从 C 族表真正移到 D 的是 **9 个**（5 正则 + `importRawWorldbook` + `getAllEnabledScriptButtons` + `getModelList` + `rotateChatMessages`），净效果 11（含被挪回的两键） | `REPORT_包H_..._2026-10-18.md:321-332`（§7.2）对照 `:95-116`（族表） | **我已按红线只记录**：脚本把 11 键写成 §7.2 的移动（时间顺序在批次A 之前），批次A 再把其中 2 键挪回 C，轨迹表如实打印 |
| F-5 | **台账 §2 有 12 行的"卡从哪儿碰到它（真名）"列只写"N 键"**（真名其实在上一列），`jailbreak_slot` 更是连键名都没有（只有 `/jailbreak` 类命令） | `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md:47,52-62` | **只记录**。① 的判据因此写成"键名（两列合看）**或**族表说明 + 代码里有 `[ST-GAP:<id>]` token"，不把"列里没写名"当空壳 |

## 5. 四条断言的实现判据（可逐条复跑）

- **① 台账可用**：台账 §2 id 集合（17）与 `ST_GAP_IDS`（17）**双向**相等；每个 id 要么在 `ST_GAP_BY_NAME` 里有名字，
  要么"说明列有实质文字 + `palink-diag.ts` 里有 `[ST-GAP:<id>]` token"。→ 现状 **PASS**。
- **② 分类闭合**：§3 每行"声明键数"必须等于该行**真正列出的键名数**（防"数了 7 个只写 5 个名字"）；
  A/C/D 三集合两两不交；`A+C+D = 134` 且 134 里没有族表覆盖不到的键。→ 现状 **PASS**（13/70/51）。
- **②b 声明值核对**：报告声明的 C/D 与键名实测比。→ 现状 **WARN**（差 2 键，见 F-2）。
- **③ 守卫漏列**：按最终 D 类逐族比对"`forbidden` ∪ 正向锚点"，缺一个就列一个。→ 现状 **FAIL**（27 键，见 F-1）。
- **③b 守卫自身过期**：`forbidden` 里不许出现已归 C/A 的键（拦已实现的键＝守卫过期）；正向锚点里不许出现仍归 D 的键。→ 现状 **PASS**。
- **④ 名字表**：`ST_GAP_BY_NAME` 每个名字要么在 134 里（74 个），要么是全小写 kebab 形状（27 个）；每个名字指向的 id 必须在 `ST_GAP_IDS` 里。→ 现状 **PASS**，另出 ④c WARN。

**订正段怎么读（防"用旧口径静默对账"）**：每条订正都带 `cite.lines` + `cite.expect`（必须在原文里命中的片段），
命中不了就 `FAIL` 并打印缺哪句 —— 报告一旦改写，脚本先红，逼人来核，而不是拿旧口径继续算。
整族移动（主脑复验那条）额外断言"该族键名数 == 订正声明的 11 / 7"，对不上也红。

## 6. 反证（会红，且是两次独立的红）

**反证方式**：把守卫 `forbidden` 数组里的 `'getPreset'` 临时删掉（模拟"守卫名单漏列一个键"），备份在 `.tmp_probe/F/guard.bak`，`cp` 还原（未用任何 git 破坏性命令）。

脚本层（漏列 27 → 28，rc=1）：

```text
[FAIL] ③ 守卫漏列 — 守卫（D 名单 ∪ 正向锚点）没覆盖到 28 个 D 类键 —— 这些键被塞成空壳时守卫看不见
SUMMARY: FAIL=1 WARN=2 ⇒ 不平（exit 1）
```

测试层（白名单拦不住新增漏列）：

```text
 ❯ .../st-gap-ledger-reconcile.test.ts:108:7
    106|       '守卫（D 名单 ∪ 正向锚点）新漏了这些 D 类键，它们将来被塞成空壳时守卫看不见：'
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

还原后（`md5sum` 与备份一致 `0ac2f38a…`，`git status` 里该文件干净）：

```text
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## 7. 门禁与"没做到"的部分（不藏）

| 项 | 结果 |
|---|---|
| 我的文件 `npx tsc --noEmit` | **该文件 0 error**（全仓 tsc 另计，见下） |
| 单跑新测试 | **6 passed (6)** |
| `bash scripts/gate.sh frontend` | **rc≠0（红）**，但**不是本批造成的**：① `st-gap-ledger-guard.test.ts:97` 报"台账记了 `tokenizers` 但 `palink-diag.ts` 没标"——`docs/_active/spec/SPEC_向ST学习的系统…2026-10-19.md` 此刻**被别的会话改着（`git status` 显示 `M`）**，新增的 `| 键 \`tokenizers\` |` 行被旧守卫的行解析器当成了台账 id；② 同批另有 1 例红与 tsc 报错落在 `runtime-body/part-*.ts` 的在途改动上（批次C/G 正在改）。**本批一个字节都没碰这些文件**，按红线保持原样，请主脑在并行批次落地后复跑 |
| 全量 pytest | 未跑（本批选 vitest 形态，未动后端） |

**做不到/未做**：

1. 没补守卫的 27 个漏列键（边界禁止改 `h-tavernhelper-134-contract.test.ts`）—— 见 F-1。
2. 没补 `st289-names.json`（属"新增权威分母"，需要 289 命令的权威来源，本批无此授权）—— 见 F-3。
3. 没替台账/包H 报告做任何计数订正（明令禁止）—— F-2/F-4 只记录。
4. 测试里 ③ 用"债务白名单"而不是直接断言绿：现状本就红，直接断言绿会让门禁恒红；白名单的语义是**新增漏列即红、漏列减少即允许**，与"恒红"相比它至少能抓下一次少算。这条是**对本批验收口径的主动偏离**，主脑若不认，改一行即可（把 `KNOWN_GUARD_GAPS` 清空）。

## 8. 复跑方式

```bash
node scripts/docs/st-gap-ledger-reconcile.mjs          # 人读，不平 exit 1
node scripts/docs/st-gap-ledger-reconcile.mjs --json   # 机器读
cd frontend && npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-gap-ledger-reconcile.test.ts
```
