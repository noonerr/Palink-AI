# Palink-AI 原生酒馆层 - 完整实施计划

> 更新时间: 2026-06-13
> 状态: 阶段1已完成，准备进入阶段2

---

## 一、当前状态

### ✅ 已完成（基础设施层 80%）

| 模块 | 路径 | 代码量 | 状态 |
|------|------|--------|------|
| 事件总线 | `lib/event-bus/` | ~400行 | ✅ |
| 宏引擎 | `lib/macro-engine/` | ~2,900行 | ✅ |
| 斜杠命令 | `lib/slash-engine/` | ~650行 | ✅ |
| 流式传输引擎 | `lib/stream-engine/` | ~260行 | ✅ |
| 错误处理 | `lib/error-handler/` | ~250行 | ✅ |
| useChatView拆分 | `hooks/useChatView/` | ~600行 | ✅ |
| CatchUpAnimator修复 | `lib/catchUpAnimator.ts` | ~100行 | ✅ |
| 共享工具函数 | `lib/utils/messageUtils.ts` | ~120行 | ✅ |
| 桥接层 | `lib/sillytavern/macros/bridge.ts` | ~120行 | ✅ |

**已完成**: ~5,400行 | **阶段1（集成验证）**: ✅ 已完成

### ⏳ 待实现

| 优先级 | 模块 | 代码量 | 依赖 |
|--------|------|--------|------|
| P0 | 变量系统 | ~1,200行 | 无 |
| P0 | 世界书引擎 | ~2,800行 | 变量系统 |
| P0 | 群聊系统 | ~3,100行 | 世界书 |
| P1 | 插件系统 | ~2,000行 | 事件总线 |
| P1 | Instruct模式 | ~800行 | 无 |
| P1 | Prompt Manager | ~1,800行 | Instruct |
| P1 | Personas | ~1,000行 | 无 |
| P2 | Reasoning显示 | ~600行 | 无 |
| P2 | 标签系统 | ~1,300行 | 无 |
| P2 | 弹窗系统 | ~600行 | 无 |

**待实现**: ~15,200行 | **预计工期**: 15-23天

---

## 二、执行计划

### 阶段1: 集成验证 ✅ 已完成

已修复的问题：
- 文件/目录遮蔽（删除3个旧文件）
- AppError向后兼容（添加getter属性）
- StreamEngine向后兼容（添加简单模式重载）
- useChatView向后兼容（添加函数签名）
- ESLint错误修复

### 阶段2: 变量系统（2-3天）

**目标**: 三级变量持久化，支持 `{{getvar}}`、`{{setvar}}` 等宏

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 2.1 | 定义变量接口 | `lib/variables/types.ts` | VariableStorage接口 |
| 2.2 | 实现本地变量 | `lib/variables/local.ts` | 会话级（chat_metadata） |
| 2.3 | 实现全局变量 | `lib/variables/global.ts` | 应用级（extension_settings） |
| 2.4 | 实现变量管理器 | `lib/variables/manager.ts` | 三级作用域统一 |
| 2.5 | 更新变量宏 | `lib/macro-engine/definitions/variable-macros.ts` | 集成新存储 |
| 2.6 | 集成到角色扮演 | `hooks/useCharacterChat.ts` | 变量持久化 |
| 2.7 | 集成到桥接层 | `lib/sillytavern/macros/bridge.ts` | 桥接变量API |

**接口设计**:
```typescript
interface VariableStorage {
  get(name: string, index?: string | number): string | number;
  set(name: string, value: string, index?: string | number): string;
  add(name: string, value: string): string | number;
  increment(name: string): string | number;
  decrement(name: string): string | number;
  delete(name: string): void;
  exists(name: string): boolean;
  list(): Record<string, string>;
}

class VariableManager {
  readonly local: VariableStorage;    // 会话级
  readonly global: VariableStorage;   // 应用级
  resolveVariable(name: string): string;
}
```

**验证**: TypeScript编译通过，变量宏可用

### 阶段3: 世界书引擎（3-4天）

**目标**: 递归扫描、预算管理、时间效果

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 3.1 | 定义世界书类型 | `lib/worldbook/types.ts` | WorldBookEntry接口 |
| 3.2 | 实现关键词扫描器 | `lib/worldbook/scanner.ts` | AND/NOT逻辑门 |
| 3.3 | 实现递归扫描 | `lib/worldbook/recursive.ts` | 条目触发其他条目 |
| 3.4 | 实现预算管理 | `lib/worldbook/budget.ts` | Token预算裁剪 |
| 3.5 | 实现时间效果 | `lib/worldbook/timed-effects.ts` | sticky/cooldown/delay |
| 3.6 | 创建世界书管理器 | `lib/worldbook/manager.ts` | 统一接口 |
| 3.7 | 集成到角色扮演 | `hooks/useCharacterChat.ts` | 注入世界书上下文 |

**核心算法**:
```
1. 获取最近N条消息
2. 对每个条目：检查主关键词 + 副关键词 + 逻辑门 + 概率 + 时间效果
3. 递归扫描（如果启用）
4. 按优先级排序
5. 按预算裁剪
6. 注入到prompt
```

**验证**: 关键词触发正常，递归扫描正常

### 阶段4: 群聊系统（3-4天）

**目标**: 多角色对话，支持多种激活策略

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 4.1 | 定义群聊类型 | `lib/group-chat/types.ts` | Group/Member接口 |
| 4.2 | 实现群聊管理器 | `lib/group-chat/manager.ts` | CRUD |
| 4.3 | 实现激活策略 | `lib/group-chat/activation.ts` | NATURAL/LIST/MANUAL/POOLED |
| 4.4 | 实现生成调度 | `lib/group-chat/scheduler.ts` | 谁说话、何时说话 |
| 4.5 | 创建群聊UI | `components/roleplay/GroupChat.tsx` | 界面 |
| 4.6 | 集成到角色扮演 | `hooks/useCharacterChat.ts` | 群聊支持 |

**激活策略**:
```typescript
enum GroupActivationStrategy {
  NATURAL = 0,  // AI决定谁说话
  LIST = 1,     // 轮流发言
  MANUAL = 2,   // 用户选择
  POOLED = 3,   // 随机选择
}
```

**验证**: 多角色对话正常，自动模式正常

### 阶段5: Instruct模式（1-2天）

**目标**: 序列模板，支持多种Instruct格式

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 5.1 | 定义Instruct类型 | `lib/instruct/types.ts` | InstructTemplate接口 |
| 5.2 | 实现模板管理器 | `lib/instruct/manager.ts` | 加载/保存/切换 |
| 5.3 | 实现格式化器 | `lib/instruct/formatter.ts` | 消息格式化 |
| 5.4 | 集成到角色扮演 | `hooks/useCharacterChat.ts` | Instruct模式 |

**模板结构**:
```typescript
interface InstructTemplate {
  name: string;
  input_sequence: string;      // 用户输入前缀
  output_sequence: string;     // 助手输出前缀
  system_sequence: string;     // 系统消息前缀
  stop_sequence: string;       // 停止序列
  names_behavior: 'none' | 'force' | 'always';
}
```

**验证**: 模板切换正常，消息格式化正常

### 阶段6: 插件系统（2-3天）

**目标**: 扩展生命周期管理

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 6.1 | 定义插件类型 | `lib/plugin-system/types.ts` | PluginManifest接口 |
| 6.2 | 实现插件管理器 | `lib/plugin-system/manager.ts` | 发现/加载/启用/禁用 |
| 6.3 | 实现插件上下文 | `lib/plugin-system/context.ts` | 扩展API门面 |
| 6.4 | 实现插件存储 | `lib/plugin-system/storage.ts` | 设置持久化 |

**验证**: 插件加载/卸载正常

### 阶段7: Prompt Manager（2-3天）

**目标**: 提示词可视化编排

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 7.1 | 定义提示词类型 | `lib/prompt-manager/types.ts` | PromptEntry接口 |
| 7.2 | 实现提示词管理器 | `lib/prompt-manager/manager.ts` | CRUD |
| 7.3 | 实现提示词编排器 | `lib/prompt-manager/orchestrator.ts` | 顺序/深度注入 |

**验证**: 提示词编排正常，深度注入正常

### 阶段8: Personas（1-2天）

**目标**: 用户角色管理

**任务**:

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 8.1 | 定义Persona类型 | `lib/personas/types.ts` | Persona接口 |
| 8.2 | 实现Persona管理器 | `lib/personas/manager.ts` | CRUD |
| 8.3 | 实现Persona选择器 | `lib/personas/selector.ts` | 切换 |

**验证**: Persona创建/切换正常

---

## 三、执行顺序

```
阶段1: 集成验证 ✅ 已完成
    ↓
阶段2: 变量系统 ← 当前
    ↓
阶段3: 世界书引擎 ← 依赖变量系统
    ↓
阶段4: 群聊系统 ← 依赖世界书
    ↓
阶段5: Instruct模式 ← 可与阶段4并行
    ↓
阶段6: 插件系统 ← 依赖事件总线
    ↓
阶段7: Prompt Manager ← 依赖Instruct
    ↓
阶段8: Personas ← 可与阶段7并行
```

---

## 四、SillyTavern可借鉴的关键文件

| 文件 | 行数 | 用途 |
|------|------|------|
| `public/scripts/variables.js` | 2,348 | 变量系统参考 |
| `public/scripts/world-info.js` | 6,289 | 世界书引擎参考 |
| `public/scripts/group-chats.js` | 2,490 | 群聊系统参考 |
| `public/scripts/extensions.js` | 2,315 | 扩展框架参考 |
| `public/scripts/instruct-mode.js` | 870 | Instruct模式参考 |
| `public/scripts/preset-manager.js` | 1,243 | 预设管理参考 |
| `public/scripts/st-context.js` | 309 | 扩展API门面参考 |

---

## 五、下一步

**立即开始**: 阶段2 - 变量系统

1. 创建 `lib/variables/types.ts` - 定义接口
2. 创建 `lib/variables/local.ts` - 本地变量存储
3. 创建 `lib/variables/global.ts` - 全局变量存储
4. 创建 `lib/variables/manager.ts` - 变量管理器
5. 更新 `lib/macro-engine/definitions/variable-macros.ts` - 集成新存储
6. 集成到 `hooks/useCharacterChat.ts`

**预计时间**: 2-3天
