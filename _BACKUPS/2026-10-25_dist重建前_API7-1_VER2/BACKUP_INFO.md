# BACKUP_INFO — 2026-10-25_dist重建前_API7-1_VER2

1. **备份日期**：2026-10-25
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
3. **备份原因**：上线「API-7 第一批 15 条命令 + VER-2 探针/报告」前快照。
   - 改前入口：`assets/index-paiblS5D.js`
   - 打包后 7,302,696 B
4. **后续待办**：
   - 上线后入口 `assets/index-D3gvEoM1.js`；旧 141 个 chunk 隔离在
     `_BACKUPS/_QUARANTINE_2026-10-25_dist孤儿chunk_api7/`；
   - 回滚：`tar -xzf dist_before.tar.gz -C frontend`。
