# ST-Compat Prompt 装配最终对齐 - 验收检查手册

> **使用方法**：每个 Phase 完成后，逐条核对本检查清单。所有检查项必须通过（✅）才能进入下一 Phase。
> 最终交付前，**全部检查项**必须通过。

---

## Phase 0：基线备份与 Golden Vector 提取

### 备份验证
- [ ] `backups/FB-0/db_dump_st_compat_final.sql` 文件存在且大小 > 0
- [ ] `backups/FB-0/baseline_test_results.txt` 文件存在且包含 Phase 0 测试输出
- [ ] git tag `baseline-pre-st-compat-final` 已创建
- [ ] docker tag `palink-ai-backend:baseline-pre-st-compat-final` 已创建

### Golden Vector 提取验证
- [ ] `scripts/extract_st_golden_vector.py` 文件存在且可执行
- [ ] `backend/tests/st_compat/golden_vectors/01_single_char_jailbreak.json` 文件存在且包含 ST 1.18.0 真实输出的 `messages` 数组
- [ ] `backend/tests/st_compat/golden_vectors/02_group_default.json` 文件存在
- [ ] `backend/tests/st_compat/golden_vectors/03_group_completion.json` 文件存在
- [ ] `backend/tests/st_compat/golden_vectors/04_wi_format_outlet.json` 文件存在
- [ ] `backend/tests/st_compat/golden_vectors/05_long_chat_trim_pin_true.json` 文件存在
- [ ] `backend/tests/st_compat/golden_vectors/05_long_chat_trim_pin_false.json` 文件存在
- [ ] 每个 golden vector JSON 包含元数据：`scenario_name`、`st_version`、`extracted_at`、`messages`

### Golden Vector 测试框架验证
- [ ] `backend/tests/test_st_compat_golden_vector.py` 文件存在
- [ ] `compare_messages(actual, golden)` 函数已实现（允许空格/换行微差，不允许内容/顺序/字段差异）
- [ ] 5 个测试用例已定义，且初始状态为 `@pytest.mark.xfail`
- [ ] 运行 `pytest backend/tests/test_st_compat_golden_vector.py -v` 全部 xfail（符合预期）

---

## Phase 1：P1 D1 — G14 jailbreak 索引 11 修复

### 模型与 Migration 验证
- [ ] `backend/app/models/character.py` 中 `Character` 类新增 `jailbreak = Column(Text, nullable=True)` 字段
- [ ] `backend/app/models/system.py` 中 `UserSetting` 类新增 `jailbreak = Column(Text, nullable=True)` 字段
- [ ] alembic migration 文件存在，新增 `characters.jailbreak` 和 `user_settings.jailbreak` 两列
- [ ] `docker exec palink-ai-backend-1 alembic upgrade head` 成功执行
- [ ] 数据库中 `characters.jailbreak` 和 `user_settings.jailbreak` 列存在且默认 NULL

### 导入与同步验证
- [ ] `backend/app/character_card.py:289-352` `convert_chara_card_to_character` 函数读取 V3 卡 `data.extensions.jailbreak` / `data.jailbreak`，写入 `Character.jailbreak`
- [ ] V2 卡导入时 `data.post_history_instructions` 同时写入 `Character.post_history_instructions` 和 `Character.jailbreak`（向后兼容）
- [ ] `backend/app/api/silly_tavern.py` `/api/settings/save` 端点从请求 body 提取 jailbreak 同步到 `UserSetting.jailbreak`
- [ ] `/api/settings/get` 端点将 `UserSetting.jailbreak` 反向同步到响应

### 装配逻辑验证
- [ ] `backend/app/services/roleplay_prompt_assembly.py:2390-2425` 调用处删除 `jailbreak=""` 硬编码
- [ ] 调用处实现 `char_jailbreak` / `user_jailbreak` / `prefer_char_jb` 合并逻辑
- [ ] `backend/app/services/character_message_builder.py:584-595` 修正覆盖语义：`jailbreak` 参数 → `char.post_history_instructions` → `context_template.jailbreak`
- [ ] **已删除**原代码中 `context_template.jailbreak` 覆盖 `char.post_history_instructions` 的 bug 逻辑

### 宏修复验证
- [ ] `backend/app/services/macro_service.py:310-312` `{{charjailbreak}}` 宏读取 `char.jailbreak`（而非 `char.jailbreak_prompt`）
- [ ] 注释已修正为"`jailbreak` 是 Palink Character 模型中对应 ST 1.18.0 角色卡 jailbreak 的字段"

### 单元测试验证
- [ ] `backend/tests/test_st_compat_jailbreak.py` 文件存在
- [ ] 测试覆盖 4 个 Scenario：角色卡优先 / 用户全局回退 / context_template 回退 / 全空不注入
- [ ] 测试 V2 卡导入时 `Character.jailbreak` 与 `Character.post_history_instructions` 同时写入
- [ ] 测试 V3 卡导入时 `Character.jailbreak` 优先从 `data.extensions.jailbreak` 读取
- [ ] 测试 `{{charjailbreak}}` 宏返回 `char.jailbreak` 而非 None
- [ ] `pytest backend/tests/test_st_compat_jailbreak.py -v` 全部通过

### Golden Vector 场景 1 验证
- [ ] `test_scenario_01_single_char_jailbreak` 的 `xfail` 标记已移除
- [ ] `pytest backend/tests/test_st_compat_golden_vector.py::test_scenario_01_single_char_jailbreak -v` 通过

---

## Phase 2：P1 D2 — G13 names_behavior 四态 + 群聊名字

### 签名扩展验证
- [ ] `build_st_compat_messages` 签名新增 `names_behavior: int = 0` 参数
- [ ] 签名新增 `is_group: bool = False` 参数
- [ ] 签名新增 `user_name: str = ""` 参数
- [ ] 签名新增 `narrator_type: str = "narrator"` 参数
- [ ] 参数注释引用 ST 1.18.0 源码位置（`openai.js:204-209` / `openai.js:586-603`）

### 历史消息字段读取验证
- [ ] `character_message_builder.py:528-544` 历史消息构建循环读取 `m.name` 字段
- [ ] 循环读取 `m_extra.force_avatar` 字段（从 `CharacterChatMessage.extra` JSON 中解析）
- [ ] 循环读取 `m_extra.type` 字段（narrator 类型）
- [ ] `_sanitize_name(name)` 辅助函数已实现，与 ST `sanitizeName` 一致

### 四态注入逻辑验证
- [ ] `NONE(-1)` 模式：不前缀、不加 name 字段
- [ ] `DEFAULT(0)` 模式：`(is_group and name != user_name) or (force_avatar and name != user_name and type != narrator_type)` 时拼 `Name: content`
- [ ] `COMPLETION(1)` 模式：消息对象添加 `name` 字段（经 `_sanitize_name`），content 不变
- [ ] `CONTENT(2)` 模式：`type != narrator_type` 时拼 `Name: content`
- [ ] NARRATOR 类型在 DEFAULT 和 CONTENT 模式下不前缀

### 调用处验证
- [ ] `roleplay_prompt_assembly.py:2390-2425` 调用处传入 `names_behavior`（从 `oai_settings` 读取）
- [ ] 调用处传入 `is_group=bool(req.group_id)`
- [ ] 调用处传入 `user_name=req.user.username`
- [ ] `_read_oai_settings_int` 辅助函数已实现

### 单元测试验证
- [ ] `backend/tests/test_st_compat_names_behavior.py` 文件存在
- [ ] 测试覆盖 6 个 Scenario：NONE / DEFAULT+group / DEFAULT+force_avatar / COMPLETION / CONTENT / NARRATOR 豁免
- [ ] 测试单聊场景下 DEFAULT 模式不加前缀
- [ ] 测试群聊场景下 DEFAULT 模式对非用户消息加前缀
- [ ] `pytest backend/tests/test_st_compat_names_behavior.py -v` 全部通过

### Golden Vector 场景 2/3 验证
- [ ] `test_scenario_02_group_default` 的 `xfail` 标记已移除
- [ ] `test_scenario_03_group_completion` 的 `xfail` 标记已移除
- [ ] 两个测试用例通过

---

## Phase 3：P1 D3 — wi_format 包裹

### 签名与工具函数验证
- [ ] `build_st_compat_messages` 签名新增 `wi_format: str = ""` 参数
- [ ] `_apply_wi_format(content, wi_format)` 函数已实现
- [ ] 函数逻辑与 ST `openai.js:780-792` `formatWorldInfo` 一致（空 format 返回原值，否则 `wi_format.replace("{0}", content)`）

### 注入点应用验证
- [ ] `character_message_builder.py:434` before 条目插入前调用 `_apply_wi_format`
- [ ] `character_message_builder.py:457` after 条目插入前调用 `_apply_wi_format`
- [ ] `character_message_builder.py:577` depth 条目插入前调用 `_apply_wi_format`
- [ ] **未**对 EMTop/EMBottom/ANTop/ANBottom 条目应用 wi_format（与 ST 行为一致）

### 调用处验证
- [ ] `roleplay_prompt_assembly.py` 调用处传入 `wi_format`（从 `oai_settings.wi_format` 读取）
- [ ] `_read_oai_settings_str` 辅助函数已实现

### 单元测试验证
- [ ] `backend/tests/test_st_compat_wi_format.py` 文件存在
- [ ] 测试覆盖 3 个 Scenario：空 format / 非空 format / 多条目
- [ ] 测试默认 wi_format="" 时行为与修复前一致（向后兼容）
- [ ] `pytest backend/tests/test_st_compat_wi_format.py -v` 全部通过

### Golden Vector 场景 4 验证（部分）
- [ ] wi_format 包裹部分与 golden vector 一致（outlet 部分本就可达，不验证）

---

## Phase 4：P1 D4 — token 预算裁剪

### 裁剪逻辑验证
- [ ] `_apply_st_compat_history_trim(messages, token_budget, prompt_sources, report)` 函数已实现
- [ ] 函数识别 chat_history 区段（通过 `prompt_sources` 标识符或 messages metadata）
- [ ] 函数计算强制项总 token 数（main/worldInfoBefore/personaDescription/charDescription/charPersonality/scenario/worldInfoAfter/dialogueExamples/jailbreak/authorsNote）
- [ ] 剩余预算 = `token_budget * 0.7 - 强制项总 token`（0.7 = ST 默认历史保留比例）
- [ ] 从 chat_history 中间裁剪最旧消息，保留开头 N 条 + 末尾 M 条

### st-compat 路径启用验证
- [ ] `roleplay_prompt_assembly.py:2648-2654` st-compat 分支调用 `_apply_st_compat_history_trim`
- [ ] st-compat 路径**仍跳过** `_apply_full_prompt_order`（装配序由 builder 固定）
- [ ] st-compat 路径**不再跳过** chat_history token 裁剪

### recent_messages_budget 软上限验证
- [ ] `character_message_builder.py:503-507` `history_limit` 改为软上限
- [ ] 优先按 token 估算裁剪，条数作为兜底

### 单元测试验证
- [ ] `backend/tests/test_st_compat_token_budget.py` 文件存在
- [ ] 测试覆盖 4 个 Scenario：超预算裁剪 / pin_examples=true / pin_examples=false / 强制项不被裁剪
- [ ] 测试 token 估算准确性（与 ST 1.18.0 tiktoken 一致，允许 ±5% 误差）
- [ ] `pytest backend/tests/test_st_compat_token_budget.py -v` 全部通过

### Golden Vector 场景 5 验证
- [ ] `test_scenario_05_long_chat_trim_pin_true` 的 `xfail` 标记已移除
- [ ] `test_scenario_05_long_chat_trim_pin_false` 的 `xfail` 标记已移除
- [ ] 两个测试用例通过

---

## Phase 5：P2 D5/D6/D7 — 群聊 nudge + pin_examples + scenario/personality_format

### 签名扩展验证
- [ ] `build_st_compat_messages` 签名新增 `pin_examples: bool = False`
- [ ] 签名新增 `scenario_format: str = "{{scenario}}"`
- [ ] 签名新增 `personality_format: str = "{{personality}}"`
- [ ] 签名新增 `new_group_chat_prompt: str = "[Start a new group chat. Group members: {{group}}]"`
- [ ] 签名新增 `group_nudge: str = ""`

### scenario/personality_format 验证
- [ ] `_apply_field_format(text, fmt, sub_func)` 函数已实现
- [ ] `character_message_builder.py:446` scenario 字段应用 `scenario_format`
- [ ] `character_message_builder.py:450` personality 字段应用 `personality_format`
- [ ] 默认 format（`{{scenario}}` / `{{personality}}`）行为与未包裹等价（向后兼容）
- [ ] 空 format 时字段插入为空字符串（与 ST 行为一致）

### new_group_chat_prompt + group_nudge 验证
- [ ] `character_message_builder.py:411-416` `is_group=True` 时使用 `new_group_chat_prompt`
- [ ] `{{group}}` 替换为成员名列表（逗号分隔）
- [ ] jailbreak 之后、chatHistory 之前，若 `is_group && group_nudge`，注入 nudge system 消息
- [ ] 单聊（`is_group=False`）使用原 `new_chat_prompt`，不注入 nudge

### pin_examples 装配顺序验证
- [ ] `character_message_builder.py:488` 根据 `pin_examples` 决定装配顺序
- [ ] `pin_examples=True`：先装 dialogueExamples，后装 chatHistory
- [ ] `pin_examples=False`：先装 chatHistory，后装 dialogueExamples
- [ ] 配合 Phase 4 token 预算裁剪，pin_examples 语义正确

### 调用处验证
- [ ] `roleplay_prompt_assembly.py` 调用处传入所有 P2 参数
- [ ] 参数从 `oai_settings` / `power_user` JSON 中正确读取

### 单元测试验证
- [ ] `backend/tests/test_st_compat_p2_features.py` 文件存在
- [ ] 测试覆盖所有 P2 Scenario
- [ ] `pytest backend/tests/test_st_compat_p2_features.py -v` 全部通过

---

## Phase 6：D8/D9/D10 — 群聊路径接通 + 死代码修复 + dynamic_context_parts 接入

### D8 群聊装配路径接通验证
- [ ] `backend/app/api/character_ext.py:3732-3756` `CharacterChatRequest` 新增 `group_id: Optional[str] = None`
- [ ] `CharacterChatRequest` 新增 `current_speaker_id: Optional[str] = None`
- [ ] `character_ext.py:4101-4130` 调用处透传 `group_id` / `current_speaker_id` 到 `PromptAssemblyRequest`
- [ ] `backend/app/api/websocket.py:1403-1431` 调用处从 WebSocket 消息解析 `group_id` 并透传
- [ ] `backend/app/api/silly_tavern.py:3423-3447` 调用处从 ST 请求上下文解析 `group_id` 并透传
- [ ] `assemble_roleplay_prompt` 内 `_resolve_group_speaker` 在 `group_id` 非空时被触发
- [ ] `_build_group_profile_context` 在 `group_id` 非空时被触发

### D9 {{charjailbreak}} 宏死代码修复验证
- [ ] `macro_service.py:310-312` 已改为读取 `char.jailbreak`（Phase 1 Task 1.6 已完成）
- [ ] 测试 `{{charjailbreak}}` 宏在 `Character.jailbreak` 有值时返回该值
- [ ] 测试 `{{charjailbreak}}` 宏在 `Character.jailbreak` 为 None 时返回 None

### D10 dynamic_context_parts 接入验证
- [ ] `build_st_compat_messages` 函数体在合适位置（jailbreak 之后、chatHistory 之前）注入 `dynamic_context_parts`
- [ ] 注入的内容为 `dynamic_context_parts` 拼接的 system 消息
- [ ] 单元测试验证 st-compat 路径下 memory/plotline 内容出现在最终 messages 中

### 端到端集成测试验证
- [ ] `backend/tests/test_st_compat_group_chat_e2e.py` 文件存在
- [ ] 测试模拟群聊请求（含 `group_id`），验证 `_resolve_group_speaker` 被触发
- [ ] 测试验证群聊 nudge 注入、names_behavior 正确应用
- [ ] 测试单聊请求（无 `group_id`）不受影响
- [ ] `pytest backend/tests/test_st_compat_group_chat_e2e.py -v` 全部通过

---

## Phase 7：清单订正与文档更新

### docs/st-compat-gap.md 订正验证
- [ ] P1 outlet 项已订正为"经后置 macro pass 解析，内容可达，不再是差距"
- [ ] 订正内容包含 `roleplay_prompt_assembly.py:2602-2622` 后置 macro pass 的解释
- [ ] P1 G14 项 jailbreak 字段来源已订正为 `data.post_history_instructions`
- [ ] 订正内容包含 V3 spec 允许 `data.extensions.jailbreak` 作为独立字段的说明
- [ ] 第 1 节"作者备注 5 态"已订正为"ST 1.18.0 实际 3 态，Palink 5 态是扩展"
- [ ] 订正内容包含 `authors-note.js:81-88` 源码位置引用

### project_memory.md 更新验证
- [ ] `c:\Users\Pall\.trae-cn\memory\projects\-d----Palink-AI\project_memory.md` 的 "Lessons Learned" 已新增 5 条条目
- [ ] 条目覆盖：jailbreak 字段来源、作者备注 3 态、outlet 后置 macro pass、{{charjailbreak}} 宏修正、dynamic_context_parts 接入

---

## Phase 8：端到端 Golden Vector 验证与最终回归

### Docker 容器重建验证
- [ ] `docker compose down && docker compose build backend && docker compose up -d` 成功执行
- [ ] `curl http://localhost:8000/health` 返回 200
- [ ] `docker exec palink-ai-backend-1 alembic upgrade head` 成功执行
- [ ] 数据库中 `characters.jailbreak` 和 `user_settings.jailbreak` 列存在

### 全量 Golden Vector 验证
- [ ] `pytest backend/tests/test_st_compat_golden_vector.py -v` 5 个场景全部通过
- [ ] 场景 1（单角色 + jailbreak）通过
- [ ] 场景 2（群聊 + DEFAULT）通过
- [ ] 场景 3（群聊 + COMPLETION）通过
- [ ] 场景 4（wi_format + outlet）通过
- [ ] 场景 5（长对话 + token 裁剪，pin_examples true/false）两个变体均通过

### 全量回归测试验证
- [ ] `pytest backend/tests/ -v --tb=short` 全部通过
- [ ] 对比 Phase 0 基线，无回归（通过测试数 ≥ 基线）
- [ ] `pytest backend/tests/test_st_contract.py -v` 通过
- [ ] `pytest backend/tests/test_author_note_position.py -v` 通过

### 性能回归测试验证
- [ ] 提示词组装 P95 < 200ms
- [ ] 对比 Phase 0 基线，无性能退步

### ST Sidecar 代理验证
- [ ] Palink-owned API（`/api/characters/get` 等）仍由 Palink 处理
- [ ] 非 owned API 仍透明代理（面 B 模式下 `/api/backends/chat-completions/generate`）
- [ ] `X-Palink-*` header 注入正常

### 最终备份与 git tag 验证
- [ ] `git add -A && git commit -m "feat: align st-compat prompt assembly with ST 1.18.0 final parity"` 成功
- [ ] docker tag `palink-ai-backend:st-compat-final-parity` 已创建
- [ ] `backups/st-compat-final-parity/db_dump.sql` 文件存在
- [ ] git tag `st-compat-prompt-final-parity` 已创建

---

## 最终验收总览

### 7 项清单内 P1/P2 差距修复验证
- [ ] **D1 G14 jailbreak 索引 11**：Character.jailbreak + UserSetting.jailbreak 字段已添加，调用处不再硬编码空串，覆盖语义与 ST 一致
- [ ] **D2 G13 names_behavior 四态**：build_st_compat_messages 支持 NONE/DEFAULT/COMPLETION/CONTENT 四态，群聊名字正确注入
- [ ] **D3 wi_format 包裹**：before/after/depth 条目应用 wi_format，与 ST `formatWorldInfo` 一致
- [ ] **D4 token 预算裁剪**：st-compat 路径启用 chat_history token 裁剪，支持 pin_examples 装配顺序
- [ ] **D5 new_group_chat_prompt + group nudge**：群聊起始标记与 nudge 注入已实现
- [ ] **D6 pin_examples**：装配顺序与 ST 一致
- [ ] **D7 scenario/personality_format**：格式串包裹已实现

### 3 项新发现差距修复验证
- [ ] **D8 群聊装配路径接通**：CharacterChatRequest 新增 group_id 字段，三个调用点透传，群聊分支不再为 dead code
- [ ] **D9 {{charjailbreak}} 宏死代码修复**：宏读取 char.jailbreak 而非 char.jailbreak_prompt
- [ ] **D10 dynamic_context_parts 接入**：memory/plotline 等内容在 st-compat 路径下进入 prompt

### 3 项清单订正验证
- [ ] outlet (pos 7) 项订正为"不再是差距"
- [ ] jailbreak 字段来源订正为 `data.post_history_instructions`
- [ ] 作者备注 5 态订正为"ST 1.18.0 实际 3 态，Palink 5 态是扩展"

### 端到端 Golden Vector 验证
- [ ] 5 个核心场景（6 个测试用例）全部通过
- [ ] Golden vector 来自 ST 1.18.0 真实浏览器输出，非自洽

### 验收标准最终确认
- [ ] **7 项 P1/P2 差距全部修复**（D1-D7），并通过单元测试
- [ ] **3 项新发现差距全部修复**（D8-D10），并通过单元测试
- [ ] **5 个核心场景 golden vector 测试全部通过**
- [ ] **清单 3 处错误描述已订正**
- [ ] **回归测试无退步**
- [ ] **性能 P95 < 200ms**
- [ ] **Docker 容器重建后所有测试通过**

---

## 风险与回滚

### 风险点
1. **Phase 4 token 预算裁剪**：可能与现有 `_apply_dynamic_trimming` 逻辑冲突，需仔细测试
2. **Phase 6 D8 群聊路径接通**：可能暴露既有群聊分支的隐藏 bug（之前是 dead code）
3. **Phase 1 jailbreak 覆盖语义修改**：可能影响存量角色卡的行为（依赖 `context_template.jailbreak` 覆盖的角色）

### 回滚方案
- Phase 0 已创建 `baseline-pre-st-compat-final` git tag 和 docker tag
- 若任一 Phase 严重失败，可 `git reset --hard baseline-pre-st-compat-final` + `docker tag palink-ai-backend:baseline-pre-st-compat-final palink-ai-backend:latest`
- 数据库回滚：`docker exec palink-ai-db-1 psql -U palink -c "DROP TABLE IF EXISTS characters_jailbreak_backup;"` + `pg_restore` from `backups/FB-0/db_dump_st_compat_final.sql`
