# Phase 1: extension_settings 全局共享

## 目标

完全对齐 ST 1.18.0 的全局 `extension_settings` 契约，放弃 Palink 当前的按插件隔离存储，让所有 ST 插件共享同一个 `extension_settings` 对象。

## Why

ST 1.18.0 的 `extension_settings` 是全局共享对象，所有扩展通过 `extension_settings[pluginName]` 读写自己的设置，并通过 `saveSettingsDebounced()` 持久化。跨插件通信（如 connection-manager 的 profile 被 vectors 读取）依赖此全局契约。

当前 Palink 的实现**按插件隔离**：
- sandbox.ts:2384-2403 将 `extension_settings` Proxy 为 `ext_settings_${prop}` 独立存储
- getContext.ts:1599-1615 通过 `runtime.setExtensionSettings` 持久化
- SillyTavernCompatRuntime.ts:4196 用 `window.extension_settings` + localStorage

三处实现不统一，且隔离导致：
- 插件 A 写 `extension_settings.foo = {bar: 1}`，插件 B 读 `extension_settings.foo` 得到 `undefined`
- ST 原生扩展（connection-manager/memory/regex）期望全局共享，隔离后读写与 ST iframe 内的 `window.extension_settings` 不一致
- `_sync_themes_from_extension_settings` 和 `_sync_author_note_from_extension_settings`（silly_tavern.py:147/205）只能同步 ST iframe 传来的全局对象，沙箱内插件修改不触发同步

## What Changes

### 改动点

#### 1. MODIFIED: `frontend/src/lib/plugin-system/sandbox.ts`（行 2384-2403）

**当前实现**（按插件隔离）：
```typescript
const extensionSettings = new Proxy({ disabledExtensions: [] }, {
  get(target, prop) {
    if (prop in target) return target[prop];
    const v = context.storage.get(`ext_settings_${prop}`);
    return v ?? {};
  },
  set(target, prop, value) {
    if (typeof prop === 'string') {
      target[prop] = value;
      context.storage.set(`ext_settings_${prop}`, value);
    }
    return true;
  },
});
```

**改为全局共享**：
```typescript
// ST 1.18.0 契约：extension_settings 是全局共享对象，所有扩展共享
// 通过 ST 兼容运行时的 window.extension_settings 实现
const extensionSettings = getGlobalExtensionSettings();

function getGlobalExtensionSettings(): Record<string, any> {
  // 优先从 ST 兼容运行时取 window.extension_settings
  const stRuntime = (window as any).SillyTavern;
  if (stRuntime?.extension_settings) return stRuntime.extension_settings;
  // 回退：从 localStorage 取持久化数据
  try {
    const stored = localStorage.getItem('__palink_extension_settings');
    if (stored) return JSON.parse(stored);
  } catch {}
  return { disabledExtensions: [] };
}
```

**set 拦截器改为同步到全局 + 触发持久化**：
```typescript
set(target, prop, value) {
  if (typeof prop === 'string') {
    target[prop] = value;
    // 同步到 ST 兼容运行时的 window.extension_settings
    const stRuntime = (window as any).SillyTavern;
    if (stRuntime?.extension_settings) {
      stRuntime.extension_settings[prop] = value;
    }
    // 触发持久化（debounced）
    scheduleExtensionSettingsSave();
  }
  return true;
}
```

#### 2. ADDED: `frontend/src/lib/sillytavern/extension-settings-store.ts`

统一的 extension_settings 全局存储与持久化：

```typescript
const STORAGE_KEY = '__palink_extension_settings';
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 全局 extension_settings 对象（对齐 ST 1.18.0 契约）
 */
export const globalExtensionSettings: Record<string, any> = loadFromStorage();

function loadFromStorage(): Record<string, any> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return { disabledExtensions: [] };
}

/**
 * 持久化到 localStorage + 后端（debounced 500ms，对齐 ST saveSettingsDebounced）
 */
export function saveExtensionSettingsDebounced(delay = 500): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    // 1. 持久化到 localStorage
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(globalExtensionSettings));
    } catch (e) {
      console.error('[extension-settings] localStorage save failed:', e);
    }
    // 2. 同步到后端 /api/settings/save
    fetch('/api/settings/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension_settings: globalExtensionSettings }),
    }).catch((err) => console.warn('[extension-settings] backend sync failed:', err));
  }, delay);
}

/**
 * 获取指定插件的设置（对齐 ST extension_settings[name]）
 */
export function getExtensionSettings(name: string): Record<string, any> {
  return globalExtensionSettings[name] ?? {};
}

/**
 * 写入指定插件的设置
 */
export function setExtensionSettings(name: string, settings: Record<string, any>): void {
  globalExtensionSettings[name] = settings;
  saveExtensionSettingsDebounced();
}

/**
 * 写入单个字段（对齐 ST writeExtensionField）
 */
export function writeExtensionField(name: string, field: string, value: unknown): void {
  if (!globalExtensionSettings[name]) globalExtensionSettings[name] = {};
  globalExtensionSettings[name][field] = value;
  saveExtensionSettingsDebounced();
}
```

#### 3. MODIFIED: `frontend/src/lib/sillytavern/getContext.ts`

**3.1 行 1599 `extensionSettings` 字段**：改为引用 `globalExtensionSettings`

```typescript
extensionSettings: globalExtensionSettings,
```

**3.2 行 1600-1609 `writeExtensionField`**：委托到统一 store

```typescript
writeExtensionField: (name, field, value) => {
  writeExtensionField(name, field, value); // 从 extension-settings-store 导入
},
```

**3.3 行 1610-1615 `getExtensionSettings`**：委托到统一 store

```typescript
getExtensionSettings: (module?) => {
  return module ? getExtensionSettings(module) : globalExtensionSettings;
},
```

**3.4 行 1155-1175 `saveSettingsDebounced`**：改为同步 extension_settings 到后端

```typescript
function saveSettingsDebounced(delay = 500): void {
  saveExtensionSettingsDebounced(delay); // 委托到统一 store
}
```

#### 4. MODIFIED: `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`

**4.1 行 4196 `window.extension_settings` 初始化**：改为引用 `globalExtensionSettings`

```javascript
// 改为：直接使用全局共享对象，不再 mergePlainObjectCompat
ensureObject('extension_settings', globalExtensionSettings);
```

**4.2 行 4500-4506 `persistCompatRuntimeState`**：委托到统一 store

```javascript
const persistCompatRuntimeState = () => {
  saveExtensionSettingsDebounced(0); // 立即持久化（无 debounce）
};
```

#### 5. MODIFIED: `backend/app/api/silly_tavern.py`

**5.1 `/api/settings/save` 端点**：接受 `extension_settings` 字段并持久化

当前 body 为空对象（getContext.ts:1163-1167），后端需自己读 session/db。改为接受前端传入的 `extension_settings` 并写入 settings JSON。

```python
@router.post("/api/settings/save")
async def save_settings(
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    # 接受 extension_settings 字段并持久化
    ext_settings = payload.get("extension_settings")
    if ext_settings is not None:
        # 写入 user_settings.extension_settings
        ...
    return {"result": "ok"}
```

**5.2 `/api/settings/get` 端点**：返回持久化的 `extension_settings`

确保返回的 settings 包含 `extension_settings` 字段。

## 迁移策略

### 旧数据迁移

旧的 `ext_settings_${prop}`（localStorage 中的 `palink_plugin_${name}` 下的字段）需迁移到全局 `extension_settings`：

```typescript
function migrateOldExtSettings(): void {
  const oldKeys = Object.keys(localStorage).filter(k => k.startsWith('palink_plugin_'));
  for (const key of oldKeys) {
    try {
      const pluginData = JSON.parse(localStorage.getItem(key) || '{}');
      Object.keys(pluginData).forEach(prop => {
        if (prop.startsWith('ext_settings_')) {
          const pluginName = prop.slice('ext_settings_'.length);
          if (!globalExtensionSettings[pluginName]) {
            globalExtensionSettings[pluginName] = pluginData[prop];
          }
        }
      });
      // 迁移后删除旧 key（可选，避免重复迁移）
      // localStorage.removeItem(key);
    } catch {}
  }
  saveExtensionSettingsDebounced(0);
}
```

迁移在应用启动时执行一次。

## 验收标准

### 单元测试
- [ ] `frontend/src/lib/sillytavern/__tests__/extension-settings-store.test.ts`
  - test 全局共享：插件 A 写 `extension_settings.foo`，插件 B 读得到
  - test 持久化：写入后 localStorage + 后端都有
  - test debounce：多次写入只触发一次持久化
  - test writeExtensionField 写入单个字段
  - test 旧数据迁移

### 集成测试
- [ ] connection-manager 扩展的 profile 被 vectors 扩展读取到
- [ ] regex 扩展的脚本被 regex-pipeline 读取到
- [ ] memory 扩展的配置在重启后保持

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误

## 风险与注意事项

1. **插件互相污染**：全局共享后，一个插件可以读写另一个插件的设置。这是 ST 原生行为，接受。
2. **并发写入**：多个插件同时写 `extension_settings` 可能并发冲突。debounce 持久化降低冲突，但内存中仍是顺序写入。
3. **后端持久化**：`/api/settings/save` 需正确处理 `extension_settings` 字段，避免覆盖其他 settings。
4. **向后兼容**：旧版本 Palink 的 `ext_settings_${prop}` 数据需迁移，迁移逻辑要幂等。
5. **ST iframe 同步**：ST Native 模式下，`window.extension_settings` 是 iframe 内的对象，需通过 postMessage 同步到父窗口。

## 完成判定

- sandbox.ts 的 `extension_settings` Proxy 指向全局 `globalExtensionSettings`
- getContext.ts 的 `extensionSettings`/`writeExtensionField`/`getExtensionSettings` 委托到统一 store
- SillyTavernCompatRuntime.ts 的 `window.extension_settings` 指向全局 `globalExtensionSettings`
- 后端 `/api/settings/save` 接受并持久化 `extension_settings` 字段
- 跨插件读写测试通过
- 全量回归 0 failure
