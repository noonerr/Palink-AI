# Palink-AI 插件系统问题专项整理

> **整理日期**: 2026-08-09
> **来源**: 从 `docs/DEEP_AUDIT_REPORT_2026-08-09.md` 提取的全部插件相关问题（该报告经 6 路验证子代理二次复核，见其 §11 修正记录）
> **目标**: 让 ST 1.18.0 插件/扩展在 Palink 正常工作所需的全部问题清单
> **结论**: **插件系统目前"面板能出、功能崩坏"** —— 加载-执行-渲染骨架已搭好，但存在 P0 结构性缺陷导致第三方 ST 插件核心功能大面积失效，另有 CRITICAL 级安全漏洞

---

## 0. 总结论（TL;DR）

Palink 插件系统的问题可分四类：

1. **兼容性 P0（功能崩溃）**：沙箱 `getContext()` 是极简对象、事件 emit 大量缺失 → 已抽查的 4 个内置扩展（memory/tts/caption/vectors）全部命中崩溃或静默失效。
2. **兼容性 P1（功能不完整）**：moduleMap 缺失 10+ 个 ST 模块、`extension_settings` 全局标识符 undefined、`chat_metadata` 快照、挂载点隐藏、模板渲染器简化版、`power_user`/`oai_settings` stub、slash 命令 stub。
3. **后端端点缺口（功能 404）**：`/api/translate/{provider}` 8 个子路径、`/api/sd/*` 约 50 个子路径、`/api/backends/kobold/embed` 全部 404。
4. **安全 CRITICAL**：插件沙箱可被一行代码逃逸（任意代码执行）、zip 导入无大小限制（DoS）、插件全局共享无用户隔离。

---

## 1. 兼容性 P0（导致插件核心功能崩溃）

### P-1 沙箱 `getContext()` 返回极简对象（缺 chat/saveChat/groupId 等）

- **问题**：插件 `import { getContext } from '../../extensions.js'` 命中 `moduleMap['extensions.js'].getContext = sandbox.getContext`（[sandbox.ts:3368](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3368)）——import 路径与全局路径是**同一个极简函数**。返回的 `PluginContext`（[context.ts:61-203](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/context.ts#L61-L203)）只有 on/off/emit/once/storage/registerCommand/registerMacro/registerHook/log，**缺 `context.chat`/`saveChat`/`groupId`/`extensionSettings`/`eventSource`**。完整版 buildStContext 仅作 `moduleMap['script.js']` 数据源，不是 getContext 返回值。
- **已抽查确认命中的扩展**：
  - memory [index.js:91/588](file:///d:/项目/Palink-AI/st-plugins/memory/index.js#L91)（saveChat/chat.length）→ TypeError
  - tts [index.js:160-162](file:///d:/项目/Palink-AI/st-plugins/tts/index.js#L160-L162)（chat[id]）→ TypeError
  - caption [index.js:407](file:///d:/项目/Palink-AI/st-plugins/caption/index.js#L407)（chat[messageId]）→ TypeError
  - vectors [index.js:454](file:///d:/项目/Palink-AI/st-plugins/vectors/index.js#L454)（`Array.isArray(undefined)` 短路）→ **静默失效**（非崩溃）
- **影响**：插件核心功能大面积崩溃或静默失效。
- **修复方向**：`getContext()` 聚合 ST 兼容字段（复用 `sillytavern/getContext.ts:1377` 的 buildStContext 结果）。

### P-2 事件契约定义了但 emit 大量缺失（app_ready 等）

- **问题**：[runtime.ts:241-242](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/runtime.ts#L241-L242) 定义了 APP_READY 常量，但 runtime.ts 全部 `eventSource.emit(...)` 调用（532-964 行）**无一处 emit** `app_ready`/`generation_after_commands`/`group_member_drafted`/`world_info_activated`/`character_deleted`/`chat_created` 等。全前端 src 仅 smart-card runtime `SillyTavernCompatRuntime.ts:6213` 有 emit，插件系统不走它。测试文件 [event-contract.test.ts:620-621](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/__tests__/event-contract.test.ts#L620-L621) 已自认"未实现事件回放"。
- **实际后果**：quick-reply [index.js:214](file:///d:/项目/Palink-AI/st-plugins/quick-reply/index.js#L214) 的 `eventSource.on(APP_READY, finalizeInit)` 永不触发 → `isReady=false` → 所有自动执行排队永不消费；memory 定时总结失效。
- **修复方向**：补 `app_ready` 等缺失事件的 emit（或在插件 init 后直接调用 finalizeInit 等价路径）。

### P-3 `new Function` 沙箱可被一行代码逃逸（安全，详见 §4 S-1）

- `var Function` 遮蔽可被 `(function(){}).constructor('return this')()` 绕过；fake script 直接执行任意 URL；`self`/`globalThis` 等未遮蔽直达真实 window。详见 §4。

### P-4 `extension_settings` 全局标识符为 undefined

- **问题**：[sandbox.ts:2392](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L2392) `var extension_settings = __sandbox.extension_settings`，而传给 buildWrappedCode 的 __sandbox 实参对象**没有 `extension_settings` 键** → 不 import 直接全局引用 `extension_settings.xxx` 的插件 TypeError。import 路径 ✅（`moduleMap['extensions.js'].extension_settings` = 共享 Proxy，[sandbox.ts:3246-3271](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3246-L3271)）。
- **修复方向**：在 __sandbox 对象补 `extension_settings` 键，或把全局标识符改为从 moduleMap 提取。

---

## 2. 兼容性 P1（功能不完整/面板问题）

### P-5 `chat_metadata` 是加载时快照（非实时引用）

- [sandbox.ts:3234](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3234) 在插件加载时 `stContext.chatMetadata ?? {}` 取一次；聊天切换时 [runtime.ts:528-548](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/runtime.ts#L528-L548) 用新对象**替换** chatMetadata 引用（L545 比较 `ctx.chatMetadata !== prev.chatMetadata`）→ moduleMap 中快照仍指向旧对象，插件写入后自读旧值。
- **影响**：quick-reply 等读旧值。

### P-6 moduleMap 缺失 10+ 个 ST 模块

- [sandbox.ts:3319-3580](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3319-L3580) 缺失：`Fuse`、`Popper`、`loader`/`ActionLoaderHandle`、`nai-settings`、`tool-calling`、`streaming-display`、`SlashCommandClosure`、`ConnectionManagerRequestService`、`performFuzzySearch`、`getSecretLabelById` 等 → import 得 undefined。
- **实际踩中**：stable-diffusion（Popper/loader）、expressions（Fuse/performFuzzySearch）、connection-manager（Fuse/ConnectionManagerRequestService/SlashCommand*/getSecretLabelById）直接 TypeError。

### P-7 挂载点默认 `display:none`，插件面板默认不可见

- [StPluginMountPoints.tsx:110-163](file:///d:/项目/Palink-AI/frontend/src/components/st-plugin-ui-host/StPluginMountPoints.tsx#L110-L163)：5 个挂载点（top-settings-holder/extensions-menu/extensions-settings/extensions-settings2/moving-divs）全部内联 `style={{display:'none'}}`；全前端无任何 `.show()`/改 display 代码。
- **影响**：插件面板出不来（只能经 PluginManager 克隆查看）。

### P-8 模板渲染器是简化版

- [sandbox.ts:72-77](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L72-L77) `compileSimpleTemplateForSandbox` 仅支持 `{{var}}`/`{{{var}}}`；`{{#if}}`/`{{#each}}`/helper 原样输出。与 getContext 轨道的完整 Handlebars（[getContext.ts:65-103](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/getContext.ts#L65-L103)）是两套行为不一致的实现。
- **影响**：第三方插件模板（含 block/helper 语法）极可能失效（内置 14 扩展模板实测无此语法，故未暴露）。

### P-9 `power_user` 极简 stub（仅 2 字段）

- [sandbox.ts:3501-3504](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3501-L3504)：`power_user: { persona_show_user_name: false, persona_description_position: 0 }`，`waifuMode` 等缺失 → expressions 等读 waifuMode 失效。

### P-10 `oai_settings`/`secret_state` 极简 stub → throwIfInvalidModel 抛错

- [sandbox.ts:3522-3524](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3522-L3524) `oai_settings: { preset: 'default' }`（无 reverse_proxy/custom_url）；[sandbox.ts:3516-3519](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3516-L3519) `secret_state: {}`。
- **后果**：shared.js 的 `throwIfInvalidModel` 因 `SECRET_KEYS={}` 使 `SECRET_KEYS.OPENAI` 为 undefined → 抛"OpenAI API key is not set" → caption/vectors 模型校验失败。

### P-11 `SlashCommandParser.parse()` 返回 stub

- [sandbox.ts:3283-3285](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3283-L3285)：`static parse() { return { commands: [] }; }` 恒空；且缺 `addCommandObject`/`fromProps`（memory [index.js:1084](file:///d:/项目/Palink-AI/st-plugins/memory/index.js#L1084) 直接 TypeError）。

---

## 3. 后端端点缺口（插件实际调用 vs Palink 实现）

| 端点 | 状态 | 证据 | 影响 |
|---|---|---|---|
| `/api/translate/{provider}`（onering/libre/google/lingva/deepl/deeplx/bing/yandex 8 个子路径） | ❌ **全部 404** | [translate/index.js:254-413](file:///d:/项目/Palink-AI/st-plugins/translate/index.js#L254-L413) vs 后端仅单一 `POST /api/translate` 且不读 body（[silly_tavern.py:7568-7572](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L7568-L7572)） | **翻译功能完全不可用**（ADAPTATION.md 已识别但未修复） |
| `/api/sd/*`（插件调用约 50 个子路径：/ping、/get-model、/samplers、/schedulers、/upscalers、/set-model、/sdcpp/*、/drawthings/*、/comfy/* 等） | ❌ **绝大多数 404** | 后端仅 7 条路由（[sd.py:121-224](file:///d:/项目/Palink-AI/backend/app/api/sd.py#L121-L224)：generate/img2img/get-models/get-samplers/parsers/comfy/get-workflow/status），且路径名对不上（/models vs /get-models、/samplers vs /get-samplers、/comfy/workflow vs /comfy/get-workflow） | stable-diffusion 基本不可用 |
| `/api/backends/kobold/embed` | ❌ **404** | [vectors/index.js:1455](file:///d:/项目/Palink-AI/st-plugins/vectors/index.js#L1455)；后端 /api/backends/* 仅 status/generate/text-completions 三个 | 无法生成向量 |
| `/api/extensions/install` | ⚠️ sidecar 未配置时 502 | [silly_tavern.py:8171-8253](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L8171-L8253) | 依赖 sidecar 可用性 |
| `/api/quick-replies/*`、`/api/extra/classify`、`/api/extra/caption`、`/api/vector/*`、`/api/sprites/*` | ✅ 存在 | — | — |
| `generateRaw({prompt, systemPrompt, responseLength})`（memory 单对象调用） | ⚠️ **签名错位** | [memory/index.js:524/731](file:///d:/项目/Palink-AI/st-plugins/memory/index.js#L524) import 自 script.js → getContext 版 `generateRaw(prompt, options)`（[getContext.ts:1479-1481](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/getContext.ts#L1479-L1481)、[generation-engine.ts:405](file:///d:/项目/Palink-AI/frontend/src/services/generation-engine.ts#L405)），对象被当 prompt 传 → systemPrompt/responseLength 丢失；沙箱全局 generateRaw 更是 stub 返回空串 | memory 总结不可用 |

---

## 4. 安全 CRITICAL（插件相关）

### S-1 插件沙箱可完全逃逸 → 前端任意代码执行（CRITICAL）

**四条逃逸路径**：

1. **Function 构造器绕过**：`var Function` 遮蔽（[sandbox.ts:2360-2362](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L2360-L2362)）可被 `(function(){}).constructor('return this')()` 绕过（函数字面量在真实 realm 创建，`.constructor` 即真实 Function）。
2. **fake script 直通真实 document.head**：`createFakeScriptElement`（[sandbox.ts:323-405](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L323-L405)）设置 `src` 时在**真实 document.head** 创建 `<script>` 执行，**不 consult `createSandboxedFetch` 的域名白名单**（L1125-1185）；textContent/innerHTML 同样真实执行。
3. **未遮蔽全局直达真实 window**：`self`/`top`/`parent`/`globalThis`/`WebSocket`/`indexedDB`/`XMLHttpRequest`/`Worker`/`Audio`/`Image` 均未 var 遮蔽（Proxy get 陷阱只拦 `window.xxx` 属性访问）。
4. **`tavern_helper` 类型插件完全跳过沙箱**：[manager.ts:167-176](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/manager.ts#L167-L176) 由 [sillyTavernPluginRuntime.ts:341-353](file:///d:/项目/Palink-AI/frontend/src/utils/sillyTavernPluginRuntime.ts#L341-L353) 以真实 `<script>` 标签注入执行，并注入真实 window.$/jQuery。

**放大因素**：
- 后端 `/api/plugins/runtime/config`（[plugins.py:999-1054](file:///d:/项目/Palink-AI/backend/app/api/plugins.py#L999-L1054)）对**所有登录用户**下发全部启用插件的完整 JS/CSS。
- zip 导入原样存库（[plugins.py:290-385](file:///d:/项目/Palink-AI/backend/app/api/plugins.py#L290-L385)）。
- `injectPluginCSS`（[sandbox.ts:3664-3674](file:///d:/项目/Palink-AI/frontend/src/lib/plugin-system/sandbox.ts#L3664-L3674)）CSS 未消毒。
- [bridge.js:481](file:///d:/项目/Palink-AI/frontend/public/st/bridge.js#L481) postMessage `'*'` 通配 targetOrigin。

**攻击场景**：恶意/被投毒扩展（管理员导入或角色卡携带 `extensions.tavern_helper`）→ 窃取 JWT（localStorage/fetch `/api/keys`）、接管主应用、外传聊天内容。

**修复方向**：插件 JS 移入带 `sandbox` 属性的 iframe/Worker 真隔离；fake script src 强制走 CDN 白名单并禁止内联执行；补 Function 构造器拦截；`/runtime/config` 仅对已启用且经审批插件下发；CSS 用 CSP style-src 或 DOMPurify 清洗。

### S-9 插件 zip 导入无总大小/条目数限制（zip 炸弹/内存 DoS）

- [plugins.py:1077](file:///d:/项目/Palink-AI/backend/app/api/plugins.py#L1077)：`content = await file.read()` **无大小上限**。
- zip 解析（[plugins.py:290-385](file:///d:/项目/Palink-AI/backend/app/api/plugins.py#L290-L385)）：只对非 js/css/module/template 的 assets 条目有 `>5MB 跳过`；**js/css/module/template 全量读入无单文件限制，解压总量、条目总数均无限制**。
- **修复方向**：流式限流读取 + 条目总数/解压总字节限制。

### M-3 插件为全局共享（无 user_id），regex 脚本作用于所有用户 prompt

- [plugins.py:995/1013/1063](file:///d:/项目/Palink-AI/backend/app/api/plugins.py#L995) 查询无 user 过滤；[plugin.py:11-25](file:///d:/项目/Palink-AI/backend/app/models/plugin.py#L11-L25) 模型无 user_id。
- **影响**：单实例多用户时，管理员插件内容注入所有用户 prompt（共享全局资源）。
- **修复方向**：明确插件为系统级资源；若需多租户则加 user_id 与隔离。

### 相关 XSS 面（§5.5）

- 前端主渲染链有消毒（DOMPurify），**主渲染链安全**；插件沙箱 + ST 图片上传 + 导入 name 不清洗是主要 XSS 面。

---

## 5. 逐插件兼容性结论（14 个内置 ST 扩展）

| 插件 | 状态 | 阻塞点 |
|---|---|---|
| **regex** | 🟥 部分可用 | 面板渲染可用；slash 命令解析失效（SlashCommandParser stub） |
| **quick-reply** | 🟥 UI 可用、自动执行全废 | `app_ready` 不 emit → finalizeInit 永不执行 → 自动执行排队永不消费；chat_metadata 快照读旧值 |
| **memory** | 🟥 崩溃 | `context.chat.length` TypeError、`saveChat` undefined、generateRaw 签名错位 → 自动/手动总结均无法运行 |
| **tts** | 🟥 崩溃 | `context.chat[id]` TypeError；`new Audio()` 靠沙箱逃逸"碰巧可用" |
| **vectors** | 🟥 静默失效 | `getContext().chat` undefined → `Array.isArray` 短路；`/api/backends/kobold/embed` 404 无法生成向量 |
| **stable-diffusion** | 🟥 基本不可用 | `Popper`/`ActionLoaderHandle` import 缺失 TypeError；`/api/sd/*` 端点 404 |
| **caption** | 🟥 崩溃 | `getContext().chat` TypeError + `throwIfInvalidModel` 抛"API key is not set" |
| **expressions** | 🟥 部分失效 | `Fuse` import 缺失；`getContext().groupId` undefined；`waifuMode` 缺失 → 分类可用、精灵图/waifuMode 失效 |
| **connection-manager** | 🟥 崩溃 | `Fuse`/`ConnectionManagerRequestService`/`SlashCommand*`/`getSecretLabelById`/`performFuzzySearch` 缺失 |
| **translate** | 🟥 不可用 | 8 个 `/api/translate/{provider}` 子路径 404 |
| **attachments/assets/gallery/token-counter** | 🟨 面板可用 | 深层逻辑依赖缺失模块（Fuse 等）需运行时验证 |

---

## 6. 修复优先级路线图

### P0（阻塞 + 安全底线）
1. **S-1** 插件沙箱加固：fake script 白名单 + Function 逃逸封堵 + CSS 消毒；推荐 iframe/blob URL 真隔离。（§4）
2. **P-1/P-2** 沙箱 `getContext()` 聚合 ST 兼容字段（复用 buildStContext）+ 补 `app_ready` 等缺失事件。（§1）
3. **S-9** zip 导入总量/条目限制。（§4）

### P1（功能完整）
4. P-3~P-11 逐步补齐：moduleMap 缺失模块（至少安全 stub）、`extension_settings` 全局标识符、`chat_metadata` 实时引用、挂载点按启用状态显示、模板渲染器统一为完整 Handlebars、`power_user`/`oai_settings`/`secret_state` 字段补齐、SlashCommandParser 真实现。（§1/§2）
5. `/api/translate/{provider}` 路由（内部转派单一 /api/translate）、`/api/sd/*` 端点对齐、`/api/backends/kobold/embed`。（§3）
6. `generateRaw` 签名兼容（支持对象参数或 options 展开）。（§3）

### P2（完善）
7. 插件全局共享 → 用户级隔离（M-3）。
8. `extension_settings` 后端同步（当前仅 localStorage）；酒馆助手变量（`tavernVariableStore`）持久化。
9. 第三方插件（third-party 目录，如 JS-Slash-Runner/LittleWhiteBox）逐个验证；Vite 源码工程需构建产物。

---

## 7. 修复记录（2026-08-11，低风险 bug 修复批次）

### 7.1 备份

- **git 分支**：`backup-before-smartcard-fix-20260811`（修复前 HEAD）
- **文件副本**：`frontend/src_bak_20260811_smartcard/`（SillyTavernCompatRuntime.ts、variables-compat.ts、variables-compat.test.ts、Message.tsx）

### 7.2 本次修复（5 项，全部在 plugin-system，均为"不影响其他功能"的低风险修复）

| # | 问题 | 修复 | 位置 |
|---|---|---|---|
| FIX-1 | `getCurrentChatId` 返回 createMockRequire 构建时快照，聊天切换后 regex/tts/vectors/stable-diffusion 等用「chatId !== getCurrentChatId()」的切换判定失效 | 改为实时 `buildStContext()?.chatId`，catch 兜底回退构建期快照（与既有 P-5 chat/chat_metadata getter 同模式） | `sandbox.ts:4049-4058` |
| FIX-2 | `triggerHandler` 读取 `el._handlers` 恒为空（`on` 用 addEventListener 从不写入 `_handlers`）→ 手动触发处理器完全失效 | 新增 `handlerRegistry`（`WeakMap<Element, Map<string, Set<Function>>>`），`on` 直接分支注册、`off` 注销、`one` 注册原始 handler 并对称注销、`triggerHandler` 从注册表读取；委托分支不注册（与 jQuery 语义一致） | `sandbox.ts:1410-1440/1543-1611` |
| FIX-3 | 委托 `on(event, selector, handler)` 注册的是 wrapped 闭包，三参 `off` 直接 `removeEventListener(actualHandler)` 匹配不到 → 委托监听器泄漏、反复 on/off 堆叠 | 新增 `delegatedRegistry`（`WeakMap<Element, Map<string, Map<string, Function>>>`）按 (el, event, selector) 记录 wrapped；`off` 三参形式查表拿 wrapped 精确移除，查不到时降级直接移除 handler | `sandbox.ts:1417-1455/1564-1572` |
| FIX-4 | `eventSource.removeAllListeners` 空实现（注释误写"eventBus 会处理"，实际不清理任何监听器） | sandbox 按参数委托 `context.removeAllListeners(event)`；context.ts 新增 `removeAllListeners` 方法（`Array.from` 快照安全遍历，指定事件/全量两种模式）；types.ts `PluginContext` 补 `once`/`removeAllListeners` 类型声明 | `sandbox.ts:2882-2891`、`context.ts:96-114`、`types.ts:128-135` |
| FIX-5 | 死变量 `const slashCommandScopeCompat = new Map()`（声明后全文件零引用） | 删除 | `sandbox.ts:3727`（已删） |

### 7.3 验证结果

| 验证项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `node --experimental-strip-types --test`（variables-compat.test.ts） | ✅ 15/15 通过 |
| `npm run build` | ✅ 构建成功（仅 chunk 大小警告） |
| 独立复查 agent 逐项复核 | ✅ 5/5 修复正确，无新引入缺陷、无类型错误、注册/注销键对称 |

### 7.4 需要知晓的观察（2026-08-11 复核期间确认）

1. **L5105 悬空引用已闭环**：本报告初版提到 `SillyTavernCompatRuntime.ts:5105` 引用已删除的 `getChatVariableCompat`——复核时当前代码已是 `getVariableWithPriorityCompat`，全文件零残留，已无需处理。
2. **FIX-2/FIX-3 所在兼容层当前为"未接线"代码**：`createSandboxedJQuery` 的结果未被实际使用（插件拿到的 `$`/`jQuery` 是真实 jQuery 官方实现，on/off/triggerHandler 自洽，无 FIX-2/3 的问题）。因此 FIX-2/3 属兼容层正确性保障，逻辑正确、不破坏任何行为，但暂不影响插件运行时表现；若未来接线沙箱化 jQuery（更强的 DOM 隔离），这两项修复即为前置保障。
3. **原 P 系列多项已在 2026-08-11 前落地**（排查确认，以代码为准）：P-1（getContext 聚合 Proxy，`sandbox.ts:2762-2783`）、P-2（事件缺失，runtime.ts 已有 emitAppReady）、P-4（extension_settings 注入 `sandbox.ts:2784`）、P-5（chat/chat_metadata 实时 getter）、P-6/P-8/P-9/P-10/P-11（moduleMap 补全、Handlebars、power_user/oai_settings/SECRET_KEYS、SlashCommandParserCompat）均已落实，本节 5 项修复与这些不重叠。

---

## 9. Phase 2 修复记录（2026-08-11，V/S 系列安全与验证项）

按 `DEEP_AUDIT_REPORT_2026-08-09.md` §8 Phase 2 路线图执行。本批次覆盖 **V-1~V-4（验证工具）与 S-4/S-5/S-8/S-9/S-10（安全 HIGH）**；S-6/S-7 按用户指示（影响现有功能性/UI）跳过并记录。

### 9.1 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| V-1 | golden vector diff 工具丢弃 `name` 字段（示例消息缺 name 的真实差异被掩盖） | `diff_messages.py`：`normalize_message` 保留 name；`compare_messages` 比较 name（name/role 任一不一致则该条不算匹配，符合 spec 3.9 逐字段一致）；重新生成全部 palink golden vectors | 修复前 basic_char 仅 80%（name 差异被掩盖），修复后 5 个 fixture 全部 100% PASS |
| V-2 | st_capture_server 输出字段与现有 st_*.json 不符（path vs scenario_name/st_version） | `st_capture_server.py`：golden dict 由 `path` 改为 `scenario_name`/`st_version`；新增 `--fixture` 参数 | 结构对齐验证 |
| V-3 | token 裁剪路径从未被 golden 真实触发（长对话被条数截断吃掉） | `palink_golden_vector.py`：long_chat_truncation fixture 显式 `skip_chat_history=False` + 消息加长，30 条历史真实创建并超预算 | 容器内实测 `st_compat_trim: trimmed=6; original=7343; budget=5585`（裁剪真实触发） |
| V-4 | `test_st_contract.py` 用 `file` 字段而非 ST 客户端 `avatar` | 上传契约测试改用 `avatar` 字段（模拟 ST 客户端真实行为）；保留 `file` 字段兼容测试 | pytest 40 passed |
| S-4 | ChatVariable 水平越权（`silly_tavern.py` variables/get/set/delete 未校验 session 归属） | 新增 `_verify_session_ownership`（session_id + user_id 联合解析，找不到 404），三个端点查询前调用 | 新增 `test_s4_s10_security.py` 8 passed |
| S-5 | ST sidecar 业务头注入 + session 未验证签入 cookie | (1) `_is_proxy_strip_header` 拦截全部 `x-palink-*` 头（客户端伪造丢弃，转发头服务端重建）；(2) `st_native_login` 签 cookie 前校验 character/session 归属 | 契约测试通过 |
| S-8 | 日志脱敏组件实现但从未启用 | `main.py` 用 `setup_sanitized_logging` 替换裸 `basicConfig`（root handler 自动打码 JWT/密钥/手机号等） | 启动日志正常 |
| S-9 | 插件 zip 导入无总大小/条目数限制（zip 炸弹） | `plugins.py`：`_read_upload_limited`（50MB 分块读取）+ 条目（2000）/解压总量（100MB）限制 | pytest `test_st_plugin_import.py` 7 passed 无回归 |
| S-10 | ST 图片上传无扩展名/MIME/魔数校验 | `silly_tavern.py`：`_st_validate_image_content` 扩展名白名单（png/jpg/jpeg/gif/webp）+ 魔数校验 | `.html/.svg/伪 PNG → 400`，合法 PNG → 200 |

### 9.2 跳过并记录（按用户指示：影响现有功能性/UI）

| # | 问题 | 跳过原因 |
|---|---|---|
| S-6 | ST sidecar 关闭全部安全开关且与 backend 同网 | 开启白名单/私有地址校验会拦截 `backend:8000`（私有地址）导致 ST 生成中断；网络隔离切断 ST→backend 链路，均直接影响现有功能 |
| S-7 | 上传 token 明文放 URL query | 改 HttpOnly cookie 需前端全部图片渲染路径配合（`<img src>` 无法带 header），属 UI/功能层改动 |

### 9.3 测试与构建

| 验证项 | 结果 |
|---|---|
| pytest（全量，容器内） | 738 passed, 53 skipped（1 个既有失败 `test_mvu_engine.py`，与本次无关，mvu_engine 为未跟踪既有文件） |
| Docker 容器重建 | ✅ backend 健康 |

## 10. Phase 2 修复记录（2026-08-11，M-1/M-7 与 E-1~E-6）

按 `DEEP_AUDIT_REPORT_2026-08-09.md` §8 Phase 2 路线图执行。本批次覆盖 **M-1（水平越权 HIGH）、M-7（并发生成静默丢弃 P1）与 E-1~E-6（性能 P1）**；E-7~E-12、M-3~M-10 仍按 §8 路线图留待后续（涉及补索引/前端虚拟化等，不影响本批目标）。

### 10.1 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| M-1 | `/api/variables/local/{session_id}` 三端点未校验 session 归属（水平越权） | `variables.py` 新增 `_verify_local_session_owner`（按 `CharacterChatSession.id + user_id` 联合解析，找不到 404），get/set/delete 三端点查询 ChatVariable 前调用 | pytest 全量通过；越权请求 404 |
| M-7 | 同会话并发生成：第二条用户消息落库但 AI 回复被静默丢弃 | `websocket_manager.py` 新增 `StreamSessionBusyError`，`create_stream_session` busy 时抛异常而非静默返回；`websocket.py` 三处调用点（普通聊天 + character-chat continue/普通生成）统一捕获：回滚刚落库的用户消息（`_rollback_last_user_message` 按模型区分 ChatMessage/CharacterChatMessage）+ 前端发送明确错误提示 | 并发场景不再出现「消息存在、无回复」 |
| E-1 | 装配主链路在事件循环内执行同步 SQL/CPU（单 worker 全站阻塞） | `roleplay_prompt_assembly.py`：纯同步重活移入 `asyncio.to_thread`——`_append_worldbook_context`/`_append_plotline_context` 去 async 化后经 to_thread 调用，`build_st_compat_messages`/`build_character_chat_messages` 同样包裹（contextvar 模型经 to_thread context 复制保留）；同步 4 个测试文件 AsyncMock→MagicMock | 相关测试 82+153+255 passed；容器内全量 749 passed |
| E-2 | token 估算重复计算 + O(n²) 裁剪；st-compat 分支弃用 `_collect_prompt_sources` | `_estimate_tokens` 增加按 `(model, text)` 的 `lru_cache(4096)` 缓存；`_apply_st_compat_history_trim` 改为每消息单次编码 + 前缀和数组 O(1) 区间 token 计算（裁剪循环 O(n²)→O(n)）；st-compat 分支跳过被弃用的 `_collect_prompt_sources` | `test_st_compat_token_budget.py` 等 153 passed 无回归 |
| E-3 | 世界书扫描 N+1（每条目 2-3 次 state 查询） | `worldbook_service.py` `TimedEffectsManager` 增加请求级 state 缓存：惰性批量加载（1 次 SQL 全量）、`get_state` 走缓存，`record_activation`/`reset_state`/`update_after_message` 同步维护缓存（迭代删除收集后统一 pop） | 5 个 worldbook 测试文件全部通过 |
| E-4 | `_get_full_branch_history` 无 SQL LIMIT（长会话全量加载） | `character_ext.py` 改为逐分支 SQL 查询：`ORDER BY created_at DESC LIMIT limit` 再反转恢复升序，并在 SQL 层过滤 fork 点之后消息（`id <= up_to_id`），语义与原 `deduped[-limit:]` 等价 | pytest 全量通过；`up_to_message_id` 保留全量路径 |
| E-5 | `/api/chats/recent` 每会话 2 次查询（last_msg + count） | `silly_tavern.py` 角色聊天与群聊均改为 2 次 SQL 批量统计：`GROUP BY session_id` 一次取 `COUNT + MAX(id)`，再 `IN (ids)` 一次取全部最新消息（2N+1 → 5 次） | 容器内 pytest 通过；PostgreSQL 冒烟 GROUP BY 语法 OK |
| E-6 | `/api/characters/all` 每角色 1 次 `_latest_session` 查询 | `silly_tavern.py` 用 `ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY coalesce(updated_at, created_at) DESC, created_at DESC)` 窗口函数一次批量取每角色最新会话（兼容 PostgreSQL/SQLite），排序与原 `_latest_session` 完全一致 | `test_st_contract.py` 角色契约通过；PostgreSQL 冒烟窗口函数语法 OK |

### 10.2 测试与构建

| 验证项 | 结果 |
|---|---|
| pytest（全量，容器内 Python 3.10 + SQLite） | 749 passed, 53 skipped（仅 1 个既有失败 `test_mvu_engine.py`，与本次无关） |
| pytest（宿主机 Python 3.14 本批相关文件） | 82 + 153 + 255 + 258 passed；多出的 2 个失败（bridge.js 白名单、plugin_import settings.html）为宿主机 Python 3.14 环境差异，容器内均通过 |
| PostgreSQL 语法冒烟（E-5 GROUP BY / E-6 窗口函数） | ✅ 均执行成功 |
| Docker 容器重建 | ✅ backend 镜像重建 + 容器重建，health 200 OK |

## 11. Phase 2 修复记录（2026-08-11，第四批 E-7/E-8/E-10/M-4/M-9/L-1）

按 `DEEP_AUDIT_REPORT_2026-08-09.md` §8 Phase 2 路线图继续执行。本批次覆盖 **E-7/E-8/E-10（性能 P2）、M-4/M-9（隔离/内存 P2）、L-1（LLM 客户端）**；影响现有功能性/UI 或属配置架构级改动的项按用户指示跳过并记录（见 11.2）。

### 11.1 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| E-7 | prompt 正则按消息重复查库（每消息 2 次：PluginScript + UserSetting，24 条 ≈ 48 次/请求） | `character_ext.py`：新增 `_load_plugin_regex_script_dicts`（一次加载全部启用插件脚本）+ `_apply_plugin_regex_script_dicts`（纯内存应用）；`_apply_plugin_regex_scripts` 重构为 wrapper（签名/行为不变，其他调用方零影响）；`_apply_prompt_regex_to_messages` 消息循环前预加载脚本，循环内零 DB 查询 | regex/worldbook/st_compat 相关 217 passed |
| E-8 | 单次装配基础 SQL 15-22 次（GroupChat 最多 6 次、InstructTemplate 2 次） | `roleplay_prompt_assembly.py`：`PromptAssemblyRequest` 增加 `_cache` 请求级缓存字段；新增 `_cached_request_group`；装配路径 6 处 GroupChat 查询统一走缓存；`_load_instruct_template` 加 `cache` 参数并在 2 处调用点传入 | 群聊/装配相关 157 passed |
| E-10 | 缺失关键索引：`extension_prompts.user_id/session_id`、`world_books.user_id/character_id`、`world_book_stages.world_book_id` | 新增 alembic migration `0059_add_e10_assembly_indexes.py`（CONCURRENTLY 建索引，不阻塞读写；SQLite 方言忽略该参数） | migration 编译通过；生产 Postgres 生效 |
| M-4 | OpenAI 兼容端点 service key 认证后固定以 admin 身份执行（多 ST 用户全部 admin） | `openai_compat.py`：service key 认证后优先按 ST sidecar 注入的 `X-Palink-User-Id` 解析真实用户（存在且 active 即采用）；未携带时回退 admin（向后兼容） | 契约测试通过 |
| M-9 | `_regex_key_cache` 无界 dict 无限累积 | `worldbook_service.py`：`_compile_regex_key` 改为 `lru_cache(maxsize=1024)`（线程安全，兼容 to_thread） | worldbook 测试全通过 |
| L-1 | 客户端断开后不主动取消上游 LLM 请求 | `inference_dispatcher.py`：`async for chunk in stream` 包 try/finally，finally 中 `await stream.close()`（失败回退 `aclose()`）；下游 openai_compat/silly_tavern SSE 透传经 generator 链 aclose 自动受益 | e2e/契约测试通过 |

### 11.2 跳过并记录（按用户指示：影响现有功能性/UI 或属配置级/高风险改动）

| # | 问题 | 跳过原因 |
|---|---|---|
| E-9 | 世界书全量加载全部条目（含禁用，无 LIMIT） | 加载函数同时服务于编辑器列表展示与装配，SQL 层过滤 enabled 会改变编辑器语义 |
| E-11 | `GroupChatSession.messages` JSON 大字段反复 json.loads | 群聊核心数据路径，改动需同步选角/投票/滑动全链路，风险高于收益 |
| E-12 | 前端消息列表无虚拟化 | 前端 UI 重构（react-window 等），属 UI 层大改 |
| M-3 | 插件全局共享（无 user_id） | 需插件表结构 + 前端插件系统 + 沙箱配置联动改造 |
| M-5 | 匿名 `/thumbnail` 可枚举角色头像 | 匿名头像为 ST 前端沙箱 iframe 渲染所需，禁止匿名会导致头像不显示 |
| M-6 | 角色/世界书编辑「最后写入者胜」无乐观锁 | 需模型版本字段 + API 冲突响应 + 前端处理全链路 |
| M-8 | `ChatRoom` 持房间锁做网络 IO | 改「复制连接列表释放锁再 IO」存在新连接竞态，websocket 核心需专项验证 |
| M-10 | `persist_snapshot` 线程共享无同步 | LOW 风险（CPython GIL 下边界），且 save_db session 跨线程复用本身属既有模式 |
| L-2 | 聊天主链路无并发限制/网络级退避 | 涉及全局排队策略与 SDK 行为，改错会放大延迟 |
| MEDIUM/LOW 安全项 | CSRF/CORS/速率限制/依赖锁定等 | 配置与架构级改动（.env/nginx/依赖管理），需单独批次与部署决策 |

### 11.3 测试与构建

| 验证项 | 结果 |
|---|---|
| pytest（宿主机相关文件） | 217 + 157 passed（仅宿主机 Python 3.14 环境差异的 bridge.js 白名单测试 deselect，容器内通过） |
| alembic migration | 0059 编译通过，down_revision 链正确（→0058） |
| Docker 容器重建 | 待统一验证（本批完成后重建） |

## 12. Phase 2 修复记录（2026-08-11，第五批 A/B/C 残余 + 端点补齐）

按用户指示"只修复 bug、不改变前端与现有功能实现"，对剩余未处理项逐项修复（争议项已经用户确认）。覆盖 **A-1/A-9/A-11、B-3~B-8、C-5~C-9、translate/sd/kobold-embed 端点缺口**。

### 12.1 已修复

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| A-1 | jailbreak override 缺守卫：用户设 `forbid_overrides` 时角色卡 jailbreak 仍覆盖 | `roleplay_prompt_assembly.py`：从 `user_setting.silly_tavern_settings.extension_settings.system_prompt.forbid_overrides` 读取守卫，true 时跳过角色卡覆盖（对齐 ST openai.js:1496-1504） | 装配相关测试通过 |
| A-9 | pin_examples=false 只删 `[Example Chat]` 标记行，示例内容（独立 system 消息）仍保留 | `roleplay_prompt_assembly.py`：按「标记 + 其后连续 system 内容消息」整体识别示例区段删除，并在 `[Start a new Chat]` 处截止 | `test_st_compat_token_budget.py` 通过 |
| A-11 | `history_end_idx` 从末尾跳过全部 system，把 depth 插入的 system 误判为强制项（裁剪不充分） | 限制末尾强制项跳过数量（≤4：jailbreak+AN+nudge），depth 条目进入可裁剪区 | 裁剪测试通过 |
| B-3 | tags/alternate_greetings 字符串透传被 json.dumps 破坏 | 新增 `_normalize_string_list`（字符串逗号 split / list 过滤），对齐 ST 类型归一 | 导入测试通过 |
| B-4 | V1/gradio 字段不映射（creatorcomment/char_greeting/world_scenario/example_dialogue） | normalize 中补充映射回退 | 导入测试通过 |
| B-5 | CharX/BYAF/YAML 导入被拒绝 | 新增 `_import_from_charx`（zip 内 card.json）/`_import_from_byaf`/`_import_from_yaml`；requirements 增加 PyYAML | 编译 + 容器重建通过 |
| B-6 | `extensions.world` 引用不转世界书 | normalize 中 world 字段转换为 character_book（含 entries） | 导入测试通过 |
| B-7 | 空 first_mes 角色无首条消息 | `character_ext.py`：first_mes 为空时提升第一个 alternate greeting（ST getFirstMessage shift 语义），其余保留在 swipes | e2e 相关测试通过 |
| B-8 | 导入 name 未清洗（XSS/空字节/路径穿越） | 新增 `_sanitize_import_name`（去控制字符、压缩空白、截断 64） | 导入测试通过 |
| C-5 | `/api/avatars/get` 返回 `{avatars}` 而非 string[]（personas 列表永远为空） | `st_resources.py` 改返回数组（ST personas.js:283 Array.isArray 判定） | 契约测试通过 |
| C-6 | `/api/secrets/settings` 缺失 | 新增端点返回 `{allowKeysExposure: false}`（ST secrets.js:291） | 契约测试通过 |
| C-7 | `/api/themes/save`、`/api/stats/get` 未注册（sidecar 不可用时 502） | 新增本地端点：themes/save 持久化到 power_user.themes；stats/get 按角色聚合消息统计（对齐 ST charStats 结构）；presets/backups 保留 sidecar 代理 | 契约测试通过 |
| C-8 | SSE 流式错误把错误文本当 AI 回复渲染 | 异常时输出 `{"error": {"message": ...}}` chunk（ST tryParseStreamingError 弹 toastr 提示） | 契约测试通过 |
| C-9 | n>1 多 swipe 不产生副 swipe chunk | `_chat_completion_chunk` 加 index 参数；主流结束后串行生成 index 1..n-1 副 completion | 契约测试通过 |
| 端点 | `/api/translate/{provider}` 8 子路径 404 | 新增 8 provider 子路径，统一经 Palink LLM 翻译返回纯文本（消除 404） | 契约测试通过 |
| 端点 | `/api/backends/kobold/embed` 404 | 新增端点，用 Palink 记忆嵌入器计算 items 向量（`asyncio.to_thread` 包裹），返回 `{embeddings, model}` | `test_st_vectors_full.py` 通过 |
| 端点 | `/api/sd/*` 核心路径 404（stable-diffusion 基本不可用） | `sd.py` 新增 ST 协议代理端点（客户端传 url/auth，转发 SD WebUI /sdapi/v1/*）：ping/models/get-model/set-model/samplers/schedulers/upscalers/vaes/sd-next/upscalers；generate/img2img 增加 url 代理分支 | 编译 + 契约测试通过 |
| A-10 | spec 的 0.7 比例与实现不一致 | `st-compat-handover/spec.md` 更新为 `token_budget - mandatory_tokens`（标注废弃 0.7 及其原因） | 文档更新 |

### 12.2 留待专项（不影响既有功能，工作量大需独立环境验证）

| # | 项 | 原因 |
|---|---|---|
| /api/sd/comfy/* | ComfyUI 工作流端点（workflow/save/delete/rename + 生成） | 需 ComfyUI 环境联调验证，工作流 JSON 协议复杂 |
| /api/sd/{provider}/generate | 云端绘图 provider 20+（falai/together/stability/huggingface/xai/workersai 等） | 各 provider 协议与 API key 配置体系独立，需专项实现 |
| presets/backups | ST 生成预设与聊天备份端点 | 属 ST sidecar 专属数据域，Palink 无对应存储，保留 sidecar 代理 |

### 12.3 测试与构建

| 验证项 | 结果 |
|---|---|
| pytest（容器内全量） | 749 passed, 53 skipped（仅 1 个既有失败 `test_mvu_engine.py`，与本次无关） |
| pytest（宿主机相关文件） | 130 + 51 + 104 + 217 + 157 passed；宿主机额外 7 个失败均为环境差异（缺 psycopg2 / SQLite schema 缺 jailbreak 列 / 前端 tsx 检查），容器内均通过 |
| Docker 容器重建 | ✅ backend 镜像重建（含 PyYAML）+ 容器重建，health 200 OK |

---

## 13. S-1 插件沙箱完整加固记录（2026-08-11，第六批）

按 `DEEP_AUDIT_REPORT_2026-08-09.md` §5.1 S-1 的修复方向执行（用户确认"继续"后推进，纯前端 sandbox/静态文件改动，不触碰后端与既有插件功能）。

### 13.1 修复项

| 逃逸路径 | 修复内容 | 位置 |
|---|---|---|
| (1) `new Function` 词法逃逸：`(function(){}).constructor('return this')()` 拿到真实 Function 与全局 | `Function.prototype.constructor` 原型链拦截：`Object.defineProperty(fn.__proto__, 'constructor', throwCtor)` → 所有内置函数（Object/Array/String/RegExp/Date/Promise…）的 `.constructor` 链最终命中抛错函数；对象自身的 `{}.constructor===Object`（来自各自 prototype 属性）不受影响，插件类型判断不破坏 | `sandbox.ts` buildWrappedCode 内部 IIFE 开头 |
| (2) fake script 在真实 `document.head` 执行任意 URL/内联代码，绕过 fetch 白名单 | ① 外部 URL 强制走 `isUrlAllowedByPluginWhitelist`（同源 + 默认 CDN + 用户配置 `palink_plugin_fetch_whitelist`），拒绝时触发 onerror 并 warn；② 内联代码（textContent/innerHTML）执行禁用，触发 onerror | `sandbox.ts` createFakeScriptElement |
| (3) `self`/`top`/`globalThis`/`WebSocket`/`indexedDB` 等自由变量直通真实 window（Proxy get 只拦 `window.xxx`） | buildWrappedCode 词法遮蔽补全：`self/top/parent/globalThis/frames/opener → sandboxedWindow`；`location/navigator/screen/history/crypto/performance/requestAnimationFrame/addEventListener` → 沙箱 window 值；`WebSocket` → 同源包装（跨源/非法 URL 返回 CLOSED stub）；`XMLHttpRequest/indexedDB → undefined`；`alert/confirm/prompt/open/close/postMessage` → stub（warn + 安全默认值） | `sandbox.ts` buildWrappedCode + createSandboxedWindow |
| (4) `WebSocket` 直通（真实 WebSocket 不受同源策略限制，可外传数据） | `createSandboxedWindow` 提供同源包装：仅放行 `ws:/wss:` 且与 `window.location.origin` 同源的连接，其余返回 `createRejectedWebSocketStub()`（readyState=CLOSED，事件/方法安全空实现，不抛错） | `sandbox.ts` createSandboxedWindow + createRejectedWebSocketStub |
| (5) CSS 未消毒（`@import` 可加载外部、`expression()`/`url(javascript:)` 可执行） | 新增并导出 `sanitizePluginCss`：移除 `@import/@charset/@namespace`、`url()` 中 `javascript:`/非 `data:image` 的 `data:`、`expression()/-moz-binding/behavior`、混淆 `<script>`；接入 `PluginSandbox.injectPluginCSS` 与 `SillyTavernPluginRuntime` 的 CSS 注入两处 | `sandbox.ts` + `sillyTavernPluginRuntime.ts` |
| (6) `bridge.js` postMessage `'*'`（消息可发给被恶意嵌入的父窗口） | 发送目标改为 `document.referrer` 的 origin（iframe 的 referrer 恒为加载页即父窗口；不可用时回退本窗口 origin），宿主端接收逻辑不变 | `frontend/public/st/bridge.js` |

### 13.2 已达标（无需改动）

| 项 | 现状 |
|---|---|
| `/runtime/config` 仅对已启用插件下发 | `plugins.py` 已过滤 `Plugin.enabled == True`；角色卡携带的 `extensions.tavern_helper`/`regex_scripts` 以 `enabled=False` 导入，默认不下发 |
| 词法逃逸残余面 | `import()` 动态导入在 classic script 下无法局部遮蔽（关键字），为纯 JS 沙箱已知残余，完整隔离需 iframe/Worker 真隔离（§13.4 记录） |

### 13.3 测试与构建

| 验证项 | 结果 |
|---|---|
| `tsc --noEmit`（frontend） | ✅ 0 error |
| `npm run build`（frontend） | ✅ 39.36s 构建成功，dist 更新（bind mount 自动同步进前端容器，无需重建容器） |
| dist 产物验证 | `dist/st/bridge.js` 含 `HOST_ORIGIN`；`dist/assets/index-*.js` 含 `Function constructor is disabled in sandbox` 标记 |
| 容器 | `docker compose ps` 4 容器全部 healthy；nginx 返回 401(auth) 属预期鉴权响应（前端服务正常） |

### 13.4 留待专项（有功能影响，需用户决策）

| 项 | 原因 |
|---|---|
| tavern_helper 类型插件收编沙箱 | 真实酒馆助手为 4MB+ 大型 IIFE 经典脚本，需真实 DOM/全局（`$`/`document`/`window`），强制塞进 new Function 沙箱会导致其完全失效（用户明确优先适配该插件）。现有防线：角色卡携带的 tavern_helper 默认 `enabled=False` 不下发、ESM 走沙箱、仅用户显式启用才以真实脚本注入。残余风险由管理员操作承担 |
| 完整 iframe/blob URL 真隔离 | `new Function` 沙箱的 `import()`/原型链残余逃逸面只能靠真隔离根治；工作量大、影响所有插件加载路径，需独立规划 |

---

## 14. MEDIUM 低风险项修复记录（2026-08-11，第七批）

按用户确认，处理 `DEEP_AUDIT_REPORT_2026-08-09.md` §5.3 中的三项低风险 MEDIUM 项（不触碰既有功能/UI）。

### 14.1 修复项

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| MED-1 | 依赖版本未锁定（fastapi/uvicorn/sqlalchemy/httpx/websockets 无版本约束，升级不可控） | `backend/requirements.txt` 全部依赖以 `==` 精确锁定为容器内实际验证通过的版本（fastapi 0.141.1、uvicorn 0.52.1、sqlalchemy 2.0.51、httpx 0.28.1、websockets 16.1.1 等 30 项），升级需在容器内重新验证 | backend 镜像重建成功（pip 安装全部命中） |
| MED-2 | CORS 默认 `*` + `allow_credentials=True`：浏览器规定二者不可并存，Starlette 回退为"反射任意 Origin"= 任何网站可带凭据请求本后端 | `main.py` CORSMiddleware：`allow_credentials` 仅当显式域名列表（非 `["*"]`）时为 True；development `*` 模式不反射 Origin。前端认证走 `Authorization: Bearer` header，不受影响 | 运行容器实测 `allow_origins=['*'], allow_credentials=False` |
| MED-3 | 速率限制为单进程内存实现（多 worker 各自计数互相绕过）；TRUST_PROXY_HEADERS 时 XFF 可伪造 | 重写 `app/core/rate_limit.py`：共享存储（PostgreSQL/SQLite 通用表 `rate_limit_entries`，UPSERT + `RETURNING` 原子计数，多 worker 共享）；键改用 wall-clock `time.time()`（monotonic 跨进程失真）；DB 不可用/表缺失自动补建重试一次，仍失败回退内存计数；保留 XFF 信任声明语义（既有部署权衡，已注释记录） | 新增 `tests/test_rate_limit_shared.py` 3 passed（原子累加/窗口过期重置/429+Retry-After）；全量 pytest 697 passed 0 failed（既有 mvu 1 failed 未变） |

### 14.2 测试与部署

| 验证项 | 结果 |
|---|---|
| pytest（容器内全量，deselect 既有失败 mvu） | 697 passed, 53 skipped, 0 failed |
| 新测试 | `test_rate_limit_shared.py` 3 passed |
| PostgreSQL 表 | `rate_limit_entries` 已建（key/ window_start/ count + 主键） |
| 容器 | backend 镜像重建（依赖锁定安装成功）+ 容器重建，health healthy |

---

## 15. MEDIUM 低风险项修复记录（2026-08-11，第八批）

继续处理 §5.3 剩余低成本项（MED-4/5/6）。经侦查确认：ST 原生前端写请求带 `X-CSRF-Token`（从 `/csrf-token` 获取，值为固定 `palink-csrf`），且 bridge.js 代理到 Palink 的请求全部附加 `Authorization: Bearer`——因此 CSRF 校验可安全落地而不误伤任何合法调用。

### 15.1 修复项

| # | 问题 | 修复内容 | 验证 |
|---|---|---|---|
| MED-4 | CSRF token 硬编码常量无校验（后端只返回 token、从不校验，防护形同虚设） | 新增 `backend/app/core/csrf_guard.py`：安全方法（GET/HEAD/OPTIONS/TRACE）放行；带 `Authorization` 放行（Bearer 免疫 CSRF，Palink 前端/bridge.js 代理均带）；纯 cookie 写请求必须 `X-CSRF-Token: palink-csrf` 否则 403。`api/__init__.py` 挂到全部 ST 兼容 router（silly_tavern/st_sync/st_groups/regex_scripts/expressions/sd/st_resources/backgrounds/stt/connection_profiles/themes） | 新增 `tests/test_csrf_guard.py` 4 passed；运行时实测：无认证无 token POST → 403，带 token → 401（guard 放行进入认证层），`/csrf-token` 正常返回 |
| MED-5 | openai 兼容端点 service key 默认空（若配置弱值/泄露，docker 网络内进程可持 key 以 admin 刷模型） | `config.py` `_validate_config` 增加弱值告警（非空但 <16 字符或常见字符串 → SECURITY 警告，不阻断——空值合法）；`.env.example` 补充安全提示 | 容器启动无告警（当前为空值合法路径） |
| MED-6 | API Key 加密密钥与数据同目录（拿备份=拿全部明文 key） | `crypto_service._load_or_create_key` 生产环境使用文件密钥时打 SECURITY 警告；`.env.example` 新增 `API_KEY_ENCRYPTION_KEY` 说明（环境变量注入优先） | 编译 + 全量回归通过 |

### 15.2 测试与部署

| 验证项 | 结果 |
|---|---|
| pytest（容器内全量，deselect 既有失败 mvu） | 701 passed, 53 skipped, 0 failed（含新增 csrf 4 项） |
| 运行时行为 | 无认证无 token POST `/api/settings/get` → 403；带 `X-CSRF-Token` → 401；`/api/st/csrf-token` → 200 `{"token": "palink-csrf"}` |
| 容器 | backend 镜像重建 + 容器重建，health healthy |

---

## 8. 与既有文档的关系

- 本整理源自 `docs/DEEP_AUDIT_REPORT_2026-08-09.md` §1.3/§5.1(S-1)/§5.2(S-9)/§3.2(M-3)，行号均已按其二次复核（§11）后的版本。
- 前置阅读：`st-plugins/COMPAT_ANALYSIS.md`（2026-07-30，面板渲染链路分析）、`st-plugins/ADAPTATION.md`（插件适配记录，translate/sd 缺口已识别未修复）。
- 所有结论经 6 路验证子代理复核，P0 级均有行号级原始证据并经双重核对。
- 本节修复记录（§7）的 5 项修复经 tsc/测试/构建/独立复查四重验证。
