# BACKUP_INFO — 2026-10-06 dist 重建前快照（卡消息 id 回退修复批次）

## ① 备份日期

2026-10-06（约 19:47，重建前）

## ② 原始来源路径

`D:\项目\Palink-AI\frontend\dist` —— 容器 nginx bind mount 的**在用**前端产物。
备份时在用入口：`assets/index-BuZgZuhl.js`（`dist/index.html` mtime 2026-10-06 12:09）。
共 783 个文件，逐文件 `sha256` 见同目录 `SHA256SUMS.txt`。

## ③ 备份原因

修复「卡状态栏恒报 `无法加载状态数据 (messages empty)`」需要重建 dist。
根因（实测，非推理）：帧内注入两份 `getChatMessages`，先注入的 `legacy-st-sim.ts` 只按
**数组下标**取值、落空直接 `return []`；而 Palink 的 `ctx.messageId` 是**数据库行 id**
（实测该会话那条消息 id=2740，会话内只有 2 条消息），卡脚本惯用写法
`getChatMessages(getCurrentMessageId())[0].message` 必然落空。
2026-09-30 的同源修复只落在 `SillyTavernCompatRuntime.getCompatChatMessages`，
而 compatV2 的桥接是 `typeof window.getChatMessages === 'function' ? 用它 : 自己那份`，
legacy 已占用 `window.getChatMessages` ⇒ **compatV2 那份修复在帧内是死代码**。

`frontend/dist` 被 `.gitignore` 排除（`git ls-files frontend/dist` = 0 条）⇒ **git 不是回滚路径**，
回滚只能靠本快照。

## ④ 后续待办清单

1. **本次待上线改动**：`frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts`
   的 `getChatMessages` 补「下标落空 → 按 id/message_id 回退」，与 compatV2 对齐；
   新增守卫测试 `smart-card-runtime/__tests__/frame-getchatmessages-id-lookup.test.ts`（6 例，含反证）。
2. **⚠️ 本次重建会一并带入并行会话的在途改动**（同一工作树，无法只挑一批）：
   `Message.tsx` / `useCharacterChat.ts` / `stream-engine/index.ts` / `ThinkingProcess.tsx`
   —— 即台账 [`2026-10-06_流式渲染与思考框四修复`](./2026-10-06_流式渲染与思考框四修复)
   那一批（历史滚动回看丢样式 / 流式侧边栏卡顿 / 思考内容重复 / 思考框折叠）。
   该批自己的记录就写明「重建 dist 前必须先比对」，**上线后需按那批的判据一并回归**。
3. **仍未修的同类缺口**（本批刻意不动，避免扩大影响面）：
   - `InlineCardRenderer.tsx` 注册宿主能力时**没有注册 `getChatMessages`**
     （`inline-st-globals.ts` 的 `callInlineHost('getChatMessages', …, [])` 缺省即空数组）
     ⇒ 内联 flag 一旦开启，同一症状会复现。
   - 两份 `getChatMessages` 长期看应合并为一份实现，否则还会再分叉。
4. **验证方式**：产物只能 grep 字符串字面量——本批标记为注释文本
   `下标落空时回退按 id 匹配`（整段 shim 是模板字符串，minify 不动它），
   旧 dist 命中 0，新 dist 命中于入口 chunk。
5. **回滚**：`cp -r _BACKUPS/2026-10-06_dist重建前_卡消息id回退/dist/. frontend/dist/`
   后 `docker compose restart frontend`（**不要 mv 整个目录**，会让 bind mount 失效）。
