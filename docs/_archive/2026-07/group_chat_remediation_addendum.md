# 群聊审计修复执行补遗（Items A–E 结果）

> 日期：2026-07-23
> 前置：依据 `docs/group_chat_full_audit.md`（保守审计）与 `docs/group_chat_remediation_plan.md`（修复计划）
> 执行顺序（按原计划）：A → B → E → C → D
> 最终验证：`pytest tests/` → **388 passed / 36 skipped / 0 failed**（基线 354 + 新增 34 测试）

---

## A. 删除 `manual_skip_ai` 死字段 ✅ 完成（生产代码改动）

- **改动**：`backend/app/services/roleplay_prompt_assembly.py`
  - 删除 `PromptAssemblyRequest.manual_skip_ai` 字段声明（原 :382）。
  - 删除 `_resolve_group_speaker` 中 `req.manual_skip_ai = True` 赋值（原 :2126）。
  - 更新 3 处过期注释（:2057 st-compat 引用、:2144 LIST 串联已由 F1 实现、:2350 MANUAL 跳过由 websocket 队列 `[]` 承接）。
- **风险规避**：删除前全代码库 grep 确认 `manual_skip_ai` 仅 4 处（声明/赋值/注释），**无任何读取点、无 API schema 引用**。
- **验证**：`py_compile` 通过；全量套件 0 失败；grep `manual_skip_ai` 仅剩 0 处。
- **影响**：纯清理，不改变任何运行时行为（MANUAL 跳过此前已改由 websocket `resolve_group_speaker_queue` 返回 `[]` 承接）。

---

## B. 补 NATURAL/POOLED 选角内部逻辑单测 ✅ 完成（新增测试，零生产改动）

- **新增文件**：`backend/tests/test_group_speaker_selection.py`（**23 个测试，全过**）
- **覆盖**：
  - `_enabled_member_ids` 禁用过滤（纯函数 4 例，含 disabled 为 list）。
  - `_read_talkativeness` 边界（缺失/"0"/"0.5"/非法 → 0.5）。
  - `_select_natural_speaker`：提及强制 / 全员 0 回退取首位 / 防连续排除 last / **follower 衰减**（random.random=0.5 时 follower 被 0.3 系数排除）/ 概率防连续分支。
  - `_select_pooled_speaker`：未发言优先 / 全发言回退排除 last / 无用户标记视为全部未发言 / 空成员返回 None。
  - `_resolve_group_speaker` 分支：MANUAL(跳过) / NATURAL / POOLED / LIST(单发言者 fallback) / TALKATIVE / VOTING(回退 TALKATIVE) / 已指定发言者不被覆盖 / **st-compat 4/5 降级 NATURAL 固化**（断言不调用原生选角器）。
- **确定性手段**：对随机分支 `monkeypatch` `random.choice`（取首位）/ `random.random`（固定值）；fake `db`/`GroupChat`/`Character` 严格对齐被测函数读取字段；不依赖真实数据库。

---

## E. 补边界用例 + 发现并修复一个真实潜在 bug ✅ 完成（新增测试 + 1 处生产修复）

- **新增文件**：`backend/tests/test_group_boundary.py`（**11 个测试，全过**）
- **覆盖**：空群 NATURAL→None / 空群 VOTING→400 / 空群 TALKATIVE→400 / 空群 POOLED→None / 单成员 NATURAL→该成员 / 单成员 TALKATIVE→该成员 / 全 disabled `_enabled_member_ids`→[] 且 NATURAL 不设置发言者 / LIST 有序队列 / LIST 排除 disabled / **LIST 多成员中间发言者异常不中断其余**（复刻 `websocket.py:1629-1633` 逐发言者 catch）。
- **🔴 发现并修复的真实潜在 bug**：
  - `roleplay_prompt_assembly.py` 在 :1555 / :2077 / :2105 三处 `raise HTTPException(...)`，但**模块未 import `HTTPException`**。导致这些防御性 400 实际会抛 `NameError`，而非干净返回 400。
  - 该路径此前无任何测试覆盖，故基线 354 passed 未暴露（属于计划 Item E 风险 R-E1「边界测试暴露既有真实 bug」的实例）。
  - **修复**：在 `roleplay_prompt_assembly.py` 导入区新增 `from fastapi import HTTPException`（:18）。**仅启用既有意图行为，不改任何逻辑**。
  - **固化测试**：`test_empty_group_voting_raises_400`、`test_empty_group_talkative_raises_400` 断言 400。
- **验证**：`py_compile` 通过；边界 + 选角共 34 测试全过；全量套件 388 passed / 0 failed。

---

## C. 定位并确认 E2（群专属 WI 偏移）✅ 完成（调查，无生产改动）

- **结论**：E2 = WI 位置枚举偏移映射，即 `normalize_worldbook_position`
  （`backend/app/services/worldbook_import_utils.py:36`）。
- **形态**：将 ST 1.18.0 的 position 枚举（0–8）映射到 Palink 内部位置（0–7），偏移为 `st_pos - 1`；
  规范验收点 `at_depth=5 → 4`（`WI_POS_AT_DEPTH == 4`）。
- **已被测试覆盖**：`backend/tests/test_worldbook_group_and_position.py`
  - `test_st_integer_enum_full_range`（0..8 全映射）/ `test_at_depth_five_maps_to_at_depth_four`（验收点）/ `test_st_string_names`（字符串名）/ 越界与未知回退 / 旧名兼容。
- **处置**：确认 E2 已实现且已测，**不改逻辑**，仅此处书面澄清定位。

---

## D. 确认 st-compat 模式 TALKATIVE(4)/VOTING(5) 降级 ✅ 完成（调查 + 注释 + 测试固化）

- **核查依据（ST 1.18.0 参考源）**：`SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/group-chats.js:122`
  ```js
  export const group_activation_strategy = {
      NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3,
  };
  ```
  ST 1.18.0 **仅定义 0–3**，没有 4(TALKATIVE)/5(VOTING)。两者是 **Palink 原生扩展**
  （代码注释 `_GROUP_ACTIVATION_TALKATIVE=4 / _GROUP_ACTIVATION_VOTING=5` 已自述）。
- **结论**：对应计划「情形 2」——st-compat 对标版本仅 0–3，收到原生 4/5 时降级 NATURAL(0)
  **属正确对齐行为，非缺口**。
- **处置**：
  - 在 `roleplay_prompt_assembly.py:2057` 补充注释，引用参考源 `group-chats.js:122` 说明 0–3 枚举，
    明确 4/5 为扩展、降级为正确对齐（非待补缺口）。
  - **行为变更**：无。
  - **测试固化**（已在 Item B 完成）：`test_resolve_stcompat_talkative_downgrades_to_natural`、
    `test_resolve_stcompat_voting_downgrades_to_natural` 断言降级且不复用原生选角器。

---

## 总体结论

- 全部 5 项（A/B/C/D/E）执行完毕，符合「先安全后敏感、每改必测、最小原子改动、可回滚」原则。
- 生产代码改动仅两处且均低风险：
  1. 删除死字段 `manual_skip_ai`（A）。
  2. 补 `HTTPException` 导入，修复防御性 400 的 `NameError` 潜在 bug（E）。
  3. 两处注释澄清（A 过期注释、D 降级依据引用）。
- 新增测试 34 个（选角 23 + 边界 11），全量套件 354 → **388 passed**，0 失败，36 skipped 不变。
- 前端群聊 UI 接线按用户既有要求**持续搁置**，不在本次范围。
- 后端群聊对齐状态：**代码对齐约 82–85%**，剩余项仅为前端接线与可选的原生 4/5 在 st-compat 的取舍（当前保守按"降级 NATURAL"处理，已文档化）。
