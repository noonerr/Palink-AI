/**
 * 流式传输引擎
 * 统一SSE和WebSocket双通道的传输逻辑
 */

import { consumeSseStream } from '@/lib/sseStream';
import { AppError } from '@/lib/error-handler';
import { emitEvent } from '@/lib/event-bus';
import { isAbortError, formatErrorMessage } from '@/lib/utils/messageUtils';

// ============================================================
// 类型定义
// ============================================================

export type StreamStatus = 'idle' | 'pending' | 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface StreamRequest {
  session_id: string | null;
  session_type: 'chat' | 'character';
  message: string;
  model: string;
  images: string[];
  files: string[];
  display_content?: string;
  web_search?: boolean;
  [key: string]: any;
}

export interface StreamCallbacks {
  onChunk?: (content: string, reasoning: string) => void;
  onDone?: (fullContent: string, fullReasoning: string) => void;
  onError?: (error: AppError) => void;
  onCancelled?: () => void;
  onSessionCreated?: (sessionId: string) => void;
  onQueued?: (requestId: string, position: number, estimatedWait: number) => void;
  onStatusChange?: (status: StreamStatus) => void;
}

export interface StreamResult {
  status: StreamStatus;
  content: string;
  reasoning: string;
  sessionId: string | null;
  error: AppError | null;
  cancelled: boolean;  // 向后兼容
}

// ============================================================
// StreamEngine 类
// ============================================================

export class StreamEngine {
  private abortController: AbortController | null = null;
  private status: StreamStatus = 'idle';
  private fullContent = '';
  private fullReasoning = '';
  private sessionId: string | null = null;
  private callbacks: StreamCallbacks = {};

  /**
   * 获取当前状态
   */
  getStatus(): StreamStatus {
    return this.status;
  }

  /**
   * 获取当前内容
   */
  getContent(): { content: string; reasoning: string } {
    return { content: this.fullContent, reasoning: this.fullReasoning };
  }

  /**
   * 获取会话ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: StreamCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 更新状态
   */
  private setStatus(newStatus: StreamStatus): void {
    this.status = newStatus;
    this.callbacks.onStatusChange?.(newStatus);
  }

  /**
   * 通过SSE发送请求 - 简单模式（直接接收Response）
   */
  async sendViaSSE(response: Response, onJson: (json: Record<string, unknown>) => void): Promise<StreamResult>;

  /**
   * 通过SSE发送请求 - 高级模式（通过request + api发起）
   */
  async sendViaSSE(request: StreamRequest, api: any): Promise<StreamResult>;

  async sendViaSSE(responseOrRequest: Response | StreamRequest, onJsonOrApi?: ((json: Record<string, unknown>) => void) | any): Promise<StreamResult> {
    // 简单模式: Response + onJson回调
    if (responseOrRequest instanceof Response) {
      return this.handleSimpleMode(responseOrRequest, onJsonOrApi as (json: Record<string, unknown>) => void);
    }
    // 高级模式: StreamRequest + api
    return this.handleAdvancedMode(responseOrRequest, onJsonOrApi);
  }

  /**
   * 简单模式处理
   */
  private async handleSimpleMode(response: Response, onJson: (json: Record<string, unknown>) => void): Promise<StreamResult> {
    this.setStatus('streaming');
    
    try {
      await consumeSseStream(response, (json) => {
        onJson(json);
      });

      this.setStatus('done');
      return {
        status: 'done',
        content: this.fullContent,
        reasoning: this.fullReasoning,
        sessionId: this.sessionId,
        error: null,
        cancelled: false,
      };
    } catch (error) {
      if (isAbortError(error)) {
        this.setStatus('cancelled');
        return {
          status: 'cancelled',
          content: this.fullContent,
          reasoning: this.fullReasoning,
          sessionId: this.sessionId,
          error: null,
          cancelled: true,
        };
      }

      const appError = AppError.fromStreamError(formatErrorMessage(error));
      this.setStatus('error');
      return {
        status: 'error',
        content: this.fullContent,
        reasoning: this.fullReasoning,
        sessionId: this.sessionId,
        error: appError,
        cancelled: false,
      };
    }
  }

  /**
   * 高级模式处理
   */
  private async handleAdvancedMode(request: StreamRequest, api: any): Promise<StreamResult> {
    this.abortController = new AbortController();
    this.fullContent = '';
    this.fullReasoning = '';
    this.sessionId = request.session_id;
    this.setStatus('pending');

    try {
      const res = await api.stream('/api/chat', request, { 
        signal: this.abortController.signal 
      });

      // 处理会话创建
      if (!request.session_id) {
        setTimeout(() => {
          // 延迟加载会话列表
        }, 1000);
      }

      await consumeSseStream(res, (json) => {
        // 处理web搜索结果
        if (json.type === 'web_search' && json.results) {
          // web搜索结果由调用方处理
          return;
        }

        // 处理排队状态
        if (json.type === 'queue' && json.request_id) {
          this.setStatus('queued');
          this.callbacks.onQueued?.(
            json.request_id as string,
            typeof json.position === 'number' ? json.position : 0,
            typeof json.estimated_wait === 'number' ? json.estimated_wait : 0
          );
          return;
        }

        // 处理会话ID
        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        if (sessionId && !this.sessionId) {
          this.sessionId = sessionId;
          this.callbacks.onSessionCreated?.(sessionId);
        }

        // 处理内容
        const content = typeof json.content === 'string' ? json.content : '';
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const reasoningDelta = `${reasoning}${modelReasoning}`;

        if (!content && !reasoningDelta) return;

        // 更新状态
        if (this.status === 'queued') {
          this.setStatus('streaming');
        } else if (this.status === 'pending') {
          this.setStatus('streaming');
        }

        // 累加内容
        if (reasoningDelta) {
          this.fullReasoning += reasoningDelta;
        }
        if (content) {
          this.fullContent += content;
        }

        // 触发chunk回调
        this.callbacks.onChunk?.(content, reasoningDelta);

        // 触发事件总线
        emitEvent('stream:chunk', {
          sessionId: this.sessionId || '',
          content,
          reasoning: reasoningDelta || undefined,
        });
      });

      // 完成
      this.setStatus('done');
      this.callbacks.onDone?.(this.fullContent, this.fullReasoning);
      
      emitEvent('stream:done', {
        sessionId: this.sessionId || '',
        fullContent: this.fullContent,
        fullReasoning: this.fullReasoning || undefined,
      });

      return {
        status: 'done',
        content: this.fullContent,
        reasoning: this.fullReasoning,
        sessionId: this.sessionId,
        error: null,
        cancelled: false,
      };

    } catch (error) {
      if (isAbortError(error)) {
        this.setStatus('cancelled');
        this.callbacks.onCancelled?.();
        
        emitEvent('stream:cancelled', {
          sessionId: this.sessionId || '',
        });

        return {
          status: 'cancelled',
          content: this.fullContent,
          reasoning: this.fullReasoning,
          sessionId: this.sessionId,
          error: null,
          cancelled: true,
        };
      }

      const appError = AppError.fromStreamError(formatErrorMessage(error));
      this.setStatus('error');
      this.callbacks.onError?.(appError);
      
      emitEvent('stream:error', {
        sessionId: this.sessionId || '',
        error: formatErrorMessage(error),
      });

      return {
        status: 'error',
        content: this.fullContent,
        reasoning: this.fullReasoning,
        sessionId: this.sessionId,
        error: appError,
        cancelled: false,
      };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * 取消当前请求
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.cancel();
    this.fullContent = '';
    this.fullReasoning = '';
    this.sessionId = null;
    this.setStatus('idle');
  }
}

/**
 * 创建流式传输引擎实例
 */
export function createStreamEngine(): StreamEngine {
  return new StreamEngine();
}
