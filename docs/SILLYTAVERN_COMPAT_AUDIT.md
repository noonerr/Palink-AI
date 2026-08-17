> **ARCHIVED**: This document is an older audit snapshot. For the current ST
> compatibility status, see:
> - `docs/PALINK_ST_COMPAT_EXECUTION_SPEC.md` — current execution spec
> - `docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md` — plugin compatibility matrix
> - `docs/PALINK_ST_AGENT_TODO.md` — live task board
>
> The information below may be outdated and conflict with current code.

# Palink-AI SillyTavern 兼容层问题大纲

> 基于 SillyTavern 官方开源代码（release 分支）与 Palink-AI 当前实现的全面对比分析
> 分析日期：2026-06-10
> 官方仓库：https://github.com/SillyTavern/SillyTavern

---

## 一、角色卡（Character Card）兼容性

### 1.1 数据规范差异

#### 1.1.1 V2 规范字段缺失
| 字段 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|------|------------------|-------------|----------|
| `creatorcomment` (V1 兼容) | 支持作为 `creator_notes` 别名 | 未处理 V1 的 `creatorcomment` 字段 | 中 |
| `talkativeness` | 数值类型，控制角色话多程度 | 未映射到内部模型 | 低 |
| `fav` | 布尔/字符串，标记收藏 | 未保留 | 低 |
| `create_date` | 创建日期字符串 | 未保留 | 低 |
| `chat` | 当前聊天文件名 | 未保留（ST 服务器端字段） | 低 |
| `avatar` (文件名) | 作为角色唯一标识符 | 使用 UUID，不兼容 ST 的 avatar 命名 | 中 |
| `shallow` | 懒加载标记 | 未支持 | 低 |

#### 1.1.2 V2 扩展字段 (`extensions`) 不完整
| 扩展字段 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|----------|------------------|-------------|----------|
| `depth_prompt` | 完整对象：`{depth, prompt, role}` | 未解析，仅原样保留 JSON | 高 |
| `pygmalion_id` | Pygmalion.chat 唯一标识 | 未保留 | 低 |
| `github_repo` | 关联 GitHub 仓库 | 未保留 | 低 |
| `source_url` | 来源 URL | 未保留 | 低 |
| `chub` | Chub 平台数据 `{full_path}` | 未保留 | 低 |
| `risuai` | RisuAI 平台数据 `{source:[]}` | 未保留 | 低 |
| `sd_character_prompt` | SD 生成提示词 `{positive, negative}` | 未保留 | 低 |

#### 1.1.3 V3 规范支持不完整
- **问题**：Palink 的 `_is_ccv3_card` 仅通过 `spec` 和 `spec_version` 判断，未完整解析 V3 的嵌套数据结构
- **官方 V3 特性**：
  - 更丰富的角色属性分组
  - 新的 `creator` 对象结构（包含 `name`, `version`, `comment`）
  - 支持多模态内容（图片、声音等嵌入）
- **Palink 现状**：V3 卡片被降级为 V2 处理，可能丢失 V3 特有字段

### 1.2 PNG 角色卡解析差异

#### 1.2.1 Chunk 类型覆盖不全
| Chunk 类型 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|------------|------------------|-------------|----------|
| `tEXt` | 支持 | 支持 | 无 |
| `zTXt` | 支持 | 支持 | 无 |
| `iTXt` | 支持（完整解析压缩标志、语言标签等） | 支持（基础解析） | 低 |
| `eXIf` | 用于 AI 生成图片检测 | 仅标记存在，未深入解析 | 低 |

#### 1.2.2 编码格式支持
- **Base64 编码**：Palink 支持基础 base64 解码
- **官方额外支持**：某些工具使用非标准编码（如 URL-safe base64），Palink 未覆盖

#### 1.2.3 损坏 PNG 容错
- **Palink**：有 `truncated_chunk` 检测和错误提示
- **官方**：更完善的 PNG 修复和容错机制
- **差距**：对于部分损坏的角色卡，官方可能能恢复更多数据

### 1.3 角色卡导出差异

#### 1.3.1 导出格式
- **Palink**：仅导出 V2 格式（`spec: 'chara_card_v2'`）
- **官方**：支持 V2/V3 导出，根据原始卡片版本决定
- **问题**：V3 卡片导入后导出变为 V2，丢失 V3 特性

#### 1.3.2 扩展字段保留
- **Palink**：`extensions` 原样保留，但 `palink_raw_card_data` 嵌套可能改变原始结构
- **官方**：严格保留原始数据结构
- **问题**：某些依赖特定 `extensions` 结构的工具可能无法识别导出的卡片

---

## 二、世界书（World Info / Character Book）兼容性

### 2.1 数据结构差异

#### 2.1.1 Entry 字段映射不完整
| 字段 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|------|------------------|-------------|----------|
| `insertion_order` | 数值，控制插入顺序 | 映射为 `order` | 中（命名差异） |
| `enabled` | 布尔，控制启用状态 | 映射为 `disable` 的反向 | 中（逻辑反转） |
| `extensions` | 对象，包含高级配置 | 未解析，丢失所有扩展配置 | 高 |
| `id` | 唯一标识符 | 未保留，重新生成 UUID | 中 |

#### 2.1.2 Entry Extensions 丢失（关键）
SillyTavern 官方 `v2DataWorldInfoEntryExtensionInfos` 包含以下字段，Palink 全部丢失：
- `position` - 扩展应用顺序
- `exclude_recursion` - 防止递归应用
- `probability` / `useProbability` - 概率控制
- `depth` - 递归嵌套深度限制
- `selectiveLogic` - 选择性逻辑
- `group` / `group_override` / `group_weight` - 分组控制
- `prevent_recursion` / `delay_until_recursion` - 递归控制
- `scan_depth` - 扫描深度（Palink 有但放在顶层）
- `match_whole_words` - 整词匹配
- `use_group_scoring` - 分组权重
- `case_sensitive` - 大小写敏感
- `automation_id` - 自动化标识
- `role` - 扩展角色
- `vectorized` - 向量化标记
- `display_index` - 显示顺序
- `match_persona_description` - 匹配用户人格描述
- `match_character_description` - 匹配角色描述
- `match_character_personality` - 匹配角色性格
- `match_character_depth_prompt` - 匹配深度提示词
- `match_scenario` - 匹配场景
- `match_creator_notes` - 匹配创作者备注

### 2.2 世界书导入逻辑差异

#### 2.2.1 条目排序
- **官方**：严格按 `insertion_order` 排序
- **Palink**：使用 `order` 字段排序，但默认值处理可能不同

#### 2.2.2 常量条目处理
- **官方**：`constant: true` 的条目始终插入
- **Palink**：将 `keys.length === 0` 也视为常量，可能与官方逻辑不完全一致

#### 2.2.3 禁用条目
- **官方**：`enabled: false` 跳过
- **Palink**：`disable: true` 或 `enabled: false` 跳过（双重判断）

---

## 三、正则脚本（Regex Scripts）兼容性

### 3.1 引擎实现差异

#### 3.1.1 脚本类型优先级
| 特性 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|------|------------------|-------------|----------|
| 执行顺序 | GLOBAL(0) → SCOPED(1) → PRESET(2) | 全局 → 预设 → 角色（顺序不同） | 高 |
| 允许列表 | `character_allowed_regex` / `preset_allowed_regex` | 无允许列表机制 | 高 |
| 禁用扩展检查 | `disabledExtensions.includes('regex')` | 无此检查 | 中 |

#### 3.1.2 正则缓存机制
- **官方**：`RegexProvider` 类，LRU 缓存，容量 1000，自动重置 `lastIndex`
- **Palink**：简单 Map 缓存，容量 80，无 `lastIndex` 重置逻辑
- **问题**：全局正则的 `lastIndex` 可能导致匹配异常

#### 3.1.3 正则编译逻辑
- **官方**：`regexFromString` 函数，支持 `/pattern/flags` 格式和裸字符串（默认加 `g` 标志）
- **Palink**：相同逻辑，但错误处理可能不同

### 3.2 替换逻辑差异

#### 3.2.1 捕获组处理
- **官方**：`$<name>` 命名捕获组支持完整
- **Palink**：有命名捕获组支持，但实现可能不完全一致

#### 3.2.2 `{{match}}` 替换
- **官方**：`replaceString.replace(/{{match}}/gi, '$0')`
- **Palink**：相同实现

#### 3.2.3 Trim Strings 过滤
- **官方**：`filterString` 函数，逐条过滤
- **Palink**：`filterTrimStrings` 函数，实现类似

### 3.3 参数替换差异

#### 3.3.1 宏替换范围
| 宏 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|----|------------------|-------------|----------|
| `{{user}}` | 支持 | 支持 | 无 |
| `{{char}}` | 支持 | 支持 | 无 |
| `{{character}}` | 支持 | 支持 | 无 |
| `{{name1}}` | 支持 | 支持 | 无 |
| `{{name2}}` | 支持 | 支持 | 无 |
| `{{match}}` | 支持 | 支持 | 无 |
| 扩展宏 | `substituteParamsExtended` 提供更多宏 | 仅基础宏 | 高 |

#### 3.3.2 `substituteRegex` 模式
- **官方**：`NONE(0)`, `RAW(1)`, `ESCAPED(2)`
- **Palink**：相同三种模式，实现一致

### 3.4 Placement 定义差异
| Placement | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----------|------------------|-------------|----------|
| MD_DISPLAY | 0 (已废弃) | 0 | 无 |
| USER_INPUT | 1 | 1 | 无 |
| AI_OUTPUT | 2 | 2 | 无 |
| SLASH_COMMAND | 3 | 3 | 无 |
| WORLD_INFO | 5 | 5 | 无 |
| REASONING | 6 | 6 | 无 |
| sendAs (legacy) | 4 | 未定义 | 低 |

---

## 四、扩展/插件（Extensions）兼容性

### 4.1 扩展架构差异

#### 4.1.1 加载机制
- **官方**：
  - 扩展通过 `manifest.json` 声明
  - `loading_order` 控制加载顺序
  - `js`/`css` 文件自动加载执行
  - 事件系统 `eventSource`/`event_types` 驱动
  - `getContext()` 提供完整上下文
- **Palink**：
  - ZIP 包导入，解析 manifest
  - **默认不执行 JS**（`execute_scripts: false`）
  - 无 `eventSource` 事件系统
  - 通过 iframe 沙箱隔离运行

#### 4.1.2 全局对象暴露
- **官方扩展可访问**：
  - `getContext()` - 完整聊天上下文
  - `eventSource` - 事件发射器
  - `extension_settings` - 扩展设置
  - `saveSettingsDebounced` - 设置保存
  - `renderExtensionTemplate` / `renderExtensionTemplateAsync` - 模板渲染
  - `callPopup` - 弹窗
  - `toastr` - 通知
  - `jQuery` / `$` - DOM 操作
  - `Handlebars` - 模板引擎
  - `DOMPurify` - HTML 净化
  - 以及 `script.js` 导出的数十个函数
- **Palink 提供**：
  - 有限的 `SillyTavernCompatRuntime` shim
  - `MessageFormatter` 钩子系统
  - 部分 API 通过 `postMessage` 模拟

### 4.2 关键 API 缺失

#### 4.2.1 上下文访问 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `getContext().chat` | 完整聊天记录数组 | 有限的消息上下文 | 高 |
| `getContext().characters` | 所有角色数据 | 仅当前角色 | 高 |
| `getContext().groups` | 群组数据 | 未提供 | 高 |
| `getContext().name1` | 用户名称 | 部分提供 | 中 |
| `getContext().name2` | 角色名称 | 部分提供 | 中 |
| `getContext().characterId` | 当前角色 ID | 提供 | 无 |
| `getContext().chatId` | 当前聊天 ID | 部分提供 | 中 |
| `getContext().onlineStatus` | 在线状态 | 未提供 | 低 |

#### 4.2.2 消息操作 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `addOneMessage()` | 添加消息到聊天 | 通过 `appendMessage` 模拟 | 中 |
| `updateMessageBlock()` | 更新消息块 | 通过 `setChatMessage` 模拟 | 中 |
| `deleteMessage()` | 删除消息 | 未实现 | 高 |
| `printMessages()` | 重新渲染消息 | 未实现 | 高 |
| `clearChat()` | 清空聊天 | 未实现 | 高 |
| `scrollChatToBottom()` | 滚动到底部 | 未实现 | 中 |
| `sendSystemMessage()` | 发送系统消息 | 未实现 | 高 |

#### 4.2.3 生成控制 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `Generate()` | 触发 AI 生成 | 通过 `sendMessage` 模拟 | 中 |
| `generateRaw()` | 原始生成 | 通过 API 端点实现 | 中 |
| `generateQuietPrompt()` | 静默生成 | 通过 API 端点实现 | 中 |
| `stopGeneration()` | 停止生成 | 未实现 | 高 |
| `sendStreamingRequest()` | 流式请求 | 未实现 | 高 |
| `sendGenerationRequest()` | 生成请求 | 未实现 | 高 |

#### 4.2.4 角色操作 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `selectCharacterById()` | 切换角色 | 未实现 | 高 |
| `setCharacterId()` | 设置角色 ID | 未实现 | 高 |
| `getCharacters()` | 获取角色列表 | 未实现 | 高 |
| `getOneCharacter()` | 获取单个角色 | 未实现 | 高 |
| `createOrEditCharacter()` | 创建/编辑角色 | 未实现 | 高 |
| `unshallowCharacter()` | 解除懒加载 | 未实现 | 低 |

#### 4.2.5 设置与存储 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `saveSettingsDebounced()` | 保存设置 | 未实现 | 高 |
| `extension_settings` | 扩展设置对象 | 通过插件配置模拟 | 中 |
| `writeExtensionField()` | 写字段 | 通过 `saveExtensionSettings` 模拟 | 中 |
| `accountStorage` | 账户存储 | 未实现 | 中 |
| `localStorage` / `sessionStorage` | 浏览器存储 | iframe 内可用（受限） | 中 |

#### 4.2.6 UI 交互 API
| API | SillyTavern 官方 | Palink 当前 | 问题等级 |
|-----|------------------|-------------|----------|
| `callPopup()` / `callGenericPopup()` | 弹窗 | 未实现 | 高 |
| `toastr` | 通知提示 | 通过 `toast` 部分实现 | 中 |
| `renderExtensionTemplateAsync()` | 渲染模板 | 未实现 | 高 |
| `showLoader()` / `hideLoader()` | 加载指示器 | 未实现 | 中 |
| `isMobile()` | 移动端检测 | 未提供 | 低 |

### 4.3 事件系统缺失

#### 4.3.1 官方事件类型（部分）
- `EVENT_CHARACTER_LOADED`
- `EVENT_CHAT_CHANGED`
- `EVENT_MESSAGE_RECEIVED`
- `EVENT_MESSAGE_SENT`
- `EVENT_MESSAGE_EDITED`
- `EVENT_MESSAGE_DELETED`
- `EVENT_STREAM_TOKEN_RECEIVED`
- `EVENT_GENERATION_ENDED`
- `EVENT_SETTINGS_UPDATED`
- `EVENT_EXTENSION_SETTINGS_LOADED`
- ... 等数十个事件

#### 4.3.2 Palink 现状
- 无事件发射器系统
- 扩展无法监听聊天状态变化
- 扩展无法响应用户交互事件

### 4.4 Slash Commands 缺失

#### 4.4.1 官方 Slash Command 系统
- 完整的命令解析器 `SlashCommandParser`
- 参数类型系统 `ARGUMENT_TYPE`
- 命令作用域 `SlashCommandScope`
- 自动补全系统
- 宏系统

#### 4.4.2 Palink 现状
- 无 Slash Command 支持
- 扩展无法注册自定义命令

---

## 五、智能角色卡（Smart Card / HTML Card）兼容性

### 5.1 渲染模式差异

#### 5.1.1 沙箱限制
- **官方**：HTML 卡片直接在主页面渲染，可访问完整 DOM
- **Palink**：默认 iframe 沙箱，限制：
  - `sandbox="allow-scripts"`（无 `allow-same-origin`）
  - 无法访问父页面 DOM
  - Cookie/Storage 隔离
  - 跨域限制

#### 5.1.2 原生模式
- **Palink**：提供"Tavern 原生模式"，需用户手动授权
- **限制**：授权仅当前会话有效，每次都需要重新授权
- **官方**：无此限制，扩展默认可运行

### 5.2 资源加载差异

#### 5.2.1 CSS/JS 加载
- **官方**：扩展的 CSS/JS 直接注入主页面
- **Palink**：通过 iframe 加载，需要代理转换
- **问题**：相对路径、字体文件、图片资源可能加载失败

#### 5.2.2 模板系统
- **官方**：Handlebars 模板引擎，支持 `renderTemplateAsync`
- **Palink**：无 Handlebars 支持
- **问题**：依赖模板的扩展无法正常工作

### 5.3 通信机制差异

#### 5.3.1 官方通信
- 扩展直接调用全局函数
- 同步/异步调用均可
- 直接操作 DOM

#### 5.3.2 Palink 通信
- `postMessage` 跨 iframe 通信
- 异步-only
- 需要序列化/反序列化
- 大量 API 被包装为 `unknownApiCall`

---

## 六、UI 配置兼容性

### 6.1 主题配置差异

#### 6.1.1 SillyTavern UI 扩展
| 配置项 | SillyTavern 官方 | Palink 当前 | 问题等级 |
|--------|------------------|-------------|----------|
| `theme` | 完整主题对象 | 部分映射 | 中 |
| `background` | 背景配置 | 部分映射 | 中 |
| `custom_css` | 自定义 CSS | 支持 | 无 |
| `message_bubbles` | 消息气泡样式 | 支持 | 无 |
| `effects` | 特效配置 | 部分支持 | 中 |

#### 6.1.2 Chroma 扩展
- **官方**：`extensions.chroma` 提供完整主题色配置
- **Palink**：部分映射到 `theme` 配置
- **差距**：部分颜色字段可能丢失

---

## 七、数据持久化差异

### 7.1 扩展设置存储

#### 7.1.1 官方机制
- `extension_settings` 对象自动保存到服务器
- 按扩展名称分命名空间
- 支持 `writeExtensionField` 细粒度写入

#### 7.1.2 Palink 机制
- 通过插件 `config` 字段存储
- `extension_settings` 嵌套在 `config` 中
- 需要手动调用 API 保存

### 7.2 聊天元数据

#### 7.2.1 官方
- `chat_metadata` 对象存储聊天级元数据
- 支持 `variables` 本地变量系统
- `saveMetadataDebounced` 自动保存

#### 7.2.2 Palink
- 无 `chat_metadata` 概念
- 无变量系统
- 扩展无法存储聊天级状态

---

## 八、安全策略差异

### 8.1 脚本执行策略

#### 8.1.1 默认行为
- **官方**：扩展 JS 默认执行（用户安装即信任）
- **Palink**：默认不执行（`execute_scripts: false`）
- **影响**：大多数扩展安装后无法立即工作

#### 8.1.2 沙箱策略
- **官方**：无沙箱，扩展拥有完整页面访问权限
- **Palink**：iframe 沙箱 + CSP
- **影响**：扩展功能受限，需要显式授权

### 8.2 正则脚本安全

#### 8.2.1 允许列表
- **官方**：角色/预设正则需要显式允许（`character_allowed_regex`）
- **Palink**：无允许列表，导入即可用
- **影响**：Palink 缺少一层安全防护

---

## 九、性能与优化差异

### 9.1 正则缓存
- **官方**：1000 条 LRU 缓存，自动重置 `lastIndex`
- **Palink**：80 条简单缓存，无 `lastIndex` 管理

### 9.2 消息处理
- **官方**：流式处理，增量更新
- **Palink**：批量处理，可能阻塞 UI

### 9.3 资源加载
- **官方**：直接加载，浏览器缓存
- **Palink**：需要代理转换，增加延迟

---

## 十、总结：兼容性矩阵

| 功能模块 | 兼容度 | 主要问题 |
|----------|--------|----------|
| 角色卡 PNG 导入 | 85% | V3 支持不完整，部分扩展字段丢失 |
| 角色卡 JSON 导入 | 90% | V1 兼容字段未处理 |
| 角色卡导出 | 70% | 仅导出 V2，V3 降级 |
| 世界书导入 | 75% | Entry extensions 全部丢失 |
| 正则脚本引擎 | 85% | 执行顺序不同，缺少允许列表 |
| 正则脚本执行 | 90% | 基础功能完整，高级功能缺失 |
| 扩展 ZIP 导入 | 80% | 资源解析良好 |
| 扩展 JS 执行 | 30% | 默认关闭，沙箱限制 |
| 扩展 API 兼容 | 40% | 大量 API 未实现或模拟 |
| 扩展事件系统 | 10% | 完全缺失 |
| Slash Commands | 0% | 完全缺失 |
| 智能角色卡渲染 | 70% | 沙箱限制，需手动授权 |
| 变量系统 | 0% | 完全缺失 |
| 聊天元数据 | 20% | 基本无支持 |

---

## 十一、优先修复建议

### P0（最高优先级）
1. **正则脚本执行顺序**：调整为 GLOBAL → SCOPED → PRESET（与官方一致）
2. **正则允许列表**：实现 `character_allowed_regex` 机制
3. **扩展 API 补齐**：至少实现 `getContext()` 的核心字段

### P1（高优先级）
4. **世界书 Entry extensions**：保留并解析所有扩展字段
5. **V3 角色卡完整支持**：不降级为 V2 导出
6. **事件系统基础**：实现最小化的事件发射器

### P2（中优先级）
7. **Slash Command 基础**：实现命令注册和解析框架
8. **聊天元数据**：实现 `chat_metadata` 存储
9. **变量系统**：实现基础局部变量

### P3（低优先级）
10. **V1 兼容字段**：处理 `creatorcomment` 等遗留字段
11. **扩展模板系统**：集成 Handlebars 或兼容层
12. **性能优化**：正则缓存扩容，消息流式处理
