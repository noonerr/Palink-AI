# ST 1.18.0 兼容性项目 — Agent 交接文件

> 生成时间：2025年当前会话  
> 用途：换 agent 时的完整上下文交接

---

## 一、项目总目标

**目标**：Palink 后端与 SillyTavern 1.18.0 达到 **数据与行为等价**（相同输入产出一致的最终提示词 messages 数组与生成结果处理），覆盖 ST 全部 44 个端点文件 + 核心行为子系统。

**验收基准**：一切以 docker 原版 ST 对拍的"黄金向量"为准（≥95% 置信度才修复，先备份 + changelog，DB 变更走 alembic）。

**计划文件位置**：`C:\Users\Pall\AppData\Roaming\Qoder\SharedClientCache\cache\plans\ST_1.18.0_兼容性审计与修复_task-7a5.md`

---

## 二、当前适配率评估（最悲观）

| 子系统 | 适配率 | 状态 |
|---|---|---|
| 数据格式层（卡片/JSONL/世界书字段） | 85-90% | 已验证 PASS |
| HTTP API 契约 | 50-60% | 仅核对 ~5 个关键端点 |
| 宏引擎 | 75-80% | 常用宏已验证，日期/instruct 宏缺失 |
| **提示词装配** | **30-45% → 本轮提升至 ~70%** | ST-compat 构建器已创建并验证 |
| 世界书激活算法 | 20-35% | 仅字段保真，核心逻辑未端到端验证 |
| 生成管道 | 30-40% | SSE/token/abort 未对拍 |
| 扩展系统 | 15-25% | 仅枚举验证 |
| Settings/Presets | 40-50% | 端点存在但未逐字段对照 |

---

## 三、已完成的工作（按时间序）

### 阶段 0：黄金向量对拍 harness ✅

创建了 `scripts/st-compat/prompt_golden/` 目录，包含 4 个脚本：

| 文件 | 用途 |
|---|---|
| `palink_golden_vector.py` | Palink 侧黄金向量生成器（4 个 fixture） |
| `st_capture_server.py` | 模拟 OpenAI 后端，捕获 ST 发送的 generate 请求 |
| `diff_messages.py` | 逐条 diff messages 数组 + 等价率报告 |
| `show_result.py` | 结果查看辅助 |

**4 个 Fixture**：
- `basic_char`：普通角色（description/personality/scenario/examples/history）
- `char_with_worldbook`：含世界书触发
- `char_with_instruct`：含 instruct 模式包裹
- `long_chat_truncation`：30 条消息触发截断

### 阶段 1.1：提示词装配等价（进行中）

**核心成果**：创建了 `build_st_compat_messages` 函数，严格复现 ST 的 `promptManagerDefaultPromptOrder`。

**修改的文件**：
1. `backend/app/services/character_message_builder.py` — 新增 `build_st_compat_messages`（~220 行）
2. `backend/app/services/roleplay_prompt_assembly.py` — 新增 `silly_tavern_mode == "st-compat"` 分支（L2350-2402）
3. `scripts/st-compat/prompt_golden/palink_golden_vector.py` — 添加 `silly_tavern_mode = "st-compat"` 设置

**ST 默认装配序（已实现并验证）**：
```
Index 0:  main (system) — "Write {{char}}'s next reply..."
Index 1:  worldInfoBefore (system)
Index 2:  personaDescription (system)
Index 3:  charDescription (system)
Index 4:  charPersonality (system)
Index 5:  scenario (system)
Index 6:  enhanceDefinitions (disabled — skip)
Index 7:  nsfw/auxiliary (empty — skip)
Index 8:  worldInfoAfter (system)
Index 9:  dialogueExamples (system, 含 [Example Chat] 标记)
Index 10: chatHistory (含 [Start a new Chat] 标记)
Index 11: jailbreak / post-history instructions (system)
```

**验证结果**（4 个 fixture 全部 PASS）：
- basic_char: 9 条消息，顺序正确
- char_with_worldbook: 世界书在 main 之后正确注入
- char_with_instruct: instruct 前缀正确包裹（### System:/### User:/### Assistant:）
- long_chat_truncation: 30 条消息正确截断

---

## 四、待完成的工作

### 阶段 1.1 剩余项

| 项目 | 状态 | 说明 |
|---|---|---|
| worldInfoAfter 分离 | **待做** | 当前 `world_info_after=""` 硬编码为空。需要从 `WorldbookContextResult.entries_by_position` 中分离 position=1 (AFTER_CHAR) 的条目 |
| depth 注入对齐 | **待做** | 世界书 `WI_POS_AT_DEPTH=4` 的条目需要在 chatHistory 内按 depth 插入（类似 author's note） |
| token 预算裁剪 | **待做** | ST 用 `ChatCompletion.canAfford()` 逐条从末尾裁剪；Palink 用 `limit` 参数。需对齐 |
| `names_behavior` | **待做** | ST 可在消息中添加角色名（`character_names_behavior.COMPLETION`） |
| `scenario_format` / `personality_format` | **待做** | ST 可用自定义格式包裹 scenario/personality |
| `pin_examples` | **待做** | 控制 examples 是否在 history 之前（影响预算分配） |
| `send_if_empty` | **待做** | 最后一条是 assistant 时添加空 user 消息（默认空字符串，暂不影响） |
| 与真实 ST 输出 diff | **待做** | 需配置 ST 使用 capture server，用相同角色触发生成，捕获 messages 做 diff |

### 阶段 1.2：世界书激活等价

对照 `world-info.js`（6000+ 行）：
- scanDepth 截断
- primary/secondary key 匹配
- selectiveLogic（AND_ANY/NOT_ALL/NOT_ANY/AND_ALL）
- constant 条目
- group 评分与 groupWeight
- budget 分配
- position（before/after/EMTop/EMBottom/outlet/@depth）
- recursion/preventRecursion
- sticky/cooldown/delay
- probability/useProbability

**关键文件**：`backend/app/services/worldbook_service.py`（已有部分实现）

### 阶段 1.3：instruct 模式等价

对照 `instruct-mode.js:673`：
- input_sequence/input_suffix/output_sequence/output_suffix
- system_sequence/system_suffix
- first_output_sequence/separator
- 包裹逻辑与启用条件

**关键文件**：`backend/app/services/roleplay_prompt_assembly.py` 中的 `_apply_instruct_formatting`

### 阶段 1.4：生成管道等价

对照 `openai.js` 请求构造 + `sse-stream.js`：
- messages/采样参数/logit_bias/response_format
- SSE chunk 格式
- reasoning 字段透传
- token 计数回传
- abort 处理

**关键文件**：`backend/app/api/silly_tavern.py`（L2095+）

### 阶段 2：边缘场景 + 宏补全

- 聊天上下文宏：`{{lastMessage}}/{{lastUserMessage}}/{{lastCharMessage}}/{{lastMessageId}}/{{maxContext}}/{{maxPrompt}}/{{idle_duration}}`
- instruct 宏：`{{instructInput}}` 等
- `{{datetimeformat}}`
- 日期 locale 格式
- 超大 swipes 数组、V3 多模态 content parts、空聊天/单条聊天

### 阶段 3：全端点 schema 覆盖（44 文件）

按行为等价口径核对全部端点的请求/响应 schema 与状态码。

### 阶段 4：性能/稳定性/全面回归

- 提示词装配与世界书激活的耗时基准
- 大聊天/大世界书压测
- 并发 save/generate、迁移幂等性
- CI 回归集

---

## 五、关键技术细节（笔记）

### 5.1 ST 源码真值位置

| 功能 | 文件 | 行号 |
|---|---|---|
| 默认 main prompt | `openai.js` | :101 |
| 默认标记 | `openai.js` | :107-110 |
| `populateChatCompletion` | `openai.js` | :1176-1338 |
| `preparePromptsForChatCompletion` | `openai.js` | :1358-1507 |
| `populateChatHistory` | `openai.js` | :876-1083 |
| `populateDialogueExamples` | `openai.js` | :1092-1125 |
| `populationInjectionPrompts` | `openai.js` | :801-866 |
| `getPromptPosition` | `openai.js` | :1131-1141 |
| `getPromptRole` | `openai.js` | :1148-1159 |
| `formatWorldInfo` | `openai.js` | :780-792 |
| `promptManagerDefaultPromptOrder` | `PromptManager.js` | :2087-2136 |
| `chatCompletionDefaultPrompts` | `PromptManager.js` | :2001-2081 |
| 世界书激活 | `world-info.js` | 全文 6000+ 行 |
| instruct 包裹 | `instruct-mode.js` | :673+ |

### 5.2 Palink 关键文件

| 文件 | 用途 |
|---|---|
| `backend/app/services/character_message_builder.py` | 消息构建器（含 `build_st_compat_messages`） |
| `backend/app/services/roleplay_prompt_assembly.py` | 提示词装配主入口（3020 行） |
| `backend/app/services/worldbook_service.py` | 世界书激活（1369 行） |
| `backend/app/services/macro_service.py` | 宏引擎 |
| `backend/app/api/silly_tavern.py` | ST 兼容 API 端点 |
| `backend/app/models/system.py` | UserSetting / ContextTemplate / InstructTemplate 模型 |
| `backend/app/models/character.py` | Character / ChatSession / ChatMessage 模型 |

### 5.3 运行环境

- **Docker 容器**：`palink-ai-backend-1`
- **DB 凭据**：`ai_user` / `ai_hub`（不是 palink/palink）
- **运行测试**：`docker exec -e PYTHONPATH=/app palink-ai-backend-1 python /tmp/script.py`
- **传入脚本**：`docker cp script.py palink-ai-backend-1:/tmp/`
- **输出路径**：容器内用 `/tmp/`（`/app/scripts/` 无写权限）
- **重建**：`docker compose up -d --build backend`
- **PowerShell 注意**：用 `;` 不用 `&&`

### 5.4 模型结构

```
User (Integer id)
  └── UserSetting (user_id FK)
        ├── silly_tavern_mode: "palink-native" | "st-compat"
        ├── instruct_enabled: Boolean
        ├── instruct_template_id: Integer FK
        ├── author_note / author_note_position / author_note_depth
        └── active_persona_id: String FK

Character (String id = UUID)
  ├── name / description / personality / scenario
  ├── mes_example / first_mes
  ├── system_prompt / post_history_instructions
  └── CharacterChatSession → CharacterChatSessionBranch → CharacterChatMessage (Integer id)

WorldBook (String id)
  └── WorldBookStage (entries)
        ├── keys: JSON 字符串
        ├── position: Integer (WI_POS_* 常量)
        ├── depth: Integer
        └── world_book_id FK

InstructTemplate (Integer id)
  ├── input_prefix / output_prefix (不是 input_sequence/output_sequence)
  ├── system_prefix / system_suffix
  └── stop_sequence

ContextTemplate (Integer id)
  ├── name / story_string / chat_start
  ├── system_prompt / jailbreak
  └── is_builtin
```

### 5.5 世界书位置常量

```python
WI_POS_BEFORE_CHAR = 0   # → worldInfoBefore
WI_POS_AFTER_CHAR = 1    # → worldInfoAfter
WI_POS_BEFORE_AN = 2     # → before author's note
WI_POS_AFTER_AN = 3      # → after author's note
WI_POS_AT_DEPTH = 4      # → 在 chatHistory 内按 depth 插入
WI_POS_EM_TOP = 5        # → examples 顶部
WI_POS_EM_BOTTOM = 6     # → examples 底部
WI_POS_OUTLET = 7        # → named outlet
```

### 5.6 ST 默认值

```javascript
default_main_prompt = "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}."
default_new_chat_prompt = "[Start a new Chat]"
default_new_group_chat_prompt = "[Start a new group chat. Group members: {{group}}]"
default_new_example_chat_prompt = "[Example Chat]"
default_continue_nudge_prompt = "[Continue your last message without repeating its original content.]"
default_wi_format = "{0}"  // 直接透传
send_if_empty = ""  // 默认空
```

### 5.7 已知陷阱

1. **UniqueViolation users_pkey**：不要用 `db.add(User(...))`，用已有用户 `db.query(User).filter(User.is_active == True).first()`
2. **"This transaction is closed"**：savepoint 与内部 commit 冲突，用"创建→commit→运行→delete→commit"模式
3. **Permission denied `/app/scripts/`**：容器内输出到 `/tmp/`
4. **Container recreate 后文件丢失**：每次 `docker compose up -d` 后需重新 `docker cp`
5. **Instruct 模式泄漏**：每次 fixture 运行前重置 `user_setting.instruct_enabled = False`
6. **用户消息重复**：分离 `current_message` 字段（历史消息 vs 当前输入）
7. **DB 中 `silly_tavern_mode` 当前设为 "st-compat"**（测试用），生产默认值仍为 "palink-native"

---

## 六、当前 Todo 状态

```
[COMPLETE] 阶段0: 创建 prompt_golden/ 目录结构 + Palink 侧装配输出脚本
[COMPLETE] 阶段0: ST 侧探针/脚本 - 抓取 populateChatCompletion 最终 messages
[COMPLETE] 阶段0: diff 工具 + 等价率报告生成器
[COMPLETE] 阶段0: 世界书激活黄金向量 fixture
[PENDING]  阶段0: 验证 harness 对已知 PASS 维度复现 100%
[IN_PROGRESS] 阶段1.1: 提示词装配等价 - 对照 openai.js 装配序
  [COMPLETE] 1.1a: 修正装配序为 ST promptManagerDefaultPromptOrder
  [COMPLETE] 1.1b: 添加 [Start a new Chat] / [Example Chat] 标记
  [COMPLETE] 1.1c: jailbreak 移至 chatHistory 之后
  [COMPLETE] 1.1d: 验证世界书 worldInfoBefore 正确注入
  [COMPLETE] 1.1e: 验证 instruct 模式包裹正确
  [IN_PROGRESS] 1.1f: 检查 worldInfoAfter 分离 + depth 注入对齐
[PENDING]  阶段1.2: 世界书激活等价 - 对照 world-info.js
[PENDING]  阶段1.3: instruct 模式等价
[PENDING]  阶段1.4: 生成管道等价
[PENDING]  阶段2: 边缘场景 + 宏补全
[PENDING]  阶段3: 全端点 schema 覆盖
[PENDING]  阶段4: 性能/稳定性/全面回归
```

---

## 七、下一步具体行动

### 立即要做（1.1f）

1. **worldInfoAfter 分离**：在 `roleplay_prompt_assembly.py` 的 ST-compat 分支中，从 `WorldbookContextResult.entries_by_position` 提取 `WI_POS_AFTER_CHAR=1` 的条目，传入 `world_info_after` 参数（当前硬编码为 `""`）。

2. **depth 注入**：将 `WorldbookContextResult.depth_entries`（`WI_POS_AT_DEPTH=4`）在 `build_st_compat_messages` 中按 depth 插入到 chatHistory 内（类似 author's note 的 depth 插入逻辑）。

3. **与真实 ST 对拍**：
   - 启动 `st_capture_server.py`（监听 8899 端口）
   - 配置 ST 使用 `http://host.docker.internal:8899/v1` 作为 API
   - 用相同角色/聊天触发生成
   - 捕获 ST 的 messages 数组
   - 用 `diff_messages.py` 对比

### 之后（1.2 世界书）

对照 `world-info.js` 逐项验证 `worldbook_service.py` 的激活逻辑。

---

## 八、架构决策记录

1. **双模式设计**：`silly_tavern_mode` 字段切换 "palink-native"（Palink 增强装配）和 "st-compat"（ST 精确复现）。生产默认 "palink-native"，ST 前端连接时切换 "st-compat"。

2. **不修改 Palink-native 路径**：ST-compat 是独立分支，不影响现有 Palink 用户体验。

3. **世界书位置分离**：`WorldbookContextResult` 已按 position 分组返回（`entries_by_position` dict），ST-compat 分支只需按 key 提取即可。

4. **黄金向量方法论**：固定输入 → 分别在 ST 和 Palink 取最终 messages → 逐条 diff → 输出等价率。

---

## 九、文件清单

### 本轮新增/修改

| 文件 | 操作 | 说明 |
|---|---|---|
| `backend/app/services/character_message_builder.py` | 修改 | 新增 `build_st_compat_messages` 函数 |
| `backend/app/services/roleplay_prompt_assembly.py` | 修改 | 新增 ST-compat 分支 (L2350-2402) |
| `scripts/st-compat/prompt_golden/palink_golden_vector.py` | 修改 | 添加 `silly_tavern_mode = "st-compat"` |
| `scripts/st-compat/prompt_golden/st_capture_server.py` | 新建 | ST 侧捕获服务器 |
| `scripts/st-compat/prompt_golden/diff_messages.py` | 新建 | diff 工具 |
| `scripts/st-compat/prompt_golden/show_result.py` | 新建 | 结果查看 |

### ST 源码参考（只读）

```
SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/openai.js (7250 行)
SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/PromptManager.js (2145 行)
SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/world-info.js (6000+ 行)
SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/instruct-mode.js
SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/macros.js
```

---

## 十、验证命令速查

```powershell
# 重建 backend
cd d:\项目\Palink-AI; docker compose up -d --build backend

# 传入脚本
docker cp scripts/st-compat/prompt_golden/palink_golden_vector.py palink-ai-backend-1:/tmp/

# 运行 fixture
docker exec -e PYTHONPATH=/app palink-ai-backend-1 python /tmp/palink_golden_vector.py --fixture basic_char --output /tmp/result.json

# 查看结果
docker exec palink-ai-backend-1 python -c "import json; d=json.load(open('/tmp/result.json')); msgs=d['messages']; print('Total:', len(msgs)); [(print('  ['+str(i)+'] role='+m['role'].ljust(10)+' | '+str(m['content'])[:80])) for i,m in enumerate(msgs)]"

# 语法检查
python -c "import ast; ast.parse(open('backend/app/services/character_message_builder.py', encoding='utf-8').read()); print('OK')"
```

---

*交接完毕。祝下一个 agent 顺利。*
