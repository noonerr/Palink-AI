# BACKUP_INFO · 分支不变量修复的半成品现场（已退回，未采用）

## ① 备份日期

2026-10-22 11:5x（本地时间）

## ② 原始来源

子 agent `branch-invariants-fix` 在 2026-10-22 11:1x–11:5x 的未提交工作区改动：

- `backend/app/services/branch_resolution.py`（新，未采用）
- `backend/tests/test_branch_read_path_no_write.py`（新，未采用）
- `frontend/src/lib/branch-selection.ts` + `__tests__/branch-selection-contract.test.ts`（新，未采用）
- 另有 4 个被跟踪文件被它改过（`character_ext.py` / `silly_tavern.py` / `slash_command_service.py` /
  `CharacterView.tsx`），**已 `git checkout --` 退回**，本目录只留它新增的 4 个文件。

## ③ 备份原因

该 agent 达到最大轮次上限中断，工作区停在**不干净状态**：

- 全量门禁后端 **4 failed**（`failed=0` 是硬线）：
  - `test_branch_read_path_no_write.py::test_flagged_active_wins_over_newest_message`
    —— 它当时正在做"反向证明 D（故意忽略 `is_active`）"，**把故意改坏的代码留在了工作区**；
  - `test_p0_slash_and_smart_card_fixes.py` 三条既有用例被改红（源于它对
    `slash_command_service.py` 的 26 行改动）。
- 前端侧反而是绿的（135 文件 / 1715 通过），说明它前端那半套基本成形。

处置：退回 4 个被跟踪文件 + 把它的 4 个新文件移进本目录留档，
退回后复验 `test_p0_slash_and_smart_card_fixes.py` **18 passed**、前端门禁回到 **1704 passed / 134 文件**、
`git status` 干净。**两个缺陷（读接口写库、无活动分支时三套兜底规则）目前仍未修。**

## ④ 后续待办清单

1. 重做时**先读这份现场**：`files/` 下保留它设计的统一规则实现（`branch_resolution.py`：
   有 `is_active` 用它，否则取"含最新消息那条"，再按创建时间破平）与前端共用模块，
   方向是对的，可以在此基础上重写，不必从零开始。
2. 必须避免它犯的两个错：
   - **不许改 `slash_command_service.py` 的行为**去适配新规则（那 26 行改红了 3 条既有用例）；
   - **反向证明做完必须立刻还原**，并在工作区里 `grep` 自己留下的临时标记为 0 才算完。
3. 硬判据不变：`bash scripts/gate.sh` 退出码 0 且 `failed=0 errors=0`；
   并新增一条断言"GET 形状的路径调用前后 `is_active` 分布一字不变"。
4. ⛔ 不要动 `same_level`（同级分支语义待老板定）；不要给"消息写进非活动分支"这条擅自定规则。
5. 回退本目录内容：把 `files/` 下 4 个文件复制回原路径即可（被跟踪文件需自行重做改动）。
