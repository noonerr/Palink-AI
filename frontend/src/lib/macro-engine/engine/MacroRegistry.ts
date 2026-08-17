/**
 * 宏注册表
 * 基于 SillyTavern 1.18.0 MacroRegistry
 */

import type {
  MacroDefinition,
  MacroDefinitionOptions,
  MacroExecutionContext,
  MacroHandler,
  MacroCall,
  MacroEnv,
  MacroFlags,
  MacroResolvedAlias,
  MacroUnnamedArgDef,
  DynamicMacroValue,
} from '../types';

import {
  MacroCategory,
  MacroValueType,
  MACRO_IDENTIFIER_PATTERN,
} from '../types';

import {
  logMacroRegisterWarning,
  logMacroRegisterError,
  logMacroRuntimeWarning,
  logMacroInternalError,
} from './MacroDiagnostics';

import { parseFlags } from './MacroFlags';
import { MacroParser } from '../parser';

// ============================================================
// MacroRegistry 单例
// ============================================================

class MacroRegistryClass {
  private macros = new Map<string, MacroDefinition>();

  /**
   * 注册宏
   */
  registerMacro(name: string, options: MacroDefinitionOptions): MacroDefinition | null {
    // 验证标识符合法性
    if (!MACRO_IDENTIFIER_PATTERN.test(name)) {
      logMacroRegisterError({ macroName: name, message: `Invalid macro name: '${name}'. Must match ${MACRO_IDENTIFIER_PATTERN}` });
      return null;
    }

    // 验证 handler
    if (typeof options.handler !== 'function') {
      logMacroRegisterError({ macroName: name, message: 'handler must be a function' });
      return null;
    }

    // 构建完整定义
    const def = this.buildMacroDefFromOptions(name, options);
    if (!def) return null;

    // 注册主宏
    this.macros.set(name.toLowerCase(), def);

    // 注册别名
    if (options.aliases) {
      for (const alias of options.aliases) {
        if (MACRO_IDENTIFIER_PATTERN.test(alias)) {
          this.macros.set(alias.toLowerCase(), {
            ...def,
            name: alias,
            aliasOf: name,
            aliasVisible: true,
          });
        }
      }
    }

    return def;
  }

  /**
   * 为已有宏注册别名
   */
  registerMacroAlias(targetName: string, aliasName: string, options?: { visible?: boolean }): boolean {
    const target = this.getMacro(targetName);
    if (!target) {
      logMacroRegisterWarning({ macroName: aliasName, message: `Target macro '${targetName}' not found` });
      return false;
    }

    if (!MACRO_IDENTIFIER_PATTERN.test(aliasName)) {
      logMacroRegisterWarning({ macroName: aliasName, message: `Invalid alias name: '${aliasName}'` });
      return false;
    }

    this.macros.set(aliasName.toLowerCase(), {
      ...target,
      name: aliasName,
      aliasOf: targetName,
      aliasVisible: options?.visible ?? true,
    });

    return true;
  }

  /**
   * 移除宏
   */
  unregisterMacro(name: string): boolean {
    return this.macros.delete(name.toLowerCase());
  }

  /**
   * 检查宏是否存在
   */
  hasMacro(name: string): boolean {
    return this.macros.has(name.toLowerCase());
  }

  /**
   * 获取宏定义
   */
  getMacro(name: string): MacroDefinition | undefined {
    return this.macros.get(name.toLowerCase());
  }

  /**
   * 获取主定义（如果name是别名则追踪到主定义）
   */
  getPrimaryMacro(name: string): MacroDefinition | undefined {
    const def = this.getMacro(name);
    if (!def) return undefined;
    if (def.aliasOf) {
      return this.getMacro(def.aliasOf) ?? def;
    }
    return def;
  }

  /**
   * 获取所有宏
   */
  getAllMacros(options?: { excludeAliases?: boolean }): MacroDefinition[] {
    const result: MacroDefinition[] = [];
    const seen = new Set<string>();

    for (const def of this.macros.values()) {
      if (options?.excludeAliases && def.aliasOf) continue;
      const key = def.aliasOf ?? def.name;
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      result.push(def);
    }

    return result;
  }

  /**
   * 执行宏
   */
  executeMacro(call: MacroCall, options?: { defOverride?: MacroDefinition; depth?: number; stack?: string[] }): string {
    const depth = options?.depth ?? 0;
    const stack = options?.stack ?? [];

    // 内层优先解析（inner-first）：先递归解析 rawInner 中的嵌套宏，
    // 再重新解析得到扁平化的 name/args。
    const resolvedCall = this.resolveCallInner(call, depth, stack);
    if (!resolvedCall) {
      // 内层无法完全解析（仍含未解析的 {{...}}），保留原样
      return call.rawWithBraces;
    }

    const def = options?.defOverride ?? this.getMacro(resolvedCall.name);
    if (!def) {
      return call.rawWithBraces;
    }

    // 参数数量验证
    if (def.strictArgs) {
      if (resolvedCall.args.length < def.minArgs) {
        logMacroRuntimeWarning({
          macroName: resolvedCall.name,
          message: `Expected at least ${def.minArgs} args, got ${resolvedCall.args.length}`,
        });
        return call.rawWithBraces;
      }
      if (def.maxArgs >= 0 && resolvedCall.args.length > def.maxArgs) {
        logMacroRuntimeWarning({
          macroName: resolvedCall.name,
          message: `Expected at most ${def.maxArgs} args, got ${resolvedCall.args.length}`,
        });
      }
    }

    // 分离 unnamedArgs 和 list
    let unnamedArgs: string[];
    let list: string[] | null;

    if (def.list) {
      const minList = def.list.min ?? 0;
      if (def.maxArgs >= 0) {
        unnamedArgs = resolvedCall.args.slice(0, def.maxArgs);
        list = resolvedCall.args.slice(def.maxArgs);
      } else {
        unnamedArgs = [];
        list = resolvedCall.args;
      }
      if (list.length < minList) {
        logMacroRuntimeWarning({
          macroName: resolvedCall.name,
          message: `Expected at least ${minList} list items, got ${list.length}`,
        });
      }
    } else {
      unnamedArgs = resolvedCall.args;
      list = null;
    }

    // 构建执行上下文
    const context: MacroExecutionContext = {
      name: resolvedCall.name,
      args: resolvedCall.args,
      unnamedArgs,
      list,
      flags: resolvedCall.flags,
      isScoped: resolvedCall.isScoped,
      raw: resolvedCall.rawInner,
      rawOriginal: resolvedCall.rawWithBraces,
      rawArgs: resolvedCall.rawArgs,
      env: resolvedCall.env,
      range: resolvedCall.range,
      globalOffset: resolvedCall.globalOffset,
      normalize: (value: any) => this.normalizeMacroResult(value),
      trimContent: (content: string, options?: { trimIndent?: boolean }) => this.trimScopedContent(content, options),
      // 递归解析+求值文本中的宏（支持嵌套）
      resolve: (text: string) => this.substitute(text, depth + 1, resolvedCall.env, [...stack, resolvedCall.rawWithBraces]),
      warn: (message: string, error?: any) => {
        logMacroRuntimeWarning({ macroName: resolvedCall.name, message, error });
      },
    };

    try {
      const result = def.handler(context);
      return this.normalizeMacroResult(result);
    } catch (error) {
      if (error instanceof Error && error.name === 'MacroRuntimeError') {
        logMacroRuntimeWarning({ macroName: resolvedCall.name, message: error.message });
        return call.rawWithBraces;
      }
      logMacroInternalError({ macroName: resolvedCall.name, message: String(error), error });
      return call.rawWithBraces;
    }
  }

  /**
   * 解析宏内层的嵌套宏（inner-first）。
   * - 若 rawInner 不含 {{，直接返回原 call（非嵌套宏，保持原有行为）。
   * - 否则递归调用 substitute 解析内层，再重新解析得到扁平化的 name/args。
   * - 若内层仍含未解析的 {{（如未知宏），返回 null，由调用方保留原样。
   */
  private resolveCallInner(call: MacroCall, depth: number, stack: string[]): MacroCall | null {
    if (!call.rawInner.includes('{{')) {
      return call;
    }

    const newStack = [...stack, call.rawWithBraces];
    const resolvedInner = this.substitute(call.rawInner, depth + 1, call.env, newStack);

    // 内层仍有未解析的宏，无法安全执行
    if (resolvedInner.includes('{{')) {
      return null;
    }

    // 重新解析 {{resolvedInner}} 以获得扁平的 name/args
    const reparsed = MacroParser.instance.parseDocument(`{{${resolvedInner}}}`);
    const reparsedMacro = reparsed.cst?.find((it) => it.type === 'macro')?.macro;
    if (!reparsedMacro) {
      return null;
    }

    return {
      name: reparsedMacro.name,
      args: reparsedMacro.args,
      flags: reparsedMacro.flags,
      isScoped: reparsedMacro.isScoped,
      env: call.env,
      rawInner: resolvedInner,
      rawWithBraces: call.rawWithBraces,
      rawArgs: reparsedMacro.rawArgs,
      range: call.range,
      globalOffset: call.globalOffset,
    };
  }

  /**
   * 递归解析+求值文本中的宏。
   * 用 parser 解析 text → 对每个宏调用 executeMacro → 将结果替换回 text；
   * 若替换后仍含 {{ 且未超过最大递归深度（20），继续递归。
   *
   * @param text 待解析的文本
   * @param depth 当前递归深度
   * @param env 宏环境
   * @param stack 已处理宏调用栈（用于循环检测，存放 rawWithBraces）
   */
  substitute(text: string, depth: number, env: MacroEnv, stack: string[] = []): string {
    if (depth > 20) {
      logMacroRuntimeWarning({
        message: `Max recursion depth (20) exceeded in macro substitution; returning text as-is`,
      });
      return text;
    }

    const parseResult = MacroParser.instance.parseDocument(text);
    if (!parseResult.cst || parseResult.cst.length === 0) {
      return text;
    }

    // 若不含宏，直接返回原文本（避免无谓处理）
    let hasMacro = false;
    for (const item of parseResult.cst) {
      if (item.type === 'macro') {
        hasMacro = true;
        break;
      }
    }
    if (!hasMacro) {
      return text;
    }

    let result = '';
    for (const item of parseResult.cst) {
      if (item.type === 'text') {
        result += item.text ?? '';
      } else if (item.type === 'macro' && item.macro) {
        const macroNode = item.macro;

        // 循环检测：同一宏调用在解析链中重复出现
        if (stack.includes(macroNode.rawWithBraces)) {
          logMacroRuntimeWarning({
            macroName: macroNode.name,
            message: `Cycle detected: '${macroNode.rawWithBraces}' already in resolution stack`,
          });
          result += macroNode.rawWithBraces;
          continue;
        }

        const call: MacroCall = {
          name: macroNode.name,
          args: macroNode.args,
          flags: macroNode.flags,
          isScoped: macroNode.isScoped,
          env,
          rawInner: macroNode.rawInner,
          rawWithBraces: macroNode.rawWithBraces,
          rawArgs: macroNode.rawArgs,
          range: macroNode.range,
          globalOffset: macroNode.range.startOffset,
        };

        // 动态宏优先（与 MacroEngine.evaluateWithChevrotain 行为一致）
        const lowerName = call.name.toLowerCase();
        if (env.dynamicMacros && env.dynamicMacros[lowerName]) {
          const dynamicValue = env.dynamicMacros[lowerName];
          if (typeof dynamicValue === 'string') {
            result += dynamicValue;
            continue;
          } else if (typeof dynamicValue === 'function') {
            result += this.normalizeMacroResult((dynamicValue as () => any)());
            continue;
          }
        }

        // 注册表执行
        if (this.hasMacro(call.name)) {
          result += this.executeMacro(call, { depth, stack });
        } else {
          // 未知宏，保留原样
          result += macroNode.rawWithBraces;
        }
      }
    }

    // 替换后仍含宏（宏返回值中含 {{...}}），继续递归
    if (depth < 20 && result.includes('{{')) {
      return this.substitute(result, depth + 1, env, stack);
    }

    return result;
  }

  /**
   * 从选项构建完整定义
   */
  buildMacroDefFromOptions(name: string, options: MacroDefinitionOptions): MacroDefinition | null {
    // 处理 aliases
    const aliases: MacroResolvedAlias[] = [];
    if (options.aliases) {
      for (const alias of options.aliases) {
        if (!MACRO_IDENTIFIER_PATTERN.test(alias)) {
          logMacroRegisterWarning({ macroName: name, message: `Invalid alias: '${alias}'` });
          continue;
        }
        aliases.push({ name: alias, visible: true });
      }
    }

    // 处理 unnamedArgs
    let minArgs = 0;
    let maxArgs = 0;
    let unnamedArgDefs: MacroUnnamedArgDef[] = [];

    if (typeof options.unnamedArgs === 'number') {
      maxArgs = options.unnamedArgs;
      minArgs = options.unnamedArgs;
    } else if (Array.isArray(options.unnamedArgs)) {
      unnamedArgDefs = options.unnamedArgs;
      minArgs = unnamedArgDefs.filter(a => !a.optional).length;
      maxArgs = unnamedArgDefs.length;
    }

    // 处理 list
    let list: { min: number; max: number } | null = null;
    if (options.list === true) {
      list = { min: 0, max: Infinity };
    } else if (typeof options.list === 'object') {
      list = { min: options.list.min ?? 0, max: options.list.max ?? Infinity };
    }

    // 处理 exampleUsage
    let exampleUsage: string[] = [];
    if (typeof options.exampleUsage === 'string') {
      exampleUsage = [options.exampleUsage];
    } else if (Array.isArray(options.exampleUsage)) {
      exampleUsage = options.exampleUsage;
    }

    return {
      name,
      aliases,
      category: options.category ?? MacroCategory.UNCATEGORIZED,
      minArgs,
      maxArgs,
      unnamedArgDefs,
      list,
      strictArgs: options.strictArgs ?? true,
      description: options.description ?? '',
      returns: options.returns ?? null,
      returnType: options.returnType ?? MacroValueType.STRING,
      displayOverride: options.displayOverride ?? null,
      exampleUsage,
      delayArgResolution: options.delayArgResolution ?? false,
      handler: options.handler,
      aliasOf: null,
      aliasVisible: null,
    };
  }

  /**
   * 值标准化
   */
  normalizeMacroResult(value: any): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  /**
   * 作用域内容缩进处理
   */
  trimScopedContent(content: string, options?: { trimIndent?: boolean }): string {
    if (!content) return '';
    
    const lines = content.split('\n');
    if (lines.length === 0) return '';

    // 找到第一个非空行的缩进量
    let baseIndent = '';
    for (const line of lines) {
      if (line.trim().length > 0) {
        const match = line.match(/^(\s*)/);
        if (match) {
          baseIndent = match[1];
        }
        break;
      }
    }

    // 去除 baseIndent 前导空白
    if (baseIndent && options?.trimIndent !== false) {
      const trimmedLines = lines.map(line => {
        if (line.startsWith(baseIndent)) {
          return line.slice(baseIndent.length);
        }
        return line;
      });
      return trimmedLines.join('\n').trim();
    }

    return content.trim();
  }
}

// 导出单例
export const MacroRegistry = new MacroRegistryClass();
