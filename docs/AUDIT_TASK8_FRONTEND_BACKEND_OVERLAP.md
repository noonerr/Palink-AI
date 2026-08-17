# Task 8: 前端兼容代码与后端 runtime 重叠审查报告

- **审计日期**: 2026-07-01
- **审计范围**:
  - 前端: `d:\项目\Palink-AI\frontend\src\lib\sillytavern\`
  - 后端对照: `d:\项目\Palink-AI\backend\app\services\` 中的 `macro_service.py`、`slash_command_service.py`、`worldbook_service.py`、`roleplay_prompt_assembly.py`
- **审计员**: Palink-AI 代码审计员
- **审计方式**: 静态代码阅读（只读，未运行容器、未修改任何代码）
- **背景**: Palink-AI 采用前后端分离架构，后端 `backend/app/services/` 拥有完整的 prompt/worldbook/macro/slash 逻辑；前端 `frontend/src/lib/sillytavern/` 应该仅做"兼容层"（getContext/runtime facade/事件转发），不应包含实际业务逻辑。

---

## 1. 前端 `sillytavern/` 目录结构

```
frontend/src/lib/sillytavern/
├── __tests__/
│   ├── event-contract.test.ts      (测试文件，不参与运行时)
│   ├── getcontext-parity.test.ts   (测试文件，不参与运行时)
│   └── runtime-contract.test.ts    (测试文件，不参与运行时)
├── macros/
│   ├── bridge.ts                   (桥接层，委托到 macro-engine)
│   ├── extended.ts                (扩展时间/日期宏实现)
│   └── index.ts                   (重导出 bridge)
├── regex/
│   ├── adapter.ts                 (Palink regex → ST 格式适配器)
│   └── engine.ts                  (ST 兼容的 regex 执行引擎)
├── formatting.ts                   (消息格式化：DOMPurify + Showdown + 语义标签处理)
├── getContext.ts                   (ST getContext() 完整兼容实现)
└── runtime.ts                      (SillyTavernRuntime 类 + EventSourceWrapper + 事件映射表)
```

### 1.1 文件清单与主要职责

| 文件 | 行数 | 主要职责 | 分类 |
|---|---|---|---|
| `runtime.ts` | 947 | 定义 `SillyTavernRuntime` 类、`EventSourceWrapper`、`ST_TO_PALINK_EVENT_MAP` 事件映射表、消息操作（addOneMessage/deleteMessage/swipe 等）、生成事件触发方法、宏注册委托、变量委托 | 兼容层（OK）+ 事件转发（OK） |
| `getContext.ts` | 2195 | 实现 ST `getContext()` 函数，返回包含 P0 字段的上下文对象，覆盖 111 个事件枚举、Popup 包装、SlashCommand 包装、变量作用域包装、世界书加载、token 计数缓存等 | 兼容层（OK）+ 世界书加载委托（OK）+ 轻度业务（见问题 F-1） |
| `formatting.ts` | 1009 | 消息格式化：DOMPurify 配置与 hooks、Showdown Markdown 转换、HTML 块提取/还原、CSS 作用域化、reasoning 标签提取、宏替换、regex 应用 | 兼容层（OK，**纯前端展示逻辑**，与后端 prompt 装配无重叠） |
| `macros/index.ts` | 19 | 从 `bridge.ts` 重导出 API | 兼容层（OK） |
| `macros/bridge.ts` | 116 | 桥接层：将旧 `MacroEnv` 转换为新 `MacroEnv`，委托到 `../../macro-engine/` 的 `evaluateMacros` | 兼容层（OK） |
| `macros/extended.ts` | 45 | 扩展宏实现：`{{time::format}}`、`{{date::format}}`、`{{iso_date}}`、`{{unix_time}}`、`{{day}}`、`{{month}}`、`{{year}}`、`{{hour}}`、`{{minute}}`、`{{second}}` | **业务逻辑重复（问题 F-2）** |
| `regex/adapter.ts` | 162 | 将 Palink regex 脚本格式转换为 ST `RegexScript` 格式；提供 `getRegexedStringForMessage` 便捷入口 | 兼容层（OK） |
| `regex/engine.ts` | 409 | ST 兼容的 regex 执行引擎：`RegexProvider` 缓存、`regex_placement` 枚举、`getRegexScripts` 过滤、`runRegexScript` 执行、`getRegexedString` 入口、`applyRegexToText` / `applyRegexScripts` 辅助 | 兼容层（OK，**前端展示用**，与后端 prompt 用 regex 用途不同） |
| `__tests__/*.test.ts` | (各 80~500 行) | ST 公共 API 一致性、runtime 契约、getContext 等价性测试 | 测试文件（不参与运行时） |

---

## 2. 分类评估

### 2.1 兼容层 / Facade（OK，无问题）

| 文件 | 评估理由 |
|---|---|
| `runtime.ts` | `SillyTavernRuntime` 类是 facade：所有方法（getContext/setContext/registerMacro/setVariable/registerSlashCommand/executeSlashCommands/messageFormatting/substituteParams）都**委托到** `variableManager` / `SlashCommandEngine` / `formatMessage` / `substituteParamsExtended` 等已有 Palink 服务。`EventSourceWrapper` 包装 Palink `eventBus`，将 ST `(...args)` 语义适配为单 payload 语义。`ST_TO_PALINK_EVENT_MAP` 是事件名映射表，纯声明。 |
| `getContext.ts` | `getContext()` 返回对象所有字段都是**委托调用**：`messageManager.messages`、`generationEngine.generate`、`SlashCommandEngine.execute`、`variableManager.local/global`、`popupManager.show`、`groupChatManager`、`personaManager`、`MacroRegistry` 等。`StSlashCommandParser` / `StSlashCommand` / `StSlashCommandArgument` 包装类委托到 `SlashCommandEngine`。Popup / toastr 适配器委托到 sonner。 |
| `formatting.ts` | 实现的是**纯前端展示逻辑**：DOMPurify 消毒、Showdown Markdown→HTML、CSS 作用域化、reasoning 标签提取。后端 `roleplay_prompt_assembly.py` 处理的是 prompt 装配（消息拼接、token 预算、世界书注入），**不涉及 HTML 渲染**。两者用途不同，无重叠。 |
| `macros/index.ts` | 纯重导出，无逻辑。 |
| `macros/bridge.ts` | 桥接层：将旧接口的 `MacroEnv` 转换为新 `MacroEnv`，委托到 `../../macro-engine/`。无独立业务逻辑。 |
| `regex/adapter.ts` | 字段映射适配器（snake_case ↔ camelCase），无业务决策。 |
| `regex/engine.ts` | ST 兼容的 regex 执行入口，**主要服务于前端展示**（`MD_DISPLAY` / `USER_INPUT` / `AI_OUTPUT` 等展示位）。后端 prompt 装配中的 regex 由 `roleplay_prompt_assembly.py` 直接调用，**不通过此文件**。两者用途分离，无重叠。 |
| `runtime.ts` 事件转发部分 | `emitMessageReceived` / `emitMessageRendered` / `emitWorldInfoScanDone` / `emitGenerationStarted` / `emitGenerationEnded` / `onStreamToken` 等方法**同时**调用 `eventSource.emit(ST事件)` 与 `eventBus.emit(Palink事件)`，是标准的事件转发模式。OK。 |

### 2.2 业务逻辑重复（问题）

| 文件 | 重叠内容 | 严重程度 |
|---|---|---|
| `macros/extended.ts` | 时间/日期宏替换规则与后端 `macro_service.py::_resolve_simple_macro` 重叠 | **中** |
| `getContext.ts::getWorldInfoPrompt` (1744-1788) | 调用前端 `stWorldBookManager.scanAndBuildContext`，与后端 `worldbook_service.py::build_worldbook_context` 是两套并行实现 | **中** |

### 2.3 事件转发（OK）

| 模块 | 评估 |
|---|---|
| `runtime.ts::EventSourceWrapper` | 将 ST `(...args)` 语义打包/解包为 eventBus 单 payload，正确实现 `on/off/emit/once/makeLast/makeFirst/removeAllListeners/listenerCount` |
| `runtime.ts::emit*` 方法 | 7 个事件触发方法同时 emit ST + Palink 事件，符合事件转发模式 |
| `getContext.ts::emitChatMetadataUpdated` | 统一入口触发 `chat_metadata_updated` 事件，非阻塞 |
| `getContext.ts::createFallbackEventSource` | runtime 不可用时的 fallback，行为与 EventSourceWrapper 一致 |

---

## 3. 发现的重叠列表

### 🟡 F-1（中风险）`getContext.ts::getWorldInfoPrompt` 调用前端世界书扫描器，与后端 `worldbook_service.py::build_worldbook_context` 形成并行实现

- **前端文件:行号**: `frontend/src/lib/sillytavern/getContext.ts:1744-1788`（`getWorldInfoPrompt` 方法内调用 `stWorldBookManager.scanAndBuildContext(scanContext, messages.length - 1)`）
- **后端文件:行号**: `backend/app/services/worldbook_service.py:754-940`（`build_worldbook_context` 函数，含 ST-grade 完整实现：`_scan_entries` / `_recursive_scan` / `_resolve_budget` / `_apply_budget` / `_apply_group_scoring` / `TimedEffectsManager`）
- **前端扫描器实现**: `frontend/src/lib/worldbook/manager.ts::scanAndBuildContext`（位于 `sillytavern/` 目录外，但被 `getContext.ts` 引用并通过 `stWorldBookManagerSingleton` 暴露给 ST 插件）
- **重叠内容**:
  - 两者都实现 ST 1.18.0 的世界书条目扫描：主键匹配、二级键匹配、选择性逻辑（AND/AND NOT/OR 等）、优先级排序、token 预算分配、递归扫描、定时效果（sticky/cooldown）、分组打分
  - 前端 `frontend/src/lib/worldbook/` 还有 `budget.ts` / `recursive.ts` / `scanner.ts` 等独立模块
- **用途差异**:
  - 后端 `build_worldbook_context`: 用于**实际 prompt 装配**（在 `roleplay_prompt_assembly.py::_append_worldbook_context` 中调用），影响发送给 LLM 的真实上下文
  - 前端 `getWorldInfoPrompt`: ST 插件调用 `getContext().getWorldInfoPrompt()` 时返回**展示用**激活条目内容；同时调用 `scanAndBuildContext` 触发前端扫描以激活条目，**不直接用于后端 prompt 装配**
- **风险**:
  - **行为漂移**: 两套扫描器独立实现，ST 升级或 bug 修复时易出现一边修一边漏的情况
  - **状态不一致**: 前端扫描激活的条目与后端实际装配时激活的条目可能不同（消息采样范围、token 预算策略可能不同），导致 ST 插件看到的「激活状态」与实际 prompt 内容不符
  - **代码冗余**: 维护两套复杂扫描算法成本高
- **缓解因素**: 前端 `stWorldBookManagerSingleton` 是单例，与 `runtime.worldBookManager` 共享引用；前端扫描主要服务 ST 插件兼容性，实际 prompt 走后端
- **建议**:
  1. **短期**: 在 `getWorldInfoPrompt` 文档/注释中明确标注「此扫描仅用于 ST 插件展示，实际 prompt 装配由后端 `worldbook_service.build_worldbook_context` 完成」
  2. **长期**: 评估是否能让前端调用后端 `/api/worldbook/scan` 端点获取扫描结果，消除前端扫描器
- **风险等级**: **中**

### 🟡 F-2（中风险）`macros/extended.ts` 时间/日期宏与后端 `macro_service.py::_resolve_simple_macro` 部分重叠

- **前端文件:行号**: `frontend/src/lib/sillytavern/macros/extended.ts:1-45`（`applyExtendedMacros` 函数）
- **后端文件:行号**: `backend/app/services/macro_service.py:158-163`（`_resolve_simple_macro` 中处理 `{{time}}` / `{{date}}` / `{{datetime}}`）
- **重叠宏列表**:

  | 宏 | 前端行为 (`extended.ts`) | 后端行为 (`macro_service.py`) | 差异 |
  |---|---|---|---|
  | `{{time}}` | 不处理（仅处理 `{{time::format}}`） | UTC 时间 `%H:%M` | **不一致**：前端不处理无参 `{{time}}` |
  | `{{date}}` | 不处理（仅处理 `{{date::format}}`） | UTC 时间 `%Y-%m-%d` | **不一致**：前端不处理无参 `{{date}}` |
  | `{{time::HH:mm:ss}}` | 按格式串返回本地时间 | 不支持 | 前端独有 |
  | `{{date::YYYY-MM-DD}}` | 按格式串返回本地日期 | 不支持 | 前端独有 |
  | `{{iso_date}}` | `now.toISOString()` | 不支持 | 前端独有 |
  | `{{unix_time}}` | `Math.floor(now.getTime() / 1000)` | 不支持 | 前端独有 |
  | `{{day}}` | 英文星期名 | 不支持 | 前端独有 |
  | `{{month}}` | 英文月份名 | 不支持 | 前端独有 |
  | `{{year}}` / `{{hour}}` / `{{minute}}` / `{{second}}` | 对应数值 | 不支持 | 前端独有 |
  | `{{datetime}}` | 不处理 | UTC 时间 `%Y-%m-%d %H:%M` | **不一致**：后端独有 |

- **调用链**:
  - 前端 `formatting.ts::formatMessage` 第 879 行调用 `substituteParamsExtended`（委托到 `macros/bridge.ts::substituteParamsExtended` → `../../macro-engine/evaluateMacros`），但**未直接调用 `applyExtendedMacros`**
  - 经检查 `extended.ts` 中的 `applyExtendedMacros` **当前未被 `formatting.ts` 或 `getContext.ts` 直接引用**——它在 `macros/` 模块中导出但未在主流程中被调用（grep `applyExtendedMacros` 仅在 `extended.ts` 自身定义处出现）。因此实际重叠风险较低。
- **风险**:
  - **时区不一致**: 后端用 UTC（`datetime.utcnow()`），前端用本地时间（`new Date()`），同一宏在 prompt 装配与展示装配时可能产生不同结果
  - **格式不一致**: 后端 `{{time}}` 返回 `HH:MM`，前端 `{{time::HH:mm:ss}}` 支持自定义格式
  - **未使用的死代码风险**: `applyExtendedMacros` 未被任何运行时代码调用，存在「写了但未接入」的隐患
- **建议**:
  1. 若 `applyExtendedMacros` 确为死代码，应删除以避免混淆
  2. 若计划接入，应与后端 `macro_service.py::_resolve_simple_macro` 协调时区与格式约定，避免同一宏在前后端产生不同结果
  3. **最佳实践**: 时间/日期宏应统一在后端处理（prompt 装配时使用），前端展示用宏替换应直接复用后端逻辑或返回后端结果
- **风险等级**: **中**——目前 `applyExtendedMacros` 未被调用，实际风险低；但若后续接入会导致时区/格式不一致

### 🟢 F-3（低风险）`getContext.ts::registerSlashCommand` / `executeSlashCommands` 委托到前端 `SlashCommandEngine`，与后端 `slash_command_service.py` 形成并行实现

- **前端文件:行号**:
  - `frontend/src/lib/sillytavern/runtime.ts:610-625`（`registerSlashCommand` / `executeSlashCommands` 委托到 `SlashCommandEngine`）
  - `frontend/src/lib/sillytavern/getContext.ts:1463-1477`（同上，且定义 `registerSlashCommand` 字段）
  - 前端 SlashCommandEngine 实现位于 `frontend/src/lib/slash-engine/`（在 `sillytavern/` 目录外）
- **后端文件:行号**: `backend/app/services/slash_command_service.py`（含 24 个内置命令：`sys` / `note` / `name` / `persona` / `impersonate` / `setvar` / `getvar` / `incvar` / `decvar` / `addvar` / `wi` / `world` / `help` / `send` / `gen` / `continue` / `retry` / `swipe` / `branch` / `model` / `preset` / `delvar`）
- **重叠内容**:
  - 两者都实现 ST slash 命令解析与执行
  - 后端 `_cmd_setvar` / `_cmd_getvar` / `_cmd_incvar` / `_cmd_decvar` / `_cmd_addvar` / `_cmd_delvar` 等变量操作命令
  - 前端 `SlashCommandEngine` 也支持类似命令集（具体实现在 `slash-engine/` 内）
- **用途差异**:
  - 后端 `execute_slash_command`: 在用户消息进入聊天流程时被 `chat_service` / `inference_dispatcher` 调用，处理实际副作用（修改变量、切换分支、触发生成等）
  - 前端 `SlashCommandEngine`: 供 ST 插件通过 `getContext().executeSlashCommands()` 调用，主要服务 ST 插件兼容性
- **风险**:
  - **状态同步**: 前端执行 `/setvar` 仅修改前端 `variableManager.local`，**不会同步到后端 DB**——除非有显式的变量同步机制
  - **行为漂移**: 同一命令在前后端可能行为不同（如 `/swipe` 在后端会真正切换 swipe，在前端可能仅触发事件）
- **缓解因素**: 前端 `SlashCommandEngine` 主要服务 ST 插件兼容，实际聊天流程走后端；变量最终通过 `chat_metadata` 同步到后端
- **建议**:
  1. 在 `getContext.ts::executeSlashCommands` 文档注释中明确「此执行仅供 ST 插件兼容，实际聊天流程的 slash 命令由后端 `slash_command_service.execute_slash_command` 处理」
  2. 评估变量类命令（`/setvar` / `/getvar` 等）是否应直接代理到后端 API，而非前端独立执行
- **风险等级**: **低**——用途分离清晰，但变量同步存在潜在不一致

### 🟢 F-4（低风险）`getContext.ts::_stageToEntry` 字段映射与后端 `worldbook_service.py` 存在字段默认值差异

- **前端文件:行号**: `frontend/src/lib/sillytavern/getContext.ts:916-961`（`_stageToEntry` 函数，将后端 `WorldBookStage` 转换为前端 `WorldBookEntry`）
- **后端文件:行号**: `backend/app/services/worldbook_service.py:754-940`（`build_worldbook_context` 直接读取 `WorldBookStage` 模型字段，无中间转换）
- **重叠内容**: 两者都访问 `WorldBookStage` 字段，但前端通过 `_stageToEntry` 做了字段名映射（`stage_index` → `uid`、`keys` → `key`、`secondary_keys` → `keysecondary`、`priority` → `order` 等），并给后端暂未实现的字段（`selectiveLogic` / `depth` / `caseSensitive` / `matchWholeWords` / `enabled`）赋默认值
- **风险**:
  - 后端未来扩展 `WorldBookStage` 添加 `selectiveLogic` / `depth` / `caseSensitive` 等字段时，前端的默认值会**掩盖**真实值（除非同步更新 `_stageToEntry`）
  - 注释中已明确标注「后端 WorldBookStage 暂无 selectiveLogic 字段，默认 AND_ANY(0)」等，体现了开发者意识
- **缓解因素**: 注释充分，前端通过 `??` 运算符提供默认值，后端字段扩展时会自动读取（`stage.selectiveLogic ?? 0`）
- **建议**: 在后端 `WorldBookStage` 模型扩展时，同步检查 `_stageToEntry` 是否需要更新
- **风险等级**: **低**——默认值机制设计合理，注释充分

---

## 4. 风险等级评估汇总

| 编号 | 问题 | 风险等级 | 严重性 | 推荐处理时机 |
|---|---|---|---|---|
| F-1 | `getContext.ts::getWorldInfoPrompt` 调用前端世界书扫描器，与后端 `worldbook_service.build_worldbook_context` 并行实现 | **中** | 行为漂移、状态不一致 | 中期：评估前端扫描代理到后端 API |
| F-2 | `macros/extended.ts` 时间/日期宏与后端 `macro_service.py` 部分重叠（但 `applyExtendedMacros` 当前未被调用） | **中** | 时区/格式不一致、死代码风险 | 短期：删除死代码或与后端协调时区 |
| F-3 | `getContext.ts` slash 命令委托到前端 `SlashCommandEngine`，与后端 `slash_command_service.py` 并行实现 | **低** | 变量同步潜在不一致 | 长期：评估变量类命令代理到后端 |
| F-4 | `getContext.ts::_stageToEntry` 字段默认值与后端 `WorldBookStage` 模型字段差异 | **低** | 默认值掩盖真实值（未来扩展时） | 后端模型扩展时同步检查 |

---

## 5. 总体评估

### 5.1 整体架构合规性

`frontend/src/lib/sillytavern/` 目录**总体符合"兼容层"定位**：

- ✅ **`runtime.ts`** 是标准 facade：所有方法委托到 Palink 已有服务，事件转发模式正确
- ✅ **`getContext.ts`** 是标准 facade：返回对象所有字段委托调用 Palink 服务，无独立业务决策
- ✅ **`formatting.ts`** 是纯前端展示逻辑：DOMPurify/Showdown 渲染，与后端 prompt 装配无重叠
- ✅ **`macros/bridge.ts`** / **`macros/index.ts`** 是纯桥接层
- ✅ **`regex/adapter.ts`** / **`regex/engine.ts`** 是适配层，服务前端展示用 regex
- ✅ **`runtime.ts::EventSourceWrapper`** 与 `emit*` 方法是标准事件转发

### 5.2 发现的 4 处重叠

1. **F-1（中）**: 世界书扫描器前后端并行实现——这是 ST 兼容层为支持 ST 插件调用 `getWorldInfoPrompt()` 而必须保留的前端实现，**用途分离清晰但存在行为漂移风险**
2. **F-2（中）**: `applyExtendedMacros` 时间宏当前未被调用——**死代码风险**，且与后端时区/格式不一致
3. **F-3（低）**: Slash 命令引擎前后端并行——用途分离清晰（前端服务 ST 插件，后端服务实际聊天），变量同步存在潜在不一致
4. **F-4（低）**: `_stageToEntry` 字段默认值——设计合理，注释充分，风险低

### 5.3 关键结论

- **无高优先级问题**: 前端 `sillytavern/` 目录未发现"前端独立做业务决策"的高风险情况
- **核心业务逻辑仍在后端**: 实际 prompt 装配（`roleplay_prompt_assembly.py`）、世界书扫描（`worldbook_service.py`）、slash 命令执行（`slash_command_service.py`）、宏替换（`macro_service.py`）的核心逻辑均由后端实现
- **前端并行实现有合理依据**: ST 兼容层为支持 ST 插件调用 `getContext().getWorldInfoPrompt()` / `getContext().executeSlashCommands()` 等接口，必须在前端提供实现——这是 ST 插件兼容性的内在需求，**不属于违规**
- **主要风险是"漂移"**: 前后端并行实现的最大风险是行为漂移，建议通过文档注释、单元测试对齐、长期代理到后端 API 等方式缓解

### 5.4 建议优先级

| 优先级 | 建议 |
|---|---|
| 🟡 中 | F-2: 删除 `applyExtendedMacros` 死代码，或与后端 `macro_service.py` 协调时区/格式约定 |
| 🟡 中 | F-1: 在 `getWorldInfoPrompt` 注释中明确扫描用途，评估长期代理到后端 API |
| 🟢 低 | F-3: 在 `executeSlashCommands` 注释中明确用途分离，评估变量类命令代理到后端 |
| 🟢 低 | F-4: 后端 `WorldBookStage` 模型扩展时同步检查 `_stageToEntry` |

---

## 6. 文件路径索引（便于后续跟进）

### 6.1 前端文件

| 文件 | 绝对路径 |
|---|---|
| `runtime.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\runtime.ts` |
| `getContext.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\getContext.ts` |
| `formatting.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\formatting.ts` |
| `macros/index.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\macros\index.ts` |
| `macros/bridge.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\macros\bridge.ts` |
| `macros/extended.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\macros\extended.ts` |
| `regex/adapter.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\regex\adapter.ts` |
| `regex/engine.ts` | `d:\项目\Palink-AI\frontend\src\lib\sillytavern\regex\engine.ts` |
| 前端 worldbook 扫描器 | `d:\项目\Palink-AI\frontend\src\lib\worldbook\manager.ts`（在 `sillytavern/` 目录外） |
| 前端 slash 引擎 | `d:\项目\Palink-AI\frontend\src\lib\slash-engine\`（在 `sillytavern/` 目录外） |
| 前端 macro 引擎 | `d:\项目\Palink-AI\frontend\src\lib\macro-engine\`（在 `sillytavern/` 目录外） |

### 6.2 后端对照文件

| 文件 | 绝对路径 |
|---|---|
| `macro_service.py` | `d:\项目\Palink-AI\backend\app\services\macro_service.py` |
| `slash_command_service.py` | `d:\项目\Palink-AI\backend\app\services\slash_command_service.py` |
| `worldbook_service.py` | `d:\项目\Palink-AI\backend\app\services\worldbook_service.py` |
| `roleplay_prompt_assembly.py` | `d:\项目\Palink-AI\backend\app\services\roleplay_prompt_assembly.py` |

报告生成完毕。本审计未修改任何代码。
