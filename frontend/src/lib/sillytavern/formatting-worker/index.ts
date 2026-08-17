/**
 * Formatting Worker 主线程 API
 *
 * 提供 formatMessageAsync：异步版本 formatMessage，CPU 密集步骤走 Web Worker。
 *
 * 流程：
 *   1. 主线程预执行 beforeRegexHooks（hooks 是 JS 函数无法跨 Worker 传递）
 *   2. Worker 内执行：extractReasoningTags → stripPromptBias → 正则 → 宏 → fixMarkdown
 *      → encodeTags → extractHtmlBlocks → Showdown → restoreHtmlBlocks
 *   3. 主线程执行 afterMarkdownHooks
 *   4. 主线程执行步骤 10 名称剥离
 *   5. 主线程递归格式化 reasoning（调用 formatMessageAsync）
 *   6. 主线程执行步骤 12 DOMPurify 消毒（encodeStyleTags + sanitize + decodeStyleTags）
 *
 * Fallback 策略：
 *   - Worker 初始化失败 / 出错 / 超时 → 回退同步 formatMessage
 *   - 调用方传入 afterRegexHooks → 回退同步 formatMessage（Worker 内无法执行正则后 hook）
 */

import DOMPurify from 'dompurify';
import {
  formatMessage,
  buildMessageSanitizeConfig,
  encodeStyleTags,
  decodeStyleTags,
  renderReasoningDetails,
  escapeRegex,
  containsFullHtmlDocument,
  type FormatMessageContext,
  type FormatMessageOptions,
} from '../formatting';
import {
  WorkerState,
  type FormatWorkerInbound,
  type FormatWorkerOutbound,
  type FormatWorkerRequest,
  type WorkerFormatOptions,
} from './protocol';

// ── Worker 管理器 ──────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5000; // 单次请求超时 5 秒

class FormattingWorkerManager {
  private worker: Worker | null = null;
  private state: WorkerState = WorkerState.Idle;
  private pending = new Map<string, {
    resolve: (html: string, reasoning: string[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readyPromise: Promise<void> | null = null;
  private requestCounter = 0;

  /**
   * 懒加载 Worker。首次调用时创建。
   * 在 SSR / 非浏览器环境直接返回 null，调用方走 fallback。
   */
  private ensureWorker(): Worker | null {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker && this.state !== WorkerState.Error) {
      return this.worker;
    }
    if (this.state === WorkerState.Error) {
      return null;
    }
    if (this.readyPromise) {
      return this.worker;
    }

    try {
      // Vite 原生支持 new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      const worker = new Worker(
        new URL('./worker.ts', import.meta.url),
        { type: 'module' },
      );
      this.worker = worker;
      this.state = WorkerState.Initializing;

      worker.addEventListener('message', this.onMessage);
      worker.addEventListener('error', this.onError);

      this.readyPromise = new Promise<void>((resolve) => {
        const checkReady = () => {
          if (this.state === WorkerState.Ready) resolve();
          else if (this.state === WorkerState.Error) resolve();
          else setTimeout(checkReady, 10);
        };
        checkReady();
      });

      return worker;
    } catch (error) {
      console.warn('[formatting-worker] Failed to create Worker, falling back to sync:', error);
      this.state = WorkerState.Error;
      return null;
    }
  }

  private onMessage = (event: MessageEvent<FormatWorkerOutbound>) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'worker-ready': {
        this.state = WorkerState.Ready;
        break;
      }
      case 'pong': {
        // 心跳响应，无操作
        break;
      }
      case 'format-result': {
        const { id, html, reasoning } = data.payload;
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.resolve(html, reasoning);
        }
        break;
      }
      case 'format-error': {
        const { id, error, stack } = data.payload;
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(new Error(`${error}${stack ? '\n' + stack : ''}`));
        }
        break;
      }
      default: {
        // 未知消息类型，忽略
      }
    }
  };

  private onError = (event: ErrorEvent) => {
    console.error('[formatting-worker] Worker error:', event.message, event);
    this.state = WorkerState.Error;
    // 拒绝所有 pending 请求
    const error = new Error(`Worker error: ${event.message}`);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    // 销毁损坏的 Worker
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.removeEventListener('error', this.onError);
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
  };

  /**
   * 发送格式化请求到 Worker
   * 返回 Worker 完成的 HTML 与 reasoning 原文数组
   */
  async format(
    rawText: string,
    context: FormatMessageContext,
    options: WorkerFormatOptions,
  ): Promise<{ html: string; reasoning: string[] }> {
    const worker = this.ensureWorker();
    if (!worker) {
      throw new Error('Worker unavailable');
    }

    // 等待 Worker 就绪
    if (this.readyPromise) {
      await this.readyPromise;
    }
    if (this.state === WorkerState.Error) {
      throw new Error('Worker in error state');
    }

    const id = `req-${++this.requestCounter}-${Date.now()}`;
    const request: FormatWorkerRequest = { id, rawText, context, options };

    return new Promise<{ html: string; reasoning: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker request timeout (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (html, reasoning) => resolve({ html, reasoning }),
        reject,
        timer,
      });

      const inbound: FormatWorkerInbound = { type: 'format', payload: request };
      worker.postMessage(inbound);
    });
  }

  /**
   * 检查 Worker 是否可用（已就绪或可初始化）
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      return false;
    }
    return this.state !== WorkerState.Error;
  }
}

export const formattingWorker = new FormattingWorkerManager();

// ── 主线程 API：formatMessageAsync ─────────────────────────────

/**
 * 异步版本 formatMessage
 *
 * 与同步 formatMessage 行为一致，但 CPU 密集步骤（正则/宏/Showdown）走 Web Worker。
 *
 * Fallback 条件（自动回退同步 formatMessage）：
 *   - Worker 不可用（SSR / Worker API 缺失 / Worker 出错）
 *   - Worker 请求超时
 *   - 调用方传入 afterRegexHooks（Worker 内无法执行正则后 hook）
 *
 * Hooks 处理：
 *   - beforeRegexHooks：主线程预执行，结果传给 Worker
 *   - afterMarkdownHooks：Worker 返回后主线程执行
 *   - afterRegexHooks：触发 fallback（同步路径执行）
 */
export async function formatMessageAsync(
  rawText: string,
  context: FormatMessageContext = {},
  options: FormatMessageOptions & { messageId?: number } = {},
): Promise<string> {
  if (!rawText) return '';

  // Fallback 1: afterRegexHooks 无法在 Worker 内执行
  if (options.afterRegexHooks && options.afterRegexHooks.length > 0) {
    return formatMessage(rawText, context, options);
  }

  // Fallback 2: Worker 不可用
  if (!formattingWorker.isAvailable()) {
    return formatMessage(rawText, context, options);
  }

  // 步骤 3：主线程预执行 beforeRegexHooks
  let mes = rawText;
  if (!context.isSystem && options.beforeRegexHooks) {
    for (const hook of options.beforeRegexHooks) {
      try {
        const result = hook(mes, context);
        if (typeof result === 'string') mes = result;
      } catch (e) {
        console.error('[formatMessageAsync] beforeRegex hook error:', e);
      }
    }
  }

  // Worker 请求（不含 hooks）
  const workerOptions: WorkerFormatOptions = {
    runRegex: options.runRegex,
    regexPlacement: options.regexPlacement,
    regexParams: options.regexParams,
    skipSanitize: options.skipSanitize,
    messageId: options.messageId,
  };

  let workerHtml: string;
  let reasoningRaw: string[];
  try {
    const result = await formattingWorker.format(mes, context, workerOptions);
    workerHtml = result.html;
    reasoningRaw = result.reasoning;
  } catch (error) {
    // Fallback 3: Worker 出错 / 超时
    console.warn('[formatMessageAsync] Worker failed, falling back to sync:', error);
    return formatMessage(rawText, context, options);
  }

  // 步骤 9：主线程执行 afterMarkdownHooks
  let html = workerHtml;
  if (!context.isSystem && options.afterMarkdownHooks) {
    for (const hook of options.afterMarkdownHooks) {
      try {
        const result = hook(html, context);
        if (typeof result === 'string') html = result;
      } catch (e) {
        console.error('[formatMessageAsync] afterMarkdown hook error:', e);
      }
    }
  }

  // 步骤 10：名称剥离
  const { characterName = '', isUser = false, isSystem = false, allowName2Display = false } = context;
  if (!allowName2Display && characterName && !isUser && !isSystem) {
    html = html.replace(new RegExp(`(^|\n)${escapeRegex(characterName)}:`, 'g'), '$1');
  }

  // 步骤 11：递归格式化 reasoning 并拼接
  if (reasoningRaw.length > 0) {
    const reasoningHtml = await Promise.all(
      reasoningRaw.map(async (reasoningText) => {
        try {
          return await formatMessageAsync(
            reasoningText,
            { ...context, isReasoning: true },
            options,
          );
        } catch (e) {
          console.error('[formatMessageAsync] reasoning recursion error:', e);
          return '';
        }
      }),
    );
    const reasoningHtmlJoined = reasoningHtml.filter(Boolean).join('\n\n');
    if (reasoningHtmlJoined) {
      html = renderReasoningDetails(reasoningHtmlJoined) + html;
    }
  }

  // 步骤 12：DOMPurify 消毒（主线程，依赖 DOM）
  if (options.skipSanitize) {
    return html;
  }
  // 与同步 formatMessage 保持一致：状态栏 / smart-card 的完整 HTML 文档整体跳过消毒。
  // DOMPurify 默认 WHOLE_DOCUMENT:false 会剥掉 <!DOCTYPE>/<html>/<head>/<body>，
  // 导致进入沙箱 iframe 的文档残缺、面板黑屏。安全性由 iframe 沙箱保证。
  // 额外兜底（与同步版一致）：正则产物自身已是完整 HTML 文档且含脚本/事件属性时，
  // 即使调用方未显式声明 preserveScripts 也整体跳过消毒（正则前无法预知产物形态），
  // 内容必然被 kind='smart-card' 捕获并进入沙箱 iframe，脚本仅在 frame 内执行。
  const isFullDocumentOutput = containsFullHtmlDocument(html);
  if (isFullDocumentOutput && (options.preserveScripts || /<script[\s>]|\son[a-z]+\s*=/i.test(html))) {
    return html;
  }
  const config = buildMessageSanitizeConfig(context.sanitizerOverrides || {});
  // 保留 <script>：内容将进入沙箱 iframe（smart-card / 状态栏渲染器）时。
  if (options.preserveScripts) {
    if (Array.isArray((config as Record<string, unknown>).FORBID_TAGS)) {
      (config as Record<string, unknown>).FORBID_TAGS = (config.FORBID_TAGS as unknown[]).filter(
        (tag: unknown) => tag !== 'script'
      );
    }
    // 仅从 FORBID_TAGS 移除 script 还不够：DOMPurify 默认 ALLOWED_TAGS 不含 script，
    // 不在白名单且不在黑名单的标签会被整体丢弃（含其内容）。必须把 script 显式加回
    // ALLOWED 列表，<script> 及其内容（状态栏/智能卡脚本）才能保留到输出，进入沙箱 iframe 执行。
    const currentAdd = Array.isArray((config as Record<string, unknown>).ADD_TAGS)
      ? ((config as Record<string, unknown>).ADD_TAGS as unknown[])
      : [];
    if (!currentAdd.includes('script')) {
      (config as Record<string, unknown>).ADD_TAGS = [...currentAdd, 'script'];
    }
  }
  let result = encodeStyleTags(html);
  result = String(DOMPurify.sanitize(result, config as any));
  result = decodeStyleTags(result, { prefix: '.mes_text ' });
  return result;
}

export { formatMessageAsync as formatMessageAsyncFn };
