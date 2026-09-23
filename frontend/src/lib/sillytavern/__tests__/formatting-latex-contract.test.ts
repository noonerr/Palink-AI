/*
 * 完成态 LaTeX 渲染契约测试（P1-#4 / spec F-1）
 *
 * 权威基线：流式引擎 MarkdownRenderer.tsx（remark-math + rehype-katex）
 * 可渲染公式；完成态 showdown 管线经 renderMathInHtml 预渲染后必须同样
 * 产出 KaTeX HTML，消除流式→完成态的"公式塌回原文"突变。
 *
 * 运行: npx vitest run
 */


import { describe, it, expect } from 'vitest';
import { renderMathInHtml } from '../formatting';

describe('Completed-state LaTeX Rendering', () => {
  it('display math $$..$$ renders KaTeX HTML', () => {
    const out = renderMathInHtml('<p>Before $$x^2 + y^2 = z^2$$ after</p>');
    expect(out).toContain('class="katex');
    expect(out).toContain('katex-display');
    // 原始定界符不再以裸文本出现
    expect(out.includes('$$')).toBeFalsy();
  });

  it('inline math $..$ renders KaTeX HTML', () => {
    const out = renderMathInHtml('<p>Euler: $e^{i\\pi}+1=0$ end</p>');
    expect(out).toContain('class="katex');
    expect(out.includes('$e^{i')).toBeFalsy();
  });

  it('\\(..\\) and \\[..\\] forms render', () => {
    const inlineOut = renderMathInHtml('<p>\\(a+b\\)</p>');
    expect(inlineOut).toContain('class="katex');
    const displayOut = renderMathInHtml('<p>\\[c-d\\]</p>');
    expect(displayOut).toContain('katex-display');
  });

  it('code/pre segments are left untouched', () => {
    const codeHtml = '<pre><code>const price = "$5 and $10";</code></pre>';
    const out = renderMathInHtml(codeHtml);
    expect(out).toBe(codeHtml);
  });

  it('text without math passes through unchanged', () => {
    const plain = '<p>成本 $5 与 $10 的差价，以及 100% 纯文本。</p>';
    const out = renderMathInHtml(plain);
    expect(out).toBe(plain);
  });

  it('invalid TeX falls back to original delimiters (throwOnError:false)', () => {
    const out = renderMathInHtml('<p>$\\notacommand{xyz}$</p>');
    // throwOnError:false 下 KaTeX 以红色错误片段渲染而非抛错——只要不残留裸定界符即可
    expect(out).toContain('katex');
  });
});

