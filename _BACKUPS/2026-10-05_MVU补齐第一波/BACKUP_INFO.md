# BACKUP_INFO — 2026-10-05 MVU 补齐第一波

## ① 备份日期

2026-10-05（当日 02:4x，GMT+8）

## ② 原始来源路径

| 备份内相对路径 | 原始来源 |
|---|---|
| `pre/backend/app/api/silly_tavern.py` | `backend/app/api/silly_tavern.py` |
| `pre/frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 同名原路径 |
| `pre/frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` | 同名原路径 |
| `pre/frontend/src/components/ui/custom/smart-card-runtime/inline/inline-st-globals.ts` | 同名原路径 |

校验清单：`_manifest.tsv`（sha256，4 条）。

## ③ 备份原因

本批要改这 4 个文件，属**变量读写链路**，改错会直接表现为「变量读回旧值」或
「卡脚本事件收不到」，且这两类故障**静态读码看不出来**（正是
`docs/SOP_Agent交付自查清单.md` §6 强调的那类）。开工前按 AGENTS.md §备份与清理规范
做改动类备份（`pre/` 按原相对路径 + `_manifest.tsv`）。

三项任务：
- **P1** 卡脚本 MVU 事件名对齐（`mag_` 前缀）+ 补齐缺失事件
- **P0-1** 修读优先级倒挂（`silly_tavern.py:1337`，`ChatVariable` 行反向遮蔽 `chat_metadata`）
- **P0-2 门 B** `POST /api/chats/save` 整包覆写门

## ④ 后续待办清单

1. **P1**：3 处事件常量 + 5 处 emit 改成契约值；补 `mag_variable_initiailized` 与
   `mag_before_message_update`；`mag_command_parsed` **留空并登记**（用户 2026-10-05 裁定：
   补丁 ≠ 命令、时序已晚，emit 出来是假活）。
2. **P0-1**：整包键（`variables` / `variables.stat_data`）以 `chat_metadata` 为准，
   `ChatVariable` 行只补缺失键。配反证用例。
3. **P0-2 门 B**：payload 无 `chat_metadata` 条目时**不碰** metadata。配反证用例。
4. **门禁**：`npx tsc --noEmit` / `npx vitest run` / `py -3 -m pytest tests/ -q`，只认 `failed = 0`。
5. **改了前端 → 必须重建 dist**（禁 `npm run build`，走 `VITE_OUT_DIR=dist_new_*` → 原地覆盖 → gzip）。
6. **第二波待办**（本批不做，卡在并行清理 agent 的未提交改动上）：
   P0-2 门 A（`character_ext.py:2708`）、P2 变量编辑面板、P3-a 世界书过滤。
7. **P3-e 已裁定**：与 ST 保持一致，**不改** `mvu_cleanup.py:46-49`（插件 bundle 实测默认
   `启用=true / 保留 20 / 快照间隔 50 / 恢复触发 10`，与我们现状一致）。
   但需盯住一条不变量：保留 20 < 回看窗口 30，删除/回退场景**必须靠**
   `mvu_cleanup.run_restore_for_session` 兜底，否则会滑进已清理区找不到快照。
