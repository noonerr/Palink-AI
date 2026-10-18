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
 *
 * 包 F F-2（2026-10-18）继续在本文件补：`trimstart` `trimend`（逐字移植 ST utils.js
 * 的句子裁剪）、`clipboard-get` `clipboard-set`（浏览器能力）、
 * `translate` `summarize`（B 类薄转发到包C 的 st_extras.py 端点，实测存在：
 * 空体 POST 得 403 而非 404）。交接单 A 类清单里 `matches` `titlecase` `array-foreach`
 * `array-map` `array-filter` `array-length` `split` `join` `trim` `delglobalvar`
 * `listglobalvars` `wait` 等在 ST 1.18 参照源码中**不是注册命令名**，一律未实现
 * （详见 docs/_active/report/REPORT_包F_ST命令补全_2026-10-18.md 的不符清单）。
 */

import { SlashCommandEngine, ARGUMENT_TYPE } from './index';
import type { CommandDefinition } from './index';
import { variableManager } from '../variables/manager';
import { api } from '../../services/api';

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

/** 文本型未命名参数的通用声明（/trimend /clipboard-set /translate 都用它）。 */
const strArg = (name: string, description: string) => ({
  name,
  description,
  type: [ARGUMENT_TYPE.STRING],
  isRequired: false,
});

/**
 * ST utils.js:883 trimToEndSentence 的逐字移植（包 F F-2）。
 * 出处：_reference/sillytavern-1.18.0/public/scripts/utils.js:875-911。
 * 标点集合与「前一个字符是空白就把 last 退到空白前」这两条口径不许改。
 */
function trimToEndSentence(input: string): string {
  if (!input) return '';
  const isEmoji = (x: string) => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(x);
  const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '。', '！', '？', '”', '）', '】', '’', '」', '_']);
  let last = -1;
  const characters = Array.from(input);
  for (let i = characters.length - 1; i >= 0; i -= 1) {
    const char = characters[i];
    const emoji = isEmoji(char);
    if (punctuation.has(char) || emoji) {
      if (!emoji && i > 0 && /[\s\n]/.test(characters[i - 1])) {
        last = i - 1;
      } else {
        last = i;
      }
      break;
    }
  }
  if (last === -1) return input.trimEnd();
  return characters.slice(0, last + 1).join('').trimEnd();
}

/**
 * ST utils.js:914 trimToStartSentence 的逐字移植（包 F F-2）。
 * 出处：_reference/sillytavern-1.18.0/public/scripts/utils.js:913-935。
 * 注意 ST 的怪癖：first 起点取的是 '.' 的下标（可能为 -1），
 * 因此文本里没有 '.' 时，'!' / '?' / '\n' 都**不会**被当成切点 —— 照抄，别"顺手修好"。
 */
function trimToStartSentence(input: string): string {
  if (!input) return '';
  const p1 = input.indexOf('.');
  const p2 = input.indexOf('!');
  const p3 = input.indexOf('?');
  const p4 = input.indexOf('\n');
  let first = p1;
  let skip1 = false;
  if (p2 > 0 && p2 < first) { first = p2; }
  if (p3 > 0 && p3 < first) { first = p3; }
  if (p4 > 0 && p4 < first) { first = p4; skip1 = true; }
  if (first > 0) {
    if (skip1) return input.substring(first + 1);
    return input.substring(first + 2);
  }
  return input;
}

/**
 * ST utils.js copyText 的两级口径（clipboard-set 用）。
 * 先试异步 Clipboard API，不可用或抛错时退回临时 textarea + execCommand。
 */
async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.error('Error writing clipboard:', error);
    }
  }
  if (typeof document === 'undefined') return;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
  } catch (error) {
    console.error('Error writing clipboard (fallback):', error);
  }
  document.body.removeChild(textArea);
}

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

  // ── [包F F-2] 句子裁剪（纯函数，语义逐字照 ST utils.js）─────────
  // 出处：slash-commands.js:2858/2881 注册 trimstart/trimend，
  //       实现 utils.js:883/914；空输入一律返回 ''（trimStartCallback 的 !value 分支）。
  register('trimend', {
    description: 'Trim text to the end of the last full sentence',
    unnamedArgs: [strArg('text', 'text (or pipe)')],
    callback: (_n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      return text ? trimToEndSentence(text) : '';
    },
  });
  register('trimstart', {
    description: 'Trim text to the start of the first full sentence',
    unnamedArgs: [strArg('text', 'text (or pipe)')],
    callback: (_n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      return text ? trimToStartSentence(text) : '';
    },
  });

  // ── [包F F-2] 剪贴板（宿主浏览器能力，无 UI 依赖）───────────────
  // 出处：slash-commands.js:3506 clipboard-get（无 clipboard API 时 warn + 返回 ''，
  //       读失败 console.error + 返回 ''）、slash-commands.js:3527 clipboard-set
  //       （copyText(text) 后返回 ''，helpString 明写 "Returns an empty string"）。
  register('clipboard-get', {
    description: 'Read the OS clipboard text',
    callback: async () => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        console.warn('Clipboard API not available in this context.');
        return '';
      }
      try {
        return await navigator.clipboard.readText();
      } catch (error) {
        console.error('Error reading clipboard:', error);
        return '';
      }
    },
  });
  register('clipboard-set', {
    description: 'Copy the provided text to the OS clipboard',
    unnamedArgs: [strArg('text', 'text to copy to the clipboard')],
    callback: async (_n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      await copyTextToClipboard(text);
      return '';
    },
  });

  // ── [包F F-2] B 类薄转发：目标端点是包C 的 st_extras.py（实测存在）─
  // /translate ← extensions/translate/index.js:779-803：
  //   named: target(语言码) / provider；unnamed: 待译文本；returns: 译文字符串。
  //   ST 缺省 target 取扩展设置，Palink 无该设置 ⇒ 交给后端的 zh-CN 缺省
  //   （TranslateRequest.lang 默认值，st_extras.py:422-427），不在前端另立口径。
  register('translate', {
    description: 'Translate text to a target language',
    namedArgs: [
      { name: 'target', description: 'target language code', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'provider', description: 'translation provider', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    unnamedArgs: [strArg('text', 'the text to translate')],
    callback: async (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      if (!text) return '';
      const target = String(n.target ?? '').trim();
      const provider = String(n.provider ?? '').trim();
      // provider 参与后端 URL 拼接，后端有白名单（_ST_TRANSLATE_PROVIDERS），
      // 非法值由后端 4xx ⇒ 引擎 catch 成 "Error: ..."，不在前端假装成功。
      const url = provider
        ? `/api/translate/${encodeURIComponent(provider)}`
        : '/api/extra/translate';
      const translated = await api.post<string>(url, { text, lang: target || 'zh-CN' });
      return typeof translated === 'string' ? translated : '';
    },
  });
  // /summarize ← extensions/memory/index.js:1085-1105：
  //   named: source / prompt / quiet；unnamed: 待摘要文本。
  //   ST 的"无文本就摘要整段聊天"依赖它自己的会话对象，宿主引擎拿不到消息历史，
  //   因此无文本时 warn + 返回 ''（可诊断），不返回一段编出来的摘要。
  register('summarize', {
    description: 'Summarize the provided text',
    namedArgs: [
      { name: 'source', description: 'API to use for summarization', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'prompt', description: 'prompt to use for summarization', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'quiet', description: 'suppress the toast message', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false },
    ],
    unnamedArgs: [strArg('text', 'text to summarize')],
    callback: async (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '');
      if (!text) {
        console.warn('WARN: /summarize 需要文本（整段聊天摘要依赖 Palink 会话消息，命令引擎不可达）');
        return '';
      }
      const prompt = String(n.prompt ?? '').trim();
      const response = await api.post<{ summary?: string }>('/api/summarize', {
        text,
        params: prompt ? { prompt } : {},
      });
      return typeof response?.summary === 'string' ? response.summary : '';
    },
  });

  const after = SlashCommandEngine.getAllCommands().map((c) => c.name);
  return after.filter((name) => !before.has(name));
}
