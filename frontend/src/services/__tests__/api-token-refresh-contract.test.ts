/*
 * N-8 止血：滑动续期前端落地契约守卫。
 *
 * 锁定 services/api.ts 的源码契约：响应处理中必须检测
 * X-Palink-Token-Refresh 响应头并写入 localStorage 'palink_token'。
 * 任何整文件回退（同 formatting.ts 事故模式）立即红灯。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/services/__tests__/api-token-refresh-contract.test.ts
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
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(__dirname, '..', '..', 'services', 'api.ts'),
  'utf-8',
);

// ============================================================
// 契约断言
// ============================================================

it('检测 X-Palink-Token-Refresh 响应头', () => {
  expect(SOURCE.includes("res.headers.get('X-Palink-Token-Refresh')")).toBe(true);
});

it('命中头时写入 localStorage palink_token', () => {
  const detectSite = SOURCE.indexOf("X-Palink-Token-Refresh");
  expect(detectSite).toBeGreaterThan(-1);
  const setItemSite = SOURCE.indexOf("localStorage.setItem('palink_token'", detectSite);
  expect(setItemSite).toBeGreaterThan(detectSite);
});

it('续期落地位于统一 request() 的 fetch 之后、401 处理之前', () => {
  const applySite = SOURCE.indexOf('applyTokenRefresh(res);');
  expect(applySite).toBeGreaterThan(-1);
  const unauthorizedSite = SOURCE.indexOf("res.status === 401", applySite);
  expect(unauthorizedSite).toBeGreaterThan(applySite);
});

it('续期读取失败不阻断响应处理（try/catch 包裹）', () => {
  const fnSite = SOURCE.indexOf('function applyTokenRefresh');
  const bodyEnd = SOURCE.indexOf('\n}', fnSite);
  const body = SOURCE.slice(fnSite, bodyEnd);
  expect(body.includes('try {')).toBe(true);
  expect(body.includes('catch')).toBe(true);
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
