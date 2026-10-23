/**
 * AppError —— 错误对象（薄层）。
 *
 * 2026-10-23 L2-4（减重批次）：文案表收口到 `lib/errorHandler.ts::errorMessages` 作唯一基准。
 * 本文件只保留 AppError 的构造/工厂/兼容 getter；原重复的 `ErrorType` 枚举、
 * `analyzeError()` 与 `useErrorHandler()` 已删除（全仓零引用）——
 * 错误分类统一走 `lib/errorHandler.ts::analyzeError()`。
 */

import { errorMessages, type ErrorType } from '../errorHandler';

// ============================================================
// 统一错误类
// ============================================================

export class AppError {
  constructor(
    public readonly type: ErrorType,
    public readonly message: string,
    public readonly userMessage: string,
    public readonly recoverable: boolean,
    public readonly statusCode?: number,
    public readonly originalError?: Error,
    public readonly retryAction?: () => Promise<void>,
  ) {}

  /** 文案统一取 errorMessages 的标题/建议；描述保留具体错误（如「生成失败: xxx」）。 */
  private get copy() {
    return errorMessages[this.type] ?? errorMessages.unknown;
  }

  /**
   * 向后兼容属性 - 旧 API 使用 title/description/suggestion
   * （ErrorToast 与 buildSystemNoteContent 直接吃这三个字段）
   */
  get title(): string {
    return this.copy.title;
  }
  get description(): string {
    return this.userMessage;
  }
  get suggestion(): string {
    return this.copy.suggestion;
  }

  /**
   * 从API错误创建
   */
  static fromApiError(statusCode: number, message: string): AppError {
    if (statusCode === 401) {
      return new AppError('auth', message, '认证失败，请重新登录', false, statusCode);
    }
    if (statusCode === 429) {
      return new AppError('rate_limit', message, '请求过于频繁，请稍后再试', true, statusCode);
    }
    if (statusCode >= 500) {
      return new AppError('server', message, '服务器错误，请稍后再试', true, statusCode);
    }
    return new AppError('validation', message, message || '请求参数错误', false, statusCode);
  }

  /**
   * 从网络错误创建
   */
  static fromNetworkError(error: Error): AppError {
    return new AppError('network', error.message, '网络连接失败，请检查网络', true, undefined, error);
  }

  /**
   * 从超时错误创建
   */
  static fromTimeoutError(): AppError {
    return new AppError('timeout', 'Request timeout', '请求超时，请稍后再试', true);
  }

  /**
   * 从流式传输错误创建
   */
  static fromStreamError(message: string): AppError {
    return new AppError('unknown', message, `生成失败: ${message}`, true);
  }

  /**
   * 从模型错误创建
   */
  static fromModelError(message: string): AppError {
    return new AppError('model_unavailable', message, `模型错误: ${message}`, true);
  }

  /**
   * 转换为用户友好的消息
   */
  toUserMessage(): string {
    return this.userMessage;
  }

  /**
   * 转换为包含标题和建议的结构化消息
   */
  toStructuredMessage(): { title: string; description: string; suggestion: string } {
    return { title: this.title, description: this.description, suggestion: this.suggestion };
  }
}
