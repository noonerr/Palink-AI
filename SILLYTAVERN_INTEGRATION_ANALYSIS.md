# Palink-AI vs SillyTavern 完整差距分析报告

> 生成时间: 2026-06-12
> 目标: 全面扫描Palink-AI项目，找出半成品和可从SillyTavern借鉴的内容

---

## 一、总体评估

| 维度 | Palink-AI | SillyTavern | 差距 |
|------|-----------|-------------|------|
| 后端API | ~10,025行，121个端点 | ~22,000行 | **85-90%** |
| 前端组件 | ~15,000+行 | ~75,000行 | **88%** |
| 运行时 | ~1,500行 | ~80,000行 | **20%** |
| 服务层 | ~36个核心文件 | 更多 | **80%** |

**结论**: Palink-AI的API层和UI层已经实现了SillyTavern约85-90%的核心功能，但**运行时引擎**（宏系统、斜杠命令、变量系统）是最大的短板。

---

## 二、后端API差距分析

### 已完整实现 (✅)

| 模块 | 文件 | 行数 | 端点数 | 完整度 |
|------|------|------|--------|--------|
| character.py | 角色卡CRUD | 381 | 10 | ✅ 完整 |
| character_ext.py | 角色扩展(聊天/分支/SmartCard) | 4,076 | 22 | ✅ 完整 |
| chat.py | 聊天(流式/MCP/记忆) | 440 | 4 | ✅ 完整 |
| worldbook.py | 世界书CRUD/导入 | 534 | 10 | ✅ 完整 |
| presets.py | 预设管理 | 289 | 8 | ✅ 完整 |
| tts.py | TTS语音(多供应商) | 955 | 26 | ✅ 完整 |
| image_generation.py | 文生图 | 117 | 5 | ✅ 完整 |
| silly_tavern.py | ST兼容API | 1,289 | 19 | ✅ 完整 |
| plugins.py | 插件系统 | 1,212 | 12 | ✅ 完整 |
| memory.py | 记忆压缩 | 95 | 3 | ✅ 完整 |
| models.py | 模型管理 | 360 | 8 | ✅ 完整 |
| openai_compat.py | OpenAI兼容 | 277 | 2 | ✅ 完整 |

### 缺失的API (❌)

| 功能 | SillyTavern端点 | 优先级 | 说明 |
|------|----------------|--------|------|
| **群聊API** | `/api/groups/*` | 🔴 高 | 多角色对话，ST核心功能 |
| **Persona管理** | `/api/personas/*` | 🟡 中 | 用户人设管理 |
| **背景管理** | `/api/backgrounds/*` | 🟢 低 | Palink有自己的主题系统 |
| **精灵图/表情** | `/api/sprites/*` | 🟡 中 | 角色表情切换 |
| **ST原生预设** | `/api/presets/*` | 🟢 低 | Palink已有预设系统 |
| **Embeddings** | `/v1/embeddings` | 🟢 低 | Palink已有memory模块 |

### 服务层半成品 (⚠️)

| 服务 | 完整度 | 缺少的关键功能 |
|------|--------|---------------|
| character_service.py | 75% | 搜索/筛选/收藏/批量操作/导出 |
| chat_service.py | 60% | 消息搜索/编辑/删除/重新生成/分支/导出 |
| worldbook_service.py | 70% | 递归扫描/位置控制/预览/分组 |
| plotline_service.py | 65% | 多剧情线/分支/回退/模板 |
| worldbook_import_utils.py | 40% | 独立导入工具/验证/格式转换 |
| image_generation_service.py | 75% | 多提供商/编辑/风格控制/批量 |

---

## 三、前端功能差距分析

### 已完整实现 (✅)

| 功能 | 完整度 | 说明 |
|------|--------|------|
| 角色卡管理 | ✅ 95% | 创建/编辑/导入/导出/PNG解析 |
| 角色聊天 | ✅ 95% | 流式/分支/SmartCard/Swipe/正则 |
| 世界书UI | ✅ 90% | CRUD/导入/关联/词条编辑 |
| 预设管理 | ✅ 85% | CRUD/导入/导出/选择器 |
| TTS集成 | ✅ 90% | 多供应商/声音绑定/克隆/试听 |
| 插件管理 | ✅ 80% | 列表/启禁用/设置/导入 |
| 剧情线 | ✅ 100% | StorylineMap是创新亮点(1618行) |
| SmartCard | ✅ 90% | 多模式渲染(iframe/static/inline/immersive) |
| 正则引擎 | ✅ 90% | LRU缓存/placement系统/适配器 |
| 宏系统 | ✅ 75% | 15个基础宏+扩展宏 |
| 移动端适配 | ✅ 100% | 远超SillyTavern原生 |
| MCP集成 | ✅ 100% | Palink独有优势 |
| 记忆系统 | ✅ 100% | 语义向量+用户画像+压缩 |

### 缺失或半成品 (❌/⚠️)

| 功能 | 完整度 | 缺少的关键功能 |
|------|--------|---------------|
| **群聊系统** | ❌ 15% | 仅有占位按钮，无实际UI和逻辑 |
| **宏系统** | ⚠️ 40% | 缺少Chevrotain解析器，仅15个宏(需要100+) |
| **斜杠命令** | ⚠️ 20% | 仅简单正则替换，缺少完整DSL解析器 |
| **变量系统** | ⚠️ 60% | 缺少持久化、索引访问、JSON操作、20+命令 |
| **Instruct模式** | ❌ 0% | 完全缺失 |
| **Prompt Manager** | ❌ 0% | 完全缺失 |
| **Personas** | ❌ 0% | 完全缺失 |
| **Reasoning显示** | ⚠️ 50% | 后端支持，前端无专门显示 |
| **标签系统** | ❌ 0% | 完全缺失 |
| **书签/检查点** | ⚠️ 30% | 有分支但非ST兼容格式 |
| **工具调用** | ⚠️ 40% | 有MCP但非ST兼容格式 |

---

## 四、SillyTavern可借鉴的架构设计

### 4.1 宏引擎 (Chevrotain解析器)

**路径**: `SillyTavern-1.18.0/public/scripts/macros/` (5,099行)

**核心架构**:
```
输入文本 → MacroLexer (词法分析) → MacroParser (语法分析/CST) → MacroCstWalker (遍历求值) → 输出文本
```

**可直接移植的代码**:
1. **MacroLexer** - Chevrotain词法定义，token定义清晰
2. **MacroParser** - CST Parser规则定义
3. **MacroFlags** - 完全独立，无外部依赖
4. **MacroDiagnostics** - 结构化日志模式
5. **MacroDefinitionOptions** - 优秀的接口设计

**需要重写的部分**:
1. **MacroEnvBuilder** - 依赖jQuery全局变量，需替换为React Context/hooks
2. **MacroCstWalker** - 直接调用`SillyTavern.getContext()`，需依赖注入
3. **MacroBrowser** - jQuery UI需重写为React组件

### 4.2 世界书评估引擎

**路径**: `SillyTavern-1.18.0/public/scripts/world-info.js` (6,289行)

**核心类**:
- **WorldInfoBuffer** - 扫描缓冲区，管理深度/递归/注入缓冲
- **WorldInfoTimedEffects** - 管理sticky/cooldown/delay时间效果

**可直接移植的代码**:
1. **WorldInfoBuffer类** - 核心扫描/匹配/评分逻辑与UI无关
2. **WorldInfoTimedEffects类** - 时间效果管理逻辑独立
3. **匹配算法** - matchKeys()支持正则/全词/大小写混合匹配
4. **评分系统** - getScore()的多键AND/OR/NOT逻辑

### 4.3 斜杠命令系统

**路径**: `SillyTavern-1.18.0/public/scripts/slash-commands/` (27个文件, ~12,000行)

**核心设计模式**:
- **Command Pattern** - 每个命令是SlashCommand对象
- **Parser Pattern** - 手写递归下降解析器
- **Closure/Scope Pattern** - 词法作用域闭包

**可直接移植的代码**:
1. **SlashCommand类** - 命令定义数据结构
2. **SlashCommandArgument/NamedArgument** - 参数类型系统
3. **SlashCommandScope** - 变量作用域管理
4. **SlashCommandClosure** - 闭包执行引擎核心逻辑

### 4.4 变量系统

**路径**: `SillyTavern-1.18.0/public/scripts/variables.js` (2,348行)

**可直接移植的代码**:
1. **所有CRUD函数** - get/set/add/inc/dec/exists/delete系列
2. **resolveVariable()** - 三级优先级解析逻辑
3. **parseBooleanOperands() + evalBoolean()** - 完整布尔求值引擎

### 4.5 扩展框架

**路径**: `SillyTavern-1.18.0/public/scripts/extensions.js` (2,315行)

**核心设计模式**:
- **Plugin Architecture** - manifest.json声明式配置
- **Hook System** - 生命周期钩子(install/update/delete/enable/disable/activate)
- **Settings Singleton** - extension_settings全局单例

### 4.6 群聊系统

**路径**: `SillyTavern-1.18.0/public/scripts/group-chats.js` (2,490行)

**可直接移植的代码**:
1. **策略枚举** - group_activation_strategy, group_generation_mode
2. **生成调度逻辑** - generateGroupWrapper核心调度算法
3. **队列管理** - groupChatQueueOrder的Map-based队列设计

### 4.7 TTS扩展

**路径**: `SillyTavern-1.18.0/public/scripts/extensions/tts/` (1,622行 + 36个Provider)

**可借鉴的设计**:
1. **Provider注册机制** - registerTtsProvider(name, class)允许运行时添加新引擎
2. **双队列异步流水线** - TTS生成和音频播放解耦
3. **Multi-Voice消息分段** - 按引号类型区分对话/叙述

### 4.8 正则扩展

**路径**: `SillyTavern-1.18.0/public/scripts/extensions/regex/` (2,157行 + 465行engine)

**可借鉴的设计**:
1. **三层作用域** - Global/Scoped/Preset分层管理
2. **预设系统** - 将多组正则打包为预设
3. **变更检测** - captureCurrentState() + hasStateChanged()

---

## 五、Palink-AI独有优势

| 功能 | 说明 | SillyTavern对比 |
|------|------|-----------------|
| **MCP集成** | Model Context Protocol支持 | ST无原生支持 |
| **记忆系统** | 语义向量+用户画像+压缩 | ST无内建记忆 |
| **剧情线系统** | StorylineMap(1618行) GalGame风格 | ST无此功能 |
| **SmartCard多模式** | iframe/static/inline/immersive | ST仅iframe |
| **移动端适配** | 手势/键盘/动画完整适配 | ST移动端差 |
| **TTS声音克隆** | 小米MIMO声音克隆 | ST无原生克隆 |
| **统一模型路由** | 多Provider负载均衡+Failover | ST需手动切换 |
| **角色UI定制** | 每角色独立主题/背景/气泡 | ST无此功能 |

---

## 六、分阶段实现建议

### 阶段1: 核心引擎 (2-3周)

| 任务 | 代码量 | 优先级 |
|------|--------|--------|
| 宏系统完善(Chevrotain解析器+100+宏) | 1,500行 | P0 |
| 斜杠命令基础版(核心命令) | 3,000行 | P0 |
| 变量系统完善(持久化+JSON+命令) | 1,200行 | P0 |
| 世界书评估引擎(递归扫描+预算) | 2,800行 | P0 |

### 阶段2: 社交与扩展 (2-3周)

| 任务 | 代码量 | 优先级 |
|------|--------|--------|
| 群聊系统(多角色对话) | 3,100行 | P0 |
| 扩展框架(加载/设置/事件) | 2,000行 | P0 |
| Prompt Manager(可视化编排) | 1,800行 | P1 |
| Instruct Mode(序列模板) | 800行 | P1 |

### 阶段3: 体验增强 (2周)

| 任务 | 代码量 | 优先级 |
|------|--------|--------|
| Personas(用户角色管理) | 1,000行 | P1 |
| Reasoning Display(思考链显示) | 600行 | P1 |
| Tags System(标签管理) | 1,300行 | P1 |
| 书签/检查点 | 500行 | P2 |
| 作者注释 | 400行 | P2 |
| 流式显示增强 | 400行 | P2 |

### 阶段4: 高级功能 (按需)

| 任务 | 代码量 | 优先级 |
|------|--------|--------|
| Tool Calling(ST兼容) | 1,400行 | P2 |
| 图像生成增强(触发词/多模式) | 2,000行 | P2 |
| Token Counter | 700行 | P2 |
| i18n完善 | 300行 | P2 |

---

## 七、关键文件索引

### Palink-AI核心文件

| 文件 | 行数 | 功能 |
|------|------|------|
| frontend/src/lib/sillytavern/runtime.ts | 386 | ST运行时核心 |
| frontend/src/lib/sillytavern/macros/index.ts | 90 | 宏系统 |
| frontend/src/lib/sillytavern/regex/engine.ts | 368 | 正则引擎 |
| frontend/src/lib/sillytavern/formatting.ts | 431 | 消息格式化 |
| frontend/src/components/views/character/CharacterChat.tsx | 2,737 | 角色聊天核心 |
| frontend/src/components/ui/custom/Message.tsx | 964 | 消息渲染 |
| frontend/src/components/ui/custom/StorylineMap.tsx | 1,618 | 剧情线可视化 |
| backend/app/api/silly_tavern.py | 1,289 | ST兼容API |
| backend/app/api/character_ext.py | 4,076 | 角色扩展API |

### SillyTavern核心文件

| 文件 | 行数 | 功能 |
|------|------|------|
| public/scripts/macros/ (目录) | 5,099 | 新宏引擎 |
| public/scripts/world-info.js | 6,289 | 世界书评估 |
| public/scripts/slash-commands/ (目录) | 12,000 | 斜杠命令 |
| public/scripts/variables.js | 2,348 | 变量系统 |
| public/scripts/group-chats.js | 2,490 | 群聊系统 |
| public/scripts/extensions.js | 2,315 | 扩展框架 |
| public/scripts/instruct-mode.js | 870 | Instruct模式 |
| public/scripts/preset-manager.js | 1,243 | 预设管理 |
| public/scripts/st-context.js | 309 | 扩展API门面 |
| public/scripts/extensions/tts/ (目录) | 1,622+36 | TTS扩展 |
| public/scripts/extensions/vectors/ | 2,358 | 向量嵌入 |
| public/scripts/extensions/regex/ | 2,157+465 | 正则扩展 |
| public/scripts/extensions/expressions/ | 2,576 | 表情识别 |
| public/scripts/extensions/stable-diffusion/ | 5,998 | SD图像生成 |

---

## 八、总结

### Palink-AI现状
- **API层**: 85-90%完整，核心链路已通
- **UI层**: 88%完整，移动端和剧情线是亮点
- **运行时**: 20%完整，是最大短板
- **独有优势**: MCP、记忆系统、剧情线、SmartCard、移动端

### 最大的3个差距
1. **宏系统** - 仅15个宏，需要100+和完整解析器
2. **群聊系统** - 仅有占位按钮
3. **斜杠命令** - 仅简单正则替换

### 建议的实现顺序
1. 先补齐宏系统和斜杠命令(基础引擎)
2. 再实现群聊系统(用户最期待的功能)
3. 然后补充扩展框架和Instruct模式
4. 最后处理低优先级功能

### 预计工期
- **最小可用版本**: 6-8周
- **功能完整版本**: 12-15周
