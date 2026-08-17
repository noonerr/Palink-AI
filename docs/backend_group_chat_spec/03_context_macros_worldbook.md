# 模块 03：上下文装配 / 宏对齐 / 世界书（D1–D5 + E1–E2）

> 对应 gap 报告：D1 st-compat 丢失 member 身份 / D2 native 群历史无 name 归属 / D3 `{{char}}` 不绑定 speaker / D4 `{{group}}` 名单 / D5 `{{charIfNotGroup}}` / E1 per-member WI / E2 WI·regex 枚举
> 主文件：`roleplay_prompt_assembly.py`、`character_message_builder.py`、`macro_service.py`、`worldbook_service.py`

---

## 0. 当前现状（已验证）

### D1 — st-compat 丢失 member 身份
`assemble_roleplay_prompt:1976` 把 `_build_group_profile_context(req)` 的结果 append 到 `system_prompt`，但 st-compat 分支 `:2499` 改用 `char_system_prompt = char.system_prompt`（`:2504`），**未把 group_profile_part 纳入** → st-compat 下发言者身份完全丢失。

### D2 — native 群历史无 name 归属
`build_character_chat_messages`（character_message_builder.py:81）**无 group 分支、无 `names_behavior` 参数**；历史消息直接 `{"role":m.role,"content":msg}`（`:156-183`），**无 `"Name: content"` 前缀** → 模型难分辨谁说了什么。
> 注意：st-compat 的 `build_st_compat_messages` **已有** name 归属逻辑（`:628-699`，`names_behavior` 四态），native 路径独有此缺口。

### D3 — `{{char}}` 不绑定发言者
`roleplay_prompt_assembly.py:2792` 构建 `MacroEnv(char_name=req.char.name or "Character")` → `{{char}}` 指向前端 `character_id`，**非** `req.current_speaker_id`。群内错位。
- `macro_service._resolve_simple_macro`（`:204`）：`{{char}}`→`env.char_name`；引擎内**无** `{{group}}`/`{{charIfNotGroup}}`/`{{notChar}}` 分支。

### D4 — `{{group}}` 名单丢失（TODO）
`roleplay_prompt_assembly.py:2609` `group_members=None,  # TODO` → `build_st_compat_messages` 内 `:511-514`：
```python
if group_members:
    new_chat_marker = new_chat_marker.replace("{{group}}", ", ".join(group_members))
else:
    new_chat_marker = new_chat_marker.replace("{{group}}", char_name)  # 退化为单名
```

### D5 — `{{charIfNotGroup}}` 语义错误
`character_message_builder.py:502` `_sub`：
```python
result = result.replace("{{charIfNotGroup}}", char_name)
```
ST 语义：`{{charIfNotGroup}}` 在群聊中应解析为 `{{user}}`（"如果不是群聊则用 {{char}}，否则用 {{user}}"），此处直接替换为 `char_name` 丢失该语义。

### E1 — per-member 世界书缺失
`worldbook_service.build_worldbook_context`（`:1176`）仅接受**单个** `character`（`:1127-1131`、`character_name`/`character_tags` 来自单一角色）；`group_members` 只流入 `build_st_compat_messages` 的 `{{group}}` 标记，**从不进入 WI 扫描**。ST 有 `world_info_character_strategy` 支持按角色匹配。

### E2 — WI/regex 位置枚举偏移
`worldbook_service.py:54-72`：Palink `WI_POS_AT_DEPTH = 4`，而 ST `world-info.js` `atDepth = 5`（ST 枚举 `AFTER_PROMPT=0, BEFORE_CHAR=1, AFTER_CHAR=2, BEFORE_AN=3, AFTER_AN=4, AT_DEPTH=5, EM_TOP=6, EM_BOTTOM=7, OUTLET=8`）。Palink 整体重编号，需 `normalize_worldbook_position` 映射。
`regex_scripts.py` 缺 ST 的 `PROMPT=4` 放置位（阶段 3 再评估）。

---

## 1. D1 — 恢复 st-compat 的 member 身份注入（高/中）

### 方案
在 st-compat 分支（`:2499-2504`）构建 `char_system_prompt` 后，**追加** group profile 片段：
```python
char_system_prompt = char.system_prompt or ""
if group_profile_part:                       # 来自 :1976 已计算
    char_system_prompt = char_system_prompt + "\n\n" + group_profile_part
```
- `group_profile_part` 已在 `:1966-1988` 计算（native 与 st-compat 共用）。
- 不破坏 Index 0-5 的独立字段注入；profile 作为额外身份说明附在 system prompt 末尾（与 ST 把成员卡信息置于 system 区一致）。
### 验收
- [ ] st-compat 群聊下，`{{char}}`/`personality` 指向**发言者**（配合 D3）。
- [ ] 单人对话不变。

---

## 2. D2 — native 群历史 name 归属（中/中）

### 方案
给 `build_character_chat_messages` 增加可选群参数，复刻 st-compat 的 `names_behavior` 归属逻辑（仅 native 路径需要）：
```python
def build_character_chat_messages(...,
        is_group: bool = False,
        user_name: str = "",
        narrator_type: str = "narrator"):
    ...
    for m in history:
        ...
        msg_name = getattr(m, "name", None) or ""
        msg_obj = {"role": m.role, "content": msg_content}
        if is_group and msg_name and msg_name != user_name:
            msg_obj["content"] = f"{msg_name}: {msg_content}"   # 与 st-compat DEFAULT 行为一致
        history_messages.append(msg_obj)
```
- 调用方 `assemble_roleplay_prompt:2621` 传入 `is_group=bool(req.group_id)`、`user_name=req.user.username`。
- **不**引入完整 `names_behavior` 四态到 native（保持简单）；native 默认用 DEFAULT 风格前缀即可。

---

## 3. D3 — `{{char}}` 绑定发言者（中/中）

### 方案
在 `assemble_roleplay_prompt` 计算 `speaker_char`（见模块 02 §4.2）：按 `req.current_speaker_id` 从群成员查得 `Character`；**仅群聊且已解析出发言者时**，用其 `name` 覆盖 `MacroEnv.char_name`：
```python
char_name_for_macros = req.char.name
if req.group_id and req.current_speaker_id:
    sp = _char_by_id(req.db, req.current_speaker_id)
    if sp: char_name_for_macros = sp.name
...
MacroEnv(..., char_name=char_name_for_macros, ...)
```
- 同步影响 `build_st_compat_messages(char=speaker_char, ...)` 的 `_sub`，使 `{{char}}`/`{{user}}` 在群聊内正确。
- 单人 / 未解析发言者：回退 `req.char.name`，无回归。

---

## 4. D4 — 填 `{{group}}` 成员名单（中/低）

### 方案
在 `assemble_roleplay_prompt` 群分支计算 `group_member_names` 列表并传入：
```python
group_member_names = []
if req.group_id:
    g = db.query(GroupChat).filter(GroupChat.id == req.group_id).first()
    if g:
        ids = _enabled_member_ids(g)            # 复用模块01 §2
        chars = db.query(Character).filter(Character.id.in_(ids)).all()
        group_member_names = [c.name for c in chars if c.name]
```
- `build_st_compat_messages` 调用处（`:2561`）把 `group_members=group_member_names`（取代 `None` TODO）。
- 消除退化；`{{group}}` 正确展开为启用成员名列表（逗号分隔）。

---

## 5. D5 — 修正 `{{charIfNotGroup}}`（中/低）

### 方案（ST 语义：`{{charIfNotGroup}}` = 群聊时用 `{{user}}`，否则 `{{char}}`）
```python
def _sub(text):
    if is_group:
        result = text.replace("{{charIfNotGroup}}", user_nickname)   # 群内=用户
    else:
        result = text.replace("{{charIfNotGroup}}", char_name)       # 单聊=角色
    result = result.replace("{{char}}", char_name)
    result = result.replace("{{user}}", user_nickname)
    return result
```
- 仅改动 `build_st_compat_messages._sub`（`:498-504`）；`is_group`/`user_nickname`/`char_name` 已在作用域。
- Macro 引擎侧（`macro_service.py`）无需改（群宏由 builder 的 `_sub` 处理，与现状一致）。

---

## 6. E1 — per-member 世界书（中/高）

### ST 行为
`world_info_character_strategy`（per-character matching）、`world_info_use_group_scoring`：每个成员的 `description/personality/scenario/depth_prompt` 作为 WI 扫描 haystack；可开启"群组评分"让群内多角色共享触发。

### 方案（分阶段，降低风险）
**阶段 3a（推荐先做）**：让群聊 WI 扫描**同时**以"发言者"和"所有启用成员"的字段作为 haystack（并集），触发结果注入一次。
```python
# worldbook_service.build_worldbook_context 增加可选参数
character_name_list: Optional[list[str]] = None   # 群成员名集合
character_tags_list: Optional[list[list]] = None
# 在 _build_haystack(CHAR) 分支，累加所有群成员的 description/personality/scenario
```
- 改动 `_build_haystack`（`:478-533`）：若传 `character_name_list`，haystack 包含各成员字段。
- **阶段 3b（可选高保真）**：实现 `world_info_character_strategy='one'/ 'all'/ 'group'` 三态，分别决定"仅发言者字段 / 所有成员字段 / 合并去重"。映射到 `GroupChat` 新配置（需加字段或复用 `chat_metadata`）。

### 风险
- 多角色字段并集会扩大触发面，可能误触发；需回归测试 + 提供开关（默认关闭，仅发言者字段）。
- 不破坏单人 WI（参数缺省时行为不变）。

---

## 7. E2 — WI/regex 位置枚举对齐（中/中）

### 方案
- WI：ST 导入的 position 整数经 `normalize_worldbook_position`（已在 `worldbook_service.py:50` 导入、`:1343` 使用）做映射，**确认映射表正确覆盖 ST 全枚举**（AFTER_PROMPT=0…OUTLET=8 → Palink 0…7）。补单测验证 `atDepth=5 → WI_POS_AT_DEPTH(4)`。
- regex：评估 `regex_scripts.py` 是否需补 `PROMPT=4` 放置位。ST 的 `PROMPT` 位在生成前对用户/系统提示应用；Palink 若无此位则群聊（及单人）的 PROMPT 阶段正则不生效。**建议阶段 3 评估**，因涉及单人对话一致性，改动需谨慎。
- **不**改变 Palink 内部 position 数值（避免破坏存量数据），只在**导入/跨系统**边界做映射。

---

## 8. 受影响函数清单
| 函数 | 文件:行 | 改动 |
|---|---|---|
| `assemble_roleplay_prompt` | roleplay_prompt_assembly.py:1943 | D1 恢复注入；D3 speaker_char；D4 group_member_names；E1 群 haystack |
| `_build_group_profile_context` | :1819 | （模块02）受 generation_mode 影响 |
| `build_st_compat_messages` | character_message_builder.py:426 | D1（调用方）、D5 `_sub`、D4 `group_members` 实参 |
| `build_character_chat_messages` | character_message_builder.py:81 | D2 增加 `is_group`/`user_name` 归属 |
| `MacroEnv` 构建 | roleplay_prompt_assembly.py:2792 | D3 `char_name` 绑定 speaker |
| `build_worldbook_context` | worldbook_service.py:1176 | E1 `character_name_list` 并集 haystack |
| `normalize_worldbook_position` | worldbook_service.py:50 | E2 映射表校验/补全 |

## 9. 验收标准
- [ ] st-compat 群聊：`{{char}}`=发言者，member 身份可见，history 有 name 归属。
- [ ] native 群聊：history 有 `"Name: content"` 归属。
- [ ] `{{group}}` 展开为启用成员名列表（非单名）。
- [ ] `{{charIfNotGroup}}` 在群内=用户、单聊=角色。
- [ ] per-member WI（阶段3）：群成员字段可触发；单人不变。
- [ ] WI 位置导入映射正确（atDepth 等）。
