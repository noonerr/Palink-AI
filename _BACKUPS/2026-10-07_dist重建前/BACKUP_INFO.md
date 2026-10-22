# BACKUP_INFO

- **备份日期**：2026-10-07 03:05
- **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`
- **备份原因**：
  前端构建脚本 `npm run build` 的第一步是 `node scripts/clean-dist.cjs`，会**先清空 dist**
  再重新生成。`frontend/dist` 是 nginx 容器 bind mount 的在用产物，构建一旦中途失败
  就会造成前端白屏。故在重建前留一份可回滚的完整副本。
- **备份内容指纹**：入口 `assets/index-aWXo-K7r.js`（index.html 8476 字节）
- **后续待办清单**：
  1. 前端重建完成后，核对新 dist 的入口指纹；若与 `index-aWXo-K7r.js` 相同，
     说明源码与上次构建无差异，本备份可直接保留至下次清理窗口。
  2. 若重建失败（dist 被清空或不完整），立即用本目录的 `dist/` 覆盖回
     `frontend/dist` 恢复服务，再排查构建失败原因。
  3. 服务恢复确认后，本备份可按 `_BACKUPS/_README.md` 的保鲜期规则归档。

---

## 使用记录（2026-10-07 03:0x 追加，不改动上文）

**本备份已被实际使用，且是必要的。**

`npm run build` 执行时，第一步 `scripts/clean-dist.cjs` 递归删除 dist，
删到第 50 个文件时被沙箱批量删除保护拦截
（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count=50 threshold=50`），
构建中止，**dist 已被删掉 49 个文件**。

处置：`cp -rn _BACKUPS/2026-10-07_dist重建前/dist/. frontend/dist/`
（只补缺失、不覆盖现有），还原后 658 = 658 文件、零缺失，
容器内 `/` 与主入口均复检 HTTP 200。

结论：**前端 dist 未重建**（本来就是最新的，见
`docs/_active/report/REPORT_后端生成期CPU内存占用排查_2026-10-07.md` §7.3）；
本备份保留，供后续如需真正重建时继续使用。
