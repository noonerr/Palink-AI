/*
 * N-7 契约测试：附件 URL 去主 JWT 化。
 *
 * spec: docs/SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md §2
 * 守卫点：
 * 1. bareUploadHref（<a href> 的唯一取值来源）对任意输入的产物
 *    永不包含 "token=" 子串（正则断言）；
 * 2. stripUploadToken 能剥离历史遗留的 token= query 参数；
 * 3. isUploadPath 分类正确（/api/uploads/ 与 /uploads/）；
 * 4. getUploadUrl 非上传路径原样透传；上传路径在令牌不可用时退回
 *    裸路径（不抛错、不带任何 token）；
 * 5. 源码契约：MarkdownRenderer.tsx 不再引用 appendUploadToken，
 *    锚点 href 取值走 bareUploadHref。
 *
 * 运行: npx vitest run
 */


import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bareUploadHref,
  getUploadUrl,
  isUploadPath,
  stripUploadToken,
} from '../uploadUrls';

describe('N-7 stripUploadToken', () => {
  it('剥离唯一 token 参数', () => {
    expect(stripUploadToken('/uploads/1/a.png?token=ABC')).toBe('/uploads/1/a.png');
  });
  it('多参数时仅剔除 token', () => {
    expect(stripUploadToken('/api/uploads/x.png?v=2&token=ABC&download=1')).toBe(
      '/api/uploads/x.png?v=2&download=1',
    );
  });
  it('无 query 时原样返回', () => {
    expect(stripUploadToken('/uploads/plain.png')).toBe('/uploads/plain.png');
  });
});

describe('N-7 isUploadPath', () => {
  it('识别两种前缀', () => {
    expect(isUploadPath('/uploads/a.png')).toBe(true);
    expect(isUploadPath('/api/uploads/a.png')).toBe(true);
    expect(isUploadPath('https://example.com/a.png')).toBe(false);
    expect(isUploadPath('')).toBe(false);
  });
});

describe('N-7 <a href> 断言：上传路径产物永不携带 token=', () => {
  const TOKENED_UPLOAD_INPUTS = [
    '/uploads/u1/img.png?token=MAIN.JWT.LEAK',
    '/api/uploads/generated/x.webp?token=MAIN.JWT.LEAK',
    '/uploads/u1/img.png',
    '',
  ];
  for (const input of TOKENED_UPLOAD_INPUTS) {
    it(`bareUploadHref(${JSON.stringify(input)}) 无 token=`, () => {
      const href = bareUploadHref(input);
      expect(href).not.toMatch(/token=/);
    });
  }
  it('外部 URL 不被改写', () => {
    expect(bareUploadHref('https://example.com/pic.png?token=EXTERNAL')).toBe(
      'https://example.com/pic.png?token=EXTERNAL',
    );
  });
  it('上传路径回退为裸路径', () => {
    expect(bareUploadHref('/uploads/u1/img.png?token=MAIN.JWT.LEAK')).toBe(
      '/uploads/u1/img.png',
    );
  });
});

describe('N-7 getUploadUrl 异步行为', () => {
  it('非上传路径原样透传（不触发取令牌）', async () => {
    const url = 'https://cdn.example.com/pic.png';
    expect(await getUploadUrl(url)).toBe(url);
  });
  it('令牌不可用时上传路径退回裸路径且无 token=', async () => {
    // tsx 环境下 api.post 必然失败 → .catch 回退裸路径
    const url = await getUploadUrl('/uploads/u1/img.png?token=OLD');
    expect(url).toBe('/uploads/u1/img.png');
    expect(url).not.toMatch(/token=/);
  });
});

describe('N-7 MarkdownRenderer 源码契约', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../components/ui/custom/MarkdownRenderer.tsx',
    ),
    'utf-8',
  );
  it('不再引用 appendUploadToken', () => {
    expect(source.includes('appendUploadToken')).toBe(false);
  });
  it('锚点 href 走 bareUploadHref', () => {
    expect(source.includes('bareUploadHref(href)')).toBeTruthy();
  });
  it('图片渲染走异步短令牌解析', () => {
    expect(source.includes('AsyncMarkdownImage')).toBeTruthy();
  });
});

