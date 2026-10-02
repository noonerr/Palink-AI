/**
 * 卡脚本本地存储的「按角色命名空间」层（2026-10-02，P0 批次）
 *
 * 背景（见 docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md §2.1–2.4）：
 * 角色卡自带的 tavern_helper 脚本把解锁态写在**全局** localStorage 键上
 * （实测 `localStorage['tavern_cg_album_unlocked'] = ["露出魔纹1","哭哭1"]`），
 * 键名硬编码在卡里（我们改不了卡），于是删卡重导、同名多卡、同浏览器多账号三头互相污染。
 * 用户口径：「这玩意跟着卡的 ID 走，卡的 ID 跟着用户走。」
 *
 * 本模块给卡脚本提供一个**看起来就是 Storage、实际读写项链到角色名下**的对象，
 * 由 card-script-runner 在注入前把脚本里的 `localStorage` 文本替换成它。
 *
 * 四条必须守住的语义：
 *   1. **绝不抛错**。脚本万一拿到半坏的 Storage 就会当场崩，直接回到 2026-09-30
 *      「整页内容空白」那类事故。所有外部调用一律 try/catch 兜到底。
 *   2. **clear() 只清自己的命名空间**。原语义是 `localStorage.clear()` 清空整个 origin，
 *      卡里真这么写的话会把 Palink 自己的登录态一起抹掉 —— 这是必须拦下的副作用。
 *   3. **不回读旧全局键**。历史遗留的无命名空间键一律视为脏数据，不迁移、不认领 ——
 *      本产品在上线前无真实用户，迁移没有任何保护对象，只会把上一张卡的解锁污染给下一张。
 *   4. **同步失败静默降级**。服务端落库（P2）只是锦上添花，拿不到就当纯本地用。
 */

/** 新增常量而非复用 SMART_CARD_STORAGE_PREFIX：两条是不同的桶语义，混用会互相踩。 */
export const CARD_SCRIPT_STORAGE_PREFIX = 'palink:card-storage:v1:';

/** 单次命名空间的键数上限，防止卡脚本写出天文数字把 localStorage 撑爆 */
const MAX_KEYS_PER_NAMESPACE = 2000;

export type CardScriptStorageNs = 'local' | 'session';

/**
 * 服务端同步钩子（P2 写穿）。**允许返回 Promise、允许抛错**，
 * 调用方一律吞掉并保证降级为纯本地。
 */
export interface CardScriptStorageSyncer {
  /** 进入角色页时拉一次，返回值会被写入本地命名空间（服务端为准） */
  pull?: (
    characterId: string,
    ns: CardScriptStorageNs,
  ) => Promise<Record<string, string> | null | undefined> | Record<string, string> | null | undefined;
  /** 本地写入后回推；value 为 null 表示删除 */
  push?: (
    characterId: string,
    ns: CardScriptStorageNs,
    entries: Array<{ key: string; value: string | null }>,
  ) => void;
}

let activeSyncer: CardScriptStorageSyncer | null = null;

/** 注册全局 syncer（通常在角色页面挂载时调用一次，卸载时传 null）。 */
export function setCardScriptStorageSyncer(syncer: CardScriptStorageSyncer | null): void {
  activeSyncer = syncer;
}

/** `<prefix><characterId>:<ns>:<rawKey>` */
export function buildCardScriptStorageKey(
  characterId: string,
  ns: CardScriptStorageNs,
  rawKey: string,
): string {
  return `${CARD_SCRIPT_STORAGE_PREFIX}${characterId}:${ns}:${rawKey}`;
}

/** 该命名空间在底层存储里的枚举前缀 */
function namespacePrefix(characterId: string, ns: CardScriptStorageNs): string {
  return `${CARD_SCRIPT_STORAGE_PREFIX}${characterId}:${ns}:`;
}

function underlyingStorage(ns: CardScriptStorageNs): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const store = ns === 'session' ? window.sessionStorage : window.localStorage;
    return store || null;
  } catch {
    return null;
  }
}

/**
 * 卡脚本可见的 Storage 视图。
 * 故意不实现索引 getter（`Object.defineProperty(this, i, ...)`）——
 * 真实 Storage 支持 `localStorage[0]`，但脚本普遍只用 getItem/setItem/removeItem/clear/key/length，
 * 少一个冷门能力换取「不做动态属性」带来的可预测性，值。
 */
export class CardScriptStorage {
  private readonly characterId: string;
  private readonly ns: CardScriptStorageNs;

  constructor(characterId: string, ns: CardScriptStorageNs) {
    this.characterId = characterId;
    this.ns = ns;
  }

  get length(): number {
    try {
      return this.collectRawKeys().length;
    } catch {
      return 0;
    }
  }

  key(index: number): string | null {
    try {
      const keys = this.collectRawKeys();
      return typeof index === 'number' && index >= 0 && index < keys.length ? keys[index] : null;
    } catch {
      return null;
    }
  }

  getItem(rawKey: string): string | null {
    const key = String(rawKey ?? '');
    if (!key) return null;
    const store = underlyingStorage(this.ns);
    if (!store) return null;
    try {
      return store.getItem(buildCardScriptStorageKey(this.characterId, this.ns, key));
    } catch {
      return null;
    }
  }

  setItem(rawKey: string, value: string): void {
    const key = String(rawKey ?? '');
    if (!key) return;
    const store = underlyingStorage(this.ns);
    if (!store) return;
    try {
      const nsKey = buildCardScriptStorageKey(this.characterId, this.ns, key);
      // 超限保护：新建键且已达上限时拒写，而不是让整个 localStorage 被 QuotaExceededError 打挂
      if (store.getItem(nsKey) === null && this.collectRawKeys().length >= MAX_KEYS_PER_NAMESPACE) {
        console.warn(
          `[card-storage] 命名空间键数已达上限 ${MAX_KEYS_PER_NAMESPACE}，拒写 ${this.characterId} 的 ${key}`,
        );
        return;
      }
      store.setItem(nsKey, String(value ?? ''));
      this.pushChange([{ key, value: String(value ?? '') }]);
    } catch {
      /* 配额/隐私模式，静默失败 —— 卡脚本不该因此崩 */
    }
  }

  removeItem(rawKey: string): void {
    const key = String(rawKey ?? '');
    if (!key) return;
    const store = underlyingStorage(this.ns);
    if (!store) return;
    try {
      store.removeItem(buildCardScriptStorageKey(this.characterId, this.ns, key));
      this.pushChange([{ key, value: null }]);
    } catch {
      /* ignore */
    }
  }

  /** 只清本命名空间，绝不动 Palink 自身与其它卡的键（语义约束 2）。 */
  clear(): void {
    const store = underlyingStorage(this.ns);
    if (!store) return;
    try {
      const prefix = namespacePrefix(this.characterId, this.ns);
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k && k.startsWith(prefix)) doomed.push(k);
      }
      doomed.forEach((k) => {
        try {
          store.removeItem(k);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** 把服务端拉回来的值整体铺进本地命名空间（服务端为准）。 */
  hydrate(values: Record<string, string> | null | undefined): void {
    if (!values || typeof values !== 'object') return;
    const store = underlyingStorage(this.ns);
    if (!store) return;
    try {
      Object.entries(values).forEach(([k, v]) => {
        if (typeof k === 'string' && typeof v === 'string') {
          store.setItem(buildCardScriptStorageKey(this.characterId, this.ns, k), v);
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** 导出本地当前全部条目（给服务端 push 用）。 */
  exportEntries(): Record<string, string> {
    const store = underlyingStorage(this.ns);
    if (!store) return {};
    const prefix = namespacePrefix(this.characterId, this.ns);
    const out: Record<string, string> = {};
    try {
      this.collectRawKeys().forEach((raw) => {
        const v = store.getItem(prefix + raw);
        if (typeof v === 'string') out[raw] = v;
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  private collectRawKeys(): string[] {
    const store = underlyingStorage(this.ns);
    if (!store) return [];
    const prefix = namespacePrefix(this.characterId, this.ns);
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
    }
    return keys;
  }

  /** 回推服务端。任何异常都不允许冒泡到卡脚本。 */
  private pushChange(entries: Array<{ key: string; value: string | null }>): void {
    try {
      activeSyncer?.push?.(this.characterId, this.ns, entries);
    } catch {
      /* 同步失败 = 纯本地降级，不打扰卡脚本 */
    }
  }
}

const viewCache = new Map<string, CardScriptStorage>();

/**
 * 取（或惰性创建）某张卡在某个 ns 下的 Storage 视图。
 * 同一 (characterId, ns) 返回同一个对象实例：卡脚本里常见
 * `const ls = localStorage;` 之后再反复用，对象漂移会让人百思不得其解。
 */
export function getCardScriptStorage(
  characterId: string,
  ns: CardScriptStorageNs,
): CardScriptStorage {
  const cacheKey = `${ns}:${characterId}`;
  const hit = viewCache.get(cacheKey);
  if (hit) return hit;
  const view = new CardScriptStorage(characterId, ns);
  // 缓存上限：同浏览器换角色会不断产生新桶，简单限流避免无界增长
  if (viewCache.size > 64) viewCache.clear();
  viewCache.set(cacheKey, view);
  return view;
}

/**
 * 进入角色页时调一次：把服务端的值拉下来铺到本地。
 * 失败（离线 / 后端未部署 / 500）一律吞掉，保持纯本地可用（语义约束 4）。
 */
export async function hydrateCardScriptStorageFromServer(
  characterId: string,
  ns: CardScriptStorageNs,
): Promise<void> {
  try {
    const result = activeSyncer?.pull?.(characterId, ns);
    const values = result instanceof Promise ? await result : result;
    getCardScriptStorage(characterId, ns).hydrate(values);
  } catch {
    /* 静默降级 */
  }
}

/** 仅供测试：清掉视图缓存（缓存按 characterId 复用，跨用例必须重置）。 */
export function __resetCardScriptStorageForTests(): void {
  viewCache.clear();
}
