/**
 * 宏执行引擎
 * 基于 SillyTavern 1.18.0 MacroEngine
 * 使用 Chevrotain 解析器替代正则实现，支持嵌套宏、作用域块、变量简写
 */

import type { MacroEnv, MacroCall } from '../types';
import { MacroRegistry } from './MacroRegistry';
import { MacroParser } from '../parser';
import { MacroCstWalker } from '../cst-walker';

// ============================================================
// 处理器类型
// ============================================================

type ProcessorFn = (input: string, env: MacroEnv) => string;

interface RegisteredProcessor {
  handler: ProcessorFn;
  priority: number;
  source: string;
}

// ============================================================
// MacroEngine 单例
// ============================================================

class MacroEngineClass {
  private preProcessors: RegisteredProcessor[] = [];
  private postProcessors: RegisteredProcessor[] = [];
  private rerollSeed = 0;

  /**
   * 添加前置处理器
   */
  addPreProcessor(handler: ProcessorFn, options?: { priority?: number; source?: string }): void {
    this.preProcessors.push({
      handler,
      priority: options?.priority ?? 50,
      source: options?.source ?? 'unknown',
    });
    this.preProcessors.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 移除前置处理器
   */
  removePreProcessor(handler: ProcessorFn): boolean {
    const idx = this.preProcessors.findIndex(p => p.handler === handler);
    if (idx >= 0) {
      this.preProcessors.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * 添加后置处理器
   */
  addPostProcessor(handler: ProcessorFn, options?: { priority?: number; source?: string }): void {
    this.postProcessors.push({
      handler,
      priority: options?.priority ?? 50,
      source: options?.source ?? 'unknown',
    });
    this.postProcessors.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 移除后置处理器
   */
  removePostProcessor(handler: ProcessorFn): boolean {
    const idx = this.postProcessors.findIndex(p => p.handler === handler);
    if (idx >= 0) {
      this.postProcessors.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * 设置重投种子（用于{{pick}}宏）
   */
  setRerollSeed(seed: number): void {
    this.rerollSeed = seed;
  }

  /**
   * 获取重投种子
   */
  getRerollSeed(): number {
    return this.rerollSeed;
  }

  /**
   * 主要求值方法
   * 使用 Chevrotain 解析器解析文档，通过 CST 遍历器求值所有宏
   */
  evaluate(input: string, env: MacroEnv): string {
    if (!input) return '';

    // 冻结环境
    const frozenEnv = Object.freeze({ ...env });

    // 运行前置处理器
    let processed = input;
    for (const proc of this.preProcessors) {
      try {
        processed = proc.handler(processed, frozenEnv);
      } catch (error) {
        console.error(`[MacroEngine] PreProcessor error (${proc.source}):`, error);
      }
    }

    // 使用 Chevrotain 解析器执行宏替换
    let result = this.evaluateWithChevrotain(processed, frozenEnv);

    // 运行后置处理器
    for (const proc of this.postProcessors) {
      try {
        result = proc.handler(result, frozenEnv);
      } catch (error) {
        console.error(`[MacroEngine] PostProcessor error (${proc.source}):`, error);
      }
    }

    return result;
  }

  /**
   * 使用 Chevrotain 解析器求值宏
   */
  private evaluateWithChevrotain(input: string, env: MacroEnv): string {
    if (!input) return '';

    const parseResult = MacroParser.instance.parseDocument(input);
    if (!parseResult.cst) {
      return input;
    }

    const resolveMacro = (call: MacroCall): string => {
      // 检查动态宏
      const lowerName = call.name.toLowerCase();
      if (env.dynamicMacros && env.dynamicMacros[lowerName]) {
        const dynamicValue = env.dynamicMacros[lowerName];
        if (typeof dynamicValue === 'string') {
          return dynamicValue;
        } else if (typeof dynamicValue === 'function') {
          return MacroRegistry.normalizeMacroResult((dynamicValue as () => any)());
        }
      }

      // 从注册表执行
      if (MacroRegistry.hasMacro(call.name)) {
        return MacroRegistry.executeMacro(call);
      }

      // 未知宏，返回原始文本
      return call.rawWithBraces;
    };

    const trimContent = (content: string, options?: { trimIndent?: boolean }): string => {
      return MacroRegistry.trimScopedContent(content, options);
    };

    return MacroCstWalker.instance.evaluateDocument({
      text: input,
      cst: parseResult.cst,
      contextOffset: 0,
      env,
      resolveMacro,
      trimContent,
    });
  }

  /**
   * 值标准化
   */
  normalizeMacroResult(value: any): string {
    return MacroRegistry.normalizeMacroResult(value);
  }

  /**
   * 作用域内容缩进处理
   */
  trimScopedContent(content: string, options?: { trimIndent?: boolean }): string {
    return MacroRegistry.trimScopedContent(content, options);
  }
}

// 导出单例
export const MacroEngine = new MacroEngineClass();
