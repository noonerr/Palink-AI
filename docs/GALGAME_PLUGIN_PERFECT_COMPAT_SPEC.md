# Galgame 界面插件完美兼容 SPEC

- 版本：v1.0
- 日期：2026-08-14
- 目标插件：`galgame-ui-plugin`（第三方 SillyTavern 扩展，IIFE 经典脚本，注入真实 document 运行）
- 宿主：Palink AI（前端注入链路 `sillyTavernPluginRuntime.ts` + 后端 `silly_tavern.py` ST 兼容端点）

---

## 1. 背景与目标

### 1.1 背景

Galgame 界面插件是为 SillyTavern 1.18 编写的完整 Galgame 化扩展（立绘/Live2D、CG、BGM、TTS、分句推进、剧情选项、存档/读档、时间线图谱、COT 增强模式等）。Palink 通过 `sillyTavernPluginRuntime` 将插件脚本注入真实 document 运行，并为插件提供一套 ST 兼容桩。

当前经真实浏览器验证，插件可运行（界面、对话推进、全屏、设置面板、时间线图谱均正常），但以下能力因兼容层缺口而**静默失效**：
1. COT 格式化文本保存到 swipe（`setChatMessages` 缺失）
2. 增强模式二次生成（依赖 `triggerSlash` + `/profile` `/model` `/preset`）
3. COT 格式规范世界书注入（`createOrReplaceWorldbook` 等为 no-op）
4. 时间线/存档回退（`openCharacterChat`、`/branch-create`、`/checkpoint-*`、`/chat-fork`）
5. 世界书状态读写（`getWorldbook*` / `rebindGlobalWorldbooks` 为 no-op）

### 1.2 目标

在 Palink 中实现该插件的**完美兼容**：插件所有功能在 Palink 中与在 ST 中行为等价，且**不破坏 Palink 自身功能**（分支管理、故事线、会话切换、聊天持久化等）。

### 1.3 非目标

- 不复刻 ST 特有且 Palink 无对应概念的功能（如 OpenAI 人格档 profile 若 Palink 无等价物，则映射到 Palink 能力而非照搬）。
- 不兼容依赖其他第三方插件才能用的功能（如 AutoCardUpdater 的"总结表"剧情回顾）——除非另行安装对应插件。
- 不改动插件本体（不 fork 插件代码），全部兼容工作位于 Palink 侧。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| 注入链路 | `sillyTavernPluginRuntime.ts` 的 `injectIntoContainer` → `setupScript` 定义 window 全局桩 → 插件 IIFE 运行 |
| setupScript | runtime 内以模板字符串注入的兼容层脚本（当前约 L177-L389） |
| ST 端点 | 后端 `silly_tavern.py` 提供的 `/api/...` 兼容路由（已挂 CSRF guard） |
| COT | Chain of Thought：插件把 AI 回复格式化（`<styled>`/情绪词/段落结构）后，以 swipe 形式保存第二份 |
| 故事线 | Palink 原生分支管理（`branch-tree` / `branches` API + StorylineMap UI） |

---

## 3. 现状分析

### 3.1 已兼容（真实浏览器验证通过）

| 能力 | 说明 |
|---|---|
| `SillyTavern.getContext` | 返回 13+ 字段；`characters[characterId]` 已挂载当前角色（avatar 规范化为 `palink-{uuid}.png`） |
| `getRequestHeaders` | 带 `Authorization: Bearer` + `X-CSRF-Token`，后端 CSRF 放行 |
| 界面渲染 | 立绘/Live2D、CG、BGM、分句推进、NEXT/PREV/AUTO/SKIP、剧情选项 |
| 对话推进 | 自由输入 → AI 生成 → 分段显示（复用 Palink 聊天链路） |
| 全屏 | `document.fullscreenElement` 激活时 Palink Dock 隐藏（App.tsx 双信号监听） |
| 设置面板 | 全部设置项可读写（localStorage/IndexedDB） |
| 时间线图谱 | 26 节点/27 边渲染正常（GET `/api/characters/chats`、`/api/chats/get`） |
| 生成桥 | `#send_textarea`/`#send_but`/`#option_regenerate` 虚拟元素 + `SillyTavern.Generate` |
| toastr / jQuery / eventSource / eventOn | 已有桩 |

### 3.2 部分兼容（可用但有缺陷）

| 能力 | 缺陷 |
|---|---|
| 时间线回退导航 | 跨会话切换（`openCharacterChat` 缺失）与分支回退（`triggerSlash` 缺失）失败，仅"渲染到当前聊天已存在消息"可用 |
| 存档/读档 | 可读写插件 IndexedDB（localStorage 层），但"读档切换聊天"依赖 `openCharacterChat`，失败 |
| COT swipe | 格式化文本已注入 prompt，但第二份 swipe **写不回去**（`setChatMessages` 缺失） |

### 3.3 不兼容（静默失效，见 §5 gap 清单）

- `setChatMessages`、`triggerSlash`、`createOrReplaceWorldbook`/`createWorldbookEntries`/`updateWorldbookWith`、`openCharacterChat`、`getWorldbook*`/`rebindGlobalWorldbooks`、`getChatMessages`、`getLastMessageId`、`getCurrentChatId`、`substitudeMacros`、CORS 代理组、`Mvu`、`/api/sd/comfy/samplers`、`/user/files/`。

---

## 4. 目标架构

```
┌────────────────────────────┐
│ Galgame 插件 (IIFE)         │  ← 依赖 window.SillyTavern.* / window.* / fetch / slash
└───────────┬────────────────┘
            ▼
┌────────────────────────────┐
│ setupScript 兼容桩 (新增/改造) │
│  - setChatMessages / getChatMessages / triggerSlash
│  - openCharacterChat / 世界书读写组 / CORS 代理组
└───────────┬────────────────┘
            ▼
┌────────────────────────────┐
│ 桥接层 (TS)                 │  ← 新增 compat-bridge 模块
│  - window.__palinkBridge.{sendText,regenerate,switchChat,
│     forkBranch,saveSwipe,upsertWorldbook,runSlash,...}
└───────────┬────────────────┘
            ▼
┌───────────┴───────────────────────────────┐
│ Palink 原生能力                            │
│  SlashCommandEngine / CharacterView 分支API │
│  /api/character-sessions/*/branches        │
│  /api/chats/save|swipe|continue|regenerate │
│  /api/worldbook*                          │
└───────────────────────────────────────────┘
```

**原则**
1. 插件永远只面向 ST 形状的 API（`setChatMessages`、`triggerSlash`、`openCharacterChat`…），不感知 Palink 细节。
2. 桥接逻辑全部收敛到 `sillyTavernPluginRuntime.ts`（setupScript 桩）+ 一个可测试的 TS 桥模块，不散落。
3. 所有写操作必须经过 Palink 后端既有 API（分支/消息/世界书），保证数据模型与 Palink 一致（故事线图谱、分支树因此天然同步）。
4. 桩必须**可降级**：任何桥接失败返回结构化错误（`{ok:false, reason}`），不抛异常中断插件主流程，不影响纯展示功能。

---

## 5. Gap 清单与解决方案

优先级：**P0**（插件主流程命脉，必须）> **P1**（重要功能）> **P2**（增强/降级）> **P3**（体验）。

### P0-1 setChatMessages（COT swipe 写入）— 最致命

**插件用法**：`setChatMessages([...], {refresh:false})` 把格式化后的消息数组写回，保存第二条 swipe（[galgame_script.js:29175](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L29175)）。

**现状**：注入链路未提供 → `ReferenceError` 被插件 IIFE 捕获 → COT 第二份 swipe 丢失（只留原文，重绘/再生成时格式化失效）。

**方案**：
- setupScript 提供 `window.setChatMessages`。
- 签名兼容：`(messages, opts?) => Promise<boolean>`。`messages` 为 ST 消息数组（`{id, mes, is_user, extra.swipes}`）。
- 实现：桥接 `__palinkBridge.saveChatMessages(messages)` → 前端 `api.post('/api/chats/save', ...)`（该端点已存在 [silly_tavern.py:3476](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L3476)）。
- 若消息含 `extra.swipes`（≥2 条），额外调用 `/api/chats/swipe` 写入 swipes 数组。
- `refresh:false` 语义：不触发前端重渲染（Palink 由消息事件驱动刷新）。

**涉及文件**：`sillyTavernPluginRuntime.ts`、新增桥接函数、`backend/app/api/silly_tavern.py`（核对 `/api/chats/save` 对 swipes 的落库，必要时补）。

**验证**：对话→打开角色卡消息→检查 swipe 第二条存在格式化文本；重绘当前段使用格式化版本。

### P0-2 triggerSlash + 分支/存档/二次生成命令 — 最致命

**插件用法**：`triggerSlash(cmd)` 执行 ST slash 命令（[galgame_script.js:41132](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L41132)）；涉及命令：

| 命令 | 插件用途 | Palink 映射 |
|---|---|---|
| `/branch-create {mesId}` | 时间线/分支回退 | `POST /api/character-sessions/{sid}/branches`（forkPoint=mesId） |
| `/checkpoint-create mesId=.. {name}` | 存档点 | 映射为分支创建（name 存入 branch title） |
| `/checkpoint-go {mesId}` | 读档跳转 | `POST .../branches/{bid}/switch?up_to_message_id=` |
| `/chat-fork` | 当前聊天分叉 | 创建同级分支并切换 |
| `/getchatname` | 存档/时间线取聊天名 | 返回当前 session title |
| `/profile` `/profile-list` | 增强模式人格档 | 见 P0-3 增强模式 |
| `/model` | 增强模式模型切换 | 见 P0-3 |
| `/preset` | 增强模式预设切换 | 见 P0-3 |

**现状**：`window.triggerSlash` 缺失 → 所有命令执行失败（存档/时间线/分支回退 toast"不支持回溯分支命令"）。

**方案**：
- setupScript 提供 `window.triggerSlash = (cmd) => __palinkBridge.runSlashCommand(cmd)`。
- 桥接实现分两层：
  1. **已有命令**：走 Palink `SlashCommandEngine.execute()`（`frontend/src/lib/slash-engine`），返回输出文本。
  2. **新增命令**（`/branch-create`、`/checkpoint-create`、`/checkpoint-go`、`/chat-fork`、`/getchatname`、`/profile`、`/model`、`/preset`）：在 `slash-engine` 注册新命令，或由桥接层直接调用分支 API（推荐后者，避免污染通用引擎）。
- 分支命令需要当前 session/消息上下文：桥接层从 `runtime.context`（sessionId）与 `getChatMessages` 结果解析 mesId。

**涉及文件**：`sillyTavernPluginRuntime.ts`、新增 `compat-bridge.ts`（或并入 runtime）、`backend/app/api/character_ext.py`（branch-tree/branches/switch 端点已存在，无需新增）。

**验证**：时间线点击旧节点→提示消失、聊天回退到该节点并显示分叉；故事线图谱出现新分支；存档/读档可跳转会话。

### P0-3 增强模式二次生成（profile/model/preset + 两次生成）

**插件用法**：增强模式开启后，先内容创作生成、再 COT 格式化生成；切换人格/模型/预设用 `triggerSlash('/profile quiet=true X')` 等。

**现状**：`triggerSlash` 缺失 → 增强模式开关失效。

**方案**：
- Palink 模型切换：`/model` 桥接到 `api.post('/api/models/activate')` 或全局模型 state。
- 人格档 profile：Palink 无 persona 运行时切换概念 → 方案 A（推荐）：`/profile` 返回成功且不切换（记录 quiet），二次生成继续用当前上下文；方案 B：映射到 Palink Persona（`/api/personas`）若未来支持运行时切换。
- 预设 preset：映射到 Palink PromptPreset（`/api/presets`）。
- 记录 `quiet=true` 语义：静默执行、返回空串（插件用返回值判断成功与否，见 [galgame_script.js:29286](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L29286)）。

**验证**：开启增强模式→两次生成均产生、无报错；`/model` 不中断流程。

### P0-4 COT 世界书注入（createOrReplaceWorldbook 等）

**插件用法**：`createOrReplaceWorldbook(name, entries)`、`createWorldbookEntries(name, entries)`、`updateWorldbookWith(name, fn)`、`getWorldbook(name)` 维护一张"格式规范"世界书（[galgame_script.js:29883-29913](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L29883)）。

**现状**：`createOrReplaceWorldbook` no-op、`getWorldbook` 返回 null → 世界书注入失败，COT 规范只能靠 prompt 注入（不完整）。

**方案**：
- setupScript 改为真实实现：
  - `getWorldbook(name)` → `api.post('/api/worldinfo/get', {name})`
  - `createOrReplaceWorldbook(name, entries)` → `POST /api/worldinfo/import` 或复用 Palink 世界书 upsert API（核对 `worldbook.py` 现有端点）
  - `createWorldbookEntries(name, entries)` → 追加条目（`/api/worldinfo/import` 合并）
  - `updateWorldbookWith(name, fn)` → 读→`fn`→写
  - `getWorldbookNames` / `getGlobalWorldbookNames` → 真实列表（`/api/worldbooks`）
  - `rebindGlobalWorldbooks(names)` → 更新角色卡绑定（Palink worldbook 关联 API）
- 降级：任何失败返回 `Promise.resolve()`/`null`（与现状一致），不抛异常。

**涉及文件**：`sillyTavernPluginRuntime.ts`；核对后端 `worldbook.py` 是否有按 name upsert 端点，缺失则补 1 个。

**验证**：打开插件后 Palink 世界书列表出现"格式规范"书且条目数正确；AI 回复遵循格式规范。

### P0-5 openCharacterChat（跨会话切换 / 读档 / 时间线跳转）

**插件用法**：`openCharacterChat(chatFile, opts)` 切换聊天（[galgame_script.js:40720-40733](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L40720)）。

**现状**：未提供 → 时间线跳转、读档切会话失败。

**方案**：
- setupScript 提供 `window.openCharacterChat` 与 `SillyTavern.openCharacterChat`。
- 桥接：解析 chatFile（`{sid}.jsonl` / `session_{sid}.jsonl`）→ 路由到 Palink 会话切换（复用 `CharacterView` 的会话切换逻辑，通过 `window.location` 或全局回调）。
- 提供 `SillyTavern.chatMetadata` / `characterId` / `characters` / `name2` 动态属性（sync 自 runtime.context，每次访问时读取，勿静态缓存）。

**验证**：时间线点击其他会话节点→成功切换到该会话；读档→切换会话并跳消息。

### P0-6 getChatMessages / getLastMessageId / getCurrentChatId / substitudeMacros

**插件用法**：读取消息（含 swipes）、末条消息 ID、当前聊天 ID、宏替换 `{{chatId}}`（[galgame_script.js:9397](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L9397) 等）。

**现状**：注入链路未提供（sandbox 有、runtime 无）→ 时间线构建/回退等读取路径失效。

**方案**（与 P0-1/P0-5 同一桥接层）：
- `getChatMessages(id, {includeSwipes:true})` → 从 `runtime.context.chat` 返回 ST 形状消息。
- `getLastMessageId()` → 返回 `runtime.context.chat` 末条 id（或 max）。
- `getCurrentChatId()` → 返回 `runtime.context.chatId`（session UUID）。
- `substitudeMacros(str)` → 仅替换 `{{chatId}}`（`{{char}}` 等若 Palink 有宏引擎则委托，否则原样返回）。

**验证**：时间线/存档的"取当前聊天名/楼层"正常；COT swipe 写入后可读回。

### P1-1 后端 `/api/sd/comfy/samplers`

**插件用法**：ComfyUI 连通性检测 `POST /api/sd/comfy/samplers`（[galgame_script.js:26784](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L26784)）。

**现状**：Palink `sd.py` 仅 `/api/sd/comfy/get-workflow` → 404，检测恒失败（ComfyUI 背景图生成不可用）。

**方案**：在 `backend/app/api/sd.py` 补 `POST /api/sd/comfy/samplers`，返回 samplers 列表（直连 ComfyUI `/object_info` 或返回静态可接受列表）。

**验证**：插件设置页 ComfyUI 连接检测通过。

### P1-2 世界书读取/绑定状态真实化（与 P0-4 合并实现）

已在 P0-4 覆盖，列为独立验收项：打开插件前后 `getWorldbookNames` 返回值反映 Palink 世界书真实列表；`rebindGlobalWorldbooks` 后角色卡绑定更新。

### P2-1 CORS 代理组（getCorsProxyUrl / enableCorsProxy / corsProxy）

**插件用法**：外部图片/音频跨域代理（[galgame_script.js:19489-19505](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L19489)）。

**现状**：未提供，插件有直接 fetch 兜底（部分图片可能加载失败）。

**方案**：
- `getCorsProxyUrl(url)` / `corsProxy.getProxyUrl(url)` → 返回 `url`（直连，等效"不代理"），保持形状兼容。
- `enableCorsProxy(url)` → 返回 `url`。
- 可选：若 Palink 已实现 `/proxy` 端点则优先使用。

**验证**：立绘/CG 远程图片加载正常。

### P2-2 Mvu 桩（MVU 变量事件）

**插件用法**：`Mvu.getMvuData()`、`Mvu.events.VARIABLE_UPDATE_ENDED`、`waitGlobalInitialized("Mvu")`（[galgame_script.js:16194](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L16194)）。

**现状**：缺失 → 特殊 CG 触发器跳过（仅 warn）。

**方案**：提供最小桩：`Mvu.events = { VARIABLE_UPDATE_ENDED: 'variable_update_ended' }`、`Mvu.getMvuData = () => null`、`waitGlobalInitialized = (n) => Promise.resolve()`。关联 `stat_data` 的更新（Palink 已有 MVU 引擎 `backend/services/mvu_engine.py`）可作为后续增强。

**验证**：插件启动无 `Mvu is not defined`；MVU 变量变化不中断流程。

### P2-3 第三方集成桩（AutoCardUpdaterAPI / 小白盒 TTS）

**插件用法**：`AutoCardUpdaterAPI.exportTableAsJson()`（剧情回顾/历史，[galgame_script.js:38488](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L38488)）；`xiaobaixTts`/`LittleWhiteBox`/`XB_TTS_VOICE_DATA`（TTS 音色）。

**现状**：均缺失。

**方案**：
- AutoCardUpdaterAPI：**默认不提供**（该插件未安装，行为与 ST 一致）。文档注明"剧情回顾需安装 AutoCardUpdater"。可选：提供 `exportTableAsJson()` 返回 `{}` 使插件走"无总结表"空态而非报错。
- 小白盒 TTS：可选桩——`xiaobaixTts` 桥接到 Palink `tts` 服务（`frontend/src/lib/tts`），实现 `.speak()/.stop()/.player`。列为后续增强（P2-3b）。

**验证**：剧情回顾显示"暂无历史记录"（与 ST 未装 AutoCardUpdater 行为一致，无报错）。

### P3-1 后端 `/user/files/` 静态端点

**插件用法**：`GET /user/files/LittleWhiteBox_TTS.json`（[galgame_script.js:12581](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L12581)）。

**现状**：404（有 try-catch 兜底）。

**方案**：可选补静态文件路由（`/user/files/{path}` 映射到数据目录）。若无小白盒则返回 404 亦可接受。

### P3-2 SillyTavern.get（CORS 代理 fetch）

**插件用法**：Wallhaven 搜索 fallback（[galgame_script.js:18080](file:///d:/项目/Palink-AI/.dbg/galgame_script.js#L18080)）。

**方案**：提供 `SillyTavern.get = (url, opts) => fetch(url, opts)`（直连）。低优先级。

---

## 6. 实施任务清单（按阶段）

### 阶段 A（P0，核心主流程）✅ 已实施并验证
1. ✅ runtime 桥接层 `__palinkBridge`（saveChatMessages / runSlashCommand / switchChat / 世界书组）
2. ✅ setupScript 新桩：setChatMessages / getChatMessages（数组语义）/ getLastMessageId / getCurrentChatId / substitudeMacros / triggerSlash / openCharacterChat / 世界书读写组
3. ✅ `SillyTavern.chatMetadata/characterId/characters/name2` 动态属性
4. ✅ slash 命令：/branch-create /checkpoint-create /checkpoint-go /chat-fork /getchatname /profile /model /preset
5. ✅ 后端：/api/chats/save 保留插件写入的 swipes（不再强制 swipes[swipe_id]=content）；补 /api/sd/comfy/samplers
6. ✅ CharacterView 监听 palink:switchChat / switchBranch / chatMessagesUpdated

### 阶段 A 验证记录（真实浏览器实测）

| 项 | 结果 |
|---|---|
| getChatMessages 数组语义 + swipes | ✅ 返回 `[msg]`，含 swipes/swipe_id，支持 id=-1 + role 过滤 |
| setChatMessages 部分更新 | ✅ `[{message_id, swipes, swipe_id}]` 按楼层定位、只改 swipes，不清空聊天 |
| COT swipe 持久化 | ✅ 格式化文本写入 swipe 并落库，刷新后仍存在 |
| /branch-create / /chat-fork | ✅ 分支真实创建（branch-tree 可见），测试后已清理 |
| /getchatname | ✅ 返回 `palink-session-{sid}.jsonl` |
| openCharacterChat | ✅ 跨会话切换成功，context 同步更新 |
| 世界书创建/追加/更新/读取 | ✅ 后端落库 + name 字段经 extensions.gal_plugin_name round-trip |
| 全屏 Dock 隐藏 / 时间线图谱 | ✅ 回归通过（27 节点/28 边） |

### 已知限制（P0 后）
- 增强模式 `/profile` 采用"静默成功、不切换"策略（Palink 无 persona 运行时切换），二次生成流程不断。
- `getContext().chat` 由 CharacterChat 每次渲染同步（`stripStyleBlocks` 清洗 mes），COT swipe 若含 `<styled>` 标签，跨渲染后读回可能被剥离；插件同一渲染周期内的"写入→读回"不受影响。
- `/api/chats/save` 整体覆盖 branch 消息会重置消息 created_at（顺序由 mesid 保证）；tokens/model 列不随 save 保留（extra.token_count/model 保留）。
- 剧情回顾仍依赖 AutoCardUpdater 插件（ST 亦然）。

### 阶段 B（P1）
6. ⏳ 世界书读取/绑定真实化联动验证（getGlobalWorldbookNames / rebindGlobalWorldbooks 仍为降级桩）。
7. ⏳ 增强模式 profile/model/preset 映射细化（含 quiet 语义）。

### 阶段 C（P2/P3，增强）
8. ⏳ CORS 代理组桩、Mvu 桩、AutoCardUpdaterAPI 空桩（可选）、小白盒 TTS 桥（可选）。
9. ⏳ `/user/files/` 静态端点（可选）、`SillyTavern.get` 直连桩。

---

## 7. 验收标准

### 7.1 功能级（浏览器实测，参照 §5 验证栏）

| # | 场景 | 通过标准 |
|---|---|---|
| A1 | 对话 → COT 格式 | 消息 swipe 第二条存在格式化文本；重绘使用格式化版本 |
| A2 | 时间线回退 | 点击旧节点 → 聊天回退到该节点；Palink 故事线出现新分支（branch-tree 可查） |
| A3 | 存档/读档 | 存档后可读档跳转（含跨会话切换） |
| A4 | 增强模式 | 开启后两次生成均成功；profile/model/preset 切换不中断 |
| A5 | COT 世界书 | Palink 世界书列表出现格式规范书；AI 回复遵循格式 |
| A6 | 全屏/Dock | 全屏 Dock 隐藏、退出恢复（回归） |
| A7 | 时间线图谱 | ≥1 节点图谱渲染（回归）；点击节点不再 toast"切换聊天失败"（当目标可导航时） |
| A8 | 历史回顾 | 未装 AutoCardUpdater 时显示"暂无历史记录"（与 ST 一致，无报错） |

### 7.2 数据安全级

- 插件任何操作（含失败路径）**不得**产生孤儿分支、重复世界书、错乱 swipes。
- 每次写操作后 `GET /api/character-sessions/{sid}/branch-tree` 与故事线 UI 一致。
- 退出插件（`unloadAll`）后 Palink 数据无残留改动（除用户主动触发的分支/世界书）。

### 7.3 回归级

- `npx tsc --noEmit`、`npm run build` 通过。
- `getcontext-parity.test.ts`（145 API 契约）通过。
- 后端 `pytest backend/tests` 通过（至少 ST 契约类）。
- 插件无新 console error（除已知降级 warn）。

### 7.4 桩质量约束

- 所有新增桩**必须是函数且返回 Promise/值**，不得抛同步异常。
- 失败路径返回 `{ok:false, reason}` 或 `null`/`[]`（按 ST 语义），不得 `undefined`（防插件 `?.` 链断裂）。
- no-op 白名单：新增桩不得进入 `PALINK_ALLOWED_NO_OPS` 未登记状态（契约测试会拦截）。

---

## 8. 风险与限制

| 风险 | 应对 |
|---|---|
| `/api/chats/save` 对 ST 形状 swipes 兼容性不确定 | 阶段 A 先写后端核对用例（swipe 读写往返），再改前端 |
| 分支命令与 Palink forkPoint 语义差异（`same_level`/`up_to_message_id`） | 桥接层以 `POST /api/character-sessions/{sid}/branches` 现有参数为准，映射表在实现时固化并补单测 |
| 增强模式 profile 无等价物 | 采用"记录成功、静默跳过"策略，保证插件流程不断；文档注明差异 |
| 插件 IIFE 内 `topWindow` 引用（iframe 场景 `window.parent`） | 保持现状（当前宿主直接是顶层，`topWindow===window`）；若未来进入 iframe 需复查 |
| 世界书 upsert 缺少后端端点 | 新增 1 个专用端点并挂 CSRF guard + 权限校验 |
| 契约测试上限（no-op ≤20，当前 19） | 新增桩必须真实实现，不得占用 no-op 名额 |

---

## 9. 测试计划

1. **单测**：桥接层纯函数（slash 解析、chatFile 解析、消息形状转换、分支映射）。
2. **契约测试**：扩展 `getcontext-parity.test.ts` 或新增 `galgame-compat.test.ts`，断言新增桩存在且可调用。
3. **后端测试**：`/api/chats/save`+swipes 往返、`/api/sd/comfy/samplers`、世界书 upsert 端点。
4. **浏览器 E2E**（复用 Chrome DevTools MCP 流程）：按 §7.1 表格逐项验证，含"修复前失败路径 → 修复后成功"对照。
5. **回归**：全屏/Dock、时间线图谱、对话推进、故事线分支（§7.3）。

---

## 10. 附录

### 10.1 插件依赖外部接口完整清单（调研快照）

- **SillyTavern 命名空间**：getContext / getRequestHeaders / get / Generate / generating / openCharacterChat / chatMetadata / characterId / characters / name2
- **window 全局**：getContext / getChatMessages / setChatMessages / getLastMessageId / getCurrentChatId / substitudeMacros / getVariables / replaceVariables / Mvu / triggerSlash / eventOn / tavern_events / iframe_events / openCharacterChat / getCorsProxyUrl / enableCorsProxy / corsProxy / toastr / jQuery / this_chid / isGenerating / 世界书组 / AutoCardUpdaterAPI / xiaobaixTts / LittleWhiteBox / XB_TTS_VOICE_DATA / Live2DCubismCore / PIXI / JSZip / gsap
- **后端端点**：`POST /api/characters/chats` ✅ / `POST /api/chats/get` ✅ / `GET /thumbnail` ✅ / `POST /api/sd/comfy/samplers` ❌ / `GET /user/files/*` ❌ / `SillyTavern.get` 代理（可选）
- **slash 命令**：/profile-list /profile /model /preset /getchatname /branch-create /checkpoint-create /checkpoint-go /chat-fork
- **事件**：GENERATION_STARTED / GENERATION_ENDED / MESSAGE_RECEIVED / CHAT_CHANGED / STREAM_TOKEN_RECEIVED_FULLY / VARIABLE_UPDATE_ENDED
- **DOM**：#chat / .mes[mesid][is_user] / #send_textarea / #send_but / #option_regenerate

### 10.2 已修复项回溯（本次兼容工作的基础）

- getContext.characters 挂载当前角色（含 avatar 规范化）✅
- getRequestHeaders（Bearer + CSRF）✅
- 全屏时 Dock 隐藏（App.tsx）✅
