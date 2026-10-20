/*
 * 包G 契约测试 —— getContext 13 个真问题项 + SillyTavern.libs 25 键（2026-10-18）
 *
 * 来源：docs/_active/HANDOFF_提示词_包G_getContext与libs补齐_2026-10-18.md §2.1 / §3.2 / §5.2
 *      docs/_active/report/REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md §2.2 / P1-1
 *
 * 覆盖三组：
 *   A. 逐项真值：13 个修复项在帧内 getContext() 上拿到的是真值或**诚实失败**，
 *      并且用真机探针同一份 isStub 判据复跑 ⇒ 这 13 项不再落在 ctxNotReal 里。
 *   B. libs 25 键：Object.keys(SillyTavern.libs) ⊇ fixtures/st-libs-25.json 的 25 个权威名；
 *      getter 是懒的（未加载完取到 undefined，不造假库）；一模块多键只拉一次；
 *      CDN URL 版本锁定；Palink 自有超集保留。
 *   C. 红线：renameChat 恒 false（不许假成功）；getRequestHeaders 与 getPresetManager
 *      这两项「用户决策 / 架构红线」**保持原样**，被本测试钉住，谁动谁红。
 *
 * 求值方式说明：被测源码是注入 iframe 的模板字符串片段（runtime-body/part-08.ts），
 * 依赖 6000 行运行时的 IIFE 闭包变量；整段求值需要整套 DOM（同 st-compat-fix-batch-contract
 * 文件头的结论）。这里按 marker 切出**仓库里的真实源码文本**，扫描其中的自由标识符
 *（既非本区声明、也非全局可解析），逐个绑成夹具依赖，缺的落深桩 —— 断言的依旧是原文，
 * 不是重写副本。
 * ⚠️ new Function 的入参**只来自本仓库源文件**（compat-v2-runtime-source.ts 的 readFileSync），
 * 不含任何运行时外部输入；与同目录既有契约测试同一做法。
 *
 * ⚠️ 已知口径差异（写进包G 报告，别当 bug 修）：
 *   · getWorldInfoPrompt 返回 string，与**本仓宿主轨** getContext.ts:2330 同口径；
 *     ST 源码 world-info.js:892 实际返回 {worldInfoString,…} 对象。
 *   · getMediaIndex 无媒体返回 -1（包G 处置表口径）；ST script.js:2140 同样情形返回 0。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/g-getcontext-and-libs-contract.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_V2_RUNTIME_SOURCE as SRC } from './compat-v2-runtime-source';
// ⚠️ **求值**用运行时常量（模板字符串求值后的产物，即真正注入 iframe 的那份文本），
// 文本契约断言用 SRC（readFileSync 的原始文件文本）。两者必须分别取：
// 源码里写 `parts.join('\\n')`，注入产物里是 `parts.join('\n')` —— 拿原文去求值
// 会把 \\n 当字面量反斜杠，断言就会出现"看起来只差一个转义"的假阴性。
import { RUNTIME_BODY_PART_08 } from '../runtime-body/part-08';

const FIXTURE_PATH = join(
  process.cwd(),
  'src/components/ui/custom/smart-card-runtime/__tests__/fixtures/st-libs-25.json',
);
const ST_LIBS_25: { libs: string[]; count: number } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/** 注入 iframe 的**运行时产物文本**（模板字符串求值后），行为断言用它。 */
const PART = RUNTIME_BODY_PART_08;

// ── 切源码工具（与 st-compat-fix-batch-contract.test.ts:34 同法）──────────

/** 从 `const <name> = ` 起按花括号配平切出一段声明。 */
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

/** 从 startMarker 切到 endMarker（含 endMarker 之后第一个分号）。 */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found after start: ${endMarker}`).toBeGreaterThan(start);
  const semi = src.indexOf(';', end);
  expect(semi, `no ';' after end marker: ${endMarker}`).toBeGreaterThan(end);
  return src.slice(start, semi + 1);
}

/**
 * 与真机探针 .tmp_probe/probe-parity3.js 里**同一份** isStub 判据（逐字搬运）。
 * 用途：把"真机探针说这项不是假货"这条验收线固化成可复跑的单测。
 */
function isStubLikeProbe(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const t = typeof v;
  if (t === 'function') {
    const s = String(v);
    if (s.indexOf('reportStubApi') >= 0) return true;
    if (s.indexOf('stubApi(') >= 0) return true;
    const body = s.replace(/\s/g, '');
    if (body.length < 60 && /return(null|undefined|\{\}|\[\])?;?\}?$/.test(body)) return true;
    return false;
  }
  if (t === 'object') {
    if (Object.keys(v as object).length === 0 && (v as object).constructor === Object) return true;
    return false;
  }
  return false;
}

// ── 帧内求值夹具 ────────────────────────────────────────────────

interface FrameDeps {
  ctx: Record<string, unknown>;
  posted: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  parentCalls: Array<{ action: string; payload: Record<string, unknown> }>;
  compatChat: Array<Record<string, unknown>>;
  parentByAction: Record<string, unknown>;
  scope: Record<string, unknown>;
  libImports: string[];
}

/**
 * 编译帧内真实的桩留痕区（PALINK_STUB_API_NOTES / reportStubApi / stubApi）。
 * 目的：getContextCompat 里**残留**的 stubApi 包裹必须用原文的 stubApi 才能被发现，
 * 用测试自造桩等于把"是否还包着"这件事交给测试自己判 —— 那是假绿。
 */
function makeStubKit(reportDiagnostic: (entry: Record<string, unknown>) => void) {
  const region = sliceBetween(
    PART,
    'const PALINK_STUB_API_NOTES = {',
    'window.__palinkStubApiNotes = PALINK_STUB_API_NOTES',
  );
  // eslint-disable-next-line no-new-func
  const factory = new Function('reportDiagnostic', `${region}\nreturn { stubApi, reportStubApi, notes: PALINK_STUB_API_NOTES };`);
  return factory(reportDiagnostic) as {
    stubApi: (name: string, impl: any) => any;
    reportStubApi: (name: string, note?: string) => void;
    notes: Record<string, string>;
  };
}

function buildFrame(options: {
  ctx?: Record<string, unknown>;
  parentByAction?: Record<string, unknown>;
  parentThrows?: boolean;
  chat?: Array<Record<string, unknown>>;
} = {}): FrameDeps {
  const posted: FrameDeps['posted'] = [];
  const diagnostics: FrameDeps['diagnostics'] = [];
  const parentCalls: FrameDeps['parentCalls'] = [];
  const libImports: string[] = [];
  const compatChat = options.chat ?? [
    { id: 'm1', role: 'user', mes: 'hi', content: 'hi', extra: {} },
    { id: 'm2', role: 'assistant', mes: 'hello', content: 'hello', extra: {} },
  ];
  const ctx: Record<string, unknown> = {
    characterId: 'c28061bb-a9b7-46a9-a255-2692d57001fc',
    characterName: '露缇雅1.2',
    userName: 'User',
    language: 'zh',
    sessionId: 's1',
    messageId: 'm2',
    powerUserSettings: undefined,
    selectedModel: 'gpt-test-model',
    worldbookName: '露缇雅1.2',
    ...options.ctx,
  };
  const requestParent = vi.fn(async (action: string, payload: Record<string, unknown> = {}) => {
    parentCalls.push({ action, payload });
    if (options.parentThrows) throw new Error('parent rpc exploded');
    const byAction = options.parentByAction ?? {};
    if (Object.prototype.hasOwnProperty.call(byAction, action)) return byAction[action];
    return { success: true, name: '露缇雅1.2', entries: [] };
  });
  const setChatMessageCompat = vi.fn(async (content: unknown, messageId: unknown, payloadOptions: Record<string, unknown> = {}) => {
    const index = compatChat.findIndex((message) => String(message.id) === String(messageId));
    const target = index >= 0 ? compatChat[index] : null;
    if (target && payloadOptions.extra && typeof payloadOptions.extra === 'object') {
      target.extra = { ...(target.extra as object), ...(payloadOptions.extra as object) };
    }
    return { success: true, content, messageId };
  });

  const stubKit = makeStubKit((entry) => { diagnostics.push(entry); });

  const scope: Record<string, unknown> = {
    ctx,
    post: (message: Record<string, unknown>) => { posted.push(message); },
    requestParent,
    reportDiagnostic: (entry: Record<string, unknown>) => { diagnostics.push(entry); },
    // 帧内**原文**的桩机制（残留的 stubApi 包裹靠它才测得出来）
    stubApi: stubKit.stubApi,
    reportStubApi: stubKit.reportStubApi,
    PALINK_STUB_API_NOTES: stubKit.notes,
    clone: <T,>(value: T): T => JSON.parse(JSON.stringify(value)),
    compatChat,
    resolveMessageIndex: (messageId: unknown) => {
      const byId = compatChat.findIndex((message) => String(message.id) === String(messageId)
        || String(message.message_id) === String(messageId));
      if (byId >= 0) return byId;
      const asIndex = Number(messageId);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < compatChat.length) return asIndex;
      return compatChat.length - 1;
    },
    setChatMessageCompat,
    activeWorldbookName: '',
    activeLorebooks: { primary: '露缇雅1.2', additional: [] },
    // getContextCompat 对象字面量在**求值时**就会读的这些闭包依赖，给最小可用桩。
    accountStorageCompat: { setItem: () => true, getItem: () => null },
    lodashCompat: { isPlainObject: () => false, get: () => undefined },
    domPurifyCompat: { sanitize: (value: string) => value },
    handlebarsCompat: { compile: () => () => '' },
    momentCompat: (() => () => '') as unknown,
    localforageCompat: { getItem: async () => null, setItem: async () => true },
    tavernHelperCompat: { swipe: {} },
    variablesCompat: { getAll: () => ({}) },
    presetRegexScripts: [],
    parseMaybeJsonObject: (_value: unknown, fallback: unknown) => fallback,
    getByPath: () => undefined,
    getExtensionPromptStoreCompat: () => ({}),
    triggerSlashCompat: async () => '',
  };

  return { ctx, posted, diagnostics, parentCalls, compatChat, parentByAction: options.parentByAction ?? {}, scope, libImports };
}

/** 未知依赖的深桩：任意属性访问 / 调用都返回又一个深桩，绝不抛。 */
function deepStub(name = 'stub'): any {
  const target: any = function stubFn() { return deepStub(name + '()'); };
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === 'toString') return () => name;
      if (prop === 'then' || prop === Symbol.iterator) return undefined;
      return deepStub(name + '.' + String(prop));
    },
    set: () => true,
    apply: () => deepStub(name + '()'),
    has: () => true,
  });
}

const RESERVED_WORDS = new Set([
  'this', 'new', 'typeof', 'instanceof', 'in', 'of', 'return', 'function', 'const', 'let', 'var',
  'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'switch', 'case', 'default', 'await',
  'async', 'yield', 'try', 'catch', 'finally', 'throw', 'null', 'true', 'false', 'undefined',
  'arguments', 'void', 'delete', 'class', 'extends', 'super', 'import', 'export',
]);

/**
 * 从一段源码文本里收集"自由标识符"（既不是本区声明的、也不是全局可解析的）。
 * 这些就是运行时 IIFE 闭包变量的引用点 —— 求值前逐个绑成 var（缺依赖落深桩）。
 */
function collectFreeIdentifiers(code: string): string[] {
  const declared = new Set<string>();
  const found = new Set<string>();
  const src = String(code)
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  src.replace(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g, (_m, name: string) => {
    declared.add(name);
    return '';
  });
  const body = src
    .replace(/\?\.\s*[A-Za-z_$][\w$]*/g, ' ')
    .replace(/\.[\s]*[A-Za-z_$][\w$]*/g, ' ')
    .replace(/([A-Za-z_$][\w$]*)\s*:(?!:)/g, ' ');
  body.replace(/[A-Za-z_$][\w$]*/g, (name) => { found.add(name); return ''; });
  return Array.from(found).filter(
    (name) => !declared.has(name) && !RESERVED_WORDS.has(name) && !(name in globalThis),
  );
}

/** 把一段帧内源码 + 依赖表编译成可调用工厂（依赖缺失自动落深桩，不静默改断言）。 */
function compileRegion(code: string, deps: Record<string, unknown>, tail: string): () => any {
  const names = collectFreeIdentifiers(code + tail);
  const bindings = names.map((name) => `var ${name} = Object.prototype.hasOwnProperty.call(__deps, ${JSON.stringify(name)}) ? __deps[${JSON.stringify(name)}] : __deepStub(${JSON.stringify(name)});`).join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function('__deps', '__deepStub', `${bindings}\n${code}\n${tail}`);
  return () => factory(deps, deepStub);
}

/** 求值 getContextCompat()，返回帧内真实对象（源码即注入产物的原文）。 */
function evalGetContext(deps: FrameDeps): Record<string, any> {
  const start = PART.indexOf('const buildPowerUserSettingsCompat = () => {');
  const end = PART.indexOf('const getContextCompat = () => ({');
  expect(start, '包G G-1 助手区起点未命中').toBeGreaterThan(-1);
  expect(end, '包G G-1 助手区终点未命中').toBeGreaterThan(start);
  const helpers = PART.slice(start, end);
  // sliceDeclaration 按花括号配平切，切出来是 `const getContextCompat = () => ({ … }`
  //（少收尾的 `);`）⇒ 必须补上，否则 new Function 直接 SyntaxError。
  const getContext = `${sliceDeclaration(PART, 'const getContextCompat = () => ({')});`;
  return compileRegion(`${helpers}\n${getContext}`, deps.scope, 'return getContextCompat();')();
}

/** 求值 libs 区（含 __ensure / __packageMap 两个不可枚举辅助键），返回 SillyTavern.libs。 */
function evalLibs(deps: FrameDeps): Record<string, any> {
  const libs = sliceBetween(
    PART,
    'const PALINK_ST_LIB_BASE =',
    'window.libs = window.libs || stLibsCompat',
  );
  // 区首的 `window.SillyTavern = window.SillyTavern || {}` 在 part-08 里位于 marker 之前，
  // 切片切不到 ⇒ 这里补一次初始化（帧内真实执行顺序一致：它在 libs 区之前）。
  return compileRegion(`window.SillyTavern = window.SillyTavern || {};\n${libs}`, deps.scope, 'return window.SillyTavern.libs;')();
}

beforeEach(() => {
  // 清掉别的测试可能留在全局上的同名注入物，保证 25 键断言只看本区源码。
  delete (window as any).SillyTavern;
  delete (window as any).__palinkStLibImport;
  ['Fuse', 'hljs', 'showdown', 'YAML', 'Popper', 'droll', 'morphdom', 'SVGInject', 'seedrandom', 'chalk']
    .forEach((name) => { delete (window as any)[name]; });
  // getContextCompat 的**对象字面量求值**会直接解引用这几个 frame 全局（由 part-01..07
  // 在真帧里预置）；jsdom 侧给同名最小桩，避免把"缺预置全局"误判成"实现有 bug"。
  const win = window as any;
  win.ToolManager = {
    registerFunctionTool: () => true,
    unregisterFunctionTool: () => true,
    isToolCallingSupported: () => false,
    canPerformToolCalls: () => false,
  };
  win.ScraperManager = { registerDataBankScraper: () => true };
  win.extension_settings = {};
});

// ============================================================
// A. 13 个修复项：帧内拿到的是真值 / 诚实失败
// ============================================================
describe('A 包G G-1 —— getContext 13 个真问题项', () => {
  const FIXED_KEYS = [
    'powerUserSettings', 'getChatCompletionModel', 'getTextGenServer', 'convertCharacterBook',
    'getWorldInfoPrompt', 'updateWorldInfoList', 'reloadWorldInfoEditor', 'appendMediaToMessage',
    'getMediaDisplay', 'getMediaIndex', 'scrollOnMediaLoad', 'renameChat', 'createCharacterData',
  ];

  it('探针同口径：这 13 项在 getContext() 上都不再是"假货"（isStub 判据逐字搬自 probe-parity3.js）', () => {
    const deps = buildFrame();
    const ctx = evalGetContext(deps);
    const stillFake = FIXED_KEYS.filter((key) => isStubLikeProbe(ctx[key]));
    expect(stillFake, `以下项仍被探针判为假货: ${stillFake.join(', ')}`).toEqual([]);
  });

  it('包M 帧内角色标识：characterId 是数字（拿不到下标就 0，不填假值），字符串身份走 characterIdString/palink_character_id', () => {
    const ctxObj = evalGetContext(buildFrame());
    expect(typeof ctxObj.characterId).toBe('number');
    expect(Number.isFinite(ctxObj.characterId)).toBe(true);
    expect(ctxObj.characterId).toBe(0);
    expect(ctxObj.characterIdString).toBe('c28061bb-a9b7-46a9-a255-2692d57001fc');
    expect(ctxObj.palink_character_id).toBe('c28061bb-a9b7-46a9-a255-2692d57001fc');
    expect(ctxObj.characterUuid).toBe('c28061bb-a9b7-46a9-a255-2692d57001fc');

    // boot ctx 缺角色标识时：数字仍是 0、字符串仍是空串，**不许**造出伪 id
    const bare = evalGetContext(buildFrame({ ctx: { characterId: '' } }));
    expect(bare.characterId).toBe(0);
    expect(bare.characterIdString).toBe('');
    expect(bare.palink_character_id).toBe('');
  });

  it('#1 powerUserSettings 非空且带宿主默认值（language 取 ctx.language）', () => {
    const deps = buildFrame();
    const ctx = evalGetContext(deps);
    expect(Object.keys(ctx.powerUserSettings).length).toBeGreaterThan(0);
    expect(ctx.powerUserSettings.font_size).toBe(14);
    expect(ctx.powerUserSettings.language).toBe('zh');
    expect(ctx.powerUserSettings.scroll_on_media_load).toBe(true);
    expect(ctx.powerUserSettings.media_display).toBe('inline');
    // power_user 与 powerUserSettings 是同一实例（ST 侧就是同一个对象引用）
    expect(ctx.power_user).toBe(ctx.powerUserSettings);
    // ⚠️ 全局也必须是**同一份真值**：part-06 的 ensureObject('power_user', {}) 只给空对象，
    // 而直读全局的插件（part-02:354 访问器 / part-06:652 的 /api/settings/get）看的是它。
    expect((window as any).power_user).toBe(ctx.powerUserSettings);
    expect(Object.keys((window as any).power_user).length).toBeGreaterThan(0);
  });

  it('#1 宿主经 ctx.powerUserSettings 注入时覆盖默认值', () => {
    const deps = buildFrame({ ctx: { powerUserSettings: { font_size: 22, language: 'en-US' } } });
    const ctx = evalGetContext(deps);
    expect(ctx.powerUserSettings.font_size).toBe(22);
    expect(ctx.powerUserSettings.language).toBe('en-US');
  });

  it('#2 getChatCompletionModel 取宿主注入的当前模型名（未注入返回空串）', () => {
    const deps = buildFrame();
    expect(evalGetContext(deps).getChatCompletionModel()).toBe('gpt-test-model');
    const bare = buildFrame({ ctx: { selectedModel: undefined } });
    expect(evalGetContext(bare).getChatCompletionModel()).toBe('');
  });

  it('#3 getTextGenServer：无 textgen 后端时诚实返回空串；宿主注入则透传', async () => {
    const deps = buildFrame();
    expect(await evalGetContext(deps).getTextGenServer()).toBe('');
    const withServer = buildFrame({ ctx: { textGenServer: 'http://127.0.0.1:5000/api' } });
    expect(await evalGetContext(withServer).getTextGenServer()).toBe('http://127.0.0.1:5000/api');
  });

  it('#4 convertCharacterBook 恒等透传（Palink 后端存的即 ST 形状）', () => {
    const ctx = evalGetContext(buildFrame());
    const book = { entries: { '1': { uid: 1, content: 'x' } }, name: '露缇雅1.2' };
    expect(ctx.convertCharacterBook(book)).toBe(book);
    expect(ctx.convertCharacterBook(null)).toEqual({});
  });

  it('#5 getWorldInfoPrompt 用真条目按插入顺序组装；空世界书返回空串', async () => {
    const deps = buildFrame({
      parentByAction: {
        getCharWorldbook: {
          name: '露缇雅1.2',
          entries: [
            { uid: 1, content: '第二段', insertion_order: 20 },
            { uid: 2, content: '第一段', insertion_order: 10 },
            { uid: 3, content: '被禁用', insertion_order: 1, disabled: true },
            { uid: 4, content: '   ', insertion_order: 2 },
          ],
        },
      },
    });
    const ctx = evalGetContext(deps);
    expect(await ctx.getWorldInfoPrompt()).toBe('第一段\n第二段');
  });

  it('#5 桥失败降级为空串并留 warn（不把异常抛给卡脚本）', async () => {
    const deps = buildFrame({ parentThrows: true });
    const ctx = evalGetContext(deps);
    expect(await ctx.getWorldInfoPrompt()).toBe('');
    expect(deps.posted.some((m) => m.level === 'warn' && String(m.message).includes('getWorldInfoPrompt'))).toBe(true);
  });

  it('#6 updateWorldInfoList 刷新帧内 world_names（getWorldInfoNames 读到同一份）', async () => {
    const deps = buildFrame({ parentByAction: { getCharWorldbook: { name: '露缇雅1.2', entries: [] } } });
    const ctx = evalGetContext(deps);
    expect(await ctx.updateWorldInfoList()).toEqual(['露缇雅1.2']);
    expect((window as any).world_names).toEqual(['露缇雅1.2']);
    expect(ctx.getWorldInfoNames()).toEqual(['露缇雅1.2']);
  });

  it('#6 桥失败保留现有列表并 warn，不清空', async () => {
    (window as any).world_names = ['旧列表'];
    const deps = buildFrame({ parentThrows: true });
    const ctx = evalGetContext(deps);
    expect(await ctx.updateWorldInfoList()).toEqual(['旧列表']);
    expect(deps.posted.some((m) => m.level === 'warn' && String(m.message).includes('updateWorldInfoList'))).toBe(true);
  });

  it('#7 reloadWorldInfoEditor 恒真（帧内无编辑器 UI，无副作用可失败）', async () => {
    const ctx = evalGetContext(buildFrame());
    expect(await ctx.reloadWorldInfoEditor()).toBe(true);
  });

  it('#8 appendMediaToMessage 推进 extra.media 并经既有 setChatMessage 通道落库', async () => {
    const deps = buildFrame();
    const ctx = evalGetContext(deps);
    const ok = await ctx.appendMediaToMessage('m2', { url: 'https://cdn.test/a.png', caption: '配图' });
    expect(ok).toBe(true);
    const media = (deps.compatChat[1].extra as any).media;
    expect(Array.isArray(media)).toBe(true);
    expect(media).toHaveLength(1);
    expect(media[0].url).toBe('https://cdn.test/a.png');
    expect(media[0].caption).toBe('配图');
    // 后端媒体 id 形态：m_ + 12 位十六进制（lib/messageMedia.ts:74 同规格）
    expect(media[0].id).toMatch(/^m_[0-9a-f]{12}$/);
    expect(media[0].status).toBe('ready');
    expect(deps.scope.setChatMessageCompat).toHaveBeenCalled();
    const call = (deps.scope.setChatMessageCompat as any).mock.calls[0];
    // content 必须是 undefined（否则 part-05 判定为显式内容 → 抹正文）
    expect(call[0]).toBeUndefined();
    expect(call[1]).toBe('m2');
    expect((call[2] as any).extra.media).toHaveLength(1);
  });

  it('#8 字符串入参同样可用；映射不出媒体 / 无消息时诚实返回 false（不拿消息 id 当 URL）', async () => {
    const ctx = evalGetContext(buildFrame());
    expect(await ctx.appendMediaToMessage('m2', 'https://cdn.test/b.png')).toBe(true);
    // 只给媒体对象（无消息参数）⇒ 落到当前消息（resolveMessageIndex 的既有兜底语义）
    const solo = evalGetContext(buildFrame());
    expect(await solo.appendMediaToMessage({ url: 'https://cdn.test/c.png' })).toBe(true);
    // ST 侧第二参是 jQuery 消息元素：无法映射成媒体 ⇒ false。
    // ⚠️ 这里同时钉住一条反例：实现若"第二参不行就回头把第一参当 URL"，本断言必红（假成功）。
    const element = evalGetContext(buildFrame());
    expect(await element.appendMediaToMessage('m2', { 0: { nodeName: 'DIV' }, length: 1 })).toBe(false);
    // 空会话（一条消息都没有）⇒ 找不到目标消息，false
    const empty = buildFrame({ chat: [] });
    expect(await evalGetContext(empty).appendMediaToMessage('不存在的消息id', { url: 'x' })).toBe(false);
  });

  it('#9 getMediaDisplay：extra.media_display 优先，缺省 inline；ST 的 list 也透传', () => {
    const deps = buildFrame({
      chat: [
        { id: 'm1', extra: { media_display: 'gallery' } },
        { id: 'm2', extra: {} },
        { id: 'm3', extra: { media_display: 'list' } },
      ],
    });
    const ctx = evalGetContext(deps);
    expect(ctx.getMediaDisplay('m1')).toBe('gallery');
    expect(ctx.getMediaDisplay('m2')).toBe('inline');
    expect(ctx.getMediaDisplay('m3')).toBe('list');
    // 直接给消息对象（ST 签名）也要能用
    expect(ctx.getMediaDisplay(deps.compatChat[0])).toBe('gallery');
  });

  it('#10 getMediaIndex：无媒体 -1；越界/非法回 0；合法取真值', () => {
    const deps = buildFrame({
      chat: [
        { id: 'm1', extra: { media: [{ id: 'm_aaaaaaaaaaaa', status: 'ready' }] , media_index: 0 } },
        { id: 'm2', extra: { media: [{}, {}, {}], media_index: 2 } },
        { id: 'm3', extra: { media: [{}], media_index: 9 } },
        { id: 'm4', extra: {} },
      ],
    });
    const ctx = evalGetContext(deps);
    expect(ctx.getMediaIndex('m1')).toBe(0);
    expect(ctx.getMediaIndex('m2')).toBe(2);
    expect(ctx.getMediaIndex('m3')).toBe(0);
    expect(ctx.getMediaIndex('m4')).toBe(-1);
  });

  it('#11 scrollOnMediaLoad 是函数：偏好为真时走 scrollChatToBottom，偏好 false 时不滚', () => {
    const spy = vi.fn();
    (window as any).scrollChatToBottom = spy;
    const deps = buildFrame();
    const ctx = evalGetContext(deps);
    expect(typeof ctx.scrollOnMediaLoad).toBe('function');
    expect(ctx.scrollOnMediaLoad()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const off = buildFrame({ ctx: { powerUserSettings: { scroll_on_media_load: false } } });
    spy.mockClear();
    expect(evalGetContext(off).scrollOnMediaLoad()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    delete (window as any).scrollChatToBottom;
  });

  it('#12 renameChat 走 requestParent 桥：父侧 success 才 true，失败/空名一律诚实 false', async () => {
    // [包N B-3 2026-10-19] 契约变更：此前"恒 false + 一次性 warn"是**未接通道**的诚实降级，
    // 现在已接 requestParent('renameChat') → 宿主 POST /api/chats/rename-session。
    // 仍然是"不许假成功"：只有父侧 success === true 才回 true。
    const okDeps = buildFrame();
    const okCtx = evalGetContext(okDeps);
    expect(await okCtx.renameChat('新名字')).toBe(true);
    // 请求契约：会话标识走宿主侧 file_name 约定，帧内只传 title
    expect(okDeps.parentCalls).toEqual([{ action: 'renameChat', payload: { title: '新名字' } }]);

    // 空名不发请求（不发无意义 RPC，也不报成功）
    expect(await okCtx.renameChat()).toBe(false);
    expect(await okCtx.renameChat('   ')).toBe(false);
    expect(okDeps.parentCalls).toHaveLength(1);

    // 父侧失败（无会话 / 后端 4xx）⇒ false
    const failDeps = buildFrame({
      parentByAction: { renameChat: { success: false, error: 'no_active_session' } },
    });
    expect(await evalGetContext(failDeps).renameChat('新名字')).toBe(false);

    // 父侧通道炸了 ⇒ false（不把异常抛给卡脚本）
    const throwDeps = buildFrame({ parentThrows: true });
    expect(await evalGetContext(throwDeps).renameChat('新名字')).toBe(false);
  });

  it('#13 createCharacterData 是 ST create_save 形状（可写字段不炸）', () => {
    const ctx = evalGetContext(buildFrame());
    const template = ctx.createCharacterData;
    // ST script.js:569-592 的键（注意 ST 用 first_message / mes_example）
    ['name', 'description', 'creator_notes', 'post_history_instructions', 'character_version',
      'system_prompt', 'tags', 'creator', 'personality', 'first_message', 'avatar', 'scenario',
      'mes_example', 'world', 'talkativeness', 'alternate_greetings', 'depth_prompt_prompt',
      'depth_prompt_depth', 'depth_prompt_role', 'extensions', 'extra_books'].forEach((key) => {
      expect(template, `createCharacterData 缺键 ${key}`).toHaveProperty(key);
    });
    expect(template.alternate_greetings).toEqual([]);
    expect(template.extra_books).toEqual([]);
    expect(template.extensions).toEqual({});
    expect(() => { template.name = '新角色'; }).not.toThrow();
    expect(template.name).toBe('新角色');
  });

  it('修完的 13 项不再走 stubApi（调用它们不产 st_api_stub 诊断；用的是帧内原文 stubApi 机制）', () => {
    const deps = buildFrame();
    const ctx = evalGetContext(deps);
    void ctx.getChatCompletionModel();
    void ctx.convertCharacterBook({});
    void ctx.getMediaDisplay('m1');
    void ctx.getMediaIndex('m1');
    void ctx.scrollOnMediaLoad();
    void ctx.createCharacterData;
    void ctx.powerUserSettings;
    expect(deps.diagnostics.filter((d) => d.code === 'st_api_stub')).toEqual([]);
  });
});

// ============================================================
// B. libs 25 键
// ============================================================
describe('B 包G G-2 —— SillyTavern.libs 对齐 ST 1.18.0 的 25 个权威键', () => {
  it('fixture 自身是 25 项且逐项与 lib.js:84-110 一致（防止 fixture 被手改漂掉）', () => {
    expect(ST_LIBS_25.count).toBe(25);
    expect(ST_LIBS_25.libs).toHaveLength(25);
    // 三个易错点：css 是 @adobe/css-tools 而非 emotion；fflate 出两键；readability 出两键
    expect(ST_LIBS_25.libs).toContain('css');
    expect(ST_LIBS_25.libs).toContain('gzipSync');
    expect(ST_LIBS_25.libs).toContain('gzip');
    expect(ST_LIBS_25.libs).toContain('Readability');
    expect(ST_LIBS_25.libs).toContain('isProbablyReaderable');
    expect(new Set(ST_LIBS_25.libs).size).toBe(25);
  });

  it('Object.keys(SillyTavern.libs) 覆盖 25 个权威键（懒 getter 也必须可枚举）', () => {
    const libs = evalLibs(buildFrame());
    const keys = Object.keys(libs);
    const missing = ST_LIBS_25.libs.filter((name) => keys.indexOf(name) < 0);
    expect(missing, `libs 缺权威键: ${missing.join(', ')}`).toEqual([]);
  });

  it('Palink 自有超集保留（toastr/$/jQuery/dayjs/accountStorage 不丢）', () => {
    const deps = buildFrame();
    (window as any).toastr = { info: () => {} };
    (window as any).$ = () => {};
    const libs = evalLibs(deps);
    ['toastr', '$', 'jQuery', 'dayjs', 'accountStorage'].forEach((key) => {
      expect(libs, `libs 缺 Palink 自有键 ${key}`).toHaveProperty(key);
    });
  });

  it('未加载完成时 getter 取到 undefined（诚实，不交假对象）；加载完成后变真库', async () => {
    const deps = buildFrame();
    // ⚠️ 每个 URL 一个 resolver：懒 getter 会**同时**挂起多个请求（本例 yaml + Fuse），
    // 用单个 settle 变量会被后一个 Promise 覆盖 ⇒ yaml 永远不 resolve（前一轮的超时病根）。
    const resolvers = new Map<string, (value: unknown) => void>();
    deps.scope.libImport = (url: string) => {
      deps.libImports.push(url);
      return new Promise((resolve) => { resolvers.set(url, resolve); });
    };
    (window as any).__palinkStLibImport = (url: string) => (deps.scope.libImport as (u: string) => Promise<unknown>)(url);
    const libs = evalLibs(deps);
    expect(libs.yaml).toBeUndefined();
    expect(libs.Fuse).toBeUndefined();
    expect(deps.libImports.some((url) => url.includes('yaml@'))).toBe(true);
    const yamlResolver = resolvers.get((libs as any).__packageMap.yaml as string);
    expect(yamlResolver, 'yaml 的 CDN 请求未发起').toBeTypeOf('function');
    yamlResolver?.({ default: { fake: true }, parse: (text: string) => text, stringify: () => 'y' });
    await Promise.resolve();
    await libs.__ensure('yaml');
    expect(libs.yaml).toBeDefined();
    expect((libs.yaml as any).parse('abc')).toBe('abc');
    // Fuse 仍未 resolve ⇒ 依旧是 undefined（诚实：不交假对象，也不互相顶包）
    expect(libs.Fuse).toBeUndefined();
  });

  it('一模块多键只拉一次：@mozilla/readability 出两键、fflate 出两键', async () => {
    const deps = buildFrame();
    const fakeModule: Record<string, unknown> = {
      Readability: class Readability {},
      isProbablyReaderable: () => true,
    };
    const fflateModule: Record<string, unknown> = {
      gzipSync: () => new Uint8Array([1]),
      gzip: (_d: unknown, cb: (e: null, o: Uint8Array) => void) => cb(null, new Uint8Array([2])),
    };
    (window as any).__palinkStLibImport = (url: string) => {
      deps.libImports.push(url);
      if (url.includes('readability')) return Promise.resolve(fakeModule);
      if (url.includes('fflate')) return Promise.resolve(fflateModule);
      return Promise.resolve({ default: { name: url } });
    };
    const libs = evalLibs(deps);
    await libs.__ensure('Readability');
    await libs.__ensure('isProbablyReaderable');
    await libs.__ensure('gzipSync');
    await libs.__ensure('gzip');
    expect(libs.Readability).toBe(fakeModule.Readability);
    expect(libs.isProbablyReaderable).toBe(fakeModule.isProbablyReaderable);
    expect(libs.gzipSync).toBe(fflateModule.gzipSync);
    expect(libs.gzip).toBe(fflateModule.gzip);
    expect(deps.libImports.filter((url) => url.includes('readability'))).toHaveLength(1);
    expect(deps.libImports.filter((url) => url.includes('fflate'))).toHaveLength(1);
  });

  it('CDN URL 全部锁版本（jsdelivr +esm，禁止 floating latest）', () => {
    const deps = buildFrame();
    const libs = evalLibs(deps);
    const map = (libs as any).__packageMap as Record<string, string>;
    const lazyKeys = ST_LIBS_25.libs.filter((name) => ['lodash', 'DOMPurify', 'localforage', 'Handlebars', 'moment'].indexOf(name) < 0);
    expect(lazyKeys.length).toBe(20);
    lazyKeys.forEach((key) => {
      expect(map, `libs.${key} 缺 CDN 映射`).toHaveProperty(key);
      // 允许 npm scope（@adobe/css-tools 等），但**必须**锁三段版本号且走 +esm；
      // 缺版本号 / @latest / @major-only 一律判红（禁止 floating latest）。
      expect(map[key]).toMatch(/^https:\/\/testingcf\.jsdelivr\.net\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\/\+esm$/);
    });
  });

  it('已在全局上的同名库直接复用，不再发第二次网络请求（showdown / yaml 走 bootstrap 那条通道）', async () => {
    const deps = buildFrame();
    const showdownValue = { Converter: class Converter {} };
    (window as any).showdown = showdownValue;
    (window as any).YAML = { parse: (text: string) => text };
    (window as any).__palinkStLibImport = (url: string) => {
      deps.libImports.push(url);
      return Promise.resolve({ default: {} });
    };
    const libs = evalLibs(deps);
    await libs.__ensure('showdown');
    await libs.__ensure('yaml');
    expect(libs.showdown).toBe(showdownValue);
    expect((libs.yaml as any).parse('abc')).toBe('abc');
    expect(deps.libImports.filter((url) => url.includes('showdown'))).toHaveLength(0);
    expect(deps.libImports.filter((url) => url.includes('yaml'))).toHaveLength(0);
  });

  it('加载失败静默降级（值留 undefined + 一条 warn log，绝不抛给卡脚本）', async () => {
    const deps = buildFrame();
    (window as any).__palinkStLibImport = () => Promise.reject(new Error('CDN unreachable'));
    const libs = evalLibs(deps);
    await expect(libs.__ensure('Fuse')).resolves.toBeUndefined();
    expect(libs.Fuse).toBeUndefined();
    expect(deps.posted.some((m) => m.level === 'warn' && String(m.message).includes('libs.Fuse'))).toBe(true);
  });

  it('__ensure / __packageMap 是不可枚举辅助键，不进 Object.keys（25 键口径不被污染）', () => {
    const libs = evalLibs(buildFrame());
    const keys = Object.keys(libs);
    expect(keys).not.toContain('__ensure');
    expect(keys).not.toContain('__packageMap');
    expect(typeof (libs as any).__ensure).toBe('function');
  });
});

// ============================================================
// C. 红线：不许假成功 / 两项不许动
// ============================================================
describe('C 包G 红线 —— 不许假成功，两项按拍板保持原样', () => {
  it('renameChat 已接桥（包N B-3）：通道失败时不返回 true（红线仍是"不许假成功"）', async () => {
    // [包N B-3 2026-10-19] 契约变更：原"无论怎么调都不返回 true"是**未接通道**时的诚实降级；
    // 现已桥到 POST /api/chats/rename-session。红线不变 —— 父侧不 success 就不许回 true。
    const failDeps = buildFrame({
      parentByAction: { renameChat: { success: false, error: 'no_active_session' } },
    });
    const failCtx = evalGetContext(failDeps);
    const results = await Promise.all([
      failCtx.renameChat('a'), failCtx.renameChat('a', { force: true }), failCtx.renameChat(),
    ]);
    expect(results.every((value) => value === false)).toBe(true);
  });

  it('#14 getRequestHeaders 已按 ST 契约真实现（批次C C-1 改判，原「恒空对象」决策作废）', () => {
    // ST 一手锚点 script.js:645：返回 { 'Content-Type': 'application/json' } 且支持 omitContentType。
    // 2026-10-20 定性：帧是 opaque origin 且 /api 由 shim 本地应答 ⇒ 帧内没有 CSRF 值的数据源，
    // 也就不存在「把凭据送进帧」的泄漏面；按 ST 形状真实现、**不给** X-CSRF-Token（见 part-06 注释）。
    expect(SRC).toContain('getRequestHeaders: window.getRequestHeaders,');
    const notes = sliceDeclaration(SRC, 'const PALINK_STUB_API_NOTES = {');
    // 已实现 ⇒ 必须移出桩表，否则卡每调一次就产一条 st_api_stub 噪音
    expect(notes).not.toContain('getRequestHeaders:');
    const deps = buildFrame();
    const realHeaders = () => ({ 'Content-Type': 'application/json' });
    (window as any).getRequestHeaders = realHeaders;
    const ctx = evalGetContext(deps);
    expect(ctx.getRequestHeaders()).toEqual({ 'Content-Type': 'application/json' });
    expect(ctx.getRequestHeaders).toBe(realHeaders);
  });

  it('#15 getPresetManager 不补：仍是 {getSelectedPresetName…} 的既有形状（含 stubApi 留痕）', () => {
    const ctx = evalGetContext(buildFrame());
    const manager = ctx.getPresetManager();
    expect(manager).toBeTruthy();
    expect(typeof manager.getSelectedPresetName).toBe('function');
    expect(typeof manager.writePresetExtensionField).toBe('function');
    // 桩留痕仍在：调用 getSelectedPresetName 会经**帧内原文**的 reportStubApi → reportDiagnostic
    const deps = buildFrame();
    const manager2 = evalGetContext(deps).getPresetManager();
    expect(manager2.getSelectedPresetName()).toBe('Palink');
    const stubDiags = deps.diagnostics.filter((d) => d.code === 'st_api_stub');
    expect(stubDiags).toHaveLength(1);
    expect(stubDiags[0].apiName).toBe('getSelectedPresetName');
  });

  it('桩表只剩「故意不补」的 3 项（其余全已换成真实现或诚实失败）', () => {
    const notes = sliceDeclaration(SRC, 'const PALINK_STUB_API_NOTES = {');
    // [批次C C-1 2026-10-20] getRequestHeaders 已真实现 ⇒ 从 4 项减为 3 项。
    const remaining = [
      'getSelectedPresetName', 'writePresetExtensionField',
      'fetch:/api/worldinfo',
    ];
    remaining.forEach((name) => expect(notes).toContain(name));
    // 13 个修复项不得回到桩表
    ['getWorldInfoPrompt', 'getChatCompletionModel', 'getTextGenServer', 'convertCharacterBook',
      'updateWorldInfoList', 'reloadWorldInfoEditor', 'appendMediaToMessage', 'getMediaDisplay',
      'getMediaIndex', 'scrollOnMediaLoad', 'renameChat'].forEach((name) => {
      expect(notes, `${name} 又回到桩表了`).not.toContain(`${name}: '`);
    });
  });
});
