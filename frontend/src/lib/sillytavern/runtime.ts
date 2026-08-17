import { formatMessage, type FormatMessageContext, type FormatMessageOptions } from './formatting';
import { getRegexedString, type RegexScript, regex_placement } from './regex/engine';
import { substituteParamsExtended, type MacroEnv } from './macros';
import { eventBus, emitEvent } from '../event-bus';
import { variableManager } from '../variables/manager';
import { SlashCommandEngine } from '../slash-engine';
import { createWorldBookManager, type WorldBookManager } from '../worldbook';

export { formatMessage, FormatMessageContext, FormatMessageOptions };
export { getRegexedString, RegexScript, regex_placement };
export { substituteParamsExtended, MacroEnv };

export interface StChatMessage {
  name: string;
  mes: string;
  is_user: boolean;
  send_date?: number;
  extra?: Record<string, any>;
  swipes?: string[];
  swipe_id?: number;
  swipe_info?: any[];
  // ST 1.18.0 补全字段（均为可选，与 ST 源码对齐）
  is_system?: boolean;
  mes_id?: number;
  force_avatar?: string;
  force_name?: boolean;
  original_avatar?: string;
  avatar?: string;
  is_staged?: boolean;
  gen_id?: string;
  depth?: number;
  token_count?: number;
  is_hidden?: boolean;
  is_locked?: boolean;
}

export interface StCharacter {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  avatar?: string;
  // 方向2（逆向ST）补全字段：与 SillyTavern 角色卡规范对齐，均为可选
  depth_prompt?: {
    prompt: string;
    depth: number;
    role: 'system' | 'user' | 'assistant';
  };
  character_book?: {
    name: string;
    description: string;
    scan_depth: number;
    token_budget: number;
    recursive_scanning: boolean;
    extensions: Record<string, unknown>;
    entries: Array<{
      keys: string[];
      content: string;
      extensions: Record<string, unknown>;
      enabled: boolean;
      insertion_order: number;
      case_sensitive: boolean;
      name: string;
      priority: number;
      comment: string;
      selective: boolean;
      secondary_keys: string[];
      constant: boolean;
      position: 'before_char' | 'after_char';
    }>;
  };
  alternate_greetings?: string[];
  post_history_instructions?: string;
  system_prompt?: string;
  // ST 1.18.0 补全字段（均为可选）
  creator?: string;
  character_version?: string;
  extended_variables?: Record<string, any>;
  talkativeness?: string;
  fav?: boolean;
  date_added?: number;
  date_last_chat?: number;
  chat_size?: number;
  // ST V3 角色卡多模态资源（图标、封面、背景音乐等）
  assets?: StCharacterAsset[];
  // ST 兼容：角色卡 extensions（含 tavern_helper 变量结构），
  // 供 Tavern Helper 插件读取 schema 生成好感度等面板。
  extensions?: Record<string, any>;
}

/**
 * ST V3 角色卡 asset 项
 */
export interface StCharacterAsset {
  type?: string;      // 'icon' | 'cover' | 'background' | 'theme' | ...
  uri?: string;       // data URL 或外部 URL
  name?: string;      // 资源名
  ext?: string;       // 扩展字段
}

export interface StContext {
  name: string;
  character: StCharacter;
  chat: StChatMessage[];
  chatId: string;
  onlineStatus?: 'active' | 'idle' | 'offline';
  chatMetadata?: Record<string, any>;
  characters?: StCharacter[];
  groups?: any[];
  extensionSettings?: Record<string, any>;
  characterId?: number;
  name2?: string;
  // ST 兼容：会话级 MVU 变量（stat_data），供 Tavern Helper 插件读取并渲染面板。
  stat_data?: Record<string, any>;
}

export interface StEventSource {
  on(event: string, callback: (...args: any[]) => void): () => void;
  off(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  once(event: string, callback: (...args: any[]) => void): void;
  makeLast(event: string, callback: (...args: any[]) => void): void;
  makeFirst(event: string, callback: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;
  listenerCount(event: string): number;
}

/**
 * ST 事件名 → Palink 事件名映射表
 *
 * 注意：此映射表仅作文档参考，实际事件桥接通过手动双重 emit 实现
 * （runtime 方法中同时调用 eventSource.emit(ST事件名, ...) 和 emitEvent(Palink事件名, ...)）。
 *
 * 由于 ST 事件使用 (...args) 语义而 Palink 事件使用单 payload 语义，
 * 且两者 payload 形状不同（如 ST 的 MESSAGE_RECEIVED 传递消息对象，
 * Palink 的 message:received 传递 { sessionId, messageId }），
 * 运行时方法会分别调用 emitEvent 同步到 Palink 事件总线。
 * 此映射表用于事件名对照与未来扩展。
 *
 * 基于 ST 1.18.0 源码研究，覆盖 111 个事件，按以下分类组织：
 * - 消息事件、渲染事件、生成事件、聊天事件
 * - 角色事件、群组事件、应用生命周期事件
 * - 世界书事件、Persona 事件、连接事件
 * - 预设事件、TTS 事件、工具调用事件、变量事件
 */
export const ST_TO_PALINK_EVENT_MAP: Record<string, string> = {
  // ============================================================
  // 消息事件 (Message Events)
  // 对齐 ST 1.18.0 events.js：使用 snake_case 事件值
  // ============================================================
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_DISPLAYED: 'message_displayed',
  MESSAGE_HIDDEN: 'message_hidden',
  MESSAGE_STREAMING_STARTED: 'message_streaming_started',
  MESSAGE_STREAMING_STOPPED: 'message_streaming_stopped',

  // ============================================================
  // 渲染事件 (Render Events)
  // ============================================================
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',

  // ============================================================
  // 生成事件 (Generation Events)
  // ============================================================
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  GENERATE_AFTER_DATA: 'generate_after_data',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  GENERATION_QUEUED: 'generation_queued',
  GENERATION_CANCELED: 'generation_canceled',
  GENERATION_FAILED: 'generation_failed',
  TOKENS_COUNTED: 'tokens_counted',

  // ============================================================
  // 聊天事件 (Chat Events)
  // 注意：ST 1.18.0 中 CHAT_CHANGED='chat_id_changed', CHAT_LOADED='chatLoaded'
  // ============================================================
  CHAT_CHANGED: 'chat_id_changed',
  CHAT_LOADED: 'chatLoaded',
  CHAT_CREATED: 'chat_created',
  CHAT_DELETED: 'chat_deleted',
  CHAT_RENAMED: 'chat_renamed',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  CHAT_METADATA_UPDATED: 'chat_metadata_updated',
  CHAT_SEARCH_PERFORMED: 'chat_search_performed',
  CHAT_EXPORTED: 'chat_exported',
  CHAT_IMPORTED: 'chat_imported',

  // ============================================================
  // 角色事件 (Character Events)
  // 注意：ST 1.18.0 中 CHARACTER_DELETED='characterDeleted'（历史命名不一致）
  // ============================================================
  CHARACTER_CHANGED: 'character_changed',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_CREATED: 'character_created',
  CHARACTER_IMPORTED: 'character_imported',
  CHARACTER_EXPORTED: 'character_exported',

  // ============================================================
  // 群组事件 (Group Events)
  // ============================================================
  GROUP_UPDATED: 'group_updated',
  GROUP_CHAT_CREATED: 'group_chat_created',
  GROUP_CHAT_DELETED: 'group_chat_deleted',
  GROUP_MEMBER_DRAFTED: 'group_member_drafted',
  GROUP_WRAPPER_STARTED: 'group_wrapper_started',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
  GROUP_ACTIVATED: 'group_activated',
  GROUP_CANCELED: 'group_canceled',
  GROUP_CREATED: 'group_created',
  GROUP_DELETED: 'group_deleted',

  // ============================================================
  // 应用生命周期事件 (App Lifecycle Events)
  // ============================================================
  APP_INITIALIZED: 'app_initialized',
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  EXTENSION_SETTINGS_UPDATED: 'extension_settings_updated',
  UI_READY: 'ui_ready',

  // ============================================================
  // 世界书事件 (Worldinfo Events)
  // 注意：ST 1.18.0 中 WORLD_INFO_ACTIVATED='world_info_activated'
  // ============================================================
  WORLDINFO_UPDATED: 'worldinfo_updated',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  WORLDINFO_CREATED: 'worldinfo_created',
  WORLDINFO_DELETED: 'worldinfo_deleted',
  WORLDINFO_RENAMED: 'worldinfo_renamed',
  WORLDINFO_IMPORTED: 'worldinfo_imported',

  // ============================================================
  // Persona 事件 (Persona Events)
  // ============================================================
  PERSONA_CHANGED: 'persona_changed',
  PERSONA_CREATED: 'persona_created',
  PERSONA_UPDATED: 'persona_updated',
  PERSONA_RENAMED: 'persona_renamed',
  PERSONA_DELETED: 'persona_deleted',

  // ============================================================
  // 连接事件 (Connection Events)
  // ============================================================
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  MAIN_API_CHANGED: 'main_api_changed',
  CHATCOMPLETION_SETTINGS_CHANGED: 'chatcompletion_settings_changed',
  MODEL_CHANGED: 'model_changed',
  TRANSLATE_API_CHANGED: 'translate_api_changed',

  // ============================================================
  // 预设事件 (Preset Events)
  // ============================================================
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_LOADED: 'preset_loaded',
  PRESET_SAVED: 'preset_saved',

  // ============================================================
  // TTS 事件 (TTS Events)
  // ============================================================
  TTS_JOB_STARTED: 'tts_job_started',
  TTS_AUDIO_READY: 'tts_audio_ready',
  TTS_JOB_COMPLETE: 'tts_job_complete',
  TTS_JOB_STOPPED: 'tts_job_stopped',
  TTS_JOB_CANCELED: 'tts_job_canceled',

  // ============================================================
  // 工具调用事件 (Tool Call Events)
  // ============================================================
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  TOOL_CALLS_STARTED: 'tool_calls_started',
  TOOL_CALLS_FAILED: 'tool_calls_failed',

  // ============================================================
  // 变量事件 (Variable Events)
  // ============================================================
  VARIABLE_SET: 'variable_set',
  VARIABLE_DELETED: 'variable_deleted',
  VARIABLE_ADDED: 'variable_added',
};

/**
 * EventSourceWrapper - ST EventSource 薄包装
 *
 * 内部委托到 Palink 统一事件总线 (eventBus)，消除并行事件系统。
 * 保留 ST 兼容的方法签名：on/off/emit/once/makeLast/makeFirst/removeAllListeners/listenerCount。
 *
 * 适配策略：
 * - ST 回调的 (...args) 语义通过数组打包/解包适配 eventBus 的单 payload 模型
 * - emit(event, ...args) 将 args 打包为数组作为 eventBus 的 payload
 * - on/once/makeLast/makeFirst 注册的回调通过包装函数解包数组还原为 ...args
 * - on 返回取消订阅函数，便于调用方精确清理
 * - once 注册的监听器触发后自动从内部 Map 清理，避免引用泄漏
 * - removeAllListeners 仅清理本包装器注册的监听器，不影响 eventBus 上其他监听器
 */
class EventSourceWrapper implements StEventSource {
  /** event -> (原始回调 -> 包装回调) 的映射，用于 off/removeAllListeners 精确清理 */
  private listeners = new Map<string, Map<Function, (payload: any) => void>>();

  /** 记录通过 once 注册的包装回调，用于 makeFirst 时保留 once 语义 */
  private onceWrapped = new Set<(payload: any) => void>();

  /** 将 ST (...args) 回调包装为 eventBus (payload) 回调 */
  private wrapCallback(callback: (...args: any[]) => void): (payload: any) => void {
    return (payload: any) => {
      const args = Array.isArray(payload) ? payload : [payload];
      callback(...args);
    };
  }

  private getOrCreateEventMap(event: string): Map<Function, (payload: any) => void> {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Map());
    }
    return this.listeners.get(event)!;
  }

  on(event: string, callback: (...args: any[]) => void): () => void {
    const wrapped = this.wrapCallback(callback);
    this.getOrCreateEventMap(event).set(callback, wrapped);
    eventBus.on(event as any, wrapped as any);
    return () => this.off(event, callback);
  }

  off(event: string, callback: (...args: any[]) => void): void {
    const eventMap = this.listeners.get(event);
    if (!eventMap) return;
    const wrapped = eventMap.get(callback);
    if (wrapped) {
      eventBus.off(event as any, wrapped as any);
      eventMap.delete(callback);
      this.onceWrapped.delete(wrapped);
    }
  }

  emit(event: string, ...args: any[]): void {
    // 将 ...args 打包为数组作为 eventBus 的单 payload
    eventBus.emit(event as any, args as any);
  }

  once(event: string, callback: (...args: any[]) => void): void {
    const eventMap = this.getOrCreateEventMap(event);
    // 包装回调：触发后从内部 Map 清理，避免引用泄漏
    const wrapped = (payload: any) => {
      const args = Array.isArray(payload) ? payload : [payload];
      try {
        callback(...args);
      } finally {
        eventMap.delete(callback);
        this.onceWrapped.delete(wrapped);
      }
    };
    eventMap.set(callback, wrapped);
    this.onceWrapped.add(wrapped);
    eventBus.once(event as any, wrapped as any);
  }

  makeLast(event: string, callback: (...args: any[]) => void): void {
    // 先移除已有的同名回调，再重新注册以确保最后执行
    this.off(event, callback);
    const wrapped = this.wrapCallback(callback);
    this.getOrCreateEventMap(event).set(callback, wrapped);
    eventBus.makeLast(event as any, wrapped as any);
  }

  makeFirst(event: string, callback: (...args: any[]) => void): void {
    const eventMap = this.getOrCreateEventMap(event);

    // 如果回调已存在，先移除
    const existingWrapped = eventMap.get(callback);
    if (existingWrapped) {
      eventBus.off(event as any, existingWrapped as any);
      eventMap.delete(callback);
      this.onceWrapped.delete(existingWrapped);
    }

    // 收集所有剩余的包装监听器
    const otherEntries = Array.from(eventMap.entries());

    // 从 eventBus 移除所有监听器
    for (const [, w] of otherEntries) {
      eventBus.off(event as any, w as any);
    }

    // 创建新的包装监听器
    const wrapped = this.wrapCallback(callback);

    // 先注册新监听器（在 Set 插入顺序中排第一）
    eventBus.on(event as any, wrapped as any);

    // 重新注册其他监听器（保留 on/once 语义）
    for (const [, w] of otherEntries) {
      if (this.onceWrapped.has(w)) {
        eventBus.once(event as any, w as any);
      } else {
        eventBus.on(event as any, w as any);
      }
    }

    // 更新内部 Map
    eventMap.set(callback, wrapped);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      const eventMap = this.listeners.get(event);
      if (eventMap) {
        eventMap.forEach((wrapped) => {
          eventBus.off(event as any, wrapped as any);
          this.onceWrapped.delete(wrapped);
        });
        eventMap.clear();
      }
    } else {
      // 仅清理本包装器注册的监听器，不影响 eventBus 上其他监听器
      this.listeners.forEach((eventMap, evt) => {
        eventMap.forEach((wrapped) => {
          eventBus.off(evt as any, wrapped as any);
          this.onceWrapped.delete(wrapped);
        });
        eventMap.clear();
      });
      this.listeners.clear();
      this.onceWrapped.clear();
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

export class SillyTavernRuntime {
  private context: StContext;
  private eventSource: EventSourceWrapper;
  private macros: Map<string, string | (() => string)>;
  private extensionSettings: Record<string, any>;
  private regexScripts: {
    global: RegexScript[];
    scoped: RegexScript[];
    preset: RegexScript[];
  };
  private hooks: {
    beforeRegex: Array<(content: string, ctx: FormatMessageContext) => string>;
    afterRegex: Array<(content: string, ctx: FormatMessageContext) => string>;
    afterMarkdown: Array<(content: string, ctx: FormatMessageContext) => string>;
  };
  /**
   * WorldBookManager 实例（全局单例）。
   * 与 getContext.ts 的 stWorldBookManager 共享同一引用，
   * 确保 getContext、生成管线与 NativeRoleplayChat 使用同一实例。
   */
  private worldBookManager: WorldBookManager = stWorldBookManagerSingleton;

  constructor(initialContext?: Partial<StContext>) {
    this.context = {
      name: '',
      character: { name: '', description: '' },
      chat: [],
      chatId: '',
      onlineStatus: 'active',
      chatMetadata: {},
      characters: [],
      groups: [],
      extensionSettings: {},
      ...initialContext,
    };
    this.eventSource = new EventSourceWrapper();
    this.macros = new Map();
    this.extensionSettings = initialContext?.extensionSettings || {};
    this.regexScripts = { global: [], scoped: [], preset: [] };
    this.hooks = { beforeRegex: [], afterRegex: [], afterMarkdown: [] };
    // 将实例挂到 window，以便 worldbook/manager.ts 等模块通过 window 访问（浏览器环境才存在 window
    if (typeof window !== 'undefined') {
      (window as any).__PALINK_RUNTIME__ = this;
    }
  }

  getContext(): StContext {
    return {
      ...this.context,
      extensionSettings: { ...this.extensionSettings },
    };
  }

  setContext(ctx: Partial<StContext>) {
    const prev = { ...this.context };
    this.context = { ...this.context, ...ctx };
    if (ctx.chat && ctx.chat !== prev.chat) {
      this.eventSource.emit('chat_id_changed', this.context.chat);
      // 聊天加载事件：setContext 切换 chat 时视为加载新聊天（ST 在 openCharacterChat/openGroupChat 后触发）
      this.eventSource.emit('chatLoaded', this.context.chat);
    }
    if (ctx.character && ctx.character !== prev.character) {
      this.eventSource.emit('character_changed', this.context.character);
    }
    // 群组更新事件：groups 引用变化时触发（ST 在 updateGroupList 后触发）
    if (ctx.groups && ctx.groups !== prev.groups) {
      this.eventSource.emit('group_updated', this.context.groups);
    }
    // chat_metadata 变更事件：chatMetadata 引用变化时通知 ST 插件
    // （_chat_header 返回后 / chat 加载完成 / metadata 刷新）
    if (ctx.chatMetadata && ctx.chatMetadata !== prev.chatMetadata) {
      this.eventSource.emit('chat_metadata_updated', { metadata: this.context.chatMetadata, source: 'load' });
    }
  }

  getEventSource(): StEventSource {
    return this.eventSource;
  }

  /**
   * P-2: 触发 ST app_ready 事件（ST 1.18.0 契约）。
   * 插件在 init 中监听 event_types.APP_READY 做初始化（如 quick-reply 的
   * finalizeInit、memory 定时总结），此前 runtime 从未 emit 该事件导致
   * 插件自动执行/定时逻辑永不触发。应在所有启用插件加载完成后调用，
   * 由应用层在 pluginManager.init() resolve 后触发。
   */
  emitAppReady(): void {
    this.eventSource.emit(ST_TO_PALINK_EVENT_MAP.APP_READY);
  }

  /**
   * 获取全局共享的 WorldBookManager 实例。
   * getContext、生成管线与 NativeRoleplayChat 共享同一实例，
   * 确保世界书加载与扫描状态一致。
   */
  getWorldBookManager(): WorldBookManager {
    return this.worldBookManager;
  }

  getExtensionSettings(moduleName?: string): any {
    if (moduleName) {
      return this.extensionSettings[moduleName] || {};
    }
    return { ...this.extensionSettings };
  }

  setExtensionSettings(moduleName: string, settings: any) {
    this.extensionSettings[moduleName] = settings;
    this.eventSource.emit('extension_settings_loaded', { moduleName, settings });
  }

  setRegexScripts(globalScripts?: RegexScript[], scopedScripts?: RegexScript[], presetScripts?: RegexScript[]) {
    if (globalScripts) this.regexScripts.global = globalScripts;
    if (scopedScripts) this.regexScripts.scoped = scopedScripts;
    if (presetScripts) this.regexScripts.preset = presetScripts;
  }

  registerMacro(name: string, value: string | (() => string)) {
    this.macros.set(name, value);
  }

  unregisterMacro(name: string) {
    this.macros.delete(name);
  }

  getVariable(scope: 'chat' | 'local' | 'global', name: string): any {
    // 委托到 variableManager：chat 和 local 都映射到会话级 local 存储
    const storage = scope === 'global' ? variableManager.global : variableManager.local;
    return storage.get(name);
  }

  setVariable(scope: 'chat' | 'local' | 'global', name: string, value: any) {
    const storage = scope === 'global' ? variableManager.global : variableManager.local;
    storage.set(name, String(value));
    this.eventSource.emit('variable_set', { scope, name, value });
    // 变量更新后通知 ST 插件 chat_metadata 已变更
    if (scope !== 'global') {
      this.eventSource.emit('chat_metadata_updated', { metadata: this.context.chatMetadata, source: 'variable' });
    }
  }

  addVariable(scope: 'chat' | 'local' | 'global', name: string, value: any) {
    const storage = scope === 'global' ? variableManager.global : variableManager.local;
    storage.add(name, String(value));
    this.eventSource.emit('variable_added', { scope, name, value });
  }

  deleteVariable(scope: 'chat' | 'local' | 'global', name: string) {
    const storage = scope === 'global' ? variableManager.global : variableManager.local;
    storage.delete(name);
    this.eventSource.emit('variable_deleted', { scope, name });
    // 变量删除后通知 ST 插件 chat_metadata 已变更
    if (scope !== 'global') {
      this.eventSource.emit('chat_metadata_updated', { metadata: this.context.chatMetadata, source: 'variable' });
    }
  }

  registerSlashCommand(name: string, callback: Function, aliases?: string[], helpString?: string) {
    // 委托到 SlashCommandEngine 统一命令注册
    SlashCommandEngine.register({
      name,
      description: helpString || '',
      aliases: aliases || [],
      callback: (_namedArgs, unnamedArgs) => {
        try {
          return String(callback(unnamedArgs.join(' ')) ?? '');
        } catch (e) {
          console.error(`[ST Runtime] Slash command /${name} error:`, e);
          return '';
        }
      },
    });
  }

  async executeSlashCommands(text: string): Promise<string> {
    // 委托到 SlashCommandEngine 统一命令执行
    const result = await SlashCommandEngine.execute(text);
    return result.output;
  }

  addHook(type: 'beforeRegex' | 'afterRegex' | 'afterMarkdown', callback: (content: string, ctx: FormatMessageContext) => string) {
    this.hooks[type].push(callback);
  }

  removeHook(type: 'beforeRegex' | 'afterRegex' | 'afterMarkdown', callback: (content: string, ctx: FormatMessageContext) => string) {
    const list = this.hooks[type];
    const idx = list.indexOf(callback);
    if (idx >= 0) list.splice(idx, 1);
  }

  messageFormatting(
    rawText: string,
    characterName?: string,
    isSystem?: boolean,
    isUser?: boolean,
    messageId?: number,
    sanitizerOverrides?: Record<string, unknown>,
    isReasoning?: boolean
  ): string {
    const ctx: FormatMessageContext = {
      characterName: characterName || this.context.character?.name || '',
      isSystem: isSystem || false,
      isUser: isUser || false,
      messageId: messageId ?? -1,
      isReasoning: isReasoning || false,
      userName: this.context.name || 'User',
      modelName: '',
      dynamicMacros: Object.fromEntries(this.macros),
      sanitizerOverrides,
      encodeTagsEnabled: false,
      allowName2Display: false,
      autoFixMarkdown: true,
    };

    // 角色消息在显示时应同时执行 AI_OUTPUT(2) 放置位置的脚本（如状态栏
    // regex），与 sillyTavernDisplayPipeline.getSillyTavernRegexPlacement 保持一致；
    // 同时保留 MD_DISPLAY(0) 以兼容显示型脚本。MD_DISPLAY 始终参与，确保不漏跑。
    const regexPlacement: number | number[] = isSystem
      ? regex_placement.MD_DISPLAY
      : isReasoning
        ? regex_placement.REASONING
        : isUser
          ? [regex_placement.MD_DISPLAY, regex_placement.USER_INPUT]
          : [regex_placement.MD_DISPLAY, regex_placement.AI_OUTPUT];

    const options: FormatMessageOptions = {
      runRegex: true,
      regexPlacement,
      regexParams: {
        globalScripts: this.regexScripts.global,
        scopedScripts: this.regexScripts.scoped,
        presetScripts: this.regexScripts.preset,
        characterAvatar: this.context.character?.avatar || '',
        userName: this.context.name || 'User',
        characterName: this.context.character?.name || '',
      },
      beforeRegexHooks: this.hooks.beforeRegex,
      afterRegexHooks: this.hooks.afterRegex,
      afterMarkdownHooks: this.hooks.afterMarkdown,
    };

    return formatMessage(rawText, ctx, options);
  }

  substituteParams(text: string, env?: MacroEnv): string {
    return substituteParamsExtended(text, {
      userName: this.context.name || 'User',
      characterName: this.context.character?.name || '',
      charName: this.context.character?.name || '',
      modelName: '',
      dynamicMacros: Object.fromEntries(this.macros),
      ...env,
    });
  }

  addOneMessage(message: StChatMessage, options?: { scroll?: boolean; insertAt?: number }): number {
    const index = options?.insertAt ?? this.context.chat.length;
    const newChat = [...this.context.chat];
    newChat.splice(index, 0, message);
    this.context.chat = newChat;
    this.eventSource.emit('message_received', index, message);
    this.eventSource.emit('chat_id_changed', newChat);

    // 同步到统一事件总线
    emitEvent('message:received', {
      sessionId: this.context.chatId,
      messageId: String(index)
    });

    // 消息发送事件：用户消息时触发 MESSAGE_SENT
    // （ST 中 sendMessage 与 addOneMessage 均会触发，此处补齐 ST 兼容）
    if (message.is_user) {
      this.eventSource.emit('message_sent', index, message);
      emitEvent('message:sent', {
        sessionId: this.context.chatId,
        messageId: String(index),
        content: message.mes
      });
    }

    // 渲染事件：消息添加后触发对应渲染事件（ST 在 addOneMessage 渲染完成后触发）
    if (message.is_user) {
      this.eventSource.emit('user_message_rendered', index, message);
    } else {
      this.eventSource.emit('character_message_rendered', index, message);
    }

    return index;
  }

  setChatMessage(content: string, messageId: number, options?: { isUser?: boolean; name?: string }): boolean {
    const chat = this.context.chat;
    if (messageId < 0 || messageId >= chat.length) return false;
    const updated = [...chat];
    updated[messageId] = { ...updated[messageId], mes: content };
    if (options?.isUser !== undefined) updated[messageId].is_user = options.isUser;
    if (options?.name !== undefined) updated[messageId].name = options.name;
    this.context.chat = updated;
    this.eventSource.emit('message_edited', messageId, updated[messageId]);
    this.eventSource.emit('chat_id_changed', updated);

    // 同步到统一事件总线
    emitEvent('message:edited', {
      sessionId: this.context.chatId,
      messageId: String(messageId),
      content
    });

    return true;
  }

  updateMessageBlock(messageId: number, content: string): boolean {
    return this.setChatMessage(content, messageId);
  }

  deleteMessage(messageId: number): boolean {
    const chat = this.context.chat;
    if (messageId < 0 || messageId >= chat.length) return false;
    const updated = [...chat];
    updated.splice(messageId, 1);
    this.context.chat = updated;
    this.eventSource.emit('message_deleted', messageId);
    this.eventSource.emit('chat_id_changed', updated);

    // 同步到统一事件总线
    emitEvent('message:deleted', {
      sessionId: this.context.chatId,
      messageId: String(messageId)
    });

    return true;
  }

  swipe(messageId: number, direction: 'left' | 'right'): boolean {
    const chat = this.context.chat;
    if (messageId < 0 || messageId >= chat.length) return false;
    const msg = chat[messageId];
    const swipes = msg.swipes || [msg.mes];
    let swipeId = msg.swipe_id ?? 0;
    if (direction === 'left') swipeId = Math.max(0, swipeId - 1);
    else swipeId = Math.min(swipes.length - 1, swipeId + 1);
    const updated = [...chat];
    updated[messageId] = { ...msg, swipe_id: swipeId, mes: swipes[swipeId] || msg.mes };
    this.context.chat = updated;
    this.eventSource.emit('message_swiped', messageId, swipeId);
    this.eventSource.emit('chat_id_changed', updated);

    // 同步到统一事件总线
    emitEvent('message:swiped', {
      sessionId: this.context.chatId,
      messageId: String(messageId),
      direction
    });

    return true;
  }

  // ============================================================
  // 生成/流式事件触发方法
  //
  // 集成点：frontend/src/services/generation-engine.ts
  // 该 runtime 不在 generationEngine 的调用链中，通过
  // getGlobalSillyTavernRuntime() 在 generationEngine 内部调用以下方法，
  // 以同时触发 ST 事件（eventSource.emit）与 Palink 事件（eventBus.emit）。
  // ============================================================

  /**
   * 触发消息接收事件（ST: message_received + Palink: chat:message-received）
   * 集成点：useCharacterChat.ts 主流程 SSE 完成/websocket onDone 后调用
   */
  emitMessageReceived(messageId: number, type?: string): void {
    this.eventSource.emit('message_received', messageId, type);
    eventBus.emit('chat:message-received' as any, { messageId, type } as any);
  }

  /**
   * 触发消息渲染完成事件（ST: character_message_rendered + Palink: chat:message-rendered）
   * 集成点：useCharacterChat.ts 主流程 SSE 完成/websocket onDone 后调用
   */
  emitMessageRendered(messageId: number, type?: string): void {
    this.eventSource.emit('character_message_rendered', messageId, type);
    eventBus.emit('chat:message-rendered' as any, { messageId, type } as any);
  }

  /**
   * 触发世界书扫描完成事件（ST: worldinfo_scan_done + Palink: worldbook:scan-done）
   * 集成点：worldbook/manager.ts 的 scanAndBuildContext 在构建完成后调用
   */
  emitWorldInfoScanDone(args: any): void {
    this.eventSource.emit('worldinfo_scan_done', args);
    // K-6 修复: 同步触发 ST world_info_activated（world-info.js:902 语义，payload 为
    // 激活条目数组）。quick-reply 等插件监听该事件做世界书激活后的自动处理。
    if (Array.isArray(args?.activated)) {
      this.eventSource.emit('world_info_activated', args.activated);
    }
    eventBus.emit('worldbook:scan-done' as any, args as any);
  }

  /**
   * 触发预设切换事件（ST: preset_changed + Palink: preset:changed）
   * 集成点：CharacterView.tsx 的 setCurrentPreset 包装、PresetSelector/GenerationParamsPanel 切换预设后
   */
  emitPresetChanged(preset: { id?: unknown; name?: string } | null): void {
    this.eventSource.emit('preset_changed', preset);
    eventBus.emit('preset:changed' as any, {
      type: 'select',
      name: preset?.name || '',
    } as any);
  }

  /**
   * 触发角色卡编辑事件（ST: character_edited + Palink: character:edited）
   * 集成点：CharacterView.tsx 的 handleSaveCharacter 保存成功后
   */
  emitCharacterEdited(characterId: string): void {
    this.eventSource.emit('character_edited', characterId);
    eventBus.emit('character:edited' as any, { characterId } as any);
  }

  /**
   * 触发生成开始事件（带 type，区分 normal/regenerate/continue/swipe 等）
   * 同时触发 ST: generation_started 与 Palink: generation:started
   * 集成点：useCharacterChat.ts 的 handleSendMessage / handleRegenerate 等入口
   */
  emitGenerationStarted(type: string, options: Record<string, any> = {}): void {
    this.startGeneration(type, options);
  }

  /**
   * 触发生成结束事件（带 type 与最终响应文本）
   * 同时触发 ST: generation_ended 与 Palink: generation:ended
   * 集成点：useCharacterChat.ts 主流程 SSE 完成/websocket onDone 后调用
   *
   * Fix 4: 可选 messageId 参数。当传入时，emit 时把 messageId 放入 payload，
   * 使插件 resolveGenerationMessageId(eventPayload) 能从 { message_id } 解析出非 null 值，
   * 加强模式不再因 messageId=null 跳过。
   */
  emitGenerationEnded(type: string, message?: string, messageId?: number): void {
    this.onGenerationEnded(message ?? '', type, messageId);
  }

  /**
   * 触发生成开始事件（底层实现：同时 emit ST + Palink 事件）
   * 集成点：generationEngine.generate() 在设置 isGenerating 状态后调用
   */
  startGeneration(prompt: string, options: Record<string, any> = {}): void {
    const generationType = options.type || prompt || '';
    this.eventSource.emit('generation_started', generationType, options);
    eventBus.emit('generation:started' as any, { prompt, options, generationType } as any);
    // P1-3 修复: 同时触发 message_streaming_started（对齐 ST 1.18.0 script.js）
    // ST 在流式生成开始时触发此事件，插件常用于 UI 状态同步（禁用发送按钮等）
    this.eventSource.emit('message_streaming_started', null);
    eventBus.emit('message:streaming-started' as any, null as any);
  }

  /**
   * 触发生成停止事件
   * 集成点：generationEngine.generate() 捕获 AbortError 时调用
   */
  stopGeneration(): void {
    this.eventSource.emit('generation_stopped');
    eventBus.emit('generation:stopped' as any, {} as any);
    // P1-3 修复: 同时触发 message_streaming_stopped
    this.eventSource.emit('message_streaming_stopped', null);
    eventBus.emit('message:streaming-stopped' as any, null as any);
  }

  /**
   * 触发生成结束事件（底层实现：同时 emit ST + Palink 事件）
   * 集成点：generationEngine.generate() 成功完成时调用
   *
   * Fix 4: 当 messageId 可用时，emit 单对象 payload { message_id, message, type }
   * 作为回调首参，使插件 resolveGenerationMessageId 能解析出 messageId。
   * 兼容性：messageId 缺省时保留旧签名 (generationType, { message }) 不变。
   */
  onGenerationEnded(response: string, generationType: string = '', messageId?: number): void {
    if (typeof messageId === 'number' && Number.isFinite(messageId)) {
      // 插件 resolveGenerationMessageId 期望 eventPayload 是数字或含 message_id/messageId/id 的对象
      this.eventSource.emit('generation_ended', { message_id: messageId, message: response, type: generationType });
    } else {
      // 兼容旧签名：(generationType, { message })
      this.eventSource.emit('generation_ended', generationType, { message: response });
    }
    eventBus.emit('generation:ended' as any, { response, generationType, messageId } as any);
    // P1-3 修复: 同时触发 message_streaming_stopped（正常结束路径）
    this.eventSource.emit('message_streaming_stopped', null);
    eventBus.emit('message:streaming-stopped' as any, null as any);
    // K-6 修复: 生成结束后触发 ST GENERATION_AFTER_COMMANDS（script.js:4287 语义，
    // payload: (type, options, dryRun)）。quick-reply 的"生成后执行命令"依赖此事件。
    this.eventSource.emit('GENERATION_AFTER_COMMANDS', generationType, {}, false);
  }

  /**
   * 触发流式 token 接收事件
   * 集成点：generationEngine._generateViaSSE() 中
   * 每个 content token 接收时调用。高频触发，仅做最小化事件分发。
   */
  onStreamToken(token: string): void {
    this.eventSource.emit('stream_token_received', token);
    eventBus.emit('stream:token-received' as any, token as any);
  }

  /**
   * 触发流式推理完成事件
   * 集成点：generationEngine._generateViaSSE() 流结束/中断时调用。
   */
  onStreamReasoningDone(reasoning: string): void {
    this.eventSource.emit('stream_reasoning_done', reasoning);
    eventBus.emit('stream:reasoning-done' as any, reasoning as any);
  }
}

let globalRuntime: SillyTavernRuntime | null = null;

/**
 * 全局共享的 WorldBookManager 单例。
 * getContext.ts 的 stWorldBookManager 与 SillyTavernRuntime.worldBookManager
 * 均引用此实例，确保世界书状态在所有使用点一致。
 */
export const stWorldBookManagerSingleton: WorldBookManager = createWorldBookManager();

export function getGlobalSillyTavernRuntime(): SillyTavernRuntime | null {
  return globalRuntime;
}

export function setGlobalSillyTavernRuntime(runtime: SillyTavernRuntime | null) {
  globalRuntime = runtime;
  // Expose on window for external detection (smoke tests, ST plugins, devtools)
  if (typeof window !== 'undefined') {
    if (runtime) {
      (window as any).SillyTavern = (window as any).SillyTavern || {};
      (window as any).SillyTavern.getContext = () => runtime.getContext();
      (window as any).SillyTavern.eventSource = runtime.getEventSource();
      (window as any).getContext = () => runtime.getContext();
      (window as any).eventSource = runtime.getEventSource();
    } else {
      try {
        delete (window as any).SillyTavern;
        delete (window as any).getContext;
        delete (window as any).eventSource;
      } catch {
        // ignore
      }
    }
  }
}

export function createSillyTavernRuntime(context?: Partial<StContext>): SillyTavernRuntime {
  const runtime = new SillyTavernRuntime(context);
  setGlobalSillyTavernRuntime(runtime);
  return runtime;
}

export function destroySillyTavernRuntime() {
  if (globalRuntime) {
    globalRuntime.getEventSource().removeAllListeners();
    setGlobalSillyTavernRuntime(null);
  }
}
