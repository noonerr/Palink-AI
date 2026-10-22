# BACKUP_INFO

- **备份日期**：2026-10-05
- **原始来源路径**：无原件备份。本目录是一次性实验脚本，不是代码备份。
- **备份原因**：调查 iOS 主屏 WebApp「从对话页返回时卡在旧对话、卡几下才回上一层」的问题；用户无实机，需要在真实浏览器里复现机制。项目规范要求实验产物不得散落，故归置于此。
- **内容**：`probe.mjs` / `ghost-history-repro.html` —— 空白页最小复现，**不含任何角色卡或对话数据**。
- **实测结论**（2026-10-05，Chrome，真实浏览器）：
  1. 同一个 srcdoc iframe 连续重建 12 次，`history.length` **恒为 2，一动不动**；连续 `history.back()` 10 次只产生 **1 次真实 pop**，幽灵条目数 = **0**。
  2. 结论：**「iframe 重建产生幽灵历史条目」这个机制在 Chromium 上不成立**，
     仓库里 `useGhostHistoryProbe.ts` 与 `CharacterCardRenderer.tsx:1666-1689`
     的注释所描述的问题，在本次实测中无法复现（该现象属 WebKit/Safari 特有，Chromium 无此行为）。
- **后续待办**：
  1. 真机（Safari/iOS）复核 `useGhostHistoryProbe` 的 `[GHOST-HISTORY]` 计数，
     确认 Chromium 的否证能否外推到 WebKit —— 不能外推则机制一仍成立。
  2. 若否证成立，改查顶层栈：是否 `/characters/:id` 被重复 push（`CharacterView.tsx:917`
     与 `:1263` 是两处 `navigate`，均带同 URL 防护，但需真机确认防护是否生效）。
  3. 「卡到上一次对话」的机制（`CharacterView.tsx:1255-1258` 无条件载入
     `loadedSessions[0]`）尚未取得实测证据，仅有代码结构层面的可行性。
