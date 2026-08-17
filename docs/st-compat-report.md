# SillyTavern 1.18.0 兼容性测试报告

- **对象**：Palink-AI 角色扮演组件后端（逆向自 SillyTavern 1.18.0）
- **真值来源**：`SillyTavern-1.18.0/SillyTavern-1.18.0` 内源码（唯一真值）
- **验证方式**：docker 拉起原版 ST（源码构建）+ Palink backend + PostgreSQL，逐维度对拍
- **修复纪律**：每处改动先备份至 `.backups/st-compat-2026-07-20/`，先有对拍偏差证据（≥95% 置信度）再修复，DB 结构变更走 alembic 迁移
- **变更明细**：见 `docs/st-compat-changelog.md`

---

## 1. 总览

| 维度 | 结论 | 真实偏差 | 修复 | 对拍结果 |
|---|---|---|---|---|
| 角色卡 PNG 解析/导出 | 完全兼容 | 0 | 无需修复 | V1/V2/V3 ALL PASS |
| 聊天历史 JSONL 导入/导出 | 已修复 | 3 | 透传 + send_date 规范化 | round-trip PASS |
| 世界书 / Lorebook | 已修复 | 14 字段（3 无列） | 3 列 + 迁移 0053 + 5 路径 | 三层验证 PASS |
| HTTP API 接口契约 | 兼容（回归） | 0 新增 | 无需修复（P0/P1 在位） | 回归 PASS |
| 提示词装配（宏/instruct/context） | 已修复 | 11 项宏 + 1 隐藏 bug | macro_service 扩展 | 对拍 PASS |
| 附带：迁移 0051 | 已修复 | PG 布尔默认值 | `0`/`1`→`false`/`true` | upgrade head 成功 |

**最终状态**：backend 镜像已重建持久化全部改动；DB 迁移 head = `0053`；全量回归 PASS。

---

## 2. 对拍基础设施（阶段 0）

- `docker-compose.yml`：`sillytavern`（原版源码构建）+ `backend`（Palink）+ `db`（PostgreSQL/pgvector）+ `frontend`，全部 healthy。
- 对拍 harness：`scripts/st-compat/`
  - `st_card_roundtrip.mjs`（ST 容器内 PNG write/read）+ `card_compat.py`（编排 Palink↔ST 交叉解析）
  - `results/card/{v1,v2,v3}/`：baseline 快照（chunks/parsed/cross-read JSON）
- 后端对拍测试（挂载进容器，`backend/tests/`）：
  - `st_chat_jsonl_roundtrip_check.py`（阶段 2）
  - `st_worldinfo_roundtrip_check.py`（阶段 3，含真实 PG persist→re-read）
  - `st_macro_coverage_check.py`（阶段 5，含真实 PG 全局变量）
- **环境事实**：backend 源码 BAKED 进镜像（仅 `data/models/tests` 挂载）→ 改业务代码需 `docker compose build backend`；迁移手动执行（`RUN_MIGRATIONS_ON_STARTUP=false`，alembic 单事务 DDL）。

---

## 3. 各维度审计结论

### 3.1 角色卡 PNG（数据/文件格式）—— 完全兼容，无需修复

- **真值**：`public/scripts/character-card-parser.js`（read 仅读 tEXt、优先 ccv3；write 写 `chara`+`ccv3` 两个 tEXt，base64/utf8）。
- **对拍**：同一 JSON → Palink/ST 各自导出 PNG → 互读，比对 tEXt chunk 字节与解析结果。
- **结果**：V1/V2/V3（含 Unicode + 嵌套 character_book）**ALL PASS**；`chara`+`ccv3` tEXt 均位于 IEND 前，字节级/字段级一致。
- **纠正的误报**：「正则 placement 缺 7/8/9」经核对 `extensions/regex/engine.js:281-292`，ST 仅 6 个值（0/1/2/3/5/6），与 `character_ext.py:802-807` 完全一致 —— **非 bug**。
- **结论**：`backend/app/character_card.py` 不改。Palink read 端额外接受 zTXt/iTXt 属**无害超集**（ST read 不读，保留不影响兼容）。

### 3.2 聊天历史 JSONL（数据格式 + 导入导出）—— 已修复

**真实偏差**（docker 对拍一条真实 ST AI 消息 import→export 确认）：

| # | 偏差 | ST 真值 | 影响 |
|---|---|---|---|
| 1 | `gen_started`/`gen_finished`（顶层）彻底丢失 | `script.js:6736-6737` | 生成起止时间丢失 |
| 2 | `force_avatar`/`original_avatar` 困在 extra，未回写顶层 | `script.js:5835` | ST 读 `message.force_avatar` 失败 |
| 3 | `send_date` 丢 UTC 标记（`...456000` 微秒无 `Z`） | `RossAscends-mods.js:192` `toISOString()` | ST moment 按本地时区解读 → 时间偏移 |

**修复**（透传模式，无 DB schema 变更）：
- `st_sync_service.py`（JSONL 同步路径）与 `silly_tavern.py`（HTTP `/api/chats` 路径）同构修复：
  - 新增 `_st_iso_utc()`：按 ST `toISOString` 风格输出毫秒 + `Z`（naive 视为 UTC）。
  - 导出端将 `gen_started/gen_finished/force_avatar/original_avatar` 从 extra 提升回**顶层**。
  - 导入端 `_st_msg_extra`/`_st_message_extra` 捕获 `gen_started/gen_finished` 暂存 extra。

**修复前后对拍**：修前 3 处 MISSING/WRONG → 修后 `FINDINGS: none / RESULT: PASS`（顶层字段保真，`send_date=...456Z`）。

### 3.3 世界书 / Lorebook（数据格式 + 导入导出 + 提示词装配）—— 已修复

**真实偏差**：ST worldinfo 条目导出再解析，Palink 丢 14 字段，其中 3 个**无 DB 列彻底丢失**：

| 字段 | ST 真值 | 影响 |
|---|---|---|
| `role` | `world-info.js:4008` 顶层（默认 0=system） | 影响 @Depth 注入的 system/user/assistant 角色 → **直接影响提示词** |
| `useGroupScoring` | `world-info.js` 顶层（默认 null） | WI 分组激活评分 |
| `automationId` | `world-info.js` 顶层（默认 ''） | STscript 自动化标识 |

另有 11 字段有列但导出端未回写（`ignoreBudget`/`match*`/`delayUntilRecursion`/`useProbability`/`outletName`/`triggers` 等）。ST 读取时用模板补全缺失字段 → 丢字段被静默还原为默认值，**掩盖数据丢失**。

**修复**：
1. `models/worldbook.py` WorldBookStage 新增 3 列：`role`(Integer,默认0)/`use_group_scoring`(Boolean)/`automation_id`(String)。
2. 新建迁移 `0053_add_worldbook_role_scoring_automation.py`（`down_revision=0052`，`_column_exists` 守卫 + downgrade）。
3. `silly_tavern.py` 5 处：`_nullable_bool` 助手；`_create_stage_from_st_entry`（顶层优先、回退 `extensions.*`）；`_worldbook_to_st_world_info`（flat 导出补 14 字段）；`_worldbook_to_charbook`（V3 extensions 回写）；`_persist_worldbook_from_data`/`_sync_character_book_to_palink`（另两条导入路径）。

**修复前后对拍**（`st_worldinfo_roundtrip_check.py`）：
- 序列化 round-trip：41 字段无 MISSING/WRONG → **RESULT: PASS**
- V3 character_book 导出 role/useGroupScoring/automationId → **CHARBOOK RESULT: PASS**
- 真实 PostgreSQL persist→re-read（迁移 0053 已应用）→ **DB RESULT: PASS**

### 3.4 HTTP API 接口契约 —— 兼容（回归 PASS，无新增偏差）

逐一核对 `silly_tavern.py`（`/api/characters/*`、`/api/chats/*`、`/api/worldinfo/*`）与 `st_groups.py`（`/api/groups/*`、`/api/chats/group/*`）的请求体/响应体/状态码。

**P0/P1 修复点回归验证（对照 ST 源码，确认未回退）**：
1. `/api/chats/save` 返回 `{ok: true}`（`silly_tavern.py:3151`）↔ ST `chats.js:483`。
2. `/api/chats/recent` 返回扁平 `ChatInfo[]`（`silly_tavern.py:4998`）↔ ST `chats.js:979` + `welcome-screen.js:778-786`（角色项含 `avatar`、群聊项含 `group`）。
3. `token_count`/`model` 同步进 `extra`（`_message_to_st:1248-1258`）↔ ST 前端读 `extra.token_count`/`extra.model`。

**其余核对**：`/api/chats/get` 返回 `[header, ...messages]` ↔ ST `getChatData()`；`/api/groups/*` 端点齐备。
**已知无害超集**：无会话时 Palink `/api/chats/get` 返回 `[header]`（ST 返回 `{}`），ST 客户端对二者均按空/新聊天处理。
**结论**：未发现 >80% 置信度的新契约偏差，无代码改动。

### 3.5 提示词装配（宏/instruct/context）—— 已修复

**审计范围**：宏引擎 `macro_service.py`（`evaluate_macros` 在 `roleplay_prompt_assembly.py:2527-2528` 对 system_prompt 与 messages 求值，**直接影响最终提示词**）↔ ST `macros.js:610-715` + `variables.js:238-261`。

**真实偏差**（docker 对拍确认，修前 11 项 FAIL）：
1. 注释宏 `{{// ...}}` 未剔除（`macros.js:659`）→ 注释文本泄漏进提示词。
2. 反转宏 `{{reverse:...}}` 未实现（`macros.js:658`）→ 字面残留。
3. 遗留尖括号宏 `<USER>/<BOT>/<CHAR>/<GROUP>/<CHARIFNOTGROUP>` 未替换（`macros.js:624-628`）→ 旧式角色卡字面残留。
4. 全局变量宏 `getglobalvar/addglobalvar/incglobalvar/decglobalvar` 缺失（`variables.js:251-259`）→ 字面残留。
5. **隐藏 bug**：`_split_macro_args` 按单个 `:` 切分，把 ST `::` 分隔的 `setvar::name::value` 拆成 `['setvar','','name','','value']` → `setvar`/`setglobalvar`/`addvar` 等 **ST `::` 形式静默失效**（写入空键）。

**修复**（`macro_service.py`）：
- 新增 `_apply_pre_macros()`：主循环前剔除 `{{// 注释}}`、替换遗留尖括号宏（与 ST preEnv 顺序一致）。
- `_resolve_complex_macro` 新增 `reverse`/`getglobalvar`/`addglobalvar`/`incglobalvar`/`decglobalvar`。
- 重写 `_split_macro_args`：优先按 `::` 切分，无 `::` 回退单个 `:`（兼容 `{{roll:6}}`），修复 `::` 形式变量宏静默失效。

**修复前后对拍**（`st_macro_coverage_check.py`）：修前 11 项 FAIL → 修后 **FINDINGS: none / RESULT: PASS**。
**回归 smoke**：`{{user}}/{{char}}`、`{{roll:6}}`、`{{pick::a::b}}`、`{{random::a::b}}`、`{{outlet::village}}`、`{{upper}}/{{lower}}/{{reverse}}`、注释+尖括号混合均正确。

---

## 4. 附带修复：迁移 0051（PostgreSQL DatatypeMismatch）

- **偏差**：`0051_add_instruct_template_st1180_fields.py` 中 Boolean 列用 `sa.text("0")`/`sa.text("1")` 整型字面量，PG 严格类型报 `column ... is of type boolean but default expression is of type integer`，阻断 0050→0053 整个迁移事务（该迁移在任何 PG 环境从未成功执行过）。
- **修复**：`skip_examples`/`macro`/`system_same_as_user` → `sa.text("false")`；`sequences_as_stop_strings` → `sa.text("true")`（参照同类 0052）。
- **验证**：`alembic upgrade head` 一次性成功至 0053；`alembic current` = `0053 (head)`。
- **意义**：使 PG 下 `instruct_templates` 获得 ST 1.18.0 字段，直接服务兼容目标。

---

## 5. 残留「已知超集 / 无害差异」清单

| 项 | 说明 | 处置 |
|---|---|---|
| 角色卡 read 接受 zTXt/iTXt | ST read 仅读 tEXt；Palink 更宽松 | 无害超集，保留 |
| `/api/chats/get` 无会话返回 `[header]` | ST 返回 `{}`；客户端均按空聊天处理 | 无害超集，保留 |
| `send_date` 微秒→毫秒归一化 | 采用 ST 规范毫秒+`Z`，精度归一 | 解决 UTC 正确性，无害 |
| `palink_*` 附加字段（chat_metadata/extra） | ST 忽略未知字段 | 向后兼容，保留 |
| 日期/时间宏格式（`{{time}}/{{date}}`） | ST=locale（`3:04 PM`/`March 14, 2024`），Palink=ISO（`%H:%M`/`%Y-%m-%d`） | 真实差异但改动影响现有行为与既有测试，对 LLM 语义影响轻微，**列为已知差异** |
| 聊天上下文宏（`{{lastMessage}}/{{maxContext}}/{{idle_duration}}` 等） | 需 MacroEnv 扩展 chat/token 上下文；ST 中仅特定插件/模板使用 | 频率低，**列为后续项** |
| instruct 模板宏（`{{instructInput}}` 等，`instruct-mode.js:673`） | 属 instruct-mode 子系统；Palink 以 Context/Instruct 模板字段另行处理 | **列为后续项** |

---

## 6. 最终回归验证

backend 镜像重建（持久化阶段 2/3/5 全部改动）+ 容器重建（healthy）后全量回归：

| 测试 | 结果 |
|---|---|
| `st_macro_coverage_check.py`（阶段 5） | FINDINGS: none / **RESULT: PASS** |
| `st_worldinfo_roundtrip_check.py`（阶段 3） | RESULT / CHARBOOK / DB **三项 PASS** |
| `st_chat_jsonl_roundtrip_check.py`（阶段 2） | FINDINGS: none / **RESULT: PASS** |
| `test_regex_substitute_macros.py`（既有单测） | **11 passed** |
| `alembic current` | **0053 (head)** |

**结论**：5 个兼容维度审计完成，3 个维度发现并修复真实偏差（聊天 JSONL / 世界书 / 提示词宏），2 个维度确认兼容（角色卡 PNG / HTTP API），附带修复迁移 0051。所有修复经 docker 原版 ST 对拍验证，无回归。
