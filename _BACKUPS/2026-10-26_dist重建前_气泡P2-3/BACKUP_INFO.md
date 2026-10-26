# BACKUP_INFO — 2026-10-26 dist 重建前（P2-3 气泡上线）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`

## ③ 备份原因
上线 P2-3「用户气泡 98% + 短消息自适应」（commit `755e465`）与预设库 ST 等价默认（`05bea50`）前的整份 dist 快照。
改前入口 **`index-CSqzhUI7.js`**，上线后入口 **`index-CeOdXquD.js`**（HTTP 200）。

## ④ 后续待办清单
- [ ] 回滚：`tar -xzf dist_before.tar.gz -C frontend/`。
- [ ] 真机若发现气泡观感不对（短消息过窄 / 长消息溢出），先回滚再定位，不要直接改宽度类。
- [ ] 保留到下一次重建；旧孤儿在 `_QUARANTINE_2026-10-26_dist孤儿chunk_p23/`。
