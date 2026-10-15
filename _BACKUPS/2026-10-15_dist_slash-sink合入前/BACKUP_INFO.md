# BACKUP_INFO — frontend/dist 第二次重建前备份（slash-sink 合入前）

- **① 备份日期**：2026-10-15 14:37（GMT+8）
- **② 原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount，容器在用的线上产物）
- **③ 备份原因**：
  第一轮重建（14:22，见 `_BACKUPS/2026-10-15_dist_S4合并后重建前/`）之后，`slash-sink` 分支
  （大堂专有命令下沉 + L1 补齐）合入主干，`frontend/dist` 需要**再重建一次**。
  本轮重建前 Docker 已启动、**站点处于上线状态**（5 容器 healthy，`curl :14700/` = 200），
  故按仓库规范再做整份备份，保证重建中途失败可秒级回滚。
  - 备份时点的产物对应代码：`e0751ca`（= 三支合并后状态，未含 slash-sink）
  - 备份时点文件数：**4532 个**，体积 **278M**
  - `index.html` SHA-256（前 16 位）：`73038fd11661ac37`（与源目录逐字节一致，已核对）
  - 站点入口 chunk：`assets/index-wR3sSihs.js`（该产物**已实际上线并 HTTP 200 服务过**）
- **④ 后续待办清单**：
  1. 重建成功且站点验证通过后，本备份可降级为隔离/清理候选（走 `_QUARANTINE_<日期>`，禁止直删）。
  2. 回滚方式：`cp -r <本目录>/dist/. D:\项目\Palink-AI\frontend\dist/`
     （**直接覆盖，不要先删 dist** —— 它是 nginx bind mount，删即 500）。
  3. ⚠️ 本备份是**构建产物**，可由源码（`e0751ca`）重建；不可再生的东西在 git 里，不在本目录。
  4. ⚠️ 注意 `frontend/dist` 采用**纯增量合并**（`cp -r` 只增不删），因此目录内会**堆积历史 chunk**。
     用 grep 在 dist 里找"新代码指纹"时，务必确认命中的是**当前 `index.html` 引用的那个 chunk**，
     否则可能命中残留的旧块而误判（本轮实测踩到：`slash:profile-list` 在大堂轨旧实现里就有）。

> 说明：`_BACKUPS/**` 已在 `.gitignore` 中（仅放行 `_INDEX.md` 与各 `BACKUP_INFO.md`），
> 故本目录的 `dist/` 副本不入库，属预期行为。
