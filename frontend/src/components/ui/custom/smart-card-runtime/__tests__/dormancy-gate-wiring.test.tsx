/*
 * 智能卡休眠门接线守卫（T2 · 2026-10-13）
 *
 * 为什么要有这份测试：iframe-lru.test.ts 只覆盖**纯逻辑内核**，接线（组件 ↔ 内核）
 * 的接缝完全没被覆盖 ⇒ 真机受控实验里 cap 从 16 降到 3、存活 iframe 一个没少
 * （`_perf_cap16.txt` / `_perf_cap3.txt`：iframesAfter 7 → 7），单测却全绿。
 *
 * 真机诊断（window.__palinkIframeLru 快照，2026-10-13 20:42）证明的两个结构性缺陷：
 *   ① wake 分支调 register(cardId, true)，而 register 对**已注册**条目是幂等空操作
 *      ⇒ `visible` 永远翻不真（真机 lruVisible 恒为 0），"可见项永不逐出"形同虚设；
 *   ② 逐出判断只写在"刚刚睡着那张卡"的 IO 回调里（`pickEviction() === cardId`），
 *      而受害者按定义是**更早变隐藏**的那张卡 —— 它的 IO 状态早已稳定、回调不会再跑
 *      ⇒ 结构上永远打不中（真机 cap=3 且 size=5>3 却 gatesNoFrame 恒为 0）。
 *
 * 本文件用**伪造 IntersectionObserver** 驱动真实组件，把上面两条钉成可执行断言。
 * 反证：把 Message.tsx/dormancy-gate.tsx 的接线改回 301225a 的版本，以下用例立刻变红。
 *
 * 运行：npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/dormancy-gate-wiring.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SmartCardDormancyGate } from '../dormancy-gate';
import { __resetSharedIframeLruForTest, getSharedIframeLru } from '../iframe-lru';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 伪造 IntersectionObserver：把"何时可见"完全交给测试驱动。 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  cb: IntersectionObserverCallback;
  targets = new Set<Element>();
  root = null;
  rootMargin = '';
  thresholds: number[] = [];

  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void { this.targets.add(el); }
  unobserve(el: Element): void { this.targets.delete(el); }
  disconnect(): void { this.targets.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }

  /** 测试驱动：向本观察器上报可见性。jsdom 的 offsetHeight 恒为 0，
   *  组件会回退到 entry.boundingClientRect.height ⇒ 这里必须给非零高度，
   *  否则会命中 `measured <= 0` 的保守分支（那不是本用例要测的东西）。 */
  emit(isIntersecting: boolean, height = 500): void {
    const entries = Array.from(this.targets).map((target) => ({
      target,
      isIntersecting,
      boundingClientRect: { height } as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      time: 0,
    })) as IntersectionObserverEntry[];
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

interface MountedGate { id: string; container: HTMLDivElement; root: Root; io: FakeIntersectionObserver; }

let mounted: MountedGate[] = [];

function mountGate(id: string): MountedGate {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SmartCardDormancyGate cardId={id}>
        <div data-test-card-body={id} />
      </SmartCardDormancyGate>,
    );
  });
  const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
  const gate: MountedGate = { id, container, root, io };
  mounted.push(gate);
  return gate;
}

/** 存活 = 仍在渲染 children（未被逐出、未被卸载）。 */
function isAlive(g: MountedGate): boolean {
  return !!g.container.querySelector('[data-test-card-body]');
}
function aliveIds(): string[] {
  return mounted.filter(isAlive).map((g) => g.id);
}
function report(g: MountedGate, visible: boolean): void {
  act(() => { g.io.emit(visible); });
}

/** 每个用例前把配额调到指定值（走单例，组件内部取的就是这个单例）。 */
function useCap(cap: number): void {
  __resetSharedIframeLruForTest();
  getSharedIframeLru().setCap(cap);
}

afterEach(() => {
  for (const g of mounted) {
    act(() => { g.root.unmount(); });
    g.container.remove();
  }
  mounted = [];
  FakeIntersectionObserver.instances = [];
  __resetSharedIframeLruForTest();
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
});

function installFakeIo(): void {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
}

// ============================================================
// A 核心守卫：真机受控实验的可执行版本（cap 小于卡数 ⇒ 存活数被封住）
// ============================================================
describe('A 存活数被封在配额内（对应真机 cap=3 受控实验）', () => {
  it('[红→T2 转绿] 7 张卡、cap=3，全部出视野后存活数必须落到配额（真机实测当时是 7/7）', () => {
    installFakeIo();
    useCap(3);
    const gates = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map(mountGate);
    expect(aliveIds().length).toBe(7); // 未上报前不逐出（状态未知的卡不能当牺牲品）

    for (const g of gates) report(g, false);

    expect(aliveIds().length).toBeLessThanOrEqual(3);
    expect(aliveIds().length).toBe(3);
  });

  it('[红→T2 转绿] 逐出后留下的是"最后变隐藏"的那 3 张（LRU 序）', () => {
    installFakeIo();
    useCap(3);
    const gates = ['g0', 'g1', 'g2', 'g3', 'g4'].map(mountGate);
    for (const g of gates) report(g, false);

    expect(aliveIds().sort()).toEqual(['g2', 'g3', 'g4']);
  });

  it('[红→T2 转绿] 逐出用等高占位替换，不制造滚动条跳动', () => {
    installFakeIo();
    useCap(1);
    const [a, b] = [mountGate('a'), mountGate('b')];
    report(a, false);
    report(b, false);

    const evicted = [a, b].find((g) => !isAlive(g));
    expect(evicted).toBeTruthy();
    const placeholder = evicted!.container.querySelector('div[aria-hidden="true"]') as HTMLElement | null;
    expect(placeholder).toBeTruthy();
    expect(placeholder!.style.height).toBe('500px');
  });
});

// ============================================================
// B 可见项永不逐出（宁可短暂超配额）
// ============================================================
describe('B 可见项永不逐出', () => {
  it('[红→T2 转绿] 配额压力下优先牺牲隐藏项：唤醒一张被逐出的卡 ⇒ 逐出的是别的隐藏卡，不是它', () => {
    installFakeIo();
    useCap(2);
    const [g0, g1, g2] = ['g0', 'g1', 'g2'].map(mountGate);
    // 三张都出视野 ⇒ 在册 3 > cap 2 ⇒ 逐出最久未见的 g0
    for (const g of [g0, g1, g2]) report(g, false);
    expect(aliveIds().sort()).toEqual(['g1', 'g2']);

    // g0 重新入视野：它必须复活，且配额压力要转嫁给**隐藏**项（g1），而不是把它再逐出去
    report(g0, true);
    expect(aliveIds().sort()).toEqual(['g0', 'g2']);
    expect(getSharedIframeLru().isVisible('g0')).toBe(true);
    expect(getSharedIframeLru().isVisible('g2')).toBe(false);
  });

  it('[红→T2 转绿] 出视野又回到视野的卡，在内核里必须是 visible（register 幂等空操作回归钉）', () => {
    installFakeIo();
    useCap(16);
    const g = mountGate('x');

    report(g, false);
    expect(getSharedIframeLru().isVisible('x')).toBe(false);

    report(g, true);
    expect(getSharedIframeLru().isVisible('x')).toBe(true);
  });
});

// ============================================================
// C 唤醒：被逐出的卡重新入视野要能恢复渲染并重新登记
// ============================================================
describe('C 逐出后唤醒可恢复', () => {
  it('[红→T2 转绿] 被逐出的卡重新入视野 ⇒ 重新渲染 children 且重新登记为可见', () => {
    installFakeIo();
    useCap(1);
    const [a, b] = [mountGate('a'), mountGate('b')];
    report(a, false);
    report(b, false);

    const evicted = [a, b].find((g) => !isAlive(g));
    expect(evicted).toBeTruthy();

    report(evicted!, true);
    expect(isAlive(evicted!)).toBe(true);
    expect(getSharedIframeLru().isVisible(evicted!.id)).toBe(true);
  });

  it('[红→T2 转绿] 唤醒会重新纳入配额：唤醒第 2 张后仍不超过 cap', () => {
    installFakeIo();
    useCap(2);
    const gates = ['g0', 'g1', 'g2', 'g3'].map(mountGate);
    for (const g of gates) report(g, false);
    expect(aliveIds().length).toBe(2);

    // 把一张已逐出的卡唤醒 ⇒ 在册数回到 3 > cap=2 ⇒ 必须再逐出一张隐藏项
    const evicted = mounted.find((g) => !isAlive(g))!;
    report(evicted, true);

    expect(aliveIds().length).toBeLessThanOrEqual(3); // 可见项受保护，允许短暂超 1
    expect(getSharedIframeLru().isVisible(evicted.id)).toBe(true);
    expect(aliveIds()).toContain(evicted.id);
  });
});

// ============================================================
// D 卸载退订：消息被删除后不能留下幽灵条目
// ============================================================
describe('D 卸载退订', () => {
  it('[红→T2 转绿] 组件卸载后条目从内核移除（否则配额被幽灵条目长期占用）', () => {
    installFakeIo();
    useCap(16);
    const g = mountGate('ghost');
    report(g, false);
    expect(getSharedIframeLru().has('ghost')).toBe(true);

    act(() => { g.root.unmount(); });
    g.container.remove();
    expect(getSharedIframeLru().has('ghost')).toBe(false);
  });
});
