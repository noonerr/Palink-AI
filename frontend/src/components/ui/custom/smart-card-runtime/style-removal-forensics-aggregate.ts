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
 *   - 首次：（UI-2 当时）照旧走 CharacterCardRenderer 的通用全量记录（__palinkFrameErrors 一条 +
 *     一条 console.error，取证字段一个不少），同时把计数挂到本模块的会话账；
 *     —— UI-2b 起这一条也被降级：首次同样只在 shouldLog/shouldRecord 为真时才落（见下）；
 *   - 后续：只累加 count（window.__palinkStyleRemovalAgg 实时可读；diag 启用时经
 *     recordPalinkDiag 进诊断导出面，palinkDiagDump 的 records[].count 可直接读到 N），
 *     不再产生新的 __palinkFrameErrors 条目、不再逐条刷 console。
 *
 * [UI-2b 2026-10-26 用户裁定] 在 UI-2 的基础上做到「**平时静默、真出问题才报**」：
 *   - 默认路径（无开发者模式）：style_removal 取证事件**一条都不进 console**，
 *     也**不占** __palinkFrameErrors 的 50 格缓冲（缓冲留给真错误）；
 *     取证能力原样保留在会话账 / diag 导出面 / 管理页（见 getStyleRemovalForensicsSummary）。
 *   - 「真出问题」判据（逐条可测，任一命中才升级成一条 console.error + 一条 __palinkFrameErrors）：
 *       T1 head_node_removed（同步）：被移除节点里含 HEAD 本身 ⇒ 文档级拆除，不是搬家；
 *       T2 style_content_missing（延后探针）：settle 窗口（默认 1500ms，覆盖守护 800ms 自愈
 *          与卡侧"搬回"第二条腿）之后，被移除节点的身份**仍不在帧文档**的 style/link 集合里
 *          ⇒ 样式真丢失（有 id/href 的直接查身份；匿名节点还要文档样式节点数**减少**才算，
 *          防 REPORT_style_removal机制研究 §6.1 记录的 textLen 漂移假阳性）；
 *       T3 style_guard_restored（延后探针）：宿主样式守护的 restored 计数在这期间**增加过**
 *          ⇒ 样式确实被抽走过（稳态实测恒 0，见研究报告 §4.3），守护干了活就是一起真事故；
 *       T4 frame_height_collapsed（延后探针）：帧渲染高度与被检文档的 documentElement
 *          scrollHeight **同时为 0** ⇒ 关键样式丢失导致可见回归（读不到/折叠态给 -1 = 不参与判定）；
 *       T5 抛出错误：帧内真错误（errorReason 非 style_removal_forensics）走原来的逐条
 *          console.error 路径，本模块不接管、不降噪。
 *       T6 取证载荷缺节点身份（无法键化）= 取证面自身的结构异常 ⇒ 整会话只报一次，
 *          之后只累 unkeyed 总数（默认不再打扰，但异常不会完全无痕）。
 *   - 「逐条放行」挂在**既有**开发者模式开关上（AboutTab 的 developer_mode ⇒
 *     setPalinkDiagEnabled(true, true) ⇒ palinkDiagExplicitlyEnabled()）：开 = 每个取证事件
 *     一行 console（但仍只有首次进 __palinkFrameErrors，防缓冲被刷满）；默认关 = 静默。
 *     本机站点的"隐式默认开诊断"不算显式开启 ⇒ 本地日常开发同样静默。
 *     一次性逃生口 window.__palinkStyleRemovalVerbose = true 与既有 __palinkConsoleVerbose 同语义。
 *
 * ⛔ 红线（与 style-removal-forensics 契约测试同款）：
 *   - 只动「记录」，不动 STYLE-GUARD 的守护/恢复范围（不 import、不调用 restoreCardStyles /
 *     takeStyleSnapshot / guardSnapshot）；探针**只读**帧文档与守护的观测面计数；
 *   - 不弹任何 UI / toast，不新建 postMessage 桥；
 *   - 帧内上报点（part-08.ts）零改动。
 */

import { palinkDiagExplicitlyEnabled, recordPalinkDiag } from './palink-diag';

/** 帧内取证观察器打的固定 reason 标记（part-08.ts:1851 errorReason 字段）。 */
export const STYLE_REMOVAL_FORENSICS_REASON = 'style_removal_forensics';

/** 会话账挂 window 的键（与 __palinkFrameErrors / __palinkStyleGuard 同口径的观测面）。 */
export const STYLE_REMOVAL_AGG_WINDOW_KEY = '__palinkStyleRemovalAgg';

/** 一行汇总读取函数挂 window 的键（管理页 / 控制台都能读，取证不因静默而丢）。 */
export const STYLE_REMOVAL_SUMMARY_WINDOW_KEY = '__palinkStyleRemovalSummary';

/** 一次性逐条放行逃生口（与帧内 __palinkConsoleVerbose 同语义；显式 true 才生效）。 */
export const STYLE_REMOVAL_VERBOSE_WINDOW_KEY = '__palinkStyleRemovalVerbose';

/** 升级上报时替换 errorReason 的固定标记（原 style_removal_forensics 只是"看到搬家"）。 */
export const STYLE_REMOVAL_ESCALATION_REASON = 'style_removal_loss_suspected';

/**
 * settle 窗口：被移除节点在这个窗口之后仍不在帧文档 ⇒ 判真丢失。
 * 必须 **大于** 卡侧"搬回"第二条腿的耗时（实测 0.2~2.5s 落在同一文档装载内）
 * 与宿主守护 800ms 自愈节奏，否则会把正常搬家误判成事故。
 */
export const STYLE_REMOVAL_PROBE_SETTLE_MS = 3000;

/** 模块内延后探针的巡查节奏（只有 pending 非空时才有定时器，空闲归零）。 */
const STYLE_REMOVAL_PROBE_TICK_MS = 500;

/** 会话键上限：正常卡只有个位数身份；病态卡伪造海量 id 时按插入序淘汰最旧键，防无界增长。 */
const MAX_SESSION_KEYS = 128;

/** 「真出问题」的定性（T1~T4 + 开发者模式逐条 T-verbose + 取证面自身结构异常）。 */
export type StyleRemovalEscalationTrigger =
  | 'head_node_removed'
  | 'style_content_missing'
  | 'style_guard_restored'
  | 'frame_height_collapsed'
  | 'forensics_payload_unkeyed'
  | 'per_event_verbose';

export interface StyleRemovalAggEntry {
  /** 同键累计事件数（含首次）。 */
  count: number;
  /** 被聚合吞掉的重复条数 = count - 1。 */
  suppressed: number;
  firstAt: number;
  lastAt: number;
  /** 本键是否已经升级过一次上报（升级最多一条，重复事件不再刷）。 */
  escalated: boolean;
  /** 升级定性（未升级 = null）。 */
  escalationTrigger: StyleRemovalEscalationTrigger | null;
  /** 探针因帧不可达 / 文档已重建 / 无上下文而**无法判定**的次数（取证留痕，不是失败）。 */
  probesSkipped: number;
}

/** 会话级去重账（模块作用域 = 主文档会话；页面重载即清零，与 recordStubHitOnce 的会话边界同口径）。 */
const sessionAgg = new Map<string, StyleRemovalAggEntry>();

/** 无身份载荷的事件计数（不聚合、不判定，只留个总数）。 */
let unkeyedEventCount = 0;

function syncWindow(): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as unknown as Record<string, unknown>;
    w[STYLE_REMOVAL_AGG_WINDOW_KEY] = sessionAgg;
    w[STYLE_REMOVAL_SUMMARY_WINDOW_KEY] = getStyleRemovalForensicsSummary;
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

/** 载荷里「第一个被移除的样式节点」的可判定身份（探针与真丢失判据都用它）。 */
export interface StyleRemovalNodeId {
  tag: string;
  id: string;
  href: string;
  textLen: number;
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
 * 计算去重键：`kind|identity`。载荷缺身份（无 removedStyled[0]）时返回 null ——
 * 这类消息不进聚合账（无法判定是不是真出问题），只累 unkeyed 总数，
 * 默认静默、开发者模式逐条放行（信息不降级：原始 message 仍在 diag 导出面里）。
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
  /** true = 本条是该键的会话首次（首次是否落 console 仍由 shouldLog 决定）。 */
  first: boolean;
  /** 会话键；载荷不可键化时为 null（此时 first 恒 true，等价旧行为）。 */
  key: string | null;
  /**
   * 本条是否要往 console 打一行。默认（非开发者模式）恒 false —— 纯「节点被移除/搬家」
   * 是正常适配行为，只累计数；只有真出问题（见文件头 T1~T6）或开发者模式逐条放行才 true。
   */
  shouldLog: boolean;
  /** 本条是否要占一格 __palinkFrameErrors（真出问题必占；开发者模式只让首次占，防缓冲刷满）。 */
  shouldRecord: boolean;
  /** 上报定性；null = 静默的普通取证事件。 */
  trigger: StyleRemovalEscalationTrigger | null;
  /** 该键的会话累计数（含本条）；不可键化载荷为 unkeyed 总数。 */
  count: number;
}

/** 逐条放行：既有开发者模式（显式开启的诊断开关）或控制台一次性逃生口。 */
export function styleRemovalVerboseEnabled(): boolean {
  if (typeof window !== 'undefined') {
    try {
      if ((window as unknown as Record<string, unknown>)[STYLE_REMOVAL_VERBOSE_WINDOW_KEY] === true) return true;
    } catch { /* window 不可读时按未放行处理 */ }
  }
  return palinkDiagExplicitlyEnabled();
}

/** 载荷里被移除的样式节点身份数组（帧内取证观察器的 node.removedStyled）。 */
function removedStyledOf(data: unknown): NodeIdentityShape[] {
  const payload = data as Record<string, unknown> | null;
  const node = payload && typeof payload === 'object' ? (payload.node as Record<string, unknown> | undefined) : undefined;
  const removed = node ? node.removedStyled : null;
  return Array.isArray(removed) ? (removed as NodeIdentityShape[]) : [];
}

/** T1：被摘走的节点里含 HEAD 本身 = 文档级拆除（不是"搬家"），任何时候都要报。 */
export function removedIncludesHeadNode(data: unknown): boolean {
  return removedStyledOf(data).some((n) => String((n && n.tagName) || '').toUpperCase() === 'HEAD');
}

/** 首个被移除节点的可判定身份；无身份时 null（此时不做真丢失判定）。 */
export function firstRemovedIdentityOf(data: unknown): StyleRemovalNodeId | null {
  const first = removedStyledOf(data)[0];
  if (!first || typeof first !== 'object') return null;
  const attrs = first.attrs && typeof first.attrs === 'object'
    ? (first.attrs as Record<string, unknown>)
    : {};
  const len = Number(first.textLen);
  return {
    tag: String(first.tagName || '').toUpperCase(),
    id: String(first.id || ''),
    href: String(attrs.href || ''),
    textLen: Number.isFinite(len) ? len : -1,
  };
}

/**
 * 真丢失判定的核心：被移除节点的身份**是否仍不在**该帧文档里。
 * 口径：只在 style / link[rel=stylesheet] 集合里找（帧内取证只登记这三类节点）。
 *   - 有 id ⇒ 按 id 找；有 href ⇒ 按 href 前缀找（帧侧属性截到 80 字符，故用前缀）；
 *   - 匿名（无 id 无 href）⇒ 除长度命中外还要求文档样式节点数**没有减少**才算健在，
 *     因为 REPORT_style_removal机制研究 §6.1 实测 textLen 会漂，单靠长度会假阳性。
 * 返回 true = 判真丢失（要报）；无法判定的形态一律返回 false（宁可静默）。
 */
export function styleRemovalIdentityMissingFromDoc(
  doc: Document | null,
  identity: StyleRemovalNodeId | null,
  styledCountAtArm: number,
): boolean {
  if (!doc || !identity) return false;
  const nodes = collectStyledNodes(doc);
  if (nodes.length === 0) return styledCountAtArm > 0;
  if (identity.id) return !nodes.some((el) => String((el as HTMLElement).id || '') === identity.id);
  if (identity.href) {
    return !nodes.some((el) => {
      const href = el.getAttribute?.('href') || '';
      return href === identity.href || href.indexOf(identity.href) === 0;
    });
  }
  if (!Number.isFinite(identity.textLen) || identity.textLen < 0) return false;
  if (nodes.length < styledCountAtArm) return true;
  return !nodes.some((el) => String(el.textContent || '').length === identity.textLen);
}

function collectStyledNodes(doc: Document | null): Element[] {
  const out: Element[] = [];
  if (!doc) return out;
  try {
    const root = doc.documentElement || doc;
    const list = root.querySelectorAll?.('style, link[rel="stylesheet"]');
    if (list) for (let i = 0; i < list.length; i += 1) out.push(list[i]);
  } catch { /* 帧文档被换掉/不可读时按取不到处理，交由上层记 skipped */ }
  return out;
}

/** documentElement 的布局高度（0 = 整份文档没渲染出任何东西）。取不到给 -1（不参与判定）。 */
function docRenderedScrollHeight(doc: Document | null): number {
  if (!doc) return -1;
  try {
    const el = doc.documentElement;
    const h = el ? Number(el.scrollHeight) : -1;
    return Number.isFinite(h) ? h : -1;
  } catch { return -1; }
}

/**
 * 每个卡帧实例注册一份探针上下文：探针要读的那份文档、守护计数、渲染高度、
 * 以及升级上报的去向（由 CharacterCardRenderer 落 __palinkFrameErrors + console.error）。
 */
export interface StyleRemovalProbeContext {
  /** 当前帧文档（跨源读不到时返回 null；探针记 skipped，不猜）。 */
  resolveDocument(): Document | null;
  /** 宿主样式守护的累计回灌次数（读 window.__palinkStyleGuard.restored；读不到给 -1）。 */
  readGuardRestored?(): number;
  /** 本帧当前渲染高度；折叠态等"不该判定"的场景给 -1 = 不参与判定。 */
  readRenderedHeight?(): number;
  /** 真出问题的上报出口（一条，已带去重）。 */
  reportEscalation(escalation: StyleRemovalEscalation): void;
}

export interface StyleRemovalEscalation {
  key: string;
  trigger: StyleRemovalEscalationTrigger;
  /** 人读的一行结论（含会话计数，便于真机一眼看出量级）。 */
  message: string;
  /** 进 __palinkFrameErrors 的 errorReason（固定 style_removal_loss_suspected）。 */
  errorReason: string;
  frameId: string;
  cardId: string;
  count: number;
  identity: StyleRemovalNodeId | null;
  node?: unknown;
}

interface PendingProbe {
  key: string;
  frameId: string;
  cardId: string;
  identity: StyleRemovalNodeId;
  /** 事件发生时那份文档对象：换了就不是"丢失"而是"重建"，直接记 skipped（防假阳性）。 */
  docAtArm: Document | null;
  styledCountAtArm: number;
  guardRestoredAtArm: number;
  dueAt: number;
  /** 原始帧载荷（升级上报时把 node 取证字段一并带给父侧观测面）。 */
  payload: unknown;
}

const probeContexts = new Map<string, StyleRemovalProbeContext>();
const pendingProbes: PendingProbe[] = [];
/** 每个键只挂一次探针（会话级），重复事件不再排程。 */
const armedKeys = new Set<string>();
let probeTicker: ReturnType<typeof setInterval> | null = null;
/** T3（守护回灌）与 T4（高度塌陷）读的是宿主全局量，分不出哪一帧 ⇒ 整会话各只报一条。 */
let guardRestoreReported = false;
let heightCollapseReported = false;
/** 升级上报的会话总量上限：病态卡真丢 24 个身份时也只报前 N 条，别把噪声放回来。 */
const MAX_STYLE_REMOVAL_ESCALATIONS = 12;
let escalationReports = 0;
let escalationReportsCapped = 0;

export function registerStyleRemovalProbeContext(
  frameId: string,
  ctx: StyleRemovalProbeContext,
): () => void {
  if (!frameId) return () => { /* 无 frameId 的调用方：不给句柄，什么都不注册 */ };
  probeContexts.set(frameId, ctx);
  syncWindow();
  return () => {
    if (probeContexts.get(frameId) === ctx) probeContexts.delete(frameId);
    // 帧卸载 ⇒ 它名下未跑的探针作废（判不了就是判不了，不猜丢）
    for (let i = pendingProbes.length - 1; i >= 0; i -= 1) {
      if (pendingProbes[i].frameId === frameId) {
        const entry = sessionAgg.get(pendingProbes[i].key);
        if (entry) entry.probesSkipped += 1;
        pendingProbes.splice(i, 1);
      }
    }
    syncWindow();
  };
}

function ensureProbeTicker(): void {
  if (probeTicker !== null) return;
  if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') return;
  probeTicker = setInterval(() => { runDueStyleRemovalProbes(); }, STYLE_REMOVAL_PROBE_TICK_MS);
}

function stopProbeTickerIfIdle(): void {
  if (pendingProbes.length === 0 && probeTicker !== null) {
    clearInterval(probeTicker);
    probeTicker = null;
  }
}

/**
 * 跑一遍到期探针（真机由模块内 500ms 巡查驱动；测试直接显式调用并可注入 now）。
 * 返回本轮处理掉的探针数。
 */
export function runDueStyleRemovalProbes(now = Date.now()): number {
  let handled = 0;
  for (let i = pendingProbes.length - 1; i >= 0; i -= 1) {
    const probe = pendingProbes[i];
    if (probe.dueAt > now) continue;
    pendingProbes.splice(i, 1);
    handled += 1;
    evaluateStyleRemovalProbe(probe);
  }
  stopProbeTickerIfIdle();
  return handled;
}

function evaluateStyleRemovalProbe(probe: PendingProbe): void {
  const entry = sessionAgg.get(probe.key);
  if (!entry || entry.escalated) return;
  const ctx = probeContexts.get(probe.frameId);
  if (!ctx) { entry.probesSkipped += 1; syncWindow(); return; }
  let doc: Document | null = null;
  try {
    doc = ctx.resolveDocument();
  } catch { doc = null; entry.probesSkipped += 1; }
  if (!doc) { entry.probesSkipped += 1; syncWindow(); return; }
  if (!probe.docAtArm || doc !== probe.docAtArm) {
    // 挂探针时就读不到文档（跨源帧），或帧文档已被 srcDoc 重建 ⇒ 旧身份无从比对，
    // 记 skipped 不升级（判不了就不报：宁可静默，也不给控制台添假事故）
    entry.probesSkipped += 1;
    syncWindow();
    return;
  }
  const missing = styleRemovalIdentityMissingFromDoc(doc, probe.identity, probe.styledCountAtArm);
  if (missing) {
    escalateStyleRemoval(probe, ctx, 'style_content_missing', doc);
    return;
  }
  const guardNow = readGuardRestored(ctx);
  if (probe.guardRestoredAtArm >= 0 && guardNow > probe.guardRestoredAtArm) {
    // 守护真的动手回灌过 ⇒ 这批样式确实离开过生效文档（稳态实测恒 0，见研究报告 §4.3）。
    // 计数是宿主全局的（分不出是哪一帧），所以整个会话只报一条，防"每键一条"把噪声放回来。
    if (!guardRestoreReported) {
      guardRestoreReported = true;
      escalateStyleRemoval(probe, ctx, 'style_guard_restored', doc);
    }
    return;
  }
  const renderedHeight = readRenderedHeight(ctx);
  const docHeight = docRenderedScrollHeight(doc);
  if (renderedHeight === 0 && docHeight === 0 && !heightCollapseReported) {
    heightCollapseReported = true;
    escalateStyleRemoval(probe, ctx, 'frame_height_collapsed', doc);
  }
}

function readGuardRestored(ctx: StyleRemovalProbeContext): number {
  try {
    return ctx.readGuardRestored ? Number(ctx.readGuardRestored()) : -1;
  } catch { return -1; }
}

function readRenderedHeight(ctx: StyleRemovalProbeContext): number {
  try {
    return ctx.readRenderedHeight ? Number(ctx.readRenderedHeight()) : -1;
  } catch { return -1; }
}

const TRIGGER_LABELS: Record<StyleRemovalEscalationTrigger, string> = {
  head_node_removed: '整份 HEAD 被摘走（文档级拆除）',
  style_content_missing: '样式节点在 settle 窗口后仍不在帧文档（样式真丢失）',
  style_guard_restored: '样式守护真的回灌过（样式确实被抽走过）',
  frame_height_collapsed: '帧渲染高度与文档布局高度同时为 0（可见回归）',
  forensics_payload_unkeyed: '取证载荷没有节点身份，无法判定（取证面结构异常，整会话只报一次）',
  per_event_verbose: '开发者模式逐条放行',
};

function escalateStyleRemoval(
  probe: PendingProbe,
  ctx: StyleRemovalProbeContext,
  trigger: StyleRemovalEscalationTrigger,
  doc: Document | null,
): void {
  const entry = sessionAgg.get(probe.key);
  if (!entry || entry.escalated) return;
  entry.escalated = true;
  entry.escalationTrigger = trigger;
  // 会话级封顶：超过上限后**只记账不再刷 console**（取证不丢，噪声有界）。
  const overCap = escalationReports >= MAX_STYLE_REMOVAL_ESCALATIONS;
  if (overCap) escalationReportsCapped += 1;
  else escalationReports += 1;
  const identity = probe.identity;
  const identityText = identity.id
    ? `${identity.tag}#${identity.id}`
    : identity.href
      ? `${identity.tag}@${identity.href}`
      : `${identity.tag}#-@len${identity.textLen}`;
  const message = `style_removal 升级[${trigger}] ${TRIGGER_LABELS[trigger]} 节点=${identityText} 会话计数=${entry.count} 文档样式数=${collectStyledNodes(doc).length} 守护回灌数=${probe.guardRestoredAtArm}->${readGuardRestored(ctx)}${overCap ? ' （本会话升级上报已达上限，后续只记账不刷控制台）' : ''}`;
  const payload = (probe.payload || {}) as Record<string, unknown>;
  try {
    recordPalinkDiag({
      owner: 'frame_compat',
      kind: 'frame_record',
      name: `style_removal_escalation:${probe.key}`,
      detail: message,
      filename: String(payload.filename || identity.id || identity.href || ''),
      textLength: identity.textLen,
      frameId: probe.frameId,
      cardId: probe.cardId,
      origin: 'host',
    });
  } catch { /* diag 写失败不影响升级上报 */ }
  syncWindow();
  const escalation: StyleRemovalEscalation = {
    key: probe.key,
    trigger,
    message,
    errorReason: STYLE_REMOVAL_ESCALATION_REASON,
    frameId: probe.frameId,
    cardId: probe.cardId,
    count: entry.count,
    identity,
    node: payload.node,
  };
  try {
    if (!overCap) ctx.reportEscalation(escalation);
  } catch { /* 上报出口异常绝不影响渲染 */ }
}

/** 待跑探针的只读视图（真机/测试查验用：挂了哪些键、什么时候到期）。 */
export function getPendingStyleRemovalProbes(): ReadonlyArray<{ key: string; frameId: string; dueAt: number }> {
  return pendingProbes.map((p) => ({ key: p.key, frameId: p.frameId, dueAt: p.dueAt }));
}

function armStyleRemovalProbe(
  key: string,
  data: unknown,
  meta: { frameId?: string; cardId?: string },
  now: number,
): void {
  if (armedKeys.has(key)) return;
  const frameId = String(meta.frameId || '');
  const ctx = frameId ? probeContexts.get(frameId) : undefined;
  if (!ctx) return;
  const identity = firstRemovedIdentityOf(data);
  if (!identity) return;
  let doc: Document | null = null;
  try {
    doc = ctx.resolveDocument();
  } catch { doc = null; }
  armedKeys.add(key);
  pendingProbes.push({
    key,
    frameId,
    cardId: String(meta.cardId || ''),
    identity,
    docAtArm: doc,
    styledCountAtArm: doc ? collectStyledNodes(doc).length : 0,
    guardRestoredAtArm: readGuardRestored(ctx),
    dueAt: now + STYLE_REMOVAL_PROBE_SETTLE_MS,
    payload: data,
  });
  ensureProbeTicker();
}

/**
 * 吸收一条 style_removal 取证帧消息：
 *   1. 会话账计数（首次建键 / 重复累加）—— 静默路径也照记，取证能力不降级；
 *   2. diag 启用时同步写一条 recordPalinkDiag（其自身按 name 聚合 ⇒ count=N 可从
 *      palinkDiagDump() / __palinkDiagDump() 的导出 JSON 读到；detail 首次写入后续不覆盖）；
 *   3. 判定「真出问题」：同步判据（T1 HEAD 被摘）立即定升级；其余挂一枚延后探针
 *      （T2 真丢失 / T3 守护回灌 / T4 高度塌陷），到期后由 runDueStyleRemovalProbes 走
 *      ctx.reportEscalation 出口；
 *   4. 返回 shouldLog / shouldRecord，由 CharacterCardRenderer 决定刷不刷 console、
 *      占不占 __palinkFrameErrors 缓冲。默认（非开发者模式、无升级）两者皆 false。
 */
export function absorbStyleRemovalFrameError(
  data: unknown,
  meta: { frameId?: string; cardId?: string } = {},
  options: { verbose?: boolean; now?: number } = {},
): AbsorbStyleRemovalResult {
  const verbose = typeof options.verbose === 'boolean' ? options.verbose : styleRemovalVerboseEnabled();
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const key = styleRemovalAggKeyOf(data);
  if (!key) {
    unkeyedEventCount += 1;
    syncWindow();
    // 载荷缺身份 = 取证面自己的结构出问题了（不是卡的样式丢了）：整会话只报一次，
    // 之后只累 unkeyed 总数（在 __palinkStyleRemovalSummary() 里读得到），不让它刷屏。
    const firstUnkeyed = unkeyedEventCount === 1;
    return {
      first: true,
      key: null,
      shouldLog: verbose || firstUnkeyed,
      shouldRecord: verbose || firstUnkeyed,
      trigger: firstUnkeyed ? 'forensics_payload_unkeyed' : (verbose ? 'per_event_verbose' : null),
      count: unkeyedEventCount,
    };
  }

  let entry = sessionAgg.get(key);
  if (!entry) {
    if (sessionAgg.size >= MAX_SESSION_KEYS) {
      // Map 迭代序 = 插入序，首个键即最旧；淘汰后同键再来会重新「首次」，代价是多一条全量记录。
      const oldest = sessionAgg.keys().next().value;
      if (oldest !== undefined) sessionAgg.delete(oldest);
    }
    entry = { count: 0, suppressed: 0, firstAt: now, lastAt: now, escalated: false, escalationTrigger: null, probesSkipped: 0 };
    sessionAgg.set(key, entry);
  }
  entry.count += 1;
  entry.lastAt = now;
  entry.suppressed = entry.count - 1;
  syncWindow();

  const payload = data as Record<string, unknown>;
  const identity = firstRemovedIdentityOf(data);
  try {
    recordPalinkDiag({
      owner: 'frame_compat',
      kind: 'frame_record',
      name: `style_removal:${key}`,
      detail: String(payload.message || ''),
      filename: typeof payload.filename === 'string' ? payload.filename : '',
      textLength: identity ? identity.textLen : -1,
      frameId: String(meta.frameId || ''),
      cardId: String(meta.cardId || ''),
      origin: 'frame',
    });
  } catch { /* diag 写失败不影响聚合与首条判定 */ }

  const first = entry.count === 1;

  // T1：HEAD 整份被摘 = 文档级拆除，同步升级（一条，且必进 __palinkFrameErrors）
  if (!entry.escalated && removedIncludesHeadNode(data)) {
    entry.escalated = true;
    entry.escalationTrigger = 'head_node_removed';
    escalationReports += 1;
    armedKeys.add(key); // 已经定性，不必再挂探针
    syncWindow();
    return {
      first,
      key,
      shouldLog: true,
      shouldRecord: true,
      trigger: 'head_node_removed',
      count: entry.count,
    };
  }

  // 普通「节点被移除/被替换」：默认静默，只挂一枚延后探针等"到底丢没丢"的结论
  armStyleRemovalProbe(key, data, meta, now);

  if (verbose) {
    return {
      first,
      key,
      shouldLog: true,
      shouldRecord: first,
      trigger: 'per_event_verbose',
      count: entry.count,
    };
  }

  return { first, key, shouldLog: false, shouldRecord: false, trigger: null, count: entry.count };
}

/**
 * 会话级取证汇总（静默路径唯一的人类可读出口；管理页与控制台都读它）。
 * 纯函数式取样，不写 console、不弹 UI。
 */
export interface StyleRemovalForensicsSummary {
  /** 见过的不同「原因+节点身份」数。 */
  keys: number;
  /** 取证事件总数（含被聚合吞掉的）。 */
  events: number;
  /** 被静默吞掉的重复条数（= 降噪的量）。 */
  suppressed: number;
  /** 已升级上报（真出问题）的键数。 */
  escalated: number;
  /** 实际刷出去的控制台行数（受会话封顶约束）。 */
  escalationReports: number;
  /** 因会话封顶而只记账、没刷控制台的升级数。 */
  escalationReportsCapped: number;
  /** 无身份、未进聚合账的事件数。 */
  unkeyed: number;
  /** 探针无法判定（帧不可达 / 文档已重建）的累计次数。 */
  probesSkipped: number;
  /** 待跑探针数。 */
  probesPending: number;
  entries: Array<{
    key: string;
    count: number;
    suppressed: number;
    escalated: boolean;
    escalationTrigger: StyleRemovalEscalationTrigger | null;
    probesSkipped: number;
    firstAt: number;
    lastAt: number;
  }>;
}

export function getStyleRemovalForensicsSummary(): StyleRemovalForensicsSummary {
  let events = 0;
  let suppressed = 0;
  let escalated = 0;
  let probesSkipped = 0;
  const entries: StyleRemovalForensicsSummary['entries'] = [];
  sessionAgg.forEach((entry, key) => {
    events += entry.count;
    suppressed += entry.suppressed;
    if (entry.escalated) escalated += 1;
    probesSkipped += entry.probesSkipped;
    entries.push({
      key,
      count: entry.count,
      suppressed: entry.suppressed,
      escalated: entry.escalated,
      escalationTrigger: entry.escalationTrigger,
      probesSkipped: entry.probesSkipped,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
    });
  });
  entries.sort((a, b) => b.count - a.count);
  return {
    keys: sessionAgg.size,
    events,
    suppressed,
    escalated,
    escalationReports,
    escalationReportsCapped,
    unkeyed: unkeyedEventCount,
    probesSkipped,
    probesPending: pendingProbes.length,
    entries,
  };
}

/** 读取会话账快照（测试与真机查验用）。 */
export function getStyleRemovalAggSnapshot(): ReadonlyMap<string, StyleRemovalAggEntry> {
  return sessionAgg;
}

/** 清空会话账（仅测试用；真机以页面会话为界，不主动清）。 */
export function resetStyleRemovalAggForTest(): void {
  sessionAgg.clear();
  armedKeys.clear();
  pendingProbes.length = 0;
  probeContexts.clear();
  unkeyedEventCount = 0;
  guardRestoreReported = false;
  heightCollapseReported = false;
  escalationReports = 0;
  escalationReportsCapped = 0;
  if (probeTicker !== null) {
    clearInterval(probeTicker);
    probeTicker = null;
  }
  if (typeof window !== 'undefined') {
    try {
      const w = window as unknown as Record<string, unknown>;
      delete w[STYLE_REMOVAL_AGG_WINDOW_KEY];
      delete w[STYLE_REMOVAL_SUMMARY_WINDOW_KEY];
    } catch { /* ignore */ }
  }
}
