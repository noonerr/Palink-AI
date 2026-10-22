# 备份说明

## ① 备份日期

2026-10-05

## ② 原始来源路径

- `frontend/src/lib/sillytavern/formatting.ts`

备份位置：`files/formatting.ts`，校验清单 `_manifest.tsv`（sha256，1 行）

## ③ 备份原因

弱网实测（300kbps + 300ms 延迟、共享带宽）发现首屏入口 JS 达 **638KB gzip / 1782KB raw**，
60 秒时页面仍完全白屏（`document.body` 为 null）。入口包体积归因（用字符串字面量锚点切分，
因 minify 只改标识符不改字符串）显示三大区块：

| 区块 | raw 体积 | 可否延后 |
|---|---|---|
| smart-card-runtime 帧内 ST 模拟 | ~470KB | 否（开屏即用） |
| **KaTeX** | **~341KB**（含16 块字体度量表 53KB） | **是** |
| ST getContext 兼容 | ~257KB | 否 |

⚠️ 排查中纠正了一个错误判断：`SillyTavernCompatRuntime.ts`（源码 322KB）**并未**进入首屏 ——
它已是独立资产 `palink-smart-card-runtime-*.js`（317KB），`index.html` 中 `modulepreload` 为 0 个，
入口搜 `buildSillyTavernCompatRuntimeV2Shim` 命中 0。该架构本已正确。

KaTeX 可摘的三个依据：
1. 全项目仅一处使用 —— `formatting.ts:225` 的 `katex.renderToString()`；
2. `renderMathInHtml:269` 已有「无 `$` / `\(` / `\[` 直接返回」守卫 ⇒ 多数消息根本不进数学分支；
3. `katex@0.16.45` package.json **未声明 `sideEffects`** 且主入口为 CJS（`dist/katex.js`）
   ⇒ 打包器不敢摇树，只能改代码延后。

本批：把 KaTeX 改为按需动态加载，并利用既有守卫作为加载触发点。

## ④ 后续待办清单

- [ ] `npx tsc --noEmit` 通过（注意：`renderMathInHtml` 是**同步导出**，被同文件 `:1184` 同步调用，
      动态 import 不得破坏其签名 —— 未加载时需回退显示原文）
- [ ] `npx vitest run` 全绿（`formatting-katex-contract.test.ts:29` 断言源码含 `from 'katex'` 字面量，
      ⚠️ 改成动态 import 后该断言可能需要同步更新 —— 这是**故意的契约变更**，不是回归）
- [ ] 重建 dist，**验收硬指标：入口 `index-*.js` 的 raw 体积显著下降**（目标 -300KB 量级），
      且 `mord`/Metrics 表特征串在入口命中数归零
- [ ] 弱网复测：300kbps + 300ms 下首屏可见时间
- [ ] 真机验收：含公式的消息仍能正常渲染（首条会多一次异步加载，失败沿用现有 try/catch 回退原文）
- [ ] 无公式消息路径零影响（守卫直接返回）
- [ ] 若需回滚：把 `files/formatting.ts` 拷回 `frontend/src/lib/sillytavern/formatting.ts`