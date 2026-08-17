/**
 * Popup Manager - 通用弹窗管理器
 * 基于 SillyTavern popup.js
 */

import type {
  PopupOptions,
  PopupState,
  PopupSystemConfig,
  CustomButton,
} from './types';
import { PopupType, PopupResult } from './types';
import { emitEvent } from '../event-bus';

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: PopupSystemConfig = {
  defaultOkButton: '确定',
  defaultCancelButton: '取消',
  animationDuration: 200,
  zIndex: 1000,
};

// ============================================================
// PopupManager 类
// ============================================================

export class PopupManager {
  private state: PopupState | null = null;
  private config: PopupSystemConfig;
  private pendingResolve: ((result: any) => void) | null = null;

  constructor(config?: Partial<PopupSystemConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 确认弹窗
   */
  async confirm(
    header: string,
    text?: string,
    options?: PopupOptions
  ): Promise<PopupResult> {
    return this.show(PopupType.CONFIRM, header, text || '', {
      okButton: options?.okButton ?? this.config.defaultOkButton,
      cancelButton: options?.cancelButton ?? this.config.defaultCancelButton,
      ...options,
    });
  }

  /**
   * 输入弹窗
   */
  async input(
    header: string,
    text?: string,
    defaultValue?: string,
    options?: PopupOptions
  ): Promise<string | null> {
    const result = await this.show(PopupType.INPUT, header, text || '', {
      okButton: options?.okButton ?? this.config.defaultOkButton,
      cancelButton: options?.cancelButton ?? this.config.defaultCancelButton,
      placeholder: defaultValue,
      ...options,
    });

    if (result === PopupResult.AFFIRMATIVE) {
      return (result as any).value ?? defaultValue ?? null;
    }
    return null;
  }

  /**
   * 文本弹窗
   */
  async text(
    header: string,
    text?: string,
    options?: PopupOptions
  ): Promise<PopupResult> {
    return this.show(PopupType.TEXT, header, text || '', {
      okButton: options?.okButton ?? this.config.defaultOkButton,
      ...options,
    });
  }

  /**
   * 显示弹窗
   */
  async show(
    type: PopupType,
    header: string,
    text: string,
    options: PopupOptions = {}
  ): Promise<any> {
    return new Promise((resolve) => {
      this.state = {
        isOpen: true,
        type,
        header,
        text,
        options: {
          okButton: options.okButton ?? this.config.defaultOkButton,
          cancelButton: options.cancelButton ?? this.config.defaultCancelButton,
          ...options,
        },
        resolve,
      };

      this.pendingResolve = resolve;
      emitEvent('popup:opened', { type, header });
    });
  }

  /**
   * 关闭弹窗
   */
  close(result: any = PopupResult.CANCELLED): void {
    if (this.state) {
      this.state.resolve(result);
      emitEvent('popup:closed', { result });
      this.state = null;
      this.pendingResolve = null;
    }
  }

  /**
   * 确认操作
   */
  affirm(value?: any): void {
    if (this.state) {
      const result = this.state.type === PopupType.INPUT
        ? { result: PopupResult.AFFIRMATIVE, value }
        : PopupResult.AFFIRMATIVE;
      this.close(result);
    }
  }

  /**
   * 取消操作
   */
  cancel(): void {
    this.close(PopupResult.NEGATIVE);
  }

  /**
   * 获取当前状态
   */
  getState(): PopupState | null {
    return this.state;
  }

  /**
   * 检查是否有弹窗打开
   */
  isOpen(): boolean {
    return this.state?.isOpen ?? false;
  }

  /**
   * 获取配置
   */
  getConfig(): PopupSystemConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PopupSystemConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 创建弹窗管理器实例
 */
export function createPopupManager(config?: Partial<PopupSystemConfig>): PopupManager {
  return new PopupManager(config);
}

// 导出单例
export const popupManager = new PopupManager();
