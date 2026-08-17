/**
 * 插件系统模块导出
 */

export { PluginManager, createPluginManager, pluginManager } from './manager';
export { createPluginContext } from './context';
export { LocalPluginStorage, StorageManager, storageManager } from './storage';
export {
  recordStubHit,
  getCompatStubStats,
  resetCompatStubStats,
  type CompatStubStat,
} from './compat-stub-registry';
export type {
  PluginManifest,
  PluginInstance,
  PluginContext,
  PluginStorage,
  PluginManagerConfig,
  PluginEvents,
  PluginHook,
} from './types';
export { PluginStatus } from './types';
