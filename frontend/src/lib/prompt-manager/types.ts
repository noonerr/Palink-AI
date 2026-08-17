/**
 * Prompt Manager 类型定义
 * 基于 SillyTavern 1.18.0 prompt-manager
 */

// ============================================================
// 提示词条目
// ============================================================

/**
 * 提示词角色
 */
export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * 注入位置
 */
export enum InjectionPosition {
  BEFORE = 0,    // 主提示词前
  AFTER = 1,     // 主提示词后
  NONE = 2,      // 不注入（仅保留在映射表）
}

/**
 * 提示词条目
 */
export interface PromptEntry {
  identifier: string;          // 唯一标识符
  name: string;                // 显示名称
  content: string;             // 提示词内容
  enabled: boolean;            // 是否启用
  position: InjectionPosition; // 注入位置
  depth: number;               // 注入深度（排序用）
  role: PromptRole;            // 消息角色
  scan?: boolean;              // 是否参与扫描
  system?: boolean;            // 是否系统提示词
  marker?: boolean;            // 是否标记位
  order?: number;              // 排序顺序
}

// ============================================================
// 预设
// ============================================================

/**
 * 提示词预设
 */
export interface PromptPreset {
  id?: string;                 // 后端持久化ID
  name: string;
  entries: PromptEntry[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 编排配置
// ============================================================

/**
 * 编排配置
 */
export interface OrchestratorConfig {
  maxTokens: number;           // 最大token预算
  strategy: 'order' | 'depth' | 'mixed'; // 排序策略
  enableScan: boolean;         // 是否启用扫描
}

/**
 * 编排结果
 */
export interface OrchestratorResult {
  prompts: string[];           // 编排后的提示词列表
  totalTokens: number;         // 总token数
  truncated: boolean;          // 是否被截断
  order: string[];             // 注入顺序（identifier列表）
}

// ============================================================
// Prompt Manager 配置
// ============================================================

/**
 * Prompt Manager 配置
 */
export interface PromptManagerConfig {
  maxEntries: number;
  defaultPosition: InjectionPosition;
  defaultRole: PromptRole;
  autoSave: boolean;
}

// ============================================================
// 事件
// ============================================================

export interface PromptManagerEvents {
  'prompt:added': { identifier: string };
  'prompt:updated': { identifier: string };
  'prompt:removed': { identifier: string };
  'preset:loaded': { name: string };
  'preset:saved': { name: string };
}
