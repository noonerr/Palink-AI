import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RENDERER_SOURCE = readFileSync(join(__dirname, '..', '..', 'CharacterCardRenderer.tsx'), 'utf8');
const PART02_SOURCE = readFileSync(join(__dirname, '..', 'runtime-body', 'part-02.ts'), 'utf8');
const VENDOR_ASSET = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'public', 'dompurify.min.js'), 'utf8');
const CSP_CONF = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'security-headers.conf'), 'utf8');

/**
 * [API-6 2026-10-24] 帧内真 DOMPurify 契约：
 * 帧内（srcdoc, opaque origin）此前只有 part-02 的零消毒透传兜底
 * （sanitize = String(value)），卡经 SillyTavern.libs.DOMPurify 消毒
 * 不可信 HTML 时等于零保护。修复形态 = 父侧在两个帧模板的 shim 之前
 * 注入同域 vendor 脚本 + 兜底激活时一次性留痕。本测试钉住这四件事。
 */
describe('API-6 帧内真 DOMPurify', () => {
  it('vendor 资产在场：public/dompurify.min.js 是真库（体积+许可证标记）', () => {
    expect(VENDOR_ASSET.length).toBeGreaterThan(10_000);
    expect(VENDOR_ASSET).toContain('DOMPurify');
  });

  it('CSP 允许同域脚本（srcdoc 继承父页 CSP，script-src 必须含 self）', () => {
    const scriptSrc = /script-src[^;]*/.exec(CSP_CONF)?.[0] ?? '';
    expect(scriptSrc).toContain("'self'");
  });

  it('两个帧模板都在 shim 之前注入 vendor 标签（经典 script 按文档序先执行）', () => {
    const sites = RENDERER_SOURCE.split('\n').filter((line) => line.includes('${FRAME_DOMPURIFY_SCRIPT_TAG}'));
    expect(sites.length).toBe(2);
    for (const line of sites) {
      const tagAt = line.indexOf('${FRAME_DOMPURIFY_SCRIPT_TAG}');
      const shimAt = line.indexOf('${shim}');
      expect(shimAt).toBeGreaterThan(tagAt);
    }
    expect(RENDERER_SOURCE).toContain("'<script src=\"/dompurify.min.js\"></script>'");
  });

  it('part-02 兜底已改留痕形态：激活时一次性 console.warn 标记零消毒透传', () => {
    expect(PART02_SOURCE).toContain('domPurifyFallbackActive');
    expect(PART02_SOURCE).toContain('ZERO-sanitize passthrough');
    // 兜底仍必须是 window.DOMPurify 优先 —— vendor 脚本成功加载时用真库
    expect(PART02_SOURCE).toContain('window.DOMPurify ||');
  });
});
