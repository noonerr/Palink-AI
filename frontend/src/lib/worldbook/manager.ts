/**
 * 世界书管理器
 * 统一管理世界书的加载、扫描、预算和注入
 */

import type {
  WorldBook,
  WorldBookEntry,
  ScanConfig,
  ScanContext,
  ScanResult,
  BudgetConfig,
  TimedEffectState,
} from './types';
import { WorldBookScanner, createScanner } from './scanner';
import { RecursiveScanner, createRecursiveScanner } from './recursive';
import { BudgetManager, createBudgetManager } from './budget';
import { TimedEffectsManager, createTimedEffectsManager } from './timed-effects';

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
  private scanner: WorldBookScanner;
  private recursiveScanner: RecursiveScanner;
  private budgetManager: BudgetManager;
  private timedEffects: TimedEffectsManager;
  private config: WorldBookManagerConfig;

  // 加载的世界书
  private worldBooks: Map<string, WorldBook> = new Map();

  // 当前激活的世界书ID列表
  private activeWorldBookIds: string[] = [];

  // SubTask 9.1: 扫描缓存（检查消息内容编辑，非仅消息数量）
  private _cachedInjection: string | null = null;
  private _cachedMessages: string[] | null = null;
  private _cachedMessageIndex: number = -1;

  constructor(config?: WorldBookManagerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scanner = createScanner(config?.scan);
    this.recursiveScanner = createRecursiveScanner(config?.scan);
    this.budgetManager = createBudgetManager(config?.budget);
    this.timedEffects = createTimedEffectsManager();
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
   * 扫描并获取世界书上下文
   */
  scanAndBuildContext(
    context: ScanContext,
    currentMessageIndex: number,
  ): string {
    // SubTask 9.1: 检查缓存是否有效（包括消息内容编辑检查）
    if (this._isCacheValid(context, currentMessageIndex)) {
      return this._cachedInjection ?? '';
    }

    // 获取激活的条目
    const entries = this.getActiveEntries();
    if (entries.length === 0) {
      this._setCache('', context, currentMessageIndex);
      return '';
    }

    // 更新时间效果
    if (this.config.enableTimedEffects) {
      this.timedEffects.updateAfterMessage();
    }

    // 过滤时间效果
    let filteredEntries = entries;
    if (this.config.enableTimedEffects) {
      filteredEntries = entries.filter(e =>
        this.timedEffects.canActivate(e, currentMessageIndex)
      );
    }

    // 扫描
    let activated: WorldBookEntry[];
    if (this.config.enableRecursive) {
      activated = this.recursiveScanner.scan(filteredEntries, context);
    } else {
      const result = this.scanner.scan(filteredEntries, context);
      activated = result.entries;
    }

    // 记录激活的时间效果
    if (this.config.enableTimedEffects) {
      for (const entry of activated) {
        this.timedEffects.recordActivation(entry, currentMessageIndex);
      }
    }

    // 应用预算
    const budgetResult = this.budgetManager.applyBudget(activated);

    // 构建注入文本
    const injectionText = this.buildInjectionText(budgetResult.entries);

    // SubTask 9.1: 缓存结果
    this._setCache(injectionText, context, currentMessageIndex);

    // 触发世界书扫描完成事件（ST 兼容 + Palink 事件总线）
    // 通过 window.__PALINK_RUNTIME__ 暴露的 SillyTavernRuntime 实例，
    // 其 emitWorldInfoScanDone 内部会双重 emit ST 与 Palink 事件
    if (typeof window !== 'undefined') {
      const rt = (window as any).__PALINK_RUNTIME__;
      if (rt?.emitWorldInfoScanDone) {
        rt.emitWorldInfoScanDone({ activated: [...activated], total: entries.length });
      }
    }

    return injectionText;
  }

  /**
   * SubTask 9.1: 检查缓存是否有效（包括消息内容编辑检查）
   */
  private _isCacheValid(context: ScanContext, currentMessageIndex: number): boolean {
    if (this._cachedInjection === null || this._cachedMessages === null) {
      return false;
    }

    // 检查消息索引是否变化
    if (this._cachedMessageIndex !== currentMessageIndex) {
      return false;
    }

    // 检查消息数量是否变化
    const currentMessages = context.messages || [];
    if (this._cachedMessages.length !== currentMessages.length) {
      return false;
    }

    // 检查消息内容是否变化（编辑场景）
    for (let i = 0; i < currentMessages.length; i++) {
      const cachedMsg = this._cachedMessages[i];
      const currentMsg = String(currentMessages[i] ?? '');
      if (cachedMsg !== currentMsg) {
        return false;
      }
    }

    return true;
  }

  /**
   * SubTask 9.1: 设置缓存
   */
  private _setCache(injection: string, context: ScanContext, currentMessageIndex: number): void {
    this._cachedInjection = injection;
    this._cachedMessageIndex = currentMessageIndex;
    const currentMessages = context.messages || [];
    this._cachedMessages = currentMessages.map(m => String(m ?? ''));
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
   * 构建注入文本
   */
  private buildInjectionText(entries: WorldBookEntry[]): string {
    if (entries.length === 0) return '';

    const parts: string[] = [];
    for (const entry of entries) {
      if (entry.content) {
        parts.push(entry.content);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 获取扫描结果（用于调试/预览）
   */
  previewScan(
    context: ScanContext,
    currentMessageIndex: number,
  ): ScanResult {
    const entries = this.getActiveEntries();
    if (this.config.enableRecursive) {
      const activated = this.recursiveScanner.scan(entries, context);
      return {
        entries: activated,
        totalTokens: this.budgetManager.estimateTokens(activated),
        matchedKeywords: new Map(),
      };
    }
    return this.scanner.scan(entries, context);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<WorldBookManagerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.scan) {
      this.scanner.updateConfig(config.scan);
    }
    if (config.budget) {
      this.budgetManager.updateConfig(config.budget);
    }
  }

  /**
   * 获取配置
   */
  getConfig(): WorldBookManagerConfig {
    return { ...this.config };
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.recursiveScanner.reset();
    this.timedEffects.reset();
  }

  /**
   * 导出时间效果状态（用于持久化）
   */
  exportTimedEffectsState(): Record<string, TimedEffectState> {
    return this.timedEffects.exportState();
  }

  /**
   * 导入时间效果状态
   */
  importTimedEffectsState(state: Record<string, TimedEffectState>): void {
    this.timedEffects.importState(state);
  }
}

/**
 * 创建世界书管理器实例
 */
export function createWorldBookManager(config?: WorldBookManagerConfig): WorldBookManager {
  return new WorldBookManager(config);
}
