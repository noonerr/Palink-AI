/*
 * F-1 LaTeX 完成态渲染回归守卫。
 *
 * 背景：renderMathInHtml + KaTeX MathML DOMPurify 白名单曾两次被其他批次
 * 以"整文件按旧版覆写"的方式静默回退（2026-08-24 两次拦截）。本测试锁定
 * 该修复的源码契约，任何回退立即红灯。
 *
 * 运行: npx tsx --import ./src/lib/sillytavern/__tests__/_tsx-loader.mjs src/lib/__tests__/formatting-katex-contract.test.ts
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
  join(__dirname, '..', 'sillytavern', 'formatting.ts'),
  'utf-8',
);

// ============================================================
// 契约断言
// ============================================================

it('exports renderMathInHtml (完成态 KaTeX 预渲染)', () => {
  expect(SOURCE.includes('export function renderMathInHtml')).toBe(true);
  expect(SOURCE.includes("from 'katex'")).toBe(true);
});

it('DOMPurify whitelist keeps KaTeX MathML tags/attrs', () => {
  expect(SOURCE.includes("'math'")).toBe(true);
  expect(SOURCE.includes("'semantics'")).toBe(true);
  expect(SOURCE.includes("'annotation-xml'")).toBe(true);
  expect(SOURCE.includes("'mathvariant'")).toBe(true);
  expect(SOURCE.includes("'katex-'")).toBe(true);
});

it('completion pipeline invokes renderMathInHtml before sanitize', () => {
  const callSite = SOURCE.indexOf('mes = renderMathInHtml(mes);');
  expect(callSite).toBeGreaterThan(-1);
  const purifySite = SOURCE.indexOf('DOMPurify.sanitize(', callSite);
  expect(purifySite).toBeGreaterThan(callSite);
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
