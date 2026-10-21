# BACKUP_INFO — 2026-10-21 dist 重建前（批次 R1 上线）

## ① 备份日期
2026-10-21（傍晚，第五次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（docker-compose 里 nginx bind mount 的在用产物）

## ③ 备份原因
部署 `328c993` + `e0be1f5`（批次R1：插件读类 5 键 + 启停走 ST 斜杠命令 + `isAdmin` 真值；
后端 `runtime/config` 下发 `owner_scope`，`PUT /{id}/toggle` 作用域收紧）。

改前实测指纹：

| 项 | 值 |
|---|---|
| 文件数（`tar -tzf` 实测） | **8374** |
| 线上入口 | **`index-DRKXsT-Z.js`** |
| 归档 | `dist_before.tar.gz` |

## ④ 后续待办清单
1. `VITE_OUT_DIR=dist_r1 node scripts/build-vite.mjs` → 校验 → `cp -r dist_r1/. dist/`（只增不删）
   → `node scripts/gzip-dist.cjs`。
2. 后端：`docker compose build backend && up -d backend`（`plugins.py` 改了）。
3. 复跑：
   - `.tmp_probe/R1_extension_probe.js` —— 判据：7 帧 `read5=5`、`isAdmin=true`（admin 账号）、
     `asstId=JS-Slash-Runner`、`typeRegex=global`、`installed=true`、`statusThenable=true`、
     `th` 从 148 涨到 **153**、`ctx=196` 不变；
   - `.tmp_probe/PQ_live_after.js` / `PQ_after_regression.js` —— 零回归。
4. ⚠️ **启停不要在实机上拿全局插件做实验**（会影响所有用户）。要验就建一个**自己的私有插件**再 toggle。
5. 回滚：`tar -xzf dist_before.tar.gz -C frontend/` + `docker compose restart frontend`（勿先删 dist）。
