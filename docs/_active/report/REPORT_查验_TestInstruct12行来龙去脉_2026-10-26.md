# REPORT — 查验 TestInstruct 12 行来龙去脉（T2）

> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

`docs/_active/HANDOFF_主脑交接_ST三面一致工程_2026-10-25.md` §2 写「无 TestInstruct 变化（仍 12 行，等点头）」、§3.2 写「TestInstruct 12 行清理：等点头（一条 DELETE）」，但没有大白话记录说这 12 行是什么。`docs/_active/SPEC_下一程计划_用户裁定与排期_2026-10-26.md:18` 立项 T2：查清来龙去脉后大白话呈报，用户点头才删。本报告即 T2 交付。

**一句话大白话**：这 12 行是 2026 年 7 月底 st-compat 时代一个「黄金向量」测试脚本反复跑测试时，落在生产库里的同名测试模板——脚本每跑一次建一行、清理时唯独忘了删它，跑了 12 次就剩 12 行；它属于一个测试账号、界面上谁也看不到、没有任何功能引用它，删掉零影响。

## 方法

全部只读：grep 代码/文档/git 历史（pickaxe）、读历史 commit 的文件内容、三份历史 pg_dump 备份 grep 比对、进 `palink-ai-backend-1` 容器用 `docker exec -i … python -u -` + heredoc 跑 SQLAlchemy SELECT（含 information_schema 约束查询）。未执行任何写操作；DELETE SQL 只写在报告里。

## 发现（逐条带证据）

### 1. 是什么：`instruct_templates` 表里 12 行完全同构的测试模板，属于测试账号 hacker_test

容器内实测（`docker exec -i palink-ai-backend-1 python -u -`，SELECT）：

- 表内总数 17 行 = 5 行系统预置（`user_id IS NULL`：Llama 2 / Llama 3 / Mistral / ChatML / Alpaca，created_at 均为 2026-06-26 13:51）+ **12 行 `TestInstruct`（id 6–17）**。
- 12 行字段完全一致：`user_id=4`、`name='TestInstruct'`、`input_prefix='### User:'`、`output_prefix='### Assistant:'`、`is_default=f`、`names_behavior='force'`，仅 created_at 不同：
  - 2026-07-19 五次：18:47:35 / 19:13:50 / 19:36:04 / 19:40:04 / 19:57:04（id 6–10）
  - 2026-07-21 六次：18:32:57 / 22:18:59 / 22:21:36 / 22:29:28 / 22:32:19 / 22:49:02（id 11–16）
  - 2026-08-11 一次：11:01:41（id 17）
- `user_id=4` 实测为 `users` 表里的 **`hacker_test`**（role=user, is_active=True）——一个测试账号。users 表共有 23 个账号，其中大量是 `test_*` / `qa_*` / `*_test` 形态的测试账号。
- `user_settings` 全部 23 行实测：`instruct_template_id` **全为 NULL**、`instruct_enabled` 全为 NULL/False；`SELECT count(*) FROM user_settings WHERE instruct_template_id BETWEEN 6 AND 17` = **0**。

### 2. 怎么进来的：st-compat 时代的黄金向量生成器，建行后清理段漏删，每跑一次漏一行

写入源头是 **`scripts/st-compat/prompt_golden/palink_golden_vector.py`**（该脚本现存于 commit `7d5dea1`「restore: baseline of full working tree after git object loss (2026-08-17)」，2026-09-03 随 st-compat 剥离 `091023e` 删除，当前工作区已不存在）。关键证据（行号取自 `git show 7d5dea1:scripts/st-compat/prompt_golden/palink_golden_vector.py`）：

- `:160-173` fixture 定义 `instruct_template = {"name": "TestInstruct", "input_sequence": "### User:", "output_sequence": "### Assistant:", "system_sequence": "### System:", "stop_sequence": "### User:", …}` —— 与库内 12 行的字段值逐一吻合。
- `:207` `from app.core.database import SessionLocal`、`:230` `db = SessionLocal()` —— 脚本在容器内运行时直连的就是生产库（这正是 2026-10-21 盘点报告 §3 记的「容器内跑 pytest 会直连生产库并建表/写数据」病灶的脚本版）。
- `:239` `test_user = db.query(User).filter(User.is_active == True).first()` —— 绑定当时第一个 active 用户（即 user_id=4）。
- `:316-334` 每次运行 `it = InstructTemplate(...)`、`db.add(it)`，并把 `user_setting.instruct_template_id = it.id`、`instruct_enabled = True`。
- `:464-481` 清理段：删了 CharacterChatMessage / CharacterChatSessionBranch / CharacterChatSession / WorldBook / Character / PromptPreset，**唯独没有删 InstructTemplate 行，也没有复位 user_setting.instruct_template_id**（`git show … | grep "db.query(InstructTemplate)"` 零命中）。
- ⇒ 每跑一次 `--fixture char_with_instruct` 就在生产库留下 1 行 `TestInstruct`。库内 12 个 created_at 就是 12 次运行的时间戳（07-19 五次、07-21 六次、08-11 一次），时间聚集形态与手工反复跑测试的节奏一致。
- **源头已灭**：最后一行是 2026-08-11，之后再无新增；脚本与 st-compat 模式 2026-09-03 已删（`091023e`）。
- **无其他写入源**：`git log --all --oneline -S "TestInstruct"`（全仓 pickaxe）仅命中 7 笔 commit，其中涉及代码的只有 `7d5dea1`（夹具 JSON + 本脚本）与 `091023e`（删夹具），其余 5 笔全是文档；本仓当前代码与历史中**没有任何测试/脚本**以 `name="TestInstruct"` 经 API 或 ORM 写库。容器内复核：`docker exec palink-ai-backend-1 grep -rl 'TestInstruct' /app` → 零命中（无 git 外残留脚本）。
- 关联但不写库的历史物证：`backend/tests/st_compat/golden_vectors/palink_char_with_instruct.json:146`（golden 期望值里有 `template=TestInstruct`，同样随 `091023e` 删除）。

### 3. 「13 行 → 12 行」：12 是对的，「13」查无实据，疑为 10-21 报告的算术口径问题

三份历史 pg_dump + 今日活库比对（grep COPY 数据段，逐行格式一行=一行）：

| 快照 | TestInstruct 行数 | 证据 |
|---|---|---|
| 2026-10-03 主区快照 | **12**（id 6–17） | `_BACKUPS/2026-10-03_合并palink-new前_主区快照/main-db-dump.sql:2765-2776` |
| 2026-10-05 迁移前 dump | **12**（id 6–17） | `_BACKUPS/2026-10-05_dist重建前_MVU批次A/pre-migration-0068.sql:2414-2425` |
| 2026-10-24 三面一致开工前 | **12**（id 6–17） | `_BACKUPS/2026-10-24_三面一致开工前/db-ai_hub-pre-threeway-20261024.sql:3049-3060` |
| 今日活库（2026-10-26） | **12**（id 6–17） | 容器 SELECT（见发现 1） |

即至少自 2026-10-03 起**一直是 12 行，从未有人删过一行**。而 `REPORT_ST配置文件与默认值缺口盘点_2026-10-21.md:34` 写「17 行，其中 13 行是 TestInstruct ⇒ 真实只有 5」——同句自相矛盾（17−5=12，17−13=4，两头对不齐）。判定：**「13」是 10-21 报告的算术口径问题（高置信推断，最终裁定待主脑）**；实测真值是 12，此后所有文档（10-24 报告、10-25 交接书）写的 12 与物理证据一致。10-25 交接书「无 TestInstruct 变化（仍 12 行）」经比对属实。

### 4. 界面上能不能看到：看不到（前端无入口 + API 也只对 hacker_test 可见）

- **前端零入口**：`grep -rn "api/instruct-templates" frontend/src` 零命中；`grep -rni "instruct_template|instructTemplates|instruct-templates" frontend/src -l` 零命中——当前没有任何页面/组件列出 instruct 模板（前端仅有的 instruct 相关命中是卡片字段 `post_history_instructions` 和 getContext shim 里的硬编码）。⇒ 10-21 盘点报告 §3「在此之前，界面上会看到 13 个同名干扰项」的说法**在当前代码下不成立**（当时应为推断，现无代码支撑；待主脑裁定是否订正该报告）。
- **API 侧也只对属主可见**：`GET /api/instruct-templates`（`backend/app/api/instruct_templates.py:81-100`）只返回 `user_id IS NULL` 的系统预置 + 请求者自己的行——这 12 行（user_id=4）只对账号 `hacker_test` 可见，admin/其他用户都看不到。
- **插件面**：沙箱 getContext shim 硬编码 `instruct: { enabled: false }`（`frontend/src/lib/plugin-system/sandbox.ts:5251`），不暴露模板列表。

### 5. 删掉影响什么：零影响

- **装配链**：`instruct_templates` 的唯一业务消费点是 `backend/app/services/roleplay_prompt_assembly.py:127-150` 的 `_load_instruct_template`——`instruct_enabled` 为假直接返回 None（不包装）。实测全部用户 `instruct_enabled` 为 NULL/False，功能本就关着。
- **引用链**：全后端 `InstructTemplate` 模型消费方仅 4 处（`grep -rln "InstructTemplate" backend/app`）：`main.py`（启动种子）、`api/instruct_templates.py`、`models/`、`roleplay_prompt_assembly.py`。唯一概念引用列是 `user_settings.instruct_template_id`（裸 Integer，`backend/app/models/system.py:62-64`），实测 0 行指向 id 6–17。
- **DB 级约束**：information_schema 实查，**没有任何外键约束引用 instruct_templates**（查询返回 NONE），删除不会触发级联或拦截。
- **系统种子**：启动幂等种子 `backend/app/main.py:113-133` 按 `user_id IS NULL AND name=…` 匹配（`backend/app/core/instruct_template_seeds.py:22/39/56/73/90` 五个名字），与这 12 行（user_id=4）永不相交，删后 5 个系统预置不受影响。

### 6. 建议的 DELETE（只写不执行，等用户点头）

删前先核对（应返回 `12 | 6 | 17`；本查验当日实测即此值）：

```sql
SELECT count(*), min(id), max(id) FROM instruct_templates WHERE name = 'TestInstruct' AND user_id = 4;
```

精确删除（推荐，写死实测到的 id 区间 + 名字 + 属主三重条件）：

```sql
DELETE FROM instruct_templates
 WHERE id BETWEEN 6 AND 17
   AND name = 'TestInstruct'
   AND user_id = 4;
```

等价简化版（若担心未来 id 漂移，按名字+属主删；本查验时两版命中面完全相同）：

```sql
DELETE FROM instruct_templates WHERE name = 'TestInstruct' AND user_id = 4;
```

删后核对（应返回 5 和 0）：

```sql
SELECT count(*) FROM instruct_templates;                       -- 期望 5
SELECT count(*) FROM instruct_templates WHERE name='TestInstruct';  -- 期望 0
```

注：若用户点头执行，属破坏性写，按本仓惯例应先 `pg_dump -t instruct_templates` 落 `_BACKUPS/` 并登记台账（2026-10-24 基线 dump 已含这 12 行，可作第二重回退保险）。

## 未能查验 / 待主脑裁定

1. **脚本首次入仓时间无法追溯**：2026-08-17 git object loss 后 `7d5dea1` 是恢复基线，更早历史不完整。只能证明脚本存在于 08-17 基线、最早污染行为 2026-07-19 18:47（该时间即第一次运行的直接物证）。
2. **为何当年绑定的是 hacker_test（id=4）**：脚本 `:239` 取第一个 active 用户且无 order_by，推断 7 月时它是首位 active 用户；users 表无 created_at 列，无法实证当时账号排序。此点标推断。
3. **user 4 的 `instruct_template_id` 何时被清回 NULL**：脚本清理段不复位（最后一次运行后应残留指向 id=17 的绑定），但今日实测全库为 NULL——中间何时/被谁清掉无法查证，不影响删除影响面结论（现值已实测为 NULL）。
4. **「13 行」的最终定性**：三份 dump + 活库均为 12，判定为 10-21 报告算术口径问题是高置信推断，是否订正该报告待主脑裁定。
5. **docs 目录未刷新**：本任务纪律为只读、禁改除报告外的任何文件，故未跑 `python scripts/docs/gen_docs_catalog.py`。本报告入库提交时，主脑需补跑该脚本刷目录（否则 `--check` 会 STALE）。

## 结论与建议

1. **这 12 行 = 测试污染残留**：st-compat 时代黄金向量脚本 12 次运行各漏 1 行，属测试账号 hacker_test，源头脚本 2026-09-03 已随 st-compat 剥离删除，污染自 2026-08-11 后停止。
2. **当前完全不可见、零引用**：无前端 UI、API 仅属主可见、无任何 user_settings/外键引用、装配链因 instruct_enabled 全关而读不到它——删掉对功能零影响。
3. **可以放心按上文 SQL 删**：建议走「删前 count 核对 → 精确 DELETE → 删后 count 核对」三步，并在执行前对 `instruct_templates` 单表 dump 备份入 `_BACKUPS/`。**执行仍等用户点头**（本任务只查验，未执行任何写）。
4. 顺带建议（供主脑排期，不属本查验结论）：「测试打生产库」的根因在 10-21 盘点报告 §4 已挂账（修法：测试改独立库），本次脚本版病灶是同一根因的又一实证，可合并处理。
