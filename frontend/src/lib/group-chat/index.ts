/**
 * 群聊系统模块导出
 */

export { GroupChatManager, createGroupChatManager, groupChatManager } from './manager';
export { GroupScheduler, createGroupScheduler } from './scheduler';
export {
  createActivationStrategy,
  NaturalStrategy,
  ListStrategy,
  ManualStrategy,
  PooledStrategy,
} from './activation';
export type { ActivationStrategy } from './activation';
export type {
  GroupChat,
  GroupMember,
  GroupChatMessage,
  SchedulerConfig,
  SchedulerResult,
  GroupChatEvents,
} from './types';
export {
  GroupActivationStrategy,
  GroupGenerationMode,
} from './types';
