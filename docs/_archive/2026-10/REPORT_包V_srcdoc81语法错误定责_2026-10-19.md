# REPORT 包V · about:srcdoc:81:1 语法错误定责（先裁决，后修复）

> **状态：已完工待验收 —— 本包只做定责，零代码改动（无 pathspec 可提交）。**
> 结论：**归卡**（卡自带 `tavern_helper.scripts[0]` 正文在 ESM 语法下自身不可解析），
> 但**包T 的取证过程有两处不可复现**，**主控的否证有两处不成立**，**第三候选（Palink 注入前处理改坏）不成立**。
> 被测：角色 `bcf12cd3-8301-4cd5-aca4-b7a0ebda71ff`，站点 `http://localhost:16000`（生产 dist），报错**当场仍复现**。
> 取证日期：2026-10-19。探针落盘于 `.tmp_probe/`（`V_parse_modes.cjs` / `V_verify_raw.cjs` / `V_frameerrors.js` / `V_diag.js` 与 `V5_raw.txt` / `V6_raw.txt`；正文只存盘不外传，本文件只写摘要与结构数）。

---

## 0. 裁决表（谁对谁错）

| 说法 | 裁决 | 关键证据 |
|---|---|---|
| **包T**：坏的是卡自带 `tavern_helper.scripts[0]`（3,054 字 / 87 行），内容与 PNG 原始卡逐字节相同 ⇒ 归卡 | **结论成立，取证不成立** | 定位正确（E3/E4）；但它声称的 "node --check 即可在同一行同一 token 复现"**在它自己的脚本里并不成立**：`check_png_script.cjs` 落的是 `.js`（CJS 目标），实测 **rc=0 干净**。只有按 **ESM 目标**解析才在同一行同一 token 复现（E2）。 |
| **主控**：同一份内容 node --check 无语法错误 ⇒ 打掉"归卡" | **不成立** | 用的是 **CJS 目标**的读数。同一份字节（sha256 `76bec7af…`）按 **ESM 目标**（`.mjs`）解析：`SyntaxError: Unexpected token '}'`，V8 报错头 **`:81`**，插入符落 `});` 第 1 列 —— 与 Chromium 的 `about:srcdoc:81:1` 同行同列同 token（E2）。 |
| **主控**：srcdoc 文档第 81 行落在另一段 9,143 字 / 167 行、不带卡脚本标记的注入脚本里 | **不成立（行号基准用错）** | 该行实际是 `if (typeof window.eventOnButton !== 'function') …`（包T 自己留存的 `T_srcdoc_probe_out.txt` 的 `around81`），既不是第 1 列的 `}`，也解析得动（167 行整段 rc=0）。**动态 `appendChild` 进去的脚本，其编译错误位置是"相对该脚本正文"，不是"相对文档"** —— 反证实验 E5 直接给出 `line: 2, col: 1`（文档行应是 90+）。<br>（"括号计数 ≠ 截断"这条批评本身是对的，但它据此推出的归属不成立。） |
| **第三候选**：报错来自 `executeCompatInlineScriptCompat`（宏替换 / JSON 内嵌把正文改坏） | **不成立** | 诊断里**没有** `inline_script_injection_failed`（E6，`diagInlineScript: []`）。真实通道是帧内卡脚本引导器（`card-script-runner.ts` 的 `execute()`）：`__palinkFrameErrors` 收到 `kind: 'script_error'`、`filename: about:srcdoc`、**`lineno: 81`、`colno: 1`**，报错栈 `at execute (about:srcdoc:155:13)` 正落在该引导器脚本的文档区间 18–184 内（E1）。而卡脚本下发走 `postMessage` 结构化克隆 + `textContent`，**不经任何 JS 字符串拼接**（E7）。 |

**责任判定：卡侧缺陷。** Palink 的注入前处理对这段正文的唯一改写是 `patchInitEvent`，实测为**恒等变换**（E7：改前改后 sha256 相同），未引入任何非法 token；无宏替换、无 JSON 内嵌、无 `</script>` 转义、无 nonce 拼接进正文。
按本包纪律，**不为此放宽任何前端行为**：该脚本必须走 `type="module"`（正文首行是顶层 `import`），注入为经典脚本同样解析失败，注入为模块则如实报错——前端没有"既不改写又不报错"的合法做法。

---

## 1. 证据链

### E1 · 报错的确切身份（父侧真实落点）
`bash` 驱动 `playwright-cli -s=pv`，输出重定向到 `.tmp_probe/V6_raw.txt`：

- 顶层 `page.on('pageerror')`：`Failed to execute 'appendChild' on 'Node': Unexpected token '}'`（**此刻仍复现**）。
- 父侧 **`window.__palinkFrameErrors`**（这才是本类错误的持久化落点；`CharacterCardRenderer.tsx:914-944` 收 `frame-error`，上限 50 条）：共 **18 条**，kind 直方图 `script_error ×1 / node_removed ×17`。
- 那条 `script_error`：`filename = about:srcdoc`、**`lineno = 81`、`colno = 1`**、message 头部（脱敏）`SyntaxError: Unexpected token '}'?    at about:srcdoc:168:14?    at Ar…`。

> **修正主控的一个前提**：`st:diagnostic` 在父侧**没有 window 级数组**。接收链是
> `CharacterCardRenderer.tsx:996` → `CharacterChat.tsx:1226` → `SmartCardCompatController.ts:1121 handleSmartCardCompatDiagnostic`，
> 只做 `console.warn` + toast（12s 去重），读完即丢。父侧 `__palinkCompatStats` 是 `undefined`（它只在帧内、且是降级桩统计，不是诊断数组）——
> 所以主控"只读到 1 个帧、拿不到 `__palinkCompatStats`"**不是键名猜错，是那个键本来就不承载诊断**。
> 要全量拿诊断，必须在父侧 `addEventListener('message', …, true)` 上挂监听（本次探针即这么做的，见 E6）。

### E2 · 同一份字节，两种语法目标，两种结论（本包的核心）
本地对 `.tmp_probe/V_scratch/s0_raw.txt`（3,054 字节 / 87 行 / 无 CRLF / 无 U+2028-29）双目标解析，`node v25.2.1`：

| 目标 | 结果 |
|---|---|
| CommonJS（`.js`，= 主控与包T 实际跑的那次） | **rc=0 CLEAN** |
| **ESM（`.mjs`，= 浏览器对该脚本实际采用的目标）** | **rc=1**，报错头 `…s0_esm.mjs:81`，下一行 `});`，插入符在第 1 列，`SyntaxError: Unexpected token '}'` |

⇒ **两组读数并不矛盾，它们测的是两个语法目标。** 卡正文首行是 `import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/…'`，顶层 `import` ⇒ 浏览器端只能是模块语法目标（前端 `isTopLevelEsm()` 判为 module，运行时 DOM 上该节点 `type="module"` 实测一致）。判定脚本坏否，**必须按它被执行时的那个语法目标跑**。

结构侧佐证（只报数字，不报正文）：第 79 行处剥字符串/注释后的括号深度回到 0，**第 81 行 `});` 使深度变 −2**（V8 即在此放弃解析），第 83 行重新 +2，第 86 行再一段 `});` 到 −2，全文末深度 −2 ⇒ 卡正文尾部是**一段孤立的重复收尾**。注意：这只是与 V8 读数一致的结构旁证，**结论只认 ESM 目标的 `node --check`**（括号计数本身不作判据）。

### E3 · 钉到具体哪一段脚本（按 label/标记，不靠猜）
帧内 `page.frames()` + `frame.evaluate()` 实测（`V5_raw.txt`）：未授信 srcdoc 帧里带标记的卡脚本共 2 条——

| `data-palink-card-script-id` | type | 字节 | 行 | sha256（前 12） |
|---|---|---|---|---|
| `2d6bd520-2356-4559-90b5-c44ee68c6f22` | **module** | 3,054 | 87 | `76bec7af4083` |
| `ea643c91-0cf2-49de-9eeb-82b445afe8e5` | module | 90 | 1 | `d669d4ad…`（同行自身 rc=0，与本报错无关） |

第 81 行第 1 列的字符实测就是 `}`（`line81_first = "}"`，trim 后 `});`）。**只有第一条同时满足：87 行、第 81 行第 1 列是 `}`、module 目标、ESM 解析报错 81。**

### E4 · 闭环到原始卡（逐字节，四份同一份）
```
PNG 原始卡 chara 块 scripts[0]   sha256 = 76bec7af40837e72f628faa25488d23c…（本机自测，非引用包T）
库里 character.extensions 那份   sha256 = 76bec7af…（与 PNG 同，id 亦同）
帧内 DOM 里被执行的那份          sha256 = 76bec7af…（crypto.subtle 在帧内算，只回传摘要）
本地双目标解析用的那份            sha256 = 76bec7af…
```
⇒ **浏览器编译失败的正文，与作者写进 PNG 的正文，是同一串字节。**

### E5 · 反证（行号基准）
在同一次会话里造一个 srcdoc：先用 90 行填充把 `<script>` 推到文档第 90 行之后，再由该文档**动态** `createElement('script') + textContent('const a = 1;\n});\nconst b = 3;') + appendChild`。实测：

- `window.onerror` 报：`src = about:srcdoc`，**`line = 2`，`col = 1`**（= 该脚本自身的第 2 行第 1 列，文档行应是 90+）；
- 而 `pageerror` 的 **栈帧**给的是 `about:srcdoc:91:298`（文档行）。

⇒ **同一个 `about:srcdoc` URL 下，"栈帧行号"是文档基准、"编译错误自身行号"是脚本正文基准。** 把 `81:1` 拿去映射文档行（主控做法）与拿去映射文档行以外的脚本（包T 做法）之间，只有后者与实测同构。这条判据值得进 SOP。

### E6 · 第三候选的排除（诊断码原文）
父侧 message 监听全量记录（60 条上限，实到 2 条）：

| code | apiName（label） | severity | message 头部（脱敏） |
|---|---|---|---|
| `st_plugin_script_executed` | 酒馆助手 | info | SillyTavern extension script executed in iframe sandbox. |
| `script_error` | （空） | error | Uncaught SyntaxError: Failed to execute 'appendChild' on 'No… |

**`inline_script*` 命中数 = 0。** ⇒ 报错不是 `executeCompatInlineScriptCompat`（`runtime-body/part-01.ts:279-292`）那条路：那条路的 label 会是 `module:<plugin>:<path>` 或 `plugin:<key>`，且必带 `code: 'inline_script_injection_failed'` 的诊断。本例走的是**帧内卡脚本引导器**（`card-script-runner.ts` 的 `buildCardScriptFrameBootstrap` 里 `execute()` → `scripts.forEach` → `host.appendChild(script)`，try/catch 后 `report(...'card script execution failed')` 与帧内 `window.onerror` 各上报一次）。

### E7 · 注入前处理到底改了什么（答案：没改这一条）
帧内引导器对正文的唯一变换是 `patchInitEvent`（把 `document.addEventListener('DOMContentLoaded'` 改写为 `'palink-card-init'`）。对这段正文实测：
`sha256(原文) = sha256(patchInitEvent(原文)) = 76bec7af…`、`patch_changed_anything = false`、长度与行数不变（3,054 / 87）⇒ **行号不会被平移，没有任何一处改写引入非法 token**。下发通道是 `postMessage` 结构化克隆（`CharacterCardRenderer.tsx:549-550` → `getCardTavernHelperScriptsForFrame`，`content` 原样透传，不做宏替换、不做 JS 字符串拼接），源码注释里写明的"不受 `</script>` 结束标签转义问题影响"与实测一致。

---

## 2. 要不要改代码：不要（本包结论）

- 缺陷主体在卡正文：尾部一组多余的 `});`。任何"让它别报错"的前端改法，实质都是**改写或跳过未授信卡脚本**（放宽显示管线 / 跳过 module 注入 / 自动补括号），本包明确不提议、不实施，也**不许**借这个案例去动 `0344f55` 的 script 区域保护、sandbox（P1-1）、包I 的错误分类与 toast 行为。
- 现有前端行为是**符合设计**的：`execute()` 逐条 try/catch，一条坏不拖垮整批（`ea643c91` 那条 `import '…/MagVarUpdate/bundle.js'` 正常注入），失败既进 `__palinkFrameErrors` 又进 `st:diagnostic`（→ toast）。
- 因此本包**无代码 pathspec 可提交**；报告按纪律不入库，交主控统一提交。零回归项无需复跑（未改任何在跑代码；`gate.sh` 未跑）。

## 3. 用户侧结论（可直接转述）

1. 这条 `Uncaught SyntaxError: … Unexpected token '}' @ about:srcdoc:81:1` **不是 Palink 造成的**，是这张卡自带的"变量结构 / MVU schema 注册"脚本（`tavern_helper.scripts[0]`，id `2d6bd520…`，3,054 字节 / 87 行）第 81 行多了一个 `}`（尾部一段重复的 `});` 收尾）。它**在任何标准浏览器的模块语法下都编译不过**——拿原始 PNG 里的同一串字节按 ESM 解析即可复现同一行同一列。
2. 影响面：**只有这一条脚本不生效**（该卡的 MVU 变量 schema 注册不上）。同卡第二条脚本（`import '…/MagVarUpdate/bundle.js'`，`ea643c91…`）注入正常；卡其余显示与插件链路不受影响。所以这是"这张卡的一个功能坏了"，不是"卡片渲染坏了"。
3. 修法只有两条，都在卡侧：**卡作者删掉尾部多余的 `});`**，或用户重新导入修好的卡。Palink 不会也不应为一张坏卡改写卡脚本。
4. 若嫌这条 toast 吵，属包I 的错误分类/toast 范畴，与本定责无关，本包不动。

## 4. 剩余项（未做，列给主控/下一包）

1. **文档层面**：把 E5 的判据写进 `docs/SOP_Agent交付自查报告`级别的取证规范 —— *同一个 `about:srcdoc` 下，栈帧行号是文档基准、编译错误自身行号是脚本正文基准；判断卡脚本坏否，只认"按它被执行时那个语法目标"的解析结果（module 用 `.mjs`）*。本次两组读数打架的根因就是这两条没写死。
2. **可选的产品层小改进（本包未做，需另立议题并授权）**：帧内引导器 `execute()` 的 `report('card script execution failed: ' + id, …)` 目前把 `stack` 写进 detail，但**不带该脚本自身的 `len/lines/第 col 行首字符`**；若给失败记录补一句"脚本正文第 N 行"，用户侧就能自证是哪张卡哪一条，无需再开探针。属可选，不改不影响正确性。
3. **未授信卡脚本编译失败的复测基线**：本次只在 `:16000` 生产 dist 上取证一次；若后续改了卡脚本链路，复跑 `.tmp_probe/V_frameerrors.js`（会话 `pv`）比对 sha256 `76bec7af…` 与 `lineno=81 colno=1` 是否仍一致即可，成本为零。
