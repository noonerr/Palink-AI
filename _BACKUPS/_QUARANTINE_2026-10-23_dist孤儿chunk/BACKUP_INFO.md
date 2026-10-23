# QUARANTINE — 2026-10-23 dist 孤儿 chunk

- **隔离日期**：2026-10-23
- **来源**：`D:\项目\Palink-AI\frontend\dist\assets`
- **内容**：**9,704 个**旧构建的哈希 chunk（含历代 390 个 `index-*.js`），不属于 `dist_new_20261023` 产物。
- **原因**：历次 dist 重建只覆盖新文件、从未清理旧哈希；`dist/assets` 累积到 9,724 个文件 / 约 612MB，
  整包 617MB。本次上线（commit `a9d282b`）后只保留当前构建的 90 个 assets 文件，dist 降到 17MB。
- **回滚**：
  1. 单文件：`mv _BACKUPS/_QUARANTINE_2026-10-23_dist孤儿chunk/assets/<file> frontend/dist/assets/`
  2. 整包：优先用 `_BACKUPS/2026-10-23_dist重建前_减重L2与R3/dist_before.tar.gz`
     （`tar -xzf dist_before.tar.gz -C frontend`）。
- **删除条件**：上线后观察一个保鲜期（建议 7 天），确认没有旧页面依赖这些 chunk 再删。
