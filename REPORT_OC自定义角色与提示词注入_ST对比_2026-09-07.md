# 自定义角色(OC)可用性 & 提示词注入 · 与"酒馆"(SillyTavern)对比报告

> 调研日期：2026-09-07
> 调研对象：Palink-AI（palink-native 模式，后端 Python 原生装配）
> 对比基准：`community-st-forks/zhaiiker-SillyTavernMOD`（= 官方 **SillyTavern 1.18.0** + STC-MOD 运营外挂，低侵入，角色卡/提示词核心与官方一致；本机已 clone，无需另下源码）
> ⚠️ 注意：旧的 `PALINK_VS_SILLYTAVERN_COMPARISON.md`（2026-08-20）写于 st-compat 双轨时代，其引用的 `SillyTavern-1.18.0/` 目录已随 ST 双轨删除（2026-09-03）而消失，本文以 zhaiiker MOD 为唯一权威 ST 基准并覆盖 OC 主题。

---

## 0. 结论速览（先读这三句）

1. **OC 要分清两个入口，它们是两套东西：**
   - **设置 → 账号 → 「原创角色(OC)」**（`OCSettings.tsx`）：**不是**对话角色体系。它只把 `OC.name` 当作你在对话中的昵称（`user_nickname` → `{{user}}` 宏替换），**其余字段（人物特点/性格/爱好/背景/自定义字段）除了"AI 分析"工具外没有任何地方消费**，也不会生成角色列表里的角色。→ **你想让它"作为对话角色(对方)"：目前不能。**
   - **角色页 → 「创建角色/编辑角色」**（`CharacterEditor.tsx`）：这才是与 ST 角色卡等价的自建角色入口，**字段完整、真实入库、可正常作为对话角色使用**，全链路无 ST 双轨删除残留，且支持导入标准角色卡 PNG/JSON。
2. **提示词注入：有，而且是一整套。** Palink 后端装配器把 角色设定总纲/性格/背景/场景/描述/预设/作者注/人设/插件提示/世界书(关键词触发,8 位置)/depth 深度注入/MVU 变量指令 全部注入发给 LLM 的 messages，末尾再做 ST 1.18.0 全量宏求值。代码注释大量明示 "ST 1.18.0 对齐"。
3. **和酒馆一致吗？** 机制**同构**（逐项移植 ST 语义），非"自成一派"；差异在执行架构（ST 前端 JS 组装 + 后端仅存取；Palink 后端 Python 全量装配），以及少量字段语义取舍。详见 §3 映射表。

---

## 1. 两套"角色"体系辨析（回答"OC 选项还能不能作为角色"）

### 1.1 设置页「原创角色(OC)」—— 只是"你的昵称名片"+AI 分析工具

- 入口：`SettingsView.tsx:153` `{ id: 'oc', label: '原创角色(OC)', icon: User }` → `frontend/src/components/ui/custom/OCSettings.tsx`
- 存储：**纯 localStorage**（`OC_STORAGE_KEY='palink_oc_data'`，`OCSettings.tsx:25/119`），**不落后端、不调 /api/characters**。
- 字段：`name / traits(人物特点) / personality(性格) / hobbies(爱好) / background(背景) / customFields(自定义字段) / avatar`（`types/index.ts:505-516`）。
- **全仓唯一消费方**：
  - `CharacterView.tsx:127-132 getDisplayName()`：`OC.name` 优先 → 作为 `user_nickname`；
  - `CharacterView.tsx:1308`（开场 `__INIT__`）、`hooks/useCharacterChat.ts:741/951/1283`（regenerate/continue/普通消息）都把 `user_nickname: getDisplayName(...)` 放进请求；
  - 后端 `character_ext.py:4313/5119` `user_nickname = req.user_nickname or user.username` → 最终由 `_replace_placeholders`（`character_ext.py:761`）替换 **`{{user}}`** 宏。
  - `OCSettings.tsx:149-233` "AI 深度分析"把 OC 设定当 prompt 发给 `/api/chat` 求点评——**仅此而已**。
- **结论：OC 的 name 会贯穿所有对话请求并真实影响提示词里的"你"（{{user}}）称呼；但 traits/personality/hobbies/background/customFields 既不注入提示词、也不创建对话角色。它是一个"半成品"入口：UI 语义（原创角色档案）与实际作用（昵称 + 分析草稿）不符。**
- 若你的预期是"OC 里的设定要像 ST 角色卡那样驱动扮演"→ 当前**不生效**（只有名字生效）。

### 1.2 角色页「创建角色 / 编辑角色」—— 真正等价 ST 角色卡的自建入口（可用 ✅）

- 组件：`CharacterView.tsx`（列表/编辑/会话） + `components/views/character/CharacterEditor.tsx`
- 字段区（`CharacterEditor.tsx`）：头像、角色名称、创建者、标签、`user_nickname`(对你的称呼)、`description`(角色描述)、`personality`(性格特点)、`scenario`(场景)、`background`(背景故事)、`first_mes`(第一条消息)、`alternate_greetings`(备选开场白,可增删)、`system_prompt`(系统提示)、`post_history_instructions`(历史消息后指令)、`mes_example`(对话示例,`<START>` 拆分)、`creator_notes`(作者备注)。
- 保存：`CharacterView.tsx:806-828` 整卡 `POST/PUT /api/characters[/{id}]`，**表单字段全部序列化**；头像以 dataURL 一并入库。
- 后端模型：`backend/app/models/character.py:10-53`（含 jailbreak/alternate_greetings/preset_data/talkativeness/extensions 等）；世界书走独立 WorldBook 关联。
- 导入/导出：`backend/app/api/character_ext.py:2169`、`backend/app/services/character_card.py` 支持 PNG(`chara_card` tEXt 块)/JSON，v2/v3 字段逐项映射（`:342-365`）。
- 选入聊天：角色列表 → 会话（`/api/characters/{id}/sessions`），主聊天组件 `CharacterChat.tsx`（1:1）调 `/api/character-chat`。**grep 验证无任何 `/api/st*`、`SillyTavernIframe`、st-native 残留引用阻塞**（删除施工未误伤）。
- 后端装配消费（每个字段真实进提示词，见 §2）：description/personality/background/scenario → 角色属性块；system_prompt → 角色总纲 override；first_mes/alternate_greetings → 会话开场 assistant 消息；mes_example → [Example Chat] 块；post_history_instructions → 历史后 system 块；creator_notes → 元数据（不进提示，ST 同语义）。

### 1.3 顺带发现的两处"摆设"（未接线 UI）

| 位置 | 状态 | 证据 |
|---|---|---|
| `CharacterUIEditor.tsx`（角色专属外观：主题/背景/气泡/特效 4 Tab） | **孤儿组件，从未挂载**；`Character.ui_config` 无任何表单入口写入 | 全仓仅自身引用；`CharacterUIProvider.tsx:20` 会读但无人写 |
| 设置页 `OCSettings` 详细设定字段（性格/背景等） | 仅 AI 分析消费，不注入、不成卡 | 见 §1.1 |

---

## 2. 提示词注入：有，且是整套 ST 语义移植（附证据）

主装配：`backend/app/services/roleplay_prompt_assembly.py` `assemble_roleplay_prompt`(:2725)→`_assemble_roleplay_prompt_impl`(:2742)；消息构建：`backend/app/services/character_message_builder.py:80`。

### 2.1 发给 LLM 的 messages 最终顺序（`character_message_builder.py:116`）

```
system: 角色系统提示(base_system_prompt, 含下列注入)
system: [Example Chat]…（mes_example 按 <START> 拆分, :149-160）
… 聊天历史 …（含 smart-card 选中上下文, :218）
system: post_history_instructions 历史后指令 (:236-238)   ← ST jailbreak 槽等价物
system: 动态上下文（worldbook 0-3 / 记忆 / 群聊plotline / 角色校准 personality :255-260）
user:   当前用户消息
(system: 最终提醒/继续提示)
```

### 2.2 系统提示内部注入块（`core/default_prompts.py:328` 组装）

```
[角色 system_prompt 总纲 override]  ← char.system_prompt（prefer_character_prompt=true 默认, character_ext.py:2063-2071）
[核心规则层]                          ← 模板, 含 {{char}}/{{user}} 占位
[角色属性层] personality/background/scenario/description 按序拼接 (:272-279)
[输出格式层] 对话视角/禁止XML/【MVU 例外】 (:299-328)
```
- 空属性兜底"（没有提供额外角色卡字段）"（:283）；`creator_notes` A7 起不再拼入（:280-281，ST 对齐）。

### 2.3 按需/分位置注入队列（全部并入上面 messages，或按 depth 插入历史）

| 注入体 | 触发方式 | 位置 | 关键代码 |
|---|---|---|---|
| 角色 system_prompt | 恒定(可用 power_user.prefer_character_prompt 关闭) | 系统提示最前 | character_ext.py:2063-2071 |
| 预设提示词 preset_data | 角色带 ST preset 时 | 追加到系统提示末尾 | `_inject_preset_into_prompt` character_ext.py:2093 |
| 群成员 profile | 群聊 | 系统提示 | roleplay_prompt_assembly.py:2816-2818 |
| author_note 作者注 | frequency 每 N 条(默认0=每次)；per-chat 可覆盖 | BEFORE_PROMPT / IN_PROMPT(append 到 system 尾) / IN_CHAT(depth 插入) | :2920-2989 |
| persona 人设描述 | position 0/1/2 | 系统提示/历史 | :3048 区 |
| 插件 extension_prompts | 恒定 或 scan 宏替换 | BEFORE_PROMPT prepend / IN_PROMPT append / IN_CHAT depth | :3467/:3572 |
| worldbook 世界书 | **关键词扫描最近聊天激活**（min_activations/recursive/delay 状态机） | 8 位置：0-3 dynamic / 4 atDepth / 5 EMTop / 6 EMBottom / 7 outlet(宏) | `_append_worldbook_context`:3934、`build_worldbook_context`:4114 |
| 角色 extensions.depth_prompt | 恒定 | 按 depth 插入历史 | `_insert_depth_prompt`:4661 |
| MVU 变量更新指令 | 仅 MVU 智能卡 | 贴最后一条 user 消息末尾 | :3617-3658 |
| 最终宏求值 | 全量 | 所有文本块 | `evaluate_macros_in_messages`:3800-3801 |

### 2.4 宏替换（`{{char}}/{{user}}/{{random}}/…`）

- 中途占位替换：`character_ext.py:761 _replace_placeholders`（{{user}}/{{char}} 及中文变体，剥离不支持宏）。
- 最终全量宏引擎：`MacroEnv`（`services/macro_service.py:181`，构建于 :3769）覆盖 ST 1.18.0 宏集：`{{char}}/{{user}}/{{description}}/{{personality}}/{{scenario}}/{{first_mes}}/{{mesExamples}}/{{persona}}/{{random}}/{{pick}}/{{time}}/{{date}}/{{datetime}}/{{chat_id_hash}}/{{lastMessageId}}` 等（macro_service.py:350-377/710-712/1054-1069）。
- 世界书 EMTop/EMBottom/outlet 条目经宏 `{{mesExamples}}`/`{{outlet::name}}` 注入（:3934-3962）。
- 求值失败保留原样，不崩溃。

---

## 3. 与"酒馆"(SillyTavern) 一致性对比 —— 基准 zhaiiker-SillyTavernMOD(=ST 1.18.0 官方核心)

### 3.1 角色卡字段映射（1:1 对齐）

| Character Card Spec v2 字段 | ST 用途 | Palink Character 字段/用途 | 一致? |
|---|---|---|---|
| description | → system 块 `charDescription` | description → 角色属性层"角色描述" | ✅ |
| personality | → `charPersonality` | personality → 属性层"性格" + 动态段【角色校准】 | ✅ |
| scenario | → `scenario` | scenario → 属性层"场景" | ✅ |
| first_mes / alternate_greetings[] | 开场 assistant 消息 | first_mes/alternate_greetings 同语义 | ✅ |
| mes_example | → [Example Chat] system 块 | 同（`<START>` 拆块, `_ST_DEFAULT_NEW_EXAMPLE_CHAT_PROMPT`） | ✅ |
| system_prompt | 角色 main 槽 override（prefer_character_prompt） | 系统提示最前总纲 override | ✅ |
| post_history_instructions | 历史后 system 块(角色级 jailbreak) | 历史后 system 块 | ✅ |
| creator_notes | 元数据,不进提示 | 元数据,不进提示(A7 对齐) | ✅ |
| character_book(内嵌世界书) / 独立 worldbook | 关键词激活注入 | WorldBook 关联,关键词激活 | ✅ |
| extensions.talkativeness | 群聊选角权重 | Character.talkativeness | ✅ |
| extensions.depth_prompt | @Depth 按 depth 注入 | _insert_depth_prompt | ✅ |
| extensions.regex_scripts | 前端正则引擎 | 前端插件沙箱 regex 引擎(同源) | ✅ |
| extensions.jailbreak | 导入→jailbreak | 导入→Character.jailbreak,与 PHI 同文时去重(:304) | ✅(合并语义) |

### 3.2 提示词块顺序对照（默认值）

| ST 1.18.0（`PromptManager.js:2087` promptManagerDefaultPromptOrder） | Palink 默认等效 |
|---|---|
| 1 main 主提示词（含系统全局） | base 角色系统提示（三层模板或自定义总纲） |
| 2 worldInfoBefore | 动态上下文(部分) |
| 3 personaDescription | persona(position 0) |
| 4 charDescription | 属性层·描述 |
| 5 charPersonality | 属性层·性格 |
| 6 scenario | 属性层·场景 |
| (enhanceDefinitions 默认关) | — |
| 7 nsfw | —(并入模板) |
| 8 worldInfoAfter | 动态上下文(部分) |
| 9 dialogueExamples | [Example Chat] 块 |
| 10 chatHistory | 聊天历史 |
| 11 jailbreak | post_history_instructions system 块 |
| — | Palink 特有：MVU 变量 user-tail、世界书 8 position、author_note 3 位置、深度注入队列 |

> Palink 另有 `prompt_order` 全量重排（`_apply_full_prompt_order`:1085 / `_apply_prompt_order`:1271）与动态裁剪（`:1201 _apply_dynamic_trimming`）对齐 ST Prompt Manager 按 identifier 排序与预算削减。

### 3.3 世界书扫描（关键机制一致）

- ST：`world-info.js:892 getWorldInfoPrompt → checkWorldInfo → getScore(:428)` 主/次关键词 AND_ANY/AND_ALL 计分。
- Palink：`build_worldbook_context`(:4114) 同语义关键词匹配 + min_activations/recursive/delay 状态机（world-info.js 移植）；8 个 position 全部注入（EMTop/atDepth/outlet 等，:3934-3962 注释引 ST world-info.js:5093-5143）。

### 3.4 结构性差异（不是机制差异）

| 维度 | 酒馆 ST | Palink |
|---|---|---|
| 提示词执行端 | **浏览器前端 JS**（PromptManager/openai.js 组装后 POST 给模型后端） | **服务端 Python**（FastAPI 装配） |
| 角色卡存储 | PNG/JSON 文件（DATA_ROOT/characters） | DB 行（Character 模型）+ 导入导出卡 |
| OC/自定义角色 | "创建角色"+New Character（RossAscends-mods.js:199）即建卡 | 需用**角色页创建角色**；设置页"原创角色(OC)"≠ 角色卡（见 §1.1） |
| {{user}} 称呼来源 | persona name（用户人设） | user_nickname（OC.name → 角色卡 user_nickname → 账户用户名 三级回退） |
| creator_notes 等 | 纯元数据 | 同 |

---

## 4. 风险与建议

1. **（高）设置页 OC 误导**：用户填了完整 OC 设定会误以为已生效。建议二选一落地：
   - 若定位"用户侧人设(personal OC)"：把 OC 字段接到后端 persona 描述注入（后端已有 persona 注入位，`roleplay_prompt_assembly.py:3048` 区），让 性格/背景 真正进入提示词；
   - 若定位"原创对话角色"：加"一键生成/导入为角色卡"按钮（POST /api/characters + 字段映射），复用以角色页建卡路径。
   - 至少应把 UI 文案改为"对话中的昵称"，避免用户误填长篇设定。
2. **（中）OC.name 优先级最高**：`getDisplayName` 先取 OC.name 再取角色卡 `user_nickname`——若用户设置过 OC 名字，会覆盖每个角色各自的"对你的称呼"，可能不符预期。
3. **（中）孤儿 UI**：`CharacterUIEditor`（角色专属外观）未挂载，属废弃残留，建议从路由与代码中清理或接线。
4. **（低）旧文档过期**：`PALINK_VS_SILLYTAVERN_COMPARISON.md` 基于已删除的 `SillyTavern-1.18.0/` 目录与 st-compat 双轨，引用时注意甄别（其"Palink 多队列 vs ST 单管线"的架构描述仍大体成立）。
5. **（信息）"鱼粉的酒馆"**：本机 `community-st-forks/zhaiiker-SillyTavernMOD`（SillyTavern 1.18.0 + STC-MOD）是唯一 ST 源码。若"鱼粉的酒馆"指其他 fork/版本，请提供仓库地址，可补做差异核对（预计差异集中在运营/登录/扩展层，提示词核心与 1.18.0 一致）。

---

## 5. 证据索引（核心行号速查）

| 事实 | 位置 |
|---|---|
| OC 设置页入口/挂载 | SettingsView.tsx:153；OCSettings.tsx |
| OC 纯 localStorage 存储 | OCSettings.tsx:25/119-120 |
| OC.name → user_nickname | CharacterView.tsx:127-132；useCharacterChat.ts:741/951/1283 |
| 角色保存整卡序列化 | CharacterView.tsx:806-828 |
| Character 模型字段 | models/character.py:10-53 |
| 角色卡 PNG/JSON 导入映射 | services/character_card.py:289/342-365 |
| {{user}} 替换 | api/character_ext.py:761-788 |
| 系统提示三层模板 | core/default_prompts.py:232-329 |
| 角色 system_prompt override | api/character_ext.py:2058-2088 |
| 消息最终顺序 | services/character_message_builder.py:116-263 |
| author_note 注入 | services/roleplay_prompt_assembly.py:2831-2989 |
| worldbook 8 位置注入 | services/roleplay_prompt_assembly.py:3934-3962 |
| depth 深度注入 | services/roleplay_prompt_assembly.py:4661 |
| 宏环境与全量求值 | services/roleplay_prompt_assembly.py:3769-3801；services/macro_service.py:181 |
| ST 默认 prompt 顺序 | zhaiiker MOD public/scripts/PromptManager.js:2087-2136 |
| ST system 块组装 | zhaiiker MOD public/scripts/openai.js:1358-1425 |
| ST 世界书计分 | zhaiiker MOD public/scripts/world-info.js:892/428 |
| ST 宏注册 | zhaiiker MOD public/scripts/macros/definitions/env-macros.js:67-89 |
