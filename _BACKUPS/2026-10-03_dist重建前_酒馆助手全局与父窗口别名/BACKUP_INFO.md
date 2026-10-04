# BACKUP_INFO

| 项 | 内容 |
|---|---|
| **① 备份日期** | 2026-10-03 |
| **② 原始来源路径** | `D:\项目\Palink-AI\frontend\dist\` **整目录全量拷贝**（280 文件 / 14M，0 字节文件 0 个，入口 `assets/index-BrocModw.js`） |
| **③ 备份原因** | 「酒馆助手 API 适配」批次重建前端产物前的回滚点。`frontend/dist` 是容器 nginx 的 bind mount 在用产物，且**不入 git**（`git ls-files` = 0）→ git 不是回滚路径，必须物理备份。 |

## ④ 后续待办清单

1. **本次备份的还原方式**：`cp -r <本目录>/dist/. "D:/项目/Palink-AI/frontend/dist/"`，
   然后 `cd frontend && node scripts/gzip-dist.cjs`，再 `docker compose exec frontend nginx -s reload`。
   ⚠️ **不要**用 `npm run build` 还原 —— 它的 `clean-dist.cjs` 会先清空在用 dist。
2. **产物指纹对照**：备份时在用入口 = `index-BrocModw.js`；本轮最终上线入口 = `index-4-8sIwLv.js`
   （中间还经过 `index-BsrhZEHM.js` / `index-CJ2QOdUL.js` / `index-CHP66WFw.js` 三次迭代）。
   回滚后容器入口应回到 `index-BrocModw.js`。
3. **备份不含 nginx.conf**：本批 `frontend/nginx.conf` 也改了（新增 `location ^~ /live2d/` 的 CORS 头），
   它的回滚副本在**另一个**备份目录 `_BACKUPS/2026-10-03_酒馆助手脚本全局与父窗口别名/pre/frontend/nginx.conf`。
   两处要一起回滚，否则「旧产物 + 新 nginx」或反之会出现不一致。
4. **dist 内可能残留旧 hash 的 chunk**：本轮采用「原地 `cp -r` 覆盖」而非清空重建，
   故旧入口 `index-BrocModw.js` 及其独占 chunk 仍在目录里（无害，`index.html` 只引用新入口）。
   若要彻底清理属独立议题，**须走隔离区三步流程**，不得直接删。

---

> ⚠️ **补记（2026-10-04 01:05）**：本说明书与 `_BACKUPS/_INDEX.md` 的登记行是**事后补做**的。
> 原批次创建本目录时**漏了这两步**，违反《备份与清理规范》第 2、3 条（无说明文件 = 无效备份；未登记台账 = 不可追溯）。
> 补做原因与经过见交接文件 `HANDOFF_酒馆助手API适配_2026-10-04.md` 的「§8 自查与补救」。
