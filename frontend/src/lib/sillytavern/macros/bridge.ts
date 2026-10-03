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
  /** 角色卡字段：{{charDescription}} / {{charPersonality}} / {{charScenario}} 等宏的取值来源。
   *  此前此接口没有这一项，而 convertToNewEnv 也从不产出 `character`，
   *  导致 env-macros.ts 的处理器读 `ctx.env.character.description` 时拿到 undefined
   *  → 63 个宏（含卡内最常用的三个）全部展开成空串，且不报错。 */
  character?: {
    description?: string;
    personality?: string;
    scenario?: string;
    persona?: string;
    charPrompt?: string;
    charInstruction?: string;
    mesExamplesRaw?: string;
    charDepthPrompt?: string;
    firstMessage?: string;
    alternateGreetings?: string[];
    creatorNotes?: string;
    version?: string;
  };
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
    // 缺这一整块会让所有 env.* 系列宏拿到 undefined（表现为展开成空串）。
    // 不设可选子字段，让处理器各自的 `?? ''` 兜底生效。
    character: {
      description: env.character?.description ?? '',
      personality: env.character?.personality ?? '',
      scenario: env.character?.scenario ?? '',
      persona: env.character?.persona ?? '',
      charPrompt: env.character?.charPrompt ?? '',
      charInstruction: env.character?.charInstruction ?? '',
      mesExamplesRaw: env.character?.mesExamplesRaw ?? '',
      charDepthPrompt: env.character?.charDepthPrompt ?? '',
      firstMessage: env.character?.firstMessage ?? '',
      alternateGreetings: env.character?.alternateGreetings ?? [],
      creatorNotes: env.character?.creatorNotes ?? '',
      version: env.character?.version ?? '',
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
