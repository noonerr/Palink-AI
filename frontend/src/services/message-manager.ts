/**
 * 消息管理器服务（stub 实现）
 *
 * 提供 ST 兼容的消息管理接口，供 getContext.ts 和 useCharacterChat.ts 使用。
 * 维护内存中的消息列表，支持增删改查操作。
 * 当前为 stub 实现，方法签名与 ST 1.18.0 对齐，返回空/默认值。
 */

/**
 * 聊天消息类型
 *
 * 与 ST 1.18.0 的 StChatMessage 字段对齐，额外包含 id 和 role 字段
 * 以兼容 Palink 前端的消息管理需求。
 */
export interface ChatMessage {
  /** 消息唯一标识 */
  id: string | number;
  /** 发送者名称 */
  name: string;
  /** 消息内容 */
  mes: string;
  /** 是否为用户消息 */
  is_user: boolean;
  /** 是否为系统消息 */
  is_system?: boolean;
  /** 发送时间戳（ST 兼容字段，可为字符串或数字） */
  send_date: string | number;
  /** 消息角色（user/assistant/system） */
  role?: string;
  /** 消息的多个回复版本 */
  swipes?: string[];
  /** 当前选中的 swipe 索引 */
  swipe_id?: number;
  /** 每个 swipe 的元信息 */
  swipe_info?: Array<{ send_date?: string; extra?: Record<string, unknown> }>;
  /** 额外元数据 */
  extra?: Record<string, unknown>;
  /** 是否隐藏（不计入提示词，前端仍可见） */
  is_hidden?: boolean;
  /** 是否锁定（前端不可编辑，仍计入提示词） */
  is_locked?: boolean;
}

/**
 * 消息管理器单例
 *
 * 维护内存中的消息列表，提供 ST 兼容的消息操作接口。
 * getContext.ts 通过此对象读取/修改消息列表，
 * useCharacterChat.ts 通过此对象读取消息用于世界书上下文构建。
 */
export const messageManager = {
  /** 当前消息列表 */
  messages: [] as ChatMessage[],

  /** 当前角色 ID（ST 兼容字段，getContext 用于回填 characterId） */
  _currentCharacterId: '' as string | number,

  /**
   * 添加一条消息到列表末尾
   * @param msg 要添加的消息对象
   */
  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this._notify({ type: 'added', message: msg });
  },

  /**
   * 根据消息 ID 删除消息
   * @param id 消息 ID
   * @returns 是否删除成功
   */
  deleteMessage(id: string | number): boolean {
    const idx = this.findIndex(id);
    if (idx === -1) return false;
    const [removed] = this.messages.splice(idx, 1);
    this._notify({ type: 'deleted', message: removed });
    return true;
  },

  /**
   * 更新消息内容（合并 block 字段）
   * @param id 消息 ID
   * @param block 要合并更新的字段
   */
  updateMessage(id: string | number, block: any): void {
    const idx = this.findIndex(id);
    if (idx === -1) return;
    this.messages[idx] = { ...this.messages[idx], ...block };
    this._notify({ type: 'updated', message: this.messages[idx] });
  },

  /**
   * 根据消息 ID 获取消息
   * @param id 消息 ID
   * @returns 消息对象，未找到返回 undefined
   */
  getMessage(id: string | number): ChatMessage | undefined {
    return this.messages.find(m => String(m.id) === String(id));
  },

  /**
   * 根据消息 ID 查找索引
   * @param id 消息 ID
   * @returns 索引位置，未找到返回 -1
   */
  findIndex(id: string | number): number {
    return this.messages.findIndex(m => String(m.id) === String(id));
  },

  /**
   * 获取当前角色 ID
   * @returns 当前角色 ID
   */
  getCurrentCharacterId(): string | number {
    return this._currentCharacterId;
  },

  /**
   * 设置当前角色 ID
   * @param id 角色 ID
   */
  setCurrentCharacterId(id: string | number): void {
    this._currentCharacterId = id;
  },

  /**
   * 设置当前会话（ST 兼容方法）
   * @param sessionId 会话 ID
   * @param characterId 角色 ID
   */
  setSession(sessionId: string, characterId: string): void {
    this._currentCharacterId = characterId;
    this._currentSessionId = sessionId;
  },

  /** 当前会话 ID */
  _currentSessionId: '' as string,

  /** 消息变更监听器列表 */
  _listeners: [] as Array<(event: MessageEvent) => void>,

  /**
   * 批量设置消息列表
   * @param messages 消息数组
   * @param replace 是否替换整个列表（默认 true）
   */
  setMessages(messages: ChatMessage[], replace: boolean = true): void {
    if (replace) {
      this.messages = [...messages];
    } else {
      this.messages.push(...messages);
    }
    this._notify({ type: 'set', messages: this.messages });
  },

  /**
   * 清空所有消息
   */
  clearMessages(): void {
    this.messages = [];
    this._notify({ type: 'cleared' });
  },

  /**
   * 注册消息变更监听器
   * @param callback 回调函数，接收事件对象
   * @returns 取消订阅函数
   */
  onMessage(callback: (event: MessageEvent) => void): () => void {
    this._listeners.push(callback);
    return () => {
      const idx = this._listeners.indexOf(callback);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  },

  /**
   * 切换消息的 swipe（回复版本）
   * @param options 包含 messageId 和 direction ('next' | 'prev')
   */
  swipe(options: { messageId: string; direction: 'next' | 'prev' }): void {
    const idx = this.findIndex(options.messageId);
    if (idx === -1) return;
    const msg = this.messages[idx];
    if (!msg.swipes || msg.swipes.length === 0) return;

    const current = msg.swipe_id ?? 0;
    const max = msg.swipes.length - 1;
    let next: number;
    if (options.direction === 'next') {
      next = current >= max ? 0 : current + 1;
    } else {
      next = current <= 0 ? max : current - 1;
    }
    msg.swipe_id = next;
    msg.mes = msg.swipes[next] ?? msg.mes;
    this._notify({ type: 'updated', message: msg });
  },

  /**
   * 通知所有监听器
   */
  _notify(event: MessageEvent): void {
    for (const listener of this._listeners) {
      try { listener(event); } catch { /* 忽略监听器错误 */ }
    }
  },

  /**
   * 清空消息列表
   */
  clear(): void {
    this.messages = [];
  },
};

/**
 * 消息事件类型
 */
interface MessageEvent {
  type: 'added' | 'updated' | 'deleted' | 'set' | 'cleared';
  message?: ChatMessage;
  messages?: ChatMessage[];
}
