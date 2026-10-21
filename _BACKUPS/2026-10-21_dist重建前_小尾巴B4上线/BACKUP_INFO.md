# BACKUP_INFO

- **备份日期**：2026-10-21（夜 · 第十次上线窗口前）
- **原始来源路径**：`D:\项目\Palink-AI\frontend\dist\`（整目录 8988 个文件，未做清单筛选）
- **备份内容**：`dist_before.tar.gz`（239 MB）；快照对应的线上入口 **`index-B1gYRfbW.js`**（即批次WU 上线后的那份产物）
- **备份原因**：部署"小尾巴批次 ③-B4"（提交 `9826457`：插件沙箱读写同域回退 +
  `scripts/gen-bundled-plugin-css.mjs` 生成器）。纯前端改动 ⇒ 只重建 `dist`，不重建后端镜像。
  `frontend/dist` 是 nginx bind mount 的在用产物，属红线目录，覆盖前必须留可整目录还原的快照。
- **后续待办清单**：
  1. 本份快照是"**WU 已上线、B4 未上线**"的唯一回滚点。若 B4 需要回退而不想连带回退 WU，
     **不要整目录还原**，改为只把入口 chunk 换回：`dist/assets/index-B1gYRfbW.js` 在本包内有原件。
  2. 线上正常后可按 `docs/_archive/_README.md` 的月度判据处置；本目录留在备份区不外搬。
  3. ⚠️ `dist/` 孤儿继续累积（8988 → 9110，单次构建 196 文件）。累积是刻意的：
     让已打开的页面还能取到旧指纹。真要清需要单独批次 + 确认无长会话在用旧 chunks，别顺手 `rm`。
  4. 本次上线的实测判据在 `docs/_active/report/REPORT_批次小尾巴_CSS生成器与沙箱读写同域_2026-10-21.md` §2.5
     （`presetSelectErr` 11 → 0）。**快捷回复集保存仍失败**（P2-15，后端缺 `/api/quick-replies/save`），
     与本包无关，需另批。
