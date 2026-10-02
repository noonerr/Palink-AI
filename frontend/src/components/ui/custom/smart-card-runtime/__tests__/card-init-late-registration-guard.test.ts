/*
 * 卡脚本 DOMContentLoaded 晚注册兜底守卫（P0-FIX 2026-09-30）
 *
 * 背景（HANDOFF_卡片正文空白与卡脚本执行：故事帧"故事正文为空"）：
 * 卡脚本用裸 document.addEventListener('DOMContentLoaded', init) 初始化，但
 * iframe 的 chatMessages/variables 经 context-update 晚到；数据到达后运行时
 * 重放卡脚本时 DOMContentLoaded 早已触发，注册的是死监听 → init 永不执行。
 * jQuery 式 $(fn) 走 readyCompat 已有 setTimeout 兜底（面板脚本因此能恢复），
 * 本守卫钉住 shim 对"裸 DOM API 晚注册"也做异步补发——三条路必须全部有兜底。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';
import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

describe('DOMContentLoaded 晚注册兜底（P0-FIX 2026-09-30）', () => {
  it('shim 必须拦截"文档已加载后的 DOMContentLoaded 注册"并异步补发', () => {
    // 补发分支存在：readyState 判定 + 异步补发 + handleEvent 对象监听兼容
    expect(LEGACY_ST_SIM_SEGMENT).toContain("String(type) === 'DOMContentLoaded' && document.readyState !== 'loading'");
    expect(LEGACY_ST_SIM_SEGMENT).toContain('setTimeout(function () {');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('handleEvent');
  });

  it('补发分支不得吞掉常规事件注册（走原始 addEventListener）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain('realDocAddEventListener(type, listener, options)');
  });

  it('shim 自身 ready 的 setTimeout 兜底仍在（面板脚本依赖它）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain("document.addEventListener('DOMContentLoaded', cb, { once: true })");
    expect(LEGACY_ST_SIM_SEGMENT).toContain('setTimeout(cb, 0)');
  });

  it('兼容运行时必须在 chatMessages 首达时补发一次 DOMContentLoaded（数据晚到生命周期对齐 ST）', () => {
    const compat = buildSillyTavernCompatRuntimeV2Shim({
      context: {} as any,
      frameId: 'guard-frame',
      sourceHtml: '<div></div>',
      mode: 'inline',
    } as any);
    expect(compat).toContain('didFireDataReadyDOMContentLoadedCompat');
    expect(compat).toContain("document.dispatchEvent(new Event('DOMContentLoaded'))");
  });
});
