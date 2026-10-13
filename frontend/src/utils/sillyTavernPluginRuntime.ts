import { api, getCsrfToken } from '@/services/api';
import { toast } from 'sonner';
import jQuery from 'jquery';
import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';
import { substituteParamsExtended } from '@/lib/sillytavern/macros';
import { sanitizePluginCss, isUrlAllowedByPluginWhitelist } from '@/lib/plugin-system/sandbox';
import { generationEngine } from '@/services/generation-engine';
import { getContext as getStContext } from '@/lib/sillytavern/getContext';
import { ST_TO_PALINK_EVENT_MAP } from '@/lib/sillytavern/runtime';
import { promptInjection, activeSandboxPartitionKey } from '@/services/prompt-injection';
import { eventBus } from '@/lib/event-bus';

/** S3 大厅注入总闸：默认关闭，设为 '1' 才恢复大厅侧插件容器注入。 */
export const ST_PLUGIN_MAIN_PAGE_INJECTION_KEY = 'palink_st_plugin_main_page_injection';

export function isMainPageStPluginInjectionEnabled(): boolean {
  try {
    return window.localStorage.getItem(ST_PLUGIN_MAIN_PAGE_INJECTION_KEY) === '1';
  } catch {
    return false;
  }
}

interface RuntimePluginResource {
  path?: string;
  content?: string | null;
  missing?: boolean;
  execute?: boolean;
}

interface RuntimePlugin {
  id: string;
  name: string;
  plugin_type: string;
  /** 插件来源：'character_card_extension' = 从角色卡导入的卡内脚本（ST 语义下只应随对应卡运行，禁止全局执行） */
  source_type?: string;
  resources?: {
    css?: RuntimePluginResource[];
    js?: RuntimePluginResource[];
    templates?: RuntimePluginResource[];
    modules?: RuntimePluginResource[];
    assets?: Array<{ path?: string; mime?: string }>;
  };
}

interface RuntimeConfig {
  plugins: RuntimePlugin[];
  extension_settings: Record<string, any>;
}

export interface SillyTavernChatMessage {
  name: string;
  mes: string;
  is_user: boolean;
  send_date?: number;
  extra?: Record<string, any>;
}

export interface SillyTavernCharacter {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creatorcomment?: string;
  tags?: string[];
  avatar?: string;
  // ST 兼容：暴露角色卡 extensions（含 tavern_helper 变量结构），
  // 供 Tavern Helper 插件读取 schema 生成好感度等面板。
  extensions?: Record<string, any>;
}

export interface SillyTavernContext {
  name: string;
  character: SillyTavernCharacter;
  chat: SillyTavernChatMessage[];
  chatId: string;
  onlineStatus: 'active' | 'idle' | 'offline';
  chatMetadata?: Record<string, any>;
  characters?: SillyTavernCharacter[];
  groups?: any[];
  characterId?: number;
  name2?: string;
  // Palink 内部角色 UUID：Galgame 等插件以 avatar 反查角色（/api/characters/chats），
  // 后端仅能解析 palink-{uuid}.png / UUID 形式，base64 data URL 无法反查。
  characterUuid?: string;
  // ST 兼容：会话级 MVU 变量（stat_data），供 Tavern Helper 插件读取并渲染面板。
  stat_data?: Record<string, any>;
}

// ============================================================
// fetch 守卫（阶段2 安全模型）
// ============================================================
// 经典脚本插件运行在主 window，其 fetch 即 window.fetch。守卫在插件注入期间
// 替换 window.fetch：
// - 同源请求：补 Cookie 携带（credentials: include）保证登录态送达（N8-c 终态，
//   认证唯一依赖 HttpOnly Cookie，不再注入 Bearer token；应用的登录态由浏览器
//   按同源 Cookie 规则自动附带，getRequestHeaders 已不再向插件暴露凭据）
// - 跨源请求：套用与 ESM 沙箱同一套域名白名单（isUrlAllowedByPluginWhitelist，
//   默认 CDN + localStorage palink_plugin_fetch_whitelist 用户配置），白名单外
//   拒绝并登记降级统计
// - data:/blob: 与无法解析的 URL 走原生 fetch
// 已知限制（详见 docs/PLUGIN_SECURITY_MODEL.md）：XHR/WebSocket/sendBeacon/动态
// script 标签未拦截；经典插件仍可读 localStorage。守卫目标是阻断 fetch 通道的
// 数据外传与平台凭据的主动分发，不是完整沙箱。
// 模块级状态：CharacterChat 每次挂载都 new 一个运行时实例，守卫须防堆叠。
let nativeFetchForGuard: typeof fetch | null = null;

/**
 * [N8-d 联动] 向经典轨插件广播 ST 事件。
 *
 * 经典轨插件（Galgame 界面插件等）通过 window.eventOn 注册的监听挂在
 * injectIntoContainer 的 runtime 实例上（即 window.__palinkStRuntime）。
 * Palink 侧状态变化（如故事线侧栏切换分支）后调用此函数，插件的
 * tavern_events.CHAT_CHANGED 等监听即可收到并重建自身 UI。
 * 事件名建议用 ST 事件值（如 'chat_id_changed'）；runtime.on 已做键名↔值别名归一。
 */
export function emitClassicPluginEvent(eventName: string, data?: unknown): void {
  try {
    const rt = (window as any).__palinkStRuntime as SillyTavernPluginRuntime | undefined;
    rt?.emit?.(eventName, data);
  } catch { /* 插件事件广播失败不影响主流程 */ }
}

function installGlobalFetchGuard(): void {
  if (nativeFetchForGuard) return;
  const nativeFetch = window.fetch.bind(window);
  nativeFetchForGuard = nativeFetch;

  const guardedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else url = input.url;
    } catch { /* 取不到 URL 时按原样放行 */ }

    let parsed: URL | null = null;
    try { parsed = new URL(url, window.location.href); } catch { parsed = null; }
    if (!parsed || parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      return nativeFetch(input as RequestInfo, init);
    }

    if (parsed.origin === window.location.origin) {
      let nextInput: RequestInfo | URL = input;
      let nextInit = init;
      // N8-c 终态：不再向同源请求注入 Bearer token（认证唯一依赖 HttpOnly Cookie）；
      // 仍为插件请求补 Cookie 携带（credentials: include），保证登录态随请求送达。
      try {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (input instanceof Request) {
          // Request 的 headers 不可变，需重建（body 已消费时抛错，回退原样发送）。
          // N8-b：重建时补 Cookie 携带（原 credentials 为 omit 时保持不动）。
          nextInput = new Request(input, {
            headers,
            credentials: input.credentials === 'omit' ? undefined : 'include',
          });
        } else {
          // N8-b：同源插件请求补 Cookie 携带（调用方显式传值时尊重不覆盖）。
          nextInit = { ...init, headers, credentials: init?.credentials ?? 'include' };
        }
      } catch { /* 参数处理失败按原参数发送 */ }
      return nativeFetch(nextInput as RequestInfo, nextInit);
    }

    if (isUrlAllowedByPluginWhitelist(url)) {
      return nativeFetch(input as RequestInfo, init);
    }
    // 默认仅告警放行：卡片的字体/图片 CDN（如 fontsapi.zeoseven.com）域名发散，
    // 硬拦截会弄死卡片的媒体加载（与"和 ST 一致、全直连"的产品方向冲突）。
    // 需要严格模式时设置 localStorage.palink_plugin_fetch_guard = 'strict'。
    recordStubHit(
      `fetch-cross-origin:${parsed.hostname}`,
      '跨源 fetch 未命中白名单（默认放行并记录；strict 模式可在 palink_plugin_fetch_guard 开启）',
    );
    const strictGuard = (() => {
      try { return localStorage.getItem('palink_plugin_fetch_guard') === 'strict'; } catch { return false; }
    })();
    if (strictGuard) {
      return Promise.reject(
        new Error(
          `[Palink] 跨源请求被插件网络白名单拒绝: ${parsed.hostname}` +
            '（当前为 strict 模式；如需放行，请在 localStorage 的 palink_plugin_fetch_whitelist 中添加该域名）',
        ),
      );
    }
    return nativeFetch(input as RequestInfo, init);
  };

  window.fetch = guardedFetch as typeof fetch;
}

function restoreGlobalFetchGuard(): void {
  if (!nativeFetchForGuard) return;
  try { window.fetch = nativeFetchForGuard; } catch { /* ignore */ }
  nativeFetchForGuard = null;
}

/** setup 脚本的锚点 ID（差集计算时排除它） */
const SETUP_PLUGIN_ID = '__palink_runtime_setup__';

/** ``injectIntoContainer`` 的可选项 */
export interface InjectIntoContainerOptions {
  /**
   * [PLUGIN-ON-DEMAND L1] 差集模式：容器未变且已注入过时，只装卸差异插件，
   * 共用插件的 DOM 节点保持原样（无闪烁、面板状态不丢）。
   */
  diffOnly?: boolean;
  /** S3 legacy fallback: permit classic JS execution in the main document. */
  legacyScriptExecution?: boolean;
}

/**
 * [PLUGIN-ON-DEMAND L1] 差集计算：给定「当前已注入」与「目标」插件 ID，
 * 返回需要卸载 / 需要注入的两个列表。
 *
 * 纯函数（不碰 DOM），单独导出是为了能被单测直接覆盖 —— 25 行字符串集合运算
 * 的边界（含 id 重复、空集、顺序无关）用肉眼审不可靠。
 */
export function computePluginDiff(
  currentIds: Iterable<string>,
  desiredIds: Iterable<string>,
): { toUnload: string[]; toInject: string[] } {
  const current = new Set(currentIds);
  const desired = new Set(desiredIds);
  return {
    toUnload: Array.from(current).filter((id) => id !== SETUP_PLUGIN_ID && !desired.has(id)),
    toInject: Array.from(desired).filter((id) => id !== SETUP_PLUGIN_ID && !current.has(id)),
  };
}

/**
 * [EVENT-BRIDGE] 经典轨**自己会 emit** 的事件名（键名与 ST 事件值两种形态都要列）。
 *
 * 背景：`SillyTavernPluginRuntime.on()` 除了写本轨的 listeners，还会订阅 eventBus
 * 以接住 ST runtime 发出的生态事件（generation_* / message_* 等）。但下列几个名字
 * 本轨已有显式 emit 调用，若再经总线投递就会**同一逻辑事件触发两次**，故排除。
 *
 * 来源（全仓 grep 穷举，改这里前先重跑一遍）：
 *   - `CharacterChat.tsx`：`emit('MESSAGE_SENT')` / `emit('MESSAGE_RECEIVED')` / `emit('CHAT_CHANGED')`
 *   - `CharacterView.tsx`：`emitClassicPluginEvent('chat_id_changed')`
 */
const SELF_EMITTED_EVENTS = new Set<string>([
  'MESSAGE_SENT',
  'message_sent',
  'MESSAGE_RECEIVED',
  'message_received',
  'CHAT_CHANGED',
  'chat_id_changed',
]);

export class SillyTavernPluginRuntime {
  private config: RuntimeConfig | null = null;
  private container: HTMLElement | null = null;
  private listeners = new Map<string, Set<Function>>();
  private extensionSettings: Record<string, any> = {};
  /**
   * [PLUGIN-ON-DEMAND L1] 实际注入到容器里的插件 ID（不含 setup 脚本）。
   * 差集热插拔的基准：切卡时据此只卸载消失的、只注入新增的，共用插件的节点
   * 保持不动（面板状态与已绑事件不丢、肉眼无闪烁）。
   */
  private injectedPluginIds = new Set<string>();
  /**
   * [B4-SHARED-PARTITION 2026-10-03] 共用插件「注册归属」账本：plugin id → 写入
   * ``setExtensionPrompt`` 时所处的沙箱分区键（``sandbox:<characterId>``）。
   *
   * 为什么需要它（差集跳过 + 角色分区这两个设计单独看都对，合起来是错的）：
   *  1. ``prompt-injection`` 在 10-03 起把扩展提示词改成**按角色分区**，
   *     切卡时 CharacterChat 会 ``clearCharacterSandbox(旧卡)`` 删掉旧卡那一格；
   *  2. ``injectIntoContainer({diffOnly:true})`` 对**共用插件整个跳过**
   *     （``injectedPluginIds.has(id)`` → continue），script 节点不重建，
   *     浏览器自然不会重跑它 → 它的 ``setExtensionPrompt`` 也就不会重跑；
   *  于是 A 卡清空后，B 卡拿不到这个共用插件的注入 → 「格式规范丢失 / 卡正则在
   *  extensions JSON」这类症状的近亲（用户报过同款历史问题）。
   *
   * ⚠️ 为什么**不**改成「切卡时把共用插件从 injectedPluginIds 里摘掉重跑」：
   *  节点重建 = 已绑事件丢失 + 插件面板 DOM 重置 + 用户侧可见闪烁，
   *  正是 diffOnly 当初要避免的（见 computePluginDiff 上方注释）。脚本重跑还有
   *  副作用（重复注册监听器、重复 setInterval）。所以走下面的 rebind 通道：
   *  **脚本不重跑，只把它的注册条目搬到新分区**。
   */
  private sharedPartitionOwner = new Map<string, string>();

  /**
   * [B4-SHARED-PARTITION] identifier 粒度的归属账本（替代 sharedPartitionOwner）。
   * identifier → { pluginId, partitionKey }。
   */
  private sharedEntryOwner = new Map<string, { pluginId: string; partitionKey: string }>();
  /**
   * [B4-SHARED-PARTITION] 正在注入中的插件 id（null = 不在注入流程里）。
   *
   * 为什么需要它：``setExtensionPrompt`` 的 identifier 在 ST 生态里是**自由字符串**
   * （BubbleDialogue 用自己的名字，JS-Slash-Runner 用带前缀的 key），
   * 无法从 identifier 反查「这条注册属于哪个插件」。而 rebind 需要按插件粒度搬运，
   * 所以在 ``container.appendChild(scriptEl)`` 同步执行的那一帧前后把它设上，
   * 让 bridge 知道「当前正在执行的是哪个插件」。
   *
   * 依赖 ``appendChild(script)`` **同步执行**这一浏览器语义（append 返回时脚本已跑完），
   * 故用 try/finally 复原，绝不跨 await。
   */
  private registeringPluginId: string | null = null;
  context: SillyTavernContext = {
    name: '',
    character: { name: '', description: '' },
    chat: [],
    chatId: '',
    onlineStatus: 'active',
  };
  private injected = false;
  /** ST 事件值 → ST 常量名 反查表（eventAliases 懒初始化） */
  private reverseEventMap: Record<string, string> | null = null;

  /**
   * [PLUGIN-ON-DEMAND] 拉取插件运行时配置。
   *
   * ``characterId`` 传入时走后端按角色过滤：卡内扩展来源插件仅当该卡自带酒馆助手
   * 生态声明才下发，裸卡不再被塞进无配套渲染的脚本（2026-08-21 实测泄漏源）。
   * api.get 缓存按 URL 区分 → 不同角色各持一份（30s TTL），切卡不会互相污染。
   */
  async loadRuntimeConfig(characterId?: string): Promise<RuntimeConfig> {
    // 30s 前端内存缓存：与 preloadSmartCardRuntimeConfig 共用 api.get 缓存，
    // 同一会话内多次进入对话 / 多个智能卡 iframe 不重复下载 ~4.4MB 插件代码。
    // 插件 CRUD / 配置变更后 AdminPluginsTab 已调用 invalidateCache 清除。
    const url = characterId
      ? `/api/plugins/runtime/config?character_id=${encodeURIComponent(characterId)}`
      : '/api/plugins/runtime/config';
    const data: any = await api.get(url, { cacheTtlMs: 30_000 });
    this.config = data as RuntimeConfig;
    this.extensionSettings = data?.extension_settings || {};
    return this.config;
  }

  setContext(ctx: Partial<SillyTavernContext>) {
    this.context = { ...this.context, ...ctx };
  }

  /**
   * ST substituteParams 兼容实现：优先走 Palink 宏引擎（evaluateMacros），
   * 失败时回退原文并登记降级。{{chatId}} 手动兜底保留——宏引擎环境未注入
   * chatId 时旧桩的这部分行为仍可用。
   */
  substituteParamsCompat(text: string): string {
    const input = String(text ?? '');
    const chatId = this.context.chatId || '';
    try {
      let result = substituteParamsExtended(input);
      if (chatId && result.includes('{{chatId}}')) {
        result = result.split('{{chatId}}').join(chatId);
      }
      return result;
    } catch (e) {
      console.warn('[SillyTavernPluginRuntime] 宏引擎替换失败，回退原文:', e);
      recordStubHit('substituteParams', 'macro-engine-error');
      return chatId ? input.split('{{chatId}}').join(chatId) : input;
    }
  }

  /** 注入脚本内的桩通过此方法登记降级（桥接 compat-stub-registry） */
  recordStubHit(name: string, detail?: string): void {
    recordStubHit(name, detail);
  }

  /**
   * [N8-d 联动] 事件名别名归一：插件惯用 tavern_events.CHAT_CHANGED（ST 事件值
   * 'chat_id_changed'）监听，而 Palink 侧既有 emit 点用映射键 'CHAT_CHANGED'
   * （如 CharacterChat.tsx 会话切换），双向都注册才能接通。ST_TO_PALINK_EVENT_MAP
   * 键=ST 常量名、值=ST 1.18 事件值，别名解析对任意一侧入参补齐另一侧。
   */
  private eventAliases(eventName: string): string[] {
    const names = [eventName];
    const mapped = ST_TO_PALINK_EVENT_MAP[eventName];
    if (mapped) names.push(mapped);
    if (!this.reverseEventMap) {
      this.reverseEventMap = Object.fromEntries(
        Object.entries(ST_TO_PALINK_EVENT_MAP).map(([k, v]) => [v, k]),
      );
    }
    const reverse = this.reverseEventMap[eventName];
    if (reverse) names.push(reverse);
    return names;
  }

  /**
   * [EVENT-BRIDGE] eventBus 订阅的包装函数映射：事件名 → (原回调 → 总线回调)。
   * `off()` 必须退订**同一个**包装函数，故需要留存映射（与 lib/sillytavern/runtime.ts
   * 的 EventSourceWrapper.wrapCallback / listeners 同款做法）。
   */
  private busWrappers = new Map<string, Map<Function, (payload: unknown) => void>>();

  /**
   * 把总线 payload 还原成 ST 的 (...args) 语义。
   *
   * 为什么必须解包：`EventSourceWrapper.emit` 把 `...args` **打包成数组**当单一 payload
   * 发给 eventBus（`lib/sillytavern/runtime.ts:378`）。插件注册的是 ST 形态的回调
   * （如 `eventOn(tavern_events.GENERATION_ENDED, (message_id) => …)`），
   * 不解包就会收到 `[message_id]` 而不是 `message_id`。
   */
  private wrapBusCallback(callback: Function): (payload: unknown) => void {
    return (payload: unknown) => {
      const args = Array.isArray(payload) ? payload : [payload];
      try {
        (callback as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        console.error('SillyTavern plugin bus event handler error:', e);
      }
    };
  }

  on(eventName: string, callback: Function) {
    for (const name of this.eventAliases(eventName)) {
      if (!this.listeners.has(name)) {
        this.listeners.set(name, new Set());
      }
      this.listeners.get(name)!.add(callback);
      // [EVENT-BRIDGE 2026-10-04] 经典轨自己只 emit 少数几个事件（见 SELF_EMITTED_EVENTS），
      // 其余生态事件（generation_started/ended/stopped、message_updated/deleted/swiped、
      // character_message_rendered、stream_token_received …）由 ST runtime 经 eventBus 发出，
      // 此前**完全到不了**经典轨插件的监听器 —— 表现为「AI 说完话面板不刷新」。
      // 这里按上游 EventSourceWrapper（lib/sillytavern/runtime.ts:360）的同款做法订阅总线。
      // ⚠️ 必须排除经典轨自己 emit 的名字，否则同一逻辑事件会被投递两次。
      if (!SELF_EMITTED_EVENTS.has(name)) {
        let perEvent = this.busWrappers.get(name);
        if (!perEvent) {
          perEvent = new Map();
          this.busWrappers.set(name, perEvent);
        }
        if (!perEvent.has(callback)) {
          const wrapped = this.wrapBusCallback(callback);
          perEvent.set(callback, wrapped);
          try { eventBus.on(name as never, wrapped as never); } catch { /* 订阅失败不影响本轨投递 */ }
        }
      }
    }
  }

  off(eventName: string, callback: Function) {
    for (const name of this.eventAliases(eventName)) {
      this.listeners.get(name)?.delete(callback);
      const perEvent = this.busWrappers.get(name);
      const wrapped = perEvent?.get(callback);
      if (wrapped && perEvent) {
        try { eventBus.off(name as never, wrapped as never); } catch { /* ignore */ }
        perEvent.delete(callback);
      }
    }
  }

  emit(eventName: string, data?: any) {
    const cbs = this.listeners.get(eventName);
    if (cbs) {
      cbs.forEach((cb) => {
        try {
          cb(data);
        } catch (e) {
          console.error(`SillyTavern plugin event handler error for ${eventName}:`, e);
        }
      });
    }
  }

  getExtensionSettings(moduleName?: string): any {
    if (moduleName) {
      return this.extensionSettings[moduleName] || {};
    }
    return this.extensionSettings;
  }

  setExtensionSettings(moduleName: string, settings: any) {
    this.extensionSettings[moduleName] = settings;
    this.emit('EXTENSION_SETTINGS_UPDATED', { moduleName, settings });
  }

  /**
   * 判断插件脚本是否为 ESM 模块（含 import/export 语句）。
   * Palink 原生插件用 ESM 编写，需由 plugin-system 沙箱转译执行；
   * 本兼容运行时只注入经典脚本，遇到 ESM 应跳过。
   * 注：仅做轻量启发式检测（ST 扩展不会在字符串/注释里出现模块级 import/export）。
   */
  private isEsmModule(code: string): boolean {
    if (!code || typeof code !== 'string') return false;
    return /(?:^|\n)\s*(?:import\s*[[{'"*]|import\s+\w+\s+from|export\s*(?:default|const|let|var|function|class|async|\*|\{))/m.test(
      code,
    );
  }

  injectIntoContainer(container: HTMLElement, options: InjectIntoContainerOptions = {}) {
    const legacyScriptExecution = options.legacyScriptExecution !== false;
    // canDiff：容器没换、之前注入过 → 走差集热插拔，不清全局状态（保插件面板状态）。
    // 其余情况沿用老的全量重装语义（unloadAll），行为与 L0 完全一致。
    const canDiff = Boolean(options.diffOnly) && this.injected && this.container === container;

    // 每次全量注入前清理 Galgame 插件残留状态：
    // 首次加载时 this.injected 为 false，不会调用 unloadAll()，
    // 导致 localStorage 中残留的 galgame-ui-plugin_char_enabled 被插件读取，
    // 若 default=true 则自动启用 overlay。在注入前无条件清理，确保干净启动。
    // ⚠️ 差集模式下跳过：这会连带清掉仍在运行的插件自己的标志，等于把"不重装"
    //   的好处又丢掉了（那些全局标志没有归属信息，属 L2 议题，见 §2.7.3）。
    if (!canDiff) {
      this.cleanupGalgameState();
    }

    if (this.injected && !canDiff) {
      this.unloadAll();
    }
    this.container = container;
    this.injected = true;
    // fetch 守卫须在插件脚本注入前生效（插件脚本 append 即执行）
    installGlobalFetchGuard();

    (window as any).__palinkStRuntime = this;
    (window as any).__palinkToastSuccess = (msg: string) => toast.success(msg);
    (window as any).__palinkToastError = (msg: string) => toast.error(msg);

    // 设置全局 jQuery：酒馆助手等 ST 插件脚本在 IIFE 中直接使用 $ 变量，
    // 必须在脚本注入前将 window.$ / window.jQuery 设置为真实 jQuery，
    // 否则脚本执行时触发 ReferenceError: $ is not defined。
    if (typeof (window as any).$ === 'undefined') {
      (window as any).$ = jQuery;
    }
    if (typeof (window as any).jQuery === 'undefined') {
      (window as any).jQuery = jQuery;
    }
    (window as any).__palinkToastInfo = (msg: string) => toast.info(msg);

    // ── Galgame 插件兼容桥接层（ST 形状 API → Palink 原生能力）──
    // 插件只面向 ST 形状的接口（setChatMessages/triggerSlash/openCharacterChat…），
    // 所有写操作经此桥接层落到 Palink 既有后端 API，保证分支/消息/会话数据模型一致。
    let worldbookNamesCache: string[] = [];
    // [L1-SETTINGS 2026-10-04] 只读项数据源缓存（同步读取，注入时预取）。
    // ST 的 getPresetNames / getCharLorebooks 是**同步** API，而真数据要拉后端，
    // 故沿用 worldbookNamesCache 的既有模式：注入时 fire-and-forget 预取到缓存，
    // 插件同步调用时读缓存；未就绪时返回安全空值（并在调用点登记降级）。
    let presetNamesCache: string[] = [];
    // getPreset（实卡调用 5 次）要的是预设**对象**，不是名字 —— 同一次请求顺手缓存，
    // 不额外发请求。按 name 建索引，取不到返回 null（插件侧自行降级）。
    let presetObjectCache: Record<string, any> = {};
    let charLorebooksCache: { characterId: string; primary: string | null; additional: string[] } = {
      characterId: '',
      primary: null,
      additional: [],
    };
    const palinkBridge = {
      // P0-1: COT 格式化文本写回 swipe（ST setChatMessages → /api/chats/save）
      // ST 插件传两种形态：(a) 完整消息数组；(b) 部分更新 [{message_id, swipes, swipe_id}]。
      // 部分更新按楼层 message_id 定位现有消息，只改 swipes，避免整体覆盖清空聊天。
      saveChatMessages: async (messages: any[]): Promise<boolean> => {
        try {
          const sessionId = this.context.chatId;
          const uuid = (this.context as any).characterUuid;
          if (!sessionId || !uuid || !Array.isArray(messages) || messages.length === 0) return false;
          const current = await palinkBridge.fetchSessionMessages();
          let chatItems: any[] = (Array.isArray(current) ? current : []).slice(1);
          const isPartialUpdate = messages.every(
            (m) => m && typeof m === 'object' && m.message_id != null && m.mes == null && Array.isArray(m.swipes),
          );
          if (isPartialUpdate) {
            for (const upd of messages) {
              const floor = Number(upd.message_id);
              const idx = chatItems.findIndex(
                (m) => Number(m?.mesid) === floor || Number(m?.id) === floor || Number(m?.message_id) === floor,
              );
              if (idx === -1) continue;
              const target = chatItems[idx];
              const nextSwipes = Array.isArray(upd.swipes) ? upd.swipes.map((s: any) => String(s ?? '')) : (target?.swipes || []);
              const nextSwipeId = upd.swipe_id != null ? Number(upd.swipe_id) : (target?.swipe_id ?? 0);
              chatItems[idx] = Object.assign({}, target, {
                swipes: nextSwipes,
                swipe_id: nextSwipeId,
                extra: Object.assign({}, target?.extra, { swipes: nextSwipes }),
              });
            }
          } else {
            // 完整数组：直接用传入消息，规范化顶层 swipes（后端优先顶层字段）
            chatItems = messages.map((m: any) => {
              const swipes = Array.isArray(m?.swipes) && m.swipes.length
                ? m.swipes.map((s: any) => String(s ?? ''))
                : (Array.isArray(m?.extra?.swipes) ? m.extra.swipes.map((s: any) => String(s ?? '')) : null);
              if (swipes) {
                return Object.assign({}, m, { swipes, extra: Object.assign({}, m.extra, { swipes }) });
              }
              return m;
            });
          }
          const resp = await api.post('/api/chats/save', {
            avatar_url: `palink-${uuid}.png`,
            chat: chatItems,
          });
          // 内存同步：写回 runtime.context.chat，使 getChatMessages 立即可读
          this.context = {
            ...this.context,
            chat: chatItems.map((m: any) => ({
              name: String(m?.name ?? ''),
              mes: String(m?.mes ?? ''),
              is_user: Boolean(m?.is_user),
              send_date: m?.send_date ? new Date(m.send_date).getTime() : undefined,
              extra: m?.extra ?? {},
              swipes: Array.isArray(m?.swipes) ? m.swipes : (m?.extra?.swipes || []),
              swipe_id: m?.swipe_id ?? m?.extra?.swipe_id ?? 0,
            })),
          };
          this.emit('MESSAGE_UPDATED');
          window.dispatchEvent(new CustomEvent('palink:chatMessagesUpdated'));
          return Boolean(resp?.ok);
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] saveChatMessages failed:', e);
          return false;
        }
      },
      // 读取当前会话 ST 消息（含数据库 id/mesid/branch 上下文，用于楼层锚点解析）
      fetchSessionMessages: async (): Promise<any[]> => {
        const sessionId = this.context.chatId;
        const uuid = (this.context as any).characterUuid;
        if (!sessionId || !uuid) return [];
        const resp = await api.post('/api/chats/get', {
          avatar_url: `palink-${uuid}.png`,
          ch_name: this.context.name2 || '',
        });
        return Array.isArray(resp) ? resp : [];
      },
      // 把楼层号（mesid）解析为 {branchId, messageId}（数据库 id）
      resolveMessageAnchor: async (floorId: number): Promise<{ branchId?: string | null; messageId?: number | null } | null> => {
        try {
          const resp = await palinkBridge.fetchSessionMessages();
          if (!Array.isArray(resp) || resp.length === 0) return null;
          const header = resp[0];
          const branchId = header?.chat_metadata?.palink_branch_id ?? header?.branch_id ?? null;
          for (const item of resp.slice(1)) {
            if (Number(item?.mesid) === Number(floorId) || Number(item?.id) === Number(floorId)) {
              return { branchId, messageId: item?.id ?? null };
            }
          }
          return { branchId, messageId: null };
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] resolveMessageAnchor failed:', e);
          return null;
        }
      },
      // P0-2: slash 命令桥接（分支/存档命令 → Palink 分支 API，其余走引擎）
      runSlashCommand: async (command: string): Promise<string> => {
        const cmd = String(command ?? '').trim();
        const sessionId = this.context.chatId;
        try {
          // /branch-create {mesId}、/checkpoint-create mesId=X {name}
          const branchCreateMatch = cmd.match(/^\/branch-create\s+(\d+)/) || cmd.match(/^\/checkpoint-create\s+mesId=(\d+)(?:\s+(.*))?$/i);
          if (branchCreateMatch && sessionId) {
            const floorId = Number(branchCreateMatch[1]);
            const branchName = branchCreateMatch[2] ? String(branchCreateMatch[2]).trim() : undefined;
            const anchor = await palinkBridge.resolveMessageAnchor(floorId);
            const payload: any = { session_id: sessionId, same_level: false };
            if (anchor?.branchId) payload.parent_branch_id = anchor.branchId;
            if (anchor?.messageId) payload.parent_message_id = anchor.messageId;
            if (branchName) payload.branch_name = branchName;
            await api.post(`/api/character-sessions/${sessionId}/branches`, payload);
            window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId } }));
            return '';
          }
          // /checkpoint-go {mesId}：切到目标消息所在分支并定位
          const checkpointGoMatch = cmd.match(/^\/checkpoint-go\s+(\d+)/);
          if (checkpointGoMatch && sessionId) {
            const floorId = Number(checkpointGoMatch[1]);
            const anchor = await palinkBridge.resolveMessageAnchor(floorId);
            if (anchor?.branchId) {
              const qs = anchor.messageId ? `&up_to_message_id=${anchor.messageId}` : '';
              await api.post(`/api/character-sessions/${sessionId}/branches/${anchor.branchId}/switch?limit=10${qs}`);
              window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId, branchId: anchor.branchId, messageId: anchor.messageId } }));
            }
            return '';
          }
          // /chat-fork：当前聊天同级分叉
          if (/^\/chat-fork\b/.test(cmd) && sessionId) {
            await api.post(`/api/character-sessions/${sessionId}/branches`, { session_id: sessionId, same_level: true });
            window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId } }));
            return '';
          }
          // /getchatname：返回当前聊天文件名（与 /api/characters/chats 的 file_name 对齐）
          if (/^\/getchatname\b/.test(cmd)) {
            return sessionId ? `palink-session-${sessionId}.jsonl` : '';
          }
          // ST /model get/set：读当前模型名、切换 raw 生成所用模型（generationEngine 上下文）。
          // Galgame 插件加强模式经 /profile /model /preset 快照→切换→恢复 API 配置
          // （COT 二次生成换更强模型）；Palink 无独立 profile/preset 概念，统一映射为模型。
          if (/^\/model(?:\s|$)/i.test(cmd)) {
            const arg = String(cmd).replace(/^\/model\s*/i, '').replace(/^quiet=true\s*/i, '').trim();
            if (arg) {
              try { generationEngine.setContext({ model: arg }); } catch (e) { /* ignore */ }
              return /^\/model\s+quiet=true\b/i.test(cmd) ? arg : `Model: ${arg}`;
            }
            const currentModel = (generationEngine as any)._currentModel || '';
            return /quiet=true/i.test(cmd) ? currentModel : (currentModel ? `Current model: ${currentModel}` : '');
          }
          if (/^\/(profile|preset)(\s|$)/i.test(cmd)) {
            const arg = String(cmd).replace(/^\/(profile|preset)\s*/i, '').replace(/^quiet=true\s*/i, '').trim();
            if (arg) {
              // set：映射为模型切换；返回空串即可（runSlashSafe 只判"未知命令"）
              try { generationEngine.setContext({ model: arg }); } catch (e) { /* ignore */ }
              return '';
            }
            // get：返回当前模型名，让插件快照/恢复闭环；无模型时返回空串（插件跳过恢复）
            return (generationEngine as any)._currentModel || '';
          }
          if (/^\/profile-list\b/.test(cmd)) {
            recordStubHit('slash:profile-list', 'Palink 无独立 profile/preset 概念，返回空列表');
            return '';
          }
          // 其余命令委托 Palink SlashCommandEngine
          const { SlashCommandEngine } = await import('@/lib/slash-engine/mod');
          const result = await SlashCommandEngine.execute(cmd);
          return typeof result === 'string' ? result : String(result ?? '');
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] runSlashCommand failed:', cmd, e);
          return '';
        }
      },
      // P0-5: 跨会话切换（openCharacterChat → 全局事件，由 CharacterChat 监听切换）
      switchChat: (chatFile: string): boolean => {
        const file = String(chatFile ?? '').trim();
        const m = file.match(/palink-session-([0-9a-f-]{36})(?:\.jsonl)?$/i);
        const sessionId = m ? m[1] : (file.includes('/') ? file.split('/').pop()?.replace(/\.jsonl$/i, '') || '' : file.replace(/\.jsonl$/i, ''));
        if (!sessionId) return false;
        window.dispatchEvent(new CustomEvent('palink:switchChat', { detail: { chatId: sessionId, chatFile: file } }));
        return true;
      },
      // P0-4: COT 世界书读写（ST getWorldbook 语义返回条目数组）
      worldbookGetEntries: async (name: string): Promise<any[]> => {
        try {
          // [WB-NAME-AMBIG 2026-10-06] 带上当前角色：同一用户可以有多本同名的书
          // （实测两张卡各绑一本「露缇雅1.2」），不带的话后端按名查找会在同名书里
          // 随机挑一本，读到的是别的角色的书。后端只用它做排序偏好，不做过滤，
          // 取不到时行为与不带完全一致。
          const cid = (this.context as any)?.characterUuid;
          const resp = await api.post('/api/worldinfo/get', {
            name,
            characterId: cid ? String(cid) : undefined,
          });
          const entries = resp?.entries;
          if (!entries) return [];
          const list = Array.isArray(entries) ? entries : Object.values(entries);
          // Palink ST 世界书条目无 name 字段；插件以 name 匹配条目（updateWorldbookWith），
          // 从 extensions.gal_plugin_name 恢复插件自定义 name
          return list.map((e: any) => {
            if (!e || typeof e !== 'object') return e;
            const pluginName = e.extensions?.gal_plugin_name;
            if (pluginName && !e.name) return Object.assign({}, e, { name: pluginName });
            return e;
          });
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] worldbookGetEntries failed:', e);
          return [];
        }
      },
      worldbookSaveEntries: async (name: string, entries: any[]): Promise<boolean> => {
        try {
          const dict: Record<string, any> = {};
          for (const e of Array.isArray(entries) ? entries : []) {
            if (!e || typeof e !== 'object') continue;
            // 把插件自定义 name 存入 extensions（后端 round-trip 保留），读取时恢复
            const withName = e.name
              ? Object.assign({}, e, { extensions: Object.assign({}, e.extensions, { gal_plugin_name: e.name }) })
              : e;
            dict[e.uid ?? e.name ?? `entry_${Object.keys(dict).length}`] = withName;
          }
          const resp = await api.post('/api/worldinfo/edit', { name, data: { entries: dict } });
          const ok = Boolean(resp?.ok);
          if (ok) {
            if (!worldbookNamesCache.includes(name)) {
              worldbookNamesCache.push(name);
            }
            // [ST-ALIGN P0-4] worldinfo_updated 此前从不 emit，监听它的世界书类
            // 插件（变更后自动刷新/联动）静默失效。eventBus 与 eventSource 同源
            // （context.ts:66/80 双向桥接），此处 emit 即可让 eventSource.on 收到。
            try {
              eventBus.emit('worldinfo_updated' as any, { name } as any);
            } catch {
              /* no-op */
            }
          }
          return ok;
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] worldbookSaveEntries failed:', e);
          return false;
        }
      },
      // getWorldbookNames 需同步返回，桥接层维护名称缓存（注入时与写操作后刷新）
      worldbookRefreshNames: async (): Promise<string[]> => {
        try {
          const resp = await api.post('/api/worldinfo/list');
          worldbookNamesCache = resp && typeof resp === 'object'
            ? Object.values(resp).map((w: any) => w?.name).filter(Boolean)
            : worldbookNamesCache;
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] worldbookRefreshNames failed:', e);
        }
        return worldbookNamesCache;
      },
      worldbookNames: (): string[] => worldbookNamesCache,

      // ── [L1-SETTINGS 2026-10-04] 只读项数据源 ──
      // getPresetNames（缺口清单 A5）：Palink 的 prompt presets 与 ST 的 OpenAI 预设
      // 不是同一个模型（ST 预设 = 采样参数集；Palink 预设 = 生成参数模板），
      // 但「名字列表」这层语义是共通的，按名字列表提供即可。
      refreshPresetNames: async (): Promise<string[]> => {
        try {
          const resp = await api.get('/api/roleplay/presets');
          if (Array.isArray(resp)) {
            presetNamesCache = resp.map((p: any) => String(p?.name ?? '')).filter(Boolean);
            const index: Record<string, any> = {};
            for (const p of resp) {
              const pname = String((p as any)?.name ?? '').trim();
              if (pname && !(pname in index)) index[pname] = p;
            }
            // 默认档也按 is_default 建一个别名，供 getPreset() 无参调用取
            const def = resp.find((p: any) => (p as any)?.is_default) || resp[0];
            if (def) index['__palink_default__'] = def;
            presetObjectCache = index;
          }
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] refreshPresetNames failed:', e);
        }
        return presetNamesCache;
      },
      presetNames: (): string[] => presetNamesCache,
      /** getPreset（缺口清单 A4/A5）：按名取预设对象；无名/未命中 → 默认档 */
      presetByName: (name?: string): any => {
        const key = String(name ?? '').trim();
        return (key && presetObjectCache[key]) || presetObjectCache['__palink_default__'] || null;
      },

      // getCharLorebooks（缺口清单 A3）：当前角色绑定的世界书。
      // 后端 GET /api/worldbooks?character_id=..&type=character_book 已带
      // user_id == 当前用户 过滤（app/api/worldbook.py:290-295），不会跨用户读到。
      refreshCharLorebooks: async (characterId?: string): Promise<{ primary: string | null; additional: string[] }> => {
        const cid = String(characterId ?? '').trim();
        if (!cid) {
          charLorebooksCache = { characterId: '', primary: null, additional: [] };
          return charLorebooksCache;
        }
        try {
          const resp = await api.get(
            `/api/worldbooks?character_id=${encodeURIComponent(cid)}&type=character_book`,
          );
          const names = Array.isArray(resp)
            ? resp.map((w: any) => String(w?.name ?? '')).filter(Boolean)
            : [];
          charLorebooksCache = {
            characterId: cid,
            primary: names.length > 0 ? names[0] : null,
            additional: names.slice(1),
          };
        } catch (e) {
          console.error('[SillyTavernPluginRuntime] refreshCharLorebooks failed:', e);
          charLorebooksCache = { characterId: cid, primary: null, additional: [] };
        }
        return charLorebooksCache;
      },
      charLorebooks: (): { primary: string | null; additional: string[] } => ({
        primary: charLorebooksCache.primary,
        additional: charLorebooksCache.additional.slice(),
      }),
      /** 当前缓存是给哪个角色拉的（用于判断缓存是否仍适用于当前卡） */
      charLorebooksFor: (): string => charLorebooksCache.characterId,
    };
    (window as any).__palinkBridge = palinkBridge;
    // 注入时预取世界书名称缓存（fire-and-forget，供插件同步读取）
    void palinkBridge.worldbookRefreshNames();
    // [L1-SETTINGS] 同上：预设名 / 角色绑定世界书预取。
    // 注：角色 id 此刻可能还没进 context（loadRuntimeConfig 与 setContext 时序不定），
    // 故这里只预取预设名；角色世界书在窗口侧首次调用时按当前 id 惰性拉取。
    void palinkBridge.refreshPresetNames();

    // ── [A-6] 经典轨 window.setExtensionPrompt 全局真实现 ──
    // 桥接到 prompt-injection 服务（与沙箱轨 prompt-injection.ts 同源）。
    // 数据结构：promptInjection._sources['sandbox'][identifier] =
    //   { content, position, depth, scan, role, filter }，由
    // useCharacterChat / CharacterChat 在装配时经 getPromptsForGeneration()
    // 消费。BubbleDialogue 等卡内脚本引用全局 setExtensionPrompt(...) 此前
    // ReferenceError，现由注入脚本（见 setupScript）转发到此桥。
    (window as any).__palinkSetExtensionPrompt = (
      identifier: string,
      content: string,
      position?: number,
      depth?: number,
      scan?: boolean,
      role?: number | string,
      filter?: any,
    ) => {
      try {
        promptInjection.setExtensionPrompt(identifier, content, position as any, depth, scan, role, filter);
        // [B4-SHARED-PARTITION] 逐条记「这个 identifier 是哪个插件、在哪个角色分区下
        // 写的」。记 **owner 插件**：identifier 在 ST 生态里是自由字符串，无法从名字
        // 反查插件 → 改为「执行期间登记当前插件」。
        //
        // ⚠️ 必须记到 **identifier 粒度**而非「插件→分区」：切卡时只搬*仍在场的*
        // 那些插件的条目。若只记分区，整格搬过去会把上一张卡独有插件的条目也带过来
        // （回归测试实测到了这个：onlyA-fmt 混进了 B 卡）。
        if (this.registeringPluginId) {
          this.sharedEntryOwner.set(identifier, {
            pluginId: this.registeringPluginId,
            partitionKey: activeSandboxPartitionKey(),
          });
        }
      } catch (e) {
        console.warn('[SillyTavernPluginRuntime] __palinkSetExtensionPrompt 失败:', e);
      }
    };

    // ── ST 生成 API 桥接：window.generateRaw / window.generate ──
    // Galgame 插件 COT 格式化（加强模式/独立开场白）在"第二次生成"时调用这两个全局
    // （ST 形状单对象签名），此前主窗口未暴露 → ReferenceError → 二次生成整体失败。
    // 统一桥接到 generationEngine：generateRaw 已做 ST 单对象双向兼容，这里再补充
    // 插件的 user_input / ordered_prompts / injects 形状（ST createRawPrompt 语义：
    // ordered_prompts 中字符串 "user_input" 占位符替换为 user_input 的值）。
    const stCtx = getStContext();
    (window as any).generateRaw = async (promptOrParams: unknown) => {
      try {
        const p = (promptOrParams && typeof promptOrParams === 'object' && !Array.isArray(promptOrParams))
          ? (promptOrParams as Record<string, any>)
          : {};
        const userInput = typeof p.user_input === 'string' ? p.user_input : '';
        if (userInput && Array.isArray(p.ordered_prompts)) {
          const messages = p.ordered_prompts
            .map((item: any) => {
              if (typeof item === 'string') {
                return { role: 'user', content: item === 'user_input' ? userInput : item };
              }
              return {
                role: (item && typeof item === 'object' && typeof item.role === 'string') ? item.role : 'user',
                content: item?.content ?? '',
              };
            })
            .filter((m: any) => typeof m.content === 'string' && m.content.length > 0);
          if (messages.length === 0) messages.push({ role: 'user', content: userInput });
          return await stCtx.generateRaw({ prompt: JSON.stringify(messages) });
        }
        return await stCtx.generateRaw(promptOrParams as any);
      } catch (e) {
        console.error('[SillyTavernPluginRuntime] generateRaw 桥接失败:', e);
        return '';
      }
    };
    (window as any).generate = async (options: unknown) => {
      try {
        const o = (options && typeof options === 'object' && !Array.isArray(options))
          ? (options as Record<string, any>)
          : {};
        const userInput = typeof o.user_input === 'string' ? o.user_input : '';
        const injects = Array.isArray(o.injects) ? o.injects : [];
        if (userInput || injects.length > 0) {
          // 插件 generate({user_input, injects, max_chat_history:0, should_silence,...}) 意图：
          // 静默生成、注入 system prompt、不携带聊天历史 → 等价于 raw 生成。
          const messages = [
            ...injects.map((item: any) => ({
              role: (item && typeof item === 'object' && typeof item.role === 'string') ? item.role : 'system',
              content: item?.content ?? '',
            })),
            ...(userInput ? [{ role: 'user', content: userInput }] : []),
          ].filter((m: any) => typeof m.content === 'string' && m.content.length > 0);
          return await stCtx.generateRaw({ prompt: JSON.stringify(messages) });
        }
        return '';
      } catch (e) {
        console.error('[SillyTavernPluginRuntime] generate 桥接失败:', e);
        return '';
      }
    };

    const setupScript = document.createElement('script');
    setupScript.setAttribute('data-palink-st-plugin-id', '__palink_runtime_setup__');
    setupScript.setAttribute('nonce', 'palink-smart-card');
    // [N8-d 修复] setupScript 是注入页面的独立 <script>（页面全局作用域），
    // 模板内无法引用本 ES 模块的导入——此前 getRequestHeaders 桩直接调用
    // getCsrfToken()，运行时 ReferenceError → 插件拿不到 X-CSRF-Token →
    // ST 端点 403 CSRF token mismatch（Galgame 插件"获取聊天列表失败"的真因）。
    // 经 window 转交模块内的真实实现，模板内一律走 window.__palinkGetCsrfToken。
    (window as any).__palinkGetCsrfToken = getCsrfToken;
    // [GAP-VIS 2026-10-04] 同理转交降级登记器。
    // 此前模板内第 1196 行**裸调** recordStubHit —— 它是本模块的 import，
    // 注入脚本（页面全局作用域）里根本不存在这个名字。结果不是"登记一次降级"，
    // 而是每次调用 window.registerSlashCommand 都抛 ReferenceError：
    // 插件以为命令注册成功，实际既没执行也没留下任何痕迹（缺口不可见）。
    // 模板内统一走 window.__palinkRecordStubHit。
    (window as any).__palinkRecordStubHit = recordStubHit;
    setupScript.textContent = `
      (function() {
        var runtime = window.__palinkStRuntime;
        if (!runtime) return;

        // A-1 修复（2026-08-23）: ST event_types 常量表（与沙箱轨同源，
        // 编译期注入，避免经典轨插件 eventTypes.MESSAGE_RECEIVED 解构 undefined）
        window.event_types = ${JSON.stringify(ST_TO_PALINK_EVENT_MAP)};

        window.SillyTavern = window.SillyTavern || {};
        window.SillyTavern.getContext = function() {
          var ctx = runtime.context || {};
          var cfg = runtime.config || {};
          var characterId = typeof ctx.characterId === 'number' ? ctx.characterId : 0;
          // Galgame 等插件通过 this_chid / characterId 识别当前角色，
          // 缺失时回退到 "default" 键，导致 localStorage 中 default=true 时误启用 overlay。
          window.this_chid = characterId;
          window.name2 = ctx.name2 || ctx.character?.name || '';
          // 暴露角色卡 extensions（含 tavern_helper 变量结构）与 stat_data，
          // 供 Tavern Helper 插件读取 schema + 变量数据生成面板。
          var charExt = (ctx.character && ctx.character.extensions) || {};
          var statData = ctx.stat_data || {};
          // ST 兼容：Galgame 等插件通过 context.characters[characterId] 反查当前角色
          // （获取 avatar/name 以调用 /api/characters/chats、/api/chats/get 等 ST 端点）。
          // Palink 的 characterId 是角色名哈希而非 ST 数组索引，故在数组副本上以字符串 key
          // 挂载当前角色，同时保持 Array.isArray 语义（不破坏按数组遍历的插件）。
          var characters = Array.isArray(ctx.characters) ? ctx.characters.slice() : [];
          if (characterId && ctx.character) {
            try {
              // 挂载角色的 avatar 需可被后端反查（palink-{uuid}.png），
              // base64 data URL 无法解析出角色 ID。
              var apiAvatar = ctx.characterUuid
                ? 'palink-' + ctx.characterUuid + '.png'
                : (ctx.character.avatar || '');
              characters[String(characterId)] = Object.assign({}, ctx.character, { avatar: apiAvatar });
            } catch (e) { /* ignore */ }
          }
          return {
            name: ctx.name || '',
            character: Object.assign({}, ctx.character || { name: '', description: '' }, { extensions: charExt }),
            chat: Array.isArray(ctx.chat) ? ctx.chat : [],
            chatId: ctx.chatId || '',
            onlineStatus: ctx.onlineStatus || 'active',
            chatMetadata: ctx.chatMetadata || {},
            characters: characters,
            groups: ctx.groups || [],
            characterId: characterId,
            name2: ctx.name2 || ctx.character?.name || '',
            extensionSettings: runtime.getExtensionSettings ? runtime.getExtensionSettings() : (cfg.extension_settings || {}),
            stat_data: statData,
            // ── A-1 修复（2026-08-23）: ST 插件惯用解构成员。此前本对象仅含
            // 数据字段，const { eventSource, getRequestHeaders } = getContext()
            // 在经典轨全为 undefined（沙箱轨已用聚合语义解决，两轨不一致）。
            // 各成员在调用时从 window 求值（上方全局均已挂载），与沙箱轨对齐。
            eventSource: window.eventSource || {},
            event_types: window.event_types || {},
            toastr: window.toastr,
            getRequestHeaders: window.getRequestHeaders,
            substituteParams: window.substituteParams,
            substitudeMacros: window.substitudeMacros,
            saveSettingsDebounced: window.saveSettingsDebounced,
            getChatMessages: window.getChatMessages,
            getLastMessageId: window.getLastMessageId,
            getCurrentChatId: window.getCurrentChatId,
            setChatMessages: window.setChatMessages,
            triggerSlash: window.triggerSlash,
            openCharacterChat: window.openCharacterChat,
            generateRaw: window.generateRaw,
            registerSlashCommand: window.registerSlashCommand,
            renderExtensionTemplateAsync: window.renderExtensionTemplateAsync,
          };
        };

        // ST 兼容：Galgame 等插件通过 window.getRequestHeaders / SillyTavern.getRequestHeaders
        // 构造请求头后调用 /api/characters/chats、/api/chats/get 等 ST 端点。
        // N8-c 终态：前端不再持有明文凭据，同源请求凭据由 HttpOnly Cookie 自动携带；
        // fetch 守卫（installGlobalFetchGuard）只负责补 Cookie credentials，不注入 Bearer，
        // 插件把请求头发给第三方或写入日志都不会泄露凭据。
        // N8-d：无条件重装——旧 bundle 留下的坏桩（内部引用未定义的 getCsrfToken）
        // 不能经 || 短路残留；本函数幂等且仅依赖 window.__palinkGetCsrfToken。
        window.getRequestHeaders = function() {
          return {
            'Content-Type': 'application/json',
            // [CSRF] N8-c 终态：动态读 palink_csrf cookie（旧静态 'palink-csrf' 在新
            // 双提交中间件下会 mismatch 403）。N8-d 修复：getCsrfToken 是宿主模块
            // 作用域导入，注入脚本内不可直接引用（ReferenceError → 插件 403），
            // 经 window.__palinkGetCsrfToken 转交。
            'X-CSRF-Token': (window.__palinkGetCsrfToken || function() { return ''; })()
          };
        };
        window.SillyTavern.getRequestHeaders = window.getRequestHeaders;
        // [N8-d 修复] 插件读取当前聊天 ID 的第一优先候选是 SillyTavern.getCurrentChatId
        // （天机时间线的 resolveCurrentChatId/getCurrentChatId 候选顺序：ST API →
        // context.chatId → …）。缺省时落到 context.chatId（裸 UUID），与时间线/
        // 存档的文件名形态不匹配。用委托函数而非直接赋值——本脚本内
        // window.getCurrentChatId 在更靠后的位置才定义，直接赋值会复制 undefined。
        window.SillyTavern.getCurrentChatId = function() {
          return typeof window.getCurrentChatId === 'function' ? window.getCurrentChatId() : '';
        };

        // ST 兼容：消息写入（COT 格式化 swipe 保存）/ slash 命令 / 跨会话切换。
        // 全部经 __palinkBridge 桥接到 Palink 原生能力；桥接层缺失时优雅降级。
        window.setChatMessages = function(messages, opts) {
          var bridge = window.__palinkBridge;
          if (!bridge || typeof bridge.saveChatMessages !== 'function') return Promise.resolve(false);
          return bridge.saveChatMessages(messages);
        };
        window.triggerSlash = function(command) {
          var bridge = window.__palinkBridge;
          if (!bridge || typeof bridge.runSlashCommand !== 'function') return Promise.resolve('');
          return bridge.runSlashCommand(command);
        };
        if (!window.openCharacterChat) {
          window.openCharacterChat = function(chatFile) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.switchChat !== 'function') return Promise.resolve(false);
            return Promise.resolve(bridge.switchChat(chatFile));
          };
        }
        if (!window.SillyTavern.openCharacterChat) {
          window.SillyTavern.openCharacterChat = window.openCharacterChat;
        }

        // ── [MVU-UNBLOCK 2026-10-04] 让第三方变量引擎（MagVarUpdate / MVU）能真正加载 ──
        //
        // 实测（真机 + 关跨域屏蔽拿到真实堆栈）确认 MVU bundle 在**模块顶层**就调用了
        // 一批 Palink 缺失的 API，任缺一个都会抛错 → 整个模块死掉 → window.Mvu 永不出现
        // → 依赖变量引擎的卡（状态栏 / 好感度 / 相册按爱意值解锁）全废。逐层剥出来的链：
        //
        //   ① _.debounce(SillyTavern.saveChat, 1e3)      → TypeError: Expected a function
        //   ② (0,i.Ou)('MVU变量框架').listenPreferenceState → ReferenceError: getScriptId
        //   ③ 版本门槛检查（要求 TavernHelper >= 3.4.17）   → ReferenceError: getTavernHelperVersion
        //   ④ 脚本按钮族（appendInexistentScriptButtons…）  → 同上
        //
        // 下面按上游语义补齐。**这是模拟，不是等价实现**，边界见各条注释。

        // ① saveChat / saveChatConditional：MVU 用它做「延迟落盘」（实卡调用 8 次）。
        //    Palink 的真实写入发生在 setChatMessages 那一刻（已接 /api/chats/save），
        //    所以这里**确实没有额外的活要干** —— 但「没有活」不等于「成功了」：
        //    2026-10-04 复核发现原实现静默 resolve()，插件以为存上了。现每次调用
        //    登记一条说明（可见，不抛错，MVU 的 debounce 链照旧走通）。
        var palinkSaveChatStub = function(apiName) {
          return function() {
            var r = window.__palinkRecordStubHit
              || (runtime && typeof runtime.recordStubHit === 'function'
                  ? runtime.recordStubHit.bind(runtime) : null);
            if (typeof r === 'function') {
              r(apiName, 'Palink 的聊天在 setChatMessages 时即落库，本调用无需再存（不是失败）');
            }
            return Promise.resolve();
          };
        };
        if (typeof window.SillyTavern.saveChat !== 'function') {
          window.SillyTavern.saveChat = palinkSaveChatStub('SillyTavern.saveChat');
        }
        if (typeof window.SillyTavern.saveChatConditional !== 'function') {
          window.SillyTavern.saveChatConditional =
            palinkSaveChatStub('SillyTavern.saveChatConditional');
        }

        // ② 脚本身份 + 同名脚本去重登记。
        //    上游每个脚本跑在独立 iframe 里，靠 frameElement.id 拿身份，再配合
        //    #tavern_helper 容器里的 div[data-script-id] 选出「同名脚本中生效的那个」。
        //    Palink 把卡脚本跑在同一个页面里，没有 per-script iframe，故用
        //    「固定 id + 容器里放一个同 id 条目」模拟 → 脚本恒为「被选中的那个」。
        //    ⚠️ 代价：同页多个脚本拿到的是同一个 id（上游是每脚本不同）。
        var PALINK_SCRIPT_ID = '__palink_card_script__';
        if (typeof window.getScriptId !== 'function') {
          window.getScriptId = function() { return PALINK_SCRIPT_ID; };
        }
        if (typeof window.getScriptName !== 'function') {
          window.getScriptName = function() { return 'Palink 卡内脚本'; };
        }
        if (typeof window.getIframeName !== 'function') {
          window.getIframeName = function() { return PALINK_SCRIPT_ID; };
        }
        if (typeof window.getScriptInfo !== 'function') {
          window.getScriptInfo = function() {
            return { id: PALINK_SCRIPT_ID, name: 'Palink 卡内脚本', content: '', enabled: true };
          };
        }
        if (typeof window.reloadIframe !== 'function') {
          window.reloadIframe = function() { return Promise.resolve(); };
        }
        (function ensureTavernHelperScriptHost() {
          try {
            if (document.getElementById('tavern_helper')) return;
            var host = document.createElement('div');
            host.id = 'tavern_helper';
            host.style.display = 'none';
            var entry = document.createElement('div');
            entry.setAttribute('data-script-id', PALINK_SCRIPT_ID);
            host.appendChild(entry);
            (document.body || document.documentElement).appendChild(host);
          } catch (e) { /* 容器建不出来只是脚本偏好判定失效，不阻断注入 */ }
        })();

        // ③ 版本号。MVU 有硬门槛：TavernHelper 必须 >= 3.4.17。
        //    这里如实声明「我们对外宣称的兼容版本」，取刚好过门槛的值 ——
        //    声明更高不会多出任何真实能力，只会让脚本更晚才失败。
        if (typeof window.getTavernHelperVersion !== 'function') {
          window.getTavernHelperVersion = function() { return '3.4.17'; };
        }
        if (typeof window.getTavernVersion !== 'function') {
          window.getTavernVersion = function() { return '1.12.0'; };
        }

        // ④ 脚本按钮族：MVU / 对话渲染系统都会注册按钮。
        //    Palink 目前没有「脚本按钮栏」UI（属独立议题），故这里只维护数据模型 +
        //    getButtonEvent 的事件名约定 —— 目的是让注册动作不再抛错、事件名可预期，
        //    按钮本身要点得到还需补 UI。
        var palinkScriptButtons = [];
        if (typeof window.getButtonEvent !== 'function') {
          window.getButtonEvent = function(name) { return 'tavern_button_' + String(name); };
        }
        if (typeof window.getScriptButtons !== 'function') {
          window.getScriptButtons = function() { return palinkScriptButtons.slice(); };
        }
        if (typeof window.replaceScriptButtons !== 'function') {
          window.replaceScriptButtons = function(buttons) {
            palinkScriptButtons = Array.isArray(buttons) ? buttons.slice() : [];
          };
        }
        if (typeof window.updateScriptButtonsWith !== 'function') {
          window.updateScriptButtonsWith = function(updater) {
            var next = typeof updater === 'function' ? updater(palinkScriptButtons.slice()) : palinkScriptButtons;
            palinkScriptButtons = Array.isArray(next) ? next : palinkScriptButtons;
            return palinkScriptButtons.slice();
          };
        }
        if (typeof window.appendInexistentScriptButtons !== 'function') {
          window.appendInexistentScriptButtons = function(buttons) {
            var list = Array.isArray(buttons) ? buttons : [];
            for (var bi = 0; bi < list.length; bi++) {
              var item = list[bi];
              var bname = item && item.name;
              if (!bname) continue;
              var exists = false;
              for (var bj = 0; bj < palinkScriptButtons.length; bj++) {
                if (palinkScriptButtons[bj] && palinkScriptButtons[bj].name === bname) { exists = true; break; }
              }
              if (!exists) palinkScriptButtons.push(item);
            }
          };
        }
        if (typeof window.eventOnButton !== 'function') {
          window.eventOnButton = function(event, callback) { return window.eventOn(event, callback); };
        }

        // ⑤ #extensions_settings2：生态扩展（MVU 设置面板等）的挂载点。
        //    缺它时 Vue 应用仍能 mount 到游离节点，但面板用户看不见。
        (function ensureExtensionsSettings2() {
          try {
            if (document.getElementById('extensions_settings2')) return;
            var el = document.createElement('div');
            el.id = 'extensions_settings2';
            el.style.display = 'none';
            (document.body || document.documentElement).appendChild(el);
          } catch (e) { /* 同上，不阻断 */ }
        })();

        // Tavern Helper 兼容桩：角色卡 schema 脚本（export const Schema = z.object({...})）
        // 通常从 CDN import registerMvuSchema 且本脚本内未直接调用；为兼容任何显式调用
        // registerMvuSchema(...) 的插件，提供捕获桩（仅存全局 + 告警），不影响面板渲染主路径
        // （Palink 前端通过正则解析 z.object 字面量读取 schema，见 utils/mvuSchemaParser.ts）。
        window.registerMvuSchema = function(schema) {
          try {
            (window.__palinkMvuSchemas = window.__palinkMvuSchemas || []).push(schema);
          } catch (e) { /* ignore */ }
        };
        window.registerVariableSchema = window.registerMvuSchema;

        window.eventSource = window.eventSource || {};
        window.eventSource.on = function(event, callback) {
          runtime.on(event, callback);
        };
        window.eventSource.off = function(event, callback) {
          runtime.off(event, callback);
        };
        window.eventSource.emit = function(event, data) {
          runtime.emit(event, data);
        };

        // N11 修复（批次 F）: 补全 eventSource 完整签名——once/makeFirst/
        // makeLast/removeAllListeners（runtime.getEventSource() 的
        // EventSourceWrapper 已实现，runtime.ts:383-430）。此前经典轨只暴露
        // on/off/emit，quick-reply 式 makeFirst(CHARACTER_MESSAGE_RENDERED,
        // ..., makeFirst) 自动执行在经典轨静默失效。
        try {
          var _palinkEventSource = runtime.getEventSource ? runtime.getEventSource() : null;
          if (_palinkEventSource) {
            window.eventSource.once = function(event, callback) {
              _palinkEventSource.once(event, callback);
            };
            window.eventSource.makeFirst = function(event, callback) {
              _palinkEventSource.makeFirst(event, callback);
            };
            window.eventSource.makeLast = function(event, callback) {
              _palinkEventSource.makeLast(event, callback);
            };
            window.eventSource.removeAllListeners = function(event) {
              _palinkEventSource.removeAllListeners(event);
            };
          }
        } catch (esErr) { /* eventSource 扩展失败不阻断注入 */ }

        // [N8-d 联动] 酒馆助手式全局事件桩：Galgame 等经典轨插件通过
        // topWindow.eventOn(topWindow.tavern_events.CHAT_CHANGED, ...) 注册
        // 聊天切换监听（沙箱轨/智能卡 iframe 轨已有同名桩，此前经典轨缺失）。
        // tavern_events 与 event_types 同为 ST_TO_PALINK_EVENT_MAP（键=ST 常量名）；
        // eventOn 落到 runtime.on（eventAliases 已做 键名↔事件值 双向归一，
        // Palink 侧 emit 'CHAT_CHANGED'/'chat_id_changed' 任一形式均可命中）。
        window.tavern_events = window.tavern_events || window.event_types || {};
        window.eventOn = window.eventOn || function(event, callback) {
          window.eventSource.on(event, callback);
        };
        window.eventOff = window.eventOff || function(event, callback) {
          window.eventSource.off(event, callback);
        };
        window.eventEmit = window.eventEmit || function(event, data) {
          window.eventSource.emit(event, data);
        };
        window.eventMakeLast = window.eventMakeLast || function(event, callback) {
          window.eventSource.on(event, callback);
        };
        window.eventMakeFirst = window.eventMakeFirst || function(event, callback) {
          window.eventSource.on(event, callback);
        };

        // 本轨（sillyTavernPluginRuntime）没有 PluginContext，接不到沙箱的 SlashCommandEngine，
        // 而 window.__palinkSlashCommands 全仓无任何读取方 —— 插件以为命令注册成功了，
        // 实际永远不会被执行。沙箱轨的 registerSlashCommand 已接真实引擎，两轨不要混用。
        // 这里登记一次降级统计，让插件管理页看得见，而不是静默失效。
        window.registerSlashCommand = function(name, callback, aliases, helpString) {
          // [GAP-VIS 2026-10-04] 原为裸调 recordStubHit → ReferenceError（该名是模块
          // import，注入脚本里不存在）。改走转交入口；无入口时退回 runtime 实例方法。
          var rec = window.__palinkRecordStubHit
            || (runtime && runtime.recordStubHit ? runtime.recordStubHit.bind(runtime) : null);
          if (typeof rec === 'function') {
            rec('registerSlashCommand', '命令未在本轨执行：sillyTavernPluginRuntime 无 SlashCommandEngine，消费入口在沙箱轨');
          }
        };

        window.toastr = {
          success: function(msg) { window.__palinkToastSuccess(String(msg)); },
          error: function(msg) { window.__palinkToastError(String(msg)); },
          info: function(msg) { window.__palinkToastInfo(String(msg)); },
          warning: function(msg) { window.__palinkToastError(String(msg)); }
        };

        window.saveSettingsDebounced = function() {
          if (runtime.saveExtensionSettings) {
            runtime.saveExtensionSettings();
          }
        };

        // ── [L1-SETTINGS 2026-10-04] 挂载设置 facade（按 SPEC 批次 1）──
        //
        // 背景：插件声明的 SillyTavern facade 有 114 个成员（权威定义见
        // st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.sillytavern.d.ts），
        // 而经典轨此前只挂了 7 个，且**没有一个是设置类**。
        // 实装卡脚本（MVU）正是靠下面这几个读写它的设置：
        //   _.get(SillyTavern.extensionSettings,'mvu_settings',{})   // 读
        //   _.set(SillyTavern.extensionSettings,'mvu_settings', v); SillyTavern.saveSettingsDebounced()
        // 缺失时 lodash 对 undefined 是静默 no-op —— 设置面板恒为默认值、改完刷新即丢，
        // 且不留任何痕迹。
        //
        // ⚠️ 关键一：extensionSettings 必须是**同一对象引用**，不能是拷贝。
        //    插件是「原地改 + 事后落盘」（_.set → saveSettingsDebounced），
        //    拷一份出去等于永远写不回去。
        // ⚠️ 关键二（2026-10-04 复核修复）：**每次注入都要重新指向，不能「已存在就跳过」**。
        //    切角色卡时 loadRuntimeConfig 会把 runtime 那份整个换成新对象；若 facade 还攥着
        //    上一张卡的旧对象，插件写进旧对象、落盘发的却是新对象 —— 写入永远进不了请求，
        //    而且 B 卡的插件会读到 A 卡的值（跨卡串味）。原守卫就是这么写的，实测复现过。
        (function() {
          var st = window.SillyTavern;
          if (!st || typeof st !== 'object') return;

          // ① 扩展设置本体：无条件指向 runtime 当前那份（同一对象引用，非拷贝）
          st.extensionSettings = (typeof runtime.getExtensionSettings === 'function'
            ? runtime.getExtensionSettings() : null) || {};
          // ①-b [L2 放行 2026-10-04] chatCompletionSettings 影子副本。
          //     实装卡脚本缺它时是直接 throw 'openAiSettingsUnavailable'
          //     （MVU 的「额外模型解析」面板整块失效，见缺口清单 A4）。
          //     这里挂的是 extensionSettings 里的**活子对象**：插件原地改完，
          //     走既有 saveSettingsDebounced 就按 (用户, 卡) 落库，不开第二条通道。
          //     上面 ① 已把 extensionSettings 重新指向当前这张卡，所以本行天然跟卡。
          //     ⚠ 后端只消费其中 openai_max_context 一项，且必过闸 3（模型真实窗口）。
          var l2Shadow = st.extensionSettings.chatCompletionSettings;
          if (!l2Shadow || typeof l2Shadow !== 'object') {
            l2Shadow = st.extensionSettings.chatCompletionSettings = {};
          }
          st.chatCompletionSettings = l2Shadow;

          // ② 落盘入口（委托，不在赋值时快照 —— window.saveSettingsDebounced 可能被后置覆盖）
          if (typeof st.saveSettingsDebounced !== 'function') {
            st.saveSettingsDebounced = function() {
              if (typeof window.saveSettingsDebounced === 'function') {
                return window.saveSettingsDebounced();
              }
            };
          }

          // ③ 聊天元数据：经典轨此前完全没有 chat_metadata。
          //    只在本轨首次创建，绝不覆盖 iframe 轨 / 兼容轨已挂上的实例。
          if (typeof window.chat_metadata !== 'object' || window.chat_metadata === null) {
            window.chat_metadata =
              (runtime.context && typeof runtime.context.chatMetadata === 'object'
                && runtime.context.chatMetadata !== null)
                ? runtime.context.chatMetadata : {};
          }
          if (typeof st.chatMetadata !== 'object' || st.chatMetadata === null) {
            st.chatMetadata = window.chat_metadata;
          }
          // 保持与 runtime.context 同源，避免两处各改一份
          if (runtime.context) { runtime.context.chatMetadata = window.chat_metadata; }

          // ④ 元数据落盘：经典轨目前没有 chatId → 后端的桥，落库属下一批。
          //    这里**不做静默 no-op** —— 显式登记一次降级，让「改了没保存」可见。
          var metaStub = function(apiName) {
            return function() {
              var rec = window.__palinkRecordStubHit
                || (runtime && typeof runtime.recordStubHit === 'function'
                    ? runtime.recordStubHit.bind(runtime) : null);
              if (typeof rec === 'function') {
                rec(apiName, '经典轨暂无 chatId→后端桥：chat_metadata 仅本次会话有效，刷新后丢失');
              }
              return Promise.resolve();
            };
          };
          if (typeof st.saveMetadata !== 'function') { st.saveMetadata = metaStub('SillyTavern.saveMetadata'); }
          if (typeof window.saveMetadataDebounced !== 'function') {
            window.saveMetadataDebounced = metaStub('saveMetadataDebounced');
          }
        })();

        // A-1 修复（2026-08-23）: ST 兼容 renderExtensionTemplateAsync。
        // 模板内容来自插件配置的 resources.templates（后端导入时已抽取）。
        // 实现为最小 Handlebars 风格插值：{{key}} HTML 转义、{{{key}}} 原样、
        // 点路径取值；块级语法（#each/#if）不在支持范围，未命中模板时 reject
        // 供插件显式降级（优于 undefined TypeError）。
        window.renderExtensionTemplateAsync = function(extensionName, templateName, data) {
          data = data || {};
          var wanted = String(templateName || extensionName || '').replace(/\\\\/g, '/');
          wanted = wanted.replace(/\\.(?:html|hbs|handlebars|mustache)$/i, '');
          var found = null;
          var plugins = (runtime.config && runtime.config.plugins) || [];
          for (var pi = 0; pi < plugins.length; pi++) {
            var tpls = (plugins[pi].resources && plugins[pi].resources.templates) || [];
            for (var ti = 0; ti < tpls.length; ti++) {
              if (!tpls[ti].content) continue;
              var p = String(tpls[ti].path || '').replace(/\\\\/g, '/');
              var normalized = p.replace(/\\.(?:html|hbs|handlebars|mustache)$/i, '');
              if (p === wanted || normalized === wanted || p === '/' + wanted || normalized.endsWith('/' + wanted)) {
                found = tpls[ti].content;
                break;
              }
            }
            if (found != null) break;
          }
          if (found == null) {
            return Promise.reject(new Error('renderExtensionTemplateAsync: template not found: ' + wanted));
          }
          var getPath = function(obj, path) {
            return String(path).split('.').reduce(function(o, k) { return o == null ? undefined : o[k]; }, obj);
          };
          var html = String(found)
            .replace(/\\{\\{\\{\\s*([\\w.]+)\\s*\\}\\}\\}/g, function(_, key) {
              var v = getPath(data, key);
              return v == null ? '' : String(v);
            })
            .replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, function(_, key) {
              var v = getPath(data, key);
              var s = v == null ? '' : String(v);
              return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            });
          return Promise.resolve(html);
        };

        // ST 兼容：宏替换。旧桩为纯 no-op（原样返回），插件依赖宏展开的逻辑
        // 静默失效；现接入 Palink 宏引擎（substituteParamsCompat），失败回退原文。
        window.substituteParams = function(text) {
          if (runtime && typeof runtime.substituteParamsCompat === 'function') {
            return runtime.substituteParamsCompat(String(text == null ? '' : text));
          }
          return String(text || '');
        };

        // ST 兼容：消息/聊天读取类 API。Galgame 插件通过 getChatMessages /
        // getLastMessageId / getCurrentChatId / substitudeMacros 读取当前聊天上下文
        // （时间线构建、COT swipe 写回、存档）。数据源为 runtime.context.chat
        // （CharacterChat 每次渲染同步的 ST 形状消息数组）。
        // 注意：插件期望 getChatMessages 返回数组（msgs[0] 为目标消息），
        // id=-1 表示最后一条（可带 role 过滤），与插件 saveFormatToSwipe 等调用一致。
        window.getChatMessages = function(id, opts) {
          var chat = Array.isArray(runtime.context.chat) ? runtime.context.chat : [];
          var includeSwipes = !!(opts && (opts.includeSwipes || opts.include_swipes));
          var role = opts && opts.role;
          var list = chat.slice();
          if (role === 'assistant') list = list.filter(function(m) { return !m.is_user; });
          var idx = Number.parseInt(String(id == null ? '' : id), 10);
          var targets = [];
          if (Number.isFinite(idx) && idx >= 0 && idx < list.length) {
            targets.push(list[idx]);
          } else if (Number.isFinite(idx) && idx === -1 && list.length > 0) {
            targets.push(list[list.length - 1]);
          } else if (!Number.isFinite(idx)) {
            targets = list;
          }
          return targets.map(function(m) {
            if (!m || typeof m !== 'object') return m;
            var out = Object.assign({}, m);
            out.message = out.message || out.mes || '';
            if (includeSwipes && !Array.isArray(out.swipes) && out.extra && Array.isArray(out.extra.swipes)) {
              out.swipes = out.extra.swipes;
            }
            if (includeSwipes && !Array.isArray(out.swipes)) out.swipes = [out.message || out.mes || ''];
            if (out.swipe_id == null && out.extra && out.extra.swipe_id != null) out.swipe_id = out.extra.swipe_id;
            if (out.swipe_id == null) out.swipe_id = 0;
            return out;
          });
        };
        window.getLastMessageId = function() {
          var chat = Array.isArray(runtime.context.chat) ? runtime.context.chat : [];
          return chat.length - 1;
        };
        window.getCurrentChatId = function() {
          var chatId = runtime.context.chatId || '';
          if (!chatId) return '';
          // [N8-d 修复] ST 语义：getCurrentChatId/chatId 返回聊天文件名。
          // Palink 的 runtime.context.chatId 是裸会话 UUID，而 /api/characters/chats
          // 的 file_name（时间线节点、存档槽的 chatId 域）是
          // "palink-session-{uuid}.jsonl"——插件内部 isSameChatId 只剥路径/扩展名、
          // 不剥 palink-session- 前缀，两种形态永不相等：读档切换实际成功但校验
          // 恒失败 → 6s 超时 → "切换聊天失败，无法读档"；时间线"当前"高亮同理失联。
          // 此处统一输出文件名形态（与 /getchatname 一致）。
          if (/^palink-session-/i.test(chatId)) return chatId;
          return 'palink-session-' + chatId + '.jsonl';
        };
        window.substitudeMacros = function(text) {
          // ST 拼写错误的 API，语义同 substituteParams：同样接入宏引擎
          if (runtime && typeof runtime.substituteParamsCompat === 'function') {
            return runtime.substituteParamsCompat(String(text == null ? '' : text));
          }
          var value = String(text == null ? '' : text);
          var chatId = runtime.context.chatId || '';
          if (chatId && value.indexOf('{{chatId}}') !== -1) {
            value = value.split('{{chatId}}').join(chatId);
          }
          return value;
        };

        window.getExtensionSettings = function(moduleName) {
          return runtime.getExtensionSettings ? runtime.getExtensionSettings(moduleName) : {};
        };

        window.setExtensionSettings = function(moduleName, settings) {
          if (runtime.setExtensionSettings) {
            runtime.setExtensionSettings(moduleName, settings);
          }
        };

        // 世界书全局 API：tavern_helper 插件（如 Galgame界面插件）会调用
        // getGlobalWorldbookNames / getWorldbookNames / rebindGlobalWorldbooks
        // 来管理世界书全局绑定。Palink 暂不实现世界书全局绑定，返回空数组/no-op，
        // 避免插件因 ReferenceError 中断初始化（导致后续 UI 渲染逻辑被跳过）。
        if (typeof window.getGlobalWorldbookNames !== 'function') {
          window.getGlobalWorldbookNames = function() {
            if (runtime && typeof runtime.recordStubHit === 'function') {
              runtime.recordStubHit('getGlobalWorldbookNames', 'Palink 暂不支持世界书全局绑定');
            }
            return [];
          };
        }
        if (typeof window.getWorldbookNames !== 'function') {
          window.getWorldbookNames = function() {
            var bridge = window.__palinkBridge;
            return bridge && typeof bridge.worldbookNames === 'function' ? bridge.worldbookNames() : [];
          };
        }
        if (typeof window.rebindGlobalWorldbooks !== 'function') {
          window.rebindGlobalWorldbooks = function() {
            if (runtime && typeof runtime.recordStubHit === 'function') {
              runtime.recordStubHit('rebindGlobalWorldbooks', 'Palink 暂不支持世界书全局绑定');
            }
            return Promise.resolve();
          };
        }

        // ── [L1-SETTINGS 2026-10-04] 只读项：getLorebookEntries / getCharLorebooks /
        //    getCurrentCharPrimaryLorebook / getPresetNames / builtin ──
        // 缺口清单 A1/A3/A4/A5/A6。全部只读或纯常量，零写库风险。
        // 口径：能取到真数据就取真数据；取不到返回**安全空值并登记降级**
        // （不做静默 no-op —— 那是上一版最贵的教训：插件以为生效、实际什么都没发生）。

        // A1：世界书条目 —— Palink 已有 getWorldbook（走 /api/worldinfo/get），直接别名。
        //     ST 语义返回条目数组，与 Palink 一致。
        if (typeof window.getLorebookEntries !== 'function') {
          window.getLorebookEntries = function(name) {
            if (typeof window.getWorldbook === 'function') {
              return window.getWorldbook(name);
            }
            return Promise.resolve([]);
          };
        }

        // A3/A4：当前角色绑定的世界书。ST 是同步 API，真数据要拉后端，
        // 故走「同步读缓存 + 命中不到就惰性拉取」：缓存不是当前角色时先触发一次
        // 异步刷新（本次仍返回上一次的结果），下次调用即为新值。
        if (typeof window.getCharLorebooks !== 'function') {
          window.getCharLorebooks = function(opts) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.charLorebooks !== 'function') {
              return { primary: null, additional: [] };
            }
            var wanted = (opts && opts.name && opts.name !== 'current')
              ? String(opts.name)
              : (runtime.context && runtime.context.characterUuid
                  ? String(runtime.context.characterUuid) : '');
            if (wanted && typeof bridge.charLorebooksFor === 'function'
                && bridge.charLorebooksFor() !== wanted
                && typeof bridge.refreshCharLorebooks === 'function') {
              void bridge.refreshCharLorebooks(wanted);
            }
            return bridge.charLorebooks();
          };
        }
        if (typeof window.getCurrentCharPrimaryLorebook !== 'function') {
          window.getCurrentCharPrimaryLorebook = function() {
            if (typeof window.getCharLorebooks !== 'function') return null;
            var books = window.getCharLorebooks();
            return (books && books.primary) ? books.primary : null;
          };
        }

        // ── [MVU-UNBLOCK 2026-10-05] 角色绑定世界书的「名字列表」与「单本内容」 ──
        // 现象（真机 console）：MVU bundle（MagVarUpdate@beta）在初始化里调
        // getCharWorldbookNames('current').primary 读角色世界书绑定，取不到就抛
        //   ReferenceError: getCharWorldbookNames is not defined
        // （2026-10-13 订正：原注释记的那条 "Cannot read properties of undefined (reading
        //  'length')" 是 API 缺失的下游连锁，并非「消费者读 .length」——真机三个 MVU bundle
        //  里没有一处对返回值读 .length，详见下方 [S1-G1] 注释。勿据此推断契约形状。）
        //
        // 为什么这里以前是空的：本文件 :2067 的 SUPPLIED 白名单只决定 TavernHelper Proxy
        // 「认不认这个键」—— :2123 的 has() 是 IS_SUPPLIED[prop] === true && !!lookup(prop)，
        // 即**列进白名单还得真有实现**才算数。白名单负责"声明认"，不负责"实现"，
        // 于是这些名字在 :2115 被 lookup 判空后掉进 :2119 的 missing(prop)（记桩降级）。
        // iframe 轨（frame-shim/legacy-st-sim.ts:1372、SillyTavernCompatRuntime.ts:5315）
        // 各自实现了，主页面轨一直漏着 —— 卡脚本跑在主页面（card-script-runner.ts），
        // 所以受害的正是这条轨。
        //
        // 数据源复用上面 A3 已有的 __palinkBridge.charLorebooks（真查
        // /api/worldbooks?character_id=…&type=character_book，非空数组假货）。
        // ⚠️ [S1-G1 2026-10-13 形状订正] 本 API **必须同步返回对象**，不是 Promise、不是 string[]。
        // 推翻 2026-10-05 此处「ST 语义是 Promise，故返回 Promise<string[]>」的写法，依据三条实测：
        //   1. ST 官方类型声明 st-plugins/third-party/JS-Slash-Runner-main/@types/function/
        //      worldbook.d.ts:32 —— declare function getCharWorldbookNames(name): CharWorldbooks；
        //      type CharWorldbooks = { primary: string | null; additional: string[] };（**无 Promise**）
        //   2. 真机 MVU bundle（backend/data/smart_card_assets/ 三份，含 573KB 那份）调用形如
        //      getCharWorldbookNames('current').primary ?? 'unknown' —— **不 await、读 .primary**；
        //      三份里 "await getCharWorldbookNames" 出现 0 次。
        //   3. 同仓 JS-Slash-Runner 自家实现 src/function/worldbook.ts:50 就是
        //      getCharWorldbookNames(name) => getCharLorebooks({ name })（同步、对象形状）。
        // ⇒ 返回 Promise 时消费者不 await，.primary 恒 undefined，MVU 的 initialized_lorebooks
        //   键会退化成 'unknown' —— 原写法正是这个症状（比"API 不存在"更隐蔽）。
        // 数据源与冷缓存策略直接复用上面 A3 的 window.getCharLorebooks：它同步返回桥缓存，
        // 且缓存角色与当前不符时**后台** refreshCharLorebooks（见 :1590-1594），语义与 ST 一致。
        if (typeof window.getCharWorldbookNames !== 'function') {
          window.getCharWorldbookNames = function(name) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.charLorebooks !== 'function'
                || typeof window.getCharLorebooks !== 'function') {
              if (runtime && typeof runtime.recordStubHit === 'function') {
                runtime.recordStubHit('getCharWorldbookNames', '角色世界书桥不可用，返回空绑定');
              }
              return { primary: null, additional: [] };
            }
            var books = window.getCharLorebooks(name == null ? {} : { name: name })
              || { primary: null, additional: [] };
            return {
              primary: books.primary == null ? null : String(books.primary),
              additional: Array.isArray(books.additional) ? books.additional.slice() : [],
            };
          };
        }
        if (typeof window.getCharWorldbook !== 'function') {
          window.getCharWorldbook = function(name) {
            if (typeof window.getWorldbook === 'function') {
              return window.getWorldbook(name);
            }
            if (runtime && typeof runtime.recordStubHit === 'function') {
              runtime.recordStubHit('getCharWorldbook', 'Palink 未提供按名取角色世界书内容');
            }
            return Promise.resolve(null);
          };
        }

        // ── [CG-ALBUM-UNBLOCK 2026-10-05] 当前角色 id（ST 全局，卡脚本在用）──
        // 卡内相册脚本 isChatActive() 第一步就取它，取不到 / 为空字符串就直接
        // return false，后面的 scanLatestMessageForCg() 一次都不跑 —— 相册于是
        // 永远停在卡自带开场白给的那 1 条（用户看到的「1/205」）。
        // 真机实测主页面此前 typeof window.getCurrentCharacterId === 'undefined'。
        //
        // 注意**不要**改用 messageManager.getCurrentCharacterId()：它全仓零调用方、
        // 恒返回空串（见 CharacterChat.tsx:1579 注释，已核实），接上去只会把
        // 「undefined」换成「空字符串」，相册照样不解锁。唯一真源是 runtime.context。
        if (typeof window.getCurrentCharacterId !== 'function') {
          window.getCurrentCharacterId = function() {
            var ctx = runtime && runtime.context;
            var id = ctx && ctx.characterUuid;
            return id == null || id === '' ? null : String(id);
          };
        }

        // ── [VAR-ALIAS 2026-10-05] getAllVariables / getChatVariables 别名 ──
        // iframe 轨有（legacy-st-sim.ts:1216/1218、SillyTavernCompatRuntime.ts:17），
        // 主页面轨与沙箱轨都没有 —— 卡脚本跑在主页面，于是这两族调用直接 undefined。
        // 酒馆助手语义里 getAllVariables = 全部作用域合并（global+chat+local），
        // getChatVariables = 仅会话级。Palink 的会话变量只有一档（stat_data），
        // 故两者同源，都指向下面这个 getVariables；返回副本，避免脚本改到我们的对象。
        // 真机审计：SUPPLIED 白名单 68 项里有 9 项「列了但主页面没实现」，这两项是其中
        // 真会被卡脚本调到的（其余 7 项在 ST 侧亦无同名导出，属白名单虚列，另记）。
        if (typeof window.getAllVariables !== 'function') {
          window.getAllVariables = function() {
            return typeof window.getVariables === 'function'
              ? JSON.parse(JSON.stringify(window.getVariables() || {}))
              : {};
          };
        }
        if (typeof window.getChatVariables !== 'function') {
          window.getChatVariables = function() {
            return typeof window.getVariables === 'function'
              ? JSON.parse(JSON.stringify(window.getVariables() || {}))
              : {};
          };
        }

        // A5：预设名列表（Palink /api/roleplay/presets，注入时已预取）
        if (typeof window.getPresetNames !== 'function') {
          window.getPresetNames = function() {
            var bridge = window.__palinkBridge;
            return bridge && typeof bridge.presetNames === 'function' ? bridge.presetNames() : [];
          };
        }

        // A4（实卡调用 5 次）：getPreset 取预设**对象**。与 getPresetNames 同一次预取，
        // 不额外发请求。⚠ 语义差异要如实：ST 的预设=采样参数集，Palink 的预设=生成参数
        // 模板 —— 这里下发的是 Palink 形状，字段名不伪装成 ST。插件若按 ST 形状读
        // 具体键，取到 undefined 属预期（不是本层能抹平的模型差异）。
        if (typeof window.getPreset !== 'function') {
          window.getPreset = function(name) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.presetByName !== 'function') return null;
            return bridge.presetByName(name) || null;
          };
        }

        // A6：builtin —— ST 内置工具集。
        //     实测卡脚本只用 builtin.saveSettings（其余 5 处 builtin 字样是 i18n 文本
        //     「使用内置破限」，不是 API 调用）。故按真实需要提供：
        //     saveSettings 真落盘；uuidv4 真实现；其余成员取用时登记降级（不静默）。
        if (typeof window.builtin !== 'object' || window.builtin === null) {
          var builtinRec = function(name) {
            var rec = window.__palinkRecordStubHit
              || (runtime && typeof runtime.recordStubHit === 'function'
                  ? runtime.recordStubHit.bind(runtime) : null);
            if (typeof rec === 'function') {
              rec('builtin.' + name, 'ST 内置工具，Palink 无对应实现');
            }
          };
          window.builtin = new Proxy({}, {
            get: function(_t, prop) {
              if (typeof prop !== 'string') return undefined;
              if (prop === 'then' || prop === 'constructor') return undefined;
              if (prop === 'saveSettings') {
                return function() {
                  if (typeof window.saveSettingsDebounced === 'function') {
                    window.saveSettingsDebounced();
                  }
                  return Promise.resolve();
                };
              }
              if (prop === 'uuidv4') {
                return function() {
                  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                    return window.crypto.randomUUID();
                  }
                  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    var r = Math.random() * 16 | 0;
                    var v = c === 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                  });
                };
              }
              // 其余成员：返回一个记桩函数（调用时登记），保持 typeof === 'function'，
              // 这样插件的 typeof 守卫不会把它当成缺失而跳过整段逻辑。
              return function() { builtinRec(prop); return undefined; };
            }
          });
        }

        // 世界书创建/替换 API：Galgame 插件 injectCOTToWorldbook 维护一张格式规范世界书。
        // 桥接到 Palink /api/worldinfo/get|edit；ST 语义 getWorldbook 返回条目数组。
        if (typeof window.getWorldbook !== 'function') {
          window.getWorldbook = async function(name) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.worldbookGetEntries !== 'function') return [];
            return bridge.worldbookGetEntries(name);
          };
        }
        if (typeof window.createOrReplaceWorldbook !== 'function') {
          window.createOrReplaceWorldbook = async function(name, entries) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.worldbookSaveEntries !== 'function') return Promise.resolve(false);
            return bridge.worldbookSaveEntries(name, entries);
          };
        }
        if (typeof window.createOrReplaceCharWorldbook !== 'function') {
          window.createOrReplaceCharWorldbook = window.createOrReplaceWorldbook;
        }
        if (typeof window.createWorldbookEntries !== 'function') {
          window.createWorldbookEntries = async function(name, entries) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.worldbookGetEntries !== 'function' || typeof bridge.worldbookSaveEntries !== 'function') return Promise.resolve(false);
            var existing = await bridge.worldbookGetEntries(name);
            var merged = (Array.isArray(existing) ? existing : []).concat(Array.isArray(entries) ? entries : []);
            return bridge.worldbookSaveEntries(name, merged);
          };
        }
        if (typeof window.updateWorldbookWith !== 'function') {
          window.updateWorldbookWith = async function(name, updater) {
            var bridge = window.__palinkBridge;
            if (!bridge || typeof bridge.worldbookGetEntries !== 'function' || typeof bridge.worldbookSaveEntries !== 'function') return Promise.resolve(false);
            var existing = await bridge.worldbookGetEntries(name);
            var next = typeof updater === 'function' ? updater(existing) : existing;
            return bridge.worldbookSaveEntries(name, Array.isArray(next) ? next : []);
          };
        }

        // 注：SillyTavern.getRequestHeaders 已在上方与 window.getRequestHeaders
        // 统一为同一实现（携带 Bearer token 的真实请求头）。此处不再提供
        // 返回空对象的兜底桩——那会在语句顺序变动时静默破坏插件认证。

        // [A-6] window.setExtensionPrompt 全局真实现（对齐沙箱轨 prompt-injection.ts）：
        // 入参校验 + 转发到 __palinkSetExtensionPrompt 桥（TS 侧注册到 prompt-injection
        // 服务）。BubbleDialogue 等卡内脚本引用全局 setExtensionPrompt(...) 此前
        // ReferenceError，现在七参签名与 ST script.js 完全一致，注册项供装配期消费。
        if (typeof window.setExtensionPrompt !== 'function') {
          window.setExtensionPrompt = function(identifier, content, position, depth, scan, role, filter) {
            if (typeof identifier !== 'string' || !identifier) {
              if (typeof console !== 'undefined') {
                console.warn('[Palink setExtensionPrompt] 无效 identifier:', identifier);
              }
              return;
            }
            if (typeof content !== 'string') {
              if (typeof console !== 'undefined') {
                console.warn('[Palink setExtensionPrompt] content 必须是字符串 (identifier=' + identifier + ')');
              }
              return;
            }
            if (typeof window.__palinkSetExtensionPrompt === 'function') {
              window.__palinkSetExtensionPrompt(identifier, content, position, depth, scan, role, filter);
            }
          };
        }

        // injectPrompts 兜底：BubbleDialogue 插件会尝试用该 API 注入格式规则。
        // [ST-ALIGN P0-4] injectPrompts 真实现（JS-Slash-Runner / BubbleDialogue 约定，
        // 签名见 st-plugins/third-party/JS-Slash-Runner-main/@types/function/inject.d.ts）。
        // 此前是返回 null 的降级桩 —— BubbleDialogue 的格式规则、JS-Slash-Runner 的
        // 注入全部静默失效。改为遍历转发到 window.setExtensionPrompt 真实现（已注册到
        // prompt-injection 服务，装配期消费）。
        if (typeof window.injectPrompts !== 'function') {
          window.injectPrompts = function(prompts, _options) {
            var list = Array.isArray(prompts) ? prompts : [];
            var injectedIds = [];
            for (var i = 0; i < list.length; i++) {
              var p = list[i];
              if (!p || typeof p !== 'object') continue;
              var id = String(p.id ?? '');
              if (!id || typeof p.content !== 'string') continue;
              // position: 'in_chat' → IN_CHAT(1)；'none' → NONE(-1，不发给 AI 但参与世界书扫描)
              var pos = p.position === 'none' ? -1 : 1;
              // role: ST extension_prompt_roles 0=system / 1=user / 2=assistant
              var role = p.role === 'assistant' ? 2 : (p.role === 'user' ? 1 : 0);
              try {
                window.setExtensionPrompt(
                  id,
                  p.content,
                  pos,
                  typeof p.depth === 'number' ? p.depth : 4,
                  p.should_scan !== false,
                  role,
                  typeof p.filter === 'function' ? p.filter : undefined,
                );
                injectedIds.push(id);
              } catch (e) {
                console.warn('[SillyTavernPluginRuntime] injectPrompts 单项失败:', id, e);
              }
            }
            return {
              uninject: function() {
                try { window.uninjectPrompts(injectedIds); } catch (e) { /* no-op */ }
              },
            };
          };
        }
        if (typeof window.uninjectPrompts !== 'function') {
          window.uninjectPrompts = function(ids) {
            var list = Array.isArray(ids) ? ids : [];
            for (var i = 0; i < list.length; i++) {
              try { promptInjection.removeExtensionPrompt(String(list[i])); }
              catch (e) { /* no-op */ }
            }
          };
        }

        // [ST-ALIGN] window.getThumbnailUrl 真实现：后端**已有** /api/st/thumbnail
        // （silly_tavern.py:1853，同时注册 /thumbnail），签名 type+file 与 ST 完全一致。
        // 此前主 window 无此函数 → 沙箱轨桥接找不到实现，插件头像/背景渲染出裂图。
        // type != 'avatar'（如 'bg'）时后端返回 svg 占位图，已属优雅降级。
        if (typeof window.getThumbnailUrl !== 'function') {
          window.getThumbnailUrl = function(type, id) {
            if (!type || (!id && id !== 0)) return '';
            return '/api/st/thumbnail?type=' + encodeURIComponent(type) + '&file=' + encodeURIComponent(id);
          };
        }

        // [ST-ALIGN] window.getCharacters：返回角色数组副本（ST 高频 API，插件遍历
        // 角色列表）。数据源与 Ctx 轨 getContext().characters 同源；返回深拷贝防止
        // 插件直接改写内部状态。此前该 API 完全缺失。
        if (typeof window.getCharacters !== 'function') {
          window.getCharacters = function() {
            try {
              var st = getStContext();
              var list = st && Array.isArray(st.characters) ? st.characters : [];
              return JSON.parse(JSON.stringify(list));
            } catch (e) {
              return [];
            }
          };
        }

        // [ST-ALIGN] window.getCharAvatarPath(id)：返回角色头像标识。ST 语义为头像
        // 文件名；Palink 为 "palink-{uuid}.png"（可直传 getThumbnailUrl('avatar', …)）。
        // id 兼容数字索引 / 角色名 / avatar 串 / UUID。此前恒 null → 头像类插件失明。
        if (typeof window.getCharAvatarPath !== 'function') {
          window.getCharAvatarPath = function(id) {
            try {
              var st = getStContext();
              var list = st && Array.isArray(st.characters) ? st.characters : [];
              var found = null;
              if (typeof id === 'number') found = list[id] || null;
              if (!found && typeof id === 'string') {
                for (var i = 0; i < list.length; i++) {
                  var c = list[i] || {};
                  if (c.name === id || c.avatar === id || String(c.id ?? '') === id || String(c.uuid ?? '') === id) { found = c; break; }
                }
              }
              return found ? String(found.avatar || '') : '';
            } catch (e) {
              return '';
            }
          };
        }

        // [ST-ALIGN] window.deleteChatMessages(ids)：删除当前聊天的指定消息。
        // ST 的 ids 是 chat 数组索引；映射为 Palink 消息 id 后逐个调
        // DELETE /api/character-sessions/{chatId}/messages/{id}（走 api client，
        // 自动注入 Bearer/CSRF），并 emit message_deleted。
        // ⚠ 局限：UI 刷新依赖宿主监听 message_deleted，当前主 UI 未监听 → 删除后
        // 需手动刷新聊天。比此前恒 false 的桩前进了一步，完整闭环需视图层接入。
        if (typeof window.deleteChatMessages !== 'function') {
          window.deleteChatMessages = async function(ids) {
            try {
              var st = getStContext();
              var chat = st && Array.isArray(st.chat) ? st.chat : [];
              var chatId = st && st.chatId;
              if (!chatId) return false;
              var list = Array.isArray(ids) ? ids : [];
              var okAll = true;
              for (var i = 0; i < list.length; i++) {
                var idx = Number(list[i]);
                var msg = (!isNaN(idx)) ? chat[idx] : null;
                var mid = msg ? (msg.id ?? msg.message_id ?? msg.uid) : list[i];
                if (mid === undefined || mid === null || mid === '') { okAll = false; continue; }
                try {
                  await api.delete('/api/character-sessions/' + chatId + '/messages/' + mid);
                  if (typeof window.eventSource !== 'undefined' && window.eventSource && window.eventSource.emit) {
                    window.eventSource.emit('message_deleted', idx);
                  }
                } catch (e) {
                  okAll = false;
                }
              }
              return okAll;
            } catch (e) {
              return false;
            }
          };
        }

        // ST 桥接虚拟元素：Galgame 等插件通过 #send_textarea / #send_but /
        // #option_regenerate / SillyTavern.Generate 驱动聊天发送与重生成。
        // Palink 原生聊天 UI 无这些元素，故创建隐藏元素挂在 document.body
        // （React 树外，不被重渲染销毁），点击时桥接到 window 钩子。
        (function ensureStBridge() {
          function makeHidden(id, tag) {
            var el = document.getElementById(id);
            if (el) return el;
            el = document.createElement(tag);
            el.id = id;
            el.style.display = 'none';
            document.body.appendChild(el);
            return el;
          }

          var sendTextarea = makeHidden('send_textarea', 'textarea');
          var sendButton = makeHidden('send_but', 'button');
          sendButton.type = 'button';
          if (!sendButton.__palinkBridgeBound) {
            sendButton.addEventListener('click', function() {
              var text = String(sendTextarea.value || '').trim();
              sendTextarea.value = '';
              if (text && typeof window.__palinkSendText === 'function') {
                window.__palinkSendText(text);
              }
            });
            sendButton.__palinkBridgeBound = true;
          }

          var regenButton = makeHidden('option_regenerate', 'button');
          regenButton.type = 'button';
          if (!regenButton.__palinkBridgeBound) {
            regenButton.addEventListener('click', function() {
              if (typeof window.__palinkRegenerate === 'function') {
                window.__palinkRegenerate();
              }
            });
            regenButton.__palinkBridgeBound = true;
          }

          if (typeof window.SillyTavern !== 'object') window.SillyTavern = {};
          if (typeof window.SillyTavern.Generate !== 'function') {
            window.SillyTavern.Generate = function() {
              if (typeof window.__palinkRegenerate === 'function') {
                window.__palinkRegenerate();
              }
            };
          }
          // [IMAGE-PROXY] 生态脚本运行时注入的 <img>（头像/图库 src 指向
          // jsDelivr 主域，大陆网络被阻断）加载失败时改走后端图片代理
          // （服务端 jsDelivr 镜像回退 + 落盘缓存）。捕获阶段：img 的
          // error 事件不冒泡，必须 capture 才接得住。
          window.addEventListener('error', function(e) {
            var t = e.target;
            if (t && t.tagName === 'IMG' && !t.getAttribute('data-palink-proxy')) {
              var src = String(t.getAttribute('src') || '');
              // 注意：本段是模板字符串里再输出给浏览器的脚本，写正则字面量会因反斜杠
              // 被模板字符串吞掉而生成非法 JS（2026-09-30 实测整批插件注入中断）。
              // 故此处刻意用字符串切片判定，等价于 /^https:\\/\\/[a-z0-9.-]*jsdelivr\\.net\\/(.+)$/i。
              if (src.slice(0, 8) === 'https://') {
                var rest = src.slice(8);
                var slash = rest.indexOf('/');
                if (slash > 0 && rest.length > slash + 1
                    && rest.slice(0, slash).toLowerCase().slice(-12) === 'jsdelivr.net') {
                  t.setAttribute('data-palink-proxy', '1');
                  t.src = '/api/image-proxy?url=' + encodeURIComponent(src);
                }
              }
            }
          }, true);
        })();

        // ── [GAP-VIS 2026-10-04] 经典轨 TavernHelper 命名空间 + 缺口可见化 ──
        //
        // 问题（上位报告 §5.3①）：经典轨**没有** window.TavernHelper 命名空间。
        // 卡脚本写 TavernHelper.xxx / topWindow.TavernHelper.xxx 一律 undefined，
        // 且因为没有 Proxy 兜底（对比 iframe 轨 SillyTavernCompatRuntime.ts:5441），
        // 这些调用**不进 __palinkCompatStats** —— 用户和开发者都看不见缺口在哪。
        //
        // 做法：给 TavernHelper 加一层 Proxy。
        //   · 经典轨真正实现了的 API → 直接转发到同名 window 全局（行为与裸全局一致）
        //   · 没实现的           → 返回记桩函数：调用后登记进 __palinkCompatStats，
        //                          返回 undefined（不抛错，插件守卫不会崩，但缺口可见）
        //
        // 边界（刻意不做宽）：
        //   · 只代理 TavernHelper 命名空间，**不**给 window 套 Proxy —— 后者会让
        //     任意未定义全局变成"假函数"，插件的能力探测全面失真。
        //   · has trap 只对真能取到的名字返回 true，插件用 in 探测能力时不骗它。
        //   · Symbol / then / constructor 一律放行 undefined，避免污染 await、
        //     JSON.stringify、devtools 展开等行为。
        (function() {
          if (window.TavernHelper && typeof window.TavernHelper === 'object') {
            return;                       // iframe 轨 / 沙箱轨先装过则不覆盖
          }
          var rec = window.__palinkRecordStubHit ||
            (window.__palinkStRuntime && typeof window.__palinkStRuntime.recordStubHit === 'function'
              ? window.__palinkStRuntime.recordStubHit.bind(window.__palinkStRuntime) : null);

          // 经典轨已注入的 ST 兼容全局（TavernHelper 的实际供给面）。
          // 运行时才判定是否存在 —— 列表里有但本轮没挂上的会被 lookup 过滤掉，
          // 不会因为名单写多就凭空造出"假实现"。
          var SUPPLIED = [
            'getChatMessages', 'setChatMessages', 'deleteChatMessages', 'getLastMessageId',
            'getCurrentChatId', 'getCurrentMessageId', 'getCharacters', 'getCharacter',
            'getCharAvatarPath', 'getThumbnailUrl', 'getRequestHeaders',
            'getWorldbook', 'getWorldbookNames', 'getGlobalWorldbookNames', 'getCharWorldbookNames',
            'createWorldbookEntries', 'createOrReplaceWorldbook', 'createOrReplaceCharWorldbook',
            'updateWorldbookWith', 'rebindGlobalWorldbooks',
            'getLorebookEntries', 'getCharLorebooks', 'getCurrentCharPrimaryLorebook',
            'openCharacterChat', 'injectPrompts', 'uninjectPrompts',
            'setExtensionPrompt', 'setExtensionSettings', 'getExtensionSettings',
            'registerSlashCommand', 'registerMvuSchema', 'registerVariableSchema',
            'renderExtensionTemplateAsync', 'saveSettingsDebounced', 'saveMetadataDebounced',
            'substitudeMacros', 'substituteParams', 'triggerSlash', 'generate', 'generateRaw',
            'getScriptId', 'getScriptName', 'getScriptInfo', 'replaceScriptInfo',
            'getScriptButtons', 'replaceScriptButtons', 'appendInexistentScriptButtons',
            'updateScriptButtonsWith', 'reloadIframe', 'getIframeName', 'getButtonEvent',
            'getTavernHelperVersion', 'getTavernVersion', 'getPresetNames', 'getPreset',
            'eventOn', 'eventOff', 'eventOnce', 'eventEmit', 'eventEmitAndWait',
            'eventMakeFirst', 'eventMakeLast', 'eventRemoveListener', 'eventOnButton',
            'eventClearEvent', 'eventClearListener', 'eventClearAll', 'builtin'
          ];
          var IS_SUPPLIED = {};
          for (var si = 0; si < SUPPLIED.length; si++) { IS_SUPPLIED[SUPPLIED[si]] = true; }

          function lookup(name) {
            var fn = window[name];
            return typeof fn === 'function' ? fn : null;
          }
          // 记桩函数按名字缓存：同一名字反复取必须拿到同一个引用，
          // 否则插件做函数比较/去重会拿到不一致的结果。
          var stubs = {};
          function missing(name) {
            if (!stubs[name]) {
              stubs[name] = function() {
                if (typeof rec === 'function') {
                  rec('TavernHelper.' + name,
                      '经典轨未实现该 API：调用已登记，插件相关功能不生效（不抛错）');
                }
                return undefined;
              };
            }
            return stubs[name];
          }

          window.TavernHelper = new Proxy({}, {
            get: function(_t, prop) {
              if (typeof prop !== 'string') return undefined;
              if (prop === 'then' || prop === 'constructor' || prop === '__esModule') return undefined;
              if (IS_SUPPLIED[prop]) {
                var real = lookup(prop);
                if (real) return real;
              }
              return missing(prop);
            },
            has: function(_t, prop) {
              if (typeof prop !== 'string') return false;
              return IS_SUPPLIED[prop] === true && !!lookup(prop);
            }
          });
        })();
      })();
    `;
    // [PLUGIN-ON-DEMAND L1] setup 脚本幂等：差集模式下容器里已有一份就不重复 append
    // （重复注入会重复注册 setExtensionPrompt 等全局桥，属 harmless 但无意义）。
    const existingSetup = Array.from(
      container.querySelectorAll('script[data-palink-st-plugin-id]'),
    ).filter((el) => el.getAttribute('data-palink-st-plugin-id') === SETUP_PLUGIN_ID);
    if (existingSetup.length === 0) {
      // setup 脚本一旦解析失败会同步从 appendChild 抛出，整批插件注入随之中断
      // （ST 全局没挂上、卡片扩展一个都不注入）。此处兜住并显式报红，
      // 让「单个 setup 脚本坏了」退化成可观测故障而不是全屏空白。
      try {
        container.appendChild(setupScript);
      } catch (e) {
        console.error('[SillyTavernPluginRuntime] setup 脚本注入失败，插件全局桥未建立:', e);
      }
    }

    if (!this.config) return;

    // [CARD-EXT-SCOPE-GUARD] 卡内扩展来源（character_card_extension）的插件禁止全局执行。
    // ST 生态语义：这类脚本（如 BubbleDialogue「对话渲染系统」）随角色卡分发，只在对应卡的
    // 酒馆助手 iframe 里运行；其注入的格式规则与渲染正则同卡配套。若提升为全局执行，
    // 会出现"注入常驻、渲染缺失"的分裂态——模型对任何卡都输出 @bubble 等标记却无人渲染，
    // 原始标记直接漏进正文（2026-08-21 实测泄漏源：plugins 表「酒馆助手」插件）。
    // [GUARD-TH-EXEMPT]（2026-08-28 用户拍板，与后端 plugins.py 同名豁免配对）：
    // tavern_helper 型插件豁免本守卫——8-23 双侧守卫上线后「酒馆助手」（数据库界面
    // 面板脚本）被整体拦停，正文下方角色面板消失。泄漏面由脚本级
    // plugin_scripts.enabled 开关收口（用户可单独停用 BubbleDialogue 类脚本）。
    const extensions = this.config.plugins.filter(
      (p) => (p.plugin_type === 'sillytavern_extension' || p.plugin_type === 'tavern_helper')
        && (p.source_type !== 'character_card_extension' || p.plugin_type === 'tavern_helper')
    );

    // [PLUGIN-ON-DEMAND L1] 差集卸载：先把"这次不再需要"的插件摘掉，再补新的。
    // 顺序很重要 —— 先卸后装，避免同一插件 id 短暂出现两份节点。
    if (canDiff) {
      const { toUnload } = computePluginDiff(this.injectedPluginIds, extensions.map((p) => p.id));
      for (const pluginId of toUnload) {
        this.unloadPlugin(pluginId);
      }
    }

    for (const plugin of extensions) {
      // 差集模式下共用插件一律跳过：它们的 script/style 节点保持原样，
      // 节点身份不变 → 已绑事件、面板 DOM、插件内部状态都不丢（用户侧表现为无闪烁）。
      if (canDiff && this.injectedPluginIds.has(plugin.id)) continue;
      const resources = plugin.resources || {};
      const cssList = resources.css || [];
      for (const cssItem of cssList) {
        if (!cssItem.content || cssItem.missing) continue;
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-palink-st-plugin-id', plugin.id);
        // S-1: CSS 消毒（与 plugin-system 沙箱 injectPluginCSS 同策略，
        // 移除 @import/javascript:url/expression 等危险构造）
        styleEl.textContent = sanitizePluginCss(cssItem.content);
        container.appendChild(styleEl);
        this.injectedPluginIds.add(plugin.id);
      }
    }

    for (const plugin of extensions) {
      if (!legacyScriptExecution) continue;
      if (canDiff && this.injectedPluginIds.has(plugin.id)) continue;
      const resources = plugin.resources || {};
      const jsList = resources.js || [];
      for (const jsItem of jsList) {
        if (!jsItem.content || jsItem.missing || jsItem.execute === false) continue;
        // Palink 原生 ESM 插件（含 import/export）由 plugin-system 沙箱负责执行并转译
        // （ESM → CommonJS），本兼容运行时只能注入经典脚本；若把 ESM 直接塞进 <script>
        // 会触发 "Cannot use import statement outside a module"。跳过之：既避免整页崩溃，
        // 功能也不丢（plugin-system 已在加载它）。经典脚本型 ST 扩展（如深插件）不受影响。
        if (this.isEsmModule(jsItem.content)) {
          console.warn(
            `[SillyTavernPluginRuntime] 跳过 ESM 插件 ${plugin.name || plugin.id}（由 plugin-system 沙箱加载）`,
          );
          continue;
        }
        const scriptEl = document.createElement('script');
        scriptEl.type = 'text/javascript';
        scriptEl.setAttribute('data-palink-st-plugin-id', plugin.id);
        scriptEl.setAttribute('nonce', 'palink-smart-card');
        scriptEl.textContent = jsItem.content;
        // [B4-SHARED-PARTITION] 标出「正在执行哪个插件」，让 bridge 能把
        // setExtensionPrompt 的注册记到该插件名下（identifier 反查不出插件）。
        // appendChild 同步执行脚本 → 返回时注册已完成，故 try/finally 立即复原。
        const prevRegistering = this.registeringPluginId;
        this.registeringPluginId = plugin.id;
        try {
          container.appendChild(scriptEl);
          this.injectedPluginIds.add(plugin.id);
        } catch (e) {
          console.error(
            `[SillyTavernPluginRuntime] 注入插件脚本失败 (${plugin.name || plugin.id}):`,
            e,
          );
        } finally {
          this.registeringPluginId = prevRegistering;
        }
      }
    }

    // [B4-SHARED-PARTITION] 差集模式收尾：把本次「继续在场」的共用插件注册项
    // 搬到当前活动角色分区。**这是共用插件注入丢失的唯一修复点**，
    // 见 rebindRetainedEntries 的注释。
    if (canDiff) {
      this.rebindRetainedEntries();
    }

    this.emit('EXTENSIONS_LOADED');
  }

  /**
   * [B4-SHARED-PARTITION 2026-10-03] diffOnly 收尾：把共用插件的注册项搬到新卡分区。
   *
   * 机制：``sharedPartitionOwner`` 记着「每个插件的 setExtensionPrompt 注册写在哪个
   * 沙箱分区」。差集注入时共用插件整个被跳过（``injectedPluginIds.has(id)`` →
   * continue），script 节点不重建 → 浏览器不重跑脚本 → 注册不重跑；而切卡时
   * ``clearCharacterSandbox(旧卡)`` 已把旧卡那一格删掉 → 新卡拿不到条目。
   * 这里在差集收尾处把仍在场的插件条目**搬**到当前活动分区。
   *
   * 为什么搬而不是重跑（不闪烁、不重复注入的依据）：
   *  - **不重跑** → script/style 节点不重建 → 已绑事件、面板 DOM、插件内部状态
   *    全都保持原样，用户侧零闪烁；也不会重复注册监听器/定时器（重跑会）。
   *  - **搬运是纯账本操作**：只往 ``_sources`` 里写一行，不碰 DOM。
   *  - **同名覆盖语义与脚本重跑一致**：``rebindSandboxEntries`` 后写覆盖，
   *    等价于「这个插件又登记了一遍同样的内容」，与重跑所得完全同构。
   *  - **不会重复注入**：同一分区同 identifier 只有一条（后写覆盖先写），
   *    所以反复搬运也不会堆出多份。
   *
   * 前置条件：活动角色必须**已经**切到新卡（``setActivePromptCharacter`` 先于
   * ``injectIntoContainer``）—— CharacterChat 的切卡 effect 顺序保证了这点。
   */
  private rebindRetainedEntries(): void {
    const plugins = this.config?.plugins;
    if (!Array.isArray(plugins)) return;
    const activeKey = activeSandboxPartitionKey();
    const activeCharId = activeKey.startsWith('sandbox:') ? activeKey.slice('sandbox:'.length) : '';
    for (const [identifier, owner] of this.sharedEntryOwner) {
      if (owner.partitionKey === activeKey) continue;  // 已在当前分区
      // 只搬**本次仍在场**的插件：已卸载的不搬，避免把上一张卡独有插件的
      // 条目带进新卡（那正是跨卡串味的形态）。
      if (!this.injectedPluginIds.has(owner.pluginId)) continue;
      const ownerCharId = owner.partitionKey.startsWith('sandbox:')
        ? owner.partitionKey.slice('sandbox:'.length)
        : '';
      // 优先读 detachSandbox 留下的快照：切卡清理在插件注入**之前**就删掉了旧
      // 分区，等这里再实时读必然是空 —— 那正是条目丢失的原因。
      const detached = promptInjection.peekDetachedSandbox(ownerCharId);
      const src = Object.keys(detached).length > 0
        ? detached
        : promptInjection.snapshotSandbox(ownerCharId);
      const entry = src[identifier];
      if (!entry) continue;
      promptInjection.rebindSandboxEntries(activeCharId, { [identifier]: entry });
      // 归属更新到新分区，避免下次切卡又从已删除的旧分区取
      this.sharedEntryOwner.set(identifier, { pluginId: owner.pluginId, partitionKey: activeKey });
    }
  }

  /**
   * 清理 Galgame 插件残留状态：localStorage 持久化状态 + 运行时全局标志。
   * 在 injectIntoContainer 开头和 unloadAll 中都调用，确保每次注入前状态干净。
   */
  private cleanupGalgameState() {
    // [2026-10-03 收敛] 这里**只清历史脏键 `default`**，不再整键删除。
    //
    // 原实现（无条件 removeItem）是「角色身份识别失败」的**症状级 workaround**：
    // 当时插件在主页面 / iframe 两侧都会把当前角色解析成 "default"，于是出现
    // 「在 A 卡启用 → 所有卡都启用、切卡也不关」。删掉整键确实压住了这个现象，
    // 但副作用是**用户永远无法保留启用状态** —— 每次进对话页都被清空，
    // 表现为「Galgame 面板/按钮永远不出现」（2026-10-03 真机复现确认）。
    //
    // 根因已在同批次修好：`legacy-st-sim.ts` 的 `[PARENT-ALIAS]` 白名单补上了
    // ST 生态全局（SillyTavern / Mvu / TavernHelper / z / …），iframe 侧不再回退
    // "default"；主页面侧一直是正确的 `<卡名>::slot::<id>`。
    // 身份按角色区分之后，「跨卡串味」的成因已不存在。
    //
    // 因此改成**定向清脏**：只删 `default` 这一条（身份识别失败的产物），
    // 保留按角色的正常条目。这样即使将来身份解析再回归，"default" 也会被本次清掉，
    // 不会重新变成「所有卡一起启用」—— 原有防护意图保留，误伤去掉。
    try {
      const raw = localStorage.getItem('galgame-ui-plugin_char_enabled');
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const map = parsed as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(map, 'default')) {
            delete map.default;
            localStorage.setItem('galgame-ui-plugin_char_enabled', JSON.stringify(map));
          }
        }
      }
    } catch {
      // 解析失败说明这份数据本来就不可用（脏写 / 半截 JSON）—— 退回整键删除
      try { localStorage.removeItem('galgame-ui-plugin_char_enabled'); } catch {}
    }
    // 清理插件运行时全局标志，确保下次注入时初始化流程重新执行
    const galFlags = [
      '__galgame_init_lock__',
      'galgame-ui-plugin_styles_injected',
      '__galgame_message_observer_bound__',
      '__galgame_event_delegation_bound__',
      '__galgame_keyboard_shortcuts_bound__',
      '__galgame_options_observer_bound__',
      '__galgame_fullscreen_listener_bound__',
      '__galgame_overlay_resize_listener_bound__',
      '__galgame_char_polling_bound__',
    ];
    for (const flag of galFlags) {
      try { delete (window as any)[flag]; } catch {}
    }
  }

  /**
   * 清理插件挂在容器之外的 DOM 残留 + Galgame 运行时状态。
   *
   * 这些方法**没有归属信息**（无法知道某个 body 里的按钮是哪个插件建的，也无法知道
   * 某个 galgame 标志属于谁），所以只能在"确定插件全走了"时整体执行 —— 这也是
   * L2 通用副作用回滚要解决的根因（spec §2.7.3）。
   */
  private cleanupExternalPluginUi() {
    // 清理插件创建的外部 UI 元素：插件常把按钮/overlay append 到 document.body 或 #chat，
    // 不在 pluginHost 容器内，unloadAll 默认清不到，导致 reload 时按钮重复累积。
    const externalPluginUiSelectors = [
      '.gal-open-btn',
      '#gal-global-overlay',
      '#galgame-database-container',
    ];
    for (const selector of externalPluginUiSelectors) {
      document.querySelectorAll(selector).forEach((el) => el.remove());
    }
    this.cleanupGalgameState();
  }

  /**
   * [PLUGIN-ON-DEMAND L1] 卸载单个插件：按 ``data-palink-st-plugin-id`` 锚点移除
   * 该插件注入的 script / style 节点。
   *
   * ⚠️ 边界（已知，留待 L2）：容器外残留（body 上的按钮/overlay、全局标志）只有当
   * **最后一个插件也被卸掉**时才清 —— 因为那些残留没有归属标记，提前清会误伤仍在
   * 运行的插件。共用插件差集装卸不受此限制（它们根本不会被卸掉）。
   */
  unloadPlugin(pluginId: string): boolean {
    if (!this.container || !pluginId) return false;
    const nodes = Array.from(
      this.container.querySelectorAll('script[data-palink-st-plugin-id], style[data-palink-st-plugin-id]'),
    ).filter((el) => el.getAttribute('data-palink-st-plugin-id') === pluginId);
    for (const el of nodes) el.remove();
    this.injectedPluginIds.delete(pluginId);
    // [B4-SHARED-PARTITION] 插件没了，它的分区归属也作废：
    // 留着会让它以后重新出现时从**已被删除的旧分区**取条目（取空）或误搬别人的条目。
    this.sharedPartitionOwner.delete(pluginId);

    if (nodes.length > 0) {
      const remaining = Array.from(
        this.container.querySelectorAll('script[data-palink-st-plugin-id], style[data-palink-st-plugin-id]'),
      ).filter((el) => el.getAttribute('data-palink-st-plugin-id') !== SETUP_PLUGIN_ID);
      if (remaining.length === 0) {
        // 一个都不剩了 → 可以安全地做全量外部清理
        this.cleanupExternalPluginUi();
        restoreGlobalFetchGuard();
      }
    }
    return nodes.length > 0;
  }

  /** 当前已注入的插件 ID 快照（调试/测试用） */
  getInjectedPluginIds(): string[] {
    return Array.from(this.injectedPluginIds);
  }

  unloadAll() {
    if (!this.container) return;
    const elements = this.container.querySelectorAll(
      'script[data-palink-st-plugin-id], style[data-palink-st-plugin-id]'
    );
    elements.forEach((el) => el.remove());
    this.cleanupExternalPluginUi();
    restoreGlobalFetchGuard();
    // [EVENT-BRIDGE] 退订本实例挂在全局 eventBus 上的回调。
    // 必须显式退订：eventBus 是全局单例，会一直持有这些回调引用 —— 不退订的话
    // 实例被替换（切卡/重挂载）后，旧回调仍会被触发，且旧 runtime 无法被回收。
    this.busWrappers.forEach((perEvent, name) => {
      perEvent.forEach((wrapped) => {
        try { eventBus.off(name as never, wrapped as never); } catch { /* ignore */ }
      });
    });
    this.busWrappers.clear();
    this.injectedPluginIds.clear();
    // [B4-SHARED-PARTITION] 账本随之作废（全量卸载后没有任何插件还「在场」）
    this.sharedPartitionOwner.clear();
    this.injected = false;
    this.container = null;
    delete (window as any).__palinkStRuntime;
  }

  async reload(options: InjectIntoContainerOptions = {}) {
    const container = this.container;
    this.unloadAll();
    if (container) {
      await this.loadRuntimeConfig();
      this.injectIntoContainer(container, options);
    }
  }

  async saveExtensionSettings() {
    // 2026-10-04 复核修复：落盘作用域是 (当前用户, 这张卡)。
    // 取不到角色 id 时**不写**并登记可见降级 —— 悄悄写到用户级就是跨卡渗漏，
    // 而那正是本批要消灭的毛病，不能用一个更宽的落点把它盖过去。
    const characterId = String(this.context?.characterUuid ?? '').trim();
    if (!characterId) {
      recordStubHit('saveSettingsDebounced', '未取到当前角色卡 id：本次设置未落库（仅内存有效，刷新即丢）');
      return;
    }
    try {
      // L2 的边界：影子副本里目前只有 openai_max_context 会被后端消费（且必过闸 3）。
      // custom_include_body 的语义是「往发给上游模型的请求里塞任意字段」——键名白名单
      // 尚未裁定，所以它**照存但明确记账不生效**，避免重演「插件以为生效、实际没发生」。
      const cib = (this.extensionSettings as any)?.chatCompletionSettings?.custom_include_body;
      const cibWritten = (typeof cib === 'string' && cib.trim() !== '' && cib.trim() !== '{}')
        || (!!cib && typeof cib === 'object' && Object.keys(cib).length > 0);
      if (cibWritten) {
        recordStubHit(
          'chatCompletionSettings.custom_include_body',
          '未开放：该内容不会进上游模型请求（键名白名单待定），仅按卡存着',
        );
      }
      const resp: any = await api.post('/api/plugins/runtime/settings', {
        character_id: characterId,
        extension_settings: this.extensionSettings,
      });
      // 后端把没存下的 namespace 写在响应里。不看响应 = 「看着存上了，其实丢了几项」，
      // 而插件侧 saveSettingsDebounced 是 fire-and-forget，永远不会自己发现。
      const skipped = Array.isArray(resp?.skipped) ? resp.skipped : [];
      for (const ns of skipped) {
        recordStubHit(`saveSettingsDebounced:${ns}`, '超出限额，该命名空间未落库（本次会话内仍有效，刷新后丢）');
      }
    } catch (e: any) {
      console.error('Failed to save extension settings:', e);
      recordStubHit('saveSettingsDebounced', `设置落盘失败：${String(e?.message ?? e)}`);
    }
  }
}
