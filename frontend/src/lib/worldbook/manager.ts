/**
 * 世界书管理器
 * 管理世界书的加载/激活/条目读取（数据面）。
 *
 * [ASM-3 后续批次 2026-10-26] 前端第二套自算扫描引擎（scanner/budget/
 * recursive/timed-effects）已删除：世界书扫描/预算/注入的唯一真相源为后端
 * build_worldbook_context（插件面经 POST /api/character-sessions/{sid}/
 * worldbook-scan 同源端点，生成链经 _append_worldbook_context）。
 * 本管理器仅保留插件面 getContext 仍在消费的纯数据面方法。
 */

import type {
  WorldBook,
  WorldBookEntry,
  ScanConfig,
  BudgetConfig,
} from './types';

/**
 * 世界书管理器配置
 */
export interface WorldBookManagerConfig {
  scan?: Partial<ScanConfig>;
  budget?: Partial<BudgetConfig>;
  enableRecursive?: boolean;
  enableTimedEffects?: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: WorldBookManagerConfig = {
  enableRecursive: true,
  enableTimedEffects: true,
};

/**
 * 世界书管理器
 */
export class WorldBookManager {
  private config: WorldBookManagerConfig;

  // 加载的世界书
  private worldBooks: Map<string, WorldBook> = new Map();

  // 当前激活的世界书ID列表
  private activeWorldBookIds: string[] = [];

  // SubTask 9.1: 扫描缓存（历史遗留字段，仅 resetCache 维护；
  // 引擎方法 scanAndBuildContext 已随前端自算引擎删除）
  private _cachedInjection: string | null = null;
  private _cachedMessages: string[] | null = null;
  private _cachedMessageIndex: number = -1;

  constructor(config?: WorldBookManagerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 加载世界书
   */
  loadWorldBook(worldBook: WorldBook): void {
    this.worldBooks.set(worldBook.id, worldBook);
  }

  /**
   * 卸载世界书
   */
  unloadWorldBook(worldBookId: string): void {
    this.worldBooks.delete(worldBookId);
    this.activeWorldBookIds = this.activeWorldBookIds.filter(id => id !== worldBookId);
  }

  /**
   * 设置激活的世界书
   */
  setActiveWorldBooks(ids: string[]): void {
    this.activeWorldBookIds = ids;
  }

  /**
   * 获取所有已加载的世界书
   */
  getWorldBooks(): WorldBook[] {
    return Array.from(this.worldBooks.values());
  }

  /**
   * 获取指定世界书
   */
  getWorldBook(id: string): WorldBook | undefined {
    return this.worldBooks.get(id);
  }

  /**
   * 获取激活的条目
   */
  getActiveEntries(): WorldBookEntry[] {
    const entries: WorldBookEntry[] = [];
    for (const id of this.activeWorldBookIds) {
      const wb = this.worldBooks.get(id);
      if (wb) {
        entries.push(...wb.entries.filter(e => e.enabled !== false));
      }
    }
    return entries;
  }

  /**
   * 重置缓存
   */
  resetCache(): void {
    this._cachedInjection = null;
    this._cachedMessages = null;
    this._cachedMessageIndex = -1;
  }

  /**
   * 获取配置
   */
  getConfig(): WorldBookManagerConfig {
    return { ...this.config };
  }
}

/**
 * 创建世界书管理器实例
 */
export function createWorldBookManager(config?: WorldBookManagerConfig): WorldBookManager {
  return new WorldBookManager(config);
}
