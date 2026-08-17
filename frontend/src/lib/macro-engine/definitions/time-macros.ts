/**
 * 时间日期宏定义
 * 基于 SillyTavern 1.18.0 time-macros.js
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * 注册时间日期宏
 */
export function registerTimeMacros(): void {
  // {{time}} - 当前时间（HH:mm格式），可选UTC偏移
  MacroRegistry.registerMacro('time', {
    category: MacroCategory.TIME,
    unnamedArgs: [{
      name: 'offset',
      optional: true,
      sampleValue: 'UTC+8',
      description: 'UTC offset (e.g., UTC+8, UTC-5)',
    }],
    description: 'Current time in HH:mm format',
    returns: 'Time string',
    exampleUsage: ['{{time}}', '{{time::UTC+8}}'],
    handler: (ctx) => {
      const offset = ctx.unnamedArgs[0];
      const now = new Date();
      
      if (offset && offset.toUpperCase().startsWith('UTC')) {
        const match = offset.match(/UTC([+-]\d+)?/i);
        if (match) {
          const hours = parseInt(match[1] ?? '0', 10);
          const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
          const targetTime = new Date(utcTime + hours * 3600000);
          return `${pad(targetTime.getHours())}:${pad(targetTime.getMinutes())}`;
        }
      }
      
      return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    },
  });

  // {{date}} - 当前日期（本地长格式）
  MacroRegistry.registerMacro('date', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current date in locale long format',
    returns: 'Date string',
    handler: () => {
      return new Date().toLocaleDateString(undefined, { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
    },
  });

  // {{weekday}} - 当前星期名
  MacroRegistry.registerMacro('weekday', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current day of the week',
    returns: 'Weekday name',
    handler: () => {
      return new Date().toLocaleDateString(undefined, { weekday: 'long' });
    },
  });

  // {{isotime}} - ISO时间 (HH:mm)
  MacroRegistry.registerMacro('isotime', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current time in ISO format (HH:mm)',
    returns: 'ISO time string',
    handler: () => {
      const now = new Date();
      return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    },
  });

  // {{isodate}} - ISO日期 (YYYY-MM-DD)
  MacroRegistry.registerMacro('isodate', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current date in ISO format (YYYY-MM-DD)',
    returns: 'ISO date string',
    handler: () => {
      const now = new Date();
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    },
  });

  // {{datetimeformat}} - 自定义格式
  MacroRegistry.registerMacro('datetimeformat', {
    category: MacroCategory.TIME,
    unnamedArgs: [{
      name: 'format',
      optional: false,
      sampleValue: 'YYYY-MM-DD HH:mm',
      description: 'Date/time format string',
    }],
    description: 'Custom date/time format',
    returns: 'Formatted date/time',
    exampleUsage: '{{datetimeformat::YYYY-MM-DD HH:mm:ss}}',
    handler: (ctx) => {
      const format = ctx.unnamedArgs[0] ?? '';
      const now = new Date();
      
      // 简化的格式化实现
      return format
        .replace(/YYYY/g, String(now.getFullYear()))
        .replace(/MM/g, pad(now.getMonth() + 1))
        .replace(/DD/g, pad(now.getDate()))
        .replace(/HH/g, pad(now.getHours()))
        .replace(/mm/g, pad(now.getMinutes()))
        .replace(/ss/g, pad(now.getSeconds()));
    },
  });

  // {{idleDuration}} - 距最后用户消息的可读时长
  MacroRegistry.registerMacro('idleDuration', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Human-readable duration since last user message',
    returns: 'Duration string',
    handler: (ctx) => {
      const lastUserMessageTime = ctx.env.extra?.lastUserMessageTime as number | undefined;
      if (!lastUserMessageTime) return '';
      
      const diff = Date.now() - lastUserMessageTime;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
      if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
      return 'just now';
    },
  });

  // {{timeDiff}} - 两个时间点的可读差异
  MacroRegistry.registerMacro('timeDiff', {
    category: MacroCategory.TIME,
    unnamedArgs: [{
      name: 'left',
      optional: false,
      description: 'First time value (ISO string or timestamp)',
    }, {
      name: 'right',
      optional: false,
      description: 'Second time value (ISO string or timestamp)',
    }],
    description: 'Human-readable time difference between two values',
    returns: 'Time difference string',
    handler: (ctx) => {
      const left = parseTimeValue(ctx.unnamedArgs[0]);
      const right = parseTimeValue(ctx.unnamedArgs[1]);
      
      if (isNaN(left) || isNaN(right)) return '';
      
      const diff = Math.abs(right - left);
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
      if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
      return 'less than a minute';
    },
  });

  // {{time_UTC+N}} - UTC偏移时间（兼容旧语法）
  // 这个宏会在前置处理器中被转换为 {{time::UTC+N}}

  // ========== 迁移自 sillytavern/macros/extended.ts ==========

  // {{iso_date}} - ISO 8601 完整日期时间
  MacroRegistry.registerMacro('iso_date', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current date and time in ISO 8601 format',
    returns: 'ISO date string',
    handler: () => new Date().toISOString(),
  });

  // {{unix_time}} - Unix 时间戳（秒）
  MacroRegistry.registerMacro('unix_time', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current Unix timestamp in seconds',
    returns: 'Unix timestamp string',
    handler: () => String(Math.floor(Date.now() / 1000)),
  });

  // {{day}} - 星期名称（英文）
  MacroRegistry.registerMacro('day', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current day of the week (English name)',
    returns: 'Day name',
    handler: () => {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return days[new Date().getDay()];
    },
  });

  // {{month}} - 月份名称（英文）
  MacroRegistry.registerMacro('month', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current month name (English)',
    returns: 'Month name',
    handler: () => {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return months[new Date().getMonth()];
    },
  });

  // {{year}} - 年份（4位）
  MacroRegistry.registerMacro('year', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current year (4 digits)',
    returns: 'Year string',
    handler: () => String(new Date().getFullYear()),
  });

  // {{hour}} - 小时（2位，0填充）
  MacroRegistry.registerMacro('hour', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current hour (2 digits, zero-padded)',
    returns: 'Hour string',
    handler: () => pad(new Date().getHours()),
  });

  // {{minute}} - 分钟（2位，0填充）
  MacroRegistry.registerMacro('minute', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current minute (2 digits, zero-padded)',
    returns: 'Minute string',
    handler: () => pad(new Date().getMinutes()),
  });

  // {{second}} - 秒（2位，0填充）
  MacroRegistry.registerMacro('second', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current second (2 digits, zero-padded)',
    returns: 'Second string',
    handler: () => pad(new Date().getSeconds()),
  });

  // {{datetime}} - 当前日期时间（本地可读格式）
  MacroRegistry.registerMacro('datetime', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current date and time in locale string format',
    returns: 'Date-time string',
    handler: () => new Date().toLocaleString(),
  });

  // {{date_UTC}} - UTC 日期时间
  MacroRegistry.registerMacro('date_UTC', {
    category: MacroCategory.TIME,
    unnamedArgs: 0,
    description: 'Current date and time in UTC string format',
    returns: 'UTC date-time string',
    handler: () => new Date().toUTCString(),
  });
}

/**
 * 数字补零
 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 解析时间值（支持ISO字符串或时间戳）
 */
function parseTimeValue(value: string): number {
  if (!value) return NaN;
  
  // 尝试作为数字时间戳
  const num = Number(value);
  if (!isNaN(num)) return num;
  
  // 尝试作为ISO日期字符串
  const date = new Date(value);
  return date.getTime();
}
