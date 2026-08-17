# SillyTavern 1.18.0 兼容性修复变更日志

本文件按计划纪律记录每一处兼容性修复：文件、行号、ST 真值出处、修改前后、对拍/验证结果。
真值来源：`SillyTavern-1.18.0/SillyTavern-1.18.0` 内源码。备份目录：`.backups/st-compat-2026-07-20/`。

---

## 阶段 0：对拍基础设施

- 使用 `docker-compose.yml` 拉起原版 ST（源码构建）+ Palink backend + db，全部 healthy。
- 新增对拍 harness 目录 `scripts/st-compat/`。
- 环境事实：backend 源码 BAKED 进镜像（仅 `data/models/tests` 挂载）→ 改业务代码需 `docker compose build backend`；DB 迁移手动执行（`RUN_MIGRATIONS_ON_STARTUP=false`）。

---

## 阶段 1：角色卡 PNG 解析/导出 —— 无需修复（对拍 PASS）

- 真值：`public/scripts/character-card-parser.js`（read 仅读 tEXt，优先 ccv3；write 写 chara+ccv3 两个 tEXt，base64/utf8）。
- 对拍工具：`scripts/st-compat/st_card_roundtrip.mjs`（ST 容器内 write/read）+ `scripts/st-compat/card_compat.py`（编排 Palink↔ST 交叉解析）。
- 结果：V1/V2/V3（含 Unicode + 嵌套 character_book）**ALL PASS**。ST↔Palink PNG 互读完全兼容，`chara`+`ccv3` tEXt 均位于 IEND 前。
- 结论：Palink `backend/app/character_card.py` 与 ST 字节级/字段级一致，**不改**。
- 已核实的先前误报：正则 placement 缺 7/8/9 —— 经核对 `extensions/regex/engine.js:281-292`，ST 仅 6 个值（0/1/2/3/5/6），与 `character_ext.py:802-807` 完全一致，**非 bug**。

---

## 阶段 2：聊天历史 JSONL 导入/导出 —— 已修复（对拍 PASS）

### 真实偏差（docker 对拍确认，`backend/tests/st_chat_jsonl_roundtrip_check.py`）
对一条真实 ST 1.18.0 AI 消息做 import→export 对拍，确认丢失/篡改 3 处：
1. **`gen_started` / `gen_finished`（顶层字段）彻底丢失**。ST 在消息顶层持久化生成起止时间（`script.js:6736-6737`），Palink 导入未捕获、导出未回写 → round-trip 后为 None。
2. **`force_avatar`（及 `original_avatar`）功能性丢失**。导入时被收进 `extra.force_avatar`，但导出端未回写到 ST 期望的**顶层**位置（ST 读 `message.force_avatar`，`script.js:5835`）→ ST 侧读不到。
3. **`send_date` 格式丢失 UTC 标记**。ST 用 `getMessageTimeStamp()`=`Date.toISOString()`（`RossAscends-mods.js:192`）→ 毫秒 + 尾随 `Z`（UTC）。Palink 用 `datetime.isoformat()` 产出 `...456000`（微秒、无 `Z`），ST 的 moment 会按浏览器本地时区解读 → 显示时间偏移。

（注：`swipe_info` 内部的 `gen_started/gen_finished`、以及 `extra` 内所有键均已正确保真，非缺口。`reasoning`/`tool_invocations`/`token_count`/`model` 等 extra 字段透传正常。）

### ST 真值
- `public/scripts/RossAscends-mods.js:192` `getMessageTimeStamp` = `date.toISOString()`（消息 send_date）；`:169` `humanizedDateTime` 仅用于文件名/create_date。
- `public/script.js:5818-5835`（用户消息含 force_avatar 顶层）、`:6720-6767`（AI 消息 gen_started/gen_finished 顶层 + swipe_info 结构）。

### 修改点
1. **`backend/app/services/st_sync_service.py`**（JSONL 同步路径）：
   - 新增 `_st_iso_utc(dt)` 助手：按 ST `toISOString` 风格输出毫秒 + `Z`（naive 视为 UTC）。
   - `_message_to_st_jsonl`（导出）：`send_date` 改用 `_st_iso_utc`；导出末尾将 `gen_started/gen_finished/force_avatar/original_avatar` 从 extra 提升回顶层（ST 结构对齐）。
   - `_st_msg_extra`（导入捕获）：新增 `gen_started`/`gen_finished` 到顶层→extra 暂存列表。
2. **`backend/app/api/silly_tavern.py`**（HTTP `/api/chats` 路径，同构修复）：
   - 新增 `_st_iso_utc` 助手（`_iso` 之后）。
   - `_message_to_st`（导出）：`send_date` 改用 `_st_iso_utc`；以 `**{...}` 将同 4 个字段从 extra 提升回顶层。
   - `_st_message_extra`（导入捕获）：新增 `gen_started`/`gen_finished`。

### 设计说明
- Palink 无 gen_started/gen_finished/force_avatar 专用列，采用「导入暂存 extra → 导出提升回顶层」的透传模式，无需 DB schema 变更即实现完整 round-trip（与 is_name 已有做法一致）。
- send_date 采用 ST 规范格式（毫秒 + Z）而非逐字节保留原字符串：解决实际功能问题（UTC 时区正确性），微秒→毫秒的精度归一化列为「已知无害差异」。

### 验证
- import→export round-trip：`gen_started`/`gen_finished`/`force_avatar` 均在顶层保真，`send_date`=`...456Z`，其余字段无 MISSING/WRONG → **RESULT: PASS**（`FINDINGS: none`）。
- 回归：Phase 3 世界书三项测试（silly_tavern.py 同文件改动）仍 **PASS / CHARBOOK PASS / DB PASS**，无回退。

---

## 阶段 3：世界书 role/useGroupScoring/automationId 缺口 —— 已修复（对拍 PASS）

### 真实偏差（docker 对拍确认）
ST worldinfo 条目导出后再解析，Palink 丢失 14 个字段（其中 3 个无 DB 列）：
`role` / `useGroupScoring` / `automationId`（无列，彻底丢失）+ `ignoreBudget` / `match*` / `delayUntilRecursion` / `useProbability` / `outletName` / `triggers`（有列但导出端未回写）。

- ST 真值：`public/scripts/world-info.js`
  - `newWorldInfoEntryDefinition:4002-4045`：`role`(默认0=system) / `useGroupScoring`(默认null) / `automationId`(默认'') 为**顶层**条目字段。
  - `convertCharacterBook:5498-5540`：V3 char_book 中映射到 `extensions.role/use_group_scoring/automation_id`。
  - ST 读取 worldinfo 时用模板补全缺失字段 → 导出丢字段会被静默还原为默认，掩盖数据丢失。

### 修改点
1. **`backend/app/models/worldbook.py`** WorldBookStage（~L98-102）：新增列
   `role`(Integer,default 0) / `use_group_scoring`(Boolean,nullable) / `automation_id`(String,nullable)。
2. **`backend/alembic/versions/0053_add_worldbook_role_scoring_automation.py`**（新建）：
   `down_revision=0052`，`_column_exists` 守卫下 add_column 三列；提供 downgrade。
3. **`backend/app/api/silly_tavern.py`**：
   - 新增 `_nullable_bool` 助手（~L3804）：None 保持 None（继承全局），否则 bool()。
   - `_create_stage_from_st_entry`（~L3886-3907）：顶层优先、回退 `extensions.*` 提取 role/use_group_scoring/automation_id。
   - `_worldbook_to_st_world_info`（导出到 flat worldinfo，主 round-trip 路径，~L5258-5275）：补齐 14 字段（useProbability 派生自 probability<100、ignoreBudget、match*、delayUntilRecursion、outletName、triggers、role、useGroupScoring、automationId）。
   - `_worldbook_to_charbook`（V3 char_book 导出，~L1442-1445）：extensions 回写 role/use_group_scoring/automation_id。
   - `_persist_worldbook_from_data`、`_sync_character_book_to_palink`（另两条导入路径，~L1585 起）：补齐相同富字段。

### 验证（`backend/tests/st_worldinfo_roundtrip_check.py`）
- 序列化 round-trip：41 字段无 MISSING/WRONG → **RESULT: PASS**
- V3 character_book 导出 role/use_group_scoring/automation_id → **CHARBOOK RESULT: PASS**
- 真实 PostgreSQL persist→re-read（migration 0053 已应用）→ **DB RESULT: PASS**
- 迁移链：`alembic upgrade head` 成功，`alembic current` = `0053`（head）；`world_book_stages` 三列类型正确（role int default 0 / use_group_scoring boolean / automation_id varchar）。

---

## 附带修复：迁移 0051 布尔默认值（PostgreSQL DatatypeMismatch，阻断迁移链）

- 偏差：`0051_add_instruct_template_st1180_fields.py` 中 Boolean 列用 `sa.text("0")` / `sa.text("1")` 整型字面量，PostgreSQL 严格类型报 `column ... is of type boolean but default expression is of type integer`，导致 0050→0053 整个迁移事务回滚（该迁移在任何 PG 环境从未成功执行过）。
- 参照：同类的 0052 迁移正确使用 `sa.text("false")`。
- 修改：`skip_examples`/`macro`/`system_same_as_user` → `sa.text("false")`；`sequences_as_stop_strings` → `sa.text("true")`。
- 验证：修复后 `alembic upgrade head` 一次性成功至 0053。
- 说明：这是 ST 1.18.0 instruct 模板字段迁移，修复直接服务于兼容目标（PG 下 instruct_templates 得以获得 ST 1.18.0 字段）。

---

## 阶段 4：HTTP API 接口契约核对与回归 —— 无需修复（回归 PASS）

对 `silly_tavern.py`（`/api/characters/*`、`/api/chats/*`、`/api/worldinfo/*`）与 `st_groups.py`（`/api/groups/*`、`/api/chats/group/*`）逐一核对请求体/响应体/状态码，重点回归验证既有 P0/P1 修复未回退。

### P0/P1 修复点回归验证（对照 ST 源码）
1. **`/api/chats/save` 返回 `{ok: true}`**（`silly_tavern.py:3151`）—— 与 ST `src/endpoints/chats.js:483` `response.send({ ok: true })` **一致**，未回退。
2. **`/api/chats/recent` 返回扁平 `ChatInfo[]` 数组**（`silly_tavern.py:4998` `return all_chats[:max_count]`）—— ST `chats.js:979` 定义 + `welcome-screen.js:778-786` 客户端 `Array.isArray(data)` 后按 `chat.avatar`（角色）/`chat.group`（群聊）匹配；Palink 角色项含 `avatar`、群聊项含 `group`，字段对齐，**一致**，未回退。
3. **`token_count` / `model` 同步进 `extra`**（`_message_to_st` `silly_tavern.py:1248-1258`）—— ST 前端读 `message.extra.token_count`（`script.js`）/`extra.model`；Palink 从 DB 列回填 extra，**保留**，未回退。

### 其余核对结论
- **`/api/chats/get`**（`silly_tavern.py:3004-3007`）返回 `[header, ...messages]`，与 ST `chats.js:539` `getChatData()` 的 `[chat_metadata_header, ...messages]` 结构一致。无会话时 Palink 返回 `[header]`（ST 返回 `{}`）—— 属**已知无害超集**：ST 客户端对二者均按空/新聊天处理，不影响功能。
- **`/api/groups/*`**（`st_groups.py`）：`get/all/create/edit/delete/member-*`/`chats` 与 `/api/chats/group/*` 端点齐备，响应结构与 ST group-chats 客户端一致。
- 请求体统一接受 ST 的 `avatar_url` / `file_name` / stringified `chat`（`/save` 已处理 `JSON.parse`），与 ST 前端 `getRequestHeaders()` POST 约定对齐。

### 结论
本阶段**未发现 >80% 置信度的新契约偏差**，无代码改动。既有 3 项 P0/P1 修复经 ST 源码对照确认全部在位且未回退。

---

## 阶段 5：提示词装配（宏/instruct/context）—— 已修复（对拍 PASS）

### 审计范围
Palink 提示词装配的宏引擎 `backend/app/services/macro_service.py`（`evaluate_macros` 在 `roleplay_prompt_assembly.py:2527-2528` 对 system_prompt 与 messages 求值，直接影响最终提示词）对照 ST 1.18.0 `public/scripts/macros.js:610-715` `evaluateMacros` + `variables.js:238-261` 变量宏。

### 真实偏差（docker 对拍确认，`backend/tests/st_macro_coverage_check.py`，修前 11 项 FAIL）
1. **注释宏 `{{// ...}}` 未剩除**（ST `macros.js:659`）→ 注释文本以字面形式泄漏进提示词。
2. **反转宏 `{{reverse:...}}` 未实现**（ST `macros.js:658`）→ 字面残留。
3. **遗留尖括号宏 `<USER>/<BOT>/<CHAR>/<GROUP>/<CHARIFNOTGROUP>` 未替换**（ST `macros.js:624-628`）→ 旧式角色卡提示词中字面残留。
4. **全局变量宏 `getglobalvar/addglobalvar/incglobalvar/decglobalvar` 缺失**（ST `variables.js:251-259`）→ 字面残留（`getvar` 虽会回退查全局，但 ST 另有显式只读全局作用域的 `getglobalvar`）。
5. **`_split_macro_args` 按单个 `:` 切分（隐藏 bug）**：ST 宏以 `::` 为参数分隔符，旧实现把 `setvar::name::value` 拆成 `['setvar','','name','','value']` → `args[0]/args[1]` 为空字符串 → **`setvar`/`setglobalvar`/`addvar` 等 ST `::` 形式静默失效**（写入空键）。

### ST 真值
- `macros.js:659` 注释 `/{\{\/\/([\s\S]*?)\}\}/gm`→''；`:658` `{{reverse:(.+?)}}`→反转；`:624-628` 遗留尖括号宏；`:551` `{{roll[ : ]...}}` 单冒号骰子。
- `variables.js:241-259` `setvar/addvar/incvar/decvar/getvar` + `setglobalvar/addglobalvar/incglobalvar/decglobalvar/getglobalvar`（均 `::` 分隔）。

### 修改点（`backend/app/services/macro_service.py`）
1. 新增 `_COMMENT_MACRO_PATTERN` + `_LEGACY_ANGLE_MACROS` + `_apply_pre_macros()`：在 `evaluate_macros` 主循环前剩除 `{{// 注释}}`、替换遗留尖括号宏（与 ST preEnv 顺序一致；`<GROUP>/<CHARIFNOTGROUP>` 无群组上下文时降级为角色名）。
2. `_resolve_complex_macro` 新增：`reverse`、`getglobalvar`、`addglobalvar`、`incglobalvar`、`decglobalvar`。
3. **重写 `_split_macro_args`**：优先按 `::` 切分，无 `::` 时回退按单个 `:`（兼容 `{{roll:6}}`）。修复 ST `::` 形式变量宏静默失效的隐藏 bug；`outlet::name` 现产生 `['outlet','name']`（原依赖 `next(non-empty)` 容错，仍兼容）。

### 验证（`backend/tests/st_macro_coverage_check.py`）
- 修前：11 项 FAIL（comment×2/reverse/legacy×4/globalvar×4）→ 修后：**FINDINGS: none / RESULT: PASS**。
- 回归 smoke：`{{user}}/{{char}}`、`{{roll:6}}`、`{{pick::a::b}}`、`{{random::a::b}}`、`{{outlet::village}}`、`{{upper}}/{{lower}}/{{reverse}}`、`{{// comment}}`+`<USER>` 混合均正确；`getvar`/`setvar` 在无 session_id 环境下返回空为预期（聊天变量需会话上下文），非回退。

### 已知差异（保守起见本次不修改，>80% 置信度才动手原则）
- **日期/时间宏格式**：ST `{{time}}`=locale `LT`（如 `3:04 PM`）、`{{date}}`=locale `LL`（如 `March 14, 2024`）；Palink 用 ISO 风格 `%H:%M`/`%Y-%m-%d`。属真实格式差异，但改动会影响现有 Palink 行为与既有测试（`test_regex_substitute_macros.py` 即断言 ISO 格式），且对 LLM 语义影响轻微，列为已知差异。
- **聊天上下文宏**（`{{lastMessage}}/{{lastUserMessage}}/{{lastCharMessage}}/{{lastMessageId}}/{{maxPrompt}}/{{maxContext}}/{{idle_duration}}` 等）：需 MacroEnv 扩展 chat/token 上下文，ST 中亦仅在特定插件/模板使用，频率低，列为后续项。
- **instruct 模板宏**（`{{instructInput}}/{{instructOutput}}` 等，`instruct-mode.js:673`）：属 instruct-mode 子系统，Palink 以 Context/Instruct 模板字段另行处理，列为后续项。
