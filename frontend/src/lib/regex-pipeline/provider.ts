/**
 * Regex Provider - LRU缓存的正则提供器
 * 基于 SillyTavern 的正则缓存机制
 */

import type { RegexProviderConfig } from './types';

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: RegexProviderConfig = {
  cacheSize: 100,
  caseSensitive: true,
  unicode: true,
};

// ============================================================
// RegexProvider 类
// ============================================================

export class RegexProvider {
  private cache: Map<string, RegExp> = new Map();
  private config: RegexProviderConfig;
  private accessOrder: string[] = [];

  constructor(config?: Partial<RegexProviderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 获取编译后的正则表达式（带LRU缓存）
   */
  get(pattern: string, flags?: string): RegExp | null {
    const cacheKey = `${pattern}:::${flags || ''}`;
    
    // 检查缓存
    if (this.cache.has(cacheKey)) {
      this.touchCache(cacheKey);
      return this.cache.get(cacheKey)!;
    }

    try {
      // 编译正则
      const regex = new RegExp(pattern, flags || this.getDefaultFlags());
      
      // 添加到缓存
      this.addToCache(cacheKey, regex);
      
      return regex;
    } catch (error) {
      console.error(`[RegexProvider] Invalid regex pattern: ${pattern}`, error);
      return null;
    }
  }

  /**
   * 获取默认标志
   */
  private getDefaultFlags(): string {
    let flags = 'g';
    if (!this.config.caseSensitive) flags += 'i';
    if (this.config.unicode) flags += 'u';
    return flags;
  }

  /**
   * 触摸缓存（更新访问顺序）
   */
  private touchCache(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * 添加到缓存
   */
  private addToCache(key: string, regex: RegExp): void {
    // 如果缓存已满，移除最久未使用的
    while (this.cache.size >= this.config.cacheSize) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, regex);
    this.accessOrder.push(key);
  }

  /**
   * 清除缓存
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<RegexProviderConfig>): void {
    this.config = { ...this.config, ...config };
    // 配置变更时清除缓存
    this.clear();
  }
}

/**
 * 创建正则提供器实例
 */
export function createRegexProvider(config?: Partial<RegexProviderConfig>): RegexProvider {
  return new RegexProvider(config);
}

// 导出单例
export const regexProvider = new RegexProvider();
