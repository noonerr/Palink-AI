# BACKUP_INFO · MS-2 变量视点修复上线前 dist 整份归档

## ① 备份日期

2026-10-22 03:0x（本地时间）

## ② 原始来源

- 来源路径：`D:\项目\Palink-AI\frontend\dist`（容器 nginx bind mount 的在用产物）
- 归档件：`dist_before.tar.gz`，**257,312,662 B / 9247 条目**，`tar -tzf` 校验可读
- 改前入口指纹：`assets/index-B1yoTHTv.js`（第十一次上线 QR+I18N 那份）

## ③ 备份原因

批次 **MS-2**（变量「带视点」取值 + 逐楼补回）要覆盖 `frontend/dist` 上线。
本仓红线：`frontend/dist` 是 nginx bind mount 的在用产物，覆盖前必须整份归档，且**只增不删**
（保留历史 chunk 是为了已打开的页面不白屏）。

本次上线的改动清单（前端侧）：
- `src/components/ui/custom/cardVariables.ts` 新增第三参 `isViewpoint`：视点楼保持"会话级实时值优先"
  （保住 `card-variables-live-preference.test.ts` 钉的事件触发语义），历史楼层一律取该楼自己的值，
  取不到 ⇒ 空 + `mvu_state_unavailable`，**不再退回会话级**。
- `src/components/ui/custom/Message.tsx:1700` 传 `isLast`。
- 新增用例 `__tests__/card-variables-viewpoint.test.ts`（5 例）。
- 构建产物判据：新入口 `assets/index-D3_xHSm8.js`；字面量 `mvu_state_unavailable` 在产物中命中 1 个文件；
  单次构建 199 个文件。

## ④ 后续待办清单

1. 覆盖后必须 `node scripts/gzip-dist.cjs` 并 `curl http://localhost:16000/` 复读入口指纹。
2. 后端同批改了 `app/api/character_ext.py` / `app/services/mvu_state.py`（新文件）/
   `app/services/roleplay_prompt_assembly.py` ⇒ 必须 `docker compose build backend && up -d backend`，
   并容器内 grep 字面量 `MVU-AS-OF` 才算上线。
3. 上线判据（与改前基线对照，基线读数存 `frontend/../.tmp_probe/msgs_before.json` 与 `msgs_old_before.json`）：
   ① 更早一页 id 2696 / 2698 由「无 stat_data」变为「各有值且 `src=replay`」；
   ② 页面级那份孤立值 `6f162e20` 不再下发；
   ③ 最新一页 5 个楼层值哈希不变（`3eb6c186 / 9243a498 / 45e39ddc / 687625dc / ba455665`）。
4. 回退方式：`tar -xzf dist_before.tar.gz -C frontend/ --strip-components=0`（还原整个 dist）后
   直接生效（bind mount），无需重建镜像；后端回退走 `git revert` + 重建镜像。
5. 待清理（不在本批）：`frontend/dist_ms2` 构建草稿目录（199 文件）与既有 16 个 `dist_*` 目录，
   按"列清单 → 隔离 → 门禁 + 用户确认 → 删"三步走，禁止直删。
