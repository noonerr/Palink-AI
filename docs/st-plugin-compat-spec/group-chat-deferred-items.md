# 群聊兼容性遗留事项（暂缓修复）

> 创建日期：2026-07-28
> 背景：用户要求"优先解决插件和单人对话，群聊可以稍微缓一缓记一下还差了什么之后再修复"
> 当前状态：插件 + 单人对话兼容性修复已完成（chat_metadata 持久化、generateRaw 拦截器接入、extension_settings 全局共享等），全量回归 540 passed / 45 skipped / 0 failed

---

## 一、当前群聊测试覆盖（已通过）

以下测试已全部通过，构成群聊功能的基线保障：

| 测试文件 | 用例数 | 覆盖范围 |
|---|---|---|
| `test_group_speaker_queue.py` | 19 | resolve_group_speaker_queue 契约（LIST/MANUAL/NATURAL/POOLED/TALKATIVE + swipe/continue/impersonate/quiet 单发言者路径） |
| `test_group_speaker_selection.py` | — | _select_natural_speaker / _select_pooled_speaker 内部逻辑 |
| `test_group_swipe_impersonate.py` | — | swipe / impersonate 类型在群聊中的行为 |
| `test_group_chat_combined_card.py` | — | _build_group_combined_card 合并卡构建 |
| `test_group_boundary.py` | — | 群聊与单人对话路径隔离边界 |
| `test_single_chat_no_group_leakage.py` | — | 单人对话不受群聊逻辑泄漏 |
| `test_st_compat_group_chat_e2e.py` | — | 群聊端到端（含 profiles 触发） |
| `test_st_compat_group_generation_mode.py` | — | 群聊生成模式 |
| `test_d3_speaker_card_swap.py` | — | D3 发言者卡切换 |
| `test_min_activations_quick.py` | — | 最小激活策略 |
| `test_f1_speaker_queue.py` | — | F1 发言者队列 |

**群聊相关测试合计：80 passed / 0 failed**

---

## 二、遗留事项清单（按模块分类）

依据 `docs/st_group_chat_gap_analysis.md`（2026-07-22 差距分析）与 `docs/group_chat_remediation_plan.md`（2026-07-23 补救计划），以下为暂缓修复的群聊遗留事项。

### 模块 B：激活策略 / 发言者选择（最大缺口）

- [ ] **B1. NATURAL（轮询 + 概率）语义不完整**
  - ST 行为：① 输入提及成员名→强制激活；② 每个启用成员按 `talkativeness ≥ random()` 概率激活；③ 全未激活则取 `talkativeness>0` 者随机；④ 默认禁止连续同发言者（除非 `allow_self_responses`）
  - 当前差异：`_resolve_group_speaker` 仅处理策略值 4/5（TALKATIVE/VOTING），对 0/1/2 直接跳过
  - 优先级：高 ｜ 难度：中

- [ ] **B2. LIST（顺序全员）语义不完整**
  - ST 行为：启用成员按名册顺序各生成一次、全部追加
  - 当前差异：`resolve_group_speaker_queue` 已返回 LIST 队列，但生成路径的多成员串联流式尚未完整实现
  - 优先级：高 ｜ 难度：中

- [ ] **B3. MANUAL（手动）不完整**
  - ST 行为：无用户输入时随机激活单成员；有用户输入则 AI 不回复（仅发用户消息）
  - 当前差异：依赖前端传 `current_speaker_id`，后端不解析 MANUAL 语义，未实现"有输入则不回 AI"
  - 优先级：中 ｜ 难度：低

- [ ] **B4. POOLED 缺失**
  - ST 行为：自上次用户消息起，收集"未发言成员"随机选一人
  - 当前差异：仅 VOTING/TALKATIVE，无 POOLED 实现
  - 优先级：高 ｜ 难度：中

- [ ] **B5. disabled_members 未强制过滤**
  - ST 行为：`enabledMembers = members.filter(x => !disabled_members.includes(x))`
  - 当前差异：加载成员从 `member_ids` 取，未过滤 `disabled_members`，禁用成员仍可被选中
  - 优先级：高 ｜ 难度：低（加一行过滤）

- [ ] **B6. allow_self_responses 未实现**
  - ST 行为：仅 NATURAL 用其控制是否允许连续同人发言
  - 当前差异：生成路径零引用；TALKATIVE 的"避免连续同人"只是启发式
  - 优先级：中 ｜ 难度：低

### 模块 C：生成模式 / 角色卡合并

- [ ] **C1. generation_mode 未被读取**
  - ST 行为：`group_generation_mode`(SWAP/APPEND/APPEND_DISABLED) 控制卡合并方式与 depth 提示注入
  - 当前差异：`GroupChat.generation_mode` 仅存储，生成路径无任何读取分支
  - 优先级：高 ｜ 难度：高（需重写装配）

- [ ] **C2. combineGroupIntoSingleCard 等价物缺失**
  - ST 行为：按模式合并各成员 `description/personality/scenario/mesExamples`（用 `generation_mode_join_prefix/suffix` 连接）
  - 当前差异：`_build_group_profile_context` 是独立重写，仅注入当前发言者身份+其他人摘要，不等价于 ST 的卡合并
  - 优先级：高 ｜ 难度：高

### 模块 D：上下文 / 提示词装配

- [ ] **D1. st-compat 丢失 member_profiles 发言者身份**
  - 当前差异：st-compat 分支改用 `char.system_prompt`，丢弃了群成员身份注入
  - 优先级：高（st-compat 保真）｜ 难度：中

- [ ] **D2. native 群 history 无 name 归属前缀**
  - ST 行为：`names_behavior != NONE` 时给群非用户消息加 `"Name: content"` 前缀
  - 当前差异：`build_character_chat_messages` 无 group 分支，丢失归属
  - 优先级：中 ｜ 难度：中

- [ ] **D3. `{{char}}` 不绑定解析出的 speaker**
  - ST 行为：`{{char}}`→当前发言者
  - 当前差异：用 `req.char.name`（前端 `character_id` 决定），未对齐到 `current_speaker_id`
  - 优先级：中 ｜ 难度：中

- [ ] **D4. `{{group}}` 名单丢失（TODO）**
  - 当前差异：`group_members=None` 导致 `{{group}}` 退化为单个 `char_name`
  - 优先级：中 ｜ 难度：低

- [ ] **D5. `{{charIfNotGroup}}` 语义错误**
  - ST 行为：群聊内改用 `{{user}}`
  - 当前差异：被误替换为 `char_name`
  - 优先级：中 ｜ 难度：低

### 模块 E：世界书 / 正则 / 宏

- [ ] **E1. per-member WorldBook 缺失**
  - ST 行为：`world_info_character_strategy` 支持按角色匹配 WI 条目
  - 当前差异：仅全局/会话级 WI，无 per-member 触发
  - 优先级：中 ｜ 难度：高

- [ ] **E2. 群专属 WI 偏移**（需调查确认实际形态）
  - 优先级：低 ｜ 难度：中

### 模块 F：多人自动串联流式

- [ ] **F1. 跨成员续轮缺失**
  - ST 行为：对 activatedMembers 顺序续轮 + `shouldAutoContinue`
  - 当前差异：单轮单 speaker，无跨成员续轮
  - 优先级：高 ｜ 难度：高

### 模块 G：前端 UI

- [ ] **G1. 群聊活动 UI 接线缺失**
  - 当前差异：活动 UI 对 group 零接线，仅一份停用的 `NativeRoleplayChat` 原型
  - 优先级：高 ｜ 难度：高
  - 注：按用户既有要求暂搁置

---

## 三、清理项（低风险，可顺手做）

- [ ] **A. 删除 `manual_skip_ai` 死字段**
  - `roleplay_prompt_assembly.py` 中 `PromptAssemblyRequest.manual_skip_ai` 仅声明/赋值，无读取点
  - 风险：低 ｜ 难度：低

- [ ] **B. 补边界用例**
  - 空群 / 单成员 / 全 disabled / LIST 中间失败等边界场景
  - 风险：极低 ｜ 难度：低

---

## 四、修复优先级建议

1. **第一优先级**（影响核心功能）：B5（disabled_members 过滤）、B1（NATURAL）、B4（POOLED）、C1（generation_mode 读取）、D1（st-compat 身份注入）
2. **第二优先级**（影响保真度）：B2（LIST 串联）、B3（MANUAL 语义）、C2（卡合并）、D2-D5（宏与归属）、F1（续轮）
3. **第三优先级**（边缘场景）：B6、E1、E2、G1
4. **随手清理**：A、B（边界用例）

---

## 五、验证基线

修复群聊遗留事项时，需确保以下基线测试持续通过：

```bash
# 群聊相关测试（80 项）
docker exec palink-ai-backend-1 python -m pytest \
  tests/test_group_speaker_queue.py \
  tests/test_group_speaker_selection.py \
  tests/test_group_swipe_impersonate.py \
  tests/test_group_chat_combined_card.py \
  tests/test_group_boundary.py \
  tests/test_single_chat_no_group_leakage.py \
  tests/test_st_compat_group_chat_e2e.py \
  tests/test_st_compat_group_generation_mode.py \
  tests/test_d3_speaker_card_swap.py \
  tests/test_min_activations_quick.py \
  tests/test_f1_speaker_queue.py \
  -v

# 全量回归（540 项）
docker exec palink-ai-backend-1 python -m pytest tests/ -q
```

---

## 六、参考文档

- [群聊差距分析](../st_group_chat_gap_analysis.md) - 2026-07-22 完整差距清单
- [群聊补救计划](../group_chat_remediation_plan.md) - 2026-07-23 修复计划
- [群聊完整审计](../group_chat_full_audit.md) - 保守审计报告
- [ST 插件兼容 Spec](./README.md) - 插件兼容性总览
