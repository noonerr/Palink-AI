/**
 * Message Swipe 模块入口
 * 基于 SillyTavern 的 swipe 功能
 */

// 导出类型
export type {
  SwipeMessage,
  SwipeState,
} from './manager';

// 导出类和实例
export { MessageSwipeManager, createMessageSwipeManager } from './manager';
import { messageSwipeManager } from './manager';
export { messageSwipeManager };

/**
 * React Hook: useMessageSwipe
 */
export function useMessageSwipe() {
  return {
    manager: messageSwipeManager,
    initSwipe: messageSwipeManager.initSwipe.bind(messageSwipeManager),
    addSwipe: messageSwipeManager.addSwipe.bind(messageSwipeManager),
    getCurrentSwipe: messageSwipeManager.getCurrentSwipe.bind(messageSwipeManager),
    nextSwipe: messageSwipeManager.nextSwipe.bind(messageSwipeManager),
    prevSwipe: messageSwipeManager.prevSwipe.bind(messageSwipeManager),
    goToSwipe: messageSwipeManager.goToSwipe.bind(messageSwipeManager),
    deleteSwipe: messageSwipeManager.deleteSwipe.bind(messageSwipeManager),
    editSwipe: messageSwipeManager.editSwipe.bind(messageSwipeManager),
    getSwipeCount: messageSwipeManager.getSwipeCount.bind(messageSwipeManager),
    getCurrentIndex: messageSwipeManager.getCurrentIndex.bind(messageSwipeManager),
  };
}
