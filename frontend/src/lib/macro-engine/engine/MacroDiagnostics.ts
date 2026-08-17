/**
 * 宏引擎诊断/错误处理
 * 基于 SillyTavern 1.18.0 MacroDiagnostics
 */

export interface MacroErrorOptions {
  macroName?: string;
  rawMacro?: string;
  message: string;
  error?: any;
  skipLogging?: boolean;
}

export class MacroRuntimeError extends Error {
  constructor(options: MacroErrorOptions) {
    super(options.message);
    this.name = 'MacroRuntimeError';
  }
}

export function createMacroRuntimeError(options: MacroErrorOptions): MacroRuntimeError {
  return new MacroRuntimeError(options);
}

export function logMacroRuntimeWarning(options: MacroErrorOptions): void {
  if (options.skipLogging) return;
  const prefix = options.macroName ? `[MacroEngine] Warning in '${options.macroName}'` : '[MacroEngine] Warning';
  console.warn(`${prefix}: ${options.message}`, options.error || '');
}

export function logMacroInternalError(options: MacroErrorOptions): void {
  if (options.skipLogging) return;
  console.error(`[MacroEngine] Internal error: ${options.message}`, options.error || '');
}

export function logMacroRegisterWarning(options: MacroErrorOptions): void {
  if (options.skipLogging) return;
  console.warn(`[MacroEngine] Registration warning: ${options.message}`, options.error || '');
}

export function logMacroRegisterError(options: MacroErrorOptions): void {
  if (options.skipLogging) return;
  console.error(`[MacroEngine] Registration error: ${options.message}`, options.error || '');
}

export function logMacroSyntaxWarning(options: MacroErrorOptions): void {
  if (options.skipLogging) return;
  console.warn(`[MacroEngine] Syntax warning: ${options.message}`, options.error || '');
}
