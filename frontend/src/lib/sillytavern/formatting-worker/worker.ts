/**
 * Formatting Worker 入口
 *
 * 在 Worker 内执行 formatMessage 中 CPU 密集且无 DOM 依赖的步骤：
 *   步骤 0   extractReasoningTags（分离思考块）
 *   步骤 0.5 stripPromptBias
 *   步骤 4   getRegexedString（正则替换，CPU 密集）
 *   步骤 5.5 substituteParamsExtended（宏替换）
 *   步骤 6   fixMarkdown
 *   步骤 7   encodeTags
 *   步骤 8   extractHtmlBlocks + preprocessMarkdownForShowdown + Showdown.makeHtml + restoreHtmlBlocks
 *
 * 主线程负责：
 *   - beforeRegexHooks 预执行（hooks 是 JS 函数无法跨 Worker 传递）
 *   - afterMarkdownHooks 在 Worker 返回后执行
 *   - 步骤 10 名称剥离
 *   - 步骤 11 reasoning 拼接（递归调用 formatMessageAsync）
 *   - 步骤 12 DOMPurify 消毒（依赖 DOM，必须在主线程）
 *
 * 注意：formatting.ts 顶层会执行 registerStDomPurifyHooks()，调用 DOMPurify.addHook。
 * 在 Worker 中 DOMPurify 实例不工作（无 window），但 addHook 不会抛错（仅注册到内部数组）。
 * Worker 内绝不调用 DOMPurify.sanitize，所以是安全的。
 */

/// <reference lib="webworker" />

import {
  extractReasoningTags,
  fixMarkdown,
  encodeTags,
  extractHtmlBlocks,
  preprocessMarkdownForShowdown,
  getShowdownConverter,
  restoreHtmlBlocks,
  type FormatMessageContext,
} from '../formatting';
import { getRegexedString } from '../regex/engine';
import { substituteParams, substituteParamsExtended } from '../macros';
import type { FormatWorkerInbound, FormatWorkerOutbound, WorkerFormatOptions } from './protocol';

// ── stripPromptBias（镜像 formatting.ts 内部函数，避免修改原文件导出） ──────────
function stripPromptBias(text: string): string {
  return text.replace(/\{"bias"\s*:\s*\[[\s\S]*?\]\}/g, '');
}

/**
 * Worker 内格式化主逻辑
 * 镜像 formatMessage 的步骤 0-8（除 hooks 与 DOMPurify）
 */
function formatInWorker(
  rawText: string,
  context: FormatMessageContext,
  options: WorkerFormatOptions,
): { html: string; reasoning: string[] } {
  if (!rawText) return { html: '', reasoning: [] };

  const {
    isSystem = false,
    isReasoning = false,
    userName = '',
    characterName = '',
    modelName = '',
    dynamicMacros,
    postProcessFn,
    encodeTagsEnabled = false,
    autoFixMarkdown = true,
  } = context;

  // 步骤 0：extractReasoningTags（仅在非 reasoning 非系统消息时）
  let mes = rawText;
  let reasoning: string[] = [];
  if (!isReasoning && !isSystem) {
    const result = extractReasoningTags(rawText);
    if (result.reasoning.length > 0) {
      mes = result.content;
      reasoning = result.reasoning;
    }
  }

  // 步骤 0.5：stripPromptBias
  mes = stripPromptBias(mes);

  // 步骤 4：正则替换（CPU 密集，Worker 加速关键）
  if (!isSystem && options.runRegex && options.regexParams) {
    try {
      mes = getRegexedString(mes, options.regexPlacement ?? 0, options.regexParams as any);
    } catch (e) {
      console.error('[formatting-worker] regex error:', e);
    }
  }

  // 步骤 5.5：宏替换
  if (!isSystem) {
    mes = substituteParamsExtended(mes, {
      userName,
      characterName,
      charName: characterName,
      modelName,
      dynamicMacros,
      postProcessFn,
    });
  }

  // 首条消息特殊处理
  if (options.messageId === 0) {
    mes = substituteParams(mes, {
      userName: context.userName,
      characterName: context.characterName,
    });
  }

  // 步骤 6：fixMarkdown
  if (autoFixMarkdown && !options.skipSanitize) {
    mes = fixMarkdown(mes, true);
  }

  // 步骤 7：encodeTags
  if (!isSystem && encodeTagsEnabled) {
    mes = encodeTags(mes);
  }

  // 步骤 8：Showdown Markdown → HTML
  if (!isSystem && !options.skipSanitize) {
    const htmlBlocks = extractHtmlBlocks(mes);
    mes = preprocessMarkdownForShowdown(htmlBlocks.text, encodeTagsEnabled);

    const converter = getShowdownConverter();
    mes = converter.makeHtml(mes);

    // Firefox newline fix in code blocks
    mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/\n/gm, '\u0000');
    });
    mes = mes.replace(/\u0000/g, '\n');
    mes = mes.trim();

    // Restore & in code blocks
    mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => {
      return match.replace(/&amp;/g, '&');
    });

    // 还原 HTML 块
    mes = restoreHtmlBlocks(mes, htmlBlocks.blocks);
  }

  return { html: mes, reasoning };
}

// ── Worker 消息处理 ────────────────────────────────────────────

function postOutbound(msg: FormatWorkerOutbound): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.addEventListener('message', (event: MessageEvent<FormatWorkerInbound>) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  try {
    switch (data.type) {
      case 'ping': {
        postOutbound({ type: 'pong' });
        break;
      }
      case 'format': {
        const { id, rawText, context, options } = data.payload;
        try {
          const result = formatInWorker(rawText, context, options);
          postOutbound({
            type: 'format-result',
            payload: {
              id,
              html: result.html,
              reasoning: result.reasoning,
            },
          });
        } catch (error) {
          postOutbound({
            type: 'format-error',
            payload: {
              id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          });
        }
        break;
      }
      default: {
        // 未知消息类型，忽略
      }
    }
  } catch (error) {
    console.error('[formatting-worker] message handler error:', error);
  }
});

// 通知主线程 Worker 已就绪
postOutbound({ type: 'worker-ready' });
