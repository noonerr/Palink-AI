# 备份说明

## ① 备份日期

2026-10-05

## ② 原始来源路径

- `frontend/src/index.css`
- `frontend/src/components/ui/custom/Message.tsx`

备份位置：`files/`（保留原文件名），校验清单 `_manifest.tsv`（sha256，2 行）

## ③ 备份原因

删除 `mes-render-skip` 离屏跳绘机制前备份。该机制用 `content-visibility: auto` 让视口外消息跳过绘制，
导致**智能卡的样式在离屏时消失（卡片退化为纯文字）**，入视口恢复。根因是跳过判定
`isHtmlCardContent`（`Message.tsx:216`）只认 `div`/`span`/`iframe` 等**渲染后**标签，
不认 `<now_plot>` 包裹，而判定跑在渲染之前、输入是模型原文 ⇒ 所有带卡片的 AI 消息
被误判成「纯文本」而被跳过。

ST 侧对照：`d:\SillyTavern-release` 的 `.mes` **无任何虚拟化**；唯一的
`content-visibility: auto` 挂在 `.auto_hide` 类上，而全项目无任何处给元素加该类（死规则）。

同项目内 `SmartCardDormancyGate`（`Message.tsx:637`）已有正确的视口+一屏缓冲休眠门，
本批删除的是与之重复且有害的第二套机制。

## ④ 后续待办清单

- [ ] 删除后跑 `npx tsc --noEmit` + `npx vitest run`（只认 failed=0）
- [ ] 重建 dist 并重启 frontend 容器（提交 ≠ 上线）
- [ ] 真机验收：长对话向上滚动，卡片离屏后再入视口，样式应保持不变（不再退化纯文字）
- [ ] 回归：确认长对话滚动性能未明显劣化（若劣化，再议「加大休眠门缓冲」方案）
- [ ] 清理本次新增的离线取证测试 `frontend/src/utils/__tests__/render-skip-offscreen-probe.test.ts`
      （它复制了 `isHtmlCardContent` 逻辑，删除机制后已无存在意义）
- [ ] 若需回滚：把 `files/` 下两个文件拷回原路径