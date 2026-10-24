/**
 * [UI-2 2026-10-24] style_removal 取证 · 会话级聚合器（父侧）
 *
 * 病灶（REPORT_ST三面一致性差距评估_装配显示与插件API_2026-10-24.md §3 D-4）：
 * 真机每轮 ~168 条 style_removal 记录——帧内取证观察器
 * （runtime-body/part-08.ts 的 installStyleRemovalForensicsInFrame，每次安装上限 24 条）
 * 在 srcDoc 每轮重建 iframe 后整体重装，帧内计数器归零 ⇒ 同一批节点身份（样式实际健在，
 * 守护一直在恢复）被反复全额上报；父侧收集器（CharacterCardRenderer handleMessage 的
 * frame-error 分支）逐条 console.error + 逐条塞 __palinkFrameErrors，控制台噪音淹没真错误。
 *
 * 为什么聚合必须在**父侧**：帧内任何状态（含取证观察器的闭包）都活不过一次 iframe 重建；
 * 唯一跨帧、跨轮存活的位置是主文档的模块作用域 / window。
 *
 * 聚合口径（复用 recordStubHitOnce / recordPalinkDiag 的既有模式：首次全量、后续只计数）：
 *   - 去重键 = kind（node_removed / node_replaced，即"原因"）+ 首个被移除样式节点的身份
 *     （id → href → tagName+textLen 兜底）。不同节点、不同原因不合并；
 *   - 首次：照旧走 CharacterCardRenderer 的通用全量记录（__palinkFrameErrors 一条 + 一条
 *     console.error，取证字段一个不少），同时把计数挂到本模块的会话账；
 *   - 后续：只累加 count（window.__palinkStyleRemovalAgg 实时可读；diag 启用时经
 *     recordPalinkDiag 进诊断导出面，palinkDiagDump 的 records[].count 可直接读到 N），
 *     不再产生新的 __palinkFrameErrors 条目、不再逐条刷 console。
 *
 * ⛔ 红线（与 style-removal-forensics 契约测试同款）：
 *   - 只动「记录」，不动 STYLE-GUARD 的守护/恢复范围（不 import、不调用 restoreCardStyles /
 *     takeStyleSnapshot / guardSnapshot）；
 *   - 不弹任何 UI / toast，不新建 postMessage 桥；
 *   - 帧内上报点（part-08.ts）零改动。
 */

import { recordPalinkDiag } from './palink-diag';

/** 帧内取证观察器打的固定 reason 标记（part-08.ts:1851 errorReason 字段）。 */
export const STYLE_REMOVAL_FORENSICS_REASON = 'style_removal_forensics';

/** 会话账挂 window 的键（与 __palinkFrameErrors / __palinkStyleGuard 同口径的观测面）。 */
export const STYLE_REMOVAL_AGG_WINDOW_KEY = '__palinkStyleRemovalAgg';

/** 会话键上限：正常卡只有个位数身份；病态卡伪造海量 id 时按插入序淘汰最旧键，防无界增长。 */
const MAX_SESSION_KEYS = 128;

export interface StyleRemovalAggEntry {
  /** 同键累计事件数（含首次）。 */
  count: number;
  /** 被聚合吞掉的重复条数 = count - 1。 */
  suppressed: number;
  firstAt: number;
  lastAt: number;
}

/** 会话级去重账（模块作用域 = 主文档会话；页面重载即清零，与 recordStubHitOnce 的会话边界同口径）。 */
const sessionAgg = new Map<string, StyleRemovalAggEntry>();

function syncWindow(): void {
  if (typeof window === 'undefined') return;
  try {
    (window as unknown as Record<string, unknown>)[STYLE_REMOVAL_AGG_WINDOW_KEY] = sessionAgg;
  } catch { /* 观测面挂不上就算了，不影响聚合本身 */ }
}

/** 是否为 style_removal 取证上报帧消息（只有这类消息走聚合；其它 frame-error 原样逐条）。 */
export function isStyleRemovalForensicPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return String((data as Record<string, unknown>).errorReason || '') === STYLE_REMOVAL_FORENSICS_REASON;
}

interface NodeIdentityShape {
  tagName?: unknown;
  id?: unknown;
  textLen?: unknown;
  attrs?: unknown;
}

/**
 * 从帧消息载荷提取「节点身份」字符串。
 * 粒度：id（有 id 的 style/link 一律以 id 为准）→ attrs.href（外链样式表）→
 * tagName+textLen 兜底（匿名内联样式；同长度的匿名样式会合并，属可接受的近似）。
 */
function nodeIdentityOf(node: NodeIdentityShape): string {
  const tag = String(node && node.tagName || '').toUpperCase() || 'NODE';
  const id = String(node && node.id || '');
  if (id) return `${tag}#${id}`;
  const attrs = node && node.attrs;
  const href = attrs && typeof attrs === 'object'
    ? String((attrs as Record<string, unknown>).href || '')
    : '';
  if (href) return `${tag}@${href}`;
  const len = Number(node && node.textLen);
  return `${tag}#-@len${Number.isFinite(len) ? len : -1}`;
}

/**
 * 计算去重键：`kind|identity`。载荷缺身份（无 removedStyled[0]）时返回 null——
 * 这类消息不聚合，由调用方回退到旧的逐条记录行为（信息不降级）。
 */
export function styleRemovalAggKeyOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const kind = String(payload.kind || '');
  if (!kind) return null;
  const node = payload.node;
  const removed = node && typeof node === 'object'
    ? (node as Record<string, unknown>).removedStyled
    : null;
  const first = Array.isArray(removed) && removed.length > 0
    ? removed[0] as NodeIdentityShape
    : null;
  if (!first || typeof first !== 'object') return null;
  return `${kind}|${nodeIdentityOf(first)}`;
}

export interface AbsorbStyleRemovalResult {
  /** true = 本条是该键的会话首次（调用方照旧全量记录）；false = 重复（调用方静默返回）。 */
  first: boolean;
  /** 会话键；载荷不可键化时为 null（此时 first 恒 true，等价旧行为）。 */
  key: string | null;
}

/**
 * 吸收一条 style_removal 取证帧消息：
 *   1. 会话账计数（首次建键 / 重复累加）；
 *   2. diag 启用时同步写一条 recordPalinkDiag（其自身按 name 聚合 ⇒ count=N 可从
 *      palinkDiagDump() / __palinkDiagDump() 的导出 JSON 读到；detail 首次写入后续不覆盖）；
 *   3. 返回 first 标记，由 CharacterCardRenderer 决定是否落 __palinkFrameErrors / console。
 */
export function absorbStyleRemovalFrameError(
  data: unknown,
  meta: { frameId?: string; cardId?: string } = {},
): AbsorbStyleRemovalResult {
  const key = styleRemovalAggKeyOf(data);
  if (!key) return { first: true, key: null };

  const now = Date.now();
  let entry = sessionAgg.get(key);
  if (!entry) {
    if (sessionAgg.size >= MAX_SESSION_KEYS) {
      // Map 迭代序 = 插入序，首个键即最旧；淘汰后同键再来会重新「首次」，代价是多一条全量记录。
      const oldest = sessionAgg.keys().next().value;
      if (oldest !== undefined) sessionAgg.delete(oldest);
    }
    entry = { count: 0, suppressed: 0, firstAt: now, lastAt: now };
    sessionAgg.set(key, entry);
  }
  entry.count += 1;
  entry.lastAt = now;
  entry.suppressed = entry.count - 1;
  syncWindow();

  const payload = data as Record<string, unknown>;
  const node = payload.node as Record<string, unknown> | undefined;
  const removed = node && Array.isArray(node.removedStyled) ? (node.removedStyled[0] as NodeIdentityShape) : null;
  try {
    recordPalinkDiag({
      owner: 'frame_compat',
      kind: 'frame_record',
      name: `style_removal:${key}`,
      detail: String(payload.message || ''),
      filename: typeof payload.filename === 'string' ? payload.filename : '',
      textLength: removed && Number.isFinite(Number(removed.textLen)) ? Number(removed.textLen) : -1,
      frameId: String(meta.frameId || ''),
      cardId: String(meta.cardId || ''),
      origin: 'frame',
    });
  } catch { /* diag 写失败不影响聚合与首条判定 */ }

  return { first: entry.count === 1, key };
}

/** 读取会话账快照（测试与真机查验用）。 */
export function getStyleRemovalAggSnapshot(): ReadonlyMap<string, StyleRemovalAggEntry> {
  return sessionAgg;
}

/** 清空会话账（仅测试用；真机以页面会话为界，不主动清）。 */
export function resetStyleRemovalAggForTest(): void {
  sessionAgg.clear();
  if (typeof window !== 'undefined') {
    try {
      delete (window as unknown as Record<string, unknown>)[STYLE_REMOVAL_AGG_WINDOW_KEY];
    } catch { /* ignore */ }
  }
}
