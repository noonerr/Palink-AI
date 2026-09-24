/**
 * [P1.4] 消息媒体（`extra.media`）的前端契约与状态收敛。
 *
 * 与后端 `backend/app/services/message_media_service.py` 一一对应：字段名、
 * 状态枚举、超时阈值都取同值——两端判定口径必须一致，否则会出现
 * 「后端认为还在等、前端已经判失败」这类互相打架的现象。
 *
 * **状态收敛只有一条规则：服务端快照是唯一权威。**
 * 前端本地只做两件事：① 点击时乐观插一条 `pending`（立刻有占位，不等网络）；
 * ② 拿到服务端给的整组快照就整组换掉。不做 id 级字段拼接，也就不存在
 * 「本地与服务端各持一半真相」的分叉；重复收到同一个事件也是幂等的。
 */

/** 与后端 MEDIA_STATUS_* 同值。 */
export type MediaStatus = 'pending' | 'ready' | 'failed';

/** 与后端 `build_media_item` 的字段一一对应（§6 契约）。 */
export interface MediaItem {
  id: string;
  status: MediaStatus;
  url: string | null;
  width: number;
  height: number;
  prompt?: string;
  seed?: number;
  provider_id?: string | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MediaSnapshot {
  media: MediaItem[];
  media_index: number;
  media_display: 'inline' | 'gallery';
}

/** 与后端 `PENDING_TIMEOUT_SECONDS` 同值（D3：悬挂的 pending 只在渲染期判定）。 */
export const MEDIA_PENDING_TIMEOUT_MS = 120_000;

/** 与后端 `DEFAULT_MEDIA_WIDTH/HEIGHT` 同值（服务端未回尺寸时兜底比例）。 */
export const DEFAULT_MEDIA_WIDTH = 1024;
export const DEFAULT_MEDIA_HEIGHT = 1024;

export const EMPTY_MEDIA_SNAPSHOT: MediaSnapshot = {
  media: [],
  media_index: 0,
  media_display: 'inline',
};

interface MessageLike {
  id?: string | number;
  content?: string;
  extra?: Record<string, unknown>;
}

/** 事件载荷（SSE / WS / POST 响应共用形状）。 */
export interface MediaEventPayload {
  type?: string;
  message_id?: string | number;
  /** 服务端媒体快照：`media` / `media_index` / `media_display` 三键。 */
  media?: MediaItem[];
  media_index?: number;
  media_display?: string;
  media_id?: string;
  content?: string;
  error?: string;
}

/**
 * 生成媒体 id（形态与后端 `new_media_id` 一致：`m_` + 12 位十六进制）。
 * 前端先插占位时用它，服务端会**采纳**同一个 id —— 见后端 `normalize_media_id`。
 */
export function newMediaId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `m_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function buildPendingMediaItem(options: {
  id?: string;
  prompt?: string;
  width?: number;
  height?: number;
} = {}): MediaItem {
  return {
    id: options.id || newMediaId(),
    status: 'pending',
    url: null,
    width: options.width && options.width > 0 ? options.width : DEFAULT_MEDIA_WIDTH,
    height: options.height && options.height > 0 ? options.height : DEFAULT_MEDIA_HEIGHT,
    prompt: options.prompt || '',
    seed: -1,
    provider_id: null,
    error: null,
    created_at: new Date().toISOString(),
  };
}

function coerceItem(raw: unknown): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  if (!id) return null;
  const status = item.status;
  if (status !== 'pending' && status !== 'ready' && status !== 'failed') return null;
  const width = Number(item.width);
  const height = Number(item.height);
  return {
    id,
    status,
    url: typeof item.url === 'string' ? item.url : null,
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_MEDIA_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_MEDIA_HEIGHT,
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    seed: typeof item.seed === 'number' ? item.seed : -1,
    provider_id: typeof item.provider_id === 'string' ? item.provider_id : null,
    error: typeof item.error === 'string' ? item.error : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
    updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  };
}

/** 从消息的 `extra` 读出媒体快照（坏数据一律降级为空，不抛）。 */
export function getMediaSnapshot(extra: Record<string, unknown> | undefined | null): MediaSnapshot {
  if (!extra || typeof extra !== 'object') return EMPTY_MEDIA_SNAPSHOT;
  const rawList = (extra as Record<string, unknown>).media;
  const media = Array.isArray(rawList)
    ? (rawList.map(coerceItem).filter(Boolean) as MediaItem[])
    : [];
  const rawIndex = (extra as Record<string, unknown>).media_index;
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex)
    && rawIndex >= 0 && rawIndex < media.length
    ? rawIndex
    : 0;
  const rawDisplay = (extra as Record<string, unknown>).media_display;
  const display: MediaSnapshot['media_display'] = rawDisplay === 'gallery' ? 'gallery' : 'inline';
  return { media, media_index: index, media_display: display };
}

/**
 * 渲染期的超时收敛（对齐后端 `effective_media_status`）。
 *
 * 页面刷新 / 断线会让 `pending` 永久悬挂；超过阈值的 pending 在**渲染期**
 * 显示为 failed，不改库（D3 明确要求，避免前后台判定互相打架）。
 */
export function effectiveMediaStatus(item: MediaItem, now: number = Date.now()): MediaStatus {
  if (item.status !== 'pending' || !item.created_at) return item.status;
  const created = Date.parse(item.created_at);
  if (!Number.isFinite(created)) return item.status;
  return now - created > MEDIA_PENDING_TIMEOUT_MS ? 'failed' : 'pending';
}

/** 该条 media 是否已等待超时（用于给失败态换一句更准确的原因）。 */
export function isPendingTimedOut(item: MediaItem, now: number = Date.now()): boolean {
  return item.status === 'pending' && effectiveMediaStatus(item, now) === 'failed';
}

function withExtra<T extends MessageLike>(message: T, extra: Record<string, unknown>): T {
  return { ...message, extra: { ...(message.extra || {}), ...extra } } as T;
}

/** 把服务端快照整组写进消息（唯一权威，幂等）。 */
export function withMediaSnapshot<T extends MessageLike>(
  message: T,
  snapshot: {
    media?: MediaItem[];
    media_index?: number;
    /** 服务端可能给任意字符串，这里只认已知值，其余落到 inline。 */
    media_display?: string;
  },
): T {
  if (!Array.isArray(snapshot.media)) return message;
  return withExtra(message, {
    media: snapshot.media,
    media_index: typeof snapshot.media_index === 'number' ? snapshot.media_index : 0,
    media_display: snapshot.media_display === 'gallery' ? 'gallery' : 'inline',
  });
}

/** 乐观插入一条 pending 占位（同 id 已存在则原位复位，重复点击不会插两条）。 */
export function withPendingMedia<T extends MessageLike>(
  message: T,
  item: MediaItem,
): T {
  const snapshot = getMediaSnapshot(message.extra);
  const exists = snapshot.media.some((entry) => entry.id === item.id);
  const media = exists
    ? snapshot.media.map((entry) => (entry.id === item.id ? { ...item } : entry))
    : [...snapshot.media, item];
  return withExtra(message, { media, media_index: snapshot.media_index });
}

/**
 * 把失败原因写进本地占位。
 *
 * POST 失败时客户端只拿到 HTTP 错误文本、拿不到服务端快照，所以本地自己收敛
 * ——服务端那边同一 id 的项也已落成 failed，刷新后仍是「一条 failed」，
 * 不会出现重复项。
 */
export function withFailedMedia<T extends MessageLike>(
  message: T,
  errorText: string,
  mediaId?: string,
): T {
  const snapshot = getMediaSnapshot(message.extra);
  if (snapshot.media.length === 0) return message;
  const media = snapshot.media.map((entry) => {
    // 已就绪的图不动（重试别的图时不能把成功的也标失败）
    if (entry.status === 'ready') return entry;
    const targeted = mediaId ? entry.id === mediaId : entry.status === 'pending';
    if (!targeted) return entry;
    return { ...entry, status: 'failed' as MediaStatus, error: errorText };
  });
  return withExtra(message, { media });
}

/**
 * 把出图失败翻成人话。
 *
 * 两种必须翻译的底层错误：
 * - 客户端超时 abort → 浏览器只给 `signal is aborted without reason`（用户看不懂，
 *   而且**服务端可能已经把图生成好了**，所以提示里要给出「刷新看看」的路）；
 * - 网络层失败 → `Failed to fetch` / `Load failed`。
 * 其余保持后端原文（后端文案已是人话且带 request_id）。
 */
export function friendlyImageGenerationError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!raw) return '图片生成失败';
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /aborted|abort/i.test(raw)) {
    return '等待超时：生成可能仍在服务端继续，稍后刷新即可看到结果';
  }
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(raw)) {
    return '网络异常，请检查网络后重试';
  }
  // 后端对全部 5xx 统一脱敏成 "Internal server error"（main.py 的 HTTPException
  // 处理器，避免泄露内部细节），所以这类通用文案要在这里补上可操作的指引。
  if (/internal server error|bad gateway|service unavailable|gateway time-?out/i.test(raw)) {
    return '出图服务返回错误，请稍后重试（也可刷新看看是否已生成）';
  }
  return raw;
}

/**
 * 把一条媒体事件（成功 / 失败）应用到消息数组。
 *
 * 优先级：**服务端快照 > 失败收敛 > `content` 降级**。
 * `content` 分支只为「旧后端 / 一个版本周期内的兼容」保留——新流程里出图
 * 不再改写正文（D1），正文长度在出图前后必须完全相同。
 */
export function applyMediaEvent<T extends MessageLike>(
  messages: T[],
  payload: MediaEventPayload,
): T[] {
  const targetId = payload.message_id;
  if (targetId === undefined || targetId === null) return messages;
  const key = String(targetId);

  return messages.map((message) => {
    if (String(message.id) !== key) return message;
    if (Array.isArray(payload.media)) {
      return withMediaSnapshot(message, {
        media: payload.media,
        media_index: payload.media_index,
        media_display: payload.media_display,
      });
    }
    if (payload.type === 'message_image_generation_failed') {
      return withFailedMedia(message, payload.error || '图片生成失败', payload.media_id);
    }
    if (typeof payload.content === 'string') {
      // 降级路径：旧后端仍按 content 替换正文
      return { ...message, content: payload.content };
    }
    return message;
  });
}