/**
 * Formatting Worker 协议定义
 *
 * 设计原则：
 * 1. 主线程预执行 beforeRegexHooks（hooks 是 JS 函数，无法跨 Worker 传递）
 * 2. Worker 内执行 CPU 密集且无 DOM 依赖的步骤：正则替换 / 宏替换 / HTML 块提取 / Showdown 转 HTML / CSS 作用域化
 * 3. Worker 返回 HTML 字符串 + reasoning 数组，主线程执行 afterMarkdownHooks + reasoning 拼接 + DOMPurify 消毒
 * 4. afterRegexHooks 在 Worker 内无法执行（正则在 Worker 内，hook 在主线程）；
 *    若调用方传入了 afterRegexHooks，主线程 API 会 fallback 到同步 formatMessage 以保证正确性
 */

import type { FormatMessageContext, FormatMessageOptions } from '../formatting';

/**
 * Worker 请求：执行格式化的无 DOM 部分
 * - rawText 已在主线程预执行 beforeRegexHooks
 * - options 不含任何 hooks（主线程负责）
 */
export interface FormatWorkerRequest {
  id: string;
  rawText: string;
  context: FormatMessageContext;
  options: WorkerFormatOptions;
}

/**
 * Worker 内可用的 options 子集
 * - 移除所有 hooks 字段（主线程负责）
 * - 保留 runRegex / regexPlacement / regexParams / skipSanitize / messageId
 * - messageId 是 formatMessage 第 3 参数的扩展字段（FormatMessageOptions & { messageId?: number }）
 */
export type WorkerFormatOptions = Omit<
  FormatMessageOptions,
  'beforeRegexHooks' | 'afterRegexHooks' | 'afterMarkdownHooks'
> & { messageId?: number };

/**
 * Worker 响应：返回 Worker 内完成的 HTML 与分离的 reasoning
 * - html 已完成：stripPromptBias → 正则 → 宏 → fixMarkdown → encodeTags → extractHtmlBlocks → Showdown → restoreHtmlBlocks
 * - reasoning 是从 rawText 中提取的思考块原文数组（未格式化），主线程负责递归格式化与拼接
 */
export interface FormatWorkerResponse {
  id: string;
  html: string;
  reasoning: string[];
}

/**
 * Worker 错误响应
 */
export interface FormatWorkerErrorResponse {
  id: string;
  error: string;
  stack?: string;
}

/**
 * Worker 入站消息（主线程 → Worker）
 */
export type FormatWorkerInbound =
  | { type: 'format'; payload: FormatWorkerRequest }
  | { type: 'ping' };

/**
 * Worker 出站消息（Worker → 主线程）
 */
export type FormatWorkerOutbound =
  | { type: 'format-result'; payload: FormatWorkerResponse }
  | { type: 'format-error'; payload: FormatWorkerErrorResponse }
  | { type: 'pong' }
  | { type: 'worker-ready' };

/**
 * Worker 状态枚举（用于主线程 API 的状态机）
 */
export enum WorkerState {
  /** 未初始化 */
  Idle = 'idle',
  /** 初始化中（Worker 已创建，等待 ready） */
  Initializing = 'initializing',
  /** 就绪 */
  Ready = 'ready',
  /** 出错，将 fallback 到同步路径 */
  Error = 'error',
}
