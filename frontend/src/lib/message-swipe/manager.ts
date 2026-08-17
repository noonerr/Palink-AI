/**
 * Message Swipe - 消息滑动多回复系统
 * 基于 SillyTavern 的 swipe 功能
 */

import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export interface SwipeMessage {
  id: string;
  content: string;
  timestamp: string;
  isEdited: boolean;
}

export interface SwipeState {
  messageId: string;
  swipes: SwipeMessage[];
  currentIndex: number;
}

// ============================================================
// MessageSwipeManager 类
// ============================================================

export class MessageSwipeManager {
  private swipeStates: Map<string, SwipeState> = new Map();

  /**
   * 初始化消息的滑动状态
   */
  initSwipe(messageId: string, content: string): void {
    if (this.swipeStates.has(messageId)) return;

    this.swipeStates.set(messageId, {
      messageId,
      swipes: [{
        id: `${messageId}-0`,
        content,
        timestamp: new Date().toISOString(),
        isEdited: false,
      }],
      currentIndex: 0,
    });
  }

  /**
   * 添加新的滑动回复
   */
  addSwipe(messageId: string, content: string): number {
    let state = this.swipeStates.get(messageId);
    
    if (!state) {
      this.initSwipe(messageId, '');
      state = this.swipeStates.get(messageId)!;
    }

    const newSwipe: SwipeMessage = {
      id: `${messageId}-${state.swipes.length}`,
      content,
      timestamp: new Date().toISOString(),
      isEdited: false,
    };

    state.swipes.push(newSwipe);
    state.currentIndex = state.swipes.length - 1;

    emitEvent('swipe:added', {
      messageId,
      index: state.currentIndex,
    });

    return state.currentIndex;
  }

  /**
   * 获取当前滑动内容
   */
  getCurrentSwipe(messageId: string): SwipeMessage | null {
    const state = this.swipeStates.get(messageId);
    if (!state) return null;

    return state.swipes[state.currentIndex] ?? null;
  }

  /**
   * 获取指定索引的滑动内容
   */
  getSwipe(messageId: string, index: number): SwipeMessage | null {
    const state = this.swipeStates.get(messageId);
    if (!state || index < 0 || index >= state.swipes.length) return null;

    return state.swipes[index];
  }

  /**
   * 切换到下一个滑动
   */
  nextSwipe(messageId: string): SwipeMessage | null {
    const state = this.swipeStates.get(messageId);
    if (!state || state.swipes.length <= 1) return null;

    state.currentIndex = (state.currentIndex + 1) % state.swipes.length;

    emitEvent('swipe:changed', {
      messageId,
      index: state.currentIndex,
      direction: 'next',
    });

    return state.swipes[state.currentIndex];
  }

  /**
   * 切换到上一个滑动
   */
  prevSwipe(messageId: string): SwipeMessage | null {
    const state = this.swipeStates.get(messageId);
    if (!state || state.swipes.length <= 1) return null;

    state.currentIndex = (state.currentIndex - 1 + state.swipes.length) % state.swipes.length;

    emitEvent('swipe:changed', {
      messageId,
      index: state.currentIndex,
      direction: 'prev',
    });

    return state.swipes[state.currentIndex];
  }

  /**
   * 切换到指定索引
   */
  goToSwipe(messageId: string, index: number): SwipeMessage | null {
    const state = this.swipeStates.get(messageId);
    if (!state || index < 0 || index >= state.swipes.length) return null;

    state.currentIndex = index;

    emitEvent('swipe:changed', {
      messageId,
      index,
      direction: 'jump',
    });

    return state.swipes[index];
  }

  /**
   * 删除指定滑动
   */
  deleteSwipe(messageId: string, index: number): boolean {
    const state = this.swipeStates.get(messageId);
    if (!state || state.swipes.length <= 1) return false;

    state.swipes.splice(index, 1);

    // 调整当前索引
    if (state.currentIndex >= state.swipes.length) {
      state.currentIndex = state.swipes.length - 1;
    } else if (state.currentIndex > index) {
      state.currentIndex--;
    }

    emitEvent('swipe:deleted', { messageId, index });
    return true;
  }

  /**
   * 编辑指定滑动
   */
  editSwipe(messageId: string, index: number, content: string): boolean {
    const state = this.swipeStates.get(messageId);
    if (!state || index < 0 || index >= state.swipes.length) return false;

    state.swipes[index].content = content;
    state.swipes[index].isEdited = true;
    state.swipes[index].timestamp = new Date().toISOString();

    emitEvent('swipe:edited', { messageId, index });
    return true;
  }

  /**
   * 获取滑动数量
   */
  getSwipeCount(messageId: string): number {
    const state = this.swipeStates.get(messageId);
    return state?.swipes.length ?? 0;
  }

  /**
   * 获取当前索引
   */
  getCurrentIndex(messageId: string): number {
    const state = this.swipeStates.get(messageId);
    return state?.currentIndex ?? 0;
  }

  /**
   * 获取滑动状态
   */
  getSwipeState(messageId: string): SwipeState | null {
    return this.swipeStates.get(messageId) ?? null;
  }

  /**
   * 清除消息的滑动状态
   */
  clearSwipe(messageId: string): void {
    this.swipeStates.delete(messageId);
  }

  /**
   * 清除所有滑动状态
   */
  clearAll(): void {
    this.swipeStates.clear();
  }
}

/**
 * 创建消息滑动管理器实例
 */
export function createMessageSwipeManager(): MessageSwipeManager {
  return new MessageSwipeManager();
}

// 导出单例
export const messageSwipeManager = new MessageSwipeManager();
