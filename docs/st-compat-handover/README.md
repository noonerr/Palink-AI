# ST-Compat Prompt 装配最终对齐 - 交接包

> **交接日期**: 2026-07-21
> **change-id**: `align-st-compat-prompt-final-parity`
> **目标**: 让 Palink 角色扮演后端在 `silly_tavern_mode=st-compat` 模式下装配的 prompt 与 SillyTavern 1.18.0 浏览器端 `PromptManager` 装配结果完全一致（95%+ 把握）。

---

## 一、本文件夹内容

| 文件 | 用途 |
|------|------|
| `README.md` | 本文件，交接总说明 |
| `research-notes.md` | 三路并行深度研究的核心发现与记忆（必读） |
| `spec.md` | 完整 spec 文档（同 `.trae/specs/align-st-compat-prompt-final-parity/spec.md`） |
| `tasks.md` | 8 Phase 任务分解（同 `.trae/specs/align-st-compat-prompt-final-parity/tasks.md`） |
| `checklist.md` | 验收检查手册（同 `.trae/specs/align-st-compat-prompt-final-parity/checklist.md`） |

---

## 二、背景与缘由

用户参考 `docs/st-compat-gap.md` 清单，要求研究 Palink 角色扮演后端如何才能做到完美适配 ST 1.18.0 后端，做到和 ST 的动作完全一致，并要求 95%+ 把握后写出完善的 spec 和检查手册。

**清单第 0 节定义的两条面**：
- **面 A**（本 spec 范围）：Palink **服务端自建** ST 格式 prompt（`build_st_compat_messages`）
- **面 B**（已基本对齐，不在范围）：Palink ST 兼容 API 契约（让 ST 原生客户端直连 Palink，透明代理）

本 spec 聚焦面 A 的 7 项 P1/P2 差距 + 3 项新发现差距。

---

## 三、研究方法（三路并行）

为保证 95%+ 把握，本次研究派出三路并行子代理：

1. **Palink 现有代码核对**：逐行阅读 `build_st_compat_messages` / `roleplay_prompt_assembly.py` / `macro_service.py` / `worldbook_service.py` / 模型定义
2. **ST 1.18.0 源码对照**：定位 `SillyTavern-1.18.0` 官方源码（位于 `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\`），逐函数对照 `openai.js` / `world-info.js` / `personas.js` / `authors-note.js` / `PromptManager.js`
3. **群聊与 token 路径分析**：核对三个主聊天调用点是否传 `group_id`、token 预算裁剪逻辑、`UserSetting` / `Character` 字段完整性、测试覆盖度

详见 `research-notes.md`。

---

## 四、整体把握度

- **7 项清单内差距**：100% 把握（已逐行核对 Palink 与 ST 1.18.0 源码）
- **3 项清单修正**：100% 把握（已确认 ST 1.18.0 源码实际行为）
- **3 项新发现差距**：95%+ 把握（D8 为调用链分析结果，D9/D10 为 grep + 代码阅读直接证据）
- **整体把握度**：>95%，达到用户要求门槛

---

## 五、关键交付物

### 5.1 修复项（10 项差距）

**清单内 7 项 P1/P2 差距**（D1-D7）：
- D1 G14 jailbreak 索引 11 丢失（P1）
- D2 G13 names_behavior / 群聊名字（P1）
- D3 wi_format 未应用（P1）
- D4 token 预算裁剪缺失（P1）
- D5 new_group_chat_prompt / group nudge（P2）
- D6 pin_examples 未尊重（P2）
- D7 scenario_format / personality_format（P2）

**清单未提及但纳入修复的 3 项新差距**（D8-D10）：
- D8 群聊装配路径断裂（主聊天调用点不传 group_id，群聊分支为 dead code）
- D9 `{{charjailbreak}}` 宏死代码（Character 无 jailbreak_prompt 字段）
- D10 `dynamic_context_parts` 在 st-compat 路径被丢弃（memory/plotline 不进入 prompt）

### 5.2 订正项（3 项清单错误描述）

- outlet (pos 7) 项订正为"经后置 macro pass 解析，内容可达，不再是差距"
- G14 jailbreak 字段来源订正为 `data.post_history_instructions`（非 `data.extensions.jailbreak`）
- 作者备注 5 态订正为"ST 1.18.0 实际 3 态（0/1/2），Palink 5 态是扩展"

### 5.3 验证项

- 5 个核心场景 ST 1.18.0 golden vector 端到端测试（单聊+群聊+wi_format+outlet+长对话）
- 全量回归测试无退步
- 性能 P95 < 200ms
- Docker 容器重建后所有测试通过

---

## 六、执行顺序（8 Phase）

```
Phase 0 基线备份 + Golden Vector 提取
   ↓
Phase 1 P1 D1 — G14 jailbreak 索引 11 修复
   ↓
Phase 2 P1 D2 — G13 names_behavior 四态 + 群聊名字
   ↓ (Phase 3 可与 Phase 1/2 并行)
Phase 3 P1 D3 — wi_format 包裹
   ↓
Phase 4 P1 D4 — token 预算裁剪
   ↓
Phase 5 P2 D5/D6/D7 — 群聊 nudge + pin_examples + scenario/personality_format
   ↓
Phase 6 D8/D9/D10 — 群聊路径接通 + 死代码修复 + dynamic_context_parts 接入
   ↓
Phase 7 清单订正与文档更新
   ↓
Phase 8 端到端 Golden Vector 验证与最终回归
```

每个 Phase 严格按 `tasks.md` 执行 SubTask，每个 SubTask 完成后勾选 `checklist.md` 对应项。

---

## 七、关键风险点（交接人务必关注）

1. **Phase 4 token 预算裁剪**：可能与现有 `_apply_dynamic_trimming` 逻辑冲突，需仔细测试，避免影响性能
2. **Phase 6 D8 群聊路径接通**：可能暴露既有群聊分支（`_resolve_group_speaker` / `_build_group_profile_context`）的隐藏 bug（之前是 dead code，从未在生产环境运行过）
3. **Phase 1 jailbreak 覆盖语义修改**：可能影响存量角色卡的行为（依赖 `context_template.jailbreak` 覆盖 `char.post_history_instructions` 的角色），需做向后兼容测试
4. **Phase 0 Golden Vector 提取**：必须从 ST 1.18.0 浏览器端**真实导出**，不能用 Palink 自身预期当 golden（清单第 4 节明确警告）
5. **前端修改边界**：本 spec 仅修改后端，**不修改前端**。Phase 6 D8 完成 `CharacterChatRequest` 后端接口开放后，前端接入由后续 spec 处理

---

## 八、回滚方案

- Phase 0 已创建 `baseline-pre-st-compat-final` git tag 和 docker tag
- 若任一 Phase 严重失败，可：
  ```bash
  git reset --hard baseline-pre-st-compat-final
  docker tag palink-ai-backend:baseline-pre-st-compat-final palink-ai-backend:latest
  docker exec palink-ai-db-1 psql -U palink -c "DROP TABLE IF EXISTS characters_jailbreak_backup;"
  # 数据库回滚
  docker exec -i palink-ai-db-1 psql -U palink palink < backups/FB-0/db_dump_st_compat_final.sql
  ```

---

## 九、依赖与前序 spec

- **依赖**: `st-core-parity-conservative`（G1-G15 已对齐项作为基线）
- **依赖**: `final-st-perfect-parity-deep-audit`（B-P0-1 角色卡宏已修复）
- **不冲突**: `complete-st-parity-remaining-gaps`（聚焦面 B + 前端，与本 spec 面 A 互不重叠）

---

## 十、给接手人的建议

1. **先读 `research-notes.md`**：里面有所有代码位置、行号、ST 1.18.0 源码对照、清单订正理由，是后续修复的事实依据
2. **再读 `spec.md` 第一节"95%+ 把握的依据"**：理解每项差距的把握度来源
3. **按 `tasks.md` Phase 顺序执行**：不要跳序，每个 Phase 有明确依赖
4. **每完成一个 SubTask，立即勾选 `checklist.md` 对应项**：避免遗漏
5. **Phase 0 Golden Vector 提取是关键**：若 golden vector 不真实，后续所有验证都是自洽而非真兼容
6. **遇到不确定的地方，对照 ST 1.18.0 源码**：位于 `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\`

---

## 十一、关键文件路径速查

### Palink 后端
- `backend/app/services/character_message_builder.py` — `build_st_compat_messages` 定义（345-605 行）
- `backend/app/services/roleplay_prompt_assembly.py` — 调用处（2390-2425 行）+ macro pass（2602-2622 行）+ token 裁剪跳过（2639/2649 行）
- `backend/app/services/macro_service.py` — `{{charjailbreak}}` 宏（310-312 行）+ `{{outlet::name}}` 宏（382-387 行）
- `backend/app/services/worldbook_service.py` — pos 7 outlet 构建（1196-1201 行）
- `backend/app/models/character.py` — Character 模型（无 jailbreak 字段，需新增）
- `backend/app/models/system.py` — UserSetting 模型（无 jailbreak 字段，需新增）+ ContextTemplate.jailbreak
- `backend/app/character_card.py` — 角色卡导入（289-352 行）
- `backend/app/api/character_ext.py` — CharacterChatRequest（3732-3756 行，无 group_id，需新增）
- `backend/app/api/websocket.py:1403` — WebSocket 调用点
- `backend/app/api/silly_tavern.py:3423` — ST swipe 调用点

### ST 1.18.0 源码（对照基准）
- `SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\openai.js` — 核心装配逻辑
- `SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\world-info.js` — WI 扫描 + outlet
- `SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\personas.js` — Persona 6 态 position
- `SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\authors-note.js` — Author's Note 3 态
- `SillyTavern-1.18.0\SillyTavern-1.18.0\public\scripts\PromptManager.js` — 默认 prompt order（索引 2=personaDescription, 11=jailbreak）

### 清单与文档
- `docs/st-compat-gap.md` — 原始差距清单（需订正 3 处）
