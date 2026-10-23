# BACKUP_INFO — 2026-10-23_dist重建前_P2-20

1. **备份日期**：2026-10-23
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
3. **备份原因**：上线「P2-20 插件 chatMetadata 稳定引用」前快照。
   - 改前入口：`assets/index-De2OhDRe.js`
   - 打包后 7,268,203 B
4. **后续待办**：
   - 上线后核对新入口 `assets/index-0pSC1Vx8.js`、容器一致、前端 healthy；
   - 旧 141 个 chunk 已隔离到 `_BACKUPS/_QUARANTINE_2026-10-23_dist孤儿chunk_round3/`；
   - 回滚：`tar -xzf dist_before.tar.gz -C frontend`。
