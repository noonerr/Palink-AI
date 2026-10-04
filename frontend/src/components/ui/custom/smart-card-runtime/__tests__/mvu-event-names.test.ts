/*
 * MVU 事件名必须等于插件契约值（2026-10-05 立）
 *
 * 背景：卡脚本订阅事件走 `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...)`，
 * 而事件总线（window.eventSource）以**事件字符串本身**为 key。此前我们 emit 的是
 * 无前缀的 'VARIABLE_UPDATE_ENDED'，契约真值却是 'mag_variable_update_ended'
 * —— 两边对不上，卡作者写的钩子**永远收不到**，MVU 事件整体是「假活」。
 *
 * 契约出处（本仓内，可复核）：
 *   st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts
 *
 * 三条运行时（inline 模块 / legacy shim 文本 / compatV2 shim 文本）各有一条轨：
 *   - inline 是普通 TS 模块 → 走**真行为断言**（装 globals → 订阅 → 触发 → 断言收到）
 *   - 另两个是要注入 iframe 的脚本文本 → 走结构断言（与本目录既有
 *     mvu-panel-data-override.test.ts 同款做法），并用反证确认有效。
 *
 * 运行: npx vitest run
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';
import {
  ensureInlineStGlobals,
  MVU_EVENT_KEYS,
  resetInlineStGlobalsForTest,
  setInlineStVariables,
} from '../inline/inline-st-globals';

/** 契约真值：与 exported.mvu.d.ts 逐字一致。VARIABLE_INITIALIZED 原文就拼作 initiailized。 */
const CONTRACT = {
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
} as const;

function buildCompatShim(): string {
  return buildSillyTavernCompatRuntimeV2Shim({
    context: {} as any,
    frameId: 'mvu-event-names-frame',
    sourceHtml: '<div></div>',
    mode: 'inline',
  } as any);
}

describe('MVU 事件名 = 插件契约值', () => {
  it('inline 模块导出的常量与契约逐字一致', () => {
    expect(MVU_EVENT_KEYS).toEqual(CONTRACT);
  });

  it('legacy shim 里定义的常量与契约逐字一致', () => {
    for (const value of Object.values(CONTRACT)) {
      expect(LEGACY_ST_SIM_SEGMENT).toContain(`'${value}'`);
    }
  });

  it('compatV2 shim 里定义的常量与契约逐字一致', () => {
    const shim = buildCompatShim();
    for (const value of Object.values(CONTRACT)) {
      expect(shim).toContain(`'${value}'`);
    }
  });

  it('三处都不得再出现无 mag_ 前缀的旧事件名（VARIABLE_UPDATE_ENDED 之类）', () => {
    // 契约值里含 'VARIABLE_UPDATE_ENDED' 子串，故按「引号包裹的旧值」精确匹配，
    // 避免把 mag_variable_update_ended 误判成旧写法。
    expect(LEGACY_ST_SIM_SEGMENT).not.toContain("'VARIABLE_UPDATE_ENDED'");
    expect(LEGACY_ST_SIM_SEGMENT).not.toContain("'VARIABLE_UPDATE_STARTED'");
    expect(buildCompatShim()).not.toContain("'VARIABLE_UPDATE_ENDED'");
    expect(buildCompatShim()).not.toContain("'VARIABLE_UPDATE_STARTED'");
  });

  it('compatV2 的事件键必须无条件生效（不能被插件自带的 events 整体短路掉）', () => {
    // 旧写法是 events: window.Mvu.events || {...} —— 插件装过 MVU 时我们完全不注入。
    const shim = buildCompatShim();
    expect(shim).not.toContain('events: window.Mvu.events ||');
    expect(shim).toContain('Object.assign({}, window.Mvu.events, MVU_EVENT_KEYS');
  });

  it('自家事件 CHAT_VARIABLES_UPDATED 不变（本批不动它）', () => {
    expect(LEGACY_ST_SIM_SEGMENT).toContain("'CHAT_VARIABLES_UPDATED'");
    expect(buildCompatShim()).toContain("'CHAT_VARIABLES_UPDATED'");
  });
});

describe('inline 轨：事件真的会派发（行为断言，不是字符串断言）', () => {
  beforeEach(() => {
    resetInlineStGlobalsForTest();
  });

  function installBus(): { fired: Array<{ type: string; payload: unknown }>; restore: () => void } {
    const fired: Array<{ type: string; payload: unknown }> = [];
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const bus = {
      on(type: string, cb: (payload: unknown) => void) {
        const key = String(type);
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key)!.push(cb);
      },
      emit(type: string, payload: unknown) {
        const key = String(type);
        fired.push({ type: key, payload });
        for (const cb of listeners.get(key) ?? []) cb(payload);
        return Promise.resolve(true);
      },
    };
    const win = window as unknown as Record<string, unknown>;
    const prev = win.eventSource;
    win.eventSource = bus;
    return {
      fired,
      restore: () => {
        if (prev === undefined) delete win.eventSource;
        else win.eventSource = prev;
      },
    };
  }

  it('window.Mvu.events 暴露契约值（卡脚本按常量订阅能取到）', () => {
    ensureInlineStGlobals();
    const events = (window as unknown as { Mvu?: { events?: Record<string, string> } }).Mvu?.events;
    expect(events).toBeDefined();
    expect(events?.VARIABLE_UPDATE_ENDED).toBe('mag_variable_update_ended');
    expect(events?.VARIABLE_INITIALIZED).toBe('mag_variable_initiailized');
    expect(events?.BEFORE_MESSAGE_UPDATE).toBe('mag_before_message_update');
  });

  it('setInlineStVariables 会按 started → ended → before_message_update 顺序派发契约事件', () => {
    const bus = installBus();
    try {
      ensureInlineStGlobals();
      const received: string[] = [];
      const win = window as unknown as Record<string, any>;
      win.eventSource.on(CONTRACT.VARIABLE_UPDATE_ENDED, () => received.push('ended'));

      setInlineStVariables({ stat_data: { 好感度: 5 } });

      const types = bus.fired.map((f) => f.type);
      expect(types).toContain('mag_variable_update_started');
      expect(types).toContain('mag_variable_update_ended');
      expect(types).toContain('mag_before_message_update');
      // 顺序：started 必须在 ended 之前
      expect(types.indexOf('mag_variable_update_started')).toBeLessThan(
        types.indexOf('mag_variable_update_ended'),
      );
      // 按契约常量订阅的回调必须真的被调用（这条是「事件名对不对」的终极判据）
      expect(received).toEqual(['ended']);
    } finally {
      bus.restore();
    }
  });
});
