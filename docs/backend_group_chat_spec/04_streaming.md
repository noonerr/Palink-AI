# 模块 04：多人自动串联流式（F1）

> 对应 gap 报告：F1 多成员自动串联流式（ST `generateGroupWrapper` 对 activatedMembers 顺序 Generate + `shouldAutoContinue`）
> 主文件：`backend/app/api/websocket.py`、`roleplay_prompt_assembly.py`

---

## 0. 当前现状（已验证）

### 单次生成架构
`websocket.py:1146` 主循环：每个 `chat_request` 消息 → 一次 `assemble_roleplay_prompt`（`:1406`）→ 一次 `run_character_chat_generation`（`:1542`）→ 一次落库（`:523` `_st_message_kwargs`，`name=char.name`）。
- `_resolve_group_speaker` 只选**单个** `current_speaker_id`（模块 01）。
- **无**对多个成员的顺序 / 续轮编排。

### ST 行为（`group-chats.js:945` `generateGroupWrapper`）
1. 计算 `activatedMembers`（依策略 0-3；4/5 由 Palink 原生处理）。
2. `for (const chId of activatedMembers)` 顺序循环：
   - `setCharacterId(chId)` → `Generate('normal'|'swipe'|'impersonate'|'quiet'|'continue')`（`:1063`）。
   - 每轮产生一条消息，流式追加到 chat。
   - `shouldAutoContinue` 为真时 `Generate('continue')` 续轮直到满足停止条件（`:1067-1070`）。
3. auto-mode（`groupChatAutoModeWorker:1398`）：每 `auto_mode_delay` 秒若无用户输入则重新触发。

---

## 1. 设计目标
让 Palink 在一次用户回合内，能按激活策略驱动**一个或多个**成员顺序生成，每条独立落库、独立流式推送，且 MODE=APPEND 时多人消息都进入同一对话历史（供后续成员看到前文）。

> 这直接支撑模块 01 的 **LIST(1)** 与 **POOLED/NATURAL 多激活** 场景。NATURAL/POOLED 通常每轮激活 0-1 人（多数情况单 speaker），LIST 必多。

---

## 2. 架构方案：编排层驱动多 speaker 流水线

### 2.1 新增请求字段（`PromptAssemblyRequest`，:347）
```python
list_order_members: list[str] = field(default_factory=list)  # LIST 模式：按顺序的成员 id
manual_skip_ai: bool = False                                # MANUAL 有用户输入时跳过 AI
```

### 2.2 编排入口改造（`websocket.py` chat_request 分支）
将"装配 + 生成"抽为可重入的 `_generate_for_speaker(speaker_id)`：
```python
def resolve_speaker_queue(req, group) -> list[str]:
    """返回本轮需要顺序生成的发言者 id 列表（0/1/N 个）。"""
    strat = int(group.activation_strategy or 0)
    if strat == 1:  # LIST
        return _enabled_member_ids(group)                    # 全部顺序
    if req.current_speaker_id:
        return [req.current_speaker_id]                       # 手动/单激活
    if req.manual_skip_ai:
        return []                                            # MANUAL 有输入
    # NATURAL/POOLED 已在 _resolve_group_speaker 设置 current_speaker_id（0/1 人）
    return [req.current_speaker_id] if req.current_speaker_id else []
```
主流程：
```python
queue = resolve_speaker_queue(req, group)
if not queue:
    # MANUAL 有输入：仅落用户消息，不生成
    await _persist_user_message(...)
    return
for speaker_id in queue:
    req.current_speaker_id = speaker_id
    await _run_speaker_turn(req, speaker_id)   # assemble + stream + persist
```

### 2.3 `_run_speaker_turn`（封装现有逻辑）
- 调 `assemble_roleplay_prompt(req, deps)`（内部 `_resolve_group_speaker` 已是 no-op，因 `current_speaker_id` 已定）。
- 调 `run_character_chat_generation(...)`，落库时 `name = speaker_char.name`（从 `current_speaker_id` 解析），确保 `name` 正确（修复 D2 落库侧）。
- 通过 `ws_manager` 流式推送每条 speaker 消息（前端虽暂未接，但后端协议就绪，见下方"协议"）。

### 2.4 续轮（`shouldAutoContinue` 等价）
- Palink 现有 `is_continue` 机制可复用：若模型输出含续写信号（或 `oai_settings` 的 auto-continue 开启），对**同一 speaker** 追加一次 `assemble_roleplay_prompt(is_continue=True)` + 生成。
- 阶段 3 建议：对每个 speaker 最多续轮 `MAX_CONTINUE_PER_SPEAKER=1`（可配），避免无限循环。

---

## 3. WebSocket 推送协议（后端就绪，前端后续接）
每条 speaker 消息作为一个流式事件推送，带 `speaker_id` / `speaker_name`，便于未来前端渲染多角色气泡：
```json
{"type":"group_speaker_start","speaker_id":"...","speaker_name":"..."}
{"type":"chat_stream","delta":"...","speaker_id":"..."}
{"type":"chat_stream_end","speaker_id":"...","message_id":"..."}
```
- 当前前端不消费这些字段也不影响（向后兼容）；属"后端先行"铺垫。

---

## 4. auto-mode（可选，阶段 3）
- 群 `auto_mode_delay`（ST 默认 5s，Palink 模型可加字段或复用 `chat_metadata`）驱动定时器：无新用户输入时，重新走 `resolve_speaker_queue`（NATURAL/POOLED/TALKATIVE 可能选出下一位）并生成。
- **风险**：后台定时器需与 WebSocket 生命周期绑定，避免泄漏。建议阶段 3 单独评估，本 spec 先实现"请求驱动的多 speaker 串联"（覆盖 LIST 与多激活），auto-mode 留作后续。

---

## 5. 向后兼容 / 风险
- **单人对话 / 单 speaker 群聊**：`queue` 长度为 1，行为与现状一致（多一层封装，需回归确认时序）。
- **MANUAL 有输入**：返回空 queue → 仅落用户消息，符合 ST。
- **性能**：LIST 多成员 = 多次 LLM 调用，延迟累加。建议 LIST 的续轮/长生成加整体超时与取消。
- **历史一致性**：每个 speaker 消息落库后才进入下一 speaker 的 `assemble`，确保后续成员"看得到"前文（与 ST 一致）。

---

## 6. 受影响函数清单
| 函数 | 文件:行 | 改动 |
|---|---|---|
| `PromptAssemblyRequest` | roleplay_prompt_assembly.py:347 | 新增 `list_order_members`/`manual_skip_ai` |
| `websocket.py` chat_request 分支 | websocket.py:1406 | 抽 `_run_speaker_turn`；按 `resolve_speaker_queue` 循环 |
| 新增 `resolve_speaker_queue` | websocket.py 或编排模块 | F1 队列解析 |
| `_st_message_kwargs` 调用处 | websocket.py:523 | `name=speaker_char.name`（群聊正确归属） |
| `run_character_chat_generation` | （现有） | 复用；续轮用 `is_continue` |

## 7. 验收标准
- [ ] LIST 模式：一次用户回合驱动所有启用成员顺序生成，每条独立落库且带正确 `name`。
- [ ] NATURAL/POOLED 多激活时，多个被激活成员都生成（而非仅一个）。
- [ ] MANUAL + 用户输入：不产生 AI 回复，仅落用户消息。
- [ ] 后续成员的 prompt 能看到前序成员消息（历史连贯）。
- [ ] 单人对话行为不回归。
- [ ] 流式事件带 `speaker_id`/`speaker_name`（后端协议就绪）。
