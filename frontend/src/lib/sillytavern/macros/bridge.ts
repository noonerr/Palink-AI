/**
 * 宏系统桥接层
 * 将新的宏引擎与现有的substituteParams集成
 */

import { 
  initRegisterMacros, 
  evaluateMacros, 
  MacroEngine,
  MacroRegistry,
  type MacroEnv as NewMacroEnv 
} from '../../macro-engine';

// 初始化新的宏引擎
let initialized = false;

function ensureInitialized(): void {
  if (!initialized) {
    initRegisterMacros();
    initialized = true;
  }
}

// 旧的MacroEnv接口（向后兼容）
export interface MacroEnv {
  userName?: string;
  characterName?: string;
  charName?: string;
  modelName?: string;
  dynamicMacros?: Record<string, string | (() => string)>;
  postProcessFn?: (text: string) => string;
}

/**
 * 将旧的MacroEnv转换为新的MacroEnv
 */
function convertToNewEnv(env?: MacroEnv): Partial<NewMacroEnv> {
  if (!env) return {};
  
  return {
    names: {
      user: env.userName || 'User',
      char: env.characterName || env.charName || 'Character',
      group: '',
      groupNotMuted: '',
      notChar: env.userName || 'User',
    },
    system: {
      model: env.modelName || '',
    },
    dynamicMacros: env.dynamicMacros || {},
    functions: {
      postProcess: env.postProcessFn || ((text: string) => text),
    },
  };
}

/**
 * 替换参数（兼容旧接口）
 * 使用新的宏引擎
 */
export function substituteParams(text: string, env?: MacroEnv): string {
  ensureInitialized();
  
  const newEnv = convertToNewEnv(env);
  return evaluateMacros(text, newEnv);
}

/**
 * 扩展参数替换（兼容旧接口）
 * 使用新的宏引擎
 */
export function substituteParamsExtended(
  text: string,
  env?: MacroEnv,
  sanitizeFn?: (text: string) => string,
): string {
  ensureInitialized();
  
  const newEnv = convertToNewEnv(env);
  let result = evaluateMacros(text, newEnv);
  
  if (sanitizeFn) {
    result = sanitizeFn(result);
  }
  
  return result;
}

/**
 * 直接访问新的宏引擎
 */
export function getMacroEngine() {
  ensureInitialized();
  return MacroEngine;
}

/**
 * 直接访问宏注册表
 */
export function getMacroRegistry() {
  ensureInitialized();
  return MacroRegistry;
}

/**
 * 注册自定义宏
 */
export function registerMacro(name: string, options: Parameters<typeof MacroRegistry.registerMacro>[1]) {
  ensureInitialized();
  return MacroRegistry.registerMacro(name, options);
}

// 重新导出新的宏引擎API
export { evaluateMacros, MacroEngine, MacroRegistry } from '../../macro-engine';
export type { MacroEnv as NewMacroEnv } from '../../macro-engine';
