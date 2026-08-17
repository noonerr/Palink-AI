# ST-Compat Prompt 装配最终对齐 Spec

> **change-id**: `align-st-compat-prompt-final-parity`
> **范围**: 仅影响 Palink 角色扮演后端「服务端自建 st-compat prompt 装配」（清单第 0 节定义的「面 A」）。
> **基准**: SillyTavern 1.18.0 官方源码 `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\openai.js` / `world-info.js` / `personas.js` / `authors-note.js` / `PromptManager.js`。
> **依据清单**: `docs/st-compat-gap.md`。

---

## 一、95%+ 把握的依据

本 spec 基于 **三路并行深度研究** 得出，每条差距都已对照 Palink 现有代码与 ST 1.18.0 源码确认：

### 1.1 已核对确认存在的差距（7 项 P1/P2，100% 把握）

| 编号 | 清单项 | Palink 现状代码位置 | ST 1.18.0 基准代码位置 | 把握度 |
|------|--------|---------------------|----------------------|--------|
| D1 | P1 G14 jailbreak 索引 11 丢失 | `roleplay_prompt_assembly.py:2402` `jailbreak=""` 硬编码 | `openai.js:1495-1506` `jailbreakPromptOverride` + `script.js:3361` PHI 来源 | 100% |
| D2 | P1 G13 names_behavior / 群聊名字 | `character_message_builder.py:528-544` 仅输出 role/content | `openai.js:204-209` 四态枚举 + `openai.js:586-603` DEFAULT 条件 + `openai.js:948-950/1111/1319/3743/4034` name 注入 | 100% |
| D3 | P1 wi_format 未应用 | `character_message_builder.py:434/457/577` 原始内容插入 | `openai.js:780-792` `formatWorldInfo` + `openai.js:106` `default_wi_format='{0}'` | 100% |
| D4 | P1 token 预算裁剪缺失 | `character_message_builder.py:503-507` 纯条数截断；`roleplay_prompt_assembly.py:2639/2649` 跳过重排/裁剪 | `openai.js:3397-3403` `TokenBudgetExceededError` + `openai.js:4115-4118` `reserveBudget` + `openai.js:1578-1582` 捕获 | 100% |
| D5 | P2 new_group_chat_prompt / group nudge | 全后端 grep 0 命中 | `openai.js:883-894` `new_group_chat_prompt` + `groupNudgeMessage` | 100% |
| D6 | P2 pin_examples 未尊重 | `character_message_builder.py:488` 仅 `skip_examples` 检查 | `openai.js:1327-1334` `pin_examples` 控制装配顺序 | 100% |
| D7 | P2 scenario_format / personality_format | `character_message_builder.py:446/450` 直接插入原始字段 | `openai.js:1359-1360` 格式串 + `openai.js:112-113` 默认值 | 100% |

### 1.2 清单需修正的描述（3 项，已在 spec 中订正）

| 清单项 | 清单原描述 | 实际行为 | 修正动作 |
|--------|----------|---------|---------|
| outlet (pos 7) | "st-compat 不解析 `{{outlet::name}}`、outlet 内容丢失" | `roleplay_prompt_assembly.py:2602-2622` 后置 macro pass **无条件**解析 `{{outlet::name}}`，`wb_outlet_entries` 已填充 | 清单订正为「字面观察正确，最终结论错误，outlet 实际可达」；本 spec **不修复**，仅订正清单 |
| G14 jailbreak 来源 | "角色卡 `data.extensions.jailbreak`" | ST 1.18.0 实际是 `character.data.post_history_instructions`（`script.js:3361`） | 清单订正；本 spec 修复时以 `char.post_history_instructions` 为角色卡 jailbreak 来源 |
| 作者备注 5 态 | "ST 1.18.0 作者备注 position 0/1/2/3/4 五态" | ST 1.18.0 `authors-note.js:81-88` 实际只有 **3 态**（0=after scenario / 1=in chat at depth / 2=before scenario） | 清单订正；Palink 现有 5 态是 Palink 扩展，保留不动 |

### 1.3 清单未提及但本 spec 纳入修复的差距（3 项）

| 编号 | 差距 | 影响代码 | 把握度 |
|------|------|---------|--------|
| D8 | 群聊装配路径断裂：三个主聊天调用点（`character_ext.py:4101`/`websocket.py:1403`/`silly_tavern.py:3423`）**均不传 `group_id`**，`assemble_roleplay_prompt` 内的群聊分支（`_resolve_group_speaker` 等）成为 dead code | `character_ext.py:3732-3756` `CharacterChatRequest` 无 group_id 字段 | 95% |
| D9 | `{{charjailbreak}}` 宏死代码：`macro_service.py:310-312` 用 `getattr(char, "jailbreak_prompt", None)` 但 `Character` 模型无此字段 | `macro_service.py:310-312` + `character.py` | 100% |
| D10 | `dynamic_context_parts` 在 st-compat 路径被丢弃：`build_st_compat_messages` 接收该参数但函数体内未使用，导致 memory/plotline/Palink 注入等内容**完全不进入 st-compat prompt** | `character_message_builder.py:360` 参数声明 vs 函数体 0 处使用 | 100% |

### 1.4 综合把握度

- **7 项清单内差距**：100% 把握（已逐行核对 Palink 与 ST 1.18.0 源码）
- **3 项清单修正**：100% 把握（已确认 ST 1.18.0 源码实际行为）
- **3 项新发现差距**：95%+ 把握（D8 为调用链分析结果，D9/D10 为 grep + 代码阅读直接证据）
- **整体把握度**：>95%，达到用户要求的"95% 以上的把握后再写 spec"门槛。

---

## 二、Why

清单 `docs/st-compat-gap.md` 列出 7 项面 A 装配差距，全部影响 Palink 后端在 `silly_tavern_mode=st-compat` 模式下装配的 prompt 与 ST 1.18.0 浏览器端 `PromptManager` 装配结果的一致性。其中：

- **G14 jailbreak 索引 11 丢失**：依赖角色卡 jailbreak 或用户全局 jailbreak 的角色，索引 11 内容为空或与 ST 不符。
- **G13 names_behavior / 群聊名字**：群聊或 `force_avatar` 场景下，LLM 无法区分多个说话人——这是 ST 兼容的**核心场景**。
- **wi_format / token 预算**：用户自定义 wi_format 时世界书条目未包裹；长对话 + 大量世界书时可能超出模型上下文窗口。
- **群聊 nudge / pin_examples / scenario_format**：群聊起始标记不符；示例总注入（与 ST 默认语义相反）；scenario/personality 格式串未应用。

清单第 4 节明确指出："st-compat 路径从未在运行时执行过 golden vector 测试"——所有"已修复"结论均来自静态代码审查。本 spec 必须以 ST 1.18.0 真实浏览器输出为 golden vector 做端到端验证。

---

## 三、What Changes

### P1 修复（4 项）

#### 3.1 G14 jailbreak 索引 11 修复
- **MODIFIED** `backend/app/models/character.py`：新增 `jailbreak` 字段（Text，nullable=True），与 `post_history_instructions` 分离存储。
- **MODIFIED** `backend/app/character_card.py:289-352`：导入时优先读取 `data.extensions.jailbreak`（V3 卡 spec）/ `data.jailbreak`，写入 `Character.jailbreak`；保留 `post_history_instructions` 字段语义不变。
- **MODIFIED** `backend/app/models/system.py`：`UserSetting` 新增 `jailbreak` 字段（Text，nullable=True）存储用户全局 jailbreak（对应 ST 主界面 Jailbreak 框）。
- **MODIFIED** `backend/app/api/silly_tavern.py` `/api/settings/save`：从 `extension_settings`/`power_user` 中提取 jailbreak 同步到 `UserSetting.jailbreak`。
- **MODIFIED** `backend/app/services/roleplay_prompt_assembly.py:2390-2425`：调用处传入 `jailbreak=`（角色卡 jailbreak 或用户全局 jailbreak，按 ST `prefer_character_jailbreak` 优先级合并）。
- **MODIFIED** `backend/app/services/character_message_builder.py:584-595`：修正覆盖语义——角色卡 jailbreak（高优先级）→ 用户全局 jailbreak（中）→ `context_template.jailbreak`（低，仅当两者均空时使用）。
- **MODIFIED** `backend/app/services/macro_service.py:310-312`：`{{charjailbreak}}` 宏改为读 `char.jailbreak`（修正死代码）。
- **ADDED** alembic migration：新增 `characters.jailbreak` 列 + `user_settings.jailbreak` 列。

#### 3.2 G13 names_behavior / 群聊名字修复
- **MODIFIED** `backend/app/services/character_message_builder.py` `build_st_compat_messages` 签名新增参数：
  - `names_behavior: int = 0`（DEFAULT）
  - `is_group: bool = False`
  - `user_name: str = ""`（即 ST 的 `name1`）
  - `narrator_type: str = "narrator"`（对应 ST `system_message_types.NARRATOR`）
- **MODIFIED** `character_message_builder.py:528-544`：构建历史消息时读取 `m.name` / `m_extra.force_avatar` / `m_extra.type`，按 ST 四态规则注入：
  - `NONE(-1)`：不加前缀、不加 name 字段
  - `DEFAULT(0)`：`is_group && name != user_name` 或 `force_avatar && name != user_name && type != narrator` 时拼 `Name: content`
  - `COMPLETION(1)`：消息对象添加 `name` 字段（不拼到 content）
  - `CONTENT(2)`：`type != narrator` 时拼 `Name: content`
- **MODIFIED** `backend/app/services/roleplay_prompt_assembly.py:2390-2425`：调用处传入 `names_behavior`（从 `oai_settings.names_behavior` 或 `UserSetting` 读取）、`is_group=bool(req.group_id)`、`user_name=req.user.username`。
- **MODIFIED** `CharacterChatMessage` 模型：确保 `name` 字段已存储（已存在，仅确认读取）。

#### 3.3 wi_format 包裹修复
- **MODIFIED** `build_st_compat_messages` 签名新增 `wi_format: str = ""` 参数。
- **MODIFIED** `character_message_builder.py:434/457/577`：before/after/depth 条目插入前调用新工具函数 `_apply_wi_format(content, wi_format)`，逻辑与 ST `openai.js:780-792` `formatWorldInfo` 完全一致（空 format 返回原值，否则 `stringFormat(format, value)`）。
- **MODIFIED** `roleplay_prompt_assembly.py`：从 `oai_settings.wi_format` 或 `UserSetting.silly_tavern_settings` 读取 wi_format，传入 `build_st_compat_messages`。

#### 3.4 token 预算裁剪修复
- **MODIFIED** `roleplay_prompt_assembly.py:2638-2654`：st-compat 路径**不再无条件跳过** `_apply_dynamic_trimming`，改为：
  - 仍跳过 `_apply_full_prompt_order`（装配序由 builder 固定，与 ST 1.18.0 默认 order 一致）
  - 启用 `_apply_dynamic_trimming` 的**子集**：仅对 chat_history 做按 token 裁剪（保留对话开头与末尾），不对 worldInfoBefore/After/dialogueExamples/jailbreak 等强制项裁剪
- **MODIFIED** `character_message_builder.py:503-507`：`recent_messages_budget` 改为「软上限」——优先按 token 估算裁剪历史，条数仅作为兜底（与 ST `openai.js:1327-1334` 行为一致）。
- **ADDED** 新增 `pin_examples` 支持（见 3.5）后，dialogueExamples 与 chatHistory 的预算竞争逻辑。

### P2 修复（3 项）

#### 3.5 pin_examples + scenario/personality_format 修复
- **MODIFIED** `build_st_compat_messages` 签名新增：
  - `pin_examples: bool = False`
  - `scenario_format: str = "{{scenario}}"`（默认值与 ST `openai.js:112` 一致）
  - `personality_format: str = "{{personality}}"`（默认值与 ST `openai.js:113` 一致）
- **MODIFIED** `character_message_builder.py:446/450`：用 `substituteParams(format)` 后替换 `{{scenario}}` / `{{personality}}`，等价于 ST `openai.js:1359-1360` 行为。
- **MODIFIED** `character_message_builder.py:488`：`pin_examples=true` 时示例先装配（保预算）；`pin_examples=false` 时示例后装配（可能被裁掉）。需配合 P1 token 预算裁剪（3.4）生效。

#### 3.6 群聊 new_group_chat_prompt + group nudge 修复
- **MODIFIED** `build_st_compat_messages` 签名新增：
  - `new_group_chat_prompt: str = "[Start a new group chat. Group members: {{group}}]"`（默认值与 ST `openai.js:108` 一致）
  - `group_nudge: str = ""`（默认空，由调用方按需传入）
- **MODIFIED** `character_message_builder.py:411-416`：`is_group=True` 时使用 `new_group_chat_prompt`（替换 `{{group}}` 为成员名列表），否则用原 `new_chat_prompt`。
- **MODIFIED** `character_message_builder.py:595` 附近：jailbreak 之后、chatHistory 之前，若 `is_group && group_nudge`，注入 nudge system 消息。

#### 3.7 群聊装配路径接通（D8）
- **MODIFIED** `backend/app/api/character_ext.py:3732-3756`：`CharacterChatRequest` 新增 `group_id: Optional[str] = None` 与 `current_speaker_id: Optional[str] = None` 字段。
- **MODIFIED** `character_ext.py:4101-4130`、`websocket.py:1403-1431`、`silly_tavern.py:3423-3447`：三个调用点透传 `group_id` / `current_speaker_id` 到 `PromptAssemblyRequest`。
- **MODIFIED** 前端角色扮演聊天流（如适用）：发送群聊消息时携带 `group_id`。**注**：前端修改需用户授权，本 spec 仅完成后端接口开放，前端接入由后续 spec 处理。

### 修正项（不修改代码，仅订正清单）

#### 3.8 订正 `docs/st-compat-gap.md` 中 3 处错误描述
- **MODIFIED** `docs/st-compat-gap.md` P1 outlet 项：改为"`{{outlet::name}}` 在 st-compat 路径下经 `roleplay_prompt_assembly.py:2621` 后置 macro pass 无条件解析，outlet 内容可达。此项目**不再是差距**"。
- **MODIFIED** `docs/st-compat-gap.md` G14 项：jailbreak 字段来源由 `data.extensions.jailbreak` 订正为 `data.post_history_instructions`（实际 ST 1.18.0 字段）。
- **MODIFIED** `docs/st-compat-gap.md` 第 1 节"作者备注 5 态"：订正为"ST 1.18.0 实际 3 态（0/1/2），Palink 的 5 态是 Palink 扩展"。

### 端到端验证（必做）

#### 3.9 ST 1.18.0 Golden Vector 端到端验证
- **ADDED** `backend/tests/st_compat/golden_vectors/`：存放从 ST 1.18.0 浏览器端导出的 5 个核心场景的真实 prompt 输出（JSON 格式）：
  1. 单角色 + 角色卡 jailbreak + 用户全局 jailbreak
  2. 群聊（3 个成员）+ names_behavior=DEFAULT
  3. 群聊 + names_behavior=COMPLETION
  4. 含 wi_format 设置 + 世界书 before/after/depth/outlet
  5. 长对话（50+ 条）触发 token 预算裁剪 + pin_examples=true/false
- **ADDED** `backend/tests/test_st_compat_golden_vector.py`：对每个场景运行 `build_st_compat_messages`，与 golden vector 逐字节 diff（允许空格/换行微差，不允许内容/顺序/字段差异）。
- **ADDED** `scripts/extract_st_golden_vector.py`：从 ST 1.18.0 浏览器端导出 golden vector 的辅助脚本（指导文档）。

---

## 四、Impact

### 4.1 受影响代码

**后端服务层**（核心修改）：
- `backend/app/services/character_message_builder.py`（`build_st_compat_messages` 签名扩展 + 四态 names_behavior + wi_format + pin_examples + scenario/personality_format + group nudge）
- `backend/app/services/roleplay_prompt_assembly.py:2390-2425`（调用处参数透传 + token 预算裁剪启用）
- `backend/app/services/macro_service.py:310-312`（`{{charjailbreak}}` 宏修正）

**后端模型层**：
- `backend/app/models/character.py`（新增 `jailbreak` 字段）
- `backend/app/models/system.py`（`UserSetting` 新增 `jailbreak` 字段）

**后端 API 层**：
- `backend/app/character_card.py:289-352`（导入时提取 jailbreak）
- `backend/app/api/silly_tavern.py` `/api/settings/save`（同步 jailbreak 到 UserSetting）
- `backend/app/api/character_ext.py:3732-3756`（`CharacterChatRequest` 新增 group_id 字段）
- `backend/app/api/character_ext.py:4101-4130`、`backend/app/api/websocket.py:1403-1431`、`backend/app/api/silly_tavern.py:3423-3447`（三个调用点透传 group_id）

**后端 migration**：
- 新增 alembic migration：`characters.jailbreak` + `user_settings.jailbreak` 列

**文档**：
- `docs/st-compat-gap.md`（订正 3 处错误描述）

**测试**：
- `backend/tests/test_st_compat_golden_vector.py`（新增）
- `backend/tests/st_compat/golden_vectors/*.json`（新增）
- `scripts/extract_st_golden_vector.py`（新增）

### 4.2 不受影响代码

- `frontend/public/st/`（面 B ST iframe，保护现状）
- `backend/app/services/st_sync_service.py`（DATA_ROOT 同步，与面 A 无关）
- `backend/app/services/worldbook_service.py`（WI 扫描算法，pos 7 outlet 已正确实现）
- `backend/app/services/macro_service.py:382-387`（`{{outlet::name}}` 宏已正确实现）
- `backend/app/api/silly_tavern.py:2095` 附近的 `/api/backends/chat-completions/generate`（面 B 透传层，与面 A 无关）

### 4.3 数据库影响

- `characters` 表新增 `jailbreak TEXT NULL` 列（默认 NULL，存量行回退到 `post_history_instructions`）
- `user_settings` 表新增 `jailbreak TEXT NULL` 列（默认 NULL，存量用户无全局 jailbreak）
- 无数据迁移需求（NULL 默认值即正确语义）

### 4.4 Docker 容器影响

- 后端容器需重建（migration + 代码修改）
- 前端容器无修改（本 spec 不修改前端）

### 4.5 与前序 spec 的关系

- **依赖** `st-core-parity-conservative`（G1-G15 已对齐项作为基线）
- **依赖** `final-st-perfect-parity-deep-audit`（B-P0-1 角色卡宏已修复）
- **不冲突** `complete-st-parity-remaining-gaps`（聚焦面 B + 前端，与本 spec 面 A 互不重叠）

---

## 五、ADDED Requirements

### Requirement: ST-Compat Prompt 装配 jailbreak 索引 11 完整性
The system SHALL include both character-card jailbreak (`Character.jailbreak`) and user-global jailbreak (`UserSetting.jailbreak`) in prompt index 11 of `build_st_compat_messages`, with override semantics matching ST 1.18.0 `openai.js:1495-1506`.

#### Scenario: 角色卡 jailbreak 优先
- **WHEN** `Character.jailbreak` 非空 AND `UserSetting.prefer_character_jailbreak = true`（默认）
- **THEN** 索引 11 内容为 `Character.jailbreak`
- **AND** `UserSetting.jailbreak` 与 `context_template.jailbreak` 不参与

#### Scenario: 用户全局 jailbreak 回退
- **WHEN** `Character.jailbreak` 为空 AND `UserSetting.jailbreak` 非空
- **THEN** 索引 11 内容为 `UserSetting.jailbreak`
- **AND** `context_template.jailbreak` 不参与

#### Scenario: 最终回退到 context_template
- **WHEN** `Character.jailbreak` 与 `UserSetting.jailbreak` 均为空
- **THEN** 索引 11 内容为 `context_template.jailbreak`（如非空）

#### Scenario: 全空时索引 11 不注入
- **WHEN** 三个来源均为空
- **THEN** 不向 messages 追加索引 11 的 system 消息（与 ST `default_jailbreak_prompt = ''` 一致）

### Requirement: ST-Compat Prompt 装配 names_behavior 四态
The system SHALL support four `names_behavior` modes (NONE/DEFAULT/COMPLETION/CONTENT) in `build_st_compat_messages`, with semantics matching ST 1.18.0 `openai.js:204-209` and `openai.js:586-603`.

#### Scenario: NONE 模式
- **WHEN** `names_behavior = -1`
- **THEN** 历史消息仅含 `role` 和 `content`
- **AND** 无 `Name:` 前缀，无 `name` 字段

#### Scenario: DEFAULT 模式（默认）
- **WHEN** `names_behavior = 0` AND `is_group = true` AND `message.name != user_name`
- **THEN** 消息 content 拼接为 `"{message.name}: {content}"`
- **AND** 无 `name` 字段

#### Scenario: DEFAULT 模式 + force_avatar
- **WHEN** `names_behavior = 0` AND `message.force_avatar = true` AND `message.name != user_name` AND `message.type != "narrator"`
- **THEN** 消息 content 拼接为 `"{message.name}: {content}"`

#### Scenario: COMPLETION 模式
- **WHEN** `names_behavior = 1` AND `message.name` 非空
- **THEN** 消息对象添加 `name` 字段（值为 `message.name` 经 sanitize）
- **AND** content 不拼接前缀

#### Scenario: CONTENT 模式
- **WHEN** `names_behavior = 2` AND `message.type != "narrator"`
- **THEN** 消息 content 拼接为 `"{message.name}: {content}"`

#### Scenario: NARRATOR 类型豁免
- **WHEN** `message.type = "narrator"` AND `names_behavior` 为 DEFAULT 或 CONTENT
- **THEN** 不拼接 `Name:` 前缀（narrator 永远不加名字）

### Requirement: ST-Compat Prompt 装配 wi_format 包裹
The system SHALL apply `wi_format` template to all worldbook entries (before/after/depth) inserted into prompt, matching ST 1.18.0 `openai.js:780-792` `formatWorldInfo`.

#### Scenario: 空 wi_format
- **WHEN** `wi_format` 为空字符串或纯空白
- **THEN** 世界书条目以原始内容插入

#### Scenario: 非空 wi_format
- **WHEN** `wi_format = "[World Info: {0}]"`
- **THEN** 每个世界书条目内容包裹为 `"[World Info: {original_content}]"`

### Requirement: ST-Compat Prompt token 预算裁剪
The system SHALL apply token-level budget trimming to chat history in st-compat path, matching ST 1.18.0 `TokenBudgetExceededError` + `reserveBudget` semantics.

#### Scenario: 历史消息超预算
- **WHEN** chat_history 总 token 数超过 `token_budget - mandatory_tokens`（A-10/P1-2 修正：剩余预算 = 总预算 − 强制项 token，与 ST 1.18.0 `canAfford` 行为一致；早期 spec 的 `token_budget * 0.7` 比例已废弃，因其会重复扣减动态上下文预算导致历史被过度裁剪）
- **THEN** 从中间裁剪最旧的消息（保留开头 N 条 + 末尾 M 条）
- **AND** 裁剪后的 messages 总 token 数不超过 `token_budget`

#### Scenario: pin_examples=true 时示例优先保留
- **WHEN** `pin_examples = true` AND 总 token 数超预算
- **THEN** dialogueExamples 先装配，保预算；chatHistory 后装配，可能被裁剪

#### Scenario: pin_examples=false 时历史优先保留
- **WHEN** `pin_examples = false` AND 总 token 数超预算
- **THEN** chatHistory 先装配，保预算；dialogueExamples 后装配，可能被裁剪

#### Scenario: 强制项不被裁剪
- **WHEN** worldInfoBefore/After、jailbreak、main system prompt 等强制项总 token 数已超预算
- **THEN** 不裁剪这些强制项
- **AND** 在响应中标记 `token_budget_exceeded=true`（与 ST `promptManager.error` 一致）

### Requirement: ST-Compat Prompt 群聊专用件
The system SHALL support `new_group_chat_prompt` and `group_nudge` in `build_st_compat_messages` for group chat scenarios, matching ST 1.18.0 `openai.js:883-894`.

#### Scenario: 群聊起始标记
- **WHEN** `is_group = true`
- **THEN** 使用 `new_group_chat_prompt`（默认 `"[Start a new group chat. Group members: {{group}}]"`）作为 `[Start a new Chat]` 标记
- **AND** `{{group}}` 替换为成员名列表（逗号分隔）

#### Scenario: 群聊 nudge 注入
- **WHEN** `is_group = true` AND `group_nudge` 非空
- **THEN** 在 jailbreak 之后、chatHistory 之前注入 system 消息，内容为 `group_nudge`

#### Scenario: 单聊不受影响
- **WHEN** `is_group = false`
- **THEN** 使用原 `new_chat_prompt`（`context_template.chat_start` 或 `[Start a new Chat]`）
- **AND** 不注入 group nudge

### Requirement: ST-Compat Prompt scenario/personality_format 包裹
The system SHALL apply `scenario_format` and `personality_format` templates to scenario and personality fields, matching ST 1.18.0 `openai.js:1359-1360`.

#### Scenario: 默认 format
- **WHEN** `scenario_format = "{{scenario}}"` (默认)
- **THEN** scenario 字段插入原始内容（与未包裹等价）

#### Scenario: 自定义 format
- **WHEN** `scenario_format = "[Scenario: {{scenario}}]"`
- **THEN** scenario 字段插入为 `"[Scenario: {original_scenario}]"`

#### Scenario: 空 format
- **WHEN** `scenario_format = ""`
- **THEN** scenario 字段插入为空字符串（与 ST 行为一致）

### Requirement: ST-Compat Prompt pin_examples 控制
The system SHALL respect `pin_examples` setting to control dialogue examples budget competition, matching ST 1.18.0 `openai.js:1327-1334`.

#### Scenario: pin_examples=true
- **WHEN** `pin_examples = true`
- **THEN** dialogueExamples 先于 chatHistory 装配，保留 token 预算

#### Scenario: pin_examples=false（默认）
- **WHEN** `pin_examples = false`
- **THEN** chatHistory 先于 dialogueExamples 装配，dialogueExamples 可能因 token 不足被裁掉

### Requirement: ST-Compat Golden Vector 端到端验证
The system SHALL provide golden vector tests comparing `build_st_compat_messages` output against real ST 1.18.0 browser-side `PromptManager` output.

#### Scenario: Golden vector 一致性
- **WHEN** 运行 `pytest backend/tests/test_st_compat_golden_vector.py`
- **THEN** 5 个核心场景全部通过
- **AND** 每个场景的 messages 与 golden vector 逐字段一致（允许空格/换行微差）

#### Scenario: Golden vector 提取
- **WHEN** 运行 `scripts/extract_st_golden_vector.py`
- **THEN** 从 ST 1.18.0 浏览器端导出 5 个场景的 prompt JSON
- **AND** 输出到 `backend/tests/st_compat/golden_vectors/`

### Requirement: 群聊装配路径接通
The system SHALL pass `group_id` from main chat flows to `assemble_roleplay_prompt`, enabling the existing group chat assembly branch.

#### Scenario: HTTP 群聊请求
- **WHEN** 客户端发送 `/api/character-chat` 请求且 `group_id` 非空
- **THEN** `PromptAssemblyRequest.group_id` 接收该值
- **AND** `_resolve_group_speaker` / `_build_group_profile_context` 等群聊分支被触发

#### Scenario: WebSocket 群聊请求
- **WHEN** WebSocket 消息携带 `group_id`
- **THEN** `assemble_roleplay_prompt` 接收 `group_id`
- **AND** 群聊分支被触发

#### Scenario: 单聊不受影响
- **WHEN** `group_id` 为空
- **THEN** 走单聊路径，不触发群聊分支

---

## 六、MODIFIED Requirements

### Requirement: `build_st_compat_messages` 函数签名
**原行为**: 函数签名仅有 `jailbreak`/`authors_note`/`worldbook_depth_entries` 等参数，无 `names_behavior`/`is_group`/`wi_format`/`pin_examples`/`scenario_format`/`personality_format`/`new_group_chat_prompt`/`group_nudge` 等参数；调用处 `jailbreak=""` 硬编码。

**新行为**: 函数签名扩展上述参数；调用处按 ST 1.18.0 语义传入对应值；jailbreak 按角色卡 → 用户全局 → context_template 优先级合并。

### Requirement: `{{charjailbreak}}` 宏
**原行为**: `macro_service.py:310-312` 用 `getattr(char, "jailbreak_prompt", None)`，但 `Character` 模型无此字段，永远返回 None。

**新行为**: 改为 `getattr(char, "jailbreak", None)`，读取 `Character.jailbreak` 字段（本 spec 新增）。

### Requirement: `recent_messages_budget` 历史裁剪
**原行为**: 纯条数截断（`character_message_builder.py:503-507`）。

**新行为**: 优先按 token 估算裁剪（与 ST `openai.js:1327-1334` 一致），条数仅作为兜底上限。

### Requirement: st-compat 路径 token 预算裁剪
**原行为**: `roleplay_prompt_assembly.py:2639/2649` 无条件跳过 `_apply_full_prompt_order` 和 `_apply_dynamic_trimming`。

**新行为**: 仍跳过 `_apply_full_prompt_order`（装配序由 builder 固定），但启用 `_apply_dynamic_trimming` 的子集（仅对 chat_history 做按 token 裁剪）。

### Requirement: `CharacterChatRequest` 群聊字段
**原行为**: `character_ext.py:3732-3756` `CharacterChatRequest` 无 `group_id` 字段；三个主聊天调用点不传 `group_id`，群聊分支为 dead code。

**新行为**: `CharacterChatRequest` 新增 `group_id: Optional[str] = None` + `current_speaker_id: Optional[str] = None`；三个调用点透传到 `PromptAssemblyRequest`。

---

## 七、REMOVED Requirements

无移除需求。所有修复均在现有基础上补齐，不删除已有功能。

---

## 八、验收标准

本 spec 完成的充要条件：

1. **7 项 P1/P2 差距全部修复**（D1-D7），并通过单元测试
2. **3 项新发现差距全部修复**（D8-D10），并通过单元测试
3. **5 个核心场景 golden vector 测试全部通过**（与 ST 1.18.0 真实输出逐字段一致）
4. **清单 3 处错误描述已订正**（outlet / jailbreak 字段来源 / 作者备注 5 态）
5. **回归测试无退步**（`pytest tests/` 通过率 ≥ Phase 0 基线）
6. **性能 P95 < 200ms**（提示词组装，与 Phase 0 基线一致）
7. **Docker 容器重建后所有测试通过**
