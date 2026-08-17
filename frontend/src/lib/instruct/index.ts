/**
 * Instruct模式模块导出
 */

export { InstructManager, createInstructManager, instructManager } from './manager';
export { formatInstructMessage, formatStoryString, getInstructStopSequences } from './formatter';
export type {
  InstructTemplate,
  InstructSettings,
  FormatOptions,
  FormatResult,
} from './types';
export { NamesBehavior } from './types';
