/*
 * N8-b 前端适配契约守卫：HttpOnly Cookie 双轨期。
 *
 * 锁定 services/api.ts 的源码契约：
 * 1. request()/stream()/raw() 三处均含 credentials 注入；
 * 2. 三处均含 mutating 方法 X-CSRF-Token 自动注入逻辑（GET 默认豁免）；
 * 3. 既有 palink_token 直读 / 续期写入 / Authorization 拼接未被删除（防误删守卫，
 *    双轨期只增不删——删除归零是 N8-c 的职责）。
 * 任何整文件回退（同 formatting.ts 事故模式）立即红灯。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/services/__tests__/api-csrf-credentials-contract.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// 极简测试运行器（与既有契约测试一致）
// ============================================================
type TestFn = () => void | Promise<void>;
interface TestCase {
  name: string;
  fn: TestFn;
}
const _testCases: TestCase[] = [];

function it(name: string, fn: TestFn): void {
  _testCases.push({ name, fn });
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`expect ${String(expected)}, got ${String(actual)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (!(Number(actual) > expected)) {
        throw new Error(`expect > ${expected}, got ${String(actual)}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (!(Number(actual) >= expected)) {
        throw new Error(`expect >= ${expected}, got ${String(actual)}`);
      }
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count += 1;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(__dirname, '..', '..', 'services', 'api.ts'),
  'utf-8',
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const end = source.indexOf('\n}', start);
  return source.slice(start, end === -1 ? undefined : end);
}

// ============================================================
// 契约断言 —— CSRF 双提交令牌
// ============================================================

it('getCsrfToken 存在且解析 palink_csrf Cookie', () => {
  const body = functionBody(SOURCE, 'function getCsrfToken');
  expect(body === '').toBe(false);
  expect(body.includes('document.cookie')).toBe(true);
  expect(body.includes('palink_csrf=')).toBe(true);
});

it('getCsrfToken 以 try/catch 包裹（解析失败返回空串不抛错）', () => {
  const body = functionBody(SOURCE, 'function getCsrfToken');
  expect(body.includes('try {')).toBe(true);
  expect(body.includes('catch')).toBe(true);
});

it('mutating 方法集合恰为 POST/PUT/PATCH/DELETE（GET 不在其中）', () => {
  const start = SOURCE.indexOf('MUTATING_METHODS = new Set(');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(')', start);
  const setDef = SOURCE.slice(start, end);
  expect(setDef.includes("'POST'")).toBe(true);
  expect(setDef.includes("'PUT'")).toBe(true);
  expect(setDef.includes("'PATCH'")).toBe(true);
  expect(setDef.includes("'DELETE'")).toBe(true);
  expect(setDef.includes("'GET'")).toBe(false);
});

// ============================================================
// 契约断言 —— 三通道 credentials + X-CSRF-Token 注入
// ============================================================

it('request() fetch 补 credentials 注入（尊重调用方显式传值）', () => {
  expect(SOURCE.includes("credentials: credentials ?? 'include'")).toBe(true);
});

it('stream() fetch 补 credentials 注入（尊重调用方显式传值）', () => {
  expect(SOURCE.includes("credentials: options?.credentials ?? 'include'")).toBe(true);
});

it('raw() fetch 补 credentials 注入（尊重调用方显式传值）', () => {
  expect(SOURCE.includes("credentials: fetchOptions.credentials ?? 'include'")).toBe(true);
});

it('三处均含 X-CSRF-Token 自动注入逻辑', () => {
  expect(countOccurrences(SOURCE, "headers.set('X-CSRF-Token', getCsrfToken())")).toBe(3);
});

it('三处注入均有 MUTATING_METHODS 守卫（GET 默认不注入）', () => {
  expect(countOccurrences(SOURCE, 'MUTATING_METHODS.has(')).toBe(3);
});

it('调用方显式传入 X-CSRF-Token 时尊重不覆盖', () => {
  expect(countOccurrences(SOURCE, "!headers.has('X-CSRF-Token')")).toBe(3);
});

it('stream() 注入点位于其 fetch 之前', () => {
  const injectSite = SOURCE.indexOf('const streamMethod');
  expect(injectSite).toBeGreaterThan(-1);
  const fetchSite = SOURCE.indexOf('await fetch(url', injectSite);
  expect(fetchSite).toBeGreaterThan(injectSite);
});

it('raw() 未固定 method，默认 GET 不触发注入', () => {
  const injectSite = SOURCE.indexOf('const rawMethod = fetchOptions.method');
  expect(injectSite).toBeGreaterThan(-1);
  expect(
    SOURCE.slice(injectSite, injectSite + 60).includes("'GET'"),
  ).toBe(true);
});

// ============================================================
// 契约断言 —— 防误删守卫（双轨期只增不删）
// ============================================================

it('防误删：palink_token 直读（getToken）未被删除', () => {
  expect(SOURCE.indexOf("localStorage.getItem('palink_token')")).toBeGreaterThan(-1);
});

it('防误删：滑动续期写入 localStorage palink_token 未被删除', () => {
  expect(SOURCE.indexOf("localStorage.setItem('palink_token'")).toBeGreaterThan(-1);
});

it('防误删：applyTokenRefresh 与 401 派发逻辑未被删除', () => {
  expect(SOURCE.indexOf('function applyTokenRefresh')).toBeGreaterThan(-1);
  expect(SOURCE.indexOf('function dispatchAuthFailure')).toBeGreaterThan(-1);
  expect(countOccurrences(SOURCE, 'res.status === 401')).toBeGreaterThanOrEqual(2);
});

it('防误删：既有 Authorization Bearer 拼接全部保留（三通道）', () => {
  expect(countOccurrences(SOURCE, '`Bearer ${token}`')).toBe(3);
});

// ============================================================
// 运行
// ============================================================
let passed = 0;
let failed = 0;
for (const tc of _testCases) {
  try {
    tc.fn();
    passed += 1;
    console.log(`  ✓ PASS  ${tc.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ FAIL  ${tc.name}`);
    console.error(String(e));
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败 (共 ${_testCases.length})`);
if (failed > 0) process.exit(1);
