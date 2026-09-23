/*
 * F-1 LaTeX 完成态渲染回归守卫。
 *
 * 背景：renderMathInHtml + KaTeX MathML DOMPurify 白名单曾两次被其他批次
 * 以"整文件按旧版覆写"的方式静默回退（2026-08-24 两次拦截）。本测试锁定
 * 该修复的源码契约，任何回退立即红灯。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


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

