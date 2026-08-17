/**
 * 补充宏定义 - 填充到100+
 * 基于 SillyTavern 1.18.0 未覆盖的宏
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

// ============================================================
// Bias 注入队列（前端存储）
// ============================================================

/**
 * Bias 文本队列。{{bias::text}} 宏会将文本推入此队列并返回空字符串，
 * 实际的 logit_bias 注入在提示词构建阶段读取。
 *
 * 后端 roleplay_prompt_assembly.py 可通过 chat_metadata 读取此队列并转换为 logit_bias。
 * TODO: 后端尚未实现 bias 读取逻辑，需要在 roleplay_prompt_assembly.py 中添加
 *       从 chat_metadata 读取 bias 队列并注入 logit_bias 的实现。
 */
const biasQueue: string[] = [];

/**
 * 推入 bias 文本
 */
function pushBias(text: string): void {
  if (text) biasQueue.push(text);
}

/**
 * 获取当前 bias 队列（不消费）
 */
export function getBiasQueue(): readonly string[] {
  return biasQueue;
}

/**
 * 消费并清空 bias 队列
 */
export function consumeBiasQueue(): string[] {
  const result = [...biasQueue];
  biasQueue.length = 0;
  return result;
}

/**
 * 清空 bias 队列
 */
export function clearBiasQueue(): void {
  biasQueue.length = 0;
}

/**
 * 注册补充宏
 */
export function registerExtraMacros(): void {
  // ========== 数学宏 ==========

  // {{abs::number}} - 绝对值
  MacroRegistry.registerMacro('abs', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'Number' }],
    description: 'Returns the absolute value',
    returns: 'Absolute value',
    handler: (ctx) => {
      const val = parseFloat(ctx.unnamedArgs[0] ?? '0');
      return String(Math.abs(val));
    },
  });

  // {{ceil::number}} - 向上取整
  MacroRegistry.registerMacro('ceil', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'Number' }],
    description: 'Rounds up to the nearest integer',
    returns: 'Rounded value',
    handler: (ctx) => {
      const val = parseFloat(ctx.unnamedArgs[0] ?? '0');
      return String(Math.ceil(val));
    },
  });

  // {{floor::number}} - 向下取整
  MacroRegistry.registerMacro('floor', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'Number' }],
    description: 'Rounds down to the nearest integer',
    returns: 'Rounded value',
    handler: (ctx) => {
      const val = parseFloat(ctx.unnamedArgs[0] ?? '0');
      return String(Math.floor(val));
    },
  });

  // {{round::number}} - 四舍五入
  MacroRegistry.registerMacro('round', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'Number' }],
    description: 'Rounds to the nearest integer',
    returns: 'Rounded value',
    handler: (ctx) => {
      const val = parseFloat(ctx.unnamedArgs[0] ?? '0');
      return String(Math.round(val));
    },
  });

  // {{max::a::b}} - 最大值
  MacroRegistry.registerMacro('max', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Returns the maximum of two values',
    returns: 'Maximum value',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return String(Math.max(a, b));
    },
  });

  // {{min::a::b}} - 最小值
  MacroRegistry.registerMacro('min', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Returns the minimum of two values',
    returns: 'Minimum value',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return String(Math.min(a, b));
    },
  });

  // {{add::a::b}} - 加法
  MacroRegistry.registerMacro('add', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Adds two numbers',
    returns: 'Sum',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return String(a + b);
    },
  });

  // {{sub::a::b}} - 减法
  MacroRegistry.registerMacro('sub', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Subtracts two numbers',
    returns: 'Difference',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return String(a - b);
    },
  });

  // {{mul::a::b}} - 乘法
  MacroRegistry.registerMacro('mul', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Multiplies two numbers',
    returns: 'Product',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return String(a * b);
    },
  });

  // {{div::a::b}} - 除法
  MacroRegistry.registerMacro('div', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'Dividend' },
      { name: 'b', optional: false, description: 'Divisor' },
    ],
    description: 'Divides two numbers',
    returns: 'Quotient',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '1');
      if (b === 0) return '0';
      return String(a / b);
    },
  });

  // {{mod::a::b}} - 取模
  MacroRegistry.registerMacro('mod', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'Dividend' },
      { name: 'b', optional: false, description: 'Divisor' },
    ],
    description: 'Returns the remainder of division',
    returns: 'Remainder',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '1');
      if (b === 0) return '0';
      return String(a % b);
    },
  });

  // ========== 字符串宏 ==========

  // {{upper::value}} - 大写
  MacroRegistry.registerMacro('upper', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts string to uppercase',
    returns: 'Uppercase string',
    handler: (ctx) => {
      return (ctx.unnamedArgs[0] ?? '').toUpperCase();
    },
  });

  // {{lower::value}} - 小写
  MacroRegistry.registerMacro('lower', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts string to lowercase',
    returns: 'Lowercase string',
    handler: (ctx) => {
      return (ctx.unnamedArgs[0] ?? '').toLowerCase();
    },
  });

  // {{len::value}} - 字符串长度
  MacroRegistry.registerMacro('len', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Returns the length of a string',
    returns: 'Length as string',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      return String((ctx.unnamedArgs[0] ?? '').length);
    },
  });

  // {{substr::value::start::length}} - 子字符串
  MacroRegistry.registerMacro('substr', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'start', optional: false, description: 'Start index' },
      { name: 'length', optional: true, description: 'Length' },
    ],
    description: 'Extracts a substring',
    returns: 'Substring',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const start = parseInt(ctx.unnamedArgs[1] ?? '0', 10);
      const length = ctx.unnamedArgs[2] ? parseInt(ctx.unnamedArgs[2], 10) : undefined;
      if (length !== undefined) {
        return value.substr(start, length);
      }
      return value.substr(start);
    },
  });

  // {{slice::value::start::end}} - 切片
  MacroRegistry.registerMacro('slice', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'start', optional: false, description: 'Start index' },
      { name: 'end', optional: true, description: 'End index' },
    ],
    description: 'Extracts a section of a string',
    returns: 'Sliced string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const start = parseInt(ctx.unnamedArgs[1] ?? '0', 10);
      const end = ctx.unnamedArgs[2] ? parseInt(ctx.unnamedArgs[2], 10) : undefined;
      if (end !== undefined) {
        return value.slice(start, end);
      }
      return value.slice(start);
    },
  });

  // {{replace::value::find::replacement}} - 替换
  MacroRegistry.registerMacro('replace', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'find', optional: false, description: 'Search string' },
      { name: 'replacement', optional: false, description: 'Replacement string' },
    ],
    description: 'Replaces occurrences in a string',
    returns: 'Replaced string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const find = ctx.unnamedArgs[1] ?? '';
      const replacement = ctx.unnamedArgs[2] ?? '';
      return value.split(find).join(replacement);
    },
  });

  // {{repeat::value::count}} - 重复
  MacroRegistry.registerMacro('repeat', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String to repeat' },
      { name: 'count', optional: false, description: 'Number of times' },
    ],
    description: 'Repeats a string N times',
    returns: 'Repeated string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const count = parseInt(ctx.unnamedArgs[1] ?? '1', 10) || 1;
      return value.repeat(Math.max(0, count));
    },
  });

  // {{contains::value::search}} - 包含检查
  MacroRegistry.registerMacro('contains', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'search', optional: false, description: 'Search string' },
    ],
    description: 'Checks if a string contains another string',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const search = ctx.unnamedArgs[1] ?? '';
      return value.includes(search) ? 'true' : 'false';
    },
  });

  // {{startsWith::value::prefix}} - 前缀检查
  MacroRegistry.registerMacro('startsWith', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'prefix', optional: false, description: 'Prefix' },
    ],
    description: 'Checks if a string starts with a prefix',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const prefix = ctx.unnamedArgs[1] ?? '';
      return value.startsWith(prefix) ? 'true' : 'false';
    },
  });

  // {{endsWith::value::suffix}} - 后缀检查
  MacroRegistry.registerMacro('endsWith', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'suffix', optional: false, description: 'Suffix' },
    ],
    description: 'Checks if a string ends with a suffix',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const suffix = ctx.unnamedArgs[1] ?? '';
      return value.endsWith(suffix) ? 'true' : 'false';
    },
  });

  // {{split::value::separator}} - 分割（返回第一个元素）
  MacroRegistry.registerMacro('split', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'separator', optional: false, description: 'Separator' },
      { name: 'index', optional: true, description: 'Index' },
    ],
    description: 'Splits a string and returns element at index',
    returns: 'Split element',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const separator = ctx.unnamedArgs[1] ?? '';
      const index = parseInt(ctx.unnamedArgs[2] ?? '0', 10) || 0;
      const parts = value.split(separator);
      return parts[Math.min(index, parts.length - 1)] ?? '';
    },
  });

  // {{join::list::separator}} - 连接
  MacroRegistry.registerMacro('join', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'list', optional: false, description: 'List of values' },
      { name: 'separator', optional: false, description: 'Separator' },
    ],
    description: 'Joins a list of values with a separator',
    returns: 'Joined string',
    handler: (ctx) => {
      const list = ctx.unnamedArgs[0] ?? '';
      const separator = ctx.unnamedArgs[1] ?? ',';
      return list.split(',').join(separator);
    },
  });

  // {{charAt::value::index}} - 字符索引
  MacroRegistry.registerMacro('charAt', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', optional: false, description: 'String' },
      { name: 'index', optional: false, description: 'Index' },
    ],
    description: 'Returns the character at an index',
    returns: 'Character',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      const index = parseInt(ctx.unnamedArgs[1] ?? '0', 10) || 0;
      return value.charAt(index) ?? '';
    },
  });

  // {{trimStart::value}} - 去除前导空白
  MacroRegistry.registerMacro('trimStart', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Removes leading whitespace',
    returns: 'Trimmed string',
    handler: (ctx) => {
      return (ctx.unnamedArgs[0] ?? '').trimStart();
    },
  });

  // {{trimEnd::value}} - 去除尾部空白
  MacroRegistry.registerMacro('trimEnd', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Removes trailing whitespace',
    returns: 'Trimmed string',
    handler: (ctx) => {
      return (ctx.unnamedArgs[0] ?? '').trimEnd();
    },
  });

  // {{camelCase::value}} - 驼峰命名
  MacroRegistry.registerMacro('camelCase', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts to camelCase',
    returns: 'camelCase string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      return value.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
    },
  });

  // {{snake_case::value}} - 蛇形命名
  MacroRegistry.registerMacro('snake_case', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts to snake_case',
    returns: 'snake_case string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      return value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^_/, '');
    },
  });

  // {{kebab-case::value}} - 短横线命名
  MacroRegistry.registerMacro('kebab-case', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts to kebab-case',
    returns: 'kebab-case string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^-/, '');
    },
  });

  // {{titleCase::value}} - 标题大小写
  MacroRegistry.registerMacro('titleCase', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'String' }],
    description: 'Converts to Title Case',
    returns: 'Title Case string',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0] ?? '';
      return value.replace(/\b\w/g, c => c.toUpperCase());
    },
  });

  // ========== 条件/逻辑宏 ==========

  // {{eq::a::b}} - 等于
  MacroRegistry.registerMacro('eq', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if two values are equal',
    returns: '"true" or "false"',
    handler: (ctx) => {
      return ctx.unnamedArgs[0] === ctx.unnamedArgs[1] ? 'true' : 'false';
    },
  });

  // {{neq::a::b}} - 不等于
  MacroRegistry.registerMacro('neq', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if two values are not equal',
    returns: '"true" or "false"',
    handler: (ctx) => {
      return ctx.unnamedArgs[0] !== ctx.unnamedArgs[1] ? 'true' : 'false';
    },
  });

  // {{gt::a::b}} - 大于
  MacroRegistry.registerMacro('gt', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if a > b',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return a > b ? 'true' : 'false';
    },
  });

  // {{gte::a::b}} - 大于等于
  MacroRegistry.registerMacro('gte', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if a >= b',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return a >= b ? 'true' : 'false';
    },
  });

  // {{lt::a::b}} - 小于
  MacroRegistry.registerMacro('lt', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if a < b',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return a < b ? 'true' : 'false';
    },
  });

  // {{lte::a::b}} - 小于等于
  MacroRegistry.registerMacro('lte', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First value' },
      { name: 'b', optional: false, description: 'Second value' },
    ],
    description: 'Checks if a <= b',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = parseFloat(ctx.unnamedArgs[0] ?? '0');
      const b = parseFloat(ctx.unnamedArgs[1] ?? '0');
      return a <= b ? 'true' : 'false';
    },
  });

  // {{and::a::b}} - 逻辑与
  MacroRegistry.registerMacro('and', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First condition' },
      { name: 'b', optional: false, description: 'Second condition' },
    ],
    description: 'Logical AND',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = ctx.unnamedArgs[0];
      const b = ctx.unnamedArgs[1];
      const aTruthy = a && a !== 'false' && a !== '0';
      const bTruthy = b && b !== 'false' && b !== '0';
      return (aTruthy && bTruthy) ? 'true' : 'false';
    },
  });

  // {{or::a::b}} - 逻辑或
  MacroRegistry.registerMacro('or', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'a', optional: false, description: 'First condition' },
      { name: 'b', optional: false, description: 'Second condition' },
    ],
    description: 'Logical OR',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const a = ctx.unnamedArgs[0];
      const b = ctx.unnamedArgs[1];
      const aTruthy = a && a !== 'false' && a !== '0';
      const bTruthy = b && b !== 'false' && b !== '0';
      return (aTruthy || bTruthy) ? 'true' : 'false';
    },
  });

  // {{not::value}} - 逻辑非
  MacroRegistry.registerMacro('not', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'value', optional: false, description: 'Condition' }],
    description: 'Logical NOT',
    returns: '"true" or "false"',
    handler: (ctx) => {
      const value = ctx.unnamedArgs[0];
      const truthy = value && value !== 'false' && value !== '0';
      return truthy ? 'false' : 'true';
    },
  });

  // {{ternary::condition::trueValue::falseValue}} - 三元运算
  MacroRegistry.registerMacro('ternary', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'condition', optional: false, description: 'Condition' },
      { name: 'trueValue', optional: false, description: 'Value if true' },
      { name: 'falseValue', optional: false, description: 'Value if false' },
    ],
    description: 'Ternary conditional',
    returns: 'Selected value',
    handler: (ctx) => {
      const condition = ctx.unnamedArgs[0];
      const truthy = condition && condition !== 'false' && condition !== '0';
      return truthy ? (ctx.unnamedArgs[1] ?? '') : (ctx.unnamedArgs[2] ?? '');
    },
  });

  // {{bias::text}} - 注入 logit_bias（返回空字符串，由提示词构建阶段读取）
  MacroRegistry.registerMacro('bias', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [{ name: 'text', optional: false, description: 'Text to bias' }],
    description: 'Injects a logit bias for the given text (consumed at prompt assembly time)',
    returns: 'Empty string',
    exampleUsage: '{{bias::special_token}}',
    handler: (ctx) => {
      const text = ctx.unnamedArgs[0] ?? '';
      pushBias(text);
      return '';
    },
  });
}
