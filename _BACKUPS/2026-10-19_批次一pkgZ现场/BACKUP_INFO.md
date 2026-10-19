# 批次一 pkg-Z 在途现场（2026-10-19）

## ① 备份日期

2026-10-19 23:32。

## ② 原始来源路径与逐文件归属

工作区 `D:\项目\Palink-AI`，主脑自派的子 agent **pkg-Z**（任务书
`docs/_active/HANDOFF_提示词_紧要批次甲类第一批与三项小收尾_2026-10-19.md` §1）**被主动停止时**的在途改动：

| 备份内文件 | 原相对路径 | 归属 / 状态 |
|---|---|---|
| `pkgZ-uncommitted.patch` | `git diff -- palink-diag.ts __tests__/palink-diag-recorder.test.ts` | pkg-Z 的 **Z-3**，**已由主脑实测并提交**（`410f08e`）；本 patch 只作对照 |
| `runtime-hold/palink-diag.ts`、`__tests__/palink-diag-recorder.test.ts` | `frontend/src/components/ui/custom/smart-card-runtime/` 下同名两份 | Z-3 的中断态全文（停止时内容＝已提交内容 `410f08e`） |
| `untracked/frontend/src/lib/slash-engine/__tests__/st-compat-commands-listvar-scope.test.ts` | 同路径 | pkg-Z 的 **Z-1 半成品**（5860 字节，测试先行、实现未落）。已从工作区**移出**（原件在此），避免外部 Agent 看到"红测试但没有实现" |

⚠️ 同期工作树里 `.workbuddy-ai/**` 属另一会话，与本包无关，未纳入本备份也不许动。

## ③ 备份原因

用户把同一份任务书**直接转交给另一个 Agent 执行**，于是同一个共享工作区里出现**两个写者**：
主脑的 pkg-Z 与外部 Agent 都按 §1 改 `palink-diag.ts` / `part-07.ts` / `lib/slash-engine/**`。
主脑的处理顺序是：**先停自己**（保外部 Agent 为单写者）→ 把已验完的部分**提交掉**（不留无人认领的未提交改动，
否则会被对方的 `git add` 一并带走，这是本仓反复踩过的夹带事故）→ 半成品测试**移出工作区**并在此固化。

## ④ 后续待办清单

- [x] Z-3 由主脑独立复验：`tsc --noEmit` rc=0、`smart-card-runtime/__tests__` 41 文件 604 passed / 1 skipped / failed=0、
      目标文件 16/16 ⇒ 提交 `410f08e`。
- [ ] **Z-1（`listvar` 的 `scope`）谁做都行，但必须整项做完**：现在工作区没有那份红测试；
      若外部 Agent 已自行写过，按任务书 §0 六项交验（含"没有全局变量真通道就停手如实写"）。
- [ ] **Z-2（alias 存在性）**：⚠️ 别照"把别名下发进 commands"去做——ST 里别名本来不在那张表里，
      下发了反而偏离 ST；要做的是同名在场物核对（任务书 §1-Z-2 已写明）。
- [ ] 若将来要从本备份取回 Z-1 那份测试：**逐文件拷回**，
      禁止 `git apply -R` 整包回退（`palink-diag.ts` 后来还有 `410f08e` 的提交，整包回退会抹掉已上线内容）。
- [ ] 主脑侧待办：外部 Agent 每笔提交后逐笔复跑门禁与边界比对；上线（重建 dist）只由主脑做。
