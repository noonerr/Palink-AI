/*
 * 批次SG：插件沙箱必须提供 ST 1.18.0 的全局对象 `SillyTavern`（2026-10-21）
 *
 * 真机事实：Kimi Thinking Prefill 1.1.0 加载即 `ReferenceError: SillyTavern is not defined`，
 * 其源码第一行是 `const { eventSource, event_types } = SillyTavern.getContext();`。
 * ST 1.18.0 public/script.js:292-295 的全局对象只有两个字段：
 *     globalThis.SillyTavern = { libs, getContext };
 *
 * 本文件守四件事：
 *   1. 裸标识符 `SillyTavern`（不是 globalThis.SillyTavern）在插件作用域里可解析 ——
 *      这是 Kimi 报错的那条路径。只挂 globalThis 是不够的：new Function 的作用域链
 *      不查 sandboxedWindow（见 buildWrappedCode 内注释）。
 *   2. `SillyTavern.libs` 只装本沙箱**真实注入**的六个库，键集合精确；ST 有而我们没有的
 *      键（lodash/Fuse/moment…）必须是 undefined，不许用假对象凑数。
 *   3. `SillyTavern.getContext()` 与沙箱既有 `getContext()` 同形（键集合一致），
 *      且 eventSource / event_types 均非 undefined。
 *   4. 反证：把 prelude 里批次SG 那段整块删掉，用**同一段生产 prelude 文本**执行
 *      Kimi 首行必须抛 `SillyTavern is not defined`（本条保证第 1 条不是宿主全局的假阳性）。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/sg-sillytavern-global.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PluginSandbox } from '../sandbox';

const CONTEXT = {
  on: () => {},
  off: () => {},
  emit: () => {},
  once: () => {},
  removeAllListeners: () => {},
  storage: {
    get: () => undefined,
    set: () => {},
    delete: () => {},
    clear: () => {},
  },
  registerCommand: () => {},
  registerMacro: () => {},
  log: () => {},
};

/** Kimi Thinking Prefill 1.1.0 的首行形态（一手：其 index.js 第一行） */
const KIMI_FIRST_LINE = `
  const { eventSource, event_types } = SillyTavern.getContext();
`;

async function runPlugin(source: string, pluginId = 'sg-probe') {
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, pluginId);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('批次SG SillyTavern 全局对象', () => {
  it('真实插件形态：裸标识符 SillyTavern 可解析，eventSource / event_types 都非 undefined', async () => {
    const exports = await runPlugin(`
      ${KIMI_FIRST_LINE}
      module.exports = {
        eventSourceDefined: eventSource !== undefined && eventSource !== null,
        eventTypesDefined: event_types !== undefined && event_types !== null,
        eventSourceOn: typeof eventSource?.on,
        eventTypesCount: event_types ? Object.keys(event_types).length : -1,
        // context.eventSource 必须就是沙箱 eventSource（on/off/emit 带清理注册的那份）
        eventSourceIsSandboxOne: eventSource === require('script.js').eventSource,
      };
    `);

    expect(exports.eventSourceDefined).toBe(true);
    expect(exports.eventTypesDefined).toBe(true);
    expect(exports.eventSourceOn).toBe('function');
    expect(exports.eventTypesCount as number).toBeGreaterThan(0);
    expect(exports.eventSourceIsSandboxOne).toBe(true);
  });

  it('SillyTavern.libs 只含真实注入的六个库，jQuery 是可用函数而不是占位对象', async () => {
    const exports = await runPlugin(`
      const libs = SillyTavern.libs;
      module.exports = {
        keys: Object.keys(libs).sort(),
        jQueryType: typeof libs.jQuery,
        dollarIsJQuery: libs.$ === libs.jQuery,
        jQueryFnType: typeof libs.jQuery?.fn,
        jQueryVersion: libs.jQuery?.fn?.jquery,        handlebarsCompile: typeof libs.Handlebars?.compile,
        dompurifySanitize: typeof libs.DOMPurify?.sanitize,
        toastrInfo: typeof libs.toastr?.info,
        markedParse: typeof libs.marked?.parse,
        // ST 有而我们没注入：必须诚实为 undefined，不许造假
        lodash: libs.lodash,
        Fuse: libs.Fuse,
        moment: libs.moment,
      };
    `);

    expect(exports.keys).toEqual(['$', 'DOMPurify', 'Handlebars', 'jQuery', 'marked', 'toastr']);
    expect(exports.jQueryType).toBe('function');
    expect(exports.dollarIsJQuery).toBe(true);
    expect(exports.jQueryFnType).toBe('object');
    expect(typeof exports.jQueryVersion).toBe('string');
    expect(exports.handlebarsCompile).toBe('function');
    expect(exports.dompurifySanitize).toBe('function');
    expect(exports.toastrInfo).toBe('function');
    expect(exports.markedParse).toBe('function');
    expect(exports.lodash).toBeUndefined();
    expect(exports.Fuse).toBeUndefined();
    expect(exports.moment).toBeUndefined();
  });

  it('SillyTavern.getContext() 与沙箱既有 getContext() 同形（键集合一致）且字段可读', async () => {
    const exports = await runPlugin(`
      const viaSandbox = getContext();
      const viaGlobal = SillyTavern.getContext();
      const keysOf = (o) => Object.keys(o).sort();
      module.exports = {
        sameKeys: JSON.stringify(keysOf(viaSandbox)) === JSON.stringify(keysOf(viaGlobal)),
        directKeys: keysOf(viaSandbox),
        stKeys: keysOf(viaGlobal),
        sameFunction: SillyTavern.getContext === getContext,
        eventSourceReadable: viaGlobal.eventSource !== undefined,
        eventTypesReadable: viaGlobal.event_types !== undefined,
        chatType: typeof viaGlobal.chat,
      };
    `);

    expect(exports.sameKeys).toBe(true);
    expect(exports.stKeys).toEqual(exports.directKeys);
    expect((exports.directKeys as string[]).length).toBeGreaterThan(0);
    expect(exports.sameFunction).toBe(true);
    expect(exports.eventSourceReadable).toBe(true);
    expect(exports.eventTypesReadable).toBe(true);
    // chat 由 buildStContext() 兜底提供（ST 插件最常读的字段之一）
    expect(exports.chatType).toBe('object');
  });

  it('不存在的属性仍是 undefined（不是“什么都返回”的 Proxy）', async () => {
    const exports = await runPlugin(`
      module.exports = {
        ownKeys: Object.keys(SillyTavern).sort(),
        topMissing: SillyTavern.nonexistentApi === undefined,
        libsMissing: SillyTavern.libs?.nonexistentLib === undefined,
        isPlainObject: Object.getPrototypeOf(SillyTavern) === Object.prototype,
        windowPathSame: window.SillyTavern === SillyTavern,
        globalThisPathSame: globalThis.SillyTavern === SillyTavern,
      };
    `);

    // 与 ST public/script.js:292-295 一致：只有 libs / getContext 两个字段
    expect(exports.ownKeys).toEqual(['getContext', 'libs']);
    expect(exports.topMissing).toBe(true);
    expect(exports.libsMissing).toBe(true);
    expect(exports.isPlainObject).toBe(true);
    expect(exports.windowPathSame).toBe(true);
    expect(exports.globalThisPathSame).toBe(true);
  });

  it('不污染宿主 window：沙箱内的 SillyTavern 只存在于 pluginGlobals 隔离存储', async () => {
    expect((window as any).SillyTavern).toBeUndefined();
    await runPlugin(`module.exports = { ok: typeof SillyTavern === 'object' };`, 'sg-no-leak');
    expect((window as any).SillyTavern).toBeUndefined();
    // bare 标识符解析走的就是全局对象；上面已证明宿主 window 上没有它 ⇒ 正例只可能来自 prelude
    expect((globalThis as any).SillyTavern).toBeUndefined();
  });
});

describe('批次SG 反证：删掉 prelude 里的 SillyTavern 块，Kimi 首行必须报 ReferenceError', () => {
  /** 直接拿生产 buildWrappedCode 产出的文本，整块剥离批次SG 代码 */
  const SG_BLOCK = /\/\/ ===== 批次SG[\s\S]*?globalThis\.SillyTavern = SillyTavern;\n/;

  function execWrapped(wrappedCode: string, pluginId: string) {
    const sandbox = new PluginSandbox() as any;
    const sandboxGlobal = sandbox.createSandboxGlobal(CONTEXT, pluginId);
    return new Function(wrappedCode)(sandboxGlobal) || {};
  }

  it('对照：未剥离的生产 prelude 里 typeof SillyTavern === "object"', () => {
    const sandbox = new PluginSandbox() as any;
    const stock = sandbox.buildWrappedCode('module.exports = { type: typeof SillyTavern };');
    expect(SG_BLOCK.test(stock), '生产 prelude 里找不到批次SG 代码块（标记被改名了？）').toBe(true);
    const exports = execWrapped(stock, 'sg-stock');
    expect(exports.type).toBe('object');
  });

  it('剥离后：同一段 Kimi 首行抛出 SillyTavern is not defined，模块体不再执行', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sandbox = new PluginSandbox() as any;
    const stock = sandbox.buildWrappedCode(`
      ${KIMI_FIRST_LINE}
      module.exports = { reached: true };
    `);
    const stripped = stock.replace(SG_BLOCK, '');
    expect(stripped).not.toBe(stock);
    expect(stripped).not.toContain('var SillyTavern');

    delete (window as any).__lastPluginRuntimeError;
    const exports = execWrapped(stripped, 'sg-stripped');

    // 抛在 IIFE 里被 __sandbox.onError 捕获 ⇒ 模块体后面的赋值没执行
    expect(exports.reached).toBeUndefined();
    expect(String((window as any).__lastPluginRuntimeError?.message)).toContain(
      'SillyTavern is not defined',
    );
  });
});
