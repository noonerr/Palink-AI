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

const STORAGE_KEY = '__palink_extension_settings';
const LEGACY_PLUGIN_PREFIX = 'palink_plugin_';
const LEGACY_EXT_PREFIX = 'ext_settings_';
const MIGRATION_FLAG = '__palink_ext_settings_migrated_v1';

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
