/**
 * extension_settings 全局共享 store（ST 1.18.0 契约对齐）
 *
 * ST 1.18.0 中 extension_settings 是全局共享对象（对应每用户 settings.json 的
 * extension_settings 字段），所有扩展通过 extension_settings[name] 读写自己的
 * 命名空间，且可以读取其他扩展的命名空间（如 vectors 读 connection-manager 的
 * profile）。跨扩展通信依赖此全局契约。
 *
 * Palink 此前 sandbox.ts 按插件隔离存储（localStorage['palink_plugin_${name}']
 * 内的 ext_settings_${ns}），导致插件 A 写入的设置插件 B 读不到 —— 与 ST 语义
 * 不一致。本 store 提供进程内唯一的共享对象 + localStorage 持久化。
 *
 * 持久化键：__palink_extension_settings（与 ST-Native compat runtime 使用的
 * 键名一致；注意 compat runtime 的持久化落在按卡片指纹隔离的 bucket 中，
 * 跨模式同步不在本 store 范围内，见 docs/st-plugin-compat-spec/phase-1）。
 *
 * 后端同步：暂不在此处调用 /api/settings/save —— 该端点会整体覆盖
 * silly_tavern_settings，直接携带 extension_settings 会破坏 ST iframe 的
 * 完整设置。后端持久化在 Phase 3 统一设计。
 */

import { ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS } from './extension-settings-subkey-defaults';

const STORAGE_KEY = '__palink_extension_settings';
const LEGACY_PLUGIN_PREFIX = 'palink_plugin_';
const LEGACY_EXT_PREFIX = 'ext_settings_';
const MIGRATION_FLAG = '__palink_ext_settings_migrated_v1';

/**
 * ST 1.18.0 预置命名空间名单（批次E2，2026-10-21；批次E2b 按类型拆分；
 * 批次D1 2026-10-21 补齐到 ST settings.json 的全部 21 个）。
 *
 * 为什么要有：ST 扩展的 init/loadSettings 直接读 extension_settings.<ns> 的子对象
 * （translate 的 Object.hasOwn(settings, ...)、memory 的 Object.keys(settings)），
 * 不先判空；宿主 extension_settings 里没有这个键时它们拿到 undefined 直接抛
 * TypeError，插件 init 整条死掉（真机：Chat Translation / Memory）。
 *
 * ⚠️ 2026-10-21 批次E2b：E2 把五个命名空间**一律**补成 {}，其中 regex 被补坏 ——
 * ST 的 regex 扩展要求 extension_settings.regex 是**脚本数组**
 * （st-plugins/regex/engine.js:108 `return extension_settings.regex ?? []`，调用方
 * 直接 `.forEach`）。补成对象后真机报 `getScriptsByType(...).forEach is not a function`。
 * 故名单按类型拆分：对象 {}、数组 []、字符串 ''、布尔 false。
 *
 * ⚠️ 2026-10-21 批次D1：名单从 5 个扩到 21 个，键名与类型以 ST 1.18.0
 * `default/content/settings.json` 的 `extension_settings` 为准：
 *   - 对象 15：caption / cfg / chromadb / dice / expressions / memory / note /
 *     objective / quickReply / randomizer / rvc / sd / speech_recognition /
 *     translate / tts
 *   - 数组 3：disabledExtensions / expressionOverrides / regex
 *   - 字符串 2：apiKey / apiUrl
 *   - 布尔 1：autoConnect
 * 嵌套默认值**不搬**：ST 的 memory.prompt / sd.prompts / objective.customPrompts
 * 是提示词正文，按版权边界只给空对象；插件自建嵌套字段时走自己的 loadSettings。
 * ⚠️ 上面这条已被 [API-2 2026-10-24] **部分取代**：命名空间仍给空对象起步，但随后
 * 第 5 步会按 ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS 补子键默认值（值从参照树一手抄，
 * 含 memory.prompt 等提示词正文 —— 来源是本仓已 vendor 的 ST 扩展源码同源文本）。
 * 「不搬」只剩一条残留效力：**名单外**的未知键/未知命名空间仍不预置。
 * quickReplyV2 不在 settings.json 的 21 键里（ST 的 quick-reply 扩展 init 时自建），
 * 本名单不预置它，避免把非 ST 默认态写成契约。
 *
 * ⚠️ 这份名单在帧内还有一份（智能卡 runtime-body/part-01.ts 的
 * applyStPluginRuntimeConfigCompat，模板字符串里不能 import），两处必须逐键、逐类型一致；
 * 守卫测试 extension-settings-preset-namespaces.test.ts 断言两份相等。
 * 新增命名空间时**两边同改**，否则守卫红。
 * 子键默认值不走这条双份路：ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS 已单源到
 * extension-settings-subkey-defaults.ts，帧内构建期经插值下发（见该文件说明）。
 */
export const ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES = [
  'caption',
  'cfg',
  'chromadb',
  'dice',
  'expressions',
  'memory',
  'note',
  'objective',
  'quickReply',
  'randomizer',
  'rvc',
  'sd',
  'speech_recognition',
  'translate',
  'tts',
] as const;

/** 数组型预置命名空间：regex 是正则脚本列表；expressionOverrides 是表达式覆盖列表；
 *  disabledExtensions 是已禁用扩展名列表（regex 插件 init 首行就 includes）。 */
export const ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES = [
  'disabledExtensions',
  'expressionOverrides',
  'regex',
] as const;

/** 字符串型预置命名空间（ST 默认值见 ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS）。 */
export const ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES = ['apiKey', 'apiUrl'] as const;

/** 布尔型预置命名空间。 */
export const ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES = ['autoConnect'] as const;

/** 字符串型命名空间的 ST 1.18.0 默认值（apiUrl = ST Extras 默认地址）。 */
export const ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS: Readonly<Record<string, string>> = {
  apiKey: '',
  apiUrl: 'http://localhost:5100',
};

/**
 * ST 内置扩展命名空间的子键级默认值 —— 常量本体与来源说明在
 * ./extension-settings-subkey-defaults.ts（宿主与帧内模板串插值共用的单源，纯常量零
 * import；帧内经构建期 JSON.stringify 插值下发同一常量）。本文件 re-export 之，
 * 公共 API 与既有测试 import 路径不变。
 */
export { ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS };

/** 旧口径的合并名单（键名，不含类型）。保留给只关心「有哪些预置键」的调用方。 */
export const ST_EXTENSION_SETTINGS_PRESET_NAMESPACES: readonly string[] = [
  ...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES,
];

/**
 * 被归一掉的原值备份键（localStorage）。
 *
 * 为什么选 localStorage 而不是塞回 extension_settings：后者对插件可见，
 * `Object.keys(extension_settings)` 的消费方会看到一条假命名空间；而备份是给排障人看的，
 * 不该参与插件语义。localStorage 与 extension_settings 持久化同一环境，刷新后仍可查。
 */
export const NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY =
  '__palink_extension_settings_normalized_backup';

/** 记录一次「脏形状被归一」：原值落 localStorage，并在 console 明确点名，不静默丢弃。 */
function preserveNormalizedPresetValue(key: string, original: unknown): void {
  try {
    const raw = localStorage.getItem(NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const bucket = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    (bucket as Record<string, unknown>)[key] = {
      original,
      originalType: Array.isArray(original) ? 'array' : typeof original,
      normalizedAt: new Date().toISOString(),
    };
    localStorage.setItem(NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY, JSON.stringify(bucket));
  } catch {
    // localStorage 不可用/写满时仍走下面的 console.warn，保证至少不静默
  }
  try {
    console.warn(
      `[extension-settings-store] extension_settings.${key} 形状不符合 ST 契约，已归一；` +
      `原值备份在 localStorage['${NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY}'].${key}`,
    );
  } catch {
    // ignore
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromStorage(): Record<string, any> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!Array.isArray(parsed.disabledExtensions)) parsed.disabledExtensions = [];
        return parsed;
      }
    }
  } catch {
    // ignore, fall through to default
  }
  return { disabledExtensions: [] };
}

/**
 * 全局 extension_settings 对象 —— 进程内唯一实例。
 * 所有 ST 扩展（sandbox 插件系统加载的）共享此对象。
 */
export const globalExtensionSettings: Record<string, any> = loadFromStorage();

/**
 * 补齐 ST 预置命名空间与两个契约数组（批次E2，2026-10-21；E2b 按类型拆分；
 * 批次D1 补齐到 21 个命名空间）。
 *
 * 只补「缺失 / 类型不符」的键；已有数据原样保留，绝不覆盖。
 * 只写名单内的键 —— 名单外的未知键仍由沙箱 Proxy 返回 undefined（ST 1.18.0 语义）。
 *
 * 类型规则（依次处理四类名单）：
 *   - 对象：caption/cfg/chromadb/dice/expressions/memory/note/objective/quickReply/
 *     randomizer/rvc/sd/speech_recognition/translate/tts → {}
 *   - 数组：disabledExtensions/expressionOverrides/regex → []
 *     （regex 非数组的脏值会备份原值并 console.warn，不静默丢弃）
 *   - 字符串：apiKey/apiUrl → ST 默认值（'' / http://localhost:5100）
 *   - 布尔：autoConnect → false
 *
 * [API-2 2026-10-24] 第 5 步：对 ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS 里的命名空间
 * 补**子键级**默认值（memory 50 键那族）。同样只补缺失键、绝不覆盖已有子键；
 * vectors 命名空间本身不创建（不在 21 键名单里），仅在它已存在（旧数据/插件自建）时补子键。
 * 这一步取代批次D1「嵌套默认值不搬」的旧口径（当时只做命名空间级空容器）——
 * 子键默认值已按 API-2 从参照树一手抄入 SUBKEY_DEFAULTS，来源逐命名空间注明。
 *
 * 调用时机：宿主沙箱 createSandboxGlobal 里 migrateLegacyExtensionSettings() **之后**
 * （先迁移旧隔离存储，再补空壳，否则预置的空对象会把待迁移的同名命名空间挡掉）。
 */
export function ensureStExtensionSettingsPresets(
  target: Record<string, any> = globalExtensionSettings,
): void {
  if (!Array.isArray(target.disabledExtensions)) target.disabledExtensions = [];
  for (const key of ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES) {
    const current = target[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
      target[key] = {};
    }
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES) {
    const current = target[key];
    if (Array.isArray(current)) continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = [];
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES) {
    const current = target[key];
    if (typeof current === 'string') continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS[key] ?? '';
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES) {
    const current = target[key];
    if (typeof current === 'boolean') continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = false;
  }
  // [API-2 2026-10-24] 子键级默认值：只补缺失子键（ST loadSettings 同款补缺语义）。
  // 深拷贝再写入，防止插件改动写穿到模块常量；数组型命名空间不在此表、不受影响。
  for (const [ns, defaults] of Object.entries(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS)) {
    const current = target[ns];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    for (const [subKey, value] of Object.entries(defaults)) {
      if ((current as Record<string, unknown>)[subKey] === undefined) {
        (current as Record<string, unknown>)[subKey] = deepCloneDefaultValue(value);
      }
    }
  }
  if (!Array.isArray(target.regex_presets)) target.regex_presets = [];
}

/** 子键默认值的深拷贝（值域全部 JSON 安全：字符串/数字/布尔/数组/普通对象）。 */
function deepCloneDefaultValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * 持久化到 localStorage（debounced，对齐 ST saveSettingsDebounced 500ms）
 */
export function saveExtensionSettingsDebounced(delay = 500): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(globalExtensionSettings));
    } catch (e) {
      console.error('[extension-settings-store] localStorage save failed:', e);
    }
  }, delay);
}

/**
 * 获取指定扩展命名空间的设置（对齐 ST extension_settings[name] 读取）
 */
export function getExtensionSettingsNs(name: string): Record<string, any> {
  const val = globalExtensionSettings[name];
  return val && typeof val === 'object' ? val : {};
}

/**
 * 整体写入指定扩展命名空间的设置
 */
export function setExtensionSettingsNs(name: string, settings: Record<string, any>): void {
  globalExtensionSettings[name] = settings;
  saveExtensionSettingsDebounced();
}

/**
 * 写入单个字段（对齐 ST writeExtensionField 语义）
 */
export function writeExtensionSettingsField(name: string, field: string, value: unknown): void {
  if (!globalExtensionSettings[name] || typeof globalExtensionSettings[name] !== 'object') {
    globalExtensionSettings[name] = {};
  }
  globalExtensionSettings[name][field] = value;
  saveExtensionSettingsDebounced();
}

/**
 * 旧数据惰性迁移（幂等）：把各插件隔离存储 palink_plugin_${name} 内的
 * ext_settings_${ns} 条目合并进全局对象。仅在全局对象中不存在同名命名空间时
 * 才迁入（不覆盖新数据）；迁移完成后打标记，避免每次启动重复扫描。
 * 不删除旧数据，保证可回滚。
 */
export function migrateLegacyExtensionSettings(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
    let migrated = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PLUGIN_PREFIX)) continue;
      let pluginData: Record<string, any>;
      try {
        pluginData = JSON.parse(localStorage.getItem(key) || '{}');
      } catch {
        continue;
      }
      if (!pluginData || typeof pluginData !== 'object') continue;
      for (const prop of Object.keys(pluginData)) {
        if (!prop.startsWith(LEGACY_EXT_PREFIX)) continue;
        const nsName = prop.slice(LEGACY_EXT_PREFIX.length);
        if (!nsName || nsName in globalExtensionSettings) continue;
        globalExtensionSettings[nsName] = pluginData[prop];
        migrated = true;
      }
    }
    localStorage.setItem(MIGRATION_FLAG, '1');
    if (migrated) saveExtensionSettingsDebounced(0);
  } catch (e) {
    console.warn('[extension-settings-store] legacy migration failed:', e);
  }
}
