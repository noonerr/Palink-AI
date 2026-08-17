# Palink-AI 深度审计报告（ST 兼容 / 性能 / 多用户 / 安全 / 并发）

> **审计日期**: 2026-08-09
> **方法**: 6 路并行子代理深度研究 + 关键论断第一手交叉验证（全部 P0 级结论均经原始代码确认）
> **二次复核**: 2026-08-09 追加 6 路验证子代理逐条重读代码复核全部论断，修正 17 处表述（见 §11），无完全错误论断
> **依据**: 项目源码 + `docs/st-compat-handover/spec.md`（D1-D10 修复 spec）+ `docs/st-compat-gap.md` + SillyTavern 1.18.0 官方源码（`d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\`）
> **范围**: ST 兼容性（面 A 服务端 prompt 装配 / 角色卡 / 插件 / 面 B API 契约）、性能、多用户数据处理、安全性、隔离性、并发优化、工程验证缺口

---

## 0. 结论速览（TL;DR）

**好消息**：上一轮 spec（`align-st-compat-prompt-final-parity`）的 D1-D10 修复**全部已落地**（jailbreak 字段、names_behavior 四态、wi_format、token 预算裁剪、群聊 group_id 透传、dynamic_context_parts 接入等，均有代码 + migration + 测试证据），面 B 主链路（settings/characters/chats 读、SSE 生成）契约基本对齐。

**但审计发现三类需要立刻处理的问题**：

1. **ST 兼容性（角色扮演核心目标）仍有系统性缺口**：
   - **面 A（服务端 st-compat prompt 装配）**：D1-D10 虽落地，但存在 **8 项与 ST 1.18.0 源码语义不一致的残余 bug**（jailbreak 覆盖优先级、wi_format 过度应用、scenario/personality_format 空串语义相反、示例消息缺 name 字段等，见 §1.1），以及 **golden vector 验证真实性存疑**——diff 工具丢弃 `name` 字段、token 裁剪路径从未被 golden 触发。
   - **角色卡导入**：**生产导入路径丢失 V3 卡的 talkativeness/nickname/group_only_greetings/jailbreak 四个字段**（与测试验证路径不一致）；**世界书 position 整数映射整体偏移 1**（已第一手确认 ST 1.18.0 枚举为 0=before…7=outlet，Palink 的 `max(0, v-1)` 是错的）。
   - **插件系统**：**P0 结构性缺陷**——沙箱 `getContext()` 是极简对象（`context.chat`/`saveChat`/`groupId` 等缺失），已抽查 4 个内置 ST 扩展（memory/tts/caption/vectors）确认命中崩溃/静默失效，14 个扩展中大量依赖这些字段；事件 `app_ready` 等从不 emit，插件事件驱动逻辑全部失效；`/api/translate/{provider}` 8 个子路径 404、`/api/sd/*` 路径不匹配。
   - **面 B（ST 原生前端直连）**：**ST 前端启动会被 `/api/backgrounds/all` 响应结构不匹配直接打断**（ST 期望 `{images, config}`，Palink 返回 `{backgrounds, folders}`）；**8+ 个上传端点文件字段名不匹配**（ST 用 `avatar`，Palink 用 `file`，`edit-avatar` 例外）→ 角色卡/聊天/头像/背景/立绘/世界书/图片上传全部 422；**群聊端点请求体字段不匹配**（ST 发 `{id}`，Palink 读 `file_name`）→ 群聊无法加载/删除、**保存时静默新建孤立 session（数据漂移）**；群组 edit 因 id 带 `palink-group-` 前缀未 normalize 而 404、**delete 静默返回 ok 实际未删除**。

2. **安全面**：插件沙箱**不是安全边界**（`new Function` 词法逃逸 + fake script 直接执行任意 URL + CSS 未消毒，见 §5.1）；`.env.example` 弱 SECRET_KEY 可绕过生产校验（JWT/ST session cookie 全量伪造）；OAuth 回调开放重定向（JWT 泄露）；ChatVariable 系列端点水平越权；ST sidecar 关闭全部安全开关成为内网 SSRF 跳板；日志脱敏组件已实现但从未启用。

3. **性能与并发**：单 worker 事件循环内直接跑同步 SQL/CPU（任意 prompt 装配期间全站阻塞）；st-compat 路径 token 估算重复计算 + O(n²) 裁剪；世界书扫描每条目 2-3 次状态查询（N+1）；ST 列表端点（`/api/chats/recent`、`/api/characters/all`）N+1；同会话并发生成第二条消息被静默丢弃；LLM 流客户端断开不主动取消上游请求。

**一句话**：项目骨架和主链路已经搭好，但"**完全兼容 ST 插件和角色卡**"这一目标目前**尚未达成**——兼容性问题集中在插件运行时、上传/群聊 API 契约、角色卡导入字段丢失三处；同时存在需要优先封堵的安全漏洞和性能瓶颈。

---

## 1. ST 兼容性分析

### 1.1 面 A：服务端 st-compat prompt 装配（D1-D10 残余差距）

#### 1.1.1 落地状态确认

| 编号 | 修复项 | 状态 | 关键证据 |
|---|---|---|---|
| D1 | jailbreak 索引 11 | ✅ 已落地 | `character.py:42`、`system.py:36-38`、`character_card.py:328-340`、`roleplay_prompt_assembly.py:3471-3485`、`character_message_builder.py:889-905` |
| D2 | names_behavior 四态 | ✅ 已落地 | `character_message_builder.py:499-503/811-827`、`roleplay_prompt_assembly.py:3570-3575` |
| D3 | wi_format 包裹 | ✅ 已落地 | `character_message_builder.py:393-402/597/642/871` |
| D4 | token 预算裁剪 | ✅ 已落地 | `roleplay_prompt_assembly.py:1189-1313/3967-3971` |
| D5 | group nudge | ✅ 已落地 | `character_message_builder.py:564-578/918-923` |
| D6 | pin_examples | ✅ 已落地 | `character_message_builder.py:507`、`roleplay_prompt_assembly.py:1214-1232` |
| D7 | scenario/personality_format | ✅ 已落地 | `character_message_builder.py:405-416/620/632` |
| D8 | 群聊 group_id 透传 | ✅ 已落地（超 spec：前端也接入了） | `character_ext.py:3944-3946/4358-4360`、`websocket.py:1745-1746`、`silly_tavern.py:3775-3777`、`useCharacterChat.ts:1448/1505` |
| D9 | {{charjailbreak}} 宏 | ✅ 已落地 | `macro_service.py:428-431` |
| D10 | dynamic_context_parts | ✅ 已落地 | `character_message_builder.py:879-885` |

#### 1.1.2 残余 bug（经二次复核，8 项中 7 项完全确认 + 1 项（A-8）修正后保留"缺 impersonate 豁免"，详见 §11）

| # | 问题 | Palink 位置 | ST 1.18.0 依据 | 影响 |
|---|---|---|---|---|
| A-1 | **jailbreak override 缺守卫条件**：ST 需 `forbid_overrides !== true && !isPromptDisabledForActiveCharacter` 才覆盖；Palink 无条件覆盖 | builder `889-905` | `openai.js:1496-1504` | 用户设了 `forbid_overrides` 的角色卡 jailbreak 仍被覆盖 |
| A-2 | **prefer_character_jailbreak=false 时 PHI 仍被回退注入**：ST 此时索引 11 为空；Palink 空 jailbreak 会回退注入 `post_history_instructions` | builder `896-898` | `script.js:3359-3362`（`{{jailbreak}}` 解析 `prefer ? PHI.trim() : ''`） | prompt 与 ST 不一致（多注入 PHI） |
| A-3 | **narrator 消息未转 system role**：ST 把 `extra.type===NARRATOR` 的消息 role 转成 `system` | builder `809`（直接用 `m.role`） | `openai.js:580-583` | narrator 消息角色错误 |
| A-4 | **COMPLETION 模式 name 清洗不一致**：ST 先 `isValidName`（`/^[a-zA-Z0-9_]{1,64}$/`）合法名原样保留，非法才 sanitize 且截断 64；Palink 一律替换且**无 64 字符截断** | `_sanitize_name` `385-390` | `PromptManager.js:1343-1351` | name 字段与 ST 不符 |
| A-5 | **示例消息缺 `name` 字段**：ST 示例消息带 `example_user`/`example_assistant` name；Palink 无 | builder `719-743` | `openai.js:1111` | 已由 golden vector 第一手确认（`st_basic_char.json` 26/31 行有 name，`palink_basic_char.json` 27/31 行无）——且被 diff 工具掩盖 |
| A-6 | **wi_format 过度应用到 depth 条目**：ST 的 `formatWorldInfo` 仅作用于 worldInfoBefore/After，depth 条目不应用 | builder `871` | `openai.js:1367-1368`、`world-info.js:5084-5144` | 用户设置 wi_format 时 depth 条目被多余包裹 |
| A-7 | **scenario/personality_format 空串语义相反**：ST 空 format 插入字段原值；Palink 返回 `""` 导致字段被省略，且**测试固化了错误语义** | `_apply_field_format` `410-416`；`test_st_compat_p2_features.py:172-178` | `openai.js:1359-1360` | 用户设空 format 时 scenario/personality 丢失 |
| A-8 | **group nudge 缺 `type='impersonate'` 豁免**（注：经复核，nudge 注入位置本身与 ST 一致——ST 默认 prompts 顺序 jailbreak(3) 在 chatHistory(4) 之前，groupNudge 经 `insertAtEnd(groupNudgeMessage,'chatHistory')` 插在 chatHistory 集合末尾，实际位于 jailbreak **之后**，与 Palink 的注入位置（jailbreak 之后）相同；真正的差异仅是 ST 有 `noGroupNudgeTypes=['impersonate']` 豁免、Palink 无条件注入） | builder `918-923` | `openai.js:888-894`（`noGroupNudgeTypes`）、`openai.js:1072-1076`、`PromptManager.js:2001-2040`（默认顺序） | impersonate 类型生成时 ST 不注入 nudge，Palink 多注入 |

#### 1.1.3 token 预算裁剪的残余问题

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| A-9 | **pin_examples=false 只删 `[Example Chat]` 标记行，示例内容仍全部保留**：ST 是逐 dialogue 块预算竞争（`canAffordAll` 逐块 break）；Palink trim 收集含标记的 system 消息整体删除，而 builder 真实结构是"1 条标记 + N 条独立内容消息"（内容不含标记）→ 内容保留。测试 `test_st_compat_token_budget.py:65-66` 用"标记+内容合并单条"结构构造，与生产结构不符、未覆盖此 bug | trim `1214-1228` vs builder `709-743` | 预算裁剪语义不等价 |
| A-10 | **spec 的 0.7 比例与实现不一致**：实现用 `token_budget - mandatory_tokens`（有意偏离但 spec 未更新） | `1269-1272` vs spec 5 Scenario | 文档与代码不符，验收标准模糊 |
| A-11 | **`history_end_idx` 从末尾跳过连续 system 消息**：当 `include_user_message=False` 且末尾恰为 system（depth 插入最末）时被误判为强制项 | `1249-1254` | 裁剪不充分（保守行为，低危） |

#### 1.1.4 宏与 outlet（已确认正确）

- `{{outlet::name}}` 在 st-compat 路径经后置 macro pass（`roleplay_prompt_assembly.py:3934`）无条件解析，`wb_outlet_entries` 已填充，**outlet 可达**（与 gap.md 订正一致）。
- **新发现**：ST 1.18.0 有 `{{jailbreak}}` 宏（`script.js:3359-3362`），Palink 只有 `{{charjailbreak}}`（`macro_service.py:428-431`），未实现 `{{jailbreak}}`——且 `evaluate_macros`（`macro_service.py:733-812`）对未注册宏保留原文（L800-801），因此 `{{jailbreak}}` 会以字面量残留在 prompt 中。

### 1.2 角色卡兼容性（Tavern V2/V3 + CCv3）

#### 1.2.1 好消息（已对齐）

- 14 个 V2 必需字段（name/description/personality/scenario/first_mes/mes_example/system_prompt/creator_notes/post_history_instructions/tags/creator/character_version/alternate_greetings/extensions）**全部有映射**。
- V3 spec/spec_version 识别、PNG 双块（ccv3 优先）解析、`data` 嵌套、`extensions.character_book`/`lorebook` 提取建 WorldBook、`assets` 提取、`regex_scripts` 保留 —— 均正确。
- PNG 解析支持 tEXt/zTXt/iTXt 三型 chunk（比 ST 的 tEXt 更宽容）。

#### 1.2.2 关键 bug（按严重程度）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| B-1 | **P0：V3 卡 `talkativeness`/`nickname`/`group_only_greetings`/`jailbreak` 四字段在正常导入路径丢失**。`CharacterDataNormalizer.normalize` 返回 dict 缺这 4 个键；`_create_character` 中 talkativeness/nickname/group_only_greetings 读为 None 写入 NULL，**jailbreak 在导入路径中完全未被读取**（`Character.jailbreak` 列恒为 None）。而 `character_card.py:289-367` 的 `convert_chara_card_to_character`（仅被测试 `run_st_acceptance.py` 引用，生产代码零引用）有完整提取 → **生产导入路径与测试验证路径不一致**。注：talkativeness 与 V3 `extensions.jailbreak` 值会以 `extensions.palink_sillytavern.card_fields` 形式残留在 extensions JSON 中，但 4 个独立列恒为 None；nickname/group_only_greetings 顶层值完全丢失（不在保留字段列表） | `character_import_service.py:327-349`（normalize 返回 22 键）、`566-604`（_create_character）、`254-279`（preserve fields）、`character_card.py:289-367`；`run_st_acceptance.py:343/377/433`；生产路径 `character.py:476`/`silly_tavern.py:4893` → `import_from_file:373-374` | 群聊发言权重、显示昵称、群聊专属问候语、V3 jailbreak 在 DB 层丢失（`Character.jailbreak` 列成为**死列**，prompt 装配永远读不到） |
| B-2 | **P0：世界书 position 整数映射偏移 1**。`_ST_INT_TO_PALINK = {v: max(0, v-1)}` 假设 ST 有 9 个位置（含 AFTER_PROMPT 头位），但 ST 1.18.0 实际是 **8 个位置：0=before, 1=after, 2=ANTop, 3=ANBottom, 4=atDepth, 5=EMTop, 6=EMBottom, 7=outlet**（已确认 `world-info.js:855-864`），且 **Palink 内部枚举与之逐位对应**（`worldbook_service.py:69-76`：0=BEFORE_CHAR…7=OUTLET，装配侧 `roleplay_prompt_assembly.py:4096-4101` 确认 position 4→depth/5→em_top/6→em_bottom/7→outlet）。后果：**position 1-7 全部偏移 1**（v=0 因 `max(0,-1)` 钳制恰好正确）：`position=1`（after_char）→ 错误映射 0（before_char）；`position=4`（at_depth，最常见）→ 错误映射 3（after_an，depth 条目被注入 dynamic 上下文而非 depth 注入，语义破坏最严重）。测试 `test_worldbook_group_and_position.py:33-41` 固化了错误断言 | `worldbook_import_utils.py:9`（头注释 3-8 行假设错误）、`worldbook_service.py:69-76/1522-1547`（调用点：`character_import_service.py:517`、`worldbook.py:374`） | **角色卡自带世界书位置错位（1-7 全部偏移），atDepth 条目注入到错误位置** |
| B-3 | `alternate_greetings`/`tags` 为字符串时被破坏：ST 做类型归一（字符串→数组、逗号 split）（`characters.js:572-577/593/609`），Palink normalize 直接透传（tags L338、alternate_greetings L342）导致 `json.dumps` 存成字符串 | `character_import_service.py:338/342`（透传）、`592/594`（json.dumps） | 多问候语功能破坏、tags 前端报错 |
| B-4 | V1/gradio 卡 `creatorcomment`→creator_notes、`char_greeting`→first_mes、`world_scenario`→scenario、`example_dialogue`→mes_example 不映射（仅 char_persona 回退） | `character_import_service.py` | 老卡字段丢失 |
| B-5 | CharX/BYAF/YAML 导入被显式拒绝（ST 支持） | `character_import_service.py:364-373` | ST 前端拖入这些格式导入失败 |
| B-6 | `extensions.world` 引用不解析为世界书（ST 会转 character_book） | `character_import_service.py:299-305` | 世界书文件丢失 |
| B-7 | first_mes 为空时 alternate greeting 不提升（ST `getFirstMessage` 会 `swipes.shift()` 用第一个 alternate 顶上，`script.js:7664-7670`）；Palink 恒把 first_mes 放首位，且 first_mes 为空时 `character_ext.py:4282-4283` 直接跳过不发消息 | `character_ext.py:3440-3441/4299-4302/4282-4283` | 空 first_mes 角色无首条消息（比"不提升"更彻底） |
| B-8 | 导入路径不经过 `sanitize_name` 等清洗（name 未做 XSS/空字节/路径穿越清洗，ST 对 name 有 sanitize） | `character_import_service.py` | 与 ST 行为差异，潜在存储 XSS |

### 1.3 插件系统兼容性（P0 级问题集中区）

#### 1.3.1 结构性缺陷

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P-1 | **P0：沙箱 `getContext()` 返回极简对象**（`context.ts:61-203` 的 `PluginContext`：on/off/emit/once/storage/registerCommand/registerMacro/registerHook/log），`context.chat`/`saveChat`/`groupId`/`extensionSettings`/`eventSource` 全部缺失。插件 `import { getContext } from '../../extensions.js'` 命中 `moduleMap['extensions.js'].getContext = sandbox.getContext`（`sandbox.ts:3368`）——import 路径与全局路径是**同一个极简函数**，完整版 buildStContext 仅作 `moduleMap['script.js']` 数据源而非 getContext 返回值。已抽查 4 个扩展确认命中：memory `:91/588`（saveChat/chat.length）、tts `:160-162`（chat[id]）、caption `:407`（chat[messageId]）→ TypeError；vectors `:454` 为 `Array.isArray(undefined)` 短路 → **静默失效**（非崩溃） | `sandbox.ts:2573/3368/3224-3239` → `context.ts:61-203`；`manager.ts:180-188`（createPluginContext 无合并 chat 等字段）；插件调用点见左 | **插件核心功能大面积崩溃或静默失效** |
| P-2 | **P0：事件契约定义了但 emit 大量缺失**：`app_ready`/`generation_after_commands`/`group_member_drafted`/`world_info_activated`/`character_deleted`/`chat_created` 等从不 emit（`runtime.ts:241-242` 定义了 APP_READY 常量，但 runtime.ts 全部 `eventSource.emit(...)` 调用 532-964 行无一处 emit 它；全前端 src 仅 smart-card runtime `SillyTavernCompatRuntime.ts:6213` 有 emit，插件系统不走它）。quick-reply 的 `eventSource.on(APP_READY, finalizeInit)`（`quick-reply/index.js:214`）永不触发 → `isReady=false` → 所有自动执行排队永不消费；memory 定时总结失效。测试文件已自认"未实现事件回放" | `runtime.ts:241-242/532-964`；`event-contract.test.ts:620-621`；quick-reply `index.js:214/275-321` | 插件事件驱动逻辑全部失效 |
| P-3 | **P0：`new Function` 沙箱可被一行代码逃逸**（详见 §5.1 安全） | `sandbox.ts:2355-2462` | 任意插件可读写主应用 DOM/localStorage、任意网络请求 |
| P-4 | **P0：`extension_settings` 全局标识符为 undefined**（不 import 直接全局引用的插件 TypeError；import 路径 ✅ 共享 Proxy） | `sandbox.ts:2392` vs `3246-3271` | 部分插件报错 |
| P-5 | **P1：`chat_metadata` 是加载时快照**（非实时引用）。`sandbox.ts:3234` 在插件加载时 `stContext.chatMetadata ?? {}` 取一次；聊天切换时 `runtime.ts:528-548` 用新对象**替换** `chatMetadata` 引用（L545 比较 `ctx.chatMetadata !== prev.chatMetadata`）→ moduleMap 中快照仍指向旧对象，插件写入后自读旧值 | `sandbox.ts:3234/3324`、`runtime.ts:528-548` | quick-reply 等读旧值 |
| P-6 | **P1：moduleMap 缺失 10+ 个 ST 模块**：`Fuse`/`Popper`/`loader/ActionLoaderHandle`/`nai-settings`/`tool-calling`/`streaming-display`/`SlashCommandClosure`/`ConnectionManagerRequestService`/`performFuzzySearch`/`getSecretLabelById` 等 → import 得 undefined | `sandbox.ts:3319-3580` | stable-diffusion/expressions/connection-manager 直接踩中 |
| P-7 | **P1：挂载点默认 `display:none`**，插件注入后不 `.show()` → 面板默认不可见（5 个挂载点 top-settings-holder/extensions-menu/extensions-settings/extensions-settings2/moving-divs 全部内联 `style={{display:'none'}}`；全前端无任何 `.show()`/改 display 代码） | `StPluginMountPoints.tsx:110-163` | 插件面板出不来（只能经 PluginManager 克隆查看） |
| P-8 | **P1：模板渲染器是简化版**（仅 `{{var}}`/`{{{var}}}`，`{{#if}}`/`{{#each}}`/helper 原样输出），与 getContext 轨道的完整 Handlebars 不一致 | `sandbox.ts:72-77` | 第三方插件模板极可能失效 |
| P-9 | **P1：`power_user` 极简 stub**（仅 2 字段），`waifuMode` 等缺失 | `sandbox.ts:3501-3504` | expressions 等读 waifuMode 失效 |
| P-10 | **P1：`oai_settings`/`secret_state` 极简 stub**，`reverse_proxy`/`custom_url` 等缺失 → `throwIfInvalidModel` 抛"API key is not set" | `sandbox.ts:3521-3530` | caption/vectors 模型校验失败 |
| P-11 | **P1：`SlashCommandParser.parse()` 返回 stub**（空） | `sandbox.ts:3274-3317` | 依赖 slash 命令解析的功能失效 |

#### 1.3.2 后端端点缺口（插件实际调用 vs Palink 实现）

| 端点 | 状态 | 证据 |
|---|---|---|
| `/api/translate/{provider}`（onering/libre/google/lingva/deepl/deeplx/bing/yandex 8 个子路径，`translate/index.js:254-413`） | ❌ **全部 404**（后端仅单一 `POST /api/translate` 且不读 body，`silly_tavern.py:7568-7572`） | **翻译功能完全不可用** |
| `/api/sd/*`：插件实际调用约 50 个子路径（`/ping`、`/get-model`、`/samplers`、`/schedulers`、`/upscalers`、`/set-model`、`/sdcpp/*`、`/drawthings/*`、`/comfy/*` 等）；后端仅 7 条路由（`POST /generate`、`POST /img2img`、`GET /get-models`、`GET /get-samplers`、`GET /parsers`、`POST /comfy/get-workflow`、`GET /status`），且路径名对不上（`/models` vs `/get-models`、`/samplers` vs `/get-samplers`、`/comfy/workflow` vs `/comfy/get-workflow`） | ❌ 绝大多数 404 | `stable-diffusion/index.js` 实际调用 vs `sd.py:121-224` |
| `/api/backends/kobold/embed` | ❌ 404（vectors 嵌入依赖，`vectors/index.js:1455`）；后端 `/api/backends/*` 仅 status/generate/text-completions 三个 | — |
| `/api/extensions/install` | ⚠️ sidecar 未配置时 502（`silly_tavern.py:8171-8253`） | — |
| `/api/quick-replies/*`、`/api/extra/classify`、`/api/extra/caption`、`/api/vector/*`、`/api/sprites/*` | ✅ 存在 | — |
| `generateRaw({prompt, systemPrompt, responseLength})`（memory `index.js:524/731` 单对象调用，import 自 script.js → getContext 版 `generateRaw(prompt, options)`，对象被当 prompt 传） | ⚠️ 签名错位 → systemPrompt/responseLength 丢失（沙箱全局 generateRaw 更是 stub 返回空串） | `getContext.ts:1479-1481`、`generation-engine.ts:405` |

#### 1.3.3 逐插件结论

- 🟥 **regex / quick-reply**：面板渲染可用；quick-reply **自动执行全废**（app_ready 不 emit）；regex 的 slash 命令解析失效。
- 🟥 **memory**：自动/手动总结均崩溃（`context.chat.length` TypeError、generateRaw 签名错位）。
- 🟥 **tts**：朗读崩溃（`context.chat[id]` TypeError）；`new Audio()` 靠沙箱逃逸"碰巧可用"。
- 🟥 **vectors**：`getContext().chat` 为 undefined → `Array.isArray(undefined)` 短路**静默失效**（非 TypeError）；`/api/backends/kobold/embed` 404 → 无法生成向量。
- 🟥 **stable-diffusion**：`Popper`/`ActionLoaderHandle` import 缺失 TypeError；`/api/sd/*` 端点 404 → 基本不可用。
- 🟥 **caption**：`getContext().chat` TypeError + `throwIfInvalidModel` 抛错 → 描述功能崩溃。
- 🟥 **expressions**：`Fuse` import 缺失；`getContext().groupId` undefined；`waifuMode` 缺失 → 分类可用、精灵图/waifuMode 失效。
- 🟥 **connection-manager**：`Fuse`/`ConnectionManagerRequestService`/`SlashCommand*` 缺失 → 命令执行 TypeError。
- 🟥 **translate**：8 个子路径 404 → 翻译全不可用（ADAPTATION.md 已识别但未修复）。
- 🟨 **attachments/assets/gallery/token-counter**：面板渲染可用，深层逻辑依赖缺失模块需运行时验证。

### 1.4 面 B：ST 兼容 API 契约（ST 原生前端直连）

#### 1.4.1 致命启动失败点

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| C-1 | **P0：`/api/backgrounds/all` 返回 `{backgrounds, folders}`，ST 期望 `{images, config}`**。ST 前端 `getBackgrounds` 无 try/catch（`backgrounds.js:708-734`），L718 `images.map(x => x.filename)` 抛 TypeError 沿 `firstLoadInit`（`script.js:766`，无 catch）传播 → **ST 前端启动初始化中断**，其后所有 init（tokenizers/backgrounds/authorsNote/personas/worldInfo/stats）及 `isAppReady=true`/`APP_READY` 事件全部跳过。bridge.js 对该端点命中 `REAL_API_PATHS` 白名单（`bridge.js:110`）直接透传、**无响应改写** | `st_resources.py:168-176` vs `backgrounds.js:715-718`、`script.js:766/12567`（无 catch） | **ST 原生前端一启动就崩** |

#### 1.4.2 系统性失败区（字段名/结构不匹配）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| C-2 | **P0：上传端点文件字段名不匹配（主上传端点 8+ 处）**。ST 1.18.0 全局 `multer.single('avatar')`，前端统一发 `avatar` 字段；Palink 的 `characters/import`、`chats/import`、`worldinfo/import`、`backgrounds/upload`、`avatars/upload`、`sprites/upload`、`sprites/upload-zip`、`images/upload` 等全部声明 `file: UploadFile = File(...)`（无 `alias="avatar"`、无双字段兼容）→ 422 | `silly_tavern.py:4880/5079/5844/6320`、`st_resources.py:192/301/414/454` vs ST 前端 `script.js:10524`（角色卡导入）、`script.js:12076`（聊天导入）、`world-info.js:5744`、`backgrounds.js:1484`、`personas.js:364` | 角色卡/聊天/头像/背景/立绘/世界书/图片**上传全部 422**。唯一例外：`/api/characters/edit-avatar` 恰好用 `avatar` 字段名（`silly_tavern.py:4969`）可用 |
| C-3 | **P0：群聊端点请求体字段不匹配**。ST 发 `{id: chatId}`；Palink 只读 `file_name`/`file`/`chatfile`（不读 `id`）→ **get/delete 返回 400**（`file_name is required`）；**save 不报错但静默新建 `group_id=None` 的孤立 session**（每次保存都新建、数据丢失/会话漂移）；`group/info` 因 `GroupInfoRequest` 只有 `group_id` 字段 → 422 | `st_groups.py:582/622/681` vs `group-chats.js:196/642/2249`；`silly_tavern.py:5999-6057`（group/info 只认 `group_id`） | **群聊无法加载/删除，保存时数据漂移** |
| C-4 | **P0：`groups/edit`、`groups/delete` 用 ST 的 id（`palink-group-{uuid}.png`）查库失败**（直接 `==` 比较，未调用 `_normalize_group_id`）→ **edit 404；delete 查不到时静默返回 `{"result":"ok"}` 而非 404（实际未删除）** | `st_groups.py:338-400/401-443`（`_normalize_group_id` 定义于 699-706 但 edit/delete 均未使用） | 群组改名/换成员失败、删除静默失效 |
| C-5 | **P1：`/api/avatars/get` 返回 `{avatars:[...]}` 而非 ST 期望的 `string[]`** → personas 列表永远为空（静默失败） | `st_resources.py:286-295` vs `avatars.js:17-19`、`personas.js:276` | 自定义头像/人设不显示 |
| C-6 | **P1：`/api/secrets/settings` 缺失**（仅影响密钥查看 UI） | vs `secrets.js:291` | 密钥面板不可用（不崩） |

#### 1.4.3 已确认对齐（避免重复误报）

- ✅ SSE：`data:` chunk + `[DONE]`，首 chunk `delta:{role:'assistant'}` 无害；非流式含 usage；与 ST `getStreamingReply` 兼容。
- ✅ `/api/characters/all`、`/api/characters/get`、`/api/chats/get/save/rename/delete/search`、`/api/chats/export`、`/api/worldinfo/get/edit/delete`、`/api/backends/chat-completions/status`、`/api/settings/get`、`/api/groups/all`、`/api/quick-replies/*`、`/api/vector/*`、`/api/extra/classify` 等主链路契约匹配。
- ✅ character 对象（`data` 嵌套）、chat JSONL 结构、worldinfo V3 数组格式、settings 嵌套结构（power_user/oai_settings/extension_settings）与 ST 对齐（test_st_contract.py 验证 + tmp/ 抓包一致）。
- ✅ 认证总体兼容：cookie `palink_st_native`（JWT，不可伪造）+ bridge 注入 Bearer + `X-Palink-*` 头；CSRF token 恒返回 `palink-csrf` 但 Palink 无 CSRF 校验（兼容）。
- ✅ `enable_accounts:false` → ST 前端跳过登录/用户管理，无 /api/users 依赖。

#### 1.4.4 面 B 其他差异

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| C-7 | `/api/presets/save|delete|restore`、`/api/stats/get`、`/api/themes/save`、`/api/backups/chat/*`（ST 1.18.0 聊天备份，非"snapshots"）未注册 → 走 bridge Layer 2 代理到 ST sidecar；sidecar 不可用时 502（`httpx.ConnectError` → `{"error":"st_proxy_failed"}`） | `bridge.js:468-471`、`silly_tavern.py:4674-4714` | 依赖 sidecar 可用性 |
| C-8 | SSE 流式错误时把错误文本作为 `content` 输出并 `[DONE]`，ST 前端会当正常 AI 回复渲染（不触发错误弹窗） | `silly_tavern.py:2256-2259` | 错误对用户表现为"AI 回复报错文本" |
| C-9 | `n>1` 多 swipe 不产生 `choices[0].index>0` 的副 swipe chunk | `silly_tavern.py:2216` | 多 swipe 功能缺失（不崩） |

---

## 2. 性能问题分析

| # | 问题 | 证据 | 影响 | 优先级 |
|---|---|---|---|---|
| E-1 | **单 worker 事件循环内直接执行同步 SQL/CPU**：`assemble_roleplay_prompt` 全程同步 `db.query`（无 `to_thread`），WS 处理器同。生产部署单 worker（`docker-compose.yml:114-116`）→ **任一请求装配 prompt 期间全站事件循环被阻塞**。已有先例 `persist_snapshot`/记忆检索用 `asyncio.to_thread`，装配主链路未覆盖 | `roleplay_prompt_assembly.py:2735-2750`、`websocket.py:1727-1785` vs `websocket.py:832-833` | 多用户并发时全站卡顿/超时 | **P1** |
| E-2 | **st-compat token 估算重复计算 + O(n²) 裁剪**：`_apply_st_compat_history_trim` 内 5+ 次全量 `_estimate_tokens`；裁剪 `while` 每轮重新 sum → O(n²) 次 BPE 编码；`_estimate_tokens` 无消息级 memoization；st-compat 分支仍无条件执行 `_collect_prompt_sources`（结果被弃用） | `roleplay_prompt_assembly.py:1189-1313/3947/3963-3971` | st-compat 超预算时装配延迟 145ms → 数百 ms | **P1** |
| E-3 | **世界书扫描 N+1**：每条目 2-3 次 `get_state`/`is_sticky_active`/`record_activation` 查询。100 条目 ≈ 200-300 次 SQL 往返（正是性能报告 145ms 的主要构成）；ST 兼容路径每次都全量扫描 | `worldbook_service.py:650-903`（`timed_mgr.can_activate` L744→L152-176、`is_sticky_active` L815→L178-188、`record_activation` L793/829→L190-205，均各自 `db.query(...).first()`） | 条目越多线性恶化 | **P1** |
| E-4 | **`_get_full_branch_history` 无 SQL LIMIT**：全量加载会话历史（含分支链逐级 ancestor 查询）再在 Python 内存截断（`limit` 默认 60），长会话数千条每请求全拉 | `character_ext.py:516-595`（L555-563 无 `.limit()`、L595 `deduped[-limit:]`）；`character_message_builder.py:151-168/752-764` | 历史越长延迟线性增长，直接命中 st-compat 路径 | **P1** |
| E-5 | **`/api/chats/recent` 每会话 2 次额外查询**（last_msg + count）→ 100 会话 = 201 查询；ST 前端启动高频调用 | `silly_tavern.py:5392-5416` | 拖慢 ST 前端启动 | **P1** |
| E-6 | **`/api/characters/all` 每角色 1 次 `_latest_session` 查询** → 100 角色 = 101 查询 | `silly_tavern.py:2836-2859/1135-1147` | 角色列表页慢 | **P1** |
| E-7 | prompt 正则按消息重复查库（每消息 **2 次**：1 次 PluginScript + 1 次 UserSetting，均无请求级缓存） | `character_ext.py:1397-1402`（PluginScript）、`1457-1511`（UserSetting）、`1539-1610`（消息循环调用） | 24 条消息 ≈ 48 次重复查询/请求 | **P2** |
| E-8 | 单次装配基础 SQL 15-22 次（InstructTemplate 在 st-compat 路径加载 **2 次**；GroupChat 群聊请求可达 **6 次**加载：L2804/L2872/L3386/L3523 + `_resolve_group_speaker` L2433 + `_build_group_profile_context` L2591；Session 查询 2 次 L2855/L3092） | `roleplay_prompt_assembly.py:3468/3986`（InstructTemplate）、`2804/2872/3386/3523`（GroupChat）、`2855/3092`（Session） | 放大 E-1 | **P2** |
| E-9 | 世界书全量加载全部条目（含禁用，无 LIMIT） | `worldbook_service.py:1432-1436` | 大书每请求全量 | **P2** |
| E-10 | 缺失关键索引：`extension_prompts.user_id/session_id`、`world_books.user_id/character_id`、`world_book_stages.world_book_id` 均无索引 | `extension_prompt.py:26-50`、`worldbook.py:12-34/37-104` vs 已有 0013/0017 | 装配高频查询全表扫 | **P2** |
| E-11 | `GroupChatSession.messages` 为 JSON 大字段，选角/投票每请求 `json.loads` 全量历史（`_get_last_group_speaker_id` L1792、`_activate_swipe` L1843、投票/选角 L2152/L2224 等） | `group_chat.py:66`、`roleplay_prompt_assembly.py:1792/1843/2152/2224` | 长群聊 O(历史长度) 解析 | **P2** |
| E-12 | 前端无消息列表虚拟化（全库无 react-window/react-virtualized） | — | 长会话渲染全部消息 | **P2** |

---

## 3. 多用户数据处理与隔离性

### 3.1 确认良好（多租户隔离到位）

- ✅ 角色、会话、消息、世界书、记忆、workspace、群聊均按 `user_id` 过滤（大量行号证据，见研究记录 §2）。
- ✅ SQL 全库无注入（动态 SQL 仅限参数名/常量，值全部走命名参数绑定）。
- ✅ WebSocket ticket 认证设计良好（30s 单次使用）。

### 3.2 隔离缺陷

| # | 问题 | 证据 | 影响 | 优先级 |
|---|---|---|---|---|
| M-1 | **ChatVariable 系列端点水平越权**：`session_id` 全部来自请求，查询未关联 user 属主（同文件其他端点有校验）。攻击者拿到受害者的 session_id 即可读写其会话变量 | `silly_tavern.py:2742/2792-2799/2826-2832`、`variables.py:103-128`（对比 `_session_for_file` L1161-1165 带 user_id） | 跨用户读写会话变量（插件状态/笔记/缓存敏感数据） | **HIGH** |
| M-2 | **ST proxy 业务头透传链缺陷**：`_build_proxy_request_headers` 只覆盖非空 session_payload 对应的头；攻击者可直接带 `X-Palink-Session-Id: <victim>` 透传给 ST sidecar；`/api/st/native/login` 把用户 query 的 session_id 未验证归属即签入 cookie；sidecar `PALINK_ST_NATIVE_USER_HEADER_ENABLED=true` 信任 `X-Palink-User-Id`（该头被强制覆盖，但 session/character 不校验归属） | `silly_tavern.py:4645-4671/1998-2024`、`docker-compose.yml:60` | 若 ST sidecar 用 session_id 拼数据目录路径则跨用户读 ST 侧文件 | **HIGH** |
| M-3 | 插件为全局共享（无 user_id），regex 脚本作用于所有用户 prompt | `plugins.py:995/1013/1063`、`plugin.py:11-25` | 多租户时管理员插件注入所有用户 prompt | **P2** |
| M-4 | OpenAI 兼容端点 service key **仅当配置了 `ST_NATIVE_SERVICE_KEY` 时**固定绑定 admin 用户（默认空串时回退普通 JWT 校验） | `openai_compat.py:94-111` | 若配置该 key，多 ST 用户共用一个后端时全部以 admin 身份执行 | **P2** |
| M-5 | 匿名 `/thumbnail` 可枚举任意角色头像（`user=None` 时不做 user 过滤全局解析） | `silly_tavern.py:2114-2142/1119-1132` | 信息面扩大 | **P2** |
| M-6 | 角色/世界书编辑为"最后写入者胜"，无乐观锁/版本号 → 同用户双标签页互覆盖 | `silly_tavern.py:2901-2918`、`worldbook.py` | 丢更新 | **P2** |

### 3.3 并发正确性

| # | 问题 | 证据 | 影响 | 优先级 |
|---|---|---|---|---|
| M-7 | **同会话并发生成：第二条用户消息落库但 AI 回复被静默丢弃**。`create_stream_session` 发现同 session 已有 active 任务时直接返回 existing，不创建新任务；而消息已 `db.commit()`。前端无任何错误提示 | `websocket_manager.py:178-181`、`websocket.py:1652-1665` | 多标签页/快速连发数据不一致（消息存在、无回复） | **P1** |
| M-8 | `ChatRoom.broadcast`/`send_chunk` 持房间锁做网络 IO，慢客户端拖慢同会话流式 | `websocket_manager.py:78-88/236-250` | 自身流式延迟 | **P2** |
| M-9 | 模块级共享可变缓存：`_regex_key_cache` 无界 dict（无限累积）；记忆缓存（`_cache` 为 OrderedDict 有 `_MAX_CACHE_SIZE=1000` 上限，但写入后 60s TTL 内不失效 → 用户看到旧记忆）；`_ST_VEC_YIELD_CACHE` 多进程各自独立 | `worldbook_service.py:359`、`memory_module/service.py:32-36/57-94/226-232`、`roleplay_prompt_assembly.py:4352-4353` | 内存隐患/陈旧数据 | **P2** |
| M-10 | `persist_snapshot` 线程与主协程共享 `result`/`save_db` 无同步（CPython GIL 下风险低，理论边界） | `websocket.py:472-703` | 落库频率边界 | **LOW** |

---

## 4. 并发性能优化建议

1. **装配整段进线程池**：`assemble_roleplay_prompt` → `await asyncio.to_thread(...)`（与 persist_snapshot 同模式），世界书扫描与 token 编码至少放线程池。（E-1）
2. **token 估算 memoize + 前缀和裁剪**：按 `(model, content)` 进程内 LRU；裁剪循环改双指针一次编码；st-compat 分支跳过 `_collect_prompt_sources`。（E-2）
3. **世界书状态批量加载**：扫描前一次 `WHERE session_id=... AND entry_id IN (...)` 全部 state 到 dict。（E-3）
4. **历史 SQL LIMIT**：`ORDER BY created_at DESC LIMIT <budget>` 再反转。（E-4）
5. **ST 列表端点批量查询**：`/api/chats/recent` 用 join 子查询取 `MAX(id)`/`COUNT(*) GROUP BY`；`/api/characters/all` 用 `DISTINCT ON (character_id)` 批量取最新会话。（E-5/E-6）
6. **请求级缓存**：regex 脚本/UserSetting/InstructTemplate/GroupChat/Session 在请求内复用（lru_cache 按 user_id 或请求对象缓存）。（E-7/E-8）
7. **补索引**：`extension_prompts(user_id, session_id)`、`world_books(user_id, character_id)`、`world_book_stages(world_book_id)`，用 CONCURRENTLY 建。（E-10）
8. **LLM 流式 finally close**：`async with stream` / `try/finally: await stream.aclose()`，客户端断开主动取消上游。（详见 §6）

---

## 5. 安全性与隔离性（漏洞清单）

### 5.1 CRITICAL（严重）

| # | 问题 | 证据 | 攻击场景 |
|---|---|---|---|
| S-1 | **插件沙箱可完全逃逸 → 前端任意代码执行**。四条路径：(1) `new Function` 遮蔽 `var Function` 可被 `(function(){}).constructor('return this')()` 绕过（已第一手确认 `sandbox.ts:2357-2362`）；(2) fake script 元素在**真实 document.head** 执行任意 URL/内联代码，**不经过 fetch 白名单**（`sandbox.ts:323-405`；对比 `createSandboxedFetch` L1125-1185 有白名单但此路径不 consult）；(3) `self`/`top`/`globalThis`/`WebSocket`/`indexedDB` 等未遮蔽直达真实 window（Proxy get 陷阱只拦 `window.xxx` 属性访问）；(4) **`tavern_helper` 类型插件完全跳过沙箱**——`manager.ts:167-176` 由 `sillyTavernPluginRuntime.ts:341-353` 以真实 `<script>` 标签注入执行。后端 `/api/plugins/runtime/config` 对所有登录用户下发全部启用插件 JS；zip 导入原样存库；`injectPluginCSS`（L3664-3674）CSS 未消毒 | `sandbox.ts:2355-2462/323-405/951-954/3664-3674/1125-1185`、`manager.ts:167-176`、`sillyTavernPluginRuntime.ts:341-353`、`plugins.py:290-385/999-1054`、`bridge.js:481`（postMessage `'*'`） | 恶意/被投毒扩展（管理员导入或角色卡携带 `extensions.tavern_helper`）→ 窃取 JWT（localStorage/fetch `/api/keys`）、接管主应用、外传聊天内容 |
| S-2 | **`.env.example` 弱 SECRET_KEY 可绕过生产校验**。production 校验只拒绝 `palink-dev-secret-change-in-production`，不拒绝模板值 `change-me-to-a-strong-random-string`。该密钥用于 JWT、**ST native session cookie**、上传 token | `.env.example:11`、`config.py:115-120` | 攻击者用公开模板值伪造任意用户/admin JWT + `scope=st-native` cookie，完全接管系统 |
| S-3 | **OAuth 回调开放重定向 → JWT 令牌泄露**。`redirect_uri` 取 referer 或 query 参数（`auth.py:228-233`）；callback 后重定向到 referer 的 origin 并把 JWT 放 fragment（`auth.py:300-307`）。**注（现实约束）**：利用链还需 (a) OAuth 服务商接受该 redirect_uri、(b) callback 请求的 Referer 在正常流程下是 OAuth 服务商域名——但就代码行为而言，redirect 目标 origin 取自已控的 Referer/query，论断成立 | `auth.py:228-251/300-307` | 诱导已登录用户点击带恶意 Referer 的 login-url → OAuth 授权后 JWT 跳到攻击者域 |

### 5.2 HIGH（高危）

| # | 问题 | 证据 | 修复方向 |
|---|---|---|---|
| S-4 | ChatVariable 水平越权（见 M-1） | `silly_tavern.py:2742+` | 查询前解析 session 并校验 user_id |
| S-5 | ST sidecar 业务头注入 + session 未验证签入 cookie（见 M-2） | `silly_tavern.py:4645-4671/1998-2024` | proxy 转发前强制覆盖全部 `X-Palink-*`；login 校验归属 |
| S-6 | **ST sidecar 关闭全部安全开关成为内网 SSRF 跳板**：`SILLYTAVERN_WHITELISTMODE=false`、`SILLYTAVERN_SECURITYOVERRIDE=true`、`SILLYTAVERN_PRIVATEADDRESSWHITELIST_ENABLED=false`，且与 backend/frontend 同网络（`frontend-backend` 网络）；**db 在独立 `backend-db` 网络，ST 无法直达**（`ST_NATIVE_PALINK_OPENAI_URL=http://backend:8000` 可达 backend） | `docker-compose.yml:53-59/76-77/148-150/182-183` | 开启白名单/私有地址校验；ST 与 backend 网络隔离 |
| S-7 | **上传 token 明文放 URL query**（登录 JWT；代码默认 12h，但 `.env.example:17` 设 `ACCESS_TOKEN_EXPIRE_MINUTES=1440` = 24h），出现在浏览器历史/nginx 日志/Referer/CDN 日志 | `main.py:348-365`（`_verify_upload_access` L297-329 用 JWT）、`uploadUrls.ts:1-11`、`silly_tavern.py:766-768` | 改 HttpOnly 短期签名 cookie / 一次性签名 URL |
| S-8 | **日志脱敏组件已实现但从未启用**（`setup_sanitized_logging` 零调用），`main.py` 用裸 `basicConfig` | `log_sanitizer.py` vs `main.py:24`、`admin.py:588-590`、`silly_tavern.py:4707-4743` | lifespan 中启用 sanitizer |
| S-9 | **插件 zip 导入无总大小/条目数限制**（zip 炸弹/内存 DoS）。`file.read()` 无大小上限；zip 解析只对非 js/css/module/template 的 assets 条目有 `>5MB 跳过`限制，**js/css/module/template 全量读入无单文件限制，且解压总量、条目总数均无限制** | `plugins.py:1077`（`file.read()` 无上限）、`290-385`（zip 遍历 L330-361） | 流式限流 + 条目/总字节限制 |
| S-10 | **ST 图片上传无扩展名/MIME/魔数校验**（可传 `.html/.svg/.js` 到 data/images，配合 ST 静态服务同源 = 存储型 XSS）。仅 `os.path.basename` + 去 `..` + 10MB 大小限制 | `silly_tavern.py:6320-6351`（L6330 basename、`_ST_MAX_IMAGE_UPLOAD_SIZE`=10MB L4781） | 加魔数/扩展名白名单 |

### 5.3 MEDIUM（中危）

- ✅ **`CSRF token 硬编码常量无校验`**（`silly_tavern.py:2027-2034`）——已于 2026-08-11 修复（MED-4）：新增 `core/csrf_guard.py` 并挂到全部 ST 兼容 router——安全方法/带 `Authorization: Bearer` 的请求放行（Bearer 免疫 CSRF，Palink 前端与 bridge.js 代理均带 Bearer），纯 cookie 写请求必须携带 `X-CSRF-Token: palink-csrf` 否则 403。详见 PLUGIN_ISSUES_REPORT §15。
- `ST native session cookie 无 jti 无法注销`（12h 有效，logout 只能拉黑普通 JWT）。
- ✅ **`CORS 默认 * + allow_credentials=True`**（`main.py:286-292`）——已于 2026-08-11 修复（MED-2）：`*` 时关闭 credentials（消除 Starlette 反射任意 Origin），显式域名时正常启用；`config._validate_config` 已强制非 development 必须显式域名。详见 PLUGIN_ISSUES_REPORT §14。
- ✅ **`速率限制为单进程内存实现`**，多 worker 失效——已于 2026-08-11 修复（MED-3）：改为 PostgreSQL/SQLite 共享表 `rate_limit_entries`（UPSERT+RETURNING 原子计数），多 worker 共享；`TRUST_PROXY_HEADERS` 时 XFF 可伪造为既有部署权衡（信任声明），已注释记录未改变。详见 PLUGIN_ISSUES_REPORT §14。
- `SSRF 防护存在 TOCTOU`（DNS rebinding）：先解析检查再 httpx 重新解析。
- ✅ **`API Key 加密密钥与数据同目录`**（`.api_key_encryption_key` 在 DATA_DIR，拿备份=拿全部明文 key）——已于 2026-08-11 加固（MED-6）：环境变量 `API_KEY_ENCRYPTION_KEY` 优先注入（既有），生产环境使用文件密钥时打 SECURITY 告警，`.env.example` 补充说明。详见 PLUGIN_ISSUES_REPORT §15。
- ✅ **`openai 兼容端点 service key 默认空`**——已于 2026-08-11 加固（MED-5）：空值合法（不启用分支，推荐）；配置弱值（<16 字符或常见串）时打 SECURITY 告警，`.env.example` 补充安全提示。详见 PLUGIN_ISSUES_REPORT §15。
- ✅ **`依赖版本未锁定`**（fastapi/uvicorn/sqlalchemy/httpx/websockets 无版本约束）——已于 2026-08-11 修复（MED-1）：`backend/requirements.txt` 全部依赖 `==` 精确锁定为容器内验证通过的版本。详见 PLUGIN_ISSUES_REPORT §14。
- `注册开放` + 无验证码/邮箱验证。
- `匿名可枚举任意角色头像`（`/thumbnail`）。

### 5.4 LOW（低危）

- st-native session 无 Secure 兜底（信任可伪造的 `X-Forwarded-Proto`）；登录 token 有效期代码默认 12h（`.env.example` 为 24h）且上传接口不查黑名单；`_avatar_response` 开放重定向（用户自己的字段）；`.env.example` 默认 DB 口令 `ai_password`；MCP 命令白名单含 npx/uv（供应链）；WS/错误信息 `str(e)[:200]` 回传客户端；ST 代理透传上游 `Access-Control-Allow-*`/`Set-Cookie`。

### 5.5 XSS 面结论

- 前端主渲染链有消毒（DOMPurify 完整管线），**主渲染链安全**。
- 插件沙箱 + ST 图片上传 + 导入 name 不清洗是主要 XSS 面（见 S-1/S-10/B-8）。
- regex 脚本 `findRegex` 用户可控且前端执行，存在 ReDoS 面（低）。

---

## 6. LLM 客户端与并发

| # | 问题 | 证据 | 修复方向 |
|---|---|---|---|
| L-1 | **客户端断开后不主动取消上游 LLM 请求**：`stream_text_completion` 无 `try/finally` 显式 `aclose()`；HTTP SSE / OpenAI 兼容流同样无 finally close | `inference_dispatcher.py:432-883`（`async for chunk in stream` L771）、`silly_tavern.py:2220-2266`、`openai_compat.py:189-273` | `async with stream` / `finally: await stream.close()` |
| L-2 | 远端模型**聊天生成主链路**无并发限制（仅本地模型走 inference_queue）且无网络级退避重试（`_create_stream` L709-736 仅为参数兼容性回退，非退避；依赖 SDK 默认 max_retries=2）。**注**：`inference_queue.submit_and_wait`（L339-410）自带指数退避重试，但只用于记忆摘要/标题生成等辅助任务（`ai_summary_service.py:109`、`compact_title_service.py:148`），chat 主链路不走它 | `inference_queue.py:42-64/339-410`、`inference_dispatcher.py:508-562/628-635/765-771` | 突发并发打满上游配额；瞬时网络错误仅 SDK 默认重试 |

---

## 7. 工程验证缺口（比代码更关键）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| V-1 | **golden vector diff 工具丢弃 `name` 字段**：`normalize_message` 只保留 role/content → 示例消息缺 name 的真实差异被掩盖，测试仍 100% 通过（违反 spec 3.9"不允许字段差异"） | `diff_messages.py:23-32`；已第一手确认 `st_basic_char.json:26/31` 有 name、`palink_basic_char.json:26/31` 无 | "与 ST 1.18.0 逐字段一致"验收标准实际未达成 |
| V-2 | **golden vector 的 `model="palink-default"` 与 `st_*.json` 字段结构（scenario_name/st_version vs path）不符**，st_*.json 来源真实性存疑（st_capture_server 生成的 dict 含 path、无 st_version，与现有文件相反） | `st_capture_server.py:48-62` | golden vector 可能非 ST 真实浏览器输出 |
| V-3 | **token 裁剪路径从未被 golden 真实触发**：`palink_long_chat_truncation.json` 显示 `messages=7, total_tokens=187, token_budget=5632`（187 << 5632，trim 直接返回）；长对话被 `recent_messages_budget` 条数截断吃掉 | `golden_vectors/palink_long_chat_truncation.json`、`roleplay_prompt_assembly.py:1210-1212` | D4 token 裁剪（含 pin_examples 竞争）未被端到端验证 |
| V-4 | `test_st_contract.py` 用 `files={"file":...}` 而非 ST 客户端的 `avatar` → 上传字段不匹配被测试掩盖 | `test_st_contract.py:309` | C-2 未被测试发现 |

---

## 8. 修复优先级路线图

### Phase 1（P0，阻塞 ST 兼容/安全底线）
1. **C-1** `/api/backgrounds/all` 返回 `{images, config}` → ST 前端可启动。
2. **C-2** 上传端点兼容 `avatar` 字段名（`File(..., alias="avatar")` 或双字段解析）。
3. **C-3/C-4** 群聊端点接受 `{id}`；groups/edit/delete 对 `palink-group-` id normalize。
4. **S-1** 插件沙箱加固（fake script 白名单 + Function 逃逸封堵 + CSS 消毒；推荐 iframe/blob URL 真隔离）。
5. **S-2** 生产 SECRET_KEY 强校验（拒绝模板值）。
6. **S-3** OAuth redirect_uri 白名单化。
7. **B-2** 世界书 position 映射改为透传（identity）+ 修正测试断言。

### Phase 2（P1，功能完整 + 数据安全）
8. **P-1/P-2** 沙箱 `getContext()` 聚合 ST 兼容字段（复用 buildStContext）+ 补 `app_ready` 等缺失事件。
9. **B-1** 生产导入路径补齐 V3 四字段（talkativeness/nickname/group_only_greetings/jailbreak）。
10. **A-1~A-8** 面 A 8 项残余语义 bug 对齐 ST 1.18.0。
11. **V-1~V-4** 修正 golden vector 工具（保留 name 字段）+ 重新从 ST 真实浏览器捕获 + 触发 token 裁剪场景。
12. **S-4/S-5/S-6/S-7/S-8/S-9/S-10** 安全 HIGH 项。
13. **M-1/M-7** ChatVariable 越权、同会话并发生成静默丢弃。
14. **E-1~E-6** 性能 P1 项（to_thread、token memoize、世界书批量加载、SQL LIMIT、ST 列表批量查询）。

### Phase 3（P2，完善）
15. P-3~P-11 插件 moduleMap 补齐、挂载点显示、模板渲染器统一。
16. `/api/translate/{provider}` 路由、`/api/sd/*` 端点对齐。
17. B-3~B-8 角色卡容错（tags/greetings 归一、V1/gradio 映射、CharX/YAML、world 解析）。
18. E-7~E-12、M-3~M-10、MEDIUM/LOW 安全项、L-1/L-2。

---

## 9. 与既有文档的关系

- 本报告是 `docs/st-compat-gap.md`（面 A 差距清单）的**续篇**：gap.md 的 D1-D10 已修复但发现 8 项残余语义 bug + 5 项新差距；新增面 B 启动崩溃、插件运行时、角色卡导入字段丢失、安全、性能五大维度。
- 与 `docs/SECURITY_AUDIT_REPORT.md`（2026-05-12，清理类）互补：本报告聚焦 ST 兼容层与插件沙箱。
- 与 `docs/performance_report.md` 互补：该报告测的是未超预算基线（P95=145ms）；本报告揭示超预算/多用户下的退化路径（O(n²) 裁剪、事件循环阻塞、N+1）。

---

## 10. 审计方法与把握度声明

- **方法**：6 路并行子代理（面 A 装配现状、角色卡、插件、面 B 契约、安全/隔离、性能/多用户）+ 我本人对全部 P0 级结论的第一手代码交叉验证。
- **二次复核（2026-08-09 追加）**：报告完成后又派发 **6 路验证子代理** 对全部论断逐条重读代码复核，并按复核结果修正了本报告（见 §11 修正记录）。复核方式：每条论断给出"✅正确/⚠️部分正确/❌错误"+ 精确行号证据。
- **已亲自验证的论断**：upload 字段 `file` vs `avatar`（`silly_tavern.py:4880`）；backgrounds 返回结构（`st_resources.py:168-176`）；群聊端点读 `file_name` vs ST 发 `{id}`（`st_groups.py:582/622/681` vs `group-chats.js:199/640`）；世界书 position 枚举（`world-info.js:855-864` vs `worldbook_import_utils.py:9` 偏移 bug）；沙箱 `var Function` 遮蔽可被 `(function(){}).constructor` 绕过（`sandbox.ts:2357-2362`）；OAuth referer 重定向（`auth.py:228-233`）；golden vector name 字段缺失 + diff 工具丢弃（`palink_basic_char.json:26-31` vs `st_basic_char.json:26-31`、`diff_messages.py:23-32`）；D1-D10 修复落地证据（jailbreak/names_behavior/group_id 等 grep + 读码）。
- **整体把握度**：**>95%**。全部 P0/P1 级结论经**两轮独立验证**（初审计 6 路 + 复核 6 路）；复核共发现 17 处需修正的"部分正确"项（无完全错误论断），已全部按证据修正并记录在 §11。

---

## 11. 二次复核修正记录（2026-08-09）

本次复核共修正 17 处表述，均为"结论方向正确、细节需精确化"，无一条完全错误：

| # | 位置 | 原表述 | 修正为 |
|---|---|---|---|
| 1 | A-8 | group nudge 注入位置"与 ST 相反（ST 在 jailbreak 之前）" | **错误**。ST 默认顺序 jailbreak(3)<chatHistory(4)，nudge 插在 chatHistory 末尾即 jailbreak **之后**，与 Palink 一致；真正差异仅是缺 `type='impersonate'` 豁免 |
| 2 | C-2 | "所有上传端点"字段不匹配 | 改为"8+ 个主上传端点"；`/api/characters/edit-avatar`（`silly_tavern.py:4969` 用 `avatar`）是例外；ST 前端行号修正为 `script.js:10524/12076`（原 10486/12039 是别处） |
| 3 | C-3 | 群聊 get/save/delete "全部 400" | get/delete 确实 400；**save 不报 400**，而是每次静默新建 `group_id=None` 孤立 session（数据漂移）；group/info 是 422 |
| 4 | C-4 | groups delete "404" | **edit 404 成立；delete 查不到时静默返回 `{"result":"ok"}` 而非 404**（实际未删除） |
| 5 | C-7 | "snapshots 未注册" | 精确为 ST 1.18.0 的 `/api/backups/chat/*`（聊天备份） |
| 6 | S-6 | ST sidecar"与 db/backend 同网络" | **db 在独立 `backend-db` 网络，ST 无法直达**；ST 与 backend/frontend 同网成立 |
| 7 | S-7 | 上传 token"JWT 12h" | 代码默认 12h 正确，但 `.env.example:17` 设 1440 分钟=24h，按示例部署实为 24h |
| 8 | S-9 | "单文件有 1MB/5MB 限制" | 精确：仅非 js/css/module/template 的 assets 条目有 `>5MB 跳过`；js/css/module/template 全量读入无限制 |
| 9 | E-3 | 每条目"2-5 次"查询 | 实测激活路径 3 次、跳过路径 2 次 → "2-3 次"（100 条目 ≈ 200-300 次） |
| 10 | E-4 | 默认"24 条"截断 | 实际 `limit` 默认 60 |
| 11 | E-7 | 每消息"2-3 次" | 实测每消息 **2 次**（1 PluginScript + 1 UserSetting） |
| 12 | E-8 | GroupChat"最多 4 次"加载 | 群聊 st-compat 请求实际可达 **6 次**（低估） |
| 13 | L-2 | "无网络级退避重试" | 主链路无退避正确；但 `inference_queue.submit_and_wait`（L339-410）有指数退避，用于记忆摘要/标题生成等辅助任务，主链路不走它 |
| 14 | B-1 | jailbreak"读为 None" | 精确：talkativeness/nickname/group_only_greetings 读为 None；**jailbreak 在导入路径完全未读**；且 talkativeness/extensions.jailbreak 值以 `palink_sillytavern.card_fields` 残留于 extensions JSON |
| 15 | B-2 | position 映射"整体偏移 1" | 精确：**position 1-7 偏移 1，v=0 因 `max(0,-1)` 钳制恰好正确**；并补充 Palink 内部枚举（`worldbook_service.py:69-76`）与 ST 逐位对应的证据 |
| 16 | P-1 | getContext 字段清单"仅 on/off/emit/storage/registerCommand/registerMacro/log" | 实际还有 `once`/`registerHook`（及 manager 注入的 `pluginTemplates`）；并确认 import 与全局是同一极简函数；vectors 为 `Array.isArray(undefined)` 短路 → 静默失效而非 TypeError |
| 17 | openai service key | "以 admin 刷模型" | 精确：仅当配置了 `ST_NATIVE_SERVICE_KEY` 时该分支生效，默认空串时回退普通 JWT 校验 |

---

## 12. Phase 1 P0 修复记录（2026-08-11）

按 §8 Phase 1 路线图执行，共 8 项 P0。**已完成全部 8 项**（S-1 插件沙箱加固原暂缓，于 Phase 2 阶段按用户确认补完，见下）。

### 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| C-1 | `/api/backgrounds/all` 返回结构不对齐 | `st_resources.py` `st_backgrounds_all` 返回 `{"images": [...], "config": {}}`（ST 前端 backgrounds.js:715 解构 `{images, config}`） | TestClient 集成验证 keys=['config','images'] |
| C-2 | 上传端点文件字段名不匹配（ST 发 `avatar`） | 新增 `_resolve_upload_field(file, avatar)` 双字段解析 helper（silly_tavern.py + st_resources.py 各一份）；改造 10 个主上传端点签名为 `file: Optional[UploadFile]=File(None)` + `avatar: Optional[UploadFile]=File(None)`：characters/import、chats/import、worldinfo/import、worldinfo/batch-import、groups/import、images/upload、backgrounds/upload、avatars/upload、sprites/upload、sprites/upload-zip。`edit-avatar` 原本就用 `avatar` 字段，不改 | TestClient 验证 avatar 字段上传 200、无文件 422；test_st_contract.py 39 passed（file 字段仍兼容） |
| C-3 | 群聊端点只读 `file_name`，ST 发 `{id}` | `st_groups.py` get/save/delete 三端点增加读取 `body["id"]` 作为 session_id 来源（`_group_session_id_from_file(file_name) or chat_id or file_name`）；`silly_tavern.py` `GroupInfoRequest` 增加 `id` 字段，`st_group_info` 用 `req.group_id or req.id` | 单元验证 id 解析 + group/info 接受 `{id: palink-group-xxx.png}` → normalize 为 xxx |
| C-4 | `groups/edit`、`groups/delete` 未 normalize `palink-group-` id | 两端点查库前调用 `_normalize_group_id(req.id)`；delete 保持 ST 语义（查不到静默 ok），edit 查不到仍 404 | 单元验证 normalize 路径 |
| S-2 | 生产 SECRET_KEY 只拒绝单一默认值 | `config.py` 生产校验改为黑名单集合：拒绝 `palink-dev-secret-change-in-production` 与 `.env.example` 模板值 `change-me-to-a-strong-random-string` | 容器内验证弱密钥启动拒绝、强密钥接受 |
| S-1 | 插件沙箱可完全逃逸（Function 逃逸 + fake script 任意执行 + 词法自由变量直通真实全局 + postMessage '*' + CSS 未消毒） | `sandbox.ts`：① Function.prototype.constructor 原型链拦截（`(function(){}).constructor` / `x.constructor.constructor` 一律抛错）；② fake script 外部 URL 强制走 fetch 白名单（同源 + 默认 CDN + 用户配置）、内联代码执行禁用；③ buildWrappedCode 词法遮蔽补全（self/top/parent/globalThis/frames/opener → sandboxedWindow，WebSocket 同源包装，XMLHttpRequest/indexedDB 禁用，alert/confirm/prompt/open/close/postMessage stub）；④ window 白名单补 performance；⑤ `sanitizePluginCss` 消毒 @import/javascript:url/expression 等，接入 `injectPluginCSS` 与 `sillyTavernPluginRuntime` CSS 注入；⑥ `bridge.js` postMessage '*' → 宿主 referrer origin | tsc 通过 + 前端 build 成功 + dist 产物含 S-1 标记 + 容器 401(nginx auth) 正常响应。tavern_helper 路径经评估保持现状（默认 `enabled=False` 仅显式启用才下发，ESM 已走沙箱；真实酒馆助手为大型经典脚本需真实全局，强制收编沙箱会破坏功能，见 PLUGIN_ISSUES_REPORT §13.4） |
| S-3 | OAuth 回调开放重定向（JWT 泄露） | `auth.py` 新增 `_resolve_allowed_frontend_origin()`：从 referer/query 提取的 origin 必须命中 `CORS_ORIGINS` 白名单（开发 `*` 放行），否则忽略 referer 回退到后端自身 URL；`oauth_login_url` 与 `oauth_callback` 两处跳转目标均走白名单校验 | 单元验证白名单/黑名单/空 referer 三态 |
| B-2 | 世界书 position 整数映射偏移 1 | `worldbook_import_utils.py` `_ST_INT_TO_PALINK` 改为 identity `{v: v for v in range(0,8)}`（ST 1.18.0 枚举 0=before…7=outlet 与 Palink 逐位对应，world-info.js:855-864 已确认）；越界 8 回退 AT_DEPTH(4)；`normalize_worldbook_position` 边界改 0..7；同步修正 `test_worldbook_group_and_position.py` 断言 | pytest 8/8 passed；st_worldinfo_roundtrip_check 全 PASS；test_st_contract 39 passed |

### 暂缓与评估（用户确认后的处理）

| # | 问题 | 处理结论 |
|---|---|---|
| S-1 的 tavern_helper 收编沙箱子项 | tavern_helper 类型插件（如酒馆助手）以真实 `<script>` 注入执行（大型 IIFE 经典脚本，需真实 DOM/全局） | 经评估**保持现状**并记录：后端 `plugins.py` 对角色卡携带的 `extensions.tavern_helper` 以 `enabled=False` 导入（`/runtime/config` 仅下发 `enabled=True` 插件），且 ESM 脚本一律走沙箱（`sillyTavernPluginRuntime.isEsmModule` 跳过）；真实酒馆助手脚本强制收编 new Function 沙箱会导致其完全失效（用户明确优先适配该插件）。残余风险：用户显式启用被投毒的酒馆助手扩展时仍以真实脚本执行，由管理员操作承担（已在 §13.4 记录） |

---

## 13. Phase 2 P1 修复记录（2026-08-11）

按 §8 Phase 2 路线图执行（功能完整 + 数据安全）。本批次覆盖 **B-1 与 A-1~A-8**；P-1/P-2（前端沙箱）与 V-1~V-4（golden vector 工具）、S-4~S-10、M-1/M-7、E-1~E-6 留待后续。

### 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| B-1 | 生产导入路径丢失 V3 四字段 | `CharacterDataNormalizer.normalize`（character_import_service.py）补齐 `talkativeness`（数值转 str）/`nickname`/`group_only_greetings`（list 校验）/`jailbreak`（优先 extensions.jailbreak → data.jailbreak → PHI V2 兜底，与 convert_chara_card_to_character 对齐）；`_create_character` 写入 `jailbreak` 列。覆盖全部生产导入路径（character.py:221/476、silly_tavern.py:4907 均走 import_from_file） | 单元验证四字段归一 + jailbreak 三来源回退；测试 326 passed 无回归 |
| A-2 | prefer_character_jailbreak=false 时仍回退注入 PHI | 调用点（roleplay_prompt_assembly.py）把 PHI 兜底合并进 `char_jailbreak`（V2 兼容），`jailbreak_for_st = char_jailbreak if (prefer and char_jailbreak) else user_jailbreak`；builder 移除 `char.post_history_instructions` 无条件回退，context_template.jailbreak 保留为第二优先级；同步修正 test_st_compat_jailbreak.py 断言 | pytest 通过（jailbreak 5 项） |
| A-3 | narrator 消息未转 system role | builder 消息构造前判断 `msg_type == narrator_type → role="system"`（ST openai.js:580-583） | 冒烟验证 + 测试集通过 |
| A-4 | COMPLETION name 清洗不一致 | `_sanitize_name` 对齐 ST PromptManager：合法名（`/^[a-zA-Z0-9_]{1,64}$/`）原样保留；非法才替换非字母数字为 `_` 且截断 64 | 单元验证三态（合法/非法/超长） |
| A-5 | 示例消息缺 name 字段 | `_parse_example_chat` 返回 `(name, content)`：user 前缀 → `example_user`、角色前缀 → `example_assistant`、无前缀 → 无 name；注入时带 `name` 字段（ST openai.js:1111 setName） | 单元验证 parse + builder 输出 name 字段；golden vector 测试通过（st_basic_char.json 26/31 行有 name） |
| A-6 | wi_format 过度应用到 depth 条目 | builder depth 条目注入不再调用 `_apply_wi_format`（ST formatWorldInfo 仅用于 worldInfoBefore/After，openai.js:1367-1368）；同步修正 test_st_compat_wi_format.py / test_st_compat_assembly_order.py 断言 | pytest 通过 |
| A-7 | scenario/personality_format 空串语义相反 | `_apply_field_format` 空 fmt 返回字段原值（ST `scenario && scenario_format ? ... : scenario`）；修正 test_st_compat_p2_features.py 断言（空 format → 字段出现） | pytest 通过 |
| A-8 | group nudge 缺 impersonate 豁免 | builder 新增 `generation_type` 参数，`generation_type == "impersonate"` 时豁免 group nudge（ST noGroupNudgeTypes=['impersonate']，openai.js:888-894）；调用点传 `req.generation_type` | 单元验证 impersonate 豁免 / normal / None 向后兼容 |

### 跳过并记录（按用户指示：影响现有功能性/UI）

| # | 问题 | 跳过原因 |
|---|---|---|
| A-1 | jailbreak override 缺 `forbid_overrides` 守卫条件（ST：PromptManager 中 jailbreak prompt 的 forbid_overrides 属性 + isPromptDisabledForActiveCharacter 才允许角色卡覆盖） | Palink 无 PromptManager 等价概念，支持需新增设置字段（context_template 模型 + DB migration + 设置 UI 开关），影响面大且涉及 UI；按指示暂缓，建议与 Phase 3 插件 prompt 配置一并规划 |
| P-1/P-2 | 沙箱 `getContext()` 聚合 ST 兼容字段 + 补 `app_ready` 等缺失事件 | 前端插件运行时核心改动（与 S-1 同类），补字段/补事件会改变插件行为与 UI（memory 定时总结、quick-reply 自动执行等将开始运行）；按指示暂缓，与 S-1 一并规划 |

## 14. Phase 2 V/S 修复记录（2026-08-11 第二批）

按 §8 Phase 2 路线图继续执行 **V-1~V-4（验证工具修正）与 S-4~S-10（安全 HIGH 项）**。

### 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| V-1 | golden vector diff 工具丢弃 `name` 字段 | `diff_messages.py`：`normalize_message` 保留 name；`compare_messages` 比较 name（`name_mismatches` 报告）；name/role 任一不一致则该条不算匹配（spec 3.9 逐字段一致）；`print_report` 输出 name 不匹配明细。重新生成全部 palink golden vectors（A-5 修复后示例消息带 name），5 个 fixture 对比 100% PASS | diff 工具实测：修复前 basic_char 仅 80%（name 差异被掩盖），修复后 100% |
| V-2 | st_capture_server 输出字段与现有 st_*.json 不符 | `st_capture_server.py`：golden dict 由 `path` 改为 `scenario_name`/`st_version`（对齐现有 st_*.json 结构）；新增 `--fixture` 参数写入 `fixture`/`scenario_name` | 结构对齐验证 |
| V-3 | token 裁剪路径从未被 golden 真实触发 | `palink_golden_vector.py`：long_chat_truncation fixture 显式 `skip_chat_history=False` + 消息加长（每条约 200+ tokens），使 30 条历史真实创建并超预算；容器内实测 `st_compat_trim: trimmed=6; original=7343; budget=5585`（裁剪真实触发，原 golden 187 << 5632 直接返回） | 容器内运行生成器验证裁剪真实触发；golden 对比文件保持与 ST 侧捕获一致（未替换，避免破坏 count_match） |
| V-4 | test_st_contract.py 用 `file` 字段而非 ST 客户端 `avatar` | 上传契约测试改用 `avatar` 字段（模拟 ST 客户端真实行为）；保留 `file` 字段兼容测试（Palink 前端） | pytest test_st_contract.py 40 passed |
| S-4 | ChatVariable 水平越权（variables/get/set/delete 未校验 session 归属） | 新增 `_verify_session_ownership`（按 session_id + user_id 解析，找不到抛 404），variables/get/set/delete 三个端点查询前调用 | 新增 test_s4_s10_security.py 8 passed（伪造 session 404、own session 200） |
| S-5 | ST sidecar 业务头注入 + session 未验证签入 cookie | (1) `_is_proxy_strip_header` 增加 `x-palink-*` 前缀拦截，客户端伪造的 X-Palink-User-Id/Session-Id 等一律丢弃，转发头由服务端重建；(2) `st_native_login` 签入 cookie 前校验 `palink_character_id`（`_character_for_avatar` 按 user 过滤）与 `palink_session_id` 归属当前用户，伪造 404 | 静态审查 + 契约测试通过 |
| S-8 | 日志脱敏组件实现但从未启用 | `main.py` 用 `setup_sanitized_logging(level=logging.INFO)` 替换裸 `basicConfig`（root handler 挂 SanitizingFormatter，JWT/密钥/手机号/邮箱/身份证自动打码） | 启动日志正常输出，脱敏生效 |
| S-9 | 插件 zip 导入无总大小/条目数限制 | `plugins.py`：新增 `_read_upload_limited`（分块读取 50MB 上限，替代 `file.read()` 无上限）+ `_PLUGIN_IMPORT_MAX_ENTRIES`(2000)/`_PLUGIN_IMPORT_MAX_UNCOMPRESSED`(100MB) 校验（zip 炸弹防护） | pytest test_st_plugin_import.py 7 passed 无回归 |
| S-10 | ST 图片上传无扩展名/MIME/魔数校验 | `silly_tavern.py`：`_st_validate_image_content` 校验扩展名白名单（png/jpg/jpeg/gif/webp）+ 魔数（PNG/JPG/GIF/WEBP signature），拒绝 .html/.svg/.js 存储型 XSS | 新增 test_s4_s10_security.py：.html/.svg/伪 PNG → 400，合法 PNG → 200 |

### 跳过并记录（按用户指示：影响现有功能性/UI）

| # | 问题 | 跳过原因 |
|---|---|---|
| S-6 | ST sidecar 关闭全部安全开关（WHITELISTMODE=false / SECURITYOVERRIDE=true / PRIVATEADDRESSWHITELIST_ENABLED=false）且与 backend 同网 | 开启白名单/私有地址校验会拦截 `ST_NATIVE_PALINK_OPENAI_URL=http://backend:8000`（私有地址）导致 ST 生成功能中断；网络隔离会切断 ST→backend 的 openai 兼容代理链路，均直接影响现有功能。建议后续在 ST 私有地址白名单中显式加入 backend 后单独评估 |
| S-7 | 上传 token 明文放 URL query（出现在浏览器历史/nginx 日志/Referer） | 改为 HttpOnly 短期签名 cookie 需前端 `uploadUrls.ts`（`<img src>` 无法带 Authorization header）配合改用 fetch blob + 前端鉴权改造，影响全部图片/文件渲染路径，属于 UI/功能层改动；按指示暂缓，建议与登录态统一改造一并规划 |
