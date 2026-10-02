/*
 * KaTeX 数学渲染不得进入 <script>/<style> 的守卫（P0 2026-09-30）
 *
 * 背景（HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md 实锤根因）：
 * formatMessage 的完成态 LaTeX 渲染（renderMathInHtml）此前只保护 <pre>/<code>。
 * regex_scripts 状态栏卡片的 <script type="module"> 里满是 jQuery 代码，
 * `$('#lia-date').text(...)` 与 `$('#lia-time')` 之间的代码被
 * INLINE_MATH_HTML_REGEX 当成行内公式 `$...$`，KaTeX 解析失败后整段替换成
 * <span class="katex-error">——脚本文本混入 '<'，注入 iframe 后抛
 * SyntaxError: Unexpected token '<'，面板脚本永不执行，
 * 用户侧表现为角色面板/立绘/故事正文整页空白。
 *
 * 本文件钉住：renderMathInHtml 必须原样保留 <script>/<style> 内部内容；
 * script 之外的公式渲染行为不受影响（正向对照）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { renderMathInHtml } from '../formatting';

describe('renderMathInHtml 的 script/style 保护（P0 2026-09-30）', () => {
  it('jQuery 代码中的 $ 配对不得被当成行内公式吃掉', () => {
    const html = '<div><script type="module">'
      + "const year = 1; $('#lia-date').text(`${year}年`); const t = $('#lia-time');"
      + '</script></div>';
    expect(renderMathInHtml(html)).toBe(html);
  });

  it('style 块内容同样原样保留', () => {
    const html = '<style>.a { content: "$x$ and $y$"; }</style>';
    expect(renderMathInHtml(html)).toBe(html);
  });

  it('script 之外的行内公式仍正常渲染（正向对照，守卫不恒真）', () => {
    const html = '<p>$x^2$</p><script>$("#a")</script>';
    const out = renderMathInHtml(html);
    expect(out).toContain('katex');
    expect(out).toContain('<script>$("#a")</script>');
  });

  it('跨行 $ 不会与 script 内的 $ 配对', () => {
    const html = '<p>价格 $5 和\n$10</p><script>$("#x").text("y");</script>';
    const out = renderMathInHtml(html);
    expect(out).toContain('<script>$("#x").text("y");</script>');
  });
});
