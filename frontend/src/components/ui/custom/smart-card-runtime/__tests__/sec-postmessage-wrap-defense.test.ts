/**
 * [安全顺手批 2026-10-26 · SPEC_下一程计划 §1#14 / §3 第 10 项]
 * 父页面 postMessage 被浏览器扩展包装 ⇒ 卡通道整条静默丢弃 —— 防御性修复的判据测试。
 *
 * 病灶原文（一手依据，勿凭记忆）：docs/OPEN_ISSUES.md P2 第 16 行（:546）
 *   守卫在 components/ui/custom/CharacterCardRenderer.tsx 的 event.source 恒等校验
 *   （**实测当前行号 :1119**，台账里写的 970-971 已漂）；帧内走 window.parent.postMessage，
 *   包装器用主窗口转发 ⇒ event.source 变成主窗口 ⇒ storage 落库 / resize / RPC 全丢，
 *   不报错、不留痕。
 * 用户裁定的口径：「丢弃前必须 palinkDiag 留痕 + 以既有 frameSecret/frameId 双校验作回落判据」。
 *
 * 本批落地边界（如实写明）：
 *   ① 留痕 = palink-diag.ts 的 capture 阶段看门狗 + 帧内 card-script-runner 的 frame-error 轨。
 *      选 frame-error 轨作留痕出口是有依据的：宿主对这支只验 source+frameId、
 *      **不验 event.source**（CharacterCardRenderer.tsx:1035），所以它是包装场景下
 *      唯一还出得去的通道。
 *   ② 回落通道 = 帧内改走 Window.prototype 上仍是原生实现的那份 postMessage
 *      （incumbent global 仍是本帧 ⇒ event.source 正确）。只在自己的卡通道脚本轨上启用；
 *      主 shim（runtime-body/part-*、frame-shim/legacy-st-sim-parts/*）是模板串，
 *      本批施工令明令禁止触碰，故那条通道只留痕、不改投递。
 *   ⛔ 没有新增任何"放行"分支：宿主守卫本身（CharacterCardRenderer.tsx）不在允许改的文件里，
 *      而且放宽 event.source 等于让主页面脚本冒充卡片（它能读 iframe.srcdoc 抄到 frameId）。
 *
 * 测量纪律：全程用 capture 阶段监听 + 假 window 注入，**不包装 postMessage**
 *（主脑在册教训：包装会制造观察者效应，v1 数据就是这么作废的）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/sec-postmessage-wrap-defense.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  installSmartCardFrameMsgWatch,
  palinkDiagRecords,
  resetPalinkDiagForTest,
  resolveSmartCardFrameMsgProvenance,
  setPalinkDiagEnabled,
} from '../palink-diag';
import { buildCardScriptFrameBootstrap } from '@/lib/sillytavern/card-script-runner';

const FRAME_ID = 'palink-smart-card-abcdefghijklmnop';
const rpcMsg = (extra: Record<string, unknown> = {}) => ({
  source: 'palink-smart-card',
  frameId: FRAME_ID,
  type: 'request',
  payload: { action: 'saveExtensionSettings' },
  ...extra,
});

const ignored = () => palinkDiagRecords().filter((r) => r.kind === 'frame_msg_dropped');

beforeEach(() => {
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(true, false);
});

afterEach(() => {
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(null, false);
  document.querySelectorAll('iframe[data-sec-probe]').forEach((n) => n.remove());
});

describe('① 来源判定（纯函数，四类形状）', () => {
  const liveWin = { id: 'live-frame-window' };
  const frames = [{ contentWindow: liveWin }] as unknown as Array<{ contentWindow: unknown }>;

  it('event.source 是主窗口本身（扩展包装后转发的特征）⇒ wrapper_provenance_lost', () => {
    const self = { id: 'main-window' };
    const v = resolveSmartCardFrameMsgProvenance({ data: rpcMsg(), source: self, self, frames });
    expect(v.inScope).toBe(true);
    expect(v.verdict).toBe('wrapper_provenance_lost');
    expect(v.msgType).toBe('request');
    // 回落判据两条都要如实算出来：frameId 形状 + 手势令牌（frameSecret）是否在场
    expect(v.frameIdShaped).toBe(true);
    expect(v.gestureTokenClaimed).toBe(false);
  });

  it('event.source 为空（包装器丢了 source）⇒ 同样判为会被丢弃', () => {
    const v = resolveSmartCardFrameMsgProvenance({
      data: rpcMsg({ __palinkGestureToken: 'secret-token' }),
      source: null,
      self: { id: 'main-window' },
      frames,
    });
    expect(v.verdict).toBe('wrapper_provenance_lost');
    expect(v.gestureTokenClaimed, '令牌在顶层要认出来').toBe(true);
  });

  it('手势令牌放在 payload 内（V2 轨形状）也要认出来', () => {
    const v = resolveSmartCardFrameMsgProvenance({
      data: rpcMsg({ payload: { __palinkGestureToken: 's' } }),
      source: null,
      self: null,
      frames,
    });
    expect(v.gestureTokenClaimed).toBe(true);
  });

  it('event.source 确实在场的 iframe 窗口 ⇒ provenance_ok（宿主守卫会放行，不该留痕）', () => {
    const v = resolveSmartCardFrameMsgProvenance({
      data: rpcMsg(),
      source: liveWin,
      self: { id: 'main-window' },
      frames,
    });
    expect(v.verdict).toBe('provenance_ok');
  });

  it('event.source 是别的 iframe ⇒ foreign_frame（多卡页面正常串台，不能记账）', () => {
    const v = resolveSmartCardFrameMsgProvenance({
      data: rpcMsg(),
      source: { id: 'other-frame-window' },
      self: { id: 'main-window' },
      frames,
    });
    expect(v.verdict).toBe('foreign_frame');
  });

  it('非本通道的消息一律 inScope=false（不把全站 postMessage 灌进记录器）', () => {
    for (const data of [
      null,
      'a-string',
      { source: 'some-extension', frameId: FRAME_ID },
      // frame-error 轨**不过** event.source 校验 ⇒ 不能按"会被丢弃"记账（它是留痕出口）
      { source: 'palink-smart-card-frame', frameId: FRAME_ID, type: 'frame-error' },
    ]) {
      const v = resolveSmartCardFrameMsgProvenance({ data, source: null, self: {}, frames: [] });
      expect(v.inScope, `不该纳入判定：${JSON.stringify(data)}`).toBe(false);
    }
  });

  it('frameId 形状判据不被卡片自取的 id 蒙混（宿主 id 带 CSPRNG 后缀）', () => {
    const v = resolveSmartCardFrameMsgProvenance({
      data: rpcMsg({ frameId: 'palink-smart-card-short' }),
      source: null,
      self: {},
      frames: [],
    });
    expect(v.frameIdShaped).toBe(false);
  });
});

describe('② capture 阶段看门狗：丢弃前留痕（真实 DOM + 真实 MessageEvent）', () => {
  const install = () => {
    delete (window as unknown as Record<string, unknown>).__palinkFrameMsgWatchInstalled;
    installSmartCardFrameMsgWatch();
  };

  it('主窗口转发的卡片 RPC ⇒ 记一条 frame_msg_dropped，detail 带两条回落判据', () => {
    install();
    window.dispatchEvent(new MessageEvent('message', { data: rpcMsg(), source: window }));
    const recs = ignored();
    expect(recs).toHaveLength(1);
    expect(recs[0].owner).toBe('frame_compat');
    expect(recs[0].name).toBe('request');
    expect(recs[0].frameId).toBe(FRAME_ID);
    expect(recs[0].detail).toContain('frameId 形状=true');
    expect(recs[0].detail).toContain('手势令牌在场=false');
  });

  it('在场的 iframe 窗口发来的同一条消息 ⇒ 零留痕（不得把正常通道刷成告警）', () => {
    install();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-sec-probe', '1');
    document.body.appendChild(iframe);
    window.dispatchEvent(new MessageEvent('message', {
      data: rpcMsg({ type: 'resize' }),
      source: iframe.contentWindow,
    }));
    expect(ignored()).toHaveLength(0);
  });

  it('记录器关闭时零开销零写入（放行规则不受影响）', () => {
    install();
    // 顺序要紧：resetPalinkDiagForTest() 会把 enabledOverride 清回 null，
    // 而 jsdom 的 hostname 是 localhost ⇒ 判"关闭"必须在 reset **之后**再设。
    resetPalinkDiagForTest();
    setPalinkDiagEnabled(false, false);
    window.dispatchEvent(new MessageEvent('message', { data: rpcMsg(), source: window }));
    expect(palinkDiagRecords()).toHaveLength(0);
  });

  it('重复安装不叠加监听器（幂等标记位）', () => {
    install();
    installSmartCardFrameMsgWatch();
    installSmartCardFrameMsgWatch();
    window.dispatchEvent(new MessageEvent('message', { data: rpcMsg(), source: window }));
    expect(ignored()).toHaveLength(1);
  });

  it('垃圾 data（字符串 / null）不得让监听器抛错', () => {
    install();
    expect(() => window.dispatchEvent(new MessageEvent('message', { data: 'oops', source: window }))).not.toThrow();
    expect(() => window.dispatchEvent(new MessageEvent('message', { data: null, source: null }))).not.toThrow();
    expect(ignored()).toHaveLength(0);
  });
});

describe('③ 帧内回落通道（求值 card-script-runner 的真实 bootstrap 片段）', () => {
  /** 一个"看起来是原生实现"的假 postMessage。 */
  function makeNativeSlot() {
    const calls: unknown[][] = [];
    const fn = function postMessage(message: unknown, origin: unknown) {
      // 被测代码用 Function.prototype.toString 里的 [native code] 字样识别原生实现；
      // 注释会被转译器抹掉 ⇒ 这里必须用**字符串字面量**把同一标记留在函数源码里。
      const nativeCodeMarker = '[native code]';
      void nativeCodeMarker;
      calls.push([message, origin]);
    };
    return { calls, fn };
  }

  function evalSender(parent: Record<string, unknown>) {
    const src = buildCardScriptFrameBootstrap(FRAME_ID, 'nonce-sec');
    const start = src.indexOf('const palinkFrameMsg = {');
    const end = src.indexOf('const installCardScriptCompatGlobals');
    expect(start, '留痕/回落段起点丢失（改名请同步改守卫）').toBeGreaterThanOrEqual(0);
    expect(end, '留痕/回落段终点丢失').toBeGreaterThan(start);
    const segment = src.slice(start, end);
    const win: Record<string, unknown> = { parent, __palinkCardScriptFrameMsg: null };
    // bootstrap 里 frameId 是模板注入的字面量（在这段之外），夹具照生产同形补一个常量。
    const factory = new Function('window', `const frameId = ${JSON.stringify(FRAME_ID)};\n${segment}
return { send: palinkSendToParent, report, stats: palinkFrameMsg, native: palinkNativePostMessage };`);
    const api = factory(win) as {
      send: (p: unknown) => boolean;
      report: (m: string, d: unknown) => void;
      stats: Record<string, number | boolean>;
      native: () => unknown;
    };
    return { api, win };
  }

  it('未包装时行为与改前一致：走 window.parent 上那份 postMessage，且不产生通知', () => {
    const native = makeNativeSlot();
    const proto = { postMessage: native.fn };
    const parent = Object.create(proto) as Record<string, unknown>;
    const { api } = evalSender(parent);
    expect(api.send({ source: 'palink-smart-card-frame', type: 'frame-error' })).toBe(true);
    expect(native.calls).toHaveLength(1);
    expect(String(native.calls[0][1]), 'targetOrigin 仍是 *').toBe('*');
    expect(api.stats.wrappedDetected).toBe(false);
    expect(api.stats.nativeFallbackUsed).toBe(false);
  });

  it('own-property 遮蔽（扩展包装的典型形状）⇒ 改走原生实现，并按 frame-error 轨通知一次', () => {
    const native = makeNativeSlot();
    const wrapperCalls: unknown[][] = [];
    const proto = { postMessage: native.fn };
    const parent = Object.create(proto) as Record<string, unknown>;
    parent.postMessage = function wrapped(message: unknown, origin: unknown) {
      // 包装器：改用自己的窗口转发 ⇒ event.source 变成主窗口
      wrapperCalls.push([message, origin]);
    };
    const { api } = evalSender(parent);
    expect(api.report('boom', 'detail')).toBe(undefined);
    expect(wrapperCalls, '包装器不得再被使用').toHaveLength(0);
    expect(native.calls.length).toBeGreaterThanOrEqual(2);
    expect((native.calls[0][0] as { message?: string }).message).toBe('boom');
    const notice = native.calls.slice(1).map((c) => (c[0] as { message?: string }).message);
    expect(notice).toContain('palink_frame_postmessage_wrapped');
    expect(api.stats.wrappedDetected).toBe(true);
    expect(api.stats.nativeFallbackUsed).toBe(true);
    const noticePayload = native.calls[1][0] as { source: string; frameId: string; type: string; detail: string };
    expect(noticePayload.source).toBe('palink-smart-card-frame');
    expect(noticePayload.frameId).toBe(FRAME_ID);
    expect(noticePayload.detail, '通知里要带 frameId 判据口径').toContain('frameId=');
  });

  it('通知只发一次（不得每条消息都刷一遍包装取证）', () => {
    const native = makeNativeSlot();
    const parent = Object.create({ postMessage: native.fn }) as Record<string, unknown>;
    parent.postMessage = function wrapped() { /* 包装器 */ };
    const { api } = evalSender(parent);
    api.report('a', '1');
    api.report('b', '2');
    const notices = native.calls
      .map((c) => (c[0] as { message?: string }).message)
      .filter((m) => m === 'palink_frame_postmessage_wrapped');
    expect(notices).toHaveLength(1);
  });

  it('prototype 级补丁（原生实现本身被换掉）⇒ 不拿它当回落通道，但照常投递、不抛错', () => {
    const patched: unknown[][] = [];
    const parent = Object.create({
      postMessage: function patchedPostMessage(message: unknown) { patched.push([message]); },
    }) as Record<string, unknown>;
    const { api } = evalSender(parent);
    expect(api.native()).toBeNull();
    expect(api.send({ source: 'palink-smart-card-frame', type: 'frame-error' })).toBe(true);
    expect(patched).toHaveLength(1);
  });

  it('window.parent 缺失（顶层文档）⇒ 返回 false 并计数，不抛错', () => {
    const native = makeNativeSlot();
    const { api } = evalSender(undefined as unknown as Record<string, unknown>);
    void native;
    expect(api.send({ source: 'palink-smart-card-frame' } as unknown as never)).toBe(false);
  });

  it('入站 frameId 对不上时改为"先留痕再丢"，且信封校验与 capture 注册都还在场', () => {
    const src = buildCardScriptFrameBootstrap(FRAME_ID, 'nonce-sec');
    expect(src).toContain("source !== 'palink-smart-card-parent'");
    expect(src).toContain('card-scripts-push dropped: frameId mismatch');
    expect(src, '按在册教训：这条链要在 capture 阶段看').toMatch(/addEventListener\('message',[\s\S]*?\}, true\);/);
    expect(src).toContain('window.__palinkCardScriptFrameMsg');
  });
});

describe('④ 新 kind 必须登记在封闭名单里（包W 口径）', () => {
  it('PALINK_DIAG_KINDS 含本批三条', async () => {
    const mod = await import('../palink-diag');
    for (const kind of ['frame_msg_dropped', 'parent_postmessage_wrapped', 'payload_session_ignored']) {
      expect(mod.PALINK_DIAG_KINDS).toContain(kind);
    }
  });
});
