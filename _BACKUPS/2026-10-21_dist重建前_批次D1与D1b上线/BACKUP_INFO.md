# BACKUP_INFO — 2026-10-21 dist 重建前（批次 D1 + D1b 上线）

## ① 备份日期
2026-10-21（傍晚，第六次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（docker-compose 里 nginx bind mount 的在用产物）

## ③ 备份原因
部署 `4517900`（D1：`power_user` 83 键 + `extension_settings` 21 个命名空间）与
`6fb5610`（D1b：`power_user` 扩到运行时 **133** 键）。两批都改了前端（沙箱命名空间名单）与后端（默认值模块），
所以要**重建前端产物 + 重建后端镜像**。

改前实测指纹：

| 项 | 值 |
|---|---|
| 文件数（`tar -tzf` 实测） | **8498** |
| 线上入口 | **`index-BqDE9YGM.js`** |
| 归档 | `dist_before.tar.gz` |

## ④ 后续待办清单
1. `VITE_OUT_DIR=dist_d1 node scripts/build-vite.mjs` → `cp -r dist_d1/. dist/` → `node scripts/gzip-dist.cjs`。
   （本目录建立时这三步已完成：新入口 **`index-BiIprpTC.js`**、8568 个文件、gzip 3719。）
2. `docker compose build backend && up -d backend`（容器启动约 1 分钟才 healthy，期间 `/api/token` 会 502，属正常）。
3. 复验：`POST /api/settings/get` → 解析 `settings` 字符串 → `power_user` 应含 ST 的 133 键
   （实测 134 = 133 + 历史键 `persona_show_user`）、`extension_settings` 含 21 个默认命名空间。
4. 回滚：`tar -xzf dist_before.tar.gz -C frontend/` + `docker compose restart frontend`（勿先删 dist）。
