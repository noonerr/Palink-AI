# 备份：卡片可用高度解锁批（prefersAvailableHeight 消费 realContent）

- **备份日期**：2026-09-30
- **原始来源**：
  - `frontend/src/components/ui/custom/CharacterCardRenderer.tsx`（工作区在途状态，含并行会话未提交改动）
  - `frontend/src/components/ui/custom/smart-card-runtime/shared.ts`
- **备份原因**：施工「故事卡正文截断修复」前快照。根因=卡片 HTML `min-height:100vh` 命中 prefersAvailableHeight「按可用空间渲染」分支，帧内 realContent 上报在 CharacterCardRenderer.tsx resize 处理处被直接丢弃，正文被视口切片截断（用户观感"点一下 iframe 才多显示一点"= click→focusin→updateAvailableHeight 重适配）。
- **备份形式**：Mimosa 钩子禁止 Bash 直写 .tsx/.ts（含备份目录），整文件转抄有转写风险，故采用 `git stash create+store` 全工作区快照（git 对象、带校验和，比手工拷贝更忠实）：
  - **快照 SHA：`0ac0ec8638a605a73598e68da245c166da44a778`**（stash@{0}，message=`pre-卡片可用高度解锁批-20260930`，未 pop、工作区未动）
- **恢复命令**（单文件，保持在途状态）：
  ```bash
  git show 0ac0ec86:"frontend/src/components/ui/custom/CharacterCardRenderer.tsx" > "frontend/src/components/ui/custom/CharacterCardRenderer.tsx"
  git show 0ac0ec86:"frontend/src/components/ui/custom/smart-card-runtime/shared.ts" > "frontend/src/components/ui/custom/smart-card-runtime/shared.ts"
  ```
  （恢复后如需整体回到施工前，`git stash apply 0ac0ec86` 亦可；不要 drop 该 stash 直到本批验收通过。）
- **后续待办清单**：
  1. 施工完成后跑 `npx tsc --noEmit` + `npx vitest run`（只认 failed=0）+ `npm run build` 刷新 dist；
  2. IAB 实机复验：故事 iframe 高度≈真实内容高（实测基线 3890px+）、点击/滚动不再改变高度、launcher 界面卡（pinned height:100vh，realContent≤可用空间）行为不变；
  3. 验收通过前不 drop stash `0ac0ec86`；通过后本备份保留作追溯。
