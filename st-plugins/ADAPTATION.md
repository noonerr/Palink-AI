# ST 插件适配方案（基于源码逆向）

> 生成日期：2026-07-30
> 方法：逐个逆向 `st-plugins/` 下 11 个 ST 1.18.0 官方扩展的 `index.js` / `manifest.json` / 模板，
> 对照 Palink 的 `getContext.ts` / `sandbox.ts` / `SillyTavernCompatRuntime.ts` / `StPluginMountPoints.tsx` / `backend/app/api/silly_tavern.py` 已实现能力，
> 得出逐插件的"需要的 API → Palink 状态 → 适配动作"。

## 一、Palink 已具备的能力（无需改）

### 1. getContext 成员（palink-native 轨道）
已暴露且插件广泛使用：
`eventSource` ✅、`event_types`/`eventTypes` ✅、`extension_settings`/`extensionSettings` ✅、
`registerSlashCommand` ✅、`saveSettingsDebounced` ✅、`toastr`（桥接 sonner）✅、
`callPopup`/`callGenericPopup`（桥接 popup-system）✅、`characters` ✅、`groupId` ✅、
`saveChat` ✅、`saveMetadata` ✅、`getThumbnailUrl` ✅、`chat` ✅、`generate` ✅、
`accountStorage` ✅、`powerUserSettings` ✅。

### 2. DOM 挂载点（`StPluginMountPoints.tsx` 已提供全部 9 个容器）
`#qr_container` ✅、`#regex_container` ✅、`#tts_container` ✅、`#vectors_container` ✅、
`#caption_container` ✅、`#translation_container` ✅、`#summarize_container` ✅、
`#sd_container` ✅、`#expressions_container` ✅。
（注：expressions 还动态用 `#expression-holder`/`#expression-image`，由插件自身在消息区创建，Palink 允许。）

### 3. 后端 ST Extras 端点（已实现）
`/api/extra/caption` ✅、`/api/extra/classify` + `/api/extra/classify/labels` ✅、
`/api/vector/*`（index/query/insert/delete/list/query-multi/purge/purge-all 共 8 个）✅、
`/api/summarize` ✅、`/api/translate` ✅（单一端点）、`/api/openai/generate-image` ✅、
`/api/openai/generate-voice` ✅、`/api/backends/chat-completions/*` ✅、`/api/backends/text-completions/*` ✅。

> 结论：**"只加显示面板 + 轻逻辑" 的插件，前端加载/渲染链路已通**（P0-1 桩已修、挂载点齐、getContext 齐）。
> 真正的适配差异集中在 **(a) 后端端点缺失** 和 **(b) 个别 getContext 成员别名**。

## 二、Palink 缺失 / 不匹配的能力（适配重点）

| 缺口 | 影响插件 | 状态 | 适配动作 |
|---|---|---|---|
| `/api/sd/*`（SD WebUI/ComfyUI 转发代理） | stable-diffusion | ❌ 缺失 | **薄代理，同族于 `/api/extra/*` 与 `/api/openai/generate-image`**：Palink 已有外部图生图代理先例，补 `/api/sd/*` 把请求转派到用户配置的 SD WebUI/ComfyUI 即可。**只代理实际用的 1–2 个 provider（SD WebUI + ComfyUI），不必全做 30 个** |
| `/api/sprites/get`、`/api/sprites/delete` | expressions | ❌ 缺失 | 表情精灵图无法持久化；需补 sprite 存储接口或映射到 Palink 资源服务 |
| `/api/backends/kobold/embed` | vectors | ❌ 缺失 | 向量嵌入无来源；需补 embedding 后端或复用 Palink 已有 embedding 端点 |
| `/api/translate/{provider}` 子路径（libre/google/deepl/deeplx/bing/yandex/lingva/onering） | translate | ⚠️ 不匹配 | Palink 只有单一 `/api/translate`；需加按 provider 路由或前端垫片改写 URL |
| `power_user` 成员（仅 `powerUserSettings`） | expressions | ⚠️ 缺别名 | expressions 用 `power_user.waifuMode`；在 getContext 暴露 `power_user` 别名指向 powerUserSettings |
| TTS 音频合成后端 `/api/tts`（或外部 TTS） | tts | ❓ 待确认 | tts 用 `new Audio()` 播放但 index.js 无 fetch；需确认音频来源（浏览器 Web Speech 可适配 / 外部需代理） |
| 事件实际 emit 时机 | 全部 | ⚠️ 运行时验证 | 事件常量已定义，但 Palink 是否在正确时机 emit（MESSAGE_SENT/CHAT_CHANGED 等）需运行时验证 |

> 注 1：这 11 个插件**都不使用 `getRequestAlert`**（直接 `fetch` 相对路径），所以该项不是缺口。
> 注 2：**ST 的所有 Extras 后端（`/api/extra/*`、`/api/translate`、`/api/sd/*`、`/api/vector/*` 等）本质上都是"转发代理"**——ST 自身不生成图/不翻译/不嵌入，只是把请求转派到你配置好的外部服务（BLIP、翻译 API、SD WebUI、向量库…）。因此"Palink 缺某个后端端点"统一等于"Palink 需要补一个转发代理"，与 Palink 已有的 `/api/openai/generate-image` 同构，**都不属于原理性不可行**。适配时只代理你实际接入的外部服务即可。

## 三、逐插件适配矩阵

### 🟢 regex — 纯前端正则脚本
- 用途：按正则改写/注入提示词。
- getContext：`extension_settings`、`saveSettingsDebounced`、`eventSource`（极少）。
- 事件：无关键订阅。
- DOM：`#regex_container` ✅。
- 后端：无。
- 模板：`scriptTemplate`/`editor`/`dropdown`（根目录或 `templates/`）。
- **适配状态：✅ 已可跑**（P0-1 渲染桩已修 + 挂载点齐）。
- 动作：注册后到"设置"验证面板出现即可。优先级 **P0**。

### 🟢 quick-reply — 纯前端快捷回复
- 用途：可点击的快捷语料条。
- DOM：`#qr_container` ✅（Palink 已提供）、`#send_textarea` ✅。
- 后端：无。
- **适配状态：✅ 已可跑**。优先级 **P0**。

### 🟢 token-counter — 纯前端 token 计数浮动窗
- 用途：显示当前对话 token 数。
- DOM：浮动窗（`window` 模板）。
- 后端：无（本地 tokenizer）。
- 模板：`token-counter/window.html`。
- **适配状态：✅ 可适配**。优先级 **P1**。

### 🟢 memory — 记忆摘要
- 用途：自动/手动总结对话存入记忆。
- DOM：`#summarize_container` ✅。
- 后端：`/api/summarize` ✅。
- 事件：`CHAT_CHANGED` 等（运行时验证）。
- **适配状态：✅ 可适配**（主路径齐）。优先级 **P0/P1**。

### 🟡 caption — 图片描述
- 用途：为消息图片生成文字描述。
- DOM：`#caption_container` ✅。
- 后端：主路径 `/api/extra/caption` ✅；fallback `/api/horde/caption-image` ❌（缺失，但 fallback 可忽略）。
- 事件：`MESSAGE_SENT`、`MESSAGE_FILE_EMBEDDED`。
- **适配状态：✅ 主路径可适配**（需 Palink 配好 caption 后端，如 BLIP/Extras）。
- 动作：忽略 horde fallback。优先级 **P1**。

### 🟡 expressions — 表情精灵
- 用途：根据情绪分类显示角色表情图。
- DOM：`#expressions_container` ✅；动态 `#expression-holder`/`#expression-image`。
- 后端：分类 `/api/extra/classify` + `/api/extra/classify/labels` ✅；精灵图存储 `/api/sprites/*` ❌（缺失）。
- getContext：`power_user.waifuMode` ❌（Palink 仅 `powerUserSettings`）→ 需别名。
- **适配状态：🟡 部分适配**。表情分类可跑；精灵图持久化需补 sprite 后端或映射到 Palink 资源服务。
- 动作：① getContext 暴露 `power_user` 别名；② 补 `/api/sprites/*` 或映射到资源服务。优先级 **P1**。

### 🟡 tts — 文字转语音
- 用途：朗读消息。
- DOM：`#tts_container` ✅；`new Audio()` 播放。
- 后端：index.js 无 fetch → 音频来源待确认（浏览器 Web Speech 可适配 / 外部 TTS 端点需代理）。
- **适配状态：🟡 待确认音频来源**。若走浏览器 Web Speech → ✅ 可适配；若走外部 TTS → 需代理。
- 动作：确认 tts 音频来源后决定。优先级 **P1**。

### 🟡 vectors — 向量记忆
- 用途：把对话嵌入向量库做长期检索。
- DOM：`#vectors_container` ✅。
- 后端：存储 `/api/vector/*` ✅（全 8 个）；**嵌入 `/api/backends/kobold/embed` ❌ 缺失**。
- 事件：`MESSAGE_SENT`/`MESSAGE_RECEIVED`/`MESSAGE_DELETED`/`CHAT_DELETED` 等。
- **适配状态：🟡 部分适配**。向量库 CRUD 可跑，但无嵌入后端则无法生成向量。
- 动作：补 embedding 端点（复用 Palink 已有 embedding 能力）或代理 kobold。优先级 **P1**。

### 🟡 translate — 翻译
- 用途：翻译输入框/消息。
- DOM：`#translation_container` ✅、`#send_textarea` ✅。
- 后端：`/api/translate` ✅（Palink 单一端点）；**插件实际调 `/api/translate/{provider}` 子路径 ⚠️ 不匹配**。
- 事件：较少。
- **适配状态：🟡 路径不匹配**。需把 provider 子路径适配到 Palink 的单一 `/api/translate`。
- 动作：后端加 `/api/translate/{provider}` 路由（内部转派）或前端垫片改写 fetch URL。优先级 **P1**。

### 🟡 connection-manager — 连接配置
- 用途：管理多个 AI 后端连接配置。
- DOM：自身渲染面板。
- 后端：index.js 无 fetch；配置存 `extension_settings`；"实际切换后端"动作可能需 Palink 后端切换 API（待确认）。
- **适配状态：🟡 基本可适配**（UI + 设置）。切换动作需确认 Palink 是否暴露对应 API。
- 动作：确认连接切换是否走 Palink 已有后端管理接口。优先级 **P2**。

### 🟡 stable-diffusion — 图像生成（外部 API 客户端）
- 用途：文生图/图生图。本质是**外部图生图服务的客户端**，ST 的 `/api/sd/*` 只是把请求转发到用户自建的 SD WebUI / ComfyUI（与 caption 转 BLIP、translate 转翻译服务同构，**不是 ST 自己生图**）。
- DOM：`#sd_container` ✅。
- 后端：`/api/sd/*` 转发代理 ❌（Palink 已有同族先例 `/api/openai/generate-image`）；插件支持 ~30 个 provider，但**实际只用到 SD WebUI + ComfyUI 两个**，其余（horde/novelai/google/stability/...）按需再补。
- 模板：`button`/`dropdown`/`settings`。
- **适配状态：🟡 P1（薄代理，同族于 caption/translate）**。Palink 已在代理外部图生图，补 `/api/sd/*` 转发属同构成量级，非"原理性不可行"。
- 动作：后端加 `/api/sd/*` 薄代理（转派到用户配置的 SD URL，覆盖 generate/models/ping 等核心端点）；或前端 URL 改写垫片。只做你用的 provider。优先级 **P1**。

## 四、整体适配路线图

### P0 — 让"显示面板"全部出现（已完成大部分）
- [x] 修 `sandbox.ts` `renderExtensionTemplateAsync` 桩（P0-1）。
- [x] 修 `plugins.py` 模板抽取（根目录 `settings.html` 也能抽，P0-1b）。
- [x] 确认 `StPluginMountPoints` 9 个容器齐全。
- [x] 确认 11 个 manifest 均 `hooks.activate:"init"`。
- [ ] 用户侧：重启后端 + 跑 `_register_extensions.py` 注册 + 插件管理启用，验证 regex/quick-reply/memory 面板出现。

### P1 — 补齐轻后端/小垫片（让逻辑真正可用）
1. **translate**：加 `/api/translate/{provider}` 路由或前端 URL 垫片。
2. **expressions**：getContext 暴露 `power_user` 别名 + 补 `/api/sprites/*`（或映射资源服务）。
3. **vectors**：补 embedding 端点（复用 Palink embedding 能力）替代 `/api/backends/kobold/embed`。
4. **tts**：确认音频来源（Web Speech → 免改；外部 → 代理）。
5. **caption**：忽略 horde fallback，确认 `/api/extra/caption` 后端可用。

### P2 — 视用户资源而定的可选项
- **connection-manager**：确认连接切换是否复用 Palink 后端管理接口。
- **stable-diffusion 的扩展 provider**：核心 SD WebUI/ComfyUI 代理进 P1 后，其余 28 个 provider（horde/novelai/google/stability/bfl/xai/falai/chutes/pollinations/together/zai/aimlapi/openrouter 等）按需再补，不做也不影响主路径。

### 运行时验证项（静态分析无法判定，需浏览器实测）
- Palink 是否在正确时机 `emit` 事件：`MESSAGE_SENT`、`MESSAGE_RECEIVED`、`CHAT_CHANGED`、`MESSAGE_DELETED`、`IMAGE_SWIPED`、`EXTENSION_SETTINGS_LOADED` 等。
- `runtime.execute_scripts` 是否对白名单扩展开启（否则 init 不跑、面板不出）。

## 五、结论
- **你截图里那批"只加显示面板"的插件，前端适配已 90% 就位**——差异几乎全在后端端点和 1 个 getContext 别名。
- **纯前端插件**（regex、quick-reply、token-counter）可立即跑。
- **轻后端插件**（memory、caption、translate、expressions、vectors、tts）需补少量端点/垫片，工作量可控。
- **stable-diffusion** 不是"原理性不可行"——它和 caption/translate 一样是外部 API 客户端，ST 的 `/api/sd/*` 本就是转发代理（Palink 已有 `/api/openai/generate-image` 同族先例）。补一套转发代理属 **P1**，且只需覆盖你实际用的 SD WebUI/ComfyUI，不必做全 30 个 provider。
- 缺失的 4 个扩展（图像提示词模板 / qprompt / 小白X / 酒馆助手）不在本 ST 1.18.0 `extensions/` 内，需你提供来源后再逆向。
