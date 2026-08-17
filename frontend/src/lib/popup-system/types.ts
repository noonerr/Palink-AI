/**
 * Popup System 类型定义
 * 基于 SillyTavern popup.js
 */

// ============================================================
// 弹窗类型枚举
// ============================================================

export enum PopupType {
  TEXT = 'text',
  CONFIRM = 'confirm',
  INPUT = 'input',
  DISPLAY = 'display',
  CUSTOM = 'custom',
}

// ============================================================
// 弹窗结果枚举
// ============================================================

export enum PopupResult {
  AFFIRMATIVE = 1,
  NEGATIVE = 0,
  CANCELLED = -1,
}

// ============================================================
// 自定义按钮
// ============================================================

export interface CustomButton {
  text: string;
  classes?: string[];
  result: number;
  action?: () => void;
}

// ============================================================
// 弹窗选项
// ============================================================

export interface PopupOptions {
  okButton?: string | boolean;
  cancelButton?: string | boolean;
  rows?: number;
  placeholder?: string;
  defaultValue?: string;
  wide?: boolean;
  large?: boolean;
  customButtons?: CustomButton[];
  allowHorizontalScrolling?: boolean;
  defaultResult?: PopupResult;
  onClose?: (result: any) => void;
  timeout?: number;
  closeOnBackdropClick?: boolean;
}

// ============================================================
// 弹窗状态
// ============================================================

export interface PopupState {
  isOpen: boolean;
  type: PopupType;
  header: string;
  text: string;
  options: PopupOptions;
  resolve: (result: any) => void;
}

// ============================================================
// 弹窗配置
// ============================================================

export interface PopupSystemConfig {
  defaultOkButton: string;
  defaultCancelButton: string;
  animationDuration: number;
  zIndex: number;
}
