# BACKUP_INFO — 2026-10-24_三面一致开工前

## ① 备份日期

2026-10-24 01:24（本地）

## ② 原始来源路径

- `D:\项目\Palink-AI`（git 仓库全量历史，含全部分支与标签）→ `repo-pre-threeway-20261024.bundle`（143,228,412 B，`git bundle verify` 通过，完整历史）
- 生产数据库 `ai_hub`（容器 `palink-ai-db-1`，pg15）→ `db-ai_hub-pre-threeway-20261024.sql`（41,544,502 B，`pg_dump` rc=0）
- git 标签：`pre-threeway-st-20261024` → commit `3eb89dd`

## ③ 备份原因

「ST 三面一致对齐」施工批次开工前的基线快照（施工计划：`docs/_active/spec/SPEC_ST三面一致对齐施工计划_2026-10-24.md`）。
后续批次将触及**装配链**（ASM-4 世界书/记忆落位重构、ASM-5 depth 语义 A/B）、**插件 API 写通道**（API-1 secrets、API-3 setChatMessages 落库）、**前端世界书引擎退役**（ASM-3）——均属高风险/不可逆面，需整仓可回滚基线。

**开工前基线读数**（供回归对照）：
- HEAD = `3eb89dd`（工作区干净，`_BACKUPS/` 未跟踪行属预期）
- 门禁三绿（2026-10-24 实测）：后端 2437 passed / 23 skipped / 0 failed / 0 errors（rc=0）；前端 tsc 0 错 + vitest 141 文件 / 1742 passed / 3 skipped / 0 failed（rc=0）；docs 目录 OK
- 部署态：5 容器 healthy；前端 dist 入口 `index-0pSC1Vx8.js` 与 frontend 容器一致；backend 镜像 = P2-20 重建版
- 守卫抽测：`st-gap-ledger-guard`(17) + `h-tavernhelper-134-contract`(47) = 64 passed
- 已知挂账（开工不处理项，防误当回归）：F-3 ST 端点零限流、F-7 chats/get 写库、F-1 世界书面只列未绑定、F-8 shallow 只有 name、F-6 首装配丢记忆、mvu_cleanup 默认 True/20、TestInstruct 12 行

## ④ 后续待办清单（备份之后要做的事）

1. 按 SPEC §6 顺序开工：第一波 VER-1~4 + ASM-3 + API-1/API-2/API-6 + UI-2（均不依赖 DEC 拍板）
2. DEC-1~4 四条裁定待用户拍板（SPEC §0）；ASM-5 / UI-3 必须拍板后才动
3. ASM-4 动装配链前：先跑基线 dump（`.tmp_audit/dump_prompt.py` 流程）留施工前对照，禁直接改码
4. 每批交付后回填差距报告（A-x/D-x/P-x 状态），全部完工后本备份过保鲜期按规范下沉 `_archive`
5. 回滚方式：代码 `git reset --hard pre-threeway-st-20261024`（或从 bundle 克隆：`git clone repo-pre-threeway-20261024.bundle`）；数据库 `psql -U ai_user ai_hub < db-ai_hub-pre-threeway-20261024.sql`（⚠️ 先 drop 再恢复，属破坏性操作需用户确认）
