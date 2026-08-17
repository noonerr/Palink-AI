/**
 * 聊天历史宏定义
 * 基于 SillyTavern 1.18.0 chat-macros.js
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * 注册聊天历史宏
 */
export function registerChatMacros(): void {
  // {{lastMessage}} - 最后一条消息内容
  MacroRegistry.registerMacro('lastMessage', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Content of the last message in chat',
    returns: 'Message content',
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      if (chat.length === 0) return '';
      return chat[chat.length - 1]?.content ?? chat[chat.length - 1]?.mes ?? '';
    },
  });

  // {{lastMessageId}} - 最后一条消息索引
  MacroRegistry.registerMacro('lastMessageId', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Index of the last message in chat',
    returns: 'Message index (0-based)',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      return String(Math.max(0, chat.length - 1));
    },
  });

  // {{lastUserMessage}} - 最后一条用户消息
  MacroRegistry.registerMacro('lastUserMessage', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Content of the last user message',
    returns: 'User message content',
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg?.is_user || msg?.role === 'user') {
          return msg.content ?? msg.mes ?? '';
        }
      }
      return '';
    },
  });

  // {{lastCharMessage}} - 最后一条角色消息
  MacroRegistry.registerMacro('lastCharMessage', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Content of the last character message',
    returns: 'Character message content',
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg?.is_user && msg?.role !== 'user' && msg?.role !== 'system') {
          return msg.content ?? msg.mes ?? '';
        }
      }
      return '';
    },
  });

  // {{firstIncludedMessageId}} - 上下文中第一条消息的索引
  MacroRegistry.registerMacro('firstIncludedMessageId', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Index of the first message included in context',
    returns: 'Message index',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      return String(ctx.env.extra?.firstIncludedMessageId ?? 0);
    },
  });

  // {{firstDisplayedMessageId}} - 显示的第一条消息索引
  MacroRegistry.registerMacro('firstDisplayedMessageId', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Index of the first displayed message',
    returns: 'Message index',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      return String(ctx.env.extra?.firstDisplayedMessageId ?? 0);
    },
  });

  // {{lastSwipeId}} - 最后一条消息的滑动总数（1-based）
  MacroRegistry.registerMacro('lastSwipeId', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Total number of swipes for the last message (1-based)',
    returns: 'Swipe count',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      if (chat.length === 0) return '1';
      const lastMsg = chat[chat.length - 1];
      const swipes = lastMsg?.swipes ?? [lastMsg?.content ?? lastMsg?.mes ?? ''];
      return String(swipes.length);
    },
  });

  // {{currentSwipeId}} - 当前滑动索引（1-based）
  MacroRegistry.registerMacro('currentSwipeId', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Current swipe index (1-based)',
    returns: 'Swipe index',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      if (chat.length === 0) return '1';
      const lastMsg = chat[chat.length - 1];
      const swipeId = lastMsg?.swipe_id ?? 0;
      return String(swipeId + 1); // 转换为1-based
    },
  });

  // {{allChatRange}} - 所有消息ID范围
  MacroRegistry.registerMacro('allChatRange', {
    category: MacroCategory.CHAT,
    unnamedArgs: 0,
    description: 'Range of all message IDs (e.g., "0-99")',
    returns: 'Range string',
    handler: (ctx) => {
      const chat = ctx.env.extra?.chat as any[] ?? [];
      if (chat.length === 0) return '0-0';
      return `0-${chat.length - 1}`;
    },
  });
}
