/**
 * 插件存储系统
 * 每个插件独立的键值存储
 */

import type { PluginStorage } from './types';
import { api } from '@/services/api';

/**
 * 本地存储实现
 */
export class LocalPluginStorage implements PluginStorage {
  private data: Record<string, any> = {};
  private pluginName: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pluginName: string) {
    this.pluginName = pluginName;
    this.loadFromLocalStorage();
  }

  /**
   * 从localStorage加载
   */
  private loadFromLocalStorage(): void {
    try {
      const key = `palink_plugin_${this.pluginName}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        this.data = JSON.parse(stored);
      }
    } catch {
      this.data = {};
    }
  }

  /**
   * 保存到localStorage
   */
  private saveToLocalStorage(): void {
    try {
      const key = `palink_plugin_${this.pluginName}`;
      localStorage.setItem(key, JSON.stringify(this.data));
    } catch {
      console.error(`Failed to save plugin storage: ${this.pluginName}`);
    }
  }

  /**
   * 防抖保存
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveToLocalStorage();
    }, 500);
  }

  /**
   * 获取值
   */
  get<T>(key: string, defaultValue?: T): T {
    if (key in this.data) {
      return this.data[key] as T;
    }
    return defaultValue as T;
  }

  /**
   * 设置值
   */
  set<T>(key: string, value: T): void {
    this.data[key] = value;
    this.scheduleSave();
  }

  /**
   * 删除值
   */
  delete(key: string): void {
    delete this.data[key];
    this.scheduleSave();
  }

  /**
   * 清空所有值
   */
  clear(): void {
    this.data = {};
    this.saveToLocalStorage();
  }

  /**
   * 导出数据
   */
  export(): Record<string, any> {
    return { ...this.data };
  }

  /**
   * 导入数据
   */
  import(data: Record<string, any>): void {
    this.data = { ...data };
    this.saveToLocalStorage();
  }
}

/**
 * 存储管理器
 * 管理所有插件的存储实例
 */
export class StorageManager {
  private stores = new Map<string, LocalPluginStorage>();

  /**
   * 获取插件存储
   */
  getStore(pluginName: string): LocalPluginStorage {
    if (!this.stores.has(pluginName)) {
      this.stores.set(pluginName, new LocalPluginStorage(pluginName));
    }
    return this.stores.get(pluginName)!;
  }

  /**
   * 删除插件存储
   */
  deleteStore(pluginName: string): void {
    const store = this.stores.get(pluginName);
    if (store) {
      store.clear();
      this.stores.delete(pluginName);
    }
    // 清理localStorage
    try {
      localStorage.removeItem(`palink_plugin_${pluginName}`);
    } catch {
      // ignore
    }
  }

  /**
   * 导出所有插件数据
   */
  exportAll(): Record<string, Record<string, any>> {
    const result: Record<string, Record<string, any>> = {};
    for (const [name, store] of this.stores.entries()) {
      result[name] = store.export();
    }
    return result;
  }

  /**
   * 导入所有插件数据
   */
  importAll(data: Record<string, Record<string, any>>): void {
    for (const [name, storeData] of Object.entries(data)) {
      const store = this.getStore(name);
      store.import(storeData);
    }
  }
}

// 导出单例
export const storageManager = new StorageManager();
