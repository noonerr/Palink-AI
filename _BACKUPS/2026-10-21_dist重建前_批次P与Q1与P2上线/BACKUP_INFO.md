# BACKUP_INFO — 2026-10-21 dist 重建前（批次 P / Q1 / P2 上线）

## ① 备份日期
2026-10-21（01:38 落盘）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（docker-compose 里 nginx bind mount 的**在用产物**）

## ③ 备份原因
本批要把三批**已提交但未上线**的代码部署到实机：

- `9407273` 包P（后端）：会话级预设覆盖层（写时复制，零迁移）
- `7f225c8` 批次Q1（前端 + 运行时模板串）：本机/内网默认放开"卡片读主页面"、`retrieveDisplayedMessage` 落地、`host-origin-policy.ts` 新增
- `e3e06c1` 批次P2（前后端）：预设读类三键、内部键外泄守卫、全局选中名（零迁移）
- `fa768a5` 主脑复核（前端）：预设面堵住"帧可替宿主决定会话"的顶包通道

`frontend/dist` 是 bind mount 的在用产物，**删除或改名即前端白屏**（AGENTS.md §备份与清理规范 第 6 条红线），
所以上线前先整目录归档，出问题可整包还原到用户当时正在用的那一版。

改前实测指纹（用于确认"这份备份真的是线上那一版"）：

| 项 | 值 |
|---|---|
| 文件数（不含目录） | **7878** |
| `dist/index.html` md5 | `2774958113626996dbdbd18e59750d6b` |
| 目录体积 | 491 MB |
| 归档内文件数（`tar -tzf` 实测） | **7878**（与目录逐项一致） |

## ④ 后续待办清单
1. 新产物构建：`VITE_OUT_DIR=dist_pq node scripts/build-vite.mjs`（**禁用 `npm run build`**，它会先 clean `./dist`）。
2. 校验新目录：文件数、入口指纹、`index.html` 引用的 chunk 是否都在新目录里。
3. **原地覆盖**：`cp -r dist_pq/. dist/`（不删 `dist` 本体，保 bind mount）→ `node scripts/gzip-dist.cjs`。
4. 后端：`docker compose build backend && docker compose up -d backend`（包P/P2 都是后端改动）。
5. 实机复跑同一份探针 `.tmp_probe/PQ_live_parity.js`，与改前基线对照：
   改前实测 `HOST_POLICY=ABSENT`、7 帧、`SANDBOX_WITH_SAME_ORIGIN=0`、`th=144`、
   `retrieve=false`、`preset3=false/false/false`、`ctx=196`、`so=false`。
6. 若实机异常 ⇒ **回退方式**：`tar -xzf dist_before.tar.gz -C frontend/`（还原后会生成 `dist/`，
   与现目录同名同层，还原后需 `docker compose restart frontend` 让 nginx 重新读文件）。
7. 上线成功且过保鲜期后，本目录与 `dist_pq` 一起按 `docs/_archive/_README.md` 判据处理；
   **不要**顺手删除，等主脑裁定。
