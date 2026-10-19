# 包W 中断现场备份（2026-10-19）

## ① 备份日期

2026-10-19（18:20–18:25 落盘）。

## ② 原始来源路径

工作区 `D:\项目\Palink-AI`，包W 子 agent 被 `Maximum turns reached (150)` 中断时**未提交**的那部分改动：

| 备份内文件 | 原相对路径 | 归属 |
|---|---|---|
| `w-uncommitted-delta.patch` | `git diff -- runtime-body/part-01.ts runtime-body/part-08.ts`（中断时刻） | 包W |
| `runtime-body/part-01.ts` | `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts` | 包W（中断态全文） |
| `runtime-body/part-08.ts` | `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-08.ts` | 包W（中断态全文） |
| `__tests__/palink-diag-silent-point-guards.test.ts` | `frontend/src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-silent-point-guards.test.ts` | 包W（第 ③ 笔守卫，当时**从未跑过**） |
| `scratch/tmp_pkgW_msg1.txt`、`scratch/tmp_pkgW_msg2.txt` | 仓库根 `.tmp_pkgW_msg*.txt` | 包W 临时草稿（非产出物） |
| `scratch/frontend_tmp_wire_catches.mjs` | `frontend/.tmp_wire_catches.mjs` | 包W 临时脚本 |
| `scratch/frontend_w_probe_main.js`、`scratch/w_probe_main.js` | `frontend/w_probe_main.js` | 包W 探针入口 |

并行在场的其它包（Q/T/U/V）均已各自提交，**本次中断现场里没有任何别人的 WIP**；
`.workbuddy-ai/memory/*` 的改动属 WorkBuddy 会话，与本包无关，未纳入本备份，也未提交。

## ③ 备份原因

包W 的两处代码改动是**为修上一条真机踩到的取证缺陷**而写的，但作者没跑过任何门禁就断了：

1. `part-01`：栈位置解析取了首行「Error: 消息」而不是「at … :81:1」⇒ rejection 轨的 `filename` 恒空。
2. `part-08`：帧内 `window.error` 记录把语法类错误也归 `frame_compat`，与包V 裁决（`about:srcdoc:81:1` 归卡）矛盾。
3. 新增守卫测试**自己有两处硬伤**：`await` 写在非 async 回调里（esbuild 直接拒绝转换 ⇒ 整文件 0 用例）、
   Firefox 形态栈的 `filename` 断言按当时的解析器不可能成立。

按 `_BACKUPS` 规矩先把现场固化，再由主控实测归因、修、跑门禁、提交。

## ④ 后续待办清单

- [x] 逐条复核中断改动是否真落地（结论：方向对，两处需补：删掉因此变成死码的 `palinkDiagFirstStackLine`、
      给 `filename` 解析加 `at `/`fn@` 前缀剥离）。
- [x] 修测试硬伤（静态导入替代动态 `await`；helper 切片含 `card-script-runner.ts:447` 的 window 监听，
      夹具补 `addEventListener` no-op）。
- [x] 跑门禁：`bash scripts/gate.sh frontend` ⇒ rc=0，97 文件 / 1304 passed / 3 skipped，failed=0。
- [x] 提交（本目录只作留档，不用于回滚）。
- [ ] 台账 §1 的第 2、3 件事（`missingStSubsystem` 字段 + 双向守门）尚未落地，由主控接着做。

## 回滚方式（若需要）

**禁止** `git apply -R w-uncommitted-delta.patch`（整包回退会连带抹掉同一文件上后来的提交）。
需要回到中断态时，逐文件拷回：`cp runtime-body/part-01.ts frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts`。
