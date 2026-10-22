# BACKUP_INFO — 2026-10-05_MVU插件能力补齐批次A

## ① 备份日期

**2026-10-05 01:55**（动工**前**备份，时序合规）。

## ② 原始来源路径

**本次实际会改动的文件（`pre/` 按原相对路径存放）**

| # | 原路径 | 本批用途 |
|---|---|---|
| 1 | `frontend/src/components/views/character/CharacterChat.tsx` | 批次 A-① 修「副模型调用失败却提示成功」的 if/else 漏分支 |

**`pre/` 内共 1 个文件**，`_manifest.tsv` 记 sha256 1 行。

**另含三份「工作区状态」快照（非 `pre/`，用于多 agent 并发下的整体可回滚）**

| 文件 | 内容 |
|---|---|
| `HEAD.txt` | 基线 commit `6b98c57241a6c2658471160f9daac21c80ab2ac5`，分支 `st-plugin-compat-20260727` |
| `worktree-uncommitted.patch` | `git diff HEAD --binary` 全量快照（**59,412 B，覆盖 14 个文件**） |
| `untracked-list.txt` | `git ls-files --others --exclude-standard`（**17 条**） |

> ⚠️ **`worktree-uncommitted.patch` 里包含的不只是本批的改动**，还有另两个会话的未提交成果：
> 「变量面板与插件变量接线」批（3 文件）与「变量自动清理_MVU对齐」批（8 文件 + 新增 `mvu_cleanup.py` 等）。
> 它存在的意义是：**万一并发写入把谁的改动冲掉，这份 patch 是唯一的整体回滚依据**。
> **本批不代提交、不代回滚这些文件。**

## ③ 备份原因

用户拍板开工 `docs/SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md` 的**批次 A**（零冲突四项），
并明确要求「记得做好备份」。

**本批背景（决定了备份为什么必须做）**：

1. **多 agent 并发写同一仓库**。另一个 agent 正在施工「变量自动清理_MVU对齐」批，
   **仍在运行中**（本次备份时它刚新增 `backend/scripts/_reverse_check_mvu_cleanup.py`、
   `backend/tests/test_mvu_cleanup_safety.py`）。共享工作区 + 未提交，是本仓历史高发事故形态。
2. **本批要改的前端文件是"活文件"**。`CharacterChat.tsx` 107 KB，是角色聊天的中枢组件，
   多个会话都在动它 —— 改坏即角色聊天不可用。
3. **SPEC 里批次 A 原定 4 项，实测有 3 项已被并发占用**（见 ④），
   本备份因此同时承担「记录当时工作区真实状态」的取证职责。

## ④ 后续待办清单（本批开工后必须做的事）

### A. 本批范围内（按 SPEC 批次 A）

| 项 | 状态 | 说明 |
|---|---|---|
| **① 修 `call_failed` 漏分支** | ✅ **本批实施** | `CharacterChat.tsx` if/else 链补 `call_failed` 分支，改为 `toast.error`。已备份 |
| **② 副模型参数 + 重试** | ⏸️ **本批暂缓** | **原因：消费点在 `backend/app/api/character_ext.py`（`run_secondary_mvu` 的调用方 :6323），该文件正被并发 agent 占用**。只加设置字段不接消费 = "挂没人消费的对象"，属本仓明令禁止的半桶做法 → 整体推迟 |
| **③ 30 楼窗口可配置** | ⏸️ **本批暂缓** | **原因：目标 `backend/app/services/roleplay_prompt_assembly.py` 已被并发 agent 改动**（+13 行，`_load_effective_stat_data` 的 `extra` Text 字符串修复，落点就在我要改的 `limit(30)` 同一个函数内）→ 并发写会互相覆盖 |
| **④ 角色卡级覆盖** | ⏸️ **本批暂缓** | 同上（依赖 ③ 的同一文件）+ 依赖 ② 先落地 |

### B. 交还用户 / 下一批必办

1. **等并发 agent 交回 `character_ext.py` / `roleplay_prompt_assembly.py` 后，补做 ②③④**。
   动手前**必须先 `git status` 复核这两个文件是否仍被占用**，并重新确认行号
   （并发改动已使 SPEC 里记录的行号（如 `:5183`）发生位移）。
2. **验证 ①**：`npx tsc --noEmit`（期望 exit 0）+ `npx vitest run`（期望 failed = 0）。
3. **反证 ①**：把新增的 `call_failed` 分支注释掉，断言必须变红（SPEC §3-① 验收要求）。
4. **提交纪律**：逐项 `git add -- <path>`，**禁用 `git add -A` / `git add .`**（多 agent 合住仓库）。
5. **提交 ≠ 上线**：本批只改前端 → 需重建 `dist` 并确认容器服务新指纹。
6. **未做真机验证**：本批无浏览器验证，交付报告须如实标注。

### C. 与并发 agent 的边界（红线，勿越）

- **不要碰**：`backend/app/services/mvu_engine.py`、`mvu_cleanup.py`、`backend/app/api/character_ext.py`、
  `backend/app/api/websocket.py`、`backend/app/services/character_message_builder.py`、
  `backend/app/services/roleplay_prompt_assembly.py`、`backend/tests/test_mvu_*.py`。
- 本备份的 `worktree-uncommitted.patch` **只是快照，不是回滚指令**；
  若需回滚并发 agent 的成果，**必须先与用户确认**（那是别人未完成的工作）。

### D. 已知环境坑（复核门禁时必读）

`C:\Users\Pall\AppData\Local\Temp\pytest-of-Pall` 堆积 > 50 个目录会触发 Mimosa `safe-delete` 守卫，
表现为**2 个用例误报 F + 无统计摘要行 + exit 1**。解法：`--basetemp=D:/tmp/pt`。
**认门禁只认 `failed = 0`，别被 exit 1 骗。**（2026-10-05 实测踩到一次）
