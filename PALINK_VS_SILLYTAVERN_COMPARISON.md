# Palink-AI vs SillyTavern 1.18.0 角色扮演提示词对比报告

> 对比基准：`SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/`（ST）vs `backend/app/services/` + `frontend/src/lib/plugin-system/`（Palink）。
> Palink 分 `palink-native`（`build_character_chat_messages`）与 `st-compat`（`build_st_compat_messages`）两套，本报告以 palink-native 为主、标注 st-compat 差异。

## 0. 快速图版（装配流程一图流）

### 🟦 ST（SillyTavern 1.18.0）

```
┌─────────────────────────────┐
│  🧠 system 消息（依次拼接）        │
│  1️⃣ main 主提示词               │
│  2️⃣ 📖 worldInfoBefore 世界书前   │
│  3️⃣ 👤 personaDescription       │
│  4️⃣ 🎭 角色描述/性格/场景          │
│  5️⃣ ⬆️ 覆盖/控制提示词(impersonate)│
└─────────────────────────────┘
        ↓
┌─────────────────────────────┐
│  💬 聊天历史                    │
│   📌 按 depth 深度插入：          │
│   📌 AN / 插件提示词 / 世界书IN_CHAT│
└─────────────────────────────┘
        ↓
┌─────────────────────────────┐
│  🔞 nsfw + ⛓️ jailbreak        │
└─────────────────────────────┘
```

**⚙️ 核心机制**：所有动态内容（AN、插件、世界书）→ 统一塞进 `extension_prompts` 一条管线 → 按 depth/order 分层注入。

### 🟩 Palink

```
┌─────────────────────────────┐
│  🧠 system 消息（依次拼接）        │
│  1️⃣ base 角色提示词+世界观         │
│  2️⃣ 👥 群聊成员配置              │
│  3️⃣ 📌 AN(IN_PROMPT) / persona  │
│     / 插件注入 (追加或前置)        │
└─────────────────────────────┘
        ↓
┌─────────────────────────────┐
│  💬 聊天历史                    │
│   📌 按 depth 插入：             │
│   📌 AN(IN_CHAT) / persona(d=4)│
│   📌 世界书 depth 条目            │
└─────────────────────────────┘
        ↓
┌─────────────────────────────┐
│  📎 尾部追加：                    │
│   📌 世界书 ANTop/ANBottom      │
│   📌 EM 顶部/底部条目             │
│   📌 persona 最后消息             │
└─────────────────────────────┘
```

**⚙️ 核心机制**：多条并行队列（depth_entries / ext_depth_entries / AN parts / 世界书 8 位置）→ 构建消息时手动合并。

### 🔥 3 个关键差异

| | 🟦 ST | 🟩 Palink |
|---|---|---|
| 📦 注入管线 | **1 条统一管线** | **多条并行队列** |
| 🧠 system 顺序 | main→世界书→persona→角色 | base→群聊→AN/persona |
| ❌ 缺失 | — | 🔞nsfw ⛓️jailbreak 🎛️control 槽位 |

---

## 1. 提示词整体装配顺序

| 顺序 | ST `populateChatCompletion`（openai.js L1204-1338） | Palink `_assemble_roleplay_prompt_impl`（L2936+） |
|---|---|---|
| 1 | main（主提示词） | 对应主提示词（角色 prompt/世界观 prompt） |
| 2 | worldInfoBefore | worldbook before 段 |
| 3 | charDescription | 角色描述 |
| 4 | charPersonality | 角色性格 |
| 5 | scenario | 场景 |
| 6 | personaDescription | persona description（persona_show + 位置 0/1/2/3，L3184-3226） |
| 7 | overriddenPrompts | — |
| 8 | controlPrompts（impersonate → quietPrompt 最后） | — |
| 9 | systemPrompts（nsfw、jailbreak 注入到聊天后） | 对应 system_prompt 段 |
| 10 | userRelativePrompts（非 system 角色 + 非 ABSOLUTE） | — |
| 11 | absolutePrompts（ABSOLUTE 位置） | — |

ST 默认顺序还受 `promptManagerDefaultPromptOrder`（PromptManager.js L2087-2136）约束：main→worldInfoBefore→personaDescription→charDescription→charPersonality→scenario→enhanceDefinitions(disabled)→nsfw→worldInfoAfter→dialogueExamples→chatHistory→jailbreak。

**差异**：Palink 无 nsfw/jailbreak 内置提示词槽位、无 overriddenPrompts/controlPrompts 概念；这些在 Palink 由世界书/插件注入替代。

## 2. 扩展提示词注入（核心差异）

ST 三要素（Prompt 类 L127-133）：
- `injection_position`：enum（script.js L483）`NONE=-1 / IN_PROMPT=0 / IN_CHAT=1 / BEFORE_PROMPT=2`
- `injection_depth`：0..`MAX_INJECTION_DEPTH=10000`（L499）
- `injection_order`：默认 100

ST 注入算法 `populationInjectionPrompts`（openai.js L801-875）：
1. `maxDepth = getExtensionPromptMaxDepth()` → 10000（script.js L3222）
2. 按 `injection_depth` 分层循环；每层按 `injection_order ?? 100` 降序分组；组内按 role 优先级 system>user>assistant 排序
3. 合并扩展回调（getExtensionPrompt(IN_CHAT, depth, sep, roleType, wrap)）后整体 `reverse()`

Palink 对应：角色级 `prompt_depth`/注入位置字段 + 世界书 depth 条目（`depth_entries` 按 depth+role 分组 unshift，对齐 ST `WIDepthEntries`）。AN/persona 也映射到同一 depth 机制。

**st-compat 差异**：`skip_dynamic_context=True`，避免世界书与 ST 原生注入重复。

## 3. 世界书（World Info）

| 维度 | ST（world-info.js） | Palink（worldbook_service.py + 装配 L4386） |
|---|---|---|
| 扫描深度 | `MAX_SCAN_DEPTH=1000`（L98），递归 | `_recursive_scan`（L940），`enable_recursive or min_activations>0` 触发（L1502+） |
| 预算 | `budget = round(world_info_budget * maxContext/100) \|\| 1` + `world_info_budget_cap` | `_resolve_budget`（L1130）/`_apply_budget`（L1167）对齐 |
| 逻辑 | `world_info_logic`：AND_ANY/AND_ALL/NOT_ANY/NOT_ALL（L33），副键判定 L4837-4871 | `_apply_group_scoring`（L1262）+ 副键对齐 |
| 排序 | `getSortedEntries`（L4478）：chatLore 最先→personaLore→global+character 按 `world_info_insertion_strategy`（evenly/character_first/global_first，L4496-4510） | `_sort_by_insertion_strategy`（L1218），默认 `world_info_character_strategy=1`=character_first（ST 默认） |
| 定时效果 | `WorldInfoTimedEffects`（L479）：sticky/cooldown/delay，sticky 结束→立即 cooldown | `TimedEffectsManager.update_after_message()`（L1487） |
| 最小激活 | MIN_ACTIVATIONS 状态机（L4991-5005） | `min_activations`/`min_activations_depth_max`（Phase E，已对齐） |
| 注入位置 | 8 位置 switch（L5097-5143）：after/EMTop/EMBottom/ANTop/ANBottom/atDepth/outlet | 8 position 全对齐（装配 L4386）：st_wi_before/after/an_top(pos=2)/an_bottom(pos=3)/depth/em_top/em_bottom/outlet |

**差异**：ST `outlet` 需 `outletName` 匹配扩展注册的 outlet；Palink 用 `{{outlet::name}}` 宏（macro_service.py L529）从 `worldbook_outlets` 取回——机制等价但 Palink 的 outlet 数据源是后端 session 内传递而非前端注册表。

## 4. Author's Note

| 维度 | ST（authors-note.js） | Palink（roleplay_prompt_assembly.py） |
|---|---|---|
| 元数据 | `note_prompt/note_interval/note_depth/note_position/note_role`（L30-36） | 同名映射：chat_metadata → GroupChat → UserSetting 优先级（L3025-3102） |
| 频率 | interval 按**用户消息数**计数；interval=1 总是注入（L360-362） | frequency 取模门控 |
| 位置 | position 0=IN_PROMPT/1=IN_CHAT/2=BEFORE_PROMPT（通过 setExtensionPrompt 进入统一注入） | 1=IN_CHAT→depth_entries（含 an_top/an_bottom parts）；0=IN_PROMPT→追加 system_prompt；2=BEFORE_PROMPT→前置 system_prompt（L3157-3182） |
| 角色 note | chara_note_position：replace=0/before=1/after=2（L370-380） | 未实现（Palink 无角色级 AN） |
| 默认值 | position 默认 1(IN_CHAT)、depth 默认 4 | 相同；Migration 0056 已做旧值转换（0=depth/1=after/2=last/3=inactive/4=top） |

## 5. 宏系统

ST `evaluateMacros`（macros.js L610）：preEnvMacros（`<USER>/<BOT>/<CHAR>/<CHARIFNOTGROUP>/<GROUP>` + dice/instruct/variable）→ env 宏 → postEnvMacros（`{{maxPrompt}}/{{maxContext}}` 等）。

宏清单：core 17（space/newline/noop/trim/if/else/input/maxPrompt/maxContext/maxResponse/reverse/roll/random/pick/banned/outlet///）、env 20（user/char/group/persona/mesExamples/charDepthPrompt 等）、variable 14（setvar/getvar/incvar/decvar/addvar/hasvar/deletevar + global 变体）、chat 9、time 8、state 2、instruct 1。

Palink `evaluate_macros`（macro_service.py L776）4 步对齐 ST 1.18.0：
1. `raw_content` 捕获（对应 macros.js:616）
2. pre-macros：注释移除 + 遗留尖括号宏（L142/L147-152）
3. `{{random}}` 非确定性单次
4. `{{pick}}` 确定性单次：种子 `st_get_string_hash(chatIdHash + rawContentHash + offset)`，`st_pick_index(chat_id_hash, raw_content, m.start(), len)`
5. 迭代通用宏直至稳定（max_iterations=10）

**差异**：
- Palink **已实现** `{{banned}}`（L570）、`{{reverse}}`（L705）、`{{roll}}`（L673）——此前版本误列为缺失，已核对 `macro_service.py` 确认存在。仅剩 `{{time}}` 时区差异（见下条）
- Palink 多 `format_message_variable::stat_data`（JSON dump chat_metadata.variables.stat_data，2026-08-18 修复）
- Palink `{{time}}` 用 UTC `%H:%M`，ST 本地时区——**行为差异**，需注意
- ST 宏注册表支持插件 `registerMacro` 动态注册（script.js → macroSystem.registry）；Palink 通过 `context.registerMacro` 委托 MacroRegistry 等效

## 6. 斜杠命令

ST：`SlashCommandParser.addCommandObject`（slash-commands.js），命令注册结构含 aliases/help text/枚举参数类型（SlashCommandArgument/SlashCommandEnumValue）。

Palink：`SlashCommandRegistry`（slash_command_service.py L67）+ 注册表 L906-941，已实现 26 个：
- ST 对齐类：`/sys`、`/note`+`/note-position`+`/note-depth`+`/note-frequency`、`/name`、`/persona`、`/impersonate`、`/trigger`、`/wi`+`/world`
- 变量类：`/setvar` `/getvar` `/incvar` `/decvar` `/addvar`
- 生成类：`/send` `/gen` `/continue` `/retry` `/swipe` `/branch` `/model` `/help`

**差异**：ST 1.18.0 全量命令远超此（含 /data、/extract、/notepad、/qrc、/set 等数十个）；Palink 无 `arguments` 类型化解析（枚举/数字/可选 flag），无插件向注册表动态注入（registerSlashCommand 由前端 context 委托实现）。

## 7. 变量系统

ST（variables.js）：`getLocalVariable/setLocalVariable`（含 index 语法 + `convertValueType` + `as` 类型转换）、`getGlobalVariable/setGlobalVariable`、`add/increment/decrement`、`resolveVariable(name, scope)`、`{{getvar::}}` 宏、`registerVariableCommands`（L902 斜杠命令）。

Palink：macro_service.py 变量宏函数（L254-335）：chat/user/global 三域 × get/set/add/delete + `_STATUS_CURRENT_VAR_RE`。斜杠命令 `/setvar` 等已注册。

**差异**：Palink 无 `as` 类型转换宏语法、无 index 数组访问语法（`{{getvar::arr::1}}`）；ST 有 `{{getvar}}` 别名解析（getLocalVariable 失败回落 getGlobalVariable）。

## 8. 正则引擎

ST（extensions/regex/engine.js）：
- `regex_placement`（L281）：USER_INPUT=1/AI_OUTPUT=2/SLASH_COMMAND=3/4=sendAs(legacy)/WORLD_INFO=5/REASONING=6（MD_DISPLAY=0 废弃）
- `substitute_find_regex`：NONE=0/RAW=1/ESCAPED=2（L304 sanitizeRegexMacro）
- 脚本作用域：preset-scoped / per-char（allowScopedScripts L175）

Palink：前端插件沙箱内实现 regex 引擎（regex 属前端运行时），后端不参与。已实现 `{{/regex}}` 宏触发方式对齐（sandbox substituteParams）。**未逐项核对其 regex_placement 各位置钩子**（标记待续）。

## 9. 插件体系

| 维度 | ST | Palink |
|---|---|---|
| 注册 | `registerExtension`/`registerSlashCommand`/`registerMacro`/`setExtensionPrompt`（script.js L8866 / st-context.js getContext L114 / extensions-slashcommands.js L87） | 沙箱全局 `getContext/eventSource/registerMacro/setExtensionPrompt/substituteParams/registerMacroLike`（sandbox.ts L2715+）；`context.registerCommand/registerMacro/registerHook`（context.ts） |
| 沙箱 | 无（直接 JS） | U-IF iframe 沙箱 + Proxy window 白名单 + CDN 白名单（L1315：jsdelivr/unpkg/cdnjs/raw.githubusercontent/github） |
| getContext | 字段全量（tokenizers/streamingProcessor/SlashCommandParser 等） | 聚合 ST 兼容字段（L3042-3061），缺失 `streamingProcessor`/`tokenizers` 等运行时能力 |
| 事件 | eventSource + eventTypes 全量 | on/off/emit/once/removeAllListeners，wrapCallback 解包数组 payload，精确清理 |
| 生成拦截 | ST 无此概念 | `generate_interceptor` 桥接（sandbox.ts L1278-1289）——Palink 独有 |
| 扩展模板 | renderExtensionTemplate | 未发现对应物 |

**差异要点**：
- ST `setExtensionPrompt(key, value, position, depth, scan=false, role=SYSTEM, filter=null)`（script.js L8866）七参签名；Palink 沙箱 `setExtensionPrompt`（L3199）委托 `promptInjection.setExtensionPrompt`，参数是否完整对齐需运行时验证
- ST 插件无沙箱隔离；Palink 沙箱是安全边界，天然限制 DOM/网络访问——能力差异是有意设计

## 10. 缺失项清单（Palink 对比 ST 1.18.0）

1. **无 nsfw/jailbreak 系统提示词槽位**（ST 默认顺序第 9/12 位）
2. **无 overriddenPrompts/controlPrompts**（impersonate/quiet 注入）
3. **无角色级 AN（chara note）** 的 replace/before/after 三态
4. **宏缺失**：仅 `{{time}}` 本地时区支持（Palink 现用 UTC）；`{{banned}}`/`{{reverse}}`/`{{roll}}` 经核对均已实现（L570/705/673），此前误列
5. **`{{time}}` 时区差异**（UTC vs 本地）
6. **变量无 `as` 类型转换与 index 语法**
7. **斜杠命令集远小于 ST 全量**（无 /data /notepad /qrc /extract /set 等）
8. **无 ST vectors/记忆扩展链路**（Palink 侧 memory_module/ 未对比——待续）
9. **getContext 缺少 streamingProcessor/tokenizers/eventTypes 全量**
10. **无 regex 前端引擎与沙箱 runtime 的逐项钩子核对**（sillyTavernPluginRuntime.ts / st-plugins/ 待续）

## 11. 后续建议（优先级排序）

1. 仅补 `{{time}}` 本地时区（低成本高兼容）；`{{banned}}`/`{{reverse}}`/`{{roll}}` 已确认实现，无需补
2. 补 chara note 三态（数据模型已具备 chat_metadata）
3. **为 depth 队列补 ST 一致的顺序权重（对齐后与 ST 效果等价，对模型影响最直接）**：当前 `depth_entries`/`ext_depth_entries` 只按 depth 排序，无 ST 的 `injection_order`（默认 100，降序）/role（system>user>assistant）同级语义；同 depth 时 AN、persona、世界书、插件注入的先后取决于代码合并顺序而非明确规则。建议：depth 为主键，同 depth 按固定优先级排序（对齐 ST order 语义），消除顺序漂移与不可预测性
4. 核对 `setExtensionPrompt` 沙箱签名与 ST 七参一致性（运行时测试）
5. 补齐 memory_module/、worldbook_vector_service.py、前端 regex、st-plugins/、plugins.py 的对比（本次未覆盖）
6. st-compat 已封存（AGENTS.md），其 `skip_dynamic_context` 去重逻辑保持冻结即可