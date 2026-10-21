/*
 * 批次E2-1：宿主插件沙箱的 extension_settings 必须预置 ST 命名空间（2026-10-21）
 *
 * 真机报错（REPORT_控制台报错九类定性_2026-10-21 §B）：Chat Translation 的
 * `Object.hasOwn(undefined)`、Memory 的 `Object.keys(undefined)` —— 两个扩展的
 * loadSettings 都直接读 extension_settings.<ns> 的子对象，而宿主 Proxy 对未知键
 * 返回 undefined（ST 1.18.0 语义，必须保留），于是 init 直接抛。
 *
 * 帧内 applyStPluginRuntimeConfigCompat（runtime-body/part-01.ts）早已预置同一份名单，
 * 宿主漏修。本文件守三件事：
 *   1. 走**真实 PluginSandbox 执行路径**，断五个命名空间是对象、两个契约键是数组；
 *   2. 未知键仍返回 undefined（不许把 Proxy 改成什么都返回 {} —— 那会让插件的
 *      `if (extension_settings.foo)` 探测全部失真）；
 *   3. 帧内名单与宿主常量逐键一致（两边各写一份，靠本守卫防漂）。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/extension-settings-preset-namespaces.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginSandbox } from '../sandbox';
import {
  globalExtensionSettings,
  ST_EXTENSION_SETTINGS_PRESET_NAMESPACES,
} from '../../sillytavern/extension-settings-store';

const FRAME_PART_01 = 'src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts';

/** 最小 PluginContext：只实现 createSandboxGlobal 与 extension_settings 读取用得到的面。 */
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

/** 清空全局 store，保证每个用例从「什么都没有」起步（Proxy 与它指向同一对象）。 */
function resetGlobalStore(): void {
  for (const key of Object.keys(globalExtensionSettings)) delete globalExtensionSettings[key];
}

/** 把插件源码丢进真实沙箱执行，返回 module.exports。 */
function runPlugin(source: string): Promise<Record<string, any>> {
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, 'e2-1-probe');
}

const PRESET_NAMES = ['quickReply', 'quickReplyV2', 'translate', 'memory', 'regex'];

beforeEach(() => {
  resetGlobalStore();
  localStorage.clear();
});

describe('E2-1 宿主沙箱预置 ST 命名空间（执行型）', () => {
  it('五个命名空间都是普通对象、regex_presets/disabledExtensions 是数组', async () => {
    const exports = await runPlugin(`
      module.exports = {
        quickReply: extension_settings.quickReply,
        quickReplyV2: extension_settings.quickReplyV2,
        translate: extension_settings.translate,
        memory: extension_settings.memory,
        regex: extension_settings.regex,
        regex_presets: extension_settings.regex_presets,
        disabledExtensions: extension_settings.disabledExtensions,
      };
    `);

    for (const name of PRESET_NAMES) {
      expect(exports[name], name + ' 必须是对象').toBeTypeOf('object');
      expect(Array.isArray(exports[name]), name + ' 不该是数组').toBe(false);
      expect(exports[name]).toEqual({});
    }
    expect(Array.isArray(exports.regex_presets)).toBe(true);
    expect(exports.regex_presets).toEqual([]);
    expect(Array.isArray(exports.disabledExtensions)).toBe(true);
    expect(exports.disabledExtensions).toEqual([]);
  });

  it('未知键仍然返回 undefined，且读操作不会把它创建出来（ST 1.18.0 语义）', async () => {
    const exports = await runPlugin(`
      module.exports = {
        unknown: extension_settings.__e2_1_missing_namespace__,
        hasUnknown: Object.prototype.hasOwnProperty.call(extension_settings, '__e2_1_missing_namespace__'),
        ownKeys: Object.keys(extension_settings),
      };
    `);

    expect(exports.unknown).toBeUndefined();
    expect(exports.hasUnknown).toBe(false);
    expect(exports.ownKeys).not.toContain('__e2_1_missing_namespace__');
    // 预置的五个键必须真的在 ownKeys 里（否则 Object.keys(extension_settings) 的消费方看不见）
    for (const name of PRESET_NAMES) expect(exports.ownKeys).toContain(name);
  });

  it('已有数据原样保留，不被空对象覆盖（迁移/持久化语义）', async () => {
    const translate = { api: 'kept', nested: { a: 1 } };
    globalExtensionSettings.translate = translate;
    globalExtensionSettings.memory = { keep: true };

    const exports = await runPlugin(`
      module.exports = {
        translate: extension_settings.translate,
        memory: extension_settings.memory,
      };
    `);

    expect(exports.translate).toBe(translate);
    expect(exports.memory).toEqual({ keep: true });
  });

  it('非对象/数组形状被就地纠正：字符串→{}、null→{}、数组→{}、错误数组→[]', async () => {
    (globalExtensionSettings as any).translate = 'oops';
    (globalExtensionSettings as any).regex = null;
    (globalExtensionSettings as any).memory = ['not-an-object'];
    (globalExtensionSettings as any).disabledExtensions = 'not-an-array';
    (globalExtensionSettings as any).regex_presets = { zero: 'not-an-array' };

    const exports = await runPlugin(`
      module.exports = {
        translate: extension_settings.translate,
        regex: extension_settings.regex,
        memory: extension_settings.memory,
        disabledExtensions: extension_settings.disabledExtensions,
        regex_presets: extension_settings.regex_presets,
      };
    `);

    expect(exports.translate).toEqual({});
    expect(exports.regex).toEqual({});
    expect(exports.memory).toEqual({});
    expect(exports.disabledExtensions).toEqual([]);
    expect(exports.regex_presets).toEqual([]);
  });
});

describe('E2-1 两份名单一致性守卫（帧内模板串不能 import，只能靠测试防漂）', () => {
  it('宿主常量与帧内 part-01.ts 的数组逐键、逐序相等', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    const arrayMatch = frameSrc.match(/\[\s*'quickReply'[\s\S]*?\]/);
    expect(arrayMatch, 'part-01.ts 里找不到预置名单数组').toBeTruthy();
    const frameNames = Array.from(String(arrayMatch![0]).matchAll(/'([^']+)'/g)).map((m) => m[1]);
    expect(frameNames).toEqual([...ST_EXTENSION_SETTINGS_PRESET_NAMESPACES]);
    expect(frameNames).toEqual(PRESET_NAMES);
  });

  it('帧内同样把 disabledExtensions / regex_presets 钉成数组（同一份契约的另外两个键）', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    expect(frameSrc).toContain(
      'if (!Array.isArray(window.extension_settings.disabledExtensions)) window.extension_settings.disabledExtensions = [];',
    );
    expect(frameSrc).toContain(
      'if (!Array.isArray(window.extension_settings.regex_presets)) window.extension_settings.regex_presets = [];',
    );
  });
});
