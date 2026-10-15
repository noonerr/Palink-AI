# BACKUP_INFO — 2026-10-15_dist_S5删大堂重建前

1. **备份日期**：2026-10-15
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 的在线产物）
3. **备份原因**：S5「删大堂」批次改了 `frontend/src`（删 `utils/sillyTavernPluginRuntime.ts` 整文件 +
   `CharacterChat.tsx` / `CharacterView.tsx` 触点清理 + `legacy-st-sim-parts/part-b.ts` 死兜底删除），
   按 `palink-ai-repo-ops` §3 强制要求「重建 dist 前必须先整份备份 `frontend/dist`」。
   备份保证重建中途失败可秒级回滚。
4. **后续待办清单**：
   - 重建走 `VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/`（纯增量合并，只增不删）
     → `node scripts/gzip-dist.cjs`，**禁用 `npm run build` / `mv` 重命名**。
   - 重建成功且真机三步核验（入口 chunk 200 + 含 S5 新指纹）通过后，本备份降级为隔离/清理候选
     （走 `_BACKUPS/_QUARANTINE_<日期>`，禁直删）。
   - 回滚方式：`cp -r <本目录>/dist/. frontend/dist/`（**不要先删 dist** —— 它是 bind mount，删即 500）。

## 内容

- `dist/` —— 整份拷贝（`frontend/dist` 全部内容，含历史堆积 chunk）。
- 备份时 `index.html` sha256 前 16 位：见 `_BACKUPS/_INDEX.md` 对应行（与源目录逐字节一致，拷贝后已校验）。

⚠️ 本目录备份的是**构建产物**，可由源码重建，非唯一真源。
