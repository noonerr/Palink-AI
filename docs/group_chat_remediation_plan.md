# 后端群聊审计问题修复计划（详尽版）

> 制定日期：2026-07-23
> 依据：`docs/group_chat_full_audit.md`（保守审计报告）
> 总原则：**先安全后敏感**、**每改必测**、**最小原子改动**、**可回滚**。

## 一、待办清单（按优先级与风险排序）

| # | 事项 | 类型 | 风险级 | 是否改生产代码 |
|---|------|------|--------|----------------|
| A | 删除 `manual_skip_ai` 死字段 + 清两处过期注释 | 清理 | 低 | 是（仅 service 层） |
| B | 补 NATURAL/POOLED 选角内部逻辑单测 | 测试 | 极低 | 否（仅新增测试） |
| C | 定位并确认 E2（群专属 WI 偏移）实际形态 | 调查 | 低 | 否（或仅补注释） |
| D | 确认 st-compat 模式 TALKATIVE(4)/VOTING(5) 降级行为 | 调查+决策 | 中 | 视结论（保守：仅文档化+补测试） |
| E | 补边界用例（空群/单成员/全 disabled/LIST 中间失败） | 测试 | 极低 | 否（仅新增测试） |

> 前端群聊 UI 接线（报告第 6 项）按用户既有要求**暂搁置**，不在本次范围。

---

## 二、逐项做法 / 风险 / 规避 / 验证

### 项 A：删除 `manual_skip_ai` 死字段

**做法**
- `roleplay_prompt_assembly.py`：
  - 删除 `PromptAssemblyRequest.manual_skip_ai: bool = False`（:382）。
  - 删除 `_resolve_group_speaker` 中 `req.manual_skip_ai = True`（:2126）及其分支注释。
  - 更新 :2144 过期注释「多成员一次性响应待阶段 3 补全」→ 注明 F1 已用队列实现 LIST 多成员串联。
  - 更新/删除 :2347、:2350 提及 `manual_skip_ai` 的注释，改为说明 MANUAL 跳过由 websocket 队列 `[]` 驱动。

**风险**
- R-A1：`PromptAssemblyRequest` 若为对外 API 请求模型（Pydantic），删字段可能破坏接口契约或序列化。
- R-A2：其它模块（API 层）可能通过类型提示引用该字段。

**规避**
- 已在审计中 grep 全代码库：`manual_skip_ai` 仅出现在 `roleplay_prompt_assembly.py` 的声明/赋值/注释，**无任何读取点、无 API schema 引用**。执行前再 grep 一次确认。
- 删除后用 `py_compile` + 全量测试验证无 ImportError / AttributeError。

**验证**
- `python -m pytest tests/ -q` 全绿；`py_compile` 通过；grep `manual_skip_ai` 仅剩 0 处。

---

### 项 B：补 NATURAL/POOLED 选角内部逻辑单测

**做法**
- 新增 `tests/test_group_speaker_selection.py`，复用 `test_f1_speaker_queue.py` 的轻量 fake 对象模式（fake `GroupChat` / `Character` / `db`），**不依赖真实数据库**。
- 覆盖 `_select_natural_speaker`：
  - 提及强制：user_text 含某成员名 → 返回该成员（确定性）。
  - 概率激活：设确定性格 `talkativeness`，`monkeypatch` `random.random`/`random.choice` 锁定结果；验证 `allow_self=False` 时排除上一位发言者。
  - 回退：全部 `talkativeness=0` → 回退随机且回避 last。
  - follower 衰减：follower 成员的有效 talkativeness 被 `FOLLOWER_DAMPING` 乘算。
- 覆盖 `_select_pooled_speaker`：
  - 最近用户消息后已发言成员被排除；全发言后回退排除 last。
- 覆盖 `_resolve_group_speaker` 分支（用 mock db）：
  - VOTING(5) 无成员 → 抛 400；有成员 → LLM 投票或回退 TALKATIVE。
  - TALKATIVE(4) → 加权随机。
  - MANUAL(2) 无 `current_speaker_id` → 置 skip 标志（A 删除后改为断言"不设置发言者且不抛错"）。
  - NATURAL/POOLED/LIST 单发言者解析。
  - st-compat 模式 4/5 → 降 NATURAL（与项 D 联动，补断言）。

**风险**
- R-B1：`random` 非确定性导致测试偶发失败（flaky）。
- R-B2：fake 对象与真实 `Character`/`GroupChat` 字段不一致，测试失真。
- R-B3：`_resolve_group_speaker` 依赖 `req.db.query`，mock 不当可能漏测真实路径。

**规避**
- 对每个随机分支 `monkeypatch` `random.random` 返回固定值（如 0.0 必激活 / 1.0 不激活），或 `random.choice` 返回首位，使结果可断言。
- fake 对象严格对齐被测函数实际读取的字段（`talkativeness`、`name`、`id`、`follower_members`、`disabled_members`、`allow_self_responses`）。
- 对 `_resolve_group_speaker` 用 `MagicMock`/`AsyncMock` 的 `db.query().filter().first()` 链，断言调用参数与最终 `req.current_speaker_id`。

**验证**
- 新文件 `pytest tests/test_group_speaker_selection.py -q` 全过；纳入全量套件后整体仍绿。

---

### 项 C：定位并确认 E2（群专属 WI 偏移）

**做法**
- 检索 `worldbook_service.py` 中 worldbook 深度/位置枚举映射（ST 0-9 depth、特殊语义），确认其是否即 E2 所指。
- 对照 `test_worldbook_group_and_position.py`（`test_st_integer_enum_full_range` / `test_at_depth_five_maps_to_at_depth_four` / `test_st_string_names`）确认该能力已被测试。
- 若确认 E2 = depth 枚举映射（已测）：仅在审计/代码注释补一句澄清，**不改逻辑**。
- 若发现群聊场景确有专属偏移未实现：记录为缺口，提交方案待用户决策（不擅自改）。

**风险**
- R-C1：误判 E2 形态，把"已覆盖"当"缺失"或反之。

**规避**
- 以 ST 1.18.0 参考源（`SillyTavern-1.18.0/.../public/scripts/`）中 worldInfo 深度枚举定义为准，交叉确认。
- 结论保守：宁可"标注待确认"也不虚构修复。

**验证**
- 输出 E2 定位结论（文件:行号 + 对应测试），写入审计文档补遗；无生产代码改动或仅注释级。

---

### 项 D：确认 st-compat 模式 TALKATIVE(4)/VOTING(5) 降级

**做法**
- 查 ST 1.18.0 参考源中 `activation_strategy` 枚举定义，确认 st-compat 目标版本是否含 4/5。
- 情形 1（参考源显示 4/5 属 ST 标准策略）：当前降级为潜在对齐缺口。
  - 保守处理：**不擅自实现完整 TALKATIVE/VOTING 的 st-compat 路径**（范围与风险大），改为：
    - 在 :2064-2070 补注释说明降级依据（引用 ST 版本/枚举）；
    - 补一条测试断言"st-compat + strategy 4/5 → 解析为 NATURAL(0)"，把当前行为固化为已知限制；
    - 在审计报告标注为"待用户决策是否补齐"。
- 情形 2（参考源显示 st-compat 对标版本仅 0-3）：当前行为正确，仅需补注释 + 测试固化。

**风险**
- R-D1：在 st-compat 实现 4/5 可能引入与 ST 行为偏差、回归原生路径。
- R-D2：误判枚举导致错误"修复"。

**规避**
- 以参考源为准，只在结论明确且风险低时做注释/测试级改动；**不实现新的选角算法**。
- 任何行为变更（若有）必须配测试且全量绿。

**验证**
- 输出枚举核查结论；补/固化测试；全量套件绿。

---

### 项 E：补边界用例

**做法**（均用 fake 对象，不依赖真实 DB）
- 空群（无成员）：NATURAL → 返回 None；VOTING → 抛 400（现有防御 :2077）。
- 单成员群：NATURAL → 返回该成员。
- 全 disabled：`_enabled_member_ids` 返回 `[]` → 激活侧无候选。
- LIST 多成员：`resolve_group_speaker_queue` 返回全启用成员有序列表（串联已由 F1 覆盖）。
- LIST 多成员中间发言者生成异常：断言 `_gen` 捕获异常且不中断其余成员（对照 `websocket.py:1629-1633`，可用 mock generation 抛错验证）。

**风险**
- R-E1：边界测试可能暴露既有真实 bug（如全 disabled 时行为未定义）。

**规避**
- 测试只"记录并断言当前行为"；若发现可疑行为，报告而非强行改逻辑。

**验证**
- 新边界测试通过；全量绿。

---

## 三、总体风险与回滚

- **总体风险**：低—中。项 A/B/E 为零或极低风险（测试 + 局部清理）；项 C/D 以调查与文档/测试固化为主，避免行为级大改。
- **回滚**：所有改动均可通过 git 逐文件 `checkout` 回滚；生产代码改动仅项 A（已确认无引用），项 C/D 默认不产生行为变更。
- **执行顺序**：A（清理）→ B（选角单测）→ E（边界）→ C（E2 调查）→ D（st-compat 调查）。每步后跑相关测试，最后跑全量 `pytest tests/`。
- **不触碰**：前端代码、前端接线、任何数据库 migration、对外 API 契约字段（除已确认无引用的 A 字段）。
