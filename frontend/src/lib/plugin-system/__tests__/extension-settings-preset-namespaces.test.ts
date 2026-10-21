/*
 * 批次E2b-1：extension_settings.regex 必须是脚本数组（2026-10-21）
 *
 * 真机回归（E2 上线后）：`getScriptsByType(...).forEach is not a function`。
 * 根因：批次E2 的 ensureStExtensionSettingsPresets() 把五个预置命名空间**一律**
 * 补成 {}，其中 regex 在 ST 里是正则脚本数组 —— st-plugins/regex/engine.js:108
 * `case SCRIPT_TYPES.GLOBAL: return extension_settings.regex ?? [];`，调用方
 * getRegexScripts() 直接 flatMap、loadRegexScripts 直接 .forEach。
 *
 * 本文件守五件事：
 *   1. 真实 PluginSandbox 执行路径下，四个设置命名空间是 {}、regex 是 []；
 *   2. 已有 regex 数组原样保留（同一引用）；
 *   3. regex 的脏形状（对象/字符串/null）归一为 []，原值不静默丢弃（localStorage 备份可查）；
 *   4. 用**真实 st-plugins/regex/engine.js 的 getScriptsByType 函数源**跑一遍，
 *      返回值可 .forEach；对象形状的反证会抛 TypeError；
 *   5. 宿主常量与帧内 part-01.ts 两份名单逐键、逐类型一致。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/extension-settings-preset-namespaces.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginSandbox } from '../sandbox';
import {
  globalExtensionSettings,
  ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES,
  ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES,
  ST_EXTENSION_SETTINGS_PRESET_NAMESPACES,
  NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY,
} from '../../sillytavern/extension-settings-store';

const FRAME_PART_01 = 'src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts';
const REGEX_ENGINE = 'st-plugins/regex/engine.js';

const OBJECT_PRESET_NAMES = ['quickReply', 'quickReplyV2', 'translate', 'memory'];
const ARRAY_PRESET_NAMES = ['regex'];

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
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, 'e2b-1-probe');
}

beforeEach(() => {
  resetGlobalStore();
  localStorage.clear();
});

describe('E2b-1 宿主沙箱按类型预置 ST 命名空间（执行型）', () => {
  it('四个设置命名空间是普通对象、regex 是数组；regex_presets/disabledExtensions 也是数组', async () => {
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

    for (const name of OBJECT_PRESET_NAMES) {
      expect(exports[name], name + ' 必须是对象').toBeTypeOf('object');
      expect(Array.isArray(exports[name]), name + ' 不该是数组').toBe(false);
      expect(exports[name]).toEqual({});
    }
    for (const name of ARRAY_PRESET_NAMES) {
      expect(Array.isArray(exports[name]), name + ' 必须是数组').toBe(true);
      expect(exports[name]).toEqual([]);
    }
    expect(Array.isArray(exports.regex_presets)).toBe(true);
    expect(exports.regex_presets).toEqual([]);
    expect(Array.isArray(exports.disabledExtensions)).toBe(true);
    expect(exports.disabledExtensions).toEqual([]);
  });

  it('未知键仍然返回 undefined，且读操作不会把它创建出来（ST 1.18.0 语义）', async () => {
    const exports = await runPlugin(`
      module.exports = {
        unknown: extension_settings.__e2b_1_missing_namespace__,
        hasUnknown: Object.prototype.hasOwnProperty.call(extension_settings, '__e2b_1_missing_namespace__'),
        ownKeys: Object.keys(extension_settings),
      };
    `);

    expect(exports.unknown).toBeUndefined();
    expect(exports.hasUnknown).toBe(false);
    expect(exports.ownKeys).not.toContain('__e2b_1_missing_namespace__');
    for (const name of [...OBJECT_PRESET_NAMES, ...ARRAY_PRESET_NAMES]) {
      expect(exports.ownKeys).toContain(name);
    }
  });

  it('已有数据原样保留：regex 数组保持同一引用，设置对象不被覆盖', async () => {
    const regexScripts = [{ id: 'a', findRegex: '/x/g', replaceString: 'y' }];
    const translate = { api: 'kept', nested: { a: 1 } };
    globalExtensionSettings.regex = regexScripts;
    globalExtensionSettings.translate = translate;
    globalExtensionSettings.memory = { keep: true };

    const exports = await runPlugin(`
      module.exports = {
        regex: extension_settings.regex,
        translate: extension_settings.translate,
        memory: extension_settings.memory,
      };
    `);

    expect(exports.regex).toBe(regexScripts);
    expect(exports.translate).toBe(translate);
    expect(exports.memory).toEqual({ keep: true });
  });

  it('regex 脏形状归一为 [] 且原值进备份；对象型命名空间的脏值仍归一为 {}', async () => {
    (globalExtensionSettings as any).translate = 'oops';
    (globalExtensionSettings as any).regex = { zero: 'not-an-array' };
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
    expect(Array.isArray(exports.regex)).toBe(true);
    expect(exports.regex).toEqual([]);
    expect(exports.memory).toEqual({});
    expect(exports.disabledExtensions).toEqual([]);
    expect(exports.regex_presets).toEqual([]);

    // 脏值不静默丢弃：localStorage 备份里能查到原值
    const backup = JSON.parse(localStorage.getItem(NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY) || '{}');
    expect(backup.regex).toMatchObject({ original: { zero: 'not-an-array' }, originalType: 'object' });
    expect(backup.translate).toMatchObject({ original: 'oops', originalType: 'string' });
  });
});

/**
 * 用**真实 st-plugins/regex/engine.js** 的 getScriptsByType 函数源执行。
 * 不做源码字符串断言 —— 断言的是「拿 presets 结果调用 .forEach 会不会抛」。
 */
function makeRealGetScriptsByType(extensionSettings: Record<string, any>) {
  const source = readFileSync(join(process.cwd(), '..', REGEX_ENGINE), 'utf8');
  const start = source.indexOf('export function getScriptsByType(');
  const end = source.indexOf('export async function saveScriptsByType', start);
  expect(start, 'engine.js 里找不到 getScriptsByType').toBeGreaterThan(-1);
  expect(end, 'engine.js 里找不到 getScriptsByType 的结束锚点').toBeGreaterThan(start);
  const body = source.slice(start, end).replace(/^export\s+/, '');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'extension_settings',
    'characters',
    'this_chid',
    'SCRIPT_TYPES',
    'SCRIPT_TYPE_UNKNOWN',
    'getPresetManager',
    'getCurrentPresetAPI',
    'getCurrentPresetName',
    'DEFAULT_GET_REGEX_SCRIPTS_OPTIONS',
    body + '\nreturn getScriptsByType;',
  );
  return factory(
    extensionSettings,
    [],
    0,
    { GLOBAL: 0, PRESET: 2, SCOPED: 1 },
    -1,
    () => ({ readPresetExtensionField: () => [] }),
    () => '',
    () => '',
    Object.freeze({ allowedOnly: false }),
  ) as (type: number) => any;
}

describe('E2b-1 真实 regex engine 的 forEach 回归（执行型）', () => {
  it('未设置 regex 时：预置后 getScriptsByType(GLOBAL) 返回数组，.forEach 不抛', async () => {
    const exports = await runPlugin(`module.exports = { es: extension_settings };`);
    const getScriptsByType = makeRealGetScriptsByType(exports.es);
    const scripts = getScriptsByType(0);
    expect(Array.isArray(scripts)).toBe(true);
    expect(() => scripts.forEach(() => {})).not.toThrow();
  });

  it('regex 是数组时原样返回（同一引用），.forEach 能遍历到每个脚本', async () => {
    const regexScripts = [{ id: 'one' }, { id: 'two' }];
    globalExtensionSettings.regex = regexScripts;
    const exports = await runPlugin(`module.exports = { es: extension_settings };`);
    const getScriptsByType = makeRealGetScriptsByType(exports.es);
    const scripts = getScriptsByType(0);
    expect(scripts).toBe(regexScripts);
    const seen: string[] = [];
    scripts.forEach((script: any) => seen.push(script.id));
    expect(seen).toEqual(['one', 'two']);
  });

  it('反证：同样的真实函数遇到对象形状的 regex ⇒ .forEach 抛 TypeError', () => {
    const getScriptsByType = makeRealGetScriptsByType({ regex: {} });
    expect(() => getScriptsByType(0).forEach(() => {})).toThrow(TypeError);
  });
});

describe('E2b-1 两份名单逐键、逐类型一致（帧内模板串不能 import，只能靠测试防漂）', () => {
  function frameArray(source: string, constName: string): string[] {
    const match = source.match(new RegExp(`const ${constName} = \\[([^\\]]*)\\]`));
    expect(match, `part-01.ts 里找不到 ${constName}`).toBeTruthy();
    return Array.from(String(match![1]).matchAll(/'([^']+)'/g)).map((m) => m[1]);
  }

  it('宿主常量与帧内 part-01.ts 的对象型/数组型名单逐键、逐序相等', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_OBJECT_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES]);
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_ARRAY_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES]);
    expect(OBJECT_PRESET_NAMES).toEqual([...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES]);
    expect(ARRAY_PRESET_NAMES).toEqual([...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES]);
    expect([...ST_EXTENSION_SETTINGS_PRESET_NAMESPACES]).toEqual([
      ...OBJECT_PRESET_NAMES,
      ...ARRAY_PRESET_NAMES,
    ]);
  });

  it('帧内同样把 disabledExtensions / regex_presets 钉成数组（同一份契约的另外两个键）', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    expect(frameSrc).toContain(
      'if (!Array.isArray(window.extension_settings.disabledExtensions)) window.extension_settings.disabledExtensions = [];',
    );
    expect(frameSrc).toContain(
      'if (!Array.isArray(window.extension_settings.regex_presets)) window.extension_settings.regex_presets = [];',
    );
    // 数组型命名空间必须用 [] 补，不许再走 {} 分支
    expect(frameSrc).toContain('window.extension_settings[key] = [];');
    expect(frameSrc).toContain('window.extension_settings[key] = {};');
  });
});
