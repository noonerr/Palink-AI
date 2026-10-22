# BACKUP_INFO — 2026-10-11 记忆阶段 0「止血 + 立尺子」

## ① 备份日期

2026-10-11 12:11（+08:00）

## ② 原始来源路径

动工前逐字节快照（`pre/` 按原相对路径保存，`_manifest.tsv` 记 sha256 + 字节数；
校验方式：`awk -F'\t' '{print $1"  pre/"$3}' _manifest.tsv | sha256sum -c -` ⇒ 6/6 OK）：

| # | 文件 | 本轮是否改动 | 说明 |
|---|---|---|---|
| 1 | `backend/app/memory_module/config.py` | ✅ 改（D1） | `BLOCK_STM_EXCLUDE_FACTOR` **1 → 4**（原计划 3，P73 实测后修正） |
| 2 | `backend/app/memory_module/service.py` | ✅ 改（D2 + D6） | D2：`NEIGHBOR_MAX_ADDS` 全局封顶 → 每命中各自封顶；D6：缓存键补 `memory_mode` + `max_tokens` |
| 3 | `backend/app/memory_module/retriever.py` | ✅ 改（D1 自适应重取 + D5） | D1：STM 被排除集吃光时**自适应重取**（≤2 轮）；D5：`[MEM-DIAG]` 诊断日志 |
| 4 | `backend/app/utils.py` | ❌ **未改动** | 原计划 D3（去重升级）**实测证伪后撤回**，此文件最终**逐字节未变** |
| 5 | `backend/app/api/silly_tavern.py` | ❌ **不改**（仅保护） | **他人未提交在途改动**（+70 行，ST 5 个伪路径改诚实失败 404） |
| 6 | `scripts/gate.sh` | ❌ **不改**（仅保护） | **他人未提交在途改动**（+11 行，修 docs 段写死 `python` 导致恒红） |

⚠️ **回退纪律**：工作区在备份时已有**他人未提交改动**（第 5/6 项，来自 10-10「验证体系与缺陷修复」批次）。
回退必须**按文件整体拷回**，禁止只回退本批 hunk —— 否则会抹掉他人在途改动。
⚠️ 另：`docs/_CATALOG.md` 本轮已被重新生成（263 篇），属文档产物、非代码，未入本备份。
⚠️ **测试文件不在本备份内**（备份时未列入）：`backend/tests/test_memory_exclude_recent.py`、
`backend/tests/test_memory_hybrid_retrieval.py` 本轮亦有改动，见 §④「实际落地清单」。
（两者均在版本库内、有历史提交，回退用 `git checkout -- <path>` 即可。）

## ③ 备份原因

落地 `SPEC_记忆体系降本增强路线图_2026-10-11.md` 的**阶段 0（止血 + 立尺子）**。
依据两份当日报告：`REPORT_句级记忆切分交接单查验_2026-10-11.md`、
`REPORT_记忆分项基线实测_2026-10-11.md`。

本批动因（均为**修 bug / 补可观测**，不宣称效果提升）：

- **D1（`rule` 模式 STM 恒为 0）**：assistant **实测 3.73 条记忆/条消息**（P73）、
  user 1.00、混合 2.38 ⇒ 最近 5 条消息实测含 **20 行**记忆。旧公式
  `BLOCK_STM_EXCLUDE_FACTOR=1` 只补偿 5 条 ⇒ 排除量不足 ⇒ **`memory_mode=rule` 用户完全没有记忆注入**（P74 实测非空率 0%）。
  推导：`5 + 5f ≥ 20 ⇒ f ≥ 3`；但实测尾部就是 20 行，`f=3`（15）**仍不够**，取 **f = 4**。
  ⚠️ 原稿按均值 2.52 推出 `f≥2.52⇒f=3`，**低估了尾部**（这是本批自身的一处订正）。
- **D2（邻居补不齐）**：`NEIGHBOR_MAX_ADDS=4` 是**全局**封顶，块级 `radius=1`
  ⇒ 第 1 个命中补 2、第 2 个补 2、**第 3 个起一条都补不到**。P75c 实测：命中块 183 个中
  **152 个（83.1%）被饿死**。且注释里"邻居链会拖进整段历史"的动机与代码不符
  （`_expand_chunk_neighbors` **不递归**）。
- **D3（近邻重复占位）—— ❌ 实测证伪、已撤回、零代码**：原假设"去重升级可同预算多装 20~30% 有效信息"。
  P77 实测三种去重口径结果**完全一致**（203→203→203→203，收益 **0.0%**）——
  候选在上游已按 `memory.id` 去重（`final_map[m.id] = m`）。**原稿的 +20~30% 说法是错的**。
- **D5（不可观测）**：每次检索不落任何诊断，改完只能重跑一次性探针。
- **D6（本轮新发现，原计划外）**：`get_context` 缓存键漏了 `memory_mode` 与 `max_tokens`
  ⇒ 同 query 下 `rule`/`vector` 共用缓存，切档位后最多 60 秒"切了没反应"；
  P78 排查时表现为"改了模式没生效"（`rule` 分支日志根本不落）。

**本批定位是"修 bug + 可观测 + 立回归尺子"，不宣称效果提升**（D1 只影响 `rule` 模式，默认 `vector` 不受影响）。

## ④ 实际落地清单（与 §③ 计划的差异已标明）

| 项 | 状态 | 验证证据 |
|---|---|---|
| D1 系数 1→4 + 自适应重取 | ✅ 已实施 | P74：`rule` 模式 STM 非空 **17/17 = 100%**（修复前 0%）；重取轮次有界（`calls<=3`） |
| D2 每命中各自封顶 | ✅ 已实施 | P75c：饿死 83.1%；P76：注入 31.4→**35.0 行**、9,739→**10,829 字**、4,869→**5,414 单位（+11.2%）** |
| D3 去重升级 | ❌ **撤回** | P77：收益 **0.0%**；`utils.py` 未改动 |
| D5 `[MEM-DIAG]` 日志 | ✅ 已实施 | 线上样例：`mode=vector ... stm=5 ltm=25 → inj=30 units=3969/4000 BUDGET-FULL` |
| D6 缓存键补 mode+budget | ✅ 已实施 | `TestContextCacheKey` 4 用例；**变异检验**：改回旧写法 ⇒ 2 条核心用例变红 |
| 测试改动 | ✅ 已实施 | `test_memory_exclude_recent.py` 11 passed；`test_memory_hybrid_retrieval.py` 30 passed |
| 门禁 | ✅ 全绿 | 后端 pytest（2022 passed）/ tsc / vitest（810 passed）/ docs-catalog |
| 生产路径回归 | ✅ 通过 | P79（注入态）+ P80（镜像态）：57 题生产入口注入命中 **86.0%** ≥ 78.9% 基线 |
| 部署上线 | ✅ 已完成 | 镜像重建 + 容器 Recreated + healthy；镜像内静态回读 5/5 OK |
| D4 评测资产入仓 | ⏳ **未做** | 阶段 2/3 的硬前置，另批 |

## ⑤ 待办清单（本批之后）

- [x] **D1** `BLOCK_STM_EXCLUDE_FACTOR` 1→4 + 自适应重取；STM 非空回归测试
- [x] **D2** `NEIGHBOR_MAX_ADDS` 改每命中各自封顶
- [x] ~~**D3** 去重升级~~ —— **实测证伪，撤回，未写代码**
- [x] **D5** 线上诊断日志
- [x] **D6** 缓存键补 `memory_mode` + `max_tokens`（+ 变异检验）
- [x] 门禁：`bash scripts/gate.sh` 四项全绿
- [x] **已部署上线**（2026-10-11 13:20）：`docker compose build backend` → 镜像重建；
      `docker compose up -d backend` → 容器 **Recreated**（旧 `docker cp` 注入态被替换，`/tmp` 临时探针清空）；
      健康检查 `healthy`，启动日志无 error。
      **镜像内静态回读 5/5 OK**：`BLOCK_STM_EXCLUDE_FACTOR` 默认 `"4"`、`STM-REFETCH`、
      `MEM-DIAG`、`{memory_mode}:{max_tokens}`、`per_hit_cap`。
      **P80 复测**：57 题生产入口注入命中 **86.0%**（与 P79 一致）、`rule` STM 非空 **6/6**、
      实况日志 `stm=5 ltm=25 → inj=30` 与 `rule fetch=25 → stm=5` 均正常 ⇒ **PASS**
- [ ] 提交纪律：逐项 `git add -- <path>`，禁 `-A` / `.`；
      **不提交** `backend/app/api/silly_tavern.py` 与 `scripts/gate.sh`（他人在途）
- [ ] 独立待办：`_estimate_tokens`（`roleplay_prompt_assembly.py:552-569`）未设模型时
      回退 cl100k ⇒ 约 2× 高估，影响配额扣减；未在本批处理

## 验收基线（本批不得突破）

| 项 | 动工前 | 本批后 |
|---|---|---|
| `qa2.json` 57 题注入命中（生产入口） | **78.9%**（P65 离线 block 臂） | **见 P79 输出，不得低于 78.9%** |
| 记忆注入量 | 9,739 字 = 4,869 单位 = 6,427 tok | **10,829 字 = 5,414 单位**（D2 令注入更完整，+11.2%） |
| 历史 24 条 | 13,310 tok；总 prompt 25,076 tok | **本批不动历史** |
| 记忆档位 | 4000 内部单位 | **不改**（P72 已证 6000 不涨分） |
