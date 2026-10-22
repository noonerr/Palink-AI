# BACKUP_INFO — 2026-10-10_记忆档位注释一致性

## ① 备份日期
2026-10-10（凌晨，约 01:30）

## ② 原始来源路径
主区 `D:\项目\Palink-AI` 下 10 份文件，按原相对路径存放在本目录 `pre/`：

| 相对路径 | 说明 |
|---|---|
| `backend/app/services/roleplay_prompt_assembly.py` | 档位表本体（含未提交的 10-09/10-10 记忆批全部改动） |
| `backend/app/utils.py` | `build_memory_context` 的 `len//2` 口径注释 |
| `backend/tests/test_memory_entity_card_gate.py` | 档位期望值 |
| `backend/app/models/system.py` | `UserSetting.memory_budget_level` 注释（⚠️ 该文件另含他人 MVU 副模型参数改动） |
| `backend/app/core/migrations.py` | `_RUNTIME_COMPAT_COLUMNS` 的 `memory_budget_level` 注释 |
| `frontend/src/components/views/settings-tabs/AppearanceTab.tsx` | 前端档位注释（仅注释，无逻辑） |
| `docs/OPEN_ISSUES.md` | ⚠️ **该文件 git 未跟踪**（`git ls-files` 无记录），无版本可回退，故备份价值最高 |
| `docs/SPEC_分层记忆注入_2026-09-02.md` | §4.1 档位表记录 |
| `docs/AUDIT_注入体系与ST对齐_2026-09-08.md` | 档位值对照表 |
| `TODOS.md` | 10-07 决策记录里的「1500→3000~6000」（⚠️ 该文件含他人未提交改动） |

`pre/_manifest.tsv` 记录各文件 sha256（10 行）。

## ③ 备份原因
`REPORT_记忆预算与历史配比_全记录_2026-10-10.md` 落地的「记忆预算 1500 → 4000」改动，
在代码与文档里留下了 **6 处仍写旧档位（1500/3000）的注释与记录**（另 2 处为 docs 表格）。
本次动作 = **纯注释/文档一致性同步 + 把该批源码提交入库**，**零行为变更**。

备份动机：
1. `docs/OPEN_ISSUES.md` 未纳入 git，改坏了无法用 git 回退；
2. `roleplay_prompt_assembly.py` 的工作区改动**尚未提交**（HEAD 仍是 `(750,1500,3000,6000)`），
   动它之前先留一份逐字节快照；
3. `models/system.py` / `TODOS.md` 混有**他人**未提交改动，本次只改注释、**不提交这两个文件**，
   备份用于证明我只动了注释行。

## ④ 后续待办清单
1. **提交范围**（逐项 `git add -- <path>`，禁 `-A`）：
   - 可提交：`backend/app/services/roleplay_prompt_assembly.py`、`backend/app/utils.py`、
     `backend/tests/test_memory_entity_card_gate.py`、`backend/app/core/migrations.py`、
     `frontend/src/components/views/settings-tabs/AppearanceTab.tsx`、`docs/SPEC_分层记忆注入_2026-09-02.md`、
     `docs/AUDIT_注入体系与ST对齐_2026-09-08.md`
   - **不可提交**（含他人未提交改动，改动仅留在工作区）：
     `backend/app/models/system.py`（他人 MVU 副模型参数批 2026-10-05）、`TODOS.md`、
     `docs/OPEN_ISSUES.md`（未跟踪）
2. **无需重建容器**：本批为注释改动，`frontend/dist` 与 backend 镜像均无功能差异
   （记忆档位逻辑批已于 2026-10-09 部署，容器内实测 `(750, 4000, 6000, 8000)`）。
3. 报告 §6 对摘要能力的描述有偏差：`ai_summary_service.py` / `compression_service.py`
   均已 `deprecated`，真身为 `MemoryLifecycleService`，且 `maybe_auto_compress` 已在
   `api/chat.py` / `api/websocket.py` 挂载 —— 不是「没接线」。若要推进摘要化，从此处入手。
4. 仍未做（报告 §8 待办）：放开 `NEIGHBOR_MAX_ADDS`（现 4）、第 4 档 8000 实测、
   换 2~3 个会话复跑验证 4000 普适性、`_estimate_tokens` 高估 2 倍对小窗口裁剪的影响。
