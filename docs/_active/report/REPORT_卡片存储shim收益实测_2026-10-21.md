# REPORT_卡片存储shim收益实测_2026-10-21

> **状态**：已完工待验收（只读测量，供主脑决策；未提交，工作区留存）
> **测量日期**：2026-10-21（本机实机，站点 http://localhost:16000，已上线构建 `index-VmPsMJLy.js`）
> **决策问题**：要不要把智能卡帧内存储从"按卡副本 shim"换成浏览器真 localStorage/IndexedDB？
> **纪律**：零源码改动、零 git 操作、零付费 API（计费 URL 全拦截，`BILLING_BLOCKED=1` 为拦截的配图配置类请求，非 LLM）；不回传任何卡片正文/用户生成内容（只记次数、字节长度、运行时内部键名）。

---

## 0. TL;DR（给决策用的三句话）

1. **写放大实测**：本页 7 张卡帧在 boot 期共发 **91 次**逻辑写（每帧 13 次，全部是运行时内部变量持久化），1:1 转发到父页面，落成 **94 次真 localStorage 全桶重写、共 292,475 字节**——逻辑载荷只有 81,935 字节，**字节放大 ≈ 3.6×**，单次逻辑写 ≈ 3.2KB 真写。
2. **但绝对成本 ≈ 0**：交互期（滚动 10 轮、开 2 个卡片设置面板、帧内滚动、合计 35+ 秒含 20 秒空闲）增量为 **0 消息 / 0 写 / 0 读**；全部写集中在 boot，按实测单价（真 setItem 3.5KB = 13µs，桶 parse+stringify = 3-9µs）折算，shim 全链 boot 总开销 **≈ 2-5ms/页**，不可感知。
3. **建议：不换**（详见 §6）。真存储能省的只有每次写 ~25-50µs 和 boot 期几 ms；读反而会变慢（shim 读是内存 Map 命中，0 跳）；IndexedDB 侧**本来就是真的**（垫片只做库名改写，无转发）。代价是丢失按卡隔离（裸键互撞 + 卡可覆写宿主 app 自己的 localStorage 键）。

---

## 1. 测量方法与判据（每个数字怎么来的）

| 探针脚本（`.tmp_probe/`） | 干什么 | 产出 |
|---|---|---|
| `storemeas_boot.js` | v1 boot 测量（**已作废**，见 §1.1 观察者效应） | 作废，仅用于发现守卫问题 |
| `storemeas_diag.js` | 帧形态判定（descriptor / parent 代理 / IDB 垫片）+ 帧内计数代理安装 | `storemeas_diag.out.txt` |
| `storemeas_handler.js` | 重载后 boot 计数 + `event.source` 归属映射 | 输出（本文引用） |
| `storemeas_clean.js` | **干净 v2 主测量**：登录→进卡页→boot 15s→滚动 20 轮→空闲 15s→计数 | `storemeas_clean.out.txt` |
| `storemeas_interact.js` | 交互期：打开 2 个"排版与主题设置"面板（只开不动选项）+ 帧内滚动 + 页面滚动 + 20s 空闲 | `storemeas_interact.out.txt` |
| `storemeas_uiscan.js` | 只读枚举可点控件（找设置面板入口；确认**不点**"信任此卡"以免改信任态） | 输出 |
| `storemeas_bench.js` | 父页面真 localStorage 微基准（一次性临时键 `__palink_storemeas_bench_tmp`，测完即删，`cleaned:true` 已验证零残留） | 输出 |

计数口径（三层，互相印证）：
- **帧侧**：每帧 `window.localStorage/sessionStorage` shim 对象的方法包一层计数（只记次数与 key+value 长度和，不记内容）。⚠️ 只能在**帧 realm** 装：帧内 `window.parent` 是安全代理（`part-a.ts:39-175`），读不到父页面对象。
- **父侧消息**：`message` 事件 **capture 监听器**计数（`source==='palink-smart-card' && type==='storage'`），按 op/key 名/字节聚合，并做 `event.source` ↔ iframe 归属映射。
- **父侧真存储**：`Storage.prototype.getItem/setItem/removeItem` 包装，只统计 `palink:smart-card-storage:v1:` 前缀键的次数与字节。

### 1.1 ⚠️ 观察者效应（v1 数据作废的原因，也是本轮最重要的方法论教训）

v1 探针在父页面用 `window.postMessage = function(m){...}` 包了一层计数。结果：帧发的**所有**消息（storage/request/resize/diagnostic）到达父侧时 `event.source` 变成了**主窗口自己**（`SRC_AGG` 全部 `srcIdx=-1`），被 `CharacterCardRenderer.tsx:971` 的守卫 `if (event.source !== iframeRef.current.contentWindow) return;` **整批静默丢弃** → 测出"28 条消息 0 落盘"的假象。
根因：帧内 `post()` 走 parent 安全代理，代理返回 `post.bind(target)`（`part-a.ts:115-119`）；代理抓取的是**父 realm 的包装函数**，调用栈顶变成父 realm JS ⇒ postMessage 的 incumbent settings object 变成父窗口 ⇒ `event.source` 失真。
v2 改为**只用 capture 监听器计数**（不改投递路径）后，`event.source` 正确映射到 7 个 iframe（`storage|0..6` 各 13 条），落盘计数随之出现（94 次）。
**顺带的工程警示**（一手实测，非本报告范围但值得记录）：任何在父页面 realm 包装 `window.postMessage` 的代码（例如某些浏览器扩展的 content script），都会让卡片持久化/resize/RPC **全链路静默失效**。这个守卫对"包装者"是脆的。

---

## 2. 实测数据（一手）

### 2.1 形态判定（7/7 帧一致，`storemeas_clean.js` FRAME0-6 行 + `storemeas_diag.js` F0-F6 行）

- 帧内 `Object.getOwnPropertyDescriptor(window,'localStorage')` = **`value` 形态（shim）**，父页面为原生 getter ⇒ **证实主脑前提：批次Q1 放开同源后卡片拿到的仍是 shim**。开关确为 `ctx.trustedNative` 而非同源判定：`runtime-body/part-01.ts:599-604`、`frame-shim/legacy-st-sim-parts/part-a.ts:540-545`（代码复核）。
- 帧内 `window.parent` = own property（安全代理已装）⇒ 未信任路径。
- 帧内 `window.indexedDB` = **wrapped-shim**（`card-idb-namespace.ts:179-185` 的 3 方法改名包装，实测 constructor===Object 且仅 open/deleteDatabase/cmp）。
- 每张卡工具栏有"信任此卡（同源：可读页面、可带登录身份请求后端）"按钮（uiscan P0-P6）——即"用户显式点信任"通道已存在，本次未点（点它会改信任态，超出只读边界）。

### 2.2 写放大（boot 期，页面加载 → 15 秒）

| 指标 | 实测值 | 判据 |
|---|---|---|
| 帧侧逻辑写（7 帧合计） | **91 次 setItem 等价**（每帧 13 次）；removeItem=0、clear=0 | 父侧 capture 监听 `MSG_STORAGE`（帧侧包装在 boot 后才装上，boot 写以父侧监听为准，两口径在交互期互相验证一致=0） |
| 写的是什么键 | `__palink_local_variables`×28、`__palink_global_variables`×28、`__palink_chat_variables`×28、`__palink_chat_metadata`×7（全部是运行时内部变量持久化，非卡片自发业务写） | 监听器按键名聚合 |
| 逻辑载荷字节 | **81,935 B**（均值 ≈ 900 B/条） | `valB` |
| 每次逻辑写是否触发一次转发 | **是，1:1**。91 条 postMessage → 91 次 `applySmartCardStoragePatch` → 91 次桶重写；父侧真写 94 次 = 91 patch + 3 次 boot 种子/迁移写 | `FINAL_MSG n=91` vs `FINAL_PB n=94`、`BOOT_PG n=105` = 14 次种子读（7 帧×2 类型）+ 91 次 patch 读 |
| 真 localStorage 落盘字节 | **292,475 B**（均值 ≈ 3.1 KB/次 = 整桶重写） | `FINAL_PB bytes` |
| **字节放大率** | **292,475 / 81,935 ≈ 3.6×**（对逻辑载荷）；对"单个键值变更"的语义放大 = 桶大小/变更大小，桶终态 3,506 B | 计算 |
| 读侧伴随成本 | 每次 patch 前整桶 getItem+JSON.parse：105 次读、295,582 B | `FINAL_PG` |
| 桶终态 | 3 个桶（namespace=characterId:sessionId:fingerprint，7 帧按指纹归并成 3 组），各 3,506 B | `BUCKETS_END sizes=3506,3506,3506` |

**每次转发的字节量级**：帧→父 postMessage 载荷 ≈ 0.9 KB（均值）；父→盘 ≈ 3.1 KB（整桶）。

### 2.3 读放大

- **交互期帧侧 `getItem` 增量 = 0**（7 帧全部 `get+0`，绝对值仅 boot 后 2 次/帧——`palink_wb_names` 一类的一次性读，`part-a.ts:268`）。
- shim 读是**纯内存 Map 命中，0 跨帧跳**：`part-01.ts:564-581`（`makeCompatStorage` 的 `values = new Map(...)`，`getItem` 直接 `values.get`）；同形 `part-a.ts:455-463`。数据在 boot 时由父侧一次性种子进 `ctx.persistedStorage`（`CharacterCardRenderer.tsx:326-329` → `storage.ts:283-316`），boot 种子读实测 14 次 / 281,558 B（含迁移重读）。
- **结论：不存在"每次读都跨帧取"的问题**；读放大 = 0。真 localStorage 反而会把读从 ~0.1µs 的 Map 命中变成 ~1µs 的原生读（bench 实测 getItem=1µs）。

### 2.4 交互期 / 空闲期（`storemeas_interact.js`）

打开 2 个卡片"排版与主题设置"面板（只开、不点任何选项、不保存）+ 帧内滚动×7 帧 + 页面滚轮 8 轮 + 20 秒空闲：

```
INTERACT_MSG_DELTA = msg+0 (set+0) valB+0
INTERACT_PB_DELTA  = realWrites+0 realBytes+0
INTERACT_PG_DELTA  = realReads+0
FCNT0-6            = set+0 get+0 setBytes+0
```

**稳态零存储流量**。这批卡的存储行为 100% 集中在 boot（变量种子回写）。切楼层：本页无独立楼层切换控件（uiscan 未找到 swipe/翻页按钮，消息为纵向滚动布局），滚动即等效遍历楼层，已覆盖。

### 2.5 微基准（父页面真 localStorage，一次性临时键，已清理）

| 操作 | 单价 |
|---|---|
| `setItem` 3.5KB（=当前桶量级） | **13 µs** |
| `getItem` 3.5KB | **1 µs** |
| `setItem` 64KB（重卡假想桶） | **58 µs** |
| JSON.parse+stringify 3.5KB | **3-9 µs** |

### 2.6 shim 全链单次写成本核算（实测单价 × 代码链路）

一次帧内 `setItem` 的完整链路（代码：`part-01.ts:566-586` → `CharacterCardRenderer.tsx:1205-1207` → `storage.ts:338-368`）：

```
Map.set(内存, ~0.1µs) + postMessage 结构化克隆(~0.9KB, 亚 ms 任务调度)
→ 父 handleMessage 守卫链(~µs)
→ 整桶 getItem 3.5KB(1µs) + JSON.parse(3µs) + 改一键 + JSON.stringify(3µs) + 整桶 setItem(13µs)
≈ 每写 20-25µs CPU + <1ms 异步调度（postMessage 单程延迟未单独实测，标注为推理值；不影响结论量级）
```

Boot 全量：91 写 × ~25µs ≈ **2.3ms CPU**（另加 91 次消息调度的松散开销，摊在 15 秒 boot 里）。**这就是 shim 的全部实测代价。**

---

## 3. IndexedDB 侧（第 3 问）

- 帧内 IDB 垫片 = `makeScopedIdbShim`（`card-idb-namespace.ts:179-185`；注入点 `part-01.ts:620-638`）：只把白名单库名（仅 `BubbleDialogueAvatars`）加 `__<characterId>` 后缀，然后**直调原生 indexedDB**。
- **一次 IDB 写经过的跳数：0 跳转发**——无 postMessage、无跨帧、无父页面参与，就是原生 IDB 事务，前面多一次函数调用改名（~ns 级）。嵌套 srcdoc 子帧（dcRoot）经 `installIdbShimPropagation`（`card-idb-namespace.ts:191-222`）在 srcdoc 头部注入同样的改名自举（`:105-120`），也是直写原生。
- 实测 7/7 帧 `indexedDB` = wrapped-shim（原生在其下），即 **IDB 早已是"真存储"**。"换成真 IndexedDB"这个选项**不存在增量**——没有东西可换。
- 唯一注意点（代码推理）：若帧回到 opaque origin（sandbox 无 allow-same-origin），浏览器禁 IDB（`part-a.ts:177-179` 的 IDB-POLYFILL 注释）；当前同源部署下不受影响。

## 4. 对照：真 localStorage 能省什么（第 4 问，按实现算）

| 环节 | shim（现状） | 帧内真 localStorage | 差额 |
|---|---|---|---|
| 单次写 | 1 postMessage + 父侧整桶读改写（≈20-25µs CPU + <1ms 调度） | 1 次直写（3.5KB 值 ≈13µs，典型卡键值 <1KB ≈5µs） | **省 ~10-25µs/写 + 1 跳消息** |
| 单次读 | 内存 Map ~0.1µs | 原生 getItem ~1µs | **变慢 ~10×（绝对值仍可忽略）** |
| boot 种子 | 父侧 14 次整桶读（281KB）+ 每帧 13 次回写（292KB 落盘） | 0 种子（直读直写），91 次小写 ≈0.5ms | **省 ~2-5ms/页加载 + ~290KB 盘写** |
| setVariable 热路径 | 每次 `persistVariableStores()` 发 **3 条**消息 → 3 次整桶重写（`part-03.ts:220-227`；调用点 `part-06.ts:723,859,889,899`、`part-07.ts:309,1092-1094`） | 3 次直写 | 桶 3.5KB 时省 ~0.1ms/次；桶 64KB 时省 ~0.4ms/次；桶 1MB（500 键上限 × 2KB 值的假想极值）时省 ~3-5ms/次 |
| IDB | 原生直写 | 原生直写 | **0（无差别）** |

**放大率随桶大小线性涨**（每写 = O(桶字节)），这是 shim 唯一的结构性弱点；但当前实测桶只有 3.5KB，且交互期写频率为 0，弱点未被任何在用卡触发。

## 5. 哪些卡会变快、快多少（第 5 问前置事实）

- **本页 7 帧实测卡：快 ~0**。收益 = boot 一次性 2-5ms + 每写 ~25µs，交互期收益恒为 0（因为交互期根本没有写）。
- 理论上只有同时满足「桶很大（数十 KB-1MB，如大量 CG 解锁态/长变量树塞进 localStorage 而非 IDB）」且「高频 setVariable（每击键/每动画帧）」的卡才会感知到 shim 成本——量级也只有每次变量写 0.4-5ms。**本轮实测未遇到这种卡**（91 次 boot 写全部是运行时自发的变量种子回写）。
- 图片/头像类重数据走 IDB（气泡插件 `BubbleDialogueAvatars`），IDB 本来就是真的，不受本决策影响。

## 6. 结论与建议

**建议：不换。**（三个选项里明确排除"全量换真存储"；"仅用户显式点信任时换"= 现状，`trustedNative` 通道已存在且语义正确，保留即可。）

理由：
1. **收益 ≈ 0（实测）**：shim 全链成本 boot 期 2-5ms/页、单次写 ~25µs、稳态零流量。换真存储省不出任何用户可感知的性能。"太严格会让性能没法优化"这个担忧，在存储这一项上**不成立**——性能瓶颈不在这里（本轮 boot 观察到的真实开销大头是脚本/样式装配与资源加载，不是存储）。
2. **读会变慢**（内存 Map → 原生 getItem），方向反了。
3. **IDB 无可换**：已经是原生直写。
4. **代价是实打实的隔离回退**：真存储下同 origin 所有卡共用一棵键树——(a) 卡与卡裸键互撞（现在按 `characterId:sessionId:fingerprint` 桶隔离，两张卡各写 `settings` 键互不干扰；换真存储后互覆）；(b) 卡可覆写**宿主 app 自己的** localStorage 键（登录态、界面配置）；(c) 已知安全代价：卡可直读别卡数据（命名空间只是分桶不是边界）。用 ~0 的收益换这三条，不成立。
5. **如果将来真出现重存储卡**（大桶+高频变量写），正确的修法不是裸真存储，而是**帧内同步前缀垫片**：`setItem(k,v)` → 直写 `palink:smart-card-storage:v2:<ns>:<k>`（每键一条、无 postMessage、无整桶重写、保留按卡隔离）。改动面只在 `makeCompatStorage`/`memoryStorage` 两个函数 + boot 种子逻辑，收益拿满、隔离不丢。当前无实测需求驱动，不建议现在做。

## 7. 数字可信度分级

- **一手实测**：91/94/105 次计数、81,935/292,475/295,582 字节、3×3,506B 桶、交互期全零增量、7/7 帧 value 形态与 IDB wrapped-shim、bench 13/1/58/3µs、观察者效应复现（srcIdx=-1 → 修正后 srcIdx=0..6）。
- **代码推理**（未单独实测）：postMessage 单程延迟亚 ms；`persistVariableStores` 每 setVariable 发 3 条（调用点已列，boot 期 28×3+7 的消息构成与之吻合，属强印证）；1MB 桶外推数值；扩展包装 postMessage 会杀全链路的普遍化结论（仅在本探针环境实证过一次）。
- **未测**：切楼层用独立翻页控件的路径（本页无此控件）；卡片设置面板"保存"按钮的写路径（保存会改用户数据，超出只读边界；其成本可由 §2.6 单价直接推出：1 次 `__palink_extension_settings` 写 + 1 次后端持久化请求）。

## 8. 复现方式

```bash
npx playwright-cli -s=pq-storemeas open "http://localhost:16000"
npx playwright-cli -s=pq-storemeas run-code --filename=.tmp_probe/storemeas_clean.js --raw     # 主测量
npx playwright-cli -s=pq-storemeas run-code --filename=.tmp_probe/storemeas_interact.js --raw # 交互期
npx playwright-cli -s=pq-storemeas run-code --filename=.tmp_probe/storemeas_bench.js --raw    # 微基准
```

原始输出：`.tmp_probe/storemeas_clean.out.txt`、`storemeas_interact.out.txt`、`storemeas_diag.out.txt`。
⚠️ 复现时**不要**在父页面包装 `window.postMessage`（§1.1，会测出全零落盘的假数据）。
