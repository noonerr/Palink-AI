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
    // 包J J-1：登记口与追加计数也是上一轮闭包的残留，必须清干净
    delete (window as any).__palinkStyleGuardAddNode;
    delete (window as any).__palinkStyleGuardPluginCss;
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

  // ===== 包J J-1：插件 CSS 晚于快照登场，守护必须认得它 =====
  // 真机病灶（包E §4 F-1）：露缇雅帧内 t6 有 8 条 style（3 条基样式 + 5 条 Palink 插件 CSS），
  // 卡侧外部 bundle 在 6–14s 内用 head.innerHTML 整体重写 → 只剩 3 条基样式，
  // 5 条插件 CSS（含 44KB 的 Quick Replies）永久丢失 —— 因为守护的快照先到先得只拍一次，
  // 而插件 CSS 是等父侧 postMessage 之后才异步注入的，压根不在快照里。
  const PLUGIN_IDS = ['translation', 'regex', 'summarize', 'quick-replies', 'token-counter'];

  const addBaseStyle = (seq: number) => {
    const el = document.createElement('style');
    el.id = 'j1-base-' + seq;
    el.textContent = '.j1-base-' + seq + ' { color: red; }';
    document.head.appendChild(el);
    return el;
  };

  /** 复刻 part-01 injectStPluginCssCompat 的收尾动作：append 完就向守护登记该节点。 */
  const injectPluginStyle = (name: string, css: string) => {
    const el = document.createElement('style');
    el.id = 'palink-st-plugin-css-' + name + '-0';
    el.setAttribute('data-palink-st-plugin', name);
    el.textContent = css;
    document.head.appendChild(el);
    if (typeof (window as any).__palinkStyleGuardAddNode === 'function') {
      (window as any).__palinkStyleGuardAddNode(el);
    }
    return el;
  };

  it('G5: 快照后异步注入 5 条插件 CSS → head.innerHTML 重写 → 8 条全部回来，Snapshot = 8', async () => {
    addBaseStyle(1); addBaseStyle(2); addBaseStyle(3);
    installGuardFromSource();
    expect((window as any).__palinkStyleGuardSnapshot).toBe(3);

    PLUGIN_IDS.forEach((name) => injectPluginStyle(name, '.j1-' + name + ' { color: blue; }'));
    expect(document.head.querySelectorAll('style').length).toBe(8);
    expect((window as any).__palinkStyleGuardSnapshot).toBe(8);

    // 卡侧重写 head（包E 实测这条路径不经过 removeChild / remove，monkey-patch 捕获为 0）
    document.head.innerHTML = '';
    expect(document.head.querySelectorAll('style').length).toBe(0);

    await flushMicrotasks();
    const survivors = Array.from(document.head.querySelectorAll('style'));
    const back = survivors.map((el) => el.id).sort();
    expect(back).toEqual([
      'j1-base-1', 'j1-base-2', 'j1-base-3',
      ...PLUGIN_IDS.map((name) => 'palink-st-plugin-css-' + name + '-0'),
    ].sort());
    // 插件 CSS 的样式内容也得真回来，不是只回来一个空壳
    expect(document.querySelector('#palink-st-plugin-css-quick-replies-0')?.textContent)
      .toContain('.j1-quick-replies');
    expect((window as any).__palinkStyleGuardRestored).toBeGreaterThanOrEqual(8);
    expect((window as any).__palinkStyleGuardSnapshot).toBe(8);
    expect((window as any).__palinkStyleGuardPluginCss).toBe(PLUGIN_IDS.length);
  });

  it('G6 反向断言: 卡侧自己塞进 head 的样式不得被当成基线补回来', async () => {
    addBaseStyle(11);
    installGuardFromSource();
    injectPluginStyle('regex', '.j1-regex { color: green; }');
    expect((window as any).__palinkStyleGuardSnapshot).toBe(2);

    // 卡侧运行时往 head 里加的动态样式：从未经守护登记
    const cardSide = document.createElement('style');
    cardSide.id = 'j1-card-side-dynamic';
    cardSide.textContent = '.mvu-dyn { color: hotpink; }';
    document.head.appendChild(cardSide);
    expect((window as any).__palinkStyleGuardSnapshot).toBe(2);

    document.head.innerHTML = '';
    await flushMicrotasks();
    const back = Array.from(document.head.querySelectorAll('style')).map((el) => el.id).sort();
    expect(back).toEqual(['j1-base-11', 'palink-st-plugin-css-regex-0']);
    expect(document.getElementById('j1-card-side-dynamic')).toBeNull();
  });

  it('G7: 同一节点重复登记不重复计数；守护未初始化时登记口缺席不影响注入', () => {
    addBaseStyle(21);
    // 守护还没装：part-01 的调用点是 typeof 判定后调用，这里复刻该守卫 ⇒ 不抛错
    expect(typeof (window as any).__palinkStyleGuardAddNode).not.toBe('function');
    expect(() => injectPluginStyle('translation', '.j1-t { color: white; }')).not.toThrow();
    expect(document.getElementById('palink-st-plugin-css-translation-0')).toBeTruthy();

    installGuardFromSource();
    const again = injectPluginStyle('translation', '.j1-t { color: white; }');
    expect((window as any).__palinkStyleGuardSnapshot).toBe(2);
    // 重复登记同一个节点：幂等，不再加计数
    (window as any).__palinkStyleGuardAddNode(again);
    (window as any).__palinkStyleGuardAddNode(again);
    expect((window as any).__palinkStyleGuardSnapshot).toBe(2);
    // 传空值不许抛错
    expect(() => (window as any).__palinkStyleGuardAddNode(null)).not.toThrow();
    expect(() => (window as any).__palinkStyleGuardAddNode(undefined)).not.toThrow();
  });

  it('G8 源码层：插件 CSS 注入点确实接在守护登记口上（跨 part 接缝防删码）', () => {
    // 注入侧（part-01）与守护侧（part-08）在同一个求值后产物里，两边都在才算接上
    expect(SRC).toContain('const injectStPluginCssCompat = () => {');
    expect(SRC).toContain("typeof window.__palinkStyleGuardAddNode === 'function'");
    expect(SRC).toContain('window.__palinkStyleGuardAddNode = styleGuardAddNode;');
    // 禁止倒退：不许有人把「追加」改成「重拍快照」（重拍会把卡侧样式吸进基线 = 守护失效）。
    // 拍快照的动作在产物里必须只有一处调用点。
    const shootCalls = (SRC.match(/takeStyleSnapshot\(\)/g) || []).length;
    expect(shootCalls, 'takeStyleSnapshot 的调用点应当只有守护启动那一处').toBe(2); // 1 定义 + 1 调用
  });
});
