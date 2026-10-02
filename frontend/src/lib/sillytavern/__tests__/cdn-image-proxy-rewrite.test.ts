/**
 * [IMAGE-PROXY] 被阻断图床 <img> 改写回归（2026-09-27 用户报障：生态卡头像占位）。
 *
 * 生态卡把头像/CG 图库放在 jsDelivr，主域大陆网络被阻断。渲染层把正则渲染出的
 * <img src="https://cdn.jsdelivr.net/..."> 改写为后端图片代理。
 */
import { describe, expect, it } from 'vitest';

import { rewriteBlockedCdnImages } from '../formatting';

describe('rewriteBlockedCdnImages', () => {
  it('改写 jsDelivr 主域图片 URL 为后端代理', () => {
    const html = '<img src="https://cdn.jsdelivr.net/gh/u/r/avatar.png" alt="x">';
    const out = rewriteBlockedCdnImages(html);
    expect(out).toContain('/api/image-proxy?url=');
    expect(out).not.toContain('https://cdn.jsdelivr.net');
    expect(decodeURIComponent(out.match(/url=([^"]+)/)![1])).toBe(
      'https://cdn.jsdelivr.net/gh/u/r/avatar.png',
    );
  });

  it('子域（testingcf 等）一并改写', () => {
    const html = '<img src="https://testingcf.jsdelivr.net/gh/u/r/a.webp">';
    const out = rewriteBlockedCdnImages(html);
    expect(out).toContain('/api/image-proxy?url=');
    // src 属性不再直指原域名（改写后原 URL 只出现在编码参数里）
    expect(out).not.toContain('src="https://testingcf');
  });

  it('无 jsDelivr URL 时原样返回', () => {
    const html = '<img src="/api/uploads/local.png"><p>普通正文</p>';
    expect(rewriteBlockedCdnImages(html)).toBe(html);
  });

  it('空输入原样返回', () => {
    expect(rewriteBlockedCdnImages('')).toBe('');
  });

  it('多张图片全部改写', () => {
    const html =
      '<img src="https://cdn.jsdelivr.net/gh/u/r/a.png"><img src="https://fastly.jsdelivr.net/gh/u/r/b.jpg">';
    const out = rewriteBlockedCdnImages(html);
    expect((out.match(/\/api\/image-proxy\?url=/g) || []).length).toBe(2);
  });

  it('非图片的 jsDelivr 链接（JS/字体）不改写', () => {
    const html = '<a href="https://cdn.jsdelivr.net/npm/lib/index.js">lib</a>';
    expect(rewriteBlockedCdnImages(html)).toBe(html);
  });

  it('HTML 属性上下文中的 URL 也能改写（引号/无引号形态）', () => {
    const single = "<img src='https://cdn.jsdelivr.net/gh/u/r/a.png'>";
    expect(rewriteBlockedCdnImages(single)).toContain('/api/image-proxy?url=');
    const bare = '<img src=https://cdn.jsdelivr.net/gh/u/r/a.png>';
    expect(rewriteBlockedCdnImages(bare)).toContain('/api/image-proxy?url=');
  });
});
