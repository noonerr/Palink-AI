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

describe('帧错误上报契约（P0 2026-09-30 · 包N K-4 取证增强 2026-10-19）', () => {
  it('shim onerror 上报必须携带 filename/lineno/colno 与 kind（父页面据此归因，不再空串）', () => {
    // 包N K-4：detail 走 palinkFrameErrorDetail（永远非空），并透出 colno / errorReason / kind。
    expect(LEGACY_ST_SIM_SEGMENT).toContain('filename: palinkFrameErrorFilename(e)');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('colno: palinkFrameErrorNumber(e && e.colno)');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('kind: \'script_error\'');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('errorReason: palinkFrameErrorReason(e && e.error)');
  });

  it('包N K-4：message 兜底分支不得再用裸空串或 unknown error 交差', () => {
    // 取不到原文时明写缺失原因（非空、可 grep 的标记），且旧病灶写 || 'unknown error' 必须消失。
    expect(LEGACY_ST_SIM_SEGMENT).toContain('PALINK_FRAME_ERR_MSG_MISSING');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('message_unavailable');
    expect(LEGACY_ST_SIM_SEGMENT).not.toContain("|| 'unknown error'");
    // filename 缺省给显式标记，不写空串
    expect(LEGACY_ST_SIM_SEGMENT).toContain("'<filename-absent>'");
  });

  it('包N K-4：unhandledrejection 上报必须带非空 detail + filename 缺失标记 + kind', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain('kind: \'unhandled_rejection\'');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('palinkRejectionDetail(rejReason)');
    expect(LEGACY_ST_SIM_SEGMENT).toContain("'<promise-rejection-no-filename>'");
    // 旧病灶写法 e.reason && (e.reason.stack || e.reason) 可能落空串/对象，必须消失
    expect(LEGACY_ST_SIM_SEGMENT).not.toContain('message: e.reason && (e.reason.stack || e.reason)');
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
    // 包N K-4：资源失败也补 kind + colno
    expect(branch).toContain("kind: 'script_resource_failed'");
    expect(branch).toContain('colno: 0');
  });

  it('SCRIPT 上报的 message 必须含 URL（HTML-as-JS 嫌疑标记）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain('HTML-as-JS suspect');
  });

  it('父页面收集器必须透传 filename/lineno/colno/kind 到 __palinkFrameErrors 条目', () => {
    // 包N K-4：父侧不再只留 message，colno / kind / errorReason 一并入观测面
    expect(rendererSource).toContain('filename: (typeof data.filename');
    expect(rendererSource).toContain('colno: typeof data.colno');
    expect(rendererSource).toContain('kind: typeof data.kind');
    expect(rendererSource).toContain('errorReason: typeof data.errorReason');
    // 兜底非空 message，绝不再以空串入表
    expect(rendererSource).toContain("message_unavailable: 帧内上报未携带可读 message");
  });
});

// [包N K-4 2026-10-19] 行为断言（求值后载体）：LEGACY_ST_SIM_SEGMENT 本身就是模板求值后的产物，
// 从它里面切出这五个 helper 交给 new Function 真跑，断言「脱敏错误也得产出非空、可归因的取证」，
// 而不是拿源码里有没有某个字面量当证据。入参只来自本仓构建产物 + 合成 ErrorEvent，无外部/用户数据。
describe('帧错误上报行为契约（包N K-4 · 求值后载体）', () => {
  function sliceHelpers(): string {
    const start = LEGACY_ST_SIM_SEGMENT.indexOf('var PALINK_FRAME_ERR_MSG_MISSING');
    const end = LEGACY_ST_SIM_SEGMENT.indexOf('// [STATUSBAR-DEBUG]', start);
    expect(start, 'helper 区起点未找到').toBeGreaterThan(-1);
    expect(end, 'helper 区终点未找到').toBeGreaterThan(start);
    return LEGACY_ST_SIM_SEGMENT.slice(start, end);
  }

  // eslint-disable-next-line no-new-func
  const helpers = new Function(
    sliceHelpers() +
      '\nreturn { detail: palinkFrameErrorDetail, file: palinkFrameErrorFilename, num: palinkFrameErrorNumber, reason: palinkFrameErrorReason, reject: palinkRejectionDetail };',
  )() as {
    detail: (e: unknown) => string;
    file: (e: unknown) => string;
    num: (v: unknown) => number;
    reason: (o: unknown) => string;
    reject: (r: unknown) => string;
  };

  it('脱敏错误（message 空、error null、filename 空）必须给非空 message + 显式缺失标记', () => {
    const sanitized = { message: '', error: null, filename: '', lineno: 0, colno: 0 };
    const msg = helpers.detail(sanitized);
    expect(msg.length, 'message 不得为空串').toBeGreaterThan(0);
    expect(msg).not.toBe('unknown error');
    expect(msg).toContain('message_unavailable');
    expect(helpers.file(sanitized)).toBe('<filename-absent>');
    // 缺失时 lineno/colno 用 -1 明写"取不到"，不是静默 0
    expect(helpers.num(undefined)).toBe(-1);
    expect(helpers.reason(null)).toBe('<no-error-object>');
  });

  it('有原文时用原文；有 filename 时 detail 带位置线索', () => {
    expect(helpers.detail({ message: 'ReferenceError: x is not defined' }))
      .toBe('ReferenceError: x is not defined');
    const located = helpers.detail({ message: '', error: null, filename: 'panel.js', lineno: 7, colno: 3 });
    expect(located).toContain('panel.js:7:3');
    expect(helpers.file({ filename: 'panel.js' })).toBe('panel.js');
    expect(helpers.num(12)).toBe(12);
    expect(helpers.reason({ name: 'TypeError' })).toBe('TypeError');
  });

  it('rejection：Error 用 name+message；对象/字符串取不到时给非空可读标记', () => {
    expect(helpers.reject({ name: 'TypeError', message: 'Failed to fetch' })).toBe('TypeError: Failed to fetch');
    expect(helpers.reject({ stack: 'TypeError: boom\n at x' })).toContain('boom');
    const opaque = helpers.reject({});
    expect(opaque.length).toBeGreaterThan(0);
    expect(opaque).toContain('rejection_reason_unreadable');
    expect(helpers.reject('plain string')).toBe('plain string');
  });
});
