/**
 * Palink-AI 宏引擎类型定义
 * 基于 SillyTavern 1.18.0 宏系统
 */

// ============================================================
// 宏分类枚举
// ============================================================

export enum MacroCategory {
  UTILITY = 'utility',
  RANDOM = 'random',
  NAMES = 'names',
  CHARACTER = 'character',
  CHAT = 'chat',
  TIME = 'time',
  VARIABLE = 'variable',
  PROMPTS = 'prompts',
  STATE = 'state',
  MISC = 'misc',
  UNCATEGORIZED = 'uncategorized',
}

// ============================================================
// 值类型枚举
// ============================================================

export enum MacroValueType {
  STRING = 'string',
  INTEGER = 'integer',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
}

// ============================================================
// 宏定义选项（注册时使用）
// ============================================================

export interface MacroUnnamedArgDef {
  name: string;
  optional?: boolean;
  defaultValue?: string;
  type?: MacroValueType | MacroValueType[];
  sampleValue?: string;
  description?: string;
}

export interface MacroListSpec {
  min?: number;
  max?: number;
}

export type MacroHandler = (context: MacroExecutionContext) => string;

export interface MacroDefinitionOptions {
  aliases?: string[];
  category?: MacroCategory | string;
  unnamedArgs?: number | MacroUnnamedArgDef[];
  list?: boolean | MacroListSpec;
  strictArgs?: boolean;
  description?: string;
  returns?: string;
  returnType?: MacroValueType | MacroValueType[];
  displayOverride?: string;
  exampleUsage?: string | string[];
  delayArgResolution?: boolean;
  handler: MacroHandler;
}

// ============================================================
// 宏定义（注册后存储）
// ============================================================

export interface MacroResolvedAlias {
  name: string;
  visible: boolean;
}

export interface MacroDefinition {
  name: string;
  aliases: MacroResolvedAlias[];
  category: string;
  minArgs: number;
  maxArgs: number;
  unnamedArgDefs: MacroUnnamedArgDef[];
  list: { min: number; max: number } | null;
  strictArgs: boolean;
  description: string;
  returns: string | null;
  returnType: MacroValueType | MacroValueType[];
  displayOverride: string | null;
  exampleUsage: string[];
  delayArgResolution: boolean;
  handler: MacroHandler;
  aliasOf: string | null;
  aliasVisible: boolean | null;
}

// ============================================================
// 宏执行上下文
// ============================================================

export interface MacroExecutionContext {
  name: string;
  args: string[];
  unnamedArgs: string[];
  list: string[] | null;
  flags: MacroFlags;
  isScoped: boolean;
  raw: string;
  rawOriginal: string;
  rawArgs: string[];
  env: MacroEnv;
  range: { startOffset: number; endOffset: number };
  globalOffset: number;
  normalize: (value: any) => string;
  trimContent: (content: string, options?: { trimIndent?: boolean }) => string;
  resolve: (text: string, options?: { offsetDelta?: number }) => string;
  warn: (message: string, error?: any) => void;
}

// ============================================================
// 宏标志
// ============================================================

export interface MacroFlags {
  immediate: boolean;
  delayed: boolean;
  reevaluate: boolean;
  filter: boolean;
  closingBlock: boolean;
  preserveWhitespace: boolean;
  raw: string[];
}

// ============================================================
// 宏环境
// ============================================================

export interface MacroEnvNames {
  user: string;
  char: string;
  group: string;
  groupNotMuted: string;
  notChar: string;
}

export interface MacroEnvCharacter {
  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  charPrompt?: string;
  charInstruction?: string;
  mesExamplesRaw?: string;
  charDepthPrompt?: string;
  creatorNotes?: string;
  version?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
}

export interface MacroEnvSystem {
  model: string;
}

export interface MacroEnvFunctions {
  original?: () => string;
  postProcess: (text: string) => string;
}

export type DynamicMacroValue = string | MacroHandler | MacroDefinitionOptions;

export interface MacroEnv {
  content: string;
  contentHash: number;
  names: MacroEnvNames;
  character: MacroEnvCharacter;
  system: MacroEnvSystem;
  functions: MacroEnvFunctions;
  dynamicMacros: Record<string, DynamicMacroValue>;
  extra: Record<string, any>;
}

// ============================================================
// 宏调用（用于传递给注册表执行）
// ============================================================

export interface MacroCall {
  name: string;
  args: string[];
  flags: MacroFlags;
  isScoped: boolean;
  env: MacroEnv;
  rawInner: string;
  rawWithBraces: string;
  rawArgs: string[];
  range: { startOffset: number; endOffset: number };
  globalOffset: number;
}

// ============================================================
// 特殊常量
// ============================================================

/**
 * else分支标记（用于{{if}}宏中标记{{else}}位置）
 */
export const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

/**
 * 宏标识符验证正则
 */
export const MACRO_IDENTIFIER_PATTERN = /^[a-zA-Z][\w\-_]*$/;

/**
 * 变量简写标识符正则
 */
export const MACRO_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;
