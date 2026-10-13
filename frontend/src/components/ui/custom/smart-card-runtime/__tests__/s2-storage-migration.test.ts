/*
 * S2 存储键双兼容迁移测试（旧键 palink:card-storage:v1: → 新键 palink:smart-card-storage:v1:）
 *
 * 迁移口径（一次性方案 §6.1 / §4.4）：
 *   「读新键 → 无则读旧键 → 写新键」，且**只加不删** —— 旧键必须原样留在浏览器里，
 *   否则切回大堂轨（回退档位 R2）时解锁态 / CG 进度就丢了。
 *
 * 本文件的三条硬钉子：
 *   ① 无新键时能读到旧键的值（迁移真的发生了）
 *   ② 迁移后旧键原样存在（只加不删）
 *   ③ 新旧前缀常量不漂移（storage.ts 写死了字面量，必须等于 card-script-storage.ts 的常量）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/s2-storage-migration.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SMART_CARD_STORAGE_PREFIX,
  LEGACY_CARD_SCRIPT_STORAGE_PREFIX,
  getSmartCardStorageKey,
  readSmartCardStorageBucket,
  readSmartCardPersistedStorage,
  writeSmartCardStorageBucket,
  applySmartCardStoragePatch,
  getLegacyCardStoragePrefixes,
  collectLegacyCardStorageBucket,
} from '../storage';
import {
  CARD_SCRIPT_STORAGE_PREFIX,
  buildCardScriptStorageKey,
} from '@/lib/sillytavern/card-script-storage';
import type { CharacterSmartCardContext } from '@/types';

function ctx(characterId?: string, sessionId?: string): CharacterSmartCardContext {
  return { characterId, sessionId } as CharacterSmartCardContext;
}

/** 用**大堂轨自己的构造函数**造旧键，避免测试里手抄格式抄错导致假绿。 */
function seedLegacy(characterId: string, ns: 'local' | 'session', entries: Record<string, string>): void {
  const store = ns === 'session' ? window.sessionStorage : window.localStorage;
  Object.entries(entries).forEach(([k, v]) => {
    store.setItem(buildCardScriptStorageKey(characterId, ns, k), v);
  });
}

/** 浏览器里现存的全部旧键（含值），用来比对迁移前后的"旧键完好性"。 */
function snapshotLegacy(): Record<string, string> {
  const out: Record<string, string> = {};
  [window.localStorage, window.sessionStorage].forEach((store, storeIndex) => {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (!k || !k.startsWith(LEGACY_CARD_SCRIPT_STORAGE_PREFIX)) continue;
      out[`${storeIndex}:${k}`] = store.getItem(k) as string;
    }
  });
  return out;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// ============================================================
// S2-0 前缀常量一致性（storage.ts 写死字面量，必须与大堂轨常量逐字节相同）
// ============================================================
describe('S2-0 新旧前缀常量不漂移', () => {
  it('storage.ts 的旧键前缀 === card-script-storage.ts 的 CARD_SCRIPT_STORAGE_PREFIX', () => {
    // storage.ts 里是写死的字面量（隔离契约测试对源码文本断言，不能改 import），
    // 这条用例是防漂移的唯一保险：哪天大堂轨改了前缀，这里必须红。
    expect(LEGACY_CARD_SCRIPT_STORAGE_PREFIX).toBe(CARD_SCRIPT_STORAGE_PREFIX);
    expect(LEGACY_CARD_SCRIPT_STORAGE_PREFIX).toBe('palink:card-storage:v1:');
  });

  it('新旧前缀互不相同（迁移是换钥匙，不是原地改）', () => {
    expect(SMART_CARD_STORAGE_PREFIX).not.toBe(LEGACY_CARD_SCRIPT_STORAGE_PREFIX);
    expect(SMART_CARD_STORAGE_PREFIX.startsWith(LEGACY_CARD_SCRIPT_STORAGE_PREFIX)).toBe(false);
    expect(LEGACY_CARD_SCRIPT_STORAGE_PREFIX.startsWith(SMART_CARD_STORAGE_PREFIX)).toBe(false);
  });
});

// ============================================================
// S2-1 无新键时能读到旧键的值（迁移主链路）
// ============================================================
describe('S2-1 无新键 → 回读旧键', () => {
  it('localStorage 桶：新键缺失时读到大堂轨旧键的全部条目', () => {
    seedLegacy('c1', 'local', { unlocked: 'gallery-1', cg: 'a|b' });
    expect(window.localStorage.getItem(getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage'))).toBeNull();

    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({
      unlocked: 'gallery-1',
      cg: 'a|b',
    });
  });

  it('sessionStorage 桶：旧键在 window.sessionStorage 里，照样能读到', () => {
    seedLegacy('c1', 'session', { step: '3' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'sessionStorage')).toEqual({ step: '3' });
  });

  it('readSmartCardPersistedStorage 两套柜子各迁各的', () => {
    seedLegacy('c1', 'local', { a: '1' });
    seedLegacy('c1', 'session', { b: '2' });
    expect(readSmartCardPersistedStorage(ctx('c1', 's1'), 'fp')).toEqual({
      localStorage: { a: '1' },
      sessionStorage: { b: '2' },
    });
  });

  it('旧键的 characterId 带空格等字符时按原始形态命中（不被清洗规则挡掉）', () => {
    seedLegacy('c 1/x', 'local', { k: 'v' });
    expect(readSmartCardStorageBucket(ctx('c 1/x', 's1'), 'fp', 'localStorage')).toEqual({ k: 'v' });
  });

  it('无角色身份时旧键的 __anonymous__ 桶能被认领', () => {
    seedLegacy('__anonymous__', 'local', { anon: 'yes' });
    expect(readSmartCardStorageBucket(ctx(undefined, undefined), 'fp', 'localStorage')).toEqual({ anon: 'yes' });
  });
});

// ============================================================
// S2-2 只加不删：迁移后旧键原样存在
// ============================================================
describe('S2-2 迁移只加不删（回退完整性）', () => {
  it('迁移后全部旧键仍在且值未变（本卡 + 别卡的键一个都不少）', () => {
    seedLegacy('c1', 'local', { unlocked: 'gallery-1', cg: 'a' });
    seedLegacy('c1', 'session', { step: '3' });
    seedLegacy('c2', 'local', { other: 'keepme' });
    const before = snapshotLegacy();
    expect(Object.keys(before)).toHaveLength(4);

    readSmartCardPersistedStorage(ctx('c1', 's1'), 'fp');

    expect(snapshotLegacy()).toEqual(before);
    expect(window.localStorage.getItem(buildCardScriptStorageKey('c1', 'local', 'unlocked'))).toBe('gallery-1');
    expect(window.sessionStorage.getItem(buildCardScriptStorageKey('c1', 'session', 'step'))).toBe('3');
    expect(window.localStorage.getItem(buildCardScriptStorageKey('c2', 'local', 'other'))).toBe('keepme');
  });

  it('连续多次读不产生重复扣减：读两次旧键依旧原样', () => {
    seedLegacy('c1', 'local', { k: 'v' });
    readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage');
    const afterFirst = snapshotLegacy();
    readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage');
    expect(snapshotLegacy()).toEqual(afterFirst);
  });

  it('补丁写（set/remove/clear）之后旧键依旧原样 —— 新桶的清空不追溯旧键', () => {
    seedLegacy('c1', 'local', { a: '1', b: '2' });
    const before = snapshotLegacy();

    applySmartCardStoragePatch(ctx('c1', 's1'), 'fp', { storageType: 'localStorage', op: 'set', key: 'c', value: '3' });
    applySmartCardStoragePatch(ctx('c1', 's1'), 'fp', { storageType: 'localStorage', op: 'remove', key: 'a' });
    applySmartCardStoragePatch(ctx('c1', 's1'), 'fp', { storageType: 'localStorage', op: 'clear' });

    expect(snapshotLegacy()).toEqual(before);
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({});
  });
});

// ============================================================
// S2-3 迁移落盘 + 新键优先
// ============================================================
describe('S2-3 迁移写新键，且新键一旦存在就以新键为准', () => {
  it('迁移后新键落盘（后续读不必再依赖旧键）', () => {
    seedLegacy('c1', 'local', { unlocked: 'gallery-1' });
    readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage');

    const newKey = getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage');
    expect(JSON.parse(window.localStorage.getItem(newKey) as string)).toEqual({ unlocked: 'gallery-1' });
  });

  it('新键存在时以新键为准，旧键不反向覆盖新数据', () => {
    seedLegacy('c1', 'local', { unlocked: 'legacy' });
    writeSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage', { unlocked: 'brand-new' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({ unlocked: 'brand-new' });
  });

  it('新键存在但内容损坏时按原样返回空桶，不拿旧键兜底（损坏 ≠ 缺失）', () => {
    seedLegacy('c1', 'local', { unlocked: 'legacy' });
    window.localStorage.setItem(getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage'), '{not json');
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({});
  });

  it('扫不到旧键时不写空桶（留着"新键缺失"，让后来写入的旧键还能被搬上来）', () => {
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({});
    expect(window.localStorage.getItem(getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage'))).toBeNull();

    seedLegacy('c1', 'local', { late: 'arrival' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({ late: 'arrival' });
  });
});

// ============================================================
// S2-4 隔离与边界
// ============================================================
describe('S2-4 迁移不跨卡、不跨柜、有容量上限', () => {
  it('别卡的旧键不会迁进本卡桶', () => {
    seedLegacy('c1', 'local', { mine: '1' });
    seedLegacy('c2', 'local', { theirs: '2' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({ mine: '1' });
    expect(readSmartCardStorageBucket(ctx('c2', 's1'), 'fp', 'localStorage')).toEqual({ theirs: '2' });
  });

  it('local / session 两套旧键不互串', () => {
    seedLegacy('c1', 'local', { where: 'local' });
    seedLegacy('c1', 'session', { where: 'session' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage')).toEqual({ where: 'local' });
    expect(readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'sessionStorage')).toEqual({ where: 'session' });
  });

  it('幂等：同一桶重复迁移结果一致', () => {
    seedLegacy('c1', 'local', { a: '1', b: '2' });
    const first = collectLegacyCardStorageBucket(ctx('c1', 's1'), 'localStorage');
    const second = collectLegacyCardStorageBucket(ctx('c1', 's1'), 'localStorage');
    expect(first).toEqual(second);
  });

  it('旧键超过 500 条时迁移结果封顶 500', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i += 1) many[`k${i}`] = `v${i}`;
    seedLegacy('c1', 'local', many);
    const bucket = collectLegacyCardStorageBucket(ctx('c1', 's1'), 'localStorage');
    expect(Object.keys(bucket)).toHaveLength(500);
  });

  it('前缀候选带尾部分隔符，短 id 不会误吞长 id 的桶', () => {
    seedLegacy('c1', 'local', { who: 'c1' });
    seedLegacy('c1x', 'local', { who: 'c1x' });
    expect(collectLegacyCardStorageBucket(ctx('c1', 's1'), 'localStorage')).toEqual({ who: 'c1' });
    expect(getLegacyCardStoragePrefixes(ctx('c1', 's1'), 'localStorage')).toEqual([
      'palink:card-storage:v1:c1:local:',
    ]);
  });

  it('空旧键（空名段）被跳过，不产生空字符串条目', () => {
    window.localStorage.setItem('palink:card-storage:v1:c1:local:', 'orphan');
    expect(collectLegacyCardStorageBucket(ctx('c1', 's1'), 'localStorage')).toEqual({});
  });

  it('迁移结果与直接写新键的产物同形（后续所有消费方无感）', () => {
    seedLegacy('c1', 'local', { a: '1' });
    readSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage');
    const migrated = window.localStorage.getItem(getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage'));
    writeSmartCardStorageBucket(ctx('c1', 's1'), 'fp', 'localStorage', { a: '1' });
    const handWritten = window.localStorage.getItem(getSmartCardStorageKey(ctx('c1', 's1'), 'fp', 'localStorage'));
    expect(migrated).toBe(handWritten);
  });
});
