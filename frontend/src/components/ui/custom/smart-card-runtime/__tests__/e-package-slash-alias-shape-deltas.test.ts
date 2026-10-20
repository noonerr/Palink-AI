/*
 * 批次 E · 别名面三条形状差异按 ST 补齐（2026-10-20）
 *
 * 派包：docs/_active/prompt/PROMPT_对话包_批次D与E与H与I_2026-10-20.md §批次E。
 * 只改 runtime-body/part-07.ts（模板串）+ 其测试。三条都先一手核 ST 再动，锚点如下：
 *
 *   ① 别名键 'delete' 被 Map 方法占位 —— ST 一手（参照树 _reference/sillytavern-1.18.0）：
 *      slash-commands/SlashCommandParser.js 全文（1357 行）的写入 API 只有
 *      addCommand(:53) / addCommandObject(:65) / addCommandObjectUnsafe(:78) 三个；
 *      对 public/scripts 全树 grep deleteCommand / removeCommand 零命中
 *      ⇒ ST 没有任何"删命令"的公开路径 ⇒ 保持现状 + part-07.ts 注释写清理由，
 *        本文件钉住"没有新增删除能力"（不许自造"能删"的行为）。
 *   ② 自有 help 与 ST 别名 help(→?) 撞名 —— ST 一手：slash-commands.js:658-661 注册
 *      name '?'、aliases ['help']；SlashCommandParser.js:79-82 重名只 console.trace 告警，
 *      :95/:99 照常赋值 ⇒ 后注册者覆盖。我们有意偏离（比 ST 保守）：Palink 自有
 *      help（主名）优先占位、不折到 '?'；本文件钉住这个优先级。
 *   ③ commands.get(别名) 不解析别名 —— ST 一手：commands 是普通对象（:44
 *      'static commands = {}'），对象上没有 .get() 方法（:105-107 的 'get commands()'
 *      是 parser 实例取值器）⇒ 我们的 .get 是多出来的便利面；本批把它接到与 []
 *      同一条 resolveSlashEntryCompat 路径（内部一致性），本文件钉住同路径。
 *
 * 执行型断言一律用**求值后载体** COMPAT_V2_RUNTIME_ARTIFACT（与生产 iframe 逐字节相同）。
 * 计数口径：默认夹具下 Object.keys(commands) = 469（293 权威主名 ∪ 176 别名，
 * 交集为 0；外加 /help 解析出的 Palink 自有 help 同时落在主名与别名两侧、只计一次）。
 * 真机口径 509 是另一套配置（宿主 /help 实况 + 插件注册项），ownKeys 未动即不变。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/e-package-slash-alias-shape-deltas.test.ts
 */
import { describe, it, expect } from 'vitest';
// 求值后载体：与浏览器里 iframe 实际跑的那段文本逐字节相同（载体选错=假绿，见该文件头注）。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import {
  ST_118_COMMAND_ALIASES,
  ST_118_COMMAND_NAMES,
} from '@/lib/slash-engine/st-command-catalog';

/** 取 [from, to) 之间的源码原文（与 f/z-package 测试同法）。 */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

type Bridge = { calls: Array<{ name: string; args: unknown }> };

/**
 * 把 part-07 的「parser 命名空间 + Map 存储 + 注册函数 + known names/aliases +
 * 合成项 + Proxy 视图 + prime」原样求值出来。requestParent / executeSlashCommandCompat
 * 由测试注入，其余全是仓库里的真源码（与 f-package 同一套切法）。
 */
function buildFrameView(options: {
  seedNames?: string[] | null;
  seedAliases?: Record<string, string> | null;
  helpText?: string;
} = {}) {
  const parserNsRegion = sliceBetween(
    SRC,
    'window.SlashCommandParser = window.SlashCommandParser && typeof window.SlashCommandParser',
    'window.SlashCommandParser.addCommandObject',
  );
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
  const bridge: Bridge = { calls: [] };
  const requestParent = (action: string, payload: any = {}) => {
    bridge.calls.push({ name: action, args: payload });
    if (action === 'getStCompatCommandNames') {
      if (options.seedNames === null) return Promise.resolve({ ok: false, error: 'boom' });
      return Promise.resolve({
        ok: true,
        names: options.seedNames ?? ST_118_COMMAND_NAMES,
        aliases: options.seedAliases === null ? undefined : (options.seedAliases ?? ST_118_COMMAND_ALIASES),
      });
    }
    if (action === 'runPalinkSlash') {
      return Promise.resolve({ ok: true, result: options.helpText ?? '/help  Show this list\n' });
    }
    return Promise.resolve({ ok: false, error: 'unexpected action' });
  };
  const executeSlashCommandCompat = (text: string) => {
    bridge.calls.push({ name: 'execute', args: text });
    return Promise.resolve('');
  };
  const factory = new Function(
    'window',
    'requestParent',
    'executeSlashCommandCompat',
    `${parserNsRegion}\n${storeRegion}\n${viewRegion}\nreturn { view: slashCommandViewCompat, parser: window.SlashCommandParser, prime: primeSlashKnownNamesCompat };`,
  );
  const fakeWindow: any = {};
  const built = factory(fakeWindow, requestParent, executeSlashCommandCompat) as {
    view: any;
    parser: any;
    prime: () => Promise<void>;
  };
  return { ...built, bridge, fakeWindow };
}

// ============================================================
// ① delete：ST 无"删命令"公开路径 ⇒ 保持现状，不造能删行为
// ============================================================
describe('批次E ① delete 占位：ST 无删命令公开路径，保持现状且没有新增删除能力', () => {
  it('Map 方法占位保持现状：delete 是函数、别名键仍在表里、且不是 /del 的 entry', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect(Object.keys(view).indexOf('delete') >= 0).toBe(true);
    expect('delete' in view).toBe(true);
    expect(typeof view.delete).toBe('function');
    // 占位的含义：属性取值给的是 Map 删除方法，不是别名应解析到的 /del 合成项
    expect(view.delete).not.toBe(view.del);
    expect(view.del.name).toBe('del');
    expect(ST_118_COMMAND_ALIASES.delete).toBe('del');
  });

  it('没有新增"删命令"能力：视图与 parser 上都没有 deleteCommand / removeCommand', async () => {
    const { view, parser, prime } = buildFrameView();
    await prime();
    expect(view.deleteCommand).toBeUndefined();
    expect(view.removeCommand).toBeUndefined();
    expect(parser.deleteCommand).toBeUndefined();
    expect(parser.removeCommand).toBeUndefined();
    expect(Object.keys(view).indexOf('deleteCommand') >= 0).toBe(false);
    expect(Object.keys(view).indexOf('removeCommand') >= 0).toBe(false);
  });

  it('源码留痕：get 陷阱处记录了 ST 一手锚点与"保持现状、不造能力"的理由', () => {
    const region = sliceBetween(
      SRC,
      'const slashCommandViewCompat = new Proxy(slashCommandStoreCompat, {',
      'set(target, prop, value) {',
    );
    expect(region).toContain('addCommandObjectUnsafe');
    expect(region).toContain('deleteCommand');
    expect(region).toContain('零命中');
  });
});

// ============================================================
// ② help 撞名：自有 help 优先于 ST 别名（有意偏离，优先级被钉住）
// ============================================================
describe('批次E ② help 撞名：Palink 自有 help（主名）优先，优先级不许改成别名优先', () => {
  it('形态 A：/help 贡献主名 help ⇒ 视图里 help 是自有命令，执行落到 /help', async () => {
    const { view, prime, bridge } = buildFrameView(); // 默认 helpText 带 /help
    await prime();
    expect(ST_118_COMMAND_ALIASES.help).toBe('?');
    expect(view.help.name).toBe('help');
    expect(view.help).not.toBe(view['?']);
    view.help.callback('');
    expect(bridge.calls.filter((c) => c.name === 'execute').map((c) => c.args)).toEqual(['/help']);
  });

  it('形态 B：/help 没贡献它 ⇒ 同一键回归 ST 别名语义（help → ?，同一个对象）', async () => {
    const { view, prime } = buildFrameView({ helpText: '' });
    await prime();
    expect(view.help).toBe(view['?']);
    expect(view.help.name).toBe('?');
  });

  it('优先级在 .get 路径上同样成立（与 [] 一致，都落在自有 help 上）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect(view.get('help')).toBe(view.help);
    expect(view.get('help').name).toBe('help');
    expect(view.get('help')).not.toBe(view.get('?'));
  });

  it('源码留痕：resolveSlashEntryCompat 处记录了这是"有意偏离"及 ST 的 :79-82 锚点', () => {
    const region = sliceBetween(
      SRC,
      'const resolveSlashEntryCompat = (name) => {',
      'const primeSlashKnownNamesCompat = async () => {',
    );
    expect(region).toContain('有意偏离');
    expect(region).toContain('SlashCommandParser.js:79-82');
  });
});

// ============================================================
// ③ .get 与 [] 同路径（ST 无此方法，属我们额外提供的便利面）
// ============================================================
describe('批次E ③ commands.get 与 [] 走同一解析路径（ST 无 .get，属额外便利面）', () => {
  it('别名经 .get 解析到主名同一个对象（与 [] 引用相等，不是字段相似）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect(view.get('delete')).toBe(view.del);
    expect(view.get('delete')).toBe(view['del']);
    expect(view.get('listchatvar')).toBe(view.listvar);
    expect(view.get('listchatvar').name).toBe('listvar');
    // 同一个别名取两次也是同一个对象（合成项缓存，不每次 new）
    expect(view.get('listchatvar')).toBe(view.get('listchatvar'));
  });

  it('主名 / 未知名 / 非字符串入参的形状与 [] 一致', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect(view.get('del')).toBe(view.del);
    expect(view.get('no-such-command-xyz')).toBeUndefined();
    expect(view.get(undefined)).toBeUndefined();
    expect(view.nope_unknown_key).toBeUndefined();
  });

  it('Object.keys(commands) 计数不变（默认夹具 469 = 293 主名 ∪ 176 别名）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    // 改前改后都必须是 469：本批只动 get 陷阱的取值路径，ownKeys 一行未碰
    expect(Object.keys(view).length).toBe(469);
    // 交叉验证：两份权威表的并集本身就是 469（主名与别名交集为 0）
    expect(new Set([...ST_118_COMMAND_NAMES, ...Object.keys(ST_118_COMMAND_ALIASES)]).size).toBe(469);
    // 别名键一个没少：'delete' 占位键也仍在表里
    expect(Object.keys(view).indexOf('delete') >= 0).toBe(true);
    expect(Object.keys(view).indexOf('listchatvar') >= 0).toBe(true);
  });

  it('源码留痕：get 分支记录了"ST 无 .get、这是额外便利面"及同路径处置', () => {
    // 切整个 get 陷阱（注释在 if 行上方，不能只从 if 行开始切）
    const trap = sliceBetween(
      SRC,
      'const slashCommandViewCompat = new Proxy(slashCommandStoreCompat, {',
      'ownKeys(target) {',
    );
    expect(trap).toContain("if (prop === 'get') return (name) => resolveSlashEntryCompat(String(name));");
    expect(trap).toContain('多出来的便利面');
    expect(trap).toContain('static commands = {}');
  });
});
