/**
 * 临时测试脚本：验证 Chevrotain 宏引擎端到端求值
 * 测试完成后将删除
 */

import { MacroLexer } from './src/lib/macro-engine/lexer';
import { MacroParser } from './src/lib/macro-engine/parser';
import { MacroCstWalker } from './src/lib/macro-engine/cst-walker';
import { MacroRegistry } from './src/lib/macro-engine/engine/MacroRegistry';
import { parseFlags, createEmptyFlags } from './src/lib/macro-engine/engine/MacroFlags';
import { ELSE_MARKER } from './src/lib/macro-engine/types';
import type { MacroCall, MacroEnv } from './src/lib/macro-engine/types';

const testEnv: MacroEnv = {
  content: '',
  contentHash: 0,
  names: {
    user: '小明',
    char: '宠物',
    group: '',
    groupNotMuted: '',
    notChar: '小明',
  },
  character: {},
  system: { model: '' },
  functions: { postProcess: (text: string) => text },
  dynamicMacros: {},
  extra: {},
};

MacroRegistry.registerMacro('user', {
  category: 'character',
  unnamedArgs: 0,
  description: 'Returns the user name',
  returns: 'User name',
  handler: (ctx) => ctx.env.names.user,
});

MacroRegistry.registerMacro('char', {
  category: 'character',
  unnamedArgs: 0,
  description: 'Returns the char name',
  returns: 'Char name',
  handler: (ctx) => ctx.env.names.char,
});

MacroRegistry.registerMacro('random', {
  category: 'random',
  unnamedArgs: 0,
  list: { min: 1, max: Infinity },
  strictArgs: false,
  description: 'Randomly selects one item',
  returns: 'Selected item',
  handler: (ctx) => {
    if (!ctx.list || ctx.list.length === 0) return '';
    return ctx.list[0];
  },
});

MacroRegistry.registerMacro('if', {
  category: 'utility',
  unnamedArgs: [{ name: 'condition', optional: false }, { name: 'content', optional: true }],
  description: 'Conditional branch',
  returns: 'Content based on condition',
  handler: (ctx) => {
    let condition = ctx.unnamedArgs[0] ?? '';
    let inverted = false;
    if (condition.startsWith('!')) {
      inverted = true;
      condition = condition.slice(1).trim();
    }
    const isFalsy = condition === '' || condition.toLowerCase() === 'false' || condition === '0';
    const isTrue = inverted ? isFalsy : !isFalsy;
    const content = ctx.unnamedArgs[1] ?? '';
    const elseIdx = content.indexOf(ELSE_MARKER);
    if (elseIdx >= 0) {
      const thenPart = content.slice(0, elseIdx);
      const elsePart = content.slice(elseIdx + ELSE_MARKER.length);
      return isTrue ? thenPart : elsePart;
    }
    return isTrue ? content : '';
  },
});

MacroRegistry.registerMacro('else', {
  category: 'utility',
  unnamedArgs: 0,
  description: 'Else marker',
  returns: 'Else marker',
  handler: () => ELSE_MARKER,
});

MacroRegistry.registerMacro('setvar', {
  category: 'variable',
  unnamedArgs: [{ name: 'name', optional: false }, { name: 'value', optional: false }],
  description: 'Sets a variable',
  returns: 'Empty string',
  handler: (ctx) => '',
});

function evaluate(input: string, env: MacroEnv): string {
  const parseResult = MacroParser.instance.parseDocument(input);
  if (!parseResult.cst) {
    return input;
  }

  const resolveMacro = (call: MacroCall): string => {
    if (MacroRegistry.hasMacro(call.name)) {
      return MacroRegistry.executeMacro(call);
    }
    return call.rawWithBraces;
  };

  const trimContent = (content: string): string => content.trim();

  return MacroCstWalker.instance.evaluateDocument({
    text: input,
    cst: parseResult.cst,
    contextOffset: 0,
    env,
    resolveMacro,
    trimContent,
  });
}

let passCount = 0;
let failCount = 0;

function test(name: string, input: string, expected: string, env?: MacroEnv): void {
  const result = evaluate(input, env ?? testEnv);
  const pass = result === expected;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass) {
    console.log(`  Input:    "${input}"`);
    console.log(`  Expected: "${expected}"`);
    console.log(`  Got:      "${result}"`);
    failCount++;
  } else {
    passCount++;
  }
}

// Test 1: Simple macros
test('Simple macro', 'Hello {{user}}!', 'Hello 小明!');

// Test 2: Multiple macros
test('Multiple macros', '{{user}}和{{char}}', '小明和宠物');

// Test 3: Nested macros - KEY TEST
test('Nested macros', '{{random::{{user}}的{{char}}}}', '小明的宠物');

// Test 4: Scoped block macro (true)
test('Scoped if (true)', '{{#if true}}visible content{{/if}}', 'visible content');

// Test 5: Scoped block macro (false)
test('Scoped if (false)', '{{#if false}}hidden content{{/if}}', '');

// Test 6: Plain text
test('Plain text', 'Just plain text', 'Just plain text');

// Test 7: Unknown macro
test('Unknown macro', '{{unknownmacro}}', '{{unknownmacro}}');

// Test 8: Scoped setvar
test('Scoped setvar', '{{setvar::myvar}}value{{/setvar}}', '');

// Test 9: Inline if
test('Inline if (true)', '{{if::true::content}}', 'content');

// Test 10: Inline if (false)
test('Inline if (false)', '{{if::false::content}}', '');

// Test 11: Scoped if with else
test('Scoped if with else (true)', '{{#if true}}yes{{else}}no{{/if}}', 'yes');

// Test 12: Scoped if with else (false)
test('Scoped if with else (false)', '{{#if false}}yes{{else}}no{{/if}}', 'no');

// Test 13: Nested scoped macros
test('Nested scoped macros', '{{#if true}}outer{{#if false}}inner{{/if}}{{/if}}', 'outer');

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
