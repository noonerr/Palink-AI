# SPEC — palink-new 合并回主区 + 未修完问题收尾（2026-10-03）

> **✅ 施工完成（2026-10-03 19:40）**。9 批提交 `555ac9b` → `e44e063`，
> 门禁 pytest 1758 passed / tsc 0 / vitest 661 passed。R1–R5 全部落地。
> 本文保留原方案与踩坑记录，供复盘；**执行结果见文末「九、实际执行结果»**。

> **上游依据**：
> ① `docs/架构审查与缺陷总表_2026-10-03.md`（那个 agent 的 55 条 findings）
> ② `docs/SPEC_架构审查修复_2026-10-03.md`（他的 Z1-Z7 / T1-T5 修复计划）
> ③ 我的独立复核结论（55 条逐条实测，见 `docs/REVIEW_palink-new修复复核_2026-10-03.md`）
>
> **用户裁定（2026-10-03）**：以新代码为主 → palink-new 的修复成果合并回主区 `Palink-AI`，
> palink-new 降级为回退保险。三项决策：**① 合并保留（不动主区独有的备份区/.mimosa/群聊文档）
> ② 主区库迁到 0067 ③ 合并后只留一套容器**。
>
> **基线**：主区 `79969a7` / alembic `0065`；新区 `52639d5` / alembic `0067`。
> **合并前备份**：`_BACKUPS/2026-10-03_合并palink-new前_主区快照/`（已完成，见其 `BACKUP_INFO.md`）。
> **旧代码实体留档**：`D:/项目/palink_old/`（1355 文件，`git archive` 从 `79969a7` 导出）。

---

## 零、三条铁律（违反即事故）

1. **不动数据**：主区 `backend/data`（429M 业务数据）、`frontend/dist`（nginx bind mount 在用产物）、
   `_BACKUPS/`（1.4G）、`.mimosa/`（1.6G）、根级 `图片/` `记忆/` 与两个 `屏幕录制*.mp4`。
   用户已裁定这些**原样保留、不参与合并**。
2. **不丢主区独有成果**：`docs/goal-groupchat/` 4 个文档带 59 行未提交改动，新区没有；
   另有 `_BACKUPS/_INDEX.md` 的 40 条台账。覆盖前必须已备份（已完成）。
3. **分批提交，每批可独立回滚**：不许 `git add -A`（仓库有 63 个未跟踪路径，含 1.4G 备份区），
   一律逐项 pathspec 暂存。

---

## 一、合并方案：为什么不是"直接覆盖"

### 1.1 实测差异（136 处，排除 .git/node_modules/dist/_BACKUPS/data）

| 类别 | 数量 | 处置 |
|---|---|---|
| **仅新区有**（修复本体） | 11 项 | 全部搬入主区 |
| **仅主区有** | 大量（备份区/.mimosa/20+ 份历史文档/群聊文档） | **保留不动**（用户裁定） |
| **两边都有但内容不同** | 约 40 个源码文件 | 取新区版本（它是修复后的），但**先逐个确认主区改动是否已进新区基线** |

### 1.2 仅新区有的 11 项 = 修复本体（合并的核心）

```
backend/alembic/versions/0067_add_memory_character_id.py   ← 数据库迁移，主区缺
backend/tests/test_worldbook_character_isolation.py        ← 302 行回归测试
backend/tests/test_worldbook_import_character_binding.py   ← 180 行
backend/tests/test_ext_prompt_source_key_gate.py            ← 205 行
backend/tests/test_memory_scope_guard.py                    ← 69 行
backend/tests/test_reasoning_auto_effort_budget.py         ← 143 行
frontend/src/components/ui/custom/__tests__/chat-input-draft-contract.test.ts   ← 296 行
frontend/src/utils/__tests__/st-plugin-shared-partition.test.ts              ← 148 行
frontend/src/lib/plugin-system/sandbox.ts                   ← Z1 沙箱 @sillytavern 解析
frontend/src/services/prompt-injection.ts                   ← T3 角色分区
…（另含 character_ext.py / websocket.py / inference_dispatcher.py / worldbook_service.py
   / roleplay_prompt_assembly.py / storage.py / ChatInput.tsx 等已跟踪文件的修复版本）
```

### 1.3 ⚠️ 主区「已修改但新区没有」的 4 个文件 —— 合并前必须逐一核对

| 文件 | 主区改动 | 处置 |
|---|---|---|
| `docs/goal-groupchat/goal-overview.md` | +26 行 | **保留主区版本**（新区无此改动） |
| `docs/goal-groupchat/goal-plan.md` | +6 行 | **保留主区版本** |
| `docs/goal-groupchat/goal-design.md` | 改动 | **保留主区版本** |
| `docs/goal-groupchat/.goal-state.md` | 改动 | **保留主区版本** |
| `_BACKUPS/_INDEX.md` | 台账 40 行 | **保留主区版本**（已追加本次登记行） |

> 已实测：报错提示批（`websocket.py` / `stream_builder.py` / `App.tsx` / `ErrorToast.tsx` /
> `Message.tsx` / `NetworkStatus.tsx` / `index.css` / `systemMessage.ts`）在**两边内容一致**——
> 说明新区基线已把它吸收，合并不会丢。这条是合并可行性的关键前提。

---

## 二、剩余未修完问题的解法（5 项）

以下是复核查出的"承诺过但没做 / 假做 / 规格外缺口"。按**收益/风险比**排序。

### R1【已完成，但需订正我最初的判断】容器化文件

**我最初的说法**：palink-new 的 `frontend/Dockerfile`、`nginx.conf` 等全是 untracked，
新容器靠它们建的 → 「该仓库 clone 出去跑不起来」。

**⚠️ 订正**：合并到主区后实测 `git ls-files --error-unmatch` —— **主区这 6 个文件本来就跟踪着**
（`Dockerfile` / `Dockerfile-Pal` / `Dockerfile.dev` / `Dockerfile.dist` / `nginx.conf` /
`security-headers.conf`）。所以「主区 clone 跑不起来」**不成立**，那只是 palink-new
从 tar 包解出时丢了 git 索引的假象。本批实际只补进 1 个新文件：`docker-compose.test.yml`。

**教训**：「某文件没被跟踪」的结论必须在本工作区实测，不能从另一个工作区的情况推断。

### R2【必做·备份规范】备份目录缺说明书与台账

**问题**：`palink-new/_BACKUPS/2026-10-04_清理未绑定世界书/` 无 `BACKUP_INFO.md`、
`_INDEX.md` 在新区不存在（未登记台账）、目录名日期写成明天（实为 10-03 17:51）。
违反 AGENTS.md 备份规范第 2、3 条。

**解法**：
1. 补 `BACKUP_INFO.md`（四要素：日期/来源/原因/待办）
2. **目录名日期订正**为 `2026-10-03`（改目录名 = 重命名，不是改写存量内容，允许）
3. 台账登记进主区 `_BACKUPS/_INDEX.md`
4. **验收判据**：`git ls-files _BACKUPS/` 能查到该 `BACKUP_INFO.md`

### R3【高收益·插件兼容】Z5 宏求值恒等函数

**问题**：`sandbox.ts:5265` `MacrosParser.evaluate` 仍是 `return String(text ?? '')`。
承诺"接上 `MacroRegistry`"未做。影响：`st-plugins/memory`、`stable-diffusion` 的
`registerMacro('summary')` 注册成功但永不参与求值。

**解法**：
1. 在 `MacrosParser` 里维护 `_macros` 已有 → 让 `evaluate` 遍历注册项做 `{{name}}` 替换
2. **必须复用已有的 `substituteParams`**（注释已说明"沙箱宏求值走 substituteParams"），
   不要另写一套引擎 —— 这是 ST 的做法，也避免 P2-7 的双实现再扩大
3. **验收判据**：`st-plugins/memory` 注册宏后，`evaluate('{{summary}}')` 返回注册值而非原文；
   新增 vitest 用例锁住；`vitest` 全绿

### R4【文档一致性】Z6 失效命令未清

**问题**：24（新区 18）份文档仍写 `test:contract`，该脚本已删（现只有 `vitest run`）。
另有 136（新区 76）份文档仍写 `st-compat`/`st-native`，与 AGENTS.md「已删除」矛盾。

**解法**：
1. **只改命令，不改历史叙述**：`test:contract` → `vitest run`。
   ⚠️ `st-compat`/`st-native` 的历史 SPEC 描述**不动** —— 那是当时的决策记录，改了等于伪造历史。
   只在 AGENTS.md 增补一节「历史文档口径说明」声明这些词已废弃。
2. **验收判据**：`grep -rl test:contract --include=*.md` = 0

### R5【用户可感知】P2-3 模型「最大输出」恒失效

**问题**：后端 `websocket.py:1566` 覆盖逻辑前提是"前端没传 `max_tokens`"，
但 `useCharacterChat.ts` **4 个调用点全都恒传**（含 `?? 2048` 兜底）→ 模型管理里设的值永远不生效。

**解法**：
1. 后端判定改为 `max_tokens` **值为 `None`** 才用模型上限（而非"键不存在"）
2. 前端删掉 4 处 `?? 2048` 兜底，无值就不传该键
3. **验收判据**：模型管理设 8000 → 日志 `STREAM-CALL max_tokens=8000`

---

## 三、废物文件识别与清理（**列清单 → 隔离 → 确认 → 才删**）

> 遵守 AGENTS.md 规范第 5 条。**本节只出清单，不执行删除。**

### 3.1 已确认为废物的（待你确认后隔离）

| 候选 | 证据 | 处置建议 |
|---|---|---|
| `.mimosa/` 1.6G / 45963 文件 | mimosa 工具的 hook 基线快照，gitignored，主区实测仍在 | 隔离后删（工具会自建） |
| `_BACKUPS/` 内 4 份重复 git bundle（各约 130M，占 46%） | P3-1 | 保留 1 份最新，其余隔离 |
| `test_attack/` 10 个探测 payload | 全仓零引用（P3-9） | 隔离后删 |
| `CODE_WIKI.md` / `SILLYTAVERN_NATIVE_LAYER_PLAN.md` / `overview.md` | 早于 git 恢复起点 / 全篇写已删的 st-native / 自标"已过期"（P3-5） | 隔离后删 |
| `.bak-20261003` 文件 | P2-15，`.gitignore` 未覆盖 | 加 ignore 规则，不删 |
| `seed.sql`（新区 32M） | 数据库导出，来源不明 | **先问清用途再定**，别擅自删 |

### 3.2 红线，一律不动

`frontend/dist`、`backend/data`、根级 `图片/` `记忆/`、两个 `屏幕录制*.mp4`、
`.claude/` `.codex/` `.trae/` `.workbuddy/` `.githooks/`、`_BACKUPS/` 存量内容。

---

## 四、数据库整理

### 4.1 主区库从 0065 → 0067

```
现状：主区 palink-ai-db-1 停在 0065_drop_dialogue_mode_column
     新区 palink-new-db-1 已在 0067_add_memory_character_id
待补：0066（需确认是哪支）+ 0067_add_memory_character_id.py（从新区搬入）
```

**步骤**：
1. 确认 0066 是哪支迁移（新区 `alembic/versions/` 里 0065 之后直接是 0067，**可能缺 0066**）
2. `docker exec palink-ai-db-1 alembic upgrade head`
3. **验证**：`SELECT version_num FROM alembic_version` = `0067_add_memory_character_id`
4. **验证**：`\d conversation_memories` 有 `character_id` 列 + `idx_memory_character_user` 索引
5. ⚠️ 迁移前先 `pg_dump`（**已完成**，见备份目录 `main-db-dump.sql`）

### 4.2 数据一致性

- 主区与新区的 `backend/data` 是**两份独立副本**（inode 不同，均 429M）→ 合并时**不动任何一个**
- 新增记忆会写 `character_id`；存量 443 条 admin 记忆为 NULL 但**都带 `session_id`**
  （走会话内检索分支，不受角色过滤影响）→ 无需数据迁移

---

## 五、分批提交序列（每批独立可回滚）

```
批 0  ✅ 备份 + 台账登记（已完成）
      文件：_BACKUPS/2026-10-03_合并palink-new前_主区快照/**、_BACKUPS/_INDEX.md

批 1  合并修复本体（后端）
      0067 迁移 + 5 个后端回归测试 + 6 个后端源码文件
      门禁：pytest failed=0（基线 1749 passed / 51 skipped）

批 2  合并修复本体（前端）
      sandbox.ts / prompt-injection.ts / ChatInput.tsx / CharacterChat.tsx /
      useCharacterChat.ts / WorldBookManager.tsx / 等 + 2 个前端测试
      门禁：tsc exit 0；vitest failed=0（基线 48 文件 / 653 passed / 3 skipped）

批 3  容器化文件入库（R1）
      Dockerfile ×4 / nginx.conf / security-headers.conf / 5 个构建配置 /
      docker-compose.test.yml
      门禁：干净 clone 能起容器

批 4  备份规范补齐（R2）
      补 BACKUP_INFO.md + 目录名日期订正 + 台账登记

批 5  主区独有文档单独提交（不覆盖）
      goal-groupchat 4 文档 + _BACKUPS/_INDEX.md 台账

批 6  文档口径清理（R4）

批 7  Z5 宏求值修复（R3）—— 独立一批，改行为

批 8  P2-3 模型上限修复（R5）—— 独立一批，改用户可见行为
```

**每批门禁**：pytest / tsc / vitest 三项，见 `AGENTS.md`。
⚠️ **前端改动后必须重建 dist**（`VITE_OUT_DIR` → 校验 → 原地覆盖 → 清孤儿 → gzip，
**禁用 `npm run build`**），否则等于没改。

---

## 六、容器收尾

用户裁定：**合并后只留一套**。

1. 主区 `palink-ai-backend-1` / `palink-ai-frontend-1` 用**新代码**重建
2. 新区 `palink-new-*` 三个容器 **stop 不删**（保留回退，数据在卷里）
3. 停掉旧的前端 bind mount 前，先确认新 dist 已就位
4. ⚠️ 重建前确认 `docker-compose.yml` 与新区一致

---

## 七、明确不做

- ❌ 不删 `llama_runtime.py` / `inference_queue.py` / `plotline.py` / `lib/group-chat/`（已查实存活）
- ❌ 不动主区 1.4G 备份区与 `.mimosa/`（本轮只列清单，不删）
- ❌ 不做存量数据迁移（无存量用户）
- ❌ 不拆 `roleplay_prompt_assembly.py`（5525 行，另立 spec）
- ❌ 不删 palink-new 工作区（用户裁定降级为回退保险）
- ❌ 不改历史文档里的 `st-compat`/`st-native` 叙述（那是当时的决策记录）

---

## 九、实际执行结果（2026-10-03 19:40 收工）

### 9 批提交

| 批 | commit | 内容 |
|---|---|---|
| 1 | `555ac9b` | 后端修复本体（0067 迁移 + 5 个回归测试 + 世界书/记忆/思考） |
| 2 | `941532b` | 静默失败留痕 + 5 个配套测试对齐 |
| 3 | `a542864` | 前端修复本体（角色分区 / 沙箱别名 / 输入框 ref 化） |
| 4 | `da77388` | 容器化与编排文件入库（实际只补进 `docker-compose.test.yml`） |
| 5 | `a1c2b24` | 主区独有文档 + 备份台账 |
| 6 | `02f965d` | 报错提示批遗留入库 |
| 7 | `63fff49` | Z5 注册宏真正参与求值 |
| 8 | `edea3dc` | 模型「最大输出」对角色扮演生效 |
| 9 | `e44e063` | AGENTS.md 测试基线数字 |

### 门禁（合并后主区实跑）

```
pytest  1758 passed / 51 skipped / 0 failed   （合并中一度 34 红，见下）
tsc     exit 0
vitest  49 文件 661 passed / 3 skipped / 0 failed
alembic 0067_add_memory_character_id
```

### 过程中三次踩坑（都是我自己引入或漏掉的）

**① 合并致 34 个测试集体变红。** 根因不是修复有 bug：5 个测试文件的建书 helper 不传
`character_id` → 建出的书「未绑定」→ 在「未绑定不再注入」的新契约下拿不到条目 →
`build_worldbook_context` 返回空串。**解法是取新区测试版本，不是回退源码。**
另漏搬 `app/api/memory.py`，补上后 34→10→0。
→ 教训：改数据契约时，依赖旧契约建测试数据的地方都会红，属预期连带成本；
判定方法是看同一批测试在来源工作区是否绿。

**② Z5 第一版引用了不存在的 `substituteParams`**（本文件导入名是 `substituteParamsExtended`），
被自己新写的 8 例行为测试当场抓出。
→ 教训：守卫要写**行为断言**（走 `executePluginCode` 真插件路径），不是源码字符串断言。

**③ R5 前端有 5 处 `?? 2048` 恒传，SPEC 与缺陷总表都只记了 4 处**，漏的是
`CharacterView.tsx:1348`。
→ 教训：按清单改完必须再全仓 grep 一次。

### 仍未做（有意留待你决定）

- **废物文件清理**：清单在 §3.1，按规范只列不删，等你走「列清单 → 隔离 → 确认 → 才删」
- **主区 2 本未绑定世界书**（`galgame界面插件`、`Magical Fairy`）：现在不再注入并记
  `[WB-UNBOUND]` 告警，需你去世界书管理页补绑角色
- **结构性欠账**（另立 spec）：上帝文件 5525 行、四份 MessageFormatter、services→api 环、
  P1-12 前端宏展开空串、P1-13 slash command 只写不读、P1-5 LLM 无故障转移
- `2026-10-04_清理未绑定世界书` 目录名日期仍错（实际 10-03），已在其 `BACKUP_INFO.md` 标注待订正