/*
 * 批次MC：多文件插件模块链——相对导入必须解析到插件自己的文件（2026-10-21）
 *
 * 真机报错（Smart Memory 1.8.3，31 个模块）：
 *   `Unhandled promise rejection: TypeError: registerSmartMemoryMacros is not a function`
 * 根因：宿主 makeRequire 此前**先查 ST 模块白名单**，再看插件本地文件。真包
 *   index.js:127 `import { registerSmartMemoryMacros } from './macros.js'`
 *   经 normalizeModulePath 变成 'macros.js'，直接命中 ST 的 macros.js shim
 *   （只有 MacrosParser，没有该函数）→ 具名导入 undefined → 初始化调用即 TypeError。
 *   同批被顶替的还有真包的 './constants.js'（21 处导入，撞 ST constants.js）。
 *
 * 语义依据：ST 里相对 import 按文件系统解析，扩展目录下的 ./macros.js 永远是
 * 插件自己的文件；只有越过插件根的 ../../../../script.js 一类才指向 ST scripts。
 *
 * 本文件用**真实 PluginSandbox.executePluginCode**（生产同一入口）执行 4 组用例：
 *   1. 真机形状：入口 ./macros.js + ./constants.js 都撞 ST 同名模块名；
 *   2. 子目录 + ../ 与越界路径：插件内相对路径优先，越界路径仍走 ST 且不被本地同名文件顶替；
 *   3. 循环依赖：namespace 导入在中途拿到占位对象，被依赖模块求值完成后能看到导出；
 *   4. 非相对裸路径的本地回退与 ST 白名单常规可用（旧行为不回退）。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/multi-file-module-resolution.test.ts
 */
import { describe, it, expect } from 'vitest';
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

function runPlugin(
  entry: string,
  localFiles: Array<{ path: string; content: string }>,
  entryPath = 'index.js',
): Promise<Record<string, any>> {
  return new PluginSandbox().executePluginCode(entry, CONTEXT as any, 'mc-probe', entryPath, localFiles);
}

describe('批次MC：多文件插件相对导入解析（执行型）', () => {
  it('MC-1 真机形状：./macros.js / ./constants.js 不得被 ST 同名 shim 顶替', async () => {
    const exports = await runPlugin(
      `
      import { registerSmartMemoryMacros, MACRO_NAMES } from './macros.js';
      import { MODULE_NAME, META_KEY } from './constants.js';
      export const symbolKind = typeof registerSmartMemoryMacros;
      export const registration = registerSmartMemoryMacros();
      export const moduleName = MODULE_NAME;
      export const metaKey = META_KEY;
      export const firstMacro = MACRO_NAMES.shortterm;
      `,
      [
        {
          path: 'constants.js',
          // 与 ST constants.js 同名但内容完全不同（ST shim 只有 debounce_timeout 等）
          content: `export const MODULE_NAME = 'smart_memory';\nexport const META_KEY = 'sm_meta';`,
        },
        {
          path: 'macros.js',
          // 与 ST macros.js 同名；具名导出的函数是 E2b 规则 9（hoisted）路径
          content: `import { MODULE_NAME } from './constants.js';
            export const MACRO_NAMES = { shortterm: 'smartmemory-shortterm' };
            export function registerSmartMemoryMacros() { return MODULE_NAME; }`,
        },
      ],
    );
    expect(exports.symbolKind).toBe('function');
    expect(exports.registration).toBe('smart_memory');
    expect(exports.moduleName).toBe('smart_memory');
    expect(exports.metaKey).toBe('sm_meta');
    expect(exports.firstMacro).toBe('smartmemory-shortterm');
  });

  it('MC-2 子目录：./ 与 ../ 落在插件根内走本地；越界路径走 ST 且不被本地同名文件顶替', async () => {
    const exports = await runPlugin(
      `
      import { localName } from './names.js';
      import { shared } from '../shared/util.js';
      import { rootLocal } from '../root-local.js';
      import { rootExtensions } from '../extensions.js';
      import { getContext as stGetContext } from '../../../extensions.js';
      import { MacrosParser } from '../../../../scripts/macros.js';
      import { x } from 'lib/thing.js';
      export const out = {
        localName, shared, rootLocal, rootExtensions,
        stGetContextKind: typeof stGetContext,
        macrosParserKind: typeof MacrosParser,
        bareLocal: x,
      };
      `,
      [
        { path: 'core/names.js', content: `export const localName = 'core-names';` },
        { path: 'shared/util.js', content: `export const shared = 'shared-util';` },
        { path: 'root-local.js', content: `export const rootLocal = 'root-local';` },
        // 插件根自己的 extensions.js：'../extensions.js'（未越界）必须命中它，
        // 而 '../../../extensions.js'（越界）必须命中 ST shim —— 两者不能混。
        { path: 'extensions.js', content: `export const rootExtensions = 'LOCAL_EXTENSIONS';` },
        // 插件根自己的 macros.js：'../../../../scripts/macros.js' 越界后必须走 ST，
        // 不能被这个同名本地文件顶替。
        { path: 'macros.js', content: `export const MacrosParser = 'LOCAL_MACROS';` },
        { path: 'lib/thing.js', content: `export const x = 'bare-local';` },
      ],
      'core/main.js',
    );
    expect(exports.out.localName).toBe('core-names');
    expect(exports.out.shared).toBe('shared-util');
    expect(exports.out.rootLocal).toBe('root-local');
    expect(exports.out.rootExtensions).toBe('LOCAL_EXTENSIONS');
    expect(exports.out.stGetContextKind).toBe('function');
    expect(exports.out.macrosParserKind).toBe('function');
    expect(exports.out.bareLocal).toBe('bare-local');
  });

  it('MC-3 循环依赖：namespace 导入先拿占位对象，被依赖模块求值完成后能看到导出', async () => {
    const exports = await runPlugin(
      `
      import { a } from './a.js';
      export const result = a();
      `,
      [
        {
          path: 'a.js',
          content: `import * as b from './b.js';\nexport function a() { return 'a(' + b.b() + ')'; }`,
        },
        {
          path: 'b.js',
          content: `import * as a from './a.js';\nexport function b() { return 'b(' + typeof a.a + ')'; }`,
        },
      ],
    );
    expect(exports.result).toBe('a(b(function))');
  });

  it('MC-4 常规 ST 导入不回退：无本地文件时 ../../../extensions.js 仍是 ST shim', async () => {
    const exports = await runPlugin(
      `
      import { getContext, extension_settings } from '../../../extensions.js';
      import { MacrosParser } from '../../../../scripts/macros.js';
      export const kinds = [typeof getContext, typeof extension_settings, typeof MacrosParser];
      `,
      [],
    );
    expect(exports.kinds).toEqual(['function', 'object', 'function']);
  });
});
