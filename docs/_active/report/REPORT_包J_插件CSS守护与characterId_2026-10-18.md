# REPORT_包J_插件CSS守护与characterId_2026-10-18

> **状态：已完工待验收**（J-3 / J-1 完工并有真机读数；J-2 完工在父侧，帧内还差一棒，见 §5）
> 施工依据：`docs/_active/HANDOFF_提示词_包J_插件CSS守护与characterId_2026-10-18.md`
> 病灶取证：`REPORT_包E_ST生态卡实测_2026-10-18.md` §4 F-1/F-2、§6；J-3 来龙去脉见
> `REPORT_包L_测试载体不保真假绿清单_2026-10-18.md` §5 #2/#3、§7.1

## 0. 三段提交号（按施工顺序 ①J-3 → ②J-1 → ③J-2，每段单独跑门禁后提交）

| 段 | commit | 内容 | 门禁 |
|---|---|---|---|
| J-3 | `9f12537` | part-08 两处模板串单反斜杠改对 + 包L 登记表清空 + C3/C4/C5 | `bash scripts/gate.sh frontend` rc=0（89 文件 / 1178 passed，failed=0 errors=0） |
| J-1 | `77df460` | 守护开只追加登记口 + 注入侧登记 + G5–G8 测试 | 同上 rc=0（35 文件 / 502 passed，failed=0 errors=0） |
| J-2 | `b6877d9` | getContext 的 UUID→下标匹配面铺开 + 字符串角色 id 可达 + 新测试 5 例 | rc=0（**91 文件 / 1205 passed | 3 skipped**，failed=0 errors=0，tsc 通过） |

⚠️ **现场纪律自述**：本包施工期间经历过一次会话中断，中断后我用 `git diff` / `grep` 重新核对现场，
发现「报告里以为已改」与「盘面上真改了」不一致（part-08 只落了第 1 处转义），已按盘面重做。
**盘面是唯一的真源，任何'我已经改过了'的记忆都要用 git diff 复核一次**——这条写进报告是为了让下一
个接手的人不再踩。

## 1. J-1（P0）插件 CSS 守护：采纳 (a)，未用 (b)

**采纳交接单 §2.1 (a) 注入侧主动登记**，理由三条：

1. 病灶本质是「快照里没有它」，不是「不知道怎么造它」——(a) 直接补登记，改动面最小；
2. (b) 要求把 `injectStPluginCssCompat` 从 part-01 的局部 `const` 提成跨 part 可调的全局，
   等于为一条兜底路径新开一个帧内全局命名空间，而 (a) 的**挂起队列**已经把 (b) 想覆盖的
   少数路径（插件 CSS 早于快照登场）吃掉了：`__palinkStyleGuardAddNode` 在快照未拍时不丢弃，
   先入队，`startCardStyleGuard` 拍完快照立刻补登记；
3. 实测上 (a) 已把包E 的靶子打穿（§2 真机读数），没有 (b) 的必要性证据。**没有新开
   `injectStPluginCssCompat` 的全局别名**，跨 part 接缝只多了一个函数。

### 改了什么

- `runtime-body/part-08.ts` 的 `installCardStyleGuardInFrame` IIFE（只碰这段）：
  - 新增闭包 `styleGuardExtraNodes` / `styleGuardPendingNodes` 与
    `styleGuardSetSnapshotCount` / `styleGuardPushExtraNode` / `styleGuardAddNode` /
    `styleGuardFlushPendingNodes`；
  - **新开的全局名与归属**：`window.__palinkStyleGuardAddNode(node)`
    —— 归属就是 `installCardStyleGuardInFrame` 这个 IIFE 本身，随守护安装时赋值，
    帧内其他段（现只有 part-01）只读调用；
  - 新增观测面 `window.__palinkStyleGuardPluginCss`（插件节点登记次数）；
    `window.__palinkStyleGuardSnapshot` 语义由「基线条数」改为「**基线条数 + 追加条数**」；
  - `restoreCardStyles()` 恢复改两趟：先补基线快照，再补登记过的插件节点；
  - `styleGuardPushExtraNode` 对**已在基线里的同一节点**与**已登记过的同一节点**都去重，
    防止同一个 id 的 style 被补两次。
- `runtime-body/part-01.ts` 的 `injectStPluginCssCompat`（只碰这一处）：每条插件 `<style>`
  `appendChild` 成功后 `typeof window.__palinkStyleGuardAddNode === 'function'` 判定后再调，
  守护缺席/异常**一律不影响注入本身**。
- **没有做**：重拍快照、轮询刷新快照、把 `{ once: true }` 改成多次触发（交接单禁止项）；
  没有动 `sanitizeStCompatCss`、没有弱化 `STYLE-GUARD`、没有动 iframe sandbox。

## 2. J-1 真机读数（露缇雅 `c28061bb-…001fc`）

**读数来源 = dev 探针（vite `--config ../.tmp_probe/vite.fprobe.config.ts --port 5204`，
入口 `http://localhost:5204/characters/<cid>`），16000 上跑的都还是旧 dist。**
⇒ 「提交 ≠ 上线」这条没被绕过：**主控重建 dist 后必须按同一探针复跑一次**才算用户侧生效。

| 指标（每帧） | 包E 实测（旧 dist，病灶） | 本包 dev 探针 t6 | 本包 dev 探针 t14 |
|---|---|---|---|
| `<style>` 总数 | t6 **8** → t14 **3** | 3 | **9 / 10**（7 帧全部） |
| 插件 CSS 条数（`data-palink-st-plugin`） | t6 **5** → t14 **0** | 0（此时还没注下来） | **5**（7 帧全部） |
| `__palinkStyleGuardSnapshot` | — | 3 | **8**（判据 ≥8 ✓） |
| `__palinkStyleGuardPluginCss` | 无此键 | — | **5** |
| `typeof __palinkStyleGuardAddNode` | 无此全局 | **function** | function |

插件 CSS 存活清单（t14，7 帧一致）：`Chat Translation:122` / `Regex:3455` / `Summarize:755` /
**`Quick Replies:44839`** / `Token Counter:199` —— 正是包E 点名被抹掉的 5 条，最大那条 44,839B 也在。

**判据达成**：t14 插件 CSS 条数（5）= 注入后应有效果不丢；`<style>` 不再 8→3；Snapshot=8。
注：本包这一趟 t6 采到的是「插件 CSS 尚未下发」的时刻（注入发生在 t6–t14 之间），
所以「t14 条数 == t6 条数」这条等值判据在**这一趟**的读数是 5 vs 0，
真正被证明的是**注入发生之后它没有被抹掉**（包E 的病灶形态是 6–14s 内从 5 掉到 0）。
重建后复跑建议把 t6 延到 8s 再采一次，让等值判据在同一个时间基线上成立。

**零 API 成本**：探针 `page.route` 拦计费正则命中 **1 次**，是 `/api/ws/ticket`
（被 BILL 正则里的 `ws` 分支命中，属取票接口、非计费端点）；该请求被本地 fulfill、**从未转发**
⇒ 打到计费后端的请求数 = 0。口径与交接单的 `blockedCount=0` 差 1，差的就是这一条，如实登记。

## 3. J-3（包L 移交的债）

- `part-08.ts` 的 `getTextTokens`：`split(/\s+/)` → `split(/\\s+/)`；
  `firstCardErrorText`：`replace(/\s+/g, ' ')` → `replace(/\\s+/g, ' ')`。
  与 `part-07.ts` 同名实现的成对写法对齐；注释里不写裸反斜杠（用「反斜杠」文字形式）。
- `runtime-source-carrier-fidelity.test.ts`：
  - `KNOWN_ESCAPE_LOSS` 两项登记**已删除**，表本身保留并显式标注类型
    （空表 + C1 的「表外一个都不许多」口径不变）；
  - C3 从「缺陷在案证明」改写为**修复后的文本钉**（产物里必须是 `split(/\s+/)` 形态、
    且不许残留 `split(/s+/)`）；
  - 按交接单要求补 **C4 / C5 两条行为断言**：从**求值后载体** `COMPAT_V2_RUNTIME_ARTIFACT`
    里抠出那行表达式交给 `new Function` 真跑（入参只有本仓构建产物，不含任何外部/用户数据），
    喂含空白与多行的真串断言切分/折叠结果——不再拿「源码里有某个字面量」当证据。

## 4. 反证（三项，原始输出都留 `.tmp_probe/`）

| # | 改坏动作 | 结果 | 原始输出 |
|---|---|---|---|
| 1 | `styleGuardAddNode` 入口加 `return;`（等价于去掉「注入后追加快照」） | **rc=1，2 failed**：`G5 … AssertionError: expected 3 to be 8`、G6 红 | `.tmp_probe/J_np1.txt` |
| 2 | `restoreCardStyles` 改成整快照重拍（`styleSnapshot = takeStyleSnapshot()`） | **rc=1，6 failed**（含反向断言 G6「卡侧动态样式不得进基线」） | `.tmp_probe/J_np2.txt` |
| 3 | `getContext.ts` 的 `findIndex` 退回旧的两字段匹配 | **rc=1，2 failed**（J2-2 avatar 命中、J2-3 多键名命中） | `.tmp_probe/J_j2_np.txt` |
| — | 全部还原 | **rc=0**：`.tmp_probe/J_c3_restore.txt` 17 passed、`.tmp_probe/J_green_restore.txt` 35 文件 502 passed、`.tmp_probe/J_j2_restore.txt` 5 passed | 同左 |

J-3 的第 4 条反证（改回单反斜杠 → 守卫红）也已做过：`.tmp_probe/J_c3_negative.txt` rc=1，
三条 Assertion（C1 登记表外新增、C2/C3 产物形态）。

## 5. J-2：父侧已修，**帧内还差一棒**（本节是交接给主控的待办）

已做（`lib/sillytavern/getContext.ts` 的 characterId 计算段，只碰这段）：

- UUID→下标匹配面从 `c.id / c.name` 铺到 `id / name / character_id / uuid / avatar`
  （含 `palink-<uuid>.png` 形态与裸包含匹配）⇒ `characters` 里有这张卡时**数字下标命中**；
- 命中不了时照 ST 语义**保持 0，不填假值**；
- 新增同值双名的字符串身份：`context.characterIdString` 与 `context.palink_character_id`
  （camel / snake 两种插件写法都读得到），`StGetContext` 接口同步声明；
- 数字 `characterId` 原样透传、`thisChid` 同值，均不回归；
- 新测试 `lib/sillytavern/__tests__/plugin-frame-character-id.test.ts` 5 例；
  **既有契约 `plugin-character-id.test.ts` 一字未改且仍绿**（它管的是存储分区派生数字 id，
  与本包的「下标/字符串身份」是两件事，不要混）。

**真机实测把这条钉死了**（`.tmp_probe/J_ctx_out.txt`、`J_winctx.txt`）：

- 父侧 `getContext()`：`characterId = 2039469051`（来自 `pluginCharacterIdFromUuid` 的派生 id）、
  `charactersLen = 0`，**没有** `characterIdString` 键；
- 卡帧内：`window.context.characterId = undefined`、`getContext().characterId = 0`、
  `window.characterId = undefined`、`window.context.characters` 长度 0；
  帧内 `getContext()` 仍是 **194 键**、`window.Mvu` 仍是 **6 键**。

⇒ **结论订正（这条比交接单更硬）**：包E F-2 的定位「UUID→Number 失败 → 兜底 0」只是**下游症状**。
真实断点是 **Palink 的角色标识压根没有进卡帧**——`SillyTavernCompatRuntime.ts:176` 写的是
`characterId: context.characterId || ''`，而进来的 card context 里没有这个值，于是帧内
`window.context.characterId` 直接 undefined，帧内 `getContext()`（`part-08.ts` 包G 的 G-1 区域）
读 `window.characterId` 拿不到任何东西，才恒为 0。

**为什么我不顺手把它修了**：交接单红线 §3.7 限定我只能动三处
（`part-01.injectStPluginCssCompat`、`part-08.installCardStyleGuardInFrame` 整段、
`getContext.ts` 的 characterId 计算段）。这一棒要动的是
`SillyTavernCompatRuntime.ts` 的 boot/context-update 白名单 **和** `part-08.ts` 里包G 的
G-1 帧内 `getContext` 区域，两处都不在我的地盘；`SillyTavernCompatRuntime.ts` 与
`CharacterCardRenderer.tsx` / `storage.ts` 同属**并行的包D** 的作业面，我一行没碰。

**建议主控派的下一棒（最小改法，两处各 1–3 行）**：
1. 父侧把真实角色标识塞进下发给卡帧的 context（`context.characterId` 目前为空/未带）；
2. 帧内 `getContext()` 在保持 `characterId` 为数字（拿不到就 0）的前提下，
   透出同样的 `characterIdString` / `palink_character_id` 两个键，与父侧形状一致。
   ⚠️ 这条落地时要顺手复核 `getcontext-parity.test.ts`（实测 19 passed / 145/145 契约，
   它是否按固定键数设线未知）。

**要写进后续插件文档的口径**（交接单 §2.2 要求）：
**数字 `characterId` 在 Palink 卡帧内语义不可靠，插件应改用字符串 id**。

## 6. 剩余项

1. **重建 dist 后复跑探针**（本包全部真机读数来自 5204 dev 探针，16000 仍是旧 dist）。
   复跑脚本已备好：`.tmp_probe/probe_J_styleid.js`（J-1 存活计数 + 守护观测面）、
   `.tmp_probe/probe_J_ctx.js` / `probe_J_winctx.js`（J-2 身份链路），会话名 `pj`。
   建议把 t6 采样点从 4s 推到 8s，让「t14 条数 == t6 条数」在同一时间基线上成立。
2. **J-2 帧内那一棒**（§5，需包D/包G 地盘，交主控派单）。
3. **TavernHelper 读数未按包H 口径复核**：我的探针读 `window.TavernHelper.registered_commands`
   /`Object.keys` 得 **0**，与包H 报的「134 命中 58」不是同一个口径（我这一趟没测到它，
   **不等于它回归**）。零回归清单里这一条**未由本包证实**，请用包H 的探针口径复跑。
   其余零回归项本包实测在位：7 帧、`getContext` 194 键、`Mvu` 6 键。
4. **未授信卡边界未变（本包实测仍为 true）**：`t6`/`t14` 两趟父侧均
   `iframes=7, opaqueOrigin=7, sameOriginReadable=0` ⇒ 每个卡 iframe 的
   `contentDocument === null` 全部成立，可信任读取 0 个。
5. `.tmp_probe/` 下本包新增文件一律不入库；`vite.fprobe.config.ts` 仍按约定留在工作区。
