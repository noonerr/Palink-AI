# ST-Compat Prompt 装配最终对齐 - 任务分解

> **执行规则**：严格按 Phase 顺序执行，每个 Phase 完成验收后才能开始下一个。每个 SubTask 前执行增量备份。
> **依据**: `spec.md` 中的 D1-D10 共 10 项差距。
> **基线**: `docs/st-compat-gap.md` + ST 1.18.0 官方源码。

---

## Phase 0：基线备份与 Golden Vector 提取

- [ ] Task 0.1：执行全量备份 FB-0
  - [ ] SubTask 0.1.1：`git add -A && git commit -m "backup: full backup point FB-0 pre-st-compat-final-parity"`
  - [ ] SubTask 0.1.2：`docker tag palink-ai-backend:latest palink-ai-backend:baseline-pre-st-compat-final`
  - [ ] SubTask 0.1.3：`docker exec palink-ai-db-1 pg_dump -U palink palink > backups/FB-0/db_dump_st_compat_final.sql`
  - [ ] SubTask 0.1.4：`git tag baseline-pre-st-compat-final`
- [ ] Task 0.2：记录回归基准测试输出
  - [ ] SubTask 0.2.1：`pytest backend/tests/ -v --tb=short` → 保存到 `backups/FB-0/baseline_test_results.txt`
  - [ ] SubTask 0.2.2：`pytest backend/tests/test_st_contract.py -v` → 追加到基准文件
  - [ ] SubTask 0.2.3：`pytest backend/tests/test_author_note_position.py -v` → 追加到基准文件
  - [ ] SubTask 0.2.4：记录 alembic 当前版本 → `docker exec palink-ai-backend-1 alembic current`
- [ ] Task 0.3：编写 ST 1.18.0 Golden Vector 提取脚本
  - [ ] SubTask 0.3.1：创建 `scripts/extract_st_golden_vector.py`，提供从 ST 1.18.0 浏览器端导出 prompt JSON 的指导文档与辅助代码
  - [ ] SubTask 0.3.2：在脚本中包含 5 个核心场景的测试用例定义（角色卡 + 设置 + 消息历史）
  - [ ] SubTask 0.3.3：脚本输出格式：`backend/tests/st_compat/golden_vectors/{scenario_name}.json`，包含 `messages` 数组 + 元数据
- [ ] Task 0.4：手工提取 5 个核心场景的 Golden Vector
  - [ ] SubTask 0.4.1：启动 ST 1.18.0（`d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\`），用浏览器打开
  - [ ] SubTask 0.4.2：场景 1（单角色 + jailbreak）：导入含 `post_history_instructions` 的角色卡，设置用户全局 jailbreak，发送 1 条消息，从浏览器 DevTools 抓取 `/api/backends/chat-completions/generate` 请求 body 中的 `messages` 数组，保存为 `golden_vectors/01_single_char_jailbreak.json`
  - [ ] SubTask 0.4.3：场景 2（群聊 + DEFAULT）：创建 3 成员群聊，`names_behavior=0`，发送 1 条消息，抓取 messages，保存为 `golden_vectors/02_group_default.json`
  - [ ] SubTask 0.4.4：场景 3（群聊 + COMPLETION）：同场景 2 但 `names_behavior=1`，保存为 `golden_vectors/03_group_completion.json`
  - [ ] SubTask 0.4.5：场景 4（wi_format + outlet）：设置 `wi_format="[World Info: {0}]"`，角色描述中引用 `{{outlet::test}}`，世界书中含 pos 7 outlet 条目，保存为 `golden_vectors/04_wi_format_outlet.json`
  - [ ] SubTask 0.4.6：场景 5（长对话 + token 裁剪）：50+ 条消息历史，`max_context_tokens=4096`，触发裁剪，分别保存 `pin_examples=true` 和 `false` 两个变体为 `golden_vectors/05_long_chat_trim_pin_true.json` 和 `golden_vectors/05_long_chat_trim_pin_false.json`
- [ ] Task 0.5：编写 Golden Vector 对比测试框架
  - [ ] SubTask 0.5.1：创建 `backend/tests/test_st_compat_golden_vector.py`，定义 `compare_messages(actual, golden)` 函数（允许空格/换行微差，不允许内容/顺序/字段差异）
  - [ ] SubTask 0.5.2：为每个场景创建测试用例 `test_scenario_01_single_char_jailbreak` 等
  - [ ] SubTask 0.5.3：测试用例标记 `@pytest.mark.xfail(reason="待 Phase 1-6 修复")`，确保基线状态下预期失败

---

## Phase 1：P1 D1 — G14 jailbreak 索引 11 修复

- [ ] Task 1.1：Character 模型新增 jailbreak 字段
  - [ ] SubTask 1.1.1：修改 `backend/app/models/character.py`，在 `post_history_instructions` 字段后新增 `jailbreak = Column(Text, nullable=True)` 字段
  - [ ] SubTask 1.1.2：字段注释明确："`jailbreak` 字段对应 ST 1.18.0 角色卡高级定义的 jailbreak（V3: `data.extensions.jailbreak` 或 `data.jailbreak`），与 `post_history_instructions` 分离存储。ST 1.18.0 默认使用 `post_history_instructions` 作为 jailbreak override，但 V3 spec 允许独立 `jailbreak` 字段。"
  - [ ] SubTask 1.1.3：创建 alembic migration `XXXXXXXXXXXX_add_character_jailbreak.py`，新增 `characters.jailbreak TEXT NULL` 列
- [ ] Task 1.2：UserSetting 模型新增 jailbreak 字段
  - [ ] SubTask 1.2.1：修改 `backend/app/models/system.py` 的 `UserSetting` 类，在 `author_note_depth` 字段后新增 `jailbreak = Column(Text, nullable=True)` 字段
  - [ ] SubTask 1.2.2：字段注释明确："`jailbreak` 字段对应 ST 1.18.0 主界面 Jailbreak 框（用户全局 jailbreak），与 `power_user` JSON 中的 jailbreak 同步。"
  - [ ] SubTask 1.2.3：在同一 alembic migration 中新增 `user_settings.jailbreak TEXT NULL` 列
- [ ] Task 1.3：角色卡导入时提取 jailbreak 字段
  - [ ] SubTask 1.3.1：修改 `backend/app/character_card.py:289-352` `convert_chara_card_to_character`，在 `post_history_instructions` 提取后新增 jailbreak 提取逻辑：
    - V3 卡：优先 `data.extensions.jailbreak`，回退 `data.jailbreak`
    - V2 卡：`data.post_history_instructions`（同时写入 `Character.post_history_instructions` 和 `Character.jailbreak`，保持向后兼容）
  - [ ] SubTask 1.3.2：修改 `backend/app/services/character_import_service.py`（如有），同步更新提取逻辑
- [ ] Task 1.4：UserSetting 同步 jailbreak
  - [ ] SubTask 1.4.1：修改 `backend/app/api/silly_tavern.py` `/api/settings/save` 端点，从请求 body 中的 `power_user.jailbreak` 或 `extension_settings.jailbreak` 提取，同步到 `UserSetting.jailbreak`
  - [ ] SubTask 1.4.2：修改 `/api/settings/get` 端点，将 `UserSetting.jailbreak` 反向同步到响应的 `power_user.jailbreak` / `extension_settings.jailbreak` 字段
- [ ] Task 1.5：修正 build_st_compat_messages 调用处与函数体
  - [ ] SubTask 1.5.1：修改 `backend/app/services/roleplay_prompt_assembly.py:2390-2425` 调用处，删除 `jailbreak=""` 硬编码，改为：
    ```python
    char_jailbreak = (req.char.jailbreak or "").strip()
    user_jailbreak = (user_setting.jailbreak or "").strip()
    prefer_char_jb = _read_power_user_bool(user_setting, "prefer_character_jailbreak", default=True)
    jailbreak_for_st = char_jailbreak if (prefer_char_jb and char_jailbreak) else user_jailbreak
    ```
  - [ ] SubTask 1.5.2：修改 `backend/app/services/character_message_builder.py:584-595`，调整覆盖语义：
    - 第一优先级：`jailbreak` 参数（来自调用处的合并逻辑）
    - 第二优先级：`char.post_history_instructions`（向后兼容，ST 1.18.0 默认行为）
    - 第三优先级：`context_template.jailbreak`（仅当以上均空）
    - **删除**当前代码中 `context_template.jailbreak` 覆盖 `char.post_history_instructions` 的逻辑（bug）
- [ ] Task 1.6：修正 {{charjailbreak}} 宏
  - [ ] SubTask 1.6.1：修改 `backend/app/services/macro_service.py:310-312`，将 `getattr(char, "jailbreak_prompt", None)` 改为 `getattr(char, "jailbreak", None)`
  - [ ] SubTask 1.6.2：修正注释：从"`jailbreak_prompt` 是 Palink Character 模型中对应 ST jailbreak_prompt 的字段"改为"`jailbreak` 是 Palink Character 模型中对应 ST 1.18.0 角色卡 jailbreak 的字段（V3: `data.extensions.jailbreak`）"
- [ ] Task 1.7：单元测试
  - [ ] SubTask 1.7.1：创建 `backend/tests/test_st_compat_jailbreak.py`，覆盖 spec 中 4 个 Scenario（角色卡优先 / 用户全局回退 / context_template 回退 / 全空不注入）
  - [ ] SubTask 1.7.2：测试 V2 卡导入时 `Character.jailbreak` 与 `Character.post_history_instructions` 同时写入
  - [ ] SubTask 1.7.3：测试 V3 卡导入时 `Character.jailbreak` 优先从 `data.extensions.jailbreak` 读取
  - [ ] SubTask 1.7.4：测试 `{{charjailbreak}}` 宏返回 `char.jailbreak` 而非 None
- [ ] Task 1.8：Golden Vector 场景 1 验证
  - [ ] SubTask 1.8.1：移除 `test_st_compat_golden_vector.py::test_scenario_01_single_char_jailbreak` 的 `xfail` 标记
  - [ ] SubTask 1.8.2：运行测试，确认通过；若失败，分析 diff 并修复

---

## Phase 2：P1 D2 — G13 names_behavior 四态 + 群聊名字

- [ ] Task 2.1：扩展 build_st_compat_messages 签名
  - [ ] SubTask 2.1.1：修改 `backend/app/services/character_message_builder.py` `build_st_compat_messages` 签名，新增参数：
    ```python
    names_behavior: int = 0,  # -1=NONE, 0=DEFAULT, 1=COMPLETION, 2=CONTENT
    is_group: bool = False,
    user_name: str = "",  # ST name1
    narrator_type: str = "narrator",  # ST system_message_types.NARRATOR
    ```
  - [ ] SubTask 2.1.2：参数注释引用 ST 1.18.0 源码位置（`openai.js:204-209` / `openai.js:586-603`）
- [ ] Task 2.2：实现历史消息 name/force_avatar/type 读取
  - [ ] SubTask 2.2.1：修改 `character_message_builder.py:528-544` 历史消息构建循环，读取 `m.name`、`m_extra.force_avatar`、`m_extra.type` 字段
  - [ ] SubTask 2.2.2：确保 `CharacterChatMessage.name` 字段已存储（已存在，仅确认读取路径）
  - [ ] SubTask 2.2.3：实现 `_sanitize_name(name)` 辅助函数，与 ST `openai.js` 的 `sanitizeName` 一致（替换非字母数字字符为 `_`）
- [ ] Task 2.3：实现四态注入逻辑
  - [ ] SubTask 2.3.1：实现 `NONE(-1)` 模式：不前缀、不加 name 字段
  - [ ] SubTask 2.3.2：实现 `DEFAULT(0)` 模式：`(is_group and name != user_name) or (force_avatar and name != user_name and type != narrator_type)` 时拼 `Name: content`
  - [ ] SubTask 2.3.3：实现 `COMPLETION(1)` 模式：消息对象添加 `name` 字段（经 `_sanitize_name`），content 不变
  - [ ] SubTask 2.3.4：实现 `CONTENT(2)` 模式：`type != narrator_type` 时拼 `Name: content`
  - [ ] SubTask 2.3.5：实现 NARRATOR 类型豁免：DEFAULT 和 CONTENT 模式下，narrator 类型消息不前缀
- [ ] Task 2.4：调用处传入 names_behavior
  - [ ] SubTask 2.4.1：修改 `backend/app/services/roleplay_prompt_assembly.py:2390-2425`，调用处传入：
    ```python
    names_behavior=_read_oai_settings_int(user_setting, "names_behavior", default=0),
    is_group=bool(req.group_id),
    user_name=req.user.username if req.user else "",
    narrator_type="narrator",
    ```
  - [ ] SubTask 2.4.2：实现 `_read_oai_settings_int(user_setting, key, default)` 辅助函数，从 `UserSetting.silly_tavern_settings` JSON 中读取 `oai_settings.{key}`，回退到默认值
- [ ] Task 2.5：单元测试
  - [ ] SubTask 2.5.1：创建 `backend/tests/test_st_compat_names_behavior.py`，覆盖 spec 中 6 个 Scenario（NONE / DEFAULT+group / DEFAULT+force_avatar / COMPLETION / CONTENT / NARRATOR 豁免）
  - [ ] SubTask 2.5.2：测试单聊场景下 DEFAULT 模式不加前缀（与 ST 1.18.0 单聊行为一致）
  - [ ] SubTask 2.5.3：测试群聊场景下 DEFAULT 模式对非用户消息加前缀
- [ ] Task 2.6：Golden Vector 场景 2/3 验证
  - [ ] SubTask 2.6.1：移除 `test_scenario_02_group_default` 和 `test_scenario_03_group_completion` 的 `xfail` 标记
  - [ ] SubTask 2.6.2：运行测试，确认通过

---

## Phase 3：P1 D3 — wi_format 包裹

- [ ] Task 3.1：扩展 build_st_compat_messages 签名
  - [ ] SubTask 3.1.1：修改 `character_message_builder.py` `build_st_compat_messages` 签名，新增 `wi_format: str = ""` 参数
- [ ] Task 3.2：实现 _apply_wi_format 工具函数
  - [ ] SubTask 3.2.1：在 `character_message_builder.py` 新增 `_apply_wi_format(content: str, wi_format: str) -> str` 函数，逻辑：
    ```python
    def _apply_wi_format(content: str, wi_format: str) -> str:
        if not content:
            return ""
        if not wi_format or not wi_format.strip():
            return content
        return wi_format.replace("{0}", content)
    ```
  - [ ] SubTask 3.2.2：与 ST `openai.js:780-792` `formatWorldInfo` 行为完全一致（空 format 返回原值，否则 `stringFormat(format, value)`）
- [ ] Task 3.3：在 before/after/depth 注入点应用 wi_format
  - [ ] SubTask 3.3.1：修改 `character_message_builder.py:434`，before 条目插入前调用 `_apply_wi_format(world_info_before.strip(), wi_format)`
  - [ ] SubTask 3.3.2：修改 `character_message_builder.py:457`，after 条目插入前调用 `_apply_wi_format`
  - [ ] SubTask 3.3.3：修改 `character_message_builder.py:577`，depth 条目插入前调用 `_apply_wi_format`
  - [ ] SubTask 3.3.4：**不**对 EMTop/EMBottom/ANTop/ANBottom 条目应用 wi_format（ST 行为：仅 before/after/depth 三类条目应用）
- [ ] Task 3.4：调用处传入 wi_format
  - [ ] SubTask 3.4.1：修改 `roleplay_prompt_assembly.py:2390-2425`，调用处传入：
    ```python
    wi_format=_read_oai_settings_str(user_setting, "wi_format", default=""),
    ```
- [ ] Task 3.5：单元测试
  - [ ] SubTask 3.5.1：创建 `backend/tests/test_st_compat_wi_format.py`，覆盖 spec 中 3 个 Scenario（空 format / 非空 format / 多条目）
  - [ ] SubTask 3.5.2：测试默认 wi_format="" 时行为与修复前一致（向后兼容）

---

## Phase 4：P1 D4 — token 预算裁剪

- [ ] Task 4.1：分析 _apply_dynamic_trimming 当前实现
  - [ ] SubTask 4.1.1：阅读 `roleplay_prompt_assembly.py:891-944` `_apply_dynamic_trimming` 函数，理解其裁剪策略
  - [ ] SubTask 4.1.2：识别哪些裁剪逻辑适用于 st-compat 路径（chat_history 裁剪），哪些不适用（标识符重排）
- [ ] Task 4.2：st-compat 路径启用 chat_history token 裁剪
  - [ ] SubTask 4.2.1：修改 `roleplay_prompt_assembly.py:2648-2654`，将 st-compat 分支改为：
    ```python
    if st_mode != "st-compat":
        messages, total_tokens_estimate = _apply_dynamic_trimming(messages, prompt_sources, token_budget, report)
    else:
        # st-compat: 仅对 chat_history 做按 token 裁剪，保留强制项
        messages = _apply_st_compat_history_trim(messages, token_budget, prompt_sources, report)
        total_tokens_estimate = sum(s.token_count for s in prompt_sources)
    ```
  - [ ] SubTask 4.2.2：实现 `_apply_st_compat_history_trim(messages, token_budget, prompt_sources, report)` 函数：
    - 识别 chat_history 区段（通过 `prompt_sources` 中的标识符或 messages 中的 metadata）
    - 计算强制项总 token 数（main/worldInfoBefore/personaDescription/charDescription/charPersonality/scenario/worldInfoAfter/dialogueExamples/jailbreak/authorsNote）
    - 剩余预算 = `token_budget * 0.7 - 强制项总 token`（0.7 = ST 默认历史保留比例）
    - 从 chat_history 中间裁剪最旧消息，保留开头 N 条 + 末尾 M 条
- [ ] Task 4.3：修改 recent_messages_budget 为软上限
  - [ ] SubTask 4.3.1：修改 `character_message_builder.py:503-507`，将 `history_limit` 改为「软上限」：
    - 优先按 token 估算裁剪（调用 `_apply_st_compat_history_trim`）
    - 条数作为兜底上限（防止 token 估算误差导致历史过长）
- [ ] Task 4.4：单元测试
  - [ ] SubTask 4.4.1：创建 `backend/tests/test_st_compat_token_budget.py`，覆盖 spec 中 4 个 Scenario（超预算裁剪 / pin_examples=true / pin_examples=false / 强制项不被裁剪）
  - [ ] SubTask 4.4.2：测试 token 估算准确性（与 ST 1.18.0 tiktoken 一致，允许 ±5% 误差）
- [ ] Task 4.5：Golden Vector 场景 5 验证
  - [ ] SubTask 4.5.1：移除 `test_scenario_05_long_chat_trim_pin_true` 和 `test_scenario_05_long_chat_trim_pin_false` 的 `xfail` 标记
  - [ ] SubTask 4.5.2：运行测试，确认通过

---

## Phase 5：P2 D5/D6/D7 — 群聊 nudge + pin_examples + scenario/personality_format

- [ ] Task 5.1：扩展 build_st_compat_messages 签名（合并 P2 参数）
  - [ ] SubTask 5.1.1：新增参数：`pin_examples: bool = False`、`scenario_format: str = "{{scenario}}"`、`personality_format: str = "{{personality}}"`、`new_group_chat_prompt: str = "[Start a new group chat. Group members: {{group}}]"`、`group_nudge: str = ""`
- [ ] Task 5.2：实现 scenario_format / personality_format 包裹
  - [ ] SubTask 5.2.1：修改 `character_message_builder.py:446`，scenario 字段插入前应用 `scenario_format`：
    ```python
    scenario_text = _apply_field_format(char.scenario, scenario_format, _sub)
    ```
  - [ ] SubTask 5.2.2：修改 `character_message_builder.py:450`，personality 字段插入前应用 `personality_format`
  - [ ] SubTask 5.2.3：实现 `_apply_field_format(text, fmt, sub_func)` 函数：空 fmt 返回原值，否则 `sub_func(fmt.replace("{{scenario}}", text).replace("{{personality}}", text))`（与 ST `openai.js:1359-1360` 一致）
- [ ] Task 5.3：实现 new_group_chat_prompt + group_nudge
  - [ ] SubTask 5.3.1：修改 `character_message_builder.py:411-416`，`is_group=True` 时使用 `new_group_chat_prompt`，`{{group}}` 替换为成员名列表（逗号分隔）
  - [ ] SubTask 5.3.2：在 jailbreak 之后（:595 附近）、chatHistory 之前，若 `is_group && group_nudge`，注入 nudge system 消息
  - [ ] SubTask 5.3.3：单聊（`is_group=False`）使用原 `new_chat_prompt`，不注入 nudge
- [ ] Task 5.4：实现 pin_examples 装配顺序
  - [ ] SubTask 5.4.1：修改 `character_message_builder.py:488`，根据 `pin_examples` 决定装配顺序：
    - `pin_examples=True`：先装 dialogueExamples，后装 chatHistory（保示例预算）
    - `pin_examples=False`：先装 chatHistory，后装 dialogueExamples（保历史预算）
  - [ ] SubTask 5.4.2：配合 Phase 4 的 token 预算裁剪，确保 pin_examples 语义正确
- [ ] Task 5.5：调用处传入 P2 参数
  - [ ] SubTask 5.5.1：修改 `roleplay_prompt_assembly.py:2390-2425`，调用处传入：
    ```python
    pin_examples=_read_power_user_bool(user_setting, "pin_examples", default=False),
    scenario_format=_read_oai_settings_str(user_setting, "scenario_format", default="{{scenario}}"),
    personality_format=_read_oai_settings_str(user_setting, "personality_format", default="{{personality}}"),
    new_group_chat_prompt=_read_oai_settings_str(user_setting, "new_group_chat_prompt", default="[Start a new group chat. Group members: {{group}}]"),
    group_nudge=_read_oai_settings_str(user_setting, "group_nudge", default=""),
    ```
- [ ] Task 5.6：单元测试
  - [ ] SubTask 5.6.1：创建 `backend/tests/test_st_compat_p2_features.py`，覆盖 spec 中所有 P2 Scenario
  - [ ] SubTask 5.6.2：测试群聊起始标记、nudge 注入、scenario/personality_format 包裹、pin_examples 装配顺序

---

## Phase 6：D8/D9/D10 — 群聊路径接通 + 死代码修复 + dynamic_context_parts 接入

- [ ] Task 6.1：D8 群聊装配路径接通
  - [ ] SubTask 6.1.1：修改 `backend/app/api/character_ext.py:3732-3756` `CharacterChatRequest`，新增 `group_id: Optional[str] = None` + `current_speaker_id: Optional[str] = None` 字段
  - [ ] SubTask 6.1.2：修改 `character_ext.py:4101-4130` 调用处，透传 `group_id` / `current_speaker_id` 到 `PromptAssemblyRequest`
  - [ ] SubTask 6.1.3：修改 `backend/app/api/websocket.py:1403-1431` 调用处，从 WebSocket 消息中解析 `group_id` 并透传
  - [ ] SubTask 6.1.4：修改 `backend/app/api/silly_tavern.py:3423-3447` 调用处，从 ST 请求上下文中解析 `group_id` 并透传
  - [ ] SubTask 6.1.5：确认 `assemble_roleplay_prompt` 内的群聊分支（`_resolve_group_speaker` / `_build_group_profile_context`）在 `group_id` 非空时正确触发
- [ ] Task 6.2：D9 {{charjailbreak}} 宏死代码修复（与 Phase 1 Task 1.6 合并验证）
  - [ ] SubTask 6.2.1：确认 `macro_service.py:310-312` 已改为读取 `char.jailbreak`（Phase 1 Task 1.6 已修复）
  - [ ] SubTask 6.2.2：测试 `{{charjailbreak}}` 宏在有/无 `Character.jailbreak` 字段时的行为
- [ ] Task 6.3：D10 dynamic_context_parts 在 st-compat 路径接入
  - [ ] SubTask 6.3.1：分析 `build_st_compat_messages` 函数体，确定 `dynamic_context_parts`（memory/plotline/Palink 注入）应在哪个位置注入
  - [ ] SubTask 6.3.2：参考 ST 1.18.0 `extension_prompts` 的 `IN_CHAT` 注入位置（depth=0 或末尾），在 chatHistory 之前注入 `dynamic_context_parts` 内容
  - [ ] SubTask 6.3.3：修改 `character_message_builder.py:build_st_compat_messages` 函数体，在合适位置（建议 jailbreak 之后、chatHistory 之前）注入 `dynamic_context_parts` 拼接的 system 消息
  - [ ] SubTask 6.3.4：单元测试：验证 st-compat 路径下 memory/plotline 内容出现在最终 messages 中
- [ ] Task 6.4：端到端集成测试
  - [ ] SubTask 6.4.1：创建 `backend/tests/test_st_compat_group_chat_e2e.py`，模拟群聊请求（含 `group_id`），验证 `_resolve_group_speaker` 被触发、群聊 nudge 注入、names_behavior 正确应用
  - [ ] SubTask 6.4.2：测试单聊请求（无 `group_id`）不受影响

---

## Phase 7：清单订正与文档更新

- [ ] Task 7.1：订正 docs/st-compat-gap.md 中 outlet 项
  - [ ] SubTask 7.1.1：修改 `docs/st-compat-gap.md` 第 2 节 P1 outlet 项，改为：
    > #### 【订正】outlet（世界书 pos 7）：经后置 macro pass 解析，内容可达
    > - **ST 行为**：pos 7 世界书条目按 `outletName` 分组，通过 `{{outlet::name}}` 宏在任意角色字段中引用。
    > - **Palink 现状**：`build_st_compat_messages` 内部的 `_sub` 函数确实只替换 `{{char}}/{{user}}`，但 `roleplay_prompt_assembly.py:2602-2622` 在 st-compat 分支合并后**无条件**运行 `evaluate_macros_in_messages(messages, macro_env)`，且 `macro_env` 携带 `worldbook_outlets=wb_outlet_entries`（`wb_outlet_entries` 在 `_append_worldbook_context` 中无条件填充），所以 `{{outlet::name}}` 在 st-compat 模式下**会被解析**，outlet 内容**可达**。
    > - **结论**：此项目**不再是差距**。清单原结论"outlet 内容丢失"是字面观察正确（`_sub` 不解析）但最终结论错误（未考虑后置 macro pass）。
- [ ] Task 7.2：订正 docs/st-compat-gap.md 中 jailbreak 字段来源
  - [ ] SubTask 7.2.1：修改 `docs/st-compat-gap.md` P1 G14 项，将"角色卡 `data.extensions.jailbreak`"订正为"角色卡 `data.post_history_instructions`（ST 1.18.0 实际字段，`script.js:3361`）；V3 spec 允许 `data.extensions.jailbreak` 作为独立字段"
- [ ] Task 7.3：订正 docs/st-compat-gap.md 中作者备注 5 态描述
  - [ ] SubTask 7.3.1：修改 `docs/st-compat-gap.md` 第 1 节"已确认对齐的部分"，将"作者备注 5 态：position 0(in-story depth) / 1(after-post-history) / 2(last-in-chat) / 4(top-of-chat) / 3(inactive)"订正为：
    > **订正**：ST 1.18.0 `authors-note.js:81-88` 实际只有 **3 态**（0=after scenario / 1=in chat at depth / 2=before scenario）。Palink 的 5 态是 Palink 扩展设计，与 ST 1.18.0 不完全对齐，但功能上是 ST 3 态的超集，不视为差距。
- [ ] Task 7.4：更新 project_memory.md
  - [ ] SubTask 7.4.1：在 `c:\Users\Pall\.trae-cn\memory\projects\-d----Palink-AI\project_memory.md` 的 "Lessons Learned" 中新增条目：
    > - ST 1.18.0 角色卡 jailbreak 字段来源是 `data.post_history_instructions`（`script.js:3361`），不是 `data.extensions.jailbreak`；V3 spec 允许 `data.extensions.jailbreak` 作为独立字段
    > - ST 1.18.0 作者备注只有 3 态（0/1/2），Palink 的 5 态是扩展设计
    > - `{{outlet::name}}` 在 st-compat 路径下经 `roleplay_prompt_assembly.py:2621` 后置 macro pass 无条件解析，无需在 `build_st_compat_messages` 内的 `_sub` 中实现
    > - `{{charjailbreak}}` 宏原读取 `char.jailbreak_prompt`（不存在字段），已修正为 `char.jailbreak`
    > - `dynamic_context_parts` 在 st-compat 路径原被丢弃，现已接入（jailbreak 之后、chatHistory 之前注入）

---

## Phase 8：端到端 Golden Vector 验证与最终回归

- [ ] Task 8.1：Docker 容器重建
  - [ ] SubTask 8.1.1：`docker compose down && docker compose build backend && docker compose up -d`
  - [ ] SubTask 8.1.2：等待后端就绪，`curl http://localhost:8000/health` 返回 200
  - [ ] SubTask 8.1.3：运行 alembic migration：`docker exec palink-ai-backend-1 alembic upgrade head`
  - [ ] SubTask 8.1.4：确认 `characters.jailbreak` 和 `user_settings.jailbreak` 列已创建
- [ ] Task 8.2：全量 Golden Vector 验证
  - [ ] SubTask 8.2.1：运行 `pytest backend/tests/test_st_compat_golden_vector.py -v`，确认 5 个场景全部通过
  - [ ] SubTask 8.2.2：若任一场景失败，分析 diff（`pytest --diff` 或手动对比），修复后重测
- [ ] Task 8.3：全量回归测试
  - [ ] SubTask 8.3.1：运行 `pytest backend/tests/ -v --tb=short`，对比 Phase 0 基线，确认无回归
  - [ ] SubTask 8.3.2：运行 `pytest backend/tests/test_st_contract.py -v`，确认 ST 契约测试通过
  - [ ] SubTask 8.3.3：运行 `pytest backend/tests/test_author_note_position.py -v`，确认作者备注测试通过
- [ ] Task 8.4：性能回归测试
  - [ ] SubTask 8.4.1：运行 `pytest backend/tests/test_roleplay_prompt_perf.py -v`（如存在），或手动测试提示词组装 P95
  - [ ] SubTask 8.4.2：确认 P95 < 200ms（与 Phase 0 基线一致）
- [ ] Task 8.5：ST Sidecar 代理验证
  - [ ] SubTask 8.5.1：验证 Palink-owned API 仍由 Palink 处理（`/api/characters/get` 等）
  - [ ] SubTask 8.5.2：验证非 owned API 仍透明代理（`/api/backends/chat-completions/generate` 在面 B 模式下）
  - [ ] SubTask 8.5.3：验证 `X-Palink-*` header 注入正常
- [ ] Task 8.6：最终备份与 git tag
  - [ ] SubTask 8.6.1：`git add -A && git commit -m "feat: align st-compat prompt assembly with ST 1.18.0 final parity"`
  - [ ] SubTask 8.6.2：`docker tag palink-ai-backend:latest palink-ai-backend:st-compat-final-parity`
  - [ ] SubTask 8.6.3：`docker exec palink-ai-db-1 pg_dump -U palink palink > backups/st-compat-final-parity/db_dump.sql`
  - [ ] SubTask 8.6.4：`git tag st-compat-prompt-final-parity`

---

# Task Dependencies

- [Phase 0] 无依赖（基线建立 + Golden Vector 提取）
- [Phase 1] 依赖：Phase 0（Golden Vector 框架就绪）
- [Phase 2] 依赖：Phase 1（jailbreak 修复完成，避免 names_behavior 测试被 jailbreak 差距干扰）
- [Phase 3] 依赖：Phase 0（可与 Phase 1/2 并行，wi_format 独立于 jailbreak/names_behavior）
- [Phase 4] 依赖：Phase 3（token 预算裁剪需要 wi_format 包裹后的内容做 token 估算）
- [Phase 5] 依赖：Phase 4（pin_examples 装配顺序依赖 token 预算裁剪逻辑）
- [Phase 6] 依赖：Phase 1-5（D8 群聊路径接通需要 names_behavior + group nudge 等已实现；D10 dynamic_context_parts 接入需要 token 预算裁剪已就绪）
- [Phase 7] 依赖：Phase 1-6（清单订正需基于实际修复结果）
- [Phase 8] 依赖：Phase 1-7（端到端验证需所有修复完成）

## 可并行任务

- [Phase 3 Task 3.1-3.5] 可与 [Phase 1 Task 1.1-1.7] 并行（wi_format 与 jailbreak 互不依赖）
- [Phase 7 Task 7.1-7.3] 可与 [Phase 6 Task 6.4] 并行（文档订正与端到端测试互不依赖）
