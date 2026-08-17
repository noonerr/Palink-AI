/**
 * 世界书时间效果管理器
 * 管理 sticky/cooldown/delay 等时间效果
 */

import type { WorldBookEntry, TimedEffectState } from './types';

/**
 * 时间效果管理器
 */
export class TimedEffectsManager {
  private effects = new Map<string, TimedEffectState>();

  /**
   * 检查条目是否可以激活
   */
  canActivate(entry: WorldBookEntry, currentMessageIndex: number): boolean {
    const state = this.effects.get(entry.id);
    if (!state) return true;

    // 检查延迟
    if (state.delayRemaining > 0) return false;

    // 检查冷却
    if (state.cooldownRemaining > 0) return false;

    return true;
  }

  /**
   * 记录条目激活
   */
  recordActivation(entry: WorldBookEntry, currentMessageIndex: number): void {
    const existing = this.effects.get(entry.id);
    const sticky = entry.sticky ?? 0;
    const cooldown = entry.cooldown ?? 0;

    this.effects.set(entry.id, {
      entryId: entry.id,
      stickyRemaining: sticky,
      cooldownRemaining: cooldown,
      delayRemaining: existing?.delayRemaining ?? (entry.delay ?? 0),
      lastActivated: currentMessageIndex,
    });
  }

  /**
   * 更新效果状态（每条新消息后调用）
   */
  updateAfterMessage(): void {
    for (const [id, state] of this.effects.entries()) {
      // 减少延迟
      if (state.delayRemaining > 0) {
        state.delayRemaining--;
      }

      // 减少粘性
      if (state.stickyRemaining > 0) {
        state.stickyRemaining--;
        // 粘性期间不进入冷却
        continue;
      }

      // 减少冷却
      if (state.cooldownRemaining > 0) {
        state.cooldownRemaining--;
      }

      // 清理过期效果
      if (state.stickyRemaining <= 0 && state.cooldownRemaining <= 0 && state.delayRemaining <= 0) {
        this.effects.delete(id);
      }
    }
  }

  /**
   * 检查条目是否处于粘性状态
   */
  isSticky(entryId: string): boolean {
    const state = this.effects.get(entryId);
    return state ? state.stickyRemaining > 0 : false;
  }

  /**
   * 获取效果状态
   */
  getState(entryId: string): TimedEffectState | undefined {
    return this.effects.get(entryId);
  }

  /**
   * 重置所有效果
   */
  reset(): void {
    this.effects.clear();
  }

  /**
   * 重置特定条目的效果
   */
  resetEntry(entryId: string): void {
    this.effects.delete(entryId);
  }

  /**
   * 导出状态（用于持久化）
   */
  exportState(): Record<string, TimedEffectState> {
    const result: Record<string, TimedEffectState> = {};
    for (const [id, state] of this.effects.entries()) {
      result[id] = { ...state };
    }
    return result;
  }

  /**
   * 导入状态
   */
  importState(state: Record<string, TimedEffectState>): void {
    this.effects.clear();
    for (const [id, effect] of Object.entries(state)) {
      this.effects.set(id, { ...effect });
    }
  }
}

/**
 * 创建时间效果管理器实例
 */
export function createTimedEffectsManager(): TimedEffectsManager {
  return new TimedEffectsManager();
}
