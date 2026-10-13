/*
 * iframe 存活配额守卫（三轨并一轨 · S1 · T2）
 *
 * 钉住的目标：**已加载消息数增长时，存活 iframe 数不超过配额**
 * —— 这就是 S0 实测那条"堆随 iframe 数线性增长、只增不减"的可执行反面。
 *
 * S0 基线（REPORT_S0备料基线与回退演练档案 §6.1）：
 *   7 个 iframe → 113MB；48 个 → 560MB（GC 后 ~300MB），边际 ≈ +9~11MB/个。
 *
 * 为什么不用"出视野即卸载"：那等于把 Message.tsx:645-652 记录的那次 iOS 回归重放一遍
 * （iframe 重建 = 一次导航 = Safari 联合会话历史插一条幽灵条目 ⇒ 滑动返回闪过重复快照）。
 * 配额方案把"逐出-重建"的次数**限界**，而不是每次滚动都付代价。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/iframe-lru.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  IframeLru,
  DEFAULT_IFRAME_LRU_POLICY,
  resolveIframeCap,
  getSharedIframeLru,
  __resetSharedIframeLruForTest,
} from '../iframe-lru';

/** 模拟"消息不断加载"：每注册一条就按策略逐出，返回最终存活数。 */
function grow(lru: IframeLru, count: number, visibleIds: Set<string> = new Set()): number {
  for (let i = 0; i < count; i += 1) {
    const id = 'msg-' + i;
    lru.register(id, visibleIds.has(id));
    const victim = lru.pickEviction();
    if (victim) lru.unregister(victim);
  }
  return lru.size;
}

// ============================================================
// A 核心守卫：存活数不随已加载消息数线性增长
// ============================================================
describe('A 核心守卫 —— 存活 iframe 数不随消息数线性增长', () => {
  it('[红→S1 转绿] 加载 200 条消息，存活数封在配额内（默认非 iOS = 16）', () => {
    const lru = new IframeLru(16);
    const alive = grow(lru, 200);
    expect(alive).toBeLessThanOrEqual(16);
    expect(alive).toBe(16);
  });

  it('[红→S1 转绿] 加载 1000 条消息，存活数仍然封在配额内（不线性增长）', () => {
    const lru = new IframeLru(16);
    expect(grow(lru, 1000)).toBeLessThanOrEqual(16);
  });

  it('[红→S1 转绿] 配额调小也成立（cap=4）', () => {
    const lru = new IframeLru(4);
    expect(grow(lru, 50)).toBeLessThanOrEqual(4);
  });

  it('[红→S1 转绿] 未超配额时一条都不逐出（不误伤）', () => {
    const lru = new IframeLru(16);
    for (let i = 0; i < 16; i += 1) lru.register('msg-' + i);
    expect(lru.size).toBe(16);
    expect(lru.pickEviction()).toBeNull();
  });
});

// ============================================================
// B 可见项永不逐出（宁可短暂超配额）
// ============================================================
describe('B 可见项永不逐出', () => {
  it('[红→S1 转绿] 可见项不会被挑为逐出对象', () => {
    const lru = new IframeLru(2);
    lru.register('a', true);
    lru.register('b', true);
    lru.register('c');
    expect(lru.pickEviction()).toBe('c');   // 只有 c 不可见
  });

  it('[红→S1 转绿] 全部可见且超配额 ⇒ 不逐出（返回 null，宁可短暂超）', () => {
    const lru = new IframeLru(2);
    lru.register('a', true);
    lru.register('b', true);
    lru.register('c', true);
    expect(lru.size).toBe(3);
    expect(lru.pickEviction()).toBeNull();
  });

  it('[红→S1 转绿] 混合场景：可见项保住，隐藏项被逐出', () => {
    const lru = new IframeLru(3);
    lru.register('keep1', true);
    lru.register('keep2', true);
    lru.register('h1');
    lru.register('h2');
    lru.register('h3');
    expect(lru.size).toBe(5);
    const victim = lru.pickEviction();
    expect(victim).toBe('h1');              // 最久未见的隐藏项
    expect(lru.isVisible('keep1')).toBe(true);
    expect(lru.isVisible('keep2')).toBe(true);
  });
});

// ============================================================
// C LRU 顺序与幂等
// ============================================================
describe('C LRU 顺序 / 幂等', () => {
  it('[红→S1 转绿] 逐出的是"最久未见"的那个', () => {
    const lru = new IframeLru(2);           // 3 条 > 配额 2 ⇒ 触发逐出
    lru.register('old');
    lru.register('mid');
    lru.register('new');
    expect(lru.size).toBe(3);
    expect(lru.pickEviction()).toBe('old');
  });

  it('[红→S1 转绿] 之后被看到过 ⇒ 不再是逐出首选', () => {
    const lru = new IframeLru(2);
    lru.register('old');
    lru.register('mid');
    lru.register('new');
    lru.markVisible('old', true);
    lru.markVisible('old', false);          // 看过又隐藏：lastSeen 已刷新
    const victim = lru.pickEviction();
    expect(victim).not.toBe('old');         // 'mid' 才是现在最久未见的
    expect(victim).toBe('mid');
  });

  it('[红→S1 转绿] register 幂等：重复注册不产生重复项', () => {
    const lru = new IframeLru(8);
    lru.register('x');
    lru.register('x');
    lru.register('x');
    expect(lru.size).toBe(1);
  });

  it('[红→S1 转绿] unregister 后可重新注册', () => {
    const lru = new IframeLru(8);
    lru.register('x');
    lru.unregister('x');
    expect(lru.size).toBe(0);
    lru.register('x');
    expect(lru.size).toBe(1);
  });

  it('[红→S1 转绿] pickEvictions 批量回到配额内且不重复', () => {
    const lru = new IframeLru(3);
    for (let i = 0; i < 10; i += 1) lru.register('m' + i);
    const victims = lru.pickEvictions();
    expect(new Set(victims).size).toBe(victims.length);   // 无重复
    expect(lru.size).toBeLessThanOrEqual(3);
  });

  it('[红→S1 转绿] 全可见时 pickEvictions 不会死循环', () => {
    const lru = new IframeLru(2);
    for (let i = 0; i < 6; i += 1) lru.register('v' + i, true);
    expect(() => lru.pickEvictions()).not.toThrow();
    expect(lru.pickEvictions()).toEqual([]);
  });
});

// ============================================================
// D 平台分档（G8 策略参数）
// ============================================================
describe('D 平台分档 —— iOS 用更大的保守档', () => {
  it('[红→S1 转绿] iOS 档比非 iOS 大（内存仍有上限，但压低逐出-重建次数）', () => {
    expect(resolveIframeCap(DEFAULT_IFRAME_LRU_POLICY, true))
      .toBeGreaterThan(resolveIframeCap(DEFAULT_IFRAME_LRU_POLICY, false));
  });

  it('[红→S1 转绿] 两档都是正整数的有限上界（不存在"永不回收"）', () => {
    const nonIos = resolveIframeCap(DEFAULT_IFRAME_LRU_POLICY, false);
    const ios = resolveIframeCap(DEFAULT_IFRAME_LRU_POLICY, true);
    for (const c of [nonIos, ios]) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(200);          // 必须是有界值，不能是 Infinity 之类
    }
  });

  it('[红→S1 转绿] iOS 档下存活数仍被封住（不是无上限）', () => {
    const cap = resolveIframeCap(DEFAULT_IFRAME_LRU_POLICY, true);
    const lru = new IframeLru(cap);
    expect(grow(lru, 500)).toBeLessThanOrEqual(cap);
  });

  it('[红→S1 转绿] 配额可运行时调整（拍板改档位无需改结构）', () => {
    const lru = new IframeLru(10);
    expect(lru.getCap()).toBe(10);
    lru.setCap(3);
    expect(lru.getCap()).toBe(3);
    expect(grow(lru, 30)).toBeLessThanOrEqual(3);
  });
});

// ============================================================
// E 单例
// ============================================================
describe('E 共享单例', () => {
  it('[红→S1 转绿] 多次取用是同一个实例（多消息共用一个配额视图）', () => {
    __resetSharedIframeLruForTest();
    const a = getSharedIframeLru();
    const b = getSharedIframeLru();
    expect(a).toBe(b);
    __resetSharedIframeLruForTest();
  });
});
