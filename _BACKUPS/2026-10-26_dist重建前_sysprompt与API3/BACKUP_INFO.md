# BACKUP_INFO — 2026-10-26 dist 重建前（sysprompt P0 + API-3）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`frontend/dist/`

## ③ 备份原因
上线 `47c576a`（sysprompt 接入原生装配 P0）与 `86abaec`（API-3 setChatMessages 真落库）前的整份 dist 快照。
改前入口 **`index-Bp_vFYvA.js`**，上线后 **`index-9I-6eW7T.js`**。同批后端已重建镜像并手动应用 alembic 0072。

## ④ 后续待办清单
- [ ] 回滚：`tar -xzf dist_before.tar.gz -C frontend/`（只回前端；后端回滚走 `git revert 47c576a 86abaec` + 重建镜像）。
- [ ] sysprompt 出问题先关开关（`power_user.sysprompt.enabled=false`）而不是回滚代码——默认关即逐字节零回归。
- [ ] 保留到下一次重建。
