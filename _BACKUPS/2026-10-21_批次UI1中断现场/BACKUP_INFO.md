# BACKUP_INFO — 2026-10-21 批次UI1 中断现场

## ① 备份日期
2026-10-21（主脑接手时点：UI1 子 agent 撞 150 轮上限、**零提交**）

## ② 原始来源路径
`D:\项目\Palink-AI`（共享工作区，逐文件按原相对路径收录在 `full/` 下）

## ③ 备份原因
执行**批次UI1**（给"接上了但改不了"的设置补控件 + 删假开关）的子 agent 在 150 轮上限被强制中断，
**一笔未提交、未跑完门禁**。按《中断现场收尾流程》：先物理备份现场（patch + 全量文件），
再由主脑实测归因，**禁止整包 `git apply -R` 回退**（同工作区里还有已入库的 E2b 提交）。

**中断时的改动规模**（`ui1-uncommitted.patch`，9 个文件）：

| 文件 | 增/删 | 归属 |
|---|---|---|
| `frontend/.../settings-tabs/PromptSettings.tsx` | +177 / −2 | UI1：作者注四项 + 破甲控件 + 删 `show_character_status` 假开关 |
| `frontend/.../ui/custom/PresetManager.tsx` | +176 / −27 | UI1：预设"选中哪份"接后端 + 本对话副本只读展示 |
| `frontend/.../views/CharacterView.tsx` | +35 / 0 | UI1：进角色页对齐后端 selection（只填未确定的情况） |
| `frontend/.../chat/ChatManagerDialogs.tsx` | +2 / 0 | UI1：预设选择属性透传 |
| `frontend/.../settings-tabs/RoleplayEngineTab.tsx` | +16 / −2 | UI1：预设选择接线 |
| `frontend/.../ui/custom/CharacterCardRenderer.tsx` | +19 / −2 | UI1：选中变化后在**保留旧快照**的前提下重拉（避免空窗期读到 null） |
| `backend/app/schemas/user.py` | +19 / −3 | UI1：`UserSettingUpdate.jailbreak` + 订正作者注位置值域的旧注释 |
| `backend/app/api/users.py` | +8 / −1 | UI1：settings 响应带 `jailbreak` |
| `.workbuddy-ai/memory/*` | — | **不是本批**（开工前既有改动，未纳入 patch） |

**中断时未入版本库的新文件**（同样按原相对路径收在 `full/` 下，与上面 8 个改动文件一起共 13 个文件）：
`frontend/src/lib/promptPresetSelection.ts`、
`frontend/src/components/views/settings-tabs/__tests__/prompt-settings-ui1.test.tsx`、
`frontend/src/components/ui/custom/__tests__/preset-selection-wiring.test.tsx`、
`backend/tests/test_ui1_settings_controls.py`、
`docs/_active/report/REPORT_批次UI1_设置控件补齐_2026-10-21.md`。

## ④ 后续待办清单（主脑接手，已完成的部分见本目录的接管记录）
1. **实测归因**（主脑已做）：`npx tsc --noEmit` 干净；UI1 自己的 9 例前端测试 + 7 例后端测试全绿。
   ⚠️ 后端测试**必须在 `backend/` 目录内跑**：在仓根跑会被根 `.env` 里 22 个未建模的环境变量
   顶出 `Settings() ValidationError: extra_forbidden`（这是环境陷阱，不是本批缺陷）。
2. **门禁**：`bash scripts/gate.sh frontend` / `backend` 各跑一次，只认 `failed=0 / errors=0`。
   ⚠️ UI1 报告里记的 `frontend rc=1` 是**当时 E2b 在途**造成的（3 个文件 7 例红）；E2b 已入库，
   重跑应以绿为准；若仍红，按文件归属判定。
3. **提交**：逐项 pathspec + 临时索引；⛔ 不许 `git add -A`。
4. **上线**：与 E2b 同窗口部署，判据见 `docs/OPEN_ISSUES.md` 与任务表"第三次上线"。
5. **未做项**（UI1 报告 §5 已列，别当成遗漏）：本对话覆盖层的写操作（本轮只读展示）、
   逐会话作者注控件、`author_note_frequency=0` 的装配语义、`PresetSelector.tsx`（全仓 0 处挂载，
   疑似死代码，登记不删）、`show_character_status` 的后端残留。

## 回退方式
- **只回单文件**：`git checkout -- <该文件>`（本目录的 `full/` 里有中断态全文，需要时拷回）。
- ⛔ **禁止** `git apply -R ui1-uncommitted.patch` 整包回退 —— 同工作区后续已有提交。
