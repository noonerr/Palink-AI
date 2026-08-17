# 目标计划：群聊后端对 ST 1.18.0 高保真适配 + 1:1 非回归

> 工作区：`D:\项目\Palink-AI\docs\goal-groupchat`
> 目标类型：Software Development (Backend)
> 取向（用户确认）：① 严格对齐 ST 1.18.0（含其固有约束：仅 0-3 策略、特定随机/排序/合并卡语义）；② 1:1 验证=专项直测+全量零回归
> 参考基线：`SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/group-chats.js`（激活/合并卡）、`script.js`/`openai.js`（prompt 组装）

---

## 一、子任务分解（7 项，每项有明确输出）

### S1. ST 目标基线固化
- 输出：在 `goal-design.md` 中整理 ST 1.18.0 群聊算法精要（激活策略 NATURAL/LIST/POOLED/MANUAL 语义、合并卡字段与拼接、SWAP/APPEND prompt 组装、Name 前缀规则）。
- 依据：阶段 2 两个 Explore 代理的逐字提取（group-chats.js:1180-1316 / 477-571 / 1002-1031；script.js:3348-3390；openai.js:585-596）。

### S2. 我方实现提取 + 逐项差异矩阵
- 输出：`goal-design.md` 的差异矩阵表（吻合 / 偏离 / 扩展），每项标注严重度 + 修复归属（st-compat 严格对齐 / palink-native 保留）。
- 读取：`roleplay_prompt_assembly.py`（`_select_natural_speaker` :1687-1739、`_select_pooled_speaker` :1784-1802、`_build_group_combined_card` :1618-1685、`_resolve_group_speaker` :2033-2155、worldbook 组策略）、`character_message_builder.py`（`build_st_compat_messages` :440+、`build_character_chat_messages`）、`websocket.py`（`_gen` :1513-1642）。

### S3. 合并卡保真修复（st-compat + native 通用 ST 行为）
- 输出：修正 `roleplay_prompt_assembly.py::_build_group_combined_card`，对齐 ST `collectField`/`customTransform`：
  1. `mes_example` 拼接时：若该成员值未以 `<START>` 开头，补 `<START>\n`（对齐 group-chats.js:569）。
  2. `scenario` / `mes_example` 若 `chat_metadata.scenario` / `chat_metadata.mes_example` 存在且非空，则以覆盖值替代逐成员收集（对齐 :561/567-568）。
  3. 复刻 `customTransform(prefix, fieldName, characterName, false)`：prefix/suffix 中的 `<FIELDNAME>` 与角色名占位符做替换后再包裹（对齐 :534-535、:528-538）。
  4. 核对 disabled 跳过：APPEND 排除禁用、APPEND_DISABLED 含禁用（当前已正确，回归确认）。

### S4. NATURAL / follower 保真修复（模式感知）
- 输出：修正 `roleplay_prompt_assembly.py::_select_natural_speaker`：
  1. **follower 衰减仅在 palink-native 生效**：st-compat 模式忽略 `follower_members`（ST 1.18.0 无此概念），保证严格对齐。
  2. 提及/概率语义已等价（`random.random() <= eff` ⟺ ST `talkativeness >= rollValue`），但将提及匹配改为更贴近 ST `extractAllWords(name).includes(word)` 的词包含判定（边界一致）。
  3. （可选）talkativeness 循环前对成员做 shuffle，使多激活兜底分布更贴近 ST。

### S5. 1:1 非回归路径分析 + 加固（用户硬要求）
- 输出：① 路径追踪报告（文字）：`assemble_roleplay_prompt` + `websocket._gen` 在 `group_id=None` 时每条群聊代码路径的守卫证据；② 新增 `tests/test_single_chat_no_group_leakage.py`：
  - 断言 `group_id=None` 装配后：无成员 profile 注入、req.char 不变、system_prompt 不含合并卡、历史无 "Name: " 群前缀、generation_mode 不生效、worldbook 组策略不走 group。
  - 复用真实 `assemble_roleplay_prompt` + 轻量 fake db，确保端到端 1:1 行为惰性。

### S6. 群聊对齐测试补强
- 输出：在 `tests/test_group_chat_combined_card.py`（新建）补：
  - mes_example `<START>` 包裹；
  - chat_metadata scenario/mes_example 覆盖；
  - prefix/suffix token 替换（`<FIELDNAME>`/角色名）；
  - st-compat follower 忽略（S4.1）断言。

### S7. 全量验证与报告
- 输出：`goal-verification-report.md` + 最终 `pytest tests/` 零回归证据。
- 动作：运行全量测试，确认 1:1 零回归 + 群聊对齐提升；汇总修复清单与已知限制。

---

## 二、依赖顺序

```
S1 (基线) ─┬─> S2 (差异矩阵) ─┬─> S3 (合并卡修复) ─┐
            │                  ├─> S4 (NATURAL修复)─┤
            │                  └───────────────────┤
            └────────────────> S5 (1:1 非回归, 可与 S2 并行) ─┤
                                                                ├─> S6 (群聊测试) ─> S7 (验证+报告)
S5 的 1:1 直测与 S2/S3/S4 可并行推进
```

- 串行关键链：S1 → S2 → S3/S4 → S6 → S7
- 并行：S5（1:1 分析+测试）可与 S2/S3/S4 并行（互不依赖代码改动）。

---

## 三、所需技能

- 主技能：backend-architect（直接代码分析 + pytest）。无需加载额外 skill。
- 验证：pytest（系统 python 9.1.1）+ 现有后端测试基础设施。
- 参考：阶段 2 Explore 代理已提取 ST 源码（group-chats.js / script.js / openai.js）。

---

## 四、范围与排除（对齐阶段 1）

- **包含**：群聊后端代码 vs ST 1.18.0 对照；合并卡/激活策略保真修复；follower 模式感知；1:1 非回归验证+测试；群聊对齐测试补强。
- **排除**：前端群聊 UI 接线（用户此前要求搁置）；数据库 migration；超出 ST 对齐范围的新功能；palink-native 扩展能力（TALKATIVE/VOTING）的删除（保留为原生扩展，仅 st-compat 严格对齐）。

---

## 五、成功标准

1. 合并卡行为逐条对齐 ST `collectField`/`customTransform`（S3）。
2. st-compat NATURAL 忽略 follower 衰减（S4）。
3. 1:1 装配新增直测全过，且全量 `pytest tests/` **0 失败**（S5/S7）。
4. 差异矩阵中"偏离"项除已记录已知限制外均闭环。
