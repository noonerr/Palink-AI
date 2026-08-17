/**
 * 内联渲染的 SillyTavern 主页面全局模拟。
 *
 * ── 与 iframe 路径的根本差异 ─────────────────────────────────────────────
 * iframe 里卡片处在一个干净的空 window，shim 必须凭空造出整套 ST 全局
 * （legacy-st-sim.ts，92KB，68 个全局）。
 *
 * 内联之后卡片跑在主页面上，而主页面**本来就已经有半套真 ST 运行时**：
 * src/utils/sillyTavernPluginRuntime.ts 已挂载 window.SillyTavern.getContext、
 * window.eventSource（接的是真实事件总线 runtime.on/off/emit）、window.substituteParams、
 * window.toastr、世界书 API 等约 20 个全局（由 CharacterChat.tsx 装载）。
 *
 * 因此本模块的定位是 **增强(augment)，不是替换(replace)**：
 *   - 已存在的全局一律不覆盖（`if (typeof window.X !== 'function')` 守卫）
 *   - 只补齐 iframe shim 有、而主页面缺的那部分（Mvu / getAllVariables /
 *     waitGlobalInitialized / eventOn / errorCatched / _ / $ / TavernHelper / 变量读写）
 *   - 需要宿主配合的动作（发消息、改消息、触发生成）走 inline-host-registry 直接调用
 *
 * 这正是用户决策 C5「完全对齐 ST 页面表现」的最优解：卡片接到的是主页面上
 * 真实存在的那套运行时，而不是 iframe 里的一份仿制品。
 *
 * ── 不做 localStorage 劫持 ────────────────────────────────────────────────
 * legacy-st-sim.ts L137-138 把 localStorage/sessionStorage 整体劫持成 postMessage 转发，
 * 那是因为 iframe 在某些 sandbox 组合下访问 storage 会抛 SecurityError。
 * 主页面同源，直接用真 localStorage 即可；仅对 key 加 `palink_card_` 前缀防撞名。
 */

import jQuery from 'jquery';
import type { CharacterSmartCardContext } from '@/types';
import { readSmartCardStorageBucket, writeSmartCardStorageBucket } from '../storage';
import { callInlineHost } from './inline-host-registry';

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

const INSTALL_FLAG = '__palinkInlineStGlobalsInstalled';
const STORAGE_PREFIX = 'palink_card_';

/** 后端下发的会话变量（含 stat_data），由 setInlineStVariables 逐条消息刷新。 */
let currentVariables: AnyRecord = {};
/** 卡片自己 setVariable 写入的本地变量，优先级低于后端数据。 */
const localVariableStore: AnyRecord = {};
/** 卡片脚本写入的持久变量（真 localStorage palink_card_chat_variables）。
 *  模块级供跨路径导入/导出使用（ensureInlineStGlobals 内初始化并读写）。 */
let persistedVariableStore: AnyRecord = {};

/* ────────────────────────── 幽灵监听跟踪（内联↔iframe 切换清理） ──────────────────────────
 * 内联卡脚本跑在主页面全局，脚本注册在 document/window/eventSource 上的监听不会随
 * 卡片 DOM 卸载自动回收（document 是常驻对象）。跨路径切换（如发送新消息后该卡
 * 内联→iframe）会留下幽灵监听，回调里再 querySelector 新 DOM 可能误伤。
 * 这里在脚本重放期间标记「当前卡片作用域」，脚本同步注册的监听按 cardId 记录，
 * 卡片卸载时由 cleanupInlineCardListeners 统一注销。异步（setTimeout 后）注册的监听
 * 会漏记——初始化同步注册是主流，可接受。
 */
const trackedListeners = new Map<string, Array<{ target: AnyRecord; type: string; listener: AnyFn }>>();
let activeScriptCardId: string | null = null;

/** 脚本重放前调用：标记当前卡片，之后该卡脚本同步注册的 document/window/eventSource 监听会被记录。 */
export function beginInlineCardScriptScope(cardId: string): void {
  activeScriptCardId = cardId;
  if (!trackedListeners.has(cardId)) trackedListeners.set(cardId, []);
}

/** 脚本重放完成后调用：清除卡片作用域标记（异步注册不再记录）。 */
export function endInlineCardScriptScope(): void {
  activeScriptCardId = null;
}

/** 卡片卸载时调用：注销该卡脚本注册的全部全局监听，防止幽灵监听残留。 */
export function cleanupInlineCardListeners(cardId: string): void {
  const list = trackedListeners.get(cardId);
  if (!list) return;
  for (const item of list) {
    try {
      if (item.target && typeof item.target.removeEventListener === 'function') {
        item.target.removeEventListener(item.type, item.listener);
      } else if (item.target && typeof item.target.off === 'function') {
        item.target.off(item.type, item.listener);
      }
    } catch {
      /* 单条监听注销失败不影响整体清理 */
    }
  }
  trackedListeners.delete(cardId);
}

/** 安装 document/window 的 addEventListener 包装（幂等，仅安装一次）。 */
function installDomListenerTracking(): void {
  if (typeof document === 'undefined') return;
  const win = window as unknown as AnyRecord;
  if (win['__palinkListenerTrackingInstalled']) return;
  win['__palinkListenerTrackingInstalled'] = true;

  const wrapDomListener = (target: unknown, addName: string, removeName: string): void => {
    const targetRecord = target as AnyRecord;
    const originalAdd = targetRecord[addName] as AnyFn | undefined;
    const originalRemove = targetRecord[removeName] as AnyFn | undefined;
    if (typeof originalAdd !== 'function' || typeof originalRemove !== 'function') return;
    targetRecord[addName] = function (this: unknown, ...args: unknown[]) {
      const type = String(args[0]);
      const listener = args[1] as AnyFn | undefined;
      const cardId = activeScriptCardId;
      if (cardId && typeof listener === 'function') {
        trackedListeners.get(cardId)?.push({ target: targetRecord, type, listener });
      }
      return originalAdd.apply(this, args);
    };
    targetRecord[removeName] = function (this: unknown, ...args: unknown[]) {
      return originalRemove.apply(this, args);
    };
  };
  try {
    wrapDomListener(document, 'addEventListener', 'removeEventListener');
    wrapDomListener(win, 'addEventListener', 'removeEventListener');
  } catch {
    /* 包装失败不阻断卡片运行 */
  }
}

/** 安装 eventSource 的 on 包装（尽力而为；主应用总线只读时跳过，监听残留不清理）。 */
function installBusListenerTracking(bus: { on: AnyFn; off: AnyFn }): void {
  try {
    const busRecord = bus as unknown as AnyRecord;
    const originalOn = bus.on as AnyFn;
    if (typeof originalOn !== 'function') return;
    busRecord.on = function (this: unknown, ...args: unknown[]) {
      const cardId = activeScriptCardId;
      const type = String(args[0]);
      const cb = args[1] as AnyFn | undefined;
      if (cardId && typeof cb === 'function') {
        trackedListeners.get(cardId)?.push({ target: busRecord, type, listener: cb });
      }
      return originalOn.apply(this, args);
    };
  } catch {
    /* eventSource 只读时跳过 */
  }
}

/* ────────────────────────── 跨路径变量迁移（内联↔iframe 数据交换） ──────────────────────────
 * iframe 路径把卡片脚本写的变量持久化在主页面 localStorage 的公共 bucket：
 *   palink:smart-card-storage:v1:localStorage:{角色}:{会话}:{卡片指纹}，key 为 __palink_chat_variables
 * （storage.ts 的 read/writeSmartCardStorageBucket，iframe 挂载时经 persistedStorage 注入、
 *   写入时 postMessage 回传）。内联路径原本只写自己的 palink_card_chat_variables，两路径
 *   持久层不相交 → 同一张卡在两条路径间切换时脚本维护的状态丢失。
 * 这里让内联侧复用同一 bucket：挂载时导入（importInlineCardVariables）、卸载时导出
 * （exportInlineCardVariables），与 iframe 的注入/回写形成闭环。命名空间指纹必须与
 * iframe 侧一致（iframe = hash(原始html + '\n' + customCss)，customCss 恒空）。
 */
const SMART_CARD_VARIABLE_KEY = '__palink_chat_variables';

function toStorageContext(characterId: string | undefined, sessionId: string | undefined): CharacterSmartCardContext {
  return { characterId, sessionId } as unknown as CharacterSmartCardContext;
}

function persistChatVariables(): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + 'chat_variables', JSON.stringify(persistedVariableStore ?? {}));
  } catch {
    /* 隐私模式下 setItem 会抛，忽略 */
  }
}

/** 内联卡卸载前调用：把卡片脚本维护的变量导出到公共存储 bucket，iframe 重挂载时读回。 */
export function exportInlineCardVariables(
  characterId: string | undefined,
  sessionId: string | undefined,
  fingerprint: string,
): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: Record<string, string> = {};
    payload[SMART_CARD_VARIABLE_KEY] = JSON.stringify({ ...persistedVariableStore, ...localVariableStore });
    writeSmartCardStorageBucket(toStorageContext(characterId, sessionId), fingerprint, 'localStorage', payload);
  } catch {
    /* 存储异常不影响卸载 */
  }
}

/** 内联卡挂载时调用：从公共 bucket 读回该卡在 iframe 路径写入的变量。后端变量优先，bucket 数据只补缺。 */
export function importInlineCardVariables(
  characterId: string | undefined,
  sessionId: string | undefined,
  fingerprint: string,
): void {
  if (typeof window === 'undefined') return;
  try {
    const ctx = toStorageContext(characterId, sessionId);
    const bucket = readSmartCardStorageBucket(ctx, fingerprint, 'localStorage');
    const raw = bucket[SMART_CARD_VARIABLE_KEY];
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const key of Object.keys(parsed as AnyRecord)) {
          const value = (parsed as AnyRecord)[key];
          if (value !== undefined && getByPath(currentVariables, key, undefined) === undefined) {
            setByPath(localVariableStore, key, value);
          }
          setByPath(persistedVariableStore, key, value);
        }
      }
    }
    persistChatVariables();
    // 预热写回：无论 bucket 是否有该卡数据，都把当前持久变量写回（幂等）。
    // 页面刷新不触发 React effect cleanup（浏览器 unload 时 cleanup 不保证执行），
    // 卸载导出可能缺失；挂载时主动写回可保证后续切 iframe 时 persistedStorage
    // 注入能读到完整变量（刷新后继续对话的场景靠此兜底）。
    const payload: Record<string, string> = {};
    payload[SMART_CARD_VARIABLE_KEY] = JSON.stringify({ ...persistedVariableStore, ...localVariableStore });
    writeSmartCardStorageBucket(ctx, fingerprint, 'localStorage', payload);
  } catch {
    /* 解析/存储异常时忽略导入，卡片仍可用后端变量 */
  }
}

/* ────────────────────────── 基础工具（对齐 legacy-st-sim L774-784） ────────────────────────── */

function clone<T>(value: T): T {
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : (JSON.parse(JSON.stringify(value)) as T);
  } catch {
    return value;
  }
}

function getByPath(source: unknown, path: string, fallback: unknown = undefined): unknown {
  if (!source || typeof source !== 'object') return fallback;
  const segments = String(path || '').split('.').filter(Boolean);
  let cursor: unknown = source;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object') return fallback;
    cursor = (cursor as AnyRecord)[segment];
  }
  return cursor === undefined ? fallback : cursor;
}

function setByPath(target: AnyRecord, path: string, value: unknown): AnyRecord {
  const segments = String(path || '').split('.').filter(Boolean);
  if (segments.length === 0) return target;
  let cursor: AnyRecord = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key] as AnyRecord;
  }
  cursor[segments[segments.length - 1]] = value;
  return target;
}

/* ────────────────────────── stat_data 扁平→嵌套重组 ──────────────────────────
 * 原样移植自 SillyTavernCompatRuntime.ts L6037-6095。
 * 后端下发的是扁平复合 key（"桃汐.好感度"、"世界信息.日期时间"），
 * 而状态栏面板读的是嵌套 stats['桃汐']['好感度']。这一层不做，状态栏必定全空。
 * 头像值是裸 UUID，需绝对化为 /api/st/characters/<uuid>
 * （注意前缀是 /api/st/characters/，nginx.conf L192-194 明确禁止代理 /characters/*，
 *  那是前端 SPA 的角色详情路由）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAR_PATH_RE = /^\/api\/st\/characters\//i;

function cardOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

function absolutizeAvatar(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (UUID_RE.test(trimmed)) return cardOrigin() + '/api/st/characters/' + trimmed;
  if (CHAR_PATH_RE.test(trimmed)) return cardOrigin() + trimmed;
  return value;
}

function normalizeStatData(merged: AnyRecord): AnyRecord {
  try {
    const sd = (merged.stat_data as AnyRecord) || {};
    const keys = Object.keys(sd);
    if (keys.length === 0) return merged;

    const isNested = keys.some((k) => sd[k] && typeof sd[k] === 'object');
    if (!isNested) {
      // 扁平复合 key → 按第一个 "." 分组。通用 split，覆盖角色 + 世界信息等任意分组。
      const nested: AnyRecord = {};
      for (const fullKey of keys) {
        const dot = fullKey.indexOf('.');
        const group = dot > 0 ? fullKey.slice(0, dot) : '_';
        const attr = dot > 0 ? fullKey.slice(dot + 1) : fullKey;
        if (!nested[group]) nested[group] = {};
        (nested[group] as AnyRecord)[attr] = absolutizeAvatar(sd[fullKey]);
      }
      merged.stat_data = nested;
    } else {
      // 已是嵌套：递归把头像 UUID 绝对化
      const walk = (obj: AnyRecord): void => {
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === 'string' && UUID_RE.test(val.trim())) {
            obj[key] = cardOrigin() + '/api/st/characters/' + val.trim();
          } else if (val && typeof val === 'object') {
            walk(val as AnyRecord);
          }
        }
      };
      walk(sd);
    }
  } catch {
    /* 变量形状异常时保持原样，不阻断卡片渲染 */
  }
  return merged;
}

/** 卡片最终看到的变量集合：后端数据优先，卡片本地写入补缺。 */
function buildAllVariables(): AnyRecord {
  const merged: AnyRecord = { ...localVariableStore, ...clone(currentVariables) };
  return normalizeStatData(merged);
}

/** 宿主在每次拿到新的 AI 输出后调用，刷新卡片可见的变量。 */
export function setInlineStVariables(variables: unknown): void {
  currentVariables = variables && typeof variables === 'object' ? (variables as AnyRecord) : {};
  const win = window as unknown as AnyRecord;
  const bus = win.eventSource as { emit?: AnyFn } | undefined;
  if (bus && typeof bus.emit === 'function') {
    try {
      bus.emit('VARIABLE_UPDATE_ENDED', buildAllVariables());
    } catch {
      /* 事件总线异常不影响渲染 */
    }
  }
}

/* ────────────────────────── 存储（真 localStorage，加前缀） ────────────────────────── */

function readStoredJson(key: string, fallback: AnyRecord = {}): AnyRecord {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AnyRecord) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value ?? {}));
  } catch {
    /* 隐私模式下 setItem 会抛，忽略 */
  }
}

/* ────────────────────────── 安装 ────────────────────────── */

/** 仅在目标全局不存在时写入，绝不覆盖 sillyTavernPluginRuntime 已装好的真实现。 */
function defineIfAbsent(win: AnyRecord, name: string, value: unknown): void {
  if (typeof win[name] === 'undefined') win[name] = value;
}

/**
 * 安装内联卡片所需的 ST 全局。幂等，可重复调用。
 * 必须在任何卡片脚本重放之前完成（InlineCardRenderer 在 layout effect 里调）。
 */
export function ensureInlineStGlobals(): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as AnyRecord;
  if (win[INSTALL_FLAG]) return;
  win[INSTALL_FLAG] = true;

  // 幽灵监听跟踪包装（document/window 的 addEventListener）——幂等，仅安装一次
  installDomListenerTracking();

  /* jQuery：主包里已有（sillyTavernPluginRuntime 静态引用），此处直接复用同一实例 */
  defineIfAbsent(win, '$', jQuery);
  defineIfAbsent(win, 'jQuery', jQuery);

  /* lodash-lite：项目未装 lodash，沿用 legacy-st-sim L774-784 的四件套 */
  defineIfAbsent(win, '_', {
    get: getByPath,
    set: setByPath,
    cloneDeep: clone,
    isEmpty(value: unknown): boolean {
      if (value == null) return true;
      if (Array.isArray(value) || typeof value === 'string') return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    },
  });

  /* eventSource：主页面已有真实总线就复用，没有才兜底造一个 */
  if (!win.eventSource) {
    const listeners = new Map<string, Set<AnyFn>>();
    win.eventSource = {
      on(type: string, cb: AnyFn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      off(type: string, cb: AnyFn) {
        listeners.get(type)?.delete(cb);
      },
      emit(type: string, ...args: unknown[]) {
        for (const cb of listeners.get(type) || []) {
          try {
            cb(...args);
          } catch (error) {
            console.warn('[inline-card] 事件回调异常 ' + type + ':', error);
          }
        }
      },
    };
  }
  const bus = win.eventSource as { on: AnyFn; off: AnyFn; emit: AnyFn };
  // 幽灵监听跟踪：卡片脚本 eventSource.on 注册的监听按 cardId 记录，卸载时清理
  installBusListenerTracking(bus);

  /* 变量读写 */
  persistedVariableStore = readStoredJson('chat_variables', {});
  const persist = (): void => writeStoredJson('chat_variables', persistedVariableStore);
  const getVar = (path: string, fallback?: unknown): unknown => {
    const fromBackend = getByPath(buildAllVariables(), path, undefined);
    return fromBackend !== undefined ? fromBackend : getByPath(persistedVariableStore, path, fallback);
  };
  const setVar = (path: string, value: unknown): unknown => {
    setByPath(persistedVariableStore, path, value);
    setByPath(localVariableStore, path, value);
    persist();
    try {
      bus.emit('VARIABLE_UPDATE_ENDED', buildAllVariables());
      bus.emit('CHAT_VARIABLES_UPDATED', buildAllVariables());
    } catch {
      /* ignore */
    }
    return value;
  };

  defineIfAbsent(win, 'getAllVariables', () => buildAllVariables());
  defineIfAbsent(win, 'getVariables', () => buildAllVariables());
  defineIfAbsent(win, 'getChatVariables', () => buildAllVariables());
  defineIfAbsent(win, 'getVariable', getVar);
  defineIfAbsent(win, 'getLocalVariable', getVar);
  defineIfAbsent(win, 'getGlobalVariable', getVar);
  defineIfAbsent(win, 'setVariable', setVar);
  defineIfAbsent(win, 'setLocalVariable', setVar);
  defineIfAbsent(win, 'setGlobalVariable', setVar);
  defineIfAbsent(win, 'setVariables', (value: unknown) => {
    if (value && typeof value === 'object') Object.assign(persistedVariableStore, value);
    persist();
    return buildAllVariables();
  });

  /* Mvu：状态栏强依赖。可能已被 Tavern Helper 插件装过，需合并而非覆盖，
     且 getAllVariables 必须强制指向我们这份（含 stat_data 重组），
     对齐 SillyTavernCompatRuntime.ts L6026-6105 的「最终覆盖 + 延时补刀」策略。 */
  const existingMvu = (win.Mvu as AnyRecord) || {};
  win.Mvu = {
    ...existingMvu,
    events: {
      VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
      VARIABLE_UPDATE_STARTED: 'VARIABLE_UPDATE_STARTED',
      CHAT_VARIABLES_UPDATED: 'CHAT_VARIABLES_UPDATED',
      ...((existingMvu.events as AnyRecord) || {}),
    },
    getAllVariables: () => buildAllVariables(),
    getVariable: getVar,
    setVariable: setVar,
  };
  // 插件脚本可能异步再次接管 Mvu.getAllVariables，延时补刀一次
  setTimeout(() => {
    try {
      const mvu = win.Mvu as AnyRecord;
      if (mvu) mvu.getAllVariables = () => buildAllVariables();
      win.getAllVariables = () => buildAllVariables();
    } catch {
      /* ignore */
    }
  }, 0);

  /* 生命周期 / 事件 / 错误包装 */
  defineIfAbsent(win, 'waitGlobalInitialized', async (name: string) => {
    // 把续体推迟到下一轮宏任务：卡片 init 里常见 await waitGlobalInitialized(...) 后
    // 立刻 getElementById / querySelector。若在 React 重建 DOM 的同帧内同步续行，
    // 会撞上重建间隙拿到 null（实测 TypeError: Cannot set properties of null）。
    // setTimeout(0) 保证续行发生在 DOM 稳定之后，且不阻塞渲染。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return win[name] || true;
  });
  defineIfAbsent(win, 'eventOn', (type: string, cb: AnyFn) => {
    bus.on(type, cb);
    return () => bus.off(type, cb);
  });
  defineIfAbsent(win, 'eventMakeLast', (type: string, cb: AnyFn) => (win.eventOn as AnyFn)(type, cb));
  defineIfAbsent(win, 'errorCatched', (fn: AnyFn) => (...args: unknown[]) => {
    try {
      const result = typeof fn === 'function' ? fn(...args) : undefined;
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((error: unknown) => {
          console.warn('[inline-card] 卡片异步异常:', error);
          callInlineHost('reportError', [String(error)]);
        });
      }
      return result;
    } catch (error) {
      console.warn('[inline-card] 卡片同步异常:', error);
      callInlineHost('reportError', [String(error)]);
      return undefined;
    }
  });

  /* 消息类 API：内联后无需 postMessage，直接打宿主回调 */
  defineIfAbsent(win, 'getChatMessages', (range?: unknown) => callInlineHost('getChatMessages', [range], []) as unknown[]);
  defineIfAbsent(win, 'setChatMessage', (content: string, messageId?: number | string, options?: AnyRecord) =>
    callInlineHost('setChatMessage', [content, messageId, options], { success: false }));
  defineIfAbsent(win, 'sendMessage', (content: string, options?: AnyRecord) =>
    callInlineHost('sendMessage', [content, options], { success: false }));
  defineIfAbsent(win, 'sendUserMessage', (content: string, options?: AnyRecord) =>
    callInlineHost('sendMessageAsUser', [content, options], { success: false }));
  defineIfAbsent(win, 'sendMessageAsUser', (content: string, options?: AnyRecord) =>
    callInlineHost('sendMessageAsUser', [content, options], { success: false }));
  defineIfAbsent(win, 'sendToTavern', (content: string, options?: AnyRecord) =>
    callInlineHost('sendMessageAsUser', [content, options], { success: false }));
  defineIfAbsent(win, 'generate', (options?: AnyRecord) => callInlineHost('triggerGeneration', ['normal', options]));
  defineIfAbsent(win, 'Generate', (type?: string, options?: AnyRecord) => callInlineHost('triggerGeneration', [type, options]));
  defineIfAbsent(win, 'callGenericPopup', (...args: unknown[]) => callInlineHost('showPopup', args));

  /* getContext / SillyTavern：主页面 sillyTavernPluginRuntime 已提供真实现，只补缺口 */
  if (!win.SillyTavern) win.SillyTavern = {};
  const st = win.SillyTavern as AnyRecord;
  if (typeof st.getContext !== 'function') {
    st.getContext = () => ({
      chat: [],
      characterId: 0,
      chatId: '',
      variables: buildAllVariables(),
    });
  }
  defineIfAbsent(win, 'getContext', () => (st.getContext as AnyFn)());

  /* TavernHelper：卡片常用聚合入口 */
  const existingHelper = (win.TavernHelper as AnyRecord) || {};
  win.TavernHelper = {
    getAllVariables: () => buildAllVariables(),
    getVariables: () => buildAllVariables(),
    getVariable: getVar,
    setVariable: setVar,
    getChatMessages: (range?: unknown) => (win.getChatMessages as AnyFn)(range),
    setChatMessage: (...args: unknown[]) => (win.setChatMessage as AnyFn)(...args),
    eventOn: (...args: unknown[]) => (win.eventOn as AnyFn)(...args),
    errorCatched: (...args: unknown[]) => (win.errorCatched as AnyFn)(...args),
    substituteParams: (text: unknown) => (typeof win.substituteParams === 'function'
      ? (win.substituteParams as AnyFn)(text)
      : String(text ?? '')),
    ...existingHelper,
  };

  /* 兜底 no-op：卡片调到未实现的 ST API 时优雅降级，不抛 ReferenceError 中断整段脚本 */
  const NOOP_GLOBALS = [
    'saveSettingsDebounced', 'saveMetadataDebounced', 'setExtensionPrompt', 'getExtensionPrompt',
    'writeExtensionField', 'readExtensionField', 'updateMessageBlock', 'addOneMessage',
    'generateRaw', 'generateRawData', 'generateQuietPrompt', 'setInputDraft',
    'getWorldbook', 'getWorldbookEntries', 'setWorldbookEntries', 'createWorldbook',
    'createWorldbookEntries', 'deleteWorldbookEntries', 'getCharWorldbook',
    'getCharWorldbookNames', 'activateChatWorldbook', 'rebindChatWorldbook',
    'getCurrentMessageId', 'replaceVariables', 'messageFormatting',
  ];
  for (const name of NOOP_GLOBALS) {
    if (typeof win[name] === 'undefined') {
      win[name] = (...args: unknown[]) => {
        console.warn('[inline-card] 卡片调用了未实现的 ST API: ' + name, args);
        return undefined;
      };
    }
  }
  defineIfAbsent(win, 'chat_metadata', {});
  defineIfAbsent(win, 'extension_settings', {});

  console.warn('[inline-card] ST 主页面全局已就绪（增强模式，未覆盖已有实现）');
}

/** 仅供测试重置。 */
export function resetInlineStGlobalsForTest(): void {
  if (typeof window === 'undefined') return;
  delete (window as unknown as AnyRecord)[INSTALL_FLAG];
  currentVariables = {};
}
