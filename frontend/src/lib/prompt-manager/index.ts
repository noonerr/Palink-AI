/**
 * Prompt Manager 模块导出
 */

export { PromptManagerClass, createPromptManager, promptManager } from './manager';
export { PromptOrchestrator, createPromptOrchestrator } from './orchestrator';
export type {
  PromptEntry,
  PromptPreset,
  PromptRole,
  PromptManagerConfig,
  OrchestratorConfig,
  OrchestratorResult,
  PromptManagerEvents,
} from './types';
export { InjectionPosition } from './types';
