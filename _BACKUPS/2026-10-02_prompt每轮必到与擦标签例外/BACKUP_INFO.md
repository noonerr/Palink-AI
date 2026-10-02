# BACKUP_INFO — 2026-10-02 prompt每轮必到与擦标签例外

## ① 备份日期

2026-10-02（施工开始前）

## ② 原始来源路径

本备份为 **git stash 快照**（非文件拷贝——Mimosa hook 拦截 Bash 向 _BACKUPS 拷贝源码文件，
改用既有合规姿势 `git stash create + store`，不动工作区）：

- stash commit：`7eb3dd0771d06c2e0caad4f1d864b0e40033af46`（短 `7eb3dd0`）
- tag：`pre-prompt-every-turn-20261002`
- 内容：当时全部已跟踪文件的工作区状态（含并行会话未提交改动）
- 恢复方式：`git stash apply stash@{0}`（找到对应 message）或 `git checkout pre-prompt-every-turn-20261002 -- <path>`

涉及施工的文件（改动前状态可从该 stash 取回）：

- backend/app/services/character_message_builder.py（P2 白名单清洗）
- backend/app/services/roleplay_prompt_assembly.py（⑤ 单层改写 + 证据摘要）
- backend/app/services/stream_builder.py（StreamResult 槽位）
- backend/app/models/extension_prompt.py（source_key 列）
- backend/app/api/extension_prompts.py（persist 端点）
- backend/app/api/websocket.py、backend/app/api/character_ext.py（extra 证据落库）
- backend/app/core/migrations.py（compat 列登记）
- frontend/src/components/ui/custom/CharacterCardRenderer.tsx（上报中继）
- frontend/src/hooks/useCharacterChat.ts（console.warn 缺席检测）

## ③ 备份原因

按 docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md 施工（用户 2026-10-02 拍板主方案：
格式规范持久化到 extension_prompts 表 + 每轮装配无条件带上；P2 历史清洗白名单化放行变量块；
⑤ 单层改写只挂降级路径）。动工前按 AGENTS.md 备份规范留存回滚点。

## ④ 后续待办清单（备份之后需要修复或修改的任务）

1. 施工完成后跑门禁：`cd frontend && npx tsc --noEmit` 0 错 + `npx vitest run` failed=0 +
   后端 pytest 全量。
2. 提交一律逐项 pathspec，禁止 `git add -A`/`git add .`。
3. 克隆会话实测（同 char id）：extra.ext_prompts 每轮有值（0 条也显式写）、
   重生成输出成对 `<now_plot>…</now_plot>`、输出喂卡正则断言命中 ≥1。
4. 实测产生的克隆会话数据需用户授权后清理。
5. 验收线第 3 条双向断言（开场白回喂：变量块在、外壳净）由 pytest 单测固化。
