/**
 * 帧内卡片样式自愈（STYLE-GUARD-INFRAME）契约测试
 *
 * 背景：未信任卡 iframe 是 opaque origin（sandbox 只给 allow-scripts），父页面
 * iframe.contentDocument === null ⇒ 父侧守护装不上。守护必须跑在帧内（运行时体里）。
 *
 * 本测试按「抽段 + new Function」在 jsdom 里跑**仓库中的真实源码区域**，覆盖：
 *   1) head 里的 <style> 被抽走 → MutationObserver 立刻补回；
 *   2) head 被整体 replaceWith → interval 自愈补回；
 *   3) 快照基线语义：快照之后外部新增的 <style> 不归守护管（删了不补）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/style-guard-inframe-contract.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// [包L 2026-10-18] 执行型测试（sliceIife + new Function）⇒ 用求值后载体，
// 未求值源码文本的模板转义语义与生产相反，会假绿。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';

/** 从 `(function xxx()` 起按花括号配平切出完整 IIFE（含尾部 )();）。 */
function sliceIife(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  expect(i).toBeGreaterThan(-1);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const tail = src.indexOf(')();', i);
  expect(tail, 'IIFE tail not found').toBeGreaterThan(-1);
  return src.slice(start, tail + 4);
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

function installGuardFromSource(): void {
  const region = sliceIife(SRC, '(function installCardStyleGuardInFrame()');
  // 帧内运行时体是纯 JS 文本；jsdom 环境里 document/window/MutationObserver 都是全局
  // eslint-disable-next-line no-new-func
  new Function(region)();
}

describe('STYLE-GUARD-INFRAME —— 帧内卡片样式自愈', () => {
  const disposeGuard = () => {
    try { (window as any).__palinkStyleGuardDispose?.(); } catch { /* ignore */ }
    delete (window as any).__palinkStyleGuardDispose;
  };

  beforeEach(() => {
    disposeGuard();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    // 清掉上一轮留下的观测面
    delete (window as any).__palinkStyleGuardSnapshot;
    delete (window as any).__palinkStyleGuardRestored;
    delete (window as any).__palinkStyleGuardLastAt;
  });

  afterEach(() => {
    disposeGuard();
    vi.useRealTimers();
  });

  it('源码层：运行时体里确实装了帧内守护（防删码回归）', () => {
    expect(SRC).toContain('installCardStyleGuardInFrame');
    expect(SRC).toContain('__palinkStyleGuardSnapshot');
    expect(SRC).toContain('DOMContentLoaded');
  });

  it('G1: <style> 被抽走 → MutationObserver 补回', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'inframe-1';
    styleEl.textContent = '.a { color: red; }';
    document.head.appendChild(styleEl);

    installGuardFromSource();
    expect(document.head.querySelectorAll('style').length).toBe(1);

    styleEl.remove();
    expect(document.head.querySelectorAll('style').length).toBe(0);

    await flushMicrotasks();
    expect(document.head.querySelectorAll('style').length).toBe(1);
    expect(document.head.querySelector('style')?.id).toBe('inframe-1');
    expect(document.head.querySelector('style')?.textContent).toContain('.a');
  });

  it('G2: head 整体 replaceWith → interval 自愈补回', async () => {
    vi.useFakeTimers();
    const styleEl = document.createElement('style');
    styleEl.id = 'inframe-2';
    styleEl.textContent = '.b { color: blue; }';
    document.head.appendChild(styleEl);

    installGuardFromSource();
    expect(document.head.querySelectorAll('style').length).toBe(1);

    const newHead = document.createElement('head');
    document.documentElement.replaceChild(newHead, document.head);
    expect(newHead.querySelectorAll('style').length).toBe(0);

    vi.advanceTimersByTime(800);
    expect(newHead.querySelectorAll('style').length).toBe(1);
    expect(newHead.querySelector('style')?.id).toBe('inframe-2');
  });

  it('G3: 快照之后外部新增的 <style> 不在守护范围（删了不补）', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'inframe-3';
    document.head.appendChild(styleEl);

    installGuardFromSource();

    const external = document.createElement('style');
    external.id = 'inframe-3-external';
    document.head.appendChild(external);

    // 快照内的被删 → 补回
    styleEl.remove();
    await flushMicrotasks();
    expect(document.head.querySelector('#inframe-3')).toBeTruthy();

    // 快照外（后加）的被删 → 不补
    external.remove();
    await flushMicrotasks();
    expect(document.head.querySelector('#inframe-3-external')).toBeNull();
  });

  it('G4: 快照为空（head 里没有 style）时不装守护', () => {
    installGuardFromSource();
    expect((window as any).__palinkStyleGuardSnapshot).toBeUndefined();
  });
});
