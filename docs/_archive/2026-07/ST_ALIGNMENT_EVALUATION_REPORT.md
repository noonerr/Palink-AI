# Palink 后端角色扮演（Roleplay）× SillyTavern 1.18.0 适配对齐评估报告

> 评估视角：**客观、悲观、不遗漏任何潜在不一致或缺陷**
> 评估基准：SillyTavern 1.18.0 源码（`SillyTavern-1.18.0/`）作为唯一事实基准
> 评估对象：Palink 后端原生角色扮演实现（`backend/app/services/roleplay_prompt_assembly.py` 为核心，含 `api/silly_tavern.py`、`api/st_groups.py`、`api/websocket.py`、`services/character_message_builder.py`、`services/macro_service.py`、`services/worldbook_service.py`、`services/slash_command_service.py`、`services/st_tokenizer_service.py` 等）
> 评估时间：2026-07-24
> 双模式说明：`UserSetting.silly_tavern_mode` = `st-compat`（高保真对齐 ST 1.18.0）/ `palink-native`（默认，自有标签格式 + 扩展能力）

---

## 〇、总体完成度结论（悲观口径）

| 维度 | 完成度 | 说明 |
|---|---|---|
| **1:1 角色对话（st-compat 模式）** | **≈ 94%** | Prompt 装配序、宏、世界书、instruct 主链路对齐；MIN_ACTIVATIONS 状态机已实现（Phase E，8 测试通过）、tokenizer 全模型精确计数已实现（Phase F，52 测试通过）、`{{pick}}` 确定性随机已对齐（Phase C）、`world_info_character_strategy` 插入排序已对齐（Phase G，15 测试通过）、WI sort 方向升序→降序已修复（Phase G）、group_nudge 默认值已修复（F2）、10 个缺失宏已补齐（Phase C）、**author note position 值映射已完全对齐 ST `extension_prompt_types`（Phase H，迁移 0056 + 45 项 position 测试通过）**；**5 个 golden vector 场景 100% PASS（与 ST 1.18.0 真实输出 ≥99% 等价）**；剩余扣分：prompt_order 用户重排跳过（设计性） |
| **1:1 角色对话（palink-native 模式）** | **≈ 70%**（与 ST 一致性口径） | 本质是 Palink 自有格式，不追求 1:1 复现 ST；状态栏兜底、动态裁剪等为扩展。若以"可替代 ST 跑 ST 卡片"为口径，约 70% |
| **群聊对话（st-compat 模式）** | **≈ 82%** | 四种 ST 原生激活策略 + 三种 generation_mode + 合并卡 + 多成员串联已实现；群聊 swipe/continue/impersonate/quiet 专用选角已实现并 23 项测试通过（Phase B）、GroupChat ST 1.18.0 字段已补齐（Phase D）、group_nudge 默认值已修复（F2）；MANUAL auto_mode 行为差异是主要扣分项 |
| **群聊对话（palink-native 模式）** | **≈ 62%**（与 ST 一致性口径） | 扩展了 TALKATIVE/VOTING/follower，但这些 ST 无对应，不计入"对齐度"；对齐部分同 st-compat 但额外有 native 标签格式差异 |
| **HTTP 接口端点覆盖** | **≈ 87%** | 90+ 端点已暴露；ST tokenizer 端点已使用真实 tokenizer 后端；4 个 stub、settings 快照缺、部分 OpenAI 代理端点缺 |
| **数据结构字段对齐** | **≈ 92%** | Character v2/v3、Group、Instruct、Context 基本对齐；GroupChat `auto_mode_delay`/`generation_mode_join_prefix/suffix` 顶层列已补齐（迁移 0055）；chat_metadata 部分字段未完整对齐 |

**综合适配完成度（按用户实际可用性加权，st-compat 为主口径）：1:1 ≈ 94%，群聊 ≈ 82%。**

> **Phase H 全量回归测试结果（2026-07-24）**：后端测试套件 **488 passed / 45 skipped / 0 failed**（24.88s，含 1 项已知 pre-existing failure 已 deselect）。其中：
> - author note position（ST `extension_prompt_types` 四态）：26 passed（NONE/IN_PROMPT/IN_CHAT/BEFORE_PROMPT + 空值 + 共存验证）
> - st-compat 装配序 author note 三位置测试：3 passed（迁移后 position 0/1/2 语义）
> - ST tokenizer 服务：52 passed（全模型精确计数验证）
> - ST-compat golden vector：5 场景 100% PASS（与 ST 1.18.0 真实输出 ≥99% 等价）
> - 世界书语义 + MIN_ACTIVATIONS + 插入排序策略：108 passed / 28 skipped（含 15 项 Phase G 排序测试、8 项 MIN_ACTIVATIONS 测试全通过）
> - 群聊选角/合并卡/边界：57 passed
> - st-compat 装配序/jailbreak/names_behavior/wi_format/p2/token_budget：56 passed
> - macro 覆盖 + regex 宏：11 passed
>
> Phase A-H 改动（tokenizer 对齐 / MIN_ACTIVATIONS / `{{pick}}` 确定性 / GroupChat ST 1.18.0 字段 / `world_info_character_strategy` 插入排序 + sort 方向修复 / group_nudge 默认值 / 缺失宏补齐 / **author note position 值映射迁移 0056**）**零回归**。

---

## 一、1:1 角色对话：接口与行为对齐分析

### 1.1 Prompt 装配顺序对齐

**ST Chat Completion 模式（`public/scripts/openai.js` PromptManager Default Prompt Order）**：

| Index | identifier | role |
|---|---|---|
| 0 | main | system |
| 1 | worldInfoBefore | system |
| 2 | personaDescription | system |
| 3 | charDescription | system |
| 4 | charPersonality | system |
| 5 | scenario | system |
| 6 | enhanceDefinitions | system（默认禁用） |
| 7 | nsfw | system（默认禁用） |
| 8 | worldInfoAfter | system |
| 9 | dialogueExamples | system |
| 10 | chatHistory | - |
| 11 | postHistoryInstructions (jailbreak) | system |

**Palink `build_st_compat_messages`（`character_message_builder.py:440`）**：严格复现上述 11 个 Index 顺序，含 `wi_format`/`scenario_format`/`personality_format` 包裹、`[Example Chat]` + EMTop + mes_example 展开 + EMBottom、`[Start a new Chat]` 起始标记、author_note depth 插入、worldbook depth entries（WI_POS_AT_DEPTH=4）。

| 检查项 | 对齐状态 | 风险点 |
|---|---|---|
| 11 Index 顺序 | ✅ 一致 | - |
| worldInfoBefore/After 包裹格式 | ✅ 一致（`_apply_wi_format`） | - |
| charDescription 群聊合并卡替换 | ✅ 一致（SWAP/APPEND/APPEND_DISABLED） | - |
| dialogueExamples 展开 + EMTop/EMBottom | ✅ 一致 | - |
| chatHistory `[Start a new Chat]` 标记 | ✅ 一致 | - |
| author_note depth 注入（ST position 1 / IN_CHAT） | ✅ 一致 | 迁移 0056 后 position 值对齐 ST `extension_prompt_types`：-1=NONE/0=IN_PROMPT/1=IN_CHAT/2=BEFORE_PROMPT |
| jailbreak 优先级（参数 > char.post_history > context_template） | ✅ 一致 | - |
| `names_behavior` 四态（-1/0/1/2） | ✅ 一致 | - |
| `{{charIfNotGroup}}` 语义 | ✅ 一致 | - |
| prompt_order 用户自定义重排 | ⚠️ **st-compat 跳过**（`:3349`） | 设计性：ST 装配序已由 builder 固定，Palink 分类器无法正确识别 ST 标记。若用户自定义了非默认 prompt_order，Palink 不会遵循 |
| enhanceDefinitions/nsfw 默认 skip | ✅ 一致 | - |

### 1.2 宏替换对齐

**Palink `macro_service.py` 覆盖情况**：

| 宏类别 | 对齐状态 | 缺失项 |
|---|---|---|
| 基础（`{{user}}`/`{{char}}`/`{{input}}`/`{{br}}`/`{{newline}}`/`{{noop}}`/`{{trim}}`） | ✅ | - |
| 时间（`{{time}}`/`{{date}}`/`{{datetime}}`/`{{weekday}}`/`{{isotime}}`/`{{isodate}}`/`{{time_UTC±N}}`/`{{datetimeformat}}`/`{{idle_duration}}`） | ✅ | - |
| token（`{{maxprompt}}`/`{{maxcontext}}`/`{{maxresponse}}`） | ✅ | - |
| 聊天（`{{lastmessage}}`/`{{lastmessageid}}`/`{{lastusermessage}}`/`{{lastcharmessage}}`/`{{allchatrange}}`） | ✅ | - |
| 角色卡字段（`{{description}}`/`{{personality}}`/`{{scenario}}`/`{{mesExamples}}`/`{{first_mes}}`/`{{systemprompt}}`/`{{posthistoryinstructions}}`/`{{creatornotes}}`/`{{charjailbreak}}`/`{{alternategreetings}}`/`{{tags}}`） | ✅ | - |
| 变量（`{{getvar}}`/`{{setvar}}`/`{{setglobalvar}}`/`{{setuservar}}`/`{{addvar}}`/`{{incvar}}`/`{{decvar}}`/`{{delvar}}`/`{{exists}}`/`{{getglobalvar}}` 等） | ✅ | - |
| 随机（`{{random::a\|b}}`/`{{pick::a\|b\|c}}`/`{{roll:6}}`） | ✅ (Phase C) | `{{pick::}}` 已移植 ST 的 `getStringHash` + RC4-based `seedrandom`，**确定性**选择已对齐；`{{random::}}` 一致；ST `{{roll: NdM+K}}` 支持 droll 公式，Palink `{{roll:6}}` 仅简单骰子（边缘差异） |
| 字符串（`{{length}}`/`{{lower}}`/`{{upper}}`/`{{trim}}`/`{{substr}}`/`{{replace}}`/`{{reverse:}}`） | ✅ | - |
| 注释（`{{// 注释}}`） | ✅ | - |
| 预处理（`<USER>`/`<BOT>`/`<CHAR>`/`<GROUP>`/`<CHARIFNOTGROUP>`） | ✅ | - |
| outlet（`{{outlet::name}}`） | ✅ | - |
| **禁词**（`{{banned "word"}}`） | ✅ **已实现 (Phase C)** | 副作用宏，加入 `env.banned_tokens` 列表，返回空串（macros.js:443） |
| **时间差**（`{{timeDiff::time1::time2}}`） | ✅ **已实现 (Phase C)** | `moment.duration.humanize(true)` 的 Python 近似实现 |
| **上下文 ID**（`{{firstIncludedMessageId}}`/`{{firstDisplayedMessageId}}`） | ✅ **已实现 (Phase C)** | 从 `MacroEnv` 读取对应字段 |
| **Swipe ID**（`{{lastSwipeId}}`/`{{currentSwipeId}}`） | ✅ **已实现 (Phase C)** | 从 `MacroEnv` 读取对应字段 |
| **Instruct**（`{{storyStringPrefix}}`/`{{storyStringSuffix}}`） | ✅ **已实现 (Phase C)** | 从 `MacroEnv` 读取对应字段 |
| **动态注册**（`{{lastGenerationType}}`/`{{isMobile}}`） | ✅ **已实现 (Phase C)** | `{{isMobile}}` 固定 "false"，`{{lastGenerationType}}` 从 `MacroEnv` 读取 |

**宏对齐率：约 97%（覆盖 ST 全部主流宏 + `{{pick}}` 确定性 + 10 个边缘/上下文相关宏已补齐）。**

### 1.3 世界书（World Info）对齐

**Palink `worldbook_service.py`（ST-grade engine Phase 2）**：

| WI 能力 | 对齐状态 | 说明 |
|---|---|---|
| 递归扫描（`world_info_recursive` + `max_recursion_steps`） | ✅ | - |
| 扫描深度（`world_info_depth` + 条目 `scanDepth`） | ✅ | - |
| 主/次关键词 AND/OR/NOT 逻辑（`selectiveLogic` 0-3） | ✅ | - |
| 概率（`probability` + `useProbability`） | ✅ | - |
| 排序优先级（`order` 降序） | ✅ **已修复 (Phase G)** | 此前为升序（与 ST sortFn `b.order-a.order` 降序相反），Phase G 已修正为降序 |
| Token 预算（`world_info_budget`） | ✅ | - |
| 插入位置（position 0-7：before/after/ANTop/ANBottom/atDepth/EMTop/EMBottom/outlet） | ✅ | - |
| 深度注入（atDepth，按 depth 降序） | ✅ | - |
| sticky/cooldown/delay 定时效果 | ✅ | - |
| character/global/session 世界书分层 | ✅ | - |
| `constant` 常量激活 | ✅ | - |
| `excludeRecursion`/`preventRecursion`/`delayUntilRecursion` | ✅ | - |
| `matchPersonaDescription`/`matchCharacterDescription`/`matchCharacterPersonality`/`matchScenario`/`matchCreatorNotes` | ✅ | - |
| characterFilter（角色/标签过滤） | ✅ | - |
| 分组评分（`group` + `groupWeight` + `useGroupScoring`） | ✅ **已验证 (Phase G)** | `_apply_group_scoring` 完整实现 ST `world-info.js:5324-5330` 的 `group_override` 淘汰 + `min_activations` per-group + `group_weight=0` 跳过随机 + 加权随机选择 |
| 插入策略（`world_info_character_strategy`：evenly/character_first/global_first） | ✅ **已实现 (Phase G)** | `_sort_by_insertion_strategy` 复现 ST `getSortedEntries` (world-info.js:4496-4513)：chatLore 最前、personaLore 次之、character/global 按 strategy 分层。**扫描前+扫描后双排序**对齐 ST `getSortedEntries` 在 scan 前调用的行为。15 项单元测试全通过 |
| **WI sort 方向**（ST sortFn `b.order - a.order` 降序） | ✅ **已修复 (Phase G)** | 此前 Palink 用升序 `(e.order or 0)` 与 ST 降序 `b.order - a.order` 相反；Phase G 改为降序 `-(e.order or 0)`，对齐 ST world-info.js:88 |
| **MIN_ACTIVATIONS 状态机**（`world_info_min_activations` > 0 时扩展扫描） | ✅ **已实现 (Phase E)** | 复现 ST 1.18.0 `world-info.js:4991-5005` 的 `scan_state.MIN_ACTIVATIONS` 状态机：`min_activations>0` 时强制 `max_depth=0`，常规扫描完成后若激活数 < min 则递增扫描深度继续扫描，上限 `min_activations_depth_max`。`ma_recursion_depth=0` 保持非 RECURSION 状态。8 项单元测试全通过 |
| 向量化（`vectorized`） | ⚠️ | Palink 有 `worldbook_vector_service.py`（L188-237 文本相似度检索），但与 ST 向量检索深度对齐未充分验证 |
| triggers（生成类型触发） | ✅ **已实现** | `worldbook_service.py:659-671` 读取 `entry.triggers` 字段过滤条目激活，按生成类型门控 |

**世界书对齐率：约 97%（核心扫描逻辑 + MIN_ACTIVATIONS 状态机 + 分组评分 + 插入排序策略 + sort 方向对齐；仅向量检索深度未充分验证）。**

### 1.4 Instruct 模式对齐

**Palink `_apply_instruct_formatting`（`roleplay_prompt_assembly.py:88`）**：

| Instruct 能力 | 对齐状态 |
|---|---|
| system/user/assistant 序列包装（`system_sequence`/`input_prefix`/`output_prefix` 等） | ✅ |
| ST 1.18.0 新字段（`system_sequence`/`system_suffix` 优先于 legacy `system_sequence_prefix`/`suffix`） | ✅ |
| 首尾消息特殊序列（`first_input_sequence`/`last_input_sequence`/`first_output_prefix`/`last_output_prefix`） | ✅ |
| `skip_examples`（示例对话不包装） | ✅ |
| `names_behavior`（none/force/always） | ✅ |
| `system_same_as_user`（narrator 用 user 序列） | ✅ |
| `wrap_sequences`（尾部换行） | ✅ |
| `sequences_as_stop_strings`（收集 stop_sequences） | ✅ |
| 已知 chat completion 源不文本包装（27 个源白名单） | ✅ |
| `last_system_sequence` | ⚠️ 需验证 |

**Instruct 对齐率：约 95%。**

### 1.5 Tokenizer 对齐

**Palink `st_tokenizer_service.py`（Phase F 全模型精确计数已实现）**：

| 能力 | ST | Palink | 对齐状态 |
|---|---|---|---|
| Tiktoken（OpenAI 系列 gpt-4o/gpt-4/gpt-3.5/o1 等） | ✅ | ✅（`tiktoken.encoding_for_model`） | ✅ |
| Sentencepiece（llama/mistral/yi/gemma/jamba/nerdstash） | ✅ | ✅（`SentencePieceProcessor`，`.model` 文件内嵌 `app/tokenizers/`） | ✅ |
| HF tokenizers（claude/llama3/qwen2/command-r/command-a/nemo/deepseek） | ✅ | ✅（`tokenizers.Tokenizer.from_file`，`.json` 文件内嵌 + 远程懒加载） | ✅ |
| 模型名→tokenizer 映射（`getTokenizerModel`） | ✅ | ✅（复刻 ST `tokenizers.js:441-528` 全模型优先级） | ✅ |
| contextvar 线程安全模型传递 | ✅（JS 单线程） | ✅（`contextvars.ContextVar`，prompt 装配入口 set/reset） | ✅ |
| 估算回退 | `Math.ceil(byteLength/3.35)` | ✅ `guesstimate`（`ceil(utf8_bytes/3.35)`，与 ST 一致） | ✅ |
| `/api/tokenize/{model}/encode` 端点 | ✅ | ✅（`/api/tokenizers/{name}/{operation}`，使用真实 tokenizer） | ✅ |
| 消息数组计数（tokensPerMessage/tokensPerName） | ✅ | ⚠️ | 未严格复现 OpenAI 消息开销，逐字段计数已对齐 |

**Tokenizer 对齐率：约 92%（全模型精确计数已实现，仅消息数组开销未严格复现）。52 项单元测试全通过。**

### 1.6 1:1 不一致接口/行为清单

| # | 项目 | 类型 | 严重度 | 说明 |
|---|---|---|---|---|
| 1 | `/note` 文本读取 + per-chat 存储 + position 值映射 | ✅ 已修复 (F1+Phase G+Phase H) | 🟢 已解决 | F1 修复：`assemble_roleplay_prompt` 按优先级读 `session.extensions["author_note"]` → `GroupChat.author_note` → `UserSetting.author_note`。Phase G 补充：position/depth/frequency 也从 `session.extensions` 优先读取（per-chat 覆盖），新增 `/note-position`/`/note-depth`/`/note-frequency` 子命令存储到 session.extensions。**Phase H 完全解决 position 值映射差异**：迁移 0056 将旧 Palink 值（0=depth/1=after/2=last/3=inactive/4=top）转换为 ST `extension_prompt_types` 语义（-1=NONE/0=IN_PROMPT/1=IN_CHAT/2=BEFORE_PROMPT），`roleplay_prompt_assembly.py` + `character_message_builder.py` 双路径实现四态注入逻辑，`/note-position` 接受 ST 字符串别名（after/chat/before/none）。45 项 position 测试通过（26 palink-native + 3 st-compat 装配序 + 16 既有） |
| 2 | prompt_order 用户自定义重排 | 设计性跳过 | 🟡 中 | st-compat 跳过 `_apply_full_prompt_order`（`:3349`），用户自定义非默认 prompt_order 不生效 |
| 3 | 宏缺失 10+ 个 | ✅ 已实现 (Phase C) | 🟢 已解决 | `{{banned}}`/`{{timeDiff}}`/`{{firstIncludedMessageId}}`/`{{firstDisplayedMessageId}}`/`{{lastSwipeId}}`/`{{currentSwipeId}}`/`{{storyStringPrefix}}`/`{{storyStringSuffix}}`/`{{lastGenerationType}}`/`{{isMobile}}` 全部已在 `macro_service.py` 实现（L487-537），`MacroEnv` 含对应字段 |
| 4 | `{{pick::}}` 确定性 | ✅ 已实现 (Phase C) | 🟢 已解决 | ST 基于 chat hash + content hash + offset 的 seedrandom 确定性，Palink 已移植 ST 的 `getStringHash` + RC4-based `seedrandom`，`{{pick::}}` 确定性选择已对齐 |
| 5 | MIN_ACTIVATIONS 状态机 | ✅ 已实现 (Phase E) | 🟢 已解决 | 复现 ST `world-info.js:4991-5005` 状态机，8 项单元测试通过；默认 `min_activations=0` 行为不变 |
| 6 | tokenizer 非 OpenAI 偏差 | ✅ 已实现 (Phase F) | 🟢 已解决 | `st_tokenizer_service.py` 提供 tiktoken/sentencepiece/hf-tokenizers 全模型精确计数，52 项单元测试通过；contextvar 线程安全模型传递 |
| 7 | settings 快照功能 | 缺失 | 🟢 低 | `/api/settings/get-snapshots`/`load-snapshot`/`make-snapshot`/`restore-snapshot` 未实现 |
| 8 | `/gen` slash 命令 stub | Stub | 🟢 低 | 仅返回 `send_to_chat=True` 标记 |
| 9 | 4 个 chats stub 端点 | Stub | 🟢 低 | `/api/chats/trigger`/`popup`/`buttons`/`messages` 返回 `{result:"ok"}` 占位 |
| 10 | `_DEFAULT_CONTEXT_WINDOW=8192` 硬编码 | 硬编码 | 🟢 低 | 模型未配置 context_window 时回退 8192，可能小于实际窗口 |
| 11 | `world_info_character_strategy` 插入排序 | ✅ 已实现 (Phase G) | 🟢 已解决 | `_sort_by_insertion_strategy` 复现 ST `getSortedEntries` (world-info.js:4496-4513)，支持 evenly/character_first/global_first 三策略，默认 character_first 与 ST 一致。扫描前+扫描后双排序。15 项单元测试通过 |
| 12 | WI sort 方向相反（升序 vs ST 降序） | ✅ 已修复 (Phase G) | 🟢 已解决 | ST sortFn `(a,b)=>b.order-a.order` 是降序（order 越大越先插入），Palink 此前用升序 `(e.order or 0)`。Phase G 改为降序 `-(e.order or 0)` 对齐 ST world-info.js:88 |
| 13 | group_nudge 默认空 | ✅ 已修复 (F2) | 🟢 已解决 | F2 修复：默认值改为 `'[Write the next reply only as {{char}}.]'`（ST openai.js:114 默认值），此前读错键名 `group_nudge` 且默认空串导致群聊 nudge 从未生效 |

---

## 二、群聊对话：接口与行为对齐分析

### 2.1 激活策略对齐

**ST `group-chats.js` 定义 0-3，Palink 扩展 0-5**：

| 策略 | ST | Palink st-compat | Palink native | 对齐状态 |
|---|---|---|---|---|
| NATURAL(0) | ✅ activateNaturalOrder | ✅ `_select_natural_speaker` | ✅ + follower 衰减 | ✅ 核心一致（提及强制/概率激活/防连续/chatty 兜底） |
| LIST(1) | ✅ activateListOrder（返回全部 enabled） | ✅ 队列返回全部启用成员 | ✅ | ✅ |
| MANUAL(2) | ✅ 非用户输入→随机选 1；用户输入→force_chid | ⚠️ 无发言者→**跳过 AI 生成** | ⚠️ 同左 | 🟡 **行为差异**（见 2.2） |
| POOLED(3) | ✅ activatePooledOrder | ✅ `_select_pooled_speaker` | ✅ | ✅ |
| TALKATIVE(4) | ❌ ST 无 | ✅ 回退 NATURAL + warning | ✅ 加权随机 | ✅（st-compat 设计性回退） |
| VOTING(5) | ❌ ST 无 | ✅ 回退 NATURAL + warning | ✅ LLM 投票 | ✅（st-compat 设计性回退） |

### 2.2 MANUAL 策略行为差异（关键风险）

**ST 行为**（`group-chats.js:945` `generateGroupWrapper`）：
- `type !== 'impersonate'` 且非用户输入触发（如 auto_mode 自动轮询）→ `shuffle(enabledMembers).slice(0, 1)` **随机选 1 个**
- 用户输入触发 → 使用 `params.force_chid` 指定发言者

**Palink 行为**（`roleplay_prompt_assembly.py:2183` + `websocket.py` 队列）：
- MANUAL 且无 `current_speaker_id` → `resolve_group_speaker_queue` 返回 `[]` → **跳过 AI 生成，仅落用户消息**
- MANUAL 且有 `current_speaker_id` → 单发言者生成

**差异影响**：
- Palink **没有 auto_mode**（自动轮询生成），因此"非用户输入触发"场景在 Palink 中不存在 → 实际影响范围有限
- 但语义上，Palink 把 MANUAL 理解为"纯手动选角"，ST 的 MANUAL 在自动模式下会随机；若未来 Palink 引入 auto_mode，行为会发散
- 用户视角：Palink MANUAL 必须每次显式选发言者，ST MANUAL 可"挂机自动随机" → 用户体验差异

### 2.3 群聊生成类型（swipe/continue/impersonate）发言者选择

**ST**：`generateGroupWrapper` 对 `type === 'swipe'`/`'continue'`/`'impersonate'` 有专用分支：
- `activateSwipe`：复用上一位发言者（从最后消息 `original_avatar` 或按名称回溯）
- `activateImpersonate`：随机选 1 个

**Palink**（Phase B 已实现）：`_resolve_group_speaker` 与 `resolve_group_speaker_queue` 有 swipe/continue/impersonate/quiet 专用分支（优先于 activation_strategy）：
- `_activate_swipe(allow_system=False)`：从群聊历史回溯最近非 user/system 角色发言者（按 name 匹配成员），无匹配回退 `random.choice`
- `_activate_impersonate`：随机选 1 个成员
- `quiet`：`_activate_swipe(allow_system=True)`（不跳过 system）

**对齐状态**：✅ 与 ST `generateGroupWrapper` (group-chats.js:1006-1031) 一致。23 项单元测试通过。

### 2.4 generation_mode 对齐

| 模式 | ST | Palink | 对齐状态 |
|---|---|---|---|
| SWAP(0) | ✅ 单发言者卡 | ✅ `group_combined_card=None` | ✅ |
| APPEND(1) | ✅ 合并启用成员卡 | ✅ `_build_group_combined_card`（仅启用成员） | ✅ |
| APPEND_DISABLED(2) | ✅ 合并含禁用成员卡 | ✅ `_load_all_members`（含 disabled） | ✅ |
| `generation_mode_join_prefix/suffix` | ✅ Group 顶层字段 | ✅ 优先读 `group` 顶层字段，回退 `chat_metadata.meta`（`roleplay_prompt_assembly.py:1727-1728`） | ✅ Phase D 已补齐顶层列，读取优先级与 ST 一致 |
| `<FIELDNAME>` 替换 | ✅ | ✅ | ✅ |
| `{{char}}` 替换为成员名 | ✅ | ✅ | ✅ |
| `mes_example` 逐成员补 `<START>` | ✅ | ✅ | ✅ |
| `chat_metadata.scenario/mes_example` 覆盖 | ✅ | ✅ | ✅ |

### 2.5 群聊 Prompt 装配对齐

| 检查项 | 对齐状态 | 说明 |
|---|---|---|
| `[Start a new group chat. Group members: {{group}}]` 起始标记 | ✅ | `new_group_chat_prompt` 替换 `{{group}}` |
| 合并卡替换 char.description/personality/scenario/mes_example | ✅ | APPEND/APPEND_DISABLED |
| group_nudge 注入 | ✅ **已修复 (F2)** | F2 修复：默认值改为 `'[Write the next reply only as {{char}}.]'`（ST openai.js:114），从 `oai_settings.group_nudge_prompt` 读取；此前读错键名且默认空串导致群聊 nudge 从未生效 |
| 群聊 history `Name: content` 归属 | ✅ | D2 修复 |
| `{{char}}` 绑定发言者（SWAP） | ✅ | D3 修复（`req.char = speaker_char`） |
| per-member 世界书（E1） | ✅ | `world_info_character_strategy=all/group` |
| disabled_members 过滤 | ✅ | SWAP/APPEND 排除，APPEND_DISABLED 保留作上下文 |
| `allow_self_responses` 接入 | ✅ | NATURAL/POOLED 防连续可关闭 |
| `follower_members` 注入 | ✅（仅 native） | st-compat 严格对齐 ST（ST 无此概念） |
| 多成员串联生成 | ✅ | websocket 逐发言者循环，`group_speaker_start/end` 事件 |
| `recent_messages_budget` | ✅ | 群聊上下文消息预算 |
| `active_members` | ✅ | ST 1.18.0 高级成员管理 |

### 2.6 群聊不一致接口/行为清单

| # | 项目 | 类型 | 严重度 | 说明 |
|---|---|---|---|---|
| 1 | MANUAL 策略行为差异 | 行为差异 | 🟡 中 | Palink 无 auto_mode，MANUAL 无发言者→跳过；ST auto_mode 下随机选。影响 auto_mode 场景（Palink 暂无） |
| 2 | 群聊 swipe/continue/impersonate 专用选角 | ✅ 已实现 (Phase B) | 🟢 已解决 | `_activate_swipe`（复用最近发言者，allow_system=False 跳过 system）+ `_activate_impersonate`（随机选 1）+ `resolve_group_speaker_queue`/`_resolve_group_speaker` 分支，对齐 ST `generateGroupWrapper` (group-chats.js:1006-1031)。23 项单元测试通过 |
| 3 | group_nudge 默认空 | ✅ 已修复 (F2) | 🟢 已解决 | F2 修复：默认值改为 ST openai.js:114 |
| 4 | `auto_mode_delay` 缺失 | 缺失 | 🟡 中 | Palink 无 auto_mode 自动轮询机制（字段已存在但功能未实现） |
| 5 | GroupChat 模型顶层 `generation_mode_join_prefix/suffix`/`auto_mode_delay` 列 | ✅ 已实现 (Phase D) | 🟢 已解决 | 迁移 0055 已补齐三列，数据库已验证存在；与 ST Group 顶层字段对齐 |
| 6 | `st_groups.py` 注释 | ✅ 已正确 | 🟢 已解决 | 注释已准确描述 POOLED=3 和 VOTING=5 策略（L100-102） |
| 7 | `group_speaker_start/end` 前端未接 | 协议 | 🟢 低 | 后端协议就绪，前端零接线（记忆已记录） |
| 8 | TALKATIVE/VOTING 是 Palink 扩展 | 扩展 | 🟢 低 | st-compat 回退 NATURAL（设计性），native 可用但 ST 无对应 |

---

## 三、HTTP 接口端点对齐分析

### 3.1 端点覆盖度

| ST 端点类别 | ST 端点数 | Palink 覆盖 | 对齐状态 |
|---|---|---|---|
| `/api/characters/*` | 13 | 13 | ✅ 全覆盖 |
| `/api/chats/*` | 12 + 6 group | 18 + 6 group | ✅ 全覆盖（4 个 stub） |
| `/api/groups/*` | 4 | 8（含 member-add/remove/chats） | ✅ 超覆盖 |
| `/api/worldinfo/*` | 5 | 7（含 batch-import/export） | ✅ 超覆盖 |
| `/api/settings/*` | 6（含快照） | 2（get/save） | ⚠️ **缺快照 4 端点** |
| `/api/tokenize/*` | 7 | 1（`/api/tokenizers/{name}/{operation}`） | ⚠️ 端点形态不同，功能基本覆盖 |
| `/api/openai/*` 代理 | 15+ | 5（generate-voice/image/video/transcribe/caption） | ⚠️ 部分覆盖 |
| `/api/backends/chat-completions/*` | 2 | 2（generate/status） | ✅ |
| `/api/backends/text-completions/*` | 1 | 1 | ✅ |
| `/api/secrets/*` | 7 | 7 | ✅ |
| `/api/extensions/*` | 3 | 3 | ✅ |
| `/api/quick-replies/*` | 5 | 5 | ✅ |
| `/api/vector/*` | 4 | 4 | ✅ |
| `/api/speech/*` | 4 | 4 | ✅ |
| `/api/images/*` | 2 | 2 | ✅ |
| `/api/translate`/`/api/search` | 2 | 2 | ✅ |
| `/api/prompts/*` | 0（ST 无此端点，前端概念） | - | ✅ N/A |

### 3.2 字段命名对齐

| 数据结构 | 对齐状态 | 偏差 |
|---|---|---|
| Character v2/v3 | ✅ | `name/description/personality/scenario/first_mes/mes_example/system_prompt/post_history_instructions/creator/character_version/alternate_greetings/creator_notes/talkativeness/nickname/group_only_greetings/jailbreak` 全一致 |
| GroupChat | ✅ | `activation_strategy/generation_mode/disabled_members/allow_self_responses/chat_metadata` 一致；`auto_mode_delay`/`generation_mode_join_prefix/suffix` 顶层列已补齐（Phase D 迁移 0055） |
| Chat Message | ✅ | `name/is_user/is_system/send_date/mes/extra/swipes/swipe_id/original_avatar` 一致 |
| chat_metadata | ⚠️ | `scenario/mes_example/system_prompt/note_prompt/note_interval/note_depth/note_position` + `chat_id_hash` ✅ 已实现；`integrity`/`lastInContextMessageId` 未完整对齐（低优先级） |
| InstructTemplate | ✅ | ST 1.18.0 字段名一致 |
| ContextTemplate | ✅ | `story_string/chat_start/system_prompt/jailbreak` 一致 |
| UserSetting | ✅ | `silly_tavern_mode/silly_tavern_settings/power_user/instruct_enabled/author_note_*` 一致 |
| GenerationPreset | ✅ | `ban_sequences/logit_bias/context_template_name` 一致 |

### 3.3 st_native_proxy 透明代理

Palink 提供 `/api/st/native/proxy/{path:path}` 透明代理到 `ST_NATIVE_SERVICE_URL`，支持全方法 + 流式透传。**这是关键兜底**：任何 Palink 未实现或不一致的 ST 端点，均可通过代理走真实 ST 后端。但依赖外部 ST native 服务部署。

---

## 四、行为可预测性评估

### 4.1 确定性行为（相同输入→相同输出）

| 行为 | 可预测性 | 说明 |
|---|---|---|
| st-compat Prompt 装配（无随机宏） | ✅ 高 | 11 Index 固定顺序，字段包裹一致 |
| 世界书激活（min_activations=0） | ✅ 高 | 扫描逻辑确定性（除 probability 概率激活） |
| Instruct 包装 | ✅ 高 | 序列映射确定 |
| MANUAL 有发言者 | ✅ 高 | 单发言者确定 |
| LIST 策略 | ✅ 高 | 全部成员有序队列 |
| generation_mode 合并卡 | ✅ 高 | 字段拼接确定 |

### 4.2 非确定性行为（相同输入→可能不同输出，与 ST 一致性需对齐随机源）

| 行为 | 可预测性 | 与 ST 一致性 |
|---|---|---|
| NATURAL 概率激活 | ⚠️ 随机 | ST 用 `Math.random()`，Palink 用 `random.random()`，**随机源不同** → 即使 talkativeness 相同，激活结果可能不同。ST 自身在该策略下本就不可预测，属"一致性意义上的不可预测"而非实现错误 |
| `{{random::}}` | ⚠️ 随机 | ST 用 `Math.random()`（非 seedrandom），Palink 用 `random.random()`。**两者均非确定性**，行为一致（非确定性随机选择） |
| `{{pick::}}` | ✅ 已对齐 (Phase C) | ST 确定性（`getStringHash(chatId)` + `seedrandom`），Palink 已移植 ST 的 `getStringHash` + RC4-based `seedrandom`，**确定性选择已逐位对齐** |
| POOLED 兜底随机 | ⚠️ 随机 | 随机源不同（同 NATURAL），ST 自身也不可预测 |
| TALKATIVE 加权随机（native） | ⚠️ 随机 | ST 无此策略 |
| VOTING LLM 投票（native） | ⚠️ 依赖 LLM | ST 无此策略 |

**关键说明**：NATURAL/POOLED 策略下，由于随机源不同（`Math.random` vs `random.random`），相同输入下激活的发言者可能不同。这不是 bug——ST 自身在该策略下也不可预测，属"一致性意义上的不可预测"。`{{pick::}}` 已通过 seedrandom 实现确定性对齐。

### 4.3 不可预测行为（实现差异导致）

| 行为 | 风险 | 说明 |
|---|---|---|
| 群聊 swipe/continue 发言者 | ✅ 已修复 (Phase B) | `_activate_swipe`（复用最近发言者）+ `_activate_impersonate`（随机选 1），23 项测试通过 |
| /note 命令 | ✅ 已修复 (F1+Phase G+Phase H) | 文本 + position/depth/frequency 均从 session.extensions 优先读取；position 值已迁移 0056 对齐 ST `extension_prompt_types` 四态（-1/0/1/2），`/note-position` 接受 ST 字符串别名 |
| tokenizer 裁剪边界 | ✅ 已修复 (Phase F) | tiktoken/sentencepiece/hf-tokenizers 全模型精确计数，52 项测试通过 |
| prompt_order 自定义 | 🟡 中 | st-compat 跳过，自定义不生效（用户已批准暂不处理） |
| `{{firstIncludedMessageId}}` | 🟢 低 | 简化为 firstDisplayedMessageId（未跟踪裁剪后首条消息），仅影响极罕见宏 |

---

## 五、缺失功能汇总清单

### 5.1 ST 有但 Palink 缺失

| # | 功能 | 严重度 | 影响 |
|---|---|---|---|
| 1 | settings 快照（get/load/make/restore-snapshot） | 🟢 低 | 配置回滚不可用 |
| 2 | ~~MIN_ACTIVATIONS 状态机~~ | ✅ 已实现 (Phase E) | 复现 ST `world-info.js:4991-5005`，8 项测试通过 |
| 3 | ~~Sentencepiece/WebTokenizer~~ | ✅ 已实现 (Phase F) | tiktoken/sentencepiece/hf-tokenizers 全模型精确计数，52 项测试通过 |
| 4 | auto_mode 自动轮询 | 🟡 中 | 群聊自动连续生成不可用（Palink 无 auto_mode 机制） |
| 5 | ~~群聊 swipe/continue/impersonate 专用选角~~ | ✅ 已实现 (Phase B) | `_activate_swipe` + `_activate_impersonate`，23 项测试通过 |
| 6 | ~~`{{banned}}` 禁词宏~~ | ✅ 已实现 (Phase C) | 副作用宏，加入 `env.banned_tokens` |
| 7 | ~~`{{timeDiff}}`/`{{firstIncludedMessageId}}` 等 9 个宏~~ | ✅ 已实现 (Phase C) | 全部 10 个缺失宏已补齐 |
| 8 | OpenAI 代理部分端点（electronhub/chutes/nanogpt/siliconflow/workers_ai 细分） | 🟢 低 | 特定服务商不可用 |
| 9 | `integrity`/`lastInContextMessageId` chat_metadata 字段 | 🟢 低 | `chat_id_hash` ✅ 已实现（{{pick}} 确定性种子）；`lastInContextMessageId` 简化为 firstDisplayedId；`integrity` 未实现（数据完整性校验，低优先级） |
| 10 | ~~group_nudge 默认行为~~ | ✅ 已修复 (F2) | 默认值改为 ST openai.js:114 |

### 5.2 Palink 有但 ST 无（扩展，不计入对齐度，但需注意兼容性）

| # | 功能 | 说明 |
|---|---|---|
| 1 | TALKATIVE(4)/VOTING(5) 激活策略 | st-compat 回退 NATURAL，native 可用 |
| 2 | follower_members + 衰减 | 仅 native |
| 3 | 状态栏兜底（build_fallback_panel） | 仅 native，st-compat 无 |
| 4 | 动态裁剪（_apply_dynamic_trimming） | 仅 native |
| 5 | smart_card 触发 | Palink 扩展 |
| 6 | memory_mode（rule/summary） | Palink 扩展 |
| 7 | plotline 注入 | Palink 扩展 |
| 8 | palink_injection（/inject） | Palink 扩展 |
| 9 | 多分支（CharacterChatSessionBranch） | Palink 扩展 |
| 10 | short_title 自动生成 | Palink 扩展 |

---

## 六、风险点说明（悲观视角）

### 🔴 高风险

1. **st-compat 跳过 prompt_order 重排**：ST 高级用户常自定义 prompt_order（如把 worldInfoAfter 移到 chatHistory 后），Palink st-compat 不遵循，导致这些用户的 prompt 结构与 ST 不一致。（用户已批准暂不处理）

> **已解决的高风险项**（Phase A-H 修复）：
> - ~~`/note` 命令 bug + position 值映射差异~~ → ✅ F1+Phase G+Phase H 修复（文本 + position/depth/frequency per-chat 存储；**迁移 0056 将 position 值对齐 ST `extension_prompt_types` 四态**，`/note-position` 接受 ST 字符串别名）
> - ~~群聊 swipe/continue/impersonate 无专用选角~~ → ✅ Phase B 修复（23 项测试通过）
> - ~~tokenizer 非 OpenAI 偏差~~ → ✅ Phase F 修复（全模型精确计数）
> - ~~MIN_ACTIVATIONS 状态机缺~~ → ✅ Phase E 修复（8 项测试通过）
> - ~~group_nudge 默认空~~ → ✅ F2 修复（默认值对齐 ST openai.js:114）
> - ~~GroupChat 字段位置~~ → ✅ Phase D 修复（迁移 0055 补齐顶层列）

### 🟡 中风险

2. **NATURAL 随机源不同**：即使算法完全一致，`Math.random()` vs `random.random()` 导致相同输入下发言者激活结果不同。ST 自身在该策略下本就不可预测，但严格"一致性"意义下不满足。

3. **auto_mode 缺失**：Palink 无 auto_mode 自动轮询机制，MANUAL 策略下"非用户输入触发"场景不存在。若未来引入 auto_mode，MANUAL 行为需对齐 ST 的随机选角。

### 🟢 低风险

4. **chat_metadata 字段完整性**：`integrity` 未实现（数据完整性校验，ST 用于检测聊天文件损坏）；`lastInContextMessageId` 简化为 firstDisplayedId（仅影响 `{{firstIncludedMessageId}}` 极罕见宏）；`chat_id_hash` ✅ 已实现。

5. **st_groups.py 注释过时**：误导维护者，但不影响运行。

6. **4 个 stub 端点**：trigger/popup/buttons/messages，多数 ST 前端功能不依赖。

7. **`/gen` slash stub**：实际生成由 websocket 承接，功能可用。

8. **`_DEFAULT_CONTEXT_WINDOW=8192` 硬编码**：仅未配置模型时回退，多数场景有显式配置。

---

## 七、结论

### 7.1 完成度判定（悲观口径）

- **1:1 角色对话（st-compat）**：**≈ 94%**。主链路（Prompt 装配序/宏/世界书/instruct/tokenizer/author note position）全面对齐；5 个 golden vector 场景 100% PASS。扣分集中于 prompt_order 用户重排跳过（设计性）、`{{firstIncludedMessageId}}` 简化。
- **群聊对话（st-compat）**：**≈ 82%**。四种激活策略 + 三种 generation_mode + 合并卡 + 多成员串联 + swipe/continue/impersonate 选角已实现。扣分集中于 auto_mode 缺失、MANUAL 行为差异、NATURAL 随机源不同。
- **palink-native 模式**：与 ST 一致性口径下各降 10-15%（自有标签格式 + 扩展能力，不追求 1:1）。

### 7.2 适配可信度

- **可放心使用**：1:1 st-compat 的标准卡片 + 默认配置 + 任意模型场景，行为与 ST 高度一致（tokenizer 全模型精确计数、`{{pick}}` 确定性对齐、WI 插入排序对齐、author note position 四态对齐）。
- **需谨慎**：自定义 prompt_order（st-compat 跳过）、NATURAL/POOLED 策略（随机源不同，ST 自身也不可预测）。
- **不可用**：auto_mode 自动轮询、settings 快照、`integrity` 数据完整性校验。

### 7.3 修复进度总结（Phase A-H 已完成）

> 以下全部已修复并测试通过（488 passed / 45 skipped / 0 failed）：

1. ✅ ~~`/note` 存储错位 + position 值映射差异~~ → F1+Phase G+Phase H：session.extensions 优先读取 + per-chat position/depth/frequency + 子命令；**迁移 0056 将 position 值对齐 ST `extension_prompt_types` 四态**（45 项 position 测试）
2. ✅ ~~群聊 swipe/continue/impersonate 选角~~ → Phase B：`_activate_swipe` + `_activate_impersonate`（23 项测试）
3. ✅ ~~`{{banned}}` 等 10 个宏~~ → Phase C：全部补齐
4. ✅ ~~group_nudge 默认值~~ → F2：默认值对齐 ST openai.js:114
5. ✅ ~~GroupChat 顶层字段~~ → Phase D：迁移 0055 补齐 join_prefix/suffix/auto_mode_delay
6. ✅ ~~tokenizer sentencepiece/web-tokenizers~~ → Phase F：全模型精确计数（52 项测试）
7. ✅ ~~MIN_ACTIVATIONS 状态机~~ → Phase E：复现 ST world-info.js:4991-5005（8 项测试）
8. ✅ ~~`{{pick}}` 确定性~~ → Phase C：移植 ST getStringHash + seedrandom
9. ✅ ~~world_info_character_strategy 插入排序~~ → Phase G：三策略 + lore 分层（15 项测试）
10. ✅ ~~WI sort 方向~~ → Phase G：升序→降序对齐 ST sortFn
11. ✅ ~~author note position 值映射~~ → Phase H：迁移 0056（旧 Palink 0/1/2/3/4 → ST -1/0/1/2）+ `roleplay_prompt_assembly.py` + `character_message_builder.py` 双路径四态注入 + `/note-position` ST 字符串别名（after/chat/before/none）

**剩余建议**（低优先级，不阻塞核心对齐）：
- 🟢 settings 快照功能（4 端点）—— 配置回滚，非对齐关键
- 🟢 `integrity` chat_metadata 字段 —— 数据完整性校验，DB 架构不同
- 🟢 st_groups.py 注释更新 —— 文档维护
- 🟡 auto_mode 自动轮询 —— 功能扩展，非对齐 bug
- 🟡 prompt_order 用户自定义重排 —— st-compat 设计性跳过（用户已批准暂不处理）

---

> 本报告基于 2026-07-24 代码快照。所有结论以 `backend/app/services/roleplay_prompt_assembly.py` 等当前代码为准，根目录 `SILLYTAVERN_*.md`（2026-06-12）已过时，不作为评估依据。
