/**
 * 宏标志系统
 * 基于 SillyTavern 1.18.0 MacroFlags
 */

import type { MacroFlags } from '../types';

export enum MacroFlagType {
  IMMEDIATE = '!',
  DELAYED = '?',
  REEVALUATE = '~',
  FILTER = '>',
  CLOSING_BLOCK = '/',
  PRESERVE_WHITESPACE = '#',
}

export function createEmptyFlags(): MacroFlags {
  return {
    immediate: false,
    delayed: false,
    reevaluate: false,
    filter: false,
    closingBlock: false,
    preserveWhitespace: false,
    raw: [],
  };
}

export function parseFlags(flagChars: string[]): MacroFlags {
  const flags = createEmptyFlags();
  flags.raw = [...flagChars];

  for (const char of flagChars) {
    switch (char) {
      case MacroFlagType.IMMEDIATE:
        flags.immediate = true;
        break;
      case MacroFlagType.DELAYED:
        flags.delayed = true;
        break;
      case MacroFlagType.REEVALUATE:
        flags.reevaluate = true;
        break;
      case MacroFlagType.FILTER:
        flags.filter = true;
        break;
      case MacroFlagType.CLOSING_BLOCK:
        flags.closingBlock = true;
        break;
      case MacroFlagType.PRESERVE_WHITESPACE:
        flags.preserveWhitespace = true;
        break;
    }
  }

  return flags;
}

export function flagsToString(flags: MacroFlags): string {
  return flags.raw.join('');
}

export function hasFlag(flags: MacroFlags, type: MacroFlagType): boolean {
  switch (type) {
    case MacroFlagType.IMMEDIATE: return flags.immediate;
    case MacroFlagType.DELAYED: return flags.delayed;
    case MacroFlagType.REEVALUATE: return flags.reevaluate;
    case MacroFlagType.FILTER: return flags.filter;
    case MacroFlagType.CLOSING_BLOCK: return flags.closingBlock;
    case MacroFlagType.PRESERVE_WHITESPACE: return flags.preserveWhitespace;
    default: return false;
  }
}
