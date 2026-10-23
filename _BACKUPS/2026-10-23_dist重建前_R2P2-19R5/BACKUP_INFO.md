# BACKUP_INFO — 2026-10-23_dist重建前_R2P2-19R5

1. **备份日期**：2026-10-23
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
3. **备份原因**：上线「R2 / P2-19 / R5」（commit `5ccd75e` + `fab610b`）前快照。
   - 改前入口：`assets/index-hNul52Df.js`（上一版 `a9d282b`）
   - 打包后 7,269,168 B（上一轮已把 dist 从 617MB 清到 17MB，本次为精简后整包）
4. **后续待办**：
   - 上线后核对新入口 `assets/index-De2OhDRe.js`、`index.html` 与容器一致、前端 healthy；
   - 本次只替换 90 个 assets 文件，上一版 142 个旧 chunk 已隔离到
     `_BACKUPS/_QUARANTINE_2026-10-23_dist孤儿chunk_round2/`；
   - 回滚：`tar -xzf dist_before.tar.gz -C frontend`（覆盖前先确认）。
