/**
 * 世界书预算管理器
 * Token预算控制，确保注入内容不超过限制
 */

import type { WorldBookEntry, BudgetConfig, BudgetResult } from './types';

/**
 * 默认预算配置
 */
const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTokens: 16000,
  strategy: 'evenly',
};

/**
 * 预算管理器
 */
export class BudgetManager {
  private config: BudgetConfig;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * 应用预算裁剪
   */
  applyBudget(
    entries: WorldBookEntry[],
    maxTokens?: number,
  ): BudgetResult {
    const budget = maxTokens ?? this.config.maxTokens;
    const totalTokens = this.estimateTokens(entries);

    // 如果没有超过预算，直接返回
    if (totalTokens <= budget) {
      return {
        entries,
        totalTokens,
        truncated: false,
      };
    }

    // 根据策略裁剪
    let selected: WorldBookEntry[];
    switch (this.config.strategy) {
      case 'character_first':
        selected = this.characterFirst(entries, budget);
        break;
      case 'global_first':
        selected = this.globalFirst(entries, budget);
        break;
      case 'evenly':
      default:
        selected = this.evenly(entries, budget);
        break;
    }

    return {
      entries: selected,
      totalTokens: this.estimateTokens(selected),
      truncated: true,
    };
  }

  /**
   * 均匀分配策略
   */
  private evenly(entries: WorldBookEntry[], budget: number): WorldBookEntry[] {
    const result: WorldBookEntry[] = [];
    let remaining = budget;

    // 按优先级排序
    const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const entry of sorted) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        result.push(entry);
        remaining -= tokens;
      }
    }

    return result;
  }

  /**
   * 角色优先策略
   */
  private characterFirst(entries: WorldBookEntry[], budget: number): WorldBookEntry[] {
    // 分离角色相关和全局条目
    const characterEntries = entries.filter(e => 
      e.matchCharacterDescription || 
      e.matchCharacterPersonality || 
      e.matchCharacterDepthPrompt
    );
    const globalEntries = entries.filter(e => 
      !e.matchCharacterDescription && 
      !e.matchCharacterPersonality && 
      !e.matchCharacterDepthPrompt
    );

    const result: WorldBookEntry[] = [];
    let remaining = budget;

    // 先添加角色条目
    for (const entry of characterEntries) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        result.push(entry);
        remaining -= tokens;
      }
    }

    // 再添加全局条目
    for (const entry of globalEntries) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        result.push(entry);
        remaining -= tokens;
      }
    }

    return result;
  }

  /**
   * 全局优先策略
   */
  private globalFirst(entries: WorldBookEntry[], budget: number): WorldBookEntry[] {
    // 分离全局和角色相关条目
    const globalEntries = entries.filter(e => 
      !e.matchCharacterDescription && 
      !e.matchCharacterPersonality && 
      !e.matchCharacterDepthPrompt
    );
    const characterEntries = entries.filter(e => 
      e.matchCharacterDescription || 
      e.matchCharacterPersonality || 
      e.matchCharacterDepthPrompt
    );

    const result: WorldBookEntry[] = [];
    let remaining = budget;

    // 先添加全局条目
    for (const entry of globalEntries) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        result.push(entry);
        remaining -= tokens;
      }
    }

    // 再添加角色条目
    for (const entry of characterEntries) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        result.push(entry);
        remaining -= tokens;
      }
    }

    return result;
  }

  /**
   * 估算单个条目的token数
   */
  private estimateEntryTokens(entry: WorldBookEntry): number {
    const content = entry.content || '';
    const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
    return chineseChars * 2 + englishWords;
  }

  /**
   * 估算多个条目的总token数
   */
  estimateTokens(entries: WorldBookEntry[]): number {
    let total = 0;
    for (const entry of entries) {
      total += this.estimateEntryTokens(entry);
    }
    return total;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }
}

/**
 * 创建预算管理器实例
 */
export function createBudgetManager(config?: Partial<BudgetConfig>): BudgetManager {
  return new BudgetManager(config);
}
