# BACKUP_INFO — 2026-10-06 流式渲染与思考框四修复

- **备份日期**：2026-10-06 下午（四问题修复动工前）
- **原始来源**：整工作树快照（git stash create，未动工作区）
  - stash commit：`b2015b35dbe29cf4e6975a70feb28272db6f154b`
  - 基线 HEAD：`8128b9a`（fix(smart-card): SillyTavern 桥接落点修正 + 缺口改回 undefined）
- **备份原因**：动工修复四个问题前留快照，涉及文件：
  1. `frontend/src/components/ui/custom/Message.tsx`（P1 休眠门唤醒重绘 + P2 流式免消毒）
  2. `frontend/src/hooks/useCharacterChat.ts`（P3 model_reasoning 双重累加 ×3 处 + P2 流式节流）
  3. `frontend/src/lib/stream-engine/index.ts`（P3 model_reasoning 双重累加 ×1 处）
  4. `frontend/src/components/ui/custom/ThinkingProcess.tsx`（P4 默认折叠/计时/结束自动折叠）
- **后续待办清单**：
  1. 四处修复完成并通过门禁（tsc + vitest failed=0）后提交（逐项 pathspec，禁 git add -A）；
  2. 部署需评估并行会话在途改动（CharacterChat.tsx / index.css / card-script-runner.ts 等有未提交改动，重建 dist 会一并烤入）；
  3. 若需回滚：`git stash list` 找 `pre-四修复备份_2026-10-06_流式渲染与思考框`，`git stash show -p b2015b35` 对比或 `git checkout b2015b35 -- <path>` 单文件还原；
  4. P1（休眠门唤醒重绘）为浏览器级缺陷的对症修复，真机（尤其 iOS Safari）验收后如仍有症状，需另开「隐藏态加载 iframe」专项取证。
