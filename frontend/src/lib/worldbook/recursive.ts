/**
 * 世界书递归扫描器
 * 条目触发其他条目的递归扫描逻辑
 */

import type { WorldBookEntry, ScanContext, ScanConfig } from './types';
import { WorldBookScanner } from './scanner';

/**
 * 递归扫描器
 */
export class RecursiveScanner {
  private scanner: WorldBookScanner;
  private maxDepth: number;
  private visited = new Set<string>();

  constructor(config?: Partial<ScanConfig>) {
    this.scanner = new WorldBookScanner(config);
    this.maxDepth = config?.maxRecursionDepth ?? 5;
  }

  /**
   * 递归扫描世界书条目
   */
  scan(
    entries: WorldBookEntry[],
    context: ScanContext,
    depth: number = 0,
  ): WorldBookEntry[] {
    if (depth >= this.maxDepth) {
      return [];
    }

    // 扫描当前层级
    const result = this.scanner.scan(entries, context);
    const activated = result.entries;

    // 收集新激活的条目内容，用于递归扫描
    const newContent = activated
      .filter(e => !e.excludeRecursion)
      .map(e => e.content)
      .join('\n');

    if (!newContent) {
      return activated;
    }

    // 防止重复扫描
    const newEntries = entries.filter(e => {
      if (this.visited.has(e.id)) return false;
      if (e.preventRecursion && depth > 0) return false;
      return true;
    });

    // 标记已访问
    for (const entry of activated) {
      this.visited.add(entry.id);
    }

    // 创建递归上下文
    const recursiveContext: ScanContext = {
      ...context,
      messages: [...context.messages, newContent],
    };

    // 递归扫描
    const recursiveActivated = this.scan(newEntries, recursiveContext, depth + 1);

    // 合并结果（去重）
    const merged = new Map<string, WorldBookEntry>();
    for (const entry of activated) {
      merged.set(entry.id, entry);
    }
    for (const entry of recursiveActivated) {
      if (!merged.has(entry.id)) {
        merged.set(entry.id, entry);
      }
    }

    return Array.from(merged.values());
  }

  /**
   * 重置扫描状态
   */
  reset(): void {
    this.visited.clear();
  }
}

/**
 * 创建递归扫描器实例
 */
export function createRecursiveScanner(config?: Partial<ScanConfig>): RecursiveScanner {
  return new RecursiveScanner(config);
}
