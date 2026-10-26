/**
 * 卡内 tavern_helper 脚本执行器（2026-09-30 起，用户决策：允许卡片执行自带脚本并从 CDN 拉库）。
 *
 * 背景：生态复杂卡把交互界面（CG 图库悬浮按钮、已解锁/未解锁图鉴、状态栏特效）写在
 * `characters.extensions.tavern_helper.scripts[]` 里，type='script'。此前 Palink 对这块
 * **只读数据不跑代码**（后端 mvu_engine 只正则解析 zod schema，前端 TavernHelperPanel 是
 * 第一方复刻），所以这类卡自带的按钮永远不出现。本模块补上执行通道。
 *
 * 三条硬约束（都是当天那次「整页内容空白」事故的直接教训，见
 * _BACKUPS/2026-09-30_plugininject-注入断点修复前/BACKUP_INFO.md）：
 *   1. **单个脚本坏不得拖垮整批** —— 每条脚本各自 try/catch，失败只记录并继续下一条。
 *   2. **幂等** —— 同一条脚本（按卡内 script id）在文档里只允许存在一份，重复调用不重跑。
 *   3. **可关** —— localStorage `palink_card_tavern_helper_scripts` === '0' 时整体不执行
 *      （默认开；出问题时一键止血，不用重新构建）。
 *
 * 执行形态：卡内脚本有两类，必须分开处理，否则整段被浏览器当非法 JS 丢弃：
 *   - 顶层 `import`/`export` 的（如 `import 'https://.../MagVarUpdate/bundle.js'`）
 *     → 必须以 `<script type="module">` 注入（经典脚本里 import 会 SyntaxError）。
 *   - 其余全局常驻脚本（CG 图库本体）→ 经典 `<script>`，同步执行，能直接用 window 上的
 *     ST 兼容全局（getVariables / getChatMessages / getCurrentMessageId）。
 */

import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';
import { recordPalinkDiag } from '@/components/ui/custom/smart-card-runtime/palink-diag';
import {
  getCardScriptStorage,
  setCardScriptStorageSyncer,
  type CardScriptStorage,
  type CardScriptStorageNs,
} from './card-script-storage';

export { setCardScriptStorageSyncer, type CardScriptStorage };

/** 止血开关的 localStorage 键（'0' = 关闭，其它值/缺省 = 开启） */
export const CARD_SCRIPT_KILL_SWITCH_KEY = 'palink_card_tavern_helper_scripts';
/**
 * 主页面 legacy 回退开关。默认关闭：卡内 tavern_helper 脚本由智能卡 iframe
 * 接收并执行；设为 '1' 仅用于 S3 期间的现场回退。
 */
export const CARD_SCRIPT_LEGACY_FALLBACK_KEY = 'palink_card_tavern_helper_scripts_legacy';
/** 注入节点上的标记属性，用于幂等判定与卸载 */
export const CARD_SCRIPT_ATTR = 'data-palink-card-script-id';
/**
 * 存储隔离失效的降级登记名。落进 `window.__palinkCompatStats`（+ 插件管理页降级统计）。
 * 存在的理由：生产构建 `drop_console: true` 会剥掉全部 console.*，
 * 「改不动却不吭声」的静默面只能靠这个通道在线上留下痕迹。
 */
export const CARD_SCRIPT_STORAGE_STUB = 'card-script:storage-namespace';

/**
 * 卡脚本在 document.body 上直接创建的 UI（CG 悬浮按钮 / 弹窗 / 灯箱等）。
 * 脚本正文里普遍写 `document.body.appendChild(...)`，节点不在我们的容器里，
 * 离开聊天页时 React 管不到它们 —— 不清理就会飘在其它页面上。
 * 这里按「注入那一次 appendChild 期间 body 上新增的直接子节点」精确登记：
 * 时间窗极窄（同步执行），不会误抓应用自己的门户/提示条。
 */
const cardDomByContainer = new WeakMap<HTMLElement, Set<Node>>();

function trackCardBodyDom(container: HTMLElement, added: Node[]): void {
  const set = cardDomByContainer.get(container) ?? new Set<Node>();
  added.forEach((n) => set.add(n));
  cardDomByContainer.set(container, set);
}

export interface CardScriptRunResult {
  /** 实际注入的脚本 id */
  ran: string[];
  /** 执行/解析失败的脚本 */
  failed: Array<{ id: string; name: string; error: string }>;
  /** 未注入的脚本及原因（开关关闭、重复、非 script 类型等） */
  skipped: Array<{ id: string; name: string; reason: string }>;
  /** 已被 localStorage 命名空间改写命中的脚本 id（P0，便于现场排障「为什么键名变了」） */
  namespaced: string[];
  /**
   * 提到 localStorage/sessionStorage 却**一处都没改写成功**的脚本（P0 隔离静默失效名单）。
   * 两种情况都会进来：①所有命中处改写后编译不过、被逐处回退；②调用方没传 characterId。
   * 这条清单存在的理由：本次事故连着两个构建没人发现，就是因为旧实现静默整条回退。
   */
  storagePatchFailed: Array<{
    id: string;
    name: string;
    keywordHits: number;
    applied: number;
    rolledBack: number;
  }>;
}

export interface CardScriptBridge {
  /** 返回当前会话级变量对象（MVU 的 `getVariables()` 契约：含 stat_data） */
  getVariables: () => Record<string, unknown>;
  /** 当前（最后一条）消息下标，ST 语义里用于配对 getChatMessages */
  getCurrentMessageId: () => number;
}

interface CardScriptEntry {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  content?: string;
}

export interface CardScriptFrameEntry {
  id: string;
  name: string;
  content: string;
  module: boolean;
}

/**
 * [包W 2026-10-19] 主文档轨的卡脚本注入失败取证（与帧内 bootstrap 里的同名逻辑同一口径）。
 * 归属：语法类报错 ⇒ card_authored（卡自带正文在任何标准浏览器都编译不过）；
 * 拿不到 message 的裸失败 ⇒ frame_compat 并在 detail 注明「归属待人工判定」。
 */
function cardScriptSyntaxish(text: string): boolean {
  const low = String(text || '').toLowerCase();
  return ['syntaxerror', 'unexpected token', 'invalid or unexpected', 'import statement', 'import map', 'failed to resolve module']
    .some((needle) => low.includes(needle));
}

export function recordCardScriptInjectionFailure(input: {
  id: string;
  name: string;
  content: string;
  failure: unknown;
  via: string;
  characterId?: string | null;
}): void {
  try {
    const failure = input.failure as Record<string, unknown> | Error | undefined;
    let message = '';
    let filename = '';
    let lineno = -1;
    let colno = -1;
    let stack = '';
    if (failure && typeof failure === 'object') {
      const shape = failure as Record<string, unknown>;
      if (typeof shape.message === 'string') message = shape.message;
      const nested = shape.error as Record<string, unknown> | undefined;
      if (!message && nested && typeof nested.message === 'string') message = nested.message;
      if (nested && typeof nested.stack === 'string') stack = nested.stack;
      else if (typeof shape.stack === 'string') stack = shape.stack;
      if (typeof shape.filename === 'string') filename = shape.filename;
      if (typeof shape.lineno === 'number') lineno = shape.lineno;
      if (typeof shape.colno === 'number') colno = shape.colno;
    } else if (failure !== undefined) {
      message = String(failure);
    }
    const bytes = String(input.content || '').length;
    const lines = String(input.content || '').split('\n').length;
    const location = filename ? `；位置=${filename}:${lineno}:${colno}` : '';
    recordPalinkDiag({
      owner: cardScriptSyntaxish(`${message} ${stack}`) ? 'card_authored' : 'frame_compat',
      kind: 'card_script_injection_failed',
      name: String(input.name || input.id || ''),
      detail: `卡自带脚本注入失败 via=${input.via} id=${input.id} 脚本名=${input.name || '<无名>'}`
        + ` 正文 ${bytes} 字节 / ${lines} 行`
        + (message ? `；报错=${message.slice(0, 200)}` : '；报错=（浏览器未给出 message，归属待人工判定）')
        + location,
      stack: stack.slice(0, 1200),
      filename,
      lineno,
      colno,
      textLength: bytes,
      cardId: input.characterId ? String(input.characterId) : undefined,
    });
  } catch {
    /* 取证失败不得影响注入 */
  }
}

/** 顶层 ESM 语法判定：只认正文开头的 import/export，避免把注释里的词误判 */
export function isTopLevelEsm(content: string): boolean {
  const head = String(content || '').replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n?)*/g, '');
  return /^\s*(?:import|export)\s[\s\S]*?['{(;*=]/.test(head) || /^\s*export\s+(?:const|let|var|function|class|default)\b/.test(head);
}

function cardScriptsOf(extensions: unknown): CardScriptEntry[] {
  const th = (extensions as any)?.tavern_helper;
  const scripts = th?.scripts;
  return Array.isArray(scripts) ? (scripts as CardScriptEntry[]) : [];
}

export function isCardScriptKillSwitchOn(): boolean {
  try {
    return window.localStorage.getItem(CARD_SCRIPT_KILL_SWITCH_KEY) !== '0';
  } catch {
    return true;
  }
}

export function isCardScriptLegacyFallbackOn(): boolean {
  try {
    return window.localStorage.getItem(CARD_SCRIPT_LEGACY_FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 准备给智能卡 iframe 的卡脚本清单。iframe 侧通过 postMessage 收到清单后再以
 * DOM script 节点执行，避免把不可信脚本插进主页面。源码经 structured clone 传输，
 * 因而不会受到 HTML ``script`` 结束标签转义问题影响。
 */
export function getCardTavernHelperScriptsForFrame(extensions: unknown): CardScriptFrameEntry[] {
  if (!isCardScriptKillSwitchOn()) return [];
  return cardScriptsOf(extensions)
    .map((entry, index) => ({
      id: String(entry?.id || `idx-${index}`),
      name: String(entry?.name || ''),
      content: String(entry?.content || ''),
      module: isTopLevelEsm(String(entry?.content || '')),
      enabled: entry?.enabled !== false,
      type: entry?.type || 'script',
    }))
    .filter((entry) => entry.enabled && entry.type === 'script' && entry.content.trim())
    .map(({ id, name, content, module }) => ({ id, name, content, module }));
}

/**
 * 智能卡 iframe 内的脚本接收器。它只负责执行收到的卡脚本，ST 兼容全局和存储
 * 隔离由 iframe 自己的 runtime shim 提供。
 */
export function buildCardScriptFrameBootstrap(frameId: string, nonce = ''): string {
  const frameIdJson = JSON.stringify(String(frameId)).replace(/</g, '\\u003c');
  const nonceAttr = nonce ? ` nonce="${String(nonce).replace(/"/g, '&quot;')}"` : '';
  const nonceJson = JSON.stringify(String(nonce));
  const dependencyUrlsJson = JSON.stringify({
    lodash: 'https://testingcf.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
    vue: 'https://testingcf.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.global.prod.min.js',
    showdown: 'https://testingcf.jsdelivr.net/npm/showdown@2.1.0/dist/showdown.min.js',
    z: 'https://testingcf.jsdelivr.net/npm/zod@4.4.3/+esm',
    yaml: 'https://testingcf.jsdelivr.net/npm/yaml@2.8.1/+esm',
  });
  return `<script${nonceAttr}>
(() => {
  const frameId = ${frameIdJson};
  const scriptNonce = ${nonceJson};
  const dependencyUrls = ${dependencyUrlsJson};
  let thirdPartyGlobalsPromise = null;
  const seen = new Set();
  // [安全顺手批 2026-10-26 · SPEC_下一程 §1#14] 父 realm 的 postMessage 被浏览器扩展
  //（MAIN world 包装）替换后，帧 → 宿主的 RPC / storage / resize 整条通道会被宿主守卫
  // 静默丢弃 —— 病灶与用户裁定见 docs/OPEN_ISSUES.md P2 第 16 行；守卫实测位置：
  // components/ui/custom/CharacterCardRenderer.tsx:1119 的「event.source !== iframeRef.current.contentWindow」。
  // 包装器用主窗口自身转发时 event.source 就不再是本帧 ⇒ 守卫 return，卡片"点了没反应"且零痕迹。
  // 两层防御（本批允许改的文件只有这里与 palink-diag；模板串 part-*/legacy-st-sim 禁止触碰）：
  //   ① **回落通道**：取 Window.prototype 上仍是原生实现的那份 postMessage，以 window.parent
  //      为 receiver 调用 —— incumbent global 仍是本帧，event.source 因此保持正确。
  //      只在"父窗口上的 postMessage 被 own-property 遮蔽掉"时才启用；未包装时
  //      走的还是原来那条调用，行为与改前一致。
  //   ② **丢弃前留痕**：包装在场、投递抛错、入站 frameId 对不上，都经 frame-error 轨上报一条
  //      （宿主对这支只验 source+frameId、**不验 event.source**，见 CharacterCardRenderer.tsx:1035，
  //      所以它是包装场景下唯一还能逃出去的通道），并停止裸 catch。
  const palinkFrameMsg = { wrappedDetected: false, nativeFallbackUsed: false, sendFailed: 0, inboundDropped: 0, noticed: false };
  // 真机取证入口（与 __palinkFrameErrors / __palinkDiagDump 同一套读法）：
  // 帧内控制台 window.__palinkCardScriptFrameMsg ⇒ 包装是否在场、回落是否真用上、丢了几条。
  try {
    window.__palinkCardScriptFrameMsg = palinkFrameMsg;
  } catch (error) {
    palinkFrameMsg.sendFailed += 1;
  }
  const palinkNativePostMessage = () => {
    try {
      const parent = window.parent;
      if (!parent) return null;
      const proto = Object.getPrototypeOf(parent);
      const fn = proto ? proto.postMessage : null;
      if (typeof fn !== 'function') return null;
      // prototype 级补丁已经把原生实现换掉 ⇒ 不能拿它当回落通道（等于再撞一次包装器）
      return /\\[native code\\]/.test(Function.prototype.toString.call(fn)) ? fn : null;
    } catch (error) {
      palinkFrameMsg.sendFailed += 1;
      return null;
    }
  };
  const palinkFrameWrapNotice = (nativeAvailable) => {
    return {
      source: 'palink-smart-card-frame',
      frameId,
      type: 'frame-error',
      message: 'palink_frame_postmessage_wrapped',
      detail: '父 realm 的 postMessage 被第三方包装（own-property 遮蔽了 Window.prototype 的原生实现）。'
        + '原生回落' + (nativeAvailable ? '可用：本帧已改走原生投递，event.source 保持为本帧。' : '不可用：本帧消息将由宿主守卫按 event.source 恒等校验丢弃，'
          + '宿主侧的 capture 看门狗（palink-diag.ts installSmartCardFrameMsgWatch）会留一条 frame_msg_dropped。')
        + '判据口径：frameId=' + String(frameId).slice(-6) + '（宿主发的 id），本通知走 frame-error 轨（只验 frameId）。',
    };
  };
  const palinkSendToParent = (payload) => {
    const parent = window.parent;
    if (!parent) {
      palinkFrameMsg.sendFailed += 1;
      return false;
    }
    const direct = typeof parent.postMessage === 'function' ? parent.postMessage : null;
    const native = palinkNativePostMessage();
    const shadowed = Boolean(direct && native && direct !== native);
    if (shadowed) palinkFrameMsg.wrappedDetected = true;
    const fn = shadowed && native ? native : direct;
    if (shadowed && native) palinkFrameMsg.nativeFallbackUsed = true;
    if (typeof fn !== 'function') {
      palinkFrameMsg.sendFailed += 1;
      return false;
    }
    try {
      fn.call(parent, payload, '*');
    } catch (error) {
      palinkFrameMsg.sendFailed += 1;
      return false;
    }
    if (shadowed && !palinkFrameMsg.noticed) {
      palinkFrameMsg.noticed = true;
      // 直接 fn.call 而不是递归 palinkSendToParent：这条通知本身也必须出得去
      try {
        fn.call(parent, palinkFrameWrapNotice(Boolean(native)), '*');
      } catch (error) {
        palinkFrameMsg.sendFailed += 1;
      }
    }
    return true;
  };
  const report = (message, detail) => {
    palinkSendToParent({ source: 'palink-smart-card-frame', frameId, type: 'frame-error', message, detail });
  };
  const installCardScriptCompatGlobals = () => {
    try {
      const scriptId = '__palink_card_script__';
      if (typeof window.getScriptId !== 'function') window.getScriptId = () => scriptId;
      if (typeof window.getScriptName !== 'function') window.getScriptName = () => 'Palink 卡内脚本';
      if (typeof window.getIframeName !== 'function') window.getIframeName = () => scriptId;
      if (typeof window.getScriptInfo !== 'function') {
        window.getScriptInfo = () => ({ id: scriptId, name: 'Palink 卡内脚本', content: '', enabled: true });
      }
      if (typeof window.getTavernHelperVersion !== 'function') window.getTavernHelperVersion = () => '3.4.17';
      if (typeof window.getTavernVersion !== 'function') window.getTavernVersion = () => '1.12.0';
      if (typeof window.getButtonEvent !== 'function') window.getButtonEvent = (name) => 'tavern_button_' + String(name);
      if (typeof window.reloadIframe !== 'function') window.reloadIframe = () => Promise.resolve();
      let scriptButtons = [];
      if (typeof window.getScriptButtons !== 'function') window.getScriptButtons = () => scriptButtons.slice();
      if (typeof window.replaceScriptButtons !== 'function') window.replaceScriptButtons = (buttons) => { scriptButtons = Array.isArray(buttons) ? buttons.slice() : []; return scriptButtons.slice(); };
      if (typeof window.updateScriptButtonsWith !== 'function') window.updateScriptButtonsWith = (updater) => {
        const next = typeof updater === 'function' ? updater(scriptButtons.slice()) : scriptButtons;
        scriptButtons = Array.isArray(next) ? next : scriptButtons;
        return scriptButtons.slice();
      };
      if (typeof window.appendInexistentScriptButtons !== 'function') window.appendInexistentScriptButtons = (buttons) => {
        (Array.isArray(buttons) ? buttons : []).forEach((button) => {
          if (!button || !button.name || scriptButtons.some((item) => item?.name === button.name)) return;
          scriptButtons.push(button);
        });
        return scriptButtons.slice();
      };
      window.SillyTavern = window.SillyTavern || {};
      if (typeof window.SillyTavern.saveChat !== 'function') window.SillyTavern.saveChat = () => Promise.resolve();
      if (typeof window.SillyTavern.saveChatConditional !== 'function') window.SillyTavern.saveChatConditional = () => Promise.resolve();
      const writeVariables = (value) => {
        if (value && typeof value === 'object' && typeof window.setVariables === 'function') {
          window.setVariables(value);
        }
        return value || {};
      };
      if (typeof window.insertOrAssignVariables !== 'function') window.insertOrAssignVariables = (value) => Promise.resolve(writeVariables(value));
      if (typeof window.updateVariablesWith !== 'function') window.updateVariablesWith = (updater) => {
        const current = typeof window.getVariables === 'function' ? window.getVariables() : {};
        const next = typeof updater === 'function' ? updater(current) : current;
        return Promise.resolve(writeVariables(next));
      };
      if (typeof window.deleteVariable !== 'function') window.deleteVariable = () => Promise.resolve({ variables: {}, delete_occurred: false });
      if (typeof window.eventOn !== 'function' && window.eventSource?.on) window.eventOn = (event, callback) => window.eventSource.on(event, callback);
      if (typeof window.eventOff !== 'function' && window.eventSource?.off) window.eventOff = (event, callback) => window.eventSource.off(event, callback);
      if (typeof window.eventEmit !== 'function' && window.eventSource?.emit) window.eventEmit = (event, data) => window.eventSource.emit(event, data);
      if (typeof window.eventOnce !== 'function' && window.eventSource?.once) window.eventOnce = (event, callback) => window.eventSource.once(event, callback);
      if (typeof window.eventMakeFirst !== 'function') window.eventMakeFirst = (event, callback) => window.eventOn?.(event, callback);
      if (typeof window.eventMakeLast !== 'function') window.eventMakeLast = (event, callback) => window.eventOn?.(event, callback);
      if (typeof window.eventOnButton !== 'function') window.eventOnButton = (event, callback) => window.eventOn?.(event, callback);
      if (!window.event_types) {
        window.event_types = {
          CHAT_CHANGED: 'CHAT_CHANGED',
          MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
          CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
          USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
          MESSAGE_SENT: 'MESSAGE_SENT',
          MESSAGE_UPDATED: 'MESSAGE_UPDATED',
        };
      }
      if (!window.tavern_events) window.tavern_events = window.event_types;
      if (!window.eventTypes) window.eventTypes = window.event_types;
    } catch (error) {
      report('card script compatibility globals unavailable', String(error && (error.stack || error.message || error)));
    }
  };
  const hasGlobal = (name) => {
    try {
      const value = window[name];
      if (name === '_' && value && typeof value.clamp !== 'function') return false;
      return typeof value !== 'undefined';
    } catch { return false; }
  };
  const loadClassic = (name, src) => {
    if (hasGlobal(name)) return Promise.resolve();
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      if (scriptNonce) script.setAttribute('nonce', scriptNonce);
      const finish = () => {
        if (!hasGlobal(name)) report('card script dependency unavailable: ' + name, src);
        resolve();
      };
      script.addEventListener('load', finish, { once: true });
      script.addEventListener('error', () => {
        report('card script dependency failed: ' + name, src);
        resolve();
      }, { once: true });
      (document.head || document.documentElement).appendChild(script);
    });
  };
  const loadModule = async (name, src) => {
    if (hasGlobal(name)) return;
    try {
      const mod = await import(src);
      window[name] = mod;
    } catch (error) {
      report('card script dependency failed: ' + name, String(error && (error.stack || error.message || error)));
    }
  };
  const ensureThirdPartyGlobals = () => {
    if (thirdPartyGlobalsPromise) return thirdPartyGlobalsPromise;
    thirdPartyGlobalsPromise = Promise.all([
      loadClassic('_', dependencyUrls.lodash),
      loadClassic('Vue', dependencyUrls.vue),
      loadClassic('showdown', dependencyUrls.showdown),
      loadModule('z', dependencyUrls.z),
      loadModule('YAML', dependencyUrls.yaml),
    ]).then(() => undefined);
    return thirdPartyGlobalsPromise;
  };
  const dispatchInit = () => {
    try { document.dispatchEvent(new Event('palink-card-init')); } catch {}
  };
  // ==== [包W 2026-10-19] 卡脚本注入失败取证 ====
  // 病灶（包V §3 的现成案例）：卡自带脚本编译不过时，诊断里只知道「某条脚本失败了」，
  // **不带脚本 id 与脚本名**，也没带浏览器给出的行:列 ⇒ 定责只能重开探针。
  // 这里把身份（id / 名 / 正文长度与行数）与位置（filename:lineno:colno）一起写进统一记录器；
  // 上报通道、postMessage 形状、注入时序一字未改（report 仍照旧发 frame-error）。
  // 归属口径：报错文本是语法类（SyntaxError / Unexpected token / import 解析不了）⇒ card_authored
  // （卡自带正文在任何标准浏览器的模块语法下都编译不过）；拿不到 message 的裸失败 ⇒ frame_compat
  // 并在 detail 写明「归属待人工判定」，不伪造结论。
  const palinkCardScriptLf = String.fromCharCode(10);
  const palinkCardScriptPending = {};
  const palinkCardScriptLineCount = (text) => String(text || '').split(palinkCardScriptLf).length;
  const palinkCardScriptPendingAdd = (entry) => { palinkCardScriptPending[String(entry.id)] = entry; };
  const palinkCardScriptPendingRemove = (id) => { delete palinkCardScriptPending[String(id)]; };
  const palinkCardScriptSyntaxish = (text) => {
    const low = String(text || '').toLowerCase();
    return low.indexOf('syntaxerror') >= 0
      || low.indexOf('unexpected token') >= 0
      || low.indexOf('invalid or unexpected') >= 0
      || low.indexOf('import statement') >= 0
      || low.indexOf('import map') >= 0
      || low.indexOf('failed to resolve module') >= 0;
  };
  const palinkCardScriptFailureText = (failure) => {
    try {
      if (failure && typeof failure === 'object') {
        const nested = failure.error && typeof failure.error.message === 'string' ? failure.error.message : '';
        const message = typeof failure.message === 'string' && failure.message ? failure.message : nested;
        const filename = typeof failure.filename === 'string' ? failure.filename : '';
        const lineno = typeof failure.lineno === 'number' ? failure.lineno : -1;
        const colno = typeof failure.colno === 'number' ? failure.colno : -1;
        if (message || filename) return message + ' @ ' + filename + ':' + lineno + ':' + colno;
        return String((failure.error && failure.error.stack) || failure.stack || failure.type || 'script error');
      }
      return String(failure || '');
    } catch (e) {
      return 'failure_text_unavailable';
    }
  };
  const palinkCardScriptDiagRecord = (opts) => {
    try {
      const recorder = typeof window.__palinkDiagRecord === 'function' ? window.__palinkDiagRecord : null;
      if (!recorder) return;
      const entry = opts && typeof opts === 'object' ? opts : {};
      const failure = entry.failure;
      let message = '';
      let filename = '';
      let lineno = -1;
      let colno = -1;
      let stack = '';
      if (failure && typeof failure === 'object') {
        if (typeof failure.message === 'string') message = failure.message;
        if (!message && failure.error && typeof failure.error.message === 'string') message = failure.error.message;
        if (typeof failure.filename === 'string') filename = failure.filename;
        if (typeof failure.lineno === 'number') lineno = failure.lineno;
        if (typeof failure.colno === 'number') colno = failure.colno;
        if (failure.error && typeof failure.error.stack === 'string') stack = failure.error.stack;
        else if (typeof failure.stack === 'string') stack = failure.stack;
      } else if (failure !== undefined) {
        message = String(failure);
        stack = message;
      }
      const bytes = typeof entry.bytes === 'number' ? entry.bytes : String(entry.content || '').length;
      const lines = entry.lines || palinkCardScriptLineCount(entry.content);
      const location = filename ? '；位置=' + filename + ':' + lineno + ':' + colno : '';
      recorder({
        owner: palinkCardScriptSyntaxish(message + ' ' + stack) ? 'card_authored' : 'frame_compat',
        kind: 'card_script_injection_failed',
        name: String(entry.name || entry.id || ''),
        detail: '卡自带脚本注入失败 via=' + String(entry.via || '') + ' id=' + String(entry.id || '')
          + ' 脚本名=' + (String(entry.name || '') || '<无名>')
          + ' 正文 ' + bytes + ' 字节 / ' + lines + ' 行'
          + (message ? '；报错=' + message.slice(0, 200) : '；报错=（浏览器未给出 message，归属待人工判定）')
          + location,
        stack: stack.slice(0, 1200),
        filename: filename,
        lineno: lineno,
        colno: colno,
        textLength: bytes,
      });
    } catch (e) { /* 取证失败不得影响注入 */ }
  };
  // 模块脚本的编译错误只在 window 层给 message 与行列（包V 实拍 about:srcdoc:81:1），
  // 元素级 onerror 拿到的是裸 error 事件 ⇒ 这里做一次性关联：
  // 只有「恰好还挂着一条未 load 的脚本」且报错是语法类时才认领，多义时不猜。
  window.addEventListener('error', (event) => {
    try {
      const ids = Object.keys(palinkCardScriptPending);
      if (ids.length !== 1) return;
      const entry = palinkCardScriptPending[ids[0]];
      const message = event && typeof event.message === 'string' ? event.message : '';
      if (!palinkCardScriptSyntaxish(message)) return;
      palinkCardScriptDiagRecord({
        id: entry.id,
        name: entry.name,
        bytes: entry.bytes,
        lines: entry.lines,
        failure: event,
        via: 'window_error_correlated',
      });
      palinkCardScriptPendingRemove(entry.id);
    } catch (e) { /* 同上 */ }
  });
  const patchInitEvent = (source) => String(source || '').replace(
    /document\\s*\\.\\s*addEventListener\\s*\\(\\s*(['"])DOMContentLoaded\\1/g,
    'document.addEventListener($1palink-card-init$1',
  );
  const execute = (scripts) => {
    if (!Array.isArray(scripts)) return;
    const host = document.body || document.documentElement;
    if (!host) return;
    scripts.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = String(item.id || '');
      const content = String(item.content || '');
      if (!id || !content.trim() || seen.has(id)) return;
      seen.add(id);
      const name = String(item.name || '');
      const script = document.createElement('script');
      script.type = item.module ? 'module' : 'text/javascript';
      script.setAttribute('data-palink-card-script-id', id);
      script.setAttribute('nonce', ${JSON.stringify(String(nonce))});
      script.onerror = (event) => {
        report('card script resource failed: ' + id, palinkCardScriptFailureText(event));
        palinkCardScriptDiagRecord({ id, name, content, failure: event, via: 'element_onerror' });
      };
      script.addEventListener('load', () => { palinkCardScriptPendingRemove(id); });
      palinkCardScriptPendingAdd({ id, name, bytes: content.length, lines: palinkCardScriptLineCount(content), module: Boolean(item.module) });
      script.textContent = patchInitEvent(content);
      try {
        host.appendChild(script);
        dispatchInit();
      } catch (error) {
        report('card script execution failed: ' + id, String(error && (error.stack || error.message || error)));
        palinkCardScriptDiagRecord({ id, name, content, failure: error, via: 'append_throw' });
      }
    });
    dispatchInit();
  };
  installCardScriptCompatGlobals();
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    // [安全顺手批 2026-10-26] 改前这里是"一句 return、零痕迹"。宿主发的这一支带两道既有校验
    //（信封 source + frameId 恒等），frameId 对不上就整条丢掉 —— 丢得不响 = 卡脚本永远收不到
    // 清单却没人知道为什么。现在丢弃前经 frame-error 轨留痕（口径与用户裁定一致）。
    // ⚠️ 两道校验本身不放宽：frameId 就是"这条消息是不是发给本帧"的身份，放宽等于让一张卡
    //    读走另一张卡的脚本包。
    if (!data || data.source !== 'palink-smart-card-parent') return;
    if (data.frameId !== frameId) {
      palinkFrameMsg.inboundDropped += 1;
      report('card-scripts-push dropped: frameId mismatch', '宿主发的 ' + String(data.type || '<no-type>')
        + ' 帧号与本帧不一致，已丢弃（本帧=' + String(frameId).slice(-6)
        + '，来信=' + String(data.frameId || '').slice(-6) + '；累计丢弃 ' + palinkFrameMsg.inboundDropped + ' 条）');
      return;
    }
    if (data.type === 'card-scripts-push') {
      ensureThirdPartyGlobals().then(() => execute(data.scripts));
    }
  }, true);
  // ↑ capture 阶段：本仓在册的测量教训 —— 验/收这条链要在 capture 里看，不能靠包装
  //   postMessage（会制造观察者效应）；bootstrap 是帧内最早跑的脚本，capture 注册因此
  //   稳定先于卡自己的监听器，且本监听器不 stopPropagation、对卡侧可见行为零变化。
})();
</script>`;
}

function existingIds(): Set<string> {
  const set = new Set<string>();
  document.querySelectorAll(`[${CARD_SCRIPT_ATTR}]`).forEach((el) => {
    const v = el.getAttribute(CARD_SCRIPT_ATTR);
    if (v) set.add(v);
  });
  return set;
}

function killSwitchOn(): boolean {
  try {
    return window.localStorage.getItem(CARD_SCRIPT_KILL_SWITCH_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 与 inline-sanitize 的 INLINE_CARD_INIT_EVENT 同名：卡脚本靠它替代 DOMContentLoaded */
const CARD_INIT_EVENT = 'palink-card-init';

/**
 * 把卡脚本里的 `document.addEventListener('DOMContentLoaded', …)` 改写为
 * `palink-card-init`。内联注入发生在 document 早已 ready 之后，DOMContentLoaded
 * 永远不会再触发 —— 不改写的话，卡内 CG 图库这类「初始化挂在 DOMContentLoaded 上」
 * 的脚本会静默不启动（按钮在、点了没反应、网格空）。口径对齐
 * `smart-card-runtime/inline/inline-sanitize.ts:patchDomContentLoaded`。
 */
export function patchCardContentLoaded(code: string): string {
  return String(code || '').replace(
    /document\s*\.\s*addEventListener\s*\(\s*(['"])DOMContentLoaded\1/g,
    'document.addEventListener($1' + CARD_INIT_EVENT + '$1',
  );
}

// ── [P0] 卡脚本 localStorage 命名空间改写（2026-10-02）─────────────────────
// 卡内脚本硬编码了全局键名（如 'tavern_cg_album_unlocked'），而 Key 写在卡里、
// 卡又改不了，只能在注入前把脚本正文里的 Storage 访问替换成按角色隔离的视图。
// 走 Source改写（SPEC §5 路线甲），**不做 window.localStorage 全局劫持（路线乙）**。

/**
 * 卡脚本常见的「宿主窗口」取法。
 *
 * 2026-10-02 返工（P0 第二次未生效的定位结果）：原实现只允许**一层**宿主前缀
 * （`(?:window|self|top|…)\s*\.\s*`），于是链式取法
 * `window.top.localStorage` / `window.parent.localStorage` / `window.frames[0].localStorage`
 * **一处都匹配不上**。而「先爬到顶层窗口、再取 Storage」恰恰是这类卡最典型的写法
 * （SPEC §2.2 已证卡脚本里有 `topWin` 取法），只认一层等于漏掉主要目标。
 *
 * 现在改成允许**宿主任意链**（每段 `名字` 后跟 `.` 或 `[下标]`），上限 6 段 ——
 * 上限只为压住回溯量，不是语义限制。
 */
const STORAGE_HOST_NAME =
  '(?:window|self|top|parent|globalThis|frames|topWin|parentWin|mainWindow|win|document|defaultView)';
const STORAGE_HOST_UNIT = `${STORAGE_HOST_NAME}\\s*(?:\\.\\s*|\\[\\s*[^\\]]{0,32}\\]\\s*\\.\\s*)`;
const STORAGE_HOST_ACCESS = `(?:${STORAGE_HOST_UNIT}){0,6}`;

/**
 * 前导守卫。三类位置都不改写：
 *   - 标识符字符 / `$`：挡住 `mylocalStorage`；
 *   - `.`：挡住 `foo.bar.localStorage`（对象自有属性，不是 Web Storage）；
 *   - **引号（单引号 / 双引号 / 反引号）**：挡住字符串字面量里的关键词。
 *     这一条是本次返工新增的：卡脚本里 `console.warn('localStorage 不可用')` 这类
 *     文案会命中旧正则，改写后把字符串劈断 → 整条脚本编译不过 → 被旧闸门**整条回退**
 *     → 一层隔离全废。实测复现见 `__tests__/card-script-storage.test.ts`。
 */
const STORAGE_PREFIX_GUARD = '[^\\w$.\'"`]';

/**
 * 匹配 `localStorage` / `sessionStorage` 的**使用点**，要求后面紧跟 Storage 成员访问
 * （`.getItem(...)`、`[...]`、`.length`），或一个把语句收住的分隔符（`;` `)` `,` `+` …），
 * 或整个正文结束（`$`，覆盖 `var x = typeof localStorage` 这类收尾写法）。
 *
 * 每次调用返回新实例：带 `g` 的正则是有状态的（`lastIndex`），模块级单例会跨调用串味。
 */
function storageAccessRe(): RegExp {
  return new RegExp(
    `(^|${STORAGE_PREFIX_GUARD})${STORAGE_HOST_ACCESS}(localStorage|sessionStorage)` +
      `(?=\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[|[^\\w$.\\s]|$))`,
    'g',
  );
}

/** 当前这张卡的 UUID。为 null 时 `__palinkCardStorage` 退回匿名共享桶（不隔离但不崩）。 */
let activeStorageCharacterId: string | null = null;

/**
 * 纯语法校验（编译不执行）。改写是把标识符换成函数调用，理论上在任何位置都合法，
 * 但卡脚本来源完全不可控，加一道「改写后编译不过就回退原文」的闸门更稳妥 ——
 * 宁可没隔离，也不能让整张卡的脚本因为 SyntaxError 一条都跑不起来。
 */
function compilesAsScript(code: string): boolean {
  try {
    new Function(code); // eslint-disable-line no-new-func
    return true;
  } catch {
    return false;
  }
}

/** 正文里出现关键词的次数（含字符串/注释内）—— 只数关键词，不判断是否可改写 */
function countStorageKeywords(code: string): number {
  const found = code.match(/\b(?:localStorage|sessionStorage)\b/g);
  return found ? found.length : 0;
}

/** 改写计数。用于「有命中却一处没改」的响亮诊断（静默回退正是本次事故的成因）。 */
export interface CardStoragePatchStats {
  /** 正文里关键词出现次数 */
  keywordHits: number;
  /** 真正改写成命名空间视图的处数 */
  applied: number;
  /** 命中但因改写后编译不过被**逐处**回退的处数（旧实现会因此整条放弃） */
  rolledBack: number;
}

/**
 * 逐处改写 + 逐处回退。
 *
 * 返工要点（2026-10-02）：旧闸门是「全有或全无」—— 只要**一处**位置改写后破坏语法，
 * 整条脚本静默退回原文，且不打任何日志。于是「0 个命名空间键 + 旧全局键原封不动」
 * 这个用户可见现象，可以只由脚本里一句 `console.warn('localStorage 不可用')` 造成。
 * 现在改成逐处验证、逐处回退，并把计数交回调用方出声。
 */
export function patchCardStorageNamespacesWithStats(code: string): {
  code: string;
  stats: CardStoragePatchStats;
} {
  const source = String(code || '');
  const stats: CardStoragePatchStats = {
    keywordHits: countStorageKeywords(source),
    applied: 0,
    rolledBack: 0,
  };
  if (!source) return { code: source, stats };

  const matches = Array.from(source.matchAll(storageAccessRe())).map((m) => {
    const prefix = m[1] || '';
    const at = m.index ?? 0;
    const ns: CardScriptStorageNs = m[2] === 'sessionStorage' ? 'session' : 'local';
    return {
      // 区间必须**含前缀字符**：替换串里也带着它（`prefix + __palinkCardStorage(...)`）。
      // 起点写成 `at + prefix.length` 会让前缀被注入两次 —— 轻则多一个空格，
      // 重则 `if((…)` 括号失衡 → 触发逐处回退 → 该处静默不改写。
      start: at,
      end: at + m[0].length,
      replacement: `${prefix}__palinkCardStorage('${ns}')`,
    };
  });
  if (matches.length === 0) return { code: source, stats };
  // 原文本身就编译不过：那是卡自己的事，不替它「修」，原样放行（与返工前口径一致）
  if (!compilesAsScript(source)) return { code: source, stats };

  // 从后往前替换（避免下标位移），每处替换后单独验证可编译性：
  // 过不了只回退这一处，其余照改 —— 一处冷门写法不该废掉整层隔离。
  let out = source;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    const candidate = out.slice(0, m.start) + m.replacement + out.slice(m.end);
    if (compilesAsScript(candidate)) {
      out = candidate;
      stats.applied += 1;
    } else {
      stats.rolledBack += 1;
    }
  }
  return { code: stats.applied > 0 ? out : source, stats };
}

/**
 * 把卡脚本里的 localStorage / sessionStorage 访问改写为按角色隔离的视图调用。
 *
 * 保守原则：改写后编译不过的位置**逐处**退回原文，其余保留；正文本身不可编译则原样放行
 * （那种卡本来就跑不起来，不归我们背锅，也不替它「修」）。
 */
export function patchCardStorageNamespaces(code: string): string {
  return patchCardStorageNamespacesWithStats(code).code;
}

/** 卡脚本可调的那个桥接函数：`__palinkCardStorage('local'|'session')` */
function installCardScriptStorageGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.__palinkCardStorage === 'function') return;
  w.__palinkCardStorage = function palinkCardStorage(kind?: unknown) {
    const ns: CardScriptStorageNs = kind === 'session' ? 'session' : 'local';
    // 没有角色身份时退回匿名桶而不是返回 null：宁可不隔离，也绝不让脚本拿到空对象引用去调方法
    return getCardScriptStorage(activeStorageCharacterId || '__anonymous__', ns);
  };
}

export interface CardScriptRunOptions {
  /**
   * 角色 UUID（`characters.id`）。**缺省时不改写脚本正文**（保持旧的全部行为），
   * 这样「拿不到身份」的场景最多是没有隔离，不会额外引入改写风险。
   */
  characterId?: string | null;
}

/**
 * 把 ST 语义的变量/消息 API 桥到 window 上，供卡内经典脚本使用。
 * 只在缺失时定义，不覆盖既有实现（沙箱轨与 iframe 轨各有自己的注入）。
 */
export function ensureCardScriptBridge(bridge: CardScriptBridge): void {
  const w = window as any;
  if (typeof w.getVariables !== 'function') {
    w.getVariables = function getVariables() {
      try {
        return bridge.getVariables() || {};
      } catch (error) {
        console.warn('[card-script] getVariables 取数失败:', error);
        return {};
      }
    };
  }
  if (typeof w.getCurrentMessageId !== 'function') {
    w.getCurrentMessageId = function getCurrentMessageId() {
      try {
        return bridge.getCurrentMessageId();
      } catch {
        return -1;
      }
    };
  }
  // Palink 尚未开放「卡内脚本回写」的通道：一律做**显式降级登记**，让插件管理页的
  // 降级统计能看到，而不是静默失效或裸 ReferenceError（同 compat-stub-registry 的立项理由）。
  //
  // [写口族补全 2026-10-05] 原实现只登记了 setVariables / setVariable 两个名字，
  // 而 MVU 变量框架（卡脚本 `backend/data/smart_card_assets/0c646fb31a…js`，307,179 B）
  // 实际调用的是这一整族：replaceVariables ×7、updateVariablesWith ×8、deleteVariable ×1、
  // insertOrAssignVariables ×1、setChatMessage ×1（计数为实测 `grep -o` 统计）。
  // 这些名字在本轨**全是裸 undefined** → MVU 的更新管线每轮抛 ReferenceError
  // （是"崩溃"而不是"降级"），与"写口族已登记降级"的既有口径不一致，故按同一口径补齐。
  //
  // 语义：**只登记、不写入**。Palink 的变量更新走后端 mvu_engine（生成时解析
  // <UpdateVariable> 并落库）、正文也由后端剥离后写入 —— 卡脚本再写一遍会形成双写。
  // 真实写入通道的开放属独立议题，见
  // `docs/REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md` §8 的 P2 项。
  const WRITE_DEGRADED_REASON =
    '卡内脚本回写未开放（Palink 的变量更新与正文写入走后端链路，避免双写）';
  const degradedWrite = (name: string, ret: () => unknown) =>
    function palinkDegradedWrite() {
      recordStubHit(name, WRITE_DEGRADED_REASON);
      return ret();
    };
  // 异步族：TavernHelper 契约返回 Promise，用 resolved Promise 兜底，
  // 避免调用方 `await`/`.then()` 拿到 undefined 再炸一次（换汤不换药的第二个坑）。
  const ASYNC_WRITE_NAMES = [
    'setVariables',
    'setVariable',
    'replaceVariables',
    'updateVariablesWith',
    'insertOrAssignVariables',
    'setChatMessage',
  ] as const;
  for (const name of ASYNC_WRITE_NAMES) {
    if (typeof w[name] !== 'function') {
      w[name] = degradedWrite(name, () => Promise.resolve());
    }
  }
  // 同步族：deleteVariable 的 TavernHelper 契约返回 `{variables, delete_occurred}`，
  // 用**同形状的空结果**兜底，而不是 Promise —— 调用方可能直接读字段。
  if (typeof w.deleteVariable !== 'function') {
    w.deleteVariable = degradedWrite('deleteVariable', () => ({
      variables: {},
      delete_occurred: false,
    }));
  }
}

/**
 * 执行卡内 tavern_helper 脚本。幂等：重复调用只补注入新增的脚本。
 */
export function runCardTavernHelperScripts(
  extensions: unknown,
  container: HTMLElement,
  options: CardScriptRunOptions = {},
): CardScriptRunResult {
  const result: CardScriptRunResult = {
    ran: [],
    failed: [],
    skipped: [],
    namespaced: [],
    storagePatchFailed: [],
  };
  const scripts = cardScriptsOf(extensions);
  if (scripts.length === 0) return result;
  const characterId = options.characterId || null;

  // 先装好 __palinkCardStorage 再跑脚本：改写后的正文依赖这个全局存在。
  // 顺序绝不能反 —— 桥缺失会让引用处直接 ReferenceError，等于把整条脚本打死。
  //
  // **每次调用都要覆盖**（含覆盖成 null）：这是模块级变量，不覆盖就会把**上一张卡**的 id
  // 留给这一批脚本用 —— 用户从卡 A 切到卡 B、而这一次没拿到 id 时，B 的解锁会被写进
  // A 的命名空间，等于反向串卡（返工复核实测到：跨用例/跨卡都复现）。
  activeStorageCharacterId = characterId;
  if (characterId) {
    try {
      installCardScriptStorageGlobals();
    } catch (error) {
      console.warn('[card-script] 安装命名空间存储桥失败，退回原 Storage:', error);
      activeStorageCharacterId = null;
    }
  }

  if (!killSwitchOn()) {
    for (const s of scripts) {
      result.skipped.push({
        id: String(s?.id || s?.name || 'unknown'),
        name: String(s?.name || ''),
        reason: `止血开关已关闭（localStorage ${CARD_SCRIPT_KILL_SWITCH_KEY}=0）`,
      });
    }
    console.warn(
      `[card-script] 跳过 ${scripts.length} 条卡内脚本：${CARD_SCRIPT_KILL_SWITCH_KEY}=0`,
    );
    return result;
  }

  const done = existingIds();
  let classicRan = 0;

  const dispatchCardInit = () => {
    try {
      document.dispatchEvent(new Event(CARD_INIT_EVENT));
    } catch (error) {
      console.warn('[card-script] 派发 ' + CARD_INIT_EVENT + ' 失败:', error);
    }
  };

  scripts.forEach((entry, index) => {
    const id = String(entry?.id || `idx-${index}`);
    const name = String(entry?.name || '');
    const content = String(entry?.content || '');

    if (entry?.enabled === false) {
      result.skipped.push({ id, name, reason: '卡内该脚本 enabled=false' });
      return;
    }
    if ((entry?.type || 'script') !== 'script') {
      result.skipped.push({ id, name, reason: `type=${entry?.type} 非脚本` });
      return;
    }
    if (!content.trim()) {
      result.skipped.push({ id, name, reason: 'content 为空' });
      return;
    }
    if (done.has(id)) {
      result.skipped.push({ id, name, reason: '已注入过（幂等跳过）' });
      return;
    }

    const asModule = isTopLevelEsm(content);
    const el = document.createElement('script');
    el.setAttribute(CARD_SCRIPT_ATTR, id);
    if (asModule) {
      el.type = 'module';
      el.textContent = content;
    } else {
      el.type = 'text/javascript';
      // 与插件注入同源的 nonce 约定：页面若有 CSP，nonce 缺失会被拦
      el.setAttribute('nonce', 'palink-smart-card');
      // 经典脚本才需要改写 —— 模块脚本有自己的求值时序，多为第三方 CDN 库
      // （MVU bundle 之类），改它的 Storage 访问收益小、风险大，本期不碰。
      const contentLoaded = patchCardContentLoaded(content);
      // 经典脚本才需要改写 —— 模块脚本有自己的求值时序，多为第三方 CDN 库
      // （MVU bundle 之类），改它的 Storage 访问收益小、风险大，本期不碰。
      let wrapped = contentLoaded;
      let patchStats: CardStoragePatchStats = {
        keywordHits: countStorageKeywords(contentLoaded),
        applied: 0,
        rolledBack: 0,
      };
      if (activeStorageCharacterId) {
        const patched = patchCardStorageNamespacesWithStats(contentLoaded);
        wrapped = patched.code;
        patchStats = patched.stats;
      }
      if (wrapped !== contentLoaded) {
        result.namespaced.push(id);
        if (patchStats.rolledBack > 0) {
          console.warn(
            `[card-script][P0-STORAGE] 部分位置回退：${name || id}` +
              `（已改写 ${patchStats.applied} 处，回退 ${patchStats.rolledBack} 处；回退处仍是全局存储）`,
          );
        }
      } else if (patchStats.keywordHits > 0) {
        // 有命中却一处没改 —— 这就是本次事故的静默面。必须留痕，只报计数不报正文。
        result.storagePatchFailed.push({ id, name, ...patchStats });
        // ⚠️ 留痕必须走降级登记，不能只靠 console：vite.config.ts 的 terser
        // `drop_console: true` 会把**全部** console.*（含 warn，不只 log/info）从生产产物里剥掉
        // —— 实测确认。写进 window.__palinkCompatStats 才能在线上被看见
        // （插件管理页的降级统计面板读的就是它）。
        recordStubHit(
          CARD_SCRIPT_STORAGE_STUB,
          `${name || id}: 关键词 ${patchStats.keywordHits} 处 / 已改写 0 处 / 回退 ${patchStats.rolledBack} 处` +
            (activeStorageCharacterId ? '' : '（未拿到角色 id）'),
        );
        console.warn(
          activeStorageCharacterId
            ? `[card-script][P0-STORAGE] 脚本提到 localStorage/sessionStorage 但一处都没改写：${name || id}` +
              `（关键词 ${patchStats.keywordHits} 处，回退 ${patchStats.rolledBack} 处）` +
              ' —— 该脚本的存储仍是全局共享，跨卡隔离对它无效'
            : `[card-script][P0-STORAGE] 未拿到角色 id，本次跳过存储隔离改写：${name || id}` +
              `（关键词 ${patchStats.keywordHits} 处，脚本会继续写全局键 = 跨卡共享）。` +
              '检查调用方是否传了 characterId。',
        );
      }
      el.textContent = wrapped;
    }
    // 顶层 const 重复声明会整段抛 SyntaxError（多卡/重进会话同场景），
    // 这里保留原代码不降级为 var：卡脚本靠 const 顶层作用域注册自己，改写风险更大。
    // 失败由下面的 catch/onerror 承接，只影响这一条。
    if (asModule) {
      // 模块脚本异步取 CDN，执行错误不回抛到 appendChild，只能靠 onerror 观测
      el.onerror = (event) => {
        result.failed.push({
          id,
          name,
          error: typeof event === 'string' ? event : 'module script error',
        });
        console.warn(`[card-script] 模块脚本执行失败 ${name || id}:`, event);
        // [包W] 主文档轨同帧内轨口径：身份（id + 名 + 正文长度/行数）必须进诊断记录。
        recordCardScriptInjectionFailure({
          id,
          name,
          content,
          failure: event,
          via: 'host_element_onerror',
        });
      };
    }
    const bodyBefore = Array.from(document.body.children) as Element[];
    try {
      container.appendChild(el);
      result.ran.push(id);
      done.add(id);
      const bodyAfter = Array.from(document.body.children) as Element[];
      const beforeSet = new Set<Node>(bodyBefore);
      const spawned = bodyAfter.filter((n) => !beforeSet.has(n));
      if (spawned.length > 0) trackCardBodyDom(container, spawned);
      if (!asModule) {
        classicRan += 1;
        // 对齐 ST 侧 palink-smart-card.js：每插入一条就派发一次，
        // 让「先注册监听、后被别的脚本触发初始化」的卡脚本也能收到
        dispatchCardInit();
      }
    } catch (error) {
      result.failed.push({
        id,
        name,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      // [包W] 注入这条脚本时同步抛错（顶层 const 重复声明 / 语法错等）⇒ 带身份落记录。
      recordCardScriptInjectionFailure({
        id,
        name,
        content,
        failure: error,
        via: 'host_append_throw',
      });
      console.error(
        `[card-script] 注入失败（已隔离，不影响其余脚本）${name || id}:`,
        error,
      );
      try {
        el.remove();
      } catch {
        /* 节点可能已被脚本自身移除 */
      }
    }
  });

  // 兜底再派发一次：覆盖「后面的脚本注册监听时，前面的派发已经过去」的情况
  if (classicRan > 0) dispatchCardInit();

  return result;
}

/**
 * 卸载：摘掉本容器注入的卡脚本节点，并清掉脚本在 body 上直接创建的 UI
 * （悬浮按钮/弹窗/灯箱）。幂等，重复调用安全。
 */
export function removeCardTavernHelperScripts(container: HTMLElement): number {
  const nodes = Array.from(container.querySelectorAll(`[${CARD_SCRIPT_ATTR}]`));
  nodes.forEach((n) => {
    try {
      n.remove();
    } catch {
      /* ignore */
    }
  });
  const tracked = cardDomByContainer.get(container);
  let domRemoved = 0;
  if (tracked) {
    tracked.forEach((n) => {
      try {
        n.parentNode?.removeChild(n);
        domRemoved += 1;
      } catch {
        /* 脚本可能已自行移除 */
      }
    });
    tracked.clear();
  }
  return nodes.length + domRemoved;
}
