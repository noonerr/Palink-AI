/**
 * Extension Market - 扩展市场系统
 * 基于 SillyTavern 的扩展发现和管理
 */

import { api } from '@/services/api';
import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export interface ExtensionManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  icon?: string;
  screenshots?: string[];
  downloads: number;
  rating: number;
  ratingCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface ExtensionSearchResult {
  extensions: ExtensionManifest[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExtensionSearchOptions {
  query?: string;
  category?: string;
  sortBy?: 'downloads' | 'rating' | 'updated' | 'name';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

// ============================================================
// 辅助函数
// ============================================================

function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ============================================================
// ExtensionMarketManager 类
// ============================================================

export class ExtensionMarketManager {
  private cache: Map<string, ExtensionManifest> = new Map();
  private installedExtensions: Set<string> = new Set();

  /**
   * 搜索扩展
   */
  async search(options: ExtensionSearchOptions = {}): Promise<ExtensionSearchResult> {
    try {
      const queryString = buildQueryString(options);
      const response = await api.get<ExtensionSearchResult>(`/api/extensions/search${queryString}`);
      return response ?? { extensions: [], total: 0, page: 1, pageSize: 20 };
    } catch (error) {
      console.error('[ExtensionMarket] Search failed:', error);
      return { extensions: [], total: 0, page: 1, pageSize: 20 };
    }
  }

  /**
   * 获取扩展详情
   */
  async getExtension(name: string): Promise<ExtensionManifest | null> {
    // 检查缓存
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    try {
      const response = await api.get<ExtensionManifest>(`/api/extensions/${name}`);
      if (response) {
        this.cache.set(name, response);
        return response;
      }
      return null;
    } catch (error) {
      console.error('[ExtensionMarket] Get extension failed:', error);
      return null;
    }
  }

  /**
   * 获取热门扩展
   */
  async getPopular(limit: number = 10): Promise<ExtensionManifest[]> {
    try {
      const response = await api.get<ExtensionManifest[]>(`/api/extensions/popular?limit=${limit}`);
      return response ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Get popular failed:', error);
      return [];
    }
  }

  /**
   * 获取最新扩展
   */
  async getRecent(limit: number = 10): Promise<ExtensionManifest[]> {
    try {
      const response = await api.get<ExtensionManifest[]>(`/api/extensions/recent?limit=${limit}`);
      return response ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Get recent failed:', error);
      return [];
    }
  }

  /**
   * 获取推荐扩展
   */
  async getRecommended(limit: number = 10): Promise<ExtensionManifest[]> {
    try {
      const response = await api.get<ExtensionManifest[]>(`/api/extensions/recommended?limit=${limit}`);
      return response ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Get recommended failed:', error);
      return [];
    }
  }

  /**
   * 安装扩展
   */
  async install(name: string): Promise<boolean> {
    try {
      await api.post(`/api/extensions/${name}/install`);
      this.installedExtensions.add(name);
      emitEvent('extension:installed', { name });
      return true;
    } catch (error) {
      console.error('[ExtensionMarket] Install failed:', error);
      return false;
    }
  }

  /**
   * 卸载扩展
   */
  async uninstall(name: string): Promise<boolean> {
    try {
      await api.delete(`/api/extensions/${name}/uninstall`);
      this.installedExtensions.delete(name);
      emitEvent('extension:uninstalled', { name });
      return true;
    } catch (error) {
      console.error('[ExtensionMarket] Uninstall failed:', error);
      return false;
    }
  }

  /**
   * 更新扩展
   */
  async update(name: string): Promise<boolean> {
    try {
      await api.post(`/api/extensions/${name}/update`);
      emitEvent('extension:updated', { name });
      return true;
    } catch (error) {
      console.error('[ExtensionMarket] Update failed:', error);
      return false;
    }
  }

  /**
   * 检查已安装扩展的更新
   */
  async checkUpdates(): Promise<{ name: string; currentVersion: string; latestVersion: string }[]> {
    try {
      const response = await api.get<{ updates: { name: string; currentVersion: string; latestVersion: string }[] }>(
        '/api/extensions/updates'
      );
      return response?.updates ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Check updates failed:', error);
      return [];
    }
  }

  /**
   * 获取已安装扩展列表
   */
  async getInstalled(): Promise<ExtensionManifest[]> {
    try {
      const response = await api.get<ExtensionManifest[]>('/api/extensions/installed');
      return response ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Get installed failed:', error);
      return [];
    }
  }

  /**
   * 检查扩展是否已安装
   */
  isInstalled(name: string): boolean {
    return this.installedExtensions.has(name);
  }

  /**
   * 获取分类列表
   */
  async getCategories(): Promise<string[]> {
    try {
      const response = await api.get<{ categories: string[] }>('/api/extensions/categories');
      return response?.categories ?? [];
    } catch (error) {
      console.error('[ExtensionMarket] Get categories failed:', error);
      return [];
    }
  }

  /**
   * 评分扩展
   */
  async rate(name: string, rating: number, review?: string): Promise<boolean> {
    try {
      await api.post(`/api/extensions/${name}/rate`, { rating, review });
      emitEvent('extension:rated', { name, rating });
      return true;
    } catch (error) {
      console.error('[ExtensionMarket] Rate failed:', error);
      return false;
    }
  }
}

/**
 * 创建扩展市场管理器实例
 */
export function createExtensionMarketManager(): ExtensionMarketManager {
  return new ExtensionMarketManager();
}

// 导出单例
export const extensionMarketManager = new ExtensionMarketManager();
