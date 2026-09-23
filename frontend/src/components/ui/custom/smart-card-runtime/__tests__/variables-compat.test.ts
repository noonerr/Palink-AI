/**
 * 变量兼容层（variables-compat.ts）单元测试 —— F8 读取优先级 / F9 类型语义。
 *
 * 对齐 SillyTavern 1.18.0 variables.js（spec §3.2 F8/F9）：
 * - F8: getVariable 优先级 chat → local → global → fallback（local 优先 global）
 * - F9: 纯数字串 → Number；空串/空白串/非数字串 → 原值；非字符串 → 原值
 *
 * 运行: npx vitest run
 * （原为 node:test + node:assert/strict；assert.equal 即 Object.is 严格相等，
 *   等价换为 vitest 的 expect().toBe()，比较的值与条件未变。）
 */
import { describe, it, expect } from 'vitest';
import {
  applyStVariableTypeCompat,
  getByPathCompat,
  getStScopedVariableCompat,
  getVariableWithPriorityCompat,
} from '../variables-compat.ts';

// ---- 测试数据 ----
const chatStore = { stat_data: { hp: 100 }, chatOnly: 'C', shared: 'CHAT' } as Record<string, unknown>;
const localStore = { num: '123', empty: '', blank: '  ', text: 'abc', shared: 'LOCAL', sharedLG: 'LOCAL', missing: undefined } as Record<string, unknown>;
const globalStore = { num: '456', shared: 'GLOBAL', sharedLG: 'GLOBAL', onlyGlobal: 'GG' } as Record<string, unknown>;

const read = (path: string, fallback?: unknown) =>
  getVariableWithPriorityCompat(chatStore, localStore, globalStore, path, fallback);

describe('F8: 读取优先级', () => {
  it('F8: chat 命中直接返回（不归一化）', () => {
    expect(read('stat_data.hp')).toBe(100);
    expect(read('chatOnly')).toBe('C');
  });

  it('F8: chat 无 → local 有，返回 local 并应用 F9 归一化', () => {
    expect(read('num')).toBe(123);          // local '123' → 123
    expect(read('text')).toBe('abc');        // local 非数字串原样
  });

  it('F8: local 优先于 global', () => {
    expect(read('sharedLG')).toBe('LOCAL');
  });

  it('F8: chat/local 均无 → global 命中（字符串原样）', () => {
    expect(read('onlyGlobal')).toBe('GG');
  });

  it('F8: global 数字串经 getVariable 归一化（#1 修复点：global 分支漏接 F9）', () => {
    // global 独有数字串场景：chat/local 均无该键 → global '456' 应返回 456（number）
    const gOnly = { gnum: '456' } as Record<string, unknown>;
    expect(getVariableWithPriorityCompat({}, {}, gOnly, 'gnum')).toBe(456);
    // 修复前此场景返回 '456'（string），与 getGlobalVariable('gnum') → 456 不一致
  });

  it('F8: 三处均未命中返回 fallback', () => {
    expect(read('nonexistent', 'FB')).toBe('FB');
    expect(read('nonexistent')).toBe(undefined);
  });

  it('F8: 兜底分支语义（getContextCompat L5105 场景，window.getVariable 缺失时走 getVariableWithPriorityCompat）', () => {
    // 对应 SillyTavernCompatRuntime.ts getContextCompat.getVariable 的兜底分支：
    //   window.getVariable 非函数 → getVariableWithPriorityCompat(chat, local, global, path, fallback)
    // 回归保护：兜底必须走新优先级逻辑（chat→local→global），而非旧单仓（仅 chat）读取。
    expect(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'sharedLG', 'FB')).toBe('LOCAL'); // 兜底仍 local 优先 global
    expect(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'onlyGlobal', 'FB')).toBe('GG');   // 兜底可读 global
    expect(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'none', 'FB')).toBe('FB');         // 兜底 fallback
  });

  it('F8: 与 getGlobalVariable 路径（getStScopedVariableCompat）类型一致', () => {
    const gOnly = { gnum: '456' } as Record<string, unknown>;
    const viaGetVariable = getVariableWithPriorityCompat({}, {}, gOnly, 'gnum');
    const viaGetGlobal = getStScopedVariableCompat(gOnly, 'gnum');
    expect(viaGetVariable).toBe(viaGetGlobal);
    expect(typeof viaGetVariable).toBe('number');
  });
});

describe('F9: 类型语义', () => {
  it('F9: 纯数字字符串转 Number', () => {
    expect(applyStVariableTypeCompat('123')).toBe(123);
    expect(getStScopedVariableCompat(localStore, 'num')).toBe(123);
    expect(getStScopedVariableCompat(globalStore, 'num')).toBe(456);
  });

  it('F9: 空串/空白串返回原值', () => {
    expect(applyStVariableTypeCompat('')).toBe('');
    expect(applyStVariableTypeCompat('   ')).toBe('   ');
    expect(getStScopedVariableCompat(localStore, 'empty')).toBe('');
    expect(getStScopedVariableCompat(localStore, 'blank')).toBe('  ');
  });

  it('F9: 非数字字符串返回原值', () => {
    expect(applyStVariableTypeCompat('abc')).toBe('abc');
    expect(getStScopedVariableCompat(localStore, 'text')).toBe('abc');
  });

  it('F9: 数字类型原样（不误转）', () => {
    expect(applyStVariableTypeCompat(100)).toBe(100);
    expect(applyStVariableTypeCompat(0)).toBe(0);
    expect(getStScopedVariableCompat(chatStore, 'stat_data.hp')).toBe(100);
  });

  it('F9: 非字符串值（布尔/对象）原样返回，避免 Number(true)→1', () => {
    expect(applyStVariableTypeCompat(true)).toBe(true);
    expect(applyStVariableTypeCompat(false)).toBe(false);
    const obj = { a: 1 };
    expect(applyStVariableTypeCompat(obj)).toBe(obj);
  });

  it('F9: 不存在返回 fallback', () => {
    expect(getStScopedVariableCompat(localStore, 'missing', 'FB')).toBe('FB');
  });
});

describe('getByPathCompat 基础', () => {
  it('getByPathCompat: 点路径嵌套读取与 fallback', () => {
    expect(getByPathCompat(chatStore, 'stat_data.hp', undefined)).toBe(100);
    expect(getByPathCompat(chatStore, 'stat_data.missing', 'FB')).toBe('FB');
    expect(getByPathCompat(null, 'a.b', 'FB')).toBe('FB');
  });
});
