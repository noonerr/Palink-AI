/**
 * SillyTavern 宏系统入口
 *
 * 所有宏处理统一走 macro-engine/，通过桥接层保持向后兼容
 */

// 从桥接层导出所有API
export {
  substituteParams,
  substituteParamsExtended,
  registerMacro,
  getMacroEngine,
  getMacroRegistry,
  evaluateMacros,
  MacroEngine,
  MacroRegistry,
  type MacroEnv,
  type MacroEnv as NewMacroEnv,
} from './bridge';
