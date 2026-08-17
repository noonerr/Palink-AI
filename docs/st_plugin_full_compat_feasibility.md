# 「后端完美兼容全部 ST 插件」可行性报告（中立·悲观基调）

- 日期：2026-07-29
- 评估对象：Palink-AI 后端（FastAPI/Python，`backend/app/`）
- 参考基准：SillyTavern 1.18.0 官方源码（`SillyTavern-1.18.0/SillyTavern-1.18.0/`）
- 评估问题：**能否在后端实现对全部 ST 插件的 100% 完美兼容？**
- 结论先行：**不能。这不是工程量问题，而是架构层面的原理性不可行。** 下文给出全部证据链。

---

## 0. 一句话结论

> ST 的"插件"绝大多数是**运行在浏览器里的前端 ES Module**，它们的宿主环境是"整个 ST 前端"（DOM、jQuery、约 145 个成员的 `getContext()`、104 种事件、Slash 命令解析器、宏引擎、弹窗系统）；少数"服务端插件"则是 **Node.js + Express** 模块。一个 Python 后端在原理上**既不是浏览器，也不是 Node**，无论投入多少工程量，"纯后端 100% 兼容全部插件"这一命题本身不成立。可达上限是"数据面高兼容 + 前端沙箱代跑代码面"，即当前 Palink 已走的路线；该路线的现实上限估计在 **60–75%（按扩展个数计）/ 明显更低（按重度扩展功能点计）**，且永远无法收敛到 100%。

---

## 1. 术语澄清：ST 的"插件"是两种完全不同的东西

| 类别 | 运行位置 | 技术形态 | 加载机制 | 占生态比例 |
|---|---|---|---|---|
| **前端扩展（UI Extensions）** | 用户浏览器 | ES Module JS + CSS + HTML 模板 | `extensions.js:813` 以 `<script type="module">` 注入 DOM | 绝大多数（内置 14 个 + 几乎全部第三方） |
| **服务端插件（Server Plugins）** | ST 的 Node 进程 | Node 模块，`init(router)` 契约 | `src/plugin-loader.js:153` 动态 `import()`，`server-main.js:313` 挂载 `/api/plugins/<id>` | 少数 |

用户口中的"ST 插件"（酒馆助手、美化包、正则包、状态栏、总结、TTS 等）几乎全部属于第一类。**第一类的宿主是 ST 前端，不是 ST 后端**——这是本报告一切悲观结论的根源。

---

## 2. ST 前端扩展真实依赖的运行时 API 面（实测枚举）

以下均为对 1.18.0 源码的直接核查结果，非估算：

### 2.1 加载与 manifest（`public/scripts/extensions.js`）
- manifest 实际生效字段：`display_name/author/version/homePage/loading_order(:49,571 排序)/js(:429,814)/css(:782)/i18n(:850)/requires(:578, Extras 模块依赖)/optional(:972)/dependencies(:579, 扩展间依赖)/minimum_client_version(:580)/generate_interceptor(:2024)/hooks(:391-466, 含 install/update/delete/enable/disable/activate 七种生命周期钩子)/auto_update(:1949)`。
- 加载方式：`activateExtensions()`(:568) 按 `loading_order` 排序后把 JS 作为 **ES Module `<script>` 注入页面 DOM**。扩展代码天然可以 `import '../script.js'`、`import '../extensions.js'`，可以读写 `window`/`globalThis`/`$`(jQuery)/`toastr`。
- **关键事实：扩展与 ST 前端之间没有任何 API 边界。** 扩展可以 import ST 前端的任意内部模块、操作任意 DOM 节点。兼容目标不是"某个 API 列表"，而是**整个 ST 前端代码库本身**。

### 2.2 `getContext()`：约 145 个顶层成员（`public/scripts/st-context.js:114-307`）
覆盖：聊天数组直接读写（`chat`/`addOneMessage`/`deleteMessage`/`saveChat`）、角色/群组、生成控制（`generate`/`generateRaw`/`generateQuietPrompt`/`stopGeneration`/`streamingProcessor`）、世界书读写、`setExtensionPrompt`、UI（`Popup`/`callGenericPopup`/`loader`/`renderExtensionTemplateAsync`）、事件总线、`SlashCommandParser`、宏、`ToolManager`/`registerFunctionTool`、tokenizer、变量系统、连接管理等。

### 2.3 事件总线：104 种事件（`public/scripts/events.js:3-111`）
`eventSource` 是裸 EventEmitter。事件横跨消息生命周期（13+）、生成流程（`GENERATE_BEFORE_COMBINE_PROMPTS`、`STREAM_TOKEN_RECEIVED` 等 9+）、聊天/角色/群组（20+）、设置/预设（14+）、世界书/工具/TTS/媒体（30+）。**大量事件的语义与前端 UI 状态强绑定**（如消息 DOM 渲染完成），后端即使发出同名事件也无法提供等价语义。

### 2.4 `generate_interceptor`：全局函数名约定（`extensions.js:2015-2040`）
`runGenerationInterceptors(chat, contextSize, type)` 在 `globalThis[manifest.generate_interceptor]` 上查找函数并调用，拦截器可**原地修改 chat 数组**、调用 `abort()` 中止生成。官方 vectors（`vectors_rearrangeChat`）与 stable-diffusion（`SD_ProcessTriggers`）都依赖此机制。**这是一个"浏览器全局命名空间 + JS 引用语义原地改写"的契约，Python 后端没有对应物。**

### 2.5 服务端插件契约（`src/plugin-loader.js`）
插件是 Node 模块，拿到的是 `express.Router()`(:214-216)，可自由 `require` 任意 npm 包、访问 `process.env`。**Python 进程无法加载 Node 模块**；要兼容只能内嵌 Node 子进程并复刻 express 语义——那等于在 Python 后端里再养一个 Node 后端。

### 2.6 内置 14 个功能扩展的依赖抽样（证据）
- jQuery/DOM：gallery 直接捆绑 `jquery.nanogallery2.min.js`；
- toastr：tts/index.js 12+ 处、regex/index.js 4 处；
- Popup：regex/index.js:4,136,422；
- `renderExtensionTemplateAsync`：regex、tts 首部即 import；
- SlashCommandParser：regex/index.js:9,265、quick-reply 大量；
- **扩展互相 import**：caption/memory/expressions/connection-manager/stable-diffusion/vectors 全部从 `extensions/shared.js` 导入公共函数。

即：**官方扩展没有一个能脱离 ST 前端运行**。第三方扩展（酒馆助手类）耦合面只会更深（直接 hack `#chat` DOM 结构、mutation observer、CSS 选择器依赖 ST 的 HTML 布局）。

---

## 3. Palink 后端现状（实测）

| 能力 | 现状 | 位置 |
|---|---|---|
| ST 扩展 zip/manifest 导入 | ✅ 识别并入库，js/css 内联存 `plugin.config["resources"]` | `plugins.py:278-370` |
| `loading_order` | ⚠️ 仅识别、**不排序不生效** | `plugins.py:135` |
| `requires/optional/dependencies` | ❌ **完全不处理**（无依赖解析/校验） | 仅随 manifest 留存 |
| `generate_interceptor` | ❌ **无任何处理路径** | 无 |
| manifest `hooks`（7 种生命周期） | ❌ 未实现 | 无 |
| regex_scripts | ✅ **后端真执行**（转 `PluginScript`，`websocket.py:493/504` 应用） | `plugins.py:549` |
| extension_prompts | ✅ **后端真注入**（唯一端到端生效的插件钩子） | `roleplay_prompt_assembly.py:1547, 3146-3527` |
| extension_settings 命名空间 | ✅ 读写 API 齐全，语义同 ST | `plugins.py:411, 919-954, 1112` |
| 插件 JS 执行 | ❌ 后端**零 JS 引擎**（requirements 无 quickjs/pythonmonkey/mini_racer）；执行全在前端：page 注入（`sillyTavernPluginRuntime.ts:124-240`，非 iframe）或 Proxy 沙箱（`sandbox.ts:1942`） | 前端 |
| registerEndpoint | ❌ 后端仅 404 fallback，明示"端点需在前端沙箱执行" | `plugins.py:1224-1253` |
| 事件总线 | ❌ 后端无事件总线；`eventSource.on` 注册在前端钩子表 | `sandbox.ts:2098` |
| ST 服务端插件（Node） | ❌ 无加载能力 | 无 |

小结：**Palink 后端目前是"数据面兼容"（正则、扩展提示词、设置命名空间、资源转售），代码面 100% 依赖前端执行。** 这与"后端实现完美兼容"的命题方向相反——现有架构已经隐含承认了 JS 只能在前端跑。

---

## 4. 假设性方案逐一评估（悲观视角）

### 方案 A：后端嵌入 JS 引擎（node 子进程 / quickjs / pythonmonkey）+ jsdom 模拟 DOM
- **能解决**：`generate_interceptor` 这类"纯数据变换"拦截器、部分 slash 命令逻辑、服务端插件（若用 node 子进程）。
- **不能解决**（原理性）：
  1. 扩展 import 的是**整个 ST 前端代码库**（`script.js` 1 万+ 行及其全部传递依赖），要让 import 成功等于在后端加载整个 ST 前端——jsdom 跑不动其中的渲染、canvas、CSS、事件时序；
  2. 扩展的价值大半在 **UI**（设置面板、按钮、弹窗、聊天气泡改写）。无头环境里"跑通"了也没有任何用户可见效果，即"兼容"沦为空转；
  3. 多用户服务端 vs ST 单页会话的**状态模型冲突**：ST 扩展假设"一个 window = 一个用户 = 一份全局可变状态"，后端要为每用户每会话隔离一套 jsdom+JS 引擎实例，内存与安全成本随并发线性爆炸；
  4. 恶意/劣质第三方扩展在服务端执行 = **服务端 RCE 面**，比前端沙箱危险一个量级；
  5. 流式生成中 `STREAM_TOKEN_RECEIVED` 等高频事件跨 Python↔JS 引擎边界的往返延迟会实际破坏体验。
- **判定：投入巨大，收益集中在少数无 UI 扩展，永远到不了 100%。**

### 方案 B：在后端用 Python 复刻全部 ST 前端 API（145 成员 context + 104 事件 + slash/宏/popup）
- 兼容目标不是稳定 API 而是 **ST 前端实现细节本身**（第 2.1 节：无 API 边界）。复刻面 ≈ 重写整个 ST 前端。
- ST 每个版本都在漂移（1.18.0 与 1.12 的 context 成员集已不同），这是一场**永远追不上的追赶赛**；
- 即便复刻完，扩展里 `document.querySelector('#chat .mes')` 一行代码就能击穿全部努力。
- **判定：工程上等价于"用 Python 重写浏览器里的 SillyTavern"，不可行。**

### 方案 C：后端实现 ST 的 `/api/*` 协议，让**原生 ST 前端 + 扩展**直连 Palink 后端
- 这是唯一能逼近 100% 的路径（扩展跑在它们本来的宿主——真 ST 前端里）。
- 但代价是：**放弃 Palink 自绘前端体验**，等于承认"兼容插件"与"自有产品形态"二选一；且 ST 前端↔后端的私有协议（chat 存档格式、settings.json、characters 端点、tokenizer 端点等）同样是庞大且随版本漂移的复刻面。
- **判定：技术可行但产品意义存疑——那不是"Palink 兼容 ST 插件"，而是"Palink 退化为 ST 的换皮后端"。**

### "全部插件"这一限定词本身不可满足
第三方扩展生态是**无边界、不可枚举、持续增长**的集合，任何声称"100% 兼容全部插件"的结论在方法论上**不可验证也不可证伪**。哪怕官方 14 个扩展全部跑通，也只覆盖生态的一个零头。

---

## 5. 分级差距矩阵（按机制，悲观口径）

| 机制 | 纯后端可达 | 后端+前端沙箱可达 | 100% 完美 |
|---|---|---|---|
| regex_scripts | ✅ 已达 | ✅ | ✅ 可达 |
| extension_prompts / setExtensionPrompt | ✅ 已达 | ✅ | ✅ 基本可达 |
| extension_settings 命名空间 | ✅ 已达 | ✅ | ✅ 可达 |
| 宏（无 JS 的内置宏） | ✅ 自有引擎 | ✅ | ⚠️ 与 ST 宏引擎的边界行为（覆盖顺序、转义）难逐位对齐 |
| generate_interceptor | ❌ | ⚠️ 前端跑，但 chat 原地修改需回传后端，时序/一致性风险 | ❌ |
| eventSource 104 事件 | ❌ | ⚠️ 只能模拟子集，UI 绑定事件无等价语义 | ❌ |
| getContext 145 成员 | ❌ | ⚠️ 沙箱 shim 长尾无穷 | ❌ |
| Slash 命令 / Popup / 模板渲染 / toastr | ❌ | ⚠️ 需自绘 UI 对等物 | ❌ |
| 扩展直接 import ST 内部模块 / 操作 ST DOM | ❌ | ❌（Palink DOM ≠ ST DOM） | ❌ |
| manifest hooks / dependencies / loading_order | ❌（未实现，理论可补） | ✅ 可补 | ⚠️ 可接近 |
| Node 服务端插件 | ❌ | ❌ | ❌（除非内嵌 Node 进程） |

---

## 6. 最终结论

1. **"在后端实现 100% 完美兼容全部 ST 插件"——不可行，且是原理性不可行，不因投入更多工程而改变。** 核心原因：① 插件宿主是浏览器 + 整个 ST 前端实现（无 API 边界）；② 插件价值大半在 UI；③ 服务端插件是 Node 契约；④ "全部插件"是不可枚举集合，100% 主张不可验证。
2. Palink 当前"后端数据面 + 前端沙箱代码面"的架构方向，已是不放弃自有前端前提下的**正确且唯一现实路线**；诚实的目标表述应为"对无 UI/弱 UI 的数据型扩展（正则、提示词注入、拦截器变换）高保真兼容，对 UI 型扩展提供尽力而为的沙箱兼容"。
3. 若必须逼近 100%，唯一路径是方案 C（跑原生 ST 前端），但那是产品形态的置换而非兼容能力的增强。
4. 短期可低成本补齐的诚实清单（不改变悲观结论，只提高比例）：`loading_order` 排序生效、`dependencies/requires` 解析与缺失告警、manifest `hooks` 生命周期、前端沙箱内 `generate_interceptor` 的 chat 回传协议、事件子集的语义文档化（明确哪些事件永不触发）。

> 建议对外/对内一律避免"完美兼容""全部插件"表述，改用"兼容矩阵 + 明确不支持清单"。任何 100% 承诺在该架构下均属过度承诺。
