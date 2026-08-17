/**
 * 核心工具宏定义
 * 基于 SillyTavern 1.18.0 core-macros.js
 */

import { MacroCategory, MacroValueType } from '../types';
import type { MacroExecutionContext } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * else分支标记
 */
export const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

/**
 * 注册核心工具宏
 */
export function registerCoreMacros(): void {
  // {{space}} - 插入空格
  MacroRegistry.registerMacro('space', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'count',
      optional: true,
      defaultValue: '1',
      type: MacroValueType.INTEGER,
      description: 'Number of spaces to insert',
    }],
    description: 'Inserts one or more spaces',
    returns: 'Spaces string',
    handler: (ctx) => {
      const count = parseInt(ctx.unnamedArgs[0] ?? '1', 10) || 1;
      return ' '.repeat(Math.max(1, count));
    },
  });

  // {{newline}} - 插入换行
  MacroRegistry.registerMacro('newline', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'count',
      optional: true,
      defaultValue: '1',
      type: MacroValueType.INTEGER,
      description: 'Number of newlines to insert',
    }],
    description: 'Inserts one or more newlines',
    returns: 'Newlines string',
    handler: (ctx) => {
      const count = parseInt(ctx.unnamedArgs[0] ?? '1', 10) || 1;
      return '\n'.repeat(Math.max(1, count));
    },
  });

  // {{noop}} - 返回空字符串
  MacroRegistry.registerMacro('noop', {
    category: MacroCategory.UTILITY,
    unnamedArgs: 0,
    description: 'Returns an empty string (no operation)',
    returns: 'Empty string',
    handler: () => '',
  });

  // {{trim}} - 修剪空白
  MacroRegistry.registerMacro('trim', {
    category: MacroCategory.UTILITY,
    unnamedArgs: 0,
    description: 'Trims whitespace from the scoped content',
    returns: 'Trimmed text',
    handler: (ctx) => {
      return ctx.trimContent(ctx.raw);
    },
  });

  // {{if}} - 条件分支
  MacroRegistry.registerMacro('if', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'condition',
      optional: false,
      description: 'Condition to evaluate',
    }, {
      name: 'content',
      optional: true,
      description: 'Content to return if true',
    }],
    description: 'Conditional branch. Supports {{else}} for false branch.',
    returns: 'Content based on condition',
    handler: (ctx) => {
      let condition = ctx.unnamedArgs[0] ?? '';
      
      // 检查 ! 前缀（取反）
      let inverted = false;
      if (condition.startsWith('!')) {
        inverted = true;
        condition = condition.slice(1).trim();
      }

      // 解析条件值
      const conditionValue = condition;

      // 判断是否为 falsy
      const isFalsy = conditionValue === '' || 
                      conditionValue.toLowerCase() === 'false' || 
                      conditionValue === '0';

      const isTrue = inverted ? isFalsy : !isFalsy;

      // 分离 then/else 分支
      const content = ctx.unnamedArgs[1] ?? '';
      const elseIdx = content.indexOf(ELSE_MARKER);
      
      if (elseIdx >= 0) {
        const thenPart = content.slice(0, elseIdx);
        const elsePart = content.slice(elseIdx + ELSE_MARKER.length);
        return isTrue ? thenPart : elsePart;
      }

      return isTrue ? content : '';
    },
  });

  // {{else}} - else分支标记
  MacroRegistry.registerMacro('else', {
    category: MacroCategory.UTILITY,
    unnamedArgs: 0,
    description: 'Marks the else branch in an {{if}} block',
    returns: 'Else marker',
    handler: () => ELSE_MARKER,
  });

  // {{input}} - 当前输入框内容
  MacroRegistry.registerMacro('input', {
    category: MacroCategory.UTILITY,
    unnamedArgs: 0,
    description: 'Returns the current chat input text',
    returns: 'Input text',
    handler: (ctx) => {
      return ctx.env.extra?.input as string ?? '';
    },
  });

  // {{maxPrompt}} - 最大提示上下文大小
  MacroRegistry.registerMacro('maxPrompt', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Returns the maximum prompt context size',
    returns: 'Number as string',
    handler: (ctx) => {
      return String(ctx.env.extra?.maxPrompt ?? 4096);
    },
  });

  // {{maxContext}} - 最大上下文token限制
  MacroRegistry.registerMacro('maxContext', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Returns the maximum context token limit',
    returns: 'Number as string',
    handler: (ctx) => {
      return String(ctx.env.extra?.maxContext ?? 4096);
    },
  });

  // {{maxResponse}} - 最大响应token限制
  MacroRegistry.registerMacro('maxResponse', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Returns the maximum response token limit',
    returns: 'Number as string',
    handler: (ctx) => {
      return String(ctx.env.extra?.maxResponse ?? 1024);
    },
  });

  // {{reverse}} - 反转字符串
  MacroRegistry.registerMacro('reverse', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'value',
      optional: false,
      description: 'String to reverse',
    }],
    description: 'Reverses a string',
    returns: 'Reversed string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      return value.split('').reverse().join('');
    },
  });

  // {{comment}} - 注释宏（原 ST 的 {{//}} 语法，宏名需匹配 /^[a-zA-Z][\w\-_]*$/）
  MacroRegistry.registerMacro('comment', {
    category: MacroCategory.UTILITY,
    unnamedArgs: 0,
    list: { min: 0, max: Infinity },
    strictArgs: false,
    description: 'Comment macro - content is ignored',
    returns: 'Empty string',
    handler: () => '',
  });

  // {{roll}} - 骰子投掷
  MacroRegistry.registerMacro('roll', {
    category: MacroCategory.RANDOM,
    unnamedArgs: [{
      name: 'formula',
      optional: false,
      sampleValue: '2d6',
      description: 'Dice formula (e.g., 2d6, 1d20+5)',
    }],
    description: 'Rolls dice using standard notation',
    returns: 'Roll result as string',
    handler: (ctx) => {
      const formula = ctx.unnamedArgs[0] ?? '1d6';
      return rollDice(formula);
    },
  });

  // {{random}} - 随机选择（每次重新掷）
  MacroRegistry.registerMacro('random', {
    category: MacroCategory.RANDOM,
    unnamedArgs: 0,
    list: { min: 1, max: Infinity },
    description: 'Randomly selects one item from the list (re-rolls each time)',
    returns: 'Selected item',
    handler: (ctx) => {
      if (!ctx.list || ctx.list.length === 0) return '';
      const idx = Math.floor(Math.random() * ctx.list.length);
      return ctx.list[idx];
    },
  });

  // {{pick}} - 确定性随机选择（位置+聊天绑定）
  MacroRegistry.registerMacro('pick', {
    category: MacroCategory.RANDOM,
    unnamedArgs: 0,
    list: { min: 1, max: Infinity },
    description: 'Deterministically selects one item based on position and chat',
    returns: 'Selected item',
    handler: (ctx) => {
      if (!ctx.list || ctx.list.length === 0) return '';
      // 使用全局偏移量作为种子，确保同一位置总是选择同一项
      const seed = ctx.globalOffset;
      const idx = seed % ctx.list.length;
      return ctx.list[Math.abs(idx)];
    },
  });

  // {{banned}} - 禁用词
  MacroRegistry.registerMacro('banned', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'word',
      optional: false,
      description: 'Word to ban',
    }],
    description: 'Adds a word to the banned words list',
    returns: 'Empty string',
    handler: (ctx) => {
      const word = ctx.unnamedArgs[0] ?? '';
      if (word) {
        // 触发禁用词事件
        ctx.env.extra?.banWord?.(word);
      }
      return '';
    },
  });

  // {{outlet}} - 世界信息出口提示
  MacroRegistry.registerMacro('outlet', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{
      name: 'key',
      optional: false,
      description: 'Outlet key',
    }],
    description: 'World info outlet hint',
    returns: 'Empty string',
    handler: () => '',
  });
}

/**
 * 骰子投掷实现
 */
function rollDice(formula: string): string {
  // 解析骰子公式，如 2d6, 1d20+5, 4d8-2
  const match = formula.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    return formula; // 无法解析，返回原样
  }

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (count <= 0 || sides <= 0) {
    return '0';
  }

  let total = 0;
  for (let i = 0; i < count; i++) {
    total += Math.floor(Math.random() * sides) + 1;
  }
  total += modifier;

  return String(Math.max(0, total));
}
