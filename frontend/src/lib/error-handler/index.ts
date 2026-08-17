/**
 * 统一错误处理模块
 * 消除项目中三种不同的错误表示方式
 */

// ============================================================
// 错误类型枚举
// ============================================================

export enum ErrorType {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  AUTH = 'auth',
  SERVER = 'server',
  VALIDATION = 'validation',
  MODEL = 'model',
  UNKNOWN = 'unknown',
}

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

  /**
   * 向后兼容属性 - 旧API使用title/description/suggestion
   */
  get title(): string {
    return this.toStructuredMessage().title;
  }
  get description(): string {
    return this.toStructuredMessage().description;
  }
  get suggestion(): string {
    return this.toStructuredMessage().suggestion;
  }

  /**
   * 从API错误创建
   */
  static fromApiError(statusCode: number, message: string): AppError {
    let type: ErrorType;
    let userMessage: string;
    let recoverable = false;

    if (statusCode === 401) {
      type = ErrorType.AUTH;
      userMessage = '认证失败，请重新登录';
      recoverable = false;
    } else if (statusCode === 429) {
      type = ErrorType.SERVER;
      userMessage = '请求过于频繁，请稍后再试';
      recoverable = true;
    } else if (statusCode >= 500) {
      type = ErrorType.SERVER;
      userMessage = '服务器错误，请稍后再试';
      recoverable = true;
    } else {
      type = ErrorType.VALIDATION;
      userMessage = message || '请求参数错误';
      recoverable = false;
    }

    return new AppError(type, message, userMessage, recoverable, statusCode);
  }

  /**
   * 从网络错误创建
   */
  static fromNetworkError(error: Error): AppError {
    return new AppError(
      ErrorType.NETWORK,
      error.message,
      '网络连接失败，请检查网络',
      true,
      undefined,
      error,
    );
  }

  /**
   * 从超时错误创建
   */
  static fromTimeoutError(): AppError {
    return new AppError(
      ErrorType.TIMEOUT,
      'Request timeout',
      '请求超时，请稍后再试',
      true,
    );
  }

  /**
   * 从流式传输错误创建
   */
  static fromStreamError(message: string): AppError {
    return new AppError(
      ErrorType.UNKNOWN,
      message,
      `生成失败: ${message}`,
      true,
    );
  }

  /**
   * 从模型错误创建
   */
  static fromModelError(message: string): AppError {
    return new AppError(
      ErrorType.MODEL,
      message,
      `模型错误: ${message}`,
      true,
    );
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
    switch (this.type) {
      case ErrorType.NETWORK:
        return {
          title: '网络错误',
          description: this.userMessage,
          suggestion: '请检查网络连接后重试',
        };
      case ErrorType.TIMEOUT:
        return {
          title: '请求超时',
          description: this.userMessage,
          suggestion: '请稍后再试，或尝试使用其他模型',
        };
      case ErrorType.AUTH:
        return {
          title: '认证失败',
          description: this.userMessage,
          suggestion: '请重新登录',
        };
      case ErrorType.SERVER:
        return {
          title: '服务器错误',
          description: this.userMessage,
          suggestion: '请稍后再试',
        };
      case ErrorType.MODEL:
        return {
          title: '模型错误',
          description: this.userMessage,
          suggestion: '请尝试使用其他模型',
        };
      default:
        return {
          title: '生成失败',
          description: this.userMessage,
          suggestion: '请重试',
        };
    }
  }
}

// ============================================================
// 错误分析工具
// ============================================================

/**
 * 分析错误并返回统一的AppError
 */
export function analyzeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    // 检查是否是AbortError
    if (error.name === 'AbortError') {
      return new AppError(
        ErrorType.UNKNOWN,
        'Request aborted',
        '请求已取消',
        false,
      );
    }

    // 检查是否是网络错误
    if (error.message.includes('Failed to fetch') || 
        error.message.includes('NetworkError') ||
        error.message.includes('ERR_NETWORK')) {
      return AppError.fromNetworkError(error);
    }

    // 检查是否是超时错误
    if (error.message.includes('timeout') || 
        error.message.includes('ERR_CONNECTION_TIMED_OUT')) {
      return AppError.fromTimeoutError();
    }

    return new AppError(
      ErrorType.UNKNOWN,
      error.message,
      error.message,
      true,
      undefined,
      error,
    );
  }

  if (typeof error === 'string') {
    return new AppError(
      ErrorType.UNKNOWN,
      error,
      error,
      true,
    );
  }

  return new AppError(
    ErrorType.UNKNOWN,
    String(error),
    '发生未知错误',
    true,
  );
}

// ============================================================
// 错误处理Hook
// ============================================================

import { useState, useCallback } from 'react';

export interface UseErrorHandlerReturn {
  error: AppError | null;
  setError: (error: unknown) => void;
  clearError: () => void;
  retry: () => Promise<void>;
}

export function useErrorHandler(): UseErrorHandlerReturn {
  const [error, setErrorState] = useState<AppError | null>(null);

  const setError = useCallback((error: unknown) => {
    const appError = analyzeError(error);
    setErrorState(appError);
    console.error('[ErrorHandler]', appError.type, appError.message);
  }, []);

  const clearError = useCallback(() => {
    setErrorState(null);
  }, []);

  const retry = useCallback(async () => {
    if (error?.retryAction) {
      clearError();
      await error.retryAction();
    }
  }, [error, clearError]);

  return { error, setError, clearError, retry };
}
