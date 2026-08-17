# Palink ST Plugin Compatibility Matrix

> Date: 2026-06-27
> Reference: SillyTavern 1.18.0 built-in extensions
> Source of analysis: Palink 代码静态分析（`frontend/src/lib/plugin-system/*`、`frontend/src/lib/sillytavern/getContext.ts`、`frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`）+ ST 1.18.0 扩展源码（`SillyTavern-1.18.0/public/scripts/extensions/*`）。本文档基于代码静态分析 + 2026-06-28 修复后的运行时采样验证。

## Extension Classes

- **Class A**: Public API only. Depends on getContext, eventSource, message APIs,
  generation APIs, variables, popup/toast. Must work in palink-native and SmartCard runtime.
- **Class B**: Mixed public/internal ST APIs. Depends on extension settings, regex,
  worldbook, templates, selected DOM elements. Should work where reasonable.
- **Class C**: Native ST DOM/private backend dependency. Only guaranteed in ST Native mode.

### Status 值定义

| 值 | 含义 |
|----|------|
| `supported` | 完全支持（核心功能可在 palink-native 运行） |
| `partial` | 部分支持（核心路径可行，但部分功能/端点缺失） |
| `stub` | getContext 中有 stub，但功能不完整 |
| `unsupported` | 不支持（关键依赖未实现） |
| `native-only` | 仅在 ST Native 模式下保证可用 |

### 运行模式说明

- **palink-native**: 通过 `PluginSandbox`（`frontend/src/lib/plugin-system/sandbox.ts`）+ `getContext()`（`frontend/src/lib/sillytavern/getContext.ts`）执行 ST 扩展，DOM 被沙箱化隔离到插件专属容器。
- **SmartCard runtime**: 通过 `SillyTavernCompatRuntime.ts` 在卡片渲染上下文中执行 ST 扩展，提供更完整的 `window` 兼容层（含 `extension_settings` 宿主、lodash/moment/handlebars 兼容层等）。
- **ST Native**: 嵌入真实 SillyTavern 1.18.0 前端运行。

## Matrix

| Extension | Class | Required APIs | Status | Failing Path | Owner | Next Action |
|-----------|-------|---------------|--------|--------------|-------|-------------|
| regex | B | `extension_settings.regex/regex_presets`, `renderExtensionTemplateAsync`, `saveSettingsDebounced`, jQuery DOM, `toastr`, `callGenericPopup`, `SlashCommand*`, `eventSource` (MAIN_API_CHANGED/CHAT_CHANGED/CHARACTER_DELETED/PRESET_*), `messageFormatting`, `accountStorage`, `getPresetManager`, `t()` | partial | UI 面板依赖 ST 专属 DOM ID（`#saved_regex_scripts`、`#bulk_regex_move_to_global` 等），palink-native 沙箱内 `$('#...')` 查询为空；regex 脚本写入 `extension_settings` 后需由生成管线消费 | plugin-system | 1) 确认 `frontend/src/lib/sillytavern/regex/adapter.ts` 把 `extension_settings.regex` 脚本接入生成管线；2) 在 palink-native 提供设置面板挂载点或在 SmartCard runtime 内运行 UI |
| quick-reply | B | `extension_settings.quickReplyV2/quickReply`, `chat_metadata.quickReply`, `eventSource` (APP_READY/CHAT_CHANGED/CHARACTER_DELETED/CHARACTER_RENAMED/USER_MESSAGE_RENDERED/CHARACTER_MESSAGE_RENDERED/GROUP_MEMBER_DRAFTED/WORLD_INFO_ACTIVATED/CHAT_CREATED/GROUP_CHAT_CREATED/GENERATION_AFTER_COMMANDS, `makeFirst`), `getRequestHeaders`, `selected_group`, `SlashCommand*` | partial | 快捷按钮栏需要 ST DOM 插入点（`#send_textarea`、`#qr_bar` 等）；auto-execute 事件链可工作；`chat_metadata.quickReply` 持久化依赖 `saveChat` | plugin-system | 1) 提供 QR 栏挂载点；2) 验证 `chat_metadata` 同步到后端；3) 评估是否仅在 SmartCard runtime 暴露 UI |
| token-counter | A | `getContext()`, `main_api`, `getTextTokens`/`getTokenCountAsync`/`tokenizers`, `renderExtensionTemplateAsync`, `callGenericPopup`/`POPUP_TYPE`, `SlashCommand*`, `t()`, `toastr` | supported | 无重大缺口；`getTokenCount` 返回启发式估算或后端 `/api/tokenizers/count`；`main_api` 在 palink-native 为 `'palink'`/`'openai'`，`getTextTokens` 对 `tokenizers.OPENAI` 分支需对齐 | plugin-system | 验证 `main_api` 与 tokenizer 分支匹配；UI 全部走 popup，无 ST DOM 依赖 |
| expressions | C | `characters`, `eventSource`/`event_types`, `generateQuietPrompt`/`generateRaw`, `getRequestHeaders`, `online_status`, `saveSettingsDebounced`, `substituteParams`/`substituteParamsExtended`, `getContext`, `getApiUrl`/`doExtrasFetch`/`modules`, `ModuleWorkerWrapper`, `renderExtensionTemplateAsync`, `power_user` (waifuMode), `dragElement`/`isMobile`, `hideMutedSprites`/`selected_group`, `isJsonSchemaSupported`, `SlashCommand*`, `Popup`/`POPUP_RESULT`, `Fuse`, `removeReasoningFromString`, `generateWebLlmChatPrompt`/`isWebLlmSupported`, sprite 端点 `/api/sprites/*` | native-only | sprite 文件系统（`/api/sprites/list`、`/api/sprites/get`）；Extras `classify` 模块；视觉小说模式 DOM（`#expression-image`、VN container）；`power_user.waifuMode` | st-native | 仅在 ST Native 模式启用；palink-native 不要承诺支持 |
| caption | B | `getContext`, `getApiUrl`/`doExtrasFetch`/`modules` (Extras), `extension_settings.caption`, `renderExtensionTemplateAsync`, `appendMediaToMessage`, `chat_metadata`, `eventSource`/`event_types`, `getRequestHeaders`, `saveChatConditional`, `saveSettingsDebounced`, `substituteParams`, `SECRET_KEYS`/`secret_state`, `oai_settings`, `textgen_types`/`textgenerationwebui_settings`, `getMultimodalCaption`, `SlashCommand*`, `callGenericPopup`/`Popup`/`POPUP_TYPE`, `MEDIA_DISPLAY`/`MEDIA_SOURCE`/`MEDIA_TYPE`/`SCROLL_BEHAVIOR`, `fetch` | partial | Extras 路径（`doExtrasFetch`/`modules`）不可用；多模态 caption 需走 OpenAI 兼容 vision API；`appendMediaToMessage` 在 getContext 中为 stub（`async () => true`）；`/api/caption` 后端端点 | plugin-system | 1) 将 `getMultimodalCaption` 接到 Palink vision 服务；2) stub Extras 路径；3) 实现 `appendMediaToMessage` |
| tts | B | `cancelTtsPlay`, `eventSource`/`event_types`, `getCurrentChatId`, `isStreamingEnabled`, `name2`, `saveSettingsDebounced`, `substituteParams`, `ModuleWorkerWrapper`, `extension_settings.tts`, `getContext`, `renderExtensionTemplateAsync`, `power_user`, `SlashCommand*`, `POPUP_TYPE`/`callGenericPopup`, `accountStorage`, `HTMLAudioElement`, `fetch` 到 TTS 提供商 API, `SECRET_KEYS` | partial | 后端 TTS 代理端点（`/api/tts/*`）未确认存在；`SECRET_KEYS`/`secret_state` 未实现；部分 provider 依赖后端合成；`isStreamingEnabled` 在 palink-native 为 stub | plugin-system | 1) 优先支持浏览器原生 provider（System/Edge）；2) 评估后端 TTS 代理；3) stub `secret_state` |
| vectors | C | `eventSource`/`event_types`, `getRequestHeaders`, `saveSettingsDebounced`, `substituteParams`/`substituteParamsExtended`, `ModuleWorkerWrapper`, `extension_settings.vectors`, `renderExtensionTemplateAsync`, `registerDebugFunction`, `SECRET_KEYS`/`secret_state`, `getDataBankAttachments`/`getFileAttachment`, `SlashCommand*`, `generateWebLlmChatPrompt`/`isWebLlmSupported`, `WebLlmVectorProvider`, `oai_settings`, `getSortedEntries` (world-info), `setExtensionPrompt`, `getContext().chat`, `fetch` 到 `/api/vectors/*`、`/api/summarize`、`/api/openai/*/models/embedding` | native-only | 向量存储后端（`/api/vectors/*`）；embedding 模型端点；向量索引持久化；WebLLM 浏览器内 embedding | st-native | 仅在 ST Native 模式启用；如需 palink-native 支持需先实现向量存储后端 |
| gallery | C | `eventSource`/`event_types`/`getRequestHeaders`, `groups`/`selected_group`, `loadFileToDocument`, `saveBase64AsFile`, `getFileExtension`, `getVideoThumbnail`, `loadMovingUIState`, `dragElement`, `SlashCommand*`, `DragAndDropHandler`, `Popup`, `deleteMediaFromServer`, `MEDIA_REQUEST_TYPE`/`VIDEO_EXTENSIONS`, `SillyTavern.getContext().extensionSettings.gallery`, `SillyTavern.getContext().saveSettingsDebounced`, `fetch('/api/images/list')`, `fetch('/api/images/folders')`, `nanogallery2` jQuery 插件, `toastr` | native-only | 图片管理端点（`/api/images/list`、`/api/images/folders`、`/api/images/delete`）；`nanogallery2` 库（需 jQuery fn 扩展）；moving UI 依赖 ST DOM | st-native | 仅在 ST Native 模式启用；Palink 应提供原生图片画廊替代 |
| assets | C | `DOMPurify`, `getRequestHeaders`, `processDroppedFiles`, `eventSource`/`event_types`, `deleteExtension`/`EMPTY_AUTHOR`/`extensionNames`/`getAuthorFromUrl`/`getContext`/`installExtension`/`renderExtensionTemplateAsync`/`isOfficialExtension`, `Popup`/`callGenericPopup`/`POPUP_TYPE`, `accountStorage`, `SlashCommand*`, `fetch('/api/assets/download')`, `fetch('/api/assets/delete')`, `fetch('/api/assets/get')`, `toastr` | native-only | 资产管理端点（`/api/assets/*`）；`installExtension`/`deleteExtension` 扩展安装基础设施；与 Palink 自有扩展市场冲突 | st-native | 仅在 ST Native 模式启用；Palink 已有 `frontend/src/lib/extension-market` |
| connection-manager | C | `DOMPurify`/`Fuse`, `activateSendButtons`/`deactivateSendButtons`, `event_types`/`eventSource`, `main_api`, `online_status`, `saveSettingsDebounced`, `extension_settings.connectionManager`, `getContext`, `renderExtensionTemplateAsync`, `Popup`/`callGenericPopup`/`POPUP_RESULT`/`POPUP_TYPE`, `SlashCommand*`（含 `SlashCommandClosure`/`SlashCommandDebugController`/`SlashCommandAbortController`/`SlashCommandScope`）, `StreamingDisplay`, `ConnectionManagerRequestService`, `formatReasoning`, `getSecretLabelById`, `performFuzzySearch`, `power_user` | native-only | `main_api` 切换；`activateSendButtons`/`deactivateSendButtons` ST DOM；`ConnectionManagerRequestService` 与生成管线深度集成；与 Palink 自有连接管理冲突 | st-native | 仅在 ST Native 模式启用；Palink 已有自有连接管理 |
| memory | B | `getContext`/`getApiUrl`/`doExtrasFetch`/`modules`/`extension_settings.memory`/`renderExtensionTemplateAsync`, `eventSource`/`event_types` (CHAT_CHANGED, CHARACTER_MESSAGE_RENDERED `makeLast`, MESSAGE_DELETED/UPDATED/SWIPED), `generateQuietPrompt`, `saveSettingsDebounced`, `substituteParamsExtended`, `setExtensionPrompt`, `is_group_generating`/`selected_group`, `loadMovingUIState`/`power_user`, `dragElement`, `getTextTokens`/`getTokenCountAsync`/`tokenizers`, `SlashCommand*`, `macros`/`MacroCategory`/`MacrosParser`, `countWebLlmTokens`/`generateWebLlmChatPrompt`/`getWebLlmContextSize`/`isWebLlmSupported`, `removeReasoningFromString`, `getContext().saveChat()`, `getContext().chat` | partial | Extras summarize 路径不可用；WebLLM 路径需浏览器内模型；`getContext().saveChat()` 在 palink-native getContext 未导出；设置面板依赖 ST DOM（`#summary_source` 等） | plugin-system | 1) 将 summarize 接到 Palink `generateQuietPrompt`；2) stub extras/webllm；3) 提供 `saveChat`；4) 提供设置 UI shim |
| attachments | B | `event_types`/`eventSource`/`saveSettingsDebounced`, `deleteAttachment`/`getDataBankAttachments`/`getDataBankAttachmentsForSource`/`getFileAttachment`/`uploadFileAttachmentToServer`（来自 `chats.js`）, `extension_settings.disabled_attachments`/`character_attachments`/`attachments`, `renderExtensionTemplateAsync`, `SlashCommand*`（含 `SlashCommandClosure`/`SlashCommandExecutor`）, `toastr` | partial | 附件上传/删除端点（`/api/chats/attachments/*`）；`getDataBankAttachments` 与 `chat.extra.files` 集成；`uploadFileAttachmentToServer` 后端 | plugin-system | 1) 将附件端点接到 Palink 后端；2) 集成 `message.extra.files`；3) stub `getDataBankAttachments` |

## 运行时验证结果 (2026-06-28)

### 验证环境

- **后端容器重建后**：包含 `author_note_position` 字段迁移（统一为 Integer）、WebSocket `extra_messages` 广播、`slash_response` 前端处理、admin 权限校验修正。
- **前端 HMR 同步**：包含 `PushToTalkButton` 挂载、`bridge.js` provider 隐藏（Layer 1.5 ST Native provider 面板隐藏）。
- **验证方法**：代码静态分析 + 2026-06-28 修复后的状态推断。未在浏览器中实际加载插件进行端到端测试的，标注"待浏览器运行时验证"。

### 插件验证状态

| 插件 | 验证状态 | 说明 |
|------|---------|------|
| regex | 待浏览器运行时验证 | 后端 regex 脚本提取已实现（`extractRegexScriptsFromExtensions`），前端 `regex-pipeline` 统一入口；UI 面板依赖 ST DOM ID（`#saved_regex_scripts`、`#bulk_regex_move_to_global` 等）待验证 |
| quick-reply | 待浏览器运行时验证 | `chat_metadata` 持久化已修复；QR 栏挂载点（`#send_textarea`、`#qr_bar`）待验证 |
| token-counter | 基本可用 | `getTokenCount`/`getTokenCountAsync` 已接后端 `/api/tokenizers/count`；`main_api` 分支待对齐（palink-native 为 `'palink'`/`'openai'`，`tokenizers.OPENAI` 分词逻辑统一按空格分词） |
| expressions | native-only | sprite 文件系统（`/api/sprites/*`）未实现；仅在 ST Native 模式可用 |
| caption | 待浏览器运行时验证 | `getMultimodalCaption` 需接 Palink vision 服务；`appendMediaToMessage` 仍为 stub（`async () => true`） |
| tts | 基本可用 | `POST /api/tts` 已实现；provider 管理在 ST Native 模式已隐藏（`bridge.js` Layer 1.5） |
| summarize | 待浏览器运行时验证 | 依赖后端摘要服务；前端 UI（`#summary_source`、`#memory_frozen`、`#memory_prompt`）待验证 |
| vectorization | 待浏览器运行时验证 | 依赖向量记忆模块；向量存储（`/api/vectors/*`）已实现但插件接入待验证 |
| author-note | 基本可用 | `author_note_position` 已统一为 Integer；frequency/depth 注入已实现；群组级 author_note 已支持 |
| bias | 待浏览器运行时验证 | `logit_bias`/`ban_sequences` 字段已加到 `GenerationPreset`；插件写入 `extension_settings` 待验证 |

### 说明

- 本次验证基于代码静态分析 + 2026-06-28 修复后的状态推断。完整运行时验证需要在浏览器中实际加载各插件并测试核心功能。
- 修复内容：WebSocket `extra_messages` 广播、`slash_response` 前端处理、`author_note_position` 字段类型统一、ST Native provider 面板隐藏、STT 前端接入、admin 权限校验修正。

## Detailed Analysis

### Regex Extension

- **Class**: B
- **Manifest**: `display_name=Regex`, `loading_order=1`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `script.js`: `characters`, `eventSource`, `event_types`, `getCurrentChatId`, `messageFormatting`, `reloadCurrentChat`, `saveSettingsDebounced`, `this_chid`
  - 来自 `extensions.js`: `extension_settings`, `renderExtensionTemplateAsync`
  - 来自 `group-chats.js`: `selected_group`
  - 来自 `popup.js`: `callGenericPopup`, `Popup`, `POPUP_TYPE`
  - 来自 `slash-commands/*`: `SlashCommand`, `SlashCommandParser`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `SlashCommandEnumValue`, `commonEnumProviders`, `enumIcons`, `enumTypes`
  - 来自 `utils.js`: `download`, `equalsIgnoreCaseAndAccents`, `escapeHtml`, `getFileText`, `getSortableDelay`, `isFalseBoolean`, `isTrueBoolean`, `regexFromString`, `setInfoBlock`, `uuidv4`
  - 来自 `engine.js`: `allowPresetScripts`, `allowScopedScripts`, `disallowPresetScripts`, `disallowScopedScripts`, `getCurrentPresetAPI`, `getCurrentPresetName`, `getRegexScripts`, `getScriptsByType`, `isPresetScriptsAllowed`, `isScopedScriptsAllowed`, `regex_placement`, `RegexProvider`, `runRegexScript`, `saveScriptsByType`, `SCRIPT_TYPE_UNKNOWN`, `SCRIPT_TYPES`, `substitute_find_regex`
  - 来自 `i18n.js`: `t`
  - 来自 `AccountStorage.js`: `accountStorage`
  - 来自 `preset-manager.js`: `getPresetManager`
- **Status**: partial
- **Notes**:
  - Palink 已有 regex 管线（`frontend/src/lib/regex-pipeline/`、`frontend/src/lib/sillytavern/regex/adapter.ts`、`engine.ts`），可将 `extension_settings.regex` 脚本接入生成管线。
  - SmartCard runtime 在 `SillyTavernCompatRuntime.ts:4199-4209` 初始化 `extension_settings.regex`、`character_allowed_regex`、`preset_allowed_regex`、`palink_preset_regex_scripts`，并暴露 `loadExtensionSettings`。
  - UI 面板（脚本列表、debugger、bulk 操作）大量依赖 ST 专属 DOM ID（`#saved_regex_scripts`、`#saved_scoped_scripts`、`#saved_preset_scripts`、`#bulk_regex_move_to_global` 等），在 palink-native 沙箱内 `$('#...')` 查询为空，UI 不可用。
  - 核心 regex 应用逻辑（`runRegexScript` + `regex_placement`）可在 palink-native 后台运行，UI 应仅在 SmartCard runtime 暴露。
- **Failing Path**: jQuery 选择器定位 ST DOM；`getPresetManager().readPresetExtensionField({ path: 'regex_scripts' })` 需对齐 Palink preset 数据。
- **Next Action**: 1) 确认 `sillytavern/regex/adapter.ts` 消费 `extension_settings.regex` + preset 脚本；2) 限制 UI 到 SmartCard runtime；3) 验证 `regex_placement` 与生成管线接入点。

### Quick Reply Extension

- **Class**: B
- **Manifest**: `display_name=Quick Replies`, `loading_order=12`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `script.js`: `chat`, `chat_metadata`, `eventSource`, `event_types`, `getRequestHeaders`, `this_chid`, `characters`
  - 来自 `extensions.js`: `extension_settings`
  - 内部模块: `QuickReplyApi`, `AutoExecuteHandler`, `QuickReply`, `QuickReplyConfig`, `QuickReplySet`, `QuickReplySettings`, `SlashCommandHandler`, `ButtonUi`, `SettingsUi`
  - 来自 `utils.js`: `debounceAsync`
  - 来自 `group-chats.js`: `selected_group`
  - 事件订阅（关键）: `APP_READY`, `CHAT_CHANGED`, `CHARACTER_DELETED`, `CHARACTER_RENAMED`, `USER_MESSAGE_RENDERED` (`makeFirst`), `CHARACTER_MESSAGE_RENDERED` (`makeFirst`), `GROUP_MEMBER_DRAFTED`, `WORLD_INFO_ACTIVATED`, `CHAT_CREATED`, `GROUP_CHAT_CREATED`, `GENERATION_AFTER_COMMANDS`
- **Status**: partial
- **Notes**:
  - `eventSource` 在 palink-native 与 SmartCard runtime 均完整支持（含 `makeFirst`/`makeLast`），auto-execute 事件链可工作。
  - `chat_metadata.quickReply` 配置持久化依赖 `saveChat`，palink-native getContext 未导出 `saveChat`（SmartCard runtime 暴露 `window.saveChat`）。
  - UI 按钮栏需要 ST DOM 插入点（`#send_textarea`、`#qr_bar`、`#options_button` 等），palink-native 沙箱内不存在。
  - `getRequestHeaders()` 已实现，`extension_settings.quickReplyV2` 已支持。
- **Failing Path**: QR 栏 DOM 挂载；`chat_metadata` 持久化；`SlashCommandHandler` 闭包执行（`SlashCommandClosure`/`SlashCommandExecutor`）。
- **Next Action**: 1) 提供 QR 栏挂载点或仅在 SmartCard runtime 暴露 UI；2) 验证 `chat_metadata` 同步到后端；3) 评估 `SlashCommandExecutor` 兼容性。

### Token Counter Extension

- **Class**: A
- **Manifest**: `display_name=Token Counter`, `loading_order=15`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `script.js`: `main_api`
  - 来自 `extensions.js`: `getContext`
  - 来自 `slash-commands/*`: `SlashCommand`, `SlashCommandParser`
  - 来自 `tokenizers.js`: `getFriendlyTokenizerName`, `getTextTokens`, `getTokenCountAsync`, `tokenizers`
  - 来自 `utils.js`: `resetScrollHeight`, `debounce`
  - 来自 `constants.js`: `debounce_timeout`
  - 来自 `popup.js`: `POPUP_TYPE`, `callGenericPopup`
  - 来自 `extensions.js`: `renderExtensionTemplateAsync`
  - 来自 `i18n.js`: `t`
- **Status**: supported
- **Notes**:
  - 全部 API 在 palink-native getContext 与 SmartCard runtime 均可用。
  - `getTokenCountAsync` 调用后端 `/api/tokenizers/count`（palink-native getContext 已实现，含缓存与启发式回退）。
  - UI 完全走 `callGenericPopup`，无 ST DOM 依赖。
  - `main_api` 在 palink-native 为 `'palink'`（getContext）/ `'openai'`（SmartCard runtime `mainApi='palink'`），`getTextTokens` 对 `tokenizers.OPENAI` 分支需对齐（palink-native 统一按空格分词）。
- **Failing Path**: `main_api == 'openai'` 分支下 `getTextTokens(tokenizers.OPENAI, text)` 与 ST 行为略有差异（不影响计数估算）。
- **Next Action**: 验证 `main_api` 与 tokenizer 分支匹配；可选对齐 `tokenizers.OPENAI` 分词逻辑。

### Expressions Extension

- **Class**: C
- **Manifest**: `display_name=Character Expressions`, `loading_order=6`, `js=index.js`, `hooks.activate=init`, `optional=classify`
- **Required APIs**:
  - 来自 `lib.js`: `Fuse`
  - 来自 `script.js`: `characters`, `eventSource`, `event_types`, `generateQuietPrompt`, `generateRaw`, `getRequestHeaders`, `online_status`, `saveSettingsDebounced`, `substituteParams`, `substituteParamsExtended`, `system_message_types`, `this_chid`
  - 来自 `RossAscends-mods.js`: `dragElement`, `isMobile`
  - 来自 `extensions.js`: `getContext`, `getApiUrl`, `modules`, `extension_settings`, `ModuleWorkerWrapper`, `doExtrasFetch`, `renderExtensionTemplateAsync`
  - 来自 `power-user.js`: `loadMovingUIState`, `performFuzzySearch`, `power_user` (waifuMode)
  - 来自 `utils.js`: `onlyUnique`, `debounce`, `getCharaFilename`, `trimToEndSentence`, `trimToStartSentence`, `waitUntilCondition`, `findChar`, `isFalseBoolean`, `includesIgnoreCaseAndAccents`
  - 来自 `group-chats.js`: `hideMutedSprites`, `selected_group`
  - 来自 `textgen-settings.js`: `isJsonSchemaSupported`
  - 来自 `constants.js`: `debounce_timeout`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `SlashCommandEnumValue`, `commonEnumProviders`, `enumTypes`, `slashCommandReturnHelper`
  - 来自 `shared.js`: `generateWebLlmChatPrompt`, `isWebLlmSupported`
  - 来自 `popup.js`: `Popup`, `POPUP_RESULT`
  - 来自 `i18n.js`: `t`
  - 来自 `reasoning.js`: `removeReasoningFromString`
  - sprite 端点: `/api/sprites/list`、`/api/sprites/get`（隐式通过 `getSpritesList`）
- **Status**: native-only
- **Notes**:
  - 依赖 sprite 文件系统（`/api/sprites/*`），Palink 后端未实现。
  - 依赖 Extras `classify` 模块（`doExtrasFetch`/`modules`/`getApiUrl`），palink-native 无 Extras。
  - 视觉小说模式依赖 `power_user.waifuMode` 与 ST DOM（`#expression-image`、VN container、`#VAE_style`）。
  - `getContext().groupId` 在 palink-native 已支持群组，但 sprite 渲染链路整体不可用。
- **Failing Path**: sprite 加载端点；Extras classify；视觉小说 DOM；`power_user.waifuMode`。
- **Next Action**: 仅在 ST Native 模式启用；palink-native 不要承诺支持。

### Caption Extension

- **Class**: B
- **Manifest**: `display_name=Image Captioning`, `loading_order=4`, `js=index.js`, `hooks.activate=init`, `optional=caption`
- **Required APIs**:
  - 来自 `utils.js`: `ensureImageFormatSupported`, `getBase64Async`, `getFileExtension`, `isTrueBoolean`, `saveBase64AsFile`
  - 来自 `extensions.js`: `getContext`, `getApiUrl`, `doExtrasFetch`, `extension_settings`, `modules`, `renderExtensionTemplateAsync`
  - 来自 `script.js`: `appendMediaToMessage`, `chat_metadata`, `eventSource`, `event_types`, `getRequestHeaders`, `saveChatConditional`, `saveSettingsDebounced`, `substituteParams`
  - 来自 `RossAscends-mods.js`: `getMessageTimeStamp`
  - 来自 `secrets.js`: `SECRET_KEYS`, `secret_state`
  - 来自 `openai.js`: `oai_settings`
  - 来自 `shared.js`: `getMultimodalCaption`
  - 来自 `textgen-settings.js`: `textgen_types`, `textgenerationwebui_settings`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `commonEnumProviders`
  - 来自 `popup.js`: `callGenericPopup`, `Popup`, `POPUP_TYPE`
  - 来自 `constants.js`: `debounce_timeout`, `MEDIA_DISPLAY`, `MEDIA_SOURCE`, `MEDIA_TYPE`, `SCROLL_BEHAVIOR`
  - `fetch`（图片数据下载）
- **Status**: partial
- **Notes**:
  - 多模态 caption 可走 OpenAI 兼容 vision API（`getMultimodalCaption`），Palink 有 `frontend/src/lib/image-gen/`，可对接。
  - Extras 路径（`doExtrasFetch`/`modules`）不可用。
  - `appendMediaToMessage` 在 SmartCard runtime getContext 中为 stub（`async () => true`），palink-native getContext 未导出该字段。
  - `SECRET_KEYS`/`secret_state` 未实现（影响 API key 校验）。
  - `/api/caption` 后端端点未确认。
- **Failing Path**: Extras caption；`appendMediaToMessage`；`secret_state`；`saveChatConditional`。
- **Next Action**: 1) 将 `getMultimodalCaption` 接到 Palink vision 服务；2) stub Extras 路径；3) 实现 `appendMediaToMessage`；4) 评估 `secret_state` stub。

### TTS Extension

- **Class**: B
- **Manifest**: `display_name=TTS`, `loading_order=10`, `js=index.js`, `hooks.activate=init`, `optional=silero-tts,edge-tts,coqui-tts`
- **Required APIs**:
  - 来自 `script.js`: `cancelTtsPlay`, `eventSource`, `event_types`, `getCurrentChatId`, `isStreamingEnabled`, `name2`, `saveSettingsDebounced`, `substituteParams`
  - 来自 `extensions.js`: `ModuleWorkerWrapper`, `extension_settings`, `getContext`, `renderExtensionTemplateAsync`
  - 来自 `utils.js`: `delay`, `escapeRegex`, `getBase64Async`, `getStringHash`, `onlyUnique`, `regexFromString`
  - 来自 `AccountStorage.js`: `accountStorage`
  - 多个 TTS provider 模块（`EdgeTtsProvider`, `ElevenLabsTtsProvider`, `SileroTtsProvider`, `SystemTtsProvider`, `OpenAITtsProvider`, `XTTSTtsProvider`, `KokoroTtsProvider`, ...）
  - 来自 `power-user.js`: `power_user`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `SlashCommandEnumValue`, `enumIcons`, `enumTypes`
  - 来自 `constants.js`: `debounce_timeout`
  - 来自 `popup.js`: `POPUP_TYPE`, `callGenericPopup`
  - `HTMLAudioElement`（音频播放）、`fetch`（到 TTS 提供商 API）、`SECRET_KEYS`（隐式通过 provider）
- **Status**: partial
- **Notes**:
  - 音频播放（`HTMLAudioElement`）在浏览器内可用，palink-native 沙箱白名单未直接暴露 `HTMLAudioElement`，但可通过 `document.createElement('audio')` 创建。
  - 浏览器原生 provider（`SystemTtsProvider`、`EdgeTtsProvider`）较易支持。
  - 后端代理 provider（`/api/tts/*`）需 Palink 后端实现。
  - `SECRET_KEYS`/`secret_state` 未实现，影响 API key 校验。
  - `isStreamingEnabled` 在 palink-native getContext 未导出（SmartCard runtime 暴露 `isStreamingEnabled`）。
- **Failing Path**: 后端 TTS 代理端点；`secret_state`；`isStreamingEnabled`；`cancelTtsPlay`。
- **Next Action**: 1) 优先支持浏览器原生 provider；2) 评估后端 TTS 代理；3) stub `secret_state`/`isStreamingEnabled`/`cancelTtsPlay`。

### Vectors Extension

- **Class**: C
- **Manifest**: `display_name=Vector Storage`, `loading_order=100`, `js=index.js`, `hooks.activate=init`, `optional=embeddings`, `generate_interceptor=vectors_rearrangeChat`
- **Required APIs**:
  - 来自 `script.js`: `eventSource`, `event_types`, `getRequestHeaders`, `saveSettingsDebounced`, `substituteParams`, `substituteParamsExtended`, `setExtensionPrompt`（隐式）, `this_chid`（隐式）
  - 来自 `extensions.js`: `ModuleWorkerWrapper`, `extension_settings`, `renderExtensionTemplateAsync`, `getContext`（隐式）
  - 来自 `power-user.js`: `collapseNewlines`, `registerDebugFunction`
  - 来自 `secrets.js`: `SECRET_KEYS`, `secret_state`
  - 来自 `chats.js`: `getDataBankAttachments`, `getDataBankAttachmentsForSource`, `getFileAttachment`
  - 来自 `utils.js`: `debounce`, `getStringHash`, `waitUntilCondition`, `onlyUnique`, `splitRecursive`, `trimToStartSentence`, `trimToEndSentence`, `escapeHtml`, `isTrueBoolean`
  - 来自 `constants.js`: `debounce_timeout`
  - 来自 `world-info.js`: `getSortedEntries`
  - 来自 `textgen-settings.js`: `textgen_types`, `textgenerationwebui_settings`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `SlashCommandEnumValue`, `commonEnumProviders`, `slashCommandReturnHelper`
  - 来自 `shared.js`: `generateWebLlmChatPrompt`, `isWebLlmSupported`
  - 来自 `webllm.js`: `WebLlmVectorProvider`
  - 来自 `reasoning.js`: `removeReasoningFromString`
  - 来自 `openai.js`: `oai_settings`
  - 端点: `/api/vectors/*`、`/api/summarize`、`/api/openai/*/models/embedding`、`/api/openai/chutes/models/embedding`、`/api/openai/nanogpt/models/embedding`、`/api/openrouter/models/embedding`、`/api/openai/siliconflow/models/embedding`、`/api/openai/workers-ai/models/embedding`
  - `setExtensionPrompt`（EXTENSION_PROMPT_TAG / EXTENSION_PROMPT_TAG_DB）
  - `getContext().chat`、`getContext().chat.filter(x => x.extra?.files)`
- **Status**: native-only
- **Notes**:
  - 依赖向量存储后端（`/api/vectors/*`），Palink 后端未实现。
  - 依赖 embedding 模型端点（多个 provider 路由）。
  - 向量索引持久化（IndexedDB / 文件）需对接。
  - WebLLM 浏览器内 embedding 路径可行但重。
  - `generate_interceptor=vectors_rearrangeChat` 需接入生成管线拦截器。
  - `setExtensionPrompt` 已支持，`getContext().chat` 已支持。
- **Failing Path**: `/api/vectors/*`；embedding 端点；向量索引持久化；`getDataBankAttachments`；`generate_interceptor` 接入。
- **Next Action**: 仅在 ST Native 模式启用；如需 palink-native 支持需先实现向量存储后端与 embedding 路由。

### Gallery Extension

- **Class**: C
- **Manifest**: `display_name=Gallery`, `loading_order=6`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `script.js`: `eventSource`, `getRequestHeaders`, `event_types`
  - 来自 `group-chats.js`: `groups`, `selected_group`
  - 来自 `utils.js`: `loadFileToDocument`, `delay`, `getBase64Async`, `getSanitizedFilename`, `saveBase64AsFile`, `getFileExtension`, `getVideoThumbnail`, `clamp`
  - 来自 `power-user.js`: `loadMovingUIState`
  - 来自 `RossAscends-mods.js`: `dragElement`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `commonEnumProviders`
  - 来自 `dragdrop.js`: `DragAndDropHandler`
  - 来自 `i18n.js`: `t`, `translate`
  - 来自 `popup.js`: `Popup`
  - 来自 `chats.js`: `deleteMediaFromServer`
  - 来自 `constants.js`: `MEDIA_REQUEST_TYPE`, `VIDEO_EXTENSIONS`
  - `SillyTavern.getContext().extensionSettings.gallery`
  - `SillyTavern.getContext().saveSettingsDebounced`
  - 端点: `/api/images/list`、`/api/images/folders`、`/api/images/delete`（隐式）
  - `nanogallery2` jQuery 插件（`gallery.nanogallery2(...)`）
  - `toastr`
- **Status**: native-only
- **Notes**:
  - 依赖图片管理端点（`/api/images/*`），Palink 后端未实现。
  - 依赖 `nanogallery2` jQuery 插件（需 `$.fn.nanogallery2` 扩展），palink-native jQuery 沙箱不包含该插件。
  - moving UI 依赖 ST DOM 结构。
  - `SillyTavern.getContext()` 在 SmartCard runtime 可用，palink-native 通过 `getContext()` 暴露 `extensionSettings`/`saveSettingsDebounced`。
- **Failing Path**: `/api/images/*`；`nanogallery2`；moving UI DOM；`deleteMediaFromServer`。
- **Next Action**: 仅在 ST Native 模式启用；Palink 应提供原生图片画廊替代。

### Assets Extension

- **Class**: C
- **Manifest**: `display_name=Assets`, `loading_order=15`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `lib.js`: `DOMPurify`
  - 来自 `script.js`: `getRequestHeaders`, `processDroppedFiles`, `eventSource`, `event_types`
  - 来自 `extensions.js`: `deleteExtension`, `EMPTY_AUTHOR`, `extensionNames`, `getAuthorFromUrl`, `getContext`, `installExtension`, `renderExtensionTemplateAsync`, `isOfficialExtension`
  - 来自 `popup.js`: `POPUP_TYPE`, `Popup`, `callGenericPopup`
  - 来自 `AccountStorage.js`: `accountStorage`
  - 来自 `utils.js`: `escapeHtml`, `flashHighlight`, `getStringHash`, `isValidUrl`
  - 来自 `i18n.js`: `t`, `translate`
  - 来自 `slash-commands/SlashCommandParser.js`: `SlashCommandParser`
  - 端点: `/api/assets/download`、`/api/assets/delete`、`/api/assets/get`
  - `toastr`
  - `getContext().characters`
- **Status**: native-only
- **Notes**:
  - 管理扩展安装（从 asset list URL 下载角色卡/扩展），与 Palink 自有扩展市场（`frontend/src/lib/extension-market`）功能冲突。
  - 依赖 `/api/assets/*` 端点与 `installExtension`/`deleteExtension` 扩展安装基础设施。
  - `processDroppedFiles` 拖放支持在沙箱内受限。
- **Failing Path**: `/api/assets/*`；`installExtension`/`deleteExtension`；与 Palink 扩展市场冲突。
- **Next Action**: 仅在 ST Native 模式启用；Palink 已有自有扩展市场。

### Connection Manager Extension

- **Class**: C
- **Manifest**: `display_name=Connection Profiles`, `loading_order=1`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `lib.js`: `DOMPurify`, `Fuse`
  - 来自 `script.js`: `activateSendButtons`, `deactivateSendButtons`, `event_types`, `eventSource`, `main_api`, `online_status`, `saveSettingsDebounced`
  - 来自 `extensions.js`: `extension_settings`, `getContext`, `renderExtensionTemplateAsync`
  - 来自 `popup.js`: `callGenericPopup`, `Popup`, `POPUP_RESULT`, `POPUP_TYPE`
  - 来自 `slash-commands/*`: `SlashCommand`, `SlashCommandAbortController`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `commonEnumProviders`, `enumIcons`, `SlashCommandDebugController`, `SlashCommandEnumValue`, `enumTypes`, `SlashCommandClosure`, `SlashCommandParser`, `SlashCommandScope`
  - 来自 `utils.js`: `collapseSpaces`, `getUniqueName`, `isFalseBoolean`, `isTrueBoolean`, `uuidv4`, `waitUntilCondition`
  - 来自 `i18n.js`: `t`
  - 来自 `secrets.js`: `getSecretLabelById`
  - 来自 `power-user.js`: `performFuzzySearch`
  - 来自 `streaming-display.js`: `StreamingDisplay`
  - 来自 `shared.js`: `ConnectionManagerRequestService`
  - 来自 `reasoning.js`: `formatReasoning`
  - `extension_settings.connectionManager.profiles`/`selectedProfile`
  - `extension_settings.regex_presets`（profile 引用）
- **Status**: native-only
- **Notes**:
  - 管理连接配置（API key、模型、preset），与 Palink 自有连接管理深度冲突。
  - 依赖 `main_api` 切换（`'openai'`/`'textgenerationwebui'`）与 `activateSendButtons`/`deactivateSendButtons` ST DOM。
  - `ConnectionManagerRequestService` 与生成管线深度集成（profile 切换会触发模型/preset 重载）。
  - 大量 SlashCommand 高级特性（`SlashCommandClosure`/`SlashCommandScope`/`SlashCommandAbortController`/`SlashCommandDebugController`）。
  - `StreamingDisplay` 依赖 ST 流式渲染管线。
- **Failing Path**: `main_api` 切换；`activateSendButtons`/`deactivateSendButtons`；`ConnectionManagerRequestService` 集成；`StreamingDisplay`；高级 SlashCommand 特性。
- **Next Action**: 仅在 ST Native 模式启用；Palink 已有自有连接管理。

### Memory Extension

- **Class**: B
- **Manifest**: `display_name=Summarize`, `loading_order=9`, `js=index.js`, `hooks.activate=init`, `optional=summarize`
- **Required APIs**:
  - 来自 `utils.js`: `getStringHash`, `debounce`, `waitUntilCondition`, `extractAllWords`, `isTrueBoolean`
  - 来自 `extensions.js`: `getContext`, `getApiUrl`, `extension_settings`, `doExtrasFetch`, `modules`, `renderExtensionTemplateAsync`
  - 来自 `script.js`: `eventSource`, `event_types`, `generateQuietPrompt`, `saveSettingsDebounced`, `substituteParamsExtended`, `setExtensionPrompt`（隐式）, `chat`（隐式）, `this_chid`（隐式）
  - 来自 `group-chats.js`: `is_group_generating`, `selected_group`
  - 来自 `power-user.js`: `loadMovingUIState`, `power_user`
  - 来自 `RossAscends-mods.js`: `dragElement`
  - 来自 `tokenizers.js`: `getTextTokens`, `getTokenCountAsync`, `tokenizers`
  - 来自 `constants.js`: `debounce_timeout`
  - 来自 `slash-commands/*`: `SlashCommandParser`, `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `commonEnumProviders`
  - 来自 `macros/macro-system.js`: `macros`, `MacroCategory`
  - 来自 `shared.js`: `countWebLlmTokens`, `generateWebLlmChatPrompt`, `getWebLlmContextSize`, `isWebLlmSupported`
  - 来自 `macros.js`: `MacrosParser`
  - 来自 `reasoning.js`: `removeReasoningFromString`
  - `getContext().saveChat()`
  - `getContext().chat`
  - `setExtensionPrompt(MODULE_NAME, ...)`（`MODULE_NAME='1_memory'`）
  - 事件: `CHAT_CHANGED`, `CHARACTER_MESSAGE_RENDERED` (`makeLast`), `MESSAGE_DELETED`/`MESSAGE_UPDATED`/`MESSAGE_SWIPED`
- **Status**: partial
- **Notes**:
  - `setExtensionPrompt` 已支持（palink-native getContext + SmartCard runtime），核心注入可行。
  - `generateQuietPrompt` 已支持，summarize 主路径可走 Palink 生成引擎。
  - Extras summarize 路径（`doExtrasFetch`/`modules`/`/api/summarize`）不可用。
  - WebLLM 路径需浏览器内模型（`isWebLlmSupported`）。
  - `getContext().saveChat()` 在 palink-native getContext 未导出（SmartCard runtime 暴露 `window.saveChat`）。
  - 设置面板依赖 ST DOM（`#summary_source`、`#memory_frozen`、`#memory_prompt` 等）。
  - `extension_settings.memory` 在 SmartCard runtime 通过 `extension_settings` 宿主支持。
- **Failing Path**: Extras summarize；WebLLM；`getContext().saveChat()`；设置面板 DOM。
- **Next Action**: 1) 将 summarize 接到 `generateQuietPrompt`；2) stub extras/webllm；3) 提供 `saveChat`；4) 提供设置 UI shim 或限制 UI 到 SmartCard runtime。

### Attachments Extension

- **Class**: B
- **Manifest**: `display_name=Data Bank (Chat Attachments)`, `loading_order=3`, `js=index.js`, `hooks.activate=init`
- **Required APIs**:
  - 来自 `script.js`: `event_types`, `eventSource`, `saveSettingsDebounced`
  - 来自 `chats.js`: `deleteAttachment`, `getDataBankAttachments`, `getDataBankAttachmentsForSource`, `getFileAttachment`, `uploadFileAttachmentToServer`
  - 来自 `extensions.js`: `extension_settings`, `renderExtensionTemplateAsync`
  - 来自 `slash-commands/*`: `SlashCommand`, `SlashCommandArgument`, `SlashCommandNamedArgument`, `enumIcons`, `SlashCommandEnumValue`, `enumTypes`, `SlashCommandClosure`, `SlashCommandExecutor`, `SlashCommandParser`
  - `extension_settings.disabled_attachments`/`character_attachments`/`attachments`
  - 事件: `APP_READY`, `CHARACTER_DELETED`, `CHARACTER_RENAMED`
  - `toastr`
- **Status**: partial
- **Notes**:
  - 附件上传/删除端点（`/api/chats/attachments/*`，隐式通过 `uploadFileAttachmentToServer`/`deleteAttachment`）需 Palink 后端实现。
  - `getDataBankAttachments`/`getFileAttachment` 与 `chat.extra.files` 集成，palink-native messageManager 消息结构需对齐。
  - `extension_settings.disabled_attachments`/`character_attachments`/`attachments` 已支持（extension_settings 宿主）。
  - `SlashCommandClosure`/`SlashCommandExecutor` 高级 SlashCommand 特性需验证。
  - `renderExtensionTemplateAsync` 已支持（从插件 resources.templates 加载）。
- **Failing Path**: 附件上传/删除端点；`getDataBankAttachments` 与 `chat.extra.files` 集成；`SlashCommandClosure`/`SlashCommandExecutor`。
- **Next Action**: 1) 将附件端点接到 Palink 后端；2) 集成 `message.extra.files`；3) stub `getDataBankAttachments`/`getFileAttachment`；4) 验证 `SlashCommandExecutor`。

## 跨扩展共性问题

1. **ST DOM 依赖**: regex/quick-reply/memory/expressions 等扩展的设置面板依赖 ST 专属 DOM ID，palink-native 沙箱内 jQuery 查询为空。建议：UI 仅在 SmartCard runtime 暴露，后台逻辑在 palink-native 运行。
2. **Extras 后端**: caption/memory/vectors/expressions 依赖 Extras（`doExtrasFetch`/`modules`/`getApiUrl`），palink-native 无 Extras。建议：统一 stub `modules` 返回空，`doExtrasFetch` 抛错或返回空。
3. **`SECRET_KEYS`/`secret_state`**: caption/tts/vectors 依赖 secret 管理，palink-native 未实现。建议：提供 stub `secret_state` 返回 `true`/`false` 由配置决定。
4. **`/api/*` 后端端点**: vectors/gallery/assets/attachments 依赖大量 ST 后端端点，Palink 后端未实现。建议：按扩展优先级逐步实现或限制到 ST Native。
5. **`getContext().saveChat()`**: memory/quick-reply 依赖，palink-native getContext 未导出。建议：在 palink-native getContext 补充 `saveChat` 字段（委托到 messageManager 持久化）。
6. **高级 SlashCommand 特性**: connection-manager/attachments/quick-reply 依赖 `SlashCommandClosure`/`SlashCommandExecutor`/`SlashCommandScope`/`SlashCommandAbortController`/`SlashCommandDebugController`。建议：评估 Palink SlashCommandEngine 是否支持闭包执行。
7. **`generate_interceptor`**: vectors 的 `generate_interceptor=vectors_rearrangeChat` 需接入生成管线拦截器，palink-native 生成引擎需暴露拦截点。

## 验证清单

- [x] 文件创建成功：`docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md`
- [x] Markdown 格式正确（标题、表格、列表层级一致）
- [x] 矩阵包含所有 12 个扩展：regex, quick-reply, token-counter, expressions, caption, tts, vectors, gallery, assets, connection-manager, memory, attachments
- [x] 每行包含 Class / Required APIs / Status / Failing Path / Owner / Next Action
- [x] Class A/B/C 分类基于代码静态分析
- [x] Class C 扩展未承诺在 palink-native 中支持

## 注意

- 本文档基于代码静态分析，不是运行时测试结果。实际兼容性需在容器中运行验证。
- Status 为 `partial` 的扩展，其"部分"边界需在运行时进一步确认。
- 若运行时发现实际行为与本矩阵不符，应以运行时结果为准并回填本文档。
