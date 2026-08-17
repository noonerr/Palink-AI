/**
 * Regex Pipeline 类型定义
 * 基于 SillyTavern extensions/regex/engine.js
 */

// ============================================================
// 正则脚本定义
// ============================================================

export interface RegexScript {
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: RegexPlacement[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
  id?: string;
}

// ============================================================
// 放置位置枚举
// ============================================================

export enum RegexPlacement {
  ALL = 0,
  USER_INPUT = 1,
  AI_OUTPUT = 2,
  SLASH_COMMAND = 3,
  REASONING = 4,
  AI_INPUT = 7,
  USER_OUTPUT = 8,
  MODEL_SETTINGS = 9,
}

// ============================================================
// 处理选项
// ============================================================

export interface RegexProcessingOptions {
  placement: RegexPlacement;
  depth?: number;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
}

// ============================================================
// 正则提供器配置
// ============================================================

export interface RegexProviderConfig {
  cacheSize: number;
  caseSensitive: boolean;
  unicode: boolean;
}

// ============================================================
// 正则管道配置
// ============================================================

export interface RegexPipelineConfig {
  enableCache: boolean;
  maxCacheSize: number;
  enableLogging: boolean;
}

// ============================================================
// 脚本来源枚举（ST 兼容：GLOBAL → SCOPED → PRESET）
// ============================================================

export enum RegexScriptSource {
  GLOBAL = 0,
  SCOPED = 1,
  PRESET = 2,
}

// ============================================================
// ST 兼容正则脚本（与 sillytavern/regex/engine.ts RegexScript 结构兼容）
// ============================================================

export interface StRegexScript {
  id?: string;
  scriptName?: string;
  findRegex: string;
  replaceString: string;
  trimStrings?: string[];
  placement?: number[];
  markdownOnly?: boolean;
  promptOnly?: boolean;
  minDepth?: number;
  maxDepth?: number;
  substituteRegex?: number;
  disabled?: boolean;
  runOnEdit?: boolean;
  order?: number;
}

// ============================================================
// ST 兼容处理选项
// ============================================================

export interface StRegexProcessingOptions {
  placement: number | number[];
  depth?: number;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
  userName?: string;
  characterName?: string;
  characterOverride?: string;
}

// ============================================================
// 带来源标签的脚本
// ============================================================

export interface SourcedRegexScript {
  script: StRegexScript;
  source: RegexScriptSource;
}
