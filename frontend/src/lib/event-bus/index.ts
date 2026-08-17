/**
 * Palink-AI 统一事件总线
 * 
 * 设计原则:
 * 1. 类型安全 - 所有事件和载荷都有TypeScript类型
 * 2. 零依赖 - 不依赖任何外部库
 * 3. 通用性 - 可用于AI对话、角色扮演、插件系统等所有场景
 * 4. 兼容性 - 提供与SillyTavern EventSource兼容的API
 */

// ============================================================
// 事件类型定义
// ============================================================

/**
 * 应用级事件
 */
export interface AppEvents {
  'app:initialized': void;
  'app:ready': void;
  'auth:failure': void;
  'settings:updated': { key: string; value: any };
}

/**
 * 会话级事件
 */
export interface SessionEvents {
  'session:created': { sessionId: string; type: 'chat' | 'character' };
  'session:switched': { sessionId: string | null };
  'session:deleted': { sessionId: string };
  'session:renamed': { sessionId: string; newName: string };
}

/**
 * 消息级事件
 */
export interface MessageEvents {
  'message:sent': { sessionId: string; messageId: string; content: string };
  'message:received': { sessionId: string; messageId: string };
  'message:edited': { sessionId: string; messageId: string; content: string };
  'message:deleted': { sessionId: string; messageId: string };
  'message:swiped': { sessionId: string; messageId: string; direction: 'left' | 'right' };
}

/**
 * 流式传输事件
 */
export interface StreamEvents {
  'stream:started': { sessionId: string; requestId: string };
  'stream:chunk': { sessionId: string; content: string; reasoning?: string };
  'stream:done': { sessionId: string; fullContent: string; fullReasoning?: string };
  'stream:error': { sessionId: string; error: string };
  'stream:cancelled': { sessionId: string };
  'stream:queued': { sessionId: string; position: number; estimatedWait: number };
}

/**
 * 角色扮演事件
 */
export interface RoleplayEvents {
  'character:selected': { characterId: string };
  'character:edited': { characterId: string };
  'character:deleted': { characterId: string };
  'group:created': { groupId: string };
  'group:updated': { groupId: string };
  'group:deleted': { groupId: string };
  'group:memberAdded': { groupId: string; characterId: string };
  'group:memberRemoved': { groupId: string; characterId: string };
  'group:messageReceived': { groupId: string; messageId: string };
  'group:generationStarted': { groupId: string };
  'group:generationEnded': { groupId: string };
  'worldbook:updated': { worldbookId: string };
  'worldbook:scanDone': { sessionId: string; matchedEntries: number };
  'branch:created': { sessionId: string; branchId: string };
  'branch:switched': { sessionId: string; branchId: string };
}

/**
 * 变量事件
 */
export interface VariableEvents {
  'variable:set': { scope: 'local' | 'global'; name: string; value: any; oldValue?: any };
  'variable:deleted': { scope: 'local' | 'global'; name: string; oldValue?: any };
}

/**
 * 图片生成事件
 */
export interface ImageEvents {
  'image:generated': { sessionId: string; messageId: string; imageUrl: string };
  'image:failed': { sessionId: string; messageId: string; error: string };
}

/**
 * 内存管理事件
 */
export interface MemoryEvents {
  'memory:compressed': { sessionId: string; savedTokens: number };
  'memory:statsLoaded': { sessionId: string; stats: any };
}

/**
 * 插件事件
 */
export interface PluginEvents {
  'plugin:loaded': { name: string };
  'plugin:unloaded': { name: string };
  'plugin:enabled': { name: string };
  'plugin:disabled': { name: string };
  'plugin:error': { name: string; error: string };
}

/**
 * Prompt Manager 事件
 */
export interface PromptEvents {
  'prompt:added': { identifier: string };
  'prompt:updated': { identifier: string };
  'prompt:removed': { identifier: string };
  'preset:loaded': { name: string };
  'preset:saved': { name: string };
}

/**
 * Persona事件
 */
export interface PersonaEvents {
  'persona:created': { personaId: string };
  'persona:updated': { personaId: string };
  'persona:deleted': { personaId: string };
  'persona:selected': { personaId: string | null };
  'persona:bound': { personaId: string; characterId: string };
  'persona:unbound': { personaId: string; characterId: string };
}

/**
 * 书签事件
 */
export interface BookmarkEvents {
  'bookmark:created': { bookmarkId: string };
  'bookmark:updated': { bookmarkId: string };
  'bookmark:deleted': { bookmarkId: string };
  'bookmark:imported': { count: number };
}

/**
 * 表情事件
 */
export interface ExpressionEvents {
  'expression:changed': { characterId: string; expression: string };
  'expression:uploaded': { characterId: string; expression: string };
  'expression:deleted': { characterId: string; expression: string };
}

/**
 * 扩展市场事件
 */
export interface ExtensionEvents {
  'extension:installed': { name: string };
  'extension:uninstalled': { name: string };
  'extension:updated': { name: string };
  'extension:rated': { name: string; rating: number };
}

/**
 * 正则管道事件
 */
export interface RegexEvents {
  'regex:added': { scriptName: string };
  'regex:removed': { scriptName: string };
  'regex:imported': { count: number };
  'regex:cache-invalidate': { reason: 'import' | 'edit' | 'delete' | 'manual' };
}

/**
 * 图像生成事件
 */
export interface ImageGenerationEvents {
  'imageGeneration:started': { prompt: string };
  'imageGeneration:completed': { url: string; seed: number };
  'imageGeneration:error': { error: string };
}

/**
 * TTS事件（扩展）
 */
export interface TTSExtendedEvents {
  'tts:started': { text: string };
  'tts:ended': { text?: string };
  'tts:stopped': void;
  'tts:error': { error: string };
}

/**
 * 预设变更事件
 */
export interface PresetEvents {
  'preset:changed': { type: string; name: string };
}

/**
 * 滑动事件
 */
export interface SwipeEvents {
  'swipe:added': { messageId: string; index: number };
  'swipe:changed': { messageId: string; index: number; direction: string };
  'swipe:deleted': { messageId: string; index: number };
  'swipe:edited': { messageId: string; index: number };
}

/**
 * 弹窗事件
 */
export interface PopupEvents {
  'popup:opened': { type: string; header: string };
  'popup:closed': { result: any };
}

/**
 * 所有事件的联合类型
 */
export type AllEventMap = 
  & AppEvents 
  & SessionEvents 
  & MessageEvents 
  & StreamEvents 
  & RoleplayEvents 
  & VariableEvents 
  & ImageEvents 
  & MemoryEvents
  & PluginEvents
  & PromptEvents
  & PersonaEvents
  & BookmarkEvents
  & ExpressionEvents
  & ExtensionEvents
  & RegexEvents
  & ImageGenerationEvents
  & TTSExtendedEvents
  & PresetEvents
  & SwipeEvents
  & PopupEvents;

/**
 * 事件名称类型
 */
export type EventName = keyof AllEventMap;

/**
 * 事件载荷类型
 */
export type EventPayload<T extends EventName> = AllEventMap[T];

/**
 * 事件监听器类型
 */
export type EventListener<T extends EventName> = (payload: EventPayload<T>) => void;

// ============================================================
// 事件总线实现
// ============================================================

/**
 * 类型安全的事件总线
 */
export class TypedEventBus<T extends Record<string, any>> {
  private listeners = new Map<keyof T, Set<(payload: any) => void>>();
  private onceListeners = new Map<keyof T, Set<(payload: any) => void>>();

  /**
   * 订阅事件
   */
  on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    
    // 返回取消订阅函数
    return () => this.off(event, listener);
  }

  /**
   * 订阅事件（一次性）
   */
  once<K extends keyof T>(event: K, listener: (payload: T[K]) => void): () => void {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(listener);
    
    // 返回取消订阅函数
    return () => {
      this.onceListeners.get(event)?.delete(listener);
    };
  }

  /**
   * 取消订阅
   */
  off<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
    this.listeners.get(event)?.delete(listener);
    this.onceListeners.get(event)?.delete(listener);
  }

  /**
   * 触发事件
   */
  emit<K extends keyof T>(event: K, payload: T[K]): void {
    // 触发普通监听器
    this.listeners.get(event)?.forEach(listener => {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[EventBus] Error in listener for '${String(event)}':`, error);
      }
    });

    // 触发一次性监听器
    this.onceListeners.get(event)?.forEach(listener => {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[EventBus] Error in once listener for '${String(event)}':`, error);
      }
    });
    
    // 清空一次性监听器
    this.onceListeners.get(event)?.clear();
  }

  /**
   * 确保监听器最后执行
   */
  makeLast<K extends keyof T>(event: K, listener: (payload: T[K]) => void): () => void {
    // 先移除，再添加（Set会保持插入顺序）
    this.off(event, listener);
    return this.on(event, listener);
  }

  /**
   * 移除所有监听器
   */
  removeAllListeners(event?: keyof T): void {
    if (event) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
  }

  /**
   * 获取事件的监听器数量（调试用）
   */
  listenerCount(event: keyof T): number {
    return (this.listeners.get(event)?.size ?? 0) + (this.onceListeners.get(event)?.size ?? 0);
  }

  /**
   * 检查是否有监听器
   */
  hasListeners(event: keyof T): boolean {
    return this.listenerCount(event) > 0;
  }
}

// ============================================================
// 全局实例
// ============================================================

/**
 * Palink-AI 全局事件总线实例
 */
export const eventBus = new TypedEventBus<AllEventMap>();

// ============================================================
// 便捷方法（兼容SillyTavern API风格）
// ============================================================

/**
 * 订阅事件（便捷方法）
 */
export function onEvent<K extends EventName>(
  event: K, 
  listener: EventListener<K>
): () => void {
  return eventBus.on(event, listener);
}

/**
 * 取消订阅（便捷方法）
 */
export function offEvent<K extends EventName>(
  event: K, 
  listener: EventListener<K>
): void {
  eventBus.off(event, listener);
}

/**
 * 触发事件（便捷方法）
 */
export function emitEvent<K extends EventName>(
  event: K, 
  payload: EventPayload<K>
): void {
  eventBus.emit(event, payload);
}

// ============================================================
// React Hook
// ============================================================

// 注意: useEventBus 需要单独的文件，因为需要导入React
// 请使用 useEventBus.ts 中的实现

export default eventBus;
