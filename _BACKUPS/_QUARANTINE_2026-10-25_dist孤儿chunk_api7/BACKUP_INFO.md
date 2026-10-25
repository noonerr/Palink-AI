# QUARANTINE — 2026-10-25 dist 孤儿 chunk（API-7 第 1 批上线）

- **隔离日期**：2026-10-25
- **来源**：`frontend/dist/assets`（上一版 `index-paiblS5D.js` 的 141 个文件）
- **原因**：上线 API-7 第一批后旧 chunk 不再引用；只隔离不删除。
- **回滚**：整包用 `_BACKUPS/2026-10-25_dist重建前_API7-1_VER2/dist_before.tar.gz`；
  单文件 `mv` 回 `frontend/dist/assets/`。
