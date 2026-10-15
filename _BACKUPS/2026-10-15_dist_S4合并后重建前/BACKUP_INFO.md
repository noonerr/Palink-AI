# BACKUP_INFO — frontend/dist 重建前整份备份

- **① 备份日期**：2026-10-15 14:20（GMT+8）
- **② 原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount，容器在用的线上产物）
- **③ 备份原因**：
  三轨并一轨 S4 阶段三支（be-extras / sandbox-dep / s4-split）已合入主干（HEAD `e0751ca`），
  需要把 `frontend/dist` 从旧代码 `355e0ce` 重建到主干最新代码。按仓库规范
  （`palink-ai-repo-ops` §3：「重建 dist 前必须先整份备份 `frontend/dist`」），
  在重建前做整份拷贝，保证重建中途失败可**秒级回滚**。
  - 备份时点的产物对应代码：`355e0ce`（= S3 收尾，未含 S4 拆分 / 沙箱轨解耦 / Extras 转发）
  - 备份时点文件数：**4408 个**，体积 **271M**
  - `index.html` SHA-256（前 16 位）：`38d667ba8c70ac27`（与源目录逐字节一致，已核对）
- **④ 后续待办清单**：
  1. 重建成功且站点验证通过后，本备份可**降级为隔离/清理候选**（走 `_QUARANTINE_<日期>`，禁止直删）。
  2. 若重建后站点异常：用 `cp -r <本目录>/dist/. D:\项目\Palink-AI\frontend\dist/` 整份回滚
     （**注意**：不要先删 dist，直接覆盖即可；dist 是 bind mount，删除会导致 nginx 500）。
  3. ⚠️ 本备份是**构建产物**，可由源码重建；真正不可再生的东西在 git 里，不在本目录。

> 说明：`_BACKUPS/**` 已在 `.gitignore` 中（仅放行 `_INDEX.md` 与各 `BACKUP_INFO.md`），
> 故本目录的 `dist/` 副本不入库，属预期行为。
