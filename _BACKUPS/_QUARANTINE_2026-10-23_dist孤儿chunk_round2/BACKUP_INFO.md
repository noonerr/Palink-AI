# QUARANTINE — 2026-10-23 dist 孤儿 chunk（第 2 轮）

- **隔离日期**：2026-10-23
- **来源**：`D:\项目\Palink-AI\frontend\dist\assets`（上一版 `index-hNul52Df.js` 的 142 个哈希文件）
- **原因**：上线 `5ccd75e` + `fab610b` 后，旧构建的 chunk 不再被新 `index.html` 引用；
  与第 1 轮 9,704 个孤儿相同的清理规则（只隔离、不删除）。
- **回滚**：
  1. 单文件：`mv _BACKUPS/_QUARANTINE_2026-10-23_dist孤儿chunk_round2/assets/<file> frontend/dist/assets/`
  2. 整包：用 `_BACKUPS/2026-10-23_dist重建前_R2P2-19R5/dist_before.tar.gz`
     （`tar -xzf dist_before.tar.gz -C frontend`）。
- **删除条件**：与第 1 轮同批，观察一个保鲜期（建议 7 天）后统一处理。
