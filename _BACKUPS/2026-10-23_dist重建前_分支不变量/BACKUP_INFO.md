# BACKUP_INFO · 分支不变量修复 上线前 dist 归档

## ① 备份日期

2026-10-23 16:4x（本地时间）

## ② 原始来源

- `D:\项目\Palink-AI\frontend\dist`
- `dist_before.tar.gz`：**271,085,654 B**，改前入口 `assets/index-BF-FlhTz.js`

## ③ 备份原因

上线"分支不变量"两个修复（上一轮 agent 半成品已退回并留档，本轮回炉重做）：
1. **读路径不再写库**：`silly_tavern._active_branch()` 改为纯读；`POST /api/chats/save` 的 commit
   不再可能把"悄悄切换的活动分支"落盘；分支行只在"该会话零分支"时由显式 `ensure_branch()` 创建。
2. **兜底规则统一到一个出口**：新增 `services/branch_resolution.py`——
   有 `is_active` 用它；否则取**含最新消息**的那条（`created_at DESC NULLS LAST, id DESC`）；
   再否则最新创建；都没有则 None。`GET /branches` 新增 `active_branch_id` / `active_branch_source`
   并加确定性排序；`/messages` 与 `/branch-tree` 同样下发；`delete_branch` 返回 `activated_branch_id`
   且再激活有确定顺序；`st_sync_service` 也改走同一规则（不再自带一套）。

## ④ 后续待办清单

1. 上线判据（已实测）：入口 `assets/index-Bn0prgjj.js`；后端镜像重建 healthy；
   容器内 `/app/app/services/branch_resolution.py` 在场（8712 B）；
   接口 `/branches` 返回 `active_branch_id=30251f44…`、`active_branch_source=flagged_active`。
   门禁：135 文件 / 1707 通过 / 3 skipped，五段 ✓，退出 0。
2. ⚠️ 真机**视觉**复核未完成：后端重建后浏览器会话失效、页面落到 `/login`，
   需重新登录后确认"进角色页默认显示 91 条消息那条分支 + 7 个卡片窗口逐层值不变"。
3. 回退：`tar -xzf dist_before.tar.gz -C frontend/` 还原前端；后端 `git revert` + 重建镜像。
4. 仍未做：`same_level`（同级分支语义待老板定）、"消息可写进非活动分支"（同前）、
   切分支接口的逐楼变量补值、`delete_branch_preview` 仍自带一处 `is_active` 只读查找。
5. 待清理：`frontend/dist_ms2` / `dist_ms3` / `dist_ms4` / `dist_trust` / `dist_branch` 草稿目录。
