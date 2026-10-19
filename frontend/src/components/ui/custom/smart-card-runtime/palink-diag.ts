/**
 * 包W · 静默失败统一记录器（父侧 / 宿主侧）
 *
 * 状态：施工中（包W）。
 *
 * 这一层解决的是「静默失败」——代码走了一条什么都没发生的路径，
 * 用户端零提示、开发者端零痕迹，于是永远定不了责。产品形状（用户已拍板）：
 *   1. 本机站点默认开启，另留手动开关（将来面向外部用户时可默认关）。
 *   2. 对用户仍然安静：本模块**不弹框、不出 toast**，只写缓冲 + 控制台一行汇总。
 *   3. 每条记录必须带「该谁修」标签（owner，取值固定四类），便于直接派单。
 *   4. 去重但不丢弃：同名首次带细节，后续只累加 count 与 lastAt。
 *
 * ⛔ 红线：
 *  - 零网络：本模块不 fetch / 不上传，导出只在浏览器本地下载 JSON。
 *  - 不改用户可见行为：帧内记录经既有 `st:diagnostic` 通道（severity=info，
 *    宿主 toast 闸门对 info 不弹）上送，不新建 postMessage 桥。
 *  - 有界：每类 owner ≤ DIAG_LIMITS.perOwner，总 ≤ DIAG_LIMITS.total。溢出丢最旧并计数。
 */

export const PALINK_DIAG_OWNERS = [
  'frame_compat',
  'host_capability',
  'card_authored',
  'display_pipeline',
] as const;

export type PalinkDiagOwner = (typeof PALINK_DIAG_OWNERS)[number];

/**
 * 记录 kind 的封闭名单（报告里逐条对应用户可见的静默点）。
 * 新增 kind 请同时更新 docs 报告与本名单，测试按本名单校验 owner 归属。
 */
export const PALINK_DIAG_KINDS = [
  'slash_command_unimplemented',
  'compat_catch_swallowed',
  'global_shape_absent',
  'tavernhelper_key_unimplemented',
  'unhandled_rejection',
  'card_script_injection_failed',
  'variable_block_residual',
  'frame_record',
  'context_stub_hit',
  'missing_api',
  'host_script_error',
  'script_error',
] as const;

export type PalinkDiagKind = (typeof PALINK_DIAG_KINDS)[number] | string;

/**
 * 稳定字段 schema（主控可直接按字段名派单，勿改名）：
 *   key        去重键 `owner|kind|name`，同名记录共用一条
 *   owner      该谁修：frame_compat / host_capability / card_authored / display_pipeline
 *   kind       静默点类型（见 PALINK_DIAG_KINDS）
 *   name       被触碰的东西的名字（命令名 / TavernHelper 键 / 全局名 / 脚本名 / catch 站点）
 *   detail     人类可读细节（首次写入，后续不覆盖）
 *   stack      首次调用栈（可能为空串）
 *   filename / lineno / colno   rejection 与脚本失败定位用，缺省给空串 / -1
 *   frameId    帧号（父侧可知；帧内记录上送时由宿主补齐）
 *   cardId     卡 id（同上）
 *   textLength 相关正文长度（未知给 -1）
 *   origin     'host' = 宿主代码写入；'frame' = 帧内记录器经 st:diagnostic 上送
 *   count      同名累计次数（含首次）
 *   firstAt / lastAt  首次与最后一次的 epoch 毫秒
 */
export interface PalinkDiagRecord {
  key: string;
  owner: PalinkDiagOwner;
  kind: PalinkDiagKind;
  name: string;
  detail: string;
  stack: string;
  filename: string;
  lineno: number;
  colno: number;
  frameId: string;
  cardId: string;
  textLength: number;
  origin: 'host' | 'frame';
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface PalinkDiagInput {
  owner: PalinkDiagOwner;
  kind: PalinkDiagKind;
  name: string;
  detail?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  frameId?: string;
  cardId?: string;
  textLength?: number;
  origin?: 'host' | 'frame';
  /** 帧内记录已经累计过的次数（上送时带上，父侧累加而不是只加 1）。 */
  count?: number;
}

export const DIAG_LIMITS = { perOwner: 200, total: 2000 } as const;

/** 手动开关落盘用的 localStorage 键（'1' 开 / '0' 关；缺失 = 按站点判定）。 */
export const PALINK_DIAG_STORAGE_KEY = 'palink.diag.enabled';

export type PalinkDiagState = {
  records: PalinkDiagRecord[];
  dropped: number;
  enabledOverride: boolean | null;
};

const state: PalinkDiagState = { records: [], dropped: 0, enabledOverride: null };

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    // 隐私模式 / 禁用存储时 localStorage 直接抛 —— 静默按"未设置"处理。
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就算了，内存里的开关仍然生效 */
  }
}

/** 本机站点判定：只看 hostname，不发任何请求。 */
export function isLocalPalinkSite(): boolean {
  if (typeof window === 'undefined') return false;
  const host = String(window.location?.hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.1' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^192\.168\./.test(host) || /^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  return false;
}

/**
 * 是否记录中。优先级：
 *   内存覆盖（本会话 __palinkDiagSetEnabled）> localStorage 手动开关 > 本机站点默认开。
 * 外部站点默认关，将来面向用户时可保持这条，也可由开发者模式显式打开。
 */
export function palinkDiagEnabled(): boolean {
  if (state.enabledOverride !== null) return state.enabledOverride;
  const stored = storageGet(PALINK_DIAG_STORAGE_KEY);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return isLocalPalinkSite();
}

export function setPalinkDiagEnabled(value: boolean | null, persist = true): boolean {
  state.enabledOverride = value === null ? null : Boolean(value);
  if (persist) {
    if (value === null) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(PALINK_DIAG_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    } else {
      storageSet(PALINK_DIAG_STORAGE_KEY, value ? '1' : '0');
    }
  }
  return palinkDiagEnabled();
}

export function diagKeyOf(input: { owner: string; kind: string; name: string }): string {
  return `${input.owner}|${input.kind}|${input.name}`;
}

function findRecord(key: string): PalinkDiagRecord | undefined {
  for (let i = state.records.length - 1; i >= 0; i -= 1) {
    if (state.records[i].key === key) return state.records[i];
  }
  return undefined;
}

function countByOwner(owner: PalinkDiagOwner): number {
  let n = 0;
  for (const rec of state.records) if (rec.owner === owner) n += 1;
  return n;
}

/** 溢出时丢该 owner 里最旧的一条（数组头部），并计入 dropped。 */
function evictOldestOfOwner(owner: PalinkDiagOwner): void {
  for (let i = 0; i < state.records.length; i += 1) {
    if (state.records[i].owner === owner) {
      state.records.splice(i, 1);
      state.dropped += 1;
      return;
    }
  }
}

/**
 * 记一条。同名（owner+kind+name）合并：首次带细节，后续只累加 count 与 lastAt。
 * 关闭状态下直接返回 null —— 连去重查询都不做，保证零开销。
 */
export function recordPalinkDiag(input: PalinkDiagInput): PalinkDiagRecord | null {
  if (!palinkDiagEnabled()) return null;
  if (!input || !input.owner || !input.kind) return null;
  const name = String(input.name ?? '');
  const key = diagKeyOf({ owner: input.owner, kind: String(input.kind), name });
  const now = Date.now();
  const step = Number.isFinite(input.count) && Number(input.count) > 1 ? Math.floor(Number(input.count)) : 1;

  const existing = findRecord(key);
  if (existing) {
    existing.count += step;
    existing.lastAt = now;
    if (!existing.stack && typeof input.stack === 'string' && input.stack) existing.stack = input.stack;
    if (existing.filename === '' && typeof input.filename === 'string' && input.filename) existing.filename = input.filename;
    if (existing.lineno < 0 && Number.isFinite(input.lineno)) existing.lineno = Number(input.lineno);
    if (existing.colno < 0 && Number.isFinite(input.colno)) existing.colno = Number(input.colno);
    if (existing.cardId === '' && typeof input.cardId === 'string' && input.cardId) existing.cardId = input.cardId;
    if (existing.frameId === '' && typeof input.frameId === 'string' && input.frameId) existing.frameId = input.frameId;
    if (existing.textLength < 0 && Number.isFinite(input.textLength)) existing.textLength = Number(input.textLength);
    scheduleSummary();
    return existing;
  }

  if (state.records.length >= DIAG_LIMITS.total) {
    // 总数上限：先丢最早到的那一条（无论归属），保证有界。
    state.records.shift();
    state.dropped += 1;
  }
  while (countByOwner(input.owner) >= DIAG_LIMITS.perOwner) {
    evictOldestOfOwner(input.owner);
    if (state.records.length === 0) break;
  }

  const record: PalinkDiagRecord = {
    key,
    owner: input.owner,
    kind: String(input.kind),
    name,
    detail: String(input.detail ?? ''),
    stack: String(input.stack ?? ''),
    filename: String(input.filename ?? ''),
    lineno: Number.isFinite(input.lineno) ? Number(input.lineno) : -1,
    colno: Number.isFinite(input.colno) ? Number(input.colno) : -1,
    frameId: String(input.frameId ?? ''),
    cardId: String(input.cardId ?? ''),
    textLength: Number.isFinite(input.textLength) ? Number(input.textLength) : -1,
    origin: input.origin === 'frame' ? 'frame' : 'host',
    count: step,
    firstAt: now,
    lastAt: now,
  };
  state.records.push(record);
  scheduleSummary();
  return record;
}

/**
 * 帧内上送的 st:diagnostic → 转成一条记录（origin=frame）。
 * 帧内记录器把 owner/kind/name 塞在 diagnostic 的 detail JSON 里，
 * 因为 `st:diagnostic` 的形状是既有的、不能改（改了会打中宿主 toast 闸门与包I 分类）。
 */
export function absorbFrameDiagnostic(diagnostic: unknown, meta?: { frameId?: string; cardId?: string }): PalinkDiagRecord | null {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const d = diagnostic as Record<string, unknown>;
  const rawDetail = typeof d.detail === 'string' ? d.detail : '';
  let payload: Record<string, unknown> | null = null;
  if (rawDetail.startsWith('palinkDiag:')) {
    try {
      const parsed = JSON.parse(rawDetail.slice('palinkDiag:'.length));
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (!payload) return null;
  const owner = PALINK_DIAG_OWNERS.includes(payload.owner as PalinkDiagOwner)
    ? (payload.owner as PalinkDiagOwner)
    : 'frame_compat';
  return recordPalinkDiag({
    owner,
    kind: String(payload.kind || 'frame_record'),
    name: String(payload.name ?? ''),
    detail: String(payload.detail ?? ''),
    stack: String(payload.stack ?? String(d.stack ?? '')),
    filename: String(payload.filename ?? ''),
    lineno: Number.isFinite(payload.lineno) ? Number(payload.lineno) : -1,
    colno: Number.isFinite(payload.colno) ? Number(payload.colno) : -1,
    textLength: Number.isFinite(payload.textLength) ? Number(payload.textLength) : -1,
    count: Number.isFinite(payload.count) ? Number(payload.count) : 1,
    frameId: String(meta?.frameId ?? payload.frameId ?? ''),
    cardId: String(meta?.cardId ?? payload.cardId ?? ''),
    origin: 'frame',
  });
}

export function palinkDiagRecords(): PalinkDiagRecord[] {
  return state.records.slice();
}

export function palinkDiagTotals(): Record<string, number> {
  const totals: Record<string, number> = { records: state.records.length, events: 0, dropped: state.dropped };
  for (const rec of state.records) {
    totals.events += rec.count;
    totals[`owner:${rec.owner}`] = (totals[`owner:${rec.owner}`] || 0) + 1;
    totals[`kind:${rec.kind}`] = (totals[`kind:${rec.kind}`] || 0) + 1;
  }
  return totals;
}

/** 导出用的 JSON 字符串（不含正文，只含长度与身份字段——细节字段本身已由写入方截断）。 */
export function palinkDiagDump(): string {
  return JSON.stringify(
    {
      schema: 'palink-diag/v1',
      enabled: palinkDiagEnabled(),
      generatedAt: new Date().toISOString(),
      limits: DIAG_LIMITS,
      totals: palinkDiagTotals(),
      records: state.records,
    },
    null,
    2,
  );
}

/** 一行汇总（各类计数 + 前几名）。禁止逐条刷屏。 */
export function palinkDiagSummaryLine(): string {
  const top = state.records
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((r) => `${r.kind}:${r.name || '-'}×${r.count}`)
    .join(' ');
  const owners = PALINK_DIAG_OWNERS.map((o) => `${o}=${countByOwner(o)}`).join(' ');
  return `[palink-diag] records=${state.records.length} events=${palinkDiagTotals().events} dropped=${state.dropped} ${owners}${top ? ' | top: ' + top : ''}`;
}

let summaryTimer: ReturnType<typeof setTimeout> | null = null;
let summaryPrintedOnce = false;

/**
 * 控制台汇总：**一行**，节流 5s，且只在开发者模式（开关开）时打。
 * 只复用同一个 timer id，不每次新建定时器链。
 */
export function scheduleSummary(delayMs = 5000): void {
  if (typeof console === 'undefined') return;
  if (!palinkDiagEnabled()) return;
  if (!summaryPrintedOnce) {
    summaryPrintedOnce = true;
    try {
      console.info(palinkDiagSummaryLine());
    } catch {
      /* console 被剥掉就算了 */
    }
    return;
  }
  if (summaryTimer !== null) return;
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    try {
      console.info(palinkDiagSummaryLine());
    } catch {
      /* ignore */
    }
  }, delayMs);
}

export function flushPalinkDiagSummary(): void {
  if (summaryTimer !== null) {
    clearTimeout(summaryTimer);
    summaryTimer = null;
  }
  summaryPrintedOnce = false;
}

/** 本地下载 JSON。零上传。 */
export function exportPalinkDiag(filename = 'palink-diag.json'): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const blob = new Blob([palinkDiagDump()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

export function resetPalinkDiagForTest(): void {
  state.records.length = 0;
  state.dropped = 0;
  state.enabledOverride = null;
  flushPalinkDiagSummary();
}

/**
 * 宿主主文档侧的 rejection / script error 取证（包W · K-3 同一条病灶的另一半）。
 *
 * 只装**一对**监听器（不是每卡一个，且幂等），且不拦事件、不 preventDefault、
 * 不调 toast ⇒ 用户可见行为与改前完全一致；只是原来"除了 toast 什么都不留"的
 * 这条轨，现在同时进记录器（带 filename / lineno / colno / stack / reason）。
 *
 * 归属口径：网络型失败（Failed to fetch / NetworkError / Load failed）⇒ host_capability
 * （能不能连通由宿主网络面决定），其余 ⇒ frame_compat（兼容层/主文档自己的问题）。
 * 语法类错误另记 kind=card_script_injection_failed? 不 —— 主文档的脚本错误一律记
 * host_script_error，卡脚本的语法错由 card-script-runner 带身份记录，避免同一失败两条同名。
 */
const PALINK_NETWORK_REJECTION_MARKERS = ['failed to fetch', 'networkerror', 'load failed', 'network request failed', 'network error'];

export function installPalinkDiagHostRejectionTrack(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__palinkDiagHostTrackInstalled === true) return;
  w.__palinkDiagHostTrackInstalled = true;
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event?.reason as Record<string, unknown> | string | undefined;
      let message = '';
      let stack = '';
      if (reason && typeof reason === 'object') {
        message = typeof reason.message === 'string' ? reason.message : String(reason.name || reason.type || 'rejection');
        stack = typeof reason.stack === 'string' ? reason.stack : '';
      } else if (reason !== undefined) {
        message = String(reason);
      } else {
        message = 'rejection-with-empty-reason';
      }
      const low = message.toLowerCase();
      recordPalinkDiag({
        owner: PALINK_NETWORK_REJECTION_MARKERS.some((needle) => low.includes(needle)) ? 'host_capability' : 'frame_compat',
        kind: 'unhandled_rejection',
        name: message.slice(0, 120),
        detail: `主文档 rejection 轨取证（origin=host；reason 形态 ${reason && typeof reason === 'object' ? 'object' : typeof reason}）`,
        stack,
        origin: 'host',
      });
    } catch {
      /* 取证失败不得影响页面 */
    }
  });
  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      const message = typeof event?.message === 'string' ? event.message : '';
      if (!message) return;
      recordPalinkDiag({
        owner: 'frame_compat',
        kind: 'host_script_error',
        name: message.slice(0, 120),
        detail: '主文档未捕获脚本错误（toast 判定未受影响，本条只进记录器）',
        stack: typeof event.error?.stack === 'string' ? event.error.stack : '',
        filename: typeof event.filename === 'string' ? event.filename : '',
        lineno: typeof event.lineno === 'number' ? event.lineno : -1,
        colno: typeof event.colno === 'number' ? event.colno : -1,
        origin: 'host',
      });
    } catch {
      /* 同上 */
    }
  });
}

/**
 * 挂全局可读入口（父侧）。重复调用幂等。
 *   window.__palinkDiagDump()      → JSON 字符串（含各帧已上送的部分）
 *   window.__palinkDiagRecords()   → 数组
 *   window.__palinkDiagSummary()   → 一行汇总字符串
 *   window.__palinkDiagExport()    → 下载 JSON
 *   window.__palinkDiagSetEnabled(bool|null) → 手动开关
 *   window.__palinkDiagRecord(...) → 宿主代码写一条
 */
export function installPalinkDiagGlobals(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__palinkDiagDump = palinkDiagDump;
  w.__palinkDiagRecords = palinkDiagRecords;
  w.__palinkDiagSummary = palinkDiagSummaryLine;
  w.__palinkDiagExport = exportPalinkDiag;
  w.__palinkDiagSetEnabled = (value: boolean | null) => setPalinkDiagEnabled(value);
  w.__palinkDiagRecord = recordPalinkDiag;
  w.__palinkDiagEnabled = palinkDiagEnabled;
  if (palinkDiagEnabled()) scheduleSummary();
}
