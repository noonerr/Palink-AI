/**
 * 斜杠命令闭包与控制流信号
 * 基于 SillyTavern 1.18.0 SlashCommandClosure 实现
 */

import { SlashCommandScope } from './scope';

// ============================================================
// 闭包执行器接口
// ============================================================

/**
 * 闭包执行器接口
 * 由 SlashCommandEngine 实现，用于在闭包内执行子命令
 */
export interface ClosureExecutor {
  executeInScope(input: string, scope: SlashCommandScope): Promise<string>;
}

// ============================================================
// 控制流信号（通过抛出异常实现 break/continue）
// ============================================================

/** break 信号：跳出当前循环 */
export class BreakSignal extends Error {
  constructor() {
    super('break');
    this.name = 'BreakSignal';
    // 维持原型链（ES5 兼容）
    Object.setPrototypeOf(this, BreakSignal.prototype);
  }
}

/** continue 信号：跳过本次循环剩余部分 */
export class ContinueSignal extends Error {
  constructor() {
    super('continue');
    this.name = 'ContinueSignal';
    Object.setPrototypeOf(this, ContinueSignal.prototype);
  }
}

// ============================================================
// SlashCommandClosure 闭包类
// ============================================================

export class SlashCommandClosure {
  /** 闭包内要执行的命令文本 */
  public commands: string;
  /** 父作用域（用于词法作用域查找） */
  private parentScope: SlashCommandScope;
  /** 执行器（由引擎注入） */
  private executor: ClosureExecutor | null = null;

  constructor(commands: string, parentScope: SlashCommandScope) {
    this.commands = commands;
    this.parentScope = parentScope;
  }

  /**
   * 注入执行器（由 SlashCommandEngine 调用）
   */
  setExecutor(executor: ClosureExecutor): void {
    this.executor = executor;
  }

  /**
   * 在子作用域中执行闭包命令
   */
  async execute(scope: SlashCommandScope): Promise<string> {
    if (!this.executor) {
      return '';
    }
    // 创建子作用域，继承父作用域变量与管道
    const childScope = new SlashCommandScope(scope);
    childScope.pipe = scope.pipe;
    return await this.executor.executeInScope(this.commands, childScope);
  }
}
