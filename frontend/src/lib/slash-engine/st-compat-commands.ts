/**
 * ST 兼容斜杠命令补充（宿主侧，三条轨共享）
 *
 * 背景（2026-10-18，包 B B-1）：
 *   Palink 的 `SlashCommandEngine` 有 75 条内置命令，但**没有一个**与 ST 1.18 的
 *   数学/文本类命令同名可用（ST 289 条里 Palink 只覆盖 30 条，且多为语义不同的同名项）。
 *   卡脚本大量使用 `/add` `/sub` `/len` `/upper` `/array-wrap` 这类纯函数命令做数值与
 *   字符串处理，缺了就只能拿到空串。
 *
 * 设计红线（照 HANDOFF §4）：
 *   1. **不写假实现**。只注册"效果可验证"的命令（纯函数 / 变量 / console）。
 *      需要 UI 或后端能力而 Palink 没有对应物的命令（`/bg` `/panels` `/theme`
 *      `/movingbar` 等 ST UI 类，以及 `/inject` `/sysprompt` 这类需要宿主注入存储的）
 *      **一律不注册**——不注册时引擎报 "Unknown command"（可诊断），
 *      比返回一个"看起来成功"的空串更安全。
 *   2. **语义照抄 ST**，不自己发明。数值命令按
 *      `_reference/sillytavern-1.18.0/public/scripts/variables.js` 的
 *      `parseNumericSeries` / `performOperation` 逐条移植（含"非法值过滤""除零返回 0"
 *      "结果 NaN 归一为 0"三个降级口径）。
 *   3. 注册进**宿主引擎**而不是帧内：沙箱轨 / getContext 轨 / 单间轨（iframe）三处共享，
 *      帧内只需一条桥（`part-07.ts` 的 executeSlashCommandCompat 未命中分支）。
 *
 * 命名冲突：与 Palink 已有命令同名的（`abs` `random` `sort` `pick` `length` 等）
 * **不覆盖**——引擎 Map 后写覆盖先写，覆盖会静默改变既有行为。
 */

import { SlashCommandEngine, ARGUMENT_TYPE } from './index';
import type { CommandDefinition } from './index';
import { variableManager } from '../variables/manager';

/** ST 的数值序列解析：空格分隔 / JSON 数组 / 变量名，非法值直接丢弃。 */
function parseNumericSeries(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  let values: (string | number)[] = Array.isArray(value)
    ? (value as (string | number)[])
    : String(value ?? '').split(' ');
  if (values.length === 1 && typeof values[0] === 'string') {
    const only = values[0].trim();
    if (only.startsWith('[')) {
      try {
        const parsed = JSON.parse(only);
        if (Array.isArray(parsed)) values = parsed as (string | number)[];
      } catch {
        // 不是合法 JSON 就按空格拆（与 ST 的 convertValueType 降级口径一致）
        values = only.split(' ');
      }
    } else {
      values = only.split(' ');
    }
  }
  return values
    .map((i) => (typeof i === 'string' ? i.trim() : i))
    .filter((i) => i !== '')
    .map((i) => (Number.isNaN(Number(i)) ? Number(variableManager.resolveVariable(String(i))) : Number(i)))
    .filter((i) => !Number.isNaN(i));
}

/** ST 的 performOperation：空输入 / 结果 NaN 一律归一为 "0"。 */
function performOperation(value: unknown, op: (arr: number[]) => number, single = false): string {
  if (!value) return '0';
  const array = parseNumericSeries(value);
  if (array.length === 0) return '0';
  const result = single ? op([array[0]]) : op(array);
  if (Number.isNaN(result)) return '0';
  return String(result);
}

/** 文本命令的取值口径：有未命名参数用参数，否则用管道输入（与 ST / Palink 既有命令一致）。 */
function textOf(unnamedArgs: string[], pipe: string): string {
  const joined = unnamedArgs.join(' ');
  return joined || pipe || '';
}

/**
 * 宽松数组解析。
 *
 * 引擎的 splitCommandParts 会剥掉引号（`["a","b"]` → `[a,b]`），所以 ST 里合法的
 * JSON 数组字面量到 callback 时已经不是合法 JSON。这里先试 JSON.parse，失败再按
 * 逗号/空白拆并去引号 —— 与 ST `convertValueType` 对数组的宽容口径一致。
 */
function parseArrayLoose(raw: string): string[] | null {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v ?? ''));
  } catch {
    // 落到宽松拆分
  }
  return text
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '');
}

const registered = new Set<string>();

/** 幂等注册一条命令；与既有命令重名时跳过（不覆盖）。 */
function register(name: string, def: Omit<CommandDefinition, 'name'>): void {
  if (registered.has(name)) return;
  if (SlashCommandEngine.getCommand(name)) return;
  SlashCommandEngine.register({ ...def, name });
  registered.add(name);
}

/**
 * 注册 ST 兼容补充命令。幂等，可重复调用。
 * @returns 本次实际新增的命令名
 */
export function registerStCompatCommands(): string[] {
  const before = new Set(SlashCommandEngine.getAllCommands().map((c) => c.name));

  const numArg = (description: string) => ({
    name: 'value',
    description,
    type: [ARGUMENT_TYPE.NUMBER],
    isRequired: false,
  });

  // ── 数值命令（照 variables.js 移植）────────────────────────────
  register('add', {
    description: 'Sum the provided values and pass the result down the pipe',
    unnamedArgs: [numArg('values to sum')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => a.reduce((x, y) => x + y, 0)),
  });
  register('sub', {
    description: 'Subtract the provided values from the first one',
    unnamedArgs: [numArg('values to subtract')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => a.slice(1).reduce((x, y) => x - y, a[0] ?? 0)),
  });
  register('mul', {
    description: 'Multiply the provided values',
    unnamedArgs: [numArg('values to multiply')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => a.reduce((x, y) => x * y, 1)),
  });
  register('div', {
    description: 'Divide two values',
    unnamedArgs: [numArg('dividend'), numArg('divisor')],
    callback: (_n, u) =>
      performOperation(u.join(' '), (a) => {
        if (a[1] === 0) return 0;
        return a.slice(1).reduce((x, y) => x / y, a[0] ?? 0);
      }),
  });
  register('mod', {
    description: 'Modulo of two values',
    unnamedArgs: [numArg('dividend'), numArg('divisor')],
    callback: (_n, u) =>
      performOperation(u.join(' '), (a) => {
        if (a[1] === 0) return 0;
        return a.slice(1).reduce((x, y) => x % y, a[0] ?? 0);
      }),
  });
  register('pow', {
    description: 'Power of two values',
    unnamedArgs: [numArg('base'), numArg('exponent')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.pow(a[0] ?? 0, a[1] ?? 0)),
  });
  register('round', {
    description: 'Round a value to the given number of decimals',
    unnamedArgs: [numArg('value'), numArg('decimals')],
    callback: (_n, u) =>
      performOperation(u.join(' '), (a) => {
        const decimals = Math.max(0, Math.min(15, Math.trunc(a[1] ?? 0)));
        const factor = Math.pow(10, decimals);
        return Math.round((a[0] ?? 0) * factor) / factor;
      }),
  });
  register('min', {
    description: 'Smallest of the provided values',
    unnamedArgs: [numArg('values')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.min(...a)),
  });
  register('max', {
    description: 'Largest of the provided values',
    unnamedArgs: [numArg('values')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.max(...a)),
  });
  register('sqrt', {
    description: 'Square root of a value',
    unnamedArgs: [numArg('value')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.sqrt(a[0] ?? 0), true),
  });
  register('cos', {
    description: 'Cosine of a value in radians',
    unnamedArgs: [numArg('value')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.cos(a[0] ?? 0), true),
  });
  register('sin', {
    description: 'Sine of a value in radians',
    unnamedArgs: [numArg('value')],
    callback: (_n, u) => performOperation(u.join(' '), (a) => Math.sin(a[0] ?? 0), true),
  });
  register('rand', {
    description: 'Random number between from and to (inclusive)',
    namedArgs: [
      { name: 'from', description: 'start of range (inclusive)', type: [ARGUMENT_TYPE.NUMBER], isRequired: false, defaultValue: '0' },
      { name: 'to', description: 'end of range (inclusive)', type: [ARGUMENT_TYPE.NUMBER], isRequired: false, defaultValue: '1' },
      { name: 'round', description: 'round / ceil / floor', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    unnamedArgs: [{ name: 'to', description: 'end of range', type: [ARGUMENT_TYPE.NUMBER], isRequired: false }],
    callback: (n, u) => {
      const from = Number(n.from ?? 0);
      const toRaw = n.to ?? (u[0] ?? '1');
      const to = Number(toRaw);
      const raw = from + Math.random() * (to - from);
      const mode = String(n.round ?? '');
      const value = mode === 'ceil' ? Math.ceil(raw) : mode === 'floor' ? Math.floor(raw) : Math.round(raw);
      return String(value);
    },
  });

  // ── 文本 / 数组命令 ────────────────────────────────────────────
  register('upper', {
    description: 'Convert text to uppercase',
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => textOf(u, c?.pipe ?? '').toUpperCase(),
  });
  register('lower', {
    description: 'Convert text to lowercase',
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => textOf(u, c?.pipe ?? '').toLowerCase(),
  });
  register('substr', {
    description: 'Slice text between start and end (end exclusive)',
    namedArgs: [
      { name: 'start', description: 'start index', type: [ARGUMENT_TYPE.NUMBER], isRequired: false, defaultValue: '0' },
      { name: 'end', description: 'end index', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      const start = Number(n.start ?? 0);
      const end = n.end === undefined || n.end === '' ? undefined : Number(n.end);
      return text.slice(start, end);
    },
  });
  register('len', {
    description: 'Length of the provided value (string length, array length, key count)',
    unnamedArgs: [{ name: 'value', description: 'value (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => {
      const raw = textOf(u, c?.pipe ?? '');
      const arr = parseArrayLoose(raw);
      if (arr) return String(arr.length);
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return String(Object.keys(parsed).length);
        } catch {
          // 非 JSON 按字符串长度处理
        }
      }
      return String(raw.length);
    },
  });
  register('array-wrap', {
    description: 'Wrap a single value into an array if it is not one already',
    unnamedArgs: [{ name: 'value', description: 'value (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => {
      const raw = textOf(u, c?.pipe ?? '');
      if (!raw) return '[]';
      const arr = parseArrayLoose(raw);
      if (arr) return JSON.stringify(arr);
      return JSON.stringify([raw]);
    },
  });
  register('array-unwrap', {
    description: 'Return the first element of an array value',
    unnamedArgs: [{ name: 'value', description: 'JSON array (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => {
      const raw = textOf(u, c?.pipe ?? '');
      if (!raw) return '';
      const arr = parseArrayLoose(raw);
      if (arr) return arr.length ? arr[0] : '';
      return raw;
    },
  });
  register('match', {
    description: 'Match text against a regular expression, returns JSON array of groups',
    namedArgs: [
      { name: 'pattern', description: 'regular expression', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'flags', description: 'regex flags', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      const pattern = String(n.pattern ?? '');
      if (!pattern) return '[]';
      try {
        const re = new RegExp(pattern, String(n.flags ?? ''));
        const m = text.match(re);
        return JSON.stringify(m ? Array.from(m) : []);
      } catch {
        return '[]';
      }
    },
  });
  register('replace', {
    description: 'Replace occurrences of a pattern in text',
    namedArgs: [
      { name: 'mode', description: 'literal or regex', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: 'literal' },
      { name: 'pattern', description: 'search pattern', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'replacer', description: 'replacement text', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: '' },
    ],
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      const pattern = String(n.pattern ?? '');
      const replacer = String(n.replacer ?? '');
      if (!pattern) return text;
      if (String(n.mode ?? 'literal') === 'regex') {
        try {
          return text.replace(new RegExp(pattern, 'g'), replacer);
        } catch {
          return text;
        }
      }
      return text.split(pattern).join(replacer);
    },
  });

  // ── 控制流 ────────────────────────────────────────────────────
  register('pass', {
    description: 'Pass the provided value through the pipe unchanged',
    unnamedArgs: [{ name: 'text', description: 'text (or pipe)', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => textOf(u, c?.pipe ?? ''),
  });
  register('times', {
    description: 'Run a command a fixed number of times; {{timesIndex}} is replaced each round',
    unnamedArgs: [{ name: 'count', description: 'repeat count', type: [ARGUMENT_TYPE.NUMBER], isRequired: true }],
    callback: async (_n, u) => {
      const [countRaw, ...rest] = u;
      const count = Math.max(0, Math.min(1000, Math.trunc(Number(countRaw ?? 0)) || 0));
      const command = rest.join(' ').trim();
      if (!count || !command) return '';
      let last = '';
      for (let i = 0; i < count; i += 1) {
        // 与 ST 一致：{{timesIndex}} 每轮替换为当前下标
        const result = await SlashCommandEngine.execute(command.replace(/\{\{timesIndex\}\}/g, String(i)));
        last = result?.output ?? '';
      }
      return last;
    },
  });

  // ── 变量命令（ST 的 global 变体）────────────────────────────────
  const globalVarName = (u: string[]) => String(u[0] ?? '').trim();
  register('addglobalvar', {
    description: 'Add a value to a global variable',
    unnamedArgs: [
      { name: 'name', description: 'variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true },
      { name: 'value', description: 'value to add', type: [ARGUMENT_TYPE.STRING], isRequired: true },
    ],
    callback: (_n, u) => {
      const name = globalVarName(u);
      if (!name) return '';
      return String(variableManager.global.add(name, String(u[1] ?? '')));
    },
  });
  register('incglobalvar', {
    description: 'Increment a global variable by 1',
    unnamedArgs: [{ name: 'name', description: 'variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true }],
    callback: (_n, u) => {
      const name = globalVarName(u);
      if (!name) return '';
      return String(variableManager.global.increment(name));
    },
  });
  register('decglobalvar', {
    description: 'Decrement a global variable by 1',
    unnamedArgs: [{ name: 'name', description: 'variable name', type: [ARGUMENT_TYPE.STRING], isRequired: true }],
    callback: (_n, u) => {
      const name = globalVarName(u);
      if (!name) return '';
      return String(variableManager.global.decrement(name));
    },
  });
  register('flushglobalvar', {
    description: 'Delete all global variables',
    callback: () => {
      const all = variableManager.global.list();
      for (const key of Object.keys(all)) variableManager.global.delete(key);
      return '';
    },
  });
  register('flushvar', {
    description: 'Delete all local (chat-scoped) variables',
    callback: () => {
      const all = variableManager.local.list();
      for (const key of Object.keys(all)) variableManager.local.delete(key);
      return '';
    },
  });
  register('listvar', {
    description: 'List all local variables as JSON',
    callback: () => JSON.stringify(variableManager.local.list()),
  });

  // ── 诊断 ──────────────────────────────────────────────────────
  register('log', {
    description: 'Write a message to the browser console',
    unnamedArgs: [{ name: 'text', description: 'text to log', type: [ARGUMENT_TYPE.STRING], isRequired: false }],
    callback: (_n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      console.log('[slash /log]', text);
      return text;
    },
  });

  const after = SlashCommandEngine.getAllCommands().map((c) => c.name);
  return after.filter((name) => !before.has(name));
}
