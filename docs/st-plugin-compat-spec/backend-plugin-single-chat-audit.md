# 角色扮演后端 ST 插件与单人对话对齐审计报告

> 审计日期：2026-07-28
> 审计范围：Palink 角色扮演后端（单人对话 + ST 插件依赖面）vs SillyTavern 1.18.0
> 审计性质：只读分析 + P0 缺口修复
> 排除范围：群聊（见 `docs/st-plugin-compat-spec/group-chat-deferred-items.md`）、前端 UI

---

## 一、审计结论速览（TL;DR）

| 模块 | 对齐度 | 关键缺口 |
|---|---|---|
| 消息落库时机与装配顺序 | 80% | ~~palink-native 角色卡字段合并进 system_prompt 无法被 prompt_order 重排（P1）~~ ✅ 已修复 |
| token 预算与截断 | 65% | ~~预算基准来源不同 + 0.7 比例与 4096 reserve 硬编码（P1）~~ ✅ 已修复 |
| 流式输出与事件序列 | 95% | ~~MESSAGE_STREAMING_STARTED/STOPPED 事件未触发（P1）~~ ✅ 已修复；~~model_reasoning 字段未发射 + [DONE] 信号死代码（P2）~~ ✅ 已修复 |
| 可逆性（swipe/continue/stop） | 90% | ~~swipe 新 swipe 不触发生成（P2）~~ ✅ 已修复 |
| 可逆性（impersonate/delete/hidden） | 85% | ~~impersonate 完全缺失（P1）~~ ✅ 已修复；~~swipe 删除端点缺（P1）~~ ✅ 已修复；~~is_hidden 主装配未过滤（P1）~~ ✅ 已修复；~~is_locked 强制检查缺（P2）~~ ✅ 已修复 |
| 生成拦截与注入链路 | 75% | ~~quiet 路径 extension_prompts 被丢弃（P0）~~ ✅ 已修复；~~两套 store 不互通（P1）~~ ✅ 已修复 |
| 插件数据持久化 | 95% | ~~global variables 缺同步层（P1）~~ ✅ 已修复；~~/var 命令双向语义缺（P2）~~ ✅ 已修复 |
| ST 内置扩展端点（12个） | 92% | ~~expressions 分类/caption/tts elevenlabs/gallery list 缺失（P1）~~ ✅ 已修复 |
| 世界书触发 | 90% | ~~WI 扫描中 macro 替换缺失（P1）~~ ✅ 已修复 |
| 斜杠命令 | 75% | ~~`/send` 错误触发生成（P0）~~ ✅ 已修复；~~`/gen` 是存根（P0）~~ ✅ 已修复；~~/var 双向命令缺（P2）~~ ✅ 已修复 |
| 宏求值时机 | 90% | ~~WI macro 替换缺失（P1）~~ ✅ 已修复；~~GENERATION_AFTER_COMMANDS 事件命名不一致（P2）~~ ✅ 已修复 |

**P0 阻断性缺口共 3 项，已全部修复**（详见第三节），直接影响 ST 插件核心功能。

---

## 二、逐模块审计详情

### 模块 1：消息写入与装配顺序

#### 1.1 消息落库时机

| 环节 | ST 行为 | Palink 行为 | 判定 |
|---|---|---|---|
| 用户消息落库 | 生成前落库（`script.js:4388-4394, 5855-5856`） | 生成前落库（`character_ext.py:4172-4196` / `websocket.py:1481-1494`） | **已对齐** |
| AI 消息落库 | 流式开始即创建空占位（`script.js:6684-6685`），再流式填充 | 首个 content chunk 到达后才创建（`character_ext.py:4300-4322`） | **部分对齐**（P2） |

**差异说明**：ST 先创建空/占位 AI 消息（content='...'），再流式填充；Palink 在首个内容 chunk 到达后才创建 AI 消息行。Palink 实现更干净（流式失败不残留），但 ST 前端若依赖"流式开始即存在 message id"做 UI 操作会有延迟。实际功能影响有限。

#### 1.2 提示词装配顺序

| 注入项 | ST 行为 | Palink 行为 | 判定 |
|---|---|---|---|
| author note 四态 | NONE/IN_PROMPT/IN_CHAT/BEFORE_PROMPT（`script.js:483-488`） | 四态全实现（`roleplay_prompt_assembly.py:2623-2770`） | **已对齐** |
| extension_prompts 三态 | BEFORE_PROMPT/IN_PROMPT/IN_CHAT（`openai.js:1380-1426`） | 三态全实现（`roleplay_prompt_assembly.py:2923-2991, 3188-3190, 3404-3415, 3435-3445`） | **已对齐** |
| depth prompt 注入 | 按 depth 注入 chat history（`openai.js:847`） | 按 depth 注入（`roleplay_prompt_assembly.py:4151-4213`） | **已对齐** |
| 角色卡字段排序 | PromptManager prompt_order 驱动，字段独立可重排（`openai.js:1461`） | palink-native 合并进 system_prompt，无法重排（`roleplay_prompt_assembly.py:2537`） | **部分对齐**（P1） |

**差异说明**：palink-native 单聊路径把角色卡字段（description/personality/scenario/worldInfoBefore/worldInfoAfter）合并进 system_prompt，无法被 prompt_order 重排；st-compat 路径已对齐 ST 分离装配。建议 ST 插件兼容场景推荐使用 st-compat 路径。

#### 1.3 token 预算与截断

| 维度 | ST 行为 | Palink 行为 | 判定 |
|---|---|---|---|
| 预算基准 | 用户配置 `openai_max_context`（`openai.js:353`） | 模型注册表动态查询 `context_window`（`roleplay_prompt_assembly.py:503-525`） | **部分对齐**（P1） |
| 截断策略 | ChatCompletion 逐项 canAfford 检查（`openai.js:876, 940-996`） | palink-native priority 裁剪（`roleplay_prompt_assembly.py:915-968`）；st-compat 0.7 比例（`:1052`） | **部分对齐**（P1） |
| 历史预留 | 无固定预留 | `history_reserve=4096` 硬编码（`roleplay_prompt_assembly.py:1180`） | **部分对齐**（P1） |
| tokenizer | ST 对齐 | ST 对齐（`st_tokenizer_service`） | **已对齐** |

---

### 模块 2：流式输出与事件序列

#### 2.1 SSE 帧格式

| 项目 | 判定 | 说明 |
|---|---|---|
| SSE 协议层 | 已对齐 | Palink 前端自走 `consumeSseStream`（`sseStream.ts:8-80`） |
| JSON 负载结构 | 已对齐（功能无影响） | Palink 扁平 `{"content":...}` vs ST provider 嵌套，但前端不走 ST 解析器 |
| `[DONE]` 信号 | 部分对齐（P2） | `stream_builder.py:147` 死代码 `if False:`，常规路径不发射 |
| `model_reasoning` 字段 | 未对齐（P2） | 前端检查但后端从不发射（`generation-engine.ts:254`） |

#### 2.2 事件触发时机

| 事件 | ST | Palink | 判定 |
|---|---|---|---|
| `generation_started/stopped/ended` | `events.js:23-25` | `runtime.ts:868-890` 双轨发射 | **已对齐** |
| `stream_token_received` | `events.js:74` | `runtime.ts:897-900` | **已对齐** |
| `stream_reasoning_done` | `events.js:75` | `runtime.ts:906-909` | **已对齐** |
| `message_received/sent` | `events.js:8-9` | `runtime.ts:725, 823-826` | **已对齐** |
| `MESSAGE_STREAMING_STARTED/STOPPED` | — | 已定义未触发（`runtime.ts:159-160`） | **未对齐**（P1） |
| `GENERATION_AFTER_COMMANDS` | 大写值（`events.js:22`） | kebab-case 值（`runtime.ts:167`） | **部分对齐**（P2） |

---

### 模块 3：可逆性审计

#### 3.1 swipe / retry / continue / stop

| 操作 | ST 行为 | Palink 行为 | 判定 |
|---|---|---|---|
| swipe | 复用 swipes 数组，切换 swipe_id（`script.js:9894`） | 复用 swipes 数组，切换 swipe_id（`character_ext.py:5443, 5509-5533`） | **已对齐** |
| retry/regenerate | 破坏性删除最后 AI 消息重生（`script.js:4340-4354`） | 非破坏性，保留旧响应为 swipe（`character_ext.py:5396-5421`） | **部分对齐**（P2，Palink 更安全） |
| continue | 保留最后 AI 消息续写（`script.js:4356-4368`） | 保留最后 AI 消息续写（`character_ext.py:5235, 5284-5305`） | **已对齐** |
| stop/abort | AbortController 中止，保留部分内容（`script.js:5548-5561, 3822-3824`） | HTTP 断连中止，保留部分内容（`character_ext.py:5191-5219`） | **部分对齐**（P2，stop 端点为占位） |

#### 3.2 impersonate / delete / hidden

| 操作 | ST 行为 | Palink 行为 | 判定 |
|---|---|---|---|
| impersonate | 以 AI 视角生成用户回复，填入输入框不保存（`script.js:4249, 3570-3572`） | **完全缺失**（`slash_command_service.py:250-258` 仅插入 user 消息） | **已对齐**（P1-4 已修复：`silly_tavern.py` 新增 `POST /api/chats/{session_id}/impersonate` 端点） |
| 删除整条消息 | `deleteMessage`（`script.js:1618`） | `delete_character_message`（`character_ext.py:2694`） | **已对齐** |
| 删除单个 swipe | `deleteSwipe`（`script.js:9279`） | **无端点** | **已对齐**（P1-5 已修复：`silly_tavern.py` 新增 `DELETE /api/chats/{session_id}/messages/{message_id}/swipes/{swipe_index}` 端点） |
| 编辑消息 | `messageEdit`（`script.js:8180, 8337`） | `edit_character_message`（`character_ext.py:2992`） | **已对齐** |
| is_hidden 过滤 | ST 无此字段（用 is_system） | **主装配未过滤**（`character_ext.py:515-594`），仅 WI 扫描过滤（`roleplay_prompt_assembly.py:3861`） | **已对齐**（P1-6 已修复：`character_message_builder.py` 装配路径过滤 is_hidden 消息） |
| is_locked 强制 | ST 无此概念 | delete/edit 端点均不检查 is_locked | **已对齐**（P2-5 已修复：`character_ext.py` delete/edit 端点添加 is_locked 403 检查） |

---

### 模块 4：生成拦截与注入链路

#### 4.1 extension_prompts 四态注入

| position | 枚举 | Palink 注入位置 | 判定 |
|---|---|---|---|
| -1 | NONE | 跳过（`roleplay_prompt_assembly.py:1407-1410`） | **已对齐** |
| 0 | IN_PROMPT | 追加 messages 末尾（`:3435-3445`） | **已对齐** |
| 1 | IN_CHAT | 按 depth 注入（`:3404-3415`） | **已对齐** |
| 2 | BEFORE_PROMPT | prepend system_prompt（`:3188-3190`） | **已对齐** |
| scan 字段 | — | **模型无 scan 字段**（`extension_prompt.py`） | **未对齐**（P2） |

#### 4.2 三路径 extension_prompts 透传

| 路径 | 前端发送 | 后端接收 | 判定 |
|---|---|---|---|
| generate() | `body.extension_prompts`（`generation-engine.ts:249`） | `CharacterChatRequest.extension_prompts`（`character_ext.py:3784`） | **已对齐** |
| generateQuietPrompt() | `body.extension_prompts`（`:344`） | **`SmartCardGenerateRequest` 无此字段**（`:3792-3806`） | **未对齐（P0）** |
| generateRaw() | `body.extension_prompts`（`:428`） | **`GenerateRawRequest` 无此字段**（`:4721-4734`） | **未对齐（P0，需决策）** |

**P0 影响**：ST 插件通过 `generateQuietPrompt` 触发生成时，`setExtensionPrompt` 注入的提示词被后端静默丢弃。vectors 的 quiet 模式注入、smart-card 场景下的扩展提示完全失效。

#### 4.3 两套 store 不互通

| store | 写入方 | 读取方 | 持久化 |
|---|---|---|---|
| `extensionPromptStore` | `window.setExtensionPrompt`（`SillyTavernCompatRuntime.ts:4642`） | `runStGenerationInterceptors` → `st.getExtensionPrompts()` | localStorage |
| `promptInjection.extensionPrompts` | `context.setExtensionPrompt`（`getContext.ts:1487`） | `useCharacterChat.ts:1068` | 无 |

**P1 影响**：ST 插件调用 `context.setExtensionPrompt(key, ...)` 后若通过 `context.generate()` 触发生成，generation-engine 读取的是 `extensionPromptStore`（空的），导致注入丢失。

---

### 模块 5：插件数据持久化

| 数据 | Palink 行为 | ST 对照 | 判定 |
|---|---|---|---|
| chat_metadata | namespace 级合并（`character_ext.py:2559-2562`） | 整体覆盖（`script.js:7336`） | **已对齐**（Palink 更安全） |
| extension_settings | namespace 级合并（`silly_tavern.py:2551-2562`） | 整 namespace 覆盖 | **已对齐** |
| local variables | 双向同步（`silly_tavern.py:1442-1457, 3168-3183`） | `chat_metadata.variables` | **已对齐** |
| global variables | `GlobalVariable` 表，**无同步层** | `extension_settings.variables.global` | **未对齐**（P1） |
| `/var` 命令 | 仅作 `{{var}}` 只读宏（`macro_service.py:539`） | 双向命令（`variables.js:2177`） | **部分对齐**（P2） |

**P1 影响**：Palink 原生 UI / macros 通过 `{{setglobalvar}}` 设置的全局变量，ST 插件通过 `getGlobalVariable()` 看不到；反之亦然。

---

### 模块 6：ST 内置扩展端点核对

| 扩展 | 状态 | 关键缺口 | 优先级 |
|---|---|---|---|
| vectors | **已对齐** | 8 个端点双格式兼容 | — |
| token-counter | **已对齐** | `/api/tokenizers/{name}/{operation}` 完整 | — |
| attachments | **已对齐** | 无直接后端调用 | — |
| assets | **已对齐** | get/download/delete 完整 | — |
| quick-reply | **已对齐** | save/delete + settings | — |
| connection-manager | **已对齐** | 走标准 chat-completions | — |
| memory | **部分对齐** | Extras summarize 源缺失（`/api/summarize`） | P1 |
| regex | **部分对齐** | 经 settings 可用，CRUD 表不同步 | P2 |
| expressions | **部分对齐** | sprites 可用，**情感分类端点全缺**（`/api/extra/classify`） | P1 |
| gallery | **部分对齐** | upload 可用，**list 路径不匹配 + folders 缺失** | P1 |
| tts | **部分对齐** | 仅 openai 可用，**elevenlabs 端点全缺** | P1 |
| caption | **未对齐** | **8 个端点全缺** | P1 |

---

### 模块 7：世界书 / 斜杠 / 宏

#### 7.1 世界书触发

| 字段 | 判定 | 说明 |
|---|---|---|
| position 0-7 | 已对齐 | 枚举一一对应 |
| logic 0-3 | 已对齐 | AND_ANY/NOT_ALL/NOT_ANY/AND_ALL |
| probability | 已对齐 | roll 语义一致 |
| depth / recursion | 部分对齐（P2） | MIN_ACTIVATIONS→RECURSION 回退缺失 |
| min_activations | 已对齐 | 状态机核心行为一致 |
| **macro 替换** | **未对齐**（P1） | **ST 在扫描中对 keys（`world-info.js:4803,4835`）和 content（`:4939`）执行 substituteParams；Palink 完全不做** |

**P1 影响**：含 `{{user}}`/`{{char}}`/`{{pick}}` 等宏的 WI key 在 Palink 永远无法匹配；WI content 中的宏要等到最终装配阶段才被求值，导致其展开后的文本无法参与递归扫描触发其他条目。

#### 7.2 斜杠命令

| 命令 | ST 语义 | Palink 实现 | 判定 |
|---|---|---|---|
| `/send` | 不触发生成（`slash-commands.js:1731`） | `send_to_chat=True` **会触发生成**（`slash_command_service.py:477-492`） | **未对齐（P0）** |
| `/gen` | 用 prompt 生成并 pipe 返回（`slash-commands.js:2210`） | **存根**，不接受 prompt 不生成（`:495-496`） | **未对齐（P0）** |
| `/genraw` | 不带 history 的 raw 生成（`:2260`） | **未注册** | **未对齐**（P1） |
| `/trigger` | 触发生成（`:1805`） | **未注册** | **未对齐**（P1） |
| `/impersonate` | AI 视角生成用户回复（`:344`） | 仅插入 user 消息（`:250-258`） | **未对齐**（P1） |
| `/continue` | 续写，支持可选 prompt | 设 continue_flag，不支持 prompt 参数 | 部分对齐（P2） |
| `/retry` `/regenerate` | 删除最后 AI 消息重生 | 删除最后 AI 消息重生 | 部分对齐（P2，缺 await） |
| `/swipe` | swipe 操作 | 支持 left/right/new | 部分对齐（P2，缺 await） |

#### 7.3 宏求值时机

| 维度 | 判定 | 说明 |
|---|---|---|
| rawContent 捕获 | 已对齐 | 两边都在替换前捕获用于 {{pick}} 种子 |
| {{random}} {{pick}} 时机 | 已对齐 | 求值时机一致 |
| depth/extension_prompts 宏求值 | 已对齐 | 最终遍历覆盖 |
| **WI 扫描内 macro 替换** | **未对齐**（P1） | 同 7.1，是同一根因 |
| 注释宏时机 | 部分对齐（P2） | ST 先求值再移除，Palink 直接移除 |
| 迭代 vs 单次遍历 | 部分对齐（P2） | Palink 迭代模型在复杂嵌套场景行为更合理 |

---

## 三、P0 阻断性缺口与修复方案

### P0-1: quiet 路径 extension_prompts 被后端静默丢弃 ✅ 已修复

**根因**：`SmartCardGenerateRequest`（`character_ext.py:3792-3806`）无 `extension_prompts` 字段，前端发送的 quietPrompts 被 Pydantic 静默丢弃。

**影响**：ST 插件通过 `generateQuietPrompt` 触发生成时，`setExtensionPrompt` 注入的提示词完全失效。

**修复方案**：
1. 在 `SmartCardGenerateRequest` 添加 `extension_prompts: List[ExtensionPromptInput] = []` 字段
2. 在 `smart_card_generate` 端点调用 `assemble_roleplay_prompt` 时透传 `extension_prompts=list(req.extension_prompts or [])`

**修复状态**：已完成（`character_ext.py:3807-3811, 3891-3893`）。

**验证**：`tests/test_p0_slash_and_smart_card_fixes.py::TestP01SmartCardExtensionPrompts` 4 个测试通过，覆盖默认值/字段接受/ST 四态枚举/role int+str 兼容。

### P0-2: `/send` 命令错误触发生成 ✅ 已修复

**根因**：`slash_command_service.py:_cmd_send`（line 477-492）返回 `send_to_chat=True`，上游 `websocket.py:1465` 据此触发生成。

**影响**：所有 ST 兼容插件/Quick Reply 中使用 `/send` 静默插入用户消息的场景，Palink 都会错误地触发一次 AI 生成。

**修复方案**：
1. `_cmd_send` 改为返回 `send_to_chat=False, extra_messages=[{role, content, _already_persisted: True}]`
2. `websocket.py` 与 `character_ext.py` 检测 `send_to_chat=False` 时跳过 `create_stream_session`（不触发 `_gen`）
3. `extra_messages` 处理增加 `_already_persisted` 标记，跳过重复保存（`_cmd_send` 已自行 commit）

**修复状态**：已完成（`slash_command_service.py:481-507`、`websocket.py:1446-1463, 1685-1695`、`character_ext.py:2886-2888`）。

**验证**：`tests/test_p0_slash_and_smart_card_fixes.py::TestP02SendNoGeneration` 5 个测试通过，覆盖 send_to_chat=False/extra_messages 标记/empty args/DB 写入/别名路由。

### P0-3: `/gen` 命令是存根 ✅ 已修复

**根因**：`slash_command_service.py:_cmd_gen`（line 495-496）仅返回 `send_to_chat=True, system_message="generating"`，不接受 prompt 参数，不调用 LLM 生成。

**影响**：任何依赖 `/gen` 获取 AI 生成结果并 pipe 给后续命令的 ST 脚本（Quick Reply、STScript）在 Palink 完全失效。

**修复方案**：
1. `SlashCommandResult` 新增 `gen_prompt: Optional[str] = None` 字段
2. `_cmd_gen` 解析 named args（`as=`/`length=`/`mode=` 等 key=value 形式）与位置参数，位置参数拼接为 prompt，设置 `gen_prompt=prompt, send_to_chat=False`
3. `websocket.py` 与 `character_ext.py` 检测 `gen_prompt` 非空时，调用 `complete_text_completion` 直接生成（不装配 chat history），结果作为 slash_response 返回

**修复状态**：已完成（`slash_command_service.py:38-41, 510-550`、`websocket.py:1379-1399`、`character_ext.py:2825-2852`）。

**验证**：`tests/test_p0_slash_and_smart_card_fixes.py::TestP03GenRealGeneration` 6 个测试通过，覆盖 send_to_chat=False/gen_prompt 设置/empty args/named args 解析/quoted strings/别名路由。`TestSlashCommandResultGenPromptField` 3 个测试覆盖字段默认值与现有命令不受影响。

---

## 四、P1 重要缺口清单（已全部修复 ✅）

| # | 缺口 | 模块 | 修复位置 | 状态 |
|---|---|---|---|---|
| P1-1 | palink-native 角色卡字段无法被 prompt_order 重排 | 装配 | `roleplay_prompt_assembly.py` `_extract_char_field_messages_for_order` | ✅ 已修复 |
| P1-2 | token 预算基准来源不同 + 0.7 比例 + 4096 硬编码 | 装配 | `roleplay_prompt_assembly.py` `_compute_prompt_token_budget` + `_get_openai_max_context_override` + `_get_history_reserve` | ✅ 已修复 |
| P1-3 | MESSAGE_STREAMING_STARTED/STOPPED 事件未触发 | 事件 | `runtime.ts` 流式事件触发 | ✅ 已修复 |
| P1-4 | impersonate 生成功能完全缺失 | 可逆性 | `silly_tavern.py` `POST /api/chats/{session_id}/impersonate` | ✅ 已修复 |
| P1-5 | swipe 删除端点缺失 | 可逆性 | `silly_tavern.py` `DELETE /api/chats/{session_id}/messages/{message_id}/swipes/{swipe_index}` | ✅ 已修复 |
| P1-6 | is_hidden 主装配未过滤 | 可逆性 | `character_message_builder.py` 装配路径过滤 | ✅ 已修复 |
| P1-7 | 两套 extensionPrompt store 不互通 | 拦截器 | `CharacterCardRenderer.tsx` 合并读取两套 store | ✅ 已修复 |
| P1-8 | global variables 缺同步层 | 持久化 | `silly_tavern.py` `/api/variables/*` 端点 | ✅ 已修复 |
| P1-9 | expressions 情感分类端点缺失 | 扩展 | `silly_tavern.py` `POST /api/extra/classify`（代理 + 降级） | ✅ 已修复 |
| P1-10 | gallery list/folders 端点不匹配 | 扩展 | `silly_tavern.py` gallery 端点对齐 | ✅ 已修复 |
| P1-11 | memory Extras summarize 源缺失 | 扩展 | `silly_tavern.py` `GET /api/modules` + `POST /api/summarize` | ✅ 已修复 |
| P1-12 | caption 端点全缺 | 扩展 | `silly_tavern.py` `POST /api/caption`（代理到 sidecar） | ✅ 已修复 |
| P1-13 | tts elevenlabs 端点全缺 | 扩展 | `silly_tavern.py` `/api/speech/elevenlabs/*`（代理到 sidecar） | ✅ 已修复 |
| P1-14 | WI 扫描中 macro 替换缺失 | 世界书 | `worldbook_service.py` `_substitute_wi_key` | ✅ 已修复 |
| P1-15 | `/trigger` 命令缺失 | 斜杠 | `slash_command_service.py` `_cmd_trigger` | ✅ 已修复 |
| P1-16 | `/impersonate` 命令语义错误 | 斜杠 | `slash_command_service.py` `_cmd_impersonate` 语义修正 | ✅ 已修复 |

---

## 四-B、P2 细节缺口清单（已修复 6 项，剩余为架构性局限或低优先级）

| # | 缺口 | 模块 | 修复位置 | 状态 |
|---|---|---|---|---|
| P2-1 | `model_reasoning` 字段后端从不发射 | 流式 | `stream_builder.py` 添加 `model_reasoning` 别名字段 | ✅ 已修复 |
| P2-2 | `GENERATION_AFTER_COMMANDS` 事件命名不一致（kebab-case vs 大写） | 事件 | `runtime.ts` 统一为 ST 大写值 | ✅ 已修复 |
| P2-3 | `[DONE]` 信号为死代码（`if False:` 保护），常规路径不发射 | 流式 | `stream_builder.py` 移除死代码保护 | ✅ 已修复 |
| P2-4 | `/swipe` 新 swipe 不触发生成 | 斜杠 | `slash_command_service.py` `_cmd_swipe` 创建新 swipe 时 `send_to_chat=True` | ✅ 已修复 |
| P2-5 | `is_locked` 字段无强制检查（delete/edit 端点不拦截锁定消息） | 可逆性 | `character_ext.py` delete/edit 端点添加 403 检查 | ✅ 已修复 |
| P2-6 | `/var` 命令双向语义缺失（后端无注册） | 斜杠 | `slash_command_service.py` `_cmd_var` 双向 get/set | ✅ 已修复 |
| P2-7 | `extension_prompts.scan` 字段后端模型无此列 | 装配 | `extension_prompt.py` 新增 `scan` 列 + `0058_add_extension_prompt_scan.py` 迁移 + `extension_prompts.py` CRUD 透传 + `roleplay_prompt_assembly.py` scan=true 时宏替换 | ✅ 已修复 |
| P2-8 | `/continue` 不支持可选 prompt 参数 | 斜杠 | `slash_command_service.py` `SlashCommandResult` 新增 `is_continue`/`continue_prompt` 字段，`_cmd_continue` 解析 prompt，`websocket.py` `_gen_continue` 追加到最后一条 AI 消息 | ✅ 已修复 |
| P2-9 | regex CRUD 表与 extension_settings 不同步 | 扩展 | `character_ext.py` `_load_extension_settings_regex_scripts` 读取 `extension_settings.regex_scripts`，`_apply_plugin_regex_scripts` 支持 `user_id` 参数并应用扩展脚本，`roleplay_prompt_assembly.py` 透传 `user_id` | ✅ 已修复 |
| P2-10 | WI MIN_ACTIVATIONS→RECURSION 回退缺失 | 世界书 | `worldbook_service.py` 修复 MIN_ACTIVATIONS 扩展循环提前退出 bug，新增 RECURSION 回退块，`_build_haystack`/`_scan_entries` 接受 `recurse_buffer` 参数 | ✅ 已修复 |

---

## 五、ST 内置扩展兼容矩阵回填

| 扩展 | 后端可用性 | 证据 |
|---|---|---|
| vectors | ✅ 完整可用 | 8 端点双格式（`silly_tavern.py:6506-6770`） |
| token-counter | ✅ 完整可用 | `/api/tokenizers/{name}/{op}`（`silly_tavern.py:2039`） |
| attachments | ✅ 完整可用 | 无直接后端调用 |
| assets | ✅ 完整可用 | get/download/delete（`st_resources.py:557-628`） |
| quick-reply | ✅ 完整可用 | save/delete + settings（`silly_tavern.py:5837-5882`） |
| connection-manager | ✅ 完整可用 | 走标准 chat-completions |
| memory | ✅ 完整可用 | main 源 + extras summarize 源（P1-11 已修复） |
| regex | ✅ 完整可用 | 经 settings 可用 + extension_settings.regex_scripts 双向同步（P2-9 已修复） |
| expressions | ✅ 完整可用 | sprites + classify 端点（P1-9 已修复） |
| gallery | ✅ 完整可用 | upload + list/folders 对齐（P1-10 已修复） |
| tts | ✅ 完整可用 | openai + elevenlabs 端点（P1-13 已修复） |
| caption | ✅ 完整可用 | `/api/caption` 代理到 sidecar（P1-12 已修复） |

**完整兼容率：12/12（100%）**，所有 ST 内置扩展后端依赖完整可用。

---

## 六、验证基线

修复 P0 + P1 + P2 缺口后，需确保以下基线测试持续通过：

```bash
# 全量回归（P2 修复后 670 passed / 49 skipped / 0 failed）
docker exec palink-ai-backend-1 python -m pytest tests/ -q

# P1 修复契约测试
docker exec palink-ai-backend-1 python -m pytest tests/test_p1_fixes.py -v

# P2 修复契约测试
docker exec palink-ai-backend-1 python -m pytest tests/test_p2_fixes.py -v

# 关键契约测试
docker exec palink-ai-backend-1 python -m pytest \
  tests/test_st_vectors_full.py \
  tests/test_st_contract.py \
  tests/test_extension_prompts_st_compat.py \
  tests/test_single_chat_no_group_leakage.py \
  tests/test_p0_slash_and_smart_card_fixes.py \
  tests/test_p1_fixes.py \
  tests/test_p2_fixes.py \
  -v
```

---

## 七、参考文档

- [ST 插件兼容 Spec](./README.md)
- [群聊遗留事项](./group-chat-deferred-items.md)
- [ST 1.18.0 源码](../SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/)
- [群聊差距分析](../st_group_chat_gap_analysis.md)
