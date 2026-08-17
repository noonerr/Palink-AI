# 后端群聊对齐 Spec（SillyTavern 1.18.0）

> 性质：**设计文档，不含实现代码**。用户在确认前要求"完全读懂代码、写出详尽 spec 放独立文件夹"。前端按用户要求暂不处理。
> 代码基线：已通过三组并行 agent 精读后端真实代码验证（行号见各模块 spec）。
> 配套差距报告：`docs/st_group_chat_gap_analysis.md`（整体对齐度 ~45%）。

## 1. 目的与范围
- **目标**：将 Palink-AI 后端群聊（1 人类 + N AI 角色）的语义对齐 ST 1.18.0 群聊。
- **范围**：**仅后端**（模型 / 编排 / 消息构建器 / 宏 / 世界书 / WebSocket 接线）。
- **排除**：前端 UI（创建/成员选择器/策略·概率·模式选择器/WebSocket 群生成接线），见 gap 报告 G1–G8。

## 2. 当前后端现状（已精读，结论）
- **数据模型** `backend/app/models/group_chat.py`：ST 核心字段齐备
  - `GroupChat`：`member_ids`(13–45)、`disabled_members`、`activation_strategy`、`generation_mode`、`allow_self_responses`、`member_profiles`、`author_note`、`recent_messages_budget`、`active_members`、`follower_members` 全部存在。
  - `GroupChatSession`：`group_id`/`user_id`/`title`/`messages`/`avatars` 存在。
- **请求模型** `PromptAssemblyRequest`（`roleplay_prompt_assembly.py:347`）：含 `group_id`(376)、`current_speaker_id`(377)；其余群配置在 `assemble_roleplay_prompt` 内通过 `req.group_id` 重新查 `GroupChat` 行获取。
- **接线** `websocket.py`：`ws_group_id = raw.get("group_id")`(1186)、`ws_current_speaker_id = raw.get("current_speaker_id")`(1187) → `PromptAssemblyRequest`(1424–1425)。**客户端按消息发送**，非 query 参数。
- **编排** `assemble_roleplay_prompt:1943` → `:1966` 调 `_resolve_group_speaker:1732` → `:1819` `_build_group_profile_context` → `:2561` `build_st_compat_messages` / `:2621` `build_character_chat_messages`。
- **已实现策略**：VOTING(5)/TALKATIVE(4) 原生（见 `:1732`–`1816`）；值 0/1/2/3 透传（不实现 ST 语义）。
- **单次生成**：一个 `chat_request` → 一次 `assemble_roleplay_prompt` → 一次 `run_character_chat_generation`（`websocket.py:1540`），**无多成员自动串联**。
- **`st_groups.py`**：纯 CRUD + 导入 + `trigger_async_sync`（导入列表无 `assemble_roleplay_prompt`），已正确序列化 `activation_strategy`/`generation_mode`/`disabled_members`/`allow_self_responses` 等。
- **`talkativeness`**：`Character.talkativeness` 为 `String default="0.5"`（`character.py:49`），**无对应迁移脚本**（grep 零匹配）——实现时注意该列可能尚未在所有环境落库。

## 3. 关键枚举映射约定（设计决策）
ST `group_activation_strategy`：`0=NATURAL` `1=LIST` `2=MANUAL` `3=POOLED`
Palink 原生扩展（保留，palink-native 模式专用）：`4=TALKATIVE` `5=VOTING`（`roleplay_prompt_assembly.py:1392-1393`）
> **规范**：`st-compat` 模式只接受 `0–3`（缺省回退 `NATURAL=0`）；`palink-native` 模式允许 `0–5`。`st-compat` 收到 `4/5` 时回退 `NATURAL` 并记 warning，避免歧义。

ST `group_generation_mode`：`0=SWAP` `1=APPEND` `2=APPEND_DISABLED`

## 4. 阶段计划（建议实现顺序）
- **阶段 1（低难度/高收益，纯正确性修复）**：B5 强制 `disabled_members`；B6 接入 `allow_self_responses`（NATURAL）；D4 填 `{{group}}` 成员名单；D5 修正 `{{charIfNotGroup}}`；B3 MANUAL 语义；D3 `{{char}}` 绑定发言者；消费 `follower_members`。
- **阶段 2（中难度，行为对齐）**：B1 NATURAL（概率+提及强制+防连续）；B4 POOLED；B2 LIST；D1 st-compat 注入 member 身份；D2 native 群历史 `name` 归属。
- **阶段 3（高难度，高保真）**：C1 读取 `generation_mode`；C2 `combineGroupIntoSingleCard` 等价装配；E1 per-member 世界书；E2 WI/regex 位置枚举对齐；F1 多人自动串联流式。

## 5. 模块 Spec 索引
- `01_activation_strategies.md` — B1 NATURAL / B2 LIST / B3 MANUAL / B4 POOLED / B5 disabled_members / B6 allow_self_responses / talkativeness 语义 / follower_members
- `02_generation_mode_and_combine.md` — C1 generation_mode 读取 / C2 combineGroupIntoSingleCard 等价
- `03_context_macros_worldbook.md` — D1 st-compat member 身份 / D2 native name 归属 / D3 `{{char}}` / D4 `{{group}}` / D5 `{{charIfNotGroup}}` / E1 per-member WI / E2 WI·regex 枚举
- `04_streaming.md` — F1 多人自动串联流式

## 6. 验收总原则
- 每个模块改动须保持向后兼容（`palink-native` 现有行为不回归；`st-compat` 逐步逼近 ST）。
- WI/regex 位置枚举改动需提供 `normalize_worldbook_position` 映射，避免破坏单人对话既有行为。
- 改动点集中、可单测：编排层（`roleplay_prompt_assembly.py`）+ 构建器（`character_message_builder.py`）+ 宏（`macro_service.py`/`character_message_builder._sub`）+ 世界书（`worldbook_service.py`）。
