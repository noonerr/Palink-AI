/*
 * 卡脚本 localStorage 命名空间（P0）+ 逐处回退 + 降级 —— 契约测试
 *
 * 钉住 SPEC_卡脚本本地存储按角色与账号隔离 §6/§7 的语义。每条都对应一个真实事故面：
 *   1. 两张卡的同名 rawKey 必须互不可见 —— 这是整个批次的立项理由。
 *   2. clear() 只清自己 —— 原语义会连 Palink 登录态一起抹掉。
 *   3. 不回读旧全局键 —— 迁移整节已作废（§6），回读会把上一张卡的解锁污染给新卡。
 *   4. 同步失败必须静默降级 —— 卡脚本不该因为后端抽风而崩。
 *   5. 源码改写必须覆盖**链式宿主**取法（window.top / window.parent / frames[0]），
 *      同时不能误伤对象自有属性与字符串文案。
 *   6. 改写闸门必须是**逐处**回退，不是整条回退 —— 一处坏写法不该废掉整层隔离（2026-10-02 返工）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CARD_SCRIPT_STORAGE_PREFIX,
  __resetCardScriptStorageForTests,
  buildCardScriptStorageKey,
  getCardScriptStorage,
  hydrateCardScriptStorageFromServer,
  setCardScriptStorageSyncer,
} from '../card-script-storage';
import { patchCardStorageNamespaces, patchCardStorageNamespacesWithStats } from '../card-script-runner';

const CARD_A = '13db28eb-0000-4000-8000-000000000001';
const CARD_B = 'be906232-0000-4000-8000-000000000002';
const RAW_KEY = 'tavern_cg_album_unlocked';

function wipeAll() {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetCardScriptStorageForTests();
  setCardScriptStorageSyncer(null);
}

beforeEach(wipeAll);
afterEach(wipeAll);

describe('命名空间隔离', () => {
  it('同一 rawKey 在两张卡下互不可见', () => {
    getCardScriptStorage(CARD_A, 'local').setItem(RAW_KEY, JSON.stringify(['露出魔纹1']));

    expect(getCardScriptStorage(CARD_A, 'local').getItem(RAW_KEY)).toBe(
      JSON.stringify(['露出魔纹1']),
    );
    expect(getCardScriptStorage(CARD_B, 'local').getItem(RAW_KEY)).toBeNull();
  });

  it('（还原缺陷现场）删卡后重新导入的新卡，图鉴为空', () => {
    // 旧卡解锁 → 删卡导入同名不同 id 的新卡
    getCardScriptStorage(CARD_A, 'local').setItem(RAW_KEY, JSON.stringify(['露出魔纹1', '哭哭1']));
    expect(getCardScriptStorage(CARD_B, 'local').getItem(RAW_KEY)).toBeNull();
  });

  it('local 与 session 同名键互不干扰', () => {
    getCardScriptStorage(CARD_A, 'local').setItem('k', 'L');
    getCardScriptStorage(CARD_A, 'session').setItem('k', 'S');
    expect(getCardScriptStorage(CARD_A, 'local').getItem('k')).toBe('L');
    expect(getCardScriptStorage(CARD_A, 'session').getItem('k')).toBe('S');
  });

  it('写入后真实 localStorage 里只 prefixed 键，不存在裸键名', () => {
    getCardScriptStorage(CARD_A, 'local').setItem(RAW_KEY, 'x');
    expect(window.localStorage.getItem(RAW_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(buildCardScriptStorageKey(CARD_A, 'local', RAW_KEY)),
    ).toBe('x');
    expect(CARD_SCRIPT_STORAGE_PREFIX).toBe('palink:card-storage:v1:');
  });

  it('同一张卡重复取视图拿到同一实例（脚本里常见 const ls = localStorage 后用很久）', () => {
    expect(getCardScriptStorage(CARD_A, 'local')).toBe(getCardScriptStorage(CARD_A, 'local'));
  });
});

describe('clear / 枚举语义', () => {
  it('clear() 只清本命名空间，不动 Palink 与其它卡的键', () => {
    getCardScriptStorage(CARD_A, 'local').setItem('k1', 'v1');
    getCardScriptStorage(CARD_B, 'local').setItem('k1', 'v2');
    window.localStorage.setItem('palink_auth_token', 'keep-me');

    getCardScriptStorage(CARD_A, 'local').clear();

    expect(getCardScriptStorage(CARD_A, 'local').getItem('k1')).toBeNull();
    expect(getCardScriptStorage(CARD_B, 'local').getItem('k1')).toBe('v2');
    expect(window.localStorage.getItem('palink_auth_token')).toBe('keep-me');
  });

  it('length / key() 只统计本命名空间的键', () => {
    const view = getCardScriptStorage(CARD_A, 'local');
    window.localStorage.setItem('palink_auth_token', 'not-mine');
    view.setItem('a', '1');
    view.setItem('b', '2');

    expect(view.length).toBe(2);
    const keys = [view.key(0), view.key(1)];
    expect(keys.sort()).toEqual(['a', 'b']);
    expect(view.key(9)).toBeNull();
  });

  it('键数超限后拒写而不是把 localStorage 撑爆', () => {
    const view = getCardScriptStorage(CARD_A, 'local');
    // 直接垫到上限：走内部 API 太重，这里借用 hydrate 批量写入
    const bulk: Record<string, string> = {};
    for (let i = 0; i < 2001; i += 1) bulk[`k${i}`] = String(i);
    view.hydrate(bulk);
    expect(view.length).toBe(2001);
    view.setItem('overflow', 'x');
    expect(view.getItem('overflow')).toBeNull();
  });
});

describe('不回读旧全局键（上线前无真实用户，迁移没有保护对象）', () => {
  it('旧全局键存在时，任何卡都读不到它', () => {
    window.localStorage.setItem(RAW_KEY, JSON.stringify(['露出魔纹1']));
    expect(getCardScriptStorage(CARD_A, 'local').getItem(RAW_KEY)).toBeNull();
    expect(getCardScriptStorage(CARD_B, 'local').getItem(RAW_KEY)).toBeNull();
  });

  it('旧全局键保持原样：不搬移、不删除、不认领', () => {
    const legacy = JSON.stringify(['露出魔纹1']);
    window.localStorage.setItem(RAW_KEY, legacy);
    getCardScriptStorage(CARD_A, 'local').getItem(RAW_KEY);
    expect(window.localStorage.getItem(RAW_KEY)).toBe(legacy);
  });

  it('一张卡写过的值，另一张卡读不到（用户要的隔离就是这一条）', () => {
    window.localStorage.setItem(RAW_KEY, 'stale-legacy');
    const viewA = getCardScriptStorage(CARD_A, 'local');
    viewA.setItem(RAW_KEY, 'a-only');
    expect(viewA.getItem(RAW_KEY)).toBe('a-only');
    expect(getCardScriptStorage(CARD_B, 'local').getItem(RAW_KEY)).toBeNull();
  });

  it('不再产生 legacy-claim 登记表', () => {
    window.localStorage.setItem(RAW_KEY, 'stale-legacy');
    getCardScriptStorage(CARD_A, 'local').getItem(RAW_KEY);
    expect(window.localStorage.getItem('palink:card-storage:legacy-claim:v1')).toBeNull();
  });
});

describe('服务端同步（P2 写穿）', () => {
  it('push 抛错时静默降级为纯本地，不把异常抛给卡脚本', () => {
    setCardScriptStorageSyncer({
      push: () => {
        throw new Error('backend down');
      },
    });
    const view = getCardScriptStorage(CARD_A, 'local');
    expect(() => view.setItem(RAW_KEY, 'v')).not.toThrow();
    expect(view.getItem(RAW_KEY)).toBe('v');
  });

  it('pull reject 时 hydrateFromServer 静默吞掉，本地仍可读写', async () => {
    setCardScriptStorageSyncer({
      pull: () => Promise.reject(new Error('offline')),
    });
    const view = getCardScriptStorage(CARD_A, 'local');
    await expect(hydrateCardScriptStorageFromServer(CARD_A, 'local')).resolves.toBeUndefined();
    view.setItem('k', 'v');
    expect(view.getItem('k')).toBe('v');
  });

  it('pull 返回值铺进本地命名空间', async () => {
    setCardScriptStorageSyncer({ pull: () => ({ [RAW_KEY]: '["来自服务端"]' }) });
    await hydrateCardScriptStorageFromServer(CARD_A, 'local');
    expect(getCardScriptStorage(CARD_A, 'local').getItem(RAW_KEY)).toBe('["来自服务端"]');
    // 服务端的值只属于这张卡
    expect(getCardScriptStorage(CARD_B, 'local').getItem(RAW_KEY)).toBeNull();
  });

  it('push 会把变更回推（本地写入仍优先）', () => {
    const seen: Array<{ key: string; value: string | null }> = [];
    setCardScriptStorageSyncer({
      push: (_id, _ns, entries) => seen.push(...entries),
    });
    const view = getCardScriptStorage(CARD_A, 'local');
    view.setItem('k', 'v');
    view.removeItem('k');
    expect(seen).toEqual([
      { key: 'k', value: 'v' },
      { key: 'k', value: null },
    ]);
  });
});

describe('patchCardStorageNamespaces 源码改写', () => {
  const cases: Array<[string, string, string]> = [
    ['裸访问', "localStorage.getItem('a')", "__palinkCardStorage('local').getItem('a')"],
    ['window 宿主', "window.localStorage.setItem('k','v')", "__palinkCardStorage('local').setItem('k','v')"],
    // §2.2 已证明这类卡会主动往顶层爬，这条覆盖不到等于没做
    ['topWin 宿主', "topWin.localStorage.getItem(K)", "__palinkCardStorage('local').getItem(K)"],
    ['parent 宿主', "parent.localStorage.clear()", "__palinkCardStorage('local').clear()"],
    ['sessionStorage', "sessionStorage.getItem('s')", "__palinkCardStorage('session').getItem('s')"],
    ['括号取值', "if(localStorage['k']){}", "if(__palinkCardStorage('local')['k']){}"],
    ['length 属性', "n = localStorage.length", "n = __palinkCardStorage('local').length"],
    ['独立变量赋值', 'var ls = localStorage;', "var ls = __palinkCardStorage('local');"],
    ['作为实参传递', 'read(localStorage);', "read(__palinkCardStorage('local'));"],
    ['typeof 守卫', "typeof localStorage !== 'undefined'", "typeof __palinkCardStorage('local') !== 'undefined'"],
    // ── 2026-10-02 返工补的盲区：旧实现只认**一层**宿主前缀，下面这几条全部零匹配 ──
    ['链式 window.top', "window.top.localStorage.getItem('k')", "__palinkCardStorage('local').getItem('k')"],
    ['链式 window.parent', "window.parent.localStorage.clear()", "__palinkCardStorage('local').clear()"],
    ['下标链 window.frames[0]', "window.frames[0].localStorage.getItem('k')", "__palinkCardStorage('local').getItem('k')"],
    ['document.defaultView', "document.defaultView.localStorage.getItem('k')", "__palinkCardStorage('local').getItem('k')"],
    ['链式后再赋给变量', 'var ls = window.top.localStorage;', "var ls = __palinkCardStorage('local');"],
    // 三元分支是真代码，必须改写 —— 所以**不能**在正则里排除「关键词后紧跟 :」
    // （旧提测单 §5.4 建议排除 `:`，那样会漏掉这一条）
    ['三元分支', 'flag ? localStorage : null', "flag ? __palinkCardStorage('local') : null"],
    ['正文收尾（无后续字符）', 'var x = typeof localStorage', 'var x = typeof __palinkCardStorage(\'local\')'],
  ];

  it.each(cases)('%s 会被改写', (_name, src, expected) => {
    expect(patchCardStorageNamespaces(src)).toBe(expected);
  });

  const safeCases: Array<[string, string]> = [
    ['对象自有属性', "foo.bar.localStorage.getItem('x')"],
    ['形似变量名', "mylocalStorage.getItem('x')"],
    ['字符串文案', "console.log('use localStorage API please')"],
  ];

  it.each(safeCases)('%s 不误伤', (_name, src) => {
    expect(patchCardStorageNamespaces(src)).toBe(src);
  });

  // 这两类位置**改写会破坏语法**（把字符串劈断 / 把对象键变成非法键），
  // 必须原样留下 —— 旧实现在这里「整条回退」，连带把真访问一起废掉。
  const untouchableCases: Array<[string, string]> = [
    ['引号前导的字符串文案', "console.warn('localStorage 不可用');"],
    ['字符串中段的关键词', "console.log('read localStorage, ok');"],
    ['字符串键名（不是真 API 访问）', 'window["localStorage"].getItem("k")'],
    ['对象字面量键位', 'var o = { localStorage: 1 };'],
  ];

  it.each(untouchableCases)('%s 原样保留', (_name, src) => {
    expect(patchCardStorageNamespaces(src)).toBe(src);
  });

  it('改写后仍是可编译的脚本；改写失败时原样放行', () => {
    const broken = 'localStorage.getItem(';
    expect(patchCardStorageNamespaces(broken)).toBe(broken);
  });

  it('未涉及 storage 的脚本不受影响', () => {
    const src = 'var a = 1;function f(){return a;}';
    expect(patchCardStorageNamespaces(src)).toBe(src);
  });
});

/**
 * 逐处回退语义（2026-10-02 返工的核心）。
 *
 * 事故现象：卡片图鉴跨卡共享。旧实现是「全有或全无」闸门 —— 脚本里**任意一处**
 * 关键词落在改写后会破坏语法的位置（例如一句中文 `console.warn('localStorage 不可用')`），
 * 整条脚本静默退回原文 → 真访问也没被改写 → 隔离全废，且不打任何日志。
 */
describe('逐处回退：一处坏写法不再废掉整层隔离', () => {
  it('字符串文案 + 真访问共存时，真访问改写成功、文案原样保留', () => {
    const src = [
      "var KB = 'tavern_cg_album_unlocked';",
      'var v = localStorage.getItem(KB);',
      "console.warn('localStorage 不可用');",
    ].join('\n');
    const { code, stats } = patchCardStorageNamespacesWithStats(src);

    expect(code).toContain("__palinkCardStorage('local').getItem(KB)");
    expect(code).toContain("'localStorage 不可用'");
    expect(stats).toEqual({ keywordHits: 2, applied: 1, rolledBack: 0 });
    // 改写结果必须仍是合法脚本 —— 否则整条会被浏览器丢弃（2026-09-30 空白事故面）
    expect(() => new Function(code)).not.toThrow();
  });

  it('命中处全在不可改写位置：返回原文，但计数可诊断（旧实现连计数都没有）', () => {
    const src = "console.log('read localStorage, ok');";
    const { code, stats } = patchCardStorageNamespacesWithStats(src);
    expect(code).toBe(src);
    expect(stats).toEqual({ keywordHits: 1, applied: 0, rolledBack: 1 });
  });

  it('对象键位命中：逐处回退，计数 1/0/1', () => {
    const src = 'var o = { localStorage: 1 };';
    const { code, stats } = patchCardStorageNamespacesWithStats(src);
    expect(code).toBe(src);
    expect(stats).toEqual({ keywordHits: 1, applied: 0, rolledBack: 1 });
  });

  it('原文本身编译不过：不替它修，原样放行且零计数', () => {
    const broken = 'localStorage.getItem(';
    const { code, stats } = patchCardStorageNamespacesWithStats(broken);
    expect(code).toBe(broken);
    expect(stats).toEqual({ keywordHits: 1, applied: 0, rolledBack: 0 });
  });

  it('完全不含关键词：零计数（供调用方区分「不用改」与「改不了」）', () => {
    const { code, stats } = patchCardStorageNamespacesWithStats('var a = 1;');
    expect(code).toBe('var a = 1;');
    expect(stats).toEqual({ keywordHits: 0, applied: 0, rolledBack: 0 });
  });
});
