/**
 * vitest setup（仅测试环境，不进生产构建）：补齐 jsdom 未实现的浏览器全局。
 *
 * 两件独立的事，都是原 `npm run test:contract` 里 _tsx-loader.mjs 手工 mock 过的同一批：
 *
 * 1) localStorage / sessionStorage
 *    Node 22.4+/25 在 globalThis 上内置了同名访问器，其取值依赖 `--localstorage-file`；
 *    未给路径时 getter 返回的对象**没有 getItem/setItem**（实测
 *    `typeof localStorage.getItem === 'undefined'`，并伴随
 *    `Warning: --localstorage-file was provided without a valid path`）。
 *    该内置访问器优先级高于 jsdom，vitest 往 globalThis 拷贝 window 属性时被它挡住。
 *    后果：src/lib/i18n/index.ts:111 在模块顶层 new I18nManager 即抛，
 *    连带 getContext.ts:38 的整条 import 链在收集阶段崩。
 *
 * 2) window.matchMedia
 *    jsdom 根本不实现 matchMedia（Jest/RTL 生态的著名缺口）。
 *    后果：getContext.ts:2520 的 `isMobile` 表达式
 *    `typeof window !== 'undefined' && window.matchMedia && window.matchMedia(...).matches`
 *    短路成 `undefined`（而非真实浏览器里的布尔值），使 getcontext-parity 误报
 *    「API 缺失: isMobile」。真实浏览器恒有 matchMedia，故这不是业务代码缺陷，
 *    是测试环境缺口。
 *
 * 语义按浏览器对齐：jsdom 默认视口 1024x768 → `(max-width: 767px)` 不命中，
 * matches 返回 false（与真实浏览器、与旧 loader 的 mock 三者一致）。
 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    const k = String(key);
    return this.map.has(k) ? this.map.get(k)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** MediaQueryList 桩：jsdom 未实现，按 jsdom 默认视口一律不命中。 */
function matchMediaStub(query: string): MediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    media: String(query ?? ''),
    matches: false,
    onchange: null,
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject | null) => {
      if (cb) listeners.add(cb as (e: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject | null) => {
      if (cb) listeners.delete(cb as (e: MediaQueryListEvent) => void);
    },
    dispatchEvent: () => true,
    // 已废弃的旧接口，ST 插件生态仍在用
    addListener: (cb: ((e: MediaQueryListEvent) => void) | null) => { if (cb) listeners.add(cb); },
    removeListener: (cb: ((e: MediaQueryListEvent) => void) | null) => { if (cb) listeners.delete(cb); },
  };
  return mql as unknown as MediaQueryList;
}

installStorage('localStorage');
installStorage('sessionStorage');

if (typeof (globalThis as { matchMedia?: unknown }).matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: matchMediaStub,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export {};
