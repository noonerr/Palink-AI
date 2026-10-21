/*
 * 模板串字面量守卫（包AF · 2026-10-20）
 *
 * 要防的事故：往 runtime-body/part-0N.ts 的**注释里**写一个反引号，
 * 会把那段注入 iframe 的模板字符串提前闭合 —— 编译器只给几条 TS1005，
 * 不告诉你哪一行是元凶；今天已经踩了两次，其中一次工作区停在编译不过的状态。
 *
 * 本守卫是**纯字面量**的：只 readFileSync 读 8 个段文件的原文，
 * 不求值、不 import 产物、不看构建输出。三条判据：
 *   ① 每个文件反引号计数恒为 2，且首尾分别落在 return 之后、分号之前
 *   ② 模板体里未转义的 ${ 只能逐字命中登记过的宿主实参（新插值 = 红）
 *   ③ 模板体里"奇数个连续反斜杠 + 正则字母"= 红（求值会吞掉反斜杠，正则静默降级）
 *
 * 边界（别当万能）：它只认字符，不认语义。把反引号换成 String.fromCharCode(96)、
 * 把正则改成字符串拼接、把模板改成 new Function —— 这些都绕过本守卫且照样能坏。
 * 语义级保真由 runtime-source-carrier-fidelity.test.ts（求值后产物）与
 * generated-script-parse-guard.test.ts（产物可解析）负责，不是本文件的活。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/runtime-body-template-literal-guard.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 一律用 charCode 取，避免本文件自己踩转义/模板嵌套
const BS = String.fromCharCode(92);   // 反斜杠
const BT = String.fromCharCode(96);   // 反引号
const DOLLAR = String.fromCharCode(36);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const PARTS_RELATIVE_DIR = 'src/components/ui/custom/smart-card-runtime/runtime-body';
const PARTS = [
  'part-01.ts', 'part-02.ts', 'part-03.ts', 'part-04.ts',
  'part-05.ts', 'part-06.ts', 'part-07.ts', 'part-08.ts',
];

/**
 * 允许出现在模板体里的插值位点：整个 `${...}` 原文必须逐字命中下表。
 * 口径是"白名单登记"，不是"计数不超过 N" —— 新插值一律红，要加必须先在这里登记，
 * 而登记这一步就是人工复核的门。
 *   bootHeader / IDB_NS_RUNTIME_SOURCE / VARIABLES_COMPAT_SOURCE
 *   = runtimeBodyPartNN 的三个宿主实参（见 SillyTavernCompatRuntime.ts 的拼装处）。
 *   JSON.stringify(BUNDLED_ST_PLUGIN_CSS)
 *   = [批次E2b 2026-10-21] 构建期插件 CSS 表（debugger.css 内联用），
 *     内容来自 bundled-plugin-css.generated.ts，不是运行时用户数据。
 */
const ALLOWED_INTERPOLATIONS = [
  DOLLAR + '{bootHeader}',
  DOLLAR + '{IDB_NS_RUNTIME_SOURCE}',
  DOLLAR + '{VARIABLES_COMPAT_SOURCE}',
  DOLLAR + '{JSON.stringify(BUNDLED_ST_PLUGIN_CSS)}',
];

/** 正则字母：紧跟在反斜杠后面时，反斜杠一旦被模板求值吞掉，正则就换了含义。 */
const REGEX_LETTERS = new Set(['d', 'D', 's', 'S', 'w', 'W', 'b', 'B']);

type Violation = { line: number; kind: string; snippet: string };

const readPart = (file: string) => readFileSync(join(process.cwd(), PARTS_RELATIVE_DIR, file), 'utf8');
const partFilesOnDisk = () => readdirSync(join(process.cwd(), PARTS_RELATIVE_DIR))
  .filter((name) => /^part-\d+\.ts$/.test(name))
  .sort();

/** 行号定位：偏移量 → 1 基行号。 */
function lineIndex(text: string) {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === LF) starts.push(i + 1);
  }
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const snippetOf = (line: string) => {
  const trimmed = line.endsWith(CR) ? line.slice(0, -1) : line;
  return trimmed.trim().slice(0, 140);
};

/** 把一个文件的违规清单渲染成 `文件名:行号: [类目] 片段`，可直接贴进终端定位。 */
function format(file: string, hits: Violation[]): string[] {
  return hits.map((hit) => file + ':' + hit.line + ': [' + hit.kind + '] ' + hit.snippet);
}

type Tick = { index: number; line: number };

function scanBackticks(text: string): Tick[] {
  const lineOf = lineIndex(text);
  const ticks: Tick[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== BT) continue;
    ticks.push({ index: i, line: lineOf(i) });
  }
  return ticks;
}

/**
 * 判据①：反引号计数恒为 2，且首尾就是模板定界符。
 *
 * 定位方式不用"第一个/最后一个"（那会把写在模板**之前**的游离反引号当成定界符，
 * 把真正的开口反引号误报成元凶），而是先用锚点认出定界符：
 *   开口 = 紧跟在 return 或 = 之后的反引号（part-01 是 return，part-02..08 是 export const ... =）
 *   收尾 = 紧跟分号的反引号
 * 锚点认不出 → 结构级报错（定界符本身没了）。锚点之外的每一个反引号都逐个点名。
 */
function findBacktickViolations(text: string): Violation[] {
  const lines = text.split(LF);
  const lineOf = lineIndex(text);
  const ticks = scanBackticks(text);
  const hits: Violation[] = [];

  const isOpen = (tick: Tick) => /(?:return|=)[ \t]*$/.test(text.slice(Math.max(0, tick.index - 40), tick.index));
  const isClose = (tick: Tick) => /^;[ \t]*(\r?\n|$)/.test(text.slice(tick.index + 1));

  const opens = ticks.filter(isOpen);
  const closes = ticks.filter(isClose);
  const open = opens.length === 1 ? opens[0] : null;
  const close = closes.length === 1 ? closes[0] : null;

  if (!open || !close || open.index >= close.index) {
    hits.push({
      line: ticks.length ? ticks[0].line : 1,
      kind: '模板定界符不可识别',
      snippet: '反引号 ' + ticks.length + ' 个（开口锚点 ' + opens.length + ' 个、收尾锚点 ' + closes.length
        + ' 个）—— 首尾定界符不完整，模板字符串已不成立',
    });
    return hits;
  }

  ticks
    .filter((tick) => tick !== open && tick !== close)
    .forEach((tick) => {
      const line = lineOf(tick.index);
      hits.push({
        line,
        kind: '多余反引号',
        snippet: snippetOf(lines[line - 1] || ''),
      });
    });
  return hits;
}

/** 取出模板体（首尾反引号之间）及其首行行号。前提：判据①已通过。 */
function templateBodyOf(text: string) {
  const ticks = scanBackticks(text);
  if (ticks.length !== 2) return null;
  const lineOf = lineIndex(text);
  return {
    body: text.slice(ticks[0].index + 1, ticks[1].index),
    firstBodyLine: lineOf(ticks[0].index + 1),
  };
}

/** 判据②：模板体里未转义的 ${ 只允许命中白名单（转义写法 \$ 是"产物里要出现这几个字"，豁免）。 */
function findInterpolationViolations(body: string, firstBodyLine: number): Violation[] {
  const lines = body.split(LF);
  const hits: Violation[] = [];
  for (let i = 0; i < body.length - 1; i += 1) {
    if (body[i] !== DOLLAR || body[i + 1] !== '{') continue;
    let run = 0;
    let k = i - 1;
    while (k >= 0 && body[k] === BS) {
      run += 1;
      k -= 1;
    }
    if (run % 2 === 1) continue;   // \$ 开头 = 转义，产物里就是字面 ${，不是插值

    const rest = body.slice(i);
    const match = rest.match(/^\$\{[^{}]*\}/);
    const lineNo = firstBodyLine + body.slice(0, i).split(LF).length - 1;
    if (!match) {
      hits.push({
        line: lineNo,
        kind: '无法解析的插值',
        snippet: snippetOf(rest.split(LF)[0]),
      });
      continue;
    }
    if (!ALLOWED_INTERPOLATIONS.includes(match[0])) {
      hits.push({
        line: lineNo,
        kind: '未登记的插值',
        snippet: snippetOf(lines[lineNo - firstBodyLine] || ''),
      });
    }
    i += match[0].length - 1;
  }
  return hits;
}

/** 判据③：奇数个连续反斜杠紧跟正则字母 = 求值后反斜杠被吞，正则静默降级。 */
function findOddBackslashViolations(body: string, firstBodyLine: number): Violation[] {
  const lines = body.split(LF);
  const hits: Violation[] = [];
  let line = firstBodyLine;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === LF) {
      line += 1;
      continue;
    }
    if (ch !== BS) continue;
    let run = 0;
    while (body[i + run] === BS) run += 1;
    const next = body[i + run];
    if (run % 2 === 1 && next !== undefined && REGEX_LETTERS.has(next)) {
      hits.push({
        line,
        kind: '反斜杠被吞（' + run + ' 个连写 + ' + next + '）',
        snippet: snippetOf(lines[line - firstBodyLine] || ''),
      });
    }
    i += run - 1;
  }
  return hits;
}

// ============================================================
// A 结构：每个段文件恰好一对模板定界符
// ============================================================
describe('A 结构：每个段文件恰好一对模板定界符', () => {
  it('A1 目录里的段文件与守卫登记的名单逐一相等（新增段必须登记，否则静默漏检）', () => {
    expect(partFilesOnDisk()).toEqual(PARTS);
  });

  it('A2 反引号计数恒为 2，且首尾分别是 return 与分号（多余的一个按 文件:行号:片段 点名）', () => {
    const offenders: string[] = [];
    PARTS.forEach((file) => {
      offenders.push(...format(file, findBacktickViolations(readPart(file))));
    });
    expect(offenders, '段文件里的多余反引号会提前闭合注入 iframe 的模板串').toEqual([]);
  });

  it('A3 判据自证：注释里插一个反引号必须红，且点的是那一行', () => {
    const clean = [
      'export function part(): string {',
      '  return ' + BT + '(() => {',
      '  const re = /^' + BS + BS + 'd+$/;',
      '  ' + BT + ';',
      '}',
    ].join(LF);
    expect(findBacktickViolations(clean)).toEqual([]);

    const broken = [
      'export function part(): string {',
      '  return ' + BT + '(() => {',
      '  // 顺手写了一个 ' + BT + ' 反引号',
      '  const re = /^' + BS + BS + 'd+$/;',
      '  ' + BT + ';',
      '}',
    ].join(LF);
    const hits = findBacktickViolations(broken);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(format('fixture.ts', hits)[0]).toContain('fixture.ts:3:');
  });
});

// ============================================================
// B 插值：模板体里的 ${ 只允许登记过的宿主实参
// ============================================================
describe('B 插值：模板体里的 ${ 只允许登记过的宿主实参', () => {
  it('B1 8 个段文件的未转义插值全部命中白名单（转义的 \\$ 不算插值）', () => {
    const offenders: string[] = [];
    PARTS.forEach((file) => {
      const parsed = templateBodyOf(readPart(file));
      expect(parsed, file + ' 的模板体定位失败（先看 A2）').toBeTruthy();
      if (!parsed) return;
      offenders.push(...format(file, findInterpolationViolations(parsed.body, parsed.firstBodyLine)));
    });
    expect(offenders, '模板体里新出现的 ${ 会改变注入内容，必须登记').toEqual([]);
  });

  it('B2 判据自证：未知插值红、转义写法豁免、白名单命中不红', () => {
    const body = [
      '  const a = ' + DOLLAR + '{bootHeader};',
      '  // 故经 ' + BS + DOLLAR + '{VARIABLES_COMPAT_SOURCE} 插值注入',
      '  const b = ' + DOLLAR + '{NOT_REGISTERED};',
    ].join(LF);
    const hits = findInterpolationViolations(body, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(12);
    expect(format('fixture.ts', hits)[0]).toContain('未登记的插值');
  });
});

// ============================================================
// C 反斜杠：奇数连写 + 正则字母 = 静默降级
// ============================================================
describe('C 反斜杠：奇数连写紧跟正则字母 = 静默降级', () => {
  it('C1 8 个段文件的模板体里零命中（成对反斜杠、\\uXXXX 都合法）', () => {
    const offenders: string[] = [];
    PARTS.forEach((file) => {
      const parsed = templateBodyOf(readPart(file));
      if (!parsed) return;
      offenders.push(...format(file, findOddBackslashViolations(parsed.body, parsed.firstBodyLine)));
    });
    expect(offenders, '单反斜杠 + 正则字母会被模板求值吞掉，正则换含义').toEqual([]);
  });

  it('C2 判据自证：单个 \\d 红、成对 \\\\d 绿、单个 \\u 豁免', () => {
    const broken = '  const re = /^' + BS + 'd+$/;' + LF
      + '  const u = ' + String.fromCharCode(39) + BS + 'u89d2' + String.fromCharCode(39) + ';';
    const hits = findOddBackslashViolations(broken, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].kind).toContain('反斜杠被吞');

    const fixed = '  const re = /^' + BS + BS + 'd+$/;';
    expect(findOddBackslashViolations(fixed, 1)).toEqual([]);
  });
});
