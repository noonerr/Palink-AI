# QUARANTINE — 2026-10-23 dist 孤儿 chunk（第 3 轮）

- **隔离日期**：2026-10-23
- **来源**：`D:\项目\Palink-AI\frontend\dist\assets`（上一版 `index-De2OhDRe.js` 的 141 个哈希文件）
- **原因**：上线 P2-20 后旧 chunk 不再被新 `index.html` 引用；同前两轮，只隔离不删除。
- **回滚**：优先用 `_BACKUPS/2026-10-23_dist重建前_P2-20/dist_before.tar.gz`；
  单文件可 `mv` 回 `frontend/dist/assets/`。
- **删除条件**：与前两轮同批，保鲜期后统一处理。
