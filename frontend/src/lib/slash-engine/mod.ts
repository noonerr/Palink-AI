/**
 * 斜杠命令系统便捷导出
 */

export { SlashCommandEngine, ARGUMENT_TYPE } from './index';
export type {
  CommandDefinition,
  ArgumentDefinition,
  CommandResult,
  CompletionItem,
  CommandExecutionContext,
} from './index';

export {
  registerBasicCommands,
  registerRoleplayCommands,
  registerControlFlowCommands,
  registerScopeVariableCommands,
  registerTextProcessingCommands,
  type CommandContext,
  type RoleplayCommandContext,
} from './commands';

export {
  registerExtendedCommands,
  type ExtendedCommandContext,
} from './extended-commands';

export { SlashCommandScope, substituteMacros, evaluateCondition } from './scope';
export { SlashCommandClosure, BreakSignal, ContinueSignal } from './closure';
export type { ClosureExecutor } from './closure';

import { SlashCommandEngine } from './index';
import {
  registerBasicCommands,
  registerRoleplayCommands,
  registerControlFlowCommands,
  registerScopeVariableCommands,
  registerTextProcessingCommands,
  type CommandContext,
  type RoleplayCommandContext,
} from './commands';
import { registerExtendedCommands, type ExtendedCommandContext } from './extended-commands';

/**
 * 初始化完整的命令系统
 */
export function initSlashCommands(
  basicContext?: CommandContext,
  roleplayContext?: RoleplayCommandContext,
  extendedContext?: ExtendedCommandContext
): void {
  registerBasicCommands(basicContext);
  registerRoleplayCommands(roleplayContext);
  registerExtendedCommands(extendedContext);
  registerControlFlowCommands();
  registerScopeVariableCommands();
  registerTextProcessingCommands();
}

/**
 * 快速执行命令
 */
export async function executeCommand(input: string) {
  return SlashCommandEngine.execute(input);
}

/**
 * 获取命令补全
 */
export function getCommandCompletions(input: string, position: number) {
  return SlashCommandEngine.getCompletions(input, position);
}
