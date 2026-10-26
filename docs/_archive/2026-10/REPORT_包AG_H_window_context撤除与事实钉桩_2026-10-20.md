# REPORT 包AG-H — 撤掉帧内 `window.context`（与 ST 的偏离），并把三处矛盾钉成一条事实（2026-10-20）

> **状态：已完工待验收（前端未上线，等主脑重建）。**
> 施工：外部对话（批次 H，任务书 `PROMPT_对话包_批次D与E与H与I_2026-10-20.md` 的「批次 H」）。
> **报告与提交由主脑代做**（该对话在完成实现与全部验证后被"回路检测"中断，未及写报告/提交；
> 其交回文本含全部反证原始输出，本报告逐项引用，不替它拔高）。
> 取代关系：撤销 `[包N B-2 2026-10-19]` 的一处产品行为（见 §3 与 §5 改判对照）。

## 1. 结论

帧内**不再提供** `window.context`。理由只有一条：**ST 没有这个东西**，而用户裁定"与 ST 冲突时以 ST 为准"。
卡要拿上下文应当调 `getContext()`（我们 145 个键都在那儿）。

## 2. 钉事实（三方互证，主脑自己复验了第 ① 条）

① **ST 侧**：`_reference/sillytavern-1.18.0/public/scripts/st-context.js` 只有
`export function getContext()`（:114）与 `export default getContext`（:309），**没有 `export const context`**；
整棵参照树 `window.context =` **0 命中**；ST 的真实写法是各文件内部 `const context = getContext()`
（`authors-note.js`、`extensions.js`、`utils.js`、`slash-commands.js` 等，两棵树各 57 处）。
⇒ **包N B-2 当初写进注释的依据（"ST 1.18 的 context 是 st-context.js 里的一次性快照"）是误读**。
② **裁定链**：台账 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2.1 第 4 行
"不摆这个全局（摆出来才是造 ST 没有的形状）"；任务书 §0 第 4 条同。
③ **真机**（执行方在 `:16000` 露缇雅 7/7 帧实测）：boot 之后 `typeof context === 'object'`
（getter、可枚举、且 `window.context !== getContext()`），而每帧唯一的记录仍是启动留痕
`frame_compat/global_shape_absent/window.context`，**没有任何 name='context' 的 error 轨记录**
⇒ 三件事同时成立（"没提供"的记录、实际提供了、ST 根本没有），且**没有在跑的卡依赖这个面**，撤掉不打断任何卡。

## 3. 改了什么

- `runtime-body/part-08.ts`：删掉 `Object.defineProperty(window, 'context', …)`；原位留撤销注记（三条依据 + **勿再加回**）。
  另修 `:485` 那条指路注释（原写"③ 由包N B-2 补齐"）。
- `runtime-body/part-01.ts`：启动留痕**文案**改为"ST 亦无此全局 + Palink 帧内同样不提供 + 卡应调 `getContext()`"；
  owner / kind / name / 触发条件一字未动。
- 两份测试按新事实**改判而非删除**：`n-package-context-rename-media-trust.test.tsx` 的 B-2 断言由
  "定义在场"改为"定义不在场 + 顺序不回退"（含执行型证明）；`c-getcontext-six-keys-and-diag-wording.test.ts`
  的 D 块同步改判并加一条顺序断言。
- 文档：`docs/OPEN_ISSUES.md` P2-12 第 9 行订正（拍板结果=不摆）；台账 §2.1 追加"✅ 已施工"。

## 4. 验证（执行方跑并交回原始输出，主脑在合并态复跑门禁）

- 执行方：`gate.sh frontend` rc=0（tsc 绿，109 文件 / 1464 passed / 3 skipped），
  智能卡运行时目录 51 文件 / 735 passed。
- 两组反证：① 把文案改回批次 C 版本 ⇒ 钉文案的 2 条用例红；② 把定义挪回原位 ⇒ 顺序断言 2 条红；
  还原后 sha256 一致、两文件单跑 42 用例复绿。
- 主脑独立复验：本报告随附的合并态门禁结果以主脑自己那次运行为准（见 §6）。

## 5. 改判对照（防下一位误删）

| 原断言 | 新断言 | 依据 |
|---|---|---|
| 帧内定义了 `window.context` 的 getter（包N B-2） | 定义**不在场**，且不得再加回 | §2 ①②③ |
| 留痕文案"我们未提供这个全局" | "ST 亦无此全局，Palink 同样不提供，卡应调 `getContext()`" | §2 ① |
| 留痕判定逻辑 | **一字未动**（owner/kind/name/条件/去重/上送全保留） | 任务书 C-2 |

## 6. 主脑补记（复验与遗留）

- 主脑自己复跑 ST 一手检查（§2 ① 的三处 grep）与合并态门禁，结论与执行方一致。
- **本批与批次 D/E/I 一起等前端重建上线**；重建后需补的读数（执行方因中断未跑）：
  boot 之后 `typeof context` 应为 `undefined`、`window.context` 不再是自有键、
  `Object.keys(TavernHelper)` 仍 144、`getContext()` 仍 196、每帧插件 CSS 仍 5/5、`Object.keys(commands)` 仍 509。
- 报告由主脑代写这一事实本身要记账：中断的对话已完成实现与验证，**未提交**，
  工作区停在 6 个改动文件上；由主脑统一提交，避免被并行批次 `git add` 夹带。
