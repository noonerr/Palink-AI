# Palink-AI 角色扮演 vs SillyTavern 对齐性审查报告

> 审查时间：2026-07-22
> 审查对象：当前后端代码（修改时间 7/20–7/22），参考基准 `SillyTavern-1.18.0`
> 方法：直接读取并交叉验证 `backend/app/` 源码 + 4 路并行代码分析子代理；**未采信**项目根目录下 6/12 的两份旧分析文档（已过时）

---

## 一、结论（先看这里）

| 问题 | 结论 | 置信度 |
|------|------|--------|
| **单人单角色对话是否已对齐 ST？** | **是，且高度对齐。** `st-compat` 模式对 ST 1.18.0 的 prompt 装配序、字段分离、instruct 包裹、names_behavior、作者注释、世界书前后注入、token 裁剪均为高保真重写；默认 `palink-native` 模式语义等价但用自有标签格式。存在少量已知差异（见 §3.6），**非 100% 逐字节一致，但核心流程已对齐**。 | ≥95% |
| **多人对话是否尚未开始开发？** | **否，多人（群聊）对话已经开发且接入生成链路，并非"尚未开始"。** 后端既有完整的群组数据/API 层（`st_groups.py`），也有原生的群聊生成编排（发言者选择策略、成员 profile 注入、群 nudge、历史预算），并经 `websocket.py` "D8 修复"接通。但它是一套**独立重写**，机制与 ST 的 `combineGroupIntoSingleCard` 不同，且仍有 TODO。 | ≥95% |

> 重要时效提示：根目录 `SILLYTAVERN_INTEGRATION_ANALYSIS.md` / `SILLYTAVERN_NATIVE_LAYER_PLAN.md`（均 6/12）声称"群聊仅有占位按钮、单人 85-90%"。**这些结论已过时**——后端在 7/20–7/22 大量改动了群聊相关代码，实际状态与旧文档不符。

---

## 二、单人单角色对话 vs ST 对齐分析

### 2.1 总体架构：纯 Python 原生实现，双模式

单人对话的 prompt 组装在 `backend/app/services/roleplay_prompt_assembly.py`（148KB）中**原生实现**，无任何对外部 ST 实例的 HTTP/subprocess 调用（1:1 主流程不经过 `silly_tavern.py` 的代理）。提供两套分支：

- `st-compat` 模式（`user_setting.silly_tavern_mode == "st-compat"`）：严格复现 ST 1.18.0 装配序。
- `palink-native` 模式（默认）：语义等价，但用 Palink 自有标签（`性格：`/`Scenario:`）。

主入口：`assemble_roleplay_prompt()`（`roleplay_prompt_assembly.py:1943`）→ 分支调用
`build_st_compat_messages()`（`character_message_builder.py:426`）或
`build_character_chat_messages()`（`character_message_builder.py:81`）。

### 2.2 消息处理流程（对齐 ST）

调用链（`websocket.py:1406` 触发）：
`assemble_roleplay_prompt` → `deps.build_system_prompt`（即 `character_ext.py:_build_char_system_prompt`）→
作者注释/Persona/扩展/世界书注入 → 分支 builder → `_insert_depth_prompt`（`:2661`）→
`evaluate_macros_in_messages`（`:2806`）→ 动态裁剪 `_apply_dynamic_trimming` / `_apply_st_compat_history_trim` →
`_apply_instruct_formatting`（`:2881`）→ 返回 messages。

### 2.3 角色卡解析（对齐 ST V2/V3 字段）

`st-compat` 模式按 ST `promptManagerDefaultPromptOrder` 将 `char.description` / `char.personality` / `char.scenario` 各作独立 system 消息（builder 内 Index 3–5），`personaDescription` 固定在 Index 2，`dialogueExamples` 在 Index 9——顺序与 ST 一致。字段来源即 ST V2 根级 / V3 `character.data.*`（`description/personality/scenario/first_mes/mes_example/system_prompt/post_history_instructions/alternate_greetings/creator_notes`），与 ST 字段映射一致。

### 2.4 上下文管理（对齐 ST）

- **Instruct 模式**：`_apply_instruct_formatting`（`:2881`）按 system/user/assistant 套 `prefix/suffix`，支持 `first/last_output_prefix`、`skip_examples`、四态 `names_behavior`、`system_same_as_user`——对齐 ST `formatInstructModeChat`。
- **names 行为**：`names_behavior` 四态（`:2597` 传入 builder，`:681` 注入 name 字段）对齐 ST `oai_settings.names_behavior`。
- **历史窗口 / token 预算**：`_compute_prompt_token_budget` = `context_window - max_tokens - reserve`；st-compat 保留强制项（jailbreak/作者注释/pos1/2/group nudge），history 占 0.7 预算，`pin_examples` 控制示例/历史竞争（`:947`、`:2840`）。
- **depth 注入**：`_insert_depth_prompt`（`:2661`）对齐 ST 的 depth prompt 机制。
- **示例对话 / 问候**：`mes_example` 在 st-compat 中解析 `<START>` 展开为多条加 `[Example Chat]` 标记（`skip_examples` 可关）；`alternate_greetings` 仅作首消息 swipes，不进 prompt（ST 同行为）。

### 2.5 变量 / 宏系统（高对齐，少量缺口）

`macro_service.py` 原生实现：`evaluate_macros`（`:579`）→ `_resolve_simple_macro`（`:204`）/ `_resolve_complex_macro`（`:372`，`::` 参数切分，兼容 ST `variables.js`）。

已实现：`{{user/char/input/time/date/datetime}}`、`{{lastmessage/lastusermessage/lastcharmessage/allchatrange}}`、`{{description/scenario/personality/mesexamples/firstmes/systemprompt/creatornotes/alternategreetings/persona}}`、变量族 `{{getvar/setvar/setglobalvar/addvar/incvar/decvar/delvar/exists}}`、文本/随机 `{{pick/random/roll/length/lower/upper/trim/substr/replace/reverse}}`、日期格式 `{{datetimeformat/time_utc±offset}}`、注释 `{{//...}}`、 outlet `{{outlet::name}}`。

**缺口（相对 ST `macros/`）**：
- 缺失 `{{depth}}`（消息深度宏，全文无）；
- `{{random:N-M}}` 区间语法未支持（仅 `{{random|a|b}}` 管道式；`{{roll:6}}` 支持，`:56/:476`）；
- 缺字符串/数学辅助宏（`{{cap/title/round/floor/ceil/abs/urlencode/pi/history}}` 等）。

### 2.6 世界书 / 正则 / 作者注释（高对齐）

- **世界书**（`worldbook_service.py`）：触发匹配（正则/全词/大小写）、`selectiveLogic` 四态、递归（`DEFAULT_MAX_RECURSION=5`）、预算（`budget_cap`/`ignoreBudget`）、时间效果（sticky/cooldown/delay/`@decorators`）均对齐 ST `world-info.js`。
  - **差异**：position 枚举编号偏移——Palink `WI_POS_AT_DEPTH=4 / EM_TOP=5 / EM_BOTTOM=6 / OUTLET=7`（`worldbook_service.py:65-68`），而 ST 为 `1=AT_DEPTH(in-story)`、`4=AFTER_PROMPT`。
- **正则脚本**（`api/regex_scripts.py`）：placement `0=MD_DISPLAY / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND / 5=WORLD_INFO / 6=REASONING`——缺 ST 的 `4=PROMPT` 显式枚举（已由 `promptOnly` 近似覆盖）。
- **作者注释（A/N）**：`roleplay_prompt_assembly.py:2003-2037` 实现 position 0/1/2/4 + depth + frequency，对齐 ST author's note。（注意：`expression_service.py` 实为"表情/情绪识别"，命名易误导，并非 A/N 系统。）

### 2.7 单人对话对齐度小结

**对齐点**：装配序、角色字段分离、instruct 序列包裹、`names_behavior`、depth 插入、token 裁剪保留强制项、作者注释 position、`skip_examples`、`{{user}}/{{char}}` 宏、世界书前后注入、jailbreak 合并优先级（角色卡 > 用户 > context_template）。
**差异点**：① 默认 `palink-native` 非 ST 字段顺序；② 缺 `{{depth}}`/`{{random:N-M}}`/数学辅助宏；③ 世界书 position 枚举编号偏移；④ 缺正则 `placement=4(prompt)`；⑤ ST `enhanceDefinitions`/`nsfw`（prompt_order Index 6-7）默认禁用；⑥ `continue`/`impersonate`/swipe 在推理层而非本模块。

---

## 三、多人（群聊）对话开发状态

### 3.1 数据 / API 层（`st_groups.py`，完整实现）

`backend/app/api/st_groups.py` 是**完整的 ST 兼容群聊 REST API**，非占位：
- 群组 CRUD：`/api/groups/get`、`/all`、`/create`、`/edit`、`/delete`；
- 成员管理：`/member-get`、`/member-add`、`/member-remove`；
- 群聊会话：`/api/chats/group/get`、`/save`、`/delete`、`/import`（JSONL 导入，调用 `convert_jsonl_to_group_chat`）；
- ST 格式转换：`_group_to_st` / `_group_to_st_format`（输出 ST `group-chats.js` 期望的对象：members/activation_strategy/generation_mode/disabled_members/allow_self_responses/chats）；
- 同步：创建/编辑时触发 `st_sync_service.trigger_async_sync` 写 ST DATA_ROOT。

### 3.2 原生生成编排（在 `roleplay_prompt_assembly.py`，已实现并接通）

当 `req.group_id` 非空时，`assemble_roleplay_prompt` 进入群聊分支：

1. **发言者选择策略** `_resolve_group_speaker`（`:1732`）：
   - `VOTING(5)`：LLM 模拟成员投票（`_build_voting_prompt` `:1564`，失败回退 TALKATIVE）；
   - `TALKATIVE(4)`：按 `talkativeness` 加权随机（`_select_talkative_member` `:1458`，对齐 ST `group-chats.js` talkativeness）；
   - `NATURAL(0)` 轮询、`LIST(1)`、`MANUAL(2)`（对齐 ST `group_activation_strategy`）。
2. **成员 profile 注入** `_build_group_profile_context`（`:1819`）：当前发言者 profile 作为角色身份注入 system prompt，其余成员 profile 摘要作为上下文。
3. **群级作者注释**（`:1992` 群级覆盖用户级）、**群历史预算** `recent_messages_budget`（`:2464`）、**群 nudge / new_group_chat_prompt**（`:2540-2608` 传入 builder）。

### 3.3 接入生成链路（已接通，非死代码）

`websocket.py:1185-1186` 显式注释 **"D8 修复: 群聊装配路径接通，解析 group_id / current_speaker_id"**，并在 `:1424` 将 `group_id=ws_group_id` 传入 `PromptAssemblyRequest` → `assemble_roleplay_prompt`。即用户在前端发起群聊生成时，会真实走通上述原生群聊编排。

### 3.4 与 ST 的机制差异（关键）

- ST 群聊：每个激活成员复用**完整单人 `Generate`**，APPEND 模式用 `combineGroupIntoSingleCard` 将多名成员卡合并为单一角色定义。
- Palink 群聊：选出一个 `current_speaker`，用**单人 builder**（`build_character_chat_messages` / `build_st_compat_messages`）构建该发言者 prompt，其余成员以 profile 摘要作为上下文注入。**这是一套独立重写，不是 ST 的逐字移植。**

### 3.5 已知 TODO / 兜底

- `roleplay_prompt_assembly.py:2609`：`group_members=None,  # TODO: 从群聊会话中获取成员名列表`——成员名列表尚未从会话拉取（已知缺口）。
- 透明代理兜底：`silly_tavern.py:4208` `st_native_proxy` 将未原生实现的端点转发到 `app_settings.ST_NATIVE_SERVICE_URL`（可配置的真实 ST 实例），因此群聊也可借代理走 ST 原生实现。

### 3.6 多人对话结论

**不是"尚未开始开发"。** 后端已具备：① 完整群组数据/API 层；② 原生群聊生成编排（发言者选择 4+ 策略、成员 profile 注入、群 nudge、历史预算），且经 websocket 接通。但它是**独立实现**，与 ST 的 `combineGroupIntoSingleCard` 机制不同，仍有 TODO（成员名列表）和代理兜底。

> 语义澄清：此处"多人对话"指 ST 式**多角色群聊**（1 人类用户 + 多 AI 角色），即本项目已实现的内容。未见"多人类用户同会话"的协同实现（属于另一种需求）。

---

## 四、关键证据索引

| 结论 | 证据 |
|------|------|
| 单人流程原生实现、双模式 | `roleplay_prompt_assembly.py:1943,2499,2561,2621`；`character_message_builder.py:81,426` |
| st-compat 高保真对齐 ST 装配序 | `roleplay_prompt_assembly.py:2561`（`build_st_compat_messages` 注入 worldInfoBefore/After、persona Index2、jailbreak 优先级 `:2517-2531`、names_behavior `:2597`、skip_examples `:2593`） |
| 变量/宏系统 | `macro_service.py:579,204,372,472,476`；缺 `{{depth}}`（全文件无） |
| 世界书 position 枚举偏移 | `worldbook_service.py:65-68`（`AT_DEPTH=4` vs ST `1`） |
| 正则 placement 缺 4 | `api/regex_scripts.py:802-807` |
| 群聊数据/API 完整 | `api/st_groups.py` 全文（CRUD/member/session/import/convert） |
| 群聊原生生成编排 | `roleplay_prompt_assembly.py:1732(_resolve_group_speaker),1819(_build_group_profile_context),1458,1564,2464,2609(TODO)` |
| 群聊接通生成链路 | `api/websocket.py:1185-1186,1406,1424`（`group_id=ws_group_id`） |
| 代理兜底 | `api/silly_tavern.py:4164(_build_proxy_target_url→ST_NATIVE_SERVICE_URL),4208(st_native_proxy)` |

---

## 五、最终判断

1. **单人单角色对话：已与 SillyTavern 1.18.0 对齐**（st-compat 模式高保真；palink-native 语义等价）。角色卡解析、上下文管理（prompt_order/instruct/depth/裁剪）、变量·世界书·正则·作者注释系统均已覆盖 ST 核心行为，仅有宏种类、世界书 position 编号、个别 prompt_order 项等少量差异——**可判定为"已对齐"，但非 100% 逐字节一致**。

2. **多人对话：并非"尚未开始开发"**。后端已有完整群组数据/API 层与原生群聊生成编排，并经 websocket 接通生产链路；它是一套独立重写（机制不同于 ST 的 `combineGroupIntoSingleCard`），仍带 TODO 与代理兜底。**旧文档"群聊仅占位按钮"的结论已过时。**
