# HANDOFF — 包J：插件 CSS 守护快照 + 帧内 characterId（包E 实测新缺陷）

> **状态：待施工（等包G 收工后派）。** 优先级 P0（J-1）/ P2（J-2）。量级：小（各 ~20–40 行 / ~5–15 行）。
> 本文档由主控（主脑）在 2026-10-18 依据 `docs/_active/report/REPORT_包E_ST生态卡实测_2026-10-18.md` §4 F-1/F-2
> 撰写，**两处坐标我已在本机 grep + 读源码逐条复核**（复核记录见 §1 末尾）。
> 你（执行 agent）看不到之前的对话，本文档是自包含的：规格、红线、验收都在这儿。

> ### ⚠️ 订正说明（2026-10-18 深夜 · 包J 完工 + 主控自修包M 后追加）
> **§1/§2.2 里 J-2 的定位是错的，包J 的真机取证把它否证了，主控随后自己接了那一棒（`00a1248`）。**
> 1. 帧内 `getContext().characterId` 恒 0 的**真断点不在宿主** `getContext.ts:1785` 的
>    `Number(uuid)=NaN → findIndex → 0`（那只是下游症状），而在**帧内**：
>    `part-08.ts` 的 `getContextCompat` 写的是 `characterId: window.this_chid`，
>    而 Palink **从未往卡帧注入过 `this_chid` 这个 ST 全局** ⇒ 该键一直是 `undefined`。
>    已改为：只接受有限数字的 `this_chid`，否则诚实给 `0`（不造伪 id），
>    并新增与父侧同名的 `characterIdString` / `palink_character_id` 两个字符串身份键。
> 2. **卡帧内不存在 `window.context` 这个全局**（boot 的 ctx 是 `const`，不挂 window）——
>    本文件原假设"帧内 `window.context.characterId` 有值、只是为 0"不成立。
>    这是与 ST 的一处**形状缺口**，登记在 `docs/OPEN_ISSUES.md` [P2-12]，本批未补。
> 3. 上线后实测（重建 dist 后回 :16000 复跑）：帧内 `characterId = 0`、
>    `characterIdString = palink_character_id = c28061bb-…`（UUID 到位）、getContext 键数 **194 → 196**。
>    ⇒ 后续插件文档口径照旧生效：**数字 characterId 在 Palink 卡帧内语义不可靠，插件应改用字符串 id**。

## 0. 一句话任务

修两个包E 实测出来、**不在 F/G/H/I 任何一包范围内**的缺陷：

- **J-1（P0）**：Palink 自家插件注入的 CSS 在 6–14 秒内被卡侧 `head.innerHTML=` 重写抹掉，
  帧内样式守护救不回——因为守护快照只拍一次，而插件 CSS 注入晚于快照。
- **J-2（P2）**：`getContext().characterId` 在卡帧里恒为 `0`（UUID → `Number()` = NaN → 兜底 0）。

**不要重写守护架构，不要新建插件注入通道。**两个缺陷各自独立可回退，按 J-1 → J-2 顺序做。

## 1. 现状（主控已核实，行号基于 HEAD `efeeac8`；G/I 正在改本文件，行号会漂 ⇒ 用函数名定位）

### J-1 相关链路

| 环节 | 坐标（用锚点函数名找，别死信行号） | 实测行为 |
|---|---|---|
| 插件 CSS 注入 | `runtime-body/part-01.ts:815` `injectStPluginCssCompat()`，写入点 `:821-827` | 往 `document.head` `appendChild(<style id="palink-st-plugin-css-<插件id>-<idx>">)`，`:822` `getElementById(styleId)` 幂等只注一次 |
| 注入调用点（**全部异步**） | `part-01.ts:675`、`part-03.ts:62`、`part-06.ts:63`、`part-06.ts:378` | 等父侧 postMessage 下发插件资源后才跑 ⇒ 常**晚于**守护快照 |
| 帧内样式守护 | `runtime-body/part-08.ts:1409-1523` `(function installCardStyleGuardInFrame(){…})()` | 整段是一个 IIFE，内含 `takeStyleSnapshot` `:1426` / `restoreCardStyles` `:1439` / `needsRestore` `:1467` / `startCardStyleGuard` `:1481` |
| **病灶 1** | `part-08.ts:1483` `if (styleSnapshot) return;` + `:1515-1521` 挂 `DOMContentLoaded` / `load` 各 `{ once: true }` | **先到先得、只拍一次** ⇒ 快照里只有当时已在场的 3 条基样式 |
| **病灶 2** | `part-08.ts:1450-1452` 恢复只遍历 `styleSnapshot` | 插件 CSS 不在快照 ⇒ 被抹掉后**永久丢失**，`restoreCardStyles` 对它完全无感 |
| 观测面 | `part-08.ts:1503` `window.__palinkStyleGuardSnapshot`（快照条数）、`:1460` `__palinkStyleGuardRestored`（累计恢复条数）、`:1505` `__palinkStyleGuardDispose`（幂等卸载） | 验收就靠这三个键 |

**包E 的实测数字（复现靶）**：露缇雅卡 7 帧，t6 帧内 `<style>` 8 条 → t14 剩 3 条。消失的 5 条
`data-palink-st-plugin` 恰为 Chat Translation / Regex / Summarize / **Quick Replies（44,839B）** / Token Counter；
存活的 3 条是基样式。monkey-patch `removeChild`/`remove` 捕获 **0 次**，MutationObserver 见 23–24 次 STYLE 移除
⇒ 走 `head.innerHTML=` / `outerHTML` 节点级替换（卡侧外部 MagVarUpdate bundle 所为）。
三张同卡克隆分别呈现 5→0 / 0→0 / 0→0 ⇒ **竞态坐实**，不是特定卡的问题。

### J-2 相关链路

| 环节 | 坐标 | 说明 |
|---|---|---|
| characterId 计算 | `frontend/src/lib/sillytavern/getContext.ts:1782-1791` | Palink 角色 id 是 **UUID 字符串** → `Number(uuid)=NaN` → 回退 `charactersArray.findIndex(...)`；卡帧里 `ctx.characters` 不含该 UUID（或为空）→ `idx=-1` → `:1789` **兜底返回 0** |
| 既有守卫 | `frontend/src/lib/sillytavern/__tests__/plugin-character-id.test.ts` | 已在管"characterId 语义"，改前先看它锁了什么，**别把它改红来迁就实现** |
| 是否崩 | **不崩** | 卡主脚本对 getContext 用 `?.`，characterId=0 只让"按 characterId 分区/按 extensions 水合"的功能**静默降级** |

### 主控复核记录（为什么这两条可以直接照做）

2026-10-18 主控独立 `sed`/`grep` 打开过：`part-08.ts:1481-1521` 的 `if (styleSnapshot) return` + 两个 `{ once: true }`
注册、`part-01.ts:815-827` 的 `styleId` 生成与 `getElementById` 幂等检查、`getContext.ts:1782-1791` 的 NaN→findIndex→0 兜底，
**三段代码与包E 报告描述一致**。报告里"removeChild 捕获 0 次 / MutationObserver 23 次"是包E 的真机否证，主控未重跑，
但结论方向与源码形状自洽。⇒ 你可以把 §1 的坐标当准，但**动手前仍要自己开文件确认一遍**（G/I 可能已经把行号推歪）。

## 2. 施工规格

### 2.1 J-1：让守护"认得"后注入的插件 CSS（P0）

二选一，或并用。**推荐 (a) 为主、(b) 兜底**：

**(a) 注入侧主动登记（首选，改动面最小）**
给守护开一个帧内窗口级追加口（例如 `window.__palinkStyleGuardAddNode(nodeOrOuterHtml)`），
`injectStPluginCssCompat()` 每成功 append 一个插件 `<style>` 就调一次，把该节点补进快照数组。
要点：
- **只允许"追加插件自有节点"，禁止整快照重拍**。重拍会把卡侧自己塞进去的样式一并当成"基线"，
  守护从此失去判定意义（这正是本文件注释里已经被规避过的坑）。
- 守护未初始化时（插件 CSS 早于 DCL 的少数路径）：`__palinkStyleGuardAddNode` 必须安全 no-op，
  不能抛错、不能让 `injectStPluginCssCompat` 失败。
- 追加后同步更新 `window.__palinkStyleGuardSnapshot`，否则验收数字看不见。

**(b) 恢复侧对插件 id 反向补注入（兜底，可选）**
`restoreCardStyles()` 发现快照里没有、但文档曾有过 `#palink-st-plugin-css-*` 的节点缺失时，
重跑一次 `injectStPluginCssCompat()`。它的 `getElementById` 幂等检查天然支持重入，不会重复插。
⇒ 若走这条路，需要把 `injectStPluginCssCompat` 暴露成守护能调到的全局（现在是 `part-01.ts` 的局部 `const`），
**这一步是跨 part 的接缝改动，做完必须在报告里写清新全局名和它的归属**。

**禁止的做法**：把 `startCardStyleGuard` 的 `{ once: true }` 改成多次触发 / 把快照改成轮询刷新。
这两种都会把卡侧动态样式吸进基线，等于关掉守护。

### 2.2 J-2：帧内拿到真实角色标识（P2）

在 `getContext.ts:1782-1791` 把真实角色标识透传进卡帧 context，让 UUID→index 映射能命中；
或按 Palink 语义**同时**暴露字符串 id 供自家插件用（ST 侧仍给数字下标，保持形状兼容）。
**~5–15 行**。约束：
- 不许为了"看起来有值"把 characterId 随便填 1 或填数组长度 ⇒ 那是假成功。
- 拿不到索引时，保持返回 0 但**必须让字符串 id 可达**，并在报告里写清"数字下标在 Palink 帧内语义不可靠，
  插件应改用字符串 id"。这条要进报告，因为它会写进后续插件文档。

## 2.3 J-3：part-08 两处模板串转义（包L 移交，2026-10-18 新增）

包L 建了「求值后载体」并实测证明：本文件在模板字符串里**单反斜杠会被求值吃掉**。
它把 part-08 的两处同款登记进了守卫 `runtime-source-carrier-fidelity.test.ts` 的
`KNOWN_ESCAPE_LOSS` 表留给本包（**行号会因包I 的改动漂移，用锚点函数名定位**）：

| 锚点 | 症状（生产实际行为） |
|---|---|
| `getTextTokens`（原 `:526`） | `String(text ?? '').split(/\s+/)` 求值后退化成"按字母 s 切分" ⇒ 帧内 token 计数是错的 |
| `firstCardErrorText`（原 `:1355`） | `.replace(/\s+/g, ' ')` 退化成折叠字母 s ⇒ 报错摘要的空白根本没被折叠 |

要求：① 两处改成**成对反斜杠**；② **删掉 `KNOWN_ESCAPE_LOSS` 里对应登记项**（守卫的 C3 会先转红提醒你，
那是预期的连带成本，不是回退信号）；③ 用求值后载体补两条行为断言（喂含空白的真串，断言切分/折叠结果），
不许再用"源码里有某个字面量"充当证据。**注释里也不要写裸反斜杠**，要提就写"反斜杠 s"这种文字形式。

## 3. 红线（违反任一即返工）

1. **`runtime-body/part-*.ts` 是注入 iframe 的模板字符串**：禁止裸反引号、禁止 `${}` 插值、
   字符串与注释里禁止裸 `\n`（要写 `\\n`）。只能是 **ES5 语法**（本段代码通篇 `var`/`function`，别引入箭头函数与 `let`）。
   `tsc` **不检查**这段字符串内部，唯一守卫是 `__tests__/generated-script-parse-guard.test.ts`。
2. **禁止用 `@` 路径别名**（帧内代码不在打包器的解析范围里）。
3. **不许动 `sanitizeStCompatCss` 净化逻辑**，不许删/弱化 `STYLE-GUARD`（未授信卡仍然需要它）。
4. **不许放宽 iframe sandbox**（P1-1 安全红线：`allow-same-origin` 只能给用户显式信任的卡，且那是包D 的范围，与包J 无关）。
5. **不碰 `frontend/dist`、不 `npm run build`、不重建后端镜像**（提交≠上线，重建 dist 归主控收尾）。
6. **零 API 成本**：真机探针的计费端点（`/api/chat`、`generate`、`/api/openai/`、`/api/extra/*`）
   一律 `page.route` 本地 fulfill，从不转发；报告里给 `blockedCount=0` 证据。
7. **包F/G/H/I 的文件不是你的**：`st-compat-commands.ts`、`part-07.ts`（F/H 地盘）、`Message.tsx` 与
   `part-08.ts` 的 `:1079-1106` 两个全局 error handler（I 地盘）**一律不动、不提交**。
   你只许改 `part-01.ts` 的 `injectStPluginCssCompat`、`part-08.ts` 的 `installCardStyleGuardInFrame` 整段、
   以及 `lib/sillytavern/getContext.ts` 的 characterId 计算段。
8. `git add -A` 禁用；只 `git commit -o -- <自己的 pathspec>`。`docs/_active/` 下主控未提交的文档不要替你带上。

## 4. 验收判据（可复跑，缺一不可）

### 4.1 静态门禁
```bash
cd frontend && npx tsc --noEmit        # 退出码 0
cd frontend && npx vitest run          # 只认 failed=0 且 errors=0；passed 数字不是验收线
```

### 4.2 新增测试（至少 2 类）
- **守护快照可追加**：帧内模拟「先拍快照（3 条基样式）→ 异步注入 5 条插件 CSS → 卡侧 `head.innerHTML=` 重写
  → 触发恢复」，断言插件 CSS **5 条全部回来**，且 `__palinkStyleGuardSnapshot` = 8。
  反向断言：卡侧自己塞进 head 的样式**不得**被当成基线恢复回来。
- **characterId**：给 `getContext.ts` 的 UUID 角色喂真 UUID + `characters` 数组，断言数字下标命中且字符串 id 可达；
  跑前先确认 `plugin-character-id.test.ts` 仍绿（它是既有契约，不许改它来迁就实现）。

### 4.3 真机复跑（**必须跑在重建后的 dist 上**，主控会在你提交后重建；若届时仍是旧 dist，
在报告里写明"待重建复跑"并把探针脚本准备好，不要拿旧 dist 的数字当"修复生效"）
```bash
# 复用包E 的探针（会话名自取；open 与 run-code 写同一条命令；输出重定向文件再读，勿 | tail）
cd .tmp_probe
playwright-cli -s=pj open http://localhost:16000 >/dev/null 2>&1; \
  playwright-cli -s=pj run-code --filename=./probe_E_styleid2.js > J_styleid_out.txt 2>&1
```
判据（露缇雅 `c28061bb-a9b7-46a9-a255-2692d57001fc`）：**t14 插件 CSS 条数 = t6 插件 CSS 条数**（都应是 5），
`<style>` 总数不再 8→3；`__palinkStyleGuardSnapshot ≥ 8`；`getContext().characterId` 不再恒 0 或字符串 id 可达（按 §2.2 采纳的方案）。

### 4.4 反证（必做，两次输出都贴报告）
1. 去掉「注入后追加快照」这一步 ⇒ 新测试**必红**。
2. 把守护改成整快照重拍 ⇒ 反向断言（卡侧样式不得进基线）**必红**。
3. 还原 ⇒ **必绿**。

### 4.5 零回归
露缇雅既有行为不动：7 帧 / Mvu 6 / `getContext` 194 键齐 / TavernHelper 76 / 状态栏帧 bodyLen / 变量变化面板；
以及「未授信卡是 opaque origin（父侧 `contentDocument === null`）」这条必须**仍然为 true**——
包J 不许改变任何卡的可信边界。

## 5. 交付物

1. `docs/_active/report/REPORT_包J_插件CSS守护与characterId_2026-10-18.md`
   ——含：改前/改后快照条数与插件 CSS 存活数、采纳的是 (a) 还是 (b)（或并用）及理由、
   若新开全局则写清全局名与归属、§4.4 反证两次的原始输出、遗留项。
2. 代码与测试提交：`git commit -o -- <pathspec>`，提交消息含代码标识时用 `-F <消息文件>`（反引号会被 bash 吃掉）。
3. 探针脚本留 `.tmp_probe/`（不进仓库）。
4. **最终回复 ≤300 字**：改前/改后数字、测试结论、反证结果、遗留项。

## 6. 明确不做

- 不改卡侧 MagVarUpdate bundle 的行为（那是第三方，且在帧内），也不去"禁止卡侧重写 head"。
- 不做信任分级 / sandbox 相关任何改动（包D 地盘，等用户拍板）。
- 不做插件 CSS 的持久化落库、不做样式快照跨帧共享。
- 不扩富卡样本（那是包K）。
