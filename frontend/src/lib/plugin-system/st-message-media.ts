/**
 * [包N B-1 2026-10-19] 插件沙箱轨的 `appendMediaToMessage` 落库计划。
 *
 * 为什么不是「往 DOM 里插节点」：ST 的 appendMediaToMessage 语义是把消息内媒体渲染进
 * **消息 DOM 元素**；Palink 的消息渲染是 React 管线，插件拿不到真实消息元素
 * （sandbox.ts 原空实现的注释就是这么写的）。正确解法是换一条**等价落库通道**：
 * 写 `message.extra.media`（Palink 消息图的唯一权威形状，见 lib/messageMedia.ts:18），
 * 再由宿主持久化到后端。
 *
 * 本模块只做**纯映射**（可单测、不碰 window/网络）：
 *   ST 入参 → { index, media } 或 { error }
 * 落库由调用方注入（sandbox.ts 里是 CharacterChat 注册的 window 桥）。
 *
 * 红线：**不许假成功**。映射不出来一律 ok:false —— 尤其不能「把消息 id 当 URL 写进
 * extra.media」，那是假成功（数据脏了、界面还看不到图）。
 */
import {
  DEFAULT_MEDIA_HEIGHT,
  DEFAULT_MEDIA_WIDTH,
  newMediaId,
  type MediaItem,
  type MediaStatus,
} from '@/lib/messageMedia';

export interface StMediaAppendPlan {
  /** ST chat 数组下标（与 __palinkChatMessages 同序） */
  index: number;
  /** 新增的媒体项（形状见 lib/messageMedia.ts:18 的 MediaItem） */
  media: MediaItem;
}

export type StMediaAppendPlanResult =
  | { ok: true; plan: StMediaAppendPlan }
  | { ok: false; error: string };

function toPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toMediaStatus(value: unknown): MediaStatus {
  return value === 'pending' || value === 'failed' ? value : 'ready';
}

/**
 * 把 ST 侧传进来的媒体来源归一化成 MediaItem。
 *
 * 接受的形态（按插件实际写法排序）：
 *   - 字符串 URL（最常见：插件自己出完图直接传地址）
 *   - `{ url | path | src }` 对象（含部分 MediaItem 字段时原样保留）
 *   - 完整 MediaItem（id + status）—— 允许 url 为空（pending/failed 占位）
 *
 * 明确**不接受**：jQuery/DOM 元素、消息对象、只有 id 没有 status 的对象。
 * 这些都无法证明「这是一张图」，硬写就是假成功。
 */
export function normalizeStMediaEntry(value: unknown): MediaItem | null {
  if (typeof value === 'string') {
    const url = value.trim();
    if (!url) return null;
    return {
      id: newMediaId(),
      status: 'ready',
      url,
      width: DEFAULT_MEDIA_WIDTH,
      height: DEFAULT_MEDIA_HEIGHT,
      created_at: new Date().toISOString(),
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const urlCandidate = raw.url ?? raw.path ?? raw.src;
  const url = typeof urlCandidate === 'string' ? urlCandidate.trim() : '';
  const hasStatus = raw.status === 'pending' || raw.status === 'ready' || raw.status === 'failed';
  const hasId = typeof raw.id === 'string' && raw.id.trim().length > 0;
  // 既没有可用的图地址、也不是一条完整的 MediaItem（id + status）⇒ 无法证明这是媒体。
  if (!url && !(hasId && hasStatus)) return null;

  const item: MediaItem = {
    id: hasId ? String(raw.id) : newMediaId(),
    status: toMediaStatus(raw.status),
    url: url || null,
    width: toPositiveNumber(raw.width) ?? DEFAULT_MEDIA_WIDTH,
    height: toPositiveNumber(raw.height) ?? DEFAULT_MEDIA_HEIGHT,
  };
  if (typeof raw.prompt === 'string') item.prompt = raw.prompt;
  if (typeof raw.seed === 'number') item.seed = raw.seed;
  if (typeof raw.provider_id === 'string' || raw.provider_id === null) item.provider_id = raw.provider_id as string | null;
  if (typeof raw.error === 'string' || raw.error === null) item.error = raw.error as string | null;
  if (typeof raw.created_at === 'string') item.created_at = raw.created_at;
  if (typeof raw.updated_at === 'string') item.updated_at = raw.updated_at;
  if (!item.created_at) item.created_at = new Date().toISOString();
  return item;
}

/**
 * 解析 ST 第一参（mes 消息对象 / 数字下标）在 chat 数组里的位置。
 * ST 的 mes 对象带 `mesid`；酒馆助手侧也常见 `message_id`。对象身份匹配是最后兜底。
 */
export function resolveStMessageIndex(mesOrId: unknown, chat: readonly unknown[]): number {
  if (!Array.isArray(chat) || chat.length === 0) return -1;
  if (typeof mesOrId === 'number') {
    return Number.isInteger(mesOrId) && mesOrId >= 0 && mesOrId < chat.length ? mesOrId : -1;
  }
  if (typeof mesOrId === 'string') {
    // 字符串既可能是数字下标，也可能是消息 id —— 两者都试，不做别的猜测。
    const asIndex = Number(mesOrId);
    if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < chat.length) return asIndex;
    const byId = chat.findIndex((item) => String((item as Record<string, unknown>)?.message_id) === mesOrId);
    return byId;
  }
  if (!mesOrId || typeof mesOrId !== 'object') return -1;

  const record = mesOrId as Record<string, unknown>;
  for (const key of ['mesid', 'message_id', 'index']) {
    const candidate = Number(record[key]);
    if (Number.isInteger(candidate) && candidate >= 0 && candidate < chat.length) return candidate;
  }
  const byIdentity = chat.indexOf(mesOrId);
  if (byIdentity >= 0) return byIdentity;
  // 部分插件会传对象浅拷贝（结构化克隆/展开），用 send_date + mes 双字段认领。
  const mes = typeof record.mes === 'string' ? record.mes : (typeof record.message === 'string' ? record.message : '');
  const sendDate = record.send_date;
  if (mes || sendDate != null) {
    return chat.findIndex((item) => {
      const candidate = item as Record<string, unknown>;
      const sameText = mes ? String(candidate?.mes ?? candidate?.message ?? '') === mes : true;
      const sameDate = sendDate != null ? String(candidate?.send_date ?? '') === String(sendDate) : true;
      return sameText && sameDate;
    });
  }
  return -1;
}

/**
 * 生成落库计划。**纯函数**：不写 storage、不发请求。
 *
 * 参数语义与 ST 对齐：`(mes, messageElement)`。第二参才是媒体来源；
 * 第二参缺省时才回退看第一参（Palink 卡/插件常见 `appendMediaToMessage(msg, { url })`
 * 或直接 `appendMediaToMessage(url)` 两种写法）。
 */
export function buildStMediaAppendPlan(
  mesOrId: unknown,
  mediaSource: unknown,
  chat: readonly unknown[],
): StMediaAppendPlanResult {
  const index = resolveStMessageIndex(mesOrId, chat);
  if (index < 0) return { ok: false, error: 'message_not_found' };

  const source = mediaSource === undefined || mediaSource === null ? mesOrId : mediaSource;
  const media = normalizeStMediaEntry(source);
  if (!media) return { ok: false, error: 'media_unresolved' };

  return { ok: true, plan: { index, media } };
}

export interface StMediaPersistPayload {
  index: number;
  media: MediaItem;
}

export type StMediaPersistResult =
  | { success?: boolean; error?: string; media_index?: number }
  | null
  | undefined;

/**
 * 走宿主桥落库。返回 true 当且仅当宿主明确回报 `success === true`。
 * 宿主缺失 / 抛错 / 回报失败 ⇒ false（绝不把「没写进去」报成成功）。
 */
export async function appendStMessageMedia(options: {
  mesOrId: unknown;
  mediaSource: unknown;
  chat: readonly unknown[];
  persist?: (payload: StMediaPersistPayload) => Promise<StMediaPersistResult> | StMediaPersistResult;
}): Promise<boolean> {
  const planned = buildStMediaAppendPlan(options.mesOrId, options.mediaSource, options.chat);
  if (!planned.ok) return false;
  if (typeof options.persist !== 'function') return false;
  try {
    const result = await options.persist(planned.plan);
    return Boolean(result && (result as { success?: boolean }).success === true);
  } catch {
    return false;
  }
}
