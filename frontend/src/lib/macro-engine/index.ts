/**
 * 宏系统主入口
 * 基于 SillyTavern 1.18.0 macro-system.js
 */

// 导出类型
export type {
  MacroEnv,
  MacroEnvNames,
  MacroEnvCharacter,
  MacroEnvSystem,
  MacroEnvFunctions,
  MacroExecutionContext,
  MacroDefinition,
  MacroDefinitionOptions,
  MacroFlags,
  MacroCall,
  DynamicMacroValue,
  MacroHandler,
  MacroValueType,
} from './types';

export {
  MacroCategory,
  ELSE_MARKER,
  MACRO_IDENTIFIER_PATTERN,
  MACRO_VARIABLE_SHORTHAND_PATTERN,
} from './types';

// 导出引擎
export { MacroEngine } from './engine/MacroEngine';
export { MacroRegistry } from './engine/MacroRegistry';
export { MacroRuntimeError } from './engine/MacroDiagnostics';

// 导出 Chevrotain 解析器组件
export { MacroLexer, MacroTokens, MacroLexerModes } from './lexer';
export { MacroParser } from './parser';
export type { MacroParseResult } from './parser';
export { MacroCstWalker } from './cst-walker';
export type { EvaluationContext, DocumentItem } from './cst-walker';

// 导出标志工具
export { parseFlags, createEmptyFlags, MacroFlagType } from './engine/MacroFlags';

// 导出宏定义注册函数
export { registerCoreMacros } from './definitions/core-macros';
export { registerEnvMacros } from './definitions/env-macros';
export { registerTimeMacros } from './definitions/time-macros';
export { registerVariableMacros } from './definitions/variable-macros';
export { registerChatMacros } from './definitions/chat-macros';
export { registerStateMacros } from './definitions/state-macros';
export { registerInstructMacros } from './definitions/instruct-macros';

// 导入注册函数
import { MacroEngine } from './engine/MacroEngine';
import { MacroRegistry } from './engine/MacroRegistry';
import { registerCoreMacros } from './definitions/core-macros';
import { registerEnvMacros } from './definitions/env-macros';
import { registerTimeMacros } from './definitions/time-macros';
import { registerVariableMacros } from './definitions/variable-macros';
import { registerChatMacros } from './definitions/chat-macros';
import { registerStateMacros } from './definitions/state-macros';
import { registerInstructMacros } from './definitions/instruct-macros';
import { registerExtraMacros } from './definitions/extra-macros';

/**
 * 初始化并注册所有内置宏
 * 按照 SillyTavern 的注册顺序
 */
export function initRegisterMacros(): void {
  // 1. 核心工具宏
  registerCoreMacros();
  
  // 2. 环境/角色宏
  registerEnvMacros();
  
  // 3. 运行时状态宏
  registerStateMacros();
  
  // 4. 聊天历史宏
  registerChatMacros();
  
  // 5. 时间日期宏
  registerTimeMacros();
  
  // 6. 变量操作宏
  registerVariableMacros();
  
  // 7. 指令模式宏
  registerInstructMacros();
  
  // 8. 补充宏（数学/字符串/比较/逻辑）
  registerExtraMacros();
  
  console.log(`[MacroEngine] Registered ${MacroRegistry.getAllMacros().length} macros`);
}

/**
 * 宏系统统一API入口
 * 兼容 SillyTavern 的 macros 对象
 */
export const macros = {
  engine: MacroEngine,
  registry: MacroRegistry,
  register: MacroRegistry.registerMacro.bind(MacroRegistry),
  registerAlias: MacroRegistry.registerMacroAlias.bind(MacroRegistry),
};

/**
 * 便捷方法：评估宏
 */
export function evaluateMacros(input: string, env?: Partial<import('./types').MacroEnv>): string {
  const defaultEnv: import('./types').MacroEnv = {
    content: input,
    contentHash: 0,
    names: {
      user: 'User',
      char: 'Assistant',
      group: '',
      groupNotMuted: '',
      notChar: 'User',
    },
    character: {},
    system: {
      model: '',
    },
    functions: {
      postProcess: (text: string) => text,
    },
    dynamicMacros: {},
    extra: {},
  };

  const mergedEnv = { ...defaultEnv, ...env };
  return MacroEngine.evaluate(input, mergedEnv);
}
