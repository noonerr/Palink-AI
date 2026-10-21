# BACKUP_INFO — 2026-10-21 dist 重建前（批次 S 上线）

## ① 备份日期
2026-10-21（下午，第四次上线窗口）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`（docker-compose 里 nginx bind mount 的在用产物）

## ③ 备份原因
部署 `2bec0f1`（批次S：帧侧会话顶包收口）—— 这是**安全/契约**改动，不是新功能：

- 删掉 dispatcher 里 `sessionId: context.sessionId || payload.__palinkContext?.sessionId` 的合并
  （`SmartCardCompatController.ts` 约 :2054），`requestContext = context`；
- 新增唯一解析 `resolveSmartCardHostSessionId`（只认宿主构造的 `selectedSession.id`，`__pending__` 视为无会话），
  在 4 个调用点统一使用；
- 逐动作清点 32 个分支，**7 个分支 / 11 个 action 名**用到会话（世界书创建族 4、两个 rebind、
  `renameChat`、`generateRaw`/`generateQuietPrompt`、预设读 2）——改前这些都能被帧顶包到
  "同用户另一份会话"。

改前实测指纹：

| 项 | 值 |
|---|---|
| 文件数（`tar -tzf` 实测） | **8252** |
| 线上入口 | **`index-C3babRVI.js`** |
| 归档 | `dist_before.tar.gz` |

## ④ 后续待办清单
1. `VITE_OUT_DIR=dist_s node scripts/build-vite.mjs` → 校验 → `cp -r dist_s/. dist/`（只增不删）
   → `node scripts/gzip-dist.cjs`。**本批零后端改动，不重建镜像。**
2. 复跑：`.tmp_probe/PQ_live_after.js`（7 帧 / `th=148` / `preset3=3` / `pn=n=3` / `gp` 四键 / `ctx=196`）
   与 `.tmp_probe/PQ_after_regression.js`（每帧 `styles=25 nonEmpty=25`）。
3. ⚠️ **本批的收口无法在实机上"用一张恶意卡"复验**：要证伪需要卡在宿主无会话时伪造
   `__palinkContext.sessionId` 并触发 `generateRaw`（会真的调模型 ⇒ 花钱，禁止）。
   ⇒ 判据只认单测 18 例 + 代码审查；实机只验**零回归**。不要写"实机验证了安全性"。
4. 异常回滚：`tar -xzf dist_before.tar.gz -C frontend/` + `docker compose restart frontend`
   （⚠️ 勿先删 dist，nginx bind mount）。
