# 群聊后端对齐 ST 1.18.0 精修 — 完成概览

## 目标
用户要求：仔细核查群聊后端对 ST 1.18.0 群聊的高保真适配，且不得影响修改前的单对话（1:1）后端；写出完善方案后认真修复。取向：严格对齐 ST 1.18.0。

## 做了什么

### 1. 方案（Stage 1–3）
- 逐字提取 ST 1.18.0 群聊算法（`group-chats.js` 激活策略 + `collectField`/`customTransform` 合并卡、`openai.js` 历史 Name 前缀）。
- 建立差异矩阵：吻合 / 偏离 / 扩展，定位 6 处需修复的"偏离"项。
- 输出 `goal-design.md`（基线 + 矩阵 + S3/S4 修复设计）。

### 2. 修复（Stage 4，仅 `roleplay_prompt_assembly.py`）
- **S3 合并卡保真** `_build_group_combined_card`：
  - 移除自动 `Name: ` 前缀（ST 不前缀成员名）；
  - mes_example 未以 `<START>` 开头补 `<START>\n`；
  - `chat_metadata.scenario/mes_example` 覆盖优先；
  - `<FIELDNAME>`→字段名、`{{char}}`→成员名 token 替换。
- **S4 NATURAL/follower 保真** `_select_natural_speaker`：
  - `st-compat` 模式忽略 `follower_members`（ST 无此概念）；
  - 提及命中过滤最后发言者（bannedUser 回避）。

### 3. 测试与验证（Stage 5–7）
- 新建 `test_single_chat_no_group_leakage.py`（6 项）：1:1 路径零群聊泄漏。
- 新建 `test_group_chat_combined_card.py`（7 项）：合并卡逐条保真。
- 加固 `test_group_speaker_selection.py`（+2 项）：st-compat 忽略 follower、提及排除 last。
- **全量 `pytest tests/`：403 passed / 36 skipped / 0 failed**（基线 388 → 无回归）。

## 关键文件
- `backend/app/services/roleplay_prompt_assembly.py`（S3/S4 修复）
- `backend/tests/test_single_chat_no_group_leakage.py`（新建，1:1 非回归）
- `backend/tests/test_group_chat_combined_card.py`（新建，合并卡保真）
- `backend/tests/test_group_speaker_selection.py`（+2 加固）
- `docs/goal-groupchat/goal-design.md`、`goal-verification-report.md`

## 已知限制（保留 palink-native 扩展，st-compat 严格对齐）
- `TALKATIVE(4)/VOTING(5)` 为 ST 后续版本扩展 → st-compat 回退 NATURAL(0)。
- `follower_members` 衰减仅 palink-native 生效。
