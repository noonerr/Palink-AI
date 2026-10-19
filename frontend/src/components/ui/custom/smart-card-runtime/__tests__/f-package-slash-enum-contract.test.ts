/*
 * 包 F F-1 · 帧内命令枚举口径（2026-10-18）
 *
 * 测的是 `runtime-body/part-07.ts` 里**真实存在的那段源码**（sliceBetween + new Function），
 * 不是照抄一份等价逻辑 —— 否则把种子请求改坏时本文件不会红（§5.4 反证依赖这一点）。
 *
 * 缺口背景：`slashKnownNamesCompat` 原先只由 `/help` 的返回文本解析填充，
 * 上限 = 宿主引擎真注册了的命令 ⇒ 帧内 `Object.keys(SlashCommandParser.commands)` 只有 135，
 * ST 1.18 权威 289 名里 202 名对三方代码"看起来不存在"。
 * 修法：帧内先向宿主取权威名单（`getStCompatCommandNames` 动作，名单在
 * `lib/slash-engine/st-command-catalog.ts`，不进模板串），再照旧接 /help 补漏。
 *
 * [包AA A 2026-10-20 追加] 别名进表（ST SlashCommandParser.js:95/:97-100 —— 别名同样是 commands 的键，
 * 且与主名指向同一个对象）。宿主同一个响应带上 `aliases`（alias→base，176 条），本文件末尾
 * `包AA A 别名进表` 一组钉四件事：枚举视图出现别名键 / 同对象 / 主名计数仍 293（别名单列口径 176）/
 * 别名执行走同一条桥；另记两处实测的形状差异（Map 方法名占位 'delete'、Palink 自有 'help' 与别名重名）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/f-package-slash-enum-contract.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// [包L 2026-10-18] 执行型测试（sliceBetween + new Function）⇒ 用求值后载体：
// 未求值源码文本里单反斜杠转义与生产语义相反，本地绿线上坏。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import {
  ST_118_COMMAND_ALIASES,
  ST_118_COMMAND_NAMES,
  getStCompatCommandAliases,
  getStCompatCommandNames,
} from '@/lib/slash-engine/st-command-catalog';

const PROBE_289: string[] = JSON.parse(
  readFileSync(join(process.cwd(), 'src/lib/slash-engine/__tests__/fixtures/st289-names.json'), 'utf8'),
);

// 别名表（alias → base）来自 ST 1.18.0 全树扫描的对账产物，不是手抄：
//   .tmp_probe/AA/reconcile_out.txt（同 _BACKUPS/2026-10-20_包AA中断现场/probe/）
//   RESULT fixture_names=293 fixture_aliases=176 / union_keys=469 / intersection_names_aliases=0
// 本文件用 import 进来的同一份表反查这些数（下面 alias 组里逐条断言），不引用探针结论当期望值。
const ALIAS_KEYS = Object.keys(ST_118_COMMAND_ALIASES);

/** 取 [from, to) 之间的源码原文（与 b-package 测试同法）。 */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

type Bridge = { calls: Array<{ name: string; args: unknown }> };

/**
 * 把 part-07 的「Map + 注册函数 + known names + Proxy 视图 + prime」原样求值出来。
 * requestParent / executeSlashCommandCompat 由测试注入，其余全是仓库里的真源码。
 */
function buildFrameView(options: {
  seedNames?: string[] | null;
  seedAliases?: Record<string, string> | null;
  helpText?: string;
} = {}) {
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
      // 宿主 respond({ ok: true, result: { names, aliases } }) → 帧内 v2 归一化成 { ok:true, ...{names, aliases} }
      // [包AA A 2026-10-20] 同一个响应带上 aliases（alias → base）；seedAliases: null 模拟"宿主没给别名"
      // 的旧形状（帧内必须退回修复前的表形状：不炸、不凭空造别名键）。
      if (options.seedNames === null) return Promise.resolve({ ok: false, error: 'boom' });
      return Promise.resolve({
        ok: true,
        names: options.seedNames ?? ST_118_COMMAND_NAMES,
        aliases: options.seedAliases === null ? undefined : (options.seedAliases ?? ST_118_COMMAND_ALIASES),
      });
    }
    if (action === 'runPalinkSlash') {
      return Promise.resolve({ ok: true, result: options.helpText ?? '/help  Show this list\n'});
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
    `${storeRegion}\n${viewRegion}\nreturn { view: slashCommandViewCompat, prime: primeSlashKnownNamesCompat, known: slashKnownNamesCompat };`,
  );
  const fakeWindow: any = { SlashCommandParser: {} };
  const built = factory(fakeWindow, requestParent, executeSlashCommandCompat) as {
    view: any;
    prime: () => Promise<void>;
    known: Set<string>;
    window: any;
  };
  return { ...built, bridge, fakeWindow };
}

describe('F-1 帧内枚举：种子名单来自宿主，不是 /help 上限', () => {
  it('prime 后 Object.keys 命中探针口径 289 名（≥280 验收线，实到 289）', async () => {
    const { view, prime, fakeWindow } = buildFrameView();
    await prime();
    const keys = Object.keys(view);
    const covered = PROBE_289.filter((n) => keys.indexOf(n) >= 0);
    expect(covered.length).toBe(289);
    expect(covered.length).toBeGreaterThanOrEqual(280);
    // ownKeys 下限 = 权威名单本身（Palink 自有命令另有 /help 补漏）
    expect(keys.length).toBeGreaterThanOrEqual(ST_118_COMMAND_NAMES.length);
    expect(ST_118_COMMAND_NAMES.length).toBe(293);
    // 观测面：prime 完就把名单挂到 window，探针不必再猜
    expect(fakeWindow.__palinkSlashKnownNames.length).toBeGreaterThanOrEqual(293);
    expect(fakeWindow.__palinkSlashSeedNamesCount).toBe(293);
  });

  it('in / has / for...in / 取值四种写法同时命中（ST 三方代码的惯用探测）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect('bg' in view).toBe(true);
    expect(view.has('bg')).toBe(true);
    expect(Object.keys(view).indexOf('caption') >= 0).toBe(true);
    let seen = 0;
    for (const _name in view) seen += 1;
    expect(seen).toBeGreaterThanOrEqual(293);
    // 有值必须有实现？—— 这里给的是合成 entry（callback 真桥到宿主），不是 undefined / 空壳
    expect(typeof view.bg.callback).toBe('function');
  });

  it('合成 entry 的执行仍落到宿主桥（未实现的命令不会被当成成功）', async () => {
    const { view, prime, bridge } = buildFrameView();
    await prime();
    view.bg.callback('blue');
    const executed = bridge.calls.filter((c) => c.name === 'execute');
    expect(executed.length).toBe(1);
    expect(executed[0].args).toBe('/bg blue');
  });

  it('/help 的解析结果照旧并入（Palink 自有命令不因种子而丢）', async () => {
    const { view, prime } = buildFrameView({ helpText: '/branch-create foo\n/palink-only-bar baz\n' });
    await prime();
    expect('branch-create' in view).toBe(true);
    expect('palink-only-bar' in view).toBe(true);
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(294);
  });

  it('种子请求失败时退回 /help 口径（不炸、不清空既有注册）', async () => {
    const { view, prime } = buildFrameView({ seedNames: null, helpText: '/echo x\n' });
    view.echo = { name: 'echo', callback: () => 'x', aliases: [] };
    await prime();
    // /help 仍被解析 → echo 在 known 里；插件写的 Map 项也在
    expect('echo' in view).toBe(true);
    expect(view.echo.name).toBe('echo');
    // 种子没拿到 ⇒ ST 名单不出现（等同修复前，不是崩溃）
    expect('bg' in view).toBe(false);
  });

  it('权威名单不在种子里的名字不会被凭空造出来（种子只加 ST 的名，不带私货）', async () => {
    const { view, prime } = buildFrameView({ helpText: '' });
    await prime();
    expect('this-is-not-a-command' in view).toBe(false);
    expect(Object.keys(view).every((k: string) => k.length > 0)).toBe(true);
  });
});

describe('F-1 源码接线（宿主与帧内两端都要在）', () => {
  it('帧内：先取种子再接 /help，且没有把 293 个字面量写进模板串', () => {
    const region = sliceBetween(SRC, 'const primeSlashKnownNamesCompat = async () => {', '  primeSlashKnownNamesCompat();');
    expect(region).toContain("requestParent('getStCompatCommandNames', {})");
    expect(region).toContain("requestParent('runPalinkSlash', { command: '/help' })");
    // srcdoc 体积红线：名单不进模板串（只允许出现"取名单"的代码，不允许出现名单本身）
    expect(region).not.toContain("'clipboard-set'");
    expect(region).not.toContain("'checkpoint-create'");
  });

  it('宿主：控制器有 getStCompatCommandNames 落点，且返回对象包一层 names + aliases', () => {
    const controller = readFileSync(
      join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts'),
      'utf8',
    );
    expect(controller).toContain("action.action === 'getStCompatCommandNames'");
    // [包AA A 2026-10-20 改判] 原断言是 `result = { names: getStCompatCommandNames() };`。
    // 改判依据：别名进 commands 表是 ST 一手语义（SlashCommandParser.js:97-100），主脑已裁决补这条，
    // 宿主必须把 alias→base 一起下发，帧内才可能在枚举视图里出现别名键。
    // 包一层 { names } 的形态**没变**（帧内 v2 对顶层数组会做对象展开 ⇒ 裸数组会变索引键），
    // 只是同一对象上多一个 aliases 兄弟键。
    expect(controller).toContain(
      'result = { names: getStCompatCommandNames(), aliases: getStCompatCommandAliases() };',
    );
    expect(controller).toContain("from '@/lib/slash-engine/st-command-catalog'");
    expect(controller).toContain('getStCompatCommandAliases');
  });

  it('宿主：两处口径分家 —— names 仍是 293 个主名，别名单独成 176 的口径', () => {
    // 权威主名数：包F 的口径，帧内 __palinkSlashSeedNamesCount 走的就是它，不许被别名撑大。
    expect(getStCompatCommandNames().length).toBe(293);
    expect(ST_118_COMMAND_NAMES.length).toBe(293);
    // 别名口径：单独一个数（表内键 = 主名 ∪ 别名，是第三个口径，见下面 alias 组）。
    const aliases = getStCompatCommandAliases();
    const aliasKeys = Object.keys(aliases);
    expect(aliasKeys.length).toBe(176);
    // 与 .tmp_probe/AA/reconcile_out.txt 的三条 RESULT 对齐（此处按导入表复算，不信探针文本）：
    //   intersection_names_aliases=0 ⇒ 别名不会盖掉任何权威主名；
    //   alias_base_not_authoritative=0 ⇒ 每个别名都指向名单内的主名；
    //   union_keys=469 ⇒ 表内键数（293 + 176）。
    expect(aliasKeys.filter((k) => ST_118_COMMAND_NAMES.indexOf(k) >= 0)).toEqual([]);
    expect([...new Set(aliasKeys)].length).toBe(176);
    expect(Object.keys(aliases).every((a) => ST_118_COMMAND_NAMES.indexOf(aliases[a]) >= 0)).toBe(true);
    expect(new Set([...ST_118_COMMAND_NAMES, ...aliasKeys]).size).toBe(469);
    expect(aliasKeys.filter((a) => aliases[a] === a)).toEqual([]);
  });
});

// ============================================================
// 包AA A · 别名进表（2026-10-20）
// 一手依据：slash-commands/SlashCommandParser.js:95 主名进表、
//   :97-100 `command.aliases.forEach((alias) => { this.commands[alias] = command; })`
//   ⇒ ST 的 Object.keys(commands) 里本来就有别名，且 commands[alias] 与 commands[base]
//   是**同一个对象**。执行型断言，全部跑求值后载体 SRC 里的真源码。
// ============================================================
describe('包AA A 别名进表：枚举视图里有别名键，且与主名同一个对象', () => {
  it('① 枚举视图（Object.keys / in / has / for...in）都出现别名键', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    const keys = Object.keys(view);
    // 逐个抽样：不同来源文件的别名（slash-commands.js / personas.js / variables.js）都要在
    ['listchatvar', 'addchatvar', 'background', 'dupe', 'persona-data'].forEach((alias) => {
      expect(keys.indexOf(alias) >= 0, `alias key missing: ${alias}`).toBe(true);
      expect(alias in view).toBe(true);
      expect(view.has(alias)).toBe(true);
    });
    let seen = 0;
    for (const _name in view) seen += 1;
    expect(seen).toBeGreaterThanOrEqual(469);
  });

  it('② commands[alias] === commands[base]（同一个对象，不是两份合成项）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    // ⚠️ 例外口径（实测得出，不是为了让断言变绿而挑的）：我们的视图是 **Map 的 Proxy**，
    //   part-07.ts 的 get 陷阱把 Map 方法名（get/has/set/delete/clear/keys/values/entries/forEach，
    //   见 part-07.ts:1136-1143）优先透传给 Map 本体。ST 的 commands 是普通对象、没有这批方法，
    //   所以 `commands['delete']` 在 ST 拿得到、在我们这里会被 Map 方法占位。
    //   176 个别名里正好撞上两个键：'delete'(→del) 与 'name'(→persona-set，'name' 不在占位名单里，仍可用)。
    //   ⇒ 同对象断言对"未被占位的 175 个别名"逐条成立；占位键单独断言（见后一条用例），不静默放行。
    const RESERVED = ['get', 'set', 'clear', 'keys', 'values', 'entries', 'forEach', 'delete'];
    const collided = Object.keys(ST_118_COMMAND_ALIASES).filter((a) => RESERVED.indexOf(a) >= 0);
    expect(collided).toEqual(['delete']);
    // ⚠️ 第二个真实碰撞（实测发现，不是挑出来的例外）：ST 的别名 'help' → '?'，
    //   而 Palink 宿主自己有一条真命令就叫 help，prime 会把它从 /help 文本并进**主名**名单。
    //   resolveSlashEntryCompat 的优先级是「Map 本体 > 主名 > 别名」，所以视图里 help 这个键
    //   被主名占住（能执行 /help），不会折到 '?' 上。下面单独一条用例钉这两种形态。
    const HOST_NAME_COLLISION = ['help'];
    Object.keys(ST_118_COMMAND_ALIASES).forEach((alias) => {
      if (RESERVED.indexOf(alias) >= 0 || HOST_NAME_COLLISION.indexOf(alias) >= 0) return;
      const base = ST_118_COMMAND_ALIASES[alias];
      expect(view[alias], `alias entry missing: ${alias}`).toBeDefined();
      // 逐条同对象：引用相等（===），不是"字段长得一样"。
      expect(view[alias]).toBe(view[base]);
      expect(view[alias].name).toBe(base);
    });
    // 未被主名占位的别名，仍然逐条同对象（176 里除去这 2 个占位 = 174 条全覆盖）。
    expect(Object.keys(ST_118_COMMAND_ALIASES).length - RESERVED.filter((r) => ALIAS_KEYS.indexOf(r) >= 0).length - 1)
      .toBe(174);
    // 反向：同一个别名取两次也必须是同一个对象（合成项有缓存，不会每次 new 一份）。
    expect(view.listchatvar).toBe(view.listchatvar);
    expect(view.listchatvar).toBe(view.listvar);
    // 占位键的实测行为：仍是表里的键（能枚举），但属性取值被 Map 方法占位 —— 这是与 ST 的已知形状差异。
    expect(Object.keys(view).indexOf('delete') >= 0).toBe(true);
    expect('delete' in view).toBe(true);
    expect(typeof view.delete).toBe('function');
    // 实测：Map 方法路径（commands.get(...)）不透传别名 —— part-07.ts:1138-1143 把方法名直通 Map 本体，
    // 而别名只登记在 slashKnownAliasesCompat，不进 Map ⇒ `get('delete')` 拿不到。
    // 这条**断成现状**（不是恒真：把 view.get 改成也解析别名时它会红），并把差异记账到报告里。
    expect(view.get('delete')).toBeUndefined();
    expect(view.has('delete')).toBe(true);
    expect(Object.keys(view).indexOf('delete') >= 0).toBe(true);
    // 主名也一样：Map 方法路径只认真注册项，合成项只经属性路径给出 —— 现状记账，别当"修好了"。
    expect(view.get('del')).toBeUndefined();
    expect(view.del).toBeDefined();
    expect(view.del.name).toBe('del');
  });

  it('③ 主名口径计数不变（293），别名另成一个口径（176）', async () => {
    const { prime, fakeWindow, known } = buildFrameView();
    await prime();
    expect(fakeWindow.__palinkSlashSeedNamesCount).toBe(293);
    expect(fakeWindow.__palinkSlashSeedAliasCount).toBe(176);
    expect(fakeWindow.__palinkSlashKnownAliases.length).toBe(176);
    // 别名不许混进主名名单（两套账）。唯一例外：Palink 自有命令名 help 与 ST 别名 help 重名，
    // 它由 /help 解析进主名口径 ⇒ 允许出现在 __palinkSlashKnownNames 里（另有用例钉其行为）。
    expect(fakeWindow.__palinkSlashKnownNames.filter((n: string) => ALIAS_KEYS.indexOf(n) >= 0))
      .toEqual(['help']);
    // 293 个权威主名全在主名口径里（/help 补漏的 Palink 自有名让总数只多不少）。
    ST_118_COMMAND_NAMES.forEach((n) => expect(known.has(n)).toBe(true));
    expect(fakeWindow.__palinkSlashKnownNames.length).toBeGreaterThanOrEqual(293);
    // 表内键是第三个口径：主名 ∪ 别名（≥469）。
    expect(new Set(Object.keys(fakeWindow.__palinkSlashKnownNames)
      .concat(fakeWindow.__palinkSlashKnownAliases)).size).toBeGreaterThanOrEqual(469);
  });

  it('④ 别名执行走同一条桥（不许"能枚举但执行报未知"的分裂）', async () => {
    const { view, prime, bridge } = buildFrameView();
    await prime();
    const executed = () => bridge.calls.filter((c) => c.name === 'execute').map((c) => c.args);
    view.listchatvar.callback('scope=global');
    // 命中的是宿主斜杠桥（executeSlashCommandCompat），且命令文本用**主名**拼出
    expect(executed()).toEqual(['/listvar scope=global']);
    // 同一个 entry 再经主名调用 ⇒ 同一条桥、同一种拼法（别名没有第二套实现）
    view.listvar.callback('scope=global');
    expect(executed()).toEqual(['/listvar scope=global', '/listvar scope=global']);
    expect(typeof view.listchatvar.callback).toBe('function');
    expect(view.listchatvar.callback).toBe(view.listvar.callback);
  });

  it('重名裁决（实测）：help 被宿主主名占住；/help 没带它时别名才折到 ?', async () => {
    // 形态 A：/help 把 Palink 自有命令名 help 并进主名名单 ⇒ view.help 是「/help」那条命令的合成项。
    const a = buildFrameView({ helpText: '/help  Show this list\n' });
    await a.prime();
    expect(a.view.help.name).toBe('help');
    expect(a.view.help).not.toBe(a.view['?']);
    a.view.help.callback('');
    expect(a.bridge.calls.filter((c) => c.name === 'execute').map((c) => c.args)).toEqual(['/help']);
    // 形态 B：/help 没贡献 help 这个名 ⇒ 同一个键回归 ST 语义（别名 'help' → 主名 '?'，同一个对象）。
    const b = buildFrameView({ helpText: '' });
    await b.prime();
    expect(b.view.help).toBe(b.view['?']);
    expect(b.view.help.name).toBe('?');
    expect(ST_118_COMMAND_ALIASES.help).toBe('?');
  });

  it('反证：宿主没下发 aliases 时退回修复前的表形状（不炸、不凭空造别名键）', async () => {
    const { view, prime, fakeWindow } = buildFrameView({ seedAliases: null });
    await prime();
    expect(fakeWindow.__palinkSlashSeedNamesCount).toBe(293);
    expect(fakeWindow.__palinkSlashSeedAliasCount).toBe(0);
    expect('listvar' in view).toBe(true);
    expect('listchatvar' in view).toBe(false);
    expect(Object.keys(view).length).toBeLessThan(469);
  });

  it('反证：别名指向的主名不在权威名单里时不发明键（不造 ST 没有的形状）', async () => {
    const { view, prime, fakeWindow } = buildFrameView({
      seedNames: ['listvar'],
      seedAliases: { listchatvar: 'listvar', ghostalias: 'not-a-real-command' },
    });
    await prime();
    expect('listchatvar' in view).toBe(true);
    expect('ghostalias' in view).toBe(false);
    expect(fakeWindow.__palinkSlashSeedAliasCount).toBe(1);
  });
});
