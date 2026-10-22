# dist 重建前备份（记忆修复 + MVU 批次上线）

## 1. 备份日期

2026-10-05

## 2. 原始来源路径

`D:\项目\Palink-AI\frontend\dist`（**90 MB**，容器 `palink-ai-frontend-1` 的 nginx
bind mount 在用产物，compose 里 `- ./frontend/dist:/usr/share/nginx/html:ro`）。

- `dist/` = 重建前的整份产物
- `dist-entry-before.txt` = 重建前入口指纹 `index-DtKE6gc3.js`

## 3. 备份原因

项目铁律「提交 ≠ 上线」。本次要把**两个 agent 的前端改动一起上线**：

- 本批（我）：`CharacterChat.tsx` 的 swipe 候选切换 in-flight 去重（`[MEM-MIRROR]`）
- 并行 MVU 批次：变量面板 `VariableChangePanel.tsx` / `cardVariables.ts` /
  `mvuSecondaryFeedback.ts` 等 5 个新增前端文件 + `Message.tsx` 改动

重建入口脚本 `scripts/build-vite.mjs` 走 `VITE_OUT_DIR` 输出到临时目录，**不直接删线上**；
但最终仍需 `rm -rf dist && mv` 原地覆盖，且旧产物若回滚需要原件，故先整份备份。
（`clean-dist.cjs` 的先删后建若中途失败即站点白屏 —— 这是 AGENTS.md 记录的高风险点。）

⚠️ 重建前 dist 有 **1527** 个文件（历次构建累积残留，同一文案散在 11 个 chunk）；
重建后 **196** 个（已合并清理）。这本身也说明旧产物长期未清理。

## 4. 后续待办清单

1. ✅ 已完成：门禁 —— `vitest run` **60 文件 / 781 passed / 3 skipped / 0 failed**；
   `tsc --noEmit` exit 0；后端 `pytest tests/` **1911 passed / 0 failed**。
2. ✅ 已完成：构建到 `dist_new_memfix` → 校验（入口引用文件真实存在、文件数 196）
   → 原地覆盖 → `gzip-dist.cjs`（生成 85 个 .gz，省 6450 KB）。
3. ✅ 已完成：`docker compose restart frontend` → healthy；
   线上 `curl http://127.0.0.1:14000/` 返回新指纹 `index-OVaxcVhT.js`，
   容器内 `/usr/share/nginx/html/index.html` 同一指纹（bind mount 内外一致）。
4. ✅ 已完成：验产物（**用字符串字面量，禁用标识符**）：
   - 「切换候选回复失败」（本批 in-flight 去重所在处）→ `CharacterView-fH3UGc4e.js` 命中
   - 「副 AI 变量更新」（MVU 批次）→ `SettingsView-8ZsMW3-z.js` 命中
   - ⚠️ 踩坑记录：先 grep 标识符 `swipeInFlightRef` 全为 0 —— 构建会压缩重命名标识符，
     **验产物只能 grep 字符串字面量**（AGENTS.md 同款教训，第 N 次复现）。
   - ⚠️ 另注：「副 AI 变量更新」在 SettingsView（设置页），不在 CharacterView（聊天页），
     跨 chunk grep 命中 0 属正常，勿误判为「没构建进去」。
5. ⏳ 用户侧：浏览器可能缓存旧 chunk，**F5 硬刷新**（必要时 Ctrl+Shift+R）。
6. ⏳ 回滚路径（未执行，备用）：`rm -rf frontend/dist && cp -r <本目录>/dist frontend/dist`
   + `docker compose restart frontend`（入口会回到 `index-DtKE6gc3.js`）。