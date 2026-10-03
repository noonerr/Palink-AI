/*
 * Z5 守卫：MacrosParser.registerMacro 的签名与 evaluate 的求值闭环。
 *
 * 背景：Palink 的沙箱给插件提供 `macros.js` 的 MacrosParser。此前该实现有两处静默断链：
 *   1. registerMacro 只认 `{ macroName }` 单对象形态，而 ST 官方（scripts/macros.js:183）
 *      与全部真实消费方用的都是 `registerMacro(key, value, description?)` 三参签名
 *      —— st-plugins/memory `registerMacro('summary', () => ...)`、
 *        stable-diffusion 的 charPrefix / charNegativePrefix。于是注册被丢弃，
 *        插件的宏永远不参与求值，且不报错。
 *   2. evaluate 是恒等函数 `return String(text)`，插件调它拿到的永远是原文。
 *
 * 本测试走真实沙箱实例（pluginSandbox.getModuleExports），不做源码字符串断言 ——
 * 契约锁在「调了会发生什么」上，改个函数名不该假红，写错逻辑也不该假绿。
 */
import { describe, it, expect } from 'vitest';
import { pluginSandbox } from '@/lib/plugin-system/sandbox';

/**
 * 走真实插件执行路径取 MacrosParser：把一段插件源码丢进沙箱跑，源码里
 * `import { MacrosParser } from 'macros.js'`，再用 `module.exports` 把实例带回来。
 * 这样测的就是插件真会走的路 —— 而不是直接摸 moduleMap 私有表。
 */
async function loadMacrosParser(): Promise<any> {
  const exports = await pluginSandbox.executePluginCode(
    `import { MacrosParser } from 'macros.js';
     module.exports = { MacrosParser };`,
    {} as any,
    '__z5_probe__',
  );
  const parser = (exports as any)?.MacrosParser;
  expect(parser, 'macros.js 应导出 MacrosParser').toBeTruthy();
  return parser;
}

describe('Z5: MacrosParser 注册宏真正参与求值', () => {
  it('ST 三参签名 registerMacro(key, fn) 能注册成功（此前静默丢弃）', async () => {
    const P = await loadMacrosParser();
    P.registerMacro('summary', () => '记忆摘要内容', 'desc');
    expect(P.parse().map((m: any) => m.macroName)).toContain('summary');
  });

  it('evaluate 把注册宏替换成函数返回值', async () => {
    const P = await loadMacrosParser();
    P.registerMacro('summary', () => 'MEM-OK');
    expect(P.evaluate('前缀-{{summary}}-后缀')).toBe('前缀-MEM-OK-后缀');
  });

  it('字符串形态的注册值同样生效', async () => {
    const P = await loadMacrosParser();
    P.registerMacro('charPrefix', ' beauty ');
    expect(P.evaluate('a{{charPrefix}}b')).toBe('a beauty b');
  });

  it('兼容旧的 Palink 对象形态 registerMacro({ macroName })', async () => {
    const P = await loadMacrosParser();
    P.registerMacro({ macroName: 'legacy', value: 'L' });
    expect(P.evaluate('x{{legacy}}y')).toBe('xLy');
  });

  it('未注册的宏保持原样，不被吞成空串', async () => {
    const P = await loadMacrosParser();
    expect(P.evaluate('{{notRegistered}}')).toBe('{{notRegistered}}');
  });

  it('注册宏函数抛错时降级为空串并继续求值，不炸掉整条链', async () => {
    const P = await loadMacrosParser();
    P.registerMacro('boom', () => {
      throw new Error('macro blew up');
    });
    P.registerMacro('good', () => 'G');
    expect(P.evaluate('a{{boom}}b{{good}}c')).toBe('abGc');
  });

  it('unregisterMacro 后该宏不再被替换', async () => {
    const P = await loadMacrosParser();
    P.registerMacro('temp', () => 'T');
    expect(P.evaluate('{{temp}}')).toBe('T');
    P.unregisterMacro('temp');
    expect(P.evaluate('{{temp}}')).toBe('{{temp}}');
  });

  it('函数型注册值是每次求值现取的（ST 语义）', async () => {
    const P = await loadMacrosParser();
    let n = 0;
    P.registerMacro('counter', () => `#${++n}`);
    expect(P.evaluate('{{counter}}')).toBe('#1');
    expect(P.evaluate('{{counter}}')).toBe('#2');
  });
});