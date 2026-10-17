/**
 * 卡片样式守护（方案 A）契约测试
 *
 * 覆盖三件事：
 *   1) head 里的 <style> 被 removeChild 抽走 → 守护在 MO 回调里立刻补回；
 *   2) head 整体被 replaceWith 换掉、observer 失联 → 自愈定时器把缺失的
 *      <style> 补回新的 head；
 *   3) dispose() 后守护不再活动（idempotent + 清掉定时器）。
 *
 * ⚠️ 实测依据：把 <style> 整段内容以 outerHTML 形态存在 snapshot 字典里做精确比对；
 *    守护在补回时 cloneElement 用 <template>.content.firstElementChild，确保
 *    CSSRules / 内联文本不丢（直接 innerHTML 解析兜底）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installCardStyleGuard } from '../style-guard';

const flushMicrotasks = async () => {
  // Promise.resolve() + setTimeout(0) 一道把 MO 回调跑完
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

describe('installCardStyleGuard —— 卡片样式守护（方案 A）', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('A1: head 里的 <style> 被 removeChild 抽走 → 立即补回', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'card-1';
    styleEl.textContent = '.foo { color: red; }';
    document.head.appendChild(styleEl);

    const handle = installCardStyleGuard(document)!;
    expect(document.head.querySelectorAll('style').length).toBe(1);

    styleEl.remove();
    expect(document.head.querySelectorAll('style').length).toBe(0);

    await flushMicrotasks();
    expect(document.head.querySelectorAll('style').length).toBe(1);
    expect(document.head.querySelector('style')?.id).toBe('card-1');
    expect(document.head.querySelector('style')?.textContent).toContain('.foo');

    handle.dispose();
  });

  it('A2: <link rel="stylesheet"> 也受守护', async () => {
    const linkEl = document.createElement('link');
    linkEl.id = 'card-link-1';
    linkEl.setAttribute('rel', 'stylesheet');
    linkEl.setAttribute('href', 'https://example.com/x.css');
    document.head.appendChild(linkEl);

    const handle = installCardStyleGuard(document)!;
    expect(document.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(1);

    linkEl.remove();
    await flushMicrotasks();
    expect(document.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(1);
    expect(document.head.querySelector('link')?.id).toBe('card-link-1');

    handle.dispose();
  });

  it('A3: head 整体被 replaceWith 换掉、observer 失联 → 自愈定时器补回', async () => {
    vi.useFakeTimers();
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'card-2';
      styleEl.textContent = '.bar { color: blue; }';
      document.head.appendChild(styleEl);

      const handle = installCardStyleGuard(document)!;
      expect(document.head.querySelectorAll('style').length).toBe(1);

      // 整张 head 换掉（head.replaceWith）。旧 head 上的 MO 会随之失联。
      const newHead = document.createElement('head');
      document.documentElement.replaceChild(newHead, document.head);
      // 新 head 当前没东西
      expect(newHead.querySelectorAll('style').length).toBe(0);

      // 推进到 1s 自愈点
      vi.advanceTimersByTime(1100);
      expect(newHead.querySelectorAll('style').length).toBe(1);
      expect(newHead.querySelector('style')?.id).toBe('card-2');

      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('A4: dispose() 后守护不再活动、且幂等', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'card-3';
    document.head.appendChild(styleEl);

    const handle = installCardStyleGuard(document)!;
    handle.dispose();
    handle.dispose(); // 二次调用不抛

    // dispose 后 style 被抽走不会被补回
    styleEl.remove();
    await flushMicrotasks();
    expect(document.head.querySelectorAll('style').length).toBe(0);
  });

  it('A5: 没有任何 <style>/<link> 时返回 null（调用方保留旧守护）', () => {
    const handle = installCardStyleGuard(document)!;
    expect(installCardStyleGuard(document)).toBeNull();
  });

  it('A6: 守护只增不删，外部后加的 <style> 不会被回灌（快照基线）', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'card-4';
    document.head.appendChild(styleEl);

    const handle = installCardStyleGuard(document)!;
    // 守护后外部加的 style —— 不在快照里，不该被守护
    const externalStyle = document.createElement('style');
    externalStyle.id = 'card-4-external';
    document.head.appendChild(externalStyle);

    // 把原 snapshot 里的 style 删了
    styleEl.remove();
    await flushMicrotasks();
    // 原 style 被补回；外部的仍然在
    expect(document.head.querySelectorAll('style').length).toBe(2);
    expect(document.head.querySelector('#card-4')).toBeTruthy();
    expect(document.head.querySelector('#card-4-external')).toBeTruthy();

    // 删外部的——守护不该插手
    externalStyle.remove();
    await flushMicrotasks();
    expect(document.head.querySelectorAll('style').length).toBe(1);
    expect(document.head.querySelector('#card-4-external')).toBeNull();

    handle.dispose();
  });
});
