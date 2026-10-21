# BACKUP_INFO — 2026-10-21 dist 重建前（批次 E2b + UI1 上线）

## ① 备份日期
2026-10-21（下午，第三次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（docker-compose 里 nginx bind mount 的在用产物）

## ③ 备份原因
把两批**已入库未上线**的改动部署到实机：

- `1c28e87` 批次E2b（前端）：`regex` 预置改数组（修 E2 引入的回归）、
  `macros/macro-system` 接真注册表、`debugger.css` 改为**构建期生成字符串模块 + 注入时内联**。
- `c72bb23` 批次UI1（前后端）：作者注四项控件、全局破甲控件、预设"选中哪份"接线 + 本对话副本只读展示、
  删除 `show_character_status` 假开关。后端改了 `schemas/user.py` 与 `api/users.py` ⇒ **需要重建后端镜像**。

改前实测指纹：

| 项 | 值 |
|---|---|
| 文件数（不含目录，`tar -tzf` 实测） | **8126** |
| 线上入口 | **`index-BtqaaMD6.js`** |
| 归档 | `dist_before.tar.gz` |

## ④ 后续待办清单
1. 前端：`VITE_OUT_DIR=dist_e2bui1 node scripts/build-vite.mjs` → 校验 → `cp -r dist_e2bui1/. dist/`（只增不删）
   → `node scripts/gzip-dist.cjs`。
2. 后端：`docker compose build backend && up -d backend`。
3. 复跑四份探针：
   - `.tmp_probe/errtriage_full.js` —— 判据：`CNT_B10_debugger_css_mime=0`、
     `getScriptsByType(...).forEach` 消失、`macros.register` 消失；
   - `.tmp_probe/PQ_live_after.js` —— 判据：7 帧、`th=148`、`pn=n=3`、`gp` 四键、`store=shim`、`ctx=196`；
   - `.tmp_probe/PQ_after_regression.js` —— 判据：每帧 `styles=25 nonEmpty=25 withId=7`；
   - `.tmp_probe/UI1_settings_probe.js` —— 判据：提示词页六个 testid 全在、"角色状态"文案消失、
     角色扮演引擎页有 `preset-global-selection-summary`。
4. 异常回滚：`tar -xzf dist_before.tar.gz -C frontend/` 后 `docker compose restart frontend`
   （⚠️ **勿先删 dist**，nginx bind mount）。
5. 上线成功后，本目录与 `dist_pq`/`dist_p3e2`/`dist_e2bui1` 等旁路目录统一等主脑裁定再隔离。
