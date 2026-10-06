/*
 * 控制台噪音治理 + 卡崩溃可见性守卫（2026-10-06 立）
 *
 * 背景（用户真机日志 localhost-1791227114044.log 实测）：
 *   ① 一张 4MB 的卡脚本在控制台打 5~6 份**完全相同**的日志（它被按消息块重复实例化，
 *      每个 iframe 一个 realm，卡自己的 init 锁管不到跨帧），769 行日志里有效信息不足 30 行。
 *   ② 卡脚本 init 中途抛错死掉时，它的设置按钮**已经渲染**但点击处理器里
 *      `_showSettingsPanelRef2` 仍是 null，那段代码「null 就静默跳过」——
 *      无 else、无报错 ⇒ 用户看到的是「点了没反应」，无从判断发生了什么。
 *
 * 本文件钉两件事：
 *   A. console governor：同一条重复日志只放行首次；warn/error 一律原样放行；
 *      `__palinkConsoleVerbose = true` 时全量放行（逃生开关）。
 *   B. 崩溃守卫：入口点击被 Palink 捕获并**可见地**报出，不再石沉大海。
 *
 * A 走**真行为断言**（把生成的脚本放进 vm 里跑，喂假 console 看它压不压）；
 * B 走结构断言 + 反证（生成文本里必须有捕获阶段监听与两个 diagnostic code）。
 *
 * 运行: npx vitest run
 */
import { describe, expect, it } from 'vitest';
import * as vm from 'node:vm';

import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

const SHIM_OPTS = {
  context: { characterId: 'gov-frame-char', language: 'zh' },
  frameId: 'gov-frame-0001',
  sourceHtml: '<div></div>',
  mode: 'inline',
} as any;

/** 取兼容运行时**外部脚本**体（无 <script> 外壳）——正是注入 iframe 的那段。 */
function extractRuntimeBody(): string {
  const shim = buildSillyTavernCompatRuntimeV2Shim(SHIM_OPTS);
  // shim 里可能含多个 <script> 段（boot 数据 + 运行时体）。运行时体是最后一段且最大。
  const blocks = [...String(shim).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const body = blocks.sort((a, b) => b.length - a.length)[0] || '';
  expect(body.length).toBeGreaterThan(1000);
  return body;
}

/**
 * 只把 **console governor 这一段**抽出来单独跑。
 *
 * 为什么不整段执行生成脚本：运行时体有 6000+ 行，会连带调 `container.append` /
 * `document.documentElement.style.setProperty` 等一大票 DOM 行为，在 vm 里铺全 DOM 等于
 * 自己写个浏览器（既脆又没测到重点）。这一段是自包含的：只依赖 `window.console`，
 * 产出的 outcome 就是 `window.console` 被换成 governor —— 抽出来测，断的就是真行为。
 */
function extractConsoleGovernorBlock(): string {
  const body = extractRuntimeBody();
  const start = body.indexOf('const __nativeConsole =');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('const console = window.console;', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** 在一个只有 console 的沙箱里跑 governor 段，返回装好的 console。 */
function runGovernorWithFakeConsole() {
  const nativeLogs: string[] = [];
  const nativeErrors: string[] = [];
  const fakeNative = {
    log: (...args: any[]) => { nativeLogs.push(args.map(String).join(' ')); },
    info: (...args: any[]) => { nativeLogs.push(args.map(String).join(' ')); },
    debug: (...args: any[]) => { nativeLogs.push(args.map(String).join(' ')); },
    warn: (...args: any[]) => { nativeErrors.push('warn:' + args.map(String).join(' ')); },
    error: (...args: any[]) => { nativeErrors.push('error:' + args.map(String).join(' ')); },
    assert: () => {},
    clear: () => {},
  };
  const sandbox: any = { console: fakeNative };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(extractConsoleGovernorBlock(), { filename: 'governor.generated.js' }).runInContext(context);
  return { sandbox, nativeLogs, nativeErrors };
}

/**
 * SillyTavern 兼容面：卡脚本（实测 MVU）从 window.SillyTavern 上取 API，取不到就崩。
 * 这里只做**生成文本的结构断言**——真行为验证要整套运行时在 vm 里跑，
 * 而它依赖的 DOM 面太宽（见文件头说明），抽段测试更稳。
 */
describe('SillyTavern API 桥接（缺 API 会崩的根因修复）', () => {
  /**
   * 把 Proxy 这一段抽出来，在 vm 里注入桩依赖**真跑一遍**。
   * 比结构断言强：能直接复现「卡拿到的是什么值」，而值本身就是这次 bug 的全部。
   */
  function runProxyWithStubs(): any {
    const body = extractRuntimeBody();
    const start = body.indexOf('const installSillyTavernCompatProxy = () => {');
    expect(start).toBeGreaterThan(-1);
    const end = body.indexOf('installSillyTavernCompatProxy();', start);
    expect(end).toBeGreaterThan(start);
    const block = body.slice(start, end) + '\ninstallSillyTavernCompatProxy();';

    const sandbox: any = {
      Proxy,
      Object,
      String,
      Boolean,
      console,
      diagnostics: [] as any[],
      // ① 层：SillyTavern 自带的键，必须优先且不被覆盖
      window: { SillyTavern: { getContext: () => ({ from: 'self' }) } },
      // ③ 层：tavernHelperCompat（实测 57 键，MVU 要的 23 个里只命中 1 个）
      tavernHelperCompat: { uuidv4: () => 'stub-uuid' },
      // ② 层：getContextCompat —— 真正装着 MVU 要的那 ~20 个实现
      getContextCompat: () => ({
        chat: [{ id: 1 }],
        characters: [{ name: 'char-a' }],
        ToolManager: { isToolCallingSupported: () => false },
        registerFunctionTool: () => true,
      }),
      reportDiagnostic: (d: any) => {
        sandbox.diagnostics.push(d);
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(block, sandbox);
    return sandbox;
  }

  it('②层必须落到 getContextCompat（一修错落到 tavernHelperCompat，等于没修）', () => {
    const body = extractRuntimeBody();
    const start = body.indexOf('const installSillyTavernCompatProxy = () => {');
    expect(start).toBeGreaterThan(-1);
    const block = body.slice(start, start + 2600);
    expect(block).toContain('getContextCompat()');
    expect(block).toContain('if (ctxObj && prop in ctxObj) return ctxObj[prop];');
    expect(block).toContain('if (prop in tavernHelperCompat) return tavernHelperCompat[prop];');
  });

  it('已知 API 能按 ①→②→③ 顺序取到真实实现', () => {
    const s = runProxyWithStubs();
    expect(s.window.SillyTavern.getContext().from).toBe('self'); // ① 自带优先
    expect(s.window.SillyTavern.chat).toEqual([{ id: 1 }]); // ② getContext
    expect(s.window.SillyTavern.ToolManager.isToolCallingSupported()).toBe(false); // ②
    expect(s.window.SillyTavern.uuidv4()).toBe('stub-uuid'); // ③
  });

  it('★ 缺口必须返回 undefined，不能返回假函数', () => {
    // 这是 2026-10-06 二修的核心。一修给缺口返回 makeMissingApiFunction，
    // 而**函数在 JS 里恒为真**。MVU 原文写法：
    //   const { registerFunctionTool: e } = SillyTavern;
    //   return e ? 走注册分支 : (提示不支持, 返回安全空实现)
    // 假函数 ⇒ 走左边 ⇒ 崩在更深处；undefined ⇒ 走右边 ⇒ 优雅降级。
    const s = runProxyWithStubs();
    const missing = s.window.SillyTavern.registerFunctionTool_不存在的键;
    expect(missing).toBeUndefined();
    expect(s.window.SillyTavern.chatCompletionSettings).toBeUndefined();
    expect(missing ? '走注册分支(会崩)' : '走安全降级分支').toBe('走安全降级分支');
  });

  it('缺口要有诊断留痕，不能静默消失', () => {
    const s = runProxyWithStubs();
    void s.window.SillyTavern.某个没实现的API;
    void s.window.SillyTavern.某个没实现的API; // 第二次不应重复上报
    const hits = s.diagnostics.filter((d: any) => d.code === 'sillytavern_api_missing');
    expect(hits.length).toBe(1);
    expect(String(hits[0].apiName)).toContain('SillyTavern.某个没实现的API');
  });
});

describe('控制台噪音治理（console governor）', () => {
  it('同一条重复日志只放行首次，重复的被折叠', () => {
    const { sandbox, nativeLogs } = runGovernorWithFakeConsole();
    // 运行时自己会把 window.console 换成 governor，取回来直接用
    const governed = sandbox.window.console;
    expect(governed).toBeTruthy();
    expect(sandbox.window.__palinkConsoleGovernor).toBeTruthy();

    const before = nativeLogs.length;
    governed.log('[重复] 同一句');
    governed.log('[重复] 同一句');
    governed.log('[重复] 同一句');
    const emitted = nativeLogs.slice(before);
    // 首次可见；第 2、3 次被折叠（未达 ANNOUNCE_EVERY=20 的播报点）
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toContain('同一句');
  });

  it('内容不同的日志不被折叠', () => {
    const { sandbox, nativeLogs } = runGovernorWithFakeConsole();
    const governed = sandbox.window.console;
    const before = nativeLogs.length;
    governed.log('唯一消息 A');
    governed.log('唯一消息 B');
    governed.log('唯一消息 C');
    expect(nativeLogs.length - before).toBe(3);
  });

  it('warn / error 原样放行，绝不折叠', () => {
    const { sandbox, nativeErrors } = runGovernorWithFakeConsole();
    const governed = sandbox.window.console;
    const before = nativeErrors.length;
    governed.error('同一条错误');
    governed.error('同一条错误');
    governed.error('同一条错误');
    governed.warn('同一条警告');
    governed.warn('同一条警告');
    // 5 条全部原样抵达，一条不少（告警/报错含唯一信息，折叠会藏 bug）
    expect(nativeErrors.length - before).toBe(5);
    expect(nativeErrors.filter((line) => line.startsWith('error:')).length).toBe(3);
  });

  it('逃生开关 __palinkConsoleVerbose = true 时全量放行', () => {
    const { sandbox, nativeLogs } = runGovernorWithFakeConsole();
    const governed = sandbox.window.console;
    sandbox.window.__palinkConsoleVerbose = true;
    const before = nativeLogs.length;
    governed.log('落盘 1');
    governed.log('落盘 1');
    governed.log('落盘 1');
    expect(nativeLogs.length - before).toBe(3);
  });

  it('重复到 ANNOUNCE_EVERY 的整数倍时播出折叠计数，用户知道被压了多少', () => {
    const { sandbox, nativeLogs } = runGovernorWithFakeConsole();
    const governed = sandbox.window.console;
    const before = nativeLogs.length;
    for (let i = 0; i < 21; i++) governed.log('[计数] 同一句');
    const emitted = nativeLogs.slice(before);
    // 首次 1 条 + 第 20 次播报 1 条（seen=20 时 seen % 20 === 0）
    expect(emitted.length).toBe(2);
    expect(emitted[1]).toContain('已折叠重复日志');
  });
});

describe('卡崩溃可见性守卫', () => {
  it('生成文本里装了「入口无响应」的捕获阶段监听与两个诊断码', () => {
    const body = extractRuntimeBody();
    // 捕获阶段（第三个参数 true）监听点击
    expect(body).toContain("document.addEventListener('click'");
    expect(body).toMatch(/data-action="config"/);
    expect(body).toMatch(/data-action="open-settings"/);
    // 两个可见性诊断码：启动未完成 / 入口无响应
    expect(body).toContain('card_bootstrap_incomplete');
    expect(body).toContain('card_settings_entry_unresponsive');
    // 不依赖卡自身挂载点的浮层提示
    expect(body).toContain('palink-card-crash-notice');
  });

  it('反证：守卫确实在做「卡自己没起来才提示」的判断，不是无条件弹', () => {
    const body = extractRuntimeBody();
    expect(body).toContain('cardCrashGuardState.sawCardBootstrap');
    // 卡自己的全局导出出现时应标记为已启动
    expect(body).toContain('sawCardBootstrap = true');
  });
});
