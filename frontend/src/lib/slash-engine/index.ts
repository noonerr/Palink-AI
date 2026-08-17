/**
 * 斜杠命令引擎核心
 * 基于 SillyTavern 1.18.0 SlashCommand 系统
 *
 * 设计原则:
 * 1. 类型安全 - 所有参数都有类型定义
 * 2. 可扩展 - 支持动态注册命令
 * 3. 自动补全 - 支持Tab补全
 * 4. 链式调用 - 支持 /cmd1 | /cmd2
 * 5. 闭包与作用域 - 支持 /: (...) 闭包语法与作用域变量
 */

import { SlashCommandScope, substituteMacros } from './scope';
import { SlashCommandClosure, type ClosureExecutor } from './closure';

// ============================================================
// 类型定义
// ============================================================

export enum ARGUMENT_TYPE {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  ENUM = 'enum',
}

export interface ArgumentDefinition {
  name: string;
  description: string;
  type: ARGUMENT_TYPE[];
  isRequired?: boolean;
  defaultValue?: string;
  enumList?: string[];
}

export interface CommandExecutionContext {
  scope: SlashCommandScope;
  closures: SlashCommandClosure[];
  pipe: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  namedArgs?: ArgumentDefinition[];
  unnamedArgs?: ArgumentDefinition[];
  returns?: string;
  callback: (
    namedArgs: Record<string, string>,
    unnamedArgs: string[],
    context?: CommandExecutionContext,
  ) => string | Promise<string>;
}

export interface CommandResult {
  success: boolean;
  output: string;
  isCommand: boolean;
}

export interface CompletionItem {
  name: string;
  description: string;
  type: 'command' | 'argument' | 'value';
}

// ============================================================
// SlashCommandEngine 单例
// ============================================================

class SlashCommandEngineClass implements ClosureExecutor {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();
  private rootScope = new SlashCommandScope(null);
  private static readonly CONTROL_FLOW_COMMANDS = new Set(['if', 'while', 'for', 'switch']);

  /**
   * 注册命令
   */
  register(command: CommandDefinition): void {
    // 注册主命令
    this.commands.set(command.name.toLowerCase(), command);

    // 注册别名
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias.toLowerCase(), command.name.toLowerCase());
      }
    }
  }

  /**
   * 注销命令
   */
  unregister(name: string): boolean {
    const lowerName = name.toLowerCase();
    const command = this.commands.get(lowerName);
    if (!command) return false;

    // 删除别名
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.delete(alias.toLowerCase());
      }
    }

    return this.commands.delete(lowerName);
  }

  /**
   * 获取命令
   */
  getCommand(name: string): CommandDefinition | undefined {
    const lowerName = name.toLowerCase();
    // 先查找主命令
    const command = this.commands.get(lowerName);
    if (command) return command;

    // 再查找别名
    const realName = this.aliases.get(lowerName);
    if (realName) {
      return this.commands.get(realName);
    }

    return undefined;
  }

  /**
   * 获取所有命令
   */
  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * 获取根作用域
   */
  getRootScope(): SlashCommandScope {
    return this.rootScope;
  }

  /**
   * 重置根作用域
   */
  resetScope(): void {
    this.rootScope = new SlashCommandScope(null);
  }

  /**
   * 执行命令（入口）
   */
  async execute(input: string): Promise<CommandResult> {
    const trimmed = input.trim();

    // 检查是否是命令（以/开头）
    if (!trimmed.startsWith('/')) {
      return { success: true, output: trimmed, isCommand: false };
    }

    try {
      const output = await this.executeInScope(trimmed, this.rootScope);
      return { success: true, output: output || '', isCommand: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Error: ${message}`,
        isCommand: true,
      };
    }
  }

  /**
   * 在指定作用域内执行命令（支持管道与闭包）
   */
  async executeInScope(input: string, scope: SlashCommandScope): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return '';

    const segments = this.splitPipeline(trimmed);
    if (segments.length === 0) return '';

    return await this.executePipeline(segments, scope);
  }

  /**
   * 执行管道：按 | 分割的命令序列
   * - 首段为控制流命令时，后续段作为闭包参数传入
   * - 首段为普通命令时，输出作为下一段的管道输入
   * - 管道中断（输出为空）时后续命令不执行
   */
  private async executePipeline(segments: string[], scope: SlashCommandScope): Promise<string> {
    const normalized = segments.map(s => this.normalizeSegment(s)).filter(s => s);
    if (normalized.length === 0) return '';

    const first = normalized[0];

    // 闭包语法 /: (...)
    if (first.startsWith('/:')) {
      const closure = this.parseClosureFromSegment(first, scope);
      closure.setExecutor(this);
      return await closure.execute(scope);
    }

    // 解析首段命令
    const parsed = this.parseCommand(first);
    if (!parsed) return '';

    const { commandName, namedArgs, unnamedArgs } = parsed;
    const command = this.getCommand(commandName);
    if (!command) {
      throw new Error(`Unknown command: /${commandName}`);
    }

    // 控制流命令：传入原始参数（自行做宏替换以支持每次迭代重新求值）
    if (SlashCommandEngineClass.CONTROL_FLOW_COMMANDS.has(commandName.toLowerCase())) {
      const closures = normalized.slice(1).map(s => {
        const c = this.parseClosureFromSegment(s, scope);
        c.setExecutor(this);
        return c;
      });

      const context: CommandExecutionContext = {
        scope,
        closures,
        pipe: scope.pipe,
      };

      const output = await command.callback(namedArgs, unnamedArgs, context);
      return output || '';
    }

    // 普通命令：先做宏替换
    const subNamedArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(namedArgs)) {
      subNamedArgs[k] = substituteMacros(v, scope);
    }
    const subUnnamedArgs = unnamedArgs.map(a => substituteMacros(a, scope));

    const context: CommandExecutionContext = {
      scope,
      closures: [],
      pipe: scope.pipe,
    };

    let output = await command.callback(subNamedArgs, subUnnamedArgs, context);
    output = output || '';

    // 管道传递：输出作为下一段输入
    if (normalized.length > 1) {
      // 管道中断：输出为空时后续命令不执行
      if (!output) return '';
      const childScope = new SlashCommandScope(scope);
      childScope.pipe = output;
      return await this.executePipeline(normalized.slice(1), childScope);
    }

    return output;
  }

  /**
   * 分割管道（处理引号与括号）
   */
  private splitPipeline(input: string): string[] {
    const segments: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let parenDepth = 0;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (inQuote) {
        current += char;
        if (char === quoteChar) {
          inQuote = false;
        }
      } else if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
        current += char;
      } else if (char === '(') {
        parenDepth++;
        current += char;
      } else if (char === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += char;
      } else if (char === '|' && parenDepth === 0) {
        if (current.trim()) {
          segments.push(current.trim());
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      segments.push(current.trim());
    }

    return segments;
  }

  /**
   * 规范化命令段：缺少 / 前缀时自动补全
   */
  private normalizeSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('/')) return trimmed;
    return '/' + trimmed;
  }

  /**
   * 从段解析闭包：/: (...) 或普通命令文本
   */
  private parseClosureFromSegment(segment: string, parentScope: SlashCommandScope): SlashCommandClosure {
    const trimmed = segment.trim();
    const match = trimmed.match(/^\/:\s*\(([\s\S]*)\)$/);
    if (match) {
      return new SlashCommandClosure(match[1], parentScope);
    }
    return new SlashCommandClosure(trimmed, parentScope);
  }

  /**
   * 解析命令字符串
   */
  private parseCommand(input: string): { commandName: string; namedArgs: Record<string, string>; unnamedArgs: string[] } | null {
    // 移除开头的 /
    const withoutSlash = input.slice(1).trim();
    if (!withoutSlash) return null;

    // 分割命令名和参数
    const parts = this.splitCommandParts(withoutSlash);
    if (parts.length === 0) return null;

    const commandName = parts[0];
    const argsStr = parts.slice(1).join(' ');

    // 解析参数
    const { namedArgs, unnamedArgs } = this.parseArgs(argsStr);

    return { commandName, namedArgs, unnamedArgs };
  }

  /**
   * 分割命令部分（处理引号内的空格）
   */
  private splitCommandParts(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (inQuote) {
        if (char === quoteChar) {
          inQuote = false;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }

  /**
   * 解析参数
   */
  private parseArgs(argsStr: string): { namedArgs: Record<string, string>; unnamedArgs: string[] } {
    const namedArgs: Record<string, string> = {};
    const unnamedArgs: string[] = [];

    if (!argsStr.trim()) {
      return { namedArgs, unnamedArgs };
    }

    const parts = this.splitCommandParts(argsStr);

    for (const part of parts) {
      // 检查是否是命名参数 (key=value 或 key="value")
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        const keyRaw = part.slice(0, eqIdx);
        // key 必须是有效标识符（字母/下划线开头，仅含字母数字下划线），
        // 否则视为普通参数（避免 <=3、>=5 等比较运算符被误判为命名参数）
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(keyRaw)) {
          const key = keyRaw.toLowerCase();
          const value = part.slice(eqIdx + 1);
          namedArgs[key] = value;
        } else {
          unnamedArgs.push(part);
        }
      } else {
        unnamedArgs.push(part);
      }
    }

    return { namedArgs, unnamedArgs };
  }

  /**
   * 获取自动补全建议
   */
  getCompletions(input: string, position: number): CompletionItem[] {
    const trimmed = input.slice(0, position).trim();
    
    // 如果没有输入或不是以/开头，返回空
    if (!trimmed || !trimmed.startsWith('/')) {
      return [];
    }

    // 如果只输入了/，返回所有命令
    if (trimmed === '/') {
      return this.getAllCommands().map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        type: 'command' as const,
      }));
    }

    // 解析当前输入
    const withoutSlash = trimmed.slice(1);
    const parts = withoutSlash.split(/\s+/);
    
    // 如果只有一个部分（命令名），返回匹配的命令
    if (parts.length === 1) {
      const prefix = parts[0].toLowerCase();
      return this.getAllCommands()
        .filter(cmd => cmd.name.toLowerCase().startsWith(prefix) || 
                       cmd.aliases?.some(a => a.toLowerCase().startsWith(prefix)))
        .map(cmd => ({
          name: cmd.name,
          description: cmd.description,
          type: 'command' as const,
        }));
    }

    // 如果有多个部分，返回参数建议
    const commandName = parts[0].toLowerCase();
    const command = this.getCommand(commandName);
    if (!command) return [];

    // 返回命名参数建议
    const completions: CompletionItem[] = [];
    if (command.namedArgs) {
      for (const arg of command.namedArgs) {
        completions.push({
          name: `${arg.name}=`,
          description: arg.description,
          type: 'argument',
        });
      }
    }

    return completions;
  }

  /**
   * 获取命令帮助文本
   */
  getHelp(commandName?: string): string {
    if (commandName) {
      const command = this.getCommand(commandName);
      if (!command) return `Unknown command: ${commandName}`;

      let help = `/${command.name} - ${command.description}\n`;
      
      if (command.aliases && command.aliases.length > 0) {
        help += `Aliases: ${command.aliases.map(a => `/${a}`).join(', ')}\n`;
      }

      if (command.namedArgs && command.namedArgs.length > 0) {
        help += '\nNamed Arguments:\n';
        for (const arg of command.namedArgs) {
          const required = arg.isRequired ? ' (required)' : '';
          const defaultVal = arg.defaultValue ? ` [default: ${arg.defaultValue}]` : '';
          help += `  ${arg.name}: ${arg.description}${required}${defaultVal}\n`;
        }
      }

      if (command.unnamedArgs && command.unnamedArgs.length > 0) {
        help += '\nArguments:\n';
        for (const arg of command.unnamedArgs) {
          const required = arg.isRequired ? ' (required)' : '';
          help += `  ${arg.name}: ${arg.description}${required}\n`;
        }
      }

      if (command.returns) {
        help += `\nReturns: ${command.returns}`;
      }

      return help;
    }

    // 返回所有命令的帮助
    let help = 'Available Commands:\n\n';
    const commands = this.getAllCommands();
    
    for (const cmd of commands) {
      help += `/${cmd.name} - ${cmd.description}\n`;
    }

    help += '\nType /help <command> for detailed information about a command.';
    return help;
  }
}

// 导出单例
export const SlashCommandEngine = new SlashCommandEngineClass();
export type { SlashCommandScope } from './scope';
export type { SlashCommandClosure, ClosureExecutor } from './closure';
export { BreakSignal, ContinueSignal } from './closure';
export { substituteMacros, evaluateCondition } from './scope';
