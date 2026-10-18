/**
 * [包I I-2 2026-10-18] 帧内全局 error / unhandledrejection 的「资源加载失败」分流。
 *
 * 实拍缺陷（REPORT_真实角色卡兼容性实测_酒馆助手卡_2026-10-18 §6）：露缇雅帧里死外链
 * https://drive.baibai.cv/f/ZKEBuW/Music.js 加载失败，reason 是 Event 形态，
 * 原路径 unhandled_rejection → reportDiagnostic → 宿主 toast.warning
 * ⇒ 主页冒「error @ …Music.js」的 Sonner toast。ST 对这类失败只落 console。
 * ⚠️ 包G 之后 SillyTavern.libs 是 18 个 jsdelivr CDN 懒加载 ⇒ 这类失败只会更常见。
 *
 * 钉住三件事：
 *   A. 资源加载失败（Event 形态 reason / target 是带 src|href 的资源元素）
 *      ⇒ console+cardErrorLog（logCardError）+ frame-error 取证，**不进 reportDiagnostic**；
 *   B. 真脚本错误（TypeError / ReferenceError / rejection reason 是 Error）
 *      ⇒ 走原路径进 reportDiagnostic，取证消息形状与 severity 一字不改；
 *   C. 不许一刀切：分类函数只认资源元素，其他一律判 false。
 *
 * 求值方式：与 g-getcontext-and-libs-contract.test.ts 同一做法 —— 从**运行时产物文本**
 * （模板字符串求值后的 RUNTIME_BODY_PART_08）按 marker 切出真实源码，
 * new Function 注入依赖（window / logCardError / reportDiagnostic 等夹具）后执行。
 * 断言的依旧是仓库里那份原文，不是重写副本。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/i-resource-load-failure-contract.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RUNTIME_BODY_PART_08 as PART } from '../runtime-body/part-08';
import { COMPAT_V2_RUNTIME_SOURCE as SRC } from './compat-v2-runtime-source';

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found after start: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** 分类 helper 区（含 var PALINK_RESOURCE_ERROR_TAGS … 到 STYLE-GUARD 注释前）。 */
const HELPERS = slice(PART, 'var PALINK_RESOURCE_ERROR_TAGS', '// [STYLE-GUARD-INFRAME');
/** 两个全局 handler 的注册段（window error + unhandledrejection）。 */
const LISTENERS = slice(PART, "window.addEventListener('error', (event) => {", '\n  setTimeout(() => {');

interface HarnessWindow {
  addEventListener: (type: string, handler: (event: any) => void) => void;
  parent: { postMessage: (payload: unknown, target: string) => void };
  handlers: Record<string, Array<(event: any) => void>>;
}

function buildHarness() {
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const posted: any[] = [];
  const diags: any[] = [];
  const logged: any[] = [];
  const fakeWindow: HarnessWindow = {
    addEventListener: (type: string, handler: (event: any) => void) => {
      handlers[type] = handlers[type] || [];
      handlers[type].push(handler);
    },
    parent: { postMessage: (payload: unknown) => { posted.push(payload); } },
    handlers,
  };
  // helper 里用到的 logCardError / frameId 由闭包参数注入；formatXxx 两个
  // 是 part-08 同段既有函数，这里用真实源码切片一并求值，避免手抄副本。
  const FORMAT_FNS = slice(PART, 'const formatWindowErrorMessage', '  // [包I I-2 2026-10-18]');
  const factory = new Function(
    'window',
    'logCardError',
    'reportDiagnostic',
    'frameId',
    'uiText',
    `${FORMAT_FNS}\n${HELPERS}\n${LISTENERS}\nreturn { classify: palinkResourceFailureFrom };`,
  );
  const api = factory(
    fakeWindow,
    (label: string, message: string, stack: string) => { logged.push({ label, message, stack }); },
    (diagnostic: any) => { diags.push(diagnostic); },
    'frame-abcdef1234',
    { unknownError: 'unknown error', unhandledRejection: 'unhandled rejection' },
  );
  return { api, handlers, posted, diags, logged };
}

function makeResourceElement(tagName: string, url: string): any {
  const el: any = { tagName };
  if (tagName.toUpperCase() === 'LINK') el.href = url;
  else el.src = url;
  return el;
}

describe('I-2 资源加载失败分流（part-08 两个全局 handler）', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    h = buildHarness();
  });

  it('A1. unhandledrejection 的 reason 是 Event 形态（target=死链 script）⇒ 不弹 toast，但留取证', () => {
    const script = makeResourceElement('SCRIPT', 'https://drive.baibai.cv/f/ZKEBuW/Music.js');
    const reason = { type: 'error', target: script };

    h.handlers.unhandledrejection[0]({ reason });

    expect(h.diags, '资源加载失败不得进入 reportDiagnostic（否则主页弹 toast）').toEqual([]);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0].label).toContain('资源加载失败');
    expect(h.logged[0].message).toContain('resource_load_failed[unhandled_rejection]');
    expect(h.logged[0].message).toContain('https://drive.baibai.cv/f/ZKEBuW/Music.js');

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({
      source: 'palink-smart-card-frame',
      type: 'frame-error',
      frameId: 'frame-abcdef1234',
      filename: 'https://drive.baibai.cv/f/ZKEBuW/Music.js',
    });
  });

  it('A2. 资源元素直挂 reason / srcElement / currentTarget 三种写法都算资源失败', () => {
    const img = makeResourceElement('IMG', 'https://cdn.example/missing.png');
    h.handlers.unhandledrejection[0]({ reason: img });
    h.handlers.unhandledrejection[0]({ reason: { type: 'error', srcElement: img } });
    h.handlers.unhandledrejection[0]({ reason: { type: 'error', currentTarget: img } });

    expect(h.diags).toEqual([]);
    expect(h.logged).toHaveLength(3);

    const link = makeResourceElement('LINK', 'https://cdn.example/gone.css');
    h.handlers.error[0]({ target: link });
    expect(h.diags.filter((d) => d.code === 'unhandled_rejection')).toEqual([]);
    expect(h.logged[3].message).toContain('resource_load_failed[window_error]');
  });

  it('A3. window error 的资源加载失败 ⇒ 分流；真脚本错误 ⇒ 原路径 severity/code 不变', () => {
    // 资源：IMG 带 src，event.target 命中
    h.handlers.error[0]({ target: makeResourceElement('IMG', 'https://cdn.example/a.png'), message: 'error' });
    expect(h.diags).toEqual([]);
    expect(h.logged[0].message).toContain('resource_load_failed[window_error] IMG');

    // 真脚本错误：target 是 window（无 tagName），message 带 ReferenceError
    h.handlers.error[0]({
      target: {},
      message: 'ReferenceError: foo is not defined',
      filename: 'panel.js',
      lineno: 12,
      colno: 3,
      error: { stack: 'ReferenceError: foo is not defined\n at panel.js:12:3' },
    });
    expect(h.diags).toHaveLength(1);
    expect(h.diags[0]).toMatchObject({
      code: 'undefined_global',
      severity: 'warning',
      apiName: 'foo',
    });
    expect(h.diags[0].message).toContain('panel.js:12:3');

    // TypeError（非 ReferenceError）⇒ 仍 error + script_error
    h.handlers.error[0]({
      target: {},
      message: "TypeError: Cannot read properties of undefined (reading 'x')",
      filename: 'panel.js',
      lineno: 40,
      colno: 8,
      error: { stack: '' },
    });
    expect(h.diags).toHaveLength(2);
    expect(h.diags[1]).toMatchObject({ code: 'script_error', severity: 'error' });
  });

  it('B. 非 Event 形态的 rejection（reason 是 Error）必须进 reportDiagnostic', () => {
    const error: any = new Error('boom in card script');
    error.stack = 'Error: boom in card script\n at panel.js:7:1';
    h.handlers.unhandledrejection[0]({ reason: error });

    expect(h.diags).toHaveLength(1);
    expect(h.diags[0]).toMatchObject({ severity: 'error', code: 'unhandled_rejection' });
    expect(h.diags[0].message).toBe('boom in card script');
    expect(h.posted).toEqual([]);
  });

  it('C. 反证「一刀切吞掉所有 error」：分类函数对非资源形态一律判 false', () => {
    expect(h.api.classify(undefined)).toBe(null);
    expect(h.api.classify('error')).toBe(null);
    expect(h.api.classify(new Error('boom'))).toBe(null);
    expect(h.api.classify({ type: 'error' })).toBe(null);
    expect(h.api.classify({ message: 'boom', stack: 'x' })).toBe(null);
    // 资源元素但取不到 src/href（例如 inline script 自己的 error）⇒ 不算资源失败
    expect(h.api.classify({ tagName: 'SCRIPT' })).toBe(null);
    // 非资源标签带 src ⇒ 也不算
    expect(h.api.classify({ tagName: 'DIV', src: 'x.png' })).toBe(null);
    // Event 形态但 target 不是资源元素（ST 插件自己 dispatch 的事件）⇒ 仍要弹 toast
    expect(h.api.classify({ type: 'error', target: { tagName: 'DIV' } })).toBe(null);

    // 两个 handler 里 reportDiagnostic 仍在（不是被 return 掉所有分支）
    expect(LISTENERS).toContain('reportDiagnostic({');
    expect(LISTENERS.match(/reportDiagnostic\(\{/g)).toHaveLength(2);
    expect(LISTENERS.match(/resource_load_failed/g)).toBeNull();
    expect(SRC).toContain("window.addEventListener('unhandledrejection', (event) => {");
  });

  it('C+. 取证通道用的是 frame-error 而不是 diagnostic：父侧 __palinkFrameErrors 只认这个形状', () => {
    h.handlers.error[0]({ target: makeResourceElement('SCRIPT', 'https://cdn.example/x.js') });
    const payload = h.posted[0];
    expect(payload.source).toBe('palink-smart-card-frame');
    expect(payload.type).toBe('frame-error');
    // CharacterCardRenderer.tsx:896 的过滤条件（source + type + frameId 三项齐备）
    expect(typeof payload.frameId).toBe('string');
    expect(typeof payload.message).toBe('string');
    expect(typeof payload.filename).toBe('string');
    expect(typeof payload.lineno).toBe('number');
    expect(h.diags).toEqual([]);
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
  });
});
