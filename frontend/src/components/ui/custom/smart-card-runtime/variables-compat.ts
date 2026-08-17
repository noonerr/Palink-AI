/**
 * 变量读取兼容层 —— 纯函数模块（无 DOM/闭包依赖，可直接单元测试）。
 *
 * 对齐 SillyTavern 1.18.0 `variables.js` 语义（spec §3.2 F8/F9）：
 * - F8：`getVariable` 读取优先级 chat → local → global → fallback
 *   （ST 无 chat 概念，为 Palink 扩展置于最前；local 优先于 global 对齐 ST resolveVariable）。
 * - F9：`getLocalVariable`/`getGlobalVariable` 类型语义（variables.js:45）：
 *   纯数字字符串自动转 Number、空串/空白串与非数字返回原值；
 *   非字符串值（数字/布尔/对象）原样返回，避免 ST 的 Number(true)→1 等意外转换。
 *
 * 本模块同时服务于两条用途：
 * 1. **运行时**：`SillyTavernCompatRuntime.ts` 的 buildSillyTavernCompatRuntimeV2Shim 是
 *    模板字符串（注入 iframe 的脚本源码），通过 `${VARIABLES_COMPAT_SOURCE}` 插值把下方
 *    `VARIABLES_COMPAT_SOURCE` 字符串内联进 shim，保证 iframe 内有自洽的 helper 定义
 *    （模板字符串内的代码无法引用外部模块 import）。
 * 2. **测试**：`__tests__/variables-compat.test.ts` 直接 import 本模块的 TS 函数。
 *
 * ⚠️ 同步约束：`VARIABLES_COMPAT_SOURCE`（字符串，运行时）与下方 TS 函数（测试）
 * 逻辑必须保持一致，改动时两处同步。
 */

/** 按点路径读取嵌套值（与原 SillyTavernCompatRuntime 内部实现等价，独立维护以便测试）。 */
export function getByPathCompat(source: unknown, path: string | number, fallback: unknown = undefined): unknown {
  if (!path) return source ?? fallback;
  const parts = String(path).split('.').filter(Boolean);
  let value: unknown = source;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return fallback;
    value = (value as Record<string, unknown>)[part];
  }
  return value === undefined ? fallback : value;
}

/** [F9] ST 类型归一化：纯数字串 → Number；空串/空白串/非数字串 → 原值；非字符串 → 原值。 */
export function applyStVariableTypeCompat(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return value;
  const num = Number(value);
  return Number.isNaN(num) ? value : num;
}

/**
 * [F8] 按 chat → local → global 优先级读取，local/global 命中值应用 F9 归一化；
 * 三处均未命中返回 fallback。
 */
export function getVariableWithPriorityCompat(
  chatStore: Record<string, unknown>,
  localStore: Record<string, unknown>,
  globalStore: Record<string, unknown>,
  path: string,
  fallback: unknown = undefined,
): unknown {
  const chatValue = getByPathCompat(chatStore, path, undefined);
  if (chatValue !== undefined) return chatValue;
  const localValue = getByPathCompat(localStore, path, undefined);
  if (localValue !== undefined) return applyStVariableTypeCompat(localValue);
  const globalValue = getByPathCompat(globalStore, path, undefined);
  if (globalValue !== undefined) return applyStVariableTypeCompat(globalValue);
  return fallback;
}

/** [F9] local/global 作用域读取：getByPath + 类型归一化。 */
export function getStScopedVariableCompat(
  store: Record<string, unknown>,
  path: string,
  fallback: unknown = undefined,
): unknown {
  return applyStVariableTypeCompat(getByPathCompat(store, path, fallback));
}

/**
 * 运行时副本（iframe shim 内联用）——与上方 TS 函数逻辑一致。
 * 注意：getByPath 在此命名为 `getByPath`（字符串内既有代码以该名引用）；
 * 模块导出用 `getByPathCompat`（测试 import 用）。改动须两处同步。
 */
export const VARIABLES_COMPAT_SOURCE: string = `
// [F8/F9] 变量兼容 helper —— 与 variables-compat.ts 模块函数同源（改动须同步）
const getByPath = (source, path, fallback = undefined) => {
  if (!path) return source ?? fallback;
  const parts = String(path).split('.').filter(Boolean);
  let value = source;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return fallback;
    value = value[part];
  }
  return value === undefined ? fallback : value;
};
const applyStVariableTypeCompat = (value) => {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return value;
  const num = Number(value);
  return Number.isNaN(num) ? value : num;
};
const getVariableWithPriorityCompat = (chatStore, localStore, globalStore, path, fallback = undefined) => {
  const chatValue = getByPath(chatStore, path, undefined);
  if (chatValue !== undefined) return chatValue;
  const localValue = getByPath(localStore, path, undefined);
  if (localValue !== undefined) return applyStVariableTypeCompat(localValue);
  const globalValue = getByPath(globalStore, path, undefined);
  if (globalValue !== undefined) return applyStVariableTypeCompat(globalValue);
  return fallback;
};
const getStScopedVariableCompat = (store, path, fallback = undefined) => applyStVariableTypeCompat(getByPath(store, path, fallback));
`;
