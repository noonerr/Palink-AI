# 群聊后端对齐 ST 1.18.0 精修 — 完成概览

> ## ⚠️ 2026-10-03 订正：本件部分内容已随 ST 双轨删除失效，勿按现状依据
>
> 本任务完成于 2026-07-23，其前提是 **`st-compat` 装配轨存在**。
> 该轨已于 **2026-09-03 代码删除**（commit `091023e`，见 `AGENTS.md`）。
> 独立复核（2026-10-03）结论：**部分失效**，逐条如下。
>
> | 本件声称的修复 | 2026-10-03 实际状态 | 物证 |
> |---|---|---|
> | **S3 合并卡保真**（去 `Name:` 前缀、`mes_example` 补 `<START>`、`chat_metadata` 覆盖优先、token 替换） | **代码全在，但已成死代码** —— 零生产调用方 | `roleplay_prompt_assembly.py:2336` 定义；全仓仅 `models/group_chat.py:45` 一句注释引用；装配主流程 `:3179-3216` 只传 `generation_mode` 给 `_build_group_profile_context`，从不构建合并卡。下游消费者 `build_st_compat_messages` 已删（`character_message_builder.py:5`） |
> | **S4.2 提及回避最后发言者**（bannedUser） | **仍有效，是活代码** | `_members_mentioned_in_text:2486`；唯一调用点 `_select_natural_speaker` 的 `:3000` |
> | **S4.1 st-compat 忽略 follower_members** | **已删** | `_select_natural_speaker:2516` 签名已无 `st_mode`；`follower_ids` 无条件生效。全仓 `st_mode` 在 `backend/app` 零命中 |
> | 「TALKATIVE(4)/VOTING(5) st-compat 回退 NATURAL(0)」 | **已作废** | 4/5 现为原生分支（`:2872` VOTING、`:2900` TALKATIVE） |
> | 「follower_members 衰减仅 palink-native 生效」 | **已作废** | 同上，随该轨删除而失去区分 |
>
> **测试现状**
> - `test_group_chat_combined_card.py`（7 例）：**断言死代码，回归保护力为零**
> - `test_group_speaker_selection.py`：22 例中关于 st-compat 的 2 例**已不存在**；`:10` docstring 仍写「st-compat 对 4/5 回退 NATURAL(0)」，与 `:348` 实际断言 4 号走 `_select_talkative_speaker` **自相矛盾**
> - `test_single_chat_no_group_leakage.py`：本件称 6 项，**实际 4 项**；这 4 项仍测真实装配行为，**有效**
> - 三个文件当前仍全过（`33 passed`），但**通过 ≠ 有约束力**
>
> **门禁**：原文「403 passed / 36 skipped，基线 388」→ 2026-10-03 为 `1744 passed / 51 skipped`。增长真实（`backend/tests/` 有 97 个后加文件）。
>
> **唯一实际风险**：本件以「6 Stage 全绿」呈现，会让后续 agent 误以为**合并卡保真是活的保障**；该标签还经 `docs/group_chat_full_audit.md:62` 传播。处置：**引用本件必须连同本订正一起**。`_build_group_combined_card` 与其测试属**待决策的孤儿** —— `generation_mode` 1/2 前端仍可发、后端已无消费分支，**是有意废弃还是漏删的半成品，需用户裁定**。

---

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
