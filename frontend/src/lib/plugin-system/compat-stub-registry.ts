/**
 * ST 兼容层降级桩登记器
 *
 * 背景：SillyTavernPluginRuntime 为大量 ST API 提供了"无操作/部分实现"的
 * 兜底桩（injectPrompts 返回 null、getGlobalWorldbookNames 返回 [] 等），
 * 目的只是让插件不抛 ReferenceError。副作用是插件功能静默失效，
 * 用户与开发者都无法感知"插件在跑但功能是假的"。
 *
 * 本模块为每个桩的调用计数并首次告警：
 * - 控制台：每个桩名只 warn 一次（避免刷屏），附带说明
 * - window.__palinkCompatStats：实时统计对象，供控制台排查
 * - getCompatStubStats()：供插件管理页渲染降级面板
 */

export interface CompatStubStat {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 最近一次调用的上下文说明（截断到 200 字符） */
  lastDetail?: string;
}

const stats = new Map<string, CompatStubStat>();
const warnedNames = new Set<string>();

export const COMPAT_STUB_WINDOW_KEY = '__palinkCompatStats';

function syncWindow(): void {
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)[COMPAT_STUB_WINDOW_KEY] = stats;
  }
}

/**
 * 登记一次降级桩调用。
 * @param name 桩名（建议用 ST API 名或 slash:xxx 形式）
 * @param detail 可选上下文（如触发来源/参数摘要）
 */
export function recordStubHit(name: string, detail?: string): void {
  const key = String(name || 'unknown');
  const now = Date.now();
  let entry = stats.get(key);
  if (!entry) {
    entry = { count: 0, firstSeenAt: now, lastSeenAt: now };
    stats.set(key, entry);
  }
  entry.count += 1;
  entry.lastSeenAt = now;
  if (detail !== undefined && detail !== null && String(detail)) {
    entry.lastDetail = String(detail).slice(0, 200);
  }
  syncWindow();

  if (!warnedNames.has(key)) {
    warnedNames.add(key);
    console.warn(
      `[Palink 兼容层] 降级桩被调用: ${key}${detail ? ` (${detail})` : ''} — ` +
        '该 ST API 在 Palink 中为无操作/部分实现，插件相关功能可能不生效。' +
        '后续命中只计数不再重复警告（见 window.__palinkCompatStats / 插件管理页降级统计）。',
    );
  }
}

/** 读取当前统计（只读视图，供 UI 渲染） */
export function getCompatStubStats(): ReadonlyMap<string, CompatStubStat> {
  return stats;
}

/** 清空统计与告警去重（用于会话重置/手动清除） */
export function resetCompatStubStats(): void {
  stats.clear();
  warnedNames.clear();
  syncWindow();
}
