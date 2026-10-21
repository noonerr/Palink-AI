# REPORT_批次QR与I18N_快捷回复落库与ST语言资产_2026-10-21

> 状态：**两批均已完工、已上线、真机闭环**（第十一次上线窗口，前后端都动）。
> 用户裁定原文：① `可以，根据你调研的来`（快捷回复那两个端点）；
> ② `那就进行适配`（`/st/locales/*.json` 404 那条）；
> ③ `这个你再仔细研究下`（`style_removal` 刷屏 —— 另见
> `REPORT_style_removal机制研究_2026-10-21.md`，本文只给结论与裁定建议）。

## 0. 两句话结论

- **快捷回复集此前存不下来**，根因不是"缺端点"这么轻：写侧只打两个 404 地址，
  读侧只认 `settings/get` 里一个**全仓没人写过**的键 ⇒ 两侧永久错位。补完两个端点后
  真机 `[QR2] sets: []` 变成 `[QR2] sets: [QuickReplySet]`。
- **ST 语言文件此前从未生效过**，根因是"清单是愿望清单"：声明 17 个 locale，
  而资产目录整个不存在，读取侧非 200 时**静默返回空对象** ⇒ 没人报错、插件永远拿英文原 key。
  搬入文件 + 把清单收成"有文件才有名字"，真机 `/st/locales/zh-cn.json` **404 → 200**（3645 条，gzip 95,819 字节）。

## 1. 批次QR：`/api/quick-replies/save|delete`（提交 `dc76b3a`）

### 1.1 根因链条（每一环都有行号，插件侧是本仓 vendored 源码，ST 侧是上游一手）

| 环 | 物证 |
|---|---|
| 插件写侧只打这两个地址 | `st-plugins/quick-reply/src/QuickReplySet.js:377`（save）`:392`（delete），body = `JSON.stringify(this)` |
| 本仓**全仓无该路由** | `grep -rn "quick.repl" backend/app/api/*.py` ⇒ 命中 0 个路由定义（只有 `silly_tavern.py:6044` 一条注释承诺过它） |
| 插件读侧只认一个字段 | `st-plugins/quick-reply/index.js:47-55` `loadSets()` 取 `settings/get` 的 `quickReplyPresets`，逐条 `QuickReplySet.from(...)` 推进 `QuickReplySet.list`（`:92`） |
| 后端读侧取的键**没人写** | `_extract_quick_reply_presets` 读 `extension_settings.quickReplyV2.sets`；而插件自己的 `QuickReplySettings.toJSON()`（`src/QuickReplySettings.js:89-102`）只写 `isEnabled/isCombined/isPopout/showPopoutButton/config/characterConfigs`，**不含 sets** |
| ST 侧真正的机制 | `src/endpoints/quick-replies.js:9/:22` 落/删 `quickreplies/<name>.json`；`src/endpoints/settings.js:261` 再把该目录读成 `quickReplyPresets`（`:281`） |

⇒ 结论：**不是"少了个可选的文件镜像"，是唯一的写侧通道断了**，而读侧从第一天起就在读一个空键。
（我上一份报告 §3 里"可能是噪音级"的怀疑是错的，这条在 §5 里已按实测改正。）

### 1.2 落点为什么不是 `quickReplyV2.sets`（这是本批唯一非显然的决定）

`settings/save` 的既有语义是 **namespace 内整体替换**（本文件 T3 注释块写得很清楚）。
插件每次 `saveSettingsDebounced()` 都会把**整个 `quickReplyV2`** 按它的 `toJSON()` 重写一遍，
而那份 `toJSON()` 里没有 `sets` ⇒ 如果我把集写进 `quickReplyV2.sets`，
**用户下一次保存快捷回复设置就会把已存的集静默擦干净**。
所以写侧落到插件不拥有的命名空间 **`extension_settings.quickReplySets`**，
读侧改成三档优先：`quickReplySets.sets` → `quickReplyV2.sets` → `quickReply.sets`（后两档保历史兼容）。

⚠️ 第二版踩到的坑（实测发现，已回滚修正）：第一档最初写成"是 list 就返回"，
于是**删光所有集**之后 `sets: []` 会把历史档**遮蔽**掉。语义应该是
"这一档没东西"而不是"最终答案"，判据补成 `isinstance(sets, list) and sets`。
反证做过：把 `and sets` 去掉 ⇒ `test_empty_new_namespace_does_not_shadow_legacy_keys` 立刻红。

### 1.3 与 ST 对齐的三点 + 我们额外加的一道闸

- `name` 必填否则 400（照 `sendStatus(400)`）；同名覆盖不产生第二条（文件名即主键的等价物）；
  删不存在的名字回 200（照 ST 的 `existsSync` 后才 `unlink`）。
- **新增**：`name ≤ 200`、`sets ≤ 500`，越界 **409 且不落盘**。
  理由写进代码注释了：ST 落文件系统有磁盘兜着，我们是往用户设置里的**单个 JSON 列**写，
  一个循环 save 的插件能把它撑爆。宁可在超限时拒绝，也不静默丢最早那条。

### 1.4 测试（`backend/tests/test_qr_save_delete_endpoints.py`，11 例，全绿）

钉的是**闭环**不是"端点存在"：
`save → settings/get 的 quickReplyPresets 读得回`、
`note/memory 等命名空间一字节不掉`、
`反向：插件自己的 settings/save 不擦 sets`、
`空新档不遮蔽历史档`、`脏形状(dict 当 list)降级不崩`、
`未认证写请求不得 200`。

⚠️ 写测试时我自己踩了一个**信封形状**坑（已记进测试注释）：
`/api/settings/get` 的响应**没有顶层 `extension_settings`**，整份设置是塞在
`data["settings"]` 这个 **JSON 字符串**里的（实测 keys=25）。第一版直接
`data.get("extension_settings")` 拿到 `{}`，被我误判成"note 被擦掉了"——
差一点就把自己的代码判成回归。判据必须读对信封。

## 2. 批次I18N：ST 语言资产（提交 `86b37cb`）

- 搬入 `frontend/public/st/locales/zh-cn.json`（上游 3645 条**扁平 string**，287,692 字节）
  与 `en.json`（**4 字节** —— ST 的英文是源语言，上游那份就是 `{}`，别指望它提供内容）。
- `ST_LOCALES` 从 **17 收成 2**（`zh-cn` / `en`）：本产品界面语言只有这两种可切，
  其余 15 门无人可达，空搬 2.4 MB 翻译数据只是把死代码摊进资产里。
  **加一门语言 = 放同名文件 + 清单加一行，必须同时做**，这条由守卫钉住。
- 补 `lang.json`：后端 `_load_st_locales()` 的取值源，此前**缺该文件 ⇒ 一直回退硬编码 17 门**
  （即 `i18n_state.locales` 对外宣称有 17 门、实际一门都没有）。
- 守卫 9 例（`frontend/src/i18n/__tests__/i18n-st-locale-assets-inventory.test.ts`）：
  清单每项必须有同名文件、`lang.json` 与清单两侧一致、文件形状必须扁平 string
  （嵌套会被读取侧整条丢弃）、真实内容读得出 >1000 条且抽样键**过半是真中文**
  （原样回显英文即判红）、清单外不再发请求、非 200 仍静默降级。
  反证做过：往清单塞一个没有文件的 `ja-jp` ⇒ 2 例红并点名。

⚠️ 体积账要说清（用户在意弱网）：默认界面语言是 `zh-cn` ⇒ **每次进页面会拉这一份**。
实测线上走的是 gzip：**95,819 字节**，`Content-Type: application/json`、`Content-Encoding: gzip`。
它是 `lib/i18n` 启动时异步拉取，不阻塞首屏，但确实是新增的每页一次请求。
如果嫌这个成本，正确做法不是回滚端点，而是把这次拉取改成"仅当有插件真调 `t()` 时才拉"——
**本批没做**，因为它会让第一句插件文案仍然是英文（可观测的退化），要改得先定优先级。

## 3. 上线（第十一次窗口）与真机判据

```
前端备份  _BACKUPS/2026-10-21_dist重建前_QR与i18n上线/dist_before.tar.gz（改前入口 index-DfHH7IYY.js）
构建      VITE_OUT_DIR=dist_qr node scripts/build-vite.mjs → ✓ built in 1m 14s（199 文件）
覆盖      cp -r dist_qr/. dist/（只增不删 9110 → 9236）→ gzip 3985
后端      docker compose build backend（rc=0）→ up -d backend → Up (healthy)
入口      服务侧 curl :16000/ = index-B1yoTHTv.js；探针里页面实际加载的 script 同源
```

真机判据一（`.tmp_probe/qr_live.js`，走浏览器带 Cookie/CSRF 的真实通道）：

```json
{ "beforeCount": 0, "saveHttp": 200, "afterSaveHasProbe": true, "afterSaveVersion": 2,
  "noNameHttp": 400, "reSaveJson": {"replaced": true, "count": 1},
  "deleteHttp": 200, "afterDeleteCount": 0, "reDeleteHttp": 200, "reDeleteRemoved": 0,
  "localeHttp": 200, "localeKeys": 3645 }
```

真机判据二 —— **这条才是"功能好了"而不是"端点通了"**
（`.tmp_probe/qr_consume.js`：存一条集 → 重新加载角色页 → 读插件自己的 init 日志）：

```
无集基线：  [Plugin Quick Replies] [QR2] sets:  []
存了一条集：[Plugin Quick Replies] [QR2] sets:  [QuickReplySet]     ← 插件真的把它 rehydrate 了
```

同时：`qrErr` 两档都是 0（没有新报错种类），错误种类从 25 降到 2。
探针自己清理了现场 —— 收尾读数 `presets:0`、新命名空间留着 `sets: []`（因"非空才短路"，
空档不遮蔽任何东西）、`extension_settings` 命名空间数 35（未被动坏）。

⚠️ **仍然没验到的一环**：快捷回复下拉里的 option 数在有集/无集两档都读到 1。
我没有把它当成"功能没生效"的证据，因为那个 select 的选项是在**渲染设置面板时**才填的，
而面板入口在 `ChatMoreMenu` 的图标菜单里（同一形状使 §小尾巴 的 `preset-session-source`
也没能自动点到）。**判据换成了插件自己的 `[QR2] sets:` 日志**，它直接反映
`QuickReplySet.list`，比 DOM 计数可靠。请用户自己开一次快捷回复面板补上肉眼确认。

## 4. 门禁

```
bash scripts/gate.sh backend   →  ✓ 后端 pytest   junitxml failures=0 errors=0   rc=0
bash scripts/gate.sh frontend  →  ✓ tsc --noEmit / ✓ vitest
                                  Test Files 132 passed (132) / Tests 1699 passed | 3 skipped (1702)
bash scripts/gate.sh docs      →  ✓ 文档目录一致性 / ✓ ST 上游引用可复核   rc=0
```

判据只认 `failed = 0 / errors = 0`（用例数随并行会话增长，今天 1699 不是基线）。
本批净增 20 例 = QR 11 + I18N 9。

## 5. 对我上一份报告的订正

`REPORT_批次小尾巴_CSS生成器与沙箱读写同域_2026-10-21.md` §3 里我写过：
"这不是'噪音'，是一个不可用的功能"，随后又给了"①补端点 / ②前端轨重定向"两档并推荐 ①。
**方向对了，但两处不准**：
① 我说"插件的读取大概靠 `extension_settings.quickReply.sets`"——**不准**，插件读的是
`settings/get` 的 `quickReplyPresets`（`index.js:55`），而那个字段的来源键全仓没人写；
② 我没预料到"落进 `quickReplyV2` 会被插件自己整块覆盖擦掉"这个坑（§1.2）。
⇒ 该节保留原文不删（只进不出），以本文为准。
