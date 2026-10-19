// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { SMART_CARD_TRUST_SESSION_TTL_MS } from './shared';
import type { CharacterSmartCardContext } from '@/types';
import { getSmartCardTrustKey, normalizeSmartCardStorageId } from './primitives';

export function readSmartCardTrustGrant(characterId: string | undefined, fingerprint: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.sessionStorage.getItem(getSmartCardTrustKey(characterId, fingerprint));
    if (!raw) {
      try {
        window.localStorage.removeItem(getSmartCardTrustKey(characterId, fingerprint));
      } catch {
        // Ignore legacy grant cleanup failures.
      }
      return false;
    }
    const grant = JSON.parse(raw) as { mode?: unknown; expiresAt?: unknown };
    const expiresAt = Number(grant.expiresAt);
    const valid = grant.mode === 'trusted-native' && Number.isFinite(expiresAt) && expiresAt > Date.now();
    if (!valid) window.sessionStorage.removeItem(getSmartCardTrustKey(characterId, fingerprint));
    return valid;
  } catch {
    return false;
  }
}


export function writeSmartCardTrustGrant(characterId: string | undefined, fingerprint: string, trusted: boolean) {
  if (typeof window === 'undefined') return;
  try {
    const key = getSmartCardTrustKey(characterId, fingerprint);
    if (trusted) {
      window.sessionStorage.setItem(key, JSON.stringify({
        mode: 'trusted-native',
        expiresAt: Date.now() + SMART_CARD_TRUST_SESSION_TTL_MS,
      }));
    } else {
      window.sessionStorage.removeItem(key);
    }
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures. The current in-memory state still applies.
  }
}


/* ─────────────── 导入时信任提示（包N C-1，TOFU + 指纹绑定） ───────────────
 *
 * 为什么不能"导入时直接写 grant"：信任指纹（sourceFingerprint）是**渲染时**按该条消息的
 * 智能卡 HTML + customCss 算的（CharacterCardRenderer.tsx:270-273），导入阶段根本拿不到；
 * 而且 grant 是 cid:fingerprint + sessionStorage + 30 分钟 TTL（shared.ts:56）。
 * 直接写 grant 会写到一个永远对不上的指纹上 ⇒ "点了信任却不生效"。
 *
 * 所以用 TOFU（首次使用即绑定）：
 *   导入时用户点"信任" ⇒ 写 { pending: true }（localStorage，持久）
 *   首次渲染读到时    ⇒ 把**当前** sourceFingerprint 绑上去并视为已授信
 *   之后再读到 { fingerprint: X } ⇒ 只有 X === 当前指纹才授信（卡内容一改即失效）
 *
 * ⚠️ 这是**安全口径变更**（会话级 30 分钟 TTL → 持久 + 指纹绑定）。补偿：
 *   ① 只对用户在导入弹窗里显式点过"信任"的卡生效（纯文本卡不弹、不写）；
 *   ② 绑定源码指纹，卡内容一改信任自动失效；
 *   ③ 卡片"信任"开关撤销时**同时清本键**（见 CharacterCardRenderer.confirmTrustedNative），
 *      否则撤了又被自动授信 —— 那是 bug。
 */
export const SMART_CARD_TRUST_OPTIN_PREFIX = 'palink:card-trust-optin:v1:';

/** 新键（与 getSmartCardTrustKey 的 `cid:fingerprint` 会话键**不同键**，别复用）。 */
export function getSmartCardTrustOptInKey(characterId: string | undefined): string {
  return `${SMART_CARD_TRUST_OPTIN_PREFIX}${characterId || 'unknown'}`;
}

/** 导入时用户点了"信任" ⇒ 记 pending（等首次渲染绑定指纹）。 */
export function writeSmartCardTrustOptIn(characterId: string | undefined): void {
  if (typeof window === 'undefined' || !characterId) return;
  try {
    window.localStorage.setItem(
      getSmartCardTrustOptInKey(characterId),
      JSON.stringify({ pending: true, at: Date.now() }),
    );
  } catch {
    // 存储不可用 ⇒ 退化为"没有 optin"，用户仍可在卡片里手动信任（不抛）。
  }
}

export function clearSmartCardTrustOptIn(characterId: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(getSmartCardTrustOptInKey(characterId));
  } catch {
    // ignore
  }
}

/**
 * 读取并**采纳** optin。
 *   { pending: true }        → 把当前 fingerprint 写进去并返回 true（TOFU 绑定）
 *   { fingerprint: X }       → 仅 X === fingerprint 时 true（卡改即失效）
 *   其他/损坏/无键            → false
 * 注意：本函数带一次写副作用（pending → 绑定），调用点只在信任解析里，且幂等。
 */
export function readSmartCardTrustOptIn(characterId: string | undefined, fingerprint: string): boolean {
  if (typeof window === 'undefined' || !characterId || !fingerprint) return false;
  try {
    const raw = window.localStorage.getItem(getSmartCardTrustOptInKey(characterId));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { pending?: unknown; fingerprint?: unknown; at?: unknown };
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.pending === true) {
      window.localStorage.setItem(
        getSmartCardTrustOptInKey(characterId),
        JSON.stringify({ fingerprint, at: Date.now() }),
      );
      return true;
    }
    return typeof parsed.fingerprint === 'string' && parsed.fingerprint === fingerprint;
  } catch {
    return false;
  }
}


export type SmartCardPersistedStorage = {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};


export const SMART_CARD_STORAGE_PREFIX = 'palink:smart-card-storage:v1:';

/**
 * 大堂轨（card-script-storage.ts）旧键前缀 —— S2 双兼容迁移的**源**键。
 *
 * ⚠️ 必须与 `lib/sillytavern/card-script-storage.ts` 的 `CARD_SCRIPT_STORAGE_PREFIX`
 * 逐字节一致。这里**故意不 import 而是原地写死**：存储隔离契约测试
 * （`__tests__/storage-isolation-contract.test.ts` A7）是对本文件**源码文本**断言，
 * import 进来的字面量不落在本文件里，契约会红。两边一致性由
 * `__tests__/s2-storage-migration.test.ts` 钉住。
 */
export const LEGACY_CARD_SCRIPT_STORAGE_PREFIX = 'palink:card-storage:v1:';

/** 单个桶的键数上限（读写双向封顶，见 A5 契约） */
const SMART_CARD_STORAGE_MAX_KEYS = 500;


export function getSmartCardStorageNamespace(context: CharacterSmartCardContext, sourceFingerprint: string): string {
  const characterId = normalizeSmartCardStorageId(context.characterId, 'global-character');
  const sessionId = normalizeSmartCardStorageId(context.sessionId, 'global-session');
  const sourceId = normalizeSmartCardStorageId(sourceFingerprint, 'source');
  return `${characterId}:${sessionId}:${sourceId}`;
}


export function getSmartCardStorageKey(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  type: keyof SmartCardPersistedStorage,
): string {
  return `${SMART_CARD_STORAGE_PREFIX}${type}:${getSmartCardStorageNamespace(context, sourceFingerprint)}`;
}


/* ────────────────────────── S2 双兼容迁移（旧键 → 新键，只加不删） ──────────────────────────
 *
 * 三轨并一轨后新键是唯一存留者，但老用户浏览器里躺着大堂轨写的旧键
 * （`palink:card-storage:v1:<characterId>:<ns>:<rawKey>`，一条键一个字符串值，不是 JSON 桶）。
 * 直接换钥匙 = 解锁态/CG 进度一夜清零，所以做**一次性抄写迁移**：
 *
 *   读新键 → 新键缺失则回读旧键 → 把旧键内容抄进新键 → 返回
 *
 * 三条硬约束：
 *   1. **只加不删**：旧键一律原地保留。回退档位 R2（切回大堂轨）要求旧键仍完好可续用，
 *      任何"搬完就清"的写法都会让回退变成数据丢失。
 *   2. **只在新键缺失时搬**：新键一旦存在就以新键为准，旧键不再参与 —— 否则旧键会
 *      反向覆盖用户在并轨后产生的新数据。
 *   3. **绝不抛错**：迁移是读路径上的附加动作，扫存储时任何异常都退回"没可迁数据"。
 */

/** 旧键的 ns 段（对应大堂轨的 CardScriptStorageNs）。 */
function legacyNamespaceFor(type: keyof SmartCardPersistedStorage): 'local' | 'session' {
  return type === 'sessionStorage' ? 'session' : 'local';
}

/**
 * 旧键所在的真实 Storage。
 * 注意：大堂轨的 `session` 键写的是 **window.sessionStorage**，而并轨后两种 type 的
 * 新桶统一落在 window.localStorage（见 writeSmartCardStorageBucket）——别按新桶的位置去找旧键。
 */
function legacyStoreFor(type: keyof SmartCardPersistedStorage): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const store = type === 'sessionStorage' ? window.sessionStorage : window.localStorage;
    return store || null;
  } catch {
    return null;
  }
}

/**
 * 旧键前缀候选（含尾部 `:`）。
 *
 * 为什么可能有多个：大堂轨 `buildCardScriptStorageKey` 用的是**原始** characterId
 * （card-script-runner 传进来的那个），新键用的是 `normalizeSmartCardStorageId` 清洗后的 id。
 * UUID 下两者相同；含空格等字符时不同。两个候选都扫一遍取并集 —— 迁移宁可多搬，
 * 也不能因为 id 形态不一致而把解锁态判成"没有旧数据"。
 *
 * 没有角色身份时旧键落在 `__anonymous__` 桶（card-script-runner 的兜底），同样纳入。
 */
export function getLegacyCardStoragePrefixes(
  context: CharacterSmartCardContext,
  type: keyof SmartCardPersistedStorage,
): string[] {
  const ns = legacyNamespaceFor(type);
  const raw = String(context?.characterId ?? '').trim();
  if (!raw) {
    // 没有角色身份时大堂轨写在 __anonymous__ 桶里（card-script-runner 的兜底），直接认领它。
    // ⚠️ 不能拿清洗后的占位符 'global-character' 当候选 —— 那是新键的命名空间名，
    // 大堂轨从来没用它写过键，扫它等于什么都扫不到。
    return [`${LEGACY_CARD_SCRIPT_STORAGE_PREFIX}__anonymous__:${ns}:`];
  }
  const normalized = normalizeSmartCardStorageId(context?.characterId, 'global-character');
  const candidates = [raw];
  if (normalized && normalized !== raw) candidates.push(normalized);
  return candidates.map((id) => `${LEGACY_CARD_SCRIPT_STORAGE_PREFIX}${id}:${ns}:`);
}

/**
 * 把某张卡的旧键扫成一个桶。**纯读**，不写任何东西、不动任何键。
 */
export function collectLegacyCardStorageBucket(
  context: CharacterSmartCardContext,
  type: keyof SmartCardPersistedStorage,
): Record<string, string> {
  const store = legacyStoreFor(type);
  if (!store) return {};
  const prefixes = getLegacyCardStoragePrefixes(context, type);
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < store.length; i += 1) {
      const fullKey = store.key(i);
      if (!fullKey) continue;
      let matched = '';
      for (const prefix of prefixes) {
        if (fullKey.startsWith(prefix)) {
          matched = prefix;
          break;
        }
      }
      if (!matched) continue;
      const rawKey = fullKey.slice(matched.length);
      if (!rawKey) continue;
      const value = store.getItem(fullKey);
      if (typeof value !== 'string') continue;
      out[rawKey] = value;
      if (Object.keys(out).length >= SMART_CARD_STORAGE_MAX_KEYS) break;
    }
  } catch {
    // 存储被禁用 / 遍历中途被改动：按"没有可迁数据"处理，绝不冒泡到卡片运行时。
    return {};
  }
  return out;
}

/**
 * 迁移落盘：把扫出来的旧键内容抄进新键。
 *
 * 只写新键，**不碰旧键**（回退完整性，约束 1）。
 * 扫不到东西时不写空桶 —— 留着"新键仍缺失"这个事实，让大堂轨后续再写进来的旧键
 * 还有机会被下一次读搬上来。
 */
export function migrateLegacySmartCardBucket(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  type: keyof SmartCardPersistedStorage,
): Record<string, string> {
  const bucket = collectLegacyCardStorageBucket(context, type);
  if (Object.keys(bucket).length === 0) return {};
  writeSmartCardStorageBucket(context, sourceFingerprint, type, bucket);
  return bucket;
}


export function readSmartCardStorageBucket(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  type: keyof SmartCardPersistedStorage,
): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(getSmartCardStorageKey(context, sourceFingerprint, type));
    // 新键缺失（注意：存在但内容损坏不算缺失，走下面原样的解析/兜底路径）→ 抄写迁移
    if (raw === null || raw === undefined) {
      return migrateLegacySmartCardBucket(context, sourceFingerprint, type);
    }
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
        .slice(0, SMART_CARD_STORAGE_MAX_KEYS),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}


export function readSmartCardPersistedStorage(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
): SmartCardPersistedStorage {
  return {
    localStorage: readSmartCardStorageBucket(context, sourceFingerprint, 'localStorage'),
    sessionStorage: readSmartCardStorageBucket(context, sourceFingerprint, 'sessionStorage'),
  };
}


export function writeSmartCardStorageBucket(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  type: keyof SmartCardPersistedStorage,
  values: Record<string, string>,
) {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(values)
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
      .slice(-SMART_CARD_STORAGE_MAX_KEYS);
    window.localStorage.setItem(
      getSmartCardStorageKey(context, sourceFingerprint, type),
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {}
}


export function applySmartCardStoragePatch(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  patch: unknown,
) {
  if (!patch || typeof patch !== 'object') return;
  const { storageType, op, key, value } = patch as {
    storageType?: keyof SmartCardPersistedStorage;
    op?: string;
    key?: unknown;
    value?: unknown;
  };
  const type = storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
  const bucket = readSmartCardStorageBucket(context, sourceFingerprint, type);

  if (op === 'clear') {
    writeSmartCardStorageBucket(context, sourceFingerprint, type, {});
    return;
  }

  const storageKey = String(key ?? '');
  if (!storageKey) return;
  if (op === 'remove') {
    delete bucket[storageKey];
  } else if (op === 'set') {
    bucket[storageKey] = String(value ?? '');
  } else {
    return;
  }
  writeSmartCardStorageBucket(context, sourceFingerprint, type, bucket);
}

