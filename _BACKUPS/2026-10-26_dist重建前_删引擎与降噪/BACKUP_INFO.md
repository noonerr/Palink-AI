# BACKUP_INFO — 2026-10-26 dist 重建前（删世界书引擎 + style_removal 降噪）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`

## ③ 备份原因
上线 `be997e7`（删前端第二套世界书引擎，净 −1230 行）与 `52c1e32`（style_removal 取证降噪）前的整份 dist 快照。
改前入口 **`index-CeOdXquD.js`**，上线后入口 **`index-Bp_vFYvA.js`**（HTTP 200）。

## ④ 后续待办清单
- [ ] 真机若发现卡样式真的丢了（历史判据：`tavern-cg-album-style` / `galgame-ui-plugin-styles` 缺身份），
      先回滚 `tar -xzf dist_before.tar.gz -C frontend/`，再按 `REPORT_style_removal机制研究_2026-10-21.md` 定位。
- [ ] 降噪的取证账在管理页「CompatStubStatsCard」与 `window.__palinkStyleRemovalAgg` 可查；
      需要逐条刷屏时打开开发者模式（`palinkDiagExplicitlyEnabled`）或 `window.__palinkStyleRemovalVerbose`。
- [ ] 保留到下一次重建。
