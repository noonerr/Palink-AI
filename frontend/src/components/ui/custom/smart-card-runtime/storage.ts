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


export type SmartCardPersistedStorage = {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};


export const SMART_CARD_STORAGE_PREFIX = 'palink:smart-card-storage:v1:';


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


export function readSmartCardStorageBucket(
  context: CharacterSmartCardContext,
  sourceFingerprint: string,
  type: keyof SmartCardPersistedStorage,
): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(getSmartCardStorageKey(context, sourceFingerprint, type));
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
        .slice(0, 500),
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
      .slice(-500);
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

