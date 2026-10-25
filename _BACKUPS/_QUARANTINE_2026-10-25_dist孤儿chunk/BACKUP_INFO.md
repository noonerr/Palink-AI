# QUARANTINE — 2026-10-25 dist 孤儿 chunk

- **隔离日期**：2026-10-25
- **来源**：`D:\项目\Palink-AI\frontend\dist\assets`
- **内容**：**688 个**旧构建哈希文件（近几轮重建残留）。
- **原因**：2026-10-24~25 的多次重建只覆盖新文件、未清旧 chunk；dist 从 17MB 涨到 57MB / 778 文件。
  本次用同一 HEAD 的干净构建（入口 `index-paiblS5D.js`，确定性构建结果一致）做基准，
  只保留当前构建的 90 个 assets 文件；dist 回到 **17MB / 288 文件**。
- **回滚**：单文件 `mv` 回 `frontend/dist/assets/`；整包回滚用对应日期的 `dist_before.tar.gz`。
- **删除条件**：与其他几轮孤儿同批，保鲜期后统一处理。
