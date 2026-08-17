/**
 * 扩展斜杠命令定义
 * 基于 SillyTavern 1.18.0 slash-commands.js
 */

import { SlashCommandEngine, ARGUMENT_TYPE } from './index';
import { BreakSignal, ContinueSignal } from './closure';
import { variableManager } from '../variables/manager';
import { tokenizerService } from '../tokenizer/service';

// ============================================================
// 闭包控制流信号（return / yield）
// ============================================================

/** return 信号：从当前闭包返回一个值 */
class ReturnSignal extends Error {
  constructor(public value: string) {
    super(`return: ${value}`);
    this.name = 'ReturnSignal';
    Object.setPrototypeOf(this, ReturnSignal.prototype);
  }
}

/** yield 信号：从当前闭包暂停并产出一个值 */
class YieldSignal extends Error {
  constructor(public value: string) {
    super(`yield: ${value}`);
    this.name = 'YieldSignal';
    Object.setPrototypeOf(this, YieldSignal.prototype);
  }
}

// ============================================================
// 数组/字符串辅助函数
// ============================================================

/**
 * 将文本解析为数组。
 * 优先按换行分割（管道输出常见格式），否则按空白字符分割。
 */
function parseArray(input: string): string[] {
  if (!input) return [];
  if (input.includes('\n')) {
    return input.split('\n').map(s => s.trim()).filter(s => s);
  }
  return input.split(/\s+/).map(s => s.trim()).filter(s => s);
}

/**
 * Levenshtein 编辑距离，用于模糊匹配。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// ============================================================
// 扩展命令上下文接口
// ============================================================

export interface ExtendedCommandContext {
  // 会话操作
  sendMessage?: (content: string) => Promise<void>;
  editMessage?: (messageId: string, content: string) => Promise<void>;
  deleteMessage?: (messageId: string) => Promise<void>;
  retryMessage?: () => Promise<void>;
  flushMessages?: () => void;

  // 生成操作
  generate?: (prompt: string) => Promise<string>;
  generateQuiet?: (prompt: string) => Promise<string>;

  // 导入导出
  importChat?: (data: string) => Promise<void>;
  exportChat?: (format: string) => string;

  // 变量操作
  getVariable?: (name: string) => string;
  setVariable?: (name: string, value: string) => void;

  // 其他
  getChatName?: () => string;
  setChatName?: (name: string) => void;
}

// ============================================================
// 注册扩展命令
// ============================================================

export function registerExtendedCommands(context: ExtendedCommandContext = {}): void {
  // ========== 聊天控制命令 ==========

  // /send - 发送消息
  SlashCommandEngine.register({
    name: 'send',
    description: 'Send a message',
    aliases: ['say'],
    unnamedArgs: [{
      name: 'message',
      description: 'Message to send',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const message = unnamedArgs.join(' ');
      if (!message) return 'Usage: /send <message>';
      if (context.sendMessage) {
        await context.sendMessage(message);
        return 'Message sent.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:send', { detail: { message } }));
        return 'Message sent.';
      }
      return '';
    },
  });

  // /sys - 发送系统消息
  SlashCommandEngine.register({
    name: 'sys',
    description: 'Send a system message',
    aliases: ['system'],
    unnamedArgs: [{
      name: 'message',
      description: 'System message',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const message = unnamedArgs.join(' ');
      if (!message) return 'Usage: /sys <message>';
      if (context.sendMessage) {
        await context.sendMessage(`[System]: ${message}`);
        return 'System message sent.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:sys', { detail: { message } }));
        return 'System message sent.';
      }
      return '';
    },
  });

  // /continue - 继续生成
  // Task 20: Dispatch a global window event so the active chat view can
  // trigger continuation. The chat view appends "Continue where you left off."
  // to the last AI message context and requests a new generation without
  // adding a visible user message.
  SlashCommandEngine.register({
    name: 'continue',
    description: 'Continue generating',
    aliases: ['cont'],
    callback: async () => {
      if (context.sendMessage) {
        await context.sendMessage('Continue where you left off.');
        return 'Continuing...';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:continue'));
        return 'Continuing...';
      }
      return '';
    },
  });

  // /retry - 重试上一条消息
  SlashCommandEngine.register({
    name: 'retry',
    description: 'Retry the last message',
    aliases: ['regenerate'],
    callback: async () => {
      if (context.retryMessage) {
        await context.retryMessage();
        return 'Retrying...';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:retry'));
        return 'Retrying...';
      }
      return '';
    },
  });

  // /gen - 触发 AI 生成
  SlashCommandEngine.register({
    name: 'gen',
    description: 'Trigger AI generation',
    aliases: ['generate'],
    unnamedArgs: [{
      name: 'prompt',
      description: 'Optional prompt for generation',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const prompt = unnamedArgs.join(' ');
      if (context.generate) {
        const result = await context.generate(prompt);
        return result;
      }
      if (context.generateQuiet) {
        const result = await context.generateQuiet(prompt);
        return result;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:gen', { detail: { prompt } }));
        return 'Generating...';
      }
      return '';
    },
  });

  // /preset - 切换预设
  SlashCommandEngine.register({
    name: 'preset',
    description: 'Switch to a preset',
    unnamedArgs: [{
      name: 'name',
      description: 'Preset name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('slash:preset', { detail: { action: 'list' } }));
        }
        return 'Usage: /preset <name>';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:preset', { detail: { name } }));
      }
      return `Preset: ${name}`;
    },
  });

  // ========== 变量操作命令 ==========

  // /setvar - 设置变量
  SlashCommandEngine.register({
    name: 'setvar',
    description: 'Set a local variable',
    unnamedArgs: [
      { name: 'name', description: 'Variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'value', description: 'Value to set', type: [ARGUMENT_TYPE.STRING], isRequired: true },
    ],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      const value = unnamedArgs[1];
      if (!name || value === undefined) return 'Usage: /setvar <name> <value>';
      variableManager.local.set(name, value);
      return `Variable ${name} set to: ${value}`;
    },
  });

  // /getvar - 获取变量
  SlashCommandEngine.register({
    name: 'getvar',
    description: 'Get a local variable',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /getvar <name>';
      const value = variableManager.local.get(name);
      return `${name} = ${value}`;
    },
  });

  // /addvar - 累加变量
  SlashCommandEngine.register({
    name: 'addvar',
    description: 'Add value to a local variable',
    unnamedArgs: [
      { name: 'name', description: 'Variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'value', description: 'Value to add', type: [ARGUMENT_TYPE.STRING], isRequired: true },
    ],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      const value = unnamedArgs[1];
      if (!name || value === undefined) return 'Usage: /addvar <name> <value>';
      variableManager.local.add(name, value);
      return `Variable ${name} updated.`;
    },
  });

  // /incvar - 自增变量
  SlashCommandEngine.register({
    name: 'incvar',
    description: 'Increment a local variable by 1',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /incvar <name>';
      const value = variableManager.local.increment(name);
      return `${name} = ${value}`;
    },
  });

  // /decvar - 自减变量
  SlashCommandEngine.register({
    name: 'decvar',
    description: 'Decrement a local variable by 1',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /decvar <name>';
      const value = variableManager.local.decrement(name);
      return `${name} = ${value}`;
    },
  });

  // /delvar - 删除变量
  SlashCommandEngine.register({
    name: 'delvar',
    description: 'Delete a local variable',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /delvar <name>';
      variableManager.local.delete(name);
      return `Variable ${name} deleted.`;
    },
  });

  // ========== 全局变量命令 ==========

  // /setglobalvar - 设置全局变量
  SlashCommandEngine.register({
    name: 'setglobalvar',
    description: 'Set a global variable',
    unnamedArgs: [
      { name: 'name', description: 'Variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'value', description: 'Value to set', type: [ARGUMENT_TYPE.STRING], isRequired: true },
    ],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      const value = unnamedArgs[1];
      if (!name || value === undefined) return 'Usage: /setglobalvar <name> <value>';
      variableManager.global.set(name, value);
      return `Global variable ${name} set to: ${value}`;
    },
  });

  // /getglobalvar - 获取全局变量
  SlashCommandEngine.register({
    name: 'getglobalvar',
    description: 'Get a global variable',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /getglobalvar <name>';
      const value = variableManager.global.get(name);
      return `${name} = ${value}`;
    },
  });

  // /delglobalvar - 删除全局变量
  SlashCommandEngine.register({
    name: 'delglobalvar',
    description: 'Delete a global variable',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /delglobalvar <name>';
      variableManager.global.delete(name);
      return `Global variable ${name} deleted.`;
    },
  });

  // ========== 聊天管理命令 ==========

  // /chatname - 获取/设置聊天名称
  SlashCommandEngine.register({
    name: 'chatname',
    description: 'Get or set chat name',
    unnamedArgs: [{
      name: 'name',
      description: 'New chat name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) {
        const current = context.getChatName?.() || 'Unknown';
        return `Current chat: ${current}`;
      }
      if (context.setChatName) {
        context.setChatName(name);
        return `Chat name set to: ${name}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:chatname', { detail: { name } }));
        return `Chat name set to: ${name}`;
      }
      return '';
    },
  });

  // ========== 导入导出命令 ==========

  // /import - 导入对话
  SlashCommandEngine.register({
    name: 'import',
    description: 'Import a conversation',
    unnamedArgs: [{
      name: 'data',
      description: 'Conversation data (JSON)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const data = unnamedArgs.join(' ');
      if (!data) return 'Usage: /import <data>';
      if (context.importChat) {
        await context.importChat(data);
        return 'Conversation imported.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:import', { detail: { data } }));
        return 'Conversation imported.';
      }
      return '';
    },
  });

  // /backup - 备份对话
  SlashCommandEngine.register({
    name: 'backup',
    description: 'Backup the current conversation',
    callback: () => {
      if (context.exportChat) {
        const data = context.exportChat('json');
        return `Backup created (${data.length} bytes).`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:backup'));
        return 'Backup requested.';
      }
      return '';
    },
  });

  // ========== 调试命令 ==========

  // /debug - 调试信息
  SlashCommandEngine.register({
    name: 'debug',
    description: 'Show debug information',
    callback: () => {
      const info = {
        timestamp: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
        language: typeof navigator !== 'undefined' ? navigator.language : 'N/A',
      };
      return JSON.stringify(info, null, 2);
    },
  });

  // /eval - 已移除（安全原因）
  // 直接 eval() 任意用户输入会带来严重的 RCE/XSS 风险，且无法通过 DOMPurify
  // 等 sanitizer 兜底。如需执行表达式，应通过受控的扩展 API 显式注册命令，
  // 而非暴露通用的 JavaScript eval 入口。

  // /echo - 回显
  SlashCommandEngine.register({
    name: 'echo',
    description: 'Echo the input',
    aliases: ['print'],
    unnamedArgs: [{
      name: 'text',
      description: 'Text to echo',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      return unnamedArgs.join(' ') || '';
    },
  });

  // /sleep - 延迟
  SlashCommandEngine.register({
    name: 'sleep',
    description: 'Sleep for a specified duration',
    unnamedArgs: [{
      name: 'ms',
      description: 'Duration in milliseconds',
      type: [ARGUMENT_TYPE.NUMBER],
      isRequired: true,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const ms = parseInt(unnamedArgs[0] ?? '1000', 10);
      await new Promise(resolve => setTimeout(resolve, ms));
      return `Slept for ${ms}ms.`;
    },
  });

  // /random - 随机数
  SlashCommandEngine.register({
    name: 'random',
    description: 'Generate a random number',
    unnamedArgs: [
      { name: 'min', description: 'Minimum value', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
      { name: 'max', description: 'Maximum value', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    callback: (_namedArgs, unnamedArgs) => {
      const min = parseInt(unnamedArgs[0] ?? '1', 10) || 1;
      const max = parseInt(unnamedArgs[1] ?? '100', 10) || 100;
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return String(result);
    },
  });

  // /roll - 掷骰子
  SlashCommandEngine.register({
    name: 'roll',
    description: 'Roll dice (e.g., 2d6, 1d20)',
    unnamedArgs: [{
      name: 'formula',
      description: 'Dice formula',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const formula = unnamedArgs[0] || '1d6';
      const match = formula.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
      if (!match) return `Invalid formula: ${formula}`;
      
      const count = parseInt(match[1], 10);
      const sides = parseInt(match[2], 10);
      const modifier = match[3] ? parseInt(match[3], 10) : 0;
      
      if (count <= 0 || sides <= 0) return '0';
      
      let total = 0;
      const rolls: number[] = [];
      for (let i = 0; i < count; i++) {
        const roll = Math.floor(Math.random() * sides) + 1;
        rolls.push(roll);
        total += roll;
      }
      total += modifier;
      
      return `${formula}: [${rolls.join(', ')}]${modifier ? ` + ${modifier}` : ''} = ${total}`;
    },
  });

  // ========== Task 4: 数组/数学命令 ==========

  // /filter - 数组过滤
  SlashCommandEngine.register({
    name: 'filter',
    description: 'Filter array elements (by contains/regex, or drop empties)',
    namedArgs: [
      { name: 'contains', description: 'Keep items containing this substring', type: [ARGUMENT_TYPE.STRING] },
      { name: 'regex', description: 'Keep items matching this regex pattern', type: [ARGUMENT_TYPE.STRING] },
    ],
    callback: (namedArgs, unnamedArgs, context) => {
      const arrayText = unnamedArgs.join(' ') || context?.pipe || '';
      let items = parseArray(arrayText);
      const hasContains = namedArgs.contains !== undefined;
      const hasRegex = namedArgs.regex !== undefined;

      if (hasContains) {
        items = items.filter(item => item.includes(namedArgs.contains));
      }
      if (hasRegex) {
        try {
          const re = new RegExp(namedArgs.regex);
          items = items.filter(item => re.test(item));
        } catch {
          return `Invalid regex: ${namedArgs.regex}`;
        }
      }
      if (!hasContains && !hasRegex) {
        items = items.filter(item => item.trim() !== '');
      }
      return items.join('\n');
    },
  });

  // /fuzzy - 模糊匹配（返回相似度最高的项）
  SlashCommandEngine.register({
    name: 'fuzzy',
    description: 'Find the best fuzzy match for a query in a list',
    unnamedArgs: [
      { name: 'query', description: 'Query string to match', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'list', description: 'List items (remaining args or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    callback: (_namedArgs, unnamedArgs, context) => {
      const query = (unnamedArgs[0] || '').toLowerCase();
      const listText = unnamedArgs.slice(1).join(' ') || context?.pipe || '';
      const items = parseArray(listText);
      if (!query || items.length === 0) return '';

      let bestMatch = '';
      let bestScore = Infinity;
      for (const item of items) {
        const distance = levenshteinDistance(query, item.toLowerCase());
        if (distance < bestScore) {
          bestScore = distance;
          bestMatch = item;
        }
      }
      return bestMatch;
    },
  });

  // /sort - 排序
  SlashCommandEngine.register({
    name: 'sort',
    description: 'Sort array elements (ascending or descending)',
    namedArgs: [{
      name: 'order',
      description: 'Sort order: asc or desc',
      type: [ARGUMENT_TYPE.ENUM],
      enumList: ['asc', 'desc'],
      defaultValue: 'asc',
    }],
    unnamedArgs: [{
      name: 'array',
      description: 'Array elements (space-separated, or via pipe)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs, context) => {
      const arrayText = unnamedArgs.join(' ') || context?.pipe || '';
      const items = parseArray(arrayText);
      const order = namedArgs.order || 'asc';
      const sorted = [...items].sort((a, b) => {
        const aNum = Number(a);
        const bNum = Number(b);
        if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
        return a.localeCompare(b);
      });
      if (order === 'desc') sorted.reverse();
      return sorted.join('\n');
    },
  });

  // /split - 字符串分割
  SlashCommandEngine.register({
    name: 'split',
    description: 'Split a string by a delimiter',
    unnamedArgs: [
      { name: 'string', description: 'String to split (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'delimiter', description: 'Delimiter (default: space)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs[0] || context?.pipe || '';
      const delimiter = unnamedArgs[1] ?? ' ';
      if (!text) return '';
      return text.split(delimiter).join('\n');
    },
  });

  // /join - 数组连接
  SlashCommandEngine.register({
    name: 'join',
    description: 'Join array elements with a delimiter',
    unnamedArgs: [
      { name: 'array', description: 'Array elements (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'delimiter', description: 'Delimiter (default: space)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    callback: (_namedArgs, unnamedArgs, context) => {
      let delimiter = ' ';
      let arrayText = '';
      if (unnamedArgs.length > 1) {
        delimiter = unnamedArgs[unnamedArgs.length - 1];
        arrayText = unnamedArgs.slice(0, -1).join(' ');
      } else if (unnamedArgs.length === 1) {
        arrayText = unnamedArgs[0];
      }
      if (!arrayText) arrayText = context?.pipe || '';
      const items = parseArray(arrayText);
      return items.join(delimiter);
    },
  });

  // /enumerate - 枚举输出（带索引）
  SlashCommandEngine.register({
    name: 'enumerate',
    description: 'Enumerate array with indices',
    unnamedArgs: [{
      name: 'array',
      description: 'Array elements (or pipe)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const arrayText = unnamedArgs.join(' ') || context?.pipe || '';
      const items = parseArray(arrayText);
      return items.map((item, index) => `${index}: ${item}`).join('\n');
    },
  });

  // /abs - 绝对值
  SlashCommandEngine.register({
    name: 'abs',
    description: 'Return the absolute value of a number',
    unnamedArgs: [{
      name: 'number',
      description: 'Number (or pipe)',
      type: [ARGUMENT_TYPE.NUMBER],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const numStr = unnamedArgs[0] || context?.pipe || '0';
      const num = parseFloat(numStr);
      if (isNaN(num)) return '0';
      return String(Math.abs(num));
    },
  });

  // /trim - 去除首尾空白
  SlashCommandEngine.register({
    name: 'trim',
    description: 'Trim leading and trailing whitespace (uses pipe or args)',
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      return text.trim();
    },
  });

  // /shuffle - 随机打乱
  SlashCommandEngine.register({
    name: 'shuffle',
    description: 'Shuffle array elements randomly',
    unnamedArgs: [{
      name: 'array',
      description: 'Array elements (or pipe)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const arrayText = unnamedArgs.join(' ') || context?.pipe || '';
      const items = parseArray(arrayText);
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items.join('\n');
    },
  });

  // /pick - 随机选取一项
  SlashCommandEngine.register({
    name: 'pick',
    description: 'Pick a random element from an array',
    aliases: ['choose'],
    unnamedArgs: [{
      name: 'array',
      description: 'Array elements (or pipe)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const arrayText = unnamedArgs.join(' ') || context?.pipe || '';
      const items = parseArray(arrayText);
      if (items.length === 0) return '';
      return items[Math.floor(Math.random() * items.length)];
    },
  });

  // ========== Task 5: 流程控制命令 ==========

  // /run - 运行闭包/命令文本
  SlashCommandEngine.register({
    name: 'run',
    description: 'Run a command string in the current scope',
    unnamedArgs: [{
      name: 'command',
      description: 'Command text to execute',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const cmdText = unnamedArgs.join(' ');
      if (!cmdText) return context?.pipe || '';
      if (scope) {
        return await SlashCommandEngine.executeInScope(cmdText, scope);
      }
      return cmdText;
    },
  });

  // /delay - 延迟执行
  SlashCommandEngine.register({
    name: 'delay',
    description: 'Delay execution for a specified duration (ms)',
    unnamedArgs: [{
      name: 'ms',
      description: 'Duration in milliseconds',
      type: [ARGUMENT_TYPE.NUMBER],
      isRequired: true,
    }],
    callback: async (_namedArgs, unnamedArgs) => {
      const ms = parseInt(unnamedArgs[0] ?? '1000', 10);
      if (isNaN(ms) || ms < 0) return 'Invalid duration.';
      await new Promise(resolve => setTimeout(resolve, ms));
      return '';
    },
  });

  // /return - 闭包返回
  SlashCommandEngine.register({
    name: 'return',
    description: 'Return a value from the current closure',
    unnamedArgs: [{
      name: 'value',
      description: 'Value to return',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      throw new ReturnSignal(unnamedArgs.join(' '));
    },
  });

  // /yield - 闭包暂停
  SlashCommandEngine.register({
    name: 'yield',
    description: 'Yield a value from the current closure',
    unnamedArgs: [{
      name: 'value',
      description: 'Value to yield',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      throw new YieldSignal(unnamedArgs.join(' '));
    },
  });

  // /break - 中断循环
  SlashCommandEngine.register({
    name: 'break',
    description: 'Break out of the current loop',
    callback: () => {
      throw new BreakSignal();
    },
  });

  // /continue:loop - 跳过当前迭代（/continue 保留给"继续生成"用）
  SlashCommandEngine.register({
    name: 'continue:loop',
    description: 'Skip to the next iteration of the current loop',
    callback: () => {
      throw new ContinueSignal();
    },
  });

  // /catch - 捕获异常
  SlashCommandEngine.register({
    name: 'catch',
    description: 'Execute a command and catch any errors',
    unnamedArgs: [{
      name: 'command',
      description: 'Command text to execute',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const cmdText = unnamedArgs.join(' ');
      if (!cmdText) return '';
      try {
        if (scope) {
          return await SlashCommandEngine.executeInScope(cmdText, scope);
        }
        return cmdText;
      } catch (e) {
        // break/continue 是循环控制信号，必须向上传播给循环处理器
        if (e instanceof BreakSignal) throw e;
        if (e instanceof ContinueSignal) throw e;
        // return/yield 是闭包控制信号，作为值返回
        if (e instanceof ReturnSignal) return e.value;
        if (e instanceof YieldSignal) return e.value;
        return `Caught: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // /throw - 抛出异常
  SlashCommandEngine.register({
    name: 'throw',
    description: 'Throw an error with a message',
    unnamedArgs: [{
      name: 'message',
      description: 'Error message',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const message = unnamedArgs.join(' ') || 'Error thrown';
      throw new Error(message);
    },
  });

  // ========== Task 6: 会话操作命令 ==========

  // /flush - 清空未发送消息
  SlashCommandEngine.register({
    name: 'flush',
    description: 'Flush unsent messages',
    callback: () => {
      if (context.flushMessages) {
        context.flushMessages();
        return 'Messages flushed.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:flush'));
      }
      return 'Flush requested.';
    },
  });

  // /newline - 插入换行
  SlashCommandEngine.register({
    name: 'newline',
    description: 'Insert a newline character',
    callback: () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:newline'));
      }
      return '\n';
    },
  });

  // /background - 切换聊天背景
  SlashCommandEngine.register({
    name: 'background',
    description: 'Change the chat background image',
    unnamedArgs: [{
      name: 'url',
      description: 'Background image URL',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const url = unnamedArgs[0];
      if (!url) return 'Usage: /background <url>';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:background', { detail: { url } }));
      }
      return `Background set to: ${url}`;
    },
  });

  // /emotion - 切换角色表情
  SlashCommandEngine.register({
    name: 'emotion',
    description: 'Change the character expression',
    unnamedArgs: [{
      name: 'name',
      description: 'Expression name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /emotion <name>';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:emotion', { detail: { name } }));
      }
      return `Expression set to: ${name}`;
    },
  });

  // /lock - 锁定群组成员
  SlashCommandEngine.register({
    name: 'lock',
    description: 'Lock a group member',
    unnamedArgs: [{
      name: 'member_id',
      description: 'Member ID to lock',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const memberId = unnamedArgs[0];
      if (!memberId) return 'Usage: /lock <member_id>';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:lock', { detail: { memberId } }));
      }
      return `Member ${memberId} locked.`;
    },
  });

  // /profile - 切换预设
  SlashCommandEngine.register({
    name: 'profile',
    description: 'Switch to a preset profile',
    unnamedArgs: [{
      name: 'name',
      description: 'Preset name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs) => {
      const name = unnamedArgs[0];
      if (!name) return 'Usage: /profile <name>';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:profile', { detail: { name } }));
      }
      return `Profile switched to: ${name}`;
    },
  });

  // /tokens - 真实 token 计数（调用后端 tokenizer）
  SlashCommandEngine.register({
    name: 'tokens',
    description: 'Count tokens in text (calls backend tokenizer)',
    aliases: ['tokenize', 'count_tokens'],
    unnamedArgs: [{
      name: 'text',
      description: 'Text to count tokens for (or pipe)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: async (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      if (!text) return '0';
      try {
        const result = await tokenizerService.count(text);
        return String(result.count);
      } catch {
        return String(tokenizerService.estimate(text));
      }
    },
  });
}
