import { api, getCsrfToken } from '@/services/api';
import { toast } from 'sonner';
import jQuery from 'jquery';
import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';
import { substituteParamsExtended } from '@/lib/sillytavern/macros';
import { sanitizePluginCss, isUrlAllowedByPluginWhitelist } from '@/lib/plugin-system/sandbox';
import { generationEngine } from '@/services/generation-engine';
import { getContext as getStContext } from '@/lib/sillytavern/getContext';
import { ST_TO_PALINK_EVENT_MAP } from '@/lib/sillytavern/runtime';
import { promptInjection } from '@/services/prompt-injection';
import { eventBus } from '@/lib/event-bus';

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

  on(eventName: string, callback: Function) {
    for (const name of this.eventAliases(eventName)) {
      if (!this.listeners.has(name)) {
        this.listeners.set(name, new Set());
      }
      this.listeners.get(name)!.add(callback);
    }
  }

  off(eventName: string, callback: Function) {
    for (const name of this.eventAliases(eventName)) {
      this.listeners.get(name)?.delete(callback);
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
          const resp = await api.post('/api/worldinfo/get', { name });
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
    };
    (window as any).__palinkBridge = palinkBridge;
    // 注入时预取世界书名称缓存（fire-and-forget，供插件同步读取）
    void palinkBridge.worldbookRefreshNames();

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

        window.registerSlashCommand = function(name, callback, aliases, helpString) {
          if (!window.__palinkSlashCommands) window.__palinkSlashCommands = {};
          window.__palinkSlashCommands[name] = { callback: callback, aliases: aliases || [], help: helpString || '' };
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
        })();
      })();
    `;
    // [PLUGIN-ON-DEMAND L1] setup 脚本幂等：差集模式下容器里已有一份就不重复 append
    // （重复注入会重复注册 setExtensionPrompt 等全局桥，属 harmless 但无意义）。
    const existingSetup = Array.from(
      container.querySelectorAll('script[data-palink-st-plugin-id]'),
    ).filter((el) => el.getAttribute('data-palink-st-plugin-id') === SETUP_PLUGIN_ID);
    if (existingSetup.length === 0) {
      container.appendChild(setupScript);
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
        try {
          container.appendChild(scriptEl);
          this.injectedPluginIds.add(plugin.id);
        } catch (e) {
          console.error(
            `[SillyTavernPluginRuntime] 注入插件脚本失败 (${plugin.name || plugin.id}):`,
            e,
          );
        }
      }
    }

    this.emit('EXTENSIONS_LOADED');
  }

  /**
   * 清理 Galgame 插件残留状态：localStorage 持久化状态 + 运行时全局标志。
   * 在 injectIntoContainer 开头和 unloadAll 中都调用，确保每次注入前状态干净。
   */
  private cleanupGalgameState() {
    // 清理 Galgame 插件持久化状态：插件将角色启用状态（_charEnabledMap）保存在
    // localStorage 的 galgame-ui-plugin_char_enabled 中。Palink 中角色 ID 映射
    // 与原版 ST 不同，插件回退到 "default" 键；一旦 default=true 被写入，
    // 每次加载都会自动启用 Galgame overlay（showGlobalOverlay），即使切换角色
    // 也不会关闭。原版 ST 中角色 ID 正确映射，不会出现 default 键被设为 true
    // 的问题。清理此键，确保插件以初始状态（未启用）启动，
    // 用户需手动点击启用按钮才能激活 Galgame 模式（与原版 ST 首次加载行为一致）。
    try {
      localStorage.removeItem('galgame-ui-plugin_char_enabled');
    } catch {}
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
    this.injectedPluginIds.clear();
    this.injected = false;
    this.container = null;
    delete (window as any).__palinkStRuntime;
  }

  async reload() {
    const container = this.container;
    this.unloadAll();
    if (container) {
      await this.loadRuntimeConfig();
      this.injectIntoContainer(container);
    }
  }

  async saveExtensionSettings() {
    try {
      await api.post('/api/plugins/runtime/settings', { extension_settings: this.extensionSettings });
    } catch (e) {
      console.error('Failed to save extension settings:', e);
    }
  }
}
