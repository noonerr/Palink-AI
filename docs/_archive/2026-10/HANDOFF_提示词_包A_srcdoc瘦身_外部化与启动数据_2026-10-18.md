# 提示词 · 包 A：智能卡 srcdoc 瘦身（legacyShim 外部化 + 启动数据瘦身）

> 本文件是**可直接发送给子 agent 的完整任务包**，自包含，不依赖任何对话上下文。
> 主控：Pal 的项目 Palink-AI。分支 `three-tracks-merge-20261012`，HEAD `94107db`。
> 门禁基线（动工前自测一次确认）：**vitest 78 文件 / 1000 passed / 3 skipped / 0 failed**，`npx tsc --noEmit` exit 0。

---

## 0. 你要解决的问题（一句话）

智能卡每帧 iframe 的 `srcdoc` 有 **893,604 字节**，7 张卡合计 **6.26 MB**，但**卡片真正的内容只占 3%**（~28KB）。剩下 97% 是我们自己塞进去的兼容运行时和启动数据，在 7 份之间反复复制。把这部分抽成可缓存的共享静态资源。

## 1. 实测事实（已由主控真机拆块核实，可直接采信，但建议你复跑一次 §5 的探针确认）

单帧 srcdoc 893,604 字节的逐块构成（`probe-blocks.js` 结果）：

| # | 块 | 字节 | 占比 |
|---|---|---|---|
| 1 | `legacyShim`（内联 `<script>`，来自 `buildShim()`） | **495,138** | 55% |
| 2 | `window.__palinkBoot__`（内联 `<script>`，compat v2 启动数据） | **359,675** | 40% |
| 3 | 运行时（**外部** `<script src="/assets/palink-smart-card-runtime-0274569ea4e2.js">`，383 KB） | — | **已外部化 ✅** |
| 4 | `cardScriptBootstrap` | 9,143 | 1% |
| 5 | 卡脚本本体 | 7,242 | 1% |
| — | 卡片 `<style>` ×3 | 11,370 | 1% |
| — | `<body>` | ~10,320 | 1% |

**块 3 已经走通了外部化路径**——这证明机制可用，块 1 照抄即可。

### 块 2 为什么有 359KB

`buildSmartCardCompatRuntimeBootPayload`（`SillyTavernCompatRuntime.ts:165-243`）把整个 context JSON 化塞进启动数据，
其中 `characterExtensions`（`SillyTavernCompatRuntime.ts:191`）实测 = 角色全部 extensions ≈ 351 KB：

| extensions 子项 | 字节 |
|---|---|
| `palink_raw_card_data` | 178,490 |
| `regex_scripts` | 74,666 |
| `tavern_helper`（3 段卡脚本） | 50,912 |
| `palink_sillytavern` | 46,836 |

⚠️ **这 359KB 对同一角色的所有卡片完全相同**（只有 `messageId`/`messageContent` 不同），而其中的脚本与 regex **已经有独立的 postMessage 下发通道** `postPluginScriptsToFrame` / `postCardScriptsToFrame`（`CharacterCardRenderer.tsx:618-622`）⇒ 启动数据里这份是**冗余副本**。

⚠️ 但帧内确实**同步**读 `ctx.characterExtensions`，不能直接删：
- `runtime-body/part-03.ts:436` — `normalizeRegexListCompat(ctx.characterExtensions)`
- `runtime-body/part-04.ts:119` — `parseMaybeJsonObject(ctx.characterExtensions, {})`
- `runtime-body/part-05.ts:885` — `normalizeRegexListCompat(ctx.characterExtensions)`
- `runtime-body/part-05.ts:888` — `parseMaybeJsonObject(ctx.characterExtensions, {})`
- `frame-shim/legacy-st-sim-parts/part-b.ts:215` — `characters[0].data.extensions`

---

## 2. 任务 A-1：`legacyShim` 外部化（先做这个，最稳）

**目标**：把块 1 的 495KB 从内联 `<script>` 变成 `<script src>` 外部静态资源，跨卡/跨帧复用 HTTP 缓存与 V8 code cache。

**现成机制（照抄，不要另造）**：
- `frontend/src/components/ui/custom/smart-card-runtime/runtime-url.ts` —— 从 virtual module `virtual:palink-smart-card-runtime-url` 取 URL
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts:244-247` —— 外部化分支：
  ```ts
  if (options.externalRuntimeUrl) {
    return bootScript + `<script${nonceAttr} src="${escapeScriptAttribute(options.externalRuntimeUrl)}"></script>`;
  }
  ```
- 对应的 Vite 插件负责产出 `/assets/palink-smart-card-runtime-<hash>.js`（在 `frontend/vite-plugins/` 下，请先 `grep -rn "palink-smart-card-runtime" frontend/vite-plugins frontend/vite.config.ts` 定位）

**改动点**：
1. 在 Vite 插件里**新增一份 legacy shim 外部资产**（或把 legacy 与 compat v2 合成一份），产出 `/assets/palink-smart-card-legacy-<hash>.js`；
2. 新增一个 `legacy-url.ts`（照抄 `runtime-url.ts`）暴露该 URL；
3. `buildShim()` 增加与 `externalRuntimeUrl` 同构的 `externalLegacyUrl` 选项：给了就只输出「引导数据 + `<script src>`」，没给就回退全内联（**必须保留回退路径**，独立测试环境没有外部资产）；
4. `CharacterCardRenderer.tsx:450-463` 传入新 URL。

**硬性要求**：外部化后的 legacy shim 与内联版必须**行为完全一致**。参考项目里已有的 `scripts/verify-shim-identity.mjs` 口径——先跑一次拿到内联版的 SHA256 基线，改完再比对一次。若现有脚本只校验 compat v2，请扩展它覆盖 legacy（不要绕过）。

## 3. 任务 A-2：启动数据瘦身

**目标**：把块 2 从 359KB 降到 KB 级。

**做法（按风险从低到高，建议逐级做，每级单独验证）**：
1. **去重**：`characterExtensions` 不再进 boot payload。改为帧内首次需要时经既有 `requestParent` 通道拉取并**缓存**到帧内变量；上面 §1 列的 5 个同步读取点改为"先读缓存，未命中则同步走一次已缓存的初始值"。
   - ⚠️ 若某处确实是**启动期同步**读、无法改异步，则退一步：只把 `palink_raw_card_data`（178KB，帧内几乎不用）剔除，保留其余。
2. **`chatMessages` 只传必要字段**（现在是完整消息数组，含长正文）。帧内大量场景只需要 `mesid`/`is_user`/`name`；正文按需拉。
   先 `grep` 帧内对 `ctx.chatMessages` 的真实用法再改，**不要凭感觉裁字段**。

**禁止**：不要为了瘦身把帧内真正需要的字段删掉导致卡片功能退化。每删一个字段都要能说出"帧内哪些读取点不再需要它"。

## 4. 验收（必须逐项给出实测数字）

| 项 | 判据 | 怎么测 |
|---|---|---|
| srcdoc 总量 | 单帧 **≤ 60 KB**（原 893,604）；7 帧合计 **≤ 400 KB**（原 6,258,832） | §5 探针 |
| legacyShim 内联块 | srcdoc 里不再有 ≥100KB 的内联 `<script>` | §5 探针逐块 |
| 外部资产可达 | `<script src>` 指向的 URL HTTP 200 | curl |
| 卡片视觉不变 | t=2s 与 t=11s 截图一致、5 个卡片宿主高度**前后完全一致** | §5 探针 |
| 帧内能力不退化 | `getContext()` 返回键数、TavernHelper 键数、Mvu 键数与改动前一致 | §5 探针 |
| 门禁 | vitest **78+ 文件 / 全绿 / 0 failed**；`npx tsc --noEmit` exit 0 | — |
| **改坏证明** | 临时把改动撤掉（git stash）跑同一探针 → 数字回到 893KB；还原 → 回到瘦身后数字。**两项都要写进报告** | — |

## 5. 探针（复制即用，放 `D:\项目\Palink-AI\.tmp_probe\probe-srcdoc.js`）

用 `playwright-cli`（全局已装 0.1.17）。**注意 playwright 会话不能跨 bash 命令持久**，`open` 和 `run-code` 必须在**同一条 bash 命令**里：

```bash
cd /d/项目/Palink-AI/.tmp_probe && playwright-cli -s=pa open http://localhost:16000 >/dev/null 2>&1; playwright-cli -s=pa run-code --filename=./probe-srcdoc.js
```

`probe-srcdoc.js` 内容（`async page => {...}` 箭头函数源码）：

```js
async page => {
  await page.evaluate(async () => {
    const f = new FormData(); f.append('username','admin'); f.append('password','admin123');
    await fetch('/api/token', { method:'POST', body:f, credentials:'include' });
  });
  await page.goto('http://localhost:16000/characters/c28061bb-a9b7-46a9-a255-2692d57001fc', { waitUntil:'domcontentloaded' });
  let w=0;
  while (w < 30000) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-palink-smart-card]').length);
    if (n >= 3) break;
    await page.waitForTimeout(500); w += 500;
  }
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    const s0 = frames[0].getAttribute('srcdoc') || '';
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    const blocks = []; let m;
    while ((m = re.exec(s0))) {
      const attrs = m[1] || '', body = m[2] || '';
      if (/src=/.test(attrs)) blocks.push({ kind:'external', src: (attrs.match(/src="([^"]+)"/)||[])[1], len:0 });
      else blocks.push({ kind:'inline', len: body.length, head: body.slice(0,80).replace(/\s+/g,' ') });
    }
    return {
      frameCount: frames.length,
      srcdocTotal: frames.reduce((a,f)=>a+(f.getAttribute('srcdoc')||'').length, 0),
      srcdoc0: s0.length,
      blocks,
      hostHeights: Array.from(document.querySelectorAll('[data-palink-smart-card]')).map(h => Math.round(h.getBoundingClientRect().height)),
    };
  });
  const caps = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { caps.push(await f.evaluate(() => ({
      ctxKeys: (typeof window.getContext==='function' ? Object.keys(window.getContext()||{}).length : 0),
      thKeys: Object.keys(window.TavernHelper||{}).length,
      mvuKeys: Object.keys(window.Mvu||{}).length,
    }))); } catch(e) { caps.push({err:String(e).slice(0,60)}); }
  }
  await page.screenshot({ path: 'shot-a-t1.png' });
  await page.waitForTimeout(6000);
  const h2 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-palink-smart-card]')).map(h => Math.round(h.getBoundingClientRect().height)));
  await page.screenshot({ path: 'shot-a-t2.png' });
  return JSON.stringify({ ...r, caps, hostHeightsLater: h2 }, null, 1);
}
```

改动前先跑一次存档，改动后再跑一次对比。

## 6. 开工前必读的项目纪律（踩过的坑，别再踩）

1. **唯一 shell = Git Bash**。Python 一律 `py`（`python`/`python3` 是商店空壳）。不可用：powershell、wget、jq、make、7z、gh、sqlite3、psql。
2. **`git commit -m` 里的反引号会被 bash 当命令替换吃掉** ⇒ 提交信息含代码标识时一律用 `git commit -F <消息文件>`。
3. **`frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-*.ts` 是注入 iframe 的模板字符串**：
   禁止裸反引号（会提前闭合模板）、`${}` 插值、**字符串里的裸 `\n`**（要写 `\\n`）、**注释里的裸 `\n`**（会变真换行截断 `//`）。
   `generated-script-parse-guard.test.ts` 是唯一守卫，改完必须跑。
4. **未信任卡 iframe 的 sandbox 只给 `allow-scripts`，是 opaque origin** ⇒ 父页面 `iframe.contentDocument === null`。
   任何要读写卡片 iframe DOM 的逻辑**必须写在帧内**（`runtime-body/part-*.ts`），父侧对未信任卡全盲。
5. **⛔ 不要动 `frontend/dist`**（它是 nginx bind mount）。**不要跑 `npm run build`**（它先跑 `clean-dist.cjs`，会被安全删除守卫拦下，dist 会被删一半）。
   需要重建时**只交代码，由主控统一重建**：`VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/` → `node scripts/gzip-dist.cjs`。
6. **不要按名字删文件**。项目里 `st_` 前缀不等于"ST 残留"（例：`st_groups.py` 是 Palink 自有群聊后端；`SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` / `api/silly_tavern.py` 全是在用生产代码，禁止整文件删）。
7. 改 `docs/` 下任何文件后跑 `py scripts/docs/gen_docs_catalog.py` 重生成目录。

## 7. 交付要求

1. 代码 + 测试，提交到当前分支（**不要自己重建 dist**）。
2. 一份完工报告放 `docs/_active/report/`，必须包含：
   - 改动前后 srcdoc 逐块字节对比表；
   - 帧内能力（`getContext` 键数 / TavernHelper / Mvu）改动前后对比，证明没退化；
   - **改坏证明会红 + 还原证明回绿**两项实测；
   - 门禁数字（vitest 文件数/passed/failed/skipped + tsc exit code）。
3. 报告里凡写"某能力还在这/没了"，必须给 `文件:行号`，不要写"经查存在"这种无法复核的话。
