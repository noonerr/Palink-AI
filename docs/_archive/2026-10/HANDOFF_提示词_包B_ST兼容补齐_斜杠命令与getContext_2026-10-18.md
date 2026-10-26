# 提示词 · 包 B：ST 兼容补齐（斜杠命令懒代理 + getContext 缺口）

> 本文件是**可直接发送给子 agent 的完整任务包**，自包含，不依赖任何对话上下文。
> 主控：Pal 的项目 Palink-AI。分支 `three-tracks-merge-20261012`，HEAD `94107db`。
> 门禁基线（动工前自测一次确认）：**vitest 78 文件 / 1000 passed / 3 skipped / 0 failed**，`npx tsc --noEmit` exit 0。
> 权威基准源码：`_reference/sillytavern-1.18.0/`（**只读参考，不入库，禁止修改**）。

---

## 0. 你要解决的问题（一句话）

Palink 对 ST 的兼容度实测：**角色卡 8.5/10、插件 5.5/10、斜杠命令 3/10、整体 6.2/10**。
其中**斜杠命令是最大短板，也是性价比最高的一块**——Palink 自己就有 92 条命令和一个完整引擎，只是**从来没注册到 ST 的 `SlashCommandParser` 上**，所以卡脚本调 `/echo` `/delay` `/setvar` 一律拿不到结果。

## 1. 实测现状（主控真机探针核实，建议复跑 §5 确认）

### 1.1 权威目标面（从 `_reference/sillytavern-1.18.0` 数出来的，不是估的）

| 口径 | 数字 | 出处 |
|---|---|---|
| `getContext()` 顶层 key | **145** | `public/scripts/st-context.js:115-306` |
| `parent.SillyTavern` 顶层字段 | **2**（`libs`、`getContext`） | `public/script.js:292` |
| 斜杠命令（去重名） | **289**（核心 222 + 内置扩展 67），另 175 别名 | 全仓扫 `SlashCommandParser.addCommandObject(SlashCommand.fromProps({name}))` |
| 内置扩展一级目录 | 15（功能扩展 13） | `public/scripts/extensions/` |
| 扩展 DOM 挂载点 | 9 | — |

### 1.2 Palink 实测（iframe 单间轨 = S5 后唯一生产路径）

| 项 | 实测 |
|---|---|
| `getContext()` 总键数 | 185（含 Palink 自有扩展键） |
| 覆盖 ST 145 键 | **135/145（93%）** |
| **真可用** | **120/145（83%）** |
| 非真可用（15） | 13 个 `stubApi` 包装 + 2 个空 class |
| 缺失（9） | `timestampToMoment`、`registerHelper`、`registerDebugFunction`、`renderExtensionTemplate`、`renderExtensionTemplateAsync`、`chatCompletionSettings`、`textCompletionSettings`、`uuidv4`、`humanizedDateTime` |
| `TavernHelper` | 76 键 / 72 真可用 / 4 桩（`messageFormatter`、`swipe`、`swipe_left`、`swipe_right`） |
| `Mvu` | 6 键（MVU beta 判据全中） |
| **`SlashCommandParser.commands`** | **0 条** 🔴 |
| Palink 自有 `lib/slash-engine/` | **92 个命令名**，与 ST 289 **同名仅 29** |

### 1.3 非真可用明细（15 项，逐项已核实）

`stubApi` 包装 13 项：
`getRequestHeaders`、`renameChat`、`saveWorldInfo`、`reloadWorldInfoEditor`、`updateWorldInfoList`、
`convertCharacterBook`、`getWorldInfoPrompt`、`getTextGenServer`、`getChatCompletionModel`、
`appendMediaToMessage`、`getMediaDisplay`、`getMediaIndex`、`scrollOnMediaLoad`

空 class 2 项：`ChatCompletionService`、`TextCompletionService`

⚠️ **已核实不是桩**（第一版探针误判过，别再改它们）：
`callPopup` / `callGenericPopup`（接 `showPopupCompat` → 宿主 `popupManager.show()`）、
`getCharacterCardFields`（`clone(character?.data || character || {})`）。
同理 `groups`=`[]` / `tags`=`[]` / `tagMap`=`{}` / `groupId`=`null` / `streamingProcessor`=`null` 都是**合法空值**（本角色无群组无标签），不是缺陷，**不要"修"它们**。

---

## 2. 任务 B-1：`SlashCommandParser` 懒代理（最高优先级，先做这个）

**问题**：卡脚本写 `executeSlashCommands('/echo xxx')`、`/delay`、`/popup`、`/setvar` 一律拿不到结果。
帧内 `SlashCommandParser.commands` 实测为空对象（`part-08.ts` 里 `SlashCommandParser: window.SlashCommandParser`）。

**现有可用资产**（不要重写命令逻辑）：
- Palink 自有引擎：`frontend/src/lib/slash-engine/`（`commands.ts` 816 行 + `extended-commands.ts` 1079 行 + `mod.ts`），**92 个命令名**
- 帧内桥：`runtime-body/part-08.ts:418-445` 的 `triggerSlashCompat` → `requestParent('runPalinkSlash')`
- 宿主落点：`SmartCardCompatController.ts:811-828`（`runPalinkSlashCommands` 命中 9 条 Palink 专有命令；未命中回落 `executeSlashCommandCompat`）
- Palink 专有 9 条：`branch-create` / `checkpoint-create` / `checkpoint-go` / `chat-fork` / `getchatname` / `model` / `profile` / `preset` / `profile-list`

**做法**：
1. **帧内把 `SlashCommandParser.commands` 做成懒代理**：查不到的名字一律转给宿主 `executeSlashCommandCompat`（已有）。这样 Palink 自有 92 条命令立刻对卡脚本可见。
2. **补 ST 高频但 Palink 没有的约 40 条薄实现**。缺失清单（ST 有、Palink engine 无，按生态使用频率排序）：
   `times`、`popup`、`pass`、`genraw`、`abort`、`stop`、`addswipe`、`delswipe`、`note`、`sysprompt`、
   `tempchat`、`newchat`、`delchat`、`closechat`、`renamechat`、`messages`、`comment`、`cut`、`flat`、`match`、
   `replace`、`sub`、`len`、`add`、`mul`、`div`、`mod`、`pow`、`round`、`min`、`max`、`sqrt`、`cos`、`sin`、`rand`、
   `hide`、`unhide`、`lockbg`、`unlockbg`、`bg`、`bgcol`、`autobg`、`beep`、`input`、`setinput`、`impersonate`、
   `sendas`、`sysname`、`sysgen`、`instruct`、`instruct-on`、`instruct-off`、`instruct-state`、`regenerate`、
   `reroll-pick`、`start-reply-with`、`context`、`flushinject`、`listinjects`、`inject`、`tokenizer`、`speak`、
   `translate`、`summarize`、`caption`、`api`、`api-url`、`persona-get`、`persona-set`
   （按语义挑能映射到 Palink 的做；ST UI 类如 `/panels` `/movingui` `/theme` 明确**不做**，见 §4。）
3. **别名**：补齐常用别名（`/m`→model、`/s`→style、`/save`→export、`/cls`→clear 等 175 条别名的常用子集）。

**成本预估**：200~400 行 + 1 个契约测试。

## 3. 任务 B-2：getContext 补 9 键 + 消 15 项非真可用

| 缺口 | 做法 | 备注 |
|---|---|---|
| `renderExtensionTemplate` / `renderExtensionTemplateAsync` | 帧内已有模板渲染，挂上去 | 插件 UI 注入主路径 |
| `timestampToMoment` / `uuidv4` / `humanizedDateTime` | 从 `TavernHelper` 同名实现挪一份到 getContext | **这三个 TavernHelper 上已经有了** |
| `registerHelper` / `registerDebugFunction` | 空实现但**存在**（ST 语义是注册、返回 void） | |
| `chatCompletionSettings` / `textCompletionSettings` | 映射到 Palink 预设对象（形状对齐即可） | |
| `ChatCompletionService` / `TextCompletionService` | 给最小可用壳（构造 + 1 个方法），避免 `instanceof`/构造炸 | |
| `getRequestHeaders` | **安全决策，先不要动**，在报告里登记为待拍板项 | 给真实头 = 把会话凭据暴露给 opaque origin 帧 |
| `saveWorldInfo` / `updateWorldInfoList` / `reloadWorldInfoEditor` | 接到 Palink 世界书写端点 | 现在"假成功"会静默丢数据 |
| `getChatCompletionModel` / `getTextGenServer` / `convertCharacterBook` | 返回 Palink 真实值（`generationEngine` 已有） | |
| `getMediaDisplay` / `getMediaIndex` / `appendMediaToMessage` / `scrollOnMediaLoad` | 映射到 Palink `extra.media` | |

**成本预估**：~200 行 + 1 个契约测试。

⚠️ 改完 `stubApi` 相关部分后，**同步更新** `runtime-body/part-08.ts` 里的 `PALINK_STUB_API_NOTES`
（它和 `getContextCompat` 是被 `st-compat-fix-batch-contract.test.ts` 双向钉住的：加了 flag 必须写说明、删了 flag 必须删说明）。

## 4. 明确**不要做**的事

| 不要做 | 原因 |
|---|---|
| 恢复"大堂轨"（主页面注入插件） | 安全倒退，S5 的核心收益就是干掉它 |
| 让 ST 扩展 UI 在角色卡内可见 | 口径 c 已拍板（2026-10-15），且技术上父侧对未信任卡全盲 |
| 硬补 `getPresetManager` / `getChatCompletionModel` 的**真实现** | Palink 模型体系与 ST 预设体系结构不同，硬补会做出"看起来对、实际错"的语义 |
| 补 `unshallowCharacter` / `getCharacterSource` | ST 私有数据水合概念，Palink 后端一次性给全量 |
| 追求 289/289 命令 | 其中约 60 条是 ST UI 类（`/bg` `/panels` `/movingui` `/theme` `/gallery`），Palink 没有对应界面 |
| `powerUserSettings` 全字段映射 | Palink 没有 ST 那套 UI 开关概念 |

## 5. 验收（必须逐项给出实测数字）

| 项 | 判据 | 怎么测 |
|---|---|---|
| 斜杠命令覆盖 | 289 条逐个 `/命令名` 打一遍，**核心 222 条里 ≥180 条有确定性返回** | 帧内探针循环 |
| `getContext` 契约 | `npx vitest run src/lib/sillytavern/__tests__/getcontext-parity.test.ts` 仍 **145/145** | — |
| 真可用率 | 真机探针：非真可用项 **≤ 3**（原 15）；缺键 **≤ 2**（原 9） | §6 探针 |
| 卡片视觉不变 | t=2s 与 t=11s 截图一致、5 个卡片宿主高度前后完全一致 | §6 探针 |
| toast 不回归 | 右上角 `[data-sonner-toast]` 里不出现新类别的告警 | §6 探针 |
| 门禁 | vitest **78+ 文件 / 全绿 / 0 failed**；`npx tsc --noEmit` exit 0 | — |
| **改坏证明** | 临时撤改动 → 命令覆盖回到 0、非真可用回到 15；还原 → 回到新数字。**两项都写进报告** | — |

## 6. 探针（复制即用，放 `D:\项目\Palink-AI\.tmp_probe\probe-cmd.js`）

用 `playwright-cli`（全局已装 0.1.17）。**playwright 会话不能跨 bash 命令持久**，`open` 和 `run-code` 必须在**同一条 bash 命令**里：

```bash
cd /d/项目/Palink-AI/.tmp_probe && playwright-cli -s=pb open http://localhost:16000 >/dev/null 2>&1; playwright-cli -s=pb run-code --filename=./probe-cmd.js
```

`probe-cmd.js` 骨架（`async page => {...}`）：

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
  const ST289 = [ /* 见 §2 的完整命令名清单，或直接用主控报告里的 289 条数组 */ 'echo','delay','times','while','if','let','run','setvar','getvar','popup','pass','abort','stop','world','note','swipe','gen','genraw','send','translate','summarize' ];
  const fr = page.frames().filter(f => f !== page.mainFrame());
  const cmd = await fr[0].evaluate((ST289) => {
    const ctx = (typeof window.getContext === 'function') ? window.getContext() : null;
    const p = window.SlashCommandParser || (ctx && ctx.SlashCommandParser);
    if (!p || !p.commands) return { hasParser: !!p, registered: 0, total: ST289.length };
    const cmds = p.commands;
    const has = (name) => {
      if (cmds[name]) return true;
      for (const k of Object.keys(cmds)) if (((cmds[k] && cmds[k].aliases) || []).indexOf(name) >= 0) return true;
      return false;
    };
    let ok = 0; const miss = [];
    for (const c of ST289) { if (has(c)) ok++; else miss.push(c); }
    return { hasParser: true, registered: ok, total: ST289.length, missSample: miss.slice(0, 40) };
  }, ST289);
  const ctxInfo = await fr[0].evaluate(() => {
    // 145 键存在性 + 非真可用分类（判据：源码含 reportStubApi( / 空 class / 空体）
    const ST145 = [ /* 145 键数组，从主控报告或 getcontext-parity.test.ts 复制 */ ];
    const stub = (v) => {
      if (typeof v === 'undefined') return 'absent';
      if (v === null) return 'null';
      if (typeof v !== 'function' && typeof v !== 'object') return 'value';
      let s; try { s = String(v); } catch(e) { return 'unprobeable'; }
      if (s.indexOf('reportStubApi(') >= 0) return 'stubApi-wrapped';
      if (/^\s*class\s+\w*\s*\{\s*\}/.test(s)) return 'empty-class';
      return 'real';
    };
    const ctx = (typeof window.getContext === 'function') ? window.getContext() : null;
    const keys = (ctx && typeof ctx === 'object') ? Object.keys(ctx) : [];
    const r = { present:0, missing:[], nonReal:[] };
    for (const k of ST145) {
      if (keys.indexOf(k) < 0) { r.missing.push(k); continue; }
      r.present++;
      const c = stub(ctx[k]);
      if (c === 'stubApi-wrapped' || c === 'empty-class') r.nonReal.push(k + '(' + c + ')');
    }
    return r;
  });
  const h1 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-palink-smart-card]')).map(h => Math.round(h.getBoundingClientRect().height)));
  await page.screenshot({ path: 'shot-b-t1.png' });
  await page.waitForTimeout(6000);
  const h2 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-palink-smart-card]')).map(h => Math.round(h.getBoundingClientRect().height)));
  const toasts = await page.evaluate(() => { const t = document.querySelector('[data-sonner-toaster]'); return t ? (t.innerText||'').slice(0,400) : '(none)'; });
  await page.screenshot({ path: 'shot-b-t2.png' });
  return JSON.stringify({ cmd, ctxInfo, hostHeights: h1, hostHeightsLater: h2, toasts }, null, 1);
}
```

改动前先跑一次存档，改动后再跑一次对比。

## 7. 开工前必读的项目纪律

1. **唯一 shell = Git Bash**。Python 一律 `py`。不可用：powershell、wget、jq、make、7z、gh、sqlite3、psql。
2. **`git commit -m` 里的反引号会被 bash 当命令替换吃掉** ⇒ 提交信息含代码标识时用 `git commit -F <消息文件>`。
3. **`runtime-body/part-*.ts` 是注入 iframe 的模板字符串**：禁止裸反引号、`${}` 插值、字符串里的裸 `\n`（写 `\\n`）、**注释里的裸 `\n`**。`generated-script-parse-guard.test.ts` 是唯一守卫，改完必跑。**这个坑本项目踩中过两次。**
4. **未信任卡 iframe 是 opaque origin**（`contentDocument === null`）⇒ 卡 DOM 逻辑必须写在帧内。
5. **桩判定不能用"花括号空体"判**：`async (...) => ( expr )` 这种圆括号箭头会被误判成桩。正确判据是源码含 `reportStubApi(` / 空 class / 空体 **三级** + 逐项源码 dump 核对。**本项目已因此误判过 3 项。**
6. **⛔ 不要动 `frontend/dist`**，**不要跑 `npm run build`**（会被安全删除守卫拦下把 dist 删一半）。需要重建只交代码，**由主控统一做**。
7. **不要按名字删文件**（`st_` 前缀不等于 ST 残留）。
8. 改 `docs/` 后跑 `py scripts/docs/gen_docs_catalog.py`。

## 8. 交付要求

1. 代码 + 契约测试，提交到当前分支（**不要自己重建 dist**）。
2. 一份完工报告放 `docs/_active/report/`，必须包含：
   - 命令覆盖改动前后数字（289 条逐条跑出的命中数）；
   - getContext 145 键的存在/非真可用改动前后对比表；
   - **改坏证明会红 + 还原证明回绿**两项实测；
   - 门禁数字；
   - **明确列出哪些没做、为什么**（尤其是 `getRequestHeaders` 这类安全决策项，写成"待主控拍板"而不是自己决定）。
3. 报告里所有"某能力在/不在"的结论必须给 `文件:行号`。
