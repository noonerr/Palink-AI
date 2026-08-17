/**
 * 变量兼容层（variables-compat.ts）单元测试 —— F8 读取优先级 / F9 类型语义。
 *
 * 对齐 SillyTavern 1.18.0 variables.js（spec §3.2 F8/F9）：
 * - F8: getVariable 优先级 chat → local → global → fallback（local 优先 global）
 * - F9: 纯数字串 → Number；空串/空白串/非数字串 → 原值；非字符串 → 原值
 *
 * 运行（Node 25 内置 test runner，零依赖）：
 *   node --test src/components/ui/custom/smart-card-runtime/__tests__/variables-compat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// ---- F8: 读取优先级 ----
test('F8: chat 命中直接返回（不归一化）', () => {
  assert.equal(read('stat_data.hp'), 100);
  assert.equal(read('chatOnly'), 'C');
});

test('F8: chat 无 → local 有，返回 local 并应用 F9 归一化', () => {
  assert.equal(read('num'), 123);          // local '123' → 123
  assert.equal(read('text'), 'abc');        // local 非数字串原样
});

test('F8: local 优先于 global', () => {
  assert.equal(read('sharedLG'), 'LOCAL');
});

test('F8: chat/local 均无 → global 命中（字符串原样）', () => {
  assert.equal(read('onlyGlobal'), 'GG');
});

test('F8: global 数字串经 getVariable 归一化（#1 修复点：global 分支漏接 F9）', () => {
  // global 独有数字串场景：chat/local 均无该键 → global '456' 应返回 456（number）
  const gOnly = { gnum: '456' } as Record<string, unknown>;
  assert.equal(getVariableWithPriorityCompat({}, {}, gOnly, 'gnum'), 456);
  // 修复前此场景返回 '456'（string），与 getGlobalVariable('gnum') → 456 不一致
});

test('F8: 三处均未命中返回 fallback', () => {
  assert.equal(read('nonexistent', 'FB'), 'FB');
  assert.equal(read('nonexistent'), undefined);
});

test('F8: 兜底分支语义（getContextCompat L5105 场景，window.getVariable 缺失时走 getVariableWithPriorityCompat）', () => {
  // 对应 SillyTavernCompatRuntime.ts getContextCompat.getVariable 的兜底分支：
  //   window.getVariable 非函数 → getVariableWithPriorityCompat(chat, local, global, path, fallback)
  // 回归保护：兜底必须走新优先级逻辑（chat→local→global），而非旧单仓（仅 chat）读取。
  assert.equal(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'sharedLG', 'FB'), 'LOCAL'); // 兜底仍 local 优先 global
  assert.equal(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'onlyGlobal', 'FB'), 'GG');   // 兜底可读 global
  assert.equal(getVariableWithPriorityCompat(chatStore, localStore, globalStore, 'none', 'FB'), 'FB');         // 兜底 fallback
});

test('F8: 与 getGlobalVariable 路径（getStScopedVariableCompat）类型一致', () => {
  const gOnly = { gnum: '456' } as Record<string, unknown>;
  const viaGetVariable = getVariableWithPriorityCompat({}, {}, gOnly, 'gnum');
  const viaGetGlobal = getStScopedVariableCompat(gOnly, 'gnum');
  assert.equal(viaGetVariable, viaGetGlobal);
  assert.equal(typeof viaGetVariable, 'number');
});

// ---- F9: 类型语义 ----
test('F9: 纯数字字符串转 Number', () => {
  assert.equal(applyStVariableTypeCompat('123'), 123);
  assert.equal(getStScopedVariableCompat(localStore, 'num'), 123);
  assert.equal(getStScopedVariableCompat(globalStore, 'num'), 456);
});

test('F9: 空串/空白串返回原值', () => {
  assert.equal(applyStVariableTypeCompat(''), '');
  assert.equal(applyStVariableTypeCompat('   '), '   ');
  assert.equal(getStScopedVariableCompat(localStore, 'empty'), '');
  assert.equal(getStScopedVariableCompat(localStore, 'blank'), '  ');
});

test('F9: 非数字字符串返回原值', () => {
  assert.equal(applyStVariableTypeCompat('abc'), 'abc');
  assert.equal(getStScopedVariableCompat(localStore, 'text'), 'abc');
});

test('F9: 数字类型原样（不误转）', () => {
  assert.equal(applyStVariableTypeCompat(100), 100);
  assert.equal(applyStVariableTypeCompat(0), 0);
  assert.equal(getStScopedVariableCompat(chatStore, 'stat_data.hp'), 100);
});

test('F9: 非字符串值（布尔/对象）原样返回，避免 Number(true)→1', () => {
  assert.equal(applyStVariableTypeCompat(true), true);
  assert.equal(applyStVariableTypeCompat(false), false);
  const obj = { a: 1 };
  assert.equal(applyStVariableTypeCompat(obj), obj);
});

test('F9: 不存在返回 fallback', () => {
  assert.equal(getStScopedVariableCompat(localStore, 'missing', 'FB'), 'FB');
});

// ---- getByPathCompat 基础 ----
test('getByPathCompat: 点路径嵌套读取与 fallback', () => {
  assert.equal(getByPathCompat(chatStore, 'stat_data.hp', undefined), 100);
  assert.equal(getByPathCompat(chatStore, 'stat_data.missing', 'FB'), 'FB');
  assert.equal(getByPathCompat(null, 'a.b', 'FB'), 'FB');
});
