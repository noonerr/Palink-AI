/*
 * 卡脚本第三方全局装载契约测试（2026-10-03）
 *
 * 背景：上游 JS-Slash-Runner 会白送 `z`(zod) / `Vue` / `_`(lodash) / `YAML` / `showdown`
 * 给卡内脚本，Palink 此前零提供 → 卡内 mvu_zod.js 报 `z is not defined`、
 * MagVarUpdate 报 `Vue is not defined`，变量系统整体失效（真机复现）。
 *
 * 本文件钉住四条容易回归的行为：
 *   1. **幂等** —— 并发/重复调用只装一次，不重复下载。
 *   2. **不覆盖既有实现** —— 已有真实现时一个 <script> 都不该插。
 *   3. **lite `_` 要被换掉** —— Palink 自己的 lodash-lite 只有 4 个方法，
 *      卡内 schema 用 `_.clamp` 会炸；判据是「有没有 clamp」。
 *   4. **失败留痕** —— 加载失败必须进 `__palinkCompatStats`（生产 terser 会剥 console，
 *      只打 warn 等于线上不可见）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureStThirdPartyGlobals,
  resetStThirdPartyGlobalsForTest,
  ST_THIRD_PARTY_GLOBAL_SPECS,
} from '../st-third-party-globals';
import { getCompatStubStats, resetCompatStubStats } from '@/lib/plugin-system/compat-stub-registry';

const GLOBAL_NAMES = ST_THIRD_PARTY_GLOBAL_SPECS.map((s) => s.name);

/** 清掉被测模块会写的全局，避免用例之间串味 */
function clearGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  for (const name of GLOBAL_NAMES) delete w[name];
}

/**
 * 拦截 <script> 注入：同步触发 load / error，避免真实网络与 8s 超时。
 * 返回被注入的 src 列表，供「一个都不该插」这类断言使用。
 */
function stubScriptInjection(mode: 'load' | 'error', onLoad?: (src: string) => void): string[] {
  const injected: string[] = [];
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
    const el = node as HTMLScriptElement;
    injected.push(el.src);
    queueMicrotask(() => {
      if (mode === 'load') {
        onLoad?.(el.src);
        el.onload?.(new Event('load'));
      } else {
        el.onerror?.(new Event('error'));
      }
    });
    return node;
  }) as typeof document.head.appendChild);
  return injected;
}

beforeEach(() => {
  clearGlobals();
  resetStThirdPartyGlobalsForTest();
  resetCompatStubStats();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearGlobals();
  resetStThirdPartyGlobalsForTest();
});

describe('ensureStThirdPartyGlobals', () => {
  it('全部已就绪时不注入任何 <script>（不覆盖既有实现）', async () => {
    const w = window as unknown as Record<string, unknown>;
    w._ = { clamp: () => 0 };
    w.Vue = {};
    w.showdown = {};
    w.z = {};
    w.YAML = {};
    const injected = stubScriptInjection('load');

    await ensureStThirdPartyGlobals();

    expect(injected).toHaveLength(0);
    // 既有实现未被替换
    expect(typeof (w._ as { clamp?: unknown }).clamp).toBe('function');
  });

  it('lodash-lite（无 clamp）视为未就绪，会被完整实现替换', async () => {
    const w = window as unknown as Record<string, unknown>;
    // Palink inline-st-globals 的 lite 版形状：只有 get/set/cloneDeep/isEmpty
    w._ = { get: () => undefined, set: () => undefined };
    w.Vue = {};
    w.showdown = {};
    w.z = {};
    w.YAML = {};
    const injected = stubScriptInjection('load', () => {
      (window as unknown as Record<string, unknown>)._ = { clamp: () => 0, get: () => undefined };
    });

    await ensureStThirdPartyGlobals();

    expect(injected.some((src) => src.includes('lodash'))).toBe(true);
    expect(typeof (w._ as { clamp?: unknown }).clamp).toBe('function');
  });

  it('幂等：并发调用复用同一个 Promise，只注入一轮', async () => {
    const w = window as unknown as Record<string, unknown>;
    // 预先满足两个 ESM 项，避免用例里发起真实跨域 import()（保持用例hermetic）
    w.z = {};
    w.YAML = {};
    const injected = stubScriptInjection('load', (src) => {
      if (src.includes('lodash')) w._ = { clamp: () => 0 };
      if (src.includes('vue')) w.Vue = {};
      if (src.includes('showdown')) w.showdown = {};
    });

    const a = ensureStThirdPartyGlobals();
    const b = ensureStThirdPartyGlobals();
    expect(a).toBe(b);
    await a;

    const afterFirst = injected.length;
    expect(afterFirst).toBeGreaterThan(0);
    await ensureStThirdPartyGlobals(); // 已 settled
    expect(injected.length).toBe(afterFirst);
  });

  it('加载失败进降级统计（而非只打 console）', async () => {
    const w = window as unknown as Record<string, unknown>;
    // ESM 两项先满足，只让 classic 三项失败 —— 断言面保持确定
    w.z = {};
    w.YAML = {};
    stubScriptInjection('error');

    await ensureStThirdPartyGlobals();

    const stats = getCompatStubStats();
    for (const name of ['_', 'Vue', 'showdown']) {
      expect(stats.has(`st-global:${name}`)).toBe(true);
    }
  });
});

describe('ST_THIRD_PARTY_GLOBAL_SPECS', () => {
  it('zod 走 ESM 且锚定 v4（卡内用的是 z.z.ZodObject / z.z.looseObject 形状）', () => {
    const zod = ST_THIRD_PARTY_GLOBAL_SPECS.find((s) => s.name === 'z');
    expect(zod?.kind).toBe('esm');
    expect(zod?.url).toMatch(/zod@4\./);
  });

  it('全部走 jsdelivr 镜像域（与卡内脚本同源口径）', () => {
    for (const spec of ST_THIRD_PARTY_GLOBAL_SPECS) {
      expect(spec.url.startsWith('https://testingcf.jsdelivr.net/')).toBe(true);
    }
  });
});
