# BACKUP_INFO — 2026-10-21 dist 重建前（批次 MC 上线）

## ① 备份日期
2026-10-21（傍晚，第八次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（nginx bind mount 的在用产物）

## ③ 备份原因
部署 `c1eb693`（批次MC：插件沙箱 `makeRequire` 改为"插件本地相对文件优先、越出插件根的路径仍走 ST shim"，
并让本地模块 exports 容器身份稳定以兜住循环依赖）。纯前端。

| 项 | 值 |
|---|---|
| 文件数（`tar -tzf`） | **8744** |
| 改前线上入口 | **`index-y1h404Oz.js`** |
| 上线后入口 | **`index-CikMaYdG.js`**（8813 文件、gzip 3825） |

## ④ 后续待办清单
1. 复验判据：启用真实插件 Smart Memory → `registerSmartMemoryMacros is not a function` 不得再出现；
   帧 `pluginCss=5 nonEmpty=5 th=153 ctx=196` 不回退。测完**再次禁用**插件。
2. 已知"下一跳"（不属于本批）：插件要连 `localhost:11434` 被沙箱拦；`extension_settings.memory` 缺子键。
   见 `docs/OPEN_ISSUES.md` [P2-14]。
3. 回滚：`tar -xzf dist_before.tar.gz -C frontend/` + `docker compose restart frontend`。
