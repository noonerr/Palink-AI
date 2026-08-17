/**
 * Popup System 模块入口
 * 基于 SillyTavern popup.js
 */

// 导出类型
export type {
  PopupOptions,
  PopupState,
  PopupSystemConfig,
  CustomButton,
} from './types';

// 导出枚举
export { PopupType, PopupResult } from './types';

// 导出类和实例
export { PopupManager, createPopupManager } from './manager';
import { popupManager } from './manager';
export { popupManager };

// 导出组件
export { Popup } from './Popup';

/**
 * React Hook: usePopup
 */
export function usePopup() {
  return {
    manager: popupManager,
    confirm: popupManager.confirm.bind(popupManager),
    input: popupManager.input.bind(popupManager),
    text: popupManager.text.bind(popupManager),
    show: popupManager.show.bind(popupManager),
    isOpen: popupManager.isOpen.bind(popupManager),
  };
}
