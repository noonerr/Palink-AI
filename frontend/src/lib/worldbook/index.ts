/**
 * 世界书模块导出
 */

export { WorldBookScanner, createScanner } from './scanner';
export { RecursiveScanner, createRecursiveScanner } from './recursive';
export { BudgetManager, createBudgetManager } from './budget';
export { TimedEffectsManager, createTimedEffectsManager } from './timed-effects';
export { WorldBookManager, createWorldBookManager, type WorldBookManagerConfig } from './manager';
export type {
  WorldBook,
  WorldBookEntry,
  ScanConfig,
  ScanContext,
  ScanResult,
  BudgetConfig,
  BudgetResult,
  TimedEffectState,
  WorldInfoLogic,
  WorldInfoPosition,
  ScanState,
} from './types';
