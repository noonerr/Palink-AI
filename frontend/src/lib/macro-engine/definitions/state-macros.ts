/**
 * 运行时状态宏定义
 * 基于 SillyTavern 1.18.0 state-macros.js
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * 注册运行时状态宏
 */
export function registerStateMacros(): void {
  // {{lastGenerationType}} - 最后一次生成请求类型
  MacroRegistry.registerMacro('lastGenerationType', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Type of the last generation request (normal/impersonate/regenerate/quiet/swipe/continue)',
    returns: 'Generation type string',
    handler: (ctx) => {
      return ctx.env.extra?.lastGenerationType as string ?? 'normal';
    },
  });

  // {{hasExtension}} - 检查指定扩展是否启用
  MacroRegistry.registerMacro('hasExtension', {
    category: MacroCategory.STATE,
    unnamedArgs: [{
      name: 'extensionName',
      optional: false,
      description: 'Name of the extension to check',
    }],
    description: 'Checks if a specific extension is enabled',
    returns: '"true" or "false"',
    exampleUsage: '{{hasExtension::tts}}',
    handler: (ctx) => {
      const extensionName = ctx.unnamedArgs[0];
      if (!extensionName) return 'false';
      
      const enabledExtensions = ctx.env.extra?.enabledExtensions as string[] ?? [];
      return enabledExtensions.includes(extensionName.toLowerCase()) ? 'true' : 'false';
    },
  });

  // {{messageDuration}} - 最近一条消息的生成时长（秒）
  MacroRegistry.registerMacro('messageDuration', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Generation duration (seconds) of the last message',
    returns: 'Duration in seconds as string',
    returnType: MacroValueType.NUMBER,
    handler: (ctx) => {
      // 从全局状态获取最近一条消息的生成时长（秒）
      // TODO: 全局状态尚未提供 messageDuration，目前返回默认值 "0"；
      //       待生成流程记录时长后从 ctx.env.extra.messageDuration 注入
      const duration = ctx.env.extra?.messageDuration;
      if (typeof duration === 'number') {
        return String(duration);
      }
      return '0';
    },
  });
}
