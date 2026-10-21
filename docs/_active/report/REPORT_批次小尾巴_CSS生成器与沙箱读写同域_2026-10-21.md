# REPORT_批次小尾巴_CSS生成器与沙箱读写同域_2026-10-21

> 状态：**部分完工并已上线**（① generator、③-B4 读写同域已修且真机复验；②③-A④ 只出证据未动手）。
> 由来：派给子 agent 的"小尾巴批次"四项（① bundled-plugin-css generator、
> ② preset-session-source 实机验、③ 三处既有报错、④ style_removal 刷屏量化）。
> 该 agent 撞 **150 轮上限**中断，交付形态是"半成品 + 零报告 + 工作区不绿"。
> 现场已按中断处置纪律备份：`_BACKUPS/2026-10-21_小尾巴批次中断现场/`（含 BACKUP_INFO.md 与台账行）。
> 主脑（本文作者）串行接管收尾，**下面每条都注明"谁做的、我复跑过什么"**。

## 0. 一句话结论

① generator 是真的且能逐字节还原（我删掉产物重跑验证过）；
③-B4「RegexPresetManager 找不到预设下拉」**不是竞态，是沙箱读写不同域**，
agent 把病灶和执行型测试都写好了、但把修复的两处调用点写成 `if (false && …)` 死码 ⇒
三条用例红。我把死码接通，现在 6/6 绿、全量前端门禁绿。
②③-A④ 本轮没有可用产出，本文只补我亲手取到的证据与档位建议。

## 1. ① bundled-plugin-css 的 generator（子 agent 做，主脑独立复验通过）

产物侧现状：`frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts` 此前**只有逐字节守卫、
没有生成器** —— 一旦漂了只能人肉回忆，这正是批次E2b 留的债。

新增（子 agent 写）：
- `scripts/gen-bundled-plugin-css.mjs`
- `scripts/README.md`（写明"什么时候必须重跑"）
- `frontend/src/lib/sillytavern/bundled-plugin-css.ts` 的头注释同步改指向该命令（只动注释，5 行）

**我复跑的证据**（不是引用它的自述）：

```
$ cp …generated.ts /tmp/gen_before.ts
$ mv …generated.ts /tmp/gen_keep.ts          # 真的把产物移走
$ node scripts/gen-bundled-plugin-css.mjs
[gen-bundled-plugin-css] WROTE frontend/src/lib/sillytavern/bundled-plugin-css.generated.ts bytes=5897
$ cmp /tmp/gen_before.ts …generated.ts → REGEN_IDENTICAL
$ node scripts/gen-bundled-plugin-css.mjs     # 第二次
[gen-bundled-plugin-css] NO-CHANGE …（已是最新）   rc=0
```

⇒ **"从来源重生成 = 入库那份字节"** 成立（含 CRLF：产物实测带 `\r\n`，generator 写出的也带）。
守卫测试 `bundled-plugin-css.generated.test.ts` 在同批全量跑里绿。

## 2. ③-B4 RegexPresetManager「找不到预设下拉」＝沙箱读写不同域（主脑接通）

### 2.1 先证症状还在（一手，不引用任何二手结论）

我自己跑 WU 上线探针时抓的控制台日志（`.playwright-cli/console-2026-10-21T13-37-48-606Z.log`）：

```
11 次  RegexPresetManager: Could not find preset select element in the DOM.
```

⇒ 这条**在当前线上构建里正在发生**，不是历史遗留。原任务描述里写的"宿主 init 竞态"是**错的**，
真实病灶是下面这个。

### 2.2 病灶（子 agent 定位，我读了实现并复核判据边界）

```
写侧：$('#regex_container').append(html)  → 走 createSandboxedJQuery 的 ST 挂载点回退
       ⇒ 节点落进真实 document 的 #regex_container（React 在 #extensions_settings2 下渲染的那个）
读侧：document.getElementById('regex_presets') → sandboxedDocument 只查插件私有 container，
       container 外只对 ST_MOUNT_POINT_IDS / ST_CHAT_SELECTOR_IDS 回退
       ⇒ regex_presets 两个名单都不在 ⇒ 返回 null ⇒ 插件 console.error 后 return
       ⇒ 预设下拉的 change/create/update/apply/delete 监听器永远不挂
```

⇒ **写面比读面宽**：插件能写进去，却读不到自己刚写进去的东西。

### 2.3 修法与它的边界（这条是我复审的重点）

`sandbox.ts` 新增 `isInsidePluginWritableMount(el)`：沿 `parentElement` 上溯（深度上限 64，到 `body` 停），
只有当祖先命中 **① `ST_MOUNT_POINT_IDS`** 或 **② 带 `data-sandbox-created-container` 的惰性容器** 时才回退。
两处调用点：`getElementById` 分支、`querySelector` 的纯 `#id` 分支（同一口径）。

**我逐项核过放开的面**：`ST_MOUNT_POINT_IDS`（`sandbox.ts:1477-1505`）全是扩展容器
（`extensions_settings`/`extensions_settings2`/各 `*_container`/`*_wand_container`/`movingDivs`…），
**不含 `#chat`**；`#chat`、`#gal-global-overlay` 在另一个名单 `ST_CHAT_SELECTOR_IDS`（`:1512`）里，
本批没动它的判定。⇒ 这条回退**不会**让插件读到消息正文所在子树，读面没超出既有写面。

测试 `frontend/src/lib/plugin-system/__tests__/b4-regex-preset-select-mount.test.ts`（6 例，执行型）
不是造夹具：真 `PluginSandbox` + **真 `st-plugins/regex/dropdown.html`**（8745 字节，从磁盘读）。
其中两例正是钉边界的：
- ③ `#app-internal-node`（在 `#root` 下但不在挂载点内）必须**继续读不到**；
- ⑤ 同名 id 挂在非挂载点子树里必须仍返回 null（防止"只看名字就放行"）。

### 2.4 我接通前 / 接通后的实测

```
接通前（现场态，两处 if (false && …)）：
  Test Files  1 failed | 1 passed (2)
  Tests       3 failed | 7 passed (10)     ← ②④⑥ 红，即"修复本体"三条

接通后：
  ✓ b4-regex-preset-select-mount.test.ts (6 tests)  →  Tests 6 passed (6)

全量：bash scripts/gate.sh frontend
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest
  全部门禁通过（rc=0）
  →  Test Files 131 passed (131)
     Tests 1690 passed | 3 skipped (1693)
```

⚠️ ~~**本条未上线**~~ → **已上线并真机复验**（见 §2.5）。

### 2.5 上线（第十次窗口）与真机判据

```
备份   _BACKUPS/2026-10-21_dist重建前_小尾巴B4上线/dist_before.tar.gz
       （8988 文件，改前入口 index-B1gYRfbW.js）
构建   VITE_OUT_DIR=dist_b4 node scripts/build-vite.mjs → ✓ built in 51.56s
覆盖   cp -r dist_b4/. dist/（只增不删 8988 → 9110）→ gzip 3931
产物判据（只能 grep 字面量）：
  data-sandbox-created-container 在入口 chunk 里 改前 2 次 → 改后 **3 次**
    （多出的一次就是 isInsidePluginWritableMount 的 hasAttribute 检查）
  插件网络白名单 在 SettingsView chunk 仍 2 次（WU 没被这次重建挤掉）
服务   curl :16000/ 入口 = index-DfHH7IYY.js
```

真机复跑（`.tmp_probe/b4_live.js`，会话 `b4_live1`，同一张卡、18s 等待、零生成不花钱）：

```json
{ "login": 200, "entryHash": "/assets/index-DfHH7IYY.js",
  "totalErrKinds": 25,
  "presetSelectErr": 0,        // ← 改前同一判据实测 11
  "regexPresetAny": [],        // RegexPresetManager 一类报错整族消失
  "qrSetsLines": 2,
  "whitelistStillThere": null }
```

⇒ **上线前 11 次、上线后 0 次**，且错误种类 27 → 25。这条是真机闭环，不是单测外推。
（`whitelistStillThere: null` 是因为这是**新开的浏览器会话**、localStorage 干净，
不是 WU 回退 —— WU 的产物判据在同一个 dist 里已单独核过。）

⇒ 但**快捷回复集仍保存不下来**：`[QR2] sets` 还在，`/api/quick-replies/save` 仍是 404，
那是 §3 的 P2-15（后端缺端点），与本条是两个不同的洞，别混。

## 3. ③-A `/api/quick-replies/save` 404 —— 定性完成，**没动手**（需用户点头）

证据（全部一手 grep / 读上游）：

- 调用方：`st-plugins/quick-reply/src/QuickReplySet.js:377`（save）与 `:392`（delete），
  是插件自己在保存/删除快捷回复集时发的 `fetch('/api/quick-replies/save', …)`。
- ST 侧确实有这**两个端点**：`/d/SillyTavern-release/src/server-startup.js:146`
  把 `src/endpoints/quick-replies.js` 挂到 `/api/quick-replies`，该文件 `:9/:22` 是
  `POST /save` / `POST /delete`，落盘 = 按 `body.name` 写 `quickreplies/<name>.json`。
- Palink 侧：**全仓无该路由**（`grep -rn "quick.repl" backend/app/api/*.py` 命中 0 个路由定义）。
  唯一提到它的地方是 `backend/app/api/silly_tavern.py:6044` 的注释
  ——「QR 数据存储在 `user_settings.silly_tavern_settings.extension_settings.quickReply.sets`
  （**与 /api/quick-replies/save 复用同一存储**）」⇒ **注释承诺了一个从没建的端点**。
- 现场旁证：探针日志里 `[QR2] sets: []`（快捷回复集永远是空），与该 404 方向一致。

⇒ 这不是"噪音"，是**bundled 插件的一个用户功能实际不可用**（保存快捷回复集会失败）。

**为什么不顺手补**：这是**新增后端可写端点**（鉴权 + CSRF + 作用域 + 写进哪张表都要定），
且改后端必须重建镜像才生效。两条可选档位：
1. 按 ST 语义补 `POST /api/quick-replies/save|delete`（挂在现有 `silly_tavern_router`，
   沿用 `get_st_current_user` 与 csrf_guard，存储写进注释里那个 `extension_settings.quickReply.sets`）；
   ⇒ 与 ST 一致，代价是新增一个写面 + 要重建后端。
2. 前端轨改写：把这两个 URL 重定向到既有 `POST /api/plugins/runtime/settings`。
   ⇒ 不加新端点，但与 ST 不同形，且要证明 body 形状能透传。
主脑建议：**选 1**（"越像 ST 越好"是用户裁定；且 2 会让插件行为依赖我们的重写规则，
将来上游一改就漂）。等用户点头再开工。

## 4. ③-C `/st/locales/zh-cn.json` 404 —— 定性完成，**没动手**（版权 + 体积，需用户点头）

- 调用方是**我们自己的代码**：`frontend/src/lib/i18n/index.ts:74`
  `fetch('/st/locales/${normalized}.json')`，失败时 `:76` 静默返回 `{}`。
- 资产根本不存在：`ls frontend/public/st/locales/` → **No such file or directory**。
  ⇒ 这条"异步加载 ST 文案"的能力**从来没有生效过**，每次调用都吃一个 404。
- 上游有多大规模：`/d/SillyTavern-release/public/locales` 实测 **2.4 MB**（十几个语言），
  其中 `zh-cn.json` 单文件 **287,692 字节**。

⇒ 补法只有两种，都要用户定：① 把我们 `ST_LOCALES` 声明支持的那几个语言文件搬进
`frontend/public/st/locales/`（AGPL 上游的翻译数据，且是**按需懒加载**、不进入口包）；
② 认定这条永远不做，删掉取用路径 + 那 30 行死代码，让 404 与"看起来支持 i18n"一起消失。
⛔ 我没擅自搬，因为这是版权与体积的判断，不是技术判断。

## 5. ④ `style_removal` 刷屏 —— 量化完成（**一条代码都没改**，等裁定）

对同一份会话日志（含 2 次页面加载，最后一次是 WU 上线后真机跑的）：

```
总条数            840
630  style_removal[node_removed] … first=STYLE#-               （匿名 <style>，卡自己注入又自己搬走）
175  style_removal[node_removed] … first=STYLE#palink-st-plugin-css-*   ← 被删的是**我们注入的插件 CSS**
 35  style_removal[node_removed] … first=STYLE#tavern-cg-album-style    ← 卡内 CG 图鉴自己的样式
```

要点：**全部是 `node_removed` 型**（监听 MutationObserver 的 removedNodes），
每条都带 `removedStyledCount/addedCount/textLen` 等计数；同帧重复上报，没有按节点去重。

三档与代价：
1. **维持现状**（全量逐条上报文本）：取证最全，代价是控制台 840 条/两轮加载，
   把别的有效报错埋掉 —— 本批 §2.1 那条"找不到预设下拉"就是在这堆噪声里被数字淹没的。
2. **帧内去重后上报**（同 `target+first+removedStyledCount` 组合只报首次 + 累计次数）：
   保留"发生了多少次"，丢掉重复行。代价：丢掉逐次时序，排查"什么时候开始漂"会难一点。
3. **降级为计数**（只进 `__palinkCompatStats` 的计数器，不 console 出行）：控制台干净，
   诊断导出仍可查。代价：真机肉眼看不到，必须开诊断面板才知道。
主脑建议 **2**：`style_removal` 的历史价值是定位"卡把插件样式搬走"这一型，
已经定位完了（包J/包N），现在它的边际作用是遮噪。⚠️ 与 `docs/OPEN_ISSUES.md` 的"遗留②"方向可能冲突，
所以**留给用户裁定，我没动**。

## 6. ② preset-session-source 实机验 —— **本轮没做，零产出**

子 agent 中断前没碰这条，主脑本轮预算用于接通与复验 ①③-B4。
现状维持不变：那条只有**代码级确认**，缺"设置页无会话时 sessionId 到底取到什么"的实机读数。
要补的最小动作已写好可复用：`.tmp_probe/wu_live.js` 是同套路（登录 → 走 UI → 只报键名与长度），
改目标即可，且必须遵守"不触发任何模型生成"（网关余额是付费的，探针一律零生成）。

## 7. 门禁与交付边界

```
bash scripts/gate.sh frontend
  ✓ 前端 tsc --noEmit
  ✓ 前端 vitest   →  Test Files 131 passed (131)
                      Tests 1690 passed | 3 skipped (1693)
  全部门禁通过（rc=0）
```

（用例数随并行会话增长，判据只认 `failed = 0`；本批净增 6 例 = B4 那份。）
后端与文档门禁：本批**没有后端改动**；`docs/_CATALOG.md` 已随本文刷新并 `--check` OK。
**上线状态**：③-B4 与 CSS 注释改动**已随第十次窗口上线并真机复验**（§2.5）；未重建后端镜像（③-A/③-C 两条在等用户点头）。
