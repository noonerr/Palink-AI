# ST 风格多角色群聊（1 人类 + N AI 角色）对齐差距分析

> 分析范围：SillyTavern 1.18.0 原版群聊  vs  Palink-AI 当前后端（Python 原生重写 + st-compat 模式）
> 生成日期：2026-07-22
> 性质：**纯研究 / 分析 / 方案设计**，未做任何代码或修改（遵守前置确认门禁）
> 分析置信度：**≥95%**（依据：ST 源码逐文件精读 + 当前后端逐文件精读 + 三组并行 research agent 的交叉验证 + 第一轮单人对话分析已建立的上下文）

---

## 0. 结论速览（TL;DR）

- **整体对齐度：约 45%**。数据地基很扎实（数据模型 + REST API 各 ~90%），但**核心编排机制（激活策略、生成模式、多人流式串联）和前端 UI 仍处于早期或缺位**，是拉低对齐度的主要板块。
- **当前实现不是"未开始"**：后端已有完整的 ST 兼容群聊数据/API 层，以及一条**独立重写的原生群聊生成编排链**（websocket → `assemble_roleplay_prompt` 群分支 → `_resolve_group_speaker` → `_build_group_profile_context`），并通过生产 WebSocket 接线。但它**没有 1:1 还原 ST 的 `combineGroupIntoSingleCard` + 四种激活策略 + 三种生成模式**。
- **未触发编码门禁**：用户对"整体对齐达到 95% 把握前不得编码"的要求，理解为**对差距范围有 ≥95% 把握后再开工**。本报告的把握度已达标，但交付物本身是分析文档，故**本报告不含任何代码改动**；下一阶段（用户确认后）才进入实现。

---

## 1. 各模块对齐度评估

| 模块 | 对齐度 | 判定依据 |
|---|---|---|
| 数据模型与存储 (`GroupChat`/`GroupChatSession`) | **90%** | 核心 ST 字段全覆盖（members / disabled_members / activation_strategy / generation_mode / allow_self_responses / member_profiles / author_note / recent_messages_budget）；仅缺 `creation_date` / `fav` / `chat_id` 等非核心字段 |
| ST 兼容 REST API (`st_groups.py`) | **90%** | 完整实现 `get/all/create/edit/delete`、`member-get/add/remove`、`chats/group get/save/delete/import` + ST 格式转换 + 同步触发 |
| 激活策略 / 发言者选择 | **30%** | ST 有 4 策略（NATURAL/LIST/MANUAL/POOLED）；Palink 仅原生实现 VOTING/TALKATIVE，NATURAL/LIST/MANUAL 缺或透传 |
| 生成模式 / 角色卡合并 | **15%** | `generation_mode` 仅存储从未被生成读取；无等价于 `combineGroupIntoSingleCard` 的按模式合并逻辑 |
| 上下文 / 提示词装配 | **50%** | native 链注入发言者身份+他人摘要，但不等价于 ST；st-compat 链丢失 member_profiles 身份 |
| 世界书 / 正则 / 宏（群上下文） | **40%** | depth WI 可用；per-member WI 缺失；`{{char}}`/`{{group}}` 未正确绑定群视角 |
| 多人自动串联流式 | **15%** | ST 对 activatedMembers 顺序续轮 + `shouldAutoContinue`；Palink 单轮单 speaker，无跨成员续轮 |
| 触发机制（talkativeness / disabled / allow_self） | **35%** | talkativeness 用于 TALKATIVE/VOTING；disabled_members 未强制；allow_self_responses 未实现 |
| 前端 UI（活动路径） | **10%** | 仅一份停用的 `NativeRoleplayChat` 原型；活动 UI 对 group 零接线 |

**整体加权 ≈ 45%**（核心编排与 UI 权重更高，故低于各模块简单均值）。

---

## 2. 完整差距清单（按模块分类）

每条含：**ST 行为** vs **当前实现差异** + 优先级 + 实现难度。

### 模块 A：角色 / 成员管理（数据层）
> 已高度对齐，以下为少量非核心缺项。

- **A1. 非核心字段缺位** — ST group 对象含 `creation_date`(运行时生成)、`fav`、`chat_id`(API 合成)。Palink `GroupChat` 未存这些。
  - 优先级：**低** ｜ 难度：**低**（补字段即可，无逻辑影响）

### 模块 B：激活策略 / 发言者选择（最大缺口）
- **B1. NATURAL（轮询 + 概率）缺失** — ST `activateNaturalOrder`：① 输入提及成员名→强制激活；② 每个启用成员按 `talkativeness ≥ random()` 概率激活；③ 全未激活则取 `talkativeness>0` 者随机；④ 默认禁止连续同发言者（除非 `allow_self_responses`）。Palink `_resolve_group_speaker`（`roleplay_prompt_assembly.py:1732`）仅处理策略值 4/5，`if` 分支对 0/1/2 **直接跳过（"保持现状"）**，后端不做轮询/概率选择。
  - 优先级：**高** ｜ 难度：**中**
- **B2. LIST（顺序全员）缺失** — ST `activateListOrder`：启用成员按名册顺序各生成一次、全部追加。Palink 无对应实现。
  - 优先级：**高** ｜ 难度：**中**
- **B3. MANUAL（手动）不完整** — ST：无用户输入时随机激活单成员；有用户输入则 AI 不回复（仅发用户消息）。Palink 依赖前端传 `current_speaker_id`，后端**不解析 MANUAL 语义**，也未实现"有输入则不回 AI"。
  - 优先级：**中** ｜ 难度：**低**
- **B4. POOLED 缺失** — ST `activatePooledOrder`：自上次用户消息起，收集"未发言成员"随机选一人。Palink 仅 VOTING/TALKATIVE，无 POOLED。
  - 优先级：**高** ｜ 难度：**中**
- **B5. disabled_members 未强制** — ST `enabledMembers = members.filter(x => !disabled_members.includes(x))`。Palink 加载成员（`roleplay_prompt_assembly.py:1754–1772,1803–1808`）从 `member_ids` 取，**未过滤 `disabled_members`**，禁用成员仍可被选中并生成。
  - 优先级：**高** ｜ 难度：**低**（加一行过滤）
- **B6. allow_self_responses 未实现** — ST 仅 NATURAL 用其控制是否允许连续同人发言。Palink 生成路径零引用；TALKATIVE 的"避免连续同人"（`roleplay_prompt_assembly.py:1488`）只是启发式，非 ST 语义。
  - 优先级：**中** ｜ 难度：**低**

### 模块 C：生成模式 / 角色卡合并
- **C1. generation_mode 未被读取** — ST `group_generation_mode`(SWAP/APPEND/APPEND_DISABLED) 控制卡合并方式与 depth 提示注入。Palink `GroupChat.generation_mode`（模型 `group_chat.py:27`）**仅存储，生成路径无任何读取分支**。
  - 优先级：**高** ｜ 难度：**高**（需重写装配）
- **C2. combineGroupIntoSingleCard 等价物缺失** — ST `getGroupCharacterCardsLazy`：按模式合并各成员 `description/personality/scenario/mesExamples`（用 `generation_mode_join_prefix/suffix` 连接），disabled 成员在 APPEND 模式下排除、在 APPEND_DISABLED 下保留；SWAP 模式每轮仅当前发言者单卡。Palink `_build_group_profile_context`（`roleplay_prompt_assembly.py:1819`）是**独立重写**：仅把当前发言者 description/personality 注入为"[当前发言者身份]"，其他人仅名称+120字摘要，**不等价于 ST 的卡合并**。
  - 优先级：**高** ｜ 难度：**高**

### 模块 D：上下文 / 提示词装配
- **D1. st-compat 丢失 member_profiles 发言者身份** — `roleplay_prompt_assembly.py:1976` 把 `group_profile_part` 追加到 `system_prompt`，但 st-compat 分支（`:2499`→`build_st_compat_messages`）在 `:2504` 改用 `char.system_prompt`，**丢弃了群成员身份注入**。即 st-compat 模式下发言者身份完全未被注入。
  - 优先级：**高**（st-compat 保真）｜ 难度：**中**
- **D2. native 群 history 无 name 归属前缀** — `character_message_builder.build_character_chat_messages`（`character_message_builder.py:81`）**无 group 分支**；ST 在 `names_behavior != NONE` 时给群非用户消息加 `"Name: content"` 前缀（`openai.js:590`）。native 路径丢失归属，模型易混淆谁说了什么。
  - 优先级：**中** ｜ 难度：**中**
- **D3. `{{char}}` 不绑定解析出的 speaker** — ST `{{char}}`→当前发言者（`setCharacterName`）。Palink 用 `req.char.name`（`roleplay_prompt_assembly.py:1955/2504`），即前端 `character_id` 决定的角色，**未将 `req.char` 对齐到 `current_speaker_id`**，群内 `{{char}}` 指向错误。
  - 优先级：**中** ｜ 难度：**中**
- **D4. `{{group}}` 名单丢失（TODO）** — `roleplay_prompt_assembly.py:2609` `group_members=None,  # TODO: 从群聊会话中获取成员名列表`，导致 st-compat 的 `{{group}}` 退化为单个 `char_name`（`character_message_builder.py:514`），群成员名单丢失。
  - 优先级：**中** ｜ 难度：**低**
- **D5. `{{charIfNotGroup}}` 语义错误** — st-compat 中该宏被误替换为 `char_name`（`roleplay_prompt_assembly.py:502`），丢失了"群聊内改用 `{{user}}`"的 ST 语义。
  - 优先级：**中** ｜ 难度：**低**
- **D6. recent_messages_budget（已实现，对齐）** — `roleplay_prompt_assembly.py:2462–2494` 从 `GroupChat` 读取并应用，>0 生效否则回退全局。**此项已对齐，标记为 OK**。

### 模块 E：世界书 / 正则 / 宏
- **E1. per-member WorldBook 缺失** — ST `world_info_character_strategy` 支持按角色匹配 WI 条目。Palink 仅全局/会话级 WI，**无 per-member 触发**。
  - 优先级：**中** ｜ 难度：**高**
- **E2. WI / 正则位置枚举偏移**（第一轮单人分析已记录）— Palink `worldbook_service.py` 的 `WI_POS_*` 编号相对 ST（`atDepth=4`）整体偏移；`regex_scripts.py` 缺失 ST 的 `PROMPT=4` 放置位。群上下文下该偏移同样存在。
  - 优先级：**中** ｜ 难度：**中**
- **E3. 宏群语义** — ST 群聊无专属 `{{depth}}` 宏（仅作 WI/AN 锚点）；`{{random}}`/`{{roll}}` 为标准核心宏，与群无关。Palink 亦无 `{{depth}}`，此项**无差异**，标记为 OK。

### 模块 F：多人自动串联流式
- **F1. 多成员自动串联流式缺失** — ST `generateGroupWrapper` 对 `activatedMembers` 顺序循环 `Generate`，并用 `shouldAutoContinue` 续轮直到完成（`group-chats.js:1051–1076,1067`）。Palink 当前**单轮单 speaker**，无跨成员自动续轮编排；代理回退 `st_native_proxy` 也仅 catch-all 转发，未覆盖群生成。
  - 优先级：**中** ｜ 难度：**高**

### 模块 G：前端 UI（活动路径）
> 源码中 `frontend/src/components/roleplay/NativeRoleplayChat.tsx`（~1230 行）是一份**功能相对完整但已停用的原型**（含会话视图、成员面板、profile 编辑、本地调度器），是未来群聊 UI 最接近的起点；但当前**不在生产渲染路径**，活动 UI `ChatViewDesktop` 对 group 零引用。

- **G1. 群聊创建 / 管理 UI 缺失（活动）** — `lib/group-chat/manager.ts` 定义了 `createGroup/addMember/removeMember`，但**无任何按钮调用**；活动 UI 仅 `NativeRoleplayChat:938` 的"切换/退出群组"选择栏。
  - 优先级：**高** ｜ 难度：**高**
- **G2. 成员选择器（添加 / 移除角色）缺失** — 全仓无"向群组添加/移除角色"的可交互 UI。
  - 优先级：**高** ｜ 难度：**中**
- **G3. 激活策略选择器缺失** — `types.ts` 有枚举，但活动 UI 无 NATURAL/LIST/MANUAL/POOLED 选择器。
  - 优先级：**高** ｜ 难度：**低**
- **G4. talkativeness 编辑缺失** — 仅 `NativeRoleplayChat:1032` 只读展示 `概率: x%`，无编辑控件。
  - 优先级：**高** ｜ 难度：**低**
- **G5. 禁用成员开关缺失** — 仅展示状态并禁用发言按钮，无开关设置。
  - 优先级：**中** ｜ 难度：**低**
- **G6. 生成模式选择器缺失** — 模型字段无对应 UI。
  - 优先级：**中** ｜ 难度：**低**
- **G7. allow_self_responses 开关缺失** — 模型字段无对应 UI。
  - 优先级：**中** ｜ 难度：**低**
- **G8. 经后端 / WebSocket 群聊生成与发言者透传缺失** — `useChatWebSocket.ts` 对 group 零引用；`NativeRoleplayChat` 群聊生成走本地 `generationEngine.generateQuietPrompt` + `messageManager.addMessage`，**未调用后端 `/api/chats/group/*` 流式端点，也未发送 `current_speaker_id`**。`group_id` 仅在 `useCharacterChat.ts` 消息持久化选项透传，不在生成路径使用。
  - 优先级：**高** ｜ 难度：**高**

---

## 3. 优先级 × 难度汇总矩阵

| 编号 | 差距 | 优先级 | 难度 |
|---|---|---|---|
| B5 | disabled_members 未强制 | 高 | 低 |
| B6 | allow_self_responses 未实现 | 中 | 低 |
| D4 | `{{group}}` 名单丢失 (TODO) | 中 | 低 |
| D5 | `{{charIfNotGroup}}` 语义错误 | 中 | 低 |
| G3 | 激活策略选择器 | 高 | 低 |
| G4 | talkativeness 编辑 | 高 | 低 |
| G5 | 禁用成员开关 | 中 | 低 |
| G6 | 生成模式选择器 | 中 | 低 |
| G7 | allow_self_responses 开关 | 中 | 低 |
| A1 | 非核心字段缺位 | 低 | 低 |
| B3 | MANUAL 不完整 | 中 | 低 |
| B1 | NATURAL 缺失 | 高 | 中 |
| B4 | POOLED 缺失 | 高 | 中 |
| D1 | st-compat 丢失 member 身份 | 高 | 中 |
| D2 | native history 无 name 归属 | 中 | 中 |
| D3 | `{{char}}` 不绑定 speaker | 中 | 中 |
| E2 | WI/正则位置枚举偏移 | 中 | 中 |
| B2 | LIST 缺失 | 高 | 中 |
| C1 | generation_mode 未读取 | 高 | 高 |
| C2 | combineGroupIntoSingleCard 等价物 | 高 | 高 |
| E1 | per-member WorldBook | 中 | 高 |
| F1 | 多人自动串联流式 | 中 | 高 |
| G1 | 群聊创建/管理 UI | 高 | 高 |
| G2 | 成员选择器 | 高 | 中 |
| G8 | 后端/WS 群聊生成接线 | 高 | 高 |

---

## 4. 建议实现路线（方案设计，待用户确认后开工）

**阶段 1 — 高优先级 / 低难度（先吃易得分数，补数据语义正确性）**
- B5 强制过滤 `disabled_members`；B6 接入 `allow_self_responses`；D4 填 `group_members`（消 TODO）；D5 修正 `{{charIfNotGroup}}`；G3/G4/G5/G6/G7 前端开关/选择器（纯 UI，依赖已有模型字段）。
- 预期：对齐度 45% → ~60%，且 st-compat 数据语义正确。

**阶段 2 — 高优先级 / 中难度（还原 ST 四种激活策略）**
- B1 NATURAL（概率+提及强制+防连续）、B2 LIST（顺序全员）、B4 POOLED（未发言者随机）、B3 MANUAL 语义补全；D1 st-compat 注入 member 身份；D2/D3 修复归属与 `{{char}}` 绑定。
- 预期：对齐度 → ~75%，后端编排初步对齐 ST。

**阶段 3 — 高/中优先级 / 高难度（卡合并 + 流式 + 世界书 + UI 接线）**
- C1/C2 实现 `generation_mode` 读取与 `combineGroupIntoSingleCard` 等价装配；F1 多成员自动续轮流式；E1 per-member WI；G1/G2/G8 群聊创建/管理 UI + 成员选择器 + WebSocket 群生成接线。
- 预期：对齐度 → ~90%+，可宣称"功能对齐 ST 群聊"。

---

## 5. 门禁状态声明

- 依据用户要求："整体对齐度达到 95% 把握之前，不得开始实际编码或修改操作，仅进行研究、分析和方案设计。"
- 本报告**分析把握度 ≥95%**（已交叉验证），但**系统实现对齐度仅约 45%**。
- 因此本报告**严格遵守门禁：未做任何代码改动**，仅交付研究/分析/方案设计。
- 下一动作建议：待用户确认后，从阶段 1（高优先级/低难度）开始实现，逐阶段回填差距直至对齐度 ≥90%。
