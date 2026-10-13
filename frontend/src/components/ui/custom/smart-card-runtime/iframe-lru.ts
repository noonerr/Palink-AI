/*
 * iframe 存活配额（T2 · LRU 封顶）—— **纯逻辑**，不碰 DOM、不碰 React。
 *
 * 背景：S0 实测（REPORT_S0备料基线与回退演练档案 §6.1）
 *   堆随 iframe 数增长：7 个 → 113MB，48 个 → 560MB（GC 后 ~300MB），
 *   边际 ≈ +9~11MB/个且只增不减；每千像素滚动主线程耗时 28.1ms → 42.3ms（1.51×）。
 * 并轨后所有卡都走 iframe ⇒ 必须给存活数封顶，否则长会话线性劣化。
 *
 * 为什么是"配额"而不是"出视野即卸载"：卸载会让 iframe 重建 = 一次导航，
 * 而 Safari 的会话历史是**联合**的（顶层 + 所有子框架），每次 iframe 导航插一条
 * 幽灵条目 ⇒ 滑动返回会闪过 N 个一模一样的快照，且 iOS 无 API 删除历史条目。
 * （事故原文见 Message.tsx:645-652。）⇒ 用配额把"逐出-重建"的次数**限界**，
 * 而不是每次滚动都付这个代价。
 *
 * 设计要点
 * - cap 显著大于可见集（可见约 2~3 个 + 一屏缓冲）⇒ 普通会话根本不触发逐出，**行为零变化**。
 * - **可见项永不逐出**：宁可短暂超过配额，也不能把用户正看着的卡片卸掉。
 *   所以 cap 是"隐藏项的目标上界"，不是硬性上界。
 * - iOS 分档更大（见 DEFAULT_IFRAME_LRU_POLICY）：内存仍有上限，但把幽灵条目的
 *   产生限制在"真的来回翻超过配额"的极端场景。是否分档、档位多少属策略参数，
 *   落地在 Message.tsx 的 SmartCardDormancyGate（本模块只提供算法）。
 *
 * 红线：不得为省内存去改卡脚本语义或变量持久化逻辑。
 */
export interface IframeLruPolicy {
  /** 非 iOS 的存活配额（激进：内存优先） */
  nonIosCap: number;
  /** iOS 的存活配额（保守：内存仍有上限，但压低逐出-重建次数） */
  iosCap: number;
}

/**
 * 默认配额。
 * ⚠️ iOS 档待拍板（G8）：若后续真机复验那条 iOS 幽灵历史回归已不复现，
 *    可直接把 iosCap 调成与 nonIosCap 一致 —— **改一个值即可，不需改结构**。
 */
export const DEFAULT_IFRAME_LRU_POLICY: IframeLruPolicy = {
  nonIosCap: 16,
  iosCap: 40,
};

/** 按平台取配额。isIos 由调用方用仓库既有口径（isIOSLikeDevice）判断，本模块不另造一套。 */
export function resolveIframeCap(policy: IframeLruPolicy, isIos: boolean): number {
  return isIos ? policy.iosCap : policy.nonIosCap;
}

interface Entry {
  visible: boolean;
  /** 最后一次"被看到/被触碰"的单调序号，越大越新 */
  lastSeen: number;
}

export class IframeLru {
  private entries = new Map<string, Entry>();
  /** id → 该卡被逐出时要通知的回调集合（组件用它把自己切到占位态）。 */
  private listeners = new Map<string, Set<() => void>>();
  private seq = 0;
  private cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, cap);
  }

  get size(): number {
    return this.entries.size;
  }

  getCap(): number {
    return this.cap;
  }

  setCap(cap: number): void {
    this.cap = Math.max(1, cap);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  isVisible(id: string): boolean {
    return this.entries.get(id)?.visible === true;
  }

  visibleCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.visible) n += 1;
    return n;
  }

  /** 幂等：重复注册同一 id 不会产生重复项，也不会刷新 lastSeen。 */
  register(id: string, visible = false): void {
    if (this.entries.has(id)) return;
    this.entries.set(id, { visible, lastSeen: ++this.seq });
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  /** 更新可见性并刷新"最后见到"时间。未注册的 id 静默忽略（调用方保证先 register）。 */
  markVisible(id: string, visible: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.visible = visible;
    e.lastSeen = ++this.seq;
  }

  /**
   * 超出配额时，挑一个该被逐出的 id：
   * 规则 = 在当前**不可见**的里面选 `lastSeen` 最小（最久未见）的那个。
   * 不超限、或所有项都可见 ⇒ 返回 null（可见项永不逐出）。
   */
  pickEviction(): string | null {
    if (this.entries.size <= this.cap) return null;
    let victim: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, e] of this.entries) {
      if (e.visible) continue;
      if (e.lastSeen < oldest) {
        oldest = e.lastSeen;
        victim = id;
      }
    }
    return victim;
  }

  /**
   * 反复挑直到回到配额内（逐个交给调用方卸载）。
   * 全可见导致无法再逐出时提前返回，不会死循环。
   */
  pickEvictions(max = 64): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < max; i += 1) {
      const victim = this.pickEviction();
      if (!victim || seen.has(victim)) break;
      seen.add(victim);
      out.push(victim);
      this.unregister(victim);
    }
    return out;
  }

  /**
   * 订阅某 id 被逐出的事件；返回退订函数。
   *
   * 为什么需要它（2026-10-13 真机实证的缺陷）：逐出决策是**全局**的（挑"最久未见的隐藏项"），
   * 而受害者按定义就是**更早变隐藏**的那张卡 —— 它的 IntersectionObserver 状态早已稳定、
   * 回调不会再跑。所以"谁刚睡着谁检查自己是不是受害者"（`pickEviction() === cardId`）
   * 在结构上永远打不中：真机 cap=3 且 size=5>3，逐出数恒为 0。
   * ⇒ 必须由内核统一逐出，并**主动通知受害者本人**去卸载自己。
   */
  onEviction(id: string, handler: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(handler);
    return () => {
      const cur = this.listeners.get(id);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this.listeners.delete(id);
    };
  }

  /**
   * 超配额时统一逐出最久未见的隐藏项，并通知其订阅者卸载（受害者自己 setState）。
   * 调用点 = 任何可能把在册数推过配额的动作之后（登记、翻可见性）。
   * 返回被逐出的 id 列表（便于测试与诊断）。
   */
  enforceCap(max = 64): string[] {
    const victims = this.pickEvictions(max);
    for (const id of victims) {
      const set = this.listeners.get(id);
      if (!set) continue;
      for (const handler of Array.from(set)) handler();
    }
    return victims;
  }

  /** 调试/诊断用：id → {visible,lastSeen} 快照。 */
  snapshot(): Array<{ id: string; visible: boolean; lastSeen: number }> {
    return Array.from(this.entries.entries()).map(([id, e]) => ({ id, visible: e.visible, lastSeen: e.lastSeen }));
  }
}

/** 进程内共享的单例（多个消息组件共用一个配额视图）。测试请自建实例。 */
let shared: IframeLru | null = null;

export function getSharedIframeLru(policy: IframeLruPolicy = DEFAULT_IFRAME_LRU_POLICY, isIos = false): IframeLru {
  if (!shared) shared = new IframeLru(resolveIframeCap(policy, isIos));
  // [T2 诊断专用 · 可随时删除] 把单例挂到 window 供真机探针读取。
  // 为什么不靠 console：生产包 terser drop_console 剥掉全部 console（含 warn），
  // 日志和截图都取不到证，只能用运行时对象。本段不参与任何产品逻辑。
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__palinkIframeLru = {
      cap: () => shared!.getCap(),
      size: () => shared!.size,
      visibleCount: () => shared!.visibleCount(),
      snapshot: () => shared!.snapshot(),
    };
  }
  return shared;
}

/** 仅供测试重置单例。 */
export function __resetSharedIframeLruForTest(): void {
  shared = null;
}
