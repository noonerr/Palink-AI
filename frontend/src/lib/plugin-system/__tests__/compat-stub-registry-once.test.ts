/**
 * [T5 口径 A 2026-10-17] 降级桩「会话级留痕」守卫
 *
 * 背景：口径 A = 「调用留痕、不加闸门」。但 `setChatMessages` 这类 API 是
 * **每轮都被调用**的（MVU 每轮都写一次消息），若逐次 `recordStubHit`，
 * 插件管理页会给出一个持续膨胀的计数（几百上千），把其他真正要看的降级信号
 * 淹没 ⇒ **比不登记更吵**。故引入 `recordStubHitOnce`：一个桩名每会话只登记一次。
 *
 * 本文件守三件事：
 *   1. `recordStubHitOnce` 的语义（首次登记、后续静默、reset 后可再登记、不同桩名互不干扰）；
 *   2. 原 `recordStubHit` 的逐次计数语义**没被改坏**；
 *   3. 两个落点（`getContext.ts` 的落库缺口、`sandbox.ts` 的 deleteChatMessages 无实现）
 *      **真的用了** Once 变体 —— 源码层守卫，防止被人改回逐次登记或删掉留痕。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordStubHit,
  recordStubHitOnce,
  getCompatStubStats,
  resetCompatStubStats,
} from '../compat-stub-registry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'sandbox.ts'), 'utf-8');
const GETCONTEXT_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'sillytavern', 'getContext.ts'),
  'utf-8',
);

beforeEach(() => {
  resetCompatStubStats();
});

afterEach(() => {
  resetCompatStubStats();
});

describe('A. recordStubHitOnce：会话级只登记一次', () => {
  it('首次登记、后续调用不再增加计数', () => {
    recordStubHitOnce('unit:once-a', 'first');
    recordStubHitOnce('unit:once-a', 'second');
    recordStubHitOnce('unit:once-a', 'third');
    const entry = getCompatStubStats().get('unit:once-a');
    expect(entry).toBeTruthy();
    expect(entry!.count).toBe(1);
    // 后续调用连 detail 都不覆盖（只认首次上下文）
    expect(entry!.lastDetail).toBe('first');
  });

  it('不同桩名互不干扰', () => {
    recordStubHitOnce('unit:once-x', 'x');
    recordStubHitOnce('unit:once-y', 'y');
    const stats = getCompatStubStats();
    expect(stats.get('unit:once-x')!.count).toBe(1);
    expect(stats.get('unit:once-y')!.count).toBe(1);
  });

  it('resetCompatStubStats 后同一桩名可以再登记（会话边界）', () => {
    recordStubHitOnce('unit:once-reset', '会话1');
    expect(getCompatStubStats().get('unit:once-reset')!.count).toBe(1);
    resetCompatStubStats();
    recordStubHitOnce('unit:once-reset', '会话2');
    const entry = getCompatStubStats().get('unit:once-reset');
    expect(entry!.count).toBe(1);
    expect(entry!.lastDetail).toBe('会话2');
  });
});

describe('B. 原 recordStubHit 的逐次计数语义没被改坏', () => {
  it('每次调用都累加 count，并刷新 lastDetail', () => {
    recordStubHit('unit:many', 'call-1');
    recordStubHit('unit:many', 'call-2');
    recordStubHit('unit:many', 'call-3');
    const entry = getCompatStubStats().get('unit:many');
    expect(entry!.count).toBe(3);
    expect(entry!.lastDetail).toBe('call-3');
  });
});

describe('C. 源码层守卫：两个落点真的用了 Once 变体', () => {
  it('getContext.ts 的 setChatMessages 落库缺口用 recordStubHitOnce（不是逐次）', () => {
    // 逐次登记会让计数随 MVU 每轮调用膨胀 ⇒ 这条守卫防它退化。
    // 用正则而非 toContain：源文件是 CRLF，写死 '\n' 会假失败。
    expect(GETCONTEXT_SRC).toMatch(/recordStubHitOnce\(\s*'setChatMessages:persist'/);
  });

  it('sandbox.ts 的 deleteChatMessages 无实现分支有留痕（S5 后恒定走这条路）', () => {
    expect(SANDBOX_SRC).toMatch(/recordStubHitOnce\(\s*'deleteChatMessages:no-impl'/);
  });

  it('防假绿：上面的正则认不出「没有留痕」的旧写法', () => {
    const oldSample = `console.warn('[PluginSandbox] deleteChatMessages: 无可用桥接');\n        return false;`;
    expect(/recordStubHitOnce\(\s*'deleteChatMessages:no-impl'/.test(oldSample)).toBe(false);
  });
});
