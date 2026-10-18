/*
 * 智能卡存储隔离契约测试（三轨并一轨 · S0 18 条契约测试 · 存储族 9 条）
 *
 * 背景：三轨并存时期存储键有三套规则——
 *   大堂卡脚本 `palink:card-storage:v1:<characterId>:<ns>:<rawKey>`（改代码正文换钥匙）
 *   大堂 ST 插件 无规则（直写真实全局 localStorage）
 *   单间 iframe `palink:smart-card-storage:v1:<type>:<characterId>:<sessionId>:<fingerprint>`（整卡一个 JSON bucket）
 * 并轨后单间规则是唯一存留者，本文件把它的隔离语义钉死：
 *   ① 按卡/会话/源码指纹三维隔离，解锁状态不串卡；
 *   ② localStorage/sessionStorage 两套柜子密钥不互串；
 *   ③ 补丁写累积语义（并发写不丢）、500 条容量上限、损坏桶不崩；
 *   ④ S2 存储键双兼容迁移的前置契约（旧键读一次搬新键 / 只加不删）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/storage-isolation-contract.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SMART_CARD_STORAGE_PREFIX,
  getSmartCardStorageKey,
  getSmartCardStorageNamespace,
  readSmartCardStorageBucket,
  writeSmartCardStorageBucket,
  readSmartCardPersistedStorage,
  applySmartCardStoragePatch,
  readSmartCardTrustGrant,
  writeSmartCardTrustGrant,
} from '../storage';
import { getSmartCardTrustKey } from '../primitives';
import { SMART_CARD_TRUST_SESSION_TTL_MS } from '../shared';
import type { CharacterSmartCardContext } from '@/types';

// 文本级契约用（S2 迁移守门钉在源码上）：vitest 固定以 frontend/ 为 cwd
const storageSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/storage.ts'),
  'utf8',
);

/** 大堂轨旧键前缀（card-script-storage.ts:24），S2 迁移的源键。 */
const LEGACY_STORAGE_PREFIX = 'palink:card-storage:v1:';

function ctx(characterId?: string, sessionId?: string): CharacterSmartCardContext {
  return { characterId, sessionId } as CharacterSmartCardContext;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// ============================================================
// A1 存储按卡隔离
// ============================================================
describe('A1 存储按卡隔离（解锁状态不串卡）', () => {
  it('不同 characterId → 不同桶，数据互不可见', () => {
    const keyA = getSmartCardStorageKey(ctx('c1', 's1'), 'fp1', 'localStorage');
    const keyB = getSmartCardStorageKey(ctx('c2', 's1'), 'fp1', 'localStorage');
    expect(keyA).not.toBe(keyB);

    writeSmartCardStorageBucket(ctx('c1', 's1'), 'fp1', 'localStorage', { unlocked: 'gallery-1' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp1', 'localStorage')).toEqual({ unlocked: 'gallery-1' });
    expect(readSmartCardStorageBucket(ctx('c2', 's1'), 'fp1', 'localStorage')).toEqual({});
  });
});

// ============================================================
// A2 两套柜子密钥不互串 + 键格式
// ============================================================
describe('A2 两套柜子（localStorage/sessionStorage）密钥不互串', () => {
  it('同卡同会话同指纹下两套柜子键不同，local 写入 session 读不到', () => {
    const local = getSmartCardStorageKey(ctx('c1', 's1'), 'fp1', 'localStorage');
    const session = getSmartCardStorageKey(ctx('c1', 's1'), 'fp1', 'sessionStorage');
    expect(local).not.toBe(session);
    expect(local).toBe(`${SMART_CARD_STORAGE_PREFIX}localStorage:c1:s1:fp1`);
    expect(session).toBe(`${SMART_CARD_STORAGE_PREFIX}sessionStorage:c1:s1:fp1`);

    applySmartCardStoragePatch(ctx('c1', 's1'), 'fp1', { storageType: 'localStorage', op: 'set', key: 'k', value: 'v-local' });
    const persisted = readSmartCardPersistedStorage(ctx('c1', 's1'), 'fp1');
    expect(persisted.localStorage).toEqual({ k: 'v-local' });
    expect(persisted.sessionStorage).toEqual({});
  });
});

// ============================================================
// A3 会话/指纹进键 + ID 清洗
// ============================================================
describe('A3 会话与源码指纹进键（切会话/换卡内容不串数据）', () => {
  it('同卡不同会话 → 键不同，数据不串', () => {
    writeSmartCardStorageBucket(ctx('c1', 's1'), 'fp1', 'localStorage', { unlocked: 'a' });
    writeSmartCardStorageBucket(ctx('c1', 's2'), 'fp1', 'localStorage', { unlocked: 'b' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp1', 'localStorage')).toEqual({ unlocked: 'a' });
    expect(readSmartCardStorageBucket(ctx('c1', 's2'), 'fp1', 'localStorage')).toEqual({ unlocked: 'b' });
  });

  it('同卡同会话不同源码指纹 → 键不同（卡内容变更后旧桶不被误用）', () => {
    writeSmartCardStorageBucket(ctx('c1', 's1'), 'fp-old', 'localStorage', { unlocked: 'old' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp-new', 'localStorage')).toEqual({});
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp-old', 'localStorage')).toEqual({ unlocked: 'old' });
  });

  it('namespace 精确组成 characterId:sessionId:fingerprint', () => {
    expect(getSmartCardStorageNamespace(ctx('c1', 's1'), 'fp1')).toBe('c1:s1:fp1');
  });

  it('怪异 characterId 被清洗进键（分隔符 Injection 无法伪造他人桶）', () => {
    const key = getSmartCardStorageKey(ctx('c 1/x:y', 's1'), 'fp', 'localStorage');
    expect(key).toBe(`${SMART_CARD_STORAGE_PREFIX}localStorage:c_1_x_y:s1:fp`);
  });

  it('空 characterId/sessionId 回落全局占位（键不出现空段）', () => {
    expect(getSmartCardStorageNamespace(ctx(undefined, undefined), 'fp')).toBe('global-character:global-session:fp');
    expect(getSmartCardStorageNamespace(ctx('', ''), '')).toBe('global-character:global-session:source');
  });
});

// ============================================================
// A4 并发写不丢（补丁累积语义）
// ============================================================
describe('A4 补丁写累积语义（并发/连续写不丢）', () => {
  it('set→set→remove→clear 序列后桶状态正确', () => {
    const c = ctx('c1', 's1');
    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'set', key: 'a', value: '1' });
    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'set', key: 'b', value: '2' });
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({ a: '1', b: '2' });

    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'remove', key: 'a' });
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({ b: '2' });

    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'clear' });
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({});
  });

  it('空 key / 未知 op / 空补丁被忽略，不清除既有数据', () => {
    const c = ctx('c1', 's1');
    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'set', key: 'a', value: '1' });
    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'set', key: '', value: 'x' });
    applySmartCardStoragePatch(c, 'fp', { storageType: 'localStorage', op: 'frobnicate', key: 'a', value: 'x' });
    applySmartCardStoragePatch(c, 'fp', null);
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({ a: '1' });
  });
});

// ============================================================
// A5 容量上限与值类型过滤
// ============================================================
describe('A5 桶容量上限（500 条）与值类型过滤', () => {
  it('写入超 500 条保留最后 500 条', () => {
    const c = ctx('c1', 's1');
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i += 1) many[`k${i}`] = `v${i}`;
    writeSmartCardStorageBucket(c, 'fp', 'localStorage', many);
    const back = readSmartCardStorageBucket(c, 'fp', 'localStorage');
    expect(Object.keys(back)).toHaveLength(500);
    expect(back.k599).toBe('v599');
    expect(back.k99).toBeUndefined();
  });

  it('读取侧对超限手工桶返回前 500 条（读写双向封顶）', () => {
    const c = ctx('c1', 's1');
    const key = getSmartCardStorageKey(c, 'fp', 'localStorage');
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i += 1) many[`k${i}`] = `v${i}`;
    window.localStorage.setItem(key, JSON.stringify(many));
    const back = readSmartCardStorageBucket(c, 'fp', 'localStorage');
    expect(Object.keys(back)).toHaveLength(500);
    expect(back.k0).toBe('v0');
    expect(back.k599).toBeUndefined();
  });

  it('写侧过滤非字符串值（数字/布尔/null 不入桶）', () => {
    const c = ctx('c1', 's1');
    writeSmartCardStorageBucket(c, 'fp', 'localStorage', {
      ok: 'v',
      num: 123,
      bool: true,
      nul: null,
    } as unknown as Record<string, string>);
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({ ok: 'v' });
  });
});

// ============================================================
// A6 损坏桶不崩
// ============================================================
describe('A6 损坏桶不崩（返回空而非抛异常）', () => {
  it('非 JSON 文本 → {}', () => {
    const c = ctx('c1', 's1');
    window.localStorage.setItem(getSmartCardStorageKey(c, 'fp', 'localStorage'), '{not json');
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({});
  });

  it('JSON 数组/标量 → {}', () => {
    const c = ctx('c1', 's1');
    const key = getSmartCardStorageKey(c, 'fp', 'localStorage');
    window.localStorage.setItem(key, '[1,2,3]');
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({});
    window.localStorage.setItem(key, '"just a string"');
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({});
    window.localStorage.setItem(key, '42');
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({});
  });

  it('含非字符串值的 JSON 对象 → 仅保留字符串条目', () => {
    const c = ctx('c1', 's1');
    window.localStorage.setItem(
      getSmartCardStorageKey(c, 'fp', 'localStorage'),
      JSON.stringify({ good: 'v', bad: 123 }),
    );
    expect(readSmartCardStorageBucket(c, 'fp', 'localStorage')).toEqual({ good: 'v' });
  });
});

// ============================================================
// A7 S2 存储键双兼容迁移守门（先红后绿由 S2 实现情况决定）
// ============================================================
describe('A7 存储键双兼容迁移守门（S2 前置契约）', () => {
  it('[红→S2 转绿] storage.ts 必须含旧键前缀迁移逻辑（读新键无则回读旧键再写新键）', () => {
    // 验收口径（一次性方案 §6.1）：旧解锁状态保留。
    // S2 实现「读新键 → 无则读旧键 → 写新键」后，源码必然出现大堂旧键前缀字面量；
    // 在此之前本用例为红——它是 S2 的开工信号，不是现有缺陷。
    expect(storageSource).toContain(LEGACY_STORAGE_PREFIX);
  });

  it('[绿] 迁移只准加新键、不准删旧键（回退档位 R2 的数据基础）', () => {
    // 一次性方案 §4.4：S2 迁移代码只准加新键不准删旧键，否则 R2 回退不完整。
    // 本用例在 S2 施工后必须保持为绿（现有 removeItem 只作用于信任授予键，不涉旧存储前缀）。
    expect(storageSource).not.toMatch(/removeItem\([^)]*card-storage/);
  });
});

// ============================================================
// A8 信任授予读回（迁移兼容：sessionStorage 优先 + localStorage 旧 grant 清理）
// ============================================================
describe('A8 信任授予读回（双存储迁移兼容）', () => {
  it('有效 sessionStorage grant → true', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.sessionStorage.setItem(key, JSON.stringify({ mode: 'trusted-native', expiresAt: Date.now() + 60_000 }));
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(true);
  });

  it('过期 grant → false 且被清理', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.sessionStorage.setItem(key, JSON.stringify({ mode: 'trusted-native', expiresAt: Date.now() - 1_000 }));
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('localStorage 遗留 grant → false 且被清理（旧柜子不升级为信任）', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.localStorage.setItem(key, JSON.stringify({ mode: 'trusted-native', expiresAt: Date.now() + 60_000 }));
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('writeSmartCardTrustGrant(false) 清理双存储并同步移除 localStorage 残留', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.sessionStorage.setItem(key, JSON.stringify({ mode: 'trusted-native', expiresAt: Date.now() + 60_000 }));
    window.localStorage.setItem(key, JSON.stringify({ mode: 'trusted-native', expiresAt: Date.now() + 60_000 }));
    writeSmartCardTrustGrant('c1', 'fp1', false);
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  // ---- 包D D-2 补覆盖：授予的三维隔离与"会话级"边界 ----

  it('writeSmartCardTrustGrant(true) 只落 sessionStorage（会话级，关浏览器即失效）', () => {
    writeSmartCardTrustGrant('c1', 'fp1', true);
    const key = getSmartCardTrustKey('c1', 'fp1');
    const raw = window.sessionStorage.getItem(key);
    expect(raw).not.toBeNull();
    const grant = JSON.parse(raw as string) as { mode: string; expiresAt: number };
    expect(grant.mode).toBe('trusted-native');
    // TTL 上界必须存在且落在 SMART_CARD_TRUST_SESSION_TTL_MS 附近（不是永久授权）
    const remain = grant.expiresAt - Date.now();
    expect(remain).toBeGreaterThan(SMART_CARD_TRUST_SESSION_TTL_MS - 60_000);
    expect(remain).toBeLessThanOrEqual(SMART_CARD_TRUST_SESSION_TTL_MS);
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(true);
  });

  it('按源码指纹隔离：改了卡（指纹变）授权即失效，不会跟着新内容走', () => {
    writeSmartCardTrustGrant('c1', 'fp1', true);
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(true);
    expect(readSmartCardTrustGrant('c1', 'fp2')).toBe(false);
  });

  it('按角色隔离：A 角色的授权不给 B 角色（同指纹也不行）', () => {
    writeSmartCardTrustGrant('c1', 'fp1', true);
    expect(readSmartCardTrustGrant('c2', 'fp1')).toBe(false);
  });

  it('无 characterId 落 unknown 桶，读回口径一致（不因缺 id 而放宽）', () => {
    writeSmartCardTrustGrant(undefined, 'fp1', true);
    expect(getSmartCardTrustKey(undefined, 'fp1')).toContain('unknown');
    expect(readSmartCardTrustGrant(undefined, 'fp1')).toBe(true);
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
  });

  it('mode 不是 trusted-native 的 grant → false（只认这一种授权形态）', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.sessionStorage.setItem(key, JSON.stringify({ mode: 'iframe-js', expiresAt: Date.now() + 60_000 }));
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('损坏 JSON / 缺 expiresAt → false 且不抛（读路径绝不冒泡）', () => {
    const key = getSmartCardTrustKey('c1', 'fp1');
    window.sessionStorage.setItem(key, '{not json');
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    window.sessionStorage.setItem(key, JSON.stringify({ mode: 'trusted-native' }));
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
  });

  it('撤销后回到未信任（授权不是单向门）', () => {
    writeSmartCardTrustGrant('c1', 'fp1', true);
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(true);
    writeSmartCardTrustGrant('c1', 'fp1', false);
    expect(readSmartCardTrustGrant('c1', 'fp1')).toBe(false);
    expect(window.sessionStorage.getItem(getSmartCardTrustKey('c1', 'fp1'))).toBeNull();
  });
});
