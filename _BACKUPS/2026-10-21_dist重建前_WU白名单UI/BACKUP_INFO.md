# BACKUP_INFO

- **备份日期**：2026-10-21（夜 · 批次WU 上线前）
- **原始来源路径**：`D:\项目\Palink-AI\frontend\dist\`（整目录，含 8866 个文件）
- **备份内容**：`frontend_dist.tar.gz`（236 MB，打包时 dist 的完整快照，未做文件清单筛选）
- **备份原因**：批次WU（插件网络白名单设置页，提交 `f76f061`）需重建前端产物并原地覆盖 `dist/`。
  覆盖流程是"只增不删"，但仍要先留一份可整目录还原的快照 —— 这是本仓上线纪律的固定第一步
  （`frontend/dist` 是 nginx bind mount 的在用产物，删或改名即前端白屏，属红线目录）。
- **快照对应的线上入口**：`assets/index-CikMaYdG.js`（备份后新构建的入口是 `index-B1gYRfbW.js`）
- **后续待办清单**：
  1. 新产物异常时：`tar -xzf frontend_dist.tar.gz -C frontend/`（会整目录还原，覆盖当前 dist），
     还原后 `curl -s http://localhost:16000/ | grep -o 'assets/index-[^"]*\.js'` 应回到 `index-CikMaYdG.js`。
  2. 确认线上正常后可保留至下一个月度归档判定（按 `docs/_archive/_README.md` 判据，本目录属备份区不外搬）。
  3. ⚠️ `dist/` 的孤儿 chunks 仍在累积（本次 8866 → 8988，单次构建只产 196 个文件）。
     累积是为了让**已打开的页面**继续能取到旧 chunks（不白屏）；真要清需要单独一个批次，
     且必须先确认没有长会话在用旧指纹 —— 别顺手 `rm`。
