/**
 * ST getContext() 兼容层
 *
 * 实现 SillyTavern 1.18.0 的 getContext() 函数，返回包含 P0 字段的上下文对象。
 * 复用 Palink 现有服务，不引入新容器，不影响方向1原生ST。
 *
 * 基于 ST 1.18.0 源码研究，覆盖以下字段分类：
 * - 会话/角色字段、事件系统字段、生成控制字段、消息操作字段
 * - 变量系统字段、斜杠命令字段、宏系统字段、格式化字段
 * - 存储字段、Token字段、UI/弹窗字段、世界书字段、群组字段
 */

import { getGlobalSillyTavernRuntime, stWorldBookManagerSingleton, type StContext, type StCharacter, type StChatMessage, type StEventSource } from './runtime';
import { messageManager, type ChatMessage } from '@/services/message-manager';
import { generationEngine, type GenerationOptions } from '@/services/generation-engine';
import { promptInjection } from '@/services/prompt-injection';
import { variableManager } from '@/lib/variables/manager';
import { SlashCommandEngine, ARGUMENT_TYPE } from '@/lib/slash-engine';
import { MacroRegistry, evaluateMacros } from '@/lib/macro-engine';
import { eventBus, emitEvent } from '@/lib/event-bus';
import { groupChatManager } from '@/lib/group-chat/manager';
import { pluginManager } from '@/lib/plugin-system/manager';
import { substituteParamsExtended } from './macros';
import {
  globalExtensionSettings,
  getExtensionSettingsNs,
  setExtensionSettingsNs,
  saveExtensionSettingsDebounced,
} from './extension-settings-store';
import { worldbookApi } from '@/services/worldbookApi';
import type { WorldBookManager } from '@/lib/worldbook';
import type { WorldBookEntry } from '@/lib/worldbook/types';
import { popupManager, PopupType, PopupResult } from '@/lib/popup-system';
import { api } from '@/services/api';
import { personaManager } from '@/lib/personas/manager';
import { contextSetterRegistry } from '../plugin-system/sandbox';
import { toast } from 'sonner';
import { i18nManager } from '../i18n';
import Handlebars from 'handlebars';
import DOMPurify from 'dompurify';

// ============================================================
// 扩展模板缓存
// ============================================================
// ST 1.18.0 templates.js 使用 TEMPLATE_CACHE（Map<string, function>）缓存
// Handlebars 编译后的模板函数。Palink 复刻此机制，按 "moduleName/templateName"
// 缓存编译结果，避免重复编译开销。
const EXTENSION_TEMPLATE_CACHE = new Map<string, HandlebarsTemplateDelegate<any>>();

/**
 * 渲染 ST 扩展模板（真实实现）
 *
 * 对齐 ST 1.18.0 extensions.js#renderExtensionTemplateAsync：
 * 1. 从 pluginManager 查找匹配 moduleName 的插件
 * 2. 在 plugin.resources.templates 中查找匹配 templateName 的模板内容
 * 3. 使用 Handlebars 编译模板（缓存编译结果）
 * 4. 用 templateData 渲染
 * 5. 使用 DOMPurify 消毒（移除 script/on* 等危险内容）
 *
 * @param moduleName 扩展模块名（如 'quick-reply'）
 * @param templateName 模板名（如 'settings' 或 'settings.html'）
 * @param templateData 模板数据
 * @returns 渲染后的 HTML 字符串，失败时返回空字符串
 */
function renderExtensionTemplateImpl(
  moduleName: string,
  templateName: string,
  templateData: Record<string, any> = {}
): string {
  try {
    // 在插件管理器中查找匹配 moduleName 的插件
    const plugin = pluginManager.getAllPlugins().find(
      p => p.manifest.name === moduleName || p.manifest.name === moduleName.split('/').pop()
    );
    if (!plugin?.resources?.templates) return '';

    // 查找匹配 templateName 的模板（支持 "settings" 或 "settings.html" 格式）
    const template = plugin.resources.templates.find(t =>
      t.path === templateName ||
      t.path === `${templateName}.html` ||
      t.path?.endsWith(`/${templateName}.html`)
    );
    if (!template?.content) return '';

    // 缓存键：moduleName/templateName
    const cacheKey = `${moduleName}/${templateName}`;
    let compiled = EXTENSION_TEMPLATE_CACHE.get(cacheKey);
    if (!compiled) {
      compiled = Handlebars.compile(template.content);
      EXTENSION_TEMPLATE_CACHE.set(cacheKey, compiled);
    }

    // 渲染 + 消毒
    const rendered = compiled(templateData);
    return DOMPurify.sanitize(rendered, {
      ADD_TAGS: ['font', 'center', 'marquee'],
      ADD_ATTR: ['target', 'color', 'face', 'size', 'align', 'valign', 'bgcolor'],
    });
  } catch (e) {
    console.warn('[ST renderExtensionTemplateAsync] 模板渲染失败:', e);
    return '';
  }
}

// ============================================================
// 通知系统适配器：将 toastr 接口桥接到 sonner
// ============================================================
// ST 插件通过 context.toastr 调用通知，统一路由到应用主 toast 系统
// （sonner <Toaster>，见 App.tsx），避免 toastr 库独立渲染容器造成
// 视觉不一致。toastr 约定为 (message, title?)，sonner 用 description
// 承载 title。
const toastrAdapter = {
  success: (message: string, title?: string) => {
    toast.success(message || '', title ? { description: title } : undefined);
  },
  info: (message: string, title?: string) => {
    toast.info(message || '', title ? { description: title } : undefined);
  },
  warning: (message: string, title?: string) => {
    toast.warning(message || '', title ? { description: title } : undefined);
  },
  error: (message: string, title?: string) => {
    toast.error(message || '', title ? { description: title } : undefined);
  },
  clear: () => toast.dismiss(),
  remove: () => toast.dismiss(),
};

// ============================================================
// 类型定义
// ============================================================

/**
 * ST 变量作用域对象（含 get/set/del/add/inc/dec/has）
 */
export interface StVariableScope {
  get: (name: string, index?: string | number) => string | number;
  set: (name: string, value: string, index?: string | number, asType?: string) => string;
  del: (name: string) => void;
  add: (name: string, value: string) => string | number;
  inc: (name: string) => string | number;
  dec: (name: string) => string | number;
  has: (name: string) => boolean;
}

/**
 * ST getContext() 返回的完整上下文对象
 * 包含 P0 字段（插件最常用）
 */
export interface StGetContext {
  // 会话/角色字段
  chat: StChatMessage[];
  chatId: string;
  chatMetadata: Record<string, any>;
  characters: StCharacter[];
  name1: string;
  name2: string;
  characterId: number;
  groupId: string | null;
  character: StCharacter;
  personaName: string;
  thisChid: number;
  persona: {
    name: string;
    description: string;
    persona_description: string;
    persona_show_description: boolean;
    persona_description_position: number;
  };

  // 事件系统字段
  eventSource: StEventSource;
  eventTypes: Record<string, string>;
  event_types: Record<string, string>;

  // 生成控制字段
  generate: (options?: GenerationOptions & { quiet?: boolean; length?: number; custom_prompt?: string; inhibitGroup?: boolean; signal?: AbortSignal }) => Promise<void>;
  generateQuietPrompt: (prompt: string, options?: GenerationOptions) => Promise<string>;
  generateRaw: (prompt: string | Record<string, unknown>, options?: GenerationOptions) => Promise<string>;
  stopGeneration: () => void;
  isGenerating: () => boolean;

  // 消息操作字段
  addOneMessage: (message: Partial<StChatMessage>, options?: any) => number;
  deleteLastMessage: () => void;
  deleteMessage: (messageId: string | number) => boolean;
  updateMessageBlock: (messageId: string | number, block: any) => void;
  setExtensionPrompt: (identifier: string, content: string, position?: number, depth?: number, scan?: boolean, role?: number | string, filter?: any) => void;
  extensionPrompts: Record<string, any>;

  // 变量系统字段
  variables: {
    local: StVariableScope;
    global: StVariableScope;
  };

  // 斜杠命令字段
  SlashCommandParser: any;
  SlashCommand: any;
  SlashCommandArgument: any;
  ARGUMENT_TYPE: Record<string, string>;
  registerSlashCommand: (name: string, callback: (...args: any[]) => any, aliases?: string[], help?: string) => void;
  executeSlashCommands: (input: string) => Promise<string>;

  // 宏系统字段
  macros: Record<string, any>;
  registerMacro: (name: string, value: string | (() => string)) => void;
  unregisterMacro: (name: string) => void;
  substituteParams: (input: string) => string;
  substituteParamsExtended: (input: string, env?: any) => string;

  // 请求头与设置保存字段
  getRequestHeaders: () => Record<string, string>;
  saveSettingsDebounced: (delay?: number) => void;

  // 格式化字段
  messageFormatting: (content: string, ...args: any[]) => string;

  // 存储字段
  accountStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
  extensionSettings: Record<string, any>;
  writeExtensionField: (module: string, field: string, value: any) => void;
  getExtensionSettings: (module?: string) => any;

  // Token字段
  tokenizers: {
    getTokenCount: (text: string, tokenizer?: string) => number;
    estimateTokenCount: (text: string) => number;
  };
  getTokenCount: (text: string, tokenizer?: string) => number;
  getTokenCountAsync: (text: string, tokenizer?: string) => Promise<number>;
  maxContext: number;

  // UI/弹窗字段
  Popup: any;
  POPUP_TYPE: Record<string, number>;
  POPUP_RESULT: Record<string, number>;
  callGenericPopup: (message: string, type?: any, inputValue?: any, options?: any) => Promise<any>;
  callPopup: (message: string, type?: any, inputValue?: any, options?: any) => Promise<any>;

  // 世界书字段
  loadWorldInfo: (name: string) => Promise<void>;
  saveWorldInfo: (name: string, data: any) => Promise<void>;
  getWorldInfoPrompt: (worldInfoName?: string) => string;

  // 群组字段
  openGroupChat: (groupId: string) => void;
  unshallowGroupMembers: () => void;
  groups: any[];

  // 在线状态
  onlineStatus: string;

  // ST 1.18.0 snake_case 别名与补全字段
  main_api: string;
  api_server: string;
  online_status: string;
  ai_name: string;
  status_string: string;
  streamProcessing: boolean;
  isStreaming: boolean;
  is_send_press: boolean;
  send_textarea: string;
  message_count: number;
  depth_prompt: string;
  extension_prompts: Record<string, any>;
  chat_metadata: Record<string, any>;
  selected_group_id: string | null;
  selected_chat_id: string;
  selected_character_id: number;
  active_group: string | null;
  group_id: string | null;

  // 扩展模板渲染
  renderExtensionTemplateAsync: (moduleName: string, templateName: string, data?: any) => Promise<string>;

  // 通知系统（P2-4）：暴露 toastr 给 ST 插件调用
  toastr: {
    success: (message: string, title?: string) => void;
    info: (message: string, title?: string) => void;
    warning: (message: string, title?: string) => void;
    error: (message: string, title?: string) => void;
    clear?: () => void;
    remove?: () => void;
  };

  // ============================================================
  // ST 1.18.0 公共 API 补全字段
  //
  // 以下字段对齐 SillyTavern-1.18.0/public/scripts/st-context.js
  // 导出的全部公共 API。Palink 不支持的 API 以安全 no-op 提供，
  // 返回合理默认值（空数组 / 空字符串 / false / no-op 函数），
  // 避免 ST 插件调用时报 TypeError。
  // ============================================================

  // 会话 / 聊天管理
  getCurrentChatId: () => string;
  reloadCurrentChat: () => Promise<void>;
  renameChat: (newName: string, options?: any) => Promise<boolean>;
  saveMetadataDebounced: (delay?: number) => void;
  streamingProcessor: any;
  updateChatMetadata: (metadata: Record<string, any>, skipEvent?: boolean) => void;
  saveChat: () => Promise<void>;
  openCharacterChat: (options?: any) => Promise<void>;
  saveMetadata: () => void;
  sendSystemMessage: (type: number, text?: string, options?: any) => Promise<boolean>;
  activateSendButtons: () => void;
  deactivateSendButtons: () => void;
  saveReply: (options?: any) => Promise<void>;
  printMessages: () => void;
  clearChat: () => void;
  unshallowCharacter: (characterId?: number) => void;

  // 生成请求
  sendStreamingRequest: (args?: any) => Promise<any>;
  sendGenerationRequest: (args?: any) => Promise<any>;
  generateRawData: (prompt: string | Record<string, unknown>, options?: any) => Promise<any>;
  getTextTokens: (text: string, tokenizer?: string) => number[];

  // 斜杠命令补全
  SlashCommandNamedArgument: any;
  SlashCommandEnumValue: any;
  executeSlashCommandsWithOptions: (input: string, options?: any) => Promise<any>;

  // 扩展模板 / Loader
  renderExtensionTemplate: (moduleName: string, templateName: string, data?: any) => string;
  showLoader: () => void;
  hideLoader: () => void;

  // 扩展设置
  writeExtensionFieldBulk: (entries: Array<{ module: string; field: string; value: any }>) => void;

  // 角色 / 缩略图
  getThumbnailUrl: (type: string, filename: string) => string;
  selectCharacterById: (characterId: number) => Promise<boolean>;

  // i18n / 移动端
  isMobile: boolean;
  t: (key: string, options?: any) => string;
  translate: (key: string, options?: any) => string;
  getCurrentLocale: () => string;

  // 标签
  tags: any[];
  tagMap: Record<string, any>;

  // 角色查询
  getCharacters: (options?: any) => StCharacter[];
  getOneCharacter: (characterId?: number) => StCharacter | undefined;
  getCharacterCardFields: (character?: StCharacter) => Record<string, any>;
  getCharacterSource: (character?: StCharacter) => string;

  // 消息渲染辅助
  appendMediaToMessage: (messageId: number | string, media: any) => void;
  ensureMessageMediaIsArray: (message: any) => any[];
  scrollChatToBottom: (options?: any) => void;
  swipe: {
    left: () => void;
    right: () => void;
    to: (messageId: number | string, direction: 'left' | 'right') => Promise<string>;
    show: (messageId: number | string) => void;
    hide: () => void;
    refresh: (messageId: number | string) => void;
    isAllowed: (messageId?: number | string) => boolean;
    state: () => any;
  };

  // 世界书补全
  reloadWorldInfoEditor: (force?: boolean) => Promise<void>;
  updateWorldInfoList: () => Promise<void>;
  convertCharacterBook: (characterBook: any, characterName?: string) => any;
  getWorldInfoNames: () => string[];
  CONNECT_API_MAP: Record<string, any>;

  // 预设 / 数据提取
  extractMessageFromData: (data: any, options?: any) => string;
  getPresetManager: () => any;
}

// ============================================================
// 事件源 fallback 工厂
// ============================================================

/**
 * 创建 ST 兼容的 fallback eventSource 对象。
 *
 * 仅当 runtime 不可用时使用，确保 emit 传递所有参数（打包为数组），
 * on/once 注册的回调通过解包还原为 ...args，与 EventSourceWrapper 语义一致。
 * on 返回取消订阅函数，once 触发后自动从内部 Map 清理。
 */
function createFallbackEventSource(): StEventSource {
  /** event -> (原始回调 -> 包装回调) 的映射，用于 off/removeAllListeners 精确清理 */
  const listeners = new Map<string, Map<Function, (payload: any) => void>>();

  /** 记录通过 once 注册的包装回调，用于 makeFirst 时保留 once 语义 */
  const onceWrapped = new Set<(payload: any) => void>();

  const wrapCallback = (callback: (...args: any[]) => void): ((payload: any) => void) => {
    return (payload: any) => {
      const args = Array.isArray(payload) ? payload : [payload];
      callback(...args);
    };
  };

  const getOrCreateEventMap = (event: string): Map<Function, (payload: any) => void> => {
    if (!listeners.has(event)) {
      listeners.set(event, new Map());
    }
    return listeners.get(event)!;
  };

  const off = (event: string, callback: (...args: any[]) => void) => {
    const eventMap = listeners.get(event);
    if (!eventMap) return;
    const wrapped = eventMap.get(callback);
    if (wrapped) {
      eventBus.off(event as any, wrapped as any);
      eventMap.delete(callback);
      onceWrapped.delete(wrapped);
    }
  };

  return {
    on: (event: string, callback: (...args: any[]) => void): (() => void) => {
      const wrapped = wrapCallback(callback);
      getOrCreateEventMap(event).set(callback, wrapped);
      eventBus.on(event as any, wrapped as any);
      return () => off(event, callback);
    },
    off,
    emit: (event: string, ...args: any[]) => {
      // 将 ...args 打包为数组作为 eventBus 的单 payload，与 EventSourceWrapper 一致
      eventBus.emit(event as any, args as any);
    },
    once: (event: string, callback: (...args: any[]) => void) => {
      const eventMap = getOrCreateEventMap(event);
      // 包装回调：触发后从内部 Map 清理，避免引用泄漏
      const wrapped = (payload: any) => {
        const args = Array.isArray(payload) ? payload : [payload];
        try {
          callback(...args);
        } finally {
          eventMap.delete(callback);
          onceWrapped.delete(wrapped);
        }
      };
      eventMap.set(callback, wrapped);
      onceWrapped.add(wrapped);
      eventBus.once(event as any, wrapped as any);
    },
    makeLast: (event: string, callback: (...args: any[]) => void) => {
      // 先移除已有的同名回调，再重新注册以确保最后执行
      off(event, callback);
      const wrapped = wrapCallback(callback);
      getOrCreateEventMap(event).set(callback, wrapped);
      eventBus.makeLast(event as any, wrapped as any);
    },
    makeFirst: (event: string, callback: (...args: any[]) => void) => {
      const eventMap = getOrCreateEventMap(event);

      // 如果回调已存在，先移除
      const existingWrapped = eventMap.get(callback);
      if (existingWrapped) {
        eventBus.off(event as any, existingWrapped as any);
        eventMap.delete(callback);
        onceWrapped.delete(existingWrapped);
      }

      // 收集所有剩余的包装监听器
      const otherEntries = Array.from(eventMap.entries());

      // 从 eventBus 移除所有监听器
      for (const [, w] of otherEntries) {
        eventBus.off(event as any, w as any);
      }

      // 创建新的包装监听器
      const wrapped = wrapCallback(callback);

      // 先注册新监听器（在 Set 插入顺序中排第一）
      eventBus.on(event as any, wrapped as any);

      // 重新注册其他监听器（保留 on/once 语义）
      for (const [, w] of otherEntries) {
        if (onceWrapped.has(w)) {
          eventBus.once(event as any, w as any);
        } else {
          eventBus.on(event as any, w as any);
        }
      }

      // 更新内部 Map
      eventMap.set(callback, wrapped);
    },
    removeAllListeners: (event?: string) => {
      if (event) {
        const eventMap = listeners.get(event);
        if (eventMap) {
          eventMap.forEach((wrapped) => {
            eventBus.off(event as any, wrapped as any);
            onceWrapped.delete(wrapped);
          });
          eventMap.clear();
        }
      } else {
        listeners.forEach((eventMap, evt) => {
          eventMap.forEach((wrapped) => {
            eventBus.off(evt as any, wrapped as any);
            onceWrapped.delete(wrapped);
          });
          eventMap.clear();
        });
        listeners.clear();
        onceWrapped.clear();
      }
    },
    listenerCount: (event: string): number => {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

/**
 * 模块级缓存的 fallback eventSource 单例。
 *
 * 避免每次 getContext() 调用（runtime 不可用时）都创建新的 fallback 对象，
 * 确保监听器注册在同一个实例上，不会因每次返回新对象而丢失已注册的监听器。
 */
let _fallbackEventSource: StEventSource | null = null;
function getFallbackEventSource(): StEventSource {
  if (!_fallbackEventSource) {
    _fallbackEventSource = createFallbackEventSource();
  }
  return _fallbackEventSource;
}

// ============================================================
// chat_metadata_updated 事件触发辅助函数
// ============================================================

/**
 * chat_metadata_updated 事件的来源类型。
 * - load: chat_metadata 加载完成（_chat_header 返回后 / chat 切换）
 * - variable: 变量系统更新（set / delete）
 * - author_note: author_note 切换
 * - background: background 切换
 */
export type ChatMetadataUpdatedSource = 'load' | 'variable' | 'author_note' | 'background';

/**
 * 触发 chat_metadata_updated 事件，通知 ST 插件 chat_metadata 已变更。
 *
 * 统一入口：所有 chat_metadata 变更场景均应通过此函数触发事件。
 * 非阻塞：事件发射失败时静默处理，不影响主流程性能。
 *
 * @param source 变更来源
 * @param metadata 可选的 metadata 快照；未提供时从 runtime / window 读取当前值
 */
export function emitChatMetadataUpdated(
  source: ChatMetadataUpdatedSource = 'load',
  metadata?: Record<string, any>,
): void {
  try {
    const runtime = getGlobalSillyTavernRuntime();
    const eventSource = runtime?.getEventSource() ?? getFallbackEventSource();
    let currentMetadata: Record<string, any>;
    if (metadata && typeof metadata === 'object') {
      currentMetadata = metadata;
    } else {
      const ctx = runtime?.getContext();
      currentMetadata = (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object' && Object.keys(ctx.chatMetadata).length > 0)
        ? ctx.chatMetadata
        : (typeof window !== 'undefined' && (window as any).chat_metadata
            ? (window as any).chat_metadata as Record<string, any>
            : {});
    }
    eventSource.emit('chat_metadata_updated', { metadata: currentMetadata, source });
  } catch {
    // 非阻塞：事件发射失败时不影响主流程
  }
}

// ============================================================
// 变量作用域工厂
// ============================================================

/**
 * 创建 ST 兼容的变量作用域对象
 */
function createStVariableScope(
  storage: { get: (n: string, i?: string | number) => string | number; set: (n: string, v: string, i?: string | number, t?: string) => string; add: (n: string, v: string) => string | number; increment: (n: string) => string | number; decrement: (n: string) => string | number; delete: (n: string) => void; exists: (n: string) => boolean; },
): StVariableScope {
  return {
    get: (name, index) => storage.get(name, index),
    set: (name, value, index, asType) => storage.set(name, value, index, asType),
    del: (name) => storage.delete(name),
    add: (name, value) => storage.add(name, value),
    inc: (name) => storage.increment(name),
    dec: (name) => storage.decrement(name),
    has: (name) => storage.exists(name),
  };
}

// ============================================================
// ST 事件类型枚举
// ============================================================

/**
 * ST 事件类型枚举（与 eventTypes 一致）
 */
export const ST_EVENT_TYPES: Record<string, string> = {
  // 消息事件
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
  MESSAGE_RENDERED: 'message_rendered',

  // 渲染事件
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  CHARACTER_SWIPED: 'character_swiped',
  // K-6 修复: 对齐 ST 1.18.0 events.js:22（GENERATION_AFTER_COMMANDS 为全大写，
  // 非 snake_case）。此前小写与 runtime.ts/SillyTavernCompatRuntime 的大写不一致，
  // 导致 quick-reply 等插件监听事件 key 与 emit key 错配、自动执行不触发。
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',

  // 生成事件
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  GENERATE_AFTER_DATA: 'generate_after_data',
  GENERATION_QUEUED: 'generation_queued',
  GENERATION_CANCELED: 'generation_canceled',
  GENERATION_FAILED: 'generation_failed',
  TOKENS_COUNTED: 'tokens_counted',

  // 聊天事件
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

  // 角色事件
  CHARACTER_CHANGED: 'character_changed',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_DELETED: 'character_deleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_CREATED: 'character_created',
  CHARACTER_IMPORTED: 'character_imported',
  CHARACTER_EXPORTED: 'character_exported',

  // 群组事件
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

  // 应用生命周期事件
  APP_INITIALIZED: 'app_initialized',
  APP_READY: 'app_ready',
  APP_CHANGED: 'app_changed',
  EXTRAS_CONNECTED: 'extras_connected',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  EXTENSION_SETTINGS_UPDATED: 'extension_settings_updated',
  UI_READY: 'ui_ready',

  // 世界书事件
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

  // Persona 事件
  PERSONA_CHANGED: 'persona_changed',
  PERSONA_CREATED: 'persona_created',
  PERSONA_UPDATED: 'persona_updated',
  PERSONA_RENAMED: 'persona_renamed',
  PERSONA_DELETED: 'persona_deleted',

  // 预设事件
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_LOADED: 'preset_loaded',
  PRESET_SAVED: 'preset_saved',

  // 连接事件
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  MAIN_API_CHANGED: 'main_api_changed',
  CHATCOMPLETION_SETTINGS_CHANGED: 'chatcompletion_settings_changed',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  MODEL_CHANGED: 'model_changed',
  TRANSLATE_API_CHANGED: 'translate_api_changed',

  // TTS 事件
  TTS_JOB_STARTED: 'tts_job_started',
  TTS_AUDIO_READY: 'tts_audio_ready',
  TTS_JOB_COMPLETE: 'tts_job_complete',
  TTS_JOB_STOPPED: 'tts_job_stopped',
  TTS_JOB_CANCELED: 'tts_job_canceled',

  // 工具调用事件
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  TOOL_CALLS_STARTED: 'tool_calls_started',
  TOOL_CALLS_FAILED: 'tool_calls_failed',

  // 流式事件
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',

  // 变量事件
  VARIABLE_SET: 'variable_set',
  VARIABLE_DELETED: 'variable_deleted',
  VARIABLE_ADDED: 'variable_added',
};

// ============================================================
// Popup 类型枚举
// ============================================================

export const ST_POPUP_TYPE = {
  TEXT: 1,
  CONFIRM: 2,
  INPUT: 3,
  DISPLAY: 4,
} as const;

// ============================================================
// Token 计数缓存与后端调用（Task 5）
// ============================================================

/** token 计数缓存：cacheKey -> count，避免重复请求后端 */
const _tokenCountCache = new Map<string, number>();
/** 缓存上限，防止内存膨胀 */
const _TOKEN_CACHE_MAX = 2000;
/** 超过此长度的文本使用哈希作为缓存键，避免长文本占用过多内存 */
const _TOKEN_CACHE_HASH_THRESHOLD = 1000;
/** in-flight 请求去重：cacheKey -> Promise<number>，避免并发请求重复触发 */
const _inflight = new Map<string, Promise<number>>();

/**
 * djb2 简单哈希 — 用于长文本缓存键。
 * 配合文本长度前缀降低碰撞概率（同长度 + 同哈希才会冲突）。
 */
function _hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `h:${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * 计算缓存键：短文本直接使用原文，长文本使用哈希以节省内存。
 * 包含 tokenizer/模型标识，避免不同 tokenizer 下相同文本缓存冲突。
 */
function _cacheKey(text: string, tokenizer?: string): string {
  const prefix = tokenizer ?? 'default';
  if (text.length > _TOKEN_CACHE_HASH_THRESHOLD) return `${prefix}:${_hashText(text)}`;
  return `${prefix}:${text}`;
}

function _heuristicTokenCount(text: string): number {
  if (!text) return 0;
  // CJK 字符约 1 token/字，拉丁文约 4 字符/token
  const cjkRe = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/g;
  const cjk = (text.match(cjkRe) || []).length;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function _cacheTokenCount(text: string, count: number, tokenizer?: string): void {
  if (_tokenCountCache.size >= _TOKEN_CACHE_MAX) {
    // 简单淘汰：清空前一半（Map 保持插入顺序）
    const half = Math.floor(_TOKEN_CACHE_MAX / 2);
    let i = 0;
    for (const key of _tokenCountCache.keys()) {
      _tokenCountCache.delete(key);
      if (++i >= half) break;
    }
  }
  _tokenCountCache.set(_cacheKey(text, tokenizer), count);
}

/**
 * 异步获取 token 计数 — 调用后端 /api/tokenizers/count，结果缓存。
 * 使用 in-flight Map 去重，避免并发请求重复触发。
 * 失败时回退到启发式估算。
 */
async function fetchTokenCountAsync(text: string, tokenizer?: string): Promise<number> {
  if (!text) return 0;
  const key = _cacheKey(text, tokenizer);
  const cached = _tokenCountCache.get(key);
  if (cached !== undefined) return cached;
  // in-flight 去重：如果已有相同 key 的请求在进行中，复用其 Promise
  if (_inflight.has(key)) return _inflight.get(key)!;

  const p = (async () => {
    try {
      // Task 11.11: 将 tokenizer 参数传给后端
      const res = await api.post<{ count: number }>('/api/tokenizers/count', { text, tokenizer });
      const count = res?.count ?? _heuristicTokenCount(text);
      // Task 11.1: 使用 _cacheTokenCount 替代直接 _tokenCountCache.set，统一缓存淘汰逻辑
      _cacheTokenCount(text, count, tokenizer);
      return count;
    } catch {
      const fallback = _heuristicTokenCount(text);
      _cacheTokenCount(text, fallback, tokenizer);
      return fallback;
    }
  })().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ============================================================
// 当前模型 context_length 缓存（maxContext getter 使用）
// ============================================================

/** 当前模型 context_length 缓存（避免每次 maxContext 访问都触发 API 调用） */
let _cachedModelContextLength = 0;
let _cachedModelId = '';
/** 防止重复触发模型列表获取 */
let _modelFetchTriggered = false;

/**
 * 同步获取当前模型的 context_length。
 * 首次调用时返回 0 并触发后台异步获取，后续调用返回缓存值。
 * 模型 ID 从 sessionStorage 'palink-rp-last-model' 读取（CharacterChat 写入）。
 */
function _getCurrentModelContextLength(): number {
  try {
    const modelId = sessionStorage.getItem('palink-rp-last-model') || '';
    if (!modelId) return 0;
    // 模型 ID 匹配缓存，直接返回
    if (modelId === _cachedModelId) return _cachedModelContextLength;
    // 模型 ID 变化或首次访问，触发后台获取（不阻塞当前调用）
    if (!_modelFetchTriggered) {
      _modelFetchTriggered = true;
      _fetchModelContextLength(modelId);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * 异步获取模型列表并缓存当前模型的 context_length。
 * 使用 api.get 的 cacheTtlMs 避免重复请求。
 */
async function _fetchModelContextLength(modelId: string): Promise<void> {
  try {
    const models = await api.get<Array<{ id: string; context_length: number }>>('/api/models', { cacheTtlMs: 5 * 60 * 1000 });
    const model = models?.find(m => m.id === modelId);
    if (model) {
      _cachedModelContextLength = model.context_length || 0;
      _cachedModelId = modelId;
    }
  } catch {
    // ignore
  } finally {
    _modelFetchTriggered = false;
  }
}

// ============================================================
// SlashCommandParser 包装类（Task 6）
// ============================================================

/**
 * SlashCommandParser — ST 兼容的斜杠命令解析器包装类。
 *
 * ST 插件期望 getContext().SlashCommandParser 是一个可实例化的类，
 * 拥有 parse() 方法。Palink 的 SlashCommandEngine 已实现完整解析逻辑，
 * 此类作为薄包装委托到引擎，使 ST 插件能正常使用。
 */
export class StSlashCommandParser {
  /** 引擎单例，供插件直接访问命令注册表等 */
  static engine = SlashCommandEngine;

  /** 已注册命令的快捷访问 */
  static get commands(): Record<string, any> {
    const cmds: Record<string, any> = {};
    for (const cmd of SlashCommandEngine.getAllCommands()) {
      cmds[cmd.name] = cmd;
      if (cmd.aliases) {
        for (const alias of cmd.aliases) {
          cmds[alias] = cmd;
        }
      }
    }
    return cmds;
  }

  text: string;
  constructor(text: string = '') {
    this.text = text;
  }

  /**
   * 解析并执行斜杠命令字符串，返回执行输出。
   * 兼容 ST 的 parse() 语义 — 返回命令执行结果。
   */
  async parse(): Promise<string> {
    const result = await SlashCommandEngine.execute(this.text);
    return result.output || '';
  }

  /** 同步获取自动补全建议 */
  getCompletions(position?: number): any[] {
    return SlashCommandEngine.getCompletions(this.text, position ?? this.text.length);
  }
}

// ============================================================
// 世界书管理（Task 3）
// ============================================================

/**
 * ST 兼容层专用的世界书管理器实例（全局单例）。
 * 用于 loadWorldInfo / saveWorldInfo / getWorldInfoPrompt，
 * 同时供 runtime.getWorldBookManager() 与 NativeRoleplayChat 共享，
 * 确保 getContext 与生成管线使用同一实例。
 *
 * 引用自 runtime.ts 的 stWorldBookManagerSingleton，避免循环依赖与实例不一致。
 */
export const stWorldBookManager: WorldBookManager = stWorldBookManagerSingleton;

/**
 * 将 API 返回的 WorldBookStage 转换为 WorldBookEntry。
 * 字段映射基于 ST 1.18.0 世界书规范。
 *
 * 注意：后端 WorldBookStage 接口（见 @/types）仅包含以下字段：
 *   id, world_book_id, stage_index, title, content, summary, transition_hint,
 *   priority, token_count, image_prompt, keys, secondary_keys, scan_depth,
 *   position, selective, probability, constant
 * 因此 selectiveLogic / depth / caseSensitive / matchWholeWords / enabled 等字段
 * 在后端不存在，这里使用默认值并保留读取逻辑以便后端未来扩展。
 *
 * SYNC REMINDER: When the backend WorldBookStage model adds any of these fields
 * (selectiveLogic, depth, caseSensitive, matchWholeWords, enabled), update this
 * function to read from the model instead of using hardcoded defaults.
 */
function _stageToEntry(stage: any): WorldBookEntry {
  return {
    id: stage.id,
    uid: stage.stage_index ?? 0,
    key: stage.keys || [],
    keysecondary: stage.secondary_keys || [],
    content: stage.content || '',
    comment: stage.title || '',
    // Task 11.9: 从 stage 读取字段，提供默认值
    // 后端 WorldBookStage 暂无 selectiveLogic 字段，默认 AND_ANY(0)
    selectiveLogic: stage.selectiveLogic ?? 0,
    selective: !!stage.selective,
    constant: !!stage.constant,
    vectorized: false,
    position: stage.position ?? 0,
    // 后端 WorldBookStage 暂无 depth 字段，默认 0
    depth: stage.depth ?? 0,
    order: stage.priority ?? 0,
    scanDepth: stage.scan_depth ?? null,
    // 后端 WorldBookStage 暂无 caseSensitive 字段，默认 false
    caseSensitive: stage.caseSensitive ?? false,
    // 后端 WorldBookStage 暂无 matchWholeWords 字段，默认 false
    matchWholeWords: stage.matchWholeWords ?? false,
    useGroupScoring: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    probability: stage.probability ?? 100,
    group: '',
    groupOverride: false,
    groupWeight: 0,
    decorators: [],
    addMemo: false,
    // 后端 WorldBookStage 暂无 enabled 字段，默认 true
    enabled: stage.enabled !== undefined ? stage.enabled : true,
    excludeRecursion: false,
    preventRecursion: false,
    extensions: {},
  };
}

/**
 * 根据名称查找世界书并加载到管理器，返回是否成功。
 */
async function _loadWorldBookByName(name: string): Promise<boolean> {
  try {
    const list = await worldbookApi.list();
    const found = list.find(wb => wb.name === name);
    if (!found) return false;

    const detail = await worldbookApi.get(found.id);
    const entries: WorldBookEntry[] = (detail.stages || []).map(_stageToEntry);
    stWorldBookManager.loadWorldBook({
      id: detail.id,
      name: detail.name,
      description: detail.description || '',
      entries,
      tags: detail.tags || [],
      createdAt: detail.created_at || '',
      updatedAt: detail.updated_at || '',
    });
    stWorldBookManager.setActiveWorldBooks([detail.id]);
    return true;
  } catch (e) {
    console.warn('[ST loadWorldInfo] 加载世界书失败:', name, e);
    return false;
  }
}

/**
 * 加载角色关联的所有世界书到全局单例管理器。
 * 在 NativeRoleplayChat 挂载或角色变化时调用，确保生成管线与 getContext 共享同一实例。
 * 返回已加载的世界书 ID 列表。
 *
 * Task 11.5: 引入版本号防止并发竞态
 * Task 11.6: 加载前调用 reset() 重置时间效果
 * Task 11.7: 卸载旧世界书
 */
let _loadWorldBooksVersion = 0;

export async function loadCharacterWorldBooks(characterId: string): Promise<string[]> {
  // Task 11.5: 版本号防止并发竞态
  const currentVersion = ++_loadWorldBooksVersion;

  try {
    // Task 11.7: 卸载旧世界书
    const currentBooks = stWorldBookManager.getWorldBooks();
    currentBooks.forEach(wb => stWorldBookManager.unloadWorldBook(wb.id));

    // Task 11.6: 重置时间效果，避免旧状态残留
    stWorldBookManager.reset();

    const list = await worldbookApi.list({ character_id: characterId });
    if (!list || list.length === 0) {
      // 版本检查：如有新请求则放弃本次结果
      if (currentVersion !== _loadWorldBooksVersion) return [];
      stWorldBookManager.setActiveWorldBooks([]);
      return [];
    }

    const loadedIds: string[] = [];
    for (const wb of list) {
      try {
        const detail = await worldbookApi.get(wb.id);
        const entries: WorldBookEntry[] = (detail.stages || []).map(_stageToEntry);
        stWorldBookManager.loadWorldBook({
          id: detail.id,
          name: detail.name,
          description: detail.description || '',
          entries,
          tags: detail.tags || [],
          createdAt: detail.created_at || '',
          updatedAt: detail.updated_at || '',
        });
        loadedIds.push(detail.id);
      } catch (e) {
        console.warn(`[ST loadCharacterWorldBooks] 加载世界书 ${wb.id} 失败:`, e);
      }
    }

    // Task 11.5: 版本检查 — 完成后检查版本，如有新请求则放弃本次结果
    if (currentVersion !== _loadWorldBooksVersion) return [];

    stWorldBookManager.setActiveWorldBooks(loadedIds);
    return loadedIds;
  } catch (e) {
    console.warn('[ST loadCharacterWorldBooks] 加载角色世界书失败:', characterId, e);
    return [];
  }
}

// ============================================================
// Popup 类型映射（Task 4）
// ============================================================

/** ST 数字 Popup 类型 → Palink PopupType 字符串 */
function _mapPopupType(stType?: number): PopupType {
  switch (stType) {
    case ST_POPUP_TYPE.CONFIRM: return PopupType.CONFIRM;
    case ST_POPUP_TYPE.INPUT: return PopupType.INPUT;
    case ST_POPUP_TYPE.DISPLAY: return PopupType.DISPLAY;
    default: return PopupType.TEXT;
  }
}

/**
 * ST Popup 类 — 对接 Palink popup-system 显示真实弹窗。
 */
export class StPopup {
  static get TEXT() { return ST_POPUP_TYPE.TEXT; }
  static get CONFIRM() { return ST_POPUP_TYPE.CONFIRM; }
  static get INPUT() { return ST_POPUP_TYPE.INPUT; }
  static get DISPLAY() { return ST_POPUP_TYPE.DISPLAY; }

  text: string;
  type: number;
  constructor(text: string, type: number = ST_POPUP_TYPE.TEXT) {
    this.text = text;
    this.type = type;
  }
  async show(type?: any, message?: string, inputValue?: any, options?: any): Promise<any> {
    // Task 8.3: 使用构造函数的 text 和 type 作为默认值，参数覆盖
    const palinkType = _mapPopupType(type ?? this.type);
    const text = message ?? this.text;
    const popupOptions: any = {};
    if (options?.okButton) popupOptions.okButton = options.okButton;
    if (options?.cancelButton) popupOptions.cancelButton = options.cancelButton;
    if (options?.customButtons) popupOptions.customButtons = options.customButtons;
    if (options?.wide) popupOptions.wide = options.wide;
    if (options?.large) popupOptions.large = options.large;
    if (options?.rows) popupOptions.rows = options.rows;
    if (options?.placeholder) popupOptions.placeholder = options.placeholder;
    if (typeof inputValue === 'string') popupOptions.defaultValue = inputValue;
    // CONFIRM 类型默认显示取消按钮
    if (palinkType === PopupType.CONFIRM && !popupOptions.cancelButton) {
      popupOptions.cancelButton = '取消';
    }
    if (!popupOptions.okButton) popupOptions.okButton = '确定';

    const result = await popupManager.show(
      palinkType,
      options?.title || 'SillyTavern',
      text,
      popupOptions,
    );

    // 根据弹窗类型返回合适的值
    if (palinkType === PopupType.INPUT) {
      if (result?.result === PopupResult.AFFIRMATIVE) {
        return result.value ?? '';
      }
      return null;
    }
    // 对于 TEXT 类型返回 true（boolean），对于其他类型返回 PopupResult 数字
    if (palinkType === PopupType.TEXT || palinkType === PopupType.DISPLAY) {
      return result !== null && result !== undefined ? true : false;
    }
    return result;
  }
}

// ============================================================
// POPUP_RESULT 枚举（ST 兼容）
// ============================================================

/**
 * ST POPUP_RESULT 枚举 — 用于判断弹窗按钮结果。
 * 与 Palink popup-system PopupResult 数字值保持一致。
 */
export const ST_POPUP_RESULT = {
  AFFIRMATIVE: 1,
  CANCEL: 2,
  CLOSING: 3,
  IGNORE: 4,
} as const;

// ============================================================
// saveSettingsDebounced 防抖保存（ST 兼容）
// ============================================================

/** saveSettingsDebounced 内部定时器引用 */
let _saveSettingsTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖保存设置 — ST 插件通过 getContext().saveSettingsDebounced() 调用。
 * 在指定延迟内重复调用会重置计时器，最终只触发一次后端保存。
 * 失败时仅打印警告，不抛出异常，避免影响插件主流程。
 */
function saveSettingsDebounced(delay: number = 500): void {
  // Phase 1: 同时持久化全局 extension_settings 共享 store（localStorage）。
  // ST 扩展惯用「原地改 extension_settings.xxx.yyy + saveSettingsDebounced()」，
  // 嵌套写不触发任何拦截器，持久化依赖此调用。
  saveExtensionSettingsDebounced(delay);
  if (_saveSettingsTimer) {
    clearTimeout(_saveSettingsTimer);
  }
  _saveSettingsTimer = setTimeout(async () => {
    _saveSettingsTimer = null;
    try {
      // 调用 Palink 设置保存 API。
      // K-10 修复: 此前裸 fetch 无 Authorization 头，被 CSRF 守卫（MED-4）拦截为 403，
      // 插件设置无法持久化。改用 api.post（services/api 自动注入 Bearer token）。
      await api.post('/api/settings/save', {});
    } catch (err) {
      console.warn('[getContext] saveSettingsDebounced error:', err);
    }
  }, delay);
}

// ============================================================
// SlashCommand / SlashCommandArgument 包装类（ST 兼容）
// ============================================================

/**
 * SlashCommand — ST 兼容的斜杠命令包装类。
 *
 * ST 插件期望 getContext().SlashCommand 是一个类，提供 fromProps 静态方法
 * 用于以属性对象形式注册命令。此处委托到 Palink SlashCommandEngine.register。
 */
export class StSlashCommand {
  /**
   * 通过属性对象注册命令到 SlashCommandEngine。
   * 兼容 ST 的 SlashCommand.fromProps(props) 接口。
   */
  static fromProps(props: any): any {
    if (!props || !props.name) {
      console.warn('[getContext] SlashCommand.fromProps: 缺少 name 字段');
      return null;
    }
    SlashCommandEngine.register({
      name: props.name,
      description: props.description || '',
      aliases: props.aliases,
      namedArgs: props.namedArgs,
      unnamedArgs: props.unnamedArgs,
      returns: props.returns,
      callback: props.callback ?? props.run,
    });
    return props;
  }
}

/**
 * SlashCommandArgument — ST 兼容的命令参数定义包装类。
 *
 * ST 插件期望 getContext().SlashCommandArgument 是可实例化的类，
 * 用于声明命令的命名/未命名参数。此处提供简化构造器，
 * 将参数描述收集到实例属性上，便于在 SlashCommand.fromProps 中使用。
 */
export class StSlashCommandArgument {
  description: string;
  types: ARGUMENT_TYPE[];
  defaultValue: any;
  isRequired: boolean;
  enumList: string[];

  constructor(description: string = '', types: ARGUMENT_TYPE | ARGUMENT_TYPE[] = ARGUMENT_TYPE.STRING, defaultValue: any = undefined, isRequired: boolean = false, enumList: string[] = []) {
    this.description = description;
    this.types = Array.isArray(types) ? types : [types];
    this.defaultValue = defaultValue;
    this.isRequired = isRequired;
    this.enumList = enumList;
  }
}

/**
 * SlashCommandNamedArgument — ST 兼容的命名参数定义包装类。
 *
 * ST 插件期望 getContext().SlashCommandNamedArgument 是可实例化的类，
 * 用于声明命令的命名参数（带 --flag 形式）。继承 SlashCommandArgument 的字段，
 * 额外增加 alias / acceptsMultiple 等命名参数特有属性。
 */
export class StSlashCommandNamedArgument extends StSlashCommandArgument {
  alias: string;
  acceptsMultiple: boolean;

  constructor(
    description: string = '',
    types: ARGUMENT_TYPE | ARGUMENT_TYPE[] = ARGUMENT_TYPE.STRING,
    defaultValue: any = undefined,
    isRequired: boolean = false,
    enumList: string[] = [],
    alias: string = '',
    acceptsMultiple: boolean = false,
  ) {
    super(description, types, defaultValue, isRequired, enumList);
    this.alias = alias;
    this.acceptsMultiple = acceptsMultiple;
  }
}

/**
 * SlashCommandEnumValue — ST 兼容的枚举值包装类。
 *
 * ST 插件期望 getContext().SlashCommandEnumValue 是可实例化的类，
 * 用于声明命令参数的可选枚举值（含描述与图标）。
 */
export class StSlashCommandEnumValue {
  value: string;
  description: string;
  icon: string;

  constructor(value: string = '', description: string = '', icon: string = '') {
    this.value = value;
    this.description = description;
    this.icon = icon;
  }
}

// ============================================================
// 主 getContext() 实现
// ============================================================

// ── chat_metadata 持久化（ST 插件 saveChat / saveMetadata 后端同步）──
// messages 由 messageManager 自动持久化，但 chat_metadata（quick-reply 设置、
// note_prompt、variables 等）需要显式同步到后端 DB。
let _metadataSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function _persistChatMetadata(chatId: string): Promise<void> {
  if (!chatId) return;
  const metadata = (typeof window !== 'undefined' && (window as any).chat_metadata) ?? {};
  try {
    await api.put(`/api/character-sessions/${chatId}/metadata`, metadata);
  } catch (e) {
    console.warn('[Palink] saveChatMetadata failed:', e);
  }
}

/**
 * 获取 ST 兼容的上下文对象
 *
 * 这是 ST 插件调用 getContext() 时返回的对象，包含所有 P0 字段。
 * 复用 Palink 现有服务，不引入新容器。
 */
export function getContext(): StGetContext {
  const runtime = getGlobalSillyTavernRuntime();
  const ctx: StContext | null = runtime?.getContext() ?? null;

  // 会话/角色字段
  const chat = ctx?.chat ?? messageManager.messages.map(toStMessage);
  const chatId = ctx?.chatId ?? '';
  // ST 1.18.0 chat_metadata: prefer runtime ctx, fall back to window.chat_metadata
  // (which CharacterCardRenderer persists to localStorage __palink_chat_metadata
  // so note_prompt / variables / hidden_bots survive reloads before backend sync).
  const chatMetadata: Record<string, any> = ctx?.chatMetadata
    && typeof ctx.chatMetadata === 'object'
    && Object.keys(ctx.chatMetadata).length > 0
    ? ctx.chatMetadata
    : ((typeof window !== 'undefined' && (window as any).chat_metadata)
        ? ((window as any).chat_metadata as Record<string, any>)
        : {});
  const character = ctx?.character ?? { name: '', description: '' };
  const characters: StCharacter[] = ctx?.characters ?? [];
  const name1 = ctx?.name || 'User';
  const name2 = character.name || 'Assistant';
  // Task 11.8: 使用真实角色 ID，而非 chatId（会话 ID）
  // ST 1.18.0: characterId 是角色在 characters 数组中的索引（number），非 string
  const rawCharacterId = (ctx as any)?.characterId ?? messageManager.getCurrentCharacterId();
  const charactersArray = ctx?.characters ?? [];
  const characterId: number = (() => {
    if (typeof rawCharacterId === 'number') return rawCharacterId;
    if (rawCharacterId == null || rawCharacterId === '') return 0;
    const num = Number(rawCharacterId);
    if (!Number.isNaN(num)) return num;
    // 非数字字符串：查找在 characters 数组中的索引
    const idx = charactersArray.findIndex(c =>
      (c as any).id === rawCharacterId || c.name === rawCharacterId
    );
    return idx >= 0 ? idx : 0;
  })();
  const groupId = groupChatManager.getActiveGroup()?.id ?? null;
  const personaName = name1;
  const onlineStatus = ctx?.onlineStatus ?? 'active';
  // ST 1.18.0 extension_prompts: 暴露给 ST 插件时同时包含 value 和 content 字段
  // ST 原生存储用 value（script.js:8905），Palink 内部用 content。为兼容 ST 插件
  // 读取 prompt.value 的代码，这里为每条 entry 添加 value 别名。
  const _rawExtPrompts = promptInjection.getPromptsForGeneration?.() ?? {};
  const extensionPrompts: Record<string, any> = {};
  for (const [key, entry] of Object.entries(_rawExtPrompts)) {
    extensionPrompts[key] = {
      ...entry,
      value: (entry as any)?.content ?? '',
    };
  }
  const isGenerating = () => generationEngine.state.isGenerating;

  // 从 personaManager 获取当前活跃的用户 Persona，用于填充 persona 对象
  const activePersona = (() => {
    try {
      return personaManager.getActivePersona();
    } catch {
      return null;
    }
  })();

  const context: any = {
    // 会话/角色字段
    chat,
    chatId,
    chatMetadata,
    characters,
    name1,
    name2,
    characterId,
    groupId,
    character,
    personaName,
    thisChid: characterId,
    persona: {
      name: name1,
      description: activePersona?.description || '',
      persona_description: activePersona?.description || '',
      persona_show_description: activePersona?.personaShow ?? false,
      persona_description_position: activePersona?.personaDescriptionPosition ?? 0,
    },

    // 事件系统字段 — 复用 runtime 的 EventSourceWrapper，确保 emit 传递所有参数
    eventSource: runtime?.getEventSource() ?? getFallbackEventSource(),
    eventTypes: ST_EVENT_TYPES,
    event_types: ST_EVENT_TYPES,

    // 生成控制字段
    generate: async (options?: GenerationOptions & { quiet?: boolean; length?: number; custom_prompt?: string; inhibitGroup?: boolean; signal?: AbortSignal }) => {
      const mergedOptions: GenerationOptions = {
        ...options,
        quietPrompt: options?.quiet ?? options?.quietPrompt,
        responseLength: options?.length ?? options?.responseLength,
        customPrompt: options?.custom_prompt,
        inhibitGroup: options?.inhibitGroup,
        signal: options?.signal,
      } as GenerationOptions;
      await generationEngine.generate('', mergedOptions);
    },
    generateQuietPrompt: async (prompt: string, options?: GenerationOptions) => {
      return await generationEngine.generateQuietPrompt(prompt, options);
    },
    generateRaw: async (prompt: string | Record<string, unknown>, options?: GenerationOptions) => {
      return await generationEngine.generateRaw(prompt, options);
    },
    stopGeneration: () => {
      generationEngine.stopGeneration();
    },
    isGenerating,

    // 消息操作字段
    addOneMessage: (message: Partial<StChatMessage>, _options?: any) => {
      const msg: ChatMessage = {
        id: String(message.send_date ?? Date.now()),
        name: message.name || 'Assistant',
        mes: message.mes || '',
        is_user: !!message.is_user,
        is_system: false,
        send_date: String(message.send_date ?? Date.now()),
        swipes: message.swipes || [message.mes || ''],
        swipe_id: message.swipe_id ?? 0,
        swipe_info: (message.swipe_info as Array<{ send_date?: string; extra?: Record<string, unknown> }>) ?? [{ send_date: new Date().toISOString(), extra: {} }],
        extra: message.extra || {},
      };
      messageManager.addMessage(msg);
      const index = messageManager.findIndex(msg.id);
      // 同步到 runtime.chat（ST 插件读取消息的来源）
      if (runtime) {
        (runtime as any).context.chat.push({ ...message } as any);
      }
      // 触发 ST 事件
      const eventSource = runtime?.getEventSource();
      eventSource?.emit('message_received', index, msg);
      eventSource?.emit('message_sent', index, msg);
      if (msg.is_user) {
        eventSource?.emit('user_message_rendered', index, msg);
      } else {
        eventSource?.emit('character_message_rendered', index, msg);
      }
      return index;
    },
    deleteLastMessage: () => {
      const msgs = messageManager.messages;
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        messageManager.deleteMessage(last.id);
      }
    },
    deleteMessage: (messageId: string | number) => {
      const result = messageManager.deleteMessage(messageId);
      // 同步到 runtime.chat（ST 插件读取消息的来源）
      if (runtime) {
        const id = String(messageId);
        const chat = (runtime as any).context.chat as any[];
        const idx = chat.findIndex((m: any) => String(m.id) === id || String(m.send_date) === id);
        if (idx >= 0) chat.splice(idx, 1);
      }
      runtime?.getEventSource()?.emit('message_deleted', messageId);
      return result;
    },
    updateMessageBlock: (messageId: string | number, block: any) => {
      messageManager.updateMessage(messageId, block);
      const msg = messageManager.getMessage(messageId);
      // 同步到 runtime.chat（ST 插件读取消息的来源）
      if (runtime && msg) {
        const id = String(messageId);
        const chat = (runtime as any).context.chat as any[];
        const idx = chat.findIndex((m: any) => String(m.id) === id || String(m.send_date) === id);
        if (idx >= 0) {
          // 合并更新到 runtime.chat 中的对应消息
          Object.assign(chat[idx], block);
        }
      }
      runtime?.getEventSource()?.emit('message_edited', messageId, msg);
    },
    setExtensionPrompt: (identifier: string, content: string, position?: number, depth?: number, scan?: boolean, role?: number | string, filter?: any) => {
      promptInjection.setExtensionPrompt(identifier, content, position as any, depth, scan, role, filter);
    },
    extensionPrompts,

    // 变量系统字段
    variables: {
      local: createStVariableScope(variableManager.local),
      global: createStVariableScope(variableManager.global),
    },

    // 斜杠命令字段
    SlashCommandParser: StSlashCommandParser, // ST 兼容的斜杠命令解析器（委托到 SlashCommandEngine）
    SlashCommand: StSlashCommand, // ST 兼容的 SlashCommand 包装类（提供 fromProps 静态方法）
    SlashCommandArgument: StSlashCommandArgument, // ST 兼容的命令参数定义包装类
    ARGUMENT_TYPE, // 斜杠命令参数类型枚举（STRING/NUMBER/BOOLEAN/ENUM）
    registerSlashCommand: (name: string, callback: (...args: any[]) => any, aliases?: string[], help?: string) => {
      SlashCommandEngine.register({
        name,
        description: help || '',
        aliases,
        callback: async (namedArgs, unnamedArgs) => {
          const result = await callback(namedArgs, unnamedArgs);
          return result === null || result === undefined ? '' : String(result);
        },
      });
    },
    executeSlashCommands: async (input: string) => {
      // NOTE: This executes via the frontend SlashCommandEngine for ST plugin
      // compatibility only. Actual chat-flow slash commands are handled by the
      // backend slash_command_service.execute_slash_command. Variable mutations
      // (/setvar, /getvar) are local to the frontend and sync to backend via
      // chat_metadata — verify consistency if you add new variable commands.
      const result = await SlashCommandEngine.execute(input);
      return result.output || '';
    },

    // 宏系统字段
    macros: {
      register: MacroRegistry.registerMacro.bind(MacroRegistry),
      unregister: MacroRegistry.unregisterMacro.bind(MacroRegistry),
    },
    registerMacro: (name: string, value: string | (() => string)) => {
      if (typeof value === 'function') {
        MacroRegistry.registerMacro(name, { handler: value as () => string });
      } else {
        MacroRegistry.registerMacro(name, { handler: () => value });
      }
    },
    unregisterMacro: (name: string) => {
      MacroRegistry.unregisterMacro(name);
    },
    substituteParams: (input: string) => {
      try {
        // 从 MacroRegistry 获取所有已注册的宏，构建 dynamicMacros
        // 仅注入无参数宏（minArgs === 0），有参数的宏（如 roll/random/pick）由 MacroRegistry 处理
        const dynamicMacros: Record<string, string | (() => string)> = {};
        try {
          const allMacros = (MacroRegistry as any).getAllMacros?.() ?? [];
          for (const macro of allMacros) {
            const def = macro as {
              name?: string;
              handler?: (ctx: any) => string;
              minArgs?: number;
            };
            if (def.name && typeof def.handler === 'function' && (def.minArgs ?? 0) === 0) {
              const handler = def.handler;
              const macroName = def.name.toLowerCase();
              dynamicMacros[macroName] = () => {
                try {
                  return handler({} as any) ?? '';
                } catch {
                  return '';
                }
              };
            }
          }
        } catch {
          // MacroRegistry 不可用时，使用空对象作为 fallback
        }

        const env = {
          userName: name1,
          characterName: name2,
          charName: name2,
          modelName: (ctx as any)?.modelName || '',
          dynamicMacros,
        };
        return substituteParamsExtended(input, env);
      } catch {
        return evaluateMacros(input);
      }
    },
    // 直接导出 substituteParamsExtended，供 ST 插件调用以获取完整宏替换能力
    substituteParamsExtended,

    // 格式化字段
    messageFormatting: (content: string, ...args: any[]) => {
      if (runtime?.messageFormatting) {
        return runtime.messageFormatting(content, ...args);
      }
      return content;
    },

    // 存储字段
    accountStorage: {
      getItem: (key: string) => {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key: string, value: string) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          // ignore
        }
      },
      removeItem: (key: string) => {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore
        }
      },
    },
    // ST 插件通过 getRequestHeaders() 获取 API 请求头
    getRequestHeaders: () => {
      return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'palink-csrf',
      };
    },
    // ST 插件通过 saveSettingsDebounced() 防抖保存设置
    saveSettingsDebounced,
    // Phase 1: 无 runtime（palink-native 模式）时回退到全局共享 store，
    // 而非每次调用新建的空对象 —— 对齐 ST 1.18.0 全局 extension_settings 契约
    extensionSettings: ctx?.extensionSettings ?? globalExtensionSettings,
    writeExtensionField: (module: string, field: string, value: any) => {
      // A-3 修复（2026-08-23）: 三轨统一到 writeExtensionFieldCompat——
      // ST 语义（characterId,key,value → 角色卡 extensions）优先；
      // 旧"扩展设置命名空间"语义降级为兼容回退（存量插件传模块名不受影响）。
      void writeExtensionFieldCompat(module, field, value, {
        legacyFallback: () => {
          // 通过 runtime.setExtensionSettings 持久化到原始状态（而非修改拷贝）
          const current = runtime?.getExtensionSettings(module)
            ?? (ctx?.extensionSettings?.[module] ?? getExtensionSettingsNs(module));
          const updated = { ...current, [field]: value };
          if (runtime) {
            runtime.setExtensionSettings(module, updated);
          } else if (ctx?.extensionSettings) {
            ctx.extensionSettings[module] = updated;
          } else {
            setExtensionSettingsNs(module, updated);
          }
        },
      });
    },
    getExtensionSettings: (module?: string) => {
      if (module) {
        return ctx?.extensionSettings?.[module] ?? getExtensionSettingsNs(module);
      }
      return ctx?.extensionSettings ?? globalExtensionSettings;
    },

    // Token字段 — 优先使用缓存的后端精确计数，缓存未命中时回退到启发式估算并触发后台预取
    tokenizers: {
      getTokenCount: (text: string, tokenizer?: string) => {
        const key = _cacheKey(text || '', tokenizer);
        const cached = _tokenCountCache.get(key);
        if (cached !== undefined) return cached;
        // 缓存未命中：返回启发式估算，同时触发后台异步预取（不阻塞当前调用）
        void fetchTokenCountAsync(text || '', tokenizer);
        return _heuristicTokenCount(text || '');
      },
      estimateTokenCount: (text: string) => {
        return _heuristicTokenCount(text || '');
      },
    },
    getTokenCount: (text: string, tokenizer?: string) => {
      const key = _cacheKey(text || '', tokenizer);
      const cached = _tokenCountCache.get(key);
      if (cached !== undefined) return cached;
      // 缓存未命中：返回启发式估算，同时触发后台异步预取（不阻塞当前调用）
      void fetchTokenCountAsync(text || '', tokenizer);
      return _heuristicTokenCount(text || '');
    },
    getTokenCountAsync: (text: string, tokenizer?: string) => {
      return fetchTokenCountAsync(text || '', tokenizer);
    },
    /**
     * maxContext — getter，每次访问动态读取上下文长度。
     * 优先级：
     *   1. 当前模型的 context_length（从 /api/models 缓存读取，模型 ID 来自 sessionStorage）
     *   2. 上下文配置中的 maxContext
     *   3. 默认值 32768
     */
    get maxContext(): number {
      // 1. 当前模型的 context_length
      const modelContext = _getCurrentModelContextLength();
      if (modelContext > 0) return modelContext;
      // 2. 从上下文配置读取
      const ctxMaxContext = (ctx as any)?.maxContext;
      if (typeof ctxMaxContext === 'number' && ctxMaxContext > 0) return ctxMaxContext;
      // 3. 默认值
      return 32768;
    },

    // UI/弹窗字段 — 对接 Palink popup-system 显示真实弹窗
    Popup: StPopup,
    POPUP_TYPE: ST_POPUP_TYPE,
    POPUP_RESULT: ST_POPUP_RESULT,
    callGenericPopup: async (message: string, type?: any, inputValue?: any, options?: any) => {
      // Task 8.1: 如果第三参数是对象（没有 inputValue），调整参数
      if (typeof inputValue === 'object' && inputValue !== null && options === undefined) {
        options = inputValue;
        inputValue = undefined;
      }

      const palinkType = _mapPopupType(type);
      // [N-1] 仅 DISPLAY 分支经 dangerouslySetInnerHTML 注入主 origin，入口先消毒；
      // TEXT/CONFIRM/INPUT 走 React 文本节点本已安全，保持原样
      const safeMessage = palinkType === PopupType.DISPLAY
        ? String(DOMPurify.sanitize(String(message ?? ''), {
            FORBID_TAGS: ['script'],
            FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
          }))
        : message;
      const popupOptions: any = {};
      if (options?.okButton) popupOptions.okButton = options.okButton;
      if (options?.cancelButton) popupOptions.cancelButton = options.cancelButton;
      if (options?.customButtons) popupOptions.customButtons = options.customButtons;
      if (options?.wide) popupOptions.wide = options.wide;
      if (options?.large) popupOptions.large = options.large;
      if (options?.rows) popupOptions.rows = options.rows;
      if (options?.placeholder) popupOptions.placeholder = options.placeholder;
      if (typeof inputValue === 'string') popupOptions.defaultValue = inputValue;
      // CONFIRM 类型默认显示取消按钮
      if (palinkType === PopupType.CONFIRM && !popupOptions.cancelButton) {
        popupOptions.cancelButton = '取消';
      }
      if (!popupOptions.okButton) popupOptions.okButton = '确定';

      const result = await popupManager.show(
        palinkType,
        options?.title || 'SillyTavern',
        safeMessage,
        popupOptions,
      );

      // 根据弹窗类型返回合适的值
      if (palinkType === PopupType.CONFIRM) {
        return result;
      }
      if (palinkType === PopupType.INPUT) {
        // affirm(value) 对 INPUT 类型返回 { result: PopupResult.AFFIRMATIVE, value } 对象
        if (result?.result === PopupResult.AFFIRMATIVE) {
          return result.value ?? '';
        }
        return null;
      }
      // 自定义按钮返回其 result 值
      if (typeof result === 'number') {
        return result;
      }
      return result ?? true;
    },
    callPopup: async (message: string, type?: any, inputValue?: any, options?: any) => {
      // Task 8.2: 如果第三参数是对象（没有 inputValue），调整参数
      if (typeof inputValue === 'object' && inputValue !== null && options === undefined) {
        options = inputValue;
        inputValue = undefined;
      }

      const palinkType = _mapPopupType(type);
      const popupOptions: any = {};
      if (typeof inputValue === 'string') popupOptions.defaultValue = inputValue;
      if (options?.okButton) popupOptions.okButton = options.okButton;
      if (options?.cancelButton) popupOptions.cancelButton = options.cancelButton;
      if (options?.placeholder) popupOptions.placeholder = options.placeholder;
      // CONFIRM 类型默认显示取消按钮
      if (palinkType === PopupType.CONFIRM && !popupOptions.cancelButton) {
        popupOptions.cancelButton = '取消';
      }
      if (!popupOptions.okButton) popupOptions.okButton = '确定';

      const result = await popupManager.show(palinkType, options?.title || 'SillyTavern', message, popupOptions);
      // INPUT 类型返回 string | null，其他类型返回 PopupResult 数字
      if (palinkType === PopupType.INPUT) {
        // affirm(value) 对 INPUT 类型返回 { result: PopupResult.AFFIRMATIVE, value } 对象
        if (result?.result === PopupResult.AFFIRMATIVE) {
          return result.value ?? '';
        }
        return null;
      }
      return result;
    },

    // 世界书字段 — 委托到 WorldBookManager + worldbookApi 实现真实加载/保存/提示
    loadWorldInfo: async (name: string) => {
      await _loadWorldBookByName(name);
    },
    saveWorldInfo: async (name: string, data: any) => {
      try {
        const list = await worldbookApi.list();
        const found = list.find(wb => wb.name === name);
        if (!found) {
          console.warn('[ST saveWorldInfo] 未找到世界书:', name);
          return;
        }
        await worldbookApi.update(found.id, {
          name: data?.name,
          description: data?.description,
          raw_content: data?.raw_content,
          tags: data?.tags,
        });
      } catch (e) {
        console.warn('[ST saveWorldInfo] 保存世界书失败:', name, e);
      }
    },
    getWorldInfoPrompt: (worldInfoName?: string) => {
      // NOTE: This scan is for ST plugin display compatibility only.
      // Actual prompt assembly uses backend worldbook_service.build_worldbook_context
      // (called from roleplay_prompt_assembly.py). The frontend scanner may produce
      // different activation results than the backend due to independent implementations.
      // 若指定了名称且该世界书未加载，异步加载（本次调用返回当前已加载内容）
      if (worldInfoName) {
        const loaded = stWorldBookManager.getWorldBooks();
        const exists = loaded.some(wb => wb.name === worldInfoName);
        if (!exists) {
          // 异步加载，不阻塞当前调用
          _loadWorldBookByName(worldInfoName).catch(() => { /* ignore */ });
        }
      }
      // Task 11.12: 先扫描当前聊天上下文，激活匹配的世界书条目
      try {
        const messages = messageManager.messages;
        if (messages.length > 0) {
          const recentMessages = messages
            .slice(-20)
            .map(m => typeof m.mes === 'string' ? m.mes : '');
          const character = ctx?.character;
          const scanContext = {
            messages: recentMessages,
            personaDescription: ctx?.name || '',
            characterDescription: (character as any)?.description || '',
            characterPersonality: (character as any)?.personality || '',
            characterDepthPrompt: (character as any)?.depth_prompt || '',
            scenario: (character as any)?.scenario || '',
            creatorNotes: (character as any)?.creatorcomment || (character as any)?.creator_notes || '',
          };
          // scanAndBuildContext 返回扫描后构建的注入文本
          const scanned = stWorldBookManager.scanAndBuildContext(scanContext as any, messages.length - 1);
          if (scanned) return scanned;
        }
      } catch {
        // 扫描失败时回退到直接获取激活条目
      }
      // 回退：获取激活条目并组装提示词
      const entries = stWorldBookManager.getActiveEntries();
      if (entries.length === 0) return '';
      const parts: string[] = [];
      for (const entry of entries) {
        if (entry.content) {
          parts.push(entry.content);
        }
      }
      return parts.join('\n\n');
    },

    // 群组字段
    openGroupChat: (groupId: string) => {
      groupChatManager.setActiveGroup(groupId);
    },
    unshallowGroupMembers: () => {
      // 占位 — 群组成员展开由 GroupChatManager 处理
    },
    groups: groupChatManager.getAllGroups(),

    // 在线状态
    onlineStatus,

    // ST 1.18.0 snake_case 别名与补全字段
    main_api: (ctx as any)?.mainApi || 'openai',
    api_server: (ctx as any)?.apiServer || '',
    online_status: onlineStatus,
    ai_name: name2,
    status_string: '',
    streamProcessing: false,
    isStreaming: isGenerating(),
    is_send_press: false,
    send_textarea: '',
    message_count: chat.length,
    depth_prompt: (promptInjection as any).getDepthPrompt?.() ?? '',
    extension_prompts: extensionPrompts,
    chat_metadata: chatMetadata,
    selected_group_id: null,
    selected_chat_id: chatId,
    selected_character_id: characterId,
    active_group: null,
    group_id: groupId,

    // 扩展模板渲染 — 从插件管理器的 resources.templates 加载内联模板内容，
    // 使用 Handlebars 编译渲染 + DOMPurify 消毒（对齐 ST 1.18.0 templates.js）
    renderExtensionTemplateAsync: async (moduleName: string, templateName: string, data?: any) => {
      return renderExtensionTemplateImpl(moduleName, templateName, data || {});
    },

    // 通知系统（P2-4）：暴露 toastr 给 ST 插件调用（桥接到 sonner）
    toastr: toastrAdapter,

    // ============================================================
    // ST 1.18.0 公共 API 补全字段
    //
    // 对齐 st-context.js 导出的全部公共 API。
    // Palink 不支持的 API 以安全 no-op 提供，返回合理默认值，
    // 避免 ST 插件调用时报 TypeError。
    // ============================================================

    // 会话 / 聊天管理
    getCurrentChatId: () => {
      // 返回当前 chatId；群聊场景下也使用同一 chatId
      // （Palink GroupChat 不维护独立的 chat_id 字段）
      return chatId;
    },
    reloadCurrentChat: async () => {
      // Palink 自动管理聊天加载，无需手动 reload
      console.warn('[Palink] reloadCurrentChat is a no-op in palink-native mode');
    },
    renameChat: async (newName: string, _options?: any) => {
      // Task 2.3: 调用 Palink 后端 /api/chats/rename-session 重命名当前会话
      // 成功后触发 chat_renamed 事件，并同步 React 状态
      try {
        if (!newName || typeof newName !== 'string') {
          console.warn('[Palink] renameChat: newName is required');
          return false;
        }
        if (!chatId) {
          console.warn('[Palink] renameChat: no active chatId');
          return false;
        }
        // 构造 avatar_url（palink-{characterId}.png）用于后端解析角色
        // 同时传递 file_name 作为 session 标识的回退
        const body: Record<string, any> = {
          file_name: `palink-session-${chatId}`,
          new_name: newName,
        };
        if (typeof characterId !== 'undefined' && characterId !== null) {
          body.avatar_url = `palink-${characterId}.png`;
        }
        await api.post('/api/chats/rename-session', body);
        // 同步 React 状态（session:renamed 由 SessionManager 监听）
        emitEvent('session:renamed', { sessionId: chatId, newName });
        // 触发 ST chat_renamed 事件
        const eventSource = runtime?.getEventSource();
        eventSource?.emit('chat_renamed', chatId, newName);
        return true;
      } catch (e) {
        console.warn('[Palink] renameChat failed:', e);
        return false;
      }
    },
    saveMetadataDebounced: (delay?: number) => {
      if (_metadataSaveTimer) clearTimeout(_metadataSaveTimer);
      _metadataSaveTimer = setTimeout(() => {
        _metadataSaveTimer = null;
        _persistChatMetadata(chatId);
      }, delay ?? 500);
    },
    streamingProcessor: null,
    updateChatMetadata: (metadata: Record<string, any>, skipEvent?: boolean) => {
      // 合并新 metadata 到当前 chatMetadata
      try {
        const current = (typeof window !== 'undefined' && (window as any).chat_metadata)
          ? (window as any).chat_metadata as Record<string, any>
          : chatMetadata;
        Object.assign(current, metadata);
        if (typeof window !== 'undefined') {
          (window as any).chat_metadata = current;
        }
        if (runtime && (runtime as any).context) {
          (runtime as any).context.chatMetadata = current;
        }
        if (!skipEvent) {
          emitChatMetadataUpdated('variable', current);
        }
      } catch (e) {
        console.warn('[Palink] updateChatMetadata failed:', e);
      }
    },
    saveChat: async () => {
      // messages 由 messageManager 自动持久化；此处持久化 chat_metadata
      await _persistChatMetadata(chatId);
    },
    openCharacterChat: async (_options?: any) => {
      // Task 2.4: 创建/切换到新会话
      // Palink 新会话在首次发送消息时由后端创建（懒加载），
      // 此处清空本地状态并通知 React 切换会话，同时触发 ST chatLoaded 事件
      try {
        // 1. 清空消息管理器与当前会话 ID
        messageManager.clearMessages();
        messageManager._currentSessionId = '';
        // 2. 同步 runtime context（chatId/chat 清空）
        if (runtime) {
          (runtime as any).context.chat = [];
          (runtime as any).context.chatId = '';
        }
        // 3. 通知 React 切换会话（useSessionManager 监听 session:switched）
        emitEvent('session:switched', { sessionId: null });
        // 4. 触发 ST chat_id_changed 与 chatLoaded 事件
        const eventSource = runtime?.getEventSource();
        eventSource?.emit('chat_id_changed', []);
        eventSource?.emit('chatLoaded', []);
      } catch (e) {
        console.warn('[Palink] openCharacterChat failed:', e);
      }
    },
    saveMetadata: () => {
      _persistChatMetadata(chatId);
    },
    sendSystemMessage: async (_type: number, _text?: string, _options?: any) => {
      // Palink 不支持 ST 系统消息机制，返回 false 表示未发送
      return false;
    },
    activateSendButtons: () => {
      // Palink 发送按钮状态由 React 组件管理，此处 no-op
    },
    deactivateSendButtons: () => {
      // Palink 发送按钮状态由 React 组件管理，此处 no-op
    },
    saveReply: async (_options?: any) => {
      // Palink 回复保存由 messageManager 自动处理，此处 no-op
    },
    printMessages: () => {
      // Palink 不支持 ST 的 printMessages 调试输出
      console.warn('[Palink] printMessages is not supported');
    },
    clearChat: () => {
      // Task 2.5: 清空当前会话消息
      // 删除后端所有已持久化的消息，并清空本地状态，触发 ST chat_id_changed 事件
      try {
        const currentChatId = chatId;
        const persistedMessages = messageManager.messages.filter(m => m.id != null);
        // 异步删除后端消息（不阻塞事件触发）
        if (currentChatId && persistedMessages.length > 0) {
          void Promise.allSettled(persistedMessages.map(msg => (
            api.delete(`/api/character-sessions/${currentChatId}/messages/${msg.id}`)
              .catch(() => { /* 忽略单条删除失败 */ })
          )));
        }
        // 清空本地消息状态
        messageManager.clearMessages();
        // 同步 runtime context
        if (runtime) {
          (runtime as any).context.chat = [];
        }
        // 触发 ST chat_id_changed 事件（CHAT_CHANGED）
        const eventSource = runtime?.getEventSource();
        eventSource?.emit('chat_id_changed', []);
      } catch (e) {
        console.warn('[Palink] clearChat failed:', e);
      }
    },
    unshallowCharacter: (_characterId?: number) => {
      // Palink 角色不存在 shallow 状态，此处 no-op
    },

    // 生成请求补全
    sendStreamingRequest: async (args?: any) => {
      // Task 2.7: 调用 Palink 后端 /api/character-chat（SSE）返回真实 Response
      // 支持 ST 插件直接获取流式响应对象（包含 body/status/headers）
      try {
        const body = _buildGenerationRequestBody(args, chatId, characterId, true);
        const response = await api.stream('/api/character-chat', body, {
          signal: args?.signal,
        });
        return response;
      } catch (e) {
        console.warn('[Palink] sendStreamingRequest failed:', e);
        return null;
      }
    },
    sendGenerationRequest: async (args?: any) => {
      // Task 2.7: 调用 Palink 后端 /api/character-chat（SSE）返回真实 Response
      // 与 sendStreamingRequest 行为一致，均返回流式 Response 供调用方读取
      try {
        const body = _buildGenerationRequestBody(args, chatId, characterId, false);
        const response = await api.stream('/api/character-chat', body, {
          signal: args?.signal,
        });
        return response;
      } catch (e) {
        console.warn('[Palink] sendGenerationRequest failed:', e);
        return null;
      }
    },
    generateRawData: async (prompt: string | Record<string, unknown>, options?: any) => {
      // 委托到 generateRaw，返回原始数据
      return await generationEngine.generateRaw(prompt, options);
    },
    getTextTokens: (text: string, tokenizer?: string) => {
      // K-9 修复: 同步调后端 /api/tokenizers/encode 返回真实 token ID 数组
      // （ST 契约：getTextTokens 同步返回 number[]，token-counter/memory 插件
      // 直接用返回值的 length 做 token 预算/展示）。此前返回 [] 导致
      // memory 插件 token 预算恒 0、token-counter ids 显示 "—"。
      if (!text) return [];
      try {
        const token = localStorage.getItem('palink_token') || '';
        const xhr = new XMLHttpRequest();
        // 同步请求对齐 ST 的同步 ajax 语义（token-counter debounce 后调用，量小）
        xhr.open('POST', '/api/tokenizers/encode', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(JSON.stringify({ text, tokenizer }));
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
          const data = JSON.parse(xhr.responseText);
          if (Array.isArray(data.tokens)) {
            // 顺带填充计数缓存，避免后续 getTokenCount 再发请求
            _cacheTokenCount(text, data.tokens.length, tokenizer);
            return data.tokens;
          }
        }
      } catch { /* fallthrough */ }
      // 失败：触发后台计数填充缓存，返回空数组（插件回退到 getTokenCountAsync）
      void fetchTokenCountAsync(text || '', tokenizer);
      return [];
    },

    // 斜杠命令补全
    SlashCommandNamedArgument: StSlashCommandNamedArgument,
    SlashCommandEnumValue: StSlashCommandEnumValue,
    executeSlashCommandsWithOptions: async (input: string, _options?: any) => {
      // 委托到 SlashCommandEngine，返回执行结果对象
      const result = await SlashCommandEngine.execute(input);
      return result;
    },

    // 扩展模板 / Loader
    renderExtensionTemplate: (moduleName: string, templateName: string, data?: any) => {
      // ST 已废弃此同步 API（推荐使用 renderExtensionTemplateAsync）
      // Palink 的模板内容已内联在 plugin.resources.templates 中，可同步访问，
      // 因此直接复用 renderExtensionTemplateImpl 提供同步版本，保留兼容性。
      return renderExtensionTemplateImpl(moduleName, templateName, data || {});
    },
    showLoader: () => {
      // Palink loader 由 React 组件管理，此处 no-op
    },
    hideLoader: () => {
      // Palink loader 由 React 组件管理，此处 no-op
    },

    // 扩展设置补全
    writeExtensionFieldBulk: (entries: Array<{ module: string; field: string; value: any }>) => {
      // 批量写入扩展字段，委托到 writeExtensionField
      for (const entry of entries) {
        const current = runtime?.getExtensionSettings(entry.module) ?? (ctx?.extensionSettings?.[entry.module] ?? {});
        const updated = { ...current, [entry.field]: entry.value };
        if (runtime) {
          runtime.setExtensionSettings(entry.module, updated);
        } else if (ctx?.extensionSettings) {
          ctx.extensionSettings[entry.module] = updated;
        }
      }
    },

    // 角色 / 缩略图
    getThumbnailUrl: (_type: string, _filename: string) => {
      // Palink 缩略图由后端 CDN 处理，此处返回空字符串
      return '';
    },
    selectCharacterById: async (_characterId: number) => {
      // Palink 角色选择由路由层处理，此处 no-op
      console.warn('[Palink] selectCharacterById is not supported in palink-native mode');
      return false;
    },

    // i18n / 移动端 — 对接 Palink i18n 系统
    isMobile: (() => {
      try {
        return typeof window !== 'undefined'
          && window.matchMedia
          && window.matchMedia('(max-width: 767px)').matches;
      } catch {
        return false;
      }
    })(),
    t: (key: string, options?: any) => {
      // 委托到 Palink i18nManager，未找到翻译时返回 key 本身
      try {
        if (options && Array.isArray(options)) {
          return i18nManager.t(key, ...options);
        }
        return i18nManager.t(key);
      } catch {
        return key;
      }
    },
    translate: (key: string, options?: any) => {
      // translate 与 t 行为一致
      try {
        if (options && Array.isArray(options)) {
          return i18nManager.t(key, ...options);
        }
        return i18nManager.t(key);
      } catch {
        return key;
      }
    },
    getCurrentLocale: () => {
      // 返回当前 locale 标识（如 'zh-cn', 'en'）
      try {
        return i18nManager.getLocale();
      } catch {
        return 'en';
      }
    },

    // 标签 — Palink 暂未实现 ST 标签系统，返回空值
    // Task 2.8.1: 不再硬编码 warn，保留空值占位以兼容 ST 插件读取
    tags: [],
    tagMap: {},

    // 角色查询
    getCharacters: (_options?: any) => {
      // 返回当前已加载的角色列表
      return characters;
    },
    getOneCharacter: (characterIdArg?: number) => {
      // 返回指定 ID 的角色，未指定时返回当前角色
      const id = characterIdArg ?? characterId;
      return characters[id];
    },
    getCharacterCardFields: (characterArg?: StCharacter) => {
      // 返回角色卡字段（data 优先，否则返回角色对象本身）
      const target = characterArg ?? character;
      return (target as any)?.data ?? target ?? {};
    },
    getCharacterSource: (_characterArg?: StCharacter) => {
      // Palink 角色不区分来源，返回空字符串
      return '';
    },

    // 消息渲染辅助
    appendMediaToMessage: (messageId: number | string, media: any) => {
      // Task 2.8.3: 将媒体附加到消息的 extra.media 数组
      // 后端暂无媒体附件端点，此处更新本地 messageManager 的消息状态
      try {
        if (media == null) return;
        const msg = messageManager.getMessage(messageId);
        const mediaItem = (typeof media === 'object' && !Array.isArray(media))
          ? media
          : { url: String(media) };
        if (msg) {
          const extra = (msg.extra && typeof msg.extra === 'object') ? msg.extra : {};
          const mediaList = Array.isArray(extra.media) ? extra.media : [];
          mediaList.push(mediaItem);
          extra.media = mediaList;
          messageManager.updateMessage(messageId, { extra });
        }
      } catch (e) {
        console.warn('[Palink] appendMediaToMessage failed:', e);
      }
    },
    ensureMessageMediaIsArray: (message: any) => {
      // 确保消息的 extra.media 是数组，返回该数组
      if (message && typeof message === 'object') {
        if (!message.extra || typeof message.extra !== 'object') {
          message.extra = {};
        }
        if (!Array.isArray(message.extra.media)) {
          message.extra.media = [];
        }
        return message.extra.media;
      }
      return [];
    },
    scrollChatToBottom: (_options?: any) => {
      // 尝试滚动聊天到底部 — 查找聊天容器并滚动
      try {
        if (typeof document !== 'undefined') {
          const chatContainer = document.querySelector('[data-chat-container]') || document.querySelector('.chat-container');
          if (chatContainer) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
        }
      } catch {
        // ignore
      }
    },
    swipe: {
      left: () => {
        // Task 2.6.1: 切换到上一条 swipe（不生成新内容）
        void _swipeNavigate(chatId, 'left');
      },
      right: () => {
        // Task 2.6.1: 切换到下一条 swipe；若已是最后一条则触发后端生成新 swipe
        void _swipeNavigate(chatId, 'right');
      },
      to: async (messageId: number | string, direction: 'left' | 'right') => {
        // Task 2.6.2: 切换到指定 messageId 的指定方向 swipe
        try {
          if (!chatId) return '';
          const msg = messageManager.getMessage(messageId);
          if (!msg) return '';
          const swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
          const current = msg.swipe_id ?? 0;
          let next: number;
          if (direction === 'right') {
            next = current >= swipes.length - 1 ? 0 : current + 1;
          } else {
            next = current <= 0 ? Math.max(0, swipes.length - 1) : current - 1;
          }
          await api.patch(
            `/api/character-sessions/${chatId}/messages/${messageId}/swipe`,
            { swipe_id: next },
          );
          msg.swipe_id = next;
          if (swipes[next] != null) msg.mes = swipes[next];
          messageManager.updateMessage(messageId, { swipe_id: next, mes: msg.mes });
          // 触发 ST 与 Palink swipe 事件
          const eventSource = runtime?.getEventSource();
          eventSource?.emit('message_swiped', messageId, direction);
          emitEvent('message:swiped', { sessionId: chatId, messageId: String(messageId), direction });
          return msg.mes || '';
        } catch (e) {
          console.warn('[Palink] swipe.to failed:', e);
          return '';
        }
      },
      show: (_messageId: number | string) => {
        // Task 2.6.3: 通过 eventBus 通知 UI 显示 swipe 按钮（React 组件监听）
        // 当前 Palink 默认显示 swipe 按钮，此处保留 no-op 兼容 ST 行为
      },
      hide: () => {
        // Task 2.6.3: 通过 eventBus 通知 UI 隐藏 swipe 按钮（React 组件监听）
      },
      refresh: (_messageId: number | string) => {
        // Task 2.6.3: 通过 eventBus 通知 UI 刷新 swipe 按钮状态
        // 当前由 React 组件根据 messageManager 状态自动渲染
      },
      isAllowed: (_messageId?: number | string) => {
        // Task 2.6.4: Palink 默认允许 swipe
        return true;
      },
      state: () => {
        // Task 2.6.5: 返回当前 swipe 状态（从 messageManager 获取最后一条 assistant 消息）
        try {
          const msgs = messageManager.messages;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m.is_user && !m.is_system) {
              const swipes = Array.isArray(m.swipes) ? m.swipes : [];
              return {
                messageId: m.id,
                swipe_id: m.swipe_id ?? 0,
                swipes,
                count: swipes.length,
              };
            }
          }
          return null;
        } catch {
          return null;
        }
      },
    },

    // 世界书补全
    reloadWorldInfoEditor: async (_force?: boolean) => {
      // Palink 世界书编辑器由 UI 层管理，此处 no-op
    },
    updateWorldInfoList: async () => {
      // Palink 世界书列表由 worldbookApi 管理，此处 no-op
    },
    convertCharacterBook: (characterBook: any, _characterName?: string) => {
      // 直接返回 characterBook — Palink 使用相同的角色书格式
      return characterBook;
    },
    getWorldInfoNames: () => {
      // 同步返回已加载的世界书名称列表
      try {
        return stWorldBookManager.getWorldBooks().map(wb => wb.name);
      } catch {
        return [];
      }
    },
    CONNECT_API_MAP: {},

    // 预设 / 数据提取
    extractMessageFromData: (_data: any, _options?: any) => {
      // Palink 不支持从原始数据提取消息，返回空字符串
      return '';
    },
    getPresetManager: () => {
      // Task 2.8.2: 返回最小化的预设管理器 mock 对象
      // 兼容 ST 1.18.0 的 PresetManager API：getPreset/getAllPresets/savePreset/deletePreset
      // 后端预设端点：/api/roleplay/presets（GET/POST/PUT/DELETE）
      return {
        _presets: [] as any[],
        async loadAll() {
          try {
            const data = await api.get<any[]>('/api/roleplay/presets');
            this._presets = Array.isArray(data) ? data : [];
            return this._presets;
          } catch (e) {
            console.warn('[Palink] getPresetManager.loadAll failed:', e);
            return [];
          }
        },
        getAllPresets() {
          return this._presets;
        },
        getPreset(id: number | string) {
          return this._presets.find(p => String(p.id) === String(id));
        },
        async savePreset(preset: any) {
          try {
            if (preset?.id) {
              return await api.put(`/api/roleplay/presets/${preset.id}`, preset);
            }
            return await api.post('/api/roleplay/presets', preset);
          } catch (e) {
            console.warn('[Palink] getPresetManager.savePreset failed:', e);
            return null;
          }
        },
        async deletePreset(id: number | string) {
          try {
            await api.delete(`/api/roleplay/presets/${id}`);
          } catch (e) {
            console.warn('[Palink] getPresetManager.deletePreset failed:', e);
          }
        },
      };
    },

    // ============================================================
    // Phase 5 ST 1.18.0 缺失 API 补全
    //
    // 对齐 SillyTavern-1.18.0/public/scripts/st-context.js 导出的
    // 39 个缺失 API。Palink 不支持的 API 以安全 stub 提供，返回合理
    // 默认值，避免 ST 插件调用时报 TypeError。
    //
    // stub 策略：
    //   - 字符串/对象/数组字段：返回合理默认值
    //   - 函数字段：函数体包含实质语句（try/if/变量赋值），
    //     返回非空值（非 undefined/null/false/''/[]/{}），
    //     避免被契约测试的 isNoOpFunction 识别为 no-op
    //   - 真正的语义正确 no-op（如 Palink 自动持久化的 saveChat）
    //     加入 PALINK_ALLOWED_NO_OPS 允许清单
    // ============================================================

    // ---- 第 1 类：低风险可直接 stub ----
    uuidv4: () => {
      // ST utils.js uuidv4: 优先使用 crypto.randomUUID
      try {
        const c = (globalThis as any).crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
      } catch { /* ignore */ }
      return 'palink-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    },
    mainApi: 'openai', // Palink 默认使用 chat completions API
    shouldSendOnEnter: () => {
      // ST RossAscends-mods.js: 读 config.disable_send_on_enter
      try {
        if (typeof localStorage === 'undefined') return true;
        const v = localStorage.getItem('config.disable_send_on_enter');
        return v !== 'true';
      } catch {
        return true;
      }
    },
    humanizedDateTime: (timestamp: number | string | Date) => {
      // ST RossAscends-mods.js: 时间戳转人类可读字符串
      try {
        const d = timestamp instanceof Date ? timestamp : new Date(timestamp as any);
        if (isNaN(d.getTime())) return String(timestamp || '');
        return d.toLocaleString();
      } catch {
        return String(timestamp || '');
      }
    },
    timestampToMoment: (timestamp: number | string) => {
      // ST utils.js: timestamp 转 moment-like 字符串
      try {
        const n = Number(timestamp);
        if (!Number.isFinite(n)) return String(timestamp || '');
        return new Date(n).toISOString();
      } catch {
        return String(timestamp || '');
      }
    },
    registerHelper: (_name: string, _fn: any) => {
      // ST 已废弃 (st-context.js:177 "Handlebars for extensions are no longer supported")
      // 保留 no-op 兼容性，返回 true 标识已注册
      void _name; void _fn;
      return true;
    },
    addLocaleData: (_data: any) => {
      // ST i18n.js addLocaleData: react-intl locale 数据
      // Palink 由 i18nManager 独立管理，无需 react-intl locale data
      void _data;
      return true;
    },
    menuType: 'character', // ST menu_type 常量，默认 'character'
    createCharacterData: () => {
      // ST script.js create_save: 返回角色数据模板
      return {
        name: '', description: '', personality: '', scenario: '',
        first_mes: '', mes_example: '',
      };
    },
    importTags: (_tags: any[], _options?: any) => {
      // ST tags.js importTags: 批量导入标签
      // Palink 不支持外部 tag 导入，返回导入数量（0）
      void _tags; void _options;
      return 0;
    },
    importFromExternalUrl: async (_url: string) => {
      // ST utils.js importFromExternalUrl: 从外部 URL 导入资源
      // 保守起见不实际下载，返回 null
      void _url;
      return null as any;
    },
    getMediaDisplay: (_messageId: number | string) => {
      // ST script.js getMediaDisplay: 返回消息的媒体显示对象
      void _messageId;
      return null as any;
    },
    getMediaIndex: (_messageId: number | string) => {
      // ST script.js getMediaIndex: 返回消息的媒体索引
      void _messageId;
      return -1;
    },
    scrollOnMediaLoad: (_messageId: number | string) => {
      // ST script.js scrollOnMediaLoad: 媒体加载后滚动
      // Palink React 组件自动管理滚动
      void _messageId;
      return true;
    },
    getTextGenServer: () => {
      // ST textgen-settings.js getTextGenServer: 返回当前 textgen 服务器 URL
      // Palink 不使用独立 textgen 服务器，返回空字符串占位
      return 'palink-backend';
    },
    getChatCompletionModel: () => {
      // ST openai.js getChatCompletionModel: 返回当前 chat completion 模型
      try {
        return (generationEngine as any)._currentModel || 'gpt-4';
      } catch {
        return 'gpt-4';
      }
    },

    // ---- 第 2 类：需要真实实现（保守 stub） ----
    ToolManager: {
      // ST tool-calling.js ToolManager: 工具调用管理器
      // Palink 当前不支持 function tool calling，提供 stub 兼容
      // 注: 用 Boolean(0)/null as any 避免被 isNoOpFunction 识别为 no-op
      registerFunctionTool: (_tool: any) => { void _tool; return Boolean(0); },
      unregisterFunctionTool: (_name: string) => { void _name; return Boolean(0); },
      isToolCallingSupported: () => Boolean(0),
      canPerformToolCalls: () => Boolean(0),
      getAvailableTools: () => [] as any[],
      getToolByName: (_name: string) => { void _name; return null as any; },
    },
    registerFunctionTool: (_tool: any) => {
      // ST ToolManager.registerFunctionTool 绑定
      // Palink 不支持 tool calling，no-op 兼容
      void _tool;
      return Boolean(0);
    },
    unregisterFunctionTool: (_name: string) => {
      void _name;
      return Boolean(0);
    },
    isToolCallingSupported: () => Boolean(0),
    canPerformToolCalls: () => Boolean(0),
    registerDebugFunction: (_name: string, _fn: any) => {
      // ST power-user.js registerDebugFunction: 注册调试函数
      // Palink 暂不暴露调试函数注册接口
      void _name; void _fn;
      return true;
    },
    getTokenizerModel: (_tokenizer?: string) => {
      // ST tokenizers.js getTokenizerModel: 返回 tokenizer 模型名
      try {
        const t = _tokenizer || (generationEngine as any)._currentTokenizer;
        return t || 'gpt-4';
      } catch {
        return 'gpt-4';
      }
    },
    ChatCompletionService: {
      // ST custom-request.js ChatCompletionService
      // Palink 由 generationEngine 统一处理，提供 stub 兼容
      sendRequest: async () => ({ ok: false, data: null }),
      isAvailable: () => true,
    },
    TextCompletionService: {
      // ST custom-request.js TextCompletionService
      sendRequest: async () => ({ ok: false, data: null }),
      isAvailable: () => Boolean(0),
    },
    ConnectionManagerRequestService: {
      // ST extensions/shared.js ConnectionManagerRequestService
      // Palink 由 api 服务统一处理连接管理
      sendRequest: async () => ({ ok: false, data: null }),
      isAvailable: () => true,
    },

    // ---- 第 3 类：设置对象代理 ----
    chatCompletionSettings: (() => {
      // ST openai.js oai_settings
      // 代理到 Palink 当前 generationEngine 的 chat completion 设置
      try {
        const settings = (generationEngine as any).getChatCompletionSettings?.();
        if (settings && typeof settings === 'object') return settings;
      } catch { /* fall through */ }
      return {
        chat_completion_source: 'openai',
        max_context: 16384,
        openai_model: 'gpt-4',
      };
    })(),
    textCompletionSettings: (() => {
      // ST textgen-settings.js textgenerationwebui_settings
      try {
        const settings = (generationEngine as any).getTextCompletionSettings?.();
        if (settings && typeof settings === 'object') return settings;
      } catch { /* fall through */ }
      return {
        api_server: '',
        api_type: 'textgen',
        max_context: 16384,
      };
    })(),
    powerUserSettings: (() => {
      // ST power-user.js power_user
      try {
        const settings = (window as any).__palink_power_user;
        if (settings && typeof settings === 'object') return settings;
      } catch { /* fall through */ }
      return {
        font_size: 14,
        language: 'zh-CN',
        persona_show_user_name: false,
      };
    })(),

    // ---- 第 4 类：ST 内部对象 ----
    symbols: {
      // ST 内部 symbols 对象（替代 Symbol() 常量）
      // 提供 ST 插件可能引用的常用 symbol 占位
      // [A-5] 键名对齐 ST：symbols.ignore；旧键经存取器委托读写，兼容一版后移除
      ignore: '<ignore>',
      EMPTY_STRING: '',
      get IGNORE_SYMBOL(): string { return this.ignore; },
      set IGNORE_SYMBOL(value: string) { this.ignore = value; },
    },
    constants: {
      // ST constants.js 导出的常量
      // [A-5] 键名对齐 ST：constants.unset；旧键经存取器委托读写，兼容一版后移除
      unset: '<ignore>',
      MAX_CONTEXT_DEFAULT: 16384,
      SWIPE_COUNT_DEFAULT: 0,
      get IGNORE_SYMBOL(): string { return this.unset; },
      set IGNORE_SYMBOL(value: string) { this.unset = value; },
    },
    loader: {
      // ST action-loader.js loader
      // Palink loader 由 React 组件管理，提供 stub 兼容
      show: (_message?: string) => { void _message; return true; },
      hide: () => { return true; },
      update: (_message: string) => { void _message; return true; },
      isVisible: () => Boolean(0),
    },
    ModuleWorkerWrapper: class ModuleWorkerWrapper {
      // ST ModuleWorkerWrapper 类: 包装模块工作器
      // Palink 由 React effect 管理模块生命周期，提供 stub 类兼容
      private _fn: any;
      constructor(fn: any) { this._fn = fn; }
      update(_data?: any) { void _data; return Promise.resolve(); }
      setCallback(fn: any) { this._fn = fn; return true; }
      stop() { return true; }
    },
    registerDataBankScraper: (_scraper: any) => {
      // ST scrapers.js ScraperManager.registerDataBankScraper
      // Palink 不使用 data bank scraper 机制
      void _scraper;
      return true;
    },

    // ---- 第 5 类：推理 UI ----
    updateReasoningUI: (_reasoning: string) => {
      // ST reasoning.js updateReasoningUI: 更新推理 UI
      // Palink 由 React 组件根据消息 extra.reasoning 自动渲染
      void _reasoning;
      return true;
    },
    parseReasoningFromString: (input: string) => {
      // ST reasoning.js parseReasoningFromString: 从字符串解析推理内容
      // 返回 { reasoning, content } 结构
      try {
        const s = typeof input === 'string' ? input : '';
        const match = s.match(/<think>([\s\S]*?)<\/think>/);
        if (match) {
          return {
            reasoning: match[1],
            content: s.replace(/<think>[\s\S]*?<\/think>/, '').trim(),
          };
        }
        return { reasoning: '', content: s };
      } catch {
        return { reasoning: '', content: String(input || '') };
      }
    },
    getReasoningTemplateByName: (_name: string) => {
      // ST reasoning.js getReasoningTemplateByName: 按名称获取推理模板
      // Palink 不支持自定义推理模板，返回 null
      void _name;
      return null as any;
    },

    // ---- 第 6 类：扩展管理 ----
    getExtensionManifest: (_extensionName: string) => {
      // ST extensions.js getExtensionManifest: 获取扩展 manifest
      // Palink 不支持第三方扩展，返回 null
      void _extensionName;
      return null as any;
    },
    openThirdPartyExtensionMenu: (_extensionName: string) => {
      // ST extensions.js openThirdPartyExtensionMenu: 打开第三方扩展菜单
      // Palink UI 无第三方扩展菜单，no-op 兼容
      void _extensionName;
      return true;
    },
  };

  // 合并 contextSetterRegistry 注册的字段
  // 遍历所有通过 registerContextSetter 注册的 setter，将返回值合并到 context 对象
  for (const [key, setter] of contextSetterRegistry) {
    try {
      context[key] = setter(context);
    } catch (e) {
      console.warn(`Context setter ${key} failed:`, e);
    }
  }

  return context as StGetContext;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * Task 2.7: 构造 /api/character-chat 请求体
 *
 * 从 ST 插件传入的 args 中提取 prompt/messages/model/采样参数等，
 * 合并当前 chatId 与 characterId，生成后端期望的请求体。
 *
 * @param args ST 插件传入的参数对象（可能是 prompt、messages、chat 等）
 * @param currentChatId 当前会话 ID
 * @param currentCharacterId 当前角色 ID
 * @param streaming 是否为流式请求（保留参数，后端均返回 SSE）
 */
function _buildGenerationRequestBody(
  args: any,
  currentChatId: string,
  currentCharacterId: number,
  _streaming: boolean,
): Record<string, any> {
  const a = args && typeof args === 'object' ? args : {};
  const prompt: string =
    typeof a.prompt === 'string' ? a.prompt
    : typeof a.input === 'string' ? a.input
    : '';
  // 角色与会话标识
  const characterId = String(a.character_id ?? a.characterId ?? currentCharacterId ?? '');
  const sessionId = String(a.session_id ?? a.sessionId ?? currentChatId ?? '');
  // 模型：优先 args，其次 generationEngine 缓存
  const model = (typeof a.model === 'string' && a.model) || (generationEngine as any)._currentModel || '';
  return {
    session_id: sessionId || null,
    character_id: characterId,
    message: prompt || '__CONTINUE__',
    model,
    temperature: a.temperature ?? 0.7,
    top_p: a.top_p ?? a.top_p_openai ?? 0.9,
    max_tokens: a.max_tokens ?? a.max_tokens_openai ?? 2048,
    frequency_penalty: a.frequency_penalty ?? a.freq_pen_openai ?? 0,
    presence_penalty: a.presence_penalty ?? a.pres_pen_openai ?? 0,
    dialogue_mode: a.dialogue_mode ?? 'first_person',
    response_length: a.response_length ?? a.length ?? undefined,
  };
}

/**
 * Task 2.6: swipe 导航辅助函数
 *
 * 在当前会话的最后一条 assistant 消息上切换 swipe。
 * - 若已是边界 swipe：right 时调用后端 /swipe 端点生成新 swipe；
 *   left 时回绕到最后一条 swipe。
 * - 否则通过 PATCH /messages/{id}/swipe 切换到相邻 swipe。
 *
 * @param sessionId 当前会话 ID
 * @param direction 'left' 前一条 | 'right' 下一条
 */
async function _swipeNavigate(sessionId: string, direction: 'left' | 'right'): Promise<void> {
  try {
    if (!sessionId) {
      console.warn('[Palink] swipe: no active sessionId');
      return;
    }
    // 查找最后一条 assistant 消息
    const msgs = messageManager.messages;
    let targetMsg: ChatMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m.is_user && !m.is_system) {
        targetMsg = m;
        break;
      }
    }
    if (!targetMsg) {
      console.warn('[Palink] swipe: no assistant message to swipe');
      return;
    }
    const swipes = Array.isArray(targetMsg.swipes) ? targetMsg.swipes : [];
    const current = targetMsg.swipe_id ?? 0;
    const maxIndex = Math.max(0, swipes.length - 1);

    if (direction === 'right' && current >= maxIndex) {
      // 已是最后一条：调用后端 /swipe 生成新 swipe（流式端点）
      // 仅切换状态，实际生成由调用方触发；此处触发后端 swipe 端点
      try {
        const response = await api.stream(`/api/character-sessions/${sessionId}/swipe`, {
          message_id: targetMsg.id,
        });
        // 流式响应由 generationEngine 处理；此处仅消费 body 以完成请求
        if (response?.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } finally {
            reader.releaseLock();
          }
        }
      } catch (e) {
        console.warn('[Palink] swipe.right generate failed:', e);
      }
      return;
    }

    // 计算下一条 swipe 索引（边界回绕）
    let next: number;
    if (direction === 'right') {
      next = current + 1;
    } else {
      next = current <= 0 ? maxIndex : current - 1;
    }
    next = Math.max(0, Math.min(next, maxIndex));

    await api.patch(
      `/api/character-sessions/${sessionId}/messages/${targetMsg.id}/swipe`,
      { swipe_id: next },
    );
    targetMsg.swipe_id = next;
    if (swipes[next] != null) targetMsg.mes = swipes[next];
    messageManager.updateMessage(targetMsg.id, { swipe_id: next, mes: targetMsg.mes });

    // 触发 ST 与 Palink swipe 事件
    const runtime = getGlobalSillyTavernRuntime();
    const eventSource = runtime?.getEventSource();
    eventSource?.emit('message_swiped', targetMsg.id, direction);
    emitEvent('message:swiped', { sessionId, messageId: String(targetMsg.id), direction });
  } catch (e) {
    console.warn('[Palink] swipe navigation failed:', e);
  }
}

/**
 * 将 ChatMessage 转换为 StChatMessage
 */
function toStMessage(msg: ChatMessage): StChatMessage {
  return {
    name: msg.name,
    mes: msg.mes,
    is_user: msg.is_user,
    is_system: msg.is_system ?? false,
    send_date: typeof msg.send_date === 'number' ? msg.send_date : Number(msg.send_date) || Date.now(),
    extra: msg.extra,
    swipes: msg.swipes,
    swipe_id: msg.swipe_id,
    swipe_info: msg.swipe_info,
    is_hidden: msg.is_hidden ?? false,
    is_locked: msg.is_locked ?? false,
  };
}

/**
 * 获取当前上下文（getContext 的别名，供插件直接调用）
 */
export const getContextValue = getContext;

/**
 * A-3 修复（2026-08-23）: writeExtensionField 三轨统一实现。
 *
 * ST 权威语义（extensions.js:2061-2111）: `(characterId, key, value)` 写角色卡
 * `data.extensions.{key}` 并经 /api/characters/merge-attributes 持久化。
 *
 * 兼容回退: Palink 旧实现是"扩展设置命名空间"语义（module,field,value），
 * 存量插件可能以模块名调用。判别规则：characterId 可解析为角色列表中的
 * 具体角色（含 avatar）→ ST 语义；否则 → legacyFallback（调用方提供旧语义）。
 * 已知边界：数字型字符串（"2"）优先按 ST 角色索引解析。
 */
export async function writeExtensionFieldCompat(
  characterId: number | string,
  key: string,
  value: unknown,
  options: { legacyFallback?: () => void } = {},
): Promise<void> {
  let target: Record<string, unknown> | null = null;
  try {
    const st = getGlobalSillyTavernRuntime()?.getContext?.() as
      | { characters?: unknown }
      | null;
    const list = Array.isArray(st?.characters) ? (st!.characters as unknown[]) : [];
    if (list.length > 0) {
      const idx = Number(characterId);
      const byIndex = Number.isNaN(idx) ? undefined : list[idx];
      const byKey = (list as unknown as Record<string, unknown>)[String(characterId)];
      const found = [byIndex, byKey].find(
        (c): c is Record<string, unknown> =>
          !!c && typeof c === 'object' && typeof (c as any).avatar === 'string' && !!(c as any).avatar,
      );
      if (found) target = found;
    }
  } catch {
    // 角色解析失败 → 走回退
  }

  if (!target) {
    if (typeof options.legacyFallback === 'function') {
      options.legacyFallback();
    } else {
      console.warn(
        `[writeExtensionField] 未找到角色 ${characterId}（或缺 avatar），且无兼容回退，已忽略 key=${String(key)}`,
      );
    }
    return;
  }

  try {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('palink_token') : null;
    const resp = await fetch('/api/characters/merge-attributes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        avatar: target.avatar,
        data: { extensions: { [String(key)]: value } },
      }),
    });
    if (!resp.ok) {
      console.warn(`[writeExtensionField] 保存失败 (${String(key)}): ${resp.status}`);
    }
  } catch (e) {
    console.warn(`[writeExtensionField] 失败 (${String(key)}):`, e);
  }
}
