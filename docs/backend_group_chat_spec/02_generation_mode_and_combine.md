# 模块 02：生成模式与角色卡合并（C1 + C2）

> 对应 gap 报告：C1 `generation_mode` 未读取 / C2 无 `combineGroupIntoSingleCard` 等价物
> 主文件：`backend/app/services/roleplay_prompt_assembly.py`、`character_message_builder.py`

---

## 0. 当前现状（已验证）

### `generation_mode` 仅存储，从未读取
- 模型 `group_chat.py:27` 有 `generation_mode = Column(Integer, default=0)`。
- `st_groups.py` 正确序列化（`:60`/`:150`）。
- **生成路径零引用**：`roleplay_prompt_assembly.py` 中 grep `generation_mode` → 无匹配。

### 当前"卡合并"做法（`_build_group_profile_context` `:1819`）
- 总是把**当前发言者** `description/personality` 注入为 `[当前发言者身份]`。
- 其他成员仅 `名称 + ≤120字摘要`。
- **不区分 SWAP/APPEND/APPEND_DISABLED**；不使用 `generation_mode_join_prefix/suffix`；不合并 `scenario/mes_example`。

### `build_st_compat_messages` 当前群处理 `:495-520`
```python
char_name = char.name or "Character"
def _sub(text):
    result = text.replace("{{char}}", char_name)
    result = text.replace("{{charIfNotGroup}}", char_name)   # ← D5 问题
    result = text.replace("{{user}}", user_nickname)
    return result
...
# 角色字段作为独立 system 消息注入（Index 3-5: description/personality/scenario）
if char.description: messages.append({"role":"system","content":_sub(char.description)})
if char.personality: messages.append({"role":"system","content": personality_text})
if char.scenario:    messages.append({"role":"system","content": scenario_text})
```
- 当前 `char` = `req.char`（前端选的角色），**不是**解析出的 `current_speaker`（D3 问题）。
- `group_profile_part`（含 member 身份）在 st-compat 分支被丢弃，改用 `char.system_prompt`（D1 问题，见模块 03）。

---

## 1. ST 行为基准（`group-chats.js` `getGroupCharacterCardsLazy`）

| 模式 | 值 | 行为 |
|---|---|---|
| SWAP | 0 | **每轮仅当前发言者单卡**。`{{char}}`=发言者；depth 提示仅来自该成员；不合并他人。 |
| APPEND | 1 | 所有**启用**成员的 `description/personality/scenario/mesExamples` 用 `generation_mode_join_prefix/suffix` 连接成**一张合并卡**；depth 提示来自所有成员。 |
| APPEND_DISABLED | 2 | 同 APPEND，但 **disabled 成员也包含在合并卡中**（仅永不激活）。 |

- 合并字段：`description`、`personality`、`scenario`、`mesExamples`（`:564-570`）。
- `scenario/mesExamples` 优先读 `chat_metadata` 覆盖（`:561-569`）。
- `generation_mode_join_prefix/suffix`：默认空（`:534-537`）。

---

## 2. 设计决策：模式如何作用于 Palink 两条路径

| Palink 路径 | 当前行为 | 目标（按 generation_mode） |
|---|---|---|
| **st-compat**（`build_st_compat_messages`） | 单卡（req.char），丢 member 身份 | 需按模式：SWAP=单发言者卡；APPEND/APPEND_DISABLED=合并卡（含/不含 disabled） |
| **palink-native**（`build_character_chat_messages` + `group_profile_part`） | 注入 speaker 身份 + 他人摘要 | 保持"身份+摘要"为 native 默认；若 `generation_mode` 显式设置且为 st 值，则向 st 语义靠拢（可选，阶段 3 再定） |

> **推荐**：阶段 3 优先把 **st-compat** 路径对齐 ST 三模式（保真度最高、最易被 ST 前端验证）；palink-native 维持现状（其"身份+摘要"已是一种合理的 native 群聊表达），仅在其 `generation_mode` 被显式设为 ST 值时做最佳努力对齐。

---

## 3. C1 — 读取 `generation_mode`（改动点）

在 `assemble_roleplay_prompt` 的群分支（约 `:1966` 附近）读取并透传：
```python
group_generation_mode = 0
if req.group_id:
    _g = db.query(GroupChat).filter(GroupChat.id == req.group_id).first()
    if _g: group_generation_mode = int(_g.generation_mode or 0)
```
- 透传至 `build_st_compat_messages(..., generation_mode=group_generation_mode)`（新增参数，见 §4）。
- native 路径：`group_profile_part` 生成时把 `mode` 传入 `_build_group_profile_context(req, generation_mode=...)`，用于决定是否排除 disabled（§5）。
- `PromptAssemblyRequest` 已有 `group_id`，无需新字段；`generation_mode` 可作为**局部变量**在 `assemble_roleplay_prompt` 内计算并传参（避免污染请求模型）。

---

## 4. C2 — `combineGroupIntoSingleCard` 等价（st-compat 路径）

### 4.1 新增 `_build_group_combined_card(group, members, mode) -> dict`
返回可注入的字段片段（与 ST 对齐）：
```python
def _build_group_combined_card(group, members, mode):
    # members: 启用成员 Character 列表（已由 _load_members 过滤）
    prefix = group.chat_metadata.get("generation_mode_join_prefix", "") or ""
    suffix = group.chat_metadata.get("generation_mode_join_suffix", "") or ""
    include_disabled = (mode == 2)  # APPEND_DISABLED
    # disabled 成员（仅 mode==2 纳入合并卡，但永不激活——激活侧已由 _load_members 排除）
    all_members = _all_member_chars(group)  # member_ids 全量
    pool = all_members if include_disabled else members
    def field(getter):
        parts = []
        for m in pool:
            v = getter(m) or ""
            if v.strip():
                parts.append(f"{prefix}{m.name}: {v}{suffix}")
        return "\n".join(parts)
    return {
        "description": field(lambda m: m.description),
        "personality": field(lambda m: m.personality),
        "scenario":    field(lambda m: m.scenario),
        "mes_example": field(lambda m: m.mes_example),
    }
```

### 4.2 `build_st_compat_messages` 按模式分流
新增参数 `generation_mode: int = 0`、`group_members_full: Optional[list] = None`。
- **SWAP(0)**：保持现有单卡逻辑，但 `char` 必须是**解析出的发言者**（见模块 03 D3）——即调用方应传入 `speaker_char` 而非 `req.char`。
- **APPEND(1)/APPEND_DISABLED(2)**：用 `_build_group_combined_card` 生成的合并片段，**替换**原有单 `char.description/personality/scenario/mes_example` 的逐字段注入（Index 3-5）。
  - 即：若 `is_group and generation_mode in (1,2)`，把合并卡的 `description/personality/scenario/mes_example` 填入对应的 system 消息，而非 `char.*`。

### 4.3 调用方改造（`assemble_roleplay_prompt` `:2561`）
- 计算 `speaker_char`（按 `req.current_speaker_id` 从群成员中查得），传给 `build_st_compat_messages(char=speaker_char, ...)`。
- 传入 `generation_mode=group_generation_mode`、`group_members_full=all_member_chars`。
- 同时恢复 `group_profile_part` 注入（修复 D1）：st-compat 分支不再丢弃 member 身份——把 `_build_group_profile_context` 的输出并入 system_prompt（或作为额外 system 消息）。

---

## 5. `_build_group_profile_context` 接受 `generation_mode`（native 路径）

签名改为 `_build_group_profile_context(req, generation_mode=0)`：
- 构建"其他成员"列表时：若 `generation_mode == 1`（APPEND）则**排除 disabled**；若 `2`（APPEND_DISABLED）则**保留 disabled**（仅作上下文，不激活）；`0`（SWAP）保持仅列启用成员即可。
- 其余不变（speaker 身份 + 摘要）。

---

## 6. 向后兼容 / 风险
- `generation_mode` 默认 `0`（SWAP）。对未设置该字段的旧群，st-compat 行为变为"仅发言者单卡"——**与当前"丢弃 member 身份"相比是改进**，但需回归测试确认不破坏现有 native 群聊（native 路径不受影响）。
- 合并卡使用 `chat_metadata` 中的 prefix/suffix（缺省空），与 ST 默认一致。
- 单人对话（`is_group=False`）完全不受影响（分支不进入）。

---

## 7. 受影响函数清单
| 函数 | 文件:行 | 改动 |
|---|---|---|
| `assemble_roleplay_prompt` | roleplay_prompt_assembly.py:1943 | 计算 `generation_mode`、`speaker_char`；传参；恢复 member 身份注入 |
| 新增 `_build_group_combined_card` | 新 | C2 合并卡 |
| `_build_group_profile_context` | :1819 | 接受 `generation_mode`，按模式排除/保留 disabled |
| `build_st_compat_messages` | character_message_builder.py:426 | 新增 `generation_mode`/`group_members_full`；APPEND/APPEND_DISABLED 用合并卡替换单卡字段 |
| `GroupChat.chat_metadata` | group_chat.py | 已有；读取 prefix/suffix（无需改模型） |

## 8. 验收标准
- [ ] `generation_mode` 被读取并影响 st-compat 装配。
- [ ] SWAP：仅发言者单卡，`{{char}}`=发言者。
- [ ] APPEND：合并卡含所有启用成员 description/personality/scenario/mes_example（prefix/suffix 连接）。
- [ ] APPEND_DISABLED：合并卡含 disabled 成员，但他们不被激活（激活侧已排除）。
- [ ] 单人对话与 palink-native 群聊行为不回归。
