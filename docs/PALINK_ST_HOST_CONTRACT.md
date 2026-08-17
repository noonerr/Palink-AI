# Palink 最小 ST Host Contract (v1)

## 目标

本文档定义 Palink 作为 SillyTavern (ST) Host 时，必须暴露的最小 API 表面。供 st-native / bridge / compat 三层运行时使用。

---

## 1. 上下文合约 (`getContext()`)

ST 前端通过 `window.SillyTavern.getContext()` 获取运行上下文。Palink bridge 必须确保返回的对象包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `characters` | `Array<Character>` | 当前角色列表。bridge 在 boot 时从 `/api/characters/all` 注入 |
| `chat` | `Array<ChatMessage>` | 当前聊天消息。bridge 在 boot 时从 `/api/chats/get` 注入 |
| `chatMetadata` | `Object` | 会话元数据，必须包含 `palink_session_id` / `palink_character_id` / `palink_branch_id` |
| `eventSource` | `EventSource` | 事件总线，bridge 可代理关键事件（如 `MESSAGE_SENT`） |
| `userName` | `string` | Palink 用户名，从 settings 注入 |
| `characterId` | `number` | 当前角色在 `characters` 数组中的索引 |
| `name2` | `string` | 当前角色名 |
| `getChat` | `Function` | 返回 `chat` 数组 |
| `setCharacterId` | `Function` | 切换角色 |
| `selectCharacterById` | `Function` | 切换角色并可选刷新菜单 |
| `printMessages` | `Function` | 重新渲染消息列表 |

### 实现位置
- `frontend/public/st/bridge.js` — boot 注入、事件桥接
- `backend/app/api/silly_tavern.py` — `/api/characters/all`, `/api/chats/get` 返回 ST 格式数据

---

## Prompt Compatibility Principle

Palink is the only prompt assembly authority, but roleplay prompt behavior
should default to ST-compatible semantics.

Required constraints:

- `palink-native` assembles prompts on the backend.
- ST is the compatibility reference for roleplay prompt ordering.
- character card fields, author note, worldbook, depth prompt, preset prompt,
  macro expansion, regex passes, and slash-command side effects should be kept
  in an ST-compatible order unless there is a documented exception.
- `bridge` must not become an alternate prompt runtime.
- `st-native` remains the fallback reference runtime for compatibility checks.

---

## 2. 事件总线 (`eventSource`)

ST 前端内部使用事件总线进行模块通信。bridge 只需要代理以下事件：

| 事件 | 方向 | 说明 |
|------|------|------|
| `MESSAGE_SENT` | ST → Palink | 用户发送消息时触发，bridge 通过 `postMessage` 转发给 Palink 主窗口 |
| `CHARACTER_LOADED` | Palink → ST | 角色加载完成后，bridge 可注入 `applyCharacters` |
| `CHAT_CHANGED` | Palink → ST | 聊天切换完成后，bridge 可注入 `applyChatSnapshot` |

### 实现位置
- `frontend/public/st/bridge.js` — `hookSTEvents()` 代理 `MESSAGE_SENT`

---

## 3. 扩展设置 (`extension_settings`)

ST 通过 `extension_settings` 存储插件数据。Palink 作为 Host 时，**不直接管理扩展设置**，而是通过以下策略：

- 在 `_default_st_settings` 中返回空的 `extension_settings: {}`
- 在 `_boot_settings_override` 中设置 `enable_extensions: False` 和 `enable_extensions_auto_update: False`
- 扩展数据由 st-native 容器自行管理（st-native 模式下）

### 实现位置
- `backend/app/api/silly_tavern.py` — `_default_st_settings()`, `_boot_settings_override()`

---

## 4. 聊天/消息 API

Palink 必须暴露与 ST 兼容的聊天/消息 CRUD 接口：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/characters/all` | POST | 返回 ST 格式的角色列表 |
| `/api/characters/get` | POST | 返回单个角色的 ST 格式数据 |
| `/api/chats/get` | POST | 返回聊天消息快照（ST 格式） |
| `/api/chats/save` | POST | 保存聊天消息（由 ST 调用时，Palink 做适配写入） |
| `/api/chats/search` | POST | 聊天搜索 |
| `/api/chats/delete` | POST | 删除聊天 |
| `/api/chats/rename` | POST | 重命名聊天 |
| `/api/backends/chat-completions/generate` | POST | 生成接口（OpenAI 兼容） |
| `/api/backends/chat-completions/status` | POST | 模型状态检查 |

### 数据主权规则
- Palink 是聊天消息的唯一数据真相源
- ST 前端通过 bridge 读取 Palink 数据，不做本地持久化
- `/api/chats/save` 被调用时，Palink 将 ST 格式消息同步回 `CharacterChatMessage` 表

### 实现位置
- `backend/app/api/silly_tavern.py` — 所有聊天/消息端点
- `frontend/public/st/bridge.js` — `REAL_API_PATHS` 透传

---

## 5. 世界书 API (`worldbook`)

Palink 的世界书引擎是 ST-grade 的，因此 Palink 作为 Host 必须暴露世界书数据：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/worldinfo/get` | POST | 返回角色的世界书条目（ST 格式） |
| `/api/worldinfo/edit` | POST | 编辑/创建世界书条目 |
| `/api/worldinfo/delete` | POST | 删除世界书条目 |

### 数据主权规则
- Palink `worldbook_service.py` 是世界书的唯一真相源
- ST 前端通过上述 API 读取/编辑世界书，所有修改直接写入 Palink 数据库
- bridge 不再 mock 世界书数据

### 实现位置
- `backend/app/api/silly_tavern.py` — `/api/worldinfo/*` 端点
- `frontend/public/st/bridge.js` — `REAL_API_PATHS` 透传，MOCKS 中无 worldbook

---

## 6. 变量 API (`variable`)

宏/变量运行时由 `macro_service.py` 提供。ST 兼容层通过以下方式访问变量：

| 机制 | 说明 |
|------|------|
| `{{getvar::key}}` | 宏替换时读取变量（由 `macro_service.evaluate_macros` 处理） |
| `/setvar`, `/getvar`, `/incvar`, `/decvar`, `/addvar` | Slash 命令修改变量（由 `slash_command_service` 处理） |

### 数据主权规则
- 变量存储在 Palink 数据库 (`chat_variables`, `user_variables`, `global_variables`)
- ST 前端通过 slash 命令或宏模板访问变量，不直接读写数据库
- 不允许 ST 原生后端直接管理 Palink 变量

### 实现位置
- `backend/app/services/macro_service.py` — 变量读写
- `backend/app/services/slash_command_service.py` — 变量 slash 命令
- `backend/app/services/roleplay_prompt_assembly.py` — 宏替换时机

---

## 7. Slash 命令 API (`slash`)

Palink 后端实现核心 slash 命令：

| 命令 | 说明 | 作用域 |
|------|------|--------|
| `/sys` | 添加系统消息 | 当前会话 |
| `/note` / `/an` | 设置作者注释 | 当前会话扩展 |
| `/name` / `/rename` | 修改角色名 | 角色数据 |
| `/persona` | 修改角色性格 | 角色数据 |
| `/impersonate` | 以用户身份发送消息 | 当前会话 |
| `/setvar` | 设置变量 | 聊天变量 |
| `/getvar` | 读取变量 | 聊天/用户/全局变量 |
| `/incvar` / `/decvar` / `/addvar` | 数值变量操作 | 聊天变量 |
| `/wi` | 添加世界书条目 | 角色世界书 |
| `/world` | 修改世界观/场景 | 角色数据 |
| `/help` | 列出可用命令 | — |

### 运行时分级
- **palink-native**: 使用 `slash_command_service.py` 后端执行
- **st-native**: 由 ST 原生容器自行处理
- **compat**: 通过 bridge 透传，最终由 Palink 后端执行

### 统一路径
- HTTP 角色聊天（`character_ext.py`）和 WebSocket 角色聊天（`websocket.py`）都必须在调用 `assemble_roleplay_prompt` 之前处理 slash 命令
- 避免一条链路走 slash 处理，另一条链路跳过

### 实现位置
- `backend/app/services/slash_command_service.py` — 命令注册与执行
- `backend/app/api/character_ext.py` — HTTP 路径前置处理
- `backend/app/api/websocket.py` — WebSocket 路径前置处理

---

## 8. 设置加载/保存 (`settings`)

Palink 管理用户的 ST 兼容设置，但**不做双写**：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/settings/get` | POST | 返回合并后的 ST 设置（包含 Palink 默认值） |
| `/api/settings/save` | POST | 保存 ST 设置到 `UserSetting.silly_tavern_settings` |

### 数据主权规则
- Palink 只保存 `UserSetting.silly_tavern_settings` 字段
- **不再**将 ST 设置同步回 `GenerationPreset`（已移除 `_apply_settings_to_preset` 调用）
- ST 前端调用 `/api/settings/save` 时，Palink 返回 `{"result": "ok"}`，但不做额外副作用
- 生成参数（temperature, top_p, max_tokens 等）以 Palink `GenerationPreset` 为准

### 实现位置
- `backend/app/api/silly_tavern.py` — `/api/settings/get`, `/api/settings/save`
- `backend/app/api/silly_tavern.py` — `_default_st_settings()`, `_boot_settings_override()`, `_merge_palink_defaults()`

---

## 9. 模式切换合约 (`silly_tavern_mode`)

用户设置中的 `silly_tavern_mode` 必须实际控制聊天运行时：

| 模式 | 值 | 运行时 | 说明 |
|------|-----|--------|------|
| palink-native | `"palink-native"` | Palink 原生 | 默认主线。使用 Palink UI 和 Palink 后端 |
| st-native | `"st-native"` | ST 原生 | 兼容兜底。嵌入 ST 容器，数据仍走 Palink 后端 |
| compat | `"compat"` | 兼容层 | 过渡模式。使用 Palink 模拟的 ST UI |

### 默认值
- 数据库默认值：`palink-native`
- 后端规范化：`_normalize_silly_tavern_mode()` 非法值回退到 `palink-native`
- 前端默认值：`CharacterChat` 组件 `sillyTavernMode = 'palink-native'`

### 实现位置
- `backend/app/models/system.py` — `UserSetting.silly_tavern_mode` 默认
- `backend/app/api/silly_tavern.py` — `_normalize_silly_tavern_mode()`
- `backend/app/api/users.py` — 设置保存/读取
- `frontend/src/components/views/CharacterView.tsx` — 设置读取
- `frontend/src/components/views/character/CharacterChat.tsx` — 模式分流渲染

---

## 10. 运行时边界总结

| 运行时 | 拥有 prompt 决定权 | 拥有 worldbook 决定权 | 拥有变量决定权 | 拥有 slash 决定权 | 拥有数据主权 |
|--------|-------------------|----------------------|---------------|------------------|-------------|
| **palink-native** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **st-native** | ❌ | ❌ | ❌ | ❌ | ✅ (Palink 后端) |
| **bridge** | ❌ | ❌ | ❌ | ❌ | ❌ (纯转接) |

- **palink-native**: 唯一拥有 prompt/worldbook/变量/slash 决定权的运行时
- **st-native**: 仅作为 UI 兜底，所有数据操作仍通过 bridge 路由到 Palink 后端
- **bridge**: 只做 boot context、状态同步、格式转换、事件转发，不执行业务逻辑

---

## 11. 插件兼容分级 (建议)

| 分级 | 依赖特征 | 处理策略 |
|------|----------|----------|
| **A 类** | 公开 API（getContext, eventSource, chat API） | 向 palink-native 迁移，bridge 提供兼容 API |
| **B 类** | 部分内部依赖（extension_settings, regex, worldbook） | 需要适配层，在 bridge 中提供 shim |
| **C 类** | 强依赖 ST DOM/私有模块/原生后端 | 仅支持 st-native 模式，不做兼容 |

---

## 版本
- 文档版本: v1.0
- 对应 Palink 版本: 当前收敛版本
- 更新日期: 2026-06-15
