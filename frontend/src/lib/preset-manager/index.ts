/**
 * Preset Manager 模块入口
 * 基于 SillyTavern preset-manager.js
 */

// 导出类型
export type {
  Preset,
  PresetBackend,
  PresetManagerConfig,
  PresetChangeEvent,
} from './types';

// 导出类
export { PresetManager, createPresetManager } from './manager';
import { createPresetManager } from './manager';

/**
 * React Hook: usePresetManager
 */
export function usePresetManager<T extends Record<string, any>>(storageKey: string) {
  const manager = createPresetManager<T>({ storageKey });
  
  return {
    manager,
    getAll: manager.getAll.bind(manager),
    get: manager.get.bind(manager),
    save: manager.save.bind(manager),
    delete: manager.delete.bind(manager),
    select: manager.select.bind(manager),
    getSelected: manager.getSelected.bind(manager),
    export: manager.export.bind(manager),
    import: manager.import.bind(manager),
  };
}
