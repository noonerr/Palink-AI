/**
 * 卡脚本存档的服务端写穿同步（2026-10-02，P2）
 *
 * 定位：**只是备份副本**。前后端口径是「本地永远先命中」——卡脚本读写走的始终是
 * 本地命名空间（card-script-storage.ts），这里负责把变更异步回推服务端，
 * 并在进入角色页时拉一次覆盖本地。
 *
 * 三条纪律：
 *   1. **任何失败都必须静默**。离线、后端未部署、401、500 —— 一律降级为纯本地，
 *      绝不能让同步层的异常冒泡到卡脚本（卡脚本崩 = 整页交互失效）。
 *   2. **只同步 local，不同步 session**。sessionStorage 语义就是"这个标签页临时看到"，
 *      搬到服务端反而制造跨标签页污染，与本次修的目标背道而驰。
 *   3. **连续失败要闭嘴**。后端没端点时每写一次配一次请求，会在控制台刷屏到不可用。
 */

import { api } from '@/services/api';
import {
  hydrateCardScriptStorageFromServer,
  setCardScriptStorageSyncer,
  type CardScriptStorageNs,
} from './card-script-storage';

const FLUSH_DELAY_MS = 800;
const MAX_ENTRIES_PER_FLUSH = 200;
/** 连续失败多少次之后彻底放弃（本页会话内） */
const MAX_CONSECUTIVE_FAILURES = 3;

type PendingEntry = { key: string; value: string | null };

const pending = new Map<string, PendingEntry>();

let activeCharacterId: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let syncDisabled = false;

function storageUrl(characterId: string): string {
  return `/api/characters/${encodeURIComponent(characterId)}/plugin-storage`;
}

/**
 * 服务端数据是否可用。disabled 之后不再发起任何请求，
 * 但要保��已经有本地值（降级为纯本地）。
 */
function canSync(): boolean {
  return Boolean(activeCharacterId) && !syncDisabled;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const characterId = activeCharacterId;
  if (!characterId || syncDisabled || pending.size === 0) return;

  const entries = Array.from(pending.values())
    .filter((e) => typeof e.key === 'string' && e.key.length > 0)
    .slice(0, MAX_ENTRIES_PER_FLUSH);
  pending.clear();
  if (entries.length === 0) return;

  try {
    await api.put(storageUrl(characterId), { ns: 'local', entries });
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      syncDisabled = true;
      console.warn(
        '[card-storage] 服务端同步连续失败已达上限，本次会话降级为纯本地（不影响卡脚本使用）',
      );
    }
  }
}

function scheduleFlush(): void {
  if (!canSync() || flushTimer) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_DELAY_MS);
}

/**
 * 为某张卡挂载同步，返回卸载函数。
 *
 * 挂载时会先 register syncer 再 hydrate —— 顺序反了的话，
 * hydrate 拉下来的值写进本地命名空间会触发 push，等于把服务端数据原样推回去（虽然幂等，但纯属浪费）。
 */
export function installCardScriptStorageSync(characterId: string | null): () => void {
  if (!characterId) return () => {};
  activeCharacterId = characterId;
  consecutiveFailures = 0;
  syncDisabled = false;

  setCardScriptStorageSyncer({
    pull: async (id: string, ns: CardScriptStorageNs) => {
      // session 不同步（纪律 2）
      if (ns !== 'local' || !canSync()) return null;
      try {
        const res = await api.get<{ values?: Record<string, string> }>(
          `${storageUrl(id)}?ns=${encodeURIComponent(ns)}`,
        );
        consecutiveFailures = 0;
        return res?.values ?? null;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) syncDisabled = true;
        return null;
      }
    },
    push: (_id: string, ns: CardScriptStorageNs, entries: PendingEntry[]) => {
      if (ns !== 'local' || !canSync()) return;
      // key 维度去重：卡脚本连续写同一个键时，只有最后一次有价值
      for (const entry of entries) pending.set(entry.key, entry);
      if (pending.size > MAX_ENTRIES_PER_FLUSH * 4) {
        // 极端场景下丢弃最早的变更，保住内存水位
        const overflow = pending.size - MAX_ENTRIES_PER_FLUSH * 4;
        Array.from(pending.keys())
          .slice(0, overflow)
          .forEach((k) => pending.delete(k));
      }
      scheduleFlush();
    },
  });

  void hydrateCardScriptStorageFromServer(characterId, 'local');

  return () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pending.clear();
    activeCharacterId = null;
    setCardScriptStorageSyncer(null);
  };
}

/** 仅供测试：把内部状态复位。 */
export function __resetCardScriptStorageSyncForTests(): void {
  pending.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  activeCharacterId = null;
  consecutiveFailures = 0;
  syncDisabled = false;
}
