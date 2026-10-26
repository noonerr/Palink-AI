# BACKUP_INFO — 2026-10-26 dist 重建前（安全顺手批）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`

## ③ 备份原因
上线 `4a2330d`（帧侧 sessionId 顶包两处收口 + postMessage 被扩展包装丢弃的防御留痕）前的整份 dist 快照。
改前入口 **`index-9I-6eW7T.js`**，上线后 **`index-BuDVIE1n.js`**（HTTP 200）。纯前端，未重建后端镜像。

## ④ 后续待办清单
- [ ] 回滚：`tar -xzf dist_before.tar.gz -C frontend/`。
- [ ] 若卡通道出现"整条静默无响应"，先看 `palinkDiag` 是否有 wrap/顶包留痕，再决定回滚。
- [ ] 保留到下一次重建。
