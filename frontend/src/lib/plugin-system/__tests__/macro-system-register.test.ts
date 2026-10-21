/*
 * 批次E2b-2：macros/macro-system.js 的 macros 必须是可注册的真实现（2026-10-21）
 *
 * 真机报错（E2 上线后）：`[PluginSandbox] 插件 Summarize 钩子 init 执行失败:
 * TypeError: macros.register is not a function`。
 * 根因：宿主沙箱 shim 里 'macros/macro-system.js' 的 macros 是**空对象**
 * （sandbox.ts:5399-5419），而 ST 1.18 的 macros =
 * { registry, register: MacroRegistry.registerMacro.bind(...), registerAlias, ... }。
 * memory / stable-diffusion 在 power_user.experimental_macro_engine=true 时都走
 * `macros.register(name, { category, description, handler })`。
 *
 * 本文件守三件事：
 *   1. 走真实 PluginSandbox 执行路径，macros.register/unregister/registerAlias/registry 都在；
 *   2. 按真实调用面注册的宏**真的参与 substituteParamsExtended 求值**（不是只挂个函数）；
 *   3. MacroCategory 与 ST 1.18 枚举一致（PROMPTS 等），插件卸载时宏被撤回。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/macro-system-register.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PluginSandbox } from '../sandbox';
import { substituteParamsExtended, MacroRegistry } from '@/lib/sillytavern/macros';

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

const REGISTERED_NAMES = [
  'e2b2_hello',
  'e2b2_registry',
  'e2b2_alias_target',
  'e2b2_alias',
  'e2b2_ctx',
  'e2b2_removed',
  'e2b2_cleanup',
];

async function runPlugin(source: string, pluginId = 'e2b2-probe') {
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, pluginId);
}

afterEach(() => {
  REGISTERED_NAMES.forEach((name) => MacroRegistry.unregisterMacro(name));
});

describe('E2b-2 macros/macro-system.js 真实现（执行型）', () => {
  it('按真实插件路径导出 macros，四个调用面都是函数，MacroCategory 是 ST 1.18 真枚举', async () => {
    const exports = await runPlugin(`
      import { macros, MacroCategory } from 'macros/macro-system.js';
      module.exports = {
        register: typeof macros.register,
        unregister: typeof macros.unregister,
        registerAlias: typeof macros.registerAlias,
        registryRegisterMacro: typeof macros.registry?.registerMacro,
        registryUnregisterMacro: typeof macros.registry?.unregisterMacro,
        category: MacroCategory.CHAT,
        prompts: MacroCategory.PROMPTS,
        uncategorized: MacroCategory.UNCATEGORIZED,
      };
    `);

    expect(exports.register).toBe('function');
    expect(exports.unregister).toBe('function');
    expect(exports.registerAlias).toBe('function');
    expect(exports.registryRegisterMacro).toBe('function');
    expect(exports.registryUnregisterMacro).toBe('function');
    expect(exports.category).toBe('chat');
    expect(exports.prompts).toBe('prompts');
    expect(exports.uncategorized).toBe('uncategorized');
  });

  it('macros.register(name, { category, handler }) 注册后参与 substituteParamsExtended 求值', async () => {
    await runPlugin(`
      import { macros, MacroCategory } from '../../macros/macro-system.js';
      macros.register('e2b2_hello', {
        category: MacroCategory.CHAT,
        description: 'E2b probe macro',
        handler: () => 'HELLO-E2B',
      });
    `);
    expect(substituteParamsExtended('A{{e2b2_hello}}B')).toBe('AHELLO-E2BB');
  });

  it('macros.registry.registerMacro 同样进入同一张注册表', async () => {
    await runPlugin(`
      import { macros, MacroCategory } from '/scripts/macros/macro-system.js';
      macros.registry.registerMacro('e2b2_registry', {
        category: MacroCategory.PROMPTS,
        handler: () => 'FROM-REGISTRY',
      });
    `);
    expect(substituteParamsExtended('{{e2b2_registry}}')).toBe('FROM-REGISTRY');
  });

  it('registerAlias 让别名指向同一 handler', async () => {
    await runPlugin(`
      import { macros, MacroCategory } from 'macros/macro-system.js';
      macros.register('e2b2_alias_target', {
        category: MacroCategory.MISC,
        handler: () => 'ALIASED',
      });
      macros.registerAlias('e2b2_alias_target', 'e2b2_alias');
    `);
    expect(substituteParamsExtended('{{e2b2_alias_target}}/{{e2b2_alias}}')).toBe('ALIASED/ALIASED');
  });

  it('handler 收到 ST 宏执行上下文（name 正确）', async () => {
    await runPlugin(`
      import { macros, MacroCategory } from 'macros/macro-system.js';
      macros.register('e2b2_ctx', {
        category: MacroCategory.MISC,
        handler: (context) => 'ctx:' + context.name,
      });
    `);
    expect(substituteParamsExtended('{{e2b2_ctx}}')).toBe('ctx:e2b2_ctx');
  });

  it('macros.unregister 后该宏不再被替换（未知宏保持原样）', async () => {
    await runPlugin(`
      import { macros, MacroCategory } from 'macros/macro-system.js';
      macros.register('e2b2_removed', {
        category: MacroCategory.MISC,
        handler: () => 'TEMP',
      });
      macros.unregister('e2b2_removed');
    `);
    expect(substituteParamsExtended('{{e2b2_removed}}')).toBe('{{e2b2_removed}}');
  });

  it('插件卸载（cleanupPlugin）时撤回它注册的宏，重载不残留旧 handler', async () => {
    const sandbox = new PluginSandbox();
    await sandbox.executePluginCode(
      `import { macros, MacroCategory } from 'macros/macro-system.js';
       macros.register('e2b2_cleanup', {
         category: MacroCategory.MISC,
         handler: () => 'CLEAN-ME',
       });`,
      CONTEXT as any,
      'e2b2-cleanup-plugin',
    );
    expect(substituteParamsExtended('{{e2b2_cleanup}}')).toBe('CLEAN-ME');

    sandbox.cleanupPlugin('e2b2-cleanup-plugin');
    expect(substituteParamsExtended('{{e2b2_cleanup}}')).toBe('{{e2b2_cleanup}}');
  });
});
