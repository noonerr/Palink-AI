/*
 * 批次E2-2：宿主转译器 export 规则 11（及 8b）必须用活绑定，不能立即赋值（2026-10-21）
 *
 * 真机报错：`[PluginSandbox] … Summarize …: ReferenceError: Cannot access 'MODULE_NAME'
 * before initialization`。根因：st-plugins/memory/index.js:34 `export { MODULE_NAME }`
 * 早于 :36 `const MODULE_NAME = '1_memory'`。ES module 的 export 列表是**懒绑定**，
 * 宿主规则 11 却把 `module.exports.MODULE_NAME = MODULE_NAME;` 内联在 export 语句位置，
 * 模块求值到那一行时 const 还在 TDZ，必抛。
 *
 * 帧内 normalizeStExportListCompat（runtime-body/part-02.ts）早已改成
 * `Object.defineProperty(exports, name, { get })`；宿主照抄。
 *
 * 本文件用**真实 PluginSandbox.executePluginCode**（与生产同一入口）执行：
 *   1. 最小复现：export 列表在前、const 在后；
 *   2. 真实插件源码片段：st-plugins/memory/index.js 的对应两行；
 *   3. 活绑定真的活：导出后对局部变量再赋值，读导出能看到新值；
 *   4. 规则 8b（`export let X;` 无初始化）同样是活绑定；
 *   5. `export const X` + `export { X }` 同模块并存不抛 "Cannot redefine property"；
 *   6. export class / `as default` 等常规形态没被改坏。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/export-live-binding-transpile.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function runModule(source: string): Promise<Record<string, any>> {
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, 'e2-2-probe');
}

describe('E2-2 规则 11：export { X } 早于 const X 时不得撞 TDZ（执行型）', () => {
  it('最小复现：export 列表在前、const 在后，求值后能读到正确值且不抛 TDZ', async () => {
    const exports = await runModule(`
      export { MODULE_NAME };
      const MODULE_NAME = '1_memory';
    `);
    expect(exports.MODULE_NAME).toBe('1_memory');
  });

  it('真实插件源码片段：st-plugins/memory/index.js 的 export { MODULE_NAME } + const 两行', async () => {
    const memoryPath = join(process.cwd(), '..', 'st-plugins', 'memory', 'index.js');
    const memorySrc = readFileSync(memoryPath, 'utf8');
    const exportIdx = memorySrc.indexOf('export { MODULE_NAME };');
    const constIdx = memorySrc.indexOf("const MODULE_NAME = '1_memory';", exportIdx);
    expect(exportIdx, 'memory/index.js 里找不到 export { MODULE_NAME };').toBeGreaterThan(-1);
    expect(constIdx, 'memory/index.js 里找不到 const MODULE_NAME 声明').toBeGreaterThan(exportIdx);
    const lineEnd = memorySrc.indexOf('\n', constIdx);
    const fragment = memorySrc.slice(exportIdx, lineEnd + 1);
    expect(fragment).toContain('export { MODULE_NAME };');
    expect(fragment).toContain("const MODULE_NAME = '1_memory';");

    const exports = await runModule(fragment);
    expect(exports.MODULE_NAME).toBe('1_memory');
  });

  it('活绑定：导出后给局部变量重新赋值，导出侧读得到新值（不是快照）', async () => {
    const exports = await runModule(`
      export { value as answer };
      let value = 41;
      export function setValue(next) { value = next; }
    `);
    expect(exports.answer).toBe(41);
    (exports as any).setValue(42);
    expect(exports.answer).toBe(42);
  });

  it('规则 8b：export let X;（无初始化）也是活绑定，后续赋值可见', async () => {
    const exports = await runModule(`
      export let api;
      export function setApi(next) { api = next; }
    `);
    expect(exports.api).toBeUndefined();
    (exports as any).setApi({ ready: true });
    expect(exports.api).toEqual({ ready: true });
  });

  it('export const X + export { X } 同模块并存不抛 "Cannot redefine property"', async () => {
    const exports = await runModule(`
      export const X = 7;
      export { X };
    `);
    expect(exports.X).toBe(7);
  });

  it('export class 与 export { X as default } 等常规形态未被改坏', async () => {
    const exports = await runModule(`
      export { Klass, VALUE as default };
      const VALUE = 'v';
      export class Klass { constructor() { this.k = 1; } }
    `);
    expect(new (exports as any).Klass().k).toBe(1);
    expect((exports as any).default).toBe('v');
  });
});
