/**
 * 消息相关工具函数
 * 从 useChatView 和 useCharacterChat 中提取的共享函数
 */

import type { Attachment } from '@/types';

/**
 * 生成唯一消息ID
 */
export const generateMessageId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

// [REASONING-SEPARATE] 原 buildAssistantContent（拼接 think 包裹体）已随分离存储迁移废弃删除；
// 思考统一持有在消息 extra.reasoning，渲染层由 Message.tsx 直读。

/**
 * 从文本中剥离附件Markdown
 */
export const stripAttachmentMarkdown = (text: string): string => {
  return text.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim();
};

/**
 * 构建包含附件的显示内容
 */
export const buildDisplayContent = (text: string, attachments: Attachment[]): string => {
  if (attachments.length === 0) return text;
  
  let display = text;
  display += '\n\n';
  attachments.forEach(att => {
    display += att.type === 'image'
      ? `![${att.name}](${att.url})\n`
      : `[📎 ${att.name}](${att.url})\n`;
  });
  
  return display;
};

/**
 * 检查是否是AbortError
 */
export const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError';
};

/**
 * 格式化错误消息
 */
export const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
};

/**
 * 延迟函数
 */
export const delay = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * 防抖函数
 */
export const debounce = <T extends (...args: any[]) => any>(
  fn: T,
  ms: number
): ((...args: Parameters<T>) => void) => {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

/**
 * 节流函数
 */
export const throttle = <T extends (...args: any[]) => any>(
  fn: T,
  ms: number
): ((...args: Parameters<T>) => void) => {
  let lastTime = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastTime >= ms) {
      lastTime = now;
      fn(...args);
    }
  };
};
