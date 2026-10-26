# BACKUP_INFO — 2026-10-26 dist 上线后快照（AP7-2 收口）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`（nginx bind mount 在用产物）

## ③ 备份原因
上线 commit `6286340`（API-7 第二批 + API-8b + 事件枚举单源 + 帧内设置子键同步 + TH 预设写键）后的整份 dist 快照。
**上线后入口 `index-B81qxQFs.js`**，HTTP 200，五容器 healthy。
⚠️ 如实说明：本次覆盖前**没有**给旧 dist 打整包 tar；旧入口 `index-D3gvEoM1.js` 的孤儿文件已隔离在
`_BACKUPS/_QUARANTINE_2026-10-26_dist孤儿chunk/`，但旧 `index.html` 已被覆盖。
要回到旧版本请用源码重建：`git checkout 6779308` → 按上线流程重建；不要试图只拷回 index.html。

## ④ 后续待办清单
- [ ] 本快照用于本轮上线后的回滚：`tar -xzf dist_after.tar.gz -C frontend/`（会覆盖 dist）。
- [ ] 下一轮重建前，先给当时的 `frontend/dist` 打 `dist_before.tar.gz`，避免再次出现“旧 index.html 未留”的缺口。
- [ ] 保鲜期后可清理旧 dist 备份链；本份保留到下一次重建。
