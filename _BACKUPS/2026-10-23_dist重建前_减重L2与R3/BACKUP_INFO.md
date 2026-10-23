# BACKUP_INFO — 2026-10-23_dist重建前_减重L2与R3

1. **备份日期**：2026-10-23
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 的在用产物）
3. **备份原因**：上线「减重 L2-3/L2-4 + R3 切分支变量（commit `a9d282b`）」前快照。
   - 改前入口：`assets/index-Bn0prgjj.js`（只含分支不变量批次）
   - 全量：9,848 文件 / 625,953,925 B；打包后 274,454,875 B
   - 已包含当时 `assets/` 下 9,724 个文件（含 390 个历代 `index-*.js` 孤儿）
4. **后续待办**：
   - 重建后核对新入口 hash、`index.html` 与 nginx 容器一致性、前端 healthy；
   - 本次将清理 `dist/assets` 中不属于新构建的孤儿 chunk（预计释放数百 MB），
     如上线后出现旧页面懒加载 chunk 404，用本 tar 还原后重新评估；
   - 还原命令：`tar -xzf dist_before.tar.gz -C frontend`（覆盖前先停流量/确认）。
