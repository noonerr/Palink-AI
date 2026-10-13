# HANDOFF — T2 收尾：iframe 存活配额接线修复 + 复测（给接手的 agent）

> 日期：2026-10-13 20:25｜分支 `three-tracks-merge-20261012`｜HEAD `8289b5e`
> 上游：`docs/_active/HANDOFF_剩余任务提示词_T2与S2-S5_2026-10-13.md`
> 方案：`docs/_active/spec/SPEC_T2_iframe生命周期策略_2026-10-13.md`（**先读它**，尤其 §8）
>
> ## ✅ 接手结果（2026-10-13 22:2x 完成，本节由接手 agent 追加）
>
> **任务已闭环，T2 可打勾。** 摘要：
> - **根因**（§3 的"看起来没生效"是真的，但三条嫌疑有两条被证伪）：真缺陷是接线两处 ——
>   ① wake 分支 `register(cardId,true)` 对已注册条目是**幂等空操作** ⇒ `visible` 永远翻不真
>   （真机 `lruVisible` 恒 0）；② 逐出判断只写在"刚睡着那张卡"的回调里，而受害者按定义是
>   **更早变隐藏**的那张卡 ⇒ 结构上永远打不中（真机 cap=3 且 size=5>3，逐出数恒 0）。
> - **顺手订正 §4 嫌疑③**：一个**门**里可以有多个卡块 iframe（同一消息两个 HTML 块）⇒
>   5 门 / 7 帧。配额单位是门，不是帧。
> - **修法**：内核加 `onEviction` 订阅 + `enforceCap()`（统一逐出并通知受害者本人）；
>   接线 wake 改 `register + markVisible(true)`、登记从"挂载时"改到"第一次 IO 上报时"；
>   门组件抽到 `smart-card-runtime/dormancy-gate.tsx`（纯移动，便于 jsdom 测试）。
> - **复测**（真机 playwright）：cap=16 → 逐出 0、帧 7→7（行为零变化）；
>   **cap=3 → 逐出 2、帧 7→5**；**cap=1 → 逐出 4、帧 7→2**（修复前 cap=3 是 7→7）。
> - **门禁**：`npx tsc --noEmit` 0 错；`npx vitest run` **958 passed / 1 failed（S2 设计红）/ 3 skipped**。
> - 新增守卫测试 `smart-card-runtime/__tests__/dormancy-gate-wiring.test.tsx`（9 条，jsdom + 伪造 IO）；
>   反证（实测）：换回旧接线 → **8 红 1 绿**，换回修复版 → 9 绿。
> - 顺手补了交接文档 §5 ① 的兜底：`cardId` 落空串时用 `useId()` 生成唯一配额身份
>   （`/chat` 的两个渲染点不传 `messageIndex`，未落库消息 `message.id` 也可能为空）。
> - 细节见 `SPEC_T2_iframe生命周期策略_2026-10-13.md` §8（含诊断口与测量方法）。
> - ⚠️ **cap 调小时 task 耗时反而上升**（逐出-重建 = 884KB srcdoc 重新装配）：这是**设计上的已知代价**，
>   默认档 16 远大于可见集所以生产不触发；别把"逐出"当零成本。
> - ⚠️ **G8（iOS 档位）仍未验**（未动 16/40）。

---

## 0. 一句话任务

**"智能卡 iframe 存活配额"已经写好策略内核和接线，但接线被真机实验证伪（不生效）。
你要做的是：查出为什么不生效 → 修 → 补上复测数字。完成前 T2 不得打勾、不得打 `s1-done`。**

---

## 1. 为什么要做（S0 实测，不是推导）

来源 `REPORT_S0备料基线与回退演练档案 §6.1`：

| 指标 | 实测 |
|---|---|
| 堆随 iframe 数增长 | 7 个 → 113MB；48 个 → 560MB（GC 后 ~300MB），边际 **+9~11MB/个，只增不减** |
| 91 条会话可滚动高度 | 12,399px → 55,753px（4.5×）；nodes 4.8k → 14.0k |
| 滚动每千像素主线程耗时 | 28.1ms → 42.3ms（**1.51×**） |

并轨后所有卡都走 iframe ⇒ 不解决则长会话**线性劣化**。

## 2. 地面现状（别重复造轮子）

### 2.1 已有的东西（本次之前就在）

- **`Message.tsx:653`**：`const PALINK_CARD_DORMANCY_UNMOUNT = false;` —— 卸载分支**已写好**，被这个常量关着。
- **`Message.tsx:655-746` `SmartCardDormancyGate`**：无条件包裹智能卡分支（`:1653` 附近）。
  IntersectionObserver + 上下各一屏 `rootMargin` 缓冲、休眠前测高、等高占位防跳动、同态重复上报守卫。
- 关闭原因写在 `Message.tsx:645-652`：卸载后重建 = 一次真实导航；Safari 会话历史是**联合**的，
  每次 iframe 导航插一条**幽灵条目**（顶层 URL 不变）⇒ 滑动返回闪过 N 个一模一样的快照；
  **iOS 没有 API 删除已存在的历史条目**。

⇒ 三选一被重新定义：
- ① "出视野即卸载" = 把 `:653` 改 `true`，但**重放已付过学费的 iOS 回归**；
- ② "冻结保留"（隐藏）= **就是当前实现，且已被证伪** —— S0 那 560MB 正是带着这个门跑出来的，
  证明"隐藏 ≠ 省内存"（`content-visibility:hidden` 也因唤醒空白被移除两次）；
- ③ **LRU 封顶** = 本次采用的方向。

### 2.2 本次已经加好的（`301225a`）

| 文件 | 内容 |
|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/iframe-lru.ts` | **纯逻辑**策略内核：`register / unregister / markVisible / pickEviction / pickEvictions / snapshot`；**可见项永不逐出**；cap 是"隐藏项目标上界"不是硬上界；`DEFAULT_IFRAME_LRU_POLICY = { nonIosCap: 16, iosCap: 40 }`；`getSharedIframeLru()` 单例 |
| `frontend/src/components/ui/custom/smart-card-runtime/__tests__/iframe-lru.test.ts` | **18 条守卫测试**，含核心守卫"加载 1000 条消息存活数仍 ≤ cap" |
| `frontend/src/components/ui/custom/Message.tsx` | 接线：gate 新增 `cardId` prop；mount 时 `register`；IO 回调 sleep 分支 `markVisible(false)` + `pickEviction()===cardId` 则 `unregister` + `setEvicted(true)`；wake 分支重新 `register(cardId,true)` + `setEvicted(false)`；渲染条件改成 `PALINK_CARD_DORMANCY_UNMOUNT && dormant \|\| evicted ? 占位 : children` |

## 3. 🔴 已证伪：接线看起来根本没生效

**受控对照实验**（做法：把 `iframe-lru.ts` 的 `nonIosCap` 临时改成 `3` → 重建 → 真机滚到底 → 数 iframe）：

| | 配额 16 | 配额 3 |
|---|---|---|
| `iframesAfter` | **7** | **7** |

配额降到 3，iframe 数**一个没少**。⇒ 策略内核单测全绿，但**线上侧效果未证明、且看起来就是没生效**。

⚠️ 实验值 `nonIosCap: 3` **已经恢复成 16 并重新构建部署**；`git status` 干净、源码在提交态。
**不要**以为"改个常量就行"——那正是这次被证伪的做法。

## 4. 三条候选根因 + 各自的判定方法（按顺序查，别跳）

### 嫌疑①（最可疑）：`cardId` 塌成同一个条目

接线处：`Message.tsx` 里 `<SmartCardDormancyGate cardId={String(message.id ?? messageIndex ?? '')}>`。
若 `message.id` 缺失 → 退到 `messageIndex` → 再缺失就是**空串** ⇒ 多张卡在 LRU 里**共用一个条目**
⇒ registry `size` 远小于卡数 ⇒ 永远不超配额。

**判定方法**：把 registry 暴露出来（见 §5），真机滚一遍看：
- `size` 是否等于**卡片数**（应为 7）；若明显偏小（例如 1），就坐实了。
- 打印各 `cardId`，看有多少是空串/重复。

### 嫌疑②：IntersectionObserver 的 sleep 分支根本没触发

**逐出只写在 sleep 分支里**。若 IO 回调没跑（或 `measured <= 0` 提前 `continue`），就永远不逐出。
注意 `Message.tsx` 里 `if (measured <= 0) continue;` 会跳过休眠。

**判定方法**：真机滚到底后统计"处于占位态的卡片数"（占位 `div` 带 `aria-hidden="true"`），
以及给 sleep 分支加计数暴露。若占位数为 0，就是 IO 没触发。

### 嫌疑③：iframe 计数口径混了非卡片 iframe

`document.querySelectorAll('iframe').length` 可能包含非卡片 iframe。

**判定方法**：改成只数**卡片 iframe** —— 判据是帧内 `script[src]` 含 `palink-smart-card-runtime`，
或帧内存在 `window.getCharWorldbookNames`。

## 5. 修复指引

1. **先加诊断，不要先改逻辑。** 在 `iframe-lru.ts` 里把单例挂到 `window.__palinkIframeLru`
   （仅诊断用，注释写明），导出 `snapshot()` 已有。真机滚一遍，按 §4 三条逐一判定。
2. 定位后**先补一条红测试**再改实现（本项目纪律：红→绿）。
   - 若是①：测试桩给两个空串 `cardId`，断言 registry size 应为 1（暴露塌陷）；
     修法：保证 `cardId` 全局唯一（缺失时用稳定的 `messageIndex`/`idx` 兜底，不要落到空串）。
   - 若是②：需要在 jsdom 里伪造 IntersectionObserver 驱动可见性，断言"进入休眠且超配额 ⇒ 被逐出"。
   - 若是③：只改测量口径，不改产品代码。
3. 修完**必须重建并真机复验**（见 §7 命令），确认"存活 iframe 数被封住"。

## 6. 验收标准（四项，缺一不可）

1. 方案文档（已有，§8 需按最终结果更新）
2. 守卫测试（已有 18 条；修 bug 需再加）
3. **复测数字**：内存堆 + 滚动主线程耗时，且能证明**存活 iframe 数不再随消息数线性增长**
4. 门禁：`failed = 0`（唯一允许的红是 `storage-isolation-contract.test.ts:221` 的 **S2 设计红**，
   测试名带 `[红→S2 转绿]`，不是缺陷）

## 7. 可复用命令（踩过的坑都在里面）

### 前端改动要生效 —— **必须宿主构建**，`docker compose build` 无效
`frontend/dist` 是 nginx **bind mount**（`docker inspect palink-ai-frontend-1` 可复核：
`Source=D:\项目\Palink-AI\frontend\dist → /usr/share/nginx/html (ro)`）⇒ 镜像里的 html 被挂载**遮蔽**。

### ⚠️ 不要直接 `npm run build`
它会先跑 `scripts/clean-dist.cjs`，而该脚本会被**安全删除守卫**拦下
（`SAFE_DELETE_BULK_CONFIRM_REQUIRED {count:50, threshold:50}`）⇒ **dist 被删掉一半**
（782→733 文件），站点仍 200 但 49 个 chunk 404。

**正确姿势（旁路构建 + 覆盖拷贝，全程不触发删除守卫）**：
```bash
cd frontend
VITE_OUT_DIR=dist_new node scripts/build-vite.mjs
cp -r dist_new/. dist/          # 只增不删
node scripts/gzip-dist.cjs
rm -rf dist_new
```
bind mount 让 nginx **立刻**读到新产物，不用重启容器。

### 门禁
```bash
cd frontend
npx tsc --noEmit
npx vitest run                  # 当前基线 949 passed / 1 failed（S2 设计红）/ 3 skipped
```

### shim 产物比对（动过 `helpers.ts` / `legacy-st-sim.ts` 时必须做，两阶段）
```bash
cd frontend
node scripts/verify-shim-identity.mjs snapshot src/components/ui/custom/CharacterCardRenderer.tsx ../_BACKUPS/<dir>/shim-after.txt
node scripts/verify-shim-identity.mjs compare  ../_BACKUPS/<dir>/shim-baseline.txt ../_BACKUPS/<dir>/shim-after.txt
```
⚠️ `compare` **只报第一处差异**；要确认"diff 仅限预期段"，需自己用 python difflib 做**行级 diff**。

### 真机探针（playwright-cli 已可用，无需装浏览器）
```bash
export MSYS_NO_PATHCONV=1
playwright-cli open about:blank
playwright-cli run-code "$(cat <脚本>.js)"
```
- 浏览器会话**不跨 bash 命令持久** ⇒ 每次都要在同一条命令里 `open` + `run-code`。
- `run-code` 必须传**箭头函数源码** `async page => {...}`；上下文里**没有 `setTimeout`**，用 `page.waitForTimeout`。
- 认证：`POST /api/token`（FormData `username=admin&password=admin123`）→ 存 `localStorage.palink_token`。
- 本机前端端口 **14700**；`curl` 必须 `/c/Windows/System32/curl.exe --noproxy '*'`（Clash 拦 localhost）。
- 现成脚本在 `D:\项目\_palink-s0-20261012\`：
  `_probe_perf.js`（性能测量，**已修好滚动容器为 `#chat`**）、`_probe_scroller.js`（找滚动容器）、
  `_probe_final.js`（lorebook 族回归）、`_probe_killswitch.js` / `_probe_sw2.js`（kill switch）。

### 测量口径（本次踩过的坑，直接沿用别重踩）
- 滚动容器是 **`#chat`**，不是 `#chat-items-scroller`；`document.scrollingElement.scrollHeight == clientHeight == 720`，
  必须自己按 `scrollHeight - clientHeight > 200` 找内层滚动容器。
- CDP `Performance.getMetrics` 的 **`TaskDuration` 单位是秒**不是毫秒（漏 ×1000 会算出 0.1ms/1000px 的荒谬值）。
- 滚动过程中 `scrollHeight` 会从 9184 涨到 14456（卡片懒解析高度）⇒ **"每千像素"的分母不准**，
  应改用**实际滚动距离**或直接报总量。
- **不得用 FPS**：headless 无 vsync，实测 149.8fps 是假象。
- 参考值：cap=16 时 heap 93.4→95.3MB / task 729.4ms / iframe 7→7；cap=3 时 heap 86.6→80.4MB / task 685.1ms / iframe 7→7。

## 8. 红线（违反即回退）

1. **不得**为省内存去改卡脚本语义或变量持久化逻辑。
2. **不得**把 `PALINK_CARD_DORMANCY_UNMOUNT` 直接改成 `true` 了事 —— 那会重放 iOS 回归。
3. 动 `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` / `helpers.ts` 这些**模板字符串**文件时：
   注释里**禁止反引号和 `${`**（会截断模板字符串，历史因此炸出过一堆 TS1005/TS1443）。
4. 一笔提交只做一件事；先写红测试再改实现。
5. **离线探针参数必须与生产调用点逐项一致**，否则结论是假阳性。
6. 声称完成前**自己实测**，别直接采信报告里的收益数字。

## 9. 顺带提醒：本仓数据不足以自然触发逐出

DB 查询结论：最大会话 92 条**仅 2 条疑似卡片**（页面实测 **7 个 iframe**），远低于配额 16。
⇒ 修好接线后，用真实数据**仍然看不到逐出**。所以：
- 要么继续用**受控实验**（临时调小 cap）来证明配额生效，并在完成后**恢复**；
- 要么先造一个卡片数 > 配额的会话。
（实验值务必记得恢复并重新构建部署。）

## 10. 待用户拍板（**不要自行决定**）

| 编号 | 问题 | 现状 |
|---|---|---|
| **G8** | iOS 配额档位（现默认非 iOS 16 / iOS 40） | 已做成**策略参数** `DEFAULT_IFRAME_LRU_POLICY`，改一个值即可。⚠️ 那条 iOS 幽灵历史回归**从未在真机 iOS 设备上复验过**；若不复现，iOS 可直接用与非 iOS 相同的配额 —— 这是性价比最高的未知项 |
| **G9** | S4 是否跳过拆分 `sillyTavernPluginRuntime.ts`（可能与 S5 删除重叠，白做） | 未定 |
| **G4** | 行数门禁范围（4228 行 vs 合规基线 4000，上限未定） | 未定 |

## 11. 已完成的其他项（供你判断上下文，别重复做）

- **G10** 单间轨补全 lorebook 族（S3 阻断项）✅ 真机 7 帧全绿
- **G11** 世界书回退到角色 `character_book` ✅ 真机 `primary='露缇雅1.2'`、条目 19 条
- **G7** 世界书名构建期内联 ✅（源已订正为 character_book）
- **G6** kill switch 真机验证 ✅ 开关1 有效；**开关2 原为哑弹已修好并复验**
- T1 / T3 ✅（上一轮完成）

## 12. 本轮踩到的通用教训（强烈建议读完再动手）

- **桩必须照抄真机形状，不能照抄自己的假设。** 本次两次踩到：
  ① `getLorebookEntries` 的测试桩按"展开对象有 `length`"写 → 单测全绿、真机仍红
  （数组 `length` 是**不可枚举**属性，`{...arr}` 不复制）；
  ② IDB kill switch 的测试只 mock `window.parent`、**没装 legacy parent 代理** → 单测覆盖、真机哑弹。
- **帧内有两套 `requestParent`**：legacy（`legacy-st-sim.ts:489`）直接 `resolve(data.result)`；
  v2（`SillyTavernCompatRuntime.ts:4659`）`resolve(data.ok ? {ok:true, ...(data.result ?? {})} )`
  ⇒ **数组结果会被展开进对象**，`Array.isArray` 为 false。**在 v2 里拿数组结果必须归一化。**
- **`page.frames()[0]` 是主页面本身，不是卡片 iframe**。判据：`script[src]` 是否含 `palink-smart-card-runtime`。
- **生产包看不到 `console.*`**：terser `drop_console: true` 剥掉全部 console（含 warn）
  ⇒ 真机取证不能靠日志、截图也拍不到，只能用 **DOM / 运行时对象**信号。
