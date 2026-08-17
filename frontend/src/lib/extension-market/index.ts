/**
 * Extension Market 模块入口
 * 基于 SillyTavern 的扩展发现和管理
 */

// 导出类型
export type {
  ExtensionManifest,
  ExtensionSearchResult,
  ExtensionSearchOptions,
} from './manager';

// 导出类和实例
export { ExtensionMarketManager, createExtensionMarketManager } from './manager';
import { extensionMarketManager } from './manager';
export { extensionMarketManager };

/**
 * React Hook: useExtensionMarket
 */
export function useExtensionMarket() {
  return {
    manager: extensionMarketManager,
    search: extensionMarketManager.search.bind(extensionMarketManager),
    getExtension: extensionMarketManager.getExtension.bind(extensionMarketManager),
    getPopular: extensionMarketManager.getPopular.bind(extensionMarketManager),
    getRecent: extensionMarketManager.getRecent.bind(extensionMarketManager),
    getRecommended: extensionMarketManager.getRecommended.bind(extensionMarketManager),
    install: extensionMarketManager.install.bind(extensionMarketManager),
    uninstall: extensionMarketManager.uninstall.bind(extensionMarketManager),
    update: extensionMarketManager.update.bind(extensionMarketManager),
    checkUpdates: extensionMarketManager.checkUpdates.bind(extensionMarketManager),
    getInstalled: extensionMarketManager.getInstalled.bind(extensionMarketManager),
    isInstalled: extensionMarketManager.isInstalled.bind(extensionMarketManager),
    getCategories: extensionMarketManager.getCategories.bind(extensionMarketManager),
    rate: extensionMarketManager.rate.bind(extensionMarketManager),
  };
}
