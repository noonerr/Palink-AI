# BACKUP_INFO

- **备份日期**：2026-10-21（深夜 · 第十一次上线窗口前）
- **原始来源路径**：`D:\项目\Palink-AI\frontend\dist\`（整目录 9110 个文件，未按清单筛选）
- **备份内容**：`dist_before.tar.gz`；快照对应的线上入口 **`index-DfHH7IYY.js`**（即批次小尾巴 ③-B4 上线后的那份）
- **备份原因**：同窗口部署两批改动 ——
  ① `dc76b3a` 批次QR（补 `POST /api/quick-replies/save|delete` + 读侧三档优先），**前后端都改**；
  ② `86b37cb` 批次I18N（搬入 ST 语言资产 `zh-cn.json`/`en.json`/`lang.json` + `ST_LOCALES` 收成 2）。
  `frontend/dist` 是 nginx bind mount 的在用产物（红线目录），覆盖前必须留可整目录还原的快照。
- **后续待办清单**：
  1. 前端回滚：`tar -xzf dist_before.tar.gz -C frontend/`（整目录还原，覆盖当前 dist），
     还原后 `curl -s http://localhost:16000/ | grep -o 'assets/index-[^"]*\.js'` 应回到 `index-DfHH7IYY.js`。
  2. ⚠️ **后端回滚不是这份包能做的**：`dc76b3a` 改了 `backend/app/api/silly_tavern.py` 并已
     `docker compose build backend` 烤进镜像。要退后端只能 `git revert dc76b3a` 再重建镜像，
     本包只覆盖前端产物。判据：`POST /api/quick-replies/save` 无凭据应**非 200**、
     带凭据且缺 `name` 应 400。
  3. i18n 的资产回滚 = 删 `frontend/public/st/locales/` 三个文件 + `ST_LOCALES` 改回 ——
     ⛔ 别顺手删，那会让 `/st/locales/zh-cn.json` 退回 404（那正是 P2-16 的病灶）。
  4. 线上正常后按 `docs/_archive/_README.md` 的月度判据处置；本目录留在备份区不外搬。
  5. `dist/` 孤儿继续累积（9110 → 9236，单次构建 199 文件）。这是刻意的（保住已打开页面的旧指纹），
     真要清需要单独批次 + 确认无长会话在用旧 chunks。
