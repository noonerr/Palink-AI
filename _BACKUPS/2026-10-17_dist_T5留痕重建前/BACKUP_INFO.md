# BACKUP_INFO — frontend/dist 重建前备份（T5 留痕入线前）

- **① 备份日期**：2026-10-17 11:19（GMT+8）
- **② 原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount，容器在用的线上产物）
- **③ 备份原因**：
  T5 口径 A（`setChatMessages` 落库缺口改会话级留痕 + `deleteChatMessages` 补留痕，提交 `6d720fd`）
  需要进线上产物，故重建 `frontend/dist`。按仓库规范（`palink-ai-repo-ops` §3：「重建 dist 前必须先整份备份」）
  做整份拷贝，保证重建中途失败可秒级回滚。
  - 备份时点的产物对应代码：`6ac54dc` 之前 —— 含并行 agent 的
    `4956789`（单间轨假实现显性化 + 卡内 triggerSlash 补桥 + MVU 世界书根因修复）
    与 `d6d61b2`（T2/T3 真机复验）的重建结果，**不含**本次 T5 留痕改动
  - 备份时点文件数：**5024 个**，体积 **309M**
  - `index.html` SHA-256（前 16 位）：`d3902fcd2fe453e9`（与源目录逐字节一致，已核对）
  - 站点入口 chunk：`assets/index-Cu3r614_.js`（宿主端口 **16000**，该产物已实际服务过）
- **④ 后续待办清单**：
  1. 重建成功且验证通过后，本备份可降级为隔离/清理候选（走 `_QUARANTINE_<日期>`，禁止直删）。
  2. 回滚方式：`cp -r <本目录>/dist/. D:\项目\Palink-AI\frontend\dist/`
     （**直接覆盖，不要先删 dist** —— 它是 nginx bind mount，删即 500）。
  3. ⚠️ 本备份是**构建产物**，可由源码重建；不可再生的东西在 git 里，不在本目录。
  4. ⚠️ `frontend/dist` 采用**纯增量合并**（`cp -r` 只增不删）⇒ 目录内会**堆积历史 chunk**。
     用 grep 找"新代码指纹"时务必确认命中的是当前 `index.html` 引用的那个 chunk。

> 说明：`_BACKUPS/**` 已在 `.gitignore` 中（仅放行 `_INDEX.md` 与各 `BACKUP_INFO.md`），
> 故本目录的 `dist/` 副本不入库，属预期行为。
