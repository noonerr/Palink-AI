# REPORT — 包G：getContext 15 项 + SillyTavern.libs 25 键（2026-10-18）

> **状态：完工待验收**（代码 + 契约测试 + 真机探针 + 反证已齐，未重建 dist、未上线）。
> 任务书：`docs/_active/HANDOFF_提示词_包G_getContext与libs补齐_2026-10-18.md`
> 上游口径：`docs/_active/report/REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`

## 0. 本轮是「接手自中断现场」，不是从零施工

执行包G 的上一轮 agent 在 150 轮上限被强制中断（最后一句输出 "Now the new contract test for 包G:"），
**已改完源码但没跑门禁、没提交、没写报告**。现场物理备份见
`_BACKUPS/2026-10-18_包G中断现场/`（`tracked-frontend-wip.patch` + `untracked/` + 逐文件归属表）。

本轮（接手者，2026-10-18 约 21:00–21:25）做的事：

| # | 动作 | 结果 |
|---|---|---|
| 1 | 逐项复核 G-1 的 15 项是否真按 §2.1 落了 | **13 项到位**，但 #1 只做了一半（见 §1 的 ⚠️ 行）⇒ 本轮补齐 |
| 2 | 修 2 条红测试 + 补完中断处写到一半的断言 | 32/32 绿 |
| 3 | 修该测试文件 2 处 tsc 错误（TS2339 / TS2349） | `tsc --noEmit` rc=0，断言语义未弱化（§4） |
| 4 | 全量门禁 | tsc rc=0；vitest rc=0，`failed=0 且 errors=0`（§3） |
| 5 | 真机探针（新源码 + 旧 dist 双跑，同口径对照） | §2 |
| 6 | 反证 3 项「改坏必红 / 还原必绿」 | §5 |

**接手时实测**（主控给的现场基线，本轮复跑一致）：生产文件 tsc 零错、目标测试 32 例中 30 绿 2 红。
两处红都定位到 **测试自身的缺陷**，不是实现缺陷（§4）。

本轮唯一新增的生产代码：`part-08.ts` 的 #1 追加 `window.power_user` 发布（6 行，§1 表内 ⚠️ 行）。

---

## 1. G-1：getContext 15 项逐项状态表

坐标全部在 `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-08.ts`
（G-1 助手区 :190 起，`getContextCompat` 定义于 :446；G-2 libs 区 :807-975）。
读数列「真机」= §2 的 dev 探针 `ctxBehavior`。

| # | 项 | 处置（§2.1） | 改前 → 改后（真机读数） | 真值来源 / 诚实性依据 | 状态 |
|---|---|---|---|---|---|
| 1 | `powerUserSettings` / `power_user` | 补真值，不许留空对象 | `{}` → `{"font_size":14,"language":"zh","persona_show_user_name":false,"scroll_on_media_load":true,"media_display":"inline"}` | 三级优先：宿主 `ctx.powerUserSettings` > 帧内 `window.__palink_power_user` > 宿主默认值（逐键照 `lib/sillytavern/getContext.ts:3225-3235`，language 取宿主 `ctx.language` 真值） | ✅（⚠️ **本轮补**：前人只改了 `getContext()` 返回值，`window.power_user` 仍是 part-06 `ensureObject('power_user', {})` 给的**空对象**；直读全局的插件（part-02:354 访问器、part-06:652 的 `/api/settings/get` 响应）看的正是它 ⇒ 追加 `window.power_user = powerUserSettingsCompat` 同一实例发布，并在测试里钉死） |
| 2 | `getChatCompletionModel` | 经 ctx 注入当前模型名 | `''`（且每次调用弹 `st_api_stub` 诊断）→ `"deepseek-flash"` | 真链路已接线：`CharacterChat.tsx` 的 `selectedModel` → `Message.tsx`(props) → 渲染器 `context.selectedModel` → boot（`SillyTavernCompatRuntime.ts:182`）+ context-update 热通道（`CharacterCardRenderer.tsx:362/421`）；未注入时返回 `''`，不编造 | ✅ |
| 3 | `getTextGenServer` | 诚实值 + 去 stubApi 噪音 | `''` + 弹诊断 → `''`（不弹） | Palink 无独立 textgen 后端，`mainApi` 恒 `'palink'`；ST 在 `mainApi != textgen` 时同样返回空串 ⇒ 空串是**语义正确**；只透传宿主显式注入的 `ctx.textGenServer` | ✅ |
| 4 | `convertCharacterBook` | 恒等映射 + 注释说明 | `stubApi` 包裹 → 纯恒等函数 | Palink 后端存的即 ST 形状（`SmartCardCompatController.ts` `mapCharBookStagesToEntries`）⇒ 恒等不是占位；注释已写明依据 | ✅ |
| 5 | `getWorldInfoPrompt` | 补真值（激活条目组装成串） | `''` → `len=27727`（露缇雅1.2 真条目） | 复用同帧 `loadWorldInfo` 的 `requestParent('getCharWorldbook')` 通道，过滤 `disabled`、按 `insertion_order` 排序、`join('\n')`；空世界书返回 `''`；桥失败 → warn + `''` | ✅ |
| 6 | `updateWorldInfoList` | 补真值（重拉列表） | `stubApi(async()=>true)` → `["露缇雅1.2"]` 并写 `window.world_names` | ST 语义 = 重拉 `world_names`（`world-info.js:2061`）；Palink 每角色绑一本 ⇒ 列表即当前绑定；桥失败保留现状 + warn，不清空。写入后**立刻可见**：两处读方都是活访问器（`part-02.ts:483` 的 `world_names: () => (window.world_names || [])`、`part-06.ts:622`），不是构建期快照 ⇒ 跨 part 写全局在这里是安全的 | ✅ |
| 7 | `reloadWorldInfoEditor` | 恒真 by design，去 stubApi | `stubApi` → `true` | 帧内**没有**世界书编辑器 UI，函数无副作用可失败 ⇒ 恒真不是假成功；注释写明 | ✅ |
| 8 | `appendMediaToMessage` | 推 `extra.media` 并经既有 `setChatMessage` 落库 | `stubApi(async()=>true)` → 真写帧内 `extra.media` + 调 `setChatMessageCompat` | 映射不出媒体 / 找不到消息一律 `false`；**不做**「第二参不行就把消息 id 当 URL」的猜测（那是假成功，测试 §A 有反例钉住）；父侧 `hasSmartCardDisplayLayerOptions` 含 `extra` 键 ⇒ 空正文也能持久化 | ✅（真机端到端落库**未证实**，见 §6 遗留 3） |
| 9 | `getMediaDisplay` | 真值 = `extra.media_display`，缺省 inline | `'inline'`（常量占位）→ 按消息取真值，缺省 `inline` | Palink 取值域 `inline/gallery`（`lib/messageMedia.ts:141`）+ ST 的 `list` 原样透传；缺省落偏好 `power_user.media_display` | ✅ |
| 10 | `getMediaIndex` | 真值 = `extra.media_index`，无媒体 -1 | `-1`（常量占位）→ 按消息取真值 | 有媒体但越界 → `0`（同 ST `script.js:2140`）；**口径差异**：无媒体时本包按任务书返 `-1`，ST 源码返 `0` ⇒ 已写进测试文件头，不当 bug 修 | ✅ |
| 11 | `scrollOnMediaLoad` | 真值 = 偏好，去 stubApi | `stubApi(()=>true)` → 函数：偏好真则走 `scrollChatToBottom` 并返 `true`，偏好 false 不滚返 `false` | ST 侧它是**函数**（`script.js:1532`），开关是 `power_user.scroll_on_media_load` ⇒ 帧内保留函数形态 + 真偏好门控，缺省 `true` | ✅ |
| 12 | `renameChat` | **诚实失败** `false` + 留痕 | `stubApi(async()=>true)`（假成功）→ `false`，`console.warn` 只一次 | 单间轨没有任何可改会话标题的父侧通道（`SmartCardCompatController.ts` 动作表无 rename 类）；⚠️ **本轮复核订正任务书的一处事实**：后端**存在**可用的改名端点 `POST /api/chats/rename-session`（`backend/app/api/silly_tavern.py:5838`，宿主轨 `lib/sillytavern/getContext.ts:2460` 在用），缺的只是**帧内桥**，不是端点 ⇒ 后续项按此描述（§6 遗留 1） | ✅ |
| 13 | `createCharacterData` | 补 ST 默认模板 | `{}`（卡脚本写字段即炸）→ 21 键模板，可写不炸 | 逐键照 `_reference/sillytavern-1.18.0/public/script.js:569-592` 的 `create_save`（注意 ST 用 `first_message`/`mes_example`）；默认量取 ST constants：`talkativeness 0.5`、`depth_prompt_depth 4`、`depth_prompt_role 'system'` | ✅ |
| 14 | `getRequestHeaders` | **不许动**（安全决策待用户拍板） | 保持 `window.getRequestHeaders` + 桩表留痕，恒 `{}` | 未动（`git status` 里 `part-06.ts` 无改动）；测试 C 组钉住，谁动谁红 | ✅ 未动 |
| 15 | `getPresetManager` | **不许补**（架构红线） | 保持既有形状（仍带 stubApi 留痕） | 未动（`part-02.ts` 无改动）；测试 C 组实测：调用仍产**恰好 1 条** `st_api_stub` 诊断，`getSelectedPresetName()` 仍返 `'Palink'` | ✅ 未动 |

红线核对（§2.2）：
- 13 个修复项**全部拆掉 stubApi** ⇒ 桩表 `PALINK_STUB_API_NOTES` 只剩 4 项
  `getSelectedPresetName / writePresetExtensionField / getRequestHeaders / fetch:/api/worldinfo`（真机 `stubNotes` 读数一致）。
- 除 #12 外无一项留下警告 toast 噪音。
- #14/#15 零改动。

配套改动（全部归包G）：`CharacterCardRenderer.tsx`(+7) / `Message.tsx`(+6) / `CharacterChat.tsx`(+2) /
`types/index.ts`(+5) / `SillyTavernCompatRuntime.ts`(+2) 是 #2 的 `selectedModel` 透传链；
`part-08.ts` 净 +523/−43；`__tests__/st-compat-fix-batch-contract.test.ts`(+39/−25) 把「桩表只剩 4 项」
与「13 项已拆桩」做成**反向断言**（原来只正向下钉子是桩，现在同时钉「不许再变回桩」）。

⚠️ 给包I 的提示（`BACKUP_INFO.md` 第 4 条落实）：`Message.tsx` 的 `:125` / `:647` / `:1571` 三处
新增了 `selectedModel`，原 1007–1031 的行号与上下文已被推歪，请按锚点重新定位。

---

## 2. 真机探针读数（含「跑在旧 dist 没有」的明确声明）

⚠️ **两组读数分别来自不同代码版本，别看混**：

| 组 | 目标 | 代码版本 | 说明 |
|---|---|---|---|
| 改前对照 | `http://localhost:16000` | **容器 nginx 的旧 dist**（不含包G） | 用来证明判据的差异确实由本批代码造成 |
| 改后 | `http://127.0.0.1:5203` | **当前工作区源码** | 临时 vite dev server（`.tmp_probe/vite.gprobe.config.ts`，复用仓库 vite 插件与别名，只改端口与 `/api` 代理 → 16000）。**没碰 `frontend/dist`、没跑 `npm run build`**，红线遵守 |

探针脚本：`.tmp_probe/probe-parity3-g.js`（口径 = 任务书指定的 `probe-parity3.js` 的 `ST145` + 同一份
`isStub` 判据逐字搬运，另加 libs 懒加载行为校验、`ctxBehavior` 逐项读数、srcdoc 字节数、计费端点本地 fulfill）；
srcdoc 归因另跑 `.tmp_probe/probe-srcdoc-attrib-g.js`。
原始输出：`.tmp_probe/G_probe_dev_after.txt`（改后）、`.tmp_probe/G_probe_16000_olddist.txt`（改前）、
`.tmp_probe/G_srcdoc_attrib.txt`（归因）。

| 判据（§5.3） | 改前（旧 dist @16000） | 改后（dev @5203） | 结论 |
|---|---|---|---|
| getContext 键缺失 | `ctxMissing: []`（145/145） | `ctxMissing: []` | 持平 |
| 非真可用项 `ctxNotReal` | **19 项**：CONNECT_API_MAP、appendMediaToMessage、chatMetadata、convertCharacterBook、createCharacterData、getChatCompletionModel、getMediaDisplay、getMediaIndex、getPresetManager、getRequestHeaders、getTextGenServer、getWorldInfoPrompt、powerUserSettings、reloadWorldInfoEditor、renameChat、scrollOnMediaLoad、tagMap、tokenizers、updateWorldInfoList | **6 项**：CONNECT_API_MAP、chatMetadata、tagMap、tokenizers（4 项合法空容器）+ `getRequestHeaders`（#14 安全决策）+ `getPresetManager`（#15 架构红线） | ✅ **真问题项 = 0 ≤ 2**（余下 6 项全是任务书允许的合法空容器 / 明确不补两项） |
| `libs` 键 | 11 项，缺 20 | **31 项**（25 权威键全在，`libsMissing25: []`；另 6 项是 Palink 超集 toastr/$/jQuery/_/dayjs/accountStorage，任务书 §3.3-3 要求保留） | ✅ 25/25 |
| 五个目标库**真取到值**（探针里 await 后断言） | 五项全 `undefined` | `yaml.parse('a: 1')` → `{"a":1}`；`new showdown.Converter().makeHtml('**b**')` → `<p><strong>b</strong></p>`；`hljs.highlight(...)` → `<span class="hljs-keyword">var</span> x=`；`new Fuse(['a','bb']).search('b')` → `["bb"]`；`Popper.createPopper` → 可用 | ✅ 五/五（附带：`css` 有 parse、`gzipSync` 出 26 字节、`sha256('a')` → `ca978112ca1b`、`gzip` 是 function） |
| srcdoc 单帧字节 ≤50,000 | 最大 **57,356**（7 帧：55,576/56,008/55,854/57,284/55,700/57,356/55,772） | 最大 **57,388**（同序 +32） | ❌ **未达标，但不是本批造成的**：旧 dist 已超线；本批净增量 **恰好 +32 字节/帧**（boot ctx 多一个 `selectedModel`），运行时体本身**不在 srcdoc**（归因探针 7/7 帧 `hasExternalRuntime: true`，大头是卡自带 `body-html` 24,796 + 内联卡脚本 22,539 + `style` 11,608）。⇒ 立为遗留项（§6 遗留 2） |
| 计费端点 | — | `billedEndpointCallsBlocked: 0`（route 已挂，页面加载不触发生成） | ✅ 零 API 成本 |

**上线声明**：本批代码**尚未上线**。16000 端口至今服务旧 dist，页面读数（改前列）即证据；
改后读数来自临时 dev server。源码改动进了运行时资产 `assets/palink-smart-card-runtime-*.js`
（Vite 插件把 `runtime-body/part-*.ts` 外部化成独立资产，见 `SillyTavernCompatRuntime.ts:256` 的
`externalRuntimeUrl` 分支与 `CharacterCardRenderer.tsx:472`）⇒ **必须 `npm run build` 重建 dist 才生效**，
这一步归主控，本包按红线未做。重建后请回 16000 复跑同一探针，只有那次读数才算「上线生效」。

---

## 3. 门禁数字（只认 failed=0 且 errors=0）

| 命令 | 结果 |
|---|---|
| `cd frontend && npx tsc --noEmit` | **rc=0，零输出**（原始文件 `.tmp_probe` 之外见 `$TEMP/G_tsc_final.txt`；接手时该文件有 2 处红，§4 已修） |
| `cd frontend && npx vitest run`（全量） | rc=0，**85 个文件全过 / 1108 passed \| 3 skipped (1111)**，`failed=0`、`errors=0` |
| 本包目标测试 `g-getcontext-and-libs-contract.test.ts` | 32/32 passed |
| 模板字符串守卫 `generated-script-parse-guard.test.ts` | 4/4 passed（part-08 未写坏：全文除收尾反引号外零裸反引号、零 `${}` 插值、换行一律 `\\n`） |
| `node scripts/gen-st-libs-fixture.cjs --check` | `OK 25 libs, fixture up to date` rc=0 |

**非本包红（归属包F）**：**无**。全量跑绿，工作区里已不含包F 的在途文件（`lib/slash-engine/st-compat-commands.ts`
与 `lib/sillytavern/__tests__/fixtures/*` 在接手期间由包F 自行提交，`git status` 复核后本批 pathspec 不含它们）。
⇒ 「全量绿」不是待办项，已达成。

---

## 4. 接手时两处红的定位与修法（没有弱化任何断言）

| 症状 | 真因 | 修法 |
|---|---|---|
| 红测 ①「未加载完成时 getter 取到 undefined」5,005ms 超时 | **测试自身缺陷**：用一个 `settle` 变量接 resolver，而 `libs.yaml` 与 `libs.Fuse` 两个 getter **同时**发起请求 ⇒ 后一个 Promise 覆盖 `settle` ⇒ yaml 的请求永远不 resolve，`await libs.__ensure('yaml')` 挂死。**不是**懒加载实现有问题 | 换成 `Map<url, resolver>`，按 `__packageMap.yaml` 精确取到 yaml 那个 resolver 再 resolve；并**新增**一条断言：resolve 完 yaml 后 `libs.Fuse` **仍是 undefined**（不顶包）。语义只增不减 |
| 红测 ②「CDN URL 全部锁版本」 | **测试自身正则不认 npm scope**：`[^/]+@x.y.z` 遇到 `@adobe/css-tools@4.4.4` 必红（`[^/]` 过不了包名里的 `/`） | 正则改 `/^https:\/\/testingcf\.jsdelivr\.net\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\/\+esm$/` ⇒ 仍强制「三段版本号 + `/+esm`」，`@latest` / 只写大版本 / floating 一律红；断言强度不降（另加注释说明「允许 scope 不等于放宽锁版本」） |
| tsc TS2339 `world_names`（:407） | jsdom 全局类型没声明该属性 | `(window as any).world_names`（同文件 :412 既有写法），断言内容一字未改 |
| tsc TS2349 `Type 'never' has no call signatures`（:594） | 与红测 ① 同因：TS 认定闭包内的赋值不可达 ⇒ `settle?.()` 被窄化成 `never` | 随 Map 改写自然消失；无 `@ts-ignore` |
| 中断处「写到一半的断言」 | 前人停笔处即 Map 那条 | 已补完（resolve 前后各一组断言 + Fuse 不顶包 + `resolvers.get(...)` 必须先存在） |

---

## 5. 反证 3 项：改坏必红 / 还原必绿（原始输出摘录）

| # | 临时改坏（生产码） | 结果 rc=1 | 原始行 |
|---|---|---|---|
| 1 | `part-08.ts` 把 `getWorldInfoPrompt: getWorldInfoPromptCompat` 换回 `stubApi('getWorldInfoPrompt', async () => '')` | **3 failed / 29 passed (32)** | `AssertionError: 以下项仍被探针判为假货: getWorldInfoPrompt: expected [ 'getWorldInfoPrompt' ] to deeply equal []`；`AssertionError: expected '' to be '第一段\n第二段'`；`AssertionError: expected false to be true` |
| 2 | 删掉 `PALINK_ST_LIB_PACKAGES` 里的 `yaml: ['yaml@2.8.3/+esm','namespace']` | **4 failed / 28 passed (32)** | `AssertionError: libs 缺权威键: yaml: expected [ 'yaml' ] to deeply equal []`；`AssertionError: libs.yaml 缺 CDN 映射: expected { …(19) } to have property "yaml"`；`AssertionError: expected false to be true` |
| 3 | `renameChatCompat` 的 `return false` 改成 `return true`（假成功） | **2 failed / 30 passed (32)** | `AssertionError: expected true to be false`；`AssertionError: expected false to be true` |
| — | 三项全部还原 | **rc=0，3 files / 58 passed (58)**（G 契约 32 + 批次契约 + 模板字符串守卫） | `Test Files 3 passed (3)` |

原始输出文件：`$TEMP/G_refute1_red.txt`、`G_refute2_red.txt`、`G_refute3_red.txt`、`G_refute_green.txt`、
`G_vitest_final.txt`、`G_tsc_final.txt`（`$TEMP` = `C:\Users\Pall\AppData\Local\Temp`）。
改坏—还原全程只动 `part-08.ts`，改前快照 `$TEMP/part08_G_pristine.ts`，还原后 grep 复核
`window.power_user = powerUserSettingsCompat`（:216）与 `getWorldInfoPrompt: getWorldInfoPromptCompat`（:712）均在位。

---

## 6. 遗留项（后续谁做、为什么不在本包做）

1. **单间轨缺会话改名桥**（不是后端缺端点 —— 任务书 §2.1 的这条事实已被本轮复核否证）。
   `POST /api/chats/rename-session`（`backend/app/api/silly_tavern.py:5838`）存在且真改库，宿主轨在用
   （`lib/sillytavern/getContext.ts:2460`）。补法：给 `SmartCardCompatController.ts` 的 requestParent 动作表
   加一个 rename 动作，再把 `renameChatCompat` 从恒 `false` 换成真实现。**不做的原因**：跨包改控制器动作表属新议题，
   且本包红线要求「不许假成功」，当前 `false` + 一次性 warn 是合规状态。
2. **srcdoc 单帧 55.6–57.4KB，超任务书的 ≤50,000 线**。本批净增 +32 字节/帧（`selectedModel` 进 boot ctx）。
   超线的 7.4KB 由**卡自身内联内容**（body-html 24,796 / 卡脚本 22,539 / style 11,608）与包A 之后其他批次的
   改动构成 —— 证据是**同一探针在旧 dist（不含包G）上已读到 57,356**。任务书引用的 46,167 基线在现网已不成立。
   ⇒ 需要主控重开 srcdoc 预算议题（本包无法在不碰别人在途文件的前提下压缩卡内联体积）。
3. **#8 `appendMediaToMessage` 的端到端落库未证实**。真机调用返 `true`，但回查
   `GET /api/character-sessions/f25daab6-…/messages`（91 条，改前改后各查一次）里 **`media` 键出现 0 次**，
   会话 `updated_at` 仍停在 2026-10-15 ⇒ 帧内 → 宿主通道走通了、宿主 → 后端那一段没观察到写入
   （最可能卡在 `handleEditMessage` 的 messageId 形状匹配：帧侧给的是 ST mes 形状 id）。
   ⚠️ 探针用的 URL 是 `/probe-not-saved.png` 且 DB 里 0 命中 ⇒ **未污染用户数据**（这条是有意设计）。
   ⚠️ 根因线索（给下一个 agent 省时间）：`SmartCardCompatController.ts:837-849` 对
   `setChatMessage`/`updateMessageBlock` **无条件**回 `{ success: true, content }`（`requestContext.setChatMessage`
   缺失或内部 return 早退也照样 success）⇒ 帧内 `Boolean(result && result.success !== false)` 这个判据
   拿不到"真的落了库"这件事。修法要么在父侧回真实结果，要么帧内改成写后回读比对（`getChatMessages` 复核）。
   ⇒ 需要一条「宿主收到 extra-only 更新后必须回真 success/false」的闭环；在此之前 #8 的帧内契约绿、
   真机落库**不许**宣布达成。
4. **libs 里 5 个「已有键」其实部分是垫片**（任务书把 DOMPurify/Handlebars/lodash/moment/localforage 记作
   「✅ 已有真库，不动」，本探针实测口径与之不符）：`DOMPurify.sanitize('<b>x</b><script>y</script>')`
   原样返回（`part-02.ts:59` 的 `window.DOMPurify || { sanitize: v => String(v) }` 兜底生效 ⇒ CDN 那份没到货），
   `lodash.isPlainObject` 在该帧取到 undefined（`part-02.ts:28` 同理回退到自造 compat）。
   ⇒ 属包G 红线「25 键不许假对象」的**既有**违规面，但修它要动 part-02 并改变净化语义（安全相关），
   本包按「不动 #14/#15 之外的既有决策」的口径只记录、不擅自换实现。建议单独拍板。
5. **`power_user` 仍无宿主真偏好源**：`window.__palink_power_user` 全仓零写入者（grep 实测，宿主轨与本帧都只是读）。
   ⇒ 帧内拿到的是「宿主默认值 + ctx.language」；等宿主设置里真有字号/媒体偏好时，把 `ctx.powerUserSettings`
   填上即可，帧内三级优先已就位，无需再改卡运行时代码。
6. **`window.libs` 别名与懒加载**：新增 `window.libs = window.libs || stLibsCompat`，
   `__ensure` / `__packageMap` 两个取证键刻意**不可枚举**，`Object.keys(libs)` 仍是 25+6 的口径。
   懒加载意味着**首帧取到 undefined**（诚实性设计），卡脚本若要立刻用库应 `await SillyTavern.libs.__ensure('yaml')`。
7. **上线动作（归主控）**：重建前端 dist 并回 16000 复跑 `.tmp_probe/probe-parity3-g.js`（把 TARGET 换回 16000）
   与 `.tmp_probe/probe-srcdoc-attrib-g.js`，两个数（真问题项、libs 25/25 真取到值）以那次为准。

---

## 7. G-2：libs 25 键逐项映射与实测

实现位置 `part-08.ts:807-975`（`PALINK_ST_LIB_PACKAGES` / `ensureStLibCompat` / `defineStLibGetter`）。
基址 `https://testingcf.jsdelivr.net/npm/`（与卡脚本 bootstrap 的 `dependencyUrls` 同供应商同风格，
见 `lib/sillytavern/card-script-runner.ts:165-171`），全部 `+esm`、全部锁三段版本号。
**版本一律取 ST 1.18.0 `package.json` 的 caret 下界**（本轮逐键比对过，18/18 完全一致），
并逐个 `curl` 实测 HTTP **200**（18 个 URL，覆盖 20 个键）。

取值方式：`default` = 默认导出；`namespace` = 整个模块命名空间（ST 源码是 `import * as X`）；
其它字符串 = 指定命名导出。**同模块多键共用一次网络请求**（按 URL 去重 `stLibModuleByUrl`）。

| lib 键 | npm 模块（URL 路径） | 版本 | 取值方式 | 加载方式 | 实测 |
|---|---|---|---|---|---|
| lodash | —（既有） | — | `window._` 优先，回退 compat | 已在 boot 注入 | 键在；`isPlainObject` 见 §6-4 |
| DOMPurify | —（既有） | — | `window.DOMPurify` 优先 | 已在 boot 注入 | 键在；真库性见 §6-4 |
| localforage | —（既有） | — | compat | 已在 boot 注入 | 键在 |
| Handlebars | —（既有） | — | `window.Handlebars` 优先 | 已在 boot 注入 | 键在 |
| moment | —（既有） | — | `window.moment` 优先 | 已在 boot 注入 | 键在 |
| Fuse | `fuse.js` | 7.1.0 | default | 懒加载 CDN | ✅ 真机 `search('b')` → `["bb"]` |
| hljs | `highlight.js` | 11.11.1 | default | 懒加载 CDN | ✅ 真机 `highlight()` 出 token HTML |
| css | `@adobe/css-tools` | 4.4.4 | default | 懒加载 CDN | ✅ 有 parse（**不是 emotion**，依 `lib.js:11`） |
| Bowser | `bowser` | 2.12.1 | default | 懒加载 CDN | 键在（curl 200） |
| DiffMatchPatch | `diff-match-patch` | 1.0.5 | default | 懒加载 CDN | 键在（curl 200） |
| Readability | `@mozilla/readability` | 0.6.0 | 命名导出 `Readability` | 懒加载 CDN，**与下一键共享同一 URL** | 键在（curl 200） |
| isProbablyReaderable | `@mozilla/readability` | 0.6.0 | 命名导出 | 同上（一次请求两键） | 键在（契约测试断言 readability 只发 1 次请求） |
| SVGInject | `@iconfu/svg-inject` | 1.2.3 | default | 懒加载 CDN | 键在（curl 200） |
| showdown | `showdown` | 2.1.0 | default | **先复用 `window.showdown`**（bootstrap 已加载），没有才发 CDN | ✅ 真机 `makeHtml('**b**')` → `<p><strong>b</strong></p>` |
| seedrandom | `seedrandom` | 3.0.5 | default | 懒加载 CDN | 键在（curl 200） |
| Popper | `@popperjs/core` | 2.11.8 | **namespace** | 懒加载 CDN | ✅ 真机 `createPopper` 可用 |
| droll | `droll` | 0.2.1 | default | 懒加载 CDN | 键在（curl 200） |
| morphdom | `morphdom` | 2.7.7 | default | 懒加载 CDN | 键在（curl 200） |
| slideToggle | `slidetoggle` | 4.0.0 | 命名导出 `toggle` | 懒加载 CDN | 键在（curl 200） |
| chalk | `chalk` | 5.6.0 | default | 懒加载 CDN | 键在（curl 200） |
| yaml | `yaml` | 2.8.3 | **namespace** | **先复用 `window.YAML`**（bootstrap 那份是 2.8.1，故帧内优先用全局） | ✅ 真机 `parse('a: 1')` → `{"a":1}` |
| chevrotain | `chevrotain` | 11.2.0 | namespace | 懒加载 CDN | 键在（curl 200） |
| gzipSync | `fflate` | 0.8.2 | 命名导出 `gzipSync` | 懒加载 CDN，**与下一键共享同一 URL** | ✅ 真机压出 26 字节 |
| gzip | `fflate` | 0.8.2 | 命名导出 `gzip` | 同上 | ✅ 是 function |
| sha256 | `js-sha256` | 0.11.1 | 命名导出 `sha256` | 懒加载 CDN | ✅ 真机 `sha256('a')` → `ca978112ca1b…` |

要点：
- **禁止假对象**：加载完成前 getter 返回 `undefined`（探针 `ensureWarmed: false` 时五项全 undefined，
  预热后才有值），没有任何「形状像」的占位。失败静默降级（一条 `log/warn`，不抛给卡脚本）。
- **不撑 srcdoc**：一个库源码也没内联；`part-08.ts` 只多了 getter 与表（且它在**外部运行时资产**里，不在 srcdoc）。
- 对齐 ST `lib.js:34 initLibraryShims`：库到货后补一份同名全局（`window.Fuse` / `window.hljs` …），
  已有值不覆盖 ⇒ 老扩展直读全局也能拿到。
- `@popperjs/core` 用 namespace（ST 是 `import * as Popper`）、`slideToggle` 取 `{toggle}` 命名导出，
  两处形状差异都写进了代码注释。
- fixture：`__tests__/fixtures/st-libs-25.json`（25 键 + 来源注释），生成器
  `frontend/scripts/gen-st-libs-fixture.cjs`（`--check` rc=0，数据源 `_reference/sillytavern-1.18.0/public/lib.js`
  的 default export，逐行数出来不是估的）。
- 内联渲染轨（`inline/inline-st-globals.ts`）**不声明 `SillyTavern.libs`**（全仓 grep `.libs` 在该目录零命中）
  ⇒ 任务书 §4 的「同步」不适用，无缺口。

---

## 8. 交付文件清单（本批提交范围）

提交：`adb09bd`（分支 `three-tracks-merge-20261012`，11 files / +1650 −43；
`git show --stat` 复核过不含任何别人的文件，pre-commit secret-scan OK）。

修改：`runtime-body/part-08.ts`(+523)、`CharacterCardRenderer.tsx`(+7)、`Message.tsx`(+6)、
`views/character/CharacterChat.tsx`(+2)、`types/index.ts`(+5)、`SillyTavernCompatRuntime.ts`(+2)、
`__tests__/st-compat-fix-batch-contract.test.ts`(+39/−25)
新增：`__tests__/g-getcontext-and-libs-contract.test.ts`(+744)、`__tests__/fixtures/st-libs-25.json`(+34)、
`frontend/scripts/gen-st-libs-fixture.cjs`(+82)、本报告
不带：`docs/` 下主控未提交的其它文档、`.workbuddy-ai/`、`_BACKUPS/`、包F/包E 的任何文件

**docs 目录证据**（AGENTS.md 强制项）：`py scripts/docs/gen_docs_catalog.py` rc=0，随后
`--check` → `OK 363 docs, catalog up to date`（rc=0）。
⚠️ 但 `docs/_CATALOG.md` **没随本提交** —— 它在本批之前就已被主控改过（`git status` 里先是 `M`），
内容里索引着主控那批尚未入库的文档，一起提交等于替别人入库；请主控把这 18 行目录变更与其文档同批提交。

