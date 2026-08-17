/**
 * 变量管理器
 * 统一管理三级变量作用域
 */

import type { VariableStorage, VariableScope, BooleanRule } from './types';
import { localVariables } from './local';
import { globalVariables } from './global';

/**
 * 变量管理器
 * 管理三级变量作用域：scope > local > global
 */
export class VariableManager {
  /**
   * 本地变量（会话级）
   */
  readonly local: VariableStorage = localVariables;

  /**
   * 全局变量（应用级）
   */
  readonly global: VariableStorage = globalVariables;

  /**
   * 作用域变量（命令执行级，临时）
   */
  private scopeVariables: Record<string, string> = {};

  /**
   * 设置会话ID（用于本地变量）
   */
  setSessionId(sessionId: string): void {
    localVariables.setSessionId(sessionId);
  }

  /**
   * 加载本地变量数据
   */
  loadLocalVariables(data: Record<string, string>): void {
    localVariables.load(data);
  }

  /**
   * 导出本地变量数据（用于持久化）
   */
  exportLocalVariables(): Record<string, string> {
    return localVariables.export();
  }

  /**
   * 加载全局变量
   */
  async loadGlobalVariables(): Promise<void> {
    await globalVariables.load();
  }

  /**
   * 解析变量（按优先级：scope > local > global）
   */
  resolveVariable(name: string): string {
    // 1. 检查作用域变量
    if (name in this.scopeVariables) {
      return this.scopeVariables[name];
    }

    // 2. 检查本地变量
    if (localVariables.exists(name)) {
      return String(localVariables.get(name));
    }

    // 3. 检查全局变量
    if (globalVariables.exists(name)) {
      return String(globalVariables.get(name));
    }

    // 4. 返回原字符串
    return name;
  }

  /**
   * 设置作用域变量
   */
  setScopeVariable(name: string, value: string): void {
    this.scopeVariables[name] = value;
  }

  /**
   * 获取作用域变量
   */
  getScopeVariable(name: string): string {
    return this.scopeVariables[name] ?? '';
  }

  /**
   * 删除作用域变量
   */
  deleteScopeVariable(name: string): void {
    delete this.scopeVariables[name];
  }

  /**
   * 清空作用域变量
   */
  clearScopeVariables(): void {
    this.scopeVariables = {};
  }

  /**
   * 布尔求值
   */
  evaluateBoolean(rule: BooleanRule, a: string | number, b?: string | number): boolean {
    const aNum = typeof a === 'number' ? a : Number(a);
    const bNum = typeof b === 'number' ? b : Number(b);
    const aStr = String(a);
    const bStr = String(b ?? '');

    switch (rule) {
      case 'eq':
        return aStr === bStr;
      case 'neq':
        return aStr !== bStr;
      case 'gt':
        return aNum > bNum;
      case 'gte':
        return aNum >= bNum;
      case 'lt':
        return aNum < bNum;
      case 'lte':
        return aNum <= bNum;
      case 'in':
        return aStr.includes(bStr);
      case 'nin':
        return !aStr.includes(bStr);
      case 'not':
        return !aStr || aStr === 'false' || aStr === '0';
      case 'and':
        return Boolean(aStr && bStr && aStr !== 'false' && aStr !== '0' && bStr !== 'false' && bStr !== '0');
      case 'or':
        return Boolean((aStr && aStr !== 'false' && aStr !== '0') || (bStr && bStr !== 'false' && bStr !== '0'));
      default:
        return false;
    }
  }

  /**
   * 解析布尔操作数
   */
  parseBooleanOperands(args: {
    a?: string;
    b?: string;
    rule?: string;
  }): { a: string | number; b: string | number; rule: BooleanRule } {
    const a = args.a ?? '';
    const b = args.b ?? '';
    const rule = (args.rule ?? 'eq') as BooleanRule;

    // 尝试转换为数字
    const aNum = Number(a);
    const bNum = Number(b);

    return {
      a: isNaN(aNum) ? a : aNum,
      b: isNaN(bNum) ? b : bNum,
      rule,
    };
  }
}

// 导出单例
export const variableManager = new VariableManager();
