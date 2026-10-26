# 包 A 完工报告：智能卡 srcdoc 瘦身（legacy 外部化 + 启动数据瘦身）

> 施工依据：`docs/_active/HANDOFF_提示词_包A_srcdoc瘦身_外部化与启动数据_2026-10-18.md`
> 分支 `three-tracks-merge-20261012`。所有数字均为**真机实测**（角色 `c28061bb-a9b7-46a9-a255-2692d57001fc`，7 帧），
> 探针 `playwright-cli`，构建走 `VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/` → `gzip-dist.cjs`。

---

## 0. 一句话结论

单帧 srcdoc **893,604 → 46,167 字节（−94.8%）**，7 帧合计 **6,258,832 → 326,773 字节**，
帧内能力**键集合双向 diff 为空**（getContext 194 / TavernHelper 76 / Mvu 6 前后完全一致）。

---

## 1. 与提示词的三处事实偏差（施工中实测纠正）

### 1.1 「legacyShim 495KB 照抄运行时外部化即可」——不成立

拆开 `buildShim()` 产物（`helpers.ts`，用 esbuild + node:vm 实跑）：

| 组成 | 字节 | 可外部化？ |
|---|---|---|
| `LEGACY_ST_SIM_SEGMENT`（兼容段代码） | 122,096 | ✅ |
| `buildFrameMeasureSegment`（度量段代码） | ~13,000 | ✅ |
| `ctx.characterExtensions`（**数据**） | 355,892 | ❌ 数据随卡而变 |
| 其余 ctx 骨架 | ~4,000 | ❌ |

⇒ 真机 495,138 字节里**只有约 135KB 是代码**，其余 355,892 是 `characterExtensions`。
而 `__palinkBoot__` 那 359,675 字节里也有同一份 355,892。
**同一份 extensions 在单帧内被内联了两次，合计 711,784 = 单帧 893,604 的 79.6%。**
这才是主病灶；只做 A-1 最多省 135KB（15%），够不到 ≤60KB。

### 1.2 「chatMessages 只传必要字段」——空转

`bootContext.chatMessages` 本来就是 `[]`（`CharacterCardRenderer.tsx:405`），
`liveContext` 也已过 `compactSmartCardChatMessages`（`:333`）。该项零收益，未实施。

### 1.3 「帧内首次需要时经 requestParent 拉取」——不需要，但缺一个 P0 前置

父侧 `handleFrameLoad` 本来就把**全量 context（含 extensions）**post 进帧
（`postLiveContext` → `postContextToFrame(liveContext, true)`），帧内 `Object.assign(ctx, …)`
已有（`part-a.ts:557` / `part-06.ts:58`），`refreshDerivedContextStoresCompat`
（`part-05.ts:884`）还会重算 `scopedRegexScripts` 与 `primaryCharacter.data.extensions`。
**无需新建任何通道。**

⚠️ 但发现一个提示词未提的硬缺陷：`lastPostedContextSignatureRef`
（`CharacterCardRenderer.tsx:175`）**从不在 frame load 时重置**。`postNow` 按 signature 去重，
而新文档的监听器是全新实例 —— srcdoc 重建 / LRU 逐出唤醒 / 插件换文档后，若 context 未变化，
这条唯一补投会被**静默丢弃**。旧行为靠 srcdoc 内联兜底所以不显；剥掉 boot 数据后就是硬故障。
本包已先修（见 §2.1）。

---

## 2. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `CharacterCardRenderer.tsx:625` | **P0**：`handleFrameLoad` 首行重置 `lastPostedContextSignatureRef.current = ''` |
| 2 | `CharacterCardRenderer.tsx:33-34,451-455` | 引入 `SMART_CARD_LEGACY_URL`，`buildShim` 传 `externalLegacyUrl` |
| 3 | `smart-card-runtime/helpers.ts` | `buildShim(context, frameId, options?)`；ctx JSON 去掉 `characterExtensions`；外部化分支输出「引导数据 + `<script src>`」，保留全内联回退 |
| 4 | `smart-card-runtime/frame-shim/legacy-shim-source.ts`（新） | 零 `@/` 依赖的源码构造器：`buildLegacyShimBody` / `buildSmartCardLegacyExternalScript` / `LEGACY_FRAME_SECRET_BLOCK`；两个图片队列常量迁入（`shared.ts` 反向 re-export 保持单一真源） |
| 5 | `smart-card-runtime/legacy-url.ts`（新） | 照抄 `runtime-url.ts`，暴露 `SMART_CARD_LEGACY_URL` |
| 6 | `SillyTavernCompatRuntime.ts:191` | boot payload 去掉 `characterExtensions`（附自愈链路注释） |
| 7 | `vite-plugins/smart-card-runtime-asset.ts` | 重构为双资产：新增 `virtual:palink-smart-card-legacy-url` + `assets/palink-smart-card-legacy-<hash>.js`（dev 中间件 + build emit） |
| 8 | `vite-env.d.ts` | 新增 legacy virtual module 声明 |
| 9 | `shared.ts:49-52` | 两个常量改为从 `legacy-shim-source` re-export |
| 10 | `scripts/verify-shim-identity.mjs` | 新增 `legacy-identity` 子命令（body 字节一致 + 引导数据同值 + 无 HTML 外壳） |
| 11 | 测试 | `generated-script-parse-guard` 支持多 `<script>`；新增 `frame-context-replay-contract`、`srcdoc-boot-slim-contract` |

**未改动**：`legacy-st-sim-parts/*`、`runtime-body/*`、`frontend/dist` 结构（仅重建）。

---

## 3. 验收：srcdoc 逐块字节对比（真机）

| 块 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| legacy shim 内联块 | 495,138 | **3,494**（引导数据） | −491,644 |
| legacy 外部资产 | — | 147,236（`<script src>`，HTTP 200） | 新增（可缓存） |
| `__palinkBoot__` 内联块 | 359,675 | **3,783** | −355,892 |
| 兼容运行时 | 外链（383KB） | 外链（387,602） | 已外部化，不变 |
| `cardScriptBootstrap` | 9,143 | 9,143 | 0 |
| 卡脚本本体 | 7,242 | 7,242 | 0 |
| 其余（style+body+head+外壳） | 22,406 | 22,505 | +99 |
| **单帧 srcdoc** | **893,604** | **46,167** | **−94.8%** |
| **7 帧合计** | **6,258,832** | **326,773** | **−94.8%** |
| 内联 `characterExtensions` 字节 | 355,892 | **0** | 完全移出 |

判据对照：单帧 ≤60KB ✅（46,167）｜7 帧 ≤400KB ✅（326,773）｜不再有 ≥100KB 内联 `<script>` ✅
｜外部资产 HTTP 200 ✅（`legacy=200 size=147236` / `runtime=200 size=387602`）。

外部资产 URL 变化即失效（内容 hash）：`/assets/palink-smart-card-legacy-2263792694c7.js`。

---

## 4. 验收：帧内能力未退化

改动前后各采集 7 帧的**完整键清单**，做双向集合差：

| 项 | 改动前 | 改动后 | 双向 diff |
|---|---|---|---|
| `getContext()` 键数 | 194 | 194 | **空** |
| `TavernHelper` 键数 | 76 | 76 | **空** |
| `Mvu` 键数 | 6 | 6 | **空** |
| 7 帧是否一致 | 是 | 是 | — |

数据到达实证（帧内）：`boot.ctx.chatMessages = 10`、`getContext().chat.length = 10`、
`getContext().characters[0].data.extensions` 10 键、`scopedRegexScripts = 6 条`
（状态栏 / 隐藏变量更新 / 状态栏标签隐藏 / 变量更新美化 / 正文美化 / 对ai隐藏cg标签）。
⇒ extensions 虽不在 boot 里，但首个 context-update 后**全部就位**。

### 4.1 关于「5 个卡片宿主高度前后完全一致」——该判据在本环境不可用

实测同一份构建多次运行即波动：卡片 3/4 出现 `2284 / 4160` 两种值，卡片 2/3 在撤回版里出现
`1935 / 684 / 1375`。根因已定位：宿主高度 = 故事 iframe 实测高度 + 操作栏，
而故事内容高度取决于**外链图片是否加载完**（`https://i.postimg.cc/...`，实测 `naturalWidth` 时 0 时 1279）。
⇒ 这是网络抖动，不是渲染回归。

改用可复现的四路证据替代：① 上表键集合双向 diff；② 帧内数据到达计数；③ 逐帧 `scrollHeight`
与文本长度（故事帧 `sh=3140/3535`、`txt=1285/1394`）；④ 截图（`shot-a-t1/t2.png`，卡片配色/版式正常）。
**"高度完全一致"这一条本包无法给出通过结论**，如实标注为不可测项。

---

## 5. 改坏证明（会红）与还原证明（回绿）

### 5.1 字节级（真机探针，同一脚本同一角色）

| 状态 | 单帧 | 7 帧合计 | 说明 |
|---|---|---|---|
| 撤掉本包全部改动（`git stash` 后重建） | **893,604** | **6,258,832** | 与提示词文档给的 893,604 / 6,258,832 **逐字节吻合**，证明探针与文档同源 |
| 还原（`git stash pop` 后重建） | **46,167** | **326,773** | 回到瘦身后数字 |

### 5.2 测试级

| 改坏动作 | 结果 |
|---|---|
| 注释掉 `lastPostedContextSignatureRef.current = ''` | `frame-context-replay-contract` **2 红**（并暴露第一版断言可被注释骗过，已加「剥行注释」修正） |
| 把 `characterExtensions` 加回 `buildShim` ctx | `srcdoc-boot-slim-contract` **2 红** |
| 两处均还原 | 3 个文件 **19 passed**，`tsc` rc=0 |

### 5.3 外部化等价性（`legacy-identity`，`failed = 0`）

```
[legacy] 内联产物字节 : 147935
[legacy] 外部化后字节 : 1013
[legacy] 外部资产字节 : 147236
[legacy] body 字节    : 146707 / 146707
[legacy] ✅ body 逐字节一致
[legacy] ✅ 引导 ctx 与内联 ctx 同值
[legacy] ✅ 引导 frameId 与内联 frameId 同值
[legacy] ✅ 外部资产不含 HTML 外壳
[legacy] ✅ 外部资产从引导对象取数
```

> ⚠️ 提示词要求的「整份产物 SHA256 前后一致」对外部化**原理上不可能**（必然多两个 script 标签、少一段内联）。
> 本包改为「IIFE body 逐字节一致 + 引导数据同值」双证，比原口径更严格地锁住了"只搬位置、不改行为"。

---

## 6. 门禁

| 项 | 结果 |
|---|---|
| `npx vitest run` | **81 文件 / 1033 passed / 3 skipped / 0 failed**（基线 78/1000/3/0，+3 文件 +33 用例） |
| `npx tsc --noEmit` | **rc = 0** |

---

## 7. 遗留风险（必须在合并前知情）

1. **⚠️ 工作区并发**：施工期间另一个 agent 正在同一 worktree 改「包 B」（`runtime-body/part-06/07/08.ts`、
   `main.tsx`、`lib/slash-engine/*`、backend Extras）。因此本次重建的 `frontend/dist` **同时包含包 B 的在途改动**，
   1000→1033 的用例增量也含包 B 新增的测试文件。本报告的能力对比是在**同一份包 B 基线**下做的双向 diff，
   结论不受影响；但**dist 不是纯包 A 产物**，主控合并时需按 pathspec 提交。
2. **解析期读 extensions 的卡片脚本**：boot 里不再有 extensions，若某卡脚本在**模块顶层**（非
   `DOMContentLoaded` 回调内）同步读 `getContext().characters[0].data.extensions`，首帧会拿到 `{}`。
   本角色的 6 条 regex 与 10 个 extension 键实测全部到位；`chatMessages` 早有同类先例（boot 恒为 `[]`）
   且有 `DOMContentLoaded` 重放兜底。**仍建议主控用一批依赖 extensions 的重卡复测。**
3. **外部资产 404 = 卡片运行时全灭**：legacy 资产与既有 runtime 资产同一暴露面（无内联兜底可用）。
   已实测 200；`hash` 变化即换名，旧文件只增不删，无缓存穿透风险。
4. **`buildShim` 的 `characterExtensions` 仍在 `bootContext` 里传**（`CharacterCardRenderer.tsx:409`），
   只是构建器不再序列化它。保留是为了不扰动 `useMemo` 依赖；`srcdoc-boot-slim-contract` 已钉住构建器侧。

---

## 8. 复现命令

```bash
# 1. 等价性
cd frontend && node scripts/verify-shim-identity.mjs legacy-identity src/components/ui/custom/smart-card-runtime/helpers.ts

# 2. 门禁
npx vitest run && npx tsc --noEmit

# 3. 重建（只增不删）
VITE_OUT_DIR=dist_new node scripts/build-vite.mjs
cp -r dist_new/. dist/ && node scripts/gzip-dist.cjs

# 4. 真机探针（open 与 run-code 必须在同一条命令里）
cd ../.tmp_probe && playwright-cli -s=pa open http://localhost:16000 >/dev/null 2>&1; playwright-cli -s=pa run-code --filename=./probe-srcdoc.js
```
