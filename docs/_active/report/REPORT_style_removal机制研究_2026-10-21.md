# REPORT · `style_removal[node_removed]` 机制研究（只读）_2026-10-21

> **状态：只读研究，未改任何代码；结论供用户裁定降噪档位。**
> 本轮不判定"要不要降噪"（那是产品裁定，见 `REPORT_批次小尾巴_CSS生成器与沙箱读写同域_2026-10-21.md` §5），
> 只回答机制层六个问题。所有结论标注「代码级」或「实测级」，实测级都附命令与读数。
> 探针脚本留在 `.tmp_probe/`（`analyze_style_removal_log.py` / `analyze_style_removal_cycles.py` /
> `analyze_wave_context.py` / `analyze_live_console.py` / `analyze_live_timeline.py` /
> `style_removal_mechanism.js` / `style_removal_snap.js` / `who_moves_styles.js` /
> `who_moves_styles_v3.js` / `where_do_styles_go.js` + 同名 `.out.txt`）。

## 0. 一句话总结（先给结论）

**这 840 条不是"卡把样式删了"，是"卡把样式搬家"被取证面当成了删除。**
搬家的执行体是**我们自己的 jQuery 兼容层**（`part-04` 的 `collection.append` → `appendChild`），
发起方是卡自带 MVU（MagVarUpdate）bundle 的 `$(容器).append($('head 里的 style'))` → 随后 `appendTo(head)` 搬回。
同一条腿的"搬回"在 MutationObserver 里是一条 **只带 addedNodes 的 record**，
被取证面的 `if (!removed || !removed.length) continue` 直接跳过 ⇒ **上报天然是半程的**。
插件样式在稳态里 **5/5 健在、全在 head 子树内、字符数与上线判据逐条一致**，
而且**两层样式守护这次一条都没参与**（实测 `__palinkStyleGuardRestored` 缺席、宿主 `restored: 0`）。

---

## 1. 谁在报

**结论**：帧内模板串里的一段 `installStyleRemovalForensicsInFrame` IIFE 报的文本，
经 `window.parent.postMessage` 送到宿主，由 `CharacterCardRenderer` 的 `console.error` 打成那行前缀。

代码级物证（`runtime-body/` 是注入 iframe 的模板字符串，tsc 看不到内部，锚点一律用函数名）：

| 位置（文件:行 / 函数锚点） | 作用 |
|---|---|
| `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-08.ts:1766` `(function installStyleRemovalForensicsInFrame()` | 取证观察器本体（包N ② 2026-10-19 建） |
| 同文件 `:1767` `var STYLE_REMOVAL_MAX_REPORTS = 24;` | 每份**帧内文档**的顶格额度 |
| 同文件 `:1810` `function handleStyleRemovalRecords(records)` | 记录筛取与拼消息 |
| 同文件 `:1836-1839` `var message = 'style_removal[' + kind + '] removedStyledCount=' …` | 就是控制台那串文本 |
| 同文件 `:1842-1859` `window.parent.postMessage({ source: 'palink-smart-card-frame', type: 'frame-error', errorReason: 'style_removal_forensics', node: {…} }, '*')` | 出帧通道（只 postMessage，不 `console`、不 toast、不 `palinkDiagRecord`） |
| 同文件 `:1867-1870` `styleRemovalObserver = new MutationObserver(...); observe(document.documentElement, { childList: true, subtree: true })` | **观察整个文档**，不只 head |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx:1024` | 父侧只认 `source === 'palink-smart-card-frame' && data.frameId === frameIdRef.current` |
| 同文件 `:1050-1053` | 写 `window.__palinkFrameErrors`，**上限 50 条** |
| 同文件 `:1055` `console.error(\`[smart-card ${frameIdRef.current.slice(0, 8)}] 卡内错误:\`, …)` | 打出 `[smart-card palink-s]` |
| 同文件 `:202` `useRef(\`palink-smart-card-${randomFrameToken()}\`)` | ⇒ **`palink-s` 不是某一张卡**，是 `palink-smart-card-…` 的前 8 字符，**所有帧共用这个前缀**（用它没法区分帧） |

实测级物证（同一份字符串确实来自该函数、且确实跑在生产产物里）：

```bash
grep -c style_removal .playwright-cli/console-2026-10-21T15-21-21-376Z.log   # 504（我 3 次加载各 168）
grep -n "style_removal" frontend/src -r                                       # 唯一代码命中 part-08.ts:1836
```

**没能确证的部分**：无。文本产生点唯一。

---

## 2. 判据是什么

**结论**：判"有样式"= 只看标签名 ∈ {STYLE, LINK, HEAD}；**没有任何去重**，只有一条 24 次的文档级封顶。

代码级（均在 `part-08.ts`，行号同第 1 节文件）：

| 字段 | 定义位置 | 真实含义 |
|---|---|---|
| `removedStyledCount` | `:1818-1821` + `styleRemovalIsStyledNode` `:1805-1808` | 本条 record 的 `removedNodes` 里 tagName/nodeName 为 `STYLE`/`LINK`/`HEAD` 的**个数**；不看有没有内容，不看是否真的生效 |
| `addedCount` | `:1824`、`:1837` | `record.addedNodes.length` **原样长度**（含文本节点/注释），与 `addedStyled`（`≤12` 条抽样，`:1826`）不是同一个数 |
| `target=HEAD#-` | `:1829-1833` `styleRemovalNodeIdentity({tagName: record.target.nodeName, id: record.target.id})` | 被改动的**父节点**；`#-` = 无 id。HEAD 无 id ⇒ 永远打 `HEAD#-` |
| `first=STYLE#<id>` | `:1835` `removedStyled[0]` | 只报**第一个**被摘节点的身份；同批还有别的也只报第一个 |
| `textLen` | `:1799-1800` + `styleRemovalByteLen` `:1771-1774` | `String(node.textContent).length` —— **UTF-16 码元数，不是字节**（函数名叫 ByteLen 是历史遗留） |
| `kind` | `:1834` `addedStyled.length ? 'node_replaced' : 'node_removed'` | ⇒ `node_removed` = 这条 record **只有移除没有新增**，不代表节点被销毁 |
| `filename` | `:1840` `first.attrs.href \|\| first.id` | 属性只采 `data-*`/`id`/`rel`/`href`，上限 12 条（`styleRemovalKeyAttrs` `:1776-1791`） |

去重与重复上报条件：

- **没有去重键**（代码级：`:1810-1862` 全文无 seen/hash/map；`styleRemovalReportCount += 1` 在 `:1860` 只是自增）。
- 唯一的抑制是 `:1812` 与 `:1814` 的两处 `>= STYLE_REMOVAL_MAX_REPORTS` 早退 ⇒ **每份帧内文档最多 24 条**。
- 计数器是 IIFE 闭包变量 ⇒ **帧文档重建即归零**（这是第 3 节 840 的来源）。
- 重复上报同一节点的现实条件：同一节点被再次摘走（搬家第二轮、守护回灌后再搬），或该文档重新装载。

实测级（重复上报确实发生）：`.tmp_probe/where_do_styles_go.js` 读数
`removals: 48`、24 个身份各 `x2` ⇒ **同一份文档里同一批节点被摘了两次**，控制台只见到前 24 条。

---

## 3. 为什么会到 840 条

**结论**：**840 = 35 × 24** —— 35 次「帧文档装载」各顶格 24 条；
不是"多 observer/多帧各报一次同一删除"，也不是"一次真删除报一次"，
而是**一次"整批 head 样式搬家"就吃掉 24 条额度（每节点一条 record）**。

拆解（对 用户给的同一份日志复核，命令 `py .tmp_probe/analyze_style_removal_log.py` / `…cycles.py`）：

```
TOTAL_STYLE_REMOVAL 840          KIND {'node_removed': 840}        TARGET {'HEAD#-': 840}
CYCLES_BY_24 35  remainder 0      每轮：len=24 distinct=24 pluginCss=5 cg=1 anon=18
FIRST  STYLE#- 630 | STYLE#palink-st-plugin-css-<UUID>-0 175 | STYLE#tavern-cg-album-style 35
FIRST_TEXTLEN_DISTINCT_NODES 25   （23 个身份各 35 次 + 10773 出现 25 次 + 6622 出现 10 次 = 840）
```

- **每轮构成**：18 条匿名 `<style>` + **5 条 `palink-st-plugin-css-<uuid>-0`** + 1 条 `tavern-cg-album-style`。
  5 = 沙箱注入的 5 个插件样式块（与上线判据 `pluginCss=5 nonEmpty=5` 同一批，见第 4 节实测字符数逐条相同）。
- **每轮 = 一份帧文档**：与 35 次一致的**每次文档装载**才有的标记，在同一份日志里全部是 35：
  `[INFO] 变量结构注册成功` ×35、Chrome 的 `An iframe which has both allow-scripts and allow-same-origin` 警告 ×35、
  `[SpriteAnimationManager] GSAP未预装` ×35、`LiveND` ×35、`[QRN] sets: []` ×35（`py .tmp_probe/analyze_style_removal_cycles.py` 的 `DISTINCT_SIGNATURES` 段）。
  ⇒ **文档数与轮数都是 35，一一对应**（封顶 24/文档，所以 35 轮不可能是 35 轮以内的文档数）。
- **时序**：5 个波次 × 每波 7 帧 = 35。波起点 `t≈24.005s / 53.43s / 123.55s / 137.40s / 196.02s`
  （`py .tmp_probe/analyze_wave_context.py`）；每波 24 条落在 1–25ms 内（24005→24022），
  且紧跟在该批 7 条文档装载标记之后 `+0.17s ~ +2.5s` ⇒ **搬家发生在帧启动后 0.2–2.5 秒**，
  与 `style-guard.ts:4-9` 记述的"插件 bundle 跑起来后 3~5 秒重置 head"同一时间窗。
- **两次页面加载的分配**：`minute0=818 / minute2=729 / minute3=386` 行；轮数 = 第 1 次加载 2 波（336 条）+ 第 2 次加载 3 波（504 条）。
- **波次的成因 = 帧文档被重建**（代码级候选，按此顺序排查）：
  `CharacterCardRenderer.tsx:1513` `iframeKey = \`${frameIdRef.current}-${effectiveMode}-${sourceFingerprint}\``
  （`:1576`/`:1702` 作 `key`）与 `:628` `srcDoc` 依赖
  `[srcDocHtml, isFullDocument, customCss, effectiveMode, prefersImmersive, resourcePlan, assetModeVersion]`；
  `sourceFingerprint` 只随 `html/customCss` 变（`:296-299`），`:1926` 的 120ms 防抖把流式期间 N 次重载收敛成 1 次。
  ⇒ **聊天里每"落定一次正文/资源计划"，7 张卡同时重建 7 份文档，同时再来一轮 24 条**。
- **排除休眠门**：`dormancy-gate.tsx:26` `PALINK_CARD_DORMANCY_UNMOUNT = false`（只隐藏不卸载）。
  实测同一页面 `dormancyCounts: {sleeping: 4, awake: 1}` 而 `iframeCount: 7` ⇒ **休眠中的帧照样上报**，与门无关。
- **排除 SSE/生成**：本轮探针全程 abort 掉 `generate|completion|/chat|stream|sse|roleplay/send` 的 POST，
  仍稳定复现 **7 帧 × 24 = 168 条/次加载**（`grep -c style_removal` 于 `console-2026-10-21T15-21-21-376Z.log` = 504 = 3 次加载 × 168）。
  ⇒ **零生成也能刷屏**，纯卡片渲染期行为。

**没能确证的部分**：用户日志里 5 个波各自的确切触发原因（`resourcePlan` 晚到 vs 正文变化 vs `assetModeVersion`）
—— 控制台没有留下"为什么重建"的标记，需要给 `srcDoc` 重建加留痕才能事后区分，本轮不改码无法确证。

---

## 4. 那 175 条是不是真事故（最关心的一条）

**结论：不是事故。插件样式既没丢、也没被"补回"——它压根没被销毁，只是被 `appendChild` 搬了一趟又搬回原处；
175 条只是取证面记录了往返的**前半程**。严格说存在一个微任务级窗口，但样式元素全程 `isConnected=true`，CSS 照常生效。**

### 4.1 谁注入、注入到哪个文档

代码级：`runtime-body/part-01.ts:1132-1158` `injectStPluginCssCompat()`
- `:1138` `const styleId = 'palink-st-plugin-css-' + String(plugin.id || plugin.name || index)…+ '-' + index;`（UUID = DB 插件 id）
- `:1144` `(document.head || document.documentElement).appendChild(style);` ⇒ **注入的是卡帧文档**，不是宿主文档
  （全仓 grep `palink-st-plugin-css` 的**生产代码命中只有 `part-01.ts:1138` 一处**，其余全是测试与文档 ⇒ 宿主文档里没有这些 id）
- `:1151-1155` append 成功后立刻 `window.__palinkStyleGuardAddNode(style)` 向帧内守护登记（包J J-1 的"只追加登记通道"）

### 4.2 谁把它们摘走、用什么 API

实测级（`.tmp_probe/where_do_styles_go.js`，帧内同步钩子 + 微任务里查连通性；会话 `styleremoval1`，零生成）：

```
--frame 0 {removals: 48, connectedAfter: 48, droppedAfter: 0, parents: {"DIV#-": 48},
           hookHits: {appendChild: 45}, headStyled: 24, docStyled: 24, docStyledInHead: 24,
           pluginCssAnywhere: 5, pluginCssInBody: 0, guardRestored: "absent", guardSnapshot: 8}
```

7 帧读数：frame0-2 `removals 48`（24 节点各搬 2 次）、frame3-6 `removals 0`（这批没跑到搬家那步）；
**所有帧 `droppedAfter: 0`** —— 被"摘走"的节点在微任务时刻**都还连着文档**，父节点是 `<DIV>`（无 id）；
钩子命中只有 `appendChild`，`removeChild / insertBefore / replaceChild / ChildNode.remove/replaceWith/before/after /
replaceChildren / head.innerHTML=` **全部 0 命中** ⇒ 移除是 `appendChild(已有节点)` 的副作用 = **移动**，不是删除。

搬家的执行体是我们的兼容层：
`runtime-body/part-04.ts:868-877` `collection.append = function(value){ … node.appendChild?.(item) … }`，
`part-04.ts:724-729` 的注释直接写了卡侧这个模式：
「卡侧『**建容器 → 把 head 里的 style 塞进容器 → appendTo head**』因此样式永远回不到生效文档」（修复前是"搬不进"，修复后是"搬得动"）。
发起方（一手归因来自既有台账，非本轮新证）：`docs/OPEN_ISSUES.md` **[P2-12] 第 10 行**——
「归因定案：163 次命中**单一调用方**（卡自带 `MagVarUpdate@beta` CDN bundle，`DOMContentLoaded` 时 `$(容器).append($('head 里的 style'))`），走 `part-04` 的 `collection.append` → `appendChild` 搬运」。

### 4.3 有没有代码把它们补回去 —— 有两层，但这次一层都没动

| 守护 | 代码位置 | 观测面 | 本轮实测 |
|---|---|---|---|
| 帧内（权威实现） | `part-08.ts:1559` `installCardStyleGuardInFrame` / `:1656` `restoreCardStyles` / `:1677-1684` 恢复"只追加登记"的插件自有节点 / `:1618` `__palinkStyleGuardPluginCss` / `:1687` `__palinkStyleGuardRestored` | `__palinkStyleGuardSnapshot / PluginCss / Restored` | `guardSnapshot: 8`、**`guardRestored: "absent"`（7/7 帧、4 次采样都缺席）** |
| 宿主侧（同源时才装得上） | `smart-card-runtime/style-guard.ts:41` `installCardStyleGuard`，调用点 `CharacterCardRenderer.tsx:799`（`:780` `prefersImmersive` / 读不到 `contentDocument` 时直接 return） | 宿主 `window.__palinkStyleGuard` | `{installed: 7, restored: 0, lastRestoreAt: 0}` |

⇒ **稳态样式不是守护救回来的，是卡自己第二条腿搬回来的**；守护的 5 条登记（`guardPluginCss=5`、`Snapshot=8=3 基线+5 追加`）只是**备用的第二重保险**，本轮没触发。

### 4.4 稳态判据（语义判据，不是"页面里 style 总数"）

`.tmp_probe/style_removal_snap.js` 在风暴之后（同页 7 帧，逐帧）：

```
pluginCss: 5                    guardSnapshot: 8   guardPluginCss: 5   guardRestored: absent
pluginCssIds: [-ff625696-…-0:122, -db0c6324-…-0:8631, -ffb782eb-…-0:755, -228185ea-…-0:44839, -6a8725df-…-0:199]
cgAlbum: true   galgame: true   host{iframeCount:7, readable0:true, guardAttrCount:7}
```

**这 5 个字符数（122 / 8631 / 755 / 44839 / 199）与 175 条日志里被"摘走"的那 5 条 `textLen` 逐条相同**，
也与既有上线判据 `pluginCss=5 nonEmpty=5` 一致（`OPEN_ISSUES.md` [P2-12]#12 的「插件 CSS t8→t16 恒 **5/5**」）。
⇒ 同一批节点回来了，且内容非空、字节数没变。

### 4.5 一个必须记下的自相矛盾（不掩饰）

带插桩的第 2、3 次加载（`.tmp_probe/who_moves_styles.js` / `_v3.js`）稳态 `headStyled` 只有 **9–10**
（无插桩的第 1 次 = 25，v4 = 24），而这两次**控制台同样各出 168 条**
（`py .tmp_probe/analyze_live_timeline.py`：`REM 168` 落在 t=211s 与 t=293–295s 两簇），
且 v3 的钩子当时报 `moRemovals 0 / hits {appendChild: 6}`。
**我没能解释这个差异**，最可能是我自己在 `initScript` 里覆写 `Node.prototype.appendChild`/`innerHTML` setter
改变了第二条腿（搬回 head）的时机或形态（探针扰动，非产品行为）。
**不影响本节的承重结论**：5 条插件样式在**四次独立加载里都是 5/5、都在 head 子树内、`pluginCssInBody=0`**；
差异只在卡自己那批匿名样式的落点。⚠️ 若有人要拿 `headStyled` 当回归线，先注意它会随卡片行为漂（实测 9/10/24/25 都出现过）。

---

## 5. 那 35 条 `tavern-cg-album-*`

**结论：不是"图鉴自己搬自己"，它是同一批 24 条里的一个受害者**——被 MVU 的"整批扫走 head 所有 `<style>`"一起搬走的，
和我们的 5 条插件样式是同一只手、同一条腿、同一个容器。

- 实测级：`where_do_styles_go.js` 的 `idents` 里 `STYLE#tavern-cg-album-style:12140 x2`
  与另外 23 条一起各 `x2`、同 `parents: {"DIV#-": 48}`；`cgAlbum: true`（稳态在位，12,140 字符）。
- 实测级：`grep -c` 于 840 条日志 = 35 条 = 每轮恰好 1 条（35 轮），身份固定 `textLen=12140`。
- 代码级：搬手的实现见第 4.2 节（`part-04.ts:868-877`）；`tavern-cg-album-style` 在**我们仓库里没有任何生产代码引用**
  （`grep -n tavern-cg-album` 的生产命中只有 `part-08.ts:1755` 的一句注释 + 测试夹具 `style-removal-forensics-contract.test.ts:110`），
  ⇒ 它是卡自带正文里的 id，不在我们代码里。
- 既有归因（二手，已核对原文）：`REPORT_ST适配体检_三轨并一轨后渲染回归_2026-10-18.md:68` 记过**另一条独立路径**——
  卡自己的 `相册` 脚本里有 `destroyAll()`，会 `topDoc.getElementById('tavern-cg-album-style')` 后移除。
  **本轮实测没看到这条路径的证据**（48 次移除 0 次 `droppedAfter`，即没有一次真的离开文档）。

**没能确证的部分**：卡侧脚本正文不在仓库（且本轮按纪律不读卡片正文），
所以我给不出"图鉴代码自己搬自己样式"的 file:line；只能说**在这张卡、这几轮里，动它的是 MVU 的批量往返，不是图鉴自身**。

---

## 6. 如果按去重改，会碰哪些既有守卫/判据（只分析，不动手）

### 6.1 判据键的选择与风险

现成可用字段只有 `part-08.ts:1793-1803` 采到的 `{tagName, id, attrs(data-*/rel/href), textLen}`。

| 候选键 | 可行性 | 风险（有实测支撑） |
|---|---|---|
| `id` 优先 | 只有 6/24 条有 id（5 条插件 + cg），18 条匿名样式使不上 | 匿名那 18 条仍会每条重复 ⇒ 去重后仍 ≈ 18×文档数 |
| `textLen` | 匿名节点也拿得到 | **同一文档内它会漂**：840 条日志里 23 个身份恒定 35 次，而 `10773` 出现 25 次、`6622` 出现 10 次 ⇒ "第 24 名位置落的是谁"本身不稳定，长度键会把**不同节点并成同一键**（伪合并） |
| 内容哈希 | 语义最准 | 同步读 `textContent`：单条最大 **100,846** 字符，另有 44,839/15,483/12,094……×7 帧×2 轮，全在**帧主线程**上；模板串里还得自写 ES5 哈希（禁 `crypto.subtle` 异步）。为降噪引入这个成本，方向反了 |
| 「同一节点只报首次」= 记 `removedNodes[0]` 的 WeakSet | 最便宜、语义最贴 | WeakSet 存活期 = 文档期，符合"每文档一次"的取证粒度；但**搬家第二轮（48→24 已被封顶截掉）就不再可见**，而"搬了两次"恰是 K-1 归因关心的信息 |
| 「首次 + 累计次数」 | 保留量级 | 现消息体 `:1836-1839` 里没有次数字段，加字段就动消息文本 |

**必须一并知道的相互作用**：现封顶 `STYLE_REMOVAL_MAX_REPORTS = 24`（`:1767`）已经**截断**了一次真实事件
（实测 `removals 48` 只报 24）。去重后 24 条额度会被"不同的 24 个身份"占满，
⇒ **新旧日志不可比**，任何拿历史 168/840/42 这些数字做对照的排查会失效（`REPORT_包N…:51` 的「42x node_removed」、
`REPORT_控制台报错九类定性_2026-10-21.md:181` 的「7 帧 × 24 = 168，全部顶格」都是这种对照）。

### 6.2 会被打红的既有测试（逐个核过）

| 测试 | 钉的是什么 | 去重怎么碰它 |
|---|---|---|
| `__tests__/style-removal-forensics-contract.test.ts:67`、`:186-193` | 必须能从求值后产物里按 marker `(function installStyleRemovalForensicsInFrame()` 切出 IIFE；区里必须含 `removedStyled: removedStyled`、`node_replaced`、`node_removed`；区里**禁止出现** `restoreCardStyles`/`reportDiagnostic`/`takeStyleSnapshot` | 改消息体不动 marker 就安全；若把去重状态挂到守护全局（`__palinkStyleGuard*`）或改去调用守护 ⇒ 立刻红 |
| 同文件 `:124`、`:126-131` | `message` 必须 `toContain('removedStyledCount=1')`，`node.removedStyled[0]` 的 `tagName/id/textLen/attrs` 必须在 | 把字段改名/换成 `styledCount=`/`count=` ⇒ 红；只加字段（`repeatCount=`）不破 |
| 同文件 `:169-183` | 40 次删除后 `removals.length ≤ 24`；且**不得写** `__palinkStyleGuardRestored` / `__palinkStyleGuardSnapshot` | 去重后条数变小仍满足 ≤24；但若去重逻辑"顺手"更新守护观测面 ⇒ 红（这条是包N 红线） |
| `__tests__/palink-diag-silent-point-guards.test.ts:31`、`:38-51` | 静默 catch 基线：`part-08.ts` 的 `max = 50` | **实测现值 49，只剩 1 格余量**（我用该测试自己的正则 `catch\s*(?:\([^)]*\))?\s*\{\s*(?:/\*[\s\S]*?\*\/\s*)*\}` 复算同一文件 = 49）。去重书写的 try/catch 若写成空 catch ⇒ 50→51 直接红 |
| 同文件 `:9`、`:53-60` | `compat_catch_swallowed` 出现次数必须**恒等于**站点名单数；站点名必须在求值后载体里逐条出现 | `part-08.ts` 现在这个计数是 **0**（实测 `t.count('compat_catch_swallowed') = 0`）；若给去重加留痕记录，站点名单与测试里的 `CATCH_SITES` 必须同步扩，否则红 |
| `__tests__/style-guard-inframe-contract.test.ts:247-248` | 产物里 `takeStyleSnapshot()` 出现次数必须 = 2（1 定义 + 1 调用） | 去重若引入"重拍快照"式实现（历史上被明令禁止，见 `part-08.ts:1571-1573`、`:1588-1593`）⇒ 红，而且这条是**故意的红线** |
| `__tests__/runtime-body-template-literal-guard.test.ts:35` | `part-01..08.ts`（含注释）禁反引号 / `${` | 去重代码写在 part-08 模板串内 ⇒ 只能用 ES5 字符串拼接、禁模板字面量、单反斜杠会被求值吞掉 |
| `__tests__/runtime-source-carrier-fidelity.test.ts:91-97` | 该文件"定位用代码片段而不是行号"，且转义保真 | 并行包在改 part-08，行号会漂；改动说明要写锚点不写行号 |
| `__tests__/frame-error-reporting-contract.test.ts:56-76`、`i-resource-load-failure-contract.test.ts:198-202` | 帧内出证必须走 `type: 'frame-error'` 这个形状，父侧要透传 `filename/lineno/colno/kind/errorReason/node` | 去重若改成"只计数不发消息"（第 3 档降噪），这些形状断言不红，但 `CharacterCardRenderer.tsx:1043-1047` 的入站兜底逻辑与 `__palinkFrameErrors` 条目形状会变成死码 |

### 6.3 判据/文档口径（不是测试，但会被引用）

- `CharacterCardRenderer.tsx:1053` 的 `__palinkFrameErrors` **上限 50** —— **实测已被 style_removal 100% 占满**
  （`{frameErrorsLen: 50, removalInFrameErrors: 50, reasons: {style_removal_forensics: 50}}`）。
  ⇒ 这条取证缓冲**现在正被自家取证面淹掉，别的卡内报错一条都进不去**。降噪的实质理由在这里，不是"看着烦"。
  反向风险：一旦去重腾出缓冲，历史排查里"__palinkFrameErrors 只有 50 条且全是 style_removal"这个特征会消失。
- `docs/OPEN_ISSUES.md` **[P2-12] 第 10/12 行**把这套上报当作 K-1 归因链的**证据载体**（第 12 行遗留②
  还想"给搬运路径加一次性留痕，复用包N 取证面"）⇒ 与"降噪"是**同一只手的两个方向**，裁定时一并看。
- `REPORT_批次小尾巴…:191` 写的「同帧重复上报，没有按节点去重」= 本文件第 2 节确认成立；
  但同文 §5 把 35 条 `tavern-cg-album-style` 说成「卡内 CG 图鉴自己的样式」——**归属对（是卡自己的样式），动因表述会让人误会是图鉴自搬**，
  按本文件第 5 节应读作"被 MVU 批量往返顺走"。
- 上线判据 `插件 CSS t8→t16 恒 5/5`（`OPEN_ISSUES.md` [P2-12]#7/#12）与本文件第 4.4 节实测一致，**不因为 175 条而作废**。

---

## 7. 复核入口（别人要重跑就用这些）

```bash
# 静态：唯一文本产生点
grep -rn "style_removal\[" frontend/src backend/app
# 数字复核（用户给的那份日志）
py .tmp_probe/analyze_style_removal_log.py      # 840 / 630 / 175 / 35 / 35×24
py .tmp_probe/analyze_style_removal_cycles.py   # 每轮 24=18+5+1；per-frame 标记全为 35
# 真机（会话名必须 styleremoval1，全程 abort 生成类 POST）
npx playwright-cli -s=styleremoval1 run-code --filename=.tmp_probe/style_removal_snap.js       # 稳态 5/5 + 守护读数
npx playwright-cli -s=styleremoval1 run-code --filename=.tmp_probe/where_do_styles_go.js       # 48 摘 48 连通 0 丢失，父=DIV
```
