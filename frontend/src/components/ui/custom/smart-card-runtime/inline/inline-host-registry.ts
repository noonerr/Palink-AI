/**
 * 内联渲染的宿主能力注册表。
 *
 * iframe 路径下，卡片调用 sendMessage / setChatMessage / generate 等 API 时，
 * shim 通过 postMessage 把请求打给父页面（legacy-st-sim.ts 的 post()/requestParent()），
 * 父页面处理完再 postMessage 回来，是一套异步 RPC。
 *
 * 内联之后卡片脚本本身就跑在主页面上，RPC 整层没有存在意义——
 * 直接调用宿主注册进来的回调即可。这是内联方案最大的复杂度削减点，
 * 同时也消除了 RPC 往返带来的时序不确定性。
 *
 * 宿主（InlineCardRenderer）在挂载时 register，卸载时 unregister。
 * 未注册的能力调用不会抛异常，只会 warn 一次并返回安全默认值，
 * 避免单个卡片脚本把整条消息渲染带崩。
 */

export interface InlineHostCapabilities {
  /** 以角色身份追加一条消息 */
  sendMessage?: (content: string, options?: Record<string, unknown>) => unknown;
  /** 以用户身份追加一条消息 */
  sendMessageAsUser?: (content: string, options?: Record<string, unknown>) => unknown;
  /** 改写某条消息正文 */
  setChatMessage?: (content: string, messageId?: number | string, options?: Record<string, unknown>) => unknown;
  /** 读取聊天消息列表 */
  getChatMessages?: (range?: unknown) => unknown[];
  /** 触发一次生成 */
  triggerGeneration?: (type?: string, options?: Record<string, unknown>) => unknown;
  /** 卡片内错误上报（对应 iframe 的 post({type:'error'})） */
  reportError?: (message: string, detail?: unknown) => void;
  /** 弹窗（callGenericPopup / Popup） */
  showPopup?: (content: unknown, type?: unknown, inputValue?: unknown, options?: unknown) => unknown;
}

const registry: InlineHostCapabilities = {};
/** 按 cardId 记录每张卡注册过的能力 key，卸载时按卡注销，避免误杀后挂载卡的注册。 */
const registryByCard = new Map<string, Array<keyof InlineHostCapabilities>>();
const warnedMissing = new Set<string>();

/**
 * 注册宿主能力。可选 cardId：传入时记录该卡注册的 key，
 * 卸载时用 unregisterInlineHostCapabilitiesByCard 按卡注销。
 */
export function registerInlineHostCapabilities(caps: InlineHostCapabilities, cardId?: string): void {
  Object.assign(registry, caps);
  if (cardId) {
    registryByCard.set(cardId, Object.keys(caps) as Array<keyof InlineHostCapabilities>);
  }
}

/** 卸载一张内联卡时调用：注销该卡注册的能力（仅删本卡注册过的 key）。 */
export function unregisterInlineHostCapabilitiesByCard(cardId: string): void {
  const keys = registryByCard.get(cardId);
  if (!keys) return;
  for (const key of keys) delete registry[key];
  registryByCard.delete(cardId);
}

export function unregisterInlineHostCapabilities(keys: Array<keyof InlineHostCapabilities>): void {
  for (const key of keys) delete registry[key];
}

/** 取一个宿主能力；缺失时返回 undefined 并按名去重 warn。 */
export function getInlineHostCapability<K extends keyof InlineHostCapabilities>(
  name: K,
): InlineHostCapabilities[K] | undefined {
  const fn = registry[name];
  if (!fn && !warnedMissing.has(name as string)) {
    warnedMissing.add(name as string);
    console.warn('[inline-card] 宿主未注册能力 "' + String(name) + '"，卡片调用将返回默认值');
  }
  return fn;
}

/** 调用宿主能力，缺失或抛错时返回 fallback，绝不向卡片脚本抛异常。 */
export function callInlineHost<K extends keyof InlineHostCapabilities>(
  name: K,
  args: unknown[],
  fallback: unknown = undefined,
): unknown {
  const fn = getInlineHostCapability(name) as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== 'function') return fallback;
  try {
    return fn(...args);
  } catch (error) {
    console.warn('[inline-card] 宿主能力 "' + String(name) + '" 执行失败:', error);
    return fallback;
  }
}

/** 仅供测试重置。 */
export function resetInlineHostRegistry(): void {
  for (const key of Object.keys(registry)) {
    delete (registry as Record<string, unknown>)[key];
  }
  warnedMissing.clear();
}
