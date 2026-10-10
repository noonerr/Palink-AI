/*
 * 卡脚本桥的「回写族降级」契约测试（2026-10-05 立）
 *
 * 钉住一条语义：**卡脚本轨的"回写"类 API 一律显式降级登记，不得裸 undefined。**
 *
 * 背景（实测）：MVU 变量框架的卡脚本（`backend/data/smart_card_assets/0c646fb31a…js`，
 * 307,179 B）会调用 replaceVariables ×7 / updateVariablesWith ×8 / deleteVariable ×1 /
 * insertOrAssignVariables ×1 / setChatMessage ×1。这些名字此前在本轨不存在，
 * 于是 MVU 的更新管线每轮抛 ReferenceError —— 是"崩溃"而不是"降级"，
 * 且不进 `__palinkCompatStats`（用户与开发者都看不见）。
 *
 * 三条断言口径：
 *   1. 名字必须存在（typeof function）—— 消灭 ReferenceError；
 *   2. 调用必须进降级统计 —— 缺口可见；
 *   3. 返回值必须与 TavernHelper 契约同形状（异步族给 Promise、deleteVariable 给对象）
 *      —— 否则调用方 `await`/`.then()`/读字段会炸出第二个错。
 *
 * 运行: npx vitest run
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureCardScriptBridge } from '../card-script-runner';
import {
  getCompatStubStats,
  resetCompatStubStats,
} from '../../plugin-system/compat-stub-registry';

/** 本轨会挂上的回写族名字（与实现里的 ASYNC_WRITE_NAMES 对齐）。 */
const ASYNC_WRITE_NAMES = [
  'setVariables',
  'setVariable',
  'replaceVariables',
  'updateVariablesWith',
  'insertOrAssignVariables',
  'setChatMessage',
] as const;

const ALL_WRITE_NAMES = [...ASYNC_WRITE_NAMES, 'deleteVariable'] as const;

/** 全部由本模块挂上的全局名（含只读桥），测试间必须清干净。 */
const ALL_BRIDGE_NAMES = ['getVariables', 'getCurrentMessageId', ...ALL_WRITE_NAMES] as const;

function clearBridgeGlobals() {
  for (const name of ALL_BRIDGE_NAMES) {
    delete (window as any)[name];
  }
}

function installBridge() {
  ensureCardScriptBridge({
    getVariables: () => ({ stat_data: { 桃汐: { 好感度: 37 } } }),
    getCurrentMessageId: () => 3,
  });
}

beforeEach(() => {
  clearBridgeGlobals();
  resetCompatStubStats();
});

afterEach(() => {
  clearBridgeGlobals();
  vi.restoreAllMocks();
});

describe('ensureCardScriptBridge · 只读桥', () => {
  it('getVariables 转发到传入的 bridge（含 stat_data）', () => {
    installBridge();
    expect((window as any).getVariables()).toEqual({
      stat_data: { 桃汐: { 好感度: 37 } },
    });
  });

  it('bridge 抛错时 getVariables 返回空对象而不炸（脚本守卫不会崩）', () => {
    ensureCardScriptBridge({
      getVariables: () => {
        throw new Error('boom');
      },
      getCurrentMessageId: () => -1,
    });
    expect((window as any).getVariables()).toEqual({});
  });

  it('getCurrentMessageId 转发到 bridge', () => {
    installBridge();
    expect((window as any).getCurrentMessageId()).toBe(3);
  });
});

describe('ensureCardScriptBridge · 回写族必须显式降级（不得裸 undefined）', () => {
  it('全部回写族名字在桥上存在（消灭 ReferenceError）', () => {
    installBridge();
    for (const name of ALL_WRITE_NAMES) {
      expect(typeof (window as any)[name], `${name} 应为函数`).toBe('function');
    }
  });

  it('异步族返回 Promise，调用方 await / .then 不会二次炸', async () => {
    installBridge();
    for (const name of ASYNC_WRITE_NAMES) {
      const ret = (window as any)[name]({}, { type: 'chat' });
      expect(ret, `${name} 应返回 thenable`).toBeInstanceOf(Promise);
      await expect(ret).resolves.toBeUndefined();
    }
  });

  it('deleteVariable 返回 {variables, delete_occurred} 同形状空结果', () => {
    installBridge();
    expect((window as any).deleteVariable('桃汐.好感度', { type: 'chat' })).toEqual({
      variables: {},
      delete_occurred: false,
    });
  });

  it('每次调用都进降级统计，且带统一说明（缺口可见）', () => {
    installBridge();
    for (const name of ALL_WRITE_NAMES) {
      (window as any)[name]({}, { type: 'chat' });
    }
    const stats = getCompatStubStats();
    for (const name of ALL_WRITE_NAMES) {
      const entry = stats.get(name);
      expect(entry, `${name} 应被登记`).toBeTruthy();
      expect(entry!.count).toBe(1);
      expect(entry!.lastDetail || '').toContain('未开放');
    }
  });

  it('重复调用累加计数，不是每次覆盖', () => {
    installBridge();
    (window as any).replaceVariables({}, { type: 'chat' });
    (window as any).replaceVariables({}, { type: 'chat' });
    expect(getCompatStubStats().get('replaceVariables')!.count).toBe(2);
  });

  it('幂等：已存在的实现不被覆盖（不抢别人已挂好的真实现）', () => {
    const real = vi.fn(() => 'real-impl');
    (window as any).replaceVariables = real;
    installBridge();
    expect((window as any).replaceVariables).toBe(real);
    expect((window as any).replaceVariables()).toBe('real-impl');
    expect(getCompatStubStats().get('replaceVariables')).toBeUndefined();
  });

  it('回写族只登记、不写入：调用后 bridge 的只读值不变（不形成双写）', () => {
    installBridge();
    (window as any).setVariables({ stat_data: { 桃汐: { 好感度: 999 } } }, { type: 'chat' });
    (window as any).replaceVariables({ stat_data: { 桃汐: { 好感度: 999 } } }, { type: 'chat' });
    expect((window as any).getVariables()).toEqual({
      stat_data: { 桃汐: { 好感度: 37 } },
    });
  });
});
