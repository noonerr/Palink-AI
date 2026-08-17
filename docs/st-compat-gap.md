# ST 后端兼容性差距清单（角色扮演后端 ↔ ST 后端，仅二端交集）

> 范围限定：**仅**影响「Palink 角色扮演/角色聊天后端」与「SillyTavern 1.18.0 后端」接口的部分。
> 不涉及 Palink 的记忆/向量、图生图、TTS、用户系统、支付等其他组件后端。
> 分析基于：Palink `backend/app/...` 当前代码 + `SillyTavern-1.18.0` 源码（`src/` 后端与 `public/scripts/` 前端）逐行核对。

---

## 0. 架构前提（先把这点说清，否则差距会被误读）

**关键事实 1：ST 的后端 `src/` 不装配 prompt。**
ST 的聊天生成端点 `/api/backends/chat-completions/generate`（`src/endpoints/backends/chat-completions.js:2157`）只把浏览器端已经装配好的 `messages` 数组**透传**给上游 LLM，并通过 `forwardFetchResponse`（`src/util.js:709`，即 `from.body.pipe(to)`）把上游字节流原样回传。ST 后端对 prompt 结构**零感知**（`src/` 中没有任何 `PromptManager` 引用）。100% 的 prompt 装配发生在浏览器端 `public/scripts/`（PromptManager.js / world-info.js / openai.js / instruct-mode.js / personas.js / authors-note.js）。

因此「ST 后端兼容」实际有**两条互相独立的面**：

| 面 | 含义 | 由谁装配 prompt | Palink 对应代码 |
|---|---|---|---|
| **面 A** | Palink **服务端自建** ST 格式 prompt | Palink 服务器（`build_st_compat_messages`） | `character_message_builder.py` + `roleplay_prompt_assembly.py` 的 `st-compat` 分支 |
| **面 B** | Palink **ST 兼容 API 契约**（让 ST 原生客户端直连 Palink） | ST 浏览器端（ST 自己装配），Palink 只透传 | `silly_tavern.py` 的 `/api/backends/chat-completions/generate` |

**关键事实 2：两条面走完全不同的代码路径。**
`/api/backends/chat-completions/generate`（`silly_tavern.py:2095`）接收客户端 `messages` 直接 `_normalize_generate_messages(payload.get("messages"))`（:2102）后转发给 `stream_text_completion`（:2146）——**它从不调用 `assemble_roleplay_prompt` / `build_st_compat_messages`**。所以：
- `build_st_compat_messages` 里的任何缺陷，**只影响面 A**（即「Palink 自己以 `silly_tavern_mode=st-compat` 模式装配 prompt」的场景，例如 Palink Web/App 在 st-compat 模式下发的角色聊天）。
- 面 B（ST 原生客户端连 Palink）完全不受 `build_st_compat_messages` 影响——ST 客户端自己带正确格式的消息来，Palink 只是流式代理。

**结论：下面列出的「差距」几乎全部落在面 A；面 B 已基本对齐（见第 4 节）。**

---

## 1. 已确认对齐的部分（G1–G15 中已修复，不再是差距）

以下项经代码核对已与 ST 1.18.0 一致，列出以避免重复误报：

- **装配序**（PromptManager 默认序 main→WIBefore→persona→charDesc→charPers→scenario→(enhance/nsfw 默认跳过)→WIAfter→examples→chatHistory→jailbreak）：`build_st_compat_messages` :420–595 复现。
- **世界书 before/after**（pos 0 / pos 1）：分离注入索引 1 / 8（:433–457）。
- **Persona 固定在索引 2**（personaDescription）：调用处 `persona_desc = persona_full_text`（:2381），避免 position==1 丢失（G2）。
- **角色字段分离**：description / personality / scenario 分别成 system 块（:442–450）。
- **作者备注 5 态**：position 0(in-story depth) / 1(after-post-history) / 2(last-in-chat) / 4(top-of-chat) / 3(inactive) 全部处理（:459–603）。
  > **订正**：ST 1.18.0 `authors-note.js:81-88` 实际只有 **3 态**（0=after scenario / 1=in chat at depth / 2=before scenario）。Palink 的 5 态是 Palink 扩展设计，与 ST 1.18.0 不完全对齐，但功能上是 ST 3 态的超集，不视为差距。
- **ANTop/ANBottom**（pos 2/3）包裹作者备注：`worldbook_an_top/bottom` 拼接（:470–479，G4）。
- **EMTop/EMBottom**（pos 5/6）包裹示例块：`worldbook_em_top/bottom`（:489–500，G5）。
- **depth 条目（pos 4）按 depth 从末尾插入，且尊重 `entry.role`**（0=system/1=user/2=assistant）：`_ROLE_MAP`（:571–580，G6）。
- **skip_examples**：instruct 的 `skip_examples` 时不注入示例（:488，G7）。
- **两个 marker**：`[Example Chat]`（示例块）、`[Start a new Chat]`（历史首条）已加（:499 / :526）。
- **st-compat 跳过 Palink 特有内容**：状态栏指令、身份锁定、标题指令、最终提醒都被跳过（:2539 `if st_mode != "st-compat"`）。
- **面 B 的 SSE 契约**：OpenAI `data:` chunk + `[DONE]` 终止符（:2169–2174），与 ST 客户端解析一致。
- **面 B 的请求参数**：`temperature` / `top_p` / `max_tokens` / `frequency_penalty` / `presence_penalty` / `stream` / `logit_bias` / `stop` / `n` / `json_schema` 全部透传（:2125–2136）。
- **面 B 的非流式响应体**：`choices[0].message.content`（:2212）形状对齐。

---

## 2. 仍存在的差距（按严重程度 + 影响面归类）

### P1 — 影响面 A（服务端自建 st-compat prompt 的真缺口）

#### 【G14 残余】jailbreak 索引 11：角色卡 jailbreak 字段丢失 + 用户全局 jailbreak 未接入
> **订正**：jailbreak 字段来源由 `data.extensions.jailbreak` 订正为 `data.post_history_instructions`（ST 1.18.0 实际字段，`script.js:3361`）；V3 spec 允许 `data.extensions.jailbreak` 作为独立字段。

- **ST 行为**（`openai.js:1354` `jailbreakPromptOverride`、`:1496–1504`）：索引 11 的内容由「角色卡的 `post_history_instructions` 字段」（经 `jailbreakPromptOverride` 覆盖，需 `prefer_character_jailbreak=true`）与「用户全局 jailbreak 提示」共同驱动。默认 `default_jailbreak_prompt = ''`（`openai.js:103`）。
- **Palink 现状**：调用处 `build_st_compat_messages(..., jailbreak="", ...)` **硬编码空串**（`roleplay_prompt_assembly.py:2402`）。`build_st_compat_messages:584–595` 退而使用 `char.post_history_instructions`，再退 `context_template.jailbreak`。
- **偏差**：
  1. 角色卡自带的 `jailbreak` 字段**永远不进入索引 11**（被 `post_history_instructions` 错配替代）。
  2. 用户全局 jailbreak（ST 主界面 Jailbreak 框）**完全未接线**。
- **影响**：依赖角色卡 jailbreak 或用户全局 jailbreak 的角色，在 st-compat 模式下索引 11 为空或与 ST 不符。
- **修复方向**：调用处传入 `char.jailbreak`（角色卡高级定义字段）作为 `jailbreak` 参数；从 `UserSetting` 读取用户全局 jailbreak 并做合并（字符卡覆盖 / 追加，按 ST 的 override 语义）。

#### 【G13 残余】names_behavior / 群聊说话人名字：st-compat 完全不注入
- **ST 行为**（`openai.js:585–602`，CHAT 完成模式的 `character_names_behavior`）：
  - `NONE(-1)`：不加名字。
  - `DEFAULT(0)`：**默认**。仅当 `selected_group && name !== name1` 或 `force_avatar` 时，加 `Name: content` 前缀（narrator 除外）。
  - `COMPLETION(1)`：不在内容里前缀，而是给消息加 OpenAI `name` 字段（:948–950、:3743、:4034）。
  - `CONTENT`：总是加 `Name: content` 前缀（narrator 除外）。
  - （另有 INSTRUCT 模式的 `names_behavior` NONE/FORCE/ALWAYS，仅作用于 TEXT/指令模式，见 `instruct-mode.js:389–393`。）
- **Palink 现状**：`build_st_compat_messages` **没有任何 `names_behavior` 参数**，历史消息只输出 `role`/`content`，既不前缀 `Name:` 也不加 `name` 字段。
- **偏差澄清（对之前「审计有误/当前实现正确」的修正）**：在 **1 对 1 单角色**场景下，ST `DEFAULT` 同样不加名字（条件不满足），所以 Palink 靠「 omission 相同」碰巧一致——**但这不证明实现正确**。在 **群聊/多人角色扮演**（`selected_group` / `force_avatar`）场景下，ST 会加 `Name:` 前缀或 `name` 字段来消歧，而 Palink 缺失，LLM 无法区分多个说话人。
- **影响**：**群聊角色扮演是 ST 兼容的核心场景**，此处为实质性缺口。
- **修复方向**：给 `build_st_compat_messages` 增加 `names_behavior` + `is_group` + 每条历史消息的 `name` / `force_avatar` / `type`(narrator) 信息，按 ST 四态规则注入前缀或 `name` 字段。

#### 【订正】outlet（世界书 pos 7）：经后置 macro pass 解析，内容可达
> **订正说明**：原清单结论“outlet 内容丢失”是字面观察正确（`_sub` 不解析）但最终结论错误（未考虑后置 macro pass）。

- **ST 行为**：pos 7 世界书条目按 `outletName` 分组，通过 `{{outlet::name}}` 宏在任意角色字段中引用。
- **Palink 现状**：`build_st_compat_messages` 内部的 `_sub` 函数确实只替换 `{{char}}/{{user}}`，但 `roleplay_prompt_assembly.py:2602-2622` 在 st-compat 分支合并后**无条件**运行 `evaluate_macros_in_messages(messages, macro_env)`，且 `macro_env` 携带 `worldbook_outlets=wb_outlet_entries`（`wb_outlet_entries` 在 `_append_worldbook_context` 中无条件填充），所以 `{{outlet::name}}` 在 st-compat 模式下**会被解析**，outlet 内容**可达**。
- **结论**：此项目**不再是差距**。

#### 【新增】wi_format（世界书条目格式化）：未应用
- **ST 行为**（`openai.js:780–792` `formatWorldInfo`）：每个世界书条目内容用 `oai_settings.wi_format` 包裹（默认空串 = 不包裹；非空时 `stringFormat(format, value)`）。
- **Palink 现状**：`build_st_compat_messages` 中 before/after/depth 条目以**原始内容**插入（:434 / :457 / :577），无 wi_format 包裹。
- **影响**：默认 wi_format 为空时无差异；当用户设置了 `wi_format`（如 `[World Info: {0}]`）时，st-compat 与 ST 不符。

#### 【新增】token 预算裁剪：st-compat 完全不裁剪
- **ST 行为**（`openai.js` reserveBudget / `TokenBudgetExceededError`）：浏览器端按 token 预算裁剪最旧消息 / 世界书 / 示例，保证不超上下文窗口。
- **Palink 现状**：st-compat 跳过重排（:2639 `if prompt_preset is not None and st_mode != "st-compat"`）和动态裁剪（:2649 `if st_mode != "st-compat"`），**仅** `recent_messages_budget` 按**条数**截断历史（:503–507）。无 token 估算、无世界书/示例预算裁剪。
- **影响**：长对话 + 大量世界书时可能超出模型上下文窗口导致报错；世界书/示例不会像 ST 那样被预算裁掉。
- **修复方向**：在 st-compat 路径引入 token 预算（至少对历史做 token 级裁剪；可选对世界书/示例做预算保护）。

### P2 — 影响面 A（细节 / 边缘场景）

#### 【新增】群聊专用件未覆盖（与 G13 同类，但独立项）
- `new_group_chat_prompt`：ST 群聊用 `oai_settings.new_group_chat_prompt` 作为 `[Start a new Chat]` 标记（:884），而非单聊的 `new_chat_prompt`；st-compat 仅用 `context_template.chat_start` 或默认（:412–416）。
- `group nudge`：ST 群聊注入 groupNudge 提示（:891–894）；st-compat 未注入。
- **影响**：群聊场景的起始标记与提示与 ST 不符。建议与 G13 一起作为「群聊完整性」一并修复。

#### 【新增】pin_examples 未尊重
- **ST 行为**（`openai.js:1328`、`power-user.js` `pin_examples`）：控制示例在 token 预算压力下是否被保留（置顶）。默认 false（示例可被裁剪）；true 时示例总保留。
- **Palink 现状**：st-compat 总注入示例（若有且 `skip_examples=False`），因本身不裁剪，等价于 `pin_examples=true`，与默认（false）语义相反——但结果是「示例更全」而非「缺失」，故优先级低。

#### 【可选】scenario_format / personality_format
- **ST 行为**（`openai.js:1359–1360`）：用 `oai_settings.scenario_format` / `personality_format` 包裹 scenario / personality 字段。
- **Palink 现状**：直接插入原始字段（:446–450）。若用户设置了格式串则有差异。需确认是否纳入 st-compat 范围。

---

## 3. 面 B 现状（ST 原生客户端连接 Palink）—— 已基本对齐

面 B 的兼容性与 `build_st_compat_messages` 无关，仅取决于 Palink 的推理透传层。已核对项：

- ✅ SSE：`data:` OpenAI chunk + `data: [DONE]\n\n`（`silly_tavern.py:2169–2174`）。
- ✅ 请求体：`messages` / `temperature` / `top_p` / `max_tokens` / `frequency_penalty` / `presence_penalty` / `stream` / `logit_bias` / `stop` / `n` / `json_schema`（:2125–2136）全部透传。
- ✅ 响应体（非流式）：`object/chat.completion` + `choices[0].message.content` + `usage`（:2207–2218）。
- ✅ 模型路由：`_resolve_chat_completion_source` 选择原生适配器（openai/claude/google/mistral 等），ST 客户端自带已装配 messages，Palink 透传。

⚠️ **需核对（不在 prompt 差距范围，但属连接层）**：ST 后端连接还依赖模型列表/可用性端点（如 `/api/backends/list`、模型健康检查）。这些属于连接层而非角色扮演 prompt 装配，建议作为独立核对项，不计入本清单的 prompt 差距。

---

## 4. 工程验证缺口（比代码更关键）

- **st-compat 路径从未在运行时执行过 golden vector 测试**：此前所有「已修复」结论均来自**静态代码审查**。需要 Docker 启动 + 真实请求 `silly_tavern_mode=st-compat` 的端到端验证。
- **golden vector 必须来自 ST 真实输出**：应以 ST 浏览器端 `PromptManager` 的真实装配结果为基准，逐字节与 Palink `build_st_compat_messages` 输出 diff。**不能**用 Palink 自身预期当 golden（否则只是自洽，不是真兼容）。
- **缺少离线比对工具**：尚无把 ST 浏览器端导出输出与 Palink 输出 diff 的脚本。建议补一个。
- 重点关注 P1 四项（G14 jailbreak、G13 群聊名字、outlet、wi_format）在真实请求下的逐条比对。

---

## 5. 优先级小结

| 优先级 | 项 | 影响面 | 一句话 |
|---|---|---|---|
| **P1** | G14 jailbreak 丢失 | A | 角色卡 jailbreak + 用户全局 jailbreak 未进索引 11 |
| **P1** | G13 群聊名字 | A | 群聊/force_avatar 缺失说话人消歧（1对1 碰巧一致） |
| **P1** | outlet (pos 7) | A | `{{outlet::name}}` 不解析、pos7 条目丢失 |
| **P1** | wi_format | A | 世界书条目未按 wi_format 包裹 |
| **P1** | token 预算裁剪 | A | st-compat 只按条数截历史，无 token 预算 |
| **P2** | 群聊 new_group_chat_prompt / group nudge | A | 群聊起始标记与提示不符 |
| **P2** | pin_examples | A | 示例总注入（等价于 pin=true），与默认语义相反（结果更全，低危） |
| **P2** | scenario/personality_format | A | 格式串未应用（可选纳入） |
| **已对齐** | 面 B API 契约 / 装配序 / 世界书前后 / persona / 作者备注 5 态 / 标记 | B + A | G1–G15 已修复项不再计为差距 |

**行动建议**：先做 P1 的 G14 + G13（群聊是 ST 兼容核心场景，jailbreak 是高频字段），再补 outlet/wi_format，最后做 token 预算。所有改动后必须通过「Docker + 真实 ST 输出 golden vector」端到端验证，而非仅靠静态审查声称完成。
