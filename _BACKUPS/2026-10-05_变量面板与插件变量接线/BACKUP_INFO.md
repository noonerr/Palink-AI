# BACKUP_INFO

## ① 备份日期

2026-10-05（00:50 前后，会话自 2026-10-04 23:49 起，跨零点）

## ② 原始来源路径

按原相对路径存于 `pre/`，逐文件 sha256 见 `_manifest.tsv`（3 行）：

| # | 原始路径 | 作用 |
|---|---|---|
| 1 | `frontend/src/components/ui/custom/Message.tsx` | 消息渲染组件；本次要在此挂「变量变化」面板 |
| 2 | `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | 智能卡 iframe 轨的 ST 兼容层；本次要修 `Mvu.getMvuData` 的覆盖条件 |
| 3 | `frontend/src/lib/sillytavern/card-script-runner.ts` | 卡脚本执行器（页面轨）；本次要补 `replaceVariables` 的显式降级登记 |

## ③ 备份原因

执行用户 2026-10-05 拍板的两件事：

1. **新增「变量变化」面板** —— 让用户能像在 SillyTavern 里一样，看到模型每轮把哪些变量从多少改成了多少。
   现状：`<UpdateVariable>` 指令块被后端 + 前端共 4 处剥离，变量只以「状态面板」形式呈现**当前值**，
   **没有变化记录**（`TavernHelperPanel.tsx` 只渲染 schema × 当前 stat_data）。
2. **修插件变量接线两处不一致**（见下），均**不改动变量真源与写入链路**。

动工前的关键侦察结论（决定改哪三个文件）：

- **MVU 的 `Mvu.getMvuData` 就是裸全局 `getVariables` 的薄包装**。实测卡脚本
  `backend/data/smart_card_assets/0c646fb31a8cd5610d22ccd26323258a430f83a09e6a0a09596b2b1875eabac2.js`
  （307,179 B，MVU bundle）内原文：
  `getMvuData:function(e){return getVariables(e)},replaceMvuData:function(e,t){return replaceVariables(e,t)}`
- 该卡脚本真实调用计数：`replaceVariables` ×7、`getChatMessages` ×7、`getVariables` ×4、`getMvuData` ×1。
- MVU 面板挂载点：`#extensions_settings2`（1 处）—— 该容器由 `StPluginMountPoints.tsx:243` 提供，
  当前是**离屏 parked**（`top:-9999px; visibility:hidden`），展示入口为 `StPluginSettingsDrawer`。
- **因此「面板接不上数据」不是缺读口**：页面轨 `window.getVariables` 已由
  `card-script-runner.ts:312` 桥到我们的会话变量；真正缺的是**写口不一致**：
  `setVariables` / `setVariable` 已是 `recordStubHit` 显式降级（`card-script-runner.ts:330-343`），
  而 `replaceVariables` 是**裸 undefined** → MVU 更新管线每轮抛 `ReferenceError`（崩溃而非降级）。

## ④ 后续待办清单

备份之后需要修复或修改的任务：

1. **[已在本批完成]** 新增 `VariableChangePanel.tsx` + `.css`，挂到 `Message.tsx` 助手消息区；
   纯函数 `diffStatData` 单独导出以便单测。
2. **[已在本批完成]** `SillyTavernCompatRuntime.ts`：`getMvuData` 改为与 `getAllVariables` 一致的
   **无条件覆盖**（含 `setTimeout` 延时补刀那处）。原实现 `if (typeof window.Mvu.getMvuData !== 'function')`
   会让面板读插件自己的空 store。
3. **[已在本批完成]** `card-script-runner.ts`：补 `replaceVariables` 的 `recordStubHit` 降级登记，
   与同族 `setVariables` / `setVariable` 口径一致；**不开放真实写入**（写口收敛仍按
   `REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md` §8 的 P2 议题单独做、单独验）。
4. **[未做 · 待办]** 真机验证：需打开站点确认 ① MVU 面板经「插件设置」抽屉可见 ② 面板显示的
   是否为我们的 stat_data ③ 变量变化面板在有 `<UpdateVariable>` 的卡上是否正确。
   **本批无法完成真机验证**（未确认站点端口与浏览器环境）。
5. **[未做 · 待办]** `replaceVariables` 的真实写入（走补丁入口 → `mvu_engine.apply_patches`）
   属变量链路改动，需另立批次。
6. **[未做 · 待办]** 前端 5 套变量供给里 3 套冗余壳（`legacy-st-sim` / `inline-st-globals` /
   `sandbox` 变量层）的收敛，见同一份报告 §11.4。

---

## 备份后的同批追加（2026-10-05 01:00，不改动已备份副本）

- **新增第 3 个测试文件**：`frontend/src/components/ui/custom/smart-card-runtime/__tests__/mvu-panel-data-override.test.ts`(5 例)。
  起因：跑全量变量/插件测试时发现 `Mvu.getMvuData` / `getAllVariables` 在本仓**零测试覆盖**
  （`grep -rn "getMvuData" src --include=*.test.ts` 命中 **0**）—— 而本批恰好改了这段逻辑。
- **`SillyTavernCompatRuntime.ts` 备份后又改了一处注释**（第 6514 行）：
  原文写了旧守卫的字面代码 `typeof window.Mvu.getMvuData !== 'function'`，会被新测试的正则误命中；
  改为文字描述（"仅当插件尚未提供该函数时才装，带 typeof 判定守卫"）。**逻辑零改动**。
- **反证已做**：把 `window.Mvu.getMvuData = ...` 翻回条件守卫 → 新测试 2 条立即变红；
  从 `/tmp` 副本恢复后 sha256 校验一致、复绿。`_manifest.tsv` 记录的是**动工前**的副本哈希，仍有效。
- **门禁终值**：tsc exit 0；vitest **56 文件 / 751 passed / 3 skipped / 0 failed**；pytest **1796 passed / 51 skipped / 0 failed**。
  变量/插件专项子集：前端 33 文件 483 passed；后端 26 文件 542 passed。
