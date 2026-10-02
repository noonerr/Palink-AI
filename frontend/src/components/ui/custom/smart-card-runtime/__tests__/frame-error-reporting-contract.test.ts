/*
 * 帧错误上报契约守卫（P0 2026-09-30）
 *
 * 背景（HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md §2/§3）：卡内 iframe 抛出
 * `SyntaxError: Unexpected token '<'`（HTML 被当 JS 执行），但取证窗口里
 * window.__palinkFrameErrors 只有 message、没有出错资源 URL —— 因为：
 *   1. iframe 侧 legacy-st-sim 的 window.onerror 上报明明带 e.filename/e.lineno，
 *      父页面 CharacterCardRenderer 的收集器却把这两个字段丢弃；
 *   2. 资源加载失败（<script src> 拿到 404/HTML 页）被 shim 整体静默 return，
 *      SPA 兜底 / 跨站 404 页这类"HTML 冒充 JS"故障在父页面完全不可见。
 *
 * 本文件钉住三件事（都是文本级契约，风格同 event-contract.test.ts）：
 *   1. shim 段的 onerror 上报必须携带 filename/lineno；
 *   2. shim 段对 SCRIPT 资源失败必须连同 URL 上报 frame-error（isConnected 过滤噪音）；
 *   3. 父页面收集器必须把 data.filename/data.lineno 写进 __palinkFrameErrors 条目。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';

// vitest 固定以 frontend/ 为 cwd 运行（jsdom 下 import.meta.url 非 file:// 不可用）
const rendererSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
  'utf8',
);

describe('帧错误上报契约（P0 2026-09-30）', () => {
  it('shim onerror 上报必须携带 filename 与 lineno（父页面据此定位出错脚本 URL）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain("filename: e && e.filename, lineno: e && e.lineno");
  });

  it('SCRIPT 资源加载失败必须连同 URL 上报 frame-error，不得静默 return', () => {
    // 资源失败分支里必须有 SCRIPT 特判 + isConnected 噪音过滤 + 带URL的 frame-error 上报
    const resourceBranch = LEGACY_ST_SIM_SEGMENT.match(
      /e\.target !== window && \(e\.target\.src \|\| e\.target\.href\)\)[\s\S]{0,2400}?return;/,
    );
    expect(resourceBranch).toBeTruthy();
    const branch = resourceBranch![0];
    expect(branch).toContain("'SCRIPT'");
    expect(branch).toContain('isConnected');
    expect(branch).toContain("type: 'frame-error'");
    expect(branch).toContain('failedUrl');
  });

  it('SCRIPT 上报的 message 必须含 URL（HTML-as-JS 嫌疑标记）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain('HTML-as-JS suspect');
  });

  it('父页面收集器必须透传 filename/lineno 到 __palinkFrameErrors 条目', () => {
    expect(rendererSource).toContain('filename: data.filename, lineno: data.lineno');
  });
});
