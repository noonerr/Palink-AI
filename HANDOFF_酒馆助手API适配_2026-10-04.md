# HANDOFF — 酒馆助手（JS-Slash-Runner）API 适配

> **交接时间**：2026-10-04 01:06
> **交接原因**：用户要求换 Agent 接手——「有一些功能是我想做、但当前这个软件暂时做不到的」（限制清单见 §12）
> **上一份相关文档**：`docs/REPORT_酒馆助手API适配查验_2026-10-03.md`（843 行，本轮的完整审计 + 每步物证，**接手前必读**）
> **目标读者**：接手「让 ST 生态卡在 Palink 原生 UI 跑通」这条线的 agent

---

## 0. 三十秒速览

**做了什么**：把「酒馆助手」这条插件链从「看着能用」打到「关键功能真机可用」。
四轮改动、4 个文件（+339/−34）、3 个新增文件，**全部真机验证过**。

**现在的状态**：

| 能力 | 状态 |
|---|---|
| 卡脚本依赖的第三方库（z / Vue / lodash / YAML / showdown） | ✅ 已提供 |
| 变量引擎 `window.Mvu` | ✅ 已挂载，`getMvuData()` 返回真实变量 |
| 变量结构 schema 注册 | ✅ |
| MVU 设置面板 | ✅ 渲染 |
| Galgame 界面面板 + 12 个按钮 | ✅ 渲染可点（截图见 `docs/酒馆助手修复后_galgame面板_2026-10-03.png`） |
| 相册悬浮按钮 + 弹窗 | ✅ |
| 生成类事件（`GENERATION_STARTED/ENDED`） | ✅ 已桥接，实测可达 |
| Live2D 立绘 | ✅ `Live2DManager.isReady = true` |
| JS 报错 | ✅ 归零 |

**最大的教训**（三条，都是「查错了方向」）：

1. **真凶不是插件，是 Palink 自己**：`cleanupGalgameState()` 每次加载**主动删掉**插件的启用开关 →
   面板永远不出现。它是当年修不了「插件认错角色」而打的**症状级 workaround**。
2. **"缺 Mvu" 不是缺 Mvu**：MVU 引擎在**模块顶层**就调用了一串 Palink 缺失的 API，
   第一个（`SillyTavern.saveChat`）就抛错 → 整个模块死掉。**必须逐层剥链**，不能只看最后一句报错。
3. **跨域屏蔽会吃掉真实堆栈**：不关 `--disable-web-security`，只能看到 `Script error.`，
   永远查不到 `_.debounce(SillyTavern.saveChat)` 这一行。

---

## 1. 环境与入口

| 项 | 值 |
|---|---|
| 项目 | `D:\项目\Palink-AI`（主区） |
| 前端 | http://localhost:13000（容器 `palink-ai-frontend-1`，nginx 8080→13000） |
| 账号 | `admin` / `admin123` |
| 容器 | `palink-ai-backend-1` / `palink-ai-frontend-1` / `palink-ai-db-1` / `palink-ollama` |
| 当前上线入口 | **`index-4-8sIwLv.js`** |

**必读的三个仓库文件**（动工前）：

- `AGENTS.md` —— 主攻方向 + **§备份与清理规范（强制）** + 门禁基线
- `TODOS.md` —— 跨 agent 待办（1.6k 行，按需 grep）
- `docs/SOP_Agent交付自查清单.md` —— **声称「已完成」前必读**，11 类失误模式

---

## 2. 四轮改动明细

### 第 1 轮：卡脚本的第三方全局（用户裁定「先修前两项」）

| 文件 | 改动 |
|---|---|
| `frontend/src/lib/sillytavern/st-third-party-globals.ts` | **新增**（195 行）。从 `testingcf.jsdelivr.net` 装 `_`(lodash 4.17.21) / `Vue`(3.5.13 runtime global) / `showdown`(2.1.0) / `z`(zod **4.4.3** ESM) / `YAML`(2.8.1 ESM)。幂等 + 8s 超时 + 失败走 `recordStubHit('st-global:<名>')` |
| `.../__tests__/st-third-party-globals.test.ts` | **新增**（153 行，6 例） |
| `.../views/character/CharacterChat.tsx` | 卡脚本 effect 改 async：先 `await ensureStThirdPartyGlobals()` 再 `runCardTavernHelperScripts()`（+69/−25） |

**为什么必须走 CDN 而不是打进 bundle**：与仓库既有口径一致（`security-headers.conf` 已为「允许卡片执行自带脚本并从 CDN 拉库」放行 `*.jsdelivr.net`），且卡内脚本本身就是从 `testingcf.jsdelivr.net` 拉的。

### 第 2 轮：iframe 父窗口别名

| 文件 | 改动 |
|---|---|
| `.../smart-card-runtime/frame-shim/legacy-st-sim.ts` | `[PARENT-ALIAS]` 新增 `ST_GLOBAL_KEYS` 白名单（+42 行）。**返回 iframe 自己的同名全局**，与既有 `jQuery`/`$` 同策略，**不暴露真实父帧**；`has` trap 同步扩表 |

**根因**：原白名单把 `SillyTavern` 挡成 `undefined` → 插件 `getCurrentCharacterSnapshot()` 拿到空 →
`currentCharId: default` → 所有「按角色」的配置读不到。
主页面日志是 `露缇雅1.2::slot::1333400005`，iframe 里是 `default`。

### 第 3 轮：真凶 + 变量引擎 + 事件 + Live2D（用户「继续修」）

| 文件 | 改动 |
|---|---|
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | **+245 行**，三处：① `cleanupGalgameState()` 整键删除 → **定向清 `default`**；② 新增 `[MVU-UNBLOCK]` 段；③ `on/off` 事件桥 + `SELF_EMITTED_EVENTS` + `unloadAll` 退订 |
| `frontend/nginx.conf` | +17 行，新增 `location ^~ /live2d/`（CORS） |

**① 真凶**：`cleanupGalgameState()` 无条件 `localStorage.removeItem('galgame-ui-plugin_char_enabled')`。
插件本体全仓 `removeItem` **零命中**——是 Palink 删的。
改法：只删 `default` 这个脏键（身份识别失败的产物），保留按角色条目。**防护意图保留、误伤去掉。**

**② `[MVU-UNBLOCK]`** —— 补 MVU bundle 模块顶层就要用的 API：

| 补的 | 为什么 |
|---|---|
| `SillyTavern.saveChat` / `saveChatConditional` | bundle 顶层 `_.debounce(SillyTavern.saveChat, 1e3)`，缺则 `TypeError: Expected a function` |
| `getScriptId` / `getScriptName` / `getIframeName` / `getScriptInfo` / `reloadIframe` | 上游「同名脚本去重」机制（`(0,i.Ou)('MVU变量框架').listenPreferenceState`） |
| `#tavern_helper` 容器（含 `div[data-script-id]`） | 上面那个去重机制要查这个容器 |
| `getTavernHelperVersion`(`'3.4.17'`) / `getTavernVersion` | MVU 有 **≥ 3.4.17 硬门槛** |
| 脚本按钮族（`getButtonEvent` / `getScriptButtons` / `replaceScriptButtons` / `updateScriptButtonsWith` / `appendInexistentScriptButtons` / `eventOnButton`） | 同族调用，缺则抛错 |
| `#extensions_settings2` 挂载点 | MVU 设置面板的挂载容器 |

**③ 事件桥**：`SillyTavernPluginRuntime.on()` 现在同时订阅 `eventBus`。
**两个必须**：**解包 args**（总线把 `...args` 打包成数组当单 payload）；
**排除自 emit 的名字**（`SELF_EMITTED_EVENTS`），否则同一逻辑事件投递两次。

**④ Live2D**：iframe 是 opaque origin，加载父页面源 `/live2d/*.js` 被判跨源，响应无 ACAO → 拦。
加 `Access-Control-Allow-Origin: "*"` 后 `Live2DManager.isReady = true`。

---

## 3. 可复用的经验（方法论）

### 3.1 查「第三方脚本为什么没生效」的正确顺序

```
① 先确认代码真的执行了（DOM 里有没有注入节点 / 控制台有没有它的日志）
② 再抓**第一句**报错，不要看最后一句
③ 跨域脚本的报错会被屏蔽成 "Script error." → 临时加 --disable-web-security 取真实堆栈
④ 每补一个缺口就重跑，**逐层剥链**（我剥了 4 层才到 Mvu）
⑤ 补完必须用**正式构建**（不是注入桩）复验
```

### 3.2 三条硬坑

1. **`sillyTavernPluginRuntime.ts` 的 setup 脚本是模板字符串** —— 内部**不得出现反引号或 `${`**。
   我在注释里写了 `` `#tavern_helper` `` → 直接 `TS1005`。
   改完必须扫：`awk 'NR>=<起> && NR<=<止> && (/`/ || /\$\{/)' <file>`
2. **`legacy-st-sim.ts` 的 `LEGACY_ST_SIM_SEGMENT` 同样是模板字符串**，约束相同；
   文件头还要求改完跑 `node scripts/verify-shim-identity.mjs`（基线见 §5）。
3. **`EventSourceWrapper.emit` 把 `...args` 打包成数组**（`lib/sillytavern/runtime.ts:378`）——
   任何从总线接事件的代码都**必须解包**，否则插件收到 `[message_id]` 而不是 `message_id`。

### 3.3 判断「该不该补」的尺子

**只读 = 可补；写库 / 代码执行 = 先问。** 详见 §7 与报告 §9.12。

---

## 4. 改动文件清单（**全部未提交 git**）

```
 M  _BACKUPS/_INDEX.md
 M  frontend/nginx.conf                                              (+17)
 M  frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts   (+42/-?)
 M  frontend/src/components/views/character/CharacterChat.tsx        (+69/-25)
 M  frontend/src/utils/sillyTavernPluginRuntime.ts                   (+245/-?)
 ?? frontend/src/lib/sillytavern/st-third-party-globals.ts           (新, 195 行)
 ?? frontend/src/lib/sillytavern/__tests__/st-third-party-globals.test.ts  (新, 153 行)
 ?? docs/REPORT_酒馆助手API适配查验_2026-10-03.md                      (新, 843 行)
 ?? docs/酒馆助手修复后_galgame面板_2026-10-03.png                     (新, 证据截图)
 ?? HANDOFF_酒馆助手API适配_2026-10-04.md                             (本文件)
```

**提交纪律**：逐项 `git add -- <path>`；**禁用 `git add -A` / `git add .`**（多 agent 合住仓库）。

---

## 5. 备份 / 隔离区 / 台账

| 目录 | 内容 |
|---|---|
| `_BACKUPS/2026-10-03_酒馆助手脚本全局与父窗口别名/` | `pre/` 4 个源文件（原相对路径）+ `_manifest.tsv`(4 行 sha256) + **`shim-snapshot-after.txt`**（shim 字节快照，SHA256 `2d5d726b…`，含 `ST_GLOBAL_KEYS` 4 处）+ `_SHIM_SNAPSHOT_NOTE.md` |
| `_BACKUPS/2026-10-03_dist重建前_酒馆助手全局与父窗口别名/` | `dist/` 280 文件 / 14M + `dist_manifest.sha256`(280 行)。入口 `index-BrocModw.js` |
| `_BACKUPS/_QUARANTINE_2026-10-03/` | `dist_new_4` / `dist_new_5` / `dist_new_6` / `dist_new_7`（4 个中间构建产物，**待用户确认后删**） |

⚠️ **shim 快照基线**：仓库此前**没有任何** shim 基线，`legacy-st-sim.ts` 文件头却要求改完比对。
本目录里的 `shim-snapshot-after.txt` 是**第一份基线**，下次动 shim 时用它做 `compare`。

---

## 6. 门禁与上线口径

```bash
# 类型
cd frontend && npx tsc --noEmit                      # 期望 exit 0
# 测试（2026-09-23 起唯一入口；test:contract 已作废）
cd frontend && npx vitest run                        # 期望 failed = 0（本轮 51 文件 / 671 passed / 3 skipped）
# 后端（本机必须用系统 py -3；托管 python 没 pytest）
cd backend && py -3 -m pytest tests/ -q --basetemp=D:/tmp/pt
```

**重建前端产物的正确姿势（不要用 `npm run build`！）**：

```bash
cd frontend
VITE_OUT_DIR=dist_new_N node scripts/build-vite.mjs      # 旁路构建（clean-dist 会跳过）
cp -r dist_new_N/. dist/                                 # 原地覆盖（不删旧 chunk）
node scripts/gzip-dist.cjs                               # 生成 .gz
docker compose exec frontend nginx -s reload             # nginx.conf 改动只需 reload
# 确认容器服务新指纹：
docker compose exec frontend sh -c "grep -oE 'index-[A-Za-z0-9_-]+\.js' /usr/share/nginx/html/index.html | head -1"
```

> `npm run build` 里的 `clean-dist.cjs` 会**清空在用 dist**（删掉历史 hashed 资源），
> 而 dist 是 nginx bind mount 的在用产物 → 白屏。**历史上踩过。**

---

## 7. 未完成项（按优先级 + 风险）

### 🟢 P0 —— 建议做，零写库风险（约 25 项）

| 项 | 说明 |
|---|---|
| **脚本按钮栏 UI** | **最该做的一项**。`getScriptButtons()` 已返回 **6 个已注册按钮**（MVU + 对话渲染系统都注册成功），但页面上 `#palink-script-buttons` / `.tavern-script-buttons` **查无此元素** → 按钮数据有了、没地方画。这是「按钮点不到」的**最后一个原因** |
| `window.TavernHelper` 总目录 | 主页面仍缺（iframe / 沙箱有）。卡脚本写 `TavernHelper.xxx` 一律失败 |
| 事件族补全 | `eventOnce` / `eventEmitAndWait` / `eventClearEvent` / `eventClearListener` / `eventClearAll` / `iframe_events` —— 纯前端，零成本 |
| 角色读取族 | `getCharacter` / `getCharData` / `getCurrentCharacterId` —— **沙箱轨已有实现，搬过来即可**（`plugin-system/sandbox.ts` 的 `sandbox` 对象有 92 个键，是现成参考） |
| 只读类 | 世界书读 8 项 / 预设读 3 项 / 人设读 5 项 / 正则读 3 项 |
| 常量类 | `builtin` / `default_preset` / `EjsTemplate` / `RawCharacter` 等 |

### 🟡 P1 —— 需产品拍板

| 项 | 说明 |
|---|---|
| **变量写入通道** | `updateVariablesWith` = undefined；`getVariable` = undefined；`setVariable` 的函数体**就是降级桩**：`function(){D("setVariable","卡内脚本回写会话变量未开放（Palink 变量更新走后端 MVU 链路）")}`，调用后 `__palinkCompatStats` 多一条 `setVariable:1`。→ **MVU 能读变量、写不进去**。⚠️ 这是 Palink **刻意**关的边界，动它要先问用户 |
| 生成控制 / 音频 / 正则写 / 消息写 | 有真实卡需要再逐项评估 |

### 🔴 P2 —— **明确不做**（约 45 项，理由见报告 §9.12）

角色/世界书/预设/人设的**写** + `importRaw*` + `installExtension` 族。
**四条真风险**：① 数据源分裂（双写）；② 权限模型被绕过（卡脚本是普通用户内容，却拿到管理员能力）；
③ 任意代码执行（且**来源卡 BanG! City 已不在库里** = 来源不明的 4MB 第三方脚本）；
④ 不可逆操作无确认。

> ⚠️ **请在文档里保留「为什么不补」的理由**，否则后续 agent 会以为这是遗漏而"顺手补上"。

### ⚫ 已知残留（当前无用户可见影响）

- iframe 内那个**影子实例**仍报一次 `PIXI.live2d 未就绪`（它读 `window.parent.PIXI`，而 PIXI 只在主页面加载）；它的 UI 本来就不可见
- iframe 与主页面的 per-character key 不一致（`slot::0` vs `slot::<哈希>`）；统一要动 `this_chid` 语义，属独立议题
- 同一份插件脚本在主页面与 iframe **各跑一遍**（跨环境无去重）
- `/live2d/` 开了 `ACAO: *`（唯一的安全面变化，评估见报告 §9.12.4）

---

## 8. 自查与补救（**我自己的失误，如实记录**）

写本交接文件前做了一次自查，**发现两条违反《备份与清理规范》的问题**，已当场补救：

| # | 问题 | 违反 | 补救 |
|---|---|---|---|
| 1 | `_BACKUPS/2026-10-03_dist重建前_酒馆助手全局与父窗口别名/` **没有 `BACKUP_INFO.md`** | 规范第 2 条（无说明文件 = 无效备份） | 已补写，含四要素 + 4 条待办 |
| 2 | 该目录**从未登记 `_BACKUPS/_INDEX.md`** | 规范第 3 条（台账登记） | 已补登记行 |

**教训**：**备份不是「拷完就完」**——`mkdir + cp` 之后还有两步（写 `BACKUP_INFO.md`、登记台账）容易被漏，
而漏了就等于**这个备份不被承认**。建议接手人把这两步写成一次性脚本或 checklist。

另：两个备份目录名不统一（`..._酒馆助手脚本全局与父窗口别名` vs `..._dist重建前_酒馆助手全局与父窗口别名`），
**本次不改名**（改名要另加 `_RENAME_NOTE.md`，避免额外 churn），仅在此登记。

---

## 9. 可复用的验证脚本

我这轮写了一批 Playwright 探针（在隔离工作区 `C:\Users\Pall\.workbuddy-ai\binaries\node\workspace\`，
**未入库**）。环境搭建：

```bash
# playwright-core 装到隔离工作区（用系统 Chrome，不下载浏览器）
cd "C:/Users/Pall/.workbuddy-ai/binaries/node/workspace"
"C:/Users/Pall/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe" \
  "C:/Users/Pall/.workbuddy-ai/binaries/node/versions/22.22.2-3/node_modules/npm/bin/npm-cli.js" \
  install playwright-core --no-audit --no-fund
# 脚本必须放在 workspace 目录内跑（ESM 不认 NODE_PATH）
# 截图路径写 C:/tmp/pw/（Node 里 '/tmp' 会被解析到当前盘根）
```

**登录取数骨架**（所有探针都是这个开头）：

```js
const b = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{ width:1440, height:900 } });
await p.goto('http://localhost:13000/login',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(1500);
await p.fill('input[placeholder="Username"]','admin');
await p.fill('input[placeholder="Password"]','admin123');
await p.click('button:has-text("Sign In")'); await p.waitForTimeout(4000);
await p.goto('http://localhost:13000/characters',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(3000);
await p.locator('button:has-text("开始对话")').first().click(); await p.waitForTimeout(22000);
// ← 之后 p.evaluate(...) 取数
```

**关键技巧**：

- **取真实堆栈**：launch args 加 `--disable-web-security`（不加只能看到 `Script error.`）
- **判别报错来自哪个帧**：`p.on('console', m => m.location().url)`；或对 `p.frames()` 逐个 `evaluate`
- **验证事件桥**：`window.eventOn('generation_started', cb)` 注册，再 `window.SillyTavern.eventSource.emit('generation_started', 'normal')` 发，看 cb 是否收到且**参数已解包**

---

## 10. 交接时的最短路径

```
① 读 docs/REPORT_酒馆助手API适配查验_2026-10-03.md（843 行，每步都有物证；§0 是结论速览，§9.12 是风险边界）
② 起容器 → 打开 :13000 → 进任意带 tavern_helper 脚本的卡 → F12 确认：
     typeof Mvu / typeof z / typeof Vue / typeof PIXI / window.__palinkCompatStats
   期望：object / object / object / object / 干净
③ 决定是否做「脚本按钮栏 UI」（§7 的 P0 首项）—— 这是最后一块「按钮点不到」的拼图
④ 若要做，先看沙箱轨现成实现：frontend/src/lib/plugin-system/sandbox.ts 的 sandbox 对象（92 键）
⑤ 动工前：备份三步（mkdir+cp → BACKUP_INFO.md → 登记 _INDEX.md），门禁 tsc + vitest
```

---

## 11. 用户侧待办 / 需要人工确认的

| # | 事项 | 说明 |
|---|---|---|
| 1 | **隔离区 4 个 `dist_new_*` 是否删除** | 内容已合进在用 dist，属冗余；按规范需用户确认后才删 |
| 2 | **本批改动是否提交 git** | 目前**全部未提交**。用户未表态 |
| 3 | **变量写入通道要不要开** | 见 §7 P1。开了 MVU 才能写变量，但要改 Palink 的变量策略 |
| 4 | **脚本按钮栏 UI 放哪里** | 需要 UI 设计决策（贴聊天输入框上方？还是插件面板里？） |
| 5 | **「补齐全部 API」的边界** | 见 §7 P2，建议明确写"不做"，避免后续 agent 误补 |

---

## 12. 当前工具做不到的事（交接的直接原因）

以下是我这轮**确实做不到**、需要别的 agent / 人工介入的：

| # | 做不到的 | 影响 / 绕法 |
|---|---|---|
| 1 | **读用户真实浏览器的 localStorage** | 我只能起 headless Chrome（全新 profile）。所以**无法复现"用户已经启用过插件"的状态**——我是靠 `p.evaluate` 手工写入启用标记来模拟的。用户实际配置里如果还有别的脏键，我看不到 |
| 2 | **在用户的真实浏览器里操作** | 无法让用户直接看到我的操作过程；只能给截图和脚本 |
| 3 | **触发真实 LLM 生成做端到端验证** | 会污染用户聊天记录 + 消耗额度。所以事件桥的验证我用的是「从 ST runtime 的 eventSource 发事件」替代真实生成。**「AI 说完话面板会不会真的刷新」这一条仍未经真实生成验证** |
| 4 | **移动端 / 真机验证** | 全部验证都在桌面 headless Chrome 上做的 |
| 5 | **恢复那张来源卡（BanG! City）** | 卡已从库中删除，磁盘上也没有文件；那 4MB 脚本**只剩数据库一份**。要不要导出留档需用户拍板 |
| 6 | **UI 设计决策** | 脚本按钮栏长什么样、放哪里，属产品/设计判断，我不该自己定 |
| 7 | **跨会话的长时间观察** | 例如「变量更新在连续多轮对话后会不会累积出错」，需要有人真的用一段时间 |

---

## 13. 文件索引

| 文件 | 角色 |
|---|---|
| `docs/REPORT_酒馆助手API适配查验_2026-10-03.md` | **主文档**：完整审计 + 每步物证 + 风险评估（843 行） |
| `docs/酒馆助手修复后_galgame面板_2026-10-03.png` | 修复后截图（Galgame 工具条 12 个按钮可见） |
| `frontend/src/lib/sillytavern/st-third-party-globals.ts` | 第三方全局装载器（新） |
| `frontend/src/lib/sillytavern/__tests__/st-third-party-globals.test.ts` | 其契约测试（新，6 例） |
| `frontend/src/utils/sillyTavernPluginRuntime.ts` | 主战场：cleanup 定向清脏 + `[MVU-UNBLOCK]` + 事件桥 |
| `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts` | `[PARENT-ALIAS]` 白名单 |
| `frontend/src/components/views/character/CharacterChat.tsx` | 卡脚本 effect 改 async |
| `frontend/nginx.conf` | `/live2d/` CORS |
| `_BACKUPS/2026-10-03_酒馆助手脚本全局与父窗口别名/` | 源文件备份 + shim 基线 |
| `_BACKUPS/2026-10-03_dist重建前_酒馆助手全局与父窗口别名/` | dist 回滚点 |

**未改但相关**：

| 文件 | 关系 |
|---|---|
| `frontend/src/lib/plugin-system/sandbox.ts` | **沙箱轨**，92 键的现成参考实现（缺的 API 大多这里已有） |
| `frontend/src/lib/sillytavern/runtime.ts` | `EventSourceWrapper` —— 事件桥的参照实现（:346 wrapCallback / :360 on / :378 emit） |
| `frontend/src/lib/sillytavern/plugin-character-id.ts` | 角色 id 派生（UUID → 数字）的唯一实现 |
| `backend/app/services/mvu_engine.py` | Palink 自有的变量引擎（后端链路） |
| `st-plugins/third-party/JS-Slash-Runner-main/` | 上游源码 —— **补 API 前先看 `@types/` 与 `src/function/*.ts`，别猜签名** |
