/**
 * 群聊激活策略
 * 决定谁在群聊中发言
 */

import type { GroupMember, GroupChatMessage } from './types';
import { GroupActivationStrategy } from './types';

/**
 * 激活策略接口
 */
export interface ActivationStrategy {
  /**
   * 选择下一个发言者
   */
  selectSpeaker(
    members: GroupMember[],
    messages: GroupChatMessage[],
    lastSpeaker?: GroupMember,
  ): GroupMember | null;
}

/**
 * 自然模式 - AI决定谁说话
 */
export class NaturalStrategy implements ActivationStrategy {
  selectSpeaker(
    members: GroupMember[],
    _messages: GroupChatMessage[],
    _lastSpeaker?: GroupMember,
  ): GroupMember | null {
    const activeMembers = members.filter(m => !m.isMuted && !m.isDisabled);
    if (activeMembers.length === 0) return null;

    // 按概率权重随机选择
    const totalWeight = activeMembers.reduce((sum, m) => sum + (m.probability ?? 50), 0);
    let random = Math.random() * totalWeight;

    for (const member of activeMembers) {
      random -= member.probability ?? 50;
      if (random <= 0) return member;
    }

    return activeMembers[activeMembers.length - 1];
  }
}

/**
 * 列表模式 - 轮流发言
 */
export class ListStrategy implements ActivationStrategy {
  private currentIndex = 0;

  selectSpeaker(
    members: GroupMember[],
    _messages: GroupChatMessage[],
    _lastSpeaker?: GroupMember,
  ): GroupMember | null {
    const activeMembers = members
      .filter(m => !m.isMuted && !m.isDisabled)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    if (activeMembers.length === 0) return null;

    const speaker = activeMembers[this.currentIndex % activeMembers.length];
    this.currentIndex++;
    return speaker;
  }

  reset(): void {
    this.currentIndex = 0;
  }
}

/**
 * 手动模式 - 用户选择
 */
export class ManualStrategy implements ActivationStrategy {
  private pendingSelection: GroupMember | null = null;

  selectSpeaker(
    _members: GroupMember[],
    _messages: GroupChatMessage[],
    _lastSpeaker?: GroupMember,
  ): GroupMember | null {
    return this.pendingSelection;
  }

  setNextSpeaker(member: GroupMember | null): void {
    this.pendingSelection = member;
  }
}

/**
 * 池模式 - 随机选择（不重复直到所有人说完）
 */
export class PooledStrategy implements ActivationStrategy {
  private pool: GroupMember[] = [];

  selectSpeaker(
    members: GroupMember[],
    _messages: GroupChatMessage[],
    _lastSpeaker?: GroupMember,
  ): GroupMember | null {
    const activeMembers = members.filter(m => !m.isMuted && !m.isDisabled);
    if (activeMembers.length === 0) return null;

    // 如果池为空，重新填充
    if (this.pool.length === 0) {
      this.pool = [...activeMembers];
      // 随机打乱
      for (let i = this.pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
      }
    }

    return this.pool.pop() ?? null;
  }

  reset(): void {
    this.pool = [];
  }
}

/**
 * 创建激活策略
 */
export function createActivationStrategy(strategy: GroupActivationStrategy): ActivationStrategy {
  switch (strategy) {
    case GroupActivationStrategy.NATURAL:
      return new NaturalStrategy();
    case GroupActivationStrategy.LIST:
      return new ListStrategy();
    case GroupActivationStrategy.MANUAL:
      return new ManualStrategy();
    case GroupActivationStrategy.POOLED:
      return new PooledStrategy();
    default:
      return new NaturalStrategy();
  }
}
