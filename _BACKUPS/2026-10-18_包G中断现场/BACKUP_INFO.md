# BACKUP_INFO — 2026-10-18_包G中断现场

## ① 备份日期
2026-10-18（约 21:00，Git Bash 实测时间）。

## ② 原始来源路径
仓库 `D:\项目\Palink-AI`，分支 `three-tracks-merge-20261012`，备份时点 **HEAD = `0988a7d`**
（包F F-1 提交）。备份的是**当时工作区里未提交的前端在途改动**，共两部分：

- `tracked-frontend-wip.patch` —— `git diff -- frontend/src frontend/types`，983 行，覆盖 8 个已跟踪文件：
  `CharacterCardRenderer.tsx`、`Message.tsx`、`SillyTavernCompatRuntime.ts`、
  `__tests__/st-compat-fix-batch-contract.test.ts`、`runtime-body/part-08.ts`（**+485/−31，主体**）、
  `views/character/CharacterChat.tsx`、`lib/slash-engine/st-compat-commands.ts`、`types/index.ts`。
- `untracked/…` —— 保持原相对路径拷出的 6 个未入库新文件（两个包各自的契约测试 + 三份 fixture + 生成脚本）。

## ③ 备份原因
执行**包G**（getContext 15 项 + `SillyTavern.libs` 25 键）的子 agent 在 150 轮上限处**被强制中断**，
中断瞬间它正在写 `g-getcontext-and-libs-contract.test.ts`（最后一句输出是 "Now the new contract test for 包G:"），
**没跑完门禁、没提交、没写交付报告**。同时 **包F** 的第二个执行 agent 仍在并行改
`lib/slash-engine/st-compat-commands.ts` 与 `lib/sillytavern/__tests__/fixtures/`。

⇒ 这批改动是**两个 agent 混在同一工作区的现场**，接手 agent 需要在他人 WIP 之上继续施工，
且 `part-*.ts` 是注入 iframe 的模板字符串（`tsc` 不检查其内部），一旦改坏没有 git 历史可回退。
按《备份与清理规范》第 1、2 条先做物理备份再动，避免"接手者把上一轮的 485 行改坏且无从复原"。

**归属划分（重要，别把别人的成果当自己的回退掉）**：

| 文件 | 归属 | 状态 |
|---|---|---|
| `part-08.ts`（+485）、`CharacterCardRenderer.tsx`、`Message.tsx`、`CharacterChat.tsx`、`types/index.ts`、`SillyTavernCompatRuntime.ts`、`__tests__/fixtures/st-libs-25.json`、`gen-st-libs-fixture.cjs`、`g-getcontext-and-libs-contract.test.ts` | **包G** | 未验证、未提交 |
| `__tests__/st-compat-fix-batch-contract.test.ts` | 包G 改的（原属包B） | 未验证、未提交 ⚠️ 与包F 同文件风险 |
| `lib/slash-engine/st-compat-commands.ts`、`lib/sillytavern/__tests__/fixtures/*`、`slash-engine/__tests__/st-compat-commands-f2-contract.test.ts` | **包F**（仍在跑） | 在途，禁止回退 |

## ④ 后续待办清单
1. 派接手 agent 把包G 做完：跑 `npx tsc --noEmit` + `npx vitest run` 拿红绿基线 → 补完
   `g-getcontext-and-libs-contract.test.ts` → 真机探针（真问题项 ≤2、libs 25/25、srcdoc 单帧 ≤50,000）→
   反证 3 项 → 写 `docs/_active/report/REPORT_包G_getContext与libs_2026-10-18.md` → 按 pathspec 提交。
   规格见 `docs/_active/HANDOFF_提示词_包G_getContext与libs补齐_2026-10-18.md`。
2. **接手前必须等包F 提交完成**，否则 `vitest` 全量结果里混着别人的半截代码，红绿无法归因。
3. 接手 agent 若判定要回退部分 `part-08.ts` 改动，**先从本目录 `tracked-frontend-wip.patch` 对照**，
   不要凭记忆删。回滚整批 = `git apply -R tracked-frontend-wip.patch`（会把包F 的 `st-compat-commands.ts` 一起回退，
   ⚠️ 禁用；要单独回退 `part-08.ts` 用 `git checkout -- <该文件>`）。
4. 包G 已在 `Message.tsx` 落了一处 **props/ctx 透传**（`selectedModel`，非包I 的 CSS 去重）。
   ⇒ 派包I 时必须告知它 `Message.tsx:1007-1031` 的行号与上下文已被包G 改动推歪，用锚点重新定位。
5. 本批改动进主干后（提交即算），本备份降级为隔离/清理候选（走 `_QUARANTINE_<日期>`，禁直删）。
