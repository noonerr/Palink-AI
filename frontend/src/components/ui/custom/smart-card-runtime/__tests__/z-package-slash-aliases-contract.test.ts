/*
 * 包 Z Z-2 · 帧内 `SlashCommandParser` 的别名面（2026-10-19）
 *
 * 任务书（HANDOFF §1 Z-2）的原始假设是"ST 有 `aliases` 数组 / `getAliases()`，我们对齐它们"。
 * 一手核完两棵参照树（`/d/SillyTavern-release` 与 `_reference/sillytavern-1.18.0`，**同为 1.18.0**）
 * 之后，假设不成立，实际事实如下 —— 每条都带行号，可复核：
 *
 *   ① `SlashCommandParser` **没有** `aliases` 静态字段，**没有** `getAliases()`：
 *      `grep -rn "getAliases" _reference/sillytavern-1.18.0/public/` ⇒ 0 命中；
 *      `SlashCommandParser.js` 全文无 `aliases` 声明（只有用到 `command.aliases` 的地方）。
 *      ⇒ 我们**不该**造这两个东西（任务书："形状照 ST，不多给"）。
 *
 *   ② 别名是**命令实例**上的字段：
 *      `slash-commands/SlashCommand.js:56` → `aliases = []`（JSDoc 标注 string[]，纯字符串数组）
 *
 *   ③ 别名**会**被写进 `commands` 表（这是包F "别名不在 Object.keys(commands) 里，ST 亦然"
 *      那条记录的反例）：
 *      `slash-commands/SlashCommandParser.js:97-100`
 *        if (Array.isArray(command.aliases)) {
 *            command.aliases.forEach((alias) => { this.commands[alias] = command; });
 *        }
 *      ⇒ 三方代码 `commands['listchatvar']` 在 ST 里拿得到命令对象。
 *
 * 我们帧内的对应实现（`runtime-body/part-07.ts`）：
 *      :797 registerSlashCommandCompat / :816 主名进表 / :817-818 别名同样进表
 *      :1008 synthesizeSlashEntryCompat / :1010 `aliases: []`（合成项也有 string[]，不是 undefined）
 * ⇒ 三条与 ST 一致，**本项不需要改产品代码**；本文件只把这三条钉住，防以后有人按旧假设
 *    "补"出一个 ST 没有的 `getAliases()`。
 *
 * ⚠️ 执行型测试必须用**求值后载体** `COMPAT_V2_RUNTIME_ARTIFACT`（未求值源码文本里的转义
 *    与生产相反，拿它执行等于测另一份东西）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/z-package-slash-aliases-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
// 求值后载体：与浏览器里 iframe 实际跑的那段文本逐字节相同。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import { ST_118_COMMAND_NAMES } from '@/lib/slash-engine/st-command-catalog';

/** 取 [from, to) 之间的源码原文（与 f-package-slash-enum-contract 同法）。 */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * 把 part-07 的三段原样求值出来：
 *   - 存储 + `registerSlashCommandCompat`（:795-819）
 *   - known names + 合成项 + Proxy 视图（:1002-1113）
 *   - `window.SlashCommandParser` 命名空间本体（:997-999）
 * requestParent / executeSlashCommandCompat 由测试注入，其余全是仓库里的真源码。
 */
function buildFrame() {
  const storeRegion = sliceBetween(
    SRC,
    'const slashCommandStoreCompat = new Map();',
    'const parseSlashArgsCompat =',
  );
  const viewRegion = sliceBetween(
    SRC,
    'const slashKnownNamesCompat = new Set();',
    'window.SlashCommandParser.commands = slashCommandViewCompat;',
  );
  const parserNsRegion = sliceBetween(
    SRC,
    'window.SlashCommandParser = window.SlashCommandParser && typeof window.SlashCommandParser',
    'window.SlashCommandParser.addCommandObject',
  );

  const requestParent = (action: string) => {
    if (action === 'getStCompatCommandNames') {
      return Promise.resolve({ ok: true, names: ST_118_COMMAND_NAMES });
    }
    return Promise.resolve({ ok: true, result: '' });
  };
  const executeSlashCommandCompat = () => Promise.resolve('');

  const factory = new Function(
    'window',
    'requestParent',
    'executeSlashCommandCompat',
    `${parserNsRegion}
${storeRegion}
${viewRegion}
return {
  parser: window.SlashCommandParser,
  view: slashCommandViewCompat,
  register: registerSlashCommandCompat,
  synthesize: synthesizeSlashEntryCompat,
  prime: primeSlashKnownNamesCompat,
};`,
  );
  const fakeWindow: any = {};
  return factory(fakeWindow, requestParent, executeSlashCommandCompat) as {
    parser: any;
    view: any;
    register: (name: string, cb?: (...a: any[]) => any, aliases?: string[], help?: string) => any;
    synthesize: (name: string) => any;
    prime: () => Promise<void>;
  };
}

describe('Z-2 别名面：不造 ST 没有的在场物', () => {
  it('SlashCommandParser 上没有 aliases 静态字段（ST 1.18.0 同样没有）', () => {
    const { parser } = buildFrame();
    // ST 依据：grep "getAliases|static aliases" slash-commands/SlashCommandParser.js ⇒ 无声明
    expect('aliases' in parser).toBe(false);
    expect(parser.aliases).toBeUndefined();
  });

  it('SlashCommandParser 上没有 getAliases()（ST 1.18.0 全树 0 命中）', () => {
    const { parser } = buildFrame();
    expect('getAliases' in parser).toBe(false);
    expect(typeof parser.getAliases).not.toBe('function');
  });
});

describe('Z-2 别名面：注册行为照 ST（SlashCommandParser.js:97-100）', () => {
  it('注册带 alias 的命令后，alias 作为键进 commands 表，且指向同一个命令对象', () => {
    const { view, register } = buildFrame();
    const entry = register('z-cmd', () => 'ok', ['z-alias']);
    expect(entry.aliases).toEqual(['z-alias']);
    // ST :99 `this.commands[alias] = command;`
    expect(view['z-alias']).toBe(entry);
    expect(Object.keys(view)).toContain('z-alias');
    expect('z-alias' in view).toBe(true);
  });

  it('命令对象的 aliases 是纯字符串数组（ST SlashCommand.js:56 `aliases = []`）', () => {
    const { register } = buildFrame();
    const entry = register('z-cmd-2', () => 'ok', ['a1', 'a2']);
    expect(Array.isArray(entry.aliases)).toBe(true);
    expect(entry.aliases.every((x: unknown) => typeof x === 'string')).toBe(true);
    expect(entry.aliases).toEqual(['a1', 'a2']);
  });

  it('没传 aliases 时是空数组而不是 undefined（ST 的默认值语义）', () => {
    const { register } = buildFrame();
    const entry = register('z-cmd-3', () => 'ok');
    expect(entry.aliases).toEqual([]);
  });

  it('宿主名单里的合成项也带 aliases: []，形状与真命令一致', async () => {
    const { view, synthesize, prime } = buildFrame();
    await prime();
    const synth = synthesize('bg');
    expect(synth.aliases).toEqual([]);
    expect(Array.isArray(synth.aliases)).toBe(true);
    // 合成项同样经 Proxy 取得到（存在性口径，不代表真能执行）
    expect(view.bg.name).toBe('bg');
  });
});
