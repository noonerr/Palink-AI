# docs/ 文档索引与可信度分级（图书管理员）

> 建立日期：**2026-10-05**。维护者：文档治理 agent。
> **本文档是 `docs/` 的检索入口。** 找东西先来这里查，再决定要不要打开某份文档。
>
> ## ⚠️ 三条使用纪律
> 1. **本文档不删除任何文件。** 归档动作已在 2026-10-05 执行过一批，但**只搬零入链的文档**
>    （全仓 grep 无任何引用），且搬完逐条复查断链。被引用的文档**一律留在原路径**，
>    因为别的 agent 正在引用（SPEC 里写着"详见 xxx.md"），移动会打断它们。
>    下方"建议去处"里若还有条目，说明它**尚不能安全移动**。
> 2. **标了"不可信"的文档不是没用，是"不能直接照做"。** 引用前必须先看下面的失效原因。
> 3. **本索引的判断是 2026-10-05 的清点结果，可能过时。** 每条都标了判断依据，
>    复核成本很低；发现索引与现实冲突，**改索引**（加订正），别默默只信一边。

---

## 〇、2026-10-05 已完成的归档 + 新文档存放规范（同日补记）

> ⚠️ **本节的份数是建立当时的快照，会过时。** 权威数字看 [`_CATALOG.md`](./_CATALOG.md)
> （由 `scripts/docs/gen_docs_catalog.py` 生成，刷新命令见 `agents.md`「目录自动化」）。
> 本文件 `_INDEX.md` 只管**可信度判断**，不管份数 —— 那件事已交给脚本。

### A. 目录现状（份数为 2026-10-05 建立时快照）

| 目录 | 收什么 | 建立时现状 |
|---|---|---|
| [`_active/`](./_active/_README.md) | **新建文档放这里**（spec/report/prompt 三个子目录） | 建目录时为空，已有 agent 开始按规矩往里放 |
| [`_archive/`](./_archive/_README.md) | 已完成、已过保鲜期的**一次性**记录，按内容真实日期分月 | 收 **34 份**（05×1 / 06×1 / 07×6 / 08×10 / 09×3 / **10×13**） |
| [`_reference/`](./_reference/_README.md) | 长期有效的配置指南/契约，**不过期** | 收 **7 份**（SearXNG、提示词、Casdoor） |

`docs/` 顶层从 166 份降到 **125 份**（建立时）。

### B. ⚠️ 新建文档一律放 `docs/_active/`

**规矩已写进 `agents.md`「文档存放规范」**（所有 agent 开工必读那份），三条要点：

1. 施工规格书 → `_active/spec/`；排查结论 → `_active/report/`；派活提示词 → `_active/prompt/`；
   交接书/提测单 → `_active/`。**判断依据是"读它的人要干嘛"**。
2. **保留现有多段前缀且前缀必须在开头**（`SPEC_`/`REPORT_`/`PROMPT_`/`HANDOFF_`）——
   全仓靠前缀分类，索引按它统计，不要改这套前缀。
3. **首部必须自述状态**（待施工/施工中/已完工待验收/已作废+被谁取代）。

⚠️ **找文件时顶层和 `_active/` 都要搜** —— 本次迁移只搬已过期的，活文件仍在顶层。
活文件会随各自完工按 `_archive/` 判据逐批下沉，届时顶层自然收敛到"只放正在用的"。

### C. 归档踩到的坑（复盘，别再踩）

- **文件名日期 ≠ 内容真实日期**：`_archive/2026-05/CODE_QUALITY_AUDIT_REPORT.md` 内容是 2026-05，
  `_archive/2026-09/ST_COMPAT_FORK_AUDIT_2026-08-17.md` 内容首次提及却是 09 月。判新鲜度要读内容。
- **全仓引用几乎都是裸文件名**（205 处里只有 1 处写完整路径），所以移动造成的断链是**静默的**。
  实测只找到 1 处真断链（`backend/scripts/backfill_worldbook_from_raw_card.py:6`），已改并验过脚本语法。
- **零入链才可搬**：按文件名全仓 grep，无任何引用才动。
- 2026-10 的 13 份是**例外**，由用户授权（"他任务完成了"）搬入，判据放宽为"零入链 + 已完结"，
  其中三份的收尾状态未逐条复核，已在 `_archive/_README.md` 逐份标注。

---

## 一、该去哪找什么（先查这张表）

| 你要找的东西 | 去哪里 | 可信度 |
|---|---|---|
| **现在该干什么（真·待办）** | [`OPEN_ISSUES.md`](./OPEN_ISSUES.md) | ✅ 高（刚建） |
| **新文档该放哪** | [`_active/_README.md`](./_active/_README.md) + `../agents.md` §文档存放规范 | ✅ 强制规矩 |
| 跨 agent 遗留任务与决策历史 | [`../TODOS.md`](../TODOS.md) + [`../agents.md`](../agents.md) | ⚠️ 会僵尸化，交叉核对 |
| **交 agent 干活的提示词** | 顶层 `PROMPT_*.md`（7 份）+ `_active/prompt/` | ✅ 指令性文件 |
| 施工规格书（动手前读） | 顶层 `SPEC_*.md`（34 份）+ `_active/spec/` | ⚠️ 看日期，8 月的半数已作废 |
| 排查结论（**最可信的一类**） | 顶层 `REPORT_`/`DIAG_`（17 份）+ `_active/report/` | ✅ 高，含实测读数与 commit |
| 交接书 | `HANDOFF_*.md`（2 份） | ⚠️ 一份已死 |
| 干活前/收工前的纪律清单 | [`SOP_Agent交付自查清单.md`](./SOP_Agent交付自查清单.md) | ✅ 元规则，持续维护 |
| 备份在哪、能不能删 | [`../_BACKUPS/_INDEX.md`](../_BACKUPS/_INDEX.md) | ✅ 台账 |
| **st-\* 名字还有哪些活着**（防误删） | 见下方 §四 | ✅ 已逐个核实 |

---

## 二、⚠️ 最大的坑：ST 双轨已死，但文档还在讲它

**事实（已核实）**：`st-compat` / `st-native` 两个模式已于 **2026-09-04** 分三笔提交彻底删除
（`091023e` 后端装配 / `aeb8348` 前端+nginx / `4eadb86` 路由+部署，**`4eadb86` 实际提交于 09-04**）。

**为什么这是最大的坑**：越新的文档越危险。
- 8 月的老文档自己声明了基准是什么，容易识别为过时。
- 真正的雷是 **`ANALYSIS_ST兼容性约束下的前端优化_2026-09-21.md`** —— 它写在双轨死后 17 天，
  **标题里的"ST 兼容性约束"当时已经不存在**，全文却在推演它，而且首行还挂着
  "test:contract 口径已作废"的横幅，看起来像"已核对过"。
  **⚠️ 横幅只覆盖 test:contract 口径，完全不覆盖 st-compat 口径失效。这是当前索引体系的最大盲区。**

### 必须先跳过的文档（主论据建立在已删除的双轨上）

⚠️ 以下**不是"旧"，是"讲的模式已不存在"**。照着做 = 返工。

**A1 类 · 名字直接宣称已删模式为一等公民（9 份，最易误引）**

| 文档 | 失效理由 |
|---|---|
| `PALINK_ST_AGENT_TODO.md`（49KB） | 标题即"Palink/SillyTavern 集成共享工作板"，按双轨分工组织。**⚠️ 它长得像"当前待办板"，最容易被误读为现状** |
| `PALINK_ST_COMPAT_EXECUTION_SPEC.md` | 已删 `st-compat` 模式的执行规格，全部步骤无意义 |
| `PALINK_ST_RUNTIME_IMPLEMENTATION_PLAN.md` | `st-native` runtime 实现计划 |
| `PALINK_ST_HOST_CONTRACT.md` | `st-compat` 宿主契约，契约方已删 |
| `_archive/2026-06/DIRECTION1_ST_NATIVE_PERFECTION_PLAN.md` | 标题即 st-native 完善计划 |
| `_archive/2026-07/ST_ALIGNMENT_EVALUATION_REPORT.md`（38KB） | **双重失效**：讲已删模式 + 自述"以 ST 1.18.0 源码为唯一事实基准"，**而该源码目录已不存在**，结论无法复现 |
| `ST_BACKEND_FINAL_COMPLETION_REPORT.md` | "final" 指**该轨**的终点，不是现状 |
| `PALINK_ST_PLUGIN_COMPAT_MATRIX.md`（41KB） | ⚠️ **部分有效的高危件**：插件沙箱属 palink-native 仍有效，但按 `silly_tavern_mode` 分轨的部分已失效。**不要整份封杀** |
| `_archive/2026-07/st-compat-audit.md` / `_archive/2026-07/st-compat-report.md` / `st-compat-gap.md` / `st-compat-changelog.md`（4 份） | 全是已删轨的审计/报告/差距/变更史。**⚠️ 名字与现存的 `'st-compat-v2'` runtime 版本标签仅一字之差，这是本仓最大的命名陷阱** |

**A2 类 · 方法是"读 ST 源码逐函数比对"，而基准已被删（6 份）**

`DEEP_AUDIT_REPORT_2026-08-09.md`（68KB，自述依据含 `SillyTavern-1.18.0/` 路径，该目录已不存在）、
`SILLYTAVERN_COMPAT_SPEC_2026-08-23.md`（自述参照已删的 `frontend/public/st/script.js`）、
`SILLYTAVERN_COMPAT_AUDIT.md`、`MOBILE_ST_COMPAT_VERIFY_2026-08-12.md`、
`SMARTCARD_VERIFY_FINDINGS_2026-08-11.md`、`_archive/2026-09/ST_COMPAT_FORK_AUDIT_2026-08-17.md`、
`PLUGIN_ISSUES_REPORT.md`（自述从 DEEP_AUDIT 提取，继承同一失效基准）

**A3 类 · 删轨后（>09-04）仍以删轨为设计前提（最严重）**

`ANALYSIS_ST兼容性约束下的前端优化_2026-09-21.md`（见上）、
`SPEC_ST兼容度全面审查_2026-08-28.md`、`PLAN_ST兼容修复批次_2026-08-28.md`、
`SPEC_ST_P2剩余六项_2026-08-26.md`（其"P2 剩余六项"**永不会完成**，当成 pending 重做即返工）、
`REPORT_ST兼容性深度调研_2026-08-29.md`、`REPORT_ST插件全兼容可行性评估_2026-09-05.md`、
`_archive/2026-09/REPORT_ST适配面安全审查_2026-09-03.md`

**A4 类 · 目录级失效**

- `docs/st-compat-handover/`（6 份）—— **位置最危险**：它是 `DEEP_AUDIT_REPORT` 自述的依据来源之一，
  **会让失效结论互相引用加固**。
- `docs/st-plugin-compat-spec/`（10 份）—— ⚠️ **部分作废**：phase-4 写的是 `palink-native`，插件沙箱仍在，**不能整目录封杀**。

---

## 三、按可信度分级（全文索引）

### ✅ 可信：结论有一手实测或真实 commit 支撑

**判据（可复核）**：2026-10 之后 + 文档内能找到真实 commit hash 或具体实测读数。

| 文档 | 凭据 |
|---|---|
| [`_active/report/REPORT_向量记忆能否替代上下文_三问实测_2026-10-09.md`](_active/report/REPORT_向量记忆能否替代上下文_三问实测_2026-10-09.md)<br>[`_active/report/REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md`](_active/report/REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md) | **本题集唯一权威件**。9 个只读探针 + 50 题端到端（真实 DeepSeek）。⚠️ **它否证了 10-07 报告 §3 的两条论断**（查询拼接反而更差、并非零成本）；引用 10-07 §3 前先看它 |
| [`_archive/2026-10/DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md`](_archive/2026-10/DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md) | **最强**。引 commit `b85a236`，可 diff 复核 |
| `REPORT_MVU补齐第一波/第二波/第三波_2026-10-05.md` | 对应 `c24017d`/`4c512d8`/`a877013`，逐笔对应 |
| `_archive/2026-10/REPORT_MVU变量更新指令让位卡片自带声明_2026-10-05.md` | 对应 `b027aa3`，一字不差 |
| `SPEC_重新生成与分支记忆隔离修复_2026-10-05.md`、`SPEC_变量自动清理_MVU对齐_2026-10-05.md`、`SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md` | 对应 `f006b09` 等近期提交 |
| [`REPORT_酒馆助手API适配查验_2026-10-03.md`](./REPORT_酒馆助手API适配查验_2026-10-03.md) | **本仓"st-\* 命名陷阱"的权威辨析件**，30 处实测标记，自己就逐个区分了同名不同物 |
| [`_archive/2026-10/REPORT_重复废弃与互搏代码审查_2026-10-02.md`](_archive/2026-10/REPORT_重复废弃与互搏代码审查_2026-10-02.md) | **"哪些 st-\* 名字还活着"的唯一权威清单**。遇 st-\* 疑点先读这份 |
| [`SPEC_首屏入口包瘦身_执行与禁则_2026-10-05.md`](./SPEC_首屏入口包瘦身_执行与禁则_2026-10-05.md) | 含 638KB 入口实测。**且它主动纠正了自己的历史误判** |
| [`SOP_Agent交付自查清单.md`](./SOP_Agent交付自查清单.md) | 元规则文件。⚠️ **引用其数字前先看 §九/§十一/§十二**（它自己记录了判据自陷坑） |
| [`../_BACKUPS/_INDEX.md`](../_BACKUPS/_INDEX.md)、[`../agents.md`](../agents.md) | 台账与主攻方向声明 |

### ⚠️ 半可信：结论对，但口径或范围需要自己再确认

| 文档 | 要注意什么 |
|---|---|
| `REPORT_插件设置冲突与100%适配可行性_2026-10-04.md` | ⚠️ **标题的"100% 适配可行性"是推断性表述，不是实测结论** |
| `REPORT_插件API缺口清单_2026-10-04.md` | 缺口数随施工推进变化，用前先看日期 |
| `SPEC_插件设置按卡隔离适配_2026-10-04.md` + 配套 REPORT | 批次 0-1 已完成，后续批次未做 |
| 13 份 2026-10-04/05 的 MVU 相关文档 | ⚠️ **都没有"口径作废"横幅**——横幅只做了一轮，后续新增文档未纳入巡检。**别因为没有横幅就以为它已被核对** |
| `docs/goal-groupchat/`（4 份，10-03 活跃） | ⚠️ 其中 `goal-verification-report.md` 是 **2026-07-23** 的，与其余 4 份 10-03 的差 2.5 个月，内容很可能不匹配 |

### 🔴 不可信：结论已被取代，但正文未标注

**判据**：存在日期更晚、主题覆盖同一问题、引用了它的下游文档。

| 被取代的文档 | 取代者 |
|---|---|
| `SPEC_前端缓存与加载优化_2026-09-21.md`、`ANALYSIS_前端性能与缓存优化_2026-09-21.md`、`ANALYSIS_ST兼容性约束下的前端优化_2026-09-21.md` | ⚠️ **三份同一天同主题，分析结论互相冲突**，而 `SPEC_首屏入口包瘦身_2026-10-05.md`（含 638KB 实测）已给出更正归因。**这三份整体降级** |
| `_archive/2026-08/状态栏渲染修复_实施计划_2026-08-05.md`、`_archive/2026-08/状态栏渲染调试_交接文件_2026-08-06.md` | `_archive/2026-10/DIAG_变量形状漂移导致状态栏回默认值_2026-10-05.md`（有 commit `b85a236` 实证） |
| `评估_P0前端memo修复任务适配性与执行计划_2026-09-22.md` | 同上，首屏实测已推翻其结论 |
| `_archive/2026-08/SCEP_角色卡面板渲染.md`、`交接文档_角色卡面板插件渲染.md`（均 08-04）、`角色卡面板渲染_完整交接文档_2026-08-08` | 三份同主题互相覆盖，**无任何取代声明** |
| `REPORT_项目全面体检_2026-09-05.md`、`HANDOFF_项目全面体检_2026-09-03.md` | 被 `REPORT_安全渗透验证_2026-09-02.md`、`REPORT_插件沙箱逃逸面评估_2026-09-02.md` 分专项覆盖 |
| `GALGAME_PLUGIN_PERFECT_COMPAT_SPEC.md`（09-25） | ⚠️ 标题写 "perfect compat"，但 `HANDOFF_相册与渲染问题_2026-10-03.md` 仍在报相册问题。**"perfect" 与"仍在出问题"并存，需复核** |

### 🔴 不可信：只有推理、没有实测；或一次性批量生成

| 文档 | 理由 |
|---|---|
| `_reference/SEARXNG_GUIDE.md` / `_reference/SEARXNG_ANTI_BAN.md` / `_archive/2026-07/WEBSEARCH_SETUP_COMPLETE.md` / `_archive/2026-07/FREE_WEBSEARCH_SETUP.md` | ⚠️ **四份 mtime 完全相同（2026-05-15 01:48），一次性批量生成**。所谓"设置完成"的实际配置是否仍生效，需实测确认 |
| `_reference/CASDOOR_INTEGRATION_PRD.md` / `_CHECKLIST.md` / `_TECHNICAL_ARCHITECTURE.md` | 同样 mtime 2026-05-19，且 Casdoor 认证在后续架构中**未见被引用**，疑似从未落地或已被取代 |
| `_archive/2026-08/QUICK_FIX_SPEC_2026-08-12.md`、`_archive/2026-08/p-series-fixes-spec-2026-08-12.md`、`_archive/2026-08/st-resources-n-series-fixes-2026-08-12.md` | 5–8 月，无实测痕迹 |
| `PLUGIN_SECURITY_MODEL.md`、`REASONING_FIELD_MIGRATION.md`、`_archive/2026-05/CODE_QUALITY_AUDIT_REPORT.md`、`SECURITY_AUDIT_REPORT.md` | 同上，结论只在推理层 |
| `performance-improvements-spec.md`（5 月）、`performance_report.md`（7 月） | 早期性能结论未复测 |

### ✅ 已正确标注作废（不是问题，但要养成习惯）

全仓 18 份含 `test:contract` 字面量的文档，**100% 已在首行加"⚠️ 口径已作废"横幅**（逐份核对遗漏为 0）。
- ✅ 正确做法：先看首行横幅，再读正文。
- ⚠️ **唯一陷阱**：`_archive/2026-10/SPEC_palink-new合并回主区_2026-10-03.md` 记录了一条批量 sed 策略
  （把 `test:contract` 批量替换成 `vitest run`）。**若有人照此对已加横幅的 18 份再跑一遍 sed，会破坏横幅。**

---

## 四、🔴 st-\* 命名陷阱存活表（防误删，务必先查）

**核实时点 2026-10-05，全部逐个确认存在/在用。**

**仍然存活（别按名字误删）**：

| 名字 | 实际情况 |
|---|---|
| `backend/app/api/st_groups.py` | ✅ 存在。Palink **自有**群聊后端，与已删的 st-native 无关 |
| `backend/app/services/st_sync_service.py` | ✅ 存在。被 character/personas/worldbook/character_ext 主链路引用 |
| `synthesize_tts_st_compat` | ✅ **在用**，Palink TTS 端点，`backend/app/api/tts.py` |
| `'st-compat-v2'` | ✅ **在用**，智能卡 runtime 版本标签，`SillyTavernCompatRuntime.ts` |
| `st-vec::` | ✅ 在用，记忆向量前缀 |
| `get_st_current_user` | ✅ 在用，共享认证依赖 |
| `frontend/src/lib/plugin-system/` | ✅ 属于 **palink-native**，与已删 st-native 无关 |
| `st-plugins/` 目录 | ✅ 属于 palink-native |
| `config.py` 的 `ST_NATIVE_*` 字段 | ✅ 在用（elevenlabs 语音转发、`st_sync_service.py`、`core/security.py` 的 HMAC 签名）。⚠️ 唯一消费链是 elevenlabs，后续删 elevenlabs 需同批清理 |
| `lib/group-chat/` | ✅ 经 `getContext.ts` 活着，**勿连带误删** |

**已死（引用即错）**：`silly_tavern_mode` 列（已 drop，alembic 0062）、`ST_NATIVE_SERVICE_URL` 之外的 `api/st/native/proxy`、`/csrf-token`、`SEALED_ST_MODES`、`_st_mode_effective`、`_is_st_compat_mode`、服务端 `build_st_compat_messages`、iframe 嵌入完整 ST 的 sidecar 链路。

**权威来源**：`_archive/2026-10/REPORT_重复废弃与互搏代码审查_2026-10-02.md` + `agents.md`。
⚠️ **本文表是抄录，不是重新推断。遇 st-\* 疑点去那两份查，不要只看这里。**

---

## 五、docs/ 子目录状态

| 目录 | 份数 | 状态 | 建议 |
|---|---|---|---|
| `archive/` | 19 | ✅ 已归档（2026-05 一批老文档） | 归档区的**唯一先例** |
| `_原型改皮截图_2026-10-03/` | 9 | ✅ 已完成的一次性产物（非文档） | 保留 |
| `goal-groupchat/` | 4 | ✅ **活跃**（唯一 10 月仍有提交） | ⚠️ 内含一份 07-23 的失配报告 |
| `st-compat-handover/` | 6 | 🔴 主题作废 | 建议归档（会互相引用加固失效结论） |
| `st-plugin-compat-spec/` | 10 | ⚠️ **部分作废**（phase-4 是 palink-native） | ⚠️ 不能整目录封杀 |
| `backend_group_chat_spec/` | 5 | ⚠️ 07-23 后无提交。主题代码仍在，技术上未必失效 | 架构已多次重构 |
| `inline-card-rendering-plan/` | 4 | 🔴 已死 | 已被 10-03 相册/渲染 HANDOFF 覆盖 |
| `fullscreen-card-functional-parity/` | 1 | 🔴 已死（08-11） | 同上 |
| `light-mode-contrast-enhancement/` | 1 | 🔴 已死（08-11） | 同上 |

**⚠️ 归档区此前只收了 5 月那批，7–9 月的大量死文档仍留在顶层。**

---

## 六、⚠️ 清理陷阱（动手前必读）

- **`docs/_原型改皮截图_2026-10-03$n.png` 的文件名带字面 `$n`** —— shell 未转义留下的错误文件名。
  ⚠️ **任何 `rm docs/*` 或 glob 类批量操作都会漏掉它。**
- 顶层还有 5 个报错提示 UI 原型 `.html`、2 个 `settings-demo-*.html`（5 月）、
  `bundle-stats-2026-09-21.txt`、`酒馆助手修复后_galgame面板_2026-10-03.png`。
  **不是文档，别误删也别当文档引用。**
- ⚠️ **清理必须走三步**：列清单 → 用户确认 → 隔离到 `_BACKUPS/_QUARANTINE_<日期>/`。
  禁止直接删。规范见 `agents.md` §备份与清理规范。

---

## 七、维护规则

1. 新增文档在这里登记一行（名字 / 日期 / 可信度 / 失效条件）。
2. **文档状态变化时回来改对应行**，别只改新文档让旧的烂掉。
3. 分级看**结论的证据层级**（一手实测 > 二手 > 仅推理），不看日期新旧。
   一份 8 月的实测报告可以可信，一份昨天的纯推理文档不可信。
4. 发现索引与现实冲突 → **改索引加订正**，并注明订正日期。**别默默只信一边。**
