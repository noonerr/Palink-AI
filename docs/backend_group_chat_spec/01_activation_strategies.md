# 模块 01：激活策略 / 发言者选择（B1–B6 + talkativeness + follower_members）

> 对应 gap 报告：B1 NATURAL / B2 LIST / B3 MANUAL / B4 POOLED / B5 disabled_members / B6 allow_self_responses / talkativeness 语义 / follower_members 消费
> 主文件：`backend/app/services/roleplay_prompt_assembly.py`

---

## 0. 当前代码现状（已验证）

### 入口与策略分发 `:1732-1816`
```python
async def _resolve_group_speaker(req):
    if not req.group_id: return
    group = req.db.query(GroupChat).filter(GroupChat.id == req.group_id).first()
    if group is None: return
    strategy = int(group.activation_strategy or 0)
    if strategy == _GROUP_ACTIVATION_VOTING and not req.current_speaker_id:   # 5
        ...加载 members...; selected = await _select_voting_speaker(...); 
        req.current_speaker_id = selected or _select_talkative_speaker(...)
        return
    if strategy == _GROUP_ACTIVATION_TALKATIVE and not req.current_speaker_id: # 4
        ...加载 members...; req.current_speaker_id = _select_talkative_speaker(...)
        return
    # 其它策略(0/1/2/3)：直接跳过，current_speaker_id 保持调用方传入值
```
- 常量 `:1392 _GROUP_ACTIVATION_TALKATIVE = 4`、`1393 _GROUP_ACTIVATION_VOTING = 5`。
- **关键缺陷**：ST 的 `0=NATURAL / 1=LIST / 2=MANUAL / 3=POOLED` 当前被当作"透传"，未实现任何 ST 语义。

### 成员加载（VOTING/TALKATIVE 分支内重复）
两分支各自 `json.loads(group.member_ids)` → `Character.id.in_(...)` 查询。**均未过滤 `disabled_members`**。

### `_select_talkative_speaker` `:1456-1501`
- 读每个成员 `_read_talkativeness`；全 0 时回退轮询（取 last_speaker 之后一位）；否则 `random.choices(weights=...)` 排除 last_speaker。
- **无 "talkativeness=0 永不自荐" 的显式保证**（仅权重为 0；全 0 回退可能选中）。

### `_read_talkativeness` `:1396-1409`
```python
def _read_talkativeness(character):
    raw = getattr(character, "talkativeness", "0.5")
    ... return float(raw)
```
- docstring 声称 "0 = never self-nominate"，**但代码未强制该语义**。

### `_build_group_profile_context` 中 `follower_members`
- `:1921` 注释提及 `follower_members`，但**代码未消费**（仅 `active_members` 在 `:1924-1936` 被消费）。

---

## 1. 枚举与兼容约定（设计决策）

| 值 | ST 语义 | Palink 现状 | 规范 |
|---|---|---|---|
| 0 | NATURAL | 透传 | **实现 NATURAL**（st-compat 缺省） |
| 1 | LIST | 透传 | **实现 LIST** |
| 2 | MANUAL | 透传 | **实现 MANUAL 语义** |
| 3 | POOLED | 透传 | **实现 POOLED** |
| 4 | — | TALKATIVE（原生） | 保留（palink-native 专用） |
| 5 | — | VOTING（原生） | 保留（palink-native 专用） |

- `st-compat` 模式：收到 `4/5` → 记 warning 并回退 `NATURAL(0)`。
- `palink-native` 模式：允许 `0–5`。
- `generation_mode`：约定 `0=SWAP / 1=APPEND / 2=APPEND_DISABLED`（见模块 02）。

---

## 2. 设计：统一"启用成员"计算（支撑 B5/B6/各策略）

新增私有辅助（放在编排模块顶部，约 `:1390` 附近）：
```python
def _enabled_member_ids(group: GroupChat) -> list:
    """member_ids 去除 disabled_members，返回启用成员 id 列表。"""
    raw = group.member_ids
    member_ids = json.loads(raw) if isinstance(raw, str) else (raw or [])
    disabled = group.disabled_members
    disabled_set = set(json.loads(disabled)) if isinstance(disabled, str) else set(disabled or [])
    return [str(m) for m in member_ids if str(m) not in disabled_set]

def _load_members(db, group: GroupChat) -> list[Character]:
    ids = _enabled_member_ids(group)
    if not ids:
        raise HTTPException(400, "No enabled group members")
    return db.query(Character).filter(Character.id.in_(ids)).all()
```
- 两处 VOTING/TALKATIVE 分支改为调用 `_load_members`，**一次性消除 B5（disabled 未强制）**。

---

## 3. B1 NATURAL（策略 0）— 高/中

### ST 行为（`group-chats.js` `activateNaturalOrder`）
1. `bannedUser` = 上一位发言者名（除非 `allow_self_responses`）。
2. 若用户输入**提及某成员名** → 强制激活该成员。
3. 否则每个启用成员按 `Math.random() <= talkativeness` 概率激活（talkativeness=0 永不激活）。
4. 若无人激活 → 从 `talkativeness>0` 成员随机；再无则从全部随机。

### 目标实现（伪码，新增 `_select_natural_speaker`）
```python
def _select_natural_speaker(db, group, members, user_text):
    last = _get_last_group_speaker_id(db, group, members)
    allow_self = bool(group.allow_self_responses)
    # (2) 提及强制
    mentioned = _members_mentioned_in_text(members, user_text)
    if mentioned:
        return random.choice(mentioned)            # 可含 last（提及优先于 banned）
    # (3) 概率激活
    activated = [m for m in members
                 if _read_talkativeness(m) > 0
                 and random.random() <= _read_talkativeness(m)
                 and (allow_self or m.id != last)]
    if not activated:
        chatty = [m for m in members if _read_talkativeness(m) > 0]
        pool = chatty if chatty else members
        if not allow_self and last in [m.id for m in pool]:
            pool = [m for m in pool if m.id != last] or pool
        return random.choice(pool).id
    return random.choice(activated).id
```
### 改动点
- `_resolve_group_speaker` 增加 `elif strategy == 0:` 分支，调用 `_select_natural_speaker`，传入 `req.message`（用户本轮文本）。
- `user_text` 来自 `req.message`（若为续写/空，跳过提及检测）。
- `_members_mentioned_in_text`：对每个成员 name 做大小写无关子串/词边界匹配（参考 ST `extractAllWords`）。

---

## 4. B2 LIST（策略 1）— 高/中

### ST 行为（`activateListOrder`）
启用成员按名册顺序，**每个成员各生成一次、全部追加**到对话。

### 关键认知
LIST 不是"选一个发言者"，而是"本回合驱动**多个**成员顺序响应"。这与当前"单轮单 speaker"架构冲突 → **LIST 的实现必须配合模块 04（多人流式 F1）**。
### 目标实现
- `_resolve_group_speaker` 对策略 1 返回 `None` 并设置 `req._list_order_members = [启用成员按顺序]`（新增请求字段，见模块 04）。
- 编排层识别 LIST → 走多人串联流水线（模块 04），依次以每个成员身份 `assemble + generate`。
- 每个成员生成时 `req.current_speaker_id = member_id`；`generation_mode` 决定卡合并方式（模块 02）。
### 风险
- 单体改动无法闭环，需模块 04 先具备"多 speaker 顺序生成"能力。建议阶段 2 与 F1 同期实现。

---

## 5. B3 MANUAL（策略 2）— 中/低

### ST 行为
- **有用户输入**：`activatedMembers=[]` → 用户文本原样发送，**AI 不回复**。
- **无用户输入（auto-mode）**：随机激活**单个**成员。

### 目标实现
在 `_resolve_group_speaker` 增加 `elif strategy == 2:`：
```python
if strategy == 2:  # MANUAL
    if req.message and req.message.strip():
        req.current_speaker_id = None          # 有输入 → 不替用户生成
        req._manual_skip_ai = True             # 编排层据此跳过生成（见模块 04）
    else:
        # 无用户输入：随机单成员（尊重 disabled 已由 _load_members 处理）
        members = _load_members(req.db, group)
        req.current_speaker_id = random.choice(members).id
    return
```
### 配合
- 编排层（`assemble_roleplay_prompt` 调用方 / `websocket.py`）需识别 `req._manual_skip_ai`：当为真时**不调用 generate**，直接把用户消息落库。
- 若客户端已显式传 `current_speaker_id`（手动指定某成员回复），则优先使用该值（覆盖随机），保持现有"客户端指定"能力。

---

## 6. B4 POOLED（策略 3）— 高/中

### ST 行为（`activatePooledOrder`）
从最近一条**用户消息**起向回遍历，收集"自那之后尚未发言"的成员；随机选其一；若全部都已发言，则随机选（排除上一位发言者）。每回合仅一名。

### 目标实现（新增 `_select_pooled_speaker`）
```python
def _select_pooled_speaker(db, group, members):
    last_user_idx, spoken_since_user = _collect_spoken_since_last_user(db, group, members)
    candidates = [m for m in members if m.id not in spoken_since_user]
    if not candidates:
        last = _get_last_group_speaker_id(db, group, members)
        candidates = [m for m in members if m.id != last] or members
    return random.choice(candidates).id
```
### 辅助
- `_collect_spoken_since_last_user`：读 `GroupChatSession.messages`（或 `CharacterChatMessage` 历史），定位最后一条 `is_user` 消息位置，向后收集 `name`/`original_avatar` 对应的成员 id 集合。
- 复用 `_get_last_group_speaker_id`（`:1412` 已有）。

---

## 7. B5 disabled_members 强制 — 高/低（已在 §2 统一解决）
- 所有策略分支改用 `_load_members`（已过滤 disabled）。
- `_build_group_profile_context` 在生成"其他成员"列表时，也应排除 disabled（除非 `generation_mode == APPEND_DISABLED`，见模块 02）。

## 8. B6 allow_self_responses — 中/低
- 仅在 **NATURAL(0)** 生效（ST 语义）。`B1 §3` 已据 `group.allow_self_responses` 决定是否排除 last speaker。
- 对其他策略（TALKATIVE/VOTING/LIST/POOLED）**不改变**现有 last-speaker 回避行为（ST 中 allow_self_responses 仅作用于 NATURAL）。
- 数据已就绪（`GroupChat.allow_self_responses`），无需改模型。

## 9. talkativeness 语义修正
- 保持 `_read_talkativeness` 返回 float（0.0–1.0）。
- **修正 docstring**（`:1396`）去除"0 = never self-nominate"的误导表述，改为："0 表示在 NATURAL 概率阶段永不主动激活；TALKATIVE 加权中随机权重为 0，仅在全员为 0 时回退轮询可能选中。"
- NATURAL 实现（B1）已显式实现"0 永不主动激活"语义，无需在 `_read_talkativeness` 加逻辑。

## 10. follower_members 消费
- ST 中 `follower_members` 为跟随成员（被动、少主动）。建议：在 NATURAL 概率阶段，对 `follower_members` 中的成员施加"衰减系数"（如 talkativeness * 0.3）降低被激活概率，但不完全排除。
- 实现：`_select_natural_speaker` 接收 `group.follower_members`，对命中成员将其有效 talkativeness 乘以 `FOLLOWER_DAMPING = 0.3`。
- `active_members` 已在 `:1924` 消费（作为上下文提示），可同步在概率阶段对 active 成员施加轻微增益（可选，默认不强制）。

---

## 11. 受影响函数清单
| 函数 | 文件:行 | 改动 |
|---|---|---|
| `_resolve_group_speaker` | roleplay_prompt_assembly.py:1732 | 增加 0/1/2/3 分支；统一 `_load_members` |
| 新增 `_enabled_member_ids` / `_load_members` | ~:1390 | 新辅助 |
| 新增 `_select_natural_speaker` / `_members_mentioned_in_text` | 新 | B1 |
| 新增 `_select_pooled_speaker` / `_collect_spoken_since_last_user` | 新 | B4 |
| `_select_talkative_speaker` | :1456 | B3 微调（MANUAL 分支不改其逻辑） |
| `_read_talkativeness` | :1396 | docstring 修正 |
| `_build_group_profile_context` | :1819 | B5 排除 disabled（受 generation_mode 约束） |
| `PromptAssemblyRequest` | :347 | 新增 `list_order_members: list = []`、`manual_skip_ai: bool = False`（供模块 04 使用） |
| `websocket.py:1406` 装配调用处 | :1406 | 透传新字段；MANUAL 跳过生成 |

## 12. 验收标准
- [ ] `activation_strategy=0/1/2/3` 不再透传，分别触发 NATURAL/LIST/MANUAL/POOLED。
- [ ] `disabled_members` 中的成员永不被选为发言者（APPEND_DISABLED 模式除外）。
- [ ] NATURAL：talkativeness=0 成员不主动激活；用户输入提及成员名时强制该成员。
- [ ] `allow_self_responses=True` 时 NATURAL 允许连续同人。
- [ ] `st-compat` 模式下 `4/5` 回退 NATURAL 且记 warning。
- [ ] 既有 `4/5`（TALKATIVE/VOTING）原生行为不回归。
- [ ] `follower_members` 在 NATURAL 下被衰减。
