/*
 * 批次Q1 · 本机放开同源后的**新**暴露面实测（2026-10-21）
 *
 * 依据：SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2.4 那张表的第 3 行 ——
 *   "一旦同站点所有卡落到同一个真 origin，卡间数据隔离就只剩我们自己的命名空间那一层…
 *    判据：本机放开态下两张不同卡的 localStorage / IndexedDB 互相读不到，且都读不到父站凭据。"
 *   "必须实测，不许推断。"
 *
 * 本文件测的是**我们能保证的那一层**（卡正常用 `window.localStorage` / IDB 时）：
 *   A. localStorage 桶按「角色 + 会话 + 源码指纹」三维隔离，两卡互不可见；
 *   B. sessionStorage 同理；
 *   C. IndexedDB 只对白名单库按角色分库（非白名单库共用 —— 这是既有口径，如实测出来）；
 *   D. 父站凭据：`palink_session` 是 HttpOnly（脚本读不到值），`palink_csrf` 不是（JS 可读）。
 *      D 是把**读数钉在源码上**，防止有人把 httponly 改回去而报告还写着"读不到"。
 *
 * ⚠️ 本文件**不**证明"同源旁路也读不到"：同源后卡可以走
 *    `window.frameElement.ownerDocument.defaultView.localStorage` 绕过 shim 直接读父站真存储，
 *    命名空间不是安全边界。这条写进 REPORT_批次Q1 的 §3，⛔ 不在此处加隔离层（那是另一包的事）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/q1-local-unlock-isolation.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSmartCardStorageKey,
  readSmartCardStorageBucket,
  writeSmartCardStorageBucket,
} from '../storage';
import {
  CARD_SCOPED_IDB_DBS,
  sanitizeIdbSuffix,
  scopeIdbName,
} from '@/lib/sillytavern/card-idb-namespace';
import type { CharacterSmartCardContext } from '@/types';

const ctx = (characterId: string, sessionId = 's1'): CharacterSmartCardContext => (
  { characterId, sessionId } as CharacterSmartCardContext
);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('A localStorage：两张卡（同一 origin，放开态）互不可见', () => {
  it('写卡 A 的桶后，卡 B 读到空桶，且两者的键不同', () => {
    const a = ctx('card-a');
    const b = ctx('card-b');
    const fp = 'fp-same-source';
    writeSmartCardStorageBucket(a, fp, 'localStorage', { 好感度: '42', 秘密: 'A 的私货' });
    expect(readSmartCardStorageBucket(a, fp, 'localStorage')).toEqual({ 好感度: '42', 秘密: 'A 的私货' });
    // 卡 B 读同一物理 localStorage，但命名空间不同 ⇒ 看不到 A 的任何键
    expect(readSmartCardStorageBucket(b, fp, 'localStorage')).toEqual({});
    expect(getSmartCardStorageKey(a, fp, 'localStorage'))
      .not.toBe(getSmartCardStorageKey(b, fp, 'localStorage'));
    // 反证：A 的键确实只以 A 的命名空间存在（没有裸键漏进全局）
    // 注意：jsdom 的 localStorage 要按 length/key(i) 枚举，Object.keys 会给内部字段（'map'）。
    const rawKeys = Array.from(
      { length: window.localStorage.length },
      (_unused, index) => window.localStorage.key(index) || '',
    );
    expect(rawKeys.length).toBe(1);
    expect(rawKeys[0]).toContain('card-a');
    expect(rawKeys[0]).not.toContain('card-b');
  });

  it('同一张卡的不同会话/不同源码指纹也各自成桶（改卡内容不串旧数据）', () => {
    const c = ctx('card-a', 's1');
    writeSmartCardStorageBucket(c, 'fp-v1', 'localStorage', { x: '1' });
    expect(readSmartCardStorageBucket(ctx('card-a', 's2'), 'fp-v1', 'localStorage')).toEqual({});
    expect(readSmartCardStorageBucket(c, 'fp-v2', 'localStorage')).toEqual({});
  });

  it('卡 B 覆盖同名键不会改到卡 A 的值（同名不同桶）', () => {
    const fp = 'fp';
    writeSmartCardStorageBucket(ctx('card-a'), fp, 'localStorage', { 好感度: 'A' });
    writeSmartCardStorageBucket(ctx('card-b'), fp, 'localStorage', { 好感度: 'B' });
    expect(readSmartCardStorageBucket(ctx('card-a'), fp, 'localStorage')).toEqual({ 好感度: 'A' });
    expect(readSmartCardStorageBucket(ctx('card-b'), fp, 'localStorage')).toEqual({ 好感度: 'B' });
  });
});

describe('B sessionStorage：与 localStorage 同一套命名空间规则', () => {
  it('两卡互不可见，且两套柜子互不串（写 local 不会出现在 session）', () => {
    const a = ctx('card-a');
    const b = ctx('card-b');
    writeSmartCardStorageBucket(a, 'fp', 'sessionStorage', { 临时: 'A' });
    expect(readSmartCardStorageBucket(b, 'fp', 'sessionStorage')).toEqual({});
    expect(readSmartCardStorageBucket(a, 'fp', 'localStorage')).toEqual({});
  });
});

describe('C IndexedDB：白名单库按角色分库（非白名单共用，如实记录）', () => {
  it('白名单库（BubbleDialogueAvatars）两卡库名不同 ⇒ 互不可见', () => {
    const scoped = CARD_SCOPED_IDB_DBS[0];
    const dbA = scopeIdbName(scoped, sanitizeIdbSuffix('card-a'));
    const dbB = scopeIdbName(scoped, sanitizeIdbSuffix('card-b'));
    expect(dbA).not.toBe(dbB);
    expect(dbA.startsWith(scoped)).toBe(true);
    expect(dbA).toContain('card-a');
  });

  it('非白名单库不分库（GalgameUIPluginDB 是父帧与帧内共用的库，一刀切会打断 Live2D）', () => {
    const shared = 'GalgameUIPluginDB';
    expect(scopeIdbName(shared, sanitizeIdbSuffix('card-a'))).toBe(shared);
    expect(scopeIdbName(shared, sanitizeIdbSuffix('card-b'))).toBe(shared);
    // ⇒ 这一族库在放开同源后**依旧是两卡共用**，属既有口径（不是本批引入）。
    //   判据差异写进报告 §3：卡间隔离在白名单库成立，在共用库不成立。
  });

  it('角色 id 全非法字符时退化为不分库（宁可少隔离，也不生成谁都认不出的库名）', () => {
    expect(sanitizeIdbSuffix('中文/../**')).toBe('');
    expect(scopeIdbName(CARD_SCOPED_IDB_DBS[0], '')).toBe(CARD_SCOPED_IDB_DBS[0]);
  });
});

describe('D 父站凭据：读数钉在源码上（防止将来有人改回去而报告还说"读不到"）', () => {
  const backend = join(process.cwd(), '..', 'backend', 'app', 'api');
  const dependencies = readFileSync(join(backend, 'dependencies.py'), 'utf8');
  const auth = readFileSync(join(backend, 'auth.py'), 'utf8');

  it('palink_session 是 HttpOnly（卡脚本读不到它的值）', () => {
    const sessionCookie = /def set_session_cookie[\s\S]{0,600}?set_cookie\(([\s\S]{0,400}?)\)\n/.exec(dependencies);
    expect(sessionCookie, '找不到 set_session_cookie 的 set_cookie 调用').not.toBeNull();
    expect(sessionCookie![1]).toContain('SESSION_COOKIE_NAME');
    expect(sessionCookie![1]).toContain('httponly=True');
  });

  it('palink_csrf 不是 HttpOnly（JS 可读 —— 这是事实，不许在报告里写成"读不到"）', () => {
    expect(auth).toContain('CSRF_COOKIE_NAME');
    expect(auth).toMatch(/CSRF_COOKIE_NAME,[\s\S]{0,200}?httponly=False/);
  });
});
