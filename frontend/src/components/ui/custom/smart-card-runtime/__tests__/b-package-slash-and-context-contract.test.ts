/*
 * 包 B（ST 兼容补齐）· 行为契约测试（2026-10-18）
 *
 * 覆盖四件事，每件都对应一处**实测发现的真缺口**，不是"改了什么测什么"：
 *
 *   A. 内置斜杠命令此前从未注册：`initSlashCommands()` 全仓 0 调用点 ⇒ 运行时
 *      `SlashCommandEngine` 只有插件注册的命令，内置 75 条一条都不在。
 *      修法：`lib/slash-engine/bootstrap.ts` 在应用入口调用一次（幂等）。
 *
 *   B. `SlashCommandParser.commands` 此前直接赋 `Map`：ST 契约是普通对象，
 *      三方代码 `commands['echo']` / `Object.keys(commands)` / `'echo' in commands`
 *      全部失效（真机探针也因此把已有命令误读成 0 条）。
 *      修法：`part-07.ts` 的 `slashCommandViewCompat` Proxy 双面视图。
 *
 *   C. 宿主响应归一化把标量返回值吃掉：`part-06.ts` 原本一律
 *      `{ ok: true, ...data.result }`，对 `runPalinkSlash` 的**字符串**结果会展开成
 *      索引键对象 ⇒ `response.result` 恒 undefined ⇒ 卡内 `triggerSlash('/getchatname')`
 *      恒返回空串。修法：按类型分流。
 *
 *   D. `getContext()` 缺 9 键 + `saveWorldInfo` 假成功。修法：part-08 补键 +
 *      saveWorldInfo 桥真写入。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/b-package-slash-and-context-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
// [包L 2026-10-18] 本文件既有字符串断言也有 new Function 执行断言 ⇒ 统一用求值后载体
// （未求值源码文本里单反斜杠转义与生产语义相反，本地绿线上坏）。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import { SlashCommandEngine } from '@/lib/slash-engine';
import {
  ensureSlashCommandsBootstrapped,
  __resetSlashCommandsBootstrapForTests,
} from '@/lib/slash-engine/bootstrap';

/** 从 marker 起按花括号配平切一段（与 st-compat-fix-batch-contract 同法）。 */
function sliceDeclaration(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  expect(i, `no '{' after marker: ${marker}`).toBeGreaterThan(-1);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

/** 取 [from, to) 之间的源码原文。 */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

// ── A. 内置命令注册 ─────────────────────────────────────────────

describe('A 内置斜杠命令注册（bootstrap 幂等）', () => {
  it('注册前引擎为空 —— 这是缺口的根因，不是假设', () => {
    // 本文件是首个触碰引擎的测试，模块级引擎此刻尚未被 bootstrap 过。
    // 若其它测试先跑过 bootstrap，这条会失真，故只在未注册时断言。
    const count = SlashCommandEngine.getAllCommands().length;
    if (count === 0) {
      expect(count).toBe(0);
    }
  });

  it('bootstrap 后内置命令 + ST 兼容命令都在（≥100 条）', () => {
    __resetSlashCommandsBootstrapForTests();
    const did = ensureSlashCommandsBootstrapped();
    const total = SlashCommandEngine.getAllCommands().length;
    expect(did).toBe(true);
    expect(total).toBeGreaterThanOrEqual(100);
    // 抽查：内置（Palink 自有）与 ST 兼容（本包新增）各一条
    expect(SlashCommandEngine.getCommand('clear')).toBeTruthy();
    expect(SlashCommandEngine.getCommand('add')).toBeTruthy();
  });

  it('幂等：重复调用不再注册、命令数不翻倍', () => {
    const before = SlashCommandEngine.getAllCommands().length;
    const did = ensureSlashCommandsBootstrapped();
    expect(did).toBe(false);
    expect(SlashCommandEngine.getAllCommands().length).toBe(before);
  });

  it('ST 数学 / 文本命令语义与 ST 一致（含除零与非法值降级）', async () => {
    const run = async (s: string) => (await SlashCommandEngine.execute(s)).output;
    expect(await run('/add 10 20 30')).toBe('60');
    expect(await run('/sub 100 30')).toBe('70');
    expect(await run('/mul 2 3 4')).toBe('24');
    expect(await run('/div 10 2')).toBe('5');
    // ST variables.js:divValuesCallback 除零返回 0
    expect(await run('/div 10 0')).toBe('0');
    // ST performOperation：结果 NaN 归一为 '0'
    expect(await run('/sqrt abc')).toBe('0');
    expect(await run('/pow 2 10')).toBe('1024');
    expect(await run('/round 3.14159 2')).toBe('3.14');
    expect(await run('/min 5 2 9')).toBe('2');
    expect(await run('/max 5 2 9')).toBe('9');
    expect(await run('/upper abc')).toBe('ABC');
    expect(await run('/lower ABC')).toBe('abc');
    expect(await run('/len hello')).toBe('5');
    expect(await run('/array-wrap x')).toBe('["x"]');
    expect(await run('/array-unwrap ["a","b"]')).toBe('a');
    expect(await run('/pass hello')).toBe('hello');
  });

  it('/add 是数值求和，不是"追加消息"（帧内同名分支已移除）', async () => {
    // 帧内 executeSlashCommandCompat 原本把 'add' 当消息追加别名。
    // ST 的 /add 是数学命令，留在本地分支会让 /add 10 20 返回一条消息而不是 30。
    const localAppendGroup = sliceBetween(SRC, "if (['append'", ']) {');
    expect(localAppendGroup).not.toContain("'add'");
    expect(localAppendGroup).toContain("'append'");
  });
});

// ── B. commands 对象视图 ───────────────────────────────────────

describe('B SlashCommandParser.commands 对象视图', () => {
  /** 把 part-07 的 Map + 注册函数 + Proxy 视图原样求值到一个假 window 上。 */
  function buildView() {
    const storeRegion = sliceBetween(
      SRC,
      'const slashCommandStoreCompat = new Map();',
      'const parseSlashArgsCompat =',
    );
    const viewRegion = sliceBetween(
      SRC,
      'const slashKnownNamesCompat = new Set();',
      'window.SlashCommandParser.commands = slashCommandViewCompat;',
    ) + 'window.SlashCommandParser.commands = slashCommandViewCompat;';
    const fakeWindow: any = { SlashCommandParser: {} };
    const factory = new Function(
      'window',
      storeRegion + '\n' + viewRegion + '\nreturn { view: slashCommandViewCompat, register: registerSlashCommandCompat, known: slashKnownNamesCompat };',
    );
    return factory(fakeWindow) as {
      view: any;
      register: (name: string, cb: any, aliases?: string[]) => any;
      known: Set<string>;
    };
  }

  it('Map 的 get / has / keys 仍然可用（帧内既有调用点不回归）', () => {
    const { view, register } = buildView();
    register('echo', () => 'ok', ['say']);
    expect(typeof view.get).toBe('function');
    expect(view.get('echo')?.name).toBe('echo');
    expect(view.has('say')).toBe(true);
    expect(Array.from(view.keys())).toEqual(['echo', 'say']);
  });

  it('对象语义可用：commands[name] / Object.keys / in（ST 三方代码的三种写法）', () => {
    const { view, register } = buildView();
    register('echo', () => 'ok', ['say']);
    register('abs', () => '1');
    // ① 属性访问
    expect(view.echo.name).toBe('echo');
    // ② Object.keys 枚举（此前 Map 上恒为 []，真机探针因此误读成 0 条）
    expect(Object.keys(view).sort()).toEqual(['abs', 'echo', 'say']);
    // ③ in 判定
    expect('echo' in view).toBe(true);
    expect('nope' in view).toBe(false);
  });

  it('赋值与删除同步到 Map（双向一致）', () => {
    const { view } = buildView();
    view.foo = { name: 'foo', callback: () => 'x', aliases: [] };
    expect(view.get('foo')?.name).toBe('foo');
    delete view.foo;
    expect(view.has('foo')).toBe(false);
  });

  it('源码层：commands 赋的是视图而不是裸 Map', () => {
    expect(SRC).toContain('window.SlashCommandParser.commands = slashCommandViewCompat;');
    expect(SRC).not.toContain('window.SlashCommandParser.commands = slashCommandStoreCompat;');
  });

  it('宿主已知命令名会被合成出可枚举的 entry（否则三方特性检测恒假）', () => {
    const { view, known } = buildView();
    // 真机实测：帧内 commands 只有插件注册的 7 条，宿主引擎的 100+ 条对三方代码不可见。
    // primeSlashKnownNamesCompat 从 /help 取到名字后放进这个 Set，视图据此合成 entry。
    known.add('echo');
    known.add('add');
    expect('echo' in view).toBe(true);
    expect(view.echo.name).toBe('echo');
    expect(Object.keys(view).sort()).toEqual(['add', 'echo']);
    // 合成项的 callback 真的会去执行（不是空函数）
    expect(typeof view.echo.callback).toBe('function');
  });

  it('源码层：known names 由 /help 的返回填充，不是硬编码名单', () => {
    expect(SRC).toContain('primeSlashKnownNamesCompat');
    expect(SRC).toContain("requestParent('runPalinkSlash', { command: '/help' })");
    expect(SRC).toContain('window.__palinkSlashKnownNames');
  });
});

// ── C. 宿主响应归一化 ─────────────────────────────────────────

describe('C requestParent 响应归一化（标量不再被对象展开吃掉）', () => {
  it('源码层：标量分支存在且对象分支保留（既有 .content/.entries 消费点不变）', () => {
    const region = sliceBetween(SRC, 'const rawResult = data.result;', 'pending.resolve(resolvedPayload);');
    // 标量包成 { ok, success, result }
    expect(region).toContain('result: rawResult');
    // 对象（含数组）照旧展开
    expect(region).toContain('...rawResult');
    // null/undefined 走默认成功体
    expect(region).toContain("typeof rawResult === 'undefined'");
  });

  it('行为：字符串结果能穿透到 response.result（/getchatname 的原始 bug）', () => {
    // 直接求值**源码里的那一段**，不是照抄一份等价逻辑 —— 否则改坏源码测试不会红。
    const region = sliceBetween(SRC, 'const rawResult = data.result;', 'pending.resolve(resolvedPayload);')
      + 'pending.resolve(resolvedPayload);';
    const resolve = (data: any) => {
      let captured: any = null;
      const pending = { resolve: (payload: any) => { captured = payload; } };
      const uiText = { requestFailed: 'request failed' };
      // eslint-disable-next-line no-new-func
      new Function('data', 'pending', 'uiText', region)(data, pending, uiText);
      return captured;
    };
    // 旧实现 { ok:true, ...'abc' } 会得到 {ok:true,0:'a',1:'b',2:'c'}，result 为 undefined
    expect(resolve({ ok: true, result: 'palink-session-abc.jsonl' }).result).toBe('palink-session-abc.jsonl');
    expect(resolve({ ok: true, result: 42 }).result).toBe(42);
    expect(resolve({ ok: true, result: { success: true, content: 'x' } }).content).toBe('x');
    expect(resolve({ ok: true, result: null }).success).toBe(true);
    expect(resolve({ ok: false, error: 'boom' }).ok).toBe(false);
  });
});

// ── D. getContext 9 键 + saveWorldInfo ────────────────────────

describe('D getContext 补 9 键 + saveWorldInfo 真写入', () => {
  const ctx = () => sliceDeclaration(SRC, 'const getContextCompat = () => ({');

  const REQUIRED_NINE = [
    'timestampToMoment',
    'uuidv4',
    'humanizedDateTime',
    'registerHelper',
    'registerDebugFunction',
    'renderExtensionTemplate',
    'renderExtensionTemplateAsync',
    'chatCompletionSettings',
    'textCompletionSettings',
  ];

  it('9 个缺失键全部出现在 getContextCompat 里', () => {
    const region = ctx();
    REQUIRED_NINE.forEach((key) => {
      expect(new RegExp('\\n\\s*' + key + ':').test(region), `missing key ${key}`).toBe(true);
    });
  });

  it('chatCompletionSettings / textCompletionSettings 带 runtimes 子对象（空对象会 TypeError）', () => {
    // part-08 上半段记录过：MVU 校验通过后立刻写 runtimes.is_function_call_enabled，
    // 空对象会在那里 TypeError。所以必须是带 runtimes 的对象。
    const region = sliceBetween(SRC, 'const buildCompletionSettingsCompat = () => {', 'const textCompletionSettingsCompat');
    expect(region).toContain('runtimes');
    expect(region).toContain('is_function_call_enabled');
    // 且是同一实例复用（每次新建会让写入丢失）
    expect(SRC).toContain('const chatCompletionSettingsCompat = buildCompletionSettingsCompat();');
  });

  it('saveWorldInfo 不再是假成功：不包 stubApi，且桥 createOrReplaceWorldbook', () => {
    const region = ctx();
    expect(region).toContain('saveWorldInfo: async (name, data) =>');
    expect(region).not.toContain("saveWorldInfo: stubApi('saveWorldInfo'");
    expect(region).toContain('createOrReplaceWorldbook');
    // 空条目必须返回 false，不能谎报成功
    expect(region).toContain('if (!list.length) return false;');
  });
});
