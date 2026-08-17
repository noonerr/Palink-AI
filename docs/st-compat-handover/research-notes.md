# ST-Compat Prompt 装配最终对齐 - 研究记忆（必读）

> **用途**: 本文件记录三路并行深度研究的所有关键发现，是 spec.md / tasks.md / checklist.md 的事实依据。
> **接手人务必先读本文件**，理解每项差距的代码位置、ST 1.18.0 对照、清单订正理由。

---

## 一、Palink 现有代码核对结果

### 1.1 `build_st_compat_messages` 函数位置（重要澄清）

- **定义**: `backend/app/services/character_message_builder.py:345-605`
- **调用**: `backend/app/services/roleplay_prompt_assembly.py:2390-2425`

清单第 0 节已注明双文件结构，但 spec 中行号引用需注意区分。

### 1.2 完整签名（修复前）

```python
def build_st_compat_messages(
    db, char, user_nickname, session_id, branch_id, message, images,
    system_prompt_override, world_info_before, world_info_after,
    persona_description, jailbreak, authors_note, authors_note_depth,
    dynamic_context_parts, prompt_lang, user_setting,
    _replace_placeholders, _get_full_branch_history, _contains_chinese,
    normalize_image_url, include_user_message=True,
    token_budget: int = 4096,
    context_template=None,
    recent_messages_budget=None,
    worldbook_depth_entries=None,  # G6
    authors_note_position: int = 0,  # G3
    worldbook_em_top=None,  # G5
    worldbook_em_bottom=None,  # G5
    skip_examples: bool = False,  # G7
    worldbook_an_top=None,  # G4
    worldbook_an_bottom=None,  # G4
) -> List[Dict[str, Any]]:
```

**缺失的参数**（与清单 P1/P2 全部吻合）：
- `names_behavior` / `is_group` / `user_name` / `narrator_type`
- `wi_format` / `scenario_format` / `personality_format`
- `pin_examples` / `new_group_chat_prompt` / `group_nudge`
- `worldbook_outlet`（其实不需要，见 1.7）

### 1.3 Jailbreak 索引 11 处理（character_message_builder.py:584-595）

```python
584     # --- Index 11: jailbreak / post-history instructions (system) ---
585     jailbreak_content = ""
586     if jailbreak and jailbreak.strip():
587         jailbreak_content = _sub(jailbreak.strip())
588     elif char.post_history_instructions and char.post_history_instructions.strip():
589         jailbreak_content = _sub(char.post_history_instructions.strip())
590     if context_template is not None:
591         tmpl_jb = (getattr(context_template, "jailbreak", None) or "").strip()
592         if tmpl_jb:
593             jailbreak_content = _sub(tmpl_jb)  # ← BUG: 覆盖了 char.post_history_instructions
594     if jailbreak_content:
595         messages.append({"role": "system", "content": jailbreak_content})
```

**Bug**: 第 590-593 行的 `context_template.jailbreak` 会**覆盖** `char.post_history_instructions`，与 ST 1.18.0 语义不符。修复时需删除此覆盖逻辑。

### 1.4 调用处 jailbreak 硬编码（roleplay_prompt_assembly.py:2390-2425）

```python
2390     messages = build_st_compat_messages(
2391         db=db,
2392         char=req.char,
...
2402         jailbreak="",          # ← 硬编码空串
...
2425     )
```

### 1.5 作者备注 5 态处理（已对齐，但 ST 实际只有 3 态）

- position 0（in-story depth）: `character_message_builder.py:560-564`
- position 1（after-post-history）: `:597-599`
- position 2（last-in-chat）: `:601-603`
- position 3（inactive）: 调用处 `roleplay_prompt_assembly.py:2403` `an_text if author_note_position_int != 3 else ""`
- position 4（top-of-chat）: `:481-483`

**清单订正**: ST 1.18.0 `authors-note.js:81-88` 实际只有 3 态（0=after scenario / 1=in chat at depth / 2=before scenario）。Palink 的 5 态是 Palink 扩展设计，功能上是 ST 3 态的超集，不视为差距。

### 1.6 世界书 before/after/depth 处理（已对齐，但缺 wi_format）

- before（pos 0）: `:432-434` `messages.append({"role": "system", "content": world_info_before.strip()})`
- after（pos 1）: `:455-457`
- depth（pos 4）: `:568-580` 按 depth 从末尾插入，尊重 `_ROLE_MAP = {0: "system", 1: "user", 2: "assistant"}`

**差距**: 三处插入均为**原始内容**，无 `wi_format` 包裹。

### 1.7 `{{outlet::name}}` 宏（清单结论错误，需订正）

**清单 P1 outlet 项原文**："st-compat 路径用的 `_sub`（:403–409）只替换 `{{char}}/{{user}}`，不解析 `{{outlet::name}}`"

**字面观察正确**：`character_message_builder.py:403-409` 的 `_sub` 函数确实只替换三个宏。

**但最终结论错误**：`roleplay_prompt_assembly.py:2602-2622` 在 st-compat 分支合并后**无条件**运行 `evaluate_macros_in_messages(messages, macro_env)`：

```python
2602     macro_env = MacroEnv(
2603         db=db,
...
2613         worldbook_outlets=wb_outlet_entries,   # ← pos 7 outlet 字典被传入
...
2620     )
2621     messages = evaluate_macros_in_messages(messages, macro_env)
```

且 `wb_outlet_entries` 在 `_append_worldbook_context`（roleplay_prompt_assembly.py:2909-2916）中**无条件填充**（不区分 st_mode），来源是 `wb_result.outlet_entries`（worldbook_service.py:1199-1201 构建 pos 7 条目）。

`macro_service.py:382-387` 已实现 `{{outlet::name}}` 宏：
```python
382     if cmd == "outlet" and args:
383         outlet_name = next((a.strip() for a in args if a.strip()), "")
384         if outlet_name:
385             entries = env.worldbook_outlets.get(outlet_name, [])
386             return "\n".join(entries) if entries else ""
387         return ""
```

**结论**：`{{outlet::name}}` 在 st-compat 模式下**会被后置 macro pass 解析**，outlet 内容**不会丢失**。此项目不再是差距，仅需订正清单。

### 1.8 历史消息构建（character_message_builder.py:528-544）

```python
for m in history:
    # ... ignore 标记处理 ...
    msg_content = m.content or ""
    if m.role == "assistant":
        msg_content = re.sub(r"<think[\s\S]*?</think\s*>", "", msg_content, flags=re.IGNORECASE).strip()
        # ...
    history_messages.append({"role": m.role, "content": msg_content})  # ← 仅 role + content
```

**差距**: 仅输出 `role` + `content`，没有 `name`、没有 `force_avatar`、没有 `type`（narrator）。

但 `CharacterChatMessage` 表（character.py:92-127）**已有 `name` 字段**（:112）和 `extra` JSON 字段，存储了 `force_avatar` / `type` 等信息（character_ext.py:190-224 的 `_ST_MESSAGE_EXTRA_FIELDS`）。修复时直接读取即可。

### 1.9 Token 预算裁剪（character_message_builder.py:503-507）

```python
503     history_limit = (
504         recent_messages_budget
505         if (isinstance(recent_messages_budget, int) and recent_messages_budget > 0)
506         else settings.CHARACTER_CHAT_HISTORY_LIMIT
507     )
```

**纯条数截断**，无 token 级裁剪。签名中的 `token_budget: int = 4096`（:368）在函数体内**未被使用**。

### 1.10 st-compat 跳过重排与裁剪（roleplay_prompt_assembly.py:2638-2654）

```python
2638     # G12 修复: st-compat 跳过重排
2639     if prompt_preset is not None and st_mode != "st-compat":
2640         messages, prompt_sources = _apply_full_prompt_order(...)
2641
2648     # G8/G12 修复: st-compat 跳过基于标识符的裁剪和重排
2649     if st_mode != "st-compat":
2650         messages, total_tokens_estimate = _apply_dynamic_trimming(...)
2651     else:
2652         total_tokens_estimate = sum(s.token_count for s in prompt_sources)
```

**修复方向**: 仍跳过 `_apply_full_prompt_order`（装配序由 builder 固定），但启用 chat_history token 裁剪子集。

### 1.11 `dynamic_context_parts` 被丢弃（D10）

`build_st_compat_messages` 签名第 360 行声明 `dynamic_context_parts: List[str]` 参数，但**函数体内 0 处使用**（grep 验证）。

后果：memory/plotline/Palink 注入等内容在 st-compat 模式下**完全不进入 prompt**。这不是清单列出的差距，但是实际影响 st-compat 模式功能完整性的重要问题。

---

## 二、ST 1.18.0 源码对照结果

### 2.1 源码位置

**完整官方源码**: `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\`

关键文件：
- `openai.js` — 核心装配逻辑
- `world-info.js` — WI 扫描 + outlet
- `personas.js` — Persona 6 态 position
- `authors-note.js` — Author's Note 3 态
- `PromptManager.js` — 默认 prompt order
- `macros.js` — `{{outlet::name}}` 宏注册
- `script.js` — 主脚本（含 `getCharacterCardFieldsLazy`）
- `constants.js` — `inject_ids.CUSTOM_WI_OUTLET`

### 2.2 `character_names_behavior` 四态（openai.js:204-209）

```js
const character_names_behavior = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};
```

四态处理逻辑（openai.js:586-603）：
```js
switch (oai_settings.names_behavior) {
    case character_names_behavior.NONE:           // -1
        break;
    case character_names_behavior.DEFAULT:        // 0
        if ((selected_group && chat[j].name !== name1)
            || (chat[j].force_avatar && chat[j].name !== name1
                && chat[j].extra?.type !== system_message_types.NARRATOR)) {
            content = `${chat[j].name}: ${content}`;
        }
        break;
    case character_names_behavior.CONTENT:        // 2
        if (chat[j].extra?.type !== system_message_types.NARRATOR) {
            content = `${chat[j].name}: ${content}`;
        }
        break;
    case character_names_behavior.COMPLETION:     // 1
        break;  // 改用 message.name 字段
}
```

**DEFAULT 触发条件**：
- 条件 A: `selected_group && chat[j].name !== name1`（群聊且非用户消息）
- 条件 B: `chat[j].force_avatar && chat[j].name !== name1 && chat[j].extra?.type !== NARRATOR`（强制头像且非用户且非叙述者）
- 满足任一即拼 `Name: content`

### 2.3 message 的 `name` 字段注入（COMPLETION 模式）

- **chatHistory 装配**: `openai.js:948-950` `chatMessage.setName(messageName)`
- **continue prefill**: `openai.js:1319` `continueMessage.setName(sanitizeName(chatMessage.name))`
- **dialogue examples**: `openai.js:1110-1112` 无条件 `setName`（dialogue 必须用 name 区分角色）
- **MessageCollection.getChat()**: `openai.js:3737-3751` 用 spread 条件注入 `name`
- **ChatCompletion.getChat()**: `openai.js:4025-4046` 同样用 spread

### 2.4 `formatWorldInfo` 与 `wi_format`（openai.js:780-792）

```js
export function formatWorldInfo(value, { wiFormat = null } = {}) {
    if (!value) return '';
    const format = wiFormat ?? oai_settings.wi_format;
    if (!format.trim()) return value;
    return stringFormat(format, value);
}
```

- 默认 `wi_format = '{0}'`（openai.js:106）
- 空 format（trim 后）返回原值
- 非空 format 用 `stringFormat` 套模板

### 2.5 `new_group_chat_prompt` + group nudge（openai.js:883-894）

```js
const newChat = selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt;
const newChatMessage = await Message.createAsync('system', substituteParams(newChat), 'newMainChat');
chatCompletion.reserveBudget(newChatMessage);

let groupNudgeMessage = null;
const noGroupNudgeTypes = ['impersonate'];
if (selected_group && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
    groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'));
    chatCompletion.reserveBudget(groupNudgeMessage);
}
```

默认值：
- `default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]'`（openai.js:108）
- `default_group_nudge_prompt = '[Write the next reply only as {{char}}.]'`（openai.js:114）

### 2.6 `pin_examples`（openai.js:1327-1334）

```js
if (power_user.pin_examples) {
    await populateDialogueExamples(prompts, chatCompletion, messageExamples);
    await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
} else {
    await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
    await populateDialogueExamples(prompts, chatCompletion, messageExamples);
}
```

- `pin_examples=true`: 先装 examples（保预算），后装 history（可能被裁）
- `pin_examples=false`: 先装 history（保预算），后装 examples（可能被裁）

### 2.7 `scenario_format` / `personality_format`（openai.js:1359-1360）

```js
const scenarioText = scenario && oai_settings.scenario_format
    ? substituteParams(oai_settings.scenario_format)
    : (scenario || '');
const charPersonalityText = charPersonality && oai_settings.personality_format
    ? substituteParams(oai_settings.personality_format)
    : (charPersonality || '');
```

默认值：
- `default_scenario_format = '{{scenario}}'`（openai.js:112）
- `default_personality_format = '{{personality}}'`（openai.js:113）

### 2.8 索引 11 jailbreak 装配（openai.js:1495-1506）

```js
// Apply character-specific jailbreak
const jailbreakPrompt = prompts.get('jailbreak') ?? null;
const isJailbreakPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('jailbreak');
if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
    const jbOriginalContent = jailbreakPrompt.content;
    jailbreakPrompt.content = jailbreakPromptOverride;
    const jbReplacement = promptManager.preparePrompt(jailbreakPrompt, jbOriginalContent);
    prompts.override(jbReplacement, prompts.index('jailbreak'));
}
```

**覆盖条件**（4 个 AND）：
1. `jailbreakPromptOverride` 非空（来自角色卡）
2. `jailbreakPrompt` 存在（preset 里有 jailbreak 条目）
3. `jailbreakPrompt.forbid_overrides !== true`
4. `!isJailbreakPromptDisabled`

### 2.9 Jailbreak 字段来源（清单订正：不是 data.extensions.jailbreak）

**清单原描述**: "角色卡 `data.extensions.jailbreak`"

**实际 ST 1.18.0**: `script.js:3359-3362` `getCharacterCardFieldsLazy`：
```js
jailbreak: () => {
    if (!character) return '';
    return power_user.prefer_character_jailbreak
        ? baseChatReplace(character.data?.post_history_instructions?.trim())
        : '';
},
```

**字段是 `character.data.post_history_instructions`，不是 `data.extensions.jailbreak`**。ST 历史上 jailbreak override 字段就是 PHI（post_history_instructions）。

**V3 spec 允许**: `data.extensions.jailbreak` 作为独立字段（但 ST 1.18.0 默认不读取，需要 V3 卡 spec 兼容）。

**决策优先级**：
1. 角色卡 `data.post_history_instructions`（需 `prefer_character_jailbreak=true`）→ `jailbreakPromptOverride`
2. preset jailbreak 内容（用户全局）→ `jailbreakPrompt.content`
3. `default_jailbreak_prompt = ''`（空字符串）

### 2.10 默认 prompt order（PromptManager.js:2086-2136）

| 索引 | identifier | enabled |
|------|-----------|---------|
| 0 | main | true |
| 1 | worldInfoBefore | true |
| 2 | **personaDescription** | true |
| 3 | charDescription | true |
| 4 | charPersonality | true |
| 5 | scenario | true |
| 6 | enhanceDefinitions | false |
| 7 | nsfw | true |
| 8 | worldInfoAfter | true |
| 9 | dialogueExamples | true |
| 10 | chatHistory | true |
| 11 | **jailbreak** | true |

### 2.11 `world_info_position` 枚举（world-info.js:855-864）

```js
export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,  // ← 1.18 新增
};
```

### 2.12 outlet 分组逻辑（world-info.js:5129-5140）

```js
case world_info_position.outlet: {
    if (!entry.outletName) {
        console.warn(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
        break;
    }
    if (Array.isArray(WIOutletEntries[entry.outletName])) {
        WIOutletEntries[entry.outletName].push(content);
    } else {
        WIOutletEntries[entry.outletName] = [content];
    }
    break;
}
```

### 2.13 outlet 的下游消费（script.js:4614-4618）

```js
if (outletEntries && typeof outletEntries === 'object' && Object.keys(outletEntries).length > 0) {
    Object.entries(outletEntries).forEach(([key, value]) => {
        setExtensionPrompt(
            inject_ids.CUSTOM_WI_OUTLET(key),
            value.join('\n'),
            extension_prompt_types.NONE,    // ← NONE = -1，不自动注入
            0
        );
    });
}
```

**关键**: outlet 用 `extension_prompt_types.NONE`（-1）注册，**不自动注入**，必须通过 `{{outlet::name}}` 宏显式拉取。

### 2.14 `{{outlet::name}}` 宏（macros.js:597-600 + 668）

```js
function getOutletPrompt(key) {
    const value = extension_prompts[inject_ids.CUSTOM_WI_OUTLET(key)]?.value;
    return value || '';
}

// 注册为内建正则宏
{ regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => getOutletPrompt(key.trim()) || '' },
```

### 2.15 Persona 6 态（personas.js:88-98）

```js
export const persona_description_positions = {
    IN_PROMPT: 0,
    AFTER_CHAR: 1,  // deprecated
    TOP_AN: 2,
    BOTTOM_AN: 3,
    AT_DEPTH: 4,
    NONE: 9,
};
```

默认 `persona_description_position: persona_description_positions.IN_PROMPT`（power-user.js:291）。

### 2.16 Author's Note 3 态（authors-note.js:81-88）— 清单订正

```js
const validPositions = {
    'after': 0,           // after scenario
    'scenario': 0,        // alias
    'chat': 1,            // in chat at depth
    'before_scenario': 2, // before scenario
    'before': 2,          // alias
};
```

**ST 1.18.0 实际只有 3 态**（0/1/2），不是清单所述的 5 态。

### 2.17 `TokenBudgetExceededError`（openai.js:3397-3403）

```js
class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);  // ← 原文拼写错误 "budged"
        this.name = 'TokenBudgetExceeded';
    }
}
```

`reserveBudget`（openai.js:4115-4118）:
```js
reserveBudget(message) {
    const tokens = typeof message === 'number' ? message : message.getTokens();
    this.decreaseTokenBudgetBy(tokens);
}
```

捕获点（openai.js:1578-1582）:
```js
} catch (error) {
    if (error instanceof TokenBudgetExceededError) {
        toastr.error(t`Mandatory prompts exceed the context size.`);
        promptManager.error = t`Not enough free tokens for mandatory prompts. Raise your token limit or disable custom prompts.`;
    }
```

---

## 三、Palink 群聊与 Token 预算系统核对

### 3.1 GroupChat / GroupChatSession 模型（backend/app/models/group_chat.py）

`GroupChat` 字段：
```
id, user_id, name, description, avatar, member_ids(JSON Text),
allow_self_responses, activation_strategy, generation_mode,
disabled_members, chat_metadata, member_profiles, author_note,
recent_messages_budget(Integer default=20),
active_members, follower_members, created_at, updated_at
```

`GroupChatSession` 字段：
```
id, group_id, user_id, title, messages(Text JSON), avatars(Text JSON),
created_at, updated_at
```

### 3.2 `assemble_roleplay_prompt` 在群聊场景的调用路径（D8 关键发现）

三个主聊天调用点**均未传入 `group_id`**：

| 调用点 | 文件:行号 | 是否传 group_id |
|---|---|---|
| HTTP `/api/character-chat` | `character_ext.py:4101-4130` | **否** |
| WebSocket 流式聊天 | `websocket.py:1403-1431` | **否** |
| ST swipe 流式生成 | `silly_tavern.py:3423-3447` | **否** |

`CharacterChatRequest` 模型（character_ext.py:3732-3756）**完全没有 `group_id` 字段**。

`PromptAssemblyRequest` 数据类**有** `group_id` / `current_speaker_id` 字段（roleplay_prompt_assembly.py:376-377），`assemble_roleplay_prompt` 内部有完整群聊分支：
- `_resolve_group_speaker` (roleplay_prompt_assembly.py:1607-1692)：TALKATIVE/VOTING 算法
- `_build_group_profile_context` (roleplay_prompt_assembly.py:1694-1814)：发言者 profile 注入
- `group_recent_budget` 读取 (roleplay_prompt_assembly.py:2336-2367)

**结论**: 由于主聊天流不传 `group_id`，上述群聊分支在主聊天路径中**实际是 dead code**。`character_ext.py:2800-2900` 中那 6 处 `group_id=req.group_id` 都是写入消息 `extra` 字段（持久化），不是用于 prompt 装配。

### 3.3 Token 估算代码（roleplay_prompt_assembly.py:430-451）

```python
def _estimate_tokens(text: str) -> int:
    global _count_tokens_fn
    if _count_tokens_fn is None:
        try:
            from ..api.tokenizer import count_tokens as _count_tokens_fn
        except Exception:
            _count_tokens_fn = _local_estimate_tokens
    return _count_tokens_fn(str(text or ""))

def _local_estimate_tokens(text: str) -> int:
    value = str(text or "")
    chinese_chars = len([ch for ch in value if "\u4e00" <= ch <= "\u9fff"])
    english_words = len(value.split())
    return chinese_chars * 2 + english_words
```

后端用 tiktoken（无 transformers），见 `backend/app/api/tokenizer.py`。

### 3.4 `_apply_token_budget`（roleplay_prompt_assembly.py:1024-1063）

对 `dynamic_context_parts`（memory/worldbook/plotline 等）做 token 级裁剪。在 line 2314 调用，**对所有路径（含 st-compat）都执行**。

但 `build_st_compat_messages` 接收 `dynamic_context_parts` 参数后**函数体内未使用**（D10），所以 st-compat 路径下 `_apply_token_budget` 对 `dynamic_context_parts` 的裁剪**不影响最终输出**（被丢弃）。

### 3.5 `_apply_dynamic_trimming`（roleplay_prompt_assembly.py:891-944）

对最终 `messages` 按优先级裁剪。**st-compat 跳过**（line 2649）。

### 3.6 UserSetting 字段全列表（backend/app/models/system.py:14-62）

```
id, user_id, show_model_reasoning, developer_mode, memory_mode, memory_model,
prompt_language, character_display_mode, author_note, author_note_position,
author_note_frequency, author_note_depth,
custom_chat_prompt_zh, custom_chat_prompt_en,
custom_character_prompt_zh, custom_character_prompt_en, use_custom_prompts,
show_character_status, auto_generate_chat_images,
silly_tavern_mode, silly_tavern_theme, silly_tavern_settings,
active_persona_id, power_user(Text JSON), ui_settings(Text JSON),
instruct_enabled, instruct_template_id
```

**无 `jailbreak` 字段**。`power_user` 是 Text JSON，存储 ST 1.18.0 完整 `power_user` 对象。

### 3.7 Character 字段全列表（backend/app/models/character.py:10-49）

```
id, user_id, name, description, background, personality, avatar,
created_at, updated_at, scenario, first_mes, mes_example, system_prompt,
tags, creator, character_version, extensions(Text JSON), user_nickname,
is_processing, processing_status, preset_data, alternate_greetings,
creator_notes, post_history_instructions(Text), ui_config,
raw_card_spec_version, assets, talkativeness, nickname, group_only_greetings
```

**无 `jailbreak` 字段**。仅有 `post_history_instructions`。

### 3.8 CharacterChatMessage 字段（character.py:92-127，重要）

**已有 `name` 字段**（:112）！但 `build_st_compat_messages:528-544` 构建历史时**没有读取** `m.name`。

`extra` JSON 字段存储 `force_avatar` / `type` 等信息（character_ext.py:190-224 的 `_ST_MESSAGE_EXTRA_FIELDS`）。

**这是 G13 群聊修复可直接利用的现成数据源**。

### 3.9 `{{charjailbreak}}` 宏死代码（macro_service.py:310-312，D9）

```python
if name_lower == "charjailbreak":
    # jailbreak_prompt 是 Palink Character 模型中对应 ST jailbreak_prompt 的字段
    return getattr(char, "jailbreak_prompt", None) if char else None
```

**注释错误**: `Character` 模型无 `jailbreak_prompt` 字段，宏永远返回 None。

修复：改为 `getattr(char, "jailbreak", None)`，读取本 spec Phase 1 新增的 `Character.jailbreak` 字段。

### 3.10 现有测试覆盖

| 文件 | 测试范围 |
|---|---|
| `backend/tests/test_author_note_position.py` | `assemble_roleplay_prompt` author_note position 0-4（**非 st-compat 路径**） |
| `backend/tests/test_st_contract.py` | ST API 契约（路由、群聊 CRUD、JSONL 导出格式） |
| `backend/tests/test_st_import_export_roundtrip.py` | 角色卡/聊天 JSONL 导入导出往返 |
| `backend/tests/test_worldbook_st_semantics.py` | 世界书语义 |
| `backend/tests/test_worldbook_em_outlet.py` | 世界书 EM/outlet |

**`test_st_compat_*.py` / `test_build_st_compat_messages.py` 均不存在**。

`build_st_compat_messages` 全后端仅在两处被引用（定义 + 调用），**无任何测试直接调用**。

**全后端 grep "golden" 0 命中**。无 golden vector 测试，无 ST 输出 diff 工具。

---

## 四、清单订正汇总（3 项）

| 清单项 | 清单原描述 | 实际行为 | 修正动作 |
|--------|----------|---------|---------|
| outlet (pos 7) | "st-compat 不解析 `{{outlet::name}}`、outlet 内容丢失" | `roleplay_prompt_assembly.py:2602-2622` 后置 macro pass **无条件**解析 `{{outlet::name}}`，`wb_outlet_entries` 已填充 | 清单订正为「字面观察正确，最终结论错误，outlet 实际可达」；**不修复**，仅订正清单 |
| G14 jailbreak 来源 | "角色卡 `data.extensions.jailbreak`" | ST 1.18.0 实际是 `character.data.post_history_instructions`（`script.js:3361`） | 清单订正；修复时以 `char.post_history_instructions` 为角色卡 jailbreak 来源；V3 spec 允许 `data.extensions.jailbreak` 作为独立字段 |
| 作者备注 5 态 | "ST 1.18.0 作者备注 position 0/1/2/3/4 五态" | ST 1.18.0 `authors-note.js:81-88` 实际只有 **3 态**（0=after scenario / 1=in chat at depth / 2=before scenario） | 清单订正；Palink 现有 5 态是 Palink 扩展，保留不动 |

---

## 五、新发现差距汇总（3 项，清单未提及）

### 5.1 D8 群聊装配路径断裂

**位置**: `character_ext.py:3732-3756` `CharacterChatRequest` 无 `group_id` 字段

**影响**: `assemble_roleplay_prompt` 内的群聊分支（`_resolve_group_speaker` / `_build_group_profile_context` / `group_recent_budget`）成为 dead code，主聊天流根本不会触发群聊分支。

**把握度**: 95%（基于调用链分析）

**修复**: `CharacterChatRequest` 新增 `group_id` + `current_speaker_id` 字段，三个调用点透传。

### 5.2 D9 `{{charjailbreak}}` 宏死代码

**位置**: `macro_service.py:310-312` `getattr(char, "jailbreak_prompt", None)` 但 `Character` 模型无此字段

**影响**: 宏永远返回 None，注释声称"Palink Character 模型中对应 ST jailbreak_prompt 的字段"是错误描述。

**把握度**: 100%（grep + 代码阅读直接证据）

**修复**: 改为 `getattr(char, "jailbreak", None)`，与 Phase 1 新增的 `Character.jailbreak` 字段配合。

### 5.3 D10 `dynamic_context_parts` 在 st-compat 路径被丢弃

**位置**: `character_message_builder.py:360` 参数声明 vs 函数体 0 处使用（grep 验证）

**影响**: st-compat 路径下 memory/plotline/Palink 注入等内容**完全不进入 prompt**。

**把握度**: 100%（grep + 代码阅读直接证据）

**修复**: 在 `build_st_compat_messages` 函数体内 jailbreak 之后、chatHistory 之前注入 `dynamic_context_parts` 拼接的 system 消息。

---

## 六、ST 1.18.0 关键源码位置速查

| 功能 | 文件 | 行号 |
|------|------|------|
| `default_jailbreak_prompt = ''` | `openai.js` | 103 |
| `character_names_behavior` 枚举 | `openai.js` | 204-209 |
| `character_names_behavior` 四态处理 | `openai.js` | 586-603 |
| `formatWorldInfo` / `wi_format` | `openai.js` | 780-792 |
| `default_wi_format = '{0}'` | `openai.js` | 106 |
| `new_group_chat_prompt` + group nudge | `openai.js` | 883-894 |
| `default_new_group_chat_prompt` | `openai.js` | 108 |
| `default_group_nudge_prompt` | `openai.js` | 114 |
| chatHistory `setName`（COMPLETION） | `openai.js` | 948-950 |
| dialogue examples `setName` | `openai.js` | 1110-1112 |
| continue prefill `setName` | `openai.js` | 1319 |
| `pin_examples` 控制 | `openai.js` | 1327-1334 |
| `scenario_format` / `personality_format` | `openai.js` | 1359-1360 |
| `default_scenario_format` / `default_personality_format` | `openai.js` | 112-113 |
| `jailbreakPromptOverride` JSDoc | `openai.js` | 1354 |
| `preparePromptsForChatCompletion` 函数定义 | `openai.js` | 1358 |
| 索引 11 jailbreak 覆盖逻辑 | `openai.js` | 1495-1506 |
| `TokenBudgetExceededError` 捕获 | `openai.js` | 1578-1582 |
| `MessageCollection.getChat()` name 字段注入 | `openai.js` | 3737-3751 |
| `TokenBudgetExceededError` 类 | `openai.js` | 3397-3403 |
| `ChatCompletion.getChat()` name 字段注入 | `openai.js` | 4025-4046 |
| `checkTokenBudget` | `openai.js` | 4104-4108 |
| `reserveBudget` | `openai.js` | 4115-4118 |
| `world_info_position` 枚举（含 outlet=7） | `world-info.js` | 855-864 |
| outlet 分组逻辑 | `world-info.js` | 5129-5140 |
| outlet 返回值结构 | `world-info.js` | 5162 |
| outlet 字段 schema | `world-info.js` | 4028 |
| outlet 序列化到 lorebook | `world-info.js` | 3617 |
| outlet 角色卡加载 | `world-info.js` | 5528 |
| `persona_description_positions` 6 态 | `personas.js` | 88-98 |
| persona 默认 position=IN_PROMPT | `power-user.js` | 291 |
| persona IN_PROMPT 注入 | `openai.js` | 1424-1426 |
| persona TOP_AN/BOTTOM_AN/AT_DEPTH 注入 | `script.js` | 3144-3166 |
| author's note 3 态 validPositions | `authors-note.js` | 81-88 |
| author's note 默认 depth=4, position=1 | `authors-note.js` | 272-273 |
| author's note 注入主流程 | `authors-note.js` | 351-391 |
| author's note 在 openai.js 装配 | `openai.js` | 1388-1395 |
| `extension_prompt_types` 4 态 | `script.js` | 483-488 |
| `getCharacterCardFieldsLazy` jailbreak 来源 | `script.js` | 3359-3362 |
| jailbreak 传给 prepareOpenAIMessages | `script.js` | 5240 |
| outlet 下游消费（注册 extension_prompt） | `script.js` | 4614-4618 |
| `inject_ids.CUSTOM_WI_OUTLET` | `constants.js` | 55 |
| `getOutletPrompt` | `macros.js` | 597-600 |
| `{{outlet::name}}` 正则宏注册 | `macros.js` | 668 |
| `{{outlet::name}}` MacroRegistry 注册 | `macros/definitions/core-macros.js` | 449-468 |
| 默认 prompt order（索引 0-11） | `PromptManager.js` | 2086-2136 |

---

## 七、Palink 关键代码位置速查

| 功能 | 文件 | 行号 |
|------|------|------|
| `build_st_compat_messages` 定义 | `backend/app/services/character_message_builder.py` | 345-605 |
| `build_st_compat_messages` 调用 | `backend/app/services/roleplay_prompt_assembly.py` | 2390-2425 |
| jailbreak 硬编码 `jailbreak=""` | `roleplay_prompt_assembly.py` | 2402 |
| jailbreak 索引 11 处理（含 BUG） | `character_message_builder.py` | 584-595 |
| 历史消息构建（仅 role+content） | `character_message_builder.py` | 528-544 |
| 世界书 before 注入 | `character_message_builder.py` | 432-434 |
| 世界书 after 注入 | `character_message_builder.py` | 455-457 |
| 世界书 depth 注入 | `character_message_builder.py` | 568-580 |
| `recent_messages_budget` 条数截断 | `character_message_builder.py` | 503-507 |
| `_sub` 函数（仅 char/user 宏） | `character_message_builder.py` | 403-409 |
| st_mode 判定 | `roleplay_prompt_assembly.py` | 2371 |
| st-compat 跳过 `_apply_full_prompt_order` | `roleplay_prompt_assembly.py` | 2639 |
| st-compat 跳过 `_apply_dynamic_trimming` | `roleplay_prompt_assembly.py` | 2649 |
| 后置 macro pass（`evaluate_macros_in_messages`） | `roleplay_prompt_assembly.py` | 2602-2622 |
| `wb_outlet_entries` 无条件填充 | `roleplay_prompt_assembly.py` | 2909-2916 |
| `_append_worldbook_context` 调用 | `roleplay_prompt_assembly.py` | 2253 |
| `_estimate_tokens` | `roleplay_prompt_assembly.py` | 430-451 |
| `_apply_token_budget` | `roleplay_prompt_assembly.py` | 1024-1063 |
| `_apply_dynamic_trimming` | `roleplay_prompt_assembly.py` | 891-944 |
| `MacroEnv` 构造 | `macro_service.py` | 63-114 |
| `{{charjailbreak}}` 宏（死代码） | `macro_service.py` | 310-312 |
| `{{outlet::name}}` 宏（已实现） | `macro_service.py` | 382-387 |
| WI pos 7 outlet 构建 | `worldbook_service.py` | 1196-1201 |
| `WI_POS_OUTLET = 7` 常量 | `worldbook_service.py` | 65-68 |
| Character 模型（无 jailbreak 字段） | `backend/app/models/character.py` | 10-49 |
| `CharacterChatMessage.name` 字段（已存在） | `backend/app/models/character.py` | 112 |
| UserSetting 模型（无 jailbreak 字段） | `backend/app/models/system.py` | 14-62 |
| `ContextTemplate.jailbreak` 字段 | `backend/app/models/system.py` | 113 |
| `InstructTemplate.names_behavior` 字段 | `backend/app/models/system.py` | 216 |
| Persona 模型（含 persona_show / persona_description_position） | `backend/app/models/persona.py` | 11-27 |
| WorldBookStage 模型（含 outlet_name / role） | `backend/app/models/worldbook.py` | 37-104 |
| 角色卡导入 `convert_chara_card_to_character` | `backend/app/character_card.py` | 289-352 |
| `CharacterChatRequest`（无 group_id） | `backend/app/api/character_ext.py` | 3732-3756 |
| HTTP 调用点 | `backend/app/api/character_ext.py` | 4101-4130 |
| WebSocket 调用点 | `backend/app/api/websocket.py` | 1403-1431 |
| ST swipe 调用点 | `backend/app/api/silly_tavern.py` | 3423-3447 |
| `_ST_MESSAGE_EXTRA_FIELDS`（force_avatar/type 等） | `backend/app/api/character_ext.py` | 190-224 |
| `_resolve_group_speaker`（群聊 dead code） | `roleplay_prompt_assembly.py` | 1607-1692 |
| `_build_group_profile_context`（群聊 dead code） | `roleplay_prompt_assembly.py` | 1694-1814 |
| `group_recent_budget` 读取（群聊 dead code） | `roleplay_prompt_assembly.py` | 2336-2367 |
| `_select_talkative_speaker` | `roleplay_prompt_assembly.py` | 1331-1376 |
| Tokenizer API（tiktoken） | `backend/app/api/tokenizer.py` | 1-80 |

---

## 八、重要工程约定（前序 spec 沉淀）

1. **G1-G15 已对齐项作为基线**（来自 `st-core-parity-conservative` spec）：装配序、世界书 before/after、Persona 索引 2、角色字段分离、作者备注 5 态（Palink 扩展）、ANTop/ANBottom、EMTop/EMBottom、depth 条目 role、skip_examples、两个 marker、st-compat 跳过 Palink 特有内容、面 B SSE 契约等

2. **面 B 已基本对齐**（清单第 3 节）：SSE `data:` chunk + `[DONE]`、请求参数透传、非流式响应体形状、模型路由

3. **B-P0-1 角色卡宏已修复**（来自 `final-st-perfect-parity-deep-audit` spec）：`{{description}}` / `{{persona}}` / `{{mesExamples}}` 等角色卡宏已在 `macro_service.py:204-575` 实现

4. **不要修改前端**：本 spec 仅修改后端。前端修改需用户明确授权

5. **不要修改 `frontend/public/st/`**：面 B ST iframe 保护现状

6. **不要修改 `st_sync_service.py`**：DATA_ROOT 同步与面 A 无关

---

## 九、给接手人的关键建议

1. **先读本文件**，理解每项差距的代码位置和 ST 1.18.0 对照
2. **再读 spec.md 第一节"95%+ 把握的依据"**，理解把握度来源
3. **按 tasks.md Phase 顺序执行**，不要跳序
4. **Phase 0 Golden Vector 提取是关键**：必须从 ST 1.18.0 浏览器端真实导出，不能用 Palink 自身预期当 golden
5. **每完成一个 SubTask，立即勾选 checklist.md 对应项**
6. **遇到不确定的地方，对照 ST 1.18.0 源码**：位于 `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\`
7. **三个容易混淆的枚举**（务必区分）：
   - `extension_prompt_types`（script.js:483-488）: NONE(-1), IN_PROMPT(0), IN_CHAT(1), BEFORE_PROMPT(2) — 全局 extension prompt 位置
   - `world_info_position`（world-info.js:855-864）: before(0), after(1), ANTop(2), ANBottom(3), atDepth(4), EMTop(5), EMBottom(6), outlet(7) — WI 条目位置
   - `persona_description_positions`（personas.js:88-98）: IN_PROMPT(0), AFTER_CHAR(1), TOP_AN(2), BOTTOM_AN(3), AT_DEPTH(4), NONE(9) — Persona description 位置
   
   三者的 `2` 含义完全不同！
8. **jailbreak 字段来源链**（修复时务必正确）：
   - ST 1.18.0: `character.data.post_history_instructions`（`script.js:3361`）
   - **不是** `data.extensions.jailbreak`（清单原描述错误）
   - V3 spec 允许 `data.extensions.jailbreak` 作为独立字段
9. **outlet 的关键设计**（已确认 Palink 实现正确，不需修复）：
   - 用 `extension_prompt_types.NONE`(-1) 注册，**不自动注入**
   - 必须通过 `{{outlet::name}}` 宏显式拉取
   - 多个 outlet 条目按 `outletName` 分组，组内以 `\n` 连接
   - Palink 在 `roleplay_prompt_assembly.py:2621` 后置 macro pass 中已正确解析
10. **COMPLETION 模式关键细节**：
    - `setName` 会触发**重新计算 token**（openai.js:3506）
    - DEFAULT/CONTENT 模式下 name 拼到 content 里，最终 payload 中 message 无 `name` 字段
    - dialogue examples **始终**调用 setName（与 names_behavior 无关）
