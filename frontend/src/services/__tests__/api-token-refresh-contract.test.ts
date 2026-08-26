/*
 * N8-c 终态契约守卫：滑动续期前端落地已整体退役。
 *
 * 新不变式（N8-c）：前端不再消费 X-Palink-Token-Refresh 响应头，也不再把
 * 任何凭据写入 localStorage 'palink_token'。滑动续期已由服务端续期中间件
 * 直接 Set-Cookie 覆盖 palink_session（HttpOnly），前端无 JS 侧工作。
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
// 契约断言 —— N8-c 终态：续期前端落地退役
// ============================================================

it('终态：applyTokenRefresh 函数已删除', () => {
  expect(SOURCE.indexOf('function applyTokenRefresh')).toBe(-1);
});

it('终态：request() 不再调用 applyTokenRefresh', () => {
  expect(SOURCE.indexOf('applyTokenRefresh(res);')).toBe(-1);
});

it('终态：不再读取/消费 X-Palink-Token-Refresh 响应头', () => {
  expect(SOURCE.indexOf('X-Palink-Token-Refresh')).toBe(-1);
});

it('终态：不再向 localStorage 写入 palink_token 凭据', () => {
  expect(SOURCE.indexOf("localStorage.setItem('palink_token'")).toBe(-1);
});

it('终态：服务端续期走 Cookie 通道，api.ts 无 JS 侧凭据读写', () => {
  expect(SOURCE.indexOf('palink_token')).toBe(-1);
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
