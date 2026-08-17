# 验证报告：群聊后端对 ST 1.18.0 高保真适配 + 1:1 非回归

> 工作区：`D:\项目\Palink-AI\docs\goal-groupchat`
> 日期：2026-07-23
> 取向：严格对齐 ST 1.18.0；1:1 验证 = 专项直测 + 全量零回归

## 一、修复清单（已落地）

| 子任务 | 文件 | 改动 |
|--------|------|------|
| S3 合并卡保真 | `backend/app/services/roleplay_prompt_assembly.py` `_build_group_combined_card` (:1619) | ① 移除自动 `Name: ` 前缀（对齐 ST collectField 不前缀成员名）；② mes_example 逐成员未以 `<START>` 开头补 `<START>\n`；③ `chat_metadata.scenario` / `chat_metadata.mes_example` 非空时整体覆盖逐成员收集；④ prefix/suffix 与值内 `<FIELDNAME>`→字段名、`{{char}}`→成员名 替换（对齐 customTransform） |
| S4.1 follower 模式感知 | `_select_natural_speaker` (:1682) + `_resolve_group_speaker` (:2134) | 新增 `st_mode` 参数；`st-compat` 模式忽略 `follower_members`（ST 1.18.0 无此概念），`palink-native` 保留衰减扩展 |
| S4.2 提及尊重 bannedUser | `_select_natural_speaker` (:1718) | 提及命中后过滤最后发言者（除非 `allow_self_responses`），对齐 ST group-chats.js:1259 |
| S5 1:1 非回归测试 | `tests/test_single_chat_no_group_leakage.py`（新建） | 6 项直测：装配无 group_* 泄漏、builder 1:1 不注入合并卡、group_profile None 守卫、worldbook group_chars=None |
| S6 合并卡保真测试 | `tests/test_group_chat_combined_card.py`（新建） | 7 项直测：无 Name: 前缀、`<START>` 包裹、覆盖、token 替换、disabled 由调用方预选 |
| S4 单测加固 | `tests/test_group_speaker_selection.py` | +2 项：st-compat 忽略 follower、提及排除 last |

## 二、差异矩阵闭合情况

差异矩阵（见 `goal-design.md` 第二节）中标注的 **偏离** 项：

- ✅ 合并卡成员名前缀（高）→ S3 已修复
- ✅ 合并卡 mes_example `<START>`（高）→ S3 已修复
- ✅ 合并卡 chat_metadata 覆盖（中）→ S3 已修复
- ✅ 合并卡 `<FIELDNAME>`/`{{char}}` token（中）→ S3 已修复
- ✅ NATURAL follower 衰减（中，仅 st-compat）→ S4.1 已修复
- ✅ NATURAL 提及尊重 bannedUser（中）→ S4.2 已修复

**吻合** 项（NATURAL 概率/回退/防连续、POOLED、LIST、MANUAL、SWAP 发言者卡、history Name 前缀、worldbook 群策略、激活枚举 0–3 回退、1:1 守卫）经测试确认无回归。

## 三、测试结果

```
pytest tests/ -q  → 403 passed, 36 skipped, 0 failed  (基线 388 passed)
```

- 新增测试：15 项（speaker_selection +2、combined_card +7、single_chat_leakage +6）
- 全量 0 失败，单聊（1:1）路径零泄漏，群聊保真度提升。

## 四、已知限制（保留为 palink-native 扩展，st-compat 严格对齐）

1. `TALKATIVE(4)` / `VOTING(5)` 为 ST 后续版本扩展，st-compat 收到时回退 NATURAL(0)（正确对齐 ST 1.18.0 仅 0–3）。
2. `follower_members` 衰减仅 `palink-native` 生效，st-compat 忽略。
3. 合并卡 `chat_metadata` 覆盖读取自 `GroupChat.chat_metadata`（群级），与 ST per-chat 覆盖语义在群聊场景下等效（群 chat_metadata 由导入/API 持久化）。
4. `{{user}}` 在合并卡内不预解析，由下游 `build_st_compat_messages._sub` 统一解析（与 ST 下游一致）。

## 五、结论

群聊后端已近乎完美对齐 ST 1.18.0 群聊语义（激活策略 + 合并卡 + 历史前缀 + 发言者卡绑定），且单对话（1:1）后端经专项直测 + 全量零回归证明未受影响。
