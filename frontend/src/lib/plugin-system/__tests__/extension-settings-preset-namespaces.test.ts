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
  ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES,
  ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES,
  ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS,
  ST_EXTENSION_SETTINGS_PRESET_NAMESPACES,
  ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS,
  NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY,
} from '../../sillytavern/extension-settings-store';

const FRAME_PART_01 = 'src/components/ui/custom/smart-card-runtime/runtime-body/part-01.ts';
const REGEX_ENGINE = 'st-plugins/regex/engine.js';

// ST 1.18.0 default/content/settings.json → extension_settings 的 21 个命名空间，
// 按类型拆分（批次D1 2026-10-21 一手核参照树）。
const OBJECT_PRESET_NAMES = [
  'caption', 'cfg', 'chromadb', 'dice', 'expressions', 'memory', 'note', 'objective',
  'quickReply', 'randomizer', 'rvc', 'sd', 'speech_recognition', 'translate', 'tts',
];
const ARRAY_PRESET_NAMES = ['disabledExtensions', 'expressionOverrides', 'regex'];
const STRING_PRESET_NAMES = ['apiKey', 'apiUrl'];
const BOOLEAN_PRESET_NAMES = ['autoConnect'];
const ALL_PRESET_NAMES = [
  ...OBJECT_PRESET_NAMES,
  ...ARRAY_PRESET_NAMES,
  ...STRING_PRESET_NAMES,
  ...BOOLEAN_PRESET_NAMES,
];

const STRING_DEFAULTS: Record<string, string> = {
  apiKey: '',
  apiUrl: 'http://localhost:5100',
};

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

describe('E2b-1 / D1 宿主沙箱按类型预置 ST 命名空间（执行型）', () => {
  /** 生成一段插件源码：把 21 个命名空间的值和 Object.keys 结果带回宿主。 */
  function snapshotPluginSource(): string {
    const entries = ALL_PRESET_NAMES.map((name) => `${name}: extension_settings.${name}`).join(',\n        ');
    return `
      module.exports = {
        values: {
        ${entries},
        },
        ownKeys: Object.keys(extension_settings),
      };
    `;
  }

  it('21 个命名空间按 ST 类型预置：15 对象 / 3 数组 / 2 字符串 / 1 布尔', async () => {
    const exports = await runPlugin(snapshotPluginSource());

    for (const name of OBJECT_PRESET_NAMES) {
      expect(exports.values[name], name + ' 必须是对象').toBeTypeOf('object');
      expect(Array.isArray(exports.values[name]), name + ' 不该是数组').toBe(false);
      // [API-2 2026-10-24] 对象命名空间不再是裸 {}：带子键默认值的逐键等于
      // ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS（memory 50 键那族）；
      // 名单内无子键默认值的（chromadb/dice）仍为 {}。
      expect(exports.values[name]).toEqual(
        (ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS as Record<string, unknown>)[name] ?? {},
      );
    }
    for (const name of ARRAY_PRESET_NAMES) {
      expect(Array.isArray(exports.values[name]), name + ' 必须是数组').toBe(true);
      expect(exports.values[name]).toEqual([]);
    }
    for (const name of STRING_PRESET_NAMES) {
      expect(typeof exports.values[name], name + ' 必须是字符串').toBe('string');
      expect(exports.values[name]).toBe(STRING_DEFAULTS[name]);
    }
    for (const name of BOOLEAN_PRESET_NAMES) {
      expect(typeof exports.values[name], name + ' 必须是布尔').toBe('boolean');
      expect(exports.values[name]).toBe(false);
    }
  });

  it('真实插件式读取不抛：Object.keys(sd) / note.x / regex.forEach / apiUrl.length / autoConnect', async () => {
    const exports = await runPlugin(`
      var sdKeys = Object.keys(extension_settings.sd);
      var noteX = extension_settings.note.x;
      var regexCount = 0;
      extension_settings.regex.forEach(function () { regexCount += 1; });
      var overrides = extension_settings.expressionOverrides.map(function (item) { return item; });
      var disabled = extension_settings.disabledExtensions.indexOf('regex');
      var apiUrl = extension_settings.apiUrl;
      var autoConnect = extension_settings.autoConnect;
      module.exports = { sdKeys: sdKeys, noteX: noteX, regexCount: regexCount,
        overrides: overrides, disabled: disabled, apiUrl: apiUrl, autoConnect: autoConnect };
    `);

    expect(Array.isArray(exports.sdKeys)).toBe(true);
    // [API-2] sd 命名空间现在带 86 个 ST 默认子键（stable-diffusion/index.js:233 起的并集）
    expect(exports.sdKeys).toEqual(Object.keys(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.sd));
    expect(exports.noteX).toBeUndefined();       // 读不存在的子字段返回 undefined，但不抛
    expect(exports.regexCount).toBe(0);
    expect(exports.overrides).toEqual([]);
    expect(exports.disabled).toBe(-1);
    expect(typeof exports.apiUrl).toBe('string');
    expect(exports.apiUrl.length).toBeGreaterThan(0);
    expect(exports.autoConnect).toBe(false);
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
    for (const name of ALL_PRESET_NAMES) {
      expect(exports.ownKeys).toContain(name);
    }
  });

  it('已有数据原样保留并**合并**子键默认（API-2）：regex 同引用；memory/translate 只补缺不覆盖', async () => {
    const regexScripts = [{ id: 'a', findRegex: '/x/g', replaceString: 'y' }];
    const translate = { api: 'kept', nested: { a: 1 } };
    globalExtensionSettings.regex = regexScripts;
    globalExtensionSettings.translate = translate;
    globalExtensionSettings.memory = { keep: true, source: 'user-set' };

    const exports = await runPlugin(`
      module.exports = {
        regex: extension_settings.regex,
        translate: extension_settings.translate,
        memory: extension_settings.memory,
      };
    `);

    expect(exports.regex).toBe(regexScripts);
    expect(exports.translate).toBe(translate);
    // [API-2] 命名空间整体不覆盖；子键默认只补缺失：已有子键（api/keep/source）原值保留，
    // 缺失子键（translate.deepl_endpoint / memory.memoryFrozen 等）被补上。
    expect(exports.translate).toEqual({ ...ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.translate, api: 'kept', nested: { a: 1 } });
    expect(exports.memory).toEqual({ ...ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.memory, keep: true, source: 'user-set' });
    expect(exports.translate.api).toBe('kept');
    expect(exports.memory.source).toBe('user-set');
  });

  it('regex 脏形状归一为 [] 且原值进备份；对象型命名空间的脏值归一后**补齐子键默认**（不再裸 {}）', async () => {
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

    // [API-2] 脏形状归一成 {} 后继续走第 5 步子键补默认 ⇒ 与 ST 全新安装运行态逐键相等
    expect(exports.translate).toEqual(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.translate);
    expect(Array.isArray(exports.regex)).toBe(true);
    expect(exports.regex).toEqual([]);
    expect(exports.memory).toEqual(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.memory);
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

describe('E2b-1 / D1 宿主与帧内四份名单逐键、逐类型一致（帧内模板串不能 import，只能靠测试防漂）', () => {
  function frameArray(source: string, constName: string): string[] {
    const match = source.match(new RegExp(`const ${constName} = \\[([^\\]]*)\\]`));
    expect(match, `part-01.ts 里找不到 ${constName}`).toBeTruthy();
    return Array.from(String(match![1]).matchAll(/'([^']+)'/g)).map((m) => m[1]);
  }

  it('宿主常量就是 ST 1.18.0 的 21 个命名空间（按类型拆分，无重复）', () => {
    expect([...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES]).toEqual(OBJECT_PRESET_NAMES);
    expect([...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES]).toEqual(ARRAY_PRESET_NAMES);
    expect([...ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES]).toEqual(STRING_PRESET_NAMES);
    expect([...ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES]).toEqual(BOOLEAN_PRESET_NAMES);
    expect([...ST_EXTENSION_SETTINGS_PRESET_NAMESPACES]).toEqual(ALL_PRESET_NAMES);
    expect(new Set(ALL_PRESET_NAMES).size, '21 个键不能有重复').toBe(21);
    expect(ALL_PRESET_NAMES).toHaveLength(21);
    expect(ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS).toEqual(STRING_DEFAULTS);
  });

  it('宿主常量与帧内 part-01.ts 的四份名单逐键、逐序相等', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_OBJECT_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES]);
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_ARRAY_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES]);
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_STRING_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES]);
    expect(frameArray(frameSrc, 'ST_PLUGIN_PRESET_BOOLEAN_NAMESPACES_COMPAT'))
      .toEqual([...ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES]);
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

  it('帧内按类型赋值：字符串给 ST 默认值、布尔给 false（不只是键存在）', () => {
    const frameSrc = readFileSync(join(process.cwd(), FRAME_PART_01), 'utf8');
    expect(frameSrc).toContain(
      "window.extension_settings[key] = key === 'apiUrl' ? 'http://localhost:5100' : '';",
    );
    expect(frameSrc).toContain('window.extension_settings[key] = false;');
    expect(frameSrc).toContain('typeof window.extension_settings[key] === \'string\'');
    expect(frameSrc).toContain('typeof window.extension_settings[key] === \'boolean\'');
  });
});

/*
 * [API-2 2026-10-24] extension_settings 子键级默认值（P2-14 #2 / 差距报告 P-5）。
 *
 * 崩溃族：真实插件（Smart Memory 的 recap.js 一族）假设 ST 内置扩展的默认子键已在场
 * （ST 里 memory 全新安装后 38 键 + loadSettings 补 12 键 = 50 键），
 * 我们此前只给 {} ⇒ `extension_settings.memory.source.length`、
 * `extension_settings.cfg.global.x = y` 这类读/写直接 TypeError。
 *
 * 期望值全部一手抄自 ST 参照树（与 store 常量独立成文，防同源抄写错误互相遮蔽）：
 *   - 源A d:/SillyTavern-release/default/content/settings.json 的 extension_settings 块（:208 起）；
 *   - 源B st-plugins/<name>/index.js（与 _reference/sillytavern-1.18.0 参照树逐字节一致，本测试直接读文件）。
 * 共同键值冲突时源A胜（ST loadSettings 只补缺失键 ⇒ settings.json 值留到运行态）。
 */
describe('API-2 未初始化即深层写键不抛（lastActive 崩溃族）', () => {
  it('插件假设 ST 默认子键在场：嵌套默认对象一步深写 / 标量默认键属性读，全部不抛', async () => {
    const exports = await runPlugin(`
      // (a) 假设嵌套默认对象已存在的一步深写（ST 默认 cfg.global / rvc.voiceMap /
      //     objective.customPrompts.default 都是运行态在场的对象；给裸 {} 时这里直接 TypeError）
      extension_settings.cfg.global.guidance_scale = 2;
      extension_settings.rvc.voiceMap['default'] = 'voice-x';
      extension_settings.objective.customPrompts.default.createTask = 'probe';
      // (b) memory 标量子键的属性读/算术（undefined.length / undefined+1 崩溃族）
      var srcLen = extension_settings.memory.source.length;
      var words = extension_settings.memory.promptWords + 1;
      // (c) recap.js 同款两层守卫写（自建子对象再写 lastActive——原本就不抛，钉住不回归）
      if (!extension_settings.memory.summaryState) extension_settings.memory.summaryState = {};
      extension_settings.memory.summaryState.lastActive = Date.now();
      module.exports = {
        cfgScale: extension_settings.cfg.global.guidance_scale,
        srcLen: srcLen,
        words: words,
        lastActive: extension_settings.memory.summaryState.lastActive,
        rvcVoice: extension_settings.rvc.voiceMap['default'],
        objectiveProbe: extension_settings.objective.customPrompts.default.createTask,
      };
    `);

    expect(exports.cfgScale).toBe(2);
    expect(exports.srcLen).toBe('extras'.length); // ST 默认 source='extras'（settings.json:214 块）
    expect(exports.words).toBe(201);             // ST 默认 promptWords=200
    expect(exports.lastActive).toBeGreaterThan(0);
    expect(exports.rvcVoice).toBe('voice-x');
    expect(exports.objectiveProbe).toBe('probe');
  });

  it('反证读数：裸 {}（未走 ensurePresets）时同一段深写必抛 TypeError（崩溃族真实存在）', () => {
    const bare: Record<string, any> = { cfg: {}, rvc: {}, objective: {}, memory: {} };
    expect(() => { bare.cfg.global.guidance_scale = 2; }).toThrow(TypeError);
    expect(() => { bare.memory.source.length; }).toThrow(TypeError);
  });
});

describe('API-2 子键默认值与 ST 参照逐键相等（memory / translate / tts）', () => {
  // 源A：settings.json extension_settings.memory（:214-253，38 键）
  const SETTINGS_JSON_MEMORY = {
    minLongMemory: 16, maxLongMemory: 1024, longMemoryLength: 128, shortMemoryLength: 512,
    minShortMemory: 128, maxShortMemory: 1024, shortMemoryStep: 16, longMemoryStep: 8,
    repetitionPenaltyStep: 0.05, repetitionPenalty: 1.2, maxRepetitionPenalty: 2, minRepetitionPenalty: 1,
    temperature: 1, minTemperature: 0.1, maxTemperature: 2, temperatureStep: 0.05,
    lengthPenalty: 1, minLengthPenalty: -4, maxLengthPenalty: 4, lengthPenaltyStep: 0.1,
    memoryFrozen: false, source: 'extras',
    prompt: 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.',
    promptWords: 200, promptMinWords: 25, promptMaxWords: 1000, promptWordsStep: 25,
    promptInterval: 10, promptMinInterval: 1, promptMaxInterval: 100, promptIntervalStep: 1,
    template: '[Summary: {{summary}}]', position: 0, depth: 2,
    promptForceWords: 0, promptForceWordsStep: 100, promptMinForceWords: 0, promptMaxForceWords: 10000,
  };
  // 源B：st-plugins/memory/index.js:108-139 defaultSettings 里 settings.json 没有的 12 键
  // （role=extension_prompt_roles.SYSTEM=0、prompt_builder=prompt_builders.DEFAULT=0，script.js:485/:493）
  const MEMORY_INDEX_ONLY = {
    SkipWIAN: false, role: 0, scan: false,
    overrideResponseLength: 0, overrideResponseLengthMin: 0, overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16, maxMessagesPerRequest: 0, maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250, maxMessagesPerRequestStep: 1, prompt_builder: 0,
  };

  it('memory 50 键逐键相等：38 键 settings.json + 12 键 memory/index.js loadSettings', () => {
    const ours = ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.memory as Record<string, unknown>;
    const expected = { ...SETTINGS_JSON_MEMORY, ...MEMORY_INDEX_ONLY };
    expect(Object.keys(ours).length, 'memory 子键数 = 38 + 12').toBe(50);
    expect(ours).toEqual(expected);
  });

  it('translate 5 键逐键相等：settings.json:311-316 的 4 键 + index.js:33-39 补 deepl_endpoint', () => {
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.translate).toEqual({
      target_language: 'en', internal_language: 'en', provider: 'google',
      auto_mode: 'none',            // autoModeOptions.NONE（translate/index.js:23-28）
      deepl_endpoint: 'free',       // index.js-only
    });
  });

  it('tts 11 键逐键相等：settings.json:267-274 的 6 键胜出 + index.js:903-913 补 5 键', () => {
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.tts).toEqual({
      voiceMap: '', ttsEnabled: false,
      currentProvider: 'System',    // ⚠️ settings.json 胜出；index.js defaultSettings 写 'ElevenLabs'，
                                    // 但 ST 全新安装时 loadSettings 只补缺 ⇒ 运行态是 'System'
      auto_generation: true,
      ElevenLabs: {}, System: {},   // settings.json 的空 provider 容器
      narrate_user: false, playback_rate: 1, multi_voice_enabled: false,
      apply_regex: false, regex_pattern: '',   // index.js-only
    });
  });

  it('用真实 st-plugins/memory/index.js 的 defaultSettings 源反向核对（防两处抄写同错）', () => {
    const source = readFileSync(join(process.cwd(), '..', 'st-plugins/memory/index.js'), 'utf8');
    const start = source.indexOf('const defaultSettings = {');
    const end = source.indexOf('};', start) + 2;
    expect(start).toBeGreaterThan(-1);
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'summary_sources', 'extension_prompt_types', 'extension_prompt_roles', 'prompt_builders',
      'defaultPrompt', 'defaultTemplate',
      source.slice(start, end).replace(/^const defaultSettings = /, 'var defaultSettings = ')
        + '\nreturn defaultSettings;',
    );
    const stDefaults = factory(
      { extras: 'extras', main: 'main', webllm: 'webllm' },
      { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
      { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
      { DEFAULT: 0, RAW_BLOCKING: 1, RAW_NON_BLOCKING: 2 },
      SETTINGS_JSON_MEMORY.prompt,      // defaultPrompt（index.js:105）与 settings.json 同文
      '[Summary: {{summary}}]',
    ) as Record<string, unknown>;

    const ours = ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.memory as Record<string, unknown>;
    // index.js 里 settings.json 也有的两个键，值被源A覆盖（ST 运行态）——显式列出，防误判
    const OVERRIDDEN_BY_SETTINGS_JSON = new Set(['promptMinInterval', 'promptMaxInterval']);
    for (const [key, stValue] of Object.entries(stDefaults)) {
      expect(ours[key], 'memory 缺 ST defaultSettings 的键: ' + key).not.toBeUndefined();
      if (OVERRIDDEN_BY_SETTINGS_JSON.has(key)) {
        expect(ours[key], '该键应取 settings.json 值而非 index.js 值: ' + key).not.toBe(stValue);
      } else {
        expect(ours[key], 'memory.' + key + ' 与 ST defaultSettings 不等').toBe(stValue);
      }
    }
  });
});

describe('API-2 其余命名空间的子键默认值抽查（哨兵键 + 结构）', () => {
  it('caption/expressions：settings.json 1 键 + migrateSettings 补齐', () => {
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.caption).toMatchObject({
      refine_mode: false, source: 'extras', multimodal_api: 'openai', multimodal_model: 'gpt-4-turbo',
      prompt: 'What\'s in this image?', show_in_chat: false,   // caption/index.js:19/:26-61
    });
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.caption.template)
      .toBe('[{{user}} sends {{char}} a picture that contains: {{caption}}]');  // index.js:20
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.expressions).toMatchObject({
      showDefault: false, api: 99,           // api=EXPRESSION_API.none（expressions/index.js:81-88）
      allowMultiple: true, promptType: 'raw', // migrateSettings（index.js:2129-2167）
    });
    expect(Object.keys(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.expressions).length).toBe(5);
  });

  it('sd：settings.json 25 键胜出的哨兵值 + index.js 补 61 键的结构', () => {
    const sd = ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.sd as Record<string, unknown>;
    expect(sd.scale_step).toBe(0.5);              // settings.json 值（index.js 写 0.1，被源A覆盖）
    expect(sd.prompt_prefix).toBe('best quality, absurdres, masterpiece,'); // settings.json 值
    expect(sd.source).toBe('extras');             // index.js:233 起补
    expect(sd.scheduler).toBe('normal');
    expect(sd.comfy_url).toBe('http://127.0.0.1:8188');
    expect(Object.keys(sd).length).toBe(86);
    expect(Object.keys(sd.prompts as object).sort()).toEqual(['0', '1', '2', '3', '4', '5', '7']);
    expect(Array.isArray(sd.styles)).toBe(true);
    expect((sd.styles as Array<{ name: string }>)[0]?.name).toBe('Default');
  });

  it('objective/cfg/note/quickReply/randomizer/rvc/speech_recognition：settings.json 原样', () => {
    expect(Object.keys(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.objective.customPrompts as object))
      .toEqual(['default']);
    expect(Object.keys(
      (ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.objective.customPrompts as Record<string, object>).default,
    )).toEqual(['createTask', 'checkTaskCompleted', 'currentTask']);
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.cfg).toEqual({ global: { guidance_scale: 1, negative_prompt: '' }, chara: [] });
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.note).toEqual({ default: '', chara: [], wiAddition: [] });
    expect((ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.quickReply.quickReplySlots as unknown[]).length).toBe(5);
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.randomizer).toEqual({ controls: [], fluctuation: 0.1, enabled: false });
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.rvc).toMatchObject({ pitchExtraction: 'dio', indexRate: 0.88, protect: 0.33, voiceMap: {} });
    expect(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.speech_recognition).toMatchObject({ currentProvider: 'None', messageMode: 'append', messageMapping: [] });
  });

  it('vectors：52 键默认在场，但**不预置命名空间**——只在已存在时补（ST 里也是扩展 init 自建）', async () => {
    expect(Object.keys(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS.vectors as object).length).toBe(52);
    // (1) 全新起步：vectors 不在 21 键名单里，Proxy 返回 undefined（ST 1.18.0 语义）
    const fresh = await runPlugin(`
      module.exports = {
        vectors: extension_settings.vectors,
        has: Object.prototype.hasOwnProperty.call(extension_settings, 'vectors'),
      };
    `);
    expect(fresh.vectors).toBeUndefined();
    expect(fresh.has).toBe(false);

    // (2) 命名空间已存在（旧数据/插件自建 {}）时：52 个默认子键被补上
    globalExtensionSettings.vectors = { keep: 'mine' };
    const filled = await runPlugin(`
      module.exports = {
        keep: extension_settings.vectors.keep,
        source: extension_settings.vectors.source,
        maxEntries: extension_settings.vectors.max_entries,
      };
    `);
    expect(filled.keep).toBe('mine');
    expect(filled.source).toBe('transformers');   // vectors/index.js:58 const settings
    expect(filled.maxEntries).toBe(5);
  });
});
