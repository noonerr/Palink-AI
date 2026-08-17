/**
 * 群聊生成调度器
 * 控制群聊中的发言顺序和生成逻辑
 */

import type { GroupChat, GroupMember, GroupChatMessage, SchedulerConfig, SchedulerResult } from './types';
import { GroupActivationStrategy, GroupGenerationMode } from './types';
import type { ActivationStrategy } from './activation';
import { createActivationStrategy } from './activation';
import { emitEvent } from '../event-bus';

/**
 * 默认调度配置
 */
const DEFAULT_CONFIG: SchedulerConfig = {
  strategy: GroupActivationStrategy.NATURAL,
  maxResponses: 1,
  delayBetween: 1000,
  allowSelfResponses: false,
};

/**
 * 群聊生成调度器
 */
export class GroupScheduler {
  private config: SchedulerConfig;
  private strategy: ActivationStrategy;
  private isGenerating = false;
  private currentSpeaker: GroupMember | null = null;
  private currentGroupId: string | null = null;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.strategy = createActivationStrategy(this.config.strategy);
  }

  /**
   * 获取下一个发言者
   */
  getNextSpeaker(
    group: GroupChat,
    messages: GroupChatMessage[],
    lastSpeaker?: GroupMember,
  ): SchedulerResult {
    const activeMembers = group.members.filter(m => !m.isMuted && !m.isDisabled);

    // 检查是否有活跃成员
    if (activeMembers.length === 0) {
      return {
        nextSpeaker: null,
        shouldContinue: false,
        reason: 'No active members',
      };
    }

    // 检查是否允许自己回复自己
    if (!this.config.allowSelfResponses && lastSpeaker) {
      const filteredMembers = activeMembers.filter(m => m.characterId !== lastSpeaker.characterId);
      if (filteredMembers.length === 0) {
        return {
          nextSpeaker: null,
          shouldContinue: false,
          reason: 'No other members available (self-responses disabled)',
        };
      }
    }

    // 选择下一个发言者
    const nextSpeaker = this.strategy.selectSpeaker(activeMembers, messages, lastSpeaker);

    if (!nextSpeaker) {
      return {
        nextSpeaker: null,
        shouldContinue: false,
        reason: 'Strategy returned no speaker',
      };
    }

    return {
      nextSpeaker,
      shouldContinue: true,
      reason: `Selected: ${nextSpeaker.name}`,
    };
  }

  /**
   * 开始生成
   */
  startGeneration(speaker: GroupMember, groupId?: string): void {
    this.isGenerating = true;
    this.currentSpeaker = speaker;
    this.currentGroupId = groupId ?? null;
    emitEvent('group:generationStarted', { groupId: groupId ?? '' });
  }

  /**
   * 结束生成
   */
  endGeneration(): void {
    this.isGenerating = false;
    this.currentSpeaker = null;
    emitEvent('group:generationEnded', { groupId: this.currentGroupId ?? '' });
    this.currentGroupId = null;
  }

  /**
   * 获取当前发言者
   */
  getCurrentSpeaker(): GroupMember | null {
    return this.currentSpeaker;
  }

  /**
   * 是否正在生成
   */
  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.strategy !== undefined) {
      this.strategy = createActivationStrategy(this.config.strategy);
    }
  }

  /**
   * 获取配置
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.isGenerating = false;
    this.currentSpeaker = null;
    if ('reset' in this.strategy) {
      (this.strategy as any).reset();
    }
  }
}

/**
 * 创建调度器实例
 */
export function createGroupScheduler(config?: Partial<SchedulerConfig>): GroupScheduler {
  return new GroupScheduler(config);
}
