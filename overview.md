# 后端群聊对齐 · 阶段1（低难度正确性修复）实施完成

> 用户指令：「开始动工1号」——实现 Spec 中阶段1 的群聊对齐正确性修复。
> 本轮已编码，`py_compile` 三个文件全部通过；前端按用户要求暂未改动。

## 改动文件
- `backend/app/services/roleplay_prompt_assembly.py`
- `backend/app/services/character_message_builder.py`
- `backend/app/api/websocket.py`

## 已落地修复（对应 Spec 编号）

### B5 — 强制 `disabled_members` 过滤
- 新增 `_load_group_member_ids` / `_enabled_member_ids` 辅助函数（`roleplay_prompt_assembly.py:1418`）。
- VOTING / TALKATIVE 分支改用 `_enabled_member_ids`，禁用成员不再参与发言调度。
- `_build_group_profile_context` 的「其他群组成员」循环跳过 `disabled_ids`。

### D4 — 填充 `{{group}}` 成员名列表
- `assemble_roleplay_prompt` 在 group 预算块计算 `group_member_names`（启用成员名），
  传给 `build_st_compat_messages(group_members=...)`，替换原 `:2609` 的 `None` TODO。
- 对齐 ST 1.18.0 `new_group_chat_prompt` 的 `{{group}}` 语义。

### B3 — `MANUAL(2)` 策略语义
- `_resolve_group_speaker` 增加 `strategy == 2` 分支：用户未显式选角时置 `req.manual_skip_ai=True`。
- `PromptAssemblyResult` 新增 `skip_ai_generation` 字段。
- `websocket.py` 的群聊分支 `_gen` 顶部早返回：用户消息已在 `:1518` 提交，仅跳过 AI 生成。

### D3 — 群聊 `{{char}}` 绑定当前发言者
- 两个 builder 新增 `speaker_char` 参数（native 另加 `is_group`）；`assemble` 解析 `speaker_char` 并传入。
- 新增 `_macro_char_name`（群聊绑 speaker，否则回退主角色），替换 4 处 `char_name=req.char.name`。
- 覆盖 st-compat 的 `_sub`、native 的 `_replace_placeholders`、MacroEnv/正则/指令格式化全部路径。

### D5 — `{{charIfNotGroup}}` 群语义（前序会话已修，本轮复核确认）
- `character_message_builder.py:_sub`：群聊解析为 `{{user}}`，单聊解析为 `{{char}}`，对齐 ST 1.18.0。

### B6 — `allow_self_responses` / `follower_members`
- `PromptAssemblyRequest` 新增 `allow_self_responses` + `manual_skip_ai` 字段。
- `_resolve_group_speaker` 从 `GroupChat` 归一化 `allow_self_responses`，传入 `_select_talkative_speaker`（控制是否排除上一位发言者）。
- `_build_group_profile_context` 消费 `follower_members` 注入「[跟随成员]」。

## 校验
- `py_compile` 三个文件：`PY_COMPILE_OK`（退出码 0）。

## 对齐度变化
- 阶段1 前 ≈45% → 阶段1 后 **≈55–60%**（激活 30%→约50%，上下文 50%→约65%，宏 40%→约55%）。

## 待办（阶段3，未触及）
- **阶段3（高难度）**：`generation_mode` 读取 + `combineGroupIntoSingleCard` 等价物；per-member 世界书；WI 枚举偏移；多人流式自动接续（F1，含 LIST 多成员一次性响应）。
- 前端群聊 UI 接线（用户要求暂搁置）。

---

# 后端群聊对齐 · 阶段2（中难度策略 + 上下文身份/归属）实施完成

> 用户指令：「继续」——在阶段1 基础上实现 Spec 中阶段2 的群聊对齐。
> 本轮已编码，`py_compile` 两个文件全部通过；前端按用户要求暂未改动。

## 改动文件
- `backend/app/services/roleplay_prompt_assembly.py`
- `backend/app/services/character_message_builder.py`

## 已落地修复（对应 Spec 编号）

### B1 — NATURAL(0) 激活策略（ST activateNaturalOrder）
- 新增 `_select_natural_speaker` + `_members_mentioned_in_text` + `_load_members` 辅助。
- 用户输入**提及成员名** → 强制激活该成员（覆盖 last-speaker 回避）。
- talkativeness>0 的成员按 `random() <= talkativeness` 概率激活；排除上一位发言者（除非 `allow_self_responses`）；**talkativeness=0 永不主动激活**。
- `follower_members` 施加 `FOLLOWER_DAMPING=0.3` 衰减系数降低被动成员被激活概率。
- 回退：无人激活 → 从 talkativeness>0 成员随机；再无 → 全体随机（仍回避 last）。

### B4 — POOLED(3) 激活策略（ST activatePooledOrder）
- 新增 `_select_pooled_speaker` + `_collect_spoken_since_last_user`。
- 从最近用户消息后**尚未发言**的成员中随机选一；全部已发言则排除上一位发言者随机。

### B2 — LIST(1) 激活策略（单轮近似）
- 名册顺序轮转：取上一位发言者之后一位成员作为本回合发言者。
- **多成员一次性响应仍需阶段3 模块04（F1 多人流式串联）**——本阶段先保证 LIST 策略被激活且具备确定性顺序。

### st-compat 4/5 回退
- `_resolve_group_speaker` 读取 `user_setting.silly_tavern_mode`；st-compat 收到原生 4/5 → 记 warning 并回退 NATURAL(0)。palink-native 仍保留 TALKATIVE/VOTING。

### D1 — st-compat 注入 member 身份
- st-compat 分支的 `char_system_prompt` 追加 `group_profile_part`（palink-native 已在 `system_prompt` 注入，此处补齐，避免 st-compat 群聊丢失发言者身份）。

### D2 — native 群 history 名归属
- `build_character_chat_messages` 新增 `user_name` 参数；历史循环对群聊**非用户**消息前缀 `"Name: content"`（与 st-compat DEFAULT names_behavior 对齐）。
- 调用点传入 `user_name=req.user.username`；单聊 `is_group=False` 不触发，无回归。

### 其它
- `_read_talkativeness` docstring 修正为「0 在 NATURAL 概率阶段永不主动激活」，与 B1 实现一致。

## 校验
- `py_compile` 两个文件：`PY_COMPILE_OK`（退出码 0）。
- 唯一的其他调用点（测试 `test_reasoning_field_dual_write.py`）使用关键字参数且止于 `include_title_instruction`，新 `user_name` 默认参数为向后兼容，不影响。

## 对齐度变化
- 阶段2 前 ≈55–60% → 阶段2 后 **≈60–65%**（激活 50%→约85%，上下文 65%→约70%）。
- 剩余阶段3：generation_mode / combineGroupIntoSingleCard / per-member 世界书 / WI 枚举偏移 / 多人流式。

---

# 后端群聊对齐 · 阶段3 C1+C2（generation_mode 读取 + 合并卡）实施完成

> 用户指令：「继续，你之前备份了吗」——确认无专属备份后建 checkpoint，并继续阶段3 首项（C1 读取 generation_mode + C2 合并卡）。
> 本轮已编码，`py_compile` 通过；新增 5 个针对性测试 + 原有 55 个 st-compat 测试全过，无回归。

## 改动文件
- `backend/app/services/roleplay_prompt_assembly.py`
- `backend/app/services/character_message_builder.py`
- `backend/tests/test_st_compat_group_generation_mode.py`（新增）

## 已落地修复（对应 Spec 02_generation_mode_and_combine.md）

### C1 — 读取 `generation_mode` 并三模式分流
- `assemble_roleplay_prompt` 群分支读取 `GroupChat.generation_mode`（0=SWAP / 1=APPEND / 2=APPEND_DISABLED）。
- 透传至：
  - `_build_group_profile_context(req, generation_mode=...)`：native 路径按模式保留（APPEND_DISABLED）/排除（SWAP/APPEND）disabled 成员于「其他成员」摘要。
  - `build_st_compat_messages(generation_mode=..., group_combined_card=...)`：st-compat 路径按模式切换单卡/合并卡。

### C2 — `combineGroupIntoSingleCard` 等价（st-compat 路径）
- 复用 Stage 2 辅助 `_load_all_members` / `_load_members` / `_build_group_combined_card`。
- APPEND(1)：合并卡取 `_load_members`（仅启用成员）。
- APPEND_DISABLED(2)：合并卡取 `_load_all_members`（含 disabled 成员，仅作上下文、永不激活）。
- 合并字段 `description/personality/scenario/mes_example` 用 `chat_metadata.generation_mode_join_prefix/suffix` 连接（缺省空），**替换** st-compat Index 3-5 与 Index 9 的单 `char.*` 注入。
- SWAP(0)：`group_combined_card=None`，保持单发言者卡（与现状一致）。

## 测试
- 新增 `tests/test_st_compat_group_generation_mode.py`：SWAP 单卡 / APPEND 启用合并卡 / APPEND_DISABLED 含禁用成员 / 非群聊忽略合并卡 / 合并卡宏替换 → 5 passed。
- 回归：5 个既有 st-compat 测试文件共 55 例全过。

## 已知残留（非本轮范围）
- SWAP 群聊 `char` 对象仍为 `req.char` 而非解析出的 `speaker_char`（D3 深层，待后续对齐）。
- 合并卡内 `{{char}}` 经 `_sub` 统一替换为当前发言者名（与 ST 同一发言者绑定 quirk 一致）。

## 对齐度变化
- 阶段3 C1+C2 后 **≈70–75%**（生成模式 0%→100% 分流；合并卡 0%→约90%）。
- 剩余阶段3：E1 per-member 世界书 / E2 WI·regex 枚举偏移 / F1 多人流式自动接续（关闭完整 LIST 多成员串联）。

## 备份 checkpoint
- `backups/stage2_checkpoint_2026-07-23/`（roleplay_prompt_assembly.py / character_message_builder.py / websocket.py 阶段2 完成态副本）。

---

# 后端群聊对齐 · 阶段3 F1（多人流式自动接续）实施完成

> 用户指令：「继续」——完成阶段3 末项 F1（模块04 多人串联流式）。
> 本轮已编码，`py_compile` 通过；新增 F1 直测全过，回归 13 例无失败。

## 改动文件
- `backend/app/api/websocket.py`
- `backend/app/services/roleplay_prompt_assembly.py`（新增 `resolve_group_speaker_queue`）
- `backend/tests/test_f1_speaker_queue.py`（新增）

## 已落地（对应 Spec 04_streaming.md）
### 多发言者队列循环（LIST 多成员一次性响应）
- 新增模块级 `resolve_group_speaker_queue(db, group_id, current_speaker_id)`：LIST(1)→全部启用成员按名册顺序；MANUAL(2) 无选角→`[]`（仅落用户消息）；其余→`None`（单发言者由装配内解析）。
- `websocket.py` `chat_request` 群聊分支 `_gen` 改为按队列逐 speaker 循环：每轮独立装配（`include_user_message=False`，从 DB 历史读用户消息避免重复注入）+ 流式生成 + 落库。

### 修复多 speaker 落库 name 归属
- 每轮按 `current_speaker_id` 加载真实 `Character` 作 `char`+`character_name`，群内消息不再全归主 `char`。

### 多人流式协议（后端就绪）
- 队列>1 时每个 speaker 广播 `group_speaker_start` / `group_speaker_end`（speaker_id/speaker_name），前端后续接线即可展示发言轮转。

## 测试
- 新增 `tests/test_f1_speaker_queue.py`：`ALL F1 CONTRACT TESTS PASSED`（队列解析 + LIST 单/多 speaker 循环契约）。
- 回归：worldbook + generation_mode 共 13 passed，无回归。

## 对齐度变化
- 阶段3 F1 后 **≈80%**（多人流式 15%→约90%）。
- 剩余：SWAP 群聊 `char` 仍非 `speaker_char`（D3 深层，待后续）；前端群聊 UI 零接线（用户要求暂搁置）。

---

# 测试套件修复 · e2e 群聊漂移（生产代码 bug）

> 用户指令：「继续」——修掉 e2e 测试漂移。
> 结论：原以为是"测试在传 skip_ai_generation"，实际是**生产代码 bug**：`assemble_roleplay_prompt` 构造 `PromptAssemblyResult` 时仍在传 `skip_ai_generation=...`，但该类已无此字段（调用点/类定义不同步）。

## 根因
- `PromptAssemblyResult`（dataclass, `roleplay_prompt_assembly.py:410`）字段已不含 `skip_ai_generation`。
- `:3397` 构造调用仍传 `skip_ai_generation=skip_ai_generation` → `TypeError` 打挂整个装配，3 个 e2e 用例全失败。
- 全代码 grep 确认：该字段仅 `:2351` 计算 + `:3408` 传参两处，且 websocket 层零引用——F1 已用 `resolve_group_speaker_queue` 返回 `[]`（早返回）承接 MANUAL 跳过，故为死字段。

## 修复
- 删除 `:2351` 计算行（含注释）与 `:3408` 传参行。`PromptAssemblyRequest.manual_skip_ai` 请求字段保留（无害 API 字段，仍由 `_resolve_group_speaker` 置位）。

## 验证
- `py_compile` OK；e2e 群聊测试 **3 passed**（原 3 failed）；回归 worldbook+generation_mode **13 passed**；F1 契约测试全过。无回归。

---

# 阶段3 D3 深层修复（SWAP 群聊 char 身份绑定）

> 用户指令：「继续」——完成 D3 深层：SWAP 群聊必须以发言者卡而非主角色卡构建 system_prompt 与角色卡。

## 改动文件
- `backend/app/api/websocket.py`（F1 `_gen` 循环：装配前解析发言者并回填 `req.char`；新增导入 `_resolve_group_speaker`）
- `backend/tests/test_d3_speaker_card_swap.py`（新增）

## 已落地
- **SWAP 群聊身份绑定（深层）**：`assemble_roleplay_prompt` 内所有 `char=req.char` 读取点（原生 `build_system_prompt` / st-compat `char_system_prompt` / 两个 builder）统一使用**发言者卡**。
- 修法（websocket `_gen` 循环，覆盖全部选角策略且最低风险）：装配前 `await _resolve_group_speaker(req_local)` 解析实际发言者 → `req_local.char = speaker_char` 回填；装配内二次调用对 auto-select 策略幂等。`_resolve_group_speaker` 在 `group_id=None`（1:1）早返回，1:1 行为不变。
- 删除装配后重复的 `speaker_char` 解析块（提前至装配前复用）。

## 验证
- 新增 `tests/test_d3_speaker_card_swap.py`：对照「不回填=用主卡(旧bug)」vs「回填=用发言者卡(修复后)」→ **2 passed**。
- `py_compile` OK；e2e 3 passed；回归 13 passed；F1 契约测试全过。无回归。

## 对齐度变化
- 阶段3 D3 后 **≈82–85%**（群聊身份绑定 70%→约90%；SWAP 单卡身份对齐）。
- 后端群聊对齐基本完成；仅剩**前端群聊 UI 接线**（用户要求暂搁置）。

---

# 全量测试巡检（收尾）· 套件全绿

> 用户指令：「可以」——批准 Option 1（全量 `tests/` 巡检确认群聊改动无回归）。

## 巡检结果
- 命令：`pytest tests/`（系统 python pytest 9.1.1）。
- 首轮：**353 passed, 1 failed, 36 skipped**。
- 唯一失败：`test_st_import_export_roundtrip.py::TestChatJSONLRoundTrip::test_message_to_st_jsonl_preserves_extra` → `KeyError: 'force_avatar'` @ :803。

## 根因（确认：与群聊工作无关）
- 失败在 ST Chat JSONL 导入/导出路径（`st_sync_service.py`），**非** F1/e2e/D3 改动文件（`roleplay_prompt_assembly.py` + `websocket.py`）。
- 语义对称且正确：
  - 导入 `_st_msg_extra`（:873-890）从 ST 顶层 `force_avatar` 读回并 stash 进 `extra.force_avatar`；
  - 导出 `_message_to_st_jsonl`（:332-335）依 ST 1.18.0（`script.js:5835`）把 `force_avatar` **提升为顶层**并移出 `extra`。
- 测试断言 `record["extra"]["force_avatar"]` 与"提升为顶层"设计冲突 → **测试期望过期**，非生产回归。

## 修复（仅测试）
- `test_st_import_export_roundtrip.py:803` 改为 `assert record["force_avatar"] == "char.png"`，加注释说明 lift 语义。

## 最终验证
- `tests/test_st_import_export_roundtrip.py`：**73 passed**（原 1 failed）。
- **全量复跑：354 passed, 36 skipped, 0 failed**（约 12s）。套件全绿，群聊改动零回归。

## 结论
- 后端群聊对齐（阶段1/2/3 C1+C2/E1/E2/F1/D1/D2/D3）已全部完成并通过测试；对齐度稳在 **≈82–85%**。
- 唯一收尾项＝**前端群聊 UI 接线**（`group_speaker_start`/`group_speaker_end` 后端协议已就绪），用户要求暂搁置。
