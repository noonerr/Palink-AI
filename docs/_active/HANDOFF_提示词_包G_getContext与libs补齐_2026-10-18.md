# HANDOFF — 包G：getContext 15 个真问题项 + `SillyTavern.libs` 补到 25 项

> ### ⚠️ 订正说明（2026-10-18 晚 · 包G 完工后追加，据 `adb09bd` / `REPORT_包G_getContext与libs_2026-10-18.md`）
> 1. **§2.1 第 12 项的前提是错的**：本文件写"已核实后端 `sessions.py` 无 rename 端点"——
>    端点其实**存在**，只是不在 `sessions.py`：`backend/app/api/silly_tavern.py:5838`
>    `@router.post("/api/chats/rename-session")`（执行 agent 实测纠正）。
>    ⇒ 后续真正缺的是**帧内到该端点的桥**，`renameChat` 现恒返 `false` + 一次性 warn；
>      别再把"后端无端点"当结论引用。
> 2. **§2.1 第 1 项前人做漏了一半**：只改了 `getContext().powerUserSettings`，
>    `window.power_user` 仍是 `part-06` 给的空对象（直读全局的插件看的是它）——收尾者已补并发布同一实例。
> 3. **srcdoc ≤50,000 这条判据本身失效**：改前最大帧已是 57,356（超线），大头是卡自带
>    `body-html` 24,796 + 内联卡脚本 22,539 + `style` 11,608，运行时体不在 srcdoc。
>    ⇒ 本包净增只有 +32 字节/帧。这条预算**另立议题**，不要再拿 50,000 当包间验收线。
> 4. 行号提醒：本文件写 `part-08.ts:178`（getContextCompat）、`:512-525`（libs）——
>    完工后实际落点是 `:190-446`（G-1）与 `:807-975`（G-2），后续包按锚点定位。

> 派发对象：子 agent｜优先级：**P0**｜预估：G-1 约 200 行 + G-2 约 150 行 + 契约测试 + 真机探针
> 前置：`REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`（必读，下文编号引用它）
> **只做功能代码，不改 `frontend/dist`、不重建后端镜像**（收尾由主脑做）。

---

## 1. 背景与当前实测基线（2026-10-18 真机，露缇雅 `c28061bb-a9b7-46a9-a255-2692d57001fc`，7 帧）

```
getContext：145/145 键存在，非真可用 19 项（宽口径），其中真问题 15 项 / 合法空容器 4 项
SillyTavern.libs = 11 项在场（toastr/$/jQuery/DOMPurify/Handlebars/_/lodash/moment/dayjs/accountStorage/localforage）
  与 ST 1.18.0 权威 25 项的真交集 = 5（DOMPurify/Handlebars/lodash/moment/localforage）⇒ 缺 20
```

权威口径（本次重新逐项数过，`_reference/sillytavern-1.18.0/public/lib.js:84-110` 的 default export）：

```
lodash  Fuse  DOMPurify  hljs  localforage  Handlebars  css  Bowser  DiffMatchPatch
Readability  isProbablyReaderable  SVGInject  showdown  moment  seedrandom  Popper
droll  morphdom  slideToggle  chalk  yaml  chevrotain  gzipSync  gzip  sha256
```

⚠️ **`libs.css` 是 `@adobe/css-tools`（CSS 解析器），不是 emotion**（`lib.js:11`）。
⚠️ **`gzipSync`/`gzip` 同在 `fflate` 一个模块**（`lib.js:26`）；`Readability`/`isProbablyReaderable`
同在 `@mozilla/readability`（`lib.js:14`）。补的时候按模块合并，别当 4 个独立库。

---

## 2. 任务 G-1：getContext 15 个真问题项

### 2.1 逐项处置表（已判完，按这个来，别自己重新判）

全部落点在 `frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-08.ts`
（`getContextCompat` 定义在 :178）。**该文件是注入 iframe 的模板字符串**：禁止裸反引号、
`${}` 插值、字符串/注释里的裸 `\n`（写 `\\n`）。唯一守卫是
`generated-script-parse-guard.test.ts`，双 `<script>` 标签产物会误报，注意。

| # | 项 | 现坐标 | 处置 |
|---|---|---|---|
| 1 | `powerUserSettings` | `part-08.ts:311`（`window.power_user`，实测空） | **补真值**：宿主侧已有同语义实现 `lib/sillytavern/getContext.ts:3225-3235`（读 `window.__palink_power_user`，无写入者 ⇒ 也落默认值）。把宿主侧偏好（字号/语言等）经 ctx 或 `requestParent` 桥进帧；桥不到就用宿主那份默认值，**不许留空对象** |
| 2 | `getChatCompletionModel` | `part-08.ts:437` stubApi（每次调用产 'st_api_stub' 警告 toast） | 真值：`CharacterChat.tsx:709` 有 `selectedModel`（已喂给 `generationEngine.setContext`）。经 ctx 注入当前模型名 |
| 3 | `getTextGenServer` | `part-08.ts:435` | Palink 无独立 textgen 服务器。ST 语义 = 返回配置的 textgen 服务器 URL。**诚实值 = 当前主 API 的 base（`mainApi` 已有 'palink'）**；拿不到返回 `''`，**去掉 stubApi 噪音** |
| 4 | `convertCharacterBook` | `part-08.ts:431` | Palink 后端存的即 ST 形状 ⇒ 恒等映射语义正确。**去掉 stubApi 包装**，加注释说明为何恒等 |
| 5 | `getWorldInfoPrompt` | `part-08.ts:432` | **补真值**：同帧 `loadWorldInfo`（`part-08.ts:369-410`）已能从 `getCharWorldbook` 桥拿真实条目；本函数按 ST 语义把激活条目组装成提示词串。条目为空返回 `''`（ST 也是这样） |
| 6 | `updateWorldInfoList` | `part-08.ts:430` | **补真值**：刷新帧内 `world_names`（从宿主 `getWorldbookNames` 类通道），ST 语义就是"重拉世界书列表" |
| 7 | `reloadWorldInfoEditor` | `part-08.ts:429` | 帧内无世界书编辑器 UI。**返回 `true` 但不许再走 stubApi 弹警告**（它不写任何数据，`true` 不是假成功）；注释写清"Palink 帧内无编辑器，恒真 by design" |
| 8 | `appendMediaToMessage` | `part-08.ts:353` | **补真值**：推入 `message.extra.media`，经既有 `setChatMessage`/`updateMessageBlock` 父侧通道落库（`SmartCardCompatController.ts:827` 已有这两个 action） |
| 9 | `getMediaDisplay` | `part-08.ts:361` | 真值 = `message.extra.media_display`，缺省 `'inline'`（ST 默认值也是 inline）。按当前 messageId 取 |
| 10 | `getMediaIndex` | `part-08.ts:362` | 真值 = `message.extra.media_index`，无媒体返回 `-1`（同 ST） |
| 11 | `scrollOnMediaLoad` | `part-08.ts:364` | 真值 = 偏好里的 scroll_on_media_load，缺省 `true`。**去掉 stubApi** |
| 12 | `renameChat` | `part-08.ts:204` | **诚实失败**：已核实后端 `backend/app/api/sessions.py` 无 rename/update 端点（只有 GET/DELETE/POST/PUT-message，title 仅创建时可设）。⇒ 返回 `false` + console.warn 一次，**在报告里把"后端缺 rename 端点"立为后续项**。不许假成功返 true |
| 13 | `createCharacterData` | `part-08.ts:344`（恒 `{}`） | 补 ST 默认角色数据模板（name/description/personality/scenario/first_mes/mes_example/creator_notes… 全空串/空数组），形状照 `@types` 的 RawCharacter。低成本 |
| 14 | `getRequestHeaders` | `part-06.ts:594-597` | **不许动**。安全决策待用户拍板（与 P1-1 沙箱红线冲突，见路线图 §4）。维持 `{}` 与留痕 |
| 15 | `getPresetManager` | `part-02.ts:633-640` | **不许补**。Palink 预设体系与 ST 结构不同，硬补=形状对语义错（路线图 §4 明文） |

### 2.2 红线

1. **不许假成功**：要么真实现，要么明确失败（返回 `false`/`''`）+ warn 留痕。
2. **除 12 号（renameChat）外全部消除 stubApi 警告 toast**——stubApi 每次调用都产一条
   `st_api_stub` 诊断警告（`part-08.ts:127`），这是卡脚本调用几次就弹几个 toast 的噪音源之一。
   修完的项从 stub 列表（`part-08.ts:108-124` 的声明注释）里划掉并更新注释。
3. 14/15 两项是**用户决策/架构红线**，动了就是越权。

---

## 3. 任务 G-2：`libs` 补到 25 项

### 3.1 现状与通道

`part-08.ts:512-525` 当前 11 项。补齐的硬约束：

- **帧是 opaque origin 的 sandbox 文档，拿不到宿主打包模块** ⇒ 只能 ①CDN 懒加载（帧内
  `await import(url)` / `<script src>`，ST 自己也是 CDN 路线）或 ②内联进模板（撑爆 srcdoc，禁止）。
- 帧内已有现成 CDN 通道：`lib/sillytavern/card-script-runner.ts:165-171` 的 `dependencyUrls`
  （jsdelivr，已加载 lodash/vue/showdown/z/YAML）。**复用它，别新造轮子。**
- srcdoc 红线：单帧当前 46,167 字节（包A 成果），内联任何库源码前先想清楚。

### 3.2 逐项映射表（ST 模块名已从 `lib.js:5-27` 逐个抄出）

| lib | npm 模块 | 现状 | 做法 |
|---|---|---|---|
| lodash/DOMPurify/localforage/Handlebars/moment | — | ✅ 已有 | 不动 |
| **showdown** | showdown | ⚠️ bootstrap 已 CDN 加载为 `window.showdown` | 接到 `libs.showdown` |
| **yaml** | yaml | ⚠️ bootstrap 已 CDN 加载为 `window.YAML`（ESM，注意大写） | 接到 `libs.yaml` |
| **hljs** | highlight.js | ⚠️ 宿主 npm 有（`frontend/package.json` highlight.js ^11.11.1）但帧内没有 | 帧内 CDN 懒加载 |
| **chevrotain** | chevrotain | ⚠️ 宿主 npm 有（^12.0.0）帧内没有 | 帧内 CDN 懒加载 |
| **Fuse** | fuse.js | ❌ | 帧内 CDN 懒加载 |
| **css** | @adobe/css-tools | ❌ | 帧内 CDN 懒加载 |
| **Bowser** | bowser | ❌ | 帧内 CDN 懒加载 |
| **DiffMatchPatch** | diff-match-patch | ❌ | 帧内 CDN 懒加载 |
| **Readability / isProbablyReaderable** | @mozilla/readability | ❌ | 同一模块，一次加载两个键 |
| **SVGInject** | @iconfu/svg-inject | ❌ | 帧内 CDN 懒加载 |
| **seedrandom** | seedrandom | ❌ | 帧内 CDN 懒加载 |
| **Popper** | @popperjs/core | ❌ | 帧内 CDN 懒加载（ST 是 `import * as Popper`，命名空间形状） |
| **droll** | droll | ❌ | 帧内 CDN 懒加载 |
| **morphdom** | morphdom | ❌ | 帧内 CDN 懒加载 |
| **slideToggle** | slidetoggle | ❌ | 帧内 CDN 懒加载（`{toggle}` 命名导出） |
| **chalk** | chalk | ❌ | 帧内 CDN 懒加载（浏览器里基本只用它的常量/类型） |
| **gzipSync / gzip** | fflate | ❌ | 同一模块，一次加载两个键 |
| **sha256** | js-sha256 | ❌ | 帧内 CDN 懒加载 |

### 3.3 实现样式（红线）

```js
// 懒 getter：首次访问才发起 CDN 加载；加载完成前返回 undefined（诚实，不是假库）
// 每个库一个 ensure<Name>()，带 Promise 缓存，失败静默（卡脚本自己会降级）
```

1. **必须是真库**：从官方 CDN 拉真包，禁止写"形状像"的假对象。
   ST 官方 CDN 路径可从 `_reference/sillytavern-1.18.0/index.html` 或 `public/lib.js` 的
   构建配置找；找不到就用 jsdelivr `/<pkg>@<版本>/+esm`（与现有 `dependencyUrls` 同风格），
   版本号锁定并在报告里列出。
2. `libs` 对象对外仍是**同步可见的 25 个键**（getter），值在加载后从 undefined 变真库。
   这是唯一兼顾"不撑 srcdoc + 不造假"的形态。
3. Palink 自有的 `toastr`/`$`/`jQuery`/`dayjs`/`accountStorage` **保留**（超集无害），
   但 25 个权威键一个不能少。

---

## 4. 注册位置（红线）

- G-1 全部改在 `runtime-body/part-08.ts`（`getContextCompat` 内），宿主侧真实数据经
  **ctx 注入或 `requestParent`** 进来。⚠️ `requestParent` v2 会把数组和字符串展开
  （MEMORY.md「帧内两套 requestParent」），测试桩必须照抄真机形状。
- G-2 改在 `part-08.ts:512-525` 的 `window.SillyTavern.libs` 赋值处 + 帧内加载器。
- 内联渲染轨（`inline/inline-st-globals.ts:594` 的 `TavernHelper`）若也声明 libs，保持同步；
  不同步就在报告里说明为何不需要。

---

## 5. 验收判据（可复跑，缺一不可）

### 5.1 静态门禁

```
frontend/: npx tsc --noEmit 与 npx vitest run 全绿
  ⇒ 只认 "failed = 0" 且 "errors = 0"，passed 数字不是验收线（会漂）
```

### 5.2 新增契约测试（`frontend/src/components/ui/custom/smart-card-runtime/__tests__/`）

1. **逐项桩清零测试**：对 2.1 表里 13 个修复项，帧内 `getContext()` 返回值不再是
   stubApi 登记的假货 —— 判据用源码文本契约（照 `st-compat-fix-batch-contract.test.ts:238`
   的 `sliceDeclaration` 既有写法）+ 运行时行为（jsdom 里执行 getContextCompat 拿真值）。
2. **libs 25 键测试**：`Object.keys(SillyTavern.libs)` ⊇ 25 权威名（fixture 从
   `_reference/sillytavern-1.18.0/public/lib.js:84-110` 生成，**把 fixture 搬进仓库**：
   `__tests__/fixtures/st-libs-25.json`，附生成命令注释）。
3. **假成功红线测试**：`renameChat` 返回 `false`；C/D 类不补的 `getPresetManager` 保持现状。

### 5.3 真机探针（复跑 `.tmp_probe/probe-parity3.js`）

```
改前：getContext 真问题 15 项；libs 真交集 5/25
改后：真问题项 ≤ 2（只允许 getRequestHeaders 安全决策项 + 合理空容器）
      libs 在场 25/25，其中 yaml/showdown/hljs/Fuse/Popper 五项目标**真能取到值**
      （探针里 await 一下再断言，懒加载需要时间）
srcdoc 单帧字节数 ≤ 50,000（当前 46,167，余量只给 25 个 getter）
```

⚠️ 探针口径提醒：会话不能跨 bash 持久 ⇒ `open` 与 `run-code` 同一条命令；
`### Result` 在输出顶部 ⇒ 重定向到文件再读，别 `| tail`。

### 5.4 反证要求

取 3 个修复项（建议 `getWorldInfoPrompt` / `libs.yaml` / `renameChat`），**临时改坏**
⇒ 契约测试必须红；**还原** ⇒ 必须回绿。两次输出贴进报告。

---

## 6. 交付物

1. 代码 + 测试，提交信息用 `-F <消息文件>`（含代码标识，反引号会被 bash 吃掉），
   `-F` 必须在 `-o -- <paths>` **之前**；只用 `git commit -o -- <pathspec>` 提自己的文件。
2. `docs/_active/report/REPORT_包G_getContext与libs_2026-10-18.md`：
   - 13 项逐项"改前值 → 改后值 + 真值来源"
   - libs 25 项逐项"CDN URL + 版本 + 加载方式"
   - srcdoc 单帧字节数前后对比
   - "后端缺 session rename 端点"后续项
   - 反证两次输出
3. `st-libs-25.json` fixture 入库并注明生成命令。

## 7. 明确不做

- 不改 `frontend/dist`、不跑 `npm run build`、不重建后端镜像（主脑收尾做）
- 不动 `getRequestHeaders` 的 `{}` 决策、不补 `getPresetManager`
- 不碰斜杠命令（包F）、TavernHelper 命名空间广度（包H）、Message.tsx 样式去重（包I）
- 不为 libs 内联任何库源码进 srcdoc
