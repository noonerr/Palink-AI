# BACKUP_INFO — 2026-10-26 dist 重建前（预设库 UI + P2-26 上线）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`

## ③ 备份原因
上线「预设模板库前端面板 + 酒馆助手 isPreset*/getProxyPresetNames + P2-26 预热」前的整份 dist 快照。
改前入口 **`index-B81qxQFs.js`**（AP7-2 收口版）；上线后入口 **`index-CSqzhUI7.js`**，HTTP 200。

## ④ 后续待办清单
- [ ] 本快照用于本轮 UI 上线回滚：`tar -xzf dist_before.tar.gz -C frontend/`（会覆盖 dist）。
- [ ] 若只需回退前端而保留后端 P2-26，可用本快照；后端回退见 `2026-10-26_dist_AP7-2上线后`。
- [ ] 保鲜期后可清理旧 dist 备份链；本份保留到下一次重建。
