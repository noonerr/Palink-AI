# BACKUP_INFO — 2026-10-26 API-7 第三批 中断现场

## ① 备份日期
2026-10-26（约 16:2x）

## ② 原始来源路径
主工作区 `D:/项目/Palink-AI` 的未提交改动，仅这两个文件：
- `frontend/src/lib/slash-engine/st-compat-commands-chat.ts`（+990 / −8）
- `frontend/src/lib/slash-engine/bootstrap.ts`（+4 / −1）

现场留档：`api7_batch3.patch`（1057 行）+ `files/` 下两份**改后全文** + `_manifest.tsv`（sha256）。

## ③ 备份原因
执行 API-7 第三批（目标"真实现 93→≈180，每批 15–25 条"）的子 agent **撞到子代理 150 轮上限**，
停在"写完实现、还没写 batch3 契约测试"这一步（`__tests__/` 里没有 `st-compat-commands-chat-api7-batch3.test.ts`）。
`npx tsc --noEmit` 当时 rc=0，但**没有任何一条新命令有测试覆盖**，且新增命令会动
`f-package-slash-enum-contract` / `st-command-catalog-contract` 两类台账守卫。
按本仓「中断现场四形态」规程：**留半成品 → 备份现场 + 逐文件标归属 + 派收尾者**，
⛔ **不整包 `git apply -R`**（这里只回退本批负责的 2 个文件，安全批 5 个文件保留）。
回退原因不是"代码坏了"，而是**不能把无测试的热路径命令并进主干**（同批还牵着枚举台账口径）。

## ④ 后续待清单（收尾者照做）
- [ ] 取回：`git apply "_BACKUPS/2026-10-26_API7批3中断现场/api7_batch3.patch"`（主工作区 HEAD 需 ≥ `86abaec`，
      且 `slash-engine/` 两文件未被他人改动；先 `git status --short frontend/src/lib/slash-engine` 确认为空）。
- [ ] 先核对 `files/` 里两份全文的 sha256 与 `_manifest.tsv` 一致，再决定"续写"还是"重做"。
- [ ] **必须补 `st-compat-commands-chat-api7-batch3.test.ts`**：仿 `st-compat-commands-chat-api7-batch2.test.ts` 形状，
      每条新命令 ≥1 条断言；实现不了的按红线如实留痕 + 返回 ST 缺席形状，**不许恒真假成功**。
- [ ] 逐条回查 ST 一手依据 `_reference/sillytavern-1.18.0/public/scripts/slash-commands.js:行号`
      ——patch 里若有命令拿不出行号，删掉那条，不要留在树上。
- [ ] 跑 `npx tsc --noEmit` + `st-command-catalog-contract` / `f-package-slash-enum-contract` / 三个 api7 用例；
      **台账必须分开写两个数**：枚举命中数 vs 真实现数（`covered_in` 已饱和，不能当覆盖率证据）。
- [ ] 排期红线：UI 类命令与 ST 私有数据模型类**不做**；agent 报告里若列了跳过清单，收尾时复核。
