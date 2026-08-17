/**
 * 群聊系统类型定义
 * 基于 SillyTavern 1.18.0 group-chats.js
 */

// ============================================================
// 群聊激活策略
// ============================================================

/**
 * 群聊激活策略
 */
export enum GroupActivationStrategy {
  NATURAL = 0,    // AI决定谁说话
  LIST = 1,       // 轮流发言
  MANUAL = 2,     // 用户选择
  POOLED = 3,     // 随机选择
}

/**
 * 群聊生成模式
 */
export enum GroupGenerationMode {
  SWAP = 0,            // 替换模式
  APPEND = 1,          // 追加模式
  APPEND_DISABLED = 2, // 追加但禁用
}

// ============================================================
// 群聊成员
// ============================================================

/**
 * 群组成员 profile（区分各 bot 在群聊中的身份/个性）
 *
 * 字段为可选；未设置时后端会回退到角色卡默认的 description / personality。
 */
export interface GroupMemberProfile {
  description?: string;
  personality?: string;
}

/**
 * 群聊成员
 */
export interface GroupMember {
  characterId: string;
  name: string;
  avatar?: string;
  isMuted: boolean;       // 是否静音（不参与发言）
  isDisabled: boolean;    // 是否禁用
  probability: number;    // 发言概率权重 (0-100)
  position: number;       // 位置（用于LIST策略）
  // 群组 profile：用于在群聊提示词中区分各成员身份（可选）
  profile?: GroupMemberProfile;
}

// ============================================================
// 群聊
// ============================================================

/**
 * 群聊
 */
export interface GroupChat {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  members: GroupMember[];
  
  // 策略设置
  activationStrategy: GroupActivationStrategy;
  generationMode: GroupGenerationMode;
  allowSelfResponses: boolean;     // 是否允许自己回复自己
  enableGroupExpressions: boolean; // 是否启用群组表情

  // 成员 profile 映射（characterId -> profile），用于群聊提示词中区分各 bot 身份
  memberProfiles?: Record<string, GroupMemberProfile>;

  // 元数据
  createdAt: string;
  updatedAt: string;

  // 扩展
  extensions: Record<string, any>;
}

// ============================================================
// 群聊消息
// ============================================================

/**
 * 群聊消息
 */
export interface GroupChatMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  name: string;             // 发言者名称
  characterId?: string;     // 发言者角色ID
  isUser: boolean;
  createdAt: string;
  swipeId?: number;
  swipes?: string[];
  extra?: Record<string, any>;
}

// ============================================================
// 调度配置
// ============================================================

/**
 * 调度配置
 */
export interface SchedulerConfig {
  strategy: GroupActivationStrategy;
  maxResponses: number;      // 单轮最大响应数
  delayBetween: number;      // 响应间延迟(ms)
  allowSelfResponses: boolean;
}

/**
 * 调度结果
 */
export interface SchedulerResult {
  nextSpeaker: GroupMember | null;
  shouldContinue: boolean;
  reason: string;
}

// ============================================================
// 群聊事件
// ============================================================

export interface GroupChatEvents {
  'group:created': { groupId: string };
  'group:updated': { groupId: string };
  'group:deleted': { groupId: string };
  'group:memberAdded': { groupId: string; characterId: string };
  'group:memberRemoved': { groupId: string; characterId: string };
  'group:messageReceived': { groupId: string; message: GroupChatMessage };
  'group:generationStarted': { groupId: string };
  'group:generationEnded': { groupId: string };
}
