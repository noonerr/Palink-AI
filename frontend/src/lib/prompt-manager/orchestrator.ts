/**
 * Prompt Manager 编排器
 * 负责将提示词条目按顺序编排并注入到prompt中
 */

import type {
  PromptEntry,
  OrchestratorConfig,
  OrchestratorResult,
  InjectionPosition,
} from './types';

/**
 * 默认编排配置
 */
const DEFAULT_CONFIG: OrchestratorConfig = {
  maxTokens: 16000,
  strategy: 'order',
  enableScan: true,
};

/**
 * Prompt 编排器
 */
export class PromptOrchestrator {
  private config: OrchestratorConfig;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 编排提示词
   */
  orchestrate(entries: PromptEntry[]): OrchestratorResult {
    // 过滤启用的条目
    const enabled = entries.filter(e => e.enabled);

    // 排序
    const sorted = this.sortEntries(enabled);

    // 应用预算
    const { selected, truncated } = this.applyBudget(sorted);

    // 构建提示词
    const prompts = selected.map(e => e.content);
    const order = selected.map(e => e.identifier);
    const totalTokens = this.estimateTokens(selected);

    return {
      prompts,
      totalTokens,
      truncated,
      order,
    };
  }

  /**
   * 按位置编排
   */
  orchestrateByPosition(
    entries: PromptEntry[],
    position: InjectionPosition,
  ): string[] {
    return entries
      .filter(e => e.enabled && e.position === position)
      .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
      .map(e => e.content);
  }

  /**
   * 排序条目
   */
  private sortEntries(entries: PromptEntry[]): PromptEntry[] {
    switch (this.config.strategy) {
      case 'depth':
        return [...entries].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
      case 'order':
        return [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      case 'mixed':
        // 先按位置分组，再按深度排序
        return [...entries].sort((a, b) => {
          if (a.position !== b.position) return (a.position ?? 0) - (b.position ?? 0);
          return (a.depth ?? 0) - (b.depth ?? 0);
        });
      default:
        return entries;
    }
  }

  /**
   * 应用预算
   */
  private applyBudget(entries: PromptEntry[]): {
    selected: PromptEntry[];
    truncated: boolean;
  } {
    const maxTokens = this.config.maxTokens;
    let remaining = maxTokens;
    const selected: PromptEntry[] = [];

    for (const entry of entries) {
      const tokens = this.estimateEntryTokens(entry);
      if (tokens <= remaining) {
        selected.push(entry);
        remaining -= tokens;
      }
    }

    return {
      selected,
      truncated: selected.length < entries.length,
    };
  }

  /**
   * 估算token数
   */
  private estimateEntryTokens(entry: PromptEntry): number {
    const content = entry.content || '';
    const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
    return chineseChars * 2 + englishWords;
  }

  /**
   * 估算总token数
   */
  estimateTokens(entries: PromptEntry[]): number {
    let total = 0;
    for (const entry of entries) {
      total += this.estimateEntryTokens(entry);
    }
    return total;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }
}

/**
 * 创建编排器实例
 */
export function createPromptOrchestrator(config?: Partial<OrchestratorConfig>): PromptOrchestrator {
  return new PromptOrchestrator(config);
}
