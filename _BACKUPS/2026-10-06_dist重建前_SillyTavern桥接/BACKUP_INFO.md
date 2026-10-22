# BACKUP_INFO

## ① 备份日期
2026-10-06（11:5x 本地时间，GMT+8）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`

（该目录是 docker nginx 的 **bind mount 在用产物**，不是构建缓存。
 备份动作 = 整目录 `cp -r`，未改名、未改动内部任何文件。）

## ③ 备份原因
本批要把「**window.SillyTavern API 桥接**」上线 —— 这是卡片设置面板打不开 / 功能闪退的
**根因修复**（详见 ④ 与 `.workbuddy-ai/memory/2026-10-06.md`）。重建 dist 前按项目规范
整份留存当前在用产物，便于逐字节回滚与改动前后分块比对。

备份时的在用入口：`index.html` → `index-CIXgeVoa.js`（上一批「控制台噪音治理」的产物）。

### 修复的根因（一句话）
卡脚本（实测 MVU 插件）从 `window.SillyTavern` 上取 22 个 API，而 Palink 只挂了 9 个，
**交集几乎为零**。更关键的是：这些 API 我们**不是没实现** —— 它们在 `tavernHelperCompat` 里
（219 个键，含 MVU 要的 19 个），只是挂在了 `window.TavernHelper` 上、没挂到 SillyTavern 上。
⇒ 准确说法是**挂错了地方**。

而 `window.TavernHelper` 是 Proxy（缺键回落到 `makeMissingApiFunction`，安全不抛），
`window.SillyTavern` 此前是**裸对象**（缺键 = `undefined`）
⇒ MVU 的 `SillyTavern.ToolManager.isToolCallingSupported()` 直接 TypeError，
且它包在 Vue 的 `watch(..., { immediate: true })` 里 —— 组件创建即执行
⇒ 初始化链当场断掉 ⇒ 后段 `setEventsRefs` 永不执行 ⇒ 设置面板打不开（用户看到的症状）。

### 本批改动
`SillyTavernCompatRuntime.ts` 给 `window.SillyTavern` 套上与 TavernHelper **同构**的 Proxy：
① 自己的 9 个键 → ② `tavernHelperCompat` 的 19 个真实现 → ③ `makeMissingApiFunction`
（安全空函数 + 上报诊断）。**任何缺口都不再抛 TypeError。**

## ④ 后续待办清单
1. 重建后**必须**核对：`index.html` 入口 hash 已变化；新 runtime 分块含
   `installSillyTavernCompatProxy` / `__palinkSillyTavernProxy`；
   上一批的 `allow-modals`、`__palinkConsoleGovernor` **仍在**（不能被覆盖）。
2. ⚠️ **真机回归重点**：影响面是**所有卡**，不只这一张。
   此前靠「`SillyTavern.xxx === undefined`」做特性检测的卡，现在会拿到实现而改走"支持"分支。
   需抽查几张不同的卡，确认没有新出现的异常。
3. 待用户验收：那张卡的设置按钮能否打开；F12 里
   `MVU: function tools are not supported` 与 `legacy_chat.ts` 的 TypeError 是否消失。
4. 若上线后异常：`cp -r _BACKUPS/2026-10-06_dist重建前_SillyTavern桥接/dist frontend/dist`
   即可回到本备份状态（先清掉新产物，避免新旧分块混杂）。
5. **仍未修的 3 个 API**：`loadWorldInfo` / `getChatCompletionModel` /
   `chatCompletionSettings` —— TavernHelper 上也没有，走的是第 ③ 层安全兜底
   （不崩，但功能不可用）。若后续发现卡依赖它们，需另行实现。

## 备注
- `window.ToolManager` 目前是**空壳**（`isToolCallingSupported: () => false`），
  所以 MVU 的工具调用会走**降级分支**（不崩，但功能不可用）。
  这是刻意的保守实现；要让工具调用真能用，需另行实现 ToolManager，本批未做。
- 门禁：重建前 `tsc` 干净、vitest **61 文件 790 passed 0 failed**。
- 重建前已确认 `frontend/src` 中晚于上次构建的文件**只有本批 1 个源文件**
  （另一条是本批新增/修改的测试，不进产物），未带入并行会话在途改动。
