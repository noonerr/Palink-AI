# Palink-AI 原生酒馆层实现计划

> 生成时间: 2026-06-12
> 目标: 参考SillyTavern架构，在Palink-AI本体预留接口，实现原生酒馆层

---

## 一、设计原则

1. **本体优先**: 先在Palink-AI本体中预留通用接口，再实现角色扮演层
2. **参考ST架构**: 借鉴SillyTavern的优秀设计模式，但用React/TypeScript重写
3. **分层设计**: 基础设施层 → 应用服务层 → 领域专属层
4. **渐进式迁移**: 保留现有iframe兼容模式，原生模式作为新选项

---

## 二、架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    原生酒馆层 (Native Roleplay)              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ 群聊系统    │ │ 世界书引擎  │ │ 表情系统    │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
├─────────────────────────────────────────────────────────────┤
│                    应用服务层 (Application Services)          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ 消息管理    │ │ 生成引擎    │ │ 提示词注入  │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
├─────────────────────────────────────────────────────────────┤
│                    基础设施层 (Infrastructure)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 事件总线 │ │ 宏引擎   │ │ 命令引擎 │ │ 变量系统 │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 正则管道 │ │ 预设管理 │ │ 插件系统 │ │ 弹窗系统 │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、基础设施层 — 需要预留的接口

### 3.1 事件总线 (EventBus)

**参考**: SillyTavern `EventEmitter` + `event_types` (100+事件)

**Palink-AI现状**: 
- `SillyTavernRuntime.EventSourceImpl` 已实现基础事件系统
- 但未统一，各模块独立实现

**需要预留的接口**:

```typescript
// frontend/src/lib/event-bus/index.ts

// 事件类型枚举
export enum PalinkEvent {
  // 应用生命周期
  APP_INITIALIZED = 'app_initialized',
  APP_READY = 'app_ready',
  
  // 消息事件
  MESSAGE_SENT = 'message_sent',
  MESSAGE_RECEIVED = 'message_received',
  MESSAGE_EDITED = 'message_edited',
  MESSAGE_DELETED = 'message_deleted',
  MESSAGE_SWIPED = 'message_swiped',
  
  // 生成事件
  GENERATION_STARTED = 'generation_started',
  GENERATION_STOPPED = 'generation_stopped',
  GENERATION_ENDED = 'generation_ended',
  STREAM_TOKEN_RECEIVED = 'stream_token_received',
  
  // 聊天事件
  CHAT_CHANGED = 'chat_changed',
  CHAT_LOADED = 'chat_loaded',
  CHAT_CREATED = 'chat_created',
  CHAT_DELETED = 'chat_deleted',
  
  // 角色事件
  CHARACTER_SELECTED = 'character_selected',
  CHARACTER_EDITED = 'character_edited',
  CHARACTER_DELETED = 'character_deleted',
  
  // 群组事件
  GROUP_UPDATED = 'group_updated',
  GROUP_CHAT_CREATED = 'group_chat_created',
  
  // 设置事件
  SETTINGS_LOADED = 'settings_loaded',
  SETTINGS_UPDATED = 'settings_updated',
  PRESET_CHANGED = 'preset_changed',
  
  // 世界书事件
  WORLDINFO_UPDATED = 'worldinfo_updated',
  WORLDINFO_SCAN_DONE = 'worldinfo_scan_done',
  
  // 变量事件
  VARIABLE_SET = 'variable_set',
  VARIABLE_DELETED = 'variable_deleted',
  
  // 扩展事件
  EXTENSION_LOADED = 'extension_loaded',
  EXTENSION_ENABLED = 'extension_enabled',
  EXTENSION_DISABLED = 'extension_disabled',
  
  // TTS事件
  TTS_JOB_STARTED = 'tts_job_started',
  TTS_AUDIO_READY = 'tts_audio_ready',
  TTS_JOB_COMPLETE = 'tts_job_complete',
  
  // 工具调用事件
  TOOL_CALLS_PERFORMED = 'tool_calls_performed',
}

// 类型安全的事件总线
class TypedEventBus<T extends Record<string, any[]>> {
  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  emit<K extends keyof T>(event: K, ...args: T[K]): void;
  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  makeLast<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  removeAllListeners(event?: keyof T): void;
}

// 全局单例
export const eventBus = new TypedEventBus<PalinkEventMap>();

// React Hook
export function useEventBus(): TypedEventBus<PalinkEventMap>;
```

**实现优先级**: P0 (基础)

---

### 3.2 宏引擎 (MacroEngine)

**参考**: SillyTavern `MacroRegistry` + `MacroEngine` + Chevrotain解析器 (5,099行)

**Palink-AI现状**: 
- `sillytavern/macros/index.ts` 有15个基础宏
- 缺少完整解析器

**需要预留的接口**:

```typescript
// frontend/src/lib/macro-engine/index.ts

// 宏分类
export enum MacroCategory {
  UTILITY = 'utility',
  RANDOM = 'random',
  NAMES = 'names',
  CHARACTER = 'character',
  CHAT = 'chat',
  TIME = 'time',
  VARIABLE = 'variable',
  STATE = 'state',
  MISC = 'misc',
}

// 宏值类型
export enum MacroValueType {
  STRING = 'string',
  INTEGER = 'integer',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
}

// 宏定义选项
export interface MacroDefinitionOptions {
  aliases?: string[];
  category?: MacroCategory;
  unnamedArgs?: number | MacroArgDef[];
  list?: boolean;
  description?: string;
  returns?: string;
  returnType?: MacroValueType;
  exampleUsage?: string[];
  delayArgResolution?: boolean;
  handler: (context: MacroExecutionContext) => string;
}

// 宏执行上下文
export interface MacroExecutionContext {
  name: string;
  args: string[];
  unnamedArgs: string[];
  list: string[] | null;
  raw: string;
  resolve: (text: string) => string;
  normalize: (value: any) => string;
  warn: (message: string) => void;
}

// 宏注册中心
class MacroRegistry {
  registerMacro(name: string, options: MacroDefinitionOptions): void;
  unregisterMacro(name: string): boolean;
  hasMacro(name: string): boolean;
  getMacro(name: string): MacroDefinition | undefined;
  getAllMacros(): MacroDefinition[];
  registerMacroAlias(target: string, alias: string): void;
  executeMacro(name: string, args: string[]): string;
}

// 宏引擎
class MacroEngine {
  evaluate(input: string, env?: Record<string, any>): string;
  addPreProcessor(handler: (text: string) => string): void;
  addPostProcessor(handler: (text: string) => string): void;
}

// 全局实例
export const macroRegistry = new MacroRegistry();
export const macroEngine = new MacroEngine();

// React Hook
export function useMacroEngine(): {
  evaluate: (text: string, env?: Record<string, any>) => string;
  registerMacro: (name: string, options: MacroDefinitionOptions) => void;
  unregisterMacro: (name: string) => void;
};
```

**实现优先级**: P0 (基础)

---

### 3.3 命令引擎 (SlashCommandEngine)

**参考**: SillyTavern `SlashCommandParser` + `SlashCommandClosure` + `SlashCommandScope` (12,000行)

**Palink-AI现状**: 
- `SillyTavernRuntime` 有基础的 `registerSlashCommand` / `executeSlashCommands`
- 仅支持简单正则替换，无解析器、闭包、作用域

**需要预留的接口**:

```typescript
// frontend/src/lib/slash-engine/index.ts

// 参数类型
export enum ARGUMENT_TYPE {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  CLOSURE = 'closure',
  SUBCOMMAND = 'subcommand',
  VARIABLE_NAME = 'variable_name',
  LIST = 'list',
  ENUM = 'enum',
}

// 命令定义
export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  returns?: string;
  namedArgs?: NamedArgDefinition[];
  unnamedArgs?: ArgDefinition[];
  callback: (namedArgs: Record<string, any>, unnamedArgs: string[]) => 
    string | Promise<string> | SlashCommandClosure;
}

// 参数定义
export interface ArgDefinition {
  description: string;
  type: ARGUMENT_TYPE[];
  isRequired?: boolean;
  defaultValue?: string;
  enumList?: string[];
}

export interface NamedArgDefinition extends ArgDefinition {
  name: string;
}

// 闭包
class SlashCommandClosure {
  scope: SlashCommandScope;
  execute(): Promise<string>;
  getCopy(): SlashCommandClosure;
}

// 作用域
class SlashCommandScope {
  parent: SlashCommandScope | null;
  pipe: string;
  
  letVariable(key: string, value?: string): void;
  setVariable(key: string, value: string): string;
  getVariable(key: string): string;
  existsVariable(key: string): boolean;
}

// 命令解析器
class SlashCommandParser {
  registerCommand(command: CommandDefinition): void;
  unregisterCommand(name: string): void;
  parse(input: string): SlashCommandClosure;
  execute(input: string): Promise<string>;
  getCompletions(input: string, position: number): CompletionItem[];
  getHelpString(commandName?: string): string;
}

// 全局实例
export const slashParser = new SlashCommandParser();

// React Hook
export function useSlashCommands(): {
  execute: (input: string) => Promise<string>;
  registerCommand: (command: CommandDefinition) => void;
  getCompletions: (input: string, position: number) => CompletionItem[];
};
```

**实现优先级**: P0 (基础)

---

### 3.4 变量系统 (VariableManager)

**参考**: SillyTavern `variables.js` (2,348行)

**Palink-AI现状**: 
- `SillyTavernRuntime` 有基础的 chat/local/global 三级变量
- 缺少持久化、JSON操作、布尔运算

**需要预留的接口**:

```typescript
// frontend/src/lib/variables/index.ts

// 变量存储接口
export interface VariableStorage {
  get(name: string, index?: string | number): string | number;
  set(name: string, value: string, index?: string | number, asType?: string): string;
  add(name: string, value: string): string | number;
  increment(name: string): string | number;
  decrement(name: string): string | number;
  delete(name: string): void;
  exists(name: string): boolean;
  list(): Record<string, string>;
}

// 变量管理器
class VariableManager {
  readonly local: VariableStorage;    // 会话级
  readonly global: VariableStorage;   // 应用级
  
  resolveVariable(name: string): string;
  evaluateBoolean(rule: string, a: string | number, b?: string | number): boolean;
  parseBooleanOperands(args: Record<string, any>): { 
    a: string | number; 
    b: string | number; 
    rule: string 
  };
}

// 布尔运算规则
export type BooleanRule = 
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'not' | 'and' | 'or';

// 全局实例
export const variableManager = new VariableManager();

// React Hook
export function useVariables(scope?: 'local' | 'global'): {
  get: (name: string) => string | number;
  set: (name: string, value: string) => void;
  increment: (name: string) => void;
  decrement: (name: string) => void;
  list: () => Record<string, string>;
};
```

**实现优先级**: P0 (基础)

---

### 3.5 正则管道 (RegexPipeline)

**参考**: SillyTavern `extensions/regex/engine.js` (465行)

**Palink-AI现状**: 
- `regexEngine.ts` 已有完整实现
- 缺少预设管理

**需要预留的接口**:

```typescript
// frontend/src/lib/regex-pipeline/index.ts

// 正则脚本
export interface RegexScript {
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
}

// 放置位置
export enum RegexPlacement {
  ALL = 0,
  USER_INPUT = 1,
  AI_OUTPUT = 2,
  SLASH_COMMAND = 3,
  REASONING = 4,
}

// 正则管道
class RegexPipeline {
  addScript(script: RegexScript): void;
  removeScript(name: string): void;
  process(input: string, placement: RegexPlacement, options?: ProcessingOptions): string;
  clearCache(): void;
  exportScripts(): string;
  importScripts(json: string): void;
}

// LRU缓存的正则提供器
class RegexProvider {
  get(pattern: string): RegExp | null;
  clear(): void;
}

// 全局实例
export const regexPipeline = new RegexPipeline();
export const regexProvider = new RegexProvider();
```

**实现优先级**: P1 (已有基础)

---

### 3.6 预设管理 (PresetManager)

**参考**: SillyTavern `preset-manager.js` (1,243行)

**Palink-AI现状**: 
- 后端有 `presets.py` API
- 前端有 `PresetSelector` 组件
- 缺少通用预设管理器

**需要预留的接口**:

```typescript
// frontend/src/lib/preset-manager/index.ts

// 预设
export interface Preset<T = Record<string, any>> {
  name: string;
  data: T;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
}

// 预设管理器
class PresetManager<T = Record<string, any>> {
  constructor(options: {
    storageKey: string;
    backend?: PresetBackend<T>;
    onChange?: (preset: Preset<T>) => void;
  });
  
  // CRUD
  getAll(): Preset<T>[];
  get(name: string): Preset<T> | undefined;
  save(name: string, data: T): Promise<void>;
  delete(name: string): Promise<void>;
  rename(oldName: string, newName: string): Promise<void>;
  
  // 选中
  getSelected(): Preset<T> | null;
  select(name: string): void;
  
  // 导入/导出
  export(names?: string[]): string;
  import(json: string): Promise<void>;
  
  // 自动匹配
  autoSelect(matchName: string): void;
}

// 后端接口
export interface PresetBackend<T> {
  loadAll(): Promise<Preset<T>[]>;
  save(preset: Preset<T>): Promise<void>;
  delete(name: string): Promise<void>;
}
```

**实现优先级**: P1 (已有基础)

---

### 3.7 插件系统 (PluginSystem)

**参考**: SillyTavern `extensions.js` (2,315行)

**Palink-AI现状**: 
- 后端有 `plugins.py` 完整API
- 前端有 `sillyTavernPluginRuntime.ts` 注入机制
- 缺少完整的生命周期管理

**需要预留的接口**:

```typescript
// frontend/src/lib/plugin-system/index.ts

// 插件清单
export interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  loadingOrder: number;
  dependencies?: string[];
  optionalDependencies?: string[];
  entry: string;
  styles?: string[];
  hooks?: {
    install?: string;
    update?: string;
    enable?: string;
    disable?: string;
    activate?: string;
  };
}

// 插件上下文
export interface PluginContext {
  // 基础设施
  eventBus: TypedEventBus<any>;
  storage: PluginStorage;
  
  // 注册能力
  registerCommand(command: CommandDefinition): void;
  registerMacro(name: string, options: MacroDefinitionOptions): void;
  registerHook(hookName: string, handler: Function): void;
  
  // 通用API
  api: {
    // 弹窗
    showPopup: (content: string, type: PopupType) => Promise<any>;
    
    // 变量
    variables: {
      local: VariableStorage;
      global: VariableStorage;
    };
    
    // 持久化
    saveSettings: () => void;
    saveMetadata: () => void;
  };
}

// 插件存储
export interface PluginStorage {
  get<T>(key: string, defaultValue?: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

// 插件管理器
class PluginManager {
  discover(): Promise<PluginManifest[]>;
  load(manifest: PluginManifest): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  getContext(pluginName: string): PluginContext;
  reload(name: string): Promise<void>;
}

// 全局实例
export const pluginManager = new PluginManager();

// React Hook
export function usePluginManager(): PluginManager;
export function usePluginContext(): PluginContext;
```

**实现优先级**: P1 (已有基础)

---

### 3.8 弹窗系统 (PopupSystem)

**参考**: SillyTavern `popup.js` (966行)

**Palink-AI现状**: 
- 有 `ConfirmDialog` 组件
- 缺少通用弹窗系统

**需要预留的接口**:

```typescript
// frontend/src/lib/popup-system/index.ts

// 弹窗类型
export enum PopupType {
  TEXT = 'text',
  CONFIRM = 'confirm',
  INPUT = 'input',
  DISPLAY = 'display',
  CUSTOM = 'custom',
}

// 弹窗结果
export enum PopupResult {
  AFFIRMATIVE = 1,
  NEGATIVE = 0,
  CANCELLED = -1,
}

// 弹窗选项
export interface PopupOptions {
  okButton?: string | boolean;
  cancelButton?: string | boolean;
  rows?: number;
  placeholder?: string;
  wide?: boolean;
  large?: boolean;
  customButtons?: CustomButton[];
}

// 弹窗管理器
class PopupManager {
  confirm(header: string, text?: string, options?: PopupOptions): Promise<PopupResult>;
  input(header: string, text?: string, defaultValue?: string, options?: PopupOptions): Promise<string | null>;
  text(header: string, text?: string, options?: PopupOptions): Promise<PopupResult>;
  custom(content: React.ReactNode, options?: PopupOptions): Promise<any>;
}

// 全局实例
export const popupManager = new PopupManager();

// React Hook
export function usePopup(): PopupManager;
```

**实现优先级**: P1 (已有基础)

---

### 3.9 国际化 (i18n)

**参考**: SillyTavern `i18n.js` (332行)

**Palink-AI现状**: 
- `frontend/src/i18n/translations.ts` 有硬编码双语翻译
- 缺少框架支持

**需要预留的接口**:

```typescript
// frontend/src/lib/i18n/index.ts

// 翻译函数
export function t(strings: TemplateStringsArray, ...values: any[]): string;
export function translate(key: string, ...values: any[]): string;

// 语言管理
export function getCurrentLocale(): string;
export function setLocale(locale: string): void;
export function addLocaleData(locale: string, data: Record<string, string>): void;

// React Hook
export function useTranslation(): {
  t: typeof t;
  locale: string;
  setLocale: (locale: string) => void;
};
```

**实现优先级**: P2 (可后置)

---

### 3.10 Tokenizer服务

**参考**: SillyTavern `tokenizers.js` (1,231行)

**Palink-AI现状**: 
- 后端有 `/api/tokenizers/{name}/{op}` 兼容端点
- 前端缺少统一服务

**需要预留的接口**:

```typescript
// frontend/src/lib/tokenizer/index.ts

// Tokenizer类型
export enum TokenizerType {
  GPT2 = 'gpt2',
  OPENAI = 'openai',
  LLAMA = 'llama',
  CLAUDE = 'claude',
  MISTRAL = 'mistral',
  BEST_MATCH = 'best_match',
}

// Tokenizer服务
class TokenizerService {
  estimate(text: string): number;
  async count(text: string, tokenizer?: TokenizerType): Promise<number>;
  async encode(text: string, tokenizer?: TokenizerType): Promise<number[]>;
  async decode(tokens: number[], tokenizer?: TokenizerType): Promise<string>;
  async list(): Promise<TokenizerInfo[]>;
  getTokenizerForModel(model: string): TokenizerType;
}

// 全局实例
export const tokenizerService = new TokenizerService();

// React Hook
export function useTokenizer(): {
  countTokens: (text: string) => Promise<number>;
  estimateTokens: (text: string) => number;
};
```

**实现优先级**: P2 (可后置)

---

## 四、应用服务层 — 需要预留的接口

### 4.1 消息管理 (MessageManager)

**参考**: SillyTavern 消息操作API

**需要预留的接口**:

```typescript
// frontend/src/services/message-manager.ts

export interface MessageManager {
  // 消息CRUD
  addMessage(message: Message, options?: { scroll?: boolean }): void;
  deleteMessage(messageId: number): void;
  editMessage(messageId: number, content: string): void;
  getMessage(messageId: number): Message | undefined;
  getMessages(): Message[];
  
  // 消息格式化
  formatMessage(content: string, options?: FormatOptions): string;
  
  // 滚动控制
  scrollToBottom(options?: { smooth?: boolean }): void;
  
  // 媒体处理
  appendMedia(messageId: number, media: MediaItem[]): void;
}
```

**实现优先级**: P0

---

### 4.2 生成引擎 (GenerationEngine)

**参考**: SillyTavern `Generate` + `generateQuietPrompt` + `generateRaw`

**需要预留的接口**:

```typescript
// frontend/src/services/generation-engine.ts

export interface GenerationEngine {
  // 主生成
  generate(options?: GenerationOptions): Promise<void>;
  
  // 静默生成（不显示在聊天中）
  generateQuietPrompt(prompt: string, options?: QuietPromptOptions): Promise<string>;
  
  // 裸文本生成
  generateRaw(prompt: string, options?: RawGenerationOptions): Promise<string>;
  
  // 停止生成
  stopGeneration(): void;
  
  // 流式状态
  isStreaming(): boolean;
}

export interface GenerationOptions {
  forceRole?: 'user' | 'assistant' | 'system';
  quiet?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface QuietPromptOptions extends GenerationOptions {
  skipFormatting?: boolean;
}
```

**实现优先级**: P0

---

### 4.3 提示词注入 (PromptInjection)

**参考**: SillyTavern `setExtensionPrompt` + `extensionPrompts`

**需要预留的接口**:

```typescript
// frontend/src/services/prompt-injection.ts

// 注入位置
export enum InjectionPosition {
  BEFORE = 0,
  AFTER = 1,
  NONE = 2,
}

// 扩展提示词
export interface ExtensionPrompt {
  identifier: string;
  prompt: string;
  position: InjectionPosition;
  depth: number;
  scan?: boolean;
  role?: 'system' | 'user' | 'assistant';
}

// 提示词注入管理器
class PromptInjectionManager {
  setExtensionPrompt(
    identifier: string,
    prompt: string,
    position: InjectionPosition,
    depth: number,
    options?: Partial<ExtensionPrompt>
  ): void;
  
  removeExtensionPrompt(identifier: string): void;
  
  getExtensionPrompts(): Map<string, ExtensionPrompt>;
  
  buildFinalPrompt(prompts: ExtensionPrompt[]): string;
}

// 全局实例
export const promptInjection = new PromptInjectionManager();
```

**实现优先级**: P0

---

## 五、实现计划

### 阶段1: 基础设施层 (2-3周)

| 任务 | 文件 | 代码量 | 优先级 |
|------|------|--------|--------|
| 事件总线 | `lib/event-bus/index.ts` | 200行 | P0 |
| 宏引擎 | `lib/macro-engine/index.ts` | 1,500行 | P0 |
| 命令引擎 | `lib/slash-engine/index.ts` | 3,000行 | P0 |
| 变量系统 | `lib/variables/index.ts` | 800行 | P0 |
| 正则管道 | `lib/regex-pipeline/index.ts` | 300行 | P1 |
| 预设管理 | `lib/preset-manager/index.ts` | 500行 | P1 |
| 插件系统 | `lib/plugin-system/index.ts` | 1,000行 | P1 |
| 弹窗系统 | `lib/popup-system/index.ts` | 600行 | P1 |

**小计**: ~8,000行

### 阶段2: 应用服务层 (1-2周)

| 任务 | 文件 | 代码量 | 优先级 |
|------|------|--------|--------|
| 消息管理 | `services/message-manager.ts` | 500行 | P0 |
| 生成引擎 | `services/generation-engine.ts` | 800行 | P0 |
| 提示词注入 | `services/prompt-injection.ts` | 400行 | P0 |
| Tokenizer | `lib/tokenizer/index.ts` | 400行 | P2 |
| i18n | `lib/i18n/index.ts` | 300行 | P2 |

**小计**: ~2,400行

### 阶段3: 原生酒馆层 (3-4周)

| 任务 | 文件 | 代码量 | 优先级 |
|------|------|--------|--------|
| 宏定义集(100+宏) | `lib/macro-engine/definitions/*.ts` | 1,500行 | P0 |
| 命令定义集(50+命令) | `lib/slash-engine/commands/*.ts` | 2,000行 | P0 |
| 群聊系统 | `services/group-chat.ts` | 2,500行 | P0 |
| 世界书引擎 | `services/worldbook-engine.ts` | 2,000行 | P0 |
| Instruct模式 | `services/instruct-mode.ts` | 800行 | P1 |
| Prompt Manager | `services/prompt-manager.ts` | 1,000行 | P1 |
| Personas | `services/personas.ts` | 600行 | P1 |
| 扩展上下文 | `lib/plugin-system/context.ts` | 800行 | P1 |

**小计**: ~11,200行

### 阶段4: 集成与UI (2-3周)

| 任务 | 文件 | 代码量 | 优先级 |
|------|------|--------|--------|
| NativeRoleplayChat | `components/roleplay/NativeRoleplayChat.tsx` | 1,500行 | P0 |
| 消息组件 | `components/roleplay/MessageItem.tsx` | 800行 | P0 |
| 群聊UI | `components/roleplay/GroupChat.tsx` | 1,000行 | P0 |
| 世界书编辑器 | `components/roleplay/WorldBookEditor.tsx` | 800行 | P1 |
| 设置页面 | `components/views/SettingsView.tsx` | 200行 | P0 |
| 切换逻辑 | `components/views/character/CharacterChat.tsx` | 300行 | P0 |

**小计**: ~4,600行

---

## 六、关键文件索引

### 需要新建的文件

```
frontend/src/lib/
├── event-bus/
│   └── index.ts                    # 事件总线
├── macro-engine/
│   ├── index.ts                    # 宏引擎核心
│   ├── registry.ts                 # 宏注册中心
│   ├── lexer.ts                    # 词法分析器
│   ├── parser.ts                   # 语法分析器
│   └── definitions/                # 宏定义集
│       ├── core.ts                 # 核心宏
│       ├── time.ts                 # 时间宏
│       ├── random.ts               # 随机宏
│       └── variable.ts             # 变量宏
├── slash-engine/
│   ├── index.ts                    # 命令引擎核心
│   ├── parser.ts                   # 命令解析器
│   ├── closure.ts                  # 闭包
│   ├── scope.ts                    # 作用域
│   └── commands/                   # 命令定义集
│       ├── core.ts                 # 核心命令
│       ├── variable.ts             # 变量命令
│       ├── chat.ts                 # 聊天命令
│       └── control.ts              # 控制命令
├── variables/
│   └── index.ts                    # 变量管理器
├── regex-pipeline/
│   └── index.ts                    # 正则管道
├── preset-manager/
│   └── index.ts                    # 预设管理器
├── plugin-system/
│   ├── index.ts                    # 插件管理器
│   ├── context.ts                  # 插件上下文
│   └── storage.ts                  # 插件存储
├── popup-system/
│   └── index.ts                    # 弹窗系统
├── tokenizer/
│   └── index.ts                    # Tokenizer服务
└── i18n/
    └── index.ts                    # 国际化

frontend/src/services/
├── message-manager.ts              # 消息管理
├── generation-engine.ts            # 生成引擎
├── prompt-injection.ts             # 提示词注入
├── group-chat.ts                   # 群聊系统
├── worldbook-engine.ts             # 世界书引擎
├── instruct-mode.ts                # Instruct模式
├── prompt-manager.ts               # Prompt Manager
└── personas.ts                     # Personas

frontend/src/components/roleplay/
├── NativeRoleplayChat.tsx          # 原生聊天组件
├── MessageItem.tsx                 # 消息项
├── GroupChat.tsx                   # 群聊UI
├── WorldBookEditor.tsx             # 世界书编辑器
└── index.ts                        # 导出
```

### 需要修改的文件

```
frontend/src/components/views/character/CharacterChat.tsx  # 添加模式切换
frontend/src/components/views/SettingsView.tsx            # 添加原生模式设置
frontend/src/lib/sillytavern/runtime.ts                   # 重构为使用新基础设施
```

---

## 七、与SillyTavern的对应关系

| SillyTavern模块 | Palink-AI对应 | 状态 |
|----------------|---------------|------|
| `EventEmitter` + `event_types` | `lib/event-bus/index.ts` | 需新建 |
| `macros/MacroRegistry` + `MacroEngine` | `lib/macro-engine/index.ts` | 需新建 |
| `slash-commands/SlashCommandParser` | `lib/slash-engine/index.ts` | 需新建 |
| `variables.js` | `lib/variables/index.ts` | 需新建 |
| `extensions/regex/engine.js` | `lib/regex-pipeline/index.ts` | 已有基础 |
| `preset-manager.js` | `lib/preset-manager/index.ts` | 需新建 |
| `extensions.js` | `lib/plugin-system/index.ts` | 需新建 |
| `popup.js` | `lib/popup-system/index.ts` | 需新建 |
| `i18n.js` | `lib/i18n/index.ts` | 需新建 |
| `tokenizers.js` | `lib/tokenizer/index.ts` | 需新建 |
| `group-chats.js` | `services/group-chat.ts` | 需新建 |
| `world-info.js` | `services/worldbook-engine.ts` | 需新建 |
| `instruct-mode.js` | `services/instruct-mode.ts` | 需新建 |
| `st-context.js` | `lib/plugin-system/context.ts` | 需新建 |

---

## 八、总结

### 工作量统计

| 阶段 | 代码量 | 工期 |
|------|--------|------|
| 阶段1: 基础设施层 | ~8,000行 | 2-3周 |
| 阶段2: 应用服务层 | ~2,400行 | 1-2周 |
| 阶段3: 原生酒馆层 | ~11,200行 | 3-4周 |
| 阶段4: 集成与UI | ~4,600行 | 2-3周 |
| **总计** | **~26,200行** | **8-12周** |

### 关键决策

1. **事件总线是基础** - 所有模块都依赖事件系统，必须最先实现
2. **宏引擎是核心** - SillyTavern的宏系统是文本处理的基础，需要完整实现
3. **命令引擎是灵魂** - 斜杠命令系统是SillyTavern可编程性的核心
4. **变量系统是胶水** - 变量系统连接各个模块，实现状态管理
5. **插件系统是扩展** - 插件系统让原生酒馆层可以被扩展

### 风险点

1. **Chevrotain依赖** - 宏引擎的词法/语法分析器需要引入Chevrotain库
2. **性能问题** - 正则管道和宏引擎的性能需要优化
3. **兼容性** - 需要保持与现有iframe模式的兼容
4. **测试覆盖** - 26,000+行代码需要充分的测试
