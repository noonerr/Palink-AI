# BACKUP_INFO — 2026-10-21 dist 重建前（批次 SG 上线）

## ① 备份日期
2026-10-21（傍晚，第七次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（nginx bind mount 的在用产物）

## ③ 备份原因
部署 `0d310fb`（批次SG：补 ST 全局 `SillyTavern = { libs, getContext }`）。纯前端，零后端改动。

| 项 | 值 |
|---|---|
| 文件数（`tar -tzf`） | **8622** |
| 改前线上入口 | **`index-BiIprpTC.js`** |
| 上线后入口 | **`index-y1h404Oz.js`**（8691 文件，gzip 3772） |

## ④ 后续待办清单
1. 复验判据：启用真实插件 Kimi Thinking Prefill → 控制台不得再出现 `SillyTavern is not defined`；
   错误种类应从 11 降到 6 左右；卡片帧 `pluginCss=5 nonEmpty=5 th=153 ctx=196` 不回退。
2. 回滚：`tar -xzf dist_before.tar.gz -C frontend/` + `docker compose restart frontend`。
3. 测完把 Kimi 插件**重新禁用**（全局插件会影响所有用户）。
