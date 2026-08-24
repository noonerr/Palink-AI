/**
 * 插件沙箱执行环境
 * 实现 ST 扩展 JS 的安全执行，支持 manifest.js 入口加载
 */

import type { PluginManifest, PluginContext } from './types';
import type { PluginContextWithHooks } from './context';
import { PluginStatus } from './types';
import { promptInjection } from '@/services/prompt-injection';
import { substituteParamsExtended } from '@/lib/sillytavern/macros';
import { popupManager, PopupType, PopupResult } from '@/lib/popup-system';
import DOMPurify from 'dompurify';
import { ST_EVENT_TYPES, getContext as buildStContext, writeExtensionFieldCompat } from '../sillytavern/getContext';
import { SlashCommandEngine } from '../slash-engine';
import {
  globalExtensionSettings,
  getExtensionSettingsNs,
  writeExtensionSettingsField,
  saveExtensionSettingsDebounced,
  migrateLegacyExtensionSettings,
} from '../sillytavern/extension-settings-store';
// ST 兼容库：真实库注入沙箱，使依赖 jQuery/Handlebars/toastr/select2/marked 的插件可用
import jQuery from 'jquery';
import Handlebars from 'handlebars';
import toastr from 'toastr';
import { marked } from 'marked';
import select2Factory from 'select2';
import 'toastr/build/toastr.min.css';

// ============================================================
// 酒馆助手(JS-Slash-Runner)变量系统全局存储
// 按 type(character/chat/script/world_info) 分区，跨插件共享。
// 对应酒馆助手 getVariables({type})/replaceVariables(vars,{type}) 契约。
// ============================================================
const tavernVariableStore = new Map<string, Record<string, any>>();

// 深合并：对照 lodash _.mergeWith（数组直接替换，对象递归合并）
function deepMergeObjects(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMergeObjects(result[key], srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ============================================================
// 扩展模板渲染（renderExtensionTemplateAsync 兼容实现）
// P-8：统一为完整 Handlebars（与 getContext 轨道的 renderExtensionTemplateImpl
// 一致：Handlebars.compile + DOMPurify 消毒）。完整支持 {{#if}}/{{#each}}/
// helper/{{var}}(转义)/{{{var}}}(不转义) 等 ST 模板语法。
// 回退：Handlebars 编译或渲染失败时，降级到旧的 {{var}}/{{{var}}} 简单替换器，
// 保证任何模板都不抛错、不输出原始 mustache 语法。
// ============================================================

/** 扩展模板编译缓存：模板源码 → 编译后的 Handlebars 函数（避免重复编译开销） */
const SANDBOX_TEMPLATE_CACHE = new Map<string, HandlebarsTemplateDelegate<any>>();

function escapeHtmlForTemplate(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char
  ));
}

function getByPathForTemplate(source: any, path: string, fallback: unknown = ''): unknown {
  const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  let value: any = source;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return fallback;
    value = value[part];
  }
  return value == null ? fallback : value;
}

/** 旧简单替换器（回退用）：仅支持 {{var}}/{{{var}}}，block/helper 原样输出 */
function compileSimpleTemplateForSandbox(template: string, data: Record<string, any> = {}): string {
  const payload = data && typeof data === 'object' ? data : {};
  return String(template || '')
    .replace(/\{\{\{\s*([\w.$-]+)\s*\}\}\}/g, (_m: string, key: string) => String(getByPathForTemplate(payload, key, '')))
    .replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m: string, key: string) => escapeHtmlForTemplate(getByPathForTemplate(payload, key, '')));
}

/**
 * 完整 Handlebars 渲染 + DOMPurify 消毒（P-8）。
 * 与 getContext.ts#renderExtensionTemplateImpl 行为对齐：
 * 1. Handlebars.compile（带缓存）
 * 2. 用 data 渲染
 * 3. DOMPurify 消毒（对齐 ST 扩展模板可用的 font/center/marquee 等标签）
 * 失败时回退 compileSimpleTemplateForSandbox，保证不抛错。
 */
function compileFullTemplateForSandbox(template: string, data: Record<string, any> = {}): string {
  const payload = data && typeof data === 'object' ? data : {};
  try {
    let compiled = SANDBOX_TEMPLATE_CACHE.get(template);
    if (!compiled) {
      compiled = Handlebars.compile(template);
      SANDBOX_TEMPLATE_CACHE.set(template, compiled);
    }
    const rendered = compiled(payload);
    return DOMPurify.sanitize(String(rendered), {
      ADD_TAGS: ['font', 'center', 'marquee', 'custom-style'],
      ADD_ATTR: ['target', 'color', 'face', 'size', 'align', 'valign', 'bgcolor'],
      FORBID_TAGS: ['script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    });
  } catch (e) {
    console.warn('[PluginSandbox] 完整 Handlebars 渲染失败，回退简单替换:', e);
    return compileSimpleTemplateForSandbox(template, payload);
  }
}

function normalizeTemplateName(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\.(?:html|hbs|handlebars|mustache)$/i, '')
    .split('/')
    .filter(Boolean)
    .join('/')
    .toLowerCase();
}

// ============================================================
// 扩展系统注册表（registerEndpoint / registerContextSetter / registerFunctionTool）
// ============================================================

/**
 * 端点注册表：key = `${pluginId}/${name}`，value = { method, handler, pluginId }
 * 同时挂载到 window 供 bridge.js 拦截 /api/plugins/ 请求时查询
 */
export const endpointRegistry: Map<string, { method: string; handler: Function; pluginId: string }> = new Map();

/**
 * Context setter 注册表：key = context 字段名，value = setter 函数
 * 由 getContext() 在构造上下文对象时遍历调用，将结果合并到 context 中
 */
export const contextSetterRegistry: Map<string, (context: any) => any> = new Map();

/**
 * 函数工具注册表：key = tool name，value = { description, handler, pluginId }
 */
export const functionToolRegistry: Map<string, { description: string; handler: Function; pluginId: string }> = new Map();

// 挂载到 window 供 bridge.js 等外部脚本访问
if (typeof window !== 'undefined') {
  (window as any).__palinkEndpointRegistry = endpointRegistry;
  (window as any).__palinkContextSetterRegistry = contextSetterRegistry;
  (window as any).__palinkFunctionToolRegistry = functionToolRegistry;
}

// select2 是 jQuery 插件（UMD），需手动调用 factory 以扩展 $.fn.select2
// 失败时仅记录日志，不阻塞沙箱初始化
let select2Ready = false;
try {
  const factory: any = (select2Factory as any)?.default ?? select2Factory;
  if (typeof factory === 'function' && jQuery) {
    factory(typeof window !== 'undefined' ? window : undefined, jQuery);
    select2Ready = true;
  }
} catch (e) {
  console.warn('[PluginSandbox] select2 插件初始化失败:', e);
}

/**
 * 使用 DOMPurify 对 HTML 字符串进行消毒
 * 防止插件通过 innerHTML/insertAdjacentHTML 等注入恶意脚本（XSS）
 * DOMPurify 不可用时回退到正则移除 script 标签和 on* 事件属性
 */
function sanitizeHtml(html: string): string {
  try {
    return String(
      DOMPurify.sanitize(html, {
        // ST 1.18 扩展模板中的自定义元素（如 quick-reply 的 <toolcool-color-picker id="qr--color">）
        // 必须保留，否则模板内对应控件 id 丢失导致插件 querySelector 返回 null。
        ADD_TAGS: ['custom-style', 'toolcool-color-picker'],
        FORBID_TAGS: ['script'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
      }),
    );
  } catch {
    // DOMPurify 不可用时，至少移除 script 标签和 on* 事件属性
    return String(html)
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  }
}

/**
 * 消毒插件 CSS（S-1）。
 * DOMPurify 不处理 CSS；此处用黑名单移除可加载外部资源/执行代码的构造：
 * @import/@charset/@namespace、url() 中的 javascript:/data:（data:image/* 保留）、
 * expression()/-moz-binding/behavior（旧式代码执行）、内嵌 script 标签。
 * 不改变插件常规样式（选择器/属性/值），仅移除危险片段。
 */
export function sanitizePluginCss(css: string): string {
  const input = String(css || '');
  try {
    let s = input;
    // @import/@charset/@namespace：可加载外部资源或改变解析上下文
    s = s.replace(/@import\b[^;]*;?/gi, '');
    s = s.replace(/@charset\b[^;]*;?/gi, '');
    s = s.replace(/@namespace\b[^;]*;?/gi, '');
    // url() 引用：仅保留 http(s):、data:image/* 与相对/无协议路径
    s = s.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, inner) => {
      const v = String(inner ?? '').trim();
      const lower = v.toLowerCase();
      if (!v) return m;
      if (/^javascript:/i.test(lower)) return 'url()';
      if (lower.startsWith('data:')) {
        return /^data:image\//i.test(lower) ? m : 'url()';
      }
      return m;
    });
    // 旧式 CSS 代码执行：expression()（IE）、-moz-binding（FF）、behavior（IE）
    s = s.replace(/expression\s*\(/gi, '/* removed */');
    s = s.replace(/-moz-binding\s*:/gi, '/* removed */');
    s = s.replace(/behavior\s*:/gi, '/* removed */');
    // 混淆进 CSS 的 script 标签
    s = s.replace(/<\/?script\b[^>]*>/gi, '');
    return s;
  } catch {
    return input;
  }
}

/**
 * 获取或创建插件的扩展容器
 * 每个插件拥有独立的 DOM 容器，用于隔离其 UI 元素与查询作用域
 */
function getOrCreatePluginExtensionContainer(pluginId: string): HTMLElement {
  const sanitized = String(pluginId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const containerId = `palink-extension-container-${sanitized}`;

  const existing = document.getElementById(containerId);
  if (existing) return existing;

  let mount = document.getElementById('palink-plugin-mount');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'palink-plugin-mount';
    mount.setAttribute('data-palink-plugin-mount', '');
    // 创建与 ST 主界面等价的定位上下文：
    // - fixed 全屏覆盖，让插件内部的 position:absolute/fixed 元素以视口为基准
    // - pointer-events:none 不拦截底层交互，插件元素可自行恢复 pointer-events:auto
    // - 高 z-index 确保插件 UI 不被普通内容遮挡
    mount.style.cssText =
      'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9999; overflow: hidden;';
    document.body.appendChild(mount);
  }

  const container = document.createElement('div');
  container.id = containerId;
  container.setAttribute('data-plugin-extension', pluginId);
  // 每个插件容器占满 mount 并提供 relative 定位上下文，
  // 让插件内容中的绝对定位元素相对于该容器而不是 document.body
  container.style.cssText =
    'position: relative; width: 100%; height: 100%; pointer-events: none;';
  mount.appendChild(container);

  return container;
}

/**
 * 模块级 Proxy → 原始对象映射
 * 用于 unwrapSandboxedElement：将沙箱化 Proxy 解包为原始对象
 * 跨沙箱共享，因为每个 Proxy 是唯一对象，不会冲突
 * 类型为 any 以支持 Node、Window、Document、Location 等多种对象类型
 */
const proxyToRaw = new WeakMap<object, any>();

/**
 * 将 Proxy 解包为原始 Node（模块级函数，供 jQuery 层使用）
 * - 如果是沙箱化 Proxy 则返回原始 Node（用于传给 DOM 方法）
 * - 否则原样返回
 *
 * 注意：不能仅依赖 `value instanceof Node` 判断是否为 Proxy。
 * 虽然普通元素 Proxy 的 instanceof Node 通常为 true（原型链透传），
 * 但某些场景下 Proxy 会被识别为非 Node（如沙箱化 document 在部分
 * jQuery 内部分支会先做 typeof/toString 判断）。因此对所有非空对象
 * 都查一次 proxyToRaw，命中则解包，未命中原样返回。WeakMap.get 是 O(1)，
 * 性能影响可忽略。
 */
function unwrapSandboxedElement<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const raw = proxyToRaw.get(value as unknown as object);
    if (raw) {
      return raw as T;
    }
  }
  return value;
}

/**
 * 模块级监听器跟踪映射：rawNode → Map<type, Map<originalListener, wrappedListener>>
 * 用于 addEventListener/removeEventListener 包装，确保 removeEventListener 能找到包装后的监听器
 */
const wrappedListenerMap = new WeakMap<Node, Map<string, Map<any, any>>>();

/**
 * 包装事件对象：使 event.target/currentTarget/relatedTarget 返回沙箱化元素
 * @param event 原始事件
 * @param wrapFn 沙箱的 wrapSandboxedElement 函数（每个沙箱独立）
 */
function wrapEventObject(event: Event, wrapFn: <T extends Node | null | undefined>(el: T) => T): Event {
  return new Proxy(event, {
    get(evtTarget, evtProp) {
      if (evtProp === 'target' || evtProp === 'currentTarget' || evtProp === 'relatedTarget') {
        const v = (evtTarget as any)[evtProp];
        return v ? wrapFn(v) : v;
      }
      const v = (evtTarget as any)[evtProp];
      return typeof v === 'function' ? v.bind(evtTarget) : v;
    },
  }) as Event;
}

/**
 * 注册包装后的监听器并记录映射，供 removeEventListener 查找
 */
function registerWrappedListener(
  node: Node,
  type: string,
  originalListener: any,
  wrappedListener: any,
): void {
  if (!wrappedListenerMap.has(node)) {
    wrappedListenerMap.set(node, new Map());
  }
  const typeMap = wrappedListenerMap.get(node)!;
  if (!typeMap.has(type)) {
    typeMap.set(type, new Map());
  }
  typeMap.get(type)!.set(originalListener, wrappedListener);
}

/**
 * 查找并移除包装后的监听器映射
 * @returns 找到的 wrappedListener，未找到则返回 originalListener
 */
function lookupWrappedListener(node: Node, type: string, originalListener: any): any {
  const typeMap = wrappedListenerMap.get(node);
  if (typeMap) {
    const listenerMap = typeMap.get(type);
    if (listenerMap) {
      const wrapped = listenerMap.get(originalListener);
      if (wrapped) {
        listenerMap.delete(originalListener);
        return wrapped;
      }
    }
  }
  return originalListener;
}

/**
 * 沙箱化元素包装函数类型
 */
type WrapElementFn = <T extends Node | null | undefined>(element: T) => T;

/**
 * createSandboxedDocument 返回值：包含沙箱化 document 和元素包装函数
 */
interface SandboxedDocumentResult {
  document: Document;
  wrapSandboxedElement: WrapElementFn;
}

/**
 * 创建沙箱化的 document 代理
 * 仅允许访问插件自己的 extension container，阻止访问主应用全局 DOM
 * 返回沙箱化 document 和元素包装函数（供 window/jQuery 层使用）
 */
function createSandboxedDocument(
  pluginId: string,
  sandboxedFetch?: (url: string, options?: RequestInit) => Promise<Response>,
): SandboxedDocumentResult {
  const container = getOrCreatePluginExtensionContainer(pluginId);

  // 双向 WeakMap：维护原始 Node 与 Proxy 的映射
  // 解决 Proxy 丢失内部槽(internal slots)无法被 DOM 方法接受的问题
  // 策略：unwrap on argument, wrap on return
  // proxyToRaw 为模块级共享，供 jQuery 层的 unwrapSandboxedElement 使用
  const rawToProxy = new WeakMap<Node, Node>();

  /**
   * 创建可执行脚本的 fake script 元素
   * 插件常通过 document.createElement('script') 加载外部库（GSAP/PIXI/Live2D 等），
   * 原始沙箱仅返回一个 div 阻止脚本执行，导致库源码被当作文本插入 DOM，撑高页面。
   * 此 fake script 会拦截 src/textContent/innerHTML，在真实 document.head 中创建 script 标签
   * 执行脚本并移除，使外部库能正确挂载到真实 window；fake 元素本身保持隐藏。
   *
   * 注意：返回的 Proxy 必须注册到 proxyToRaw，这样 document.appendChild 等 DOM 方法
   * 在解包参数时才能拿到真实 div，避免 "parameter 1 is not of type 'Node'" 错误。
   */
  function createFakeScriptElement(): HTMLDivElement {
    const fake = document.createElement('div');
    fake.setAttribute('data-sandbox-fake-script', '');
    fake.style.display = 'none';
    // 保存 onload/onerror 回调
    let onloadHandler: ((this: HTMLScriptElement, ev: Event) => any) | null = null;
    let onerrorHandler: ((this: HTMLScriptElement, ev: Event | string) => any) | null = null;
    let srcUrl = '';
    // S-1: 白名单/内联拒绝时 onerror 回调的占位接收者（fake 元素，符合 HTMLScriptElement 接口）
    const realScriptPlaceholder = fake as unknown as HTMLScriptElement;

    const executeExternalScript = (url: string) => {
      srcUrl = url;
      // S-1: 外部脚本强制走沙箱白名单（同源 + 默认 CDN + 用户配置域名）。
      // 此前 fake script 直接创建 <script src> 在真实 document.head 执行任意 URL，
      // 完全绕过 createSandboxedFetch 的域名白名单 → 恶意插件可加载任意远程代码。
      // 白名单判定失败时拒绝执行并触发 onerror，插件侧可按 onerror 回退处理。
      if (!isUrlAllowedByPluginWhitelist(url)) {
        console.warn(
          `[PluginSandbox] fake script 拒绝加载白名单外 URL: ${url}`,
        );
        try { onerrorHandler?.call(realScriptPlaceholder as any, 'blocked-by-whitelist'); } catch (e) { /* ignore */ }
        return;
      }
      const realScript = document.createElement('script');
      realScript.src = url;
      realScript.async = true;
      realScript.onload = (ev) => {
        try { onloadHandler?.call(realScript as any, ev); } catch (e) { /* ignore */ }
      };
      realScript.onerror = (ev) => {
        try { onerrorHandler?.call(realScript as any, ev); } catch (e) { /* ignore */ }
      };
      document.head.appendChild(realScript);
    };

    const executeInlineScript = (code: string) => {
      if (!code || !code.trim()) return;
      // S-1: 禁止内联脚本执行。fake script 的内联代码路径此前会创建真实
      // <script> 在 document.head 执行任意代码（绕过词法遮蔽与 Function 拦截），
      // 是沙箱逃逸面之一。改为拒绝并触发 onerror，插件侧可感知失败。
      console.warn(
        '[PluginSandbox] fake script 内联代码执行已被禁用（沙箱）',
      );
      try { onerrorHandler?.call(realScriptPlaceholder as any, 'inline-script-blocked'); } catch (e) { /* ignore */ }
    };

    const handler: ProxyHandler<HTMLDivElement> = {
      get(target, prop) {
        if (prop === 'tagName' || prop === 'nodeName') return 'SCRIPT';
        if (prop === 'src') return srcUrl;
        if (prop === 'onload') return onloadHandler;
        if (prop === 'onerror') return onerrorHandler;
        const value = (target as any)[prop];
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
      set(target, prop, value) {
        if (prop === 'src') {
          const url = String(value || '');
          executeExternalScript(url);
          return true;
        }
        if (prop === 'type' || prop === 'async' || prop === 'defer' || prop === 'crossOrigin') {
          // 忽略脚本属性，不报错
          return true;
        }
        if (prop === 'onload') {
          onloadHandler = typeof value === 'function' ? value : null;
          return true;
        }
        if (prop === 'onerror') {
          onerrorHandler = typeof value === 'function' ? value : null;
          return true;
        }
        if (prop === 'textContent' || prop === 'innerHTML' || prop === 'innerText') {
          executeInlineScript(String(value || ''));
          // 仍然保存到 target 以便 getAttribute/get 能读到，但保持 display:none
          (target as any)[prop] = value;
          return true;
        }
        (target as any)[prop] = value;
        return true;
      },
    };

    const proxy = new Proxy(fake, handler) as unknown as HTMLDivElement;
    // 注册到 proxyToRaw，使 DOM 方法解包时能拿到真实 div
    proxyToRaw.set(proxy, fake);
    return proxy;
  }

  let sandboxedDocument: Document;

  // 需要解包参数的 DOM 方法集合（参数为 Node 类型，传入 Proxy 会导致内部槽检查失败）
  const unwrapArgsMethods = new Set<string>([
    'appendChild', 'insertBefore', 'replaceChild', 'removeChild',
    'contains', 'compareDocumentPosition', 'isSameNode', 'isEqualNode',
    'addEventListener', 'removeEventListener',
    'insertAdjacentElement', 'before', 'after', 'replaceWith', 'append', 'prepend',
  ]);

  // 需要包装返回值的 DOM 方法集合（返回 Node/NodeList/HTMLCollection）
  const wrapReturnMethods = new Set<string>([
    'appendChild', 'insertBefore', 'replaceChild', 'removeChild',
    'cloneNode', 'querySelector', 'querySelectorAll',
    'getElementsByTagName', 'getElementsByClassName', 'getElementsByTagNameNS',
    'getElementsByName', 'closest', 'insertAdjacentElement',
  ]);

  /**
   * 将原始 Node 包装为沙箱化 Proxy
   * - null/undefined 原样返回
   * - 已是 Proxy 则原样返回（幂等）
   * - 已有缓存则返回缓存（保持引用一致性）
   * - 否则创建新 Proxy 并存入双向 WeakMap
   */
  function wrapSandboxedElement<T extends Node | null | undefined>(element: T): T {
    if (element === null || element === undefined) {
      return element;
    }
    // 幂等：如果已经是 Proxy，直接返回
    if (proxyToRaw.has(element)) {
      return element;
    }
    // 检查缓存
    const cached = rawToProxy.get(element);
    if (cached) {
      return cached as T;
    }
    // 创建新 Proxy 并存入双向 WeakMap
    const proxy = new Proxy(element as Node, elementHandler);
    rawToProxy.set(element as Node, proxy);
    proxyToRaw.set(proxy, element as Node);
    return proxy as T;
  }

  /**
   * 包装方法返回值：Node → Proxy，NodeList/HTMLCollection → 包装数组
   */
  function wrapReturnValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (value instanceof Node) {
      return wrapSandboxedElement(value);
    }
    if (value instanceof NodeList || value instanceof HTMLCollection) {
      const arr = Array.from(value).map(n => wrapSandboxedElement(n));
      // 添加 item 方法以兼容 NodeList/HTMLCollection 接口
      (arr as unknown as { item: (index: number) => Node | null }).item =
        (index: number) => (arr as unknown as Node[])[index] || null;
      return arr;
    }
    return value;
  }

  /**
   * 元素 Proxy handler：实现 "unwrap on argument, wrap on return" 策略
   * - 拦截 parentNode/parentElement/ownerDocument/getRootNode 阻止 DOM 上溯
   * - 方法返回包装函数：调用前解包 Proxy 参数，调用后包装 Node 返回值
   * - 属性返回 Node/NodeList/HTMLCollection 时自动包装
   */
  const elementHandler: ProxyHandler<Node> = {
    get(target, prop, _receiver) {
      // 拦截 parentNode/parentElement：返回沙箱化父节点代理（递归包装）
      // 容器本身是沙箱边界，阻止继续上溯到 mount/document.body
      if (prop === 'parentNode' || prop === 'parentElement') {
        if (target === container) {
          return null;
        }
        const parent = target.parentNode;
        if (parent === null) {
          return null;
        }
        return wrapSandboxedElement(parent);
      }
      // 拦截 ownerDocument：返回沙箱化 document 代理
      if (prop === 'ownerDocument') {
        return sandboxedDocument;
      }
      // 拦截 getRootNode：返回容器作为沙箱根节点
      if (prop === 'getRootNode') {
        return () => wrapSandboxedElement(container);
      }
      // 拦截 contentWindow/contentDocument：阻止访问 iframe 内部 window/document
      // 防止插件通过 iframe 逃逸沙箱
      if (prop === 'contentWindow' || prop === 'contentDocument') {
        return null;
      }
      // 拦截 shadowRoot/host/attachShadow：阻止访问和创建 Shadow DOM
      // 防止插件通过 Shadow DOM 逃逸沙箱或隐藏恶意内容
      if (prop === 'shadowRoot' || prop === 'host') {
        return null;
      }
      if (prop === 'attachShadow') {
        return () => null;
      }
      // 拦截 attributes：返回沙箱化 NamedNodeMap（拦截 ownerElement，包装 Attr 节点）
      // NamedNodeMap 不是 Node/NodeList/HTMLCollection，无法被自动包装，需特殊处理
      if (prop === 'attributes') {
        const attrs = (target as Element).attributes;
        return new Proxy(attrs, {
          get(t, p) {
            // ownerElement 返回沙箱化元素代理，防止泄露原始元素
            if (p === 'ownerElement') {
              return wrapSandboxedElement(target);
            }
            const v = Reflect.get(t, p);
            if (typeof v === 'function') {
              const fn = v;
              // 方法返回值若为 Attr 节点（Node），需包装
              return (...args: unknown[]) => {
                const result = fn.apply(t, args);
                if (result instanceof Node) {
                  return wrapSandboxedElement(result);
                }
                return result;
              };
            }
            // 索引访问或 item() 返回的 Attr 节点需包装
            if (v instanceof Node) {
              return wrapSandboxedElement(v);
            }
            return v;
          },
        });
      }
      // 拦截 classList：返回沙箱化 DOMTokenList
      // DOMTokenList 不直接暴露 ownerElement，但操作直接作用于 target
      // 返回 Proxy 以保持一致性并防止原型链泄露
      if (prop === 'classList') {
        const cl = (target as Element).classList;
        return new Proxy(cl, {
          get(t, p) {
            const v = Reflect.get(t, p);
            if (typeof v === 'function') {
              return v.bind(t);
            }
            return v;
          },
        });
      }

      // 其他属性正常透传（style、className、textContent 等）
      const value = Reflect.get(target, prop);

      // 拦截 insertAdjacentHTML：对 HTML 参数进行 DOMPurify 消毒，防止 XSS
      if (prop === 'insertAdjacentHTML' && typeof value === 'function') {
        return (position: InsertPosition, html: string) => {
          return (target as Element).insertAdjacentHTML(
            position,
            sanitizeHtml(String(html)),
          );
        };
      }

      // 拦截 addEventListener：包装回调，使 event.target/currentTarget/relatedTarget 返回沙箱化元素
      if (prop === 'addEventListener' && typeof value === 'function') {
        return (type: string, listener: any, options?: any) => {
          if (typeof listener !== 'function') return;
          const wrappedListener = (event: Event) => {
            const wrappedEvent = wrapEventObject(event, wrapSandboxedElement);
            listener.call(wrapSandboxedElement(target), wrappedEvent);
          };
          registerWrappedListener(target, type, listener, wrappedListener);
          target.addEventListener(type, wrappedListener, options);
        };
      }
      // 拦截 removeEventListener：查找包装后的监听器进行移除
      if (prop === 'removeEventListener' && typeof value === 'function') {
        return (type: string, listener: any, options?: any) => {
          const wrapped = lookupWrappedListener(target, type, listener);
          target.removeEventListener(type, wrapped, options);
        };
      }

      if (typeof value === 'function') {
        const rawMethod = value;
        const methodName = String(prop);
        const shouldUnwrapArgs = unwrapArgsMethods.has(methodName);
        const shouldWrapReturn = wrapReturnMethods.has(methodName);

        // 返回包装函数：调用前解包 Proxy 参数，调用后包装 Node 返回值
        // 这样 Proxy 传给 DOM 方法时会先解包为原始 Node，避免内部槽检查失败
        return (...args: unknown[]) => {
          const unwrappedArgs = shouldUnwrapArgs
            ? args.map(unwrapSandboxedElement)
            : args;
          const result = rawMethod.apply(target, unwrappedArgs);
          return shouldWrapReturn ? wrapReturnValue(result) : result;
        };
      }

      // 对返回 Node 的属性进行包装（firstChild/lastChild/nextSibling/previousSibling 等）
      if (value instanceof Node) {
        return wrapSandboxedElement(value);
      }
      // 对 NodeList/HTMLCollection 属性进行包装（childNodes/children 等）
      if (value instanceof NodeList || value instanceof HTMLCollection) {
        return wrapReturnValue(value);
      }

      return value;
    },
    set(target, prop, value) {
      // 对 innerHTML/outerHTML 进行 DOMPurify 消毒，防止插件注入恶意脚本（XSS）
      if ((prop === 'innerHTML' || prop === 'outerHTML') && typeof value === 'string') {
        value = sanitizeHtml(value);
      }
      // set 时解包（如果设置的是 Proxy Node，避免将 Proxy 存入原始 DOM）
      Reflect.set(target, prop, unwrapSandboxedElement(value));
      return true;
    },
  };

  const docHandler: ProxyHandler<Document> = {
    get(_target, prop, _receiver) {
      // 阻止访问全局 DOM 属性：返回插件扩展容器作为 body 的作用域替代
      // 插件通过 document.body.appendChild 挂载的元素仅落入自身容器，无法触及真实 document.body
      if (prop === 'body') {
        return wrapSandboxedElement(container);
      }
      // head 也返回插件容器：插件常通过 document.head.appendChild(script) 加载 CDN 脚本，
      // 返回 null 会导致 "Cannot read properties of null (reading 'appendChild')"。
      // 返回插件容器让 appendChild 不报错（脚本会被 DOMPurify 拦截不执行，但不中断插件流程）。
      if (prop === 'head') {
        return wrapSandboxedElement(container);
      }
      // documentElement 完全阻止访问
      if (prop === 'documentElement') {
        return null;
      }

      // 查询方法：仅在插件的 extension container 内查询，返回包装后的元素
      if (prop === 'getElementById') {
        return (id: string) => {
          const el = container.querySelector(`[id="${String(id).replace(/["\\]/g, '\\$&')}"]`);
          if (el) return wrapSandboxedElement(el);
          // Fix 2: ST 聊天挂载点（#chat / #gal-global-overlay / #galgame-database-container）
          // 及 ST 标准挂载点（#extensions_settings 等）由 React 在 container 外渲染，
          // 沙箱 container 查不到时回退查真实 document，与 createSandboxedJQuery 回退策略对齐。
          if (ST_CHAT_SELECTOR_IDS.has(id) || ST_MOUNT_POINT_IDS.has(id)) {
            const real = document.getElementById(id);
            if (real) return wrapSandboxedElement(real);
            // ST 预置扩展容器（如 #qr_container）由 ST index.html 提供，Palink 无此元素。
            // 在插件 mount 下惰性创建（幂等、全局唯一），使 quick-reply 等
            // document.querySelector('#qr_container').append(...) 不崩且内容落在沙箱边界内。
            const mount = document.getElementById('palink-plugin-mount');
            if (mount && ST_MOUNT_POINT_IDS.has(id) && !document.getElementById(id)) {
              const created = document.createElement('div');
              created.id = id;
              created.setAttribute('data-sandbox-created-container', '');
              mount.appendChild(created);
              return wrapSandboxedElement(created);
            }
          }
          return null;
        };
      }
      if (prop === 'querySelector') {
        return (selector: string) => {
          const el = container.querySelector(selector);
          if (el) return wrapSandboxedElement(el);
          // Fix 2: ST 聊天白名单选择器（.mes / .mes_text / [mesid] / #chat 等）回退真实 document
          if (isStChatSelector(selector)) {
            const real = document.querySelector(selector);
            if (real) return wrapSandboxedElement(real);
          }
          // 纯 #id 选择器命中 ST 挂载点白名单时回退真实 document；
          // 若元素不存在（ST 预置扩展容器）则惰性创建（与 getElementById 分支一致）
          const idMatch = typeof selector === 'string' ? selector.trim().match(/^#([\w-]+)$/) : null;
          if (idMatch && ST_MOUNT_POINT_IDS.has(idMatch[1])) {
            const real = document.getElementById(idMatch[1]);
            if (real) return wrapSandboxedElement(real);
            const mount = document.getElementById('palink-plugin-mount');
            if (mount && !document.getElementById(idMatch[1])) {
              const created = document.createElement('div');
              created.id = idMatch[1];
              created.setAttribute('data-sandbox-created-container', '');
              mount.appendChild(created);
              return wrapSandboxedElement(created);
            }
          }
          return null;
        };
      }
      if (prop === 'querySelectorAll') {
        return (selector: string) => {
          const nodes = container.querySelectorAll(selector);
          // 包装 NodeList 中的每个元素
          let wrapped = Array.from(nodes).map(el => wrapSandboxedElement(el)) as unknown as Element[];
          // Fix 2: container 查不到时，对 ST 聊天白名单选择器回退真实 document
          if (wrapped.length === 0 && isStChatSelector(selector)) {
            const realNodes = document.querySelectorAll(selector);
            if (realNodes.length > 0) {
              wrapped = Array.from(realNodes).map(el => wrapSandboxedElement(el)) as unknown as Element[];
            }
          }
          // 添加 item 方法以兼容 NodeList 接口
          (wrapped as any).item = (index: number) => (wrapped as any)[index] || null;
          return wrapped;
        };
      }

      // 创建方法：允许正常使用，返回包装后的元素
      if (prop === 'createElement') {
        return (tagName: string, options?: ElementCreationOptions) => {
          const lower = tagName.toLowerCase();
          // 拦截 script 标签：返回可执行脚本的 fake script 元素
          // 插件设置 src/textContent 时会在真实 document.head 中创建 script 执行，
          // 外部库（GSAP/PIXI/Live2D 等）可正确挂载到真实 window。
          if (lower === 'script') {
            // fake script 本身已是注册过 proxyToRaw 的自定义 Proxy，
            // 不要再包一层 wrapSandboxedElement，否则 DOM 解包时会得到内层 Proxy。
            return createFakeScriptElement() as unknown as Element;
          }
          // 拦截 iframe 标签：创建真实 iframe 但设置 sandbox 属性限制
          // sandbox 属性阻止 iframe 内执行脚本、表单提交等
          if (lower === 'iframe') {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-same-origin');
            return wrapSandboxedElement(iframe);
          }
          const el = document.createElement(tagName, options);
          return wrapSandboxedElement(el);
        };
      }
      if (prop === 'createTextNode') {
        return (data: string) => {
          const node = document.createTextNode(data);
          return wrapSandboxedElement(node);
        };
      }
      if (prop === 'createDocumentFragment') {
        return () => {
          const frag = document.createDocumentFragment();
          return wrapSandboxedElement(frag);
        };
      }
      // createElementNS：支持命名空间创建元素，拦截 script/iframe
      if (prop === 'createElementNS') {
        return (namespace: string, tagName: string) => {
          const lower = String(tagName).toLowerCase();
          if (lower === 'script') {
            // fake script 本身已是注册过 proxyToRaw 的自定义 Proxy，
            // 不要再包一层 wrapSandboxedElement，否则 DOM 解包时会得到内层 Proxy。
            return createFakeScriptElement() as unknown as Element;
          }
          if (lower === 'iframe') {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-same-origin');
            return wrapSandboxedElement(iframe);
          }
          return wrapSandboxedElement(document.createElementNS(namespace, tagName));
        };
      }
      if (prop === 'createComment') {
        return (data: string) => wrapSandboxedElement(document.createComment(data));
      }
      if (prop === 'createRange') {
        return () => {
          const range = document.createRange();
          // 拦截 createContextualFragment：对 HTML 参数进行 DOMPurify 消毒，防止 XSS
          const originalCreateContextualFragment = range.createContextualFragment.bind(range);
          range.createContextualFragment = (html: string) => {
            const sanitized = sanitizeHtml(String(html));
            return originalCreateContextualFragment(sanitized);
          };
          return range;
        };
      }
      if (prop === 'createEvent') {
        return (type: string) => document.createEvent(type);
      }

      // 事件监听：包装回调，使 event.target/currentTarget/relatedTarget 返回沙箱化元素
      if (prop === 'addEventListener') {
        return (type: string, listener: any, options?: any) => {
          if (typeof listener !== 'function') return;
          const wrappedListener = (event: Event) => {
            const wrappedEvent = wrapEventObject(event, wrapSandboxedElement);
            listener.call(document, wrappedEvent);
          };
          registerWrappedListener(document, type, listener, wrappedListener);
          document.addEventListener(type, wrappedListener, options);
        };
      }
      if (prop === 'removeEventListener') {
        return (type: string, listener: any, options?: any) => {
          const wrapped = lookupWrappedListener(document, type, listener);
          document.removeEventListener(type, wrapped, options);
        };
      }

      // document 只读属性白名单
      if (prop === 'readyState') return document.readyState;
      if (prop === 'activeElement') {
        const el = document.activeElement;
        return el && el !== document.body ? wrapSandboxedElement(el) : null;
      }
      if (prop === 'URL') return document.URL;
      if (prop === 'baseURI') return document.baseURI;
      if (prop === 'referrer') return document.referrer;
      if (prop === 'title') return document.title;
      if (prop === 'visibilityState') return document.visibilityState;
      if (prop === 'hidden') return document.hidden;

      // 其他属性一律阻止访问
      return undefined;
    },
    set() {
      // 阻止插件修改 document 属性（静默吞写，避免严格模式抛错破坏插件执行）
      return true;
    },
  };

  sandboxedDocument = new Proxy(document, docHandler) as Document;
  // 注册沙箱化 document 到模块级 proxyToRaw，使 unwrapSandboxedElement 能将其解包为原始 document。
  // 否则插件调用 $(document) 时，jQuery 会尝试对 Proxy 做 String()/Symbol.toPrimitive 转换，
  // 而 Proxy 没有有效的 primitive 转换 → 抛出 "Cannot convert object to primitive value"。
  proxyToRaw.set(sandboxedDocument, document);
  return { document: sandboxedDocument, wrapSandboxedElement };
}

/**
 * 创建沙箱化的存储对象
 * 使用插件上下文存储，隔离不同插件的存储数据
 */
function createSandboxedStorage(context: PluginContext): Storage {
  // 跟踪当前会话设置的键（用于 length/key/clear）
  const keys = new Set<string>();

  return {
    getItem(key: string) {
      const val = context.storage.get<string | undefined>(key);
      return val === undefined ? null : String(val);
    },
    setItem(key: string, value: string) {
      context.storage.set(key, String(value));
      keys.add(key);
    },
    removeItem(key: string) {
      context.storage.delete(key);
      keys.delete(key);
    },
    clear() {
      for (const key of keys) {
        context.storage.delete(key);
      }
      keys.clear();
    },
    key(index: number) {
      const arr = Array.from(keys);
      return arr[index] ?? null;
    },
    get length() {
      return keys.size;
    },
  } as Storage;
}

/**
 * 创建沙箱化的 sessionStorage
 * 使用独立的内存 Map，不持久化，与 localStorage 分离
 * 避免与 localStorage 共享 context.storage 导致互相覆盖
 */
function createSandboxedSessionStorage(): Storage {
  const data = new Map<string, string>();
  const keys = new Set<string>();
  return {
    get length() { return keys.size; },
    key(index: number) { return Array.from(keys)[index] ?? null; },
    getItem(k: string) { return data.has(k) ? data.get(k)! : null; },
    setItem(k: string, v: string) { data.set(k, v); keys.add(k); },
    removeItem(k: string) { data.delete(k); keys.delete(k); },
    clear() { data.clear(); keys.clear(); },
  } as Storage;
}

/**
 * 创建只读的 location 代理
 * 仅允许读取 href/origin/hostname 等属性，阻止修改
 */
function createSandboxedLocation(): Location {
  const allowedProps = new Set([
    'href', 'origin', 'hostname', 'host', 'port',
    'protocol', 'pathname', 'search', 'hash',
  ]);

  const handler: ProxyHandler<Location> = {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!allowedProps.has(prop)) return undefined;
      return (window.location as any)[prop];
    },
    set() {
      // 静默忽略修改
      return true;
    },
    has(_target, prop) {
      if (typeof prop === 'string') {
        return allowedProps.has(prop);
      }
      return false;
    },
  };

  return new Proxy(window.location, handler) as Location;
}

/**
 * 创建沙箱化的 history stub
 * 不暴露真实 history 状态，提供只读/空操作接口
 */
function createSandboxedHistory(): History {
  const stub: any = {
    length: 1,
    state: null,
    scrollRestoration: 'auto',
    pushState: (_state: any, _title: string, _url?: string) => { /* stub */ },
    replaceState: (_state: any, _title: string, _url?: string) => { /* stub */ },
    back: () => { /* stub */ },
    forward: () => { /* stub */ },
    go: (_delta?: number) => { /* stub */ },
  };
  return stub as History;
}

/**
 * 创建已关闭的 WebSocket stub（S-1）。
 * 沙箱拒绝跨源/非法 WebSocket 连接时返回该 stub：readyState=CLOSED(3)，
 * 事件回调/方法均安全空实现，插件 new WebSocket(...) 不抛错但也不会建立真实连接。
 */
function createRejectedWebSocketStub(): WebSocket {
  const listeners: Record<string, Function> = {};
  const stub: any = {
    url: '',
    readyState: 3, // CLOSED
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    bufferedAmount: 0,
    extensions: '',
    protocol: '',
    binaryType: 'blob',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (_data: any) => { /* stub */ },
    close: (_code?: number, _reason?: string) => { /* stub */ },
    addEventListener: (type: string, cb: any) => { listeners[type] = cb; },
    removeEventListener: (type: string, cb?: any) => {
      if (listeners[type] === cb || cb === undefined) delete listeners[type];
    },
    dispatchEvent: (ev: Event) => {
      const cb = listeners[ev.type] || stub[`on${ev.type}`];
      if (typeof cb === 'function') {
        try { cb.call(stub, ev); } catch { /* ignore */ }
      }
      return true;
    },
  };
  return stub as WebSocket;
}

/**
 * 创建沙箱化的 window 代理
 * 仅暴露白名单属性，阻止访问 location/parent/top 等敏感属性
 * 允许插件写入自定义全局变量（通过 pluginGlobals 隔离存储）
 *
 * 返回 pluginGlobals 引用供外部（createSandboxGlobal）在 sandbox 对象构造完成后
 * 注入酒馆助手兼容 API（eventOn/tavern_events 等），使 sandboxedWindow 即 window.top
 * 可通过 Proxy get handler 的 pluginGlobals 分支访问这些 API。
 */
function createSandboxedWindow(
  pluginId: string,
  sandboxedDocument: Document,
  sandboxedFetch: (url: string, options?: RequestInit) => Promise<Response>,
  sandboxedLocalStorage: Storage,
  sandboxedSessionStorage: Storage,
  wrapSandboxedElement: WrapElementFn,
): { sandboxedWindow: Window; pluginGlobals: Map<string, any> } {
  // 插件专属全局变量存储：插件写入的自定义变量存于此处，与真实 window 隔离
  const pluginGlobals = new Map<string, any>();

  // 受保护属性：禁止插件覆盖的全局属性
  const protectedProps = new Set<string>([
    'document', 'window', 'self', 'globalThis', 'location', 'navigator',
    'history', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'console', 'alert', 'confirm', 'prompt',
  ]);

  const whitelist = new Set<string>([
    // 定时器
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame',
    // 核心 JS 对象
    'console', 'Date', 'Math', 'JSON', 'Promise',
    'Array', 'Object', 'String', 'Number', 'Boolean',
    'Map', 'Set', 'Symbol', 'Error', 'RegExp',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob',
    // 事件
    'addEventListener', 'removeEventListener',
    // 自引用和核心对象（在 get handler 中特殊处理）
    'document', 'window', 'self', 'globalThis', 'fetch',
    'location', 'localStorage', 'sessionStorage',
    // Web API
    'crypto', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
    'FormData', 'Blob', 'File', 'FileReader',
    'TextEncoder', 'TextDecoder',
    'AbortController', 'AbortSignal', 'WebSocket',
    // S-1: performance 加入白名单（词法 var performance = __sandbox.window.performance 需要透传；仅测时用，无安全面）
    'performance',
    'Event', 'CustomEvent', 'EventTarget',
    'Element', 'Node', 'HTMLElement', 'DocumentFragment',
    'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
    // window 属性
    'history', 'navigator', 'screen',
    'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
    'devicePixelRatio', 'getComputedStyle', 'matchMedia',
    'scrollTo', 'scrollX', 'scrollY',
  ]);

  const sandboxedConsole = {
    log: (...args: unknown[]) => console.log(`[Plugin ${pluginId}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[Plugin ${pluginId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[Plugin ${pluginId}]`, ...args),
    info: (...args: unknown[]) => console.info(`[Plugin ${pluginId}]`, ...args),
    debug: (...args: unknown[]) => console.debug(`[Plugin ${pluginId}]`, ...args),
  };

  const sandboxedLocation = createSandboxedLocation();
  const sandboxedHistory = createSandboxedHistory();
  // S-1: WebSocket 同源包装。真实 WebSocket 不受浏览器同源策略限制（可连任意源），
  // 直通会让恶意插件把聊天内容外传到任意服务器；这里仅放行同源连接，
  // 跨源/非法 URL 返回已关闭 stub（不抛错、不建立连接）。
  const sandboxedWebSocket = function (this: any, url: string, protocols?: string | string[]) {
    const targetUrl = String(url || '');
    try {
      const parsed = new URL(targetUrl, window.location.href);
      const protocolOk = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
      const isSameOrigin = parsed.origin === window.location.origin;
      if (!protocolOk || !isSameOrigin) {
        console.warn(`[Sandbox] WebSocket 拒绝跨源连接 ${targetUrl} (plugin=${pluginId})`);
        return createRejectedWebSocketStub();
      }
      return protocols !== undefined
        ? new WebSocket(targetUrl, protocols)
        : new WebSocket(targetUrl);
    } catch (e) {
      console.warn(`[Sandbox] WebSocket 无效 URL ${targetUrl} (plugin=${pluginId})`);
      return createRejectedWebSocketStub();
    }
  } as unknown as typeof WebSocket;
  let sandboxedWindow: Window;

  // window 专属监听器跟踪（window 不是 Node，无法使用模块级 wrappedListenerMap）
  const windowListenerMap = new Map<string, Map<any, any>>();

  const handler: ProxyHandler<Window> = {
    get(target, prop, _receiver) {
      if (typeof prop !== 'string') {
        return undefined;
      }

      // 自引用：window/self/globalThis/top/parent 返回沙箱化 window 自身
      // 酒馆助手脚本通过 window.top.TavernHelper / window.parent.TavernHelper 访问 API，
      // 在非 iframe 环境下 top/parent === window，需返回 sandboxedWindow 让 TavernHelper 可达
      if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'top' || prop === 'parent') {
        return sandboxedWindow;
      }
      // document 返回沙箱化 document
      if (prop === 'document') {
        return sandboxedDocument;
      }
      // fetch 返回沙箱化 fetch
      if (prop === 'fetch') {
        return sandboxedFetch;
      }
      // location 返回只读代理
      if (prop === 'location') {
        return sandboxedLocation;
      }
      // history 返回 stub，不暴露真实 history 状态
      if (prop === 'history') {
        return sandboxedHistory;
      }
      // localStorage/sessionStorage 返回沙箱化存储
      if (prop === 'localStorage') {
        return sandboxedLocalStorage;
      }
      if (prop === 'sessionStorage') {
        return sandboxedSessionStorage;
      }
      // console 返回沙箱化 console
      if (prop === 'console') {
        return sandboxedConsole;
      }
      // S-1: WebSocket 返回同源包装（拒绝跨源连接），须在 whitelist 检查之前
      if (prop === 'WebSocket') {
        return sandboxedWebSocket;
      }

      // setTimeout/setInterval：拒绝字符串参数（防止 eval 类代码执行）
      if (prop === 'setTimeout') {
        return (handler: any, delay?: number, ...args: any[]) => {
          if (typeof handler === 'string') {
            console.warn('[Sandbox] setTimeout with string argument is not allowed');
            return 0;
          }
          return target.setTimeout(handler, delay, ...args);
        };
      }
      if (prop === 'setInterval') {
        return (handler: any, delay?: number, ...args: any[]) => {
          if (typeof handler === 'string') {
            console.warn('[Sandbox] setInterval with string argument is not allowed');
            return 0;
          }
          return target.setInterval(handler, delay, ...args);
        };
      }

      // addEventListener：包装回调，使 event.target/currentTarget 返回沙箱化元素
      if (prop === 'addEventListener') {
        return (type: string, listener: any, options?: any) => {
          if (typeof listener !== 'function') return;
          const wrappedListener = (event: Event) => {
            const wrappedEvent = wrapEventObject(event, wrapSandboxedElement);
            listener.call(target, wrappedEvent);
          };
          if (!windowListenerMap.has(type)) {
            windowListenerMap.set(type, new Map());
          }
          windowListenerMap.get(type)!.set(listener, wrappedListener);
          target.addEventListener(type, wrappedListener, options);
        };
      }
      if (prop === 'removeEventListener') {
        return (type: string, listener: any, options?: any) => {
          const typeMap = windowListenerMap.get(type);
          if (typeMap) {
            const wrapped = typeMap.get(listener);
            if (wrapped) {
              typeMap.delete(listener);
              target.removeEventListener(type, wrapped, options);
              return;
            }
          }
          target.removeEventListener(type, listener, options);
        };
      }

      // 优先从插件全局变量读取（插件写入的自定义属性）
      if (pluginGlobals.has(prop)) {
        return pluginGlobals.get(prop);
      }

      if (!whitelist.has(prop)) {
        return undefined;
      }

      const value = target[prop as keyof Window];
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
    set(target, prop, value) {
      // 允许插件写入自定义全局变量（非受保护属性），存储到插件专属全局对象
      if (typeof prop === 'string' && !protectedProps.has(prop) && !whitelist.has(prop)) {
        pluginGlobals.set(prop, value);
        // K-7: generate_interceptor 桥接 —— ST 扩展约定在自身 index.js 顶层执行
        // globalThis[manifest.generate_interceptor] = fn 注册生成拦截器（如
        // vectors_rearrangeChat），主运行时 runGenerationInterceptorsCompat 从真实
        // window 读取。沙箱隔离导致函数存于 pluginGlobals、主运行时不可见 → 把
        // 函数值同步镜像到共享桥接表（__stPluginGlobalBridge），不污染真实 window。
        if (typeof value === 'function') {
          try {
            const g = globalThis as any;
            const bridge = g.__stPluginGlobalBridge ?? (g.__stPluginGlobalBridge = {});
            bridge[prop] = value;
          } catch { /* 桥接失败不影响插件执行 */ }
        }
      }
      // 受保护属性和白名单属性的写入静默忽略
      return true;
    },
    has(_target, prop) {
      if (typeof prop === 'string' && (whitelist.has(prop) || pluginGlobals.has(prop))) {
        return true;
      }
      return false;
    },
  };

  sandboxedWindow = new Proxy(window, handler) as Window;
  // 注册沙箱化 window 到模块级 proxyToRaw，使 unwrapSandboxedElement 能将其解包为原始 window。
  // 否则插件调用 $(window) 时，jQuery 会尝试对 Proxy 做 String()/Symbol.toPrimitive 转换，
  // 而 window Proxy 没有有效的 primitive 转换 → 抛出 "Cannot convert object to primitive value"。
  proxyToRaw.set(sandboxedWindow, window);
  return { sandboxedWindow, pluginGlobals };
}

/**
 * 沙箱网络/脚本加载白名单（S-1）。
 * 默认包含常见 CDN 域名，确保插件能加载外部依赖（GSAP、PIXI.js 等）。
 * fetch 与 fake script 外部脚本加载共用同一套白名单判定。
 */
const DEFAULT_CDN_WHITELIST = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'raw.githubusercontent.com',
  'github.com',
];

/**
 * ST tokenizerType 枚举 → 后端 tokenizer 名称（tiktoken 编码名）。
 * ST 1.18.0 tokenizers.js:16-38 的枚举：NONE:0/GPT2:1/OPENAI:2/LLAMA:3/...
 * Palink 后端 /api/tokenizers/* 支持 cl100k_base/gpt2 等 tiktoken 编码名；
 * 其余枚举（LLAMA/MISTRAL 等）无对应 tiktoken 编码，返回 undefined 交给后端默认。
 */
function _stTokenizerTypeToName(tokenizerType?: number): string | undefined {
  switch (tokenizerType) {
    case 2: // OPENAI
      return 'cl100k_base';
    case 1: // GPT2
      return 'gpt2';
    default:
      return undefined;
  }
}

/**
 * 读取当前生效的域名白名单（默认 CDN + 用户配置，逗号分隔、去重）。
 * localStorage 不可用时仅返回默认白名单。
 */
function readPluginFetchWhitelist(): string[] {
  const whitelist = [...DEFAULT_CDN_WHITELIST];
  try {
    const raw = localStorage.getItem('palink_plugin_fetch_whitelist');
    if (raw) {
      const userWhitelist = raw
        .split(',')
        .map(d => d.trim().toLowerCase())
        .filter(Boolean);
      return [...new Set([...whitelist, ...userWhitelist])];
    }
  } catch {
    // localStorage 不可用时使用默认白名单
  }
  return whitelist;
}

/**
 * 沙箱 URL 白名单判定（S-1）。
 * 规则：同源 URL 恒放行；跨源 URL 仅当 hostname 命中白名单（默认 CDN + 用户配置）时放行。
 * 无效 URL 返回 false。供 createSandboxedFetch 与 fake script 外部脚本加载共用，
 * 亦导出给经典脚本运行时的 fetch 守卫（两路径共用同一套白名单配置）。
 */
export function isUrlAllowedByPluginWhitelist(url: string): boolean {
  try {
    const parsedUrl = new URL(url, window.location.href);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isSameOrigin = parsedUrl.origin === window.location.origin;
    if (isSameOrigin) return true;
    return readPluginFetchWhitelist().includes(hostname);
  } catch {
    return false;
  }
}

/**
 * 创建沙箱化的 fetch 代理
 * 记录请求日志，支持域名白名单（从 localStorage 读取 palink_plugin_fetch_whitelist）
 * 白名单为空时仅允许同源请求；白名单非空时允许白名单域名 + 同源
 */
function createSandboxedFetch(
  pluginId: string,
  pluginTemplates?: Array<{ path?: string; content?: string; missing?: boolean }>,
): (url: string, options?: RequestInit) => Promise<Response> {
  return (url: string, options?: RequestInit) => {
    const method = (options?.method as string) || 'GET';
    const timestamp = new Date().toISOString();
    // 记录请求日志（不阻塞）

    // P-6: 插件本地 HTML 模板 fetch 路由。
    // ST 插件（如 quick-reply）通过 fetch('/scripts/extensions/{name}/html/settings.html')
    // 加载自身模板（不走 renderExtensionTemplateAsync）。Palink 后端不服务该路径（401/404），
    // 此处从插件模板资源（context.pluginTemplates，zip 导入时已抓取）匹配并返回内容。
    if (method.toUpperCase() === 'GET' && typeof url === 'string') {
      const m = String(url).match(/\/scripts\/extensions\/[^/]+\/(.+)$/i);
      if (m && Array.isArray(pluginTemplates) && pluginTemplates.length > 0) {
        const wanted = normalizeTemplateName(m[1]);
        const found = pluginTemplates.find((t) => {
          if (!t || t.missing || typeof t.content !== 'string') return false;
          const p = normalizeTemplateName(String(t.path || ''));
          return p === wanted || p.endsWith('/' + wanted);
        });
        if (found?.content) {
          return Promise.resolve(new Response(found.content, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }));
        }
      }
    }

    console.warn(
      `[PluginSandbox] fetch 请求: plugin=${pluginId} method=${method} url=${url} time=${timestamp}`,
    );

    // S-1: 统一走沙箱白名单判定（同源 + 默认 CDN + 用户配置域名）
    if (!isUrlAllowedByPluginWhitelist(String(url ?? ''))) {
      return Promise.reject(
        new Error(
          `[PluginSandbox] 域名不在白名单中且非同源 (plugin=${pluginId}, url=${url})`,
        ),
      );
    }

    return fetch(url, options);
  };
}

/**
 * jQuery 兼容层类型定义
 * 使用 any 类型以保持灵活性，兼容 ST 插件的 jQuery 使用方式
 */
type JQueryLike = {
  length: number;
  [index: number]: Element;
  [key: string]: any;
};

/**
 * ST 标准挂载点 id 白名单。
 * 这些挂载点由 StPluginMountPoints 在 React 树渲染（不在插件私有 container 内），
 * ST 插件通过 $('#extensions_settings').append(...) 注入设置面板。
 * 沙箱 container 查不到时，对这些 id 回退查真实 document。
 * 列表与 StPluginMountPoints.tsx 的 EXTENSIONS_SETTINGS_CONTAINERS_1/2 对齐。
 */
const ST_MOUNT_POINT_IDS = new Set<string>([
  'extensions_settings',
  'extensions_settings2',
  'extensions_menu',
  'movingDivs',
  'top-settings-holder',
  // ST index.html 预置的扩展容器（extension_container div，如 quick-reply 的 #qr_container）
  'qr_container',
  // ST 1.18.0 #extensions_settings 标准子容器（第一列）
  'assets_container', 'typing_indicator_container', 'expressions_container',
  'sd_container', 'tts_container', 'rvc_container', 'stt_container',
  'audio_container', 'silence_container', 'objective_container', 'blip_container',
  'live2d_container', 'vrm_container', 'timelines_container', 'webllm_container',
  'rss_container',
  // ST 1.18.0 #extensions_settings2 标准子容器（第二列）
  'websearch_container', 'emulatorjs_container', 'qr_container',
  'translation_container', 'caption_container', 'idle_container', 'summarize_container',
  'hypebot_container', 'regex_container', 'vectors_container', 'randomizer_container',
  'chromadb_container', 'message_limit_container', 'injects_container',
  'accuweather_container', 'dice_container',
  // K-11: ST 1.18.0 wand 菜单（templates/wandMenu.html）——#extensionsMenu 及其容器组
  'extensionsMenu',
  'data_bank_wand_container', 'attach_file_wand_container', 'sd_wand_container',
  'caption_wand_container', 'gallery_wand_container', 'tts_wand_container',
  'screen_share_wand_container', 'prompt_inspector_wand_container',
  'emulatorjs_wand_container', 'notebook_wand_container', 'chess_wand_container',
  'token_counter_wand_container', 'dice_wand_container', 'objective_wand_container',
  'translate_wand_container',
]);

/**
 * ST 聊天区挂载点 id 白名单（Fix 2）。
 * 这些 id 由 React 在角色扮演聊天页渲染（#chat wrapper / 插件 overlay / 数据库面板），
 * 不在插件私有 container 内。sandboxedDocument 查不到时，对这些 id 回退查真实 document。
 */
const ST_CHAT_SELECTOR_IDS = new Set<string>([
  'chat',
  'gal-global-overlay',
  'galgame-database-container',
]);

/**
 * 判断 CSS 选择器是否匹配 ST 聊天白名单（Fix 2）。
 * 命中时 sandboxedDocument.querySelector/querySelectorAll 在 container 内查不到会回退真实 document。
 * 覆盖：.mes / .mes_text / [mesid] / #chat / #gal-global-overlay / #galgame-database-container
 * 及其组合选择器（如 .mes[mesid="2"] .mes_text）。
 */
function isStChatSelector(selector: string): boolean {
  if (typeof selector !== 'string' || selector.length === 0) return false;
  // 正则匹配 ST 聊天相关 token；用 \b 边界避免误匹配 .message 等同类前缀
  return /(?:^|[^a-zA-Z0-9_-])(\.mes\b|\.mes_text\b|\[mesid\b|#chat\b|#gal-global-overlay\b|#galgame-database-container\b)/.test(selector);
}

/**
 * 创建沙箱化的 jQuery 兼容层
 * $() 返回类似数组的集合对象，支持链式调用
 * 查询范围限制在插件的 extension container 内
 * $.fn 作为原型对象包含所有 jQuery 方法，支持插件扩展 $.fn.myMethod = function() {}
 */
function createSandboxedJQuery(
  container: HTMLElement,
  sandboxedDocument: Document,
  sandboxedFetch: (url: string, options?: RequestInit) => Promise<Response>,
): any {
  function $(selector: any, context?: any): JQueryLike {
    let elements: Element[] = [];

    if (typeof selector === 'function') {
      // $(document).ready(fn) 模式：立即执行
      selector.call(sandboxedDocument);
    } else if (typeof selector === 'string') {
      if (selector.trim().startsWith('<')) {
        // HTML 字符串：先经 DOMPurify 消毒再创建元素，防止 XSS
        const sanitized = sanitizeHtml(selector);
        const div = sandboxedDocument.createElement('div');
        div.innerHTML = sanitized;
        elements = Array.from(div.children) as Element[];
      } else {
        // CSS 选择器：在 context 或 sandboxedDocument 范围内查询
        const ctx = context || sandboxedDocument;
        elements = Array.from(ctx.querySelectorAll(selector)) as Element[];
        // ST 标准挂载点回退：沙箱 container 查不到时，回退查真实 document。
        // #extensions_settings 等挂载点由 StPluginMountPoints 在 React 树渲染，
        // 不在插件私有 container 内；ST 插件靠 $('#extensions_settings').append() 注入面板。
        // 回退返回真实 Element，后续 append/show 等方法会直接操作真实 DOM（符合 ST 插件预期）。
        if (elements.length === 0 && typeof selector === 'string') {
          const idMatch = selector.trim().match(/^#([\w-]+)$/);
          if (idMatch && ST_MOUNT_POINT_IDS.has(idMatch[1])) {
            const real = document.querySelectorAll(selector);
            if (real.length > 0) {
              elements = Array.from(real) as Element[];
            } else {
              // ST 预置扩展容器（如 #qr_container）：真实 document 无此元素时，
              // 在插件 mount 下惰性创建（幂等、全局唯一），$('#qr_container') 不落空
              const mount = document.getElementById('palink-plugin-mount');
              if (mount && !document.getElementById(idMatch[1])) {
                const created = document.createElement('div');
                created.id = idMatch[1];
                created.setAttribute('data-sandbox-created-container', '');
                mount.appendChild(created);
                elements = [created];
              }
            }
          }
        }
      }
    } else if (selector && selector.nodeType) {
      // DOM 元素（真实或 Proxy）
      elements = [selector];
    } else if (selector && selector.length !== undefined && typeof selector !== 'string') {
      // jQuery 对象或类数组
      elements = Array.from(selector) as Element[];
    }

    return createJQueryObject(elements);
  }

  /**
   * 创建 jQuery 集合对象
   * 通过 Object.create($.fn) 继承所有 jQuery 方法，支持 $.fn 扩展
   * 实例属性：length, elements, 索引, jquery, splice, Symbol.iterator
   */
  /**
   * 事件 handler 注册表（供 triggerHandler 使用）。
   *
   * 背景：$.on/$.one 实际经 addEventListener 注册（沙箱 Proxy 元素上无法可靠挂
   * _handlers 属性），此前 triggerHandler 读取 el._handlers 恒为空 → 手动触发
   * 处理器完全失效。此处用 WeakMap 按 (元素, 事件名) 记录原始 handler，
   * on/one 注册、off 移除、triggerHandler 读取，与 jQuery 语义对齐。
   */
  const handlerRegistry = new WeakMap<Element, Map<string, Set<Function>>>();
  // 委托监听器注册表：el → event → selector → wrappedHandler。
  // on(event, selector, handler) 注册的是 wrappedHandler 闭包，off 三参形式若直接
  // removeEventListener(actualHandler) 永远匹配不到 → 委托处理器泄漏、反复 on/off 堆叠。
  const delegatedRegistry = new WeakMap<Element, Map<string, Map<string, Function>>>();
  const registerHandler = (el: Element, ev: string, handler: Function) => {
    let byEvent = handlerRegistry.get(el);
    if (!byEvent) { byEvent = new Map(); handlerRegistry.set(el, byEvent); }
    let set = byEvent.get(ev);
    if (!set) { set = new Set(); byEvent.set(ev, set); }
    set.add(handler);
  };
  const unregisterHandler = (el: Element, ev: string, handler: Function) => {
    const byEvent = handlerRegistry.get(el);
    if (!byEvent) return;
    const set = byEvent.get(ev);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) byEvent.delete(ev);
  };
  const registerDelegated = (el: Element, ev: string, selector: string, wrapped: Function) => {
    let byEvent = delegatedRegistry.get(el);
    if (!byEvent) { byEvent = new Map(); delegatedRegistry.set(el, byEvent); }
    let bySelector = byEvent.get(ev);
    if (!bySelector) { bySelector = new Map(); byEvent.set(ev, bySelector); }
    bySelector.set(selector, wrapped);
  };
  const unregisterDelegated = (el: Element, ev: string, selector: string): Function | undefined => {
    const byEvent = delegatedRegistry.get(el);
    if (!byEvent) return undefined;
    const bySelector = byEvent.get(ev);
    if (!bySelector) return undefined;
    const wrapped = bySelector.get(selector);
    if (wrapped !== undefined) {
      bySelector.delete(selector);
      if (bySelector.size === 0) byEvent.delete(ev);
      return wrapped;
    }
    return undefined;
  };

  function createJQueryObject(elements: Element[]): JQueryLike {
    const obj: any = Object.create($.fn);
    obj.length = elements.length;
    obj.elements = elements;
    // 添加索引访问
    elements.forEach((el, i) => { obj[i] = el; });
    // jQuery 版本字符串
    obj.jquery = '3.6.0';
    // splice 方法（使 jQuery 对象更接近数组，支持 Array.isArray 检测等）
    obj.splice = Array.prototype.splice;
    // Symbol.iterator：支持 for...of 遍历
    obj[Symbol.iterator] = function* (this: any) {
      for (let i = 0; i < this.length; i++) {
        yield this[i];
      }
    };
    return obj;
  }

  // $.fn: jQuery 原型对象，包含所有实例方法
  // 插件可通过 $.fn.myMethod = function() { ... } 扩展，所有 jQuery 对象自动继承
  $.fn = {
    // 遍历方法
    each: function (this: any, fn: Function) {
      for (let i = 0; i < this.length; i++) {
        if (fn.call(this[i], i, this[i]) === false) break;
      }
      return this;
    },
    map: function (this: any, fn: Function) {
      const result: any[] = [];
      for (let i = 0; i < this.length; i++) {
        result.push(fn.call(this[i], i, this[i]));
      }
      return result;
    },
    get: function (this: any, index?: number) {
      if (index === undefined) return this.elements;
      let idx = index;
      if (idx < 0) idx = this.length + idx;
      return this.elements[idx];
    },
    toArray: function (this: any) {
      return this.elements.slice();
    },

    // 事件方法
    // on(event, handler) - 直接绑定
    // on(event, selector, handler) - 事件委托
    // 支持多事件 'click focus' 和命名空间 'click.ns'
    on: function (this: any, event: string, selectorOrHandler: any, handler?: any) {
      let actualSelector: string | null = null;
      let actualHandler: any;

      if (handler === undefined) {
        actualHandler = selectorOrHandler;
      } else {
        actualSelector = selectorOrHandler;
        actualHandler = handler;
      }

      // 支持多事件和命名空间: 'click.ns focus' → ['click', 'focus']
      const events = event.split(/\s+/).filter((e: string) => e).map((e: string) => e.split('.')[0]);

      events.forEach((ev: string) => {
        this.elements.forEach((el: Element) => {
          if (actualSelector) {
            // 事件委托：手动遍历 parentElement（受 Proxy 拦截，到达容器边界返回 null）
            // 避免使用原生 closest 方法，防止逃逸沙箱边界
            const wrappedHandler = (e: Event) => {
              let target: any = e.target;
              while (target) {
                if (target instanceof Element) {
                  try {
                    if (target.matches(actualSelector)) {
                      actualHandler.call(target, e);
                      break;
                    }
                  } catch { /* 选择器无效，跳过 */ }
                }
                target = (target as any).parentElement;
              }
            };
            el.addEventListener(ev, wrappedHandler);
            registerDelegated(el, ev, actualSelector, wrappedHandler);
          } else {
            el.addEventListener(ev, actualHandler);
            // 同步注册表，保证 triggerHandler 可触发直接绑定处理器
            registerHandler(el, ev, actualHandler);
          }
        });
      });
      return this;
    },
    // off(event, handler) - 移除直接绑定
    // off(event, selector, handler) - 移除委托（三参数形式）
    off: function (this: any, event: string, selectorOrHandler: any, handler?: any) {
      let actualSelector: string | null = null;
      let actualHandler: any;
      if (handler === undefined) {
        actualHandler = selectorOrHandler;
      } else {
        // 三参数形式 off(event, selector, handler)：移除委托处理器
        actualSelector = selectorOrHandler;
        actualHandler = handler;
      }

      const events = event.split(/\s+/).filter((e: string) => e).map((e: string) => e.split('.')[0]);
      events.forEach((ev: string) => {
        this.elements.forEach((el: Element) => {
          if (actualSelector) {
            // 委托：查注册表拿 wrappedHandler（直接 removeEventListener(actualHandler)
            // 匹配不到闭包）。查不到时降级尝试直接移除 handler（兼容旧行为）。
            const wrapped = unregisterDelegated(el, ev, actualSelector);
            if (wrapped) el.removeEventListener(ev, wrapped as EventListener);
            else el.removeEventListener(ev, actualHandler);
          } else {
            el.removeEventListener(ev, actualHandler);
            unregisterHandler(el, ev, actualHandler);
          }
        });
      });
      return this;
    },
    one: function (this: any, event: string, handler: EventListener) {
      this.elements.forEach((el: Element) => {
        const wrapped: EventListener = (e) => {
          handler(e);
          el.removeEventListener(event, wrapped);
          // 注册表存的是原始 handler（registerHandler(el, event, handler)），
          // 卸载时也应以 handler 为键移除，否则残留
          unregisterHandler(el, event, handler);
        };
        el.addEventListener(event, wrapped);
        // one 注册的是 wrapped 包装器（触发一次后自移除），triggerHandler 应触发原始 handler
        registerHandler(el, event, handler);
      });
      return this;
    },
    trigger: function (this: any, eventType: string) {
      this.elements.forEach((el: Element) => {
        el.dispatchEvent(new Event(eventType, { bubbles: true }));
      });
      return this;
    },
    // triggerHandler：手动触发绑定的事件处理器（不触发默认行为，不冒泡）
    triggerHandler: function (this: any, eventName: string, args?: any[]) {
      this.elements.forEach((el: Element) => {
        const byEvent = handlerRegistry.get(el);
        if (!byEvent) return;
        const handlers = byEvent.get(eventName);
        if (!handlers) return;
        handlers.forEach((h: any) => h.apply(el, args || []));
      });
      return this;
    },

    // 类操作
    addClass: function (this: any, cls: string) {
      this.elements.forEach((el: Element) => (el as HTMLElement).classList.add(cls));
      return this;
    },
    removeClass: function (this: any, cls: string) {
      this.elements.forEach((el: Element) => (el as HTMLElement).classList.remove(cls));
      return this;
    },
    toggleClass: function (this: any, cls: string) {
      this.elements.forEach((el: Element) => (el as HTMLElement).classList.toggle(cls));
      return this;
    },
    hasClass: function (this: any, cls: string) {
      return this.elements.some((el: Element) => (el as HTMLElement).classList.contains(cls));
    },

    // 内容操作
    html: function (this: any, content?: string) {
      if (content === undefined) return this.elements[0]?.innerHTML ?? '';
      const sanitized = sanitizeHtml(content);
      this.elements.forEach((el: Element) => { el.innerHTML = sanitized; });
      return this;
    },
    text: function (this: any, content?: string) {
      if (content === undefined) return this.elements[0]?.textContent ?? '';
      this.elements.forEach((el: Element) => { el.textContent = content; });
      return this;
    },
    val: function (this: any, value?: string) {
      if (value === undefined) return (this.elements[0] as any)?.value ?? '';
      this.elements.forEach((el: Element) => { (el as any).value = value; });
      return this;
    },

    // 属性操作
    attr: function (this: any, name: string, value?: string) {
      if (value === undefined) return this.elements[0]?.getAttribute(name) ?? null;
      this.elements.forEach((el: Element) => el.setAttribute(name, value));
      return this;
    },
    removeAttr: function (this: any, name: string) {
      this.elements.forEach((el: Element) => el.removeAttribute(name));
      return this;
    },
    prop: function (this: any, name: string, value?: any) {
      if (value === undefined) return (this.elements[0] as any)?.[name];
      this.elements.forEach((el: Element) => { (el as any)[name] = value; });
      return this;
    },
    removeProp: function (this: any, name: string) {
      this.elements.forEach((el: Element) => { try { delete (el as any)[name]; } catch { /* ignore */ } });
      return this;
    },
    // css：支持对象形式 .css({color:'red'})、getter .css('color')、setter .css('color','red')
    // 调用 getComputedStyle 前需 unwrapSandboxedElement，避免 Proxy 内部槽检查失败
    css: function (this: any, name: string | object, value?: any) {
      if (typeof name === 'object') {
        // 对象形式: .css({color: 'red', background: 'blue'})
        this.elements.forEach((el: Element) => {
          const rawEl = unwrapSandboxedElement(el) || el;
          Object.entries(name).forEach(([k, v]) => {
            (rawEl as HTMLElement).style[k as any] = v as any;
          });
        });
        return this;
      }
      if (value === undefined) {
        // getter
        if (this.elements.length === 0) return undefined;
        const rawEl = unwrapSandboxedElement(this.elements[0]) || this.elements[0];
        try {
          return getComputedStyle(rawEl as HTMLElement)[name as any];
        } catch {
          return '';
        }
      }
      // setter
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        (rawEl as HTMLElement).style[name as any] = value;
      });
      return this;
    },

    // DOM 操作
    append: function (this: any, content: any) {
      this.elements.forEach((el: Element) => {
        if (typeof content === 'string') {
          el.insertAdjacentHTML('beforeend', sanitizeHtml(content));
        } else if (content && content.nodeType) {
          el.appendChild(content);
        } else if (content && content.length !== undefined) {
          // jQuery 对象或类数组
          for (let i = 0; i < content.length; i++) {
            if (content[i] && content[i].nodeType) el.appendChild(content[i]);
          }
        }
      });
      return this;
    },
    prepend: function (this: any, content: any) {
      this.elements.forEach((el: Element) => {
        if (typeof content === 'string') {
          el.insertAdjacentHTML('afterbegin', sanitizeHtml(content));
        } else if (content && content.nodeType) {
          el.prepend(content);
        } else if (content && content.length !== undefined) {
          for (let i = content.length - 1; i >= 0; i--) {
            if (content[i] && content[i].nodeType) el.prepend(content[i]);
          }
        }
      });
      return this;
    },
    before: function (this: any, content: any) {
      this.elements.forEach((el: Element) => {
        if (typeof content === 'string') {
          el.insertAdjacentHTML('beforebegin', sanitizeHtml(content));
        } else if (content && content.nodeType) {
          (el as any).before(content);
        }
      });
      return this;
    },
    after: function (this: any, content: any) {
      this.elements.forEach((el: Element) => {
        if (typeof content === 'string') {
          el.insertAdjacentHTML('afterend', sanitizeHtml(content));
        } else if (content && content.nodeType) {
          (el as any).after(content);
        }
      });
      return this;
    },
    remove: function (this: any) {
      this.elements.forEach((el: Element) => { el.parentNode?.removeChild(el); });
      return this;
    },
    empty: function (this: any) {
      this.elements.forEach((el: Element) => { el.innerHTML = ''; });
      return this;
    },
    clone: function (this: any) {
      return createJQueryObject(this.elements.map((el: Element) => el.cloneNode(true) as Element));
    },
    replaceWith: function (this: any, content: any) {
      this.elements.forEach((el: Element) => {
        if (typeof content === 'string') {
          (el as HTMLElement).outerHTML = sanitizeHtml(content);
        } else if (content && content.nodeType) {
          (el as any).replaceWith(content);
        }
      });
      return this;
    },

    // 遍历方法
    find: function (this: any, selector: string) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        result.push(...Array.from(el.querySelectorAll(selector)));
      });
      return createJQueryObject(result);
    },
    filter: function (this: any, selector: string | Function) {
      if (typeof selector === 'function') {
        return createJQueryObject(this.elements.filter((el: Element, i: number) => (selector as Function).call(el, i, el)));
      }
      return createJQueryObject(this.elements.filter((el: Element) => {
        try { return (el as Element).matches(selector); } catch { return false; }
      }));
    },
    first: function (this: any) {
      return createJQueryObject(this.elements.slice(0, 1));
    },
    last: function (this: any) {
      return createJQueryObject(this.elements.slice(-1));
    },
    eq: function (this: any, index: number) {
      let idx = index;
      if (idx < 0) idx = this.elements.length + idx;
      return createJQueryObject(idx >= 0 && idx < this.elements.length ? [this.elements[idx]] : []);
    },
    parent: function (this: any) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        const p = el.parentElement;
        if (p && !result.includes(p)) result.push(p);
      });
      return createJQueryObject(result);
    },
    parents: function (this: any, selector?: string) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        let parent = el.parentElement;
        while (parent) {
          if (!selector || (parent as Element).matches(selector)) {
            if (!result.includes(parent)) result.push(parent);
          }
          parent = parent.parentElement;
        }
      });
      return createJQueryObject(result);
    },
    children: function (this: any, selector?: string) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        Array.from(el.children).forEach((child: Element) => {
          if (!selector || (child as Element).matches(selector)) {
            if (!result.includes(child)) result.push(child);
          }
        });
      });
      return createJQueryObject(result);
    },
    siblings: function (this: any, selector?: string) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        const parent = el.parentElement;
        if (parent) {
          Array.from(parent.children).forEach((sibling: Element) => {
            if (sibling !== el && (!selector || (sibling as Element).matches(selector))) {
              if (!result.includes(sibling)) result.push(sibling);
            }
          });
        }
      });
      return createJQueryObject(result);
    },
    // closest：手动遍历 parentElement（受 Proxy 拦截，到达容器边界返回 null）
    // 避免使用原生 closest 方法，防止逃逸沙箱边界
    closest: function (this: any, selector: string) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        let current: any = el;
        while (current) {
          if (current instanceof Element) {
            try {
              if (current.matches(selector)) {
                if (!result.includes(current)) result.push(current);
                break;
              }
            } catch { /* 选择器无效，跳过 */ }
          }
          current = (current as any).parentElement;
        }
      });
      return createJQueryObject(result);
    },
    next: function (this: any) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        const n = el.nextElementSibling;
        if (n && !result.includes(n)) result.push(n);
      });
      return createJQueryObject(result);
    },
    prev: function (this: any) {
      const result: Element[] = [];
      this.elements.forEach((el: Element) => {
        const p = el.previousElementSibling;
        if (p && !result.includes(p)) result.push(p);
      });
      return createJQueryObject(result);
    },

    // 显示控制
    show: function (this: any) {
      this.elements.forEach((el: Element) => { (el as HTMLElement).style.display = ''; });
      return this;
    },
    hide: function (this: any) {
      this.elements.forEach((el: Element) => { (el as HTMLElement).style.display = 'none'; });
      return this;
    },
    toggle: function (this: any) {
      this.elements.forEach((el: Element) => {
        const h = el as HTMLElement;
        h.style.display = h.style.display === 'none' ? '' : 'none';
      });
      return this;
    },

    // 动画方法：使用 CSS transition 实现简单动画
    animate: function (this: any, props: any, duration: number = 400, complete?: Function) {
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        const htmlEl = rawEl as HTMLElement;
        Object.entries(props).forEach(([prop, value]) => {
          htmlEl.style.transition = `${prop} ${duration}ms`;
          (htmlEl.style as any)[prop] = value;
        });
        if (complete) setTimeout(() => complete.call(el), duration);
      });
      return this;
    },
    fadeIn: function (this: any, duration: number = 400) {
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        const htmlEl = rawEl as HTMLElement;
        htmlEl.style.opacity = '0';
        htmlEl.style.display = '';
        htmlEl.style.transition = `opacity ${duration}ms`;
        // 强制重排，使 opacity:0 生效后再过渡到 1
        void htmlEl.offsetHeight;
        htmlEl.style.opacity = '1';
      });
      return this;
    },
    fadeOut: function (this: any, duration: number = 400) {
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        const htmlEl = rawEl as HTMLElement;
        htmlEl.style.transition = `opacity ${duration}ms`;
        htmlEl.style.opacity = '0';
        setTimeout(() => { htmlEl.style.display = 'none'; }, duration);
      });
      return this;
    },
    slideUp: function (this: any, duration: number = 400) {
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        const htmlEl = rawEl as HTMLElement;
        htmlEl.style.transition = `height ${duration}ms, overflow ${duration}ms`;
        htmlEl.style.overflow = 'hidden';
        htmlEl.style.height = '0';
        setTimeout(() => { htmlEl.style.display = 'none'; }, duration);
      });
      return this;
    },
    slideDown: function (this: any, duration: number = 400) {
      this.elements.forEach((el: Element) => {
        const rawEl = unwrapSandboxedElement(el) || el;
        const htmlEl = rawEl as HTMLElement;
        htmlEl.style.display = '';
        htmlEl.style.transition = `height ${duration}ms`;
        htmlEl.style.overflow = '';
        htmlEl.style.height = 'auto';
      });
      return this;
    },

    // data 方法
    data: function (this: any, key: string, value?: any) {
      if (value === undefined) {
        return this.elements[0] ? (this.elements[0] as any).dataset?.[key] : undefined;
      }
      this.elements.forEach((el: Element) => {
        if ((el as any).dataset) (el as any).dataset[key] = value;
      });
      return this;
    },

    // width/height
    width: function (this: any) {
      return this.elements[0] ? (this.elements[0] as HTMLElement).offsetWidth : 0;
    },
    height: function (this: any) {
      return this.elements[0] ? (this.elements[0] as HTMLElement).offsetHeight : 0;
    },

    // offset：调用 getBoundingClientRect 前需 unwrapSandboxedElement
    offset: function (this: any) {
      if (this.elements.length === 0) return { top: 0, left: 0 };
      const rawEl = unwrapSandboxedElement(this.elements[0]) || this.elements[0];
      const rect = (rawEl as HTMLElement).getBoundingClientRect();
      return { top: rect.top + window.scrollY, left: rect.left + window.scrollX };
    },
  };

  // 静态方法
  // $.ajax：支持字符串 URL 或 settings 对象，返回 jqXHR（兼容 Promise + done/fail）
  $.ajax = function (settings: any) {
    const url = typeof settings === 'string' ? settings : settings.url;
    const method = (typeof settings === 'object' ? settings.method || settings.type : 'GET') || 'GET';
    const data = typeof settings === 'object' ? settings.data : undefined;
    const dataType = typeof settings === 'object' ? settings.dataType : undefined;
    const headers: Record<string, string> = typeof settings === 'object' ? { ...(settings.headers || {}) } : {};

    // 设置 X-Requested-With 标识 Ajax 请求
    if (!headers['X-Requested-With']) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    // GET 请求序列化 data 到查询字符串
    let finalUrl = url;
    let body: any = undefined;
    if (data && method.toUpperCase() === 'GET') {
      const params = new URLSearchParams(data).toString();
      if (params) {
        finalUrl = url + (url.includes('?') ? '&' : '?') + params;
      }
    } else if (data) {
      body = typeof data === 'string' ? data : JSON.stringify(data);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const jqXHR: any = {
      status: 0,
      statusText: '',
      responseText: '',
      responseJSON: null,
      getResponseHeader: (_name: string) => null,
      getAllResponseHeaders: () => '',
    };

    // 使用标志位确保 error 回调只调用一次
    let errorCalled = false;
    const callError = (err: any) => {
      if (errorCalled) return;
      errorCalled = true;
      if (settings.error) {
        try { settings.error(jqXHR, 'error', err); } catch { /* ignore callback errors */ }
      }
    };

    const promise = sandboxedFetch(finalUrl, {
      method,
      headers,
      body,
    }).then(async (res: Response) => {
      jqXHR.status = res.status;
      jqXHR.statusText = res.statusText;

      if (!res.ok) {
        const text = await res.text();
        jqXHR.responseText = text;
        const error = new Error(`HTTP ${res.status}: ${res.statusText}`);
        callError(error);
        throw error;
      }

      let result: any;
      if (dataType === 'json') {
        result = await res.json();
        jqXHR.responseJSON = result;
      } else {
        result = await res.text();
        jqXHR.responseText = result;
      }

      if (settings.success) settings.success(result, 'success', jqXHR);
      return result;
    });
    // catch 仅用于将 error 回调的异常或 fetch 网络错误传播给 promise 链
    // 不再在此处调用 error 回调（已在 then 中通过 callError 处理）
    // promise 在 error 发生时正确 reject（throw 传播），确保 .catch() 能捕获

    // 返回 jqXHR 对象（兼容 Promise + jQuery done/fail 链式调用）
    const retVal: any = {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally ? promise.finally.bind(promise) : undefined,
      ...jqXHR,
    };
    retVal.done = (cb: any) => { promise.then(cb); return retVal; };
    retVal.fail = (cb: any) => { promise.catch(cb); return retVal; };
    return retVal;
  };

  $.get = (url: string, success?: Function) => {
    return $.ajax({ url, method: 'GET', success });
  };

  $.post = (url: string, data?: any, success?: Function) => {
    return $.ajax({ url, method: 'POST', data, success });
  };

  $.each = (arr: any, fn: Function) => {
    if (Array.isArray(arr) || arr && arr.length !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        if (fn.call(arr[i], i, arr[i]) === false) break;
      }
    } else if (typeof arr === 'object' && arr !== null) {
      for (const key in arr) {
        if (Object.prototype.hasOwnProperty.call(arr, key)) {
          if (fn.call(arr[key], key, arr[key]) === false) break;
        }
      }
    }
    return arr;
  };

  // $.extend：支持深拷贝（第一个参数为 true 时）
  $.extend = (targetOrDeep: any, ...args: any[]) => {
    let deep = false;
    let target = targetOrDeep;
    if (typeof targetOrDeep === 'boolean') {
      deep = targetOrDeep;
      target = args.shift();
    }
    for (const source of args) {
      if (source && typeof source === 'object') {
        for (const key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) {
            if (deep && source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
              target[key] = $.extend(true, target[key] && typeof target[key] === 'object' ? target[key] : {}, source[key]);
            } else if (deep && Array.isArray(source[key])) {
              target[key] = $.extend(true, Array.isArray(target[key]) ? target[key] : [], source[key]);
            } else {
              target[key] = source[key];
            }
          }
        }
      }
    }
    return target;
  };

  // $.parseHTML：将 HTML 字符串解析为 DOM 节点数组（经 DOMPurify 消毒）
  $.parseHTML = (htmlString: string) => {
    const sanitized = sanitizeHtml(String(htmlString));
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    return Array.from(template.content.childNodes);
  };

  // $.Deferred：基于 Promise 的 Deferred 对象
  $.Deferred = () => {
    let resolve: (value?: any) => void;
    let reject: (reason?: any) => void;
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    return {
      promise: () => promise,
      resolve: (value?: any) => resolve(value),
      reject: (reason?: any) => reject(reason),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
    };
  };

  // $.when：等待多个 Promise 完成
  $.when = (...promises: any[]) => Promise.all(promises);

  // $.param：将对象序列化为 URL 编码字符串
  $.param = (obj: any) => {
    return new URLSearchParams(obj).toString();
  };

  $.type = (obj: any) => {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';
    return Object.prototype.toString.call(obj).slice(8, -1).toLowerCase();
  };
  $.isArray = Array.isArray;
  $.isFunction = (obj: any) => typeof obj === 'function';
  $.isPlainObject = (obj: any) => {
    if (typeof obj !== 'object' || obj === null) return false;
    return Object.getPrototypeOf(obj) === Object.prototype;
  };
  $.trim = (str: string) => String(str).trim();
  $.now = () => Date.now();
  $.isEmptyObject = (obj: any) => {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) return false;
    }
    return true;
  };
  $.inArray = (value: any, arr: any[], from?: number) => {
    return arr.indexOf(value, from || 0);
  };
  $.grep = (arr: any[], fn: Function) => arr.filter((el, i) => fn.call(arr, el, i));
  $.map = (arr: any[], fn: Function) => arr.map((el, i) => fn.call(arr, el, i));

  return $;
}

/**
 * 将 ST 插件传入的 popup 类型映射到 Palink PopupType
 * 支持字符串（TEXT/CONFIRM/INPUT/DISPLAY）和数字（1-4）两种形式
 */
function mapSandboxPopupType(type?: string | number): PopupType {
  if (typeof type === 'number') {
    switch (type) {
      case 2: return PopupType.CONFIRM;
      case 3: return PopupType.INPUT;
      case 4: return PopupType.DISPLAY;
      default: return PopupType.TEXT;
    }
  }
  const value = String(type || '').toUpperCase();
  if (value.includes('CONFIRM')) return PopupType.CONFIRM;
  if (value.includes('INPUT')) return PopupType.INPUT;
  if (value.includes('DISPLAY')) return PopupType.DISPLAY;
  return PopupType.TEXT;
}

// ============================================================
// ESM → CommonJS 转译（Task 2.1）
// 将 ST 扩展的 import/export 语法转换为 require/module.exports，
// 使其能在 new Function 沙箱中执行（方案 B：转译，无需 blob URL / CSP 修改）
// ============================================================

/**
 * 规范化模块路径：移除相对路径前缀，统一为 ST scripts 目录下的相对路径
 * 例：'../../../script.js' → 'script.js'
 *     '../../extensions.js' → 'extensions.js'
 *     '../../slash-commands/SlashCommand.js' → 'slash-commands/SlashCommand.js'
 *     '/scripts/macros.js' → 'macros.js'
 */
function normalizeModulePath(importPath: string): string {
  let p = String(importPath || '');
  p = p.replace(/^\.?\/+/, '');      // 移除 ./ 或 /
  p = p.replace(/^(\.\.\/)+/, '');    // 移除 ../ 序列
  p = p.replace(/^scripts\//, '');     // 移除 scripts/ 前缀
  return p;
}

/**
 * 规范化插件本地文件路径：移除前导 ./ 与 /，保留子目录。
 * 例：'./core/constants.js' → 'core/constants.js'；'/index.js' → 'index.js'
 * 用于把 resources.js 里的每个文件登记进本地模块表。
 */
function normalizeLocalPath(localPath: string): string {
  return String(localPath || '').replace(/^\.\//, '').replace(/^\//, '');
}

/** 取文件所在目录（不含文件名）。'core/constants.js' → 'core'；'index.js' → '' */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/**
 * 以 baseDir 为基准解析相对路径（支持 ./ 与 ../），返回规范化后的插件内路径。
 * 例：baseDir='core', rel='../shared/util.js' → 'shared/util.js'
 *     baseDir='',    rel='./core/constants.js' → 'core/constants.js'
 */
function joinLocalPaths(baseDir: string, rel: string): string {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 解析命名导入绑定列表，将 `as` 转换为解构语法
 * 例：'a, b as c, d' → ['a', 'b: c', 'd']（'b as c' 转为 'b: c' 用于解构）
 */
function parseNamedBindings(bindings: string): string[] {
  return String(bindings)
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => {
      const m = s.match(/^(\w+)\s+as\s+(\w+)$/);
      return m ? `${m[1]}: ${m[2]}` : s;
    });
}

/**
 * 将 ESM import/export 语法转译为 CommonJS require/module.exports
 *
 * 支持的语法：
 *   - import { a, b as c } from 'path'
 *   - import defaultExport from 'path'
 *   - import * as ns from 'path'
 *   - import defaultExport, { a, b } from 'path'
 *   - import 'path'  (side-effect)
 *   - export default X
 *   - export const/let/var X = value
 *   - export function / async function X() {}
 *   - export class X {}
 *   - export { a, b as c }
 *   - export { a } from 'path'  (re-export)
 *   - export * from 'path'  (re-export all)
 *
 * 已知限制（记录警告但不阻塞）：
 *   - top-level await（需异步入口，ST 扩展不使用）
 *   - 多变量 export const（export const X = 1, Y = 2 仅导出 X）
 *
 * 字符串/注释保护：import/export 关键字经常出现在酒馆助手脚本的字符串字面量
 * （如 HTML 模板里的 onclick="import('xxx')"）或注释里。若不剥离，正则会误替换
 * 字符串内的 import/export，破坏引号配对，导致 SyntaxError: missing ) after argument list。
 * 方案：ESM 顶层语句必须出现在行首（前面只有空白），用 ^\s* 锚定 + m flag，
 * 天然跳过字符串/注释内的 import/export（它们不在行首）。
 */
function transpileEsmToCommonJS(code: string): string {
  // 先检测是否含 ESM 顶层语句（必须出现在行首，前面只允许空白）。
  // 不能用 \b(import|export)\b —— 酒馆助手打包脚本（IIFE/UMD）在 HTML 模板
  // 字符串、DOM id（如 #bam-btn-import）、变量名（importBtn）、注释里大量
  // 出现 import/export 单词，但都不是 ESM 语句。若据此进入转译，规则 6/7/10
  // 会误替换字符串内的关键字，破坏引号配对 → SyntaxError: missing ) after argument list。
  // 真正的 ESM 模块 import/export 必定在行首（顶层语句），用 ^\s* 锚定即可区分。
  if (!/^\s*(import|export)\b/m.test(code)) {
    return code;
  }
  let result = code;
  const hoistedExports: string[] = [];

  // 0. re-export all: export * from 'path'
  result = result.replace(
    /^\s*export\s*\*\s*from\s*(['"])([^'"]+)\1\s*;?/gm,
    (_m, _q, path) => `Object.assign(module.exports, require(${JSON.stringify(path)}));`,
  );

  // 1. re-export named: export { a, b as c } from 'path'
  result = result.replace(
    /^\s*export\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"])([^'"]+)\2\s*;?/gm,
    (_m, bindings, _q, path) => {
      const items = parseNamedBindings(bindings);
      const stmt = `var { ${items.join(', ')} } = require(${JSON.stringify(path)});`;
      const exps = items.map(item => {
        const name = item.includes(':') ? item.split(':')[1].trim() : item;
        return `module.exports.${name} = ${name};`;
      }).join(' ');
      return `${stmt} ${exps}`;
    },
  );

  // 2. namespace import: import * as ns from 'path'
  result = result.replace(
    /^\s*import\s*\*\s*as\s+(\w+)\s+from\s*(['"])([^'"]+)\2\s*;?/gm,
    (_m, name, _q, path) => `var ${name} = require(${JSON.stringify(path)});`,
  );

  // 3. default + named import: import D, { a, b as c } from 'path'
  result = result.replace(
    /^\s*import\s+(\w+)\s*,\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"])([^'"]+)\3\s*;?/gm,
    (_m, defName, bindings, _q, path) => {
      const names = parseNamedBindings(bindings);
      const varName = `__mod_${defName}`;
      let out = `var ${varName} = require(${JSON.stringify(path)}); `;
      out += `var ${defName} = ${varName}.default !== undefined ? ${varName}.default : ${varName};`;
      if (names.length > 0) {
        out += ` var { ${names.join(', ')} } = ${varName};`;
      }
      return out;
    },
  );

  // 4. default import: import D from 'path'
  result = result.replace(
    /^\s*import\s+(\w+)\s+from\s*(['"])([^'"]+)\2\s*;?/gm,
    (_m, name, _q, path) =>
      `var ${name} = (() => { var __m = require(${JSON.stringify(path)}); return __m.default !== undefined ? __m.default : __m; })();`,
  );

  // 5. named import: import { a, b as c } from 'path'
  result = result.replace(
    /^\s*import\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"])([^'"]+)\2\s*;?/gm,
    (_m, bindings, _q, path) => {
      const names = parseNamedBindings(bindings);
      return `var { ${names.join(', ')} } = require(${JSON.stringify(path)});`;
    },
  );

  // 6. side-effect import: import 'path'  (行首锚定，避免误匹配字符串内的 import")
  result = result.replace(
    /^\s*import\s*(['"])([^'"]+)\1\s*;?/gm,
    (_m, _q, path) => `require(${JSON.stringify(path)});`,
  );

  // 7. export default X  →  module.exports.default = X  (行首锚定)
  result = result.replace(
    /^\s*export\s+default\s+/gm,
    'module.exports.default = ',
  );

  // 8. export const/let/var X = value  →  const X = module.exports.X = value
  result = result.replace(
    /^\s*export\s+(const|let|var)\s+(\w+)\s*=/gm,
    (_m, kind, name) => `${kind} ${name} = module.exports.${name} =`,
  );

  // 8b. export const/let/var X;  (无初始化声明)  →  let X; module.exports.X = X
  // quick-reply/index.js:52 `export let quickReplyApi;` 踩中：旧规则 8 只匹配带 `=` 的
  // 初始化形式，无初始化声明残留 export 关键字 → new Function 抛 SyntaxError。
  result = result.replace(
    /^\s*export\s+(const|let|var)\s+(\w+)\s*;/gm,
    (_m, kind, name) => `${kind} ${name};\nmodule.exports.${name} = ${name};`,
  );

  // 9. export function / async function X  (记录名称，提升到末尾导出)
  result = result.replace(
    /^\s*export\s+(async\s+)?function\s+(\w+)/gm,
    (_m, asyncKw, name) => {
      hoistedExports.push(name);
      return `${asyncKw || ''}function ${name}`;
    },
  );

  // 10. export class X  (行首锚定)
  result = result.replace(
    /^\s*export\s+class\s+(\w+)/gm,
    (_m, name) => {
      hoistedExports.push(name);
      return `class ${name}`;
    },
  );

  // 11. export { a, b as c }  (without from)
  result = result.replace(
    /^\s*export\s*\{\s*([^}]+?)\s*\}/gm,
    (_m, bindings) => {
      return parseNamedBindings(bindings)
        .map(item => {
          if (item.includes(':')) {
            const parts = item.split(':').map(s => s.trim());
            return `module.exports.${parts[1]} = ${parts[0]};`;
          }
          return `module.exports.${item} = ${item};`;
        })
        .join(' ');
    },
  );

  // 追加函数/类导出（提升到末尾，确保声明已执行）
  if (hoistedExports.length > 0) {
    result += '\n' + hoistedExports.map(n => `module.exports.${n} = ${n};`).join('\n');
  }

  return result;
}

/**
 * 插件沙箱 — 隔离执行 ST 扩展 JS 代码
 *
 * 安全策略：
 * - 使用 Function 构造器创建隔离作用域
 * - 提供受限的全局对象（不暴露敏感 API 的直接访问）
 * - 捕获执行错误，记录到日志，不影响主应用
 * - 插件卸载时自动清理所有注册的资源
 */
export class PluginSandbox {
  /** 已加载的插件模块（pluginId → module exports） */
  private loadedModules: Map<string, Record<string, unknown>> = new Map();

  /** 已注入的 CSS style 元素（pluginId → HTMLStyleElement） */
  private injectedStyles: Map<string, HTMLStyleElement> = new Map();

  /** 插件注册的清理函数（pluginId → cleanup callbacks） */
  private cleanupCallbacks: Map<string, Array<() => void>> = new Map();

  /**
   * 安全执行插件 JS 代码
   *
   * @param code 插件 JS 源码
   * @param context 插件上下文（getContext 兼容对象）
   * @param pluginId 插件唯一标识
   * @returns 插件模块导出对象
   */
  async executePluginCode(
    code: string,
    context: PluginContext | PluginContextWithHooks,
    pluginId: string,
    entryPath?: string,
    localFiles?: Array<{ path: string; content: string }>,
  ): Promise<Record<string, unknown>> {
    // transpiledCode/wrappedCode 需在 try 之外声明：catch 诊断分支要引用它们，
    // 块级 const 在 catch 块不可见（此前诊断永远取不到值，且 tsc 报 Cannot find name）
    let transpiledCode = '';
    let wrappedCode = '';
    try {
      // 重置本地模块缓存，避免跨插件泄漏
      this.pluginLocalFiles.clear();
      this.pluginLocalExports.clear();
      // 登记插件自带的多文件模块（用于解析 ./core/xxx.js 等本地 import）
      if (Array.isArray(localFiles)) {
        for (const f of localFiles) {
          if (!f || typeof f.content !== 'string') continue;
          this.pluginLocalFiles.set(normalizeLocalPath(f.path), f.content);
        }
      }
      const entryBaseDir = dirOf(normalizeLocalPath(entryPath || 'index.js'));

      // 创建受限的沙箱环境
      const sandboxGlobal = this.createSandboxGlobal(context, pluginId, entryBaseDir);

      // 将 ESM import/export 转译为 CommonJS require/module.exports（Task 2.1）
      // 转译后插件代码通过 require('script.js') 等访问 ST 兼容模块
      transpiledCode = transpileEsmToCommonJS(code);

      // 使用 Function 构造器创建隔离作用域
      // 将沙箱全局对象作为参数传入，插件代码通过参数访问
      wrappedCode = this.buildWrappedCode(transpiledCode);

      const executor = new Function(wrappedCode);
      const moduleExports = executor(sandboxGlobal) || {};

      this.loadedModules.set(pluginId, moduleExports);
      return moduleExports;
    } catch (error) {
      console.error(`[PluginSandbox] 插件 ${pluginId} 执行失败:`, error);
      // SyntaxError 诊断：new Function 抛错时不带行号，需手动 dump 代码上下文
      // 常见根因：transpileEsmToCommonJS 正则误替换字符串/注释里的 import/export；
      // 或插件 bundle 含 new Function 不支持的语法（JSX/TS 类型注解/顶层 await）
      if (error instanceof SyntaxError) {
        try {
          (window as any).__lastPluginError = {
            pluginId,
            error,
            rawCodeLength: code.length,
            transpiledLength: transpiledCode.length,
            wrappedLength: wrappedCode.length,
            rawCodeHead: code.slice(0, 800),
            rawCodeTail: code.slice(-800),
            transpiledHead: transpiledCode.slice(0, 800),
            transpiledTail: transpiledCode.slice(-800),
            wrappedHead: wrappedCode.slice(0, 800),
            wrappedTail: wrappedCode.slice(-800),
          };
          console.error('[PluginSandbox] SyntaxError 诊断已写入 window.__lastPluginError');
          console.error('[PluginSandbox] 原始代码长度=', code.length, '转译后长度=', transpiledCode.length, '包装后长度=', wrappedCode.length);
          console.error('[PluginSandbox] 转译后代码开头 800 字符:\n', transpiledCode.slice(0, 800));
          console.error('[PluginSandbox] 转译后代码结尾 800 字符:\n', transpiledCode.slice(-800));
        } catch {}
      }
      throw error;
    }
  }

  /** 插件本地模块表：规范化路径 → 文件内容 */
  private pluginLocalFiles: Map<string, string> = new Map();
  /** 插件本地模块导出缓存：规范化路径 → module.exports（支持循环依赖） */
  private pluginLocalExports: Map<string, Record<string, unknown>> = new Map();

  /**
   * 构造插件执行外壳（入口与本地模块共用同一套受限全局）
   */
  private buildWrappedCode(transpiledCode: string): string {
    return `
        var eval = function() {
          throw new TypeError('eval is disabled in sandbox');
        };
        var Function = function() {
          throw new TypeError('Function constructor is disabled in sandbox');
        };
        var module = { exports: {} };
        var exports = module.exports;
        var __sandbox = arguments[0];
        var require = __sandbox.require;
        var getContext = __sandbox.getContext;
        var eventSource = __sandbox.eventSource;
        var eventTypes = __sandbox.eventTypes;
        var registerSlashCommand = __sandbox.registerSlashCommand;
        var registerMacro = __sandbox.registerMacro;
        var registerHook = __sandbox.registerHook;
        var registerFunctionTool = __sandbox.registerFunctionTool;
        var registerEndpoint = __sandbox.registerEndpoint;
        var registerContextSetter = __sandbox.registerContextSetter;
        var setExtensionPrompt = __sandbox.setExtensionPrompt;
        var getExtensionSettings = __sandbox.getExtensionSettings;
        var writeExtensionField = __sandbox.writeExtensionField;
        var substituteParams = __sandbox.substituteParams;
        var messageFormatting = __sandbox.messageFormatting;
        var callGenericPopup = __sandbox.callGenericPopup;
        var Popup = __sandbox.Popup;
        var POPUP_TYPE = __sandbox.POPUP_TYPE;
        var toastr = __sandbox.toastr;
        var console = __sandbox.console;
        var fetch = __sandbox.fetch;
        var document = __sandbox.document;
        var window = __sandbox.window;
        var $ = __sandbox.$;
        var jQuery = __sandbox.jQuery;
        // ST 1.18.0 全局：插件通过 extension_settings[namespace] 读写共享设置（沙箱已做成共享 Proxy）
        var extension_settings = __sandbox.extension_settings;
        var Handlebars = __sandbox.Handlebars;
        var marked = __sandbox.marked;
        var DOMPurify = __sandbox.DOMPurify;
        var localStorage = __sandbox.localStorage;
        var sessionStorage = __sandbox.sessionStorage;
        var setTimeout = __sandbox.setTimeout;
        var setInterval = __sandbox.setInterval;
        var clearTimeout = __sandbox.clearTimeout;
        var clearInterval = __sandbox.clearInterval;
        // ===== 酒馆助手(JS-Slash-Runner)兼容全局 API =====
        var eventOn = __sandbox.eventOn;
        var eventOff = __sandbox.eventOff;
        var eventEmit = __sandbox.eventEmit;
        var eventRemoveListener = __sandbox.eventRemoveListener;
        var tavern_events = __sandbox.tavern_events;
        var iframe_events = __sandbox.iframe_events;
        var getButtonEvent = __sandbox.getButtonEvent;
        var getVariables = __sandbox.getVariables;
        var setVariables = __sandbox.setVariables;
        var getVariable = __sandbox.getVariable;
        var setVariable = __sandbox.setVariable;
        var deleteVariable = __sandbox.deleteVariable;
        var insertOrAssignVariables = __sandbox.insertOrAssignVariables;
        var replaceVariables = __sandbox.replaceVariables;
        var getChatMessages = __sandbox.getChatMessages;
        var getLastMessageId = __sandbox.getLastMessageId;
        var triggerSlash = __sandbox.triggerSlash;
        var generateRaw = __sandbox.generateRaw;
        var openCharacterChat = __sandbox.openCharacterChat;
        var substitudeMacros = __sandbox.substitudeMacros;
        var generate = __sandbox.generate;
        var injectPrompts = __sandbox.injectPrompts;
        var uninjectPrompts = __sandbox.uninjectPrompts;
        var setChatMessages = __sandbox.setChatMessages;
        var deleteChatMessages = __sandbox.deleteChatMessages;
        var getCharacter = __sandbox.getCharacter;
        var getCurrentCharacterName = __sandbox.getCurrentCharacterName;
        var getCurrentCharacterId = __sandbox.getCurrentCharacterId;
        var getCharacterNames = __sandbox.getCharacterNames;
        var getCharData = __sandbox.getCharData;
        var getCharAvatarPath = __sandbox.getCharAvatarPath;
        var getWorldbook = __sandbox.getWorldbook;
        var getGlobalWorldbookNames = __sandbox.getGlobalWorldbookNames;
        var saveWorldInfoToChat = __sandbox.saveWorldInfoToChat;
        var removeWorldInfoFromChat = __sandbox.removeWorldInfoFromChat;
        var getWorldInfoData = __sandbox.getWorldInfoData;
        var checkWorldInfo = __sandbox.checkWorldInfo;
        var createOrReplaceWorldbook = __sandbox.createOrReplaceWorldbook;
        var createOrReplaceCharWorldbook = __sandbox.createOrReplaceCharWorldbook;
        var getMessageId = __sandbox.getMessageId;
        var formatAsDisplayedMessage = __sandbox.formatAsDisplayedMessage;
        var refreshOneMessage = __sandbox.refreshOneMessage;
        var retrieveDisplayedMessage = __sandbox.retrieveDisplayedMessage;
        var errorCatched = __sandbox.errorCatched;
        var getTavernHelperVersion = __sandbox.getTavernHelperVersion;
        var getTavernVersion = __sandbox.getTavernVersion;
        var registerMacroLike = __sandbox.registerMacroLike;
        var unregisterMacroLike = __sandbox.unregisterMacroLike;
        var TavernHelper = __sandbox.window.TavernHelper;
        try {
          (function() {
            'use strict';
            // ===== S-1: Function 构造器原型链拦截 =====
            // new Function 作用域内 var Function 遮蔽可被
            // (function(){}).constructor('return this')() 绕过（函数对象的 .constructor
            // 沿原型链指向真实 Function.prototype.constructor）。
            // 把 Function.prototype.constructor 替换为抛错函数后，所有内置函数
            // （Object/Array/String/RegExp/Date/Promise...）的 .constructor 链
            // 最终都命中它 → x.constructor.constructor('code') 一律抛 TypeError。
            // 对象自身（{}.constructor === Object、[].constructor === Array 等）来自
            // 各自 prototype 的 constructor 属性，不受影响，插件类型判断不破坏。
            try {
              var __sandboxThrowCtor = function () {
                throw new TypeError('Function constructor is disabled in sandbox');
              };
              Object.defineProperty((function () {}).__proto__, 'constructor', {
                value: __sandboxThrowCtor,
                writable: true,
                configurable: true,
              });
            } catch (e) { /* 拦截失败不阻塞插件执行（残余风险由 fetch/词法白名单兜底） */ }
            // ===== S-1: 词法逃逸遮蔽补全 =====
            // 此前仅遮蔽 window/document/fetch 等显式声明的标识符；self/top/parent/
            // globalThis/WebSocket/indexedDB/XMLHttpRequest/navigator 等自由变量在
            // new Function 中解析到真实全局对象 → 沙箱逃逸。逐一补全为沙箱安全值。
            var self = __sandbox.window;
            var top = __sandbox.window;
            var parent = __sandbox.window;
            var globalThis = __sandbox.window;
            var frames = __sandbox.window;
            var opener = null;
            var name = '';
            var location = __sandbox.window.location;
            var navigator = __sandbox.window.navigator;
            var screen = __sandbox.window.screen;
            var history = __sandbox.window.history;
            var crypto = __sandbox.window.crypto;
            var performance = __sandbox.window.performance;
            var requestAnimationFrame = __sandbox.window.requestAnimationFrame;
            var cancelAnimationFrame = __sandbox.window.cancelAnimationFrame;
            var addEventListener = __sandbox.window.addEventListener;
            var removeEventListener = __sandbox.window.removeEventListener;
            // WebSocket 为同源包装（见 createSandboxedWindow），拒绝跨源连接
            var WebSocket = __sandbox.window.WebSocket;
            // 高风险/无白名单的全局 API 一律禁用（与 sandboxedWindow 白名单一致）
            var XMLHttpRequest = undefined;
            var indexedDB = undefined;
            // 原生弹窗/窗口/消息 API stub（见 sandbox 对象）
            var alert = __sandbox.alert;
            var confirm = __sandbox.confirm;
            var prompt = __sandbox.prompt;
            var open = __sandbox.open;
            var close = __sandbox.close;
            var postMessage = __sandbox.postMessage;
            ${transpiledCode}
          })();
        } catch (e) {
          __sandbox.onError(e);
        }
        return module.exports;
      `;
  }

  /**
   * 执行插件本地模块文件（同步），供 require 惰性加载。
   * 与入口共用 buildWrappedCode 的受限环境，仅 require 指向基于本文件目录的解析器。
   */
  private evalLocalFile(
    localKey: string,
    content: string,
    fileRequire: (importPath: string) => Record<string, unknown>,
    context: PluginContext | PluginContextWithHooks,
    pluginId: string,
  ): Record<string, unknown> {
    try {
      const transpiled = transpileEsmToCommonJS(content);
      const sandboxGlobal = this.createSandboxGlobal(context, pluginId);
      (sandboxGlobal as Record<string, unknown>).require = fileRequire;
      const executor = new Function(this.buildWrappedCode(transpiled));
      return executor(sandboxGlobal) || {};
    } catch (error) {
      console.error(`[PluginSandbox] 本地模块 ${localKey} 执行失败 (plugin=${pluginId}):`, error);
      return {};
    }
  }

  /**
   * 创建沙箱全局对象
   */
  private createSandboxGlobal(
    context: PluginContext | PluginContextWithHooks,
    pluginId: string,
    entryBaseDir: string = '',
  ): Record<string, unknown> {
    const self = this;
    const contextWithHooks = context as PluginContextWithHooks;

    // 创建沙箱化的 fetch 代理（先创建，因为 document 的 fake script 元素需要它加载外部脚本）
    // P-6: 传入插件模板资源，支持 fetch('/scripts/extensions/{name}/html/xxx.html') 本地路由
    const pluginTemplatesForFetch = (context as unknown as Record<string, unknown>).pluginTemplates as
      | Array<{ path?: string; content?: string; missing?: boolean }>
      | undefined;
    const sandboxedFetch = createSandboxedFetch(pluginId, pluginTemplatesForFetch);
    // 创建沙箱化的全局对象代理（收紧 document/window/fetch 访问）
    const sandboxedDocResult = createSandboxedDocument(pluginId, sandboxedFetch);
    const sandboxedDocument = sandboxedDocResult.document;
    const wrapSandboxedElement = sandboxedDocResult.wrapSandboxedElement;
    const sandboxedLocalStorage = createSandboxedStorage(context);
    // sessionStorage 使用独立的内存存储，与 localStorage 分离，避免互相覆盖
    const sandboxedSessionStorage = createSandboxedSessionStorage();
    const { sandboxedWindow, pluginGlobals } = createSandboxedWindow(
      pluginId,
      sandboxedDocument,
      sandboxedFetch,
      sandboxedLocalStorage,
      sandboxedSessionStorage,
      wrapSandboxedElement,
    );

    // jQuery 沙箱化：实现完整 jQuery 兼容层，查询范围限制在插件 extension container
    // $() 返回类似数组的集合对象，支持链式调用和 ST 插件的 jQuery 使用方式
    const container = getOrCreatePluginExtensionContainer(pluginId);
    const sandboxedJQuery = createSandboxedJQuery(container, sandboxedDocument, sandboxedFetch);

    // 真实 jQuery 包装层：插件通过 var $ = __sandbox.$ 拿到的是这个包装函数。
    // 真实 jQuery 的 $(selector) init 在收到沙箱化 Proxy（document/element）时，
    // 会尝试 String(selector) 等隐式 primitive 转换；Proxy 的 [Symbol.toPrimitive]
    // 可能返回对象 → "Cannot convert object to primitive value"。
    // 这里在调用前把 Proxy 参数解包为原始 Node，再交给真实 jQuery。
    const wrappedJQuery = function (selector: any, context?: any) {
      // $(fn) 模式：等价于 $(document).ready(fn)，立即执行
      // 注意：必须在 unwrapSandboxedElement 之前检查 typeof === 'function'，
      // 因为函数类型的 Proxy 解包后仍是 Proxy，typeof 仍为 'function'，但
      // 直接调用更安全。传给 jQuery 的是原始 document（非 sandboxedDocument Proxy），
      // 避免 jQuery 内部对 Proxy 做 String()/Symbol.toPrimitive 转换时抛出
      // "Cannot convert object to primitive value"。
      if (typeof selector === 'function') {
        try {
          selector.call(sandboxedDocument);
          return jQuery(document);
        } catch (e) {
          console.error('[PluginSandbox] jQuery(fn) ready callback failed:', e);
          throw e;
        }
      }
      const unwrappedSelector = unwrapSandboxedElement(selector);
      const unwrappedContext = context !== undefined ? unwrapSandboxedElement(context) : undefined;
      try {
        return unwrappedContext !== undefined
          ? jQuery(unwrappedSelector, unwrappedContext)
          : jQuery(unwrappedSelector);
      } catch (e) {
        const diag = {
          error: String(e),
          selectorType: typeof unwrappedSelector,
          selectorConstructor: unwrappedSelector?.constructor?.name,
          isNode: typeof window !== 'undefined' && unwrappedSelector instanceof Node,
          nodeType: unwrappedSelector?.nodeType,
          hasJQuery: unwrappedSelector?.jquery,
          selectorStr: (() => { try { return String(unwrappedSelector).slice(0, 200) } catch { return 'String() failed' } })(),
          keys: unwrappedSelector && typeof unwrappedSelector === 'object' ? Object.keys(unwrappedSelector).slice(0, 20) : null,
          contextType: typeof unwrappedContext,
        };
        try { (window as any).__jqDiag = diag; } catch {}
        console.error('[PluginSandbox] jQuery call failed:', e, diag);
        throw e;
      }
    } as any;
    // 复制 jQuery 静态属性/方法（$.fn, $.extend, $.ajax 等）到包装函数
    // $.fn 必须同一个引用，插件 $.fn.myMethod = ... 扩展才能生效于真实 jQuery
    Object.assign(wrappedJQuery, jQuery);
    wrappedJQuery.fn = jQuery.fn;
    wrappedJQuery.prototype = jQuery.prototype;

    // P-6: jQuery UI 扩展兼容（quick-reply 等用 $(...).sortable 做拖拽排序）。
    // 真实 jQuery UI 未引入，提供最小可用实现：不改变 DOM 顺序，但注册
    // start/stop/update 回调（拖拽相关插件依赖 stop/update 读取新顺序）。
    try {
      if (!(wrappedJQuery.fn as any).sortable) {
        (wrappedJQuery.fn as any).sortable = function (options?: any) {
          if (typeof options === 'string') {
            // .sortable('destroy') / .sortable('refresh') 等命令：no-op 返回 this
            return this;
          }
          const opts = options && typeof options === 'object' ? options : {};
          const onStart = opts.start;
          const onStop = opts.stop;
          const onUpdate = opts.update;
          this.each(function (this: any) {
            if (typeof onStart === 'function') {
              try { onStart.call(this, {}, { item: this }); } catch { /* ignore */ }
            }
            if (typeof onStop === 'function') {
              try { onStop.call(this, {}, { item: this }); } catch { /* ignore */ }
            }
            if (typeof onUpdate === 'function') {
              try { onUpdate.call(this, {}, { item: this }); } catch { /* ignore */ }
            }
          });
          return this;
        };
      }
    } catch (e) {
      console.warn('[PluginSandbox] sortable 兼容注入失败:', e);
    }

    // P-4: extension_settings 全局标识符（ST 1.18.0 契约）。此前仅在
    // moduleMap['extensions.js'] 提供（import 路径可用），但 buildWrappedCode 的
    // `var extension_settings = __sandbox.extension_settings` 因 sandbox 顶层无此键
    // 恒为 undefined → 直接全局引用 extension_settings.xxx 的插件 TypeError。
    // 构建于 createSandboxGlobal 层级：sandbox 顶层与 moduleMap 指向同一 Proxy。
    migrateLegacyExtensionSettings();
    const extensionSettings = new Proxy(globalExtensionSettings, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return (target as any)[prop as any];
        if (Object.prototype.hasOwnProperty.call(target, prop)) return (target as any)[prop];
        // 原型链方法（hasOwnProperty/toString 等）原样返回，避免误判为扩展命名空间
        if (prop in target) return (target as any)[prop];
        // 兼容旧隔离存储：全局无此命名空间时，迁入本插件旧数据（幂等，不覆盖）
        const legacy = context.storage.get(`ext_settings_${prop}`);
        if (legacy !== undefined && legacy !== null) {
          (target as any)[prop] = legacy;
          saveExtensionSettingsDebounced();
          return legacy;
        }
        // 对齐 ST 1.18.0：extension_settings 是普通对象，未知属性返回 undefined。
        // 扩展用 extension_settings[MODULE] = extension_settings[MODULE] || {}
        // 惯用法初始化（走 set 拦截器持久化），之后原地修改同一引用。
        return undefined;
      },
      set: (target, prop, value) => {
        if (typeof prop === 'string') {
          (target as any)[prop] = value;
          saveExtensionSettingsDebounced();
        }
        return true;
      },
    });

    const sandbox: Record<string, unknown> = {
      // 核心上下文
      // P-1: getContext() 聚合 ST 兼容字段（chat/saveChat/groupId/chatMetadata/
      // characters/name1/name2/characterId 等）。惰性 Proxy：优先沙箱自有 API
      // （on/off/emit/storage/register* 等），未命中时实时从 buildStContext() 取——
      // 每次访问取最新，天然规避加载时快照导致插件读到旧 chat/chat_metadata。
      // 事件源与扩展设置统一用沙箱版本（含清理注册与持久化）。
      getContext: () => {
        const stFallback = (): Record<string, unknown> => {
          try {
            const st = buildStContext() as unknown as Record<string, unknown> | null;
            return st && typeof st === 'object' ? st : {};
          } catch (e) {
            console.warn('[PluginSandbox] getContext: buildStContext failed:', e);
            return {};
          }
        };
        return new Proxy(context as unknown as Record<string, unknown>, {
          get: (target, prop) => {
            if (typeof prop === 'symbol') return (target as any)[prop];
            if (prop in target) return (target as any)[prop];
            if (prop === 'eventSource') return sandbox.eventSource;
            if (prop === 'extensionSettings' || prop === 'extension_settings') return extensionSettings;
            const st = stFallback();
            if (prop in st) return st[prop as string];
            return undefined;
          },
        });
      },
      extension_settings: extensionSettings,
      eventSource: {
        on: (event: string, callback: (...args: any[]) => void) => {
          context.on(event, callback);
          self.registerCleanup(pluginId, () => context.off(event, callback));
        },
        off: (event: string, callback: (...args: any[]) => void) => context.off(event, callback),
        emit: (event: string, ...args: unknown[]) => context.emit(event, ...args),
        once: (event: string, callback: (...args: any[]) => void) => {
          const wrapped = (...args: unknown[]) => {
            callback(...args as any[]);
            context.off(event, wrapped as any);
          };
          context.on(event, wrapped as any);
        },
        makeLast: (event: string, callback: (...args: any[]) => void) => {
          context.on(event, callback);
          self.registerCleanup(pluginId, () => context.off(event, callback));
        },
        // ST 1.18 eventSource.makeFirst：把回调注册到监听器最前。
        // eventBus 无前置插入 API，这里语义对齐 makeLast 的 off+on 顺序（先移除旧回调再注册，
        // 保证同回调不重复注册、插件事件回调可被正确清理）；对 quick-reply 等用
        // makeFirst(USER_MESSAGE_RENDERED, ...) 自动执行场景，监听器仍能收到事件。
        makeFirst: (event: string, callback: (...args: any[]) => void) => {
          context.off(event, callback);
          context.on(event, callback);
          self.registerCleanup(pluginId, () => context.off(event, callback));
        },
        removeAllListeners: (event?: string) => {
          // ST 1.18 eventSource.removeAllListeners：移除全部或指定事件的监听器。
          // 此前为空实现（注释误写"eventBus 会处理"），插件调用后监听器残留。
          // 经 context.off 逐项清理（context.on/once 注册的回调都在其内部 listeners 表中）。
          if (event !== undefined && event !== null && event !== '') {
            context.removeAllListeners(event);
          } else {
            context.removeAllListeners();
          }
        },
      },
      eventTypes: this.getEventTypes(),
      registerSlashCommand: (
        name: string,
        callback: (...args: any[]) => void,
        aliases?: string[],
        help?: string,
      ) => {
        context.registerCommand({ name, callback, aliases, help });
        self.registerCleanup(pluginId, () => {
          // SlashCommandEngine 会处理注销
        });
      },
      registerMacro: (name: string, handler: (...args: any[]) => void) => {
        context.registerMacro(name, { handler });
        self.registerCleanup(pluginId, () => {
          // MacroRegistry 会处理注销
        });
      },
      registerHook: (hookType: string, callback: (...args: any[]) => void) => {
        if (contextWithHooks.registerHook) {
          contextWithHooks.registerHook(hookType as any, callback);
        }
        self.registerCleanup(pluginId, () => {
          // HookRegistry 会处理注销
        });
      },
      registerFunctionTool: (name: string, description: string, handler: (...args: any[]) => any) => {
        if (!name || typeof name !== 'string') {
          console.warn(`[PluginSandbox] registerFunctionTool: 无效的 name (plugin=${pluginId})`);
          return;
        }
        if (typeof handler !== 'function') {
          console.warn(`[PluginSandbox] registerFunctionTool: '${name}' handler 不是函数 (plugin=${pluginId})`);
          return;
        }
        functionToolRegistry.set(name, {
          description: String(description || ''),
          handler,
          pluginId,
        });
        self.registerCleanup(pluginId, () => {
          // 仅在 tool 仍归属本插件时移除，避免覆盖
          const entry = functionToolRegistry.get(name);
          if (entry && entry.pluginId === pluginId) {
            functionToolRegistry.delete(name);
          }
        });
      },
      // registerEndpoint: 注册自定义 HTTP 端点
      // 插件通过 fetch('/api/plugins/{pluginId}/{name}') 触发，由 bridge.js 拦截调用 handler
      registerEndpoint: (name: string, method: string, handler: (...args: any[]) => any) => {
        if (!name || typeof name !== 'string') {
          console.warn(`[PluginSandbox] registerEndpoint: 无效的 name (plugin=${pluginId})`);
          return;
        }
        if (typeof handler !== 'function') {
          console.warn(`[PluginSandbox] registerEndpoint: '${name}' handler 不是函数 (plugin=${pluginId})`);
          return;
        }
        const key = `${pluginId}/${name}`;
        endpointRegistry.set(key, {
          method: String(method || 'GET').toUpperCase(),
          handler,
          pluginId,
        });
        self.registerCleanup(pluginId, () => {
          const entry = endpointRegistry.get(key);
          if (entry && entry.pluginId === pluginId) {
            endpointRegistry.delete(key);
          }
        });
      },
      // registerContextSetter: 注册 getContext 字段扩展
      // getContext() 构造时会遍历所有 setter，将返回值合并到 context 对象
      registerContextSetter: (key: string, handler: (context: any) => any) => {
        if (!key || typeof key !== 'string') {
          console.warn(`[PluginSandbox] registerContextSetter: 无效的 key (plugin=${pluginId})`);
          return;
        }
        if (typeof handler !== 'function') {
          console.warn(`[PluginSandbox] registerContextSetter: '${key}' handler 不是函数 (plugin=${pluginId})`);
          return;
        }
        contextSetterRegistry.set(key, handler);
        self.registerCleanup(pluginId, () => {
          // 仅在 setter 仍是本插件注册时移除（避免覆盖后误删）
          if (contextSetterRegistry.get(key) === handler) {
            contextSetterRegistry.delete(key);
          }
        });
      },
      setExtensionPrompt: (
        identifier: string,
        content: string,
        position?: number,
        depth?: number,
        scan?: boolean,
        role?: number | string,
        filter?: any,
      ) => {
        // 委托到 prompt-injection 服务（签名与 ST 1.18.0 script.js:8904 对齐）
        try {
          promptInjection.setExtensionPrompt(
            identifier,
            content,
            position as any,
            depth,
            scan,
            role,
            filter,
          );
        } catch (e) {
          console.warn(`[PluginSandbox] setExtensionPrompt 失败:`, e);
        }
        self.registerCleanup(pluginId, () => {
          try {
            promptInjection.removeExtensionPrompt(identifier);
          } catch {
            // ignore
          }
        });
      },
      getExtensionSettings: (name: string) => {
        // 全局共享 store 优先（ST 1.18.0 契约）；无数据时回退旧隔离存储并迁入
        if (Object.prototype.hasOwnProperty.call(globalExtensionSettings, name)) {
          return getExtensionSettingsNs(name);
        }
        const legacy = context.storage.get(`ext_settings_${name}`);
        if (legacy !== undefined && legacy !== null) {
          globalExtensionSettings[name] = legacy;
          saveExtensionSettingsDebounced();
          return legacy;
        }
        return {};
      },
      writeExtensionField: (name: string, field: string, value: unknown) => {
        // A-3 修复（2026-08-23）: 三轨统一——ST 角色卡语义优先（characterId 可
        // 解析时），模块名调用回退旧"扩展设置命名空间"语义，与经典轨/getContext 轨一致。
        void writeExtensionFieldCompat(name, field, value, {
          legacyFallback: () => writeExtensionSettingsField(name, field, value),
        });
      },
      substituteParams: (input: string) => {
        try {
          return substituteParamsExtended(input);
        } catch {
          return input;
        }
      },
      messageFormatting: (content: string) => content,
      // callGenericPopup：委托到父应用 popupManager 显示真实弹窗
      callGenericPopup: async (message: any, type?: any, inputValue?: any, options?: any) => {
        // 如果第三参数是对象（没有 inputValue），调整参数
        if (typeof inputValue === 'object' && inputValue !== null && options === undefined) {
          options = inputValue;
          inputValue = undefined;
        }
        const palinkType = mapSandboxPopupType(type);
        const messageText = message instanceof Node
          ? (message.textContent || '')
          : String(message ?? '');
        // [N-1] 仅 DISPLAY 分支经 dangerouslySetInnerHTML 注入主 origin，入口先消毒（复用沙箱 sanitizeHtml）；
        // TEXT/CONFIRM/INPUT 走 React 文本节点本已安全，保持原样
        const displaySafeText = palinkType === PopupType.DISPLAY ? sanitizeHtml(messageText) : messageText;
        const popupOptions: any = {};
        if (options?.okButton) popupOptions.okButton = options.okButton;
        if (options?.cancelButton) popupOptions.cancelButton = options.cancelButton;
        if (options?.customButtons) popupOptions.customButtons = options.customButtons;
        if (options?.wide) popupOptions.wide = options.wide;
        if (options?.large) popupOptions.large = options.large;
        if (options?.rows) popupOptions.rows = options.rows;
        if (options?.placeholder) popupOptions.placeholder = options.placeholder;
        if (typeof inputValue === 'string') popupOptions.defaultValue = inputValue;
        // CONFIRM 类型默认显示取消按钮
        if (palinkType === PopupType.CONFIRM && !popupOptions.cancelButton) {
          popupOptions.cancelButton = '取消';
        }
        if (!popupOptions.okButton) popupOptions.okButton = '确定';

        try {
          const result = await popupManager.show(
            palinkType,
            (options?.title as string) || 'SillyTavern',
            displaySafeText,
            popupOptions,
          );
          // 根据弹窗类型返回合适的值
          if (palinkType === PopupType.INPUT) {
            if (result?.result === PopupResult.AFFIRMATIVE) {
              return result.value ?? '';
            }
            return null;
          }
          if (palinkType === PopupType.CONFIRM) {
            return result;
          }
          // TEXT/DISPLAY 类型返回 true/false
          if (typeof result === 'number') {
            return result;
          }
          return result ?? true;
        } catch (e) {
          console.warn(`[Plugin ${pluginId}] callGenericPopup 失败:`, e);
          return palinkType === PopupType.INPUT ? null : false;
        }
      },
      // Popup 类：与 POPUP_TYPE 保持一致的字符串值
      Popup: class {
        static get TEXT() { return 'TEXT'; }
        static get CONFIRM() { return 'CONFIRM'; }
        static get INPUT() { return 'INPUT'; }
        static get DISPLAY() { return 'DISPLAY'; }
      },
      // POPUP_TYPE：统一为字符串值，跨文件一致
      POPUP_TYPE: {
        TEXT: 'TEXT',
        CONFIRM: 'CONFIRM',
        INPUT: 'INPUT',
        DISPLAY: 'DISPLAY',
      },
      toastr: toastr,
      console: {
        log: (...args: unknown[]) => console.log(`[Plugin ${pluginId}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[Plugin ${pluginId}]`, ...args),
        error: (...args: unknown[]) => console.error(`[Plugin ${pluginId}]`, ...args),
        info: (...args: unknown[]) => console.info(`[Plugin ${pluginId}]`, ...args),
        debug: (...args: unknown[]) => console.debug(`[Plugin ${pluginId}]`, ...args),
      },
      // S-1: 原生弹窗/窗口/消息 API stub（词法遮蔽引用）。原生 alert/confirm/prompt
      // 直达真实 window 属沙箱逃逸面；window.open/postMessage 可外泄数据。统一 stub。
      alert: (message?: unknown) => {
        console.warn('[PluginSandbox] alert 已被沙箱禁用:', message);
      },
      confirm: (_message?: string) => {
        console.warn('[PluginSandbox] confirm 已被沙箱禁用，返回 false');
        return false;
      },
      prompt: (_message?: string, _defaultValue?: string) => {
        console.warn('[PluginSandbox] prompt 已被沙箱禁用，返回 null');
        return null;
      },
      open: (url?: unknown) => {
        console.warn('[PluginSandbox] window.open 已被沙箱禁用:', url);
        return null;
      },
      close: () => {
        console.warn('[PluginSandbox] window.close 已被沙箱禁用');
      },
      postMessage: (_data?: unknown, targetOrigin?: unknown) => {
        console.warn('[PluginSandbox] postMessage 已被沙箱禁用 (targetOrigin=)', targetOrigin);
      },
      fetch: sandboxedFetch,
      document: sandboxedDocument,
      window: sandboxedWindow,
      $: wrappedJQuery,
      jQuery: wrappedJQuery,
      Handlebars: Handlebars,
      marked: marked,
      DOMPurify: DOMPurify,
      localStorage: sandboxedLocalStorage,
      sessionStorage: sandboxedSessionStorage,
      setTimeout: (fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        // 拒绝字符串参数（防止 eval 类代码执行）
        if (typeof fn !== 'function') {
          console.warn('[Sandbox] setTimeout with string argument is not allowed');
          return 0;
        }
        const id = setTimeout(fn, delay, ...args);
        self.registerCleanup(pluginId, () => clearTimeout(id));
        return id;
      },
      setInterval: (fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        // 拒绝字符串参数（防止 eval 类代码执行）
        if (typeof fn !== 'function') {
          console.warn('[Sandbox] setInterval with string argument is not allowed');
          return 0;
        }
        const id = setInterval(fn, delay, ...args);
        self.registerCleanup(pluginId, () => clearInterval(id));
        return id;
      },
      clearTimeout: (id: number) => clearTimeout(id),
      clearInterval: (id: number) => clearInterval(id),
      // ===== 酒馆助手(JS-Slash-Runner)兼容 API =====
      // eventOn/eventOff/eventEmit: 酒馆助手事件监听封装，转发到 eventSource
      eventOn: (event: string, callback: (...args: any[]) => void) => {
        context.on(event, callback);
        self.registerCleanup(pluginId, () => context.off(event, callback));
      },
      eventOff: (event: string, callback: (...args: any[]) => void) => context.off(event, callback),
      eventEmit: (event: string, ...args: any[]) => context.emit(event, ...args),
      eventRemoveListener: (event: string, callback: (...args: any[]) => void) => context.off(event, callback),
      // tavern_events / iframe_events: 酒馆助手事件常量，映射到 ST eventTypes
      tavern_events: this.getEventTypes(),
      iframe_events: {
        STREAM_TOKEN_RECEIVED_FULLY: 'STREAM_TOKEN_RECEIVED_FULLY',
        STREAM_TOKEN_RECEIVED: 'STREAM_TOKEN_RECEIVED',
        IFRAME_READY: 'IFRAME_READY',
        GENERATION_STARTED: 'GENERATION_STARTED',
        GENERATION_ENDED: 'GENERATION_ENDED',
      },
      // getButtonEvent: 酒馆助手按钮事件名生成
      getButtonEvent: (name: string) => `tavern_button_${name}`,
      // getVariables/replaceVariables: 酒馆助手变量系统（MVU 核心）
      // 变量按 type(chat/character/preset/global/script/message/extension) 分区存储在全局共享 Map。
      // 对照 JS-Slash-Runner src/function/variables.ts：
      //   getVariables 返回深拷贝（klona），脚本修改不影响存储
      //   replaceVariables 整体替换（非合并）
      //   deleteVariable 支持点号路径（如 "foo.bar"），返回 {variables, delete_occurred}
      //   insertOrAssignVariables 深合并（_.mergeWith 语义）
      getVariables: (options?: { type?: string }) => {
        const type = (options && options.type) || 'chat';
        const vars = tavernVariableStore.get(type);
        // 深拷贝（JSON 方式兼容多数场景，对照源码 klona）
        return vars ? JSON.parse(JSON.stringify(vars)) : {};
      },
      replaceVariables: (variables: Record<string, any>, options?: { type?: string }) => {
        const type = (options && options.type) || 'chat';
        // 深拷贝写入，避免外部引用修改存储
        tavernVariableStore.set(type, JSON.parse(JSON.stringify(variables || {})));
      },
      setVariables: (variables: Record<string, any>, options?: { type?: string }) => {
        const type = (options && options.type) || 'chat';
        tavernVariableStore.set(type, JSON.parse(JSON.stringify(variables || {})));
      },
      getVariable: (name: string, options?: { type?: string }) => {
        const type = (options && options.type) || 'chat';
        const vars = tavernVariableStore.get(type) || {};
        // 支持点号路径
        const parts = String(name).split('.');
        let val: any = vars;
        for (const p of parts) { val = val?.[p]; if (val === undefined) break; }
        return val;
      },
      setVariable: (name: string, value: any, options?: { type?: string }) => {
        const type = (options && options.type) || 'chat';
        const vars = tavernVariableStore.get(type) || {};
        const parts = String(name).split('.');
        let obj: any = vars;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
        tavernVariableStore.set(type, vars);
      },
      deleteVariable: (variablePath: string, options?: { type?: string }) => {
        // 对照源码：支持点号路径（_.unset 语义），返回 {variables, delete_occurred}
        const type = (options && options.type) || 'chat';
        const vars = tavernVariableStore.get(type) || {};
        const parts = String(variablePath).split('.');
        let obj: any = vars;
        let delete_occurred = false;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') { obj = null; break; }
          obj = obj[parts[i]];
        }
        if (obj && obj[parts[parts.length - 1]] !== undefined) {
          delete obj[parts[parts.length - 1]];
          delete_occurred = true;
          tavernVariableStore.set(type, vars);
        }
        return { variables: JSON.parse(JSON.stringify(vars)), delete_occurred };
      },
      insertOrAssignVariables: (variables: Record<string, any>, options?: { type?: string }) => {
        // 对照源码：深合并（_.mergeWith 语义，数组直接替换）
        const type = (options && options.type) || 'chat';
        const existing = tavernVariableStore.get(type) || {};
        const merged = deepMergeObjects(existing, variables || {});
        tavernVariableStore.set(type, merged);
        return JSON.parse(JSON.stringify(merged));
      },
      // getChatMessages: 获取聊天消息
      // 尝试从 window 上的全局聊天状态读取，不可用时返回空数组（不崩）
      getChatMessages: (rangeOrId?: any, _options?: any) => {
        try {
          const w = window as any;
          const chat = w.__palinkChatMessages || w.SillyTavern?.getContext?.()?.chat;
          if (!chat || !Array.isArray(chat) || chat.length === 0) return [];
          if (rangeOrId === undefined || rangeOrId === null) return chat;
          if (typeof rangeOrId === 'number') {
            return chat[rangeOrId] ? [chat[rangeOrId]] : [];
          }
          if (typeof rangeOrId === 'string' && rangeOrId.includes('-')) {
            const [start, end] = rangeOrId.split('-').map(Number);
            return chat.slice(start, end + 1);
          }
          return [];
        } catch {
          return [];
        }
      },
      // getLastMessageId: 获取最后消息ID
      getLastMessageId: () => {
        try {
          const w = window as any;
          const chat = w.__palinkChatMessages || w.SillyTavern?.getContext?.()?.chat;
          if (!chat || !Array.isArray(chat)) return -1;
          return chat.length - 1;
        } catch {
          return -1;
        }
      },
      // ── A-2 修复（2026-08-23）: 能力倒挂消除 ──
      // 以下 API 此前是 console.warn 空桩，而同样代码注入主 window（经典轨）
      // 经 __palinkBridge 有真桥接——同一酒馆助手脚本"注入能跑、进沙箱失效"。
      // 统一改为调用时转发到主 window 同名真实现，缺失时保留诚实降级。

      // triggerSlash: 触发 slash 命令（桥接经典轨 window.triggerSlash → __palinkBridge.runSlashCommand）
      triggerSlash: async (_command: string) => {
        try {
          const w = window as any;
          if (typeof w.triggerSlash === 'function') {
            return await w.triggerSlash(_command);
          }
        } catch (e) {
          console.warn('[PluginSandbox] triggerSlash 桥接失败:', e);
          return '';
        }
        console.warn(`[PluginSandbox] triggerSlash: 无可用桥接（window.triggerSlash 缺失）: ${_command}`);
        return '';
      },
      // generateRaw: 生成请求（K-5 修复：桥接到真实实现，非空 stub）
      // ST 插件经 `var generateRaw = __sandbox.generateRaw`（buildWrappedCode 注入）
      // 拿到此函数，memory/vectors/expressions 以 ST 单对象签名调用
      // `generateRaw({ prompt, systemPrompt, responseLength })`。此前 stub 直接
      // 返回空串 → 插件拿到空结果；generation-engine 已做单对象兼容，此处透传。
      generateRaw: async (promptOrParams: any, options?: any) => {
        try {
          const st = buildStContext() as unknown as { generateRaw?: (...args: any[]) => Promise<string> } | null;
          if (st && typeof st.generateRaw === 'function') {
            return await st.generateRaw(promptOrParams, options);
          }
        } catch (e) {
          console.warn('[PluginSandbox] generateRaw 桥接失败:', e);
        }
        console.warn('[PluginSandbox] generateRaw stub（无可用实现）');
        return '';
      },
      // openCharacterChat: 打开角色聊天（桥接经典轨 __palinkBridge.switchChat）
      openCharacterChat: async (_options?: any) => {
        try {
          const w = window as any;
          if (typeof w.openCharacterChat === 'function') {
            return await w.openCharacterChat(_options);
          }
        } catch (e) {
          console.warn('[PluginSandbox] openCharacterChat 桥接失败:', e);
          return;
        }
        console.warn('[PluginSandbox] openCharacterChat: 无可用桥接（window.openCharacterChat 缺失）');
      },
      // ===== 补充：脚本实际调用但之前未补的 API（对照 JS-Slash-Runner index.ts） =====
      // substitudeMacros: 宏替换（对照源码 substitudeMacros，注意拼写不是 substitute）
      substitudeMacros: (input: string) => {
        try { return substituteParamsExtended(input); } catch { return input; }
      },
      // generate: 生成请求（桥接 buildStContext().generateRaw，与上方 generateRaw 同源）
      generate: async (_prompt: string, _options?: any) => {
        try {
          const st = buildStContext() as unknown as { generateRaw?: (...args: any[]) => Promise<string> } | null;
          if (st && typeof st.generateRaw === 'function') {
            return await st.generateRaw(_prompt, _options);
          }
        } catch (e) {
          console.warn('[PluginSandbox] generate 桥接失败:', e);
          return '';
        }
        console.warn('[PluginSandbox] generate stub（无可用实现）');
        return '';
      },
      // injectPrompts / uninjectPrompts: prompt 注入（桥接主 window 实现；
      // 经典轨当前亦为桩，转发保持两轨单一来源，后续实现只改一处）
      injectPrompts: async (_prompts: any) => {
        try {
          const w = window as any;
          if (typeof w.injectPrompts === 'function') {
            return await w.injectPrompts(_prompts);
          }
        } catch (e) {
          console.warn('[PluginSandbox] injectPrompts 桥接失败:', e);
          return '';
        }
        console.warn('[PluginSandbox] injectPrompts: 无可用桥接（window.injectPrompts 缺失）');
        return '';
      },
      uninjectPrompts: async (_id?: string) => {
        try {
          const w = window as any;
          if (typeof w.uninjectPrompts === 'function') {
            return await w.uninjectPrompts(_id);
          }
        } catch (e) {
          console.warn('[PluginSandbox] uninjectPrompts 桥接失败:', e);
          return;
        }
        console.warn('[PluginSandbox] uninjectPrompts: 无可用桥接（window.uninjectPrompts 缺失）');
      },
      // setChatMessages / deleteChatMessages: 消息操作
      // setChatMessages 桥接经典轨真实现（__palinkBridge.saveChatMessages）；
      // deleteChatMessages 两轨均无底层实现，保留诚实桩。
      setChatMessages: async (_messages: any, _range?: any) => {
        try {
          const w = window as any;
          if (typeof w.setChatMessages === 'function') {
            return await w.setChatMessages(_messages, _range);
          }
        } catch (e) {
          console.warn('[PluginSandbox] setChatMessages 桥接失败:', e);
          return;
        }
        console.warn('[PluginSandbox] setChatMessages: 无可用桥接（window.setChatMessages 缺失）');
      },
      deleteChatMessages: (_range?: any) => {
        console.warn('[PluginSandbox] deleteChatMessages stub（两轨均无底层实现）');
      },
      // getCharacter / getCurrentCharacterName / getCharacterNames / getCharData:
      // 尝试从 window 上的全局聊天状态读取角色信息，不可用时返回安全默认值
      getCharacter: (_id?: any) => {
        try {
          const w = window as any;
          const ctx = w.SillyTavern?.getContext?.();
          return ctx?.characters?.[ctx?.characterId] || null;
        } catch { return null; }
      },
      getCurrentCharacterName: () => {
        try {
          const w = window as any;
          return w.SillyTavern?.getContext?.()?.name2 || '未知角色卡';
        } catch { return '未知角色卡'; }
      },
      getCurrentCharacterId: () => {
        try {
          const w = window as any;
          const id = w.SillyTavern?.getContext?.()?.characterId;
          return id !== undefined ? String(id) : '';
        } catch { return ''; }
      },
      getCharacterNames: () => {
        try {
          const w = window as any;
          const ctx = w.SillyTavern?.getContext?.();
          return ctx?.characters?.map((c: any) => c.name) || [];
        } catch { return []; }
      },
      getCharData: (_id: any, _field?: any) => {
        try {
          const w = window as any;
          const ctx = w.SillyTavern?.getContext?.();
          return ctx?.characters?.[_id] || null;
        } catch { return null; }
      },
      getCharAvatarPath: (_id?: any) => null,
      getWorldbook: (_name?: any) => null,
      // 世界书全局 API：插件常调用 getGlobalWorldbookNames 获取全局世界书列表
      // Palink 世界书由 worldbookApi 管理，无"全局/本地"区分，返回空数组避免插件报错
      getGlobalWorldbookNames: (): string[] => [],
      // saveWorldInfoToChat：将世界书绑定到聊天，Palink 无此概念，no-op
      saveWorldInfoToChat: (_name?: string) => { /* no-op */ },
      // removeWorldInfoFromChat：解绑，no-op
      removeWorldInfoFromChat: (_name?: string) => { /* no-op */ },
      // getWorldInfoData：获取世界书条目数据，返回 null（插件会回退到 getWorldbook）
      getWorldInfoData: (_name?: string) => null,
      // checkWorldInfo：触发世界书扫描，no-op（Palink 在后端 build_worldbook_context 处理）
      checkWorldInfo: (_trigger: string = '') => { /* no-op */ },
      // createOrReplaceWorldbook / createOrReplaceCharWorldbook：创建或替换世界书
      // Palink 世界书由后端 worldbookApi 管理，sandbox 层 no-op 避免插件 ReferenceError
      createOrReplaceWorldbook: async (_name?: any, _entries?: any, _options?: any) => { /* no-op */ },
      createOrReplaceCharWorldbook: async (_name?: any, _entries?: any, _options?: any) => { /* no-op */ },
      getMessageId: () => {
        try {
          const w = window as any;
          const chat = w.__palinkChatMessages;
          return chat ? chat.length - 1 : -1;
        } catch { return -1; }
      },
      formatAsDisplayedMessage: (content: string) => content,
      refreshOneMessage: (_id?: any) => { /* no-op */ },
      retrieveDisplayedMessage: (_id?: any) => null,
      errorCatched: (fn: Function) => fn,
      getTavernHelperVersion: () => '3.0.0',
      getTavernVersion: () => '1.18.0',
      registerMacroLike: (_name: string, _handler: Function) => { /* no-op */ },
      unregisterMacroLike: (_name: string) => { /* no-op */ },
      onError: (error: unknown) => {
        console.error(`[PluginSandbox] 插件 ${pluginId} 运行时错误:`, error);
        try {
          (window as any).__lastPluginRuntimeError = {
            pluginId,
            error: String(error),
            stack: (error as any)?.stack,
            message: (error as any)?.message,
            name: (error as any)?.name,
          };
        } catch {}
      },
    };

    // 注入 ST 兼容库到沙箱 window 对象（插件可通过 window.jQuery 等访问）
    // 每个库独立 try-catch，失败时记录日志但不阻塞沙箱初始化
    // $/jQuery 使用前面定义的 wrappedJQuery（已解包 Proxy 参数）
    const sandboxLibs: Record<string, unknown> = {
      jQuery: wrappedJQuery,
      $: wrappedJQuery,
      Handlebars,
      toastr,
      marked,
      DOMPurify,
    };
    for (const [libName, libValue] of Object.entries(sandboxLibs)) {
      try {
        (sandboxedWindow as any)[libName] = libValue;
      } catch (e) {
        console.warn(`[PluginSandbox] ${libName} 注入 window 失败 (${pluginId}):`, e);
      }
    }
    // select2 通过 $.fn.select2 扩展 jQuery，暴露可用性标志供插件检测
    try {
      (sandboxedWindow as any).select2 = select2Ready;
    } catch (e) {
      console.warn(`[PluginSandbox] select2 注入 window 失败 (${pluginId}):`, e);
    }

    // 注入 TavernHelper 全局对象到 sandboxedWindow
    // 酒馆助手脚本通过 topWindow.TavernHelper.getCharacter 等方式访问 API（行 84052 等），
    // window.top 在沙箱里返回 sandboxedWindow 自身，故在此注入让 TavernHelper 可达。
    // 对照 JS-Slash-Runner src/function/index.ts getTavernHelper() 返回结构。
    try {
      (sandboxedWindow as any).TavernHelper = {
        // 事件
        tavern_events: sandbox.tavern_events,
        iframe_events: sandbox.iframe_events,
        // 变量
        getVariables: sandbox.getVariables,
        replaceVariables: sandbox.replaceVariables,
        updateVariablesWith: (updater: any, options?: any) => {
          const vars = (sandbox.getVariables as any)(options);
          const result = updater(vars);
          (sandbox.replaceVariables as any)(result, options);
          return result;
        },
        insertOrAssignVariables: sandbox.insertOrAssignVariables,
        insertVariables: sandbox.insertOrAssignVariables,
        deleteVariable: sandbox.deleteVariable,
        // 消息
        getChatMessages: sandbox.getChatMessages,
        setChatMessages: sandbox.setChatMessages,
        deleteChatMessages: sandbox.deleteChatMessages,
        // Slash
        triggerSlash: sandbox.triggerSlash,
        triggerSlashWithResult: sandbox.triggerSlash,
        // 生成
        generate: sandbox.generate,
        generateRaw: sandbox.generateRaw,
        // 注入
        injectPrompts: sandbox.injectPrompts,
        uninjectPrompts: sandbox.uninjectPrompts,
        // 角色
        getCharacter: sandbox.getCharacter,
        getCharacterNames: sandbox.getCharacterNames,
        getCurrentCharacterName: sandbox.getCurrentCharacterName,
        getCurrentCharacterId: sandbox.getCurrentCharacterId,
        getCharData: sandbox.getCharData,
        getCharAvatarPath: sandbox.getCharAvatarPath,
        // 工具
        substitudeMacros: sandbox.substitudeMacros,
        getLastMessageId: sandbox.getLastMessageId,
        getMessageId: sandbox.getMessageId,
        errorCatched: sandbox.errorCatched,
        // 显示
        formatAsDisplayedMessage: sandbox.formatAsDisplayedMessage,
        refreshOneMessage: sandbox.refreshOneMessage,
        retrieveDisplayedMessage: sandbox.retrieveDisplayedMessage,
        // 版本
        getTavernHelperVersion: sandbox.getTavernHelperVersion,
        getFrontendVersion: sandbox.getTavernHelperVersion,
        getTavernVersion: sandbox.getTavernVersion,
        // 宏
        registerMacroLike: sandbox.registerMacroLike,
        unregisterMacroLike: sandbox.unregisterMacroLike,
        // 按钮
        getAllEnabledScriptButtons: () => [],
        getScriptTrees: () => [],
        // 世界书
        getWorldbook: sandbox.getWorldbook,
        // 扩展
        getTavernHelperExtensionId: () => pluginId,
        getExtensionType: () => 'tavern_helper',
        isAdmin: () => false,
      };
    } catch (e) {
      console.warn(`[PluginSandbox] TavernHelper 注入 window 失败 (${pluginId}):`, e);
    }

    // 将酒馆助手兼容 API 写入 pluginGlobals，使 sandboxedWindow（即 window.top）可通过
    // Proxy get handler 的 pluginGlobals 分支访问。插件脚本常通过 topWindow = window.top;
    // topWindow.eventOn(...) 跨 frame 调用，这些 API 原本只在 sandbox 对象上，
    // 未挂到 sandboxedWindow，导致 topWindow.eventOn 为 undefined，气泡渲染系统不工作。
    // TavernHelper 已通过上方赋值（经 set trap 写入 pluginGlobals），此处只补独立 API。
    const tavernHelperApiKeys = [
      'eventOn', 'eventOff', 'eventEmit', 'eventRemoveListener',
      'tavern_events', 'iframe_events', 'getButtonEvent',
      'getVariables', 'setVariables', 'getVariable', 'setVariable',
      'deleteVariable', 'insertOrAssignVariables', 'replaceVariables',
      'getChatMessages', 'getLastMessageId', 'triggerSlash', 'generateRaw',
      'createOrReplaceWorldbook', 'createOrReplaceCharWorldbook',
    ];
    for (const key of tavernHelperApiKeys) {
      pluginGlobals.set(key, (sandbox as any)[key]);
    }

    // 提供 mock require 函数：ESM 转译后的 require('script.js') 调用由此解析
    // 引用 sandbox 闭包，require 实际被调用时所有属性已就绪
    sandbox.require = this.createMockRequire(pluginId, context, sandbox, entryBaseDir);

    return sandbox;
  }

  /**
   * 创建 mock require 函数，提供 ST 1.18.0 兼容模块映射表（Task 2.1.5）
   *
   * 插件转译后的 require('script.js') 调用由此函数解析。
   * 模块映射从 Palink 现有实现获取真实数据（characters/chat/eventSource 等
   * 来自 getContext()，eventSource/messageFormatting 等复用已沙箱化的对象）。
   * 未找到的模块返回空对象并记录警告，不阻塞插件执行。
   */
  private createMockRequire(
    pluginId: string,
    context: PluginContext | PluginContextWithHooks,
    sandbox: Record<string, unknown>,
    entryBaseDir: string = '',
  ): (path: string) => Record<string, unknown> {
    // 获取 ST 兼容上下文（聚合 characters/chat/chatId/characterId 等真实数据）
    let stContext: any = {};
    try {
      stContext = buildStContext() || {};
    } catch (e) {
      console.warn(`[PluginSandbox] 获取 ST 上下文失败 (${pluginId}):`, e);
    }

    const characters: any[] = Array.isArray(stContext.characters) ? stContext.characters : [];
    const chat: any[] = Array.isArray(stContext.chat) ? stContext.chat : [];
    const chatMetadata: Record<string, any> = stContext.chatMetadata ?? {};
    const thisChid: number = typeof stContext.characterId === 'number' ? stContext.characterId : 0;
    const chatId: string = stContext.chatId ?? '';
    const name1: string = stContext.name1 ?? 'User';
    const name2: string = stContext.name2 ?? 'Assistant';
    const mainApi: string = stContext.mainApi ?? 'openai';

    // extension_settings: 全局共享对象（ST 1.18.0 契约）
    // 已在 createSandboxGlobal 构建于 sandbox.extension_settings（沙箱顶层全局标识符
    // 与 moduleMap import 路径指向同一 Proxy），此处直接复用，避免两套实例导致
    // 插件经不同路径读到不同对象、跨扩展通信断裂。
    const extensionSettings = (sandbox as any).extension_settings as Record<string, unknown>;

    // ============================================================
    // P-6：缺失 ST 模块的轻量兼容实现（不引入真实第三方依赖）
    // 覆盖插件实际 import 但 moduleMap 缺失的符号，保证不 TypeError。
    // ============================================================

    // ---- 轻量 Fuse.js 兼容（expressions/connection-manager 用 new Fuse + fuse.search）----
    class MiniFuse {
      private list: any[];
      private options: { keys?: string[]; includeScore?: boolean };
      constructor(list: any[], options: any = {}) {
        this.list = Array.isArray(list) ? list : [];
        this.options = options || {};
      }
      search(query: string): Array<{ item: any; score: number }> {
        const q = String(query ?? '').toLowerCase().trim();
        if (!q) return [];
        const keys = Array.isArray(this.options.keys) ? this.options.keys : [];
        const results: Array<{ item: any; score: number }> = [];
        for (const item of this.list) {
          const texts: string[] = [];
          if (keys.length > 0) {
            for (const key of keys) {
              const v = MiniFuse.getPath(item, String(key));
              if (typeof v === 'string' || typeof v === 'number') texts.push(String(v));
            }
          } else if (typeof item === 'string' || typeof item === 'number') {
            texts.push(String(item));
          } else if (item && typeof item === 'object') {
            for (const v of Object.values(item)) {
              if (typeof v === 'string' || typeof v === 'number') texts.push(String(v));
            }
          }
          let bestScore = 1;
          for (const text of texts) {
            const t = text.toLowerCase();
            if (t === q) { bestScore = 0; break; }
            if (t.startsWith(q)) { bestScore = Math.min(bestScore, 0.15); continue; }
            if (t.includes(q)) { bestScore = Math.min(bestScore, 0.45); continue; }
            const dist = MiniFuse.levenshtein(t, q);
            bestScore = Math.min(bestScore, dist / Math.max(t.length, q.length, 1));
          }
          if (bestScore < 1) results.push({ item, score: bestScore });
        }
        results.sort((a, b) => a.score - b.score);
        return results;
      }
      private static getPath(obj: any, path: string): any {
        return String(path).split('.').reduce((acc: any, k: string) => (acc == null ? undefined : acc[k]), obj);
      }
      private static levenshtein(a: string, b: string): number {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
        for (let i = 1; i <= m; i++) {
          let prev = dp[0];
          dp[0] = i;
          for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
          }
        }
        return dp[n];
      }
    }

    // ---- Popper 兼容（stable-diffusion 用 Popper.createPopper）----
    // 真实 Popper 未引入依赖；提供最小可用实现：不动 DOM 布局，仅保证 API 存在
    const popperCompat = {
      createPopper: (_reference?: any, _popper?: any, _options?: any) => ({
        destroy: () => {},
        update: () => Promise.resolve(),
        setOptions: (_o: any) => Promise.resolve(),
        forceUpdate: () => {},
        state: { placement: 'bottom-start', options: {} },
      }),
    };

    // ---- action-loader 兼容（stable-diffusion 用 ActionLoaderHandle.EMPTY / loader.show）----
    const actionLoaderHandleCompat = {
      show: () => {},
      hide: async () => {},
      setProgress: (_pct: number) => {},
      setStatus: (_text: string) => {},
      setText: (_text: string) => {},
    };
    const actionLoaderCompat = {
      show: (_options?: any) => actionLoaderHandleCompat,
      hide: async () => {},
    };
    const ActionLoaderHandleCompat = { EMPTY: actionLoaderHandleCompat };

    // ---- nai-settings 兼容（stable-diffusion 读取 NovelAI 订阅状态）----
    const naiSettingsCompat = {
      getNovelAnlas: () => 0,
      getNovelUnlimitedImageGeneration: () => false,
      loadNovelSubscriptionData: async () => null,
    };

    // ---- tool-calling 兼容（stable-diffusion 用 ToolManager 注册图像生成工具）----
    const ToolManagerCompat = {
      isToolCallingSupported: () => false,
      canPerformToolCalls: () => false,
      registerFunctionTool: () => false,
      unregisterFunctionTool: () => false,
      getCurrentFunctionTools: () => [],
    };

    // ---- streaming-display 兼容（connection-manager 用 StreamingDisplay 展示生成进度）----
    class StreamingDisplayCompat {
      show(_options?: any) {}
      updateContent(_text: string) {}
      updateReasoning(_text: string) {}
      markStopped(_options?: any) {}
      hide(_options?: any) {}
      complete(_options?: any) {}
    }

    // ---- extensions/shared.js ConnectionManagerRequestService 兼容 ----
    // Palink 无 connection-manager 对应的 profile 后端，sendRequest 返回空结果
    // （不抛错，让 /gen 等命令流程跑通）
    const ConnectionManagerRequestServiceCompat = {
      getProfileIcon: (_profileId?: any) => '',
      getProfile: (_id?: any) => null,
      sendRequest: async (
        _profileId?: any,
        _messages?: any,
        _maxTokens?: any,
        _options?: any,
      ) => ({ content: '', reasoning: '' }),
    };

    // ---- power-user.js performFuzzySearch 兼容（expressions 用）----
    // ST: performFuzzySearch(indexName, list, queries) → 基于 Fuse 索引的模糊搜索
    const performFuzzySearchCompat = (indexName: string, list: any[], queries: any[]) => {
      const fuse = new MiniFuse(list, {});
      const results: Array<{ item: any; score: number }> = [];
      for (const q of Array.isArray(queries) ? queries : [queries]) {
        for (const hit of fuse.search(String(q ?? ''))) {
          results.push(hit);
        }
      }
      return results;
    };

    // ---- secrets.js getSecretLabelById 兼容（connection-manager 显示密钥标签）----
    const SECRET_KEY_LABELS: Record<string, string> = {
      OPENAI: 'OpenAI API key',
      OPENROUTER: 'OpenRouter API key',
      CLAUDE: 'Anthropic API key',
      MAKERSUITE: 'Google AI Studio API key',
      GROQ: 'Groq API key',
      MISTRAL: 'Mistral API key',
      XAI: 'xAI API key',
      ZAI: 'Z.ai API key',
      MOONSHOT: 'Moonshot API key',
      DEEPSEEK: 'DeepSeek API key',
      VERTEXAI: 'Vertex AI credentials',
      SCALINGLABS: 'ScalingLabs API key',
      NOVELAI: 'NovelAI API key',
      HORDE: 'AI Horde API key',
      DEEPLX: 'DeepLX API key',
      AI21: 'AI21 API key',
      DREAMGEN: 'DreamGen API key',
      TINYGRAIN: 'TinyGrain API key',
      // K-8: 与新补的 SECRET_KEYS 键对应，getSecretLabelById 不回落为原始键名
      COHERE: 'Cohere API key',
      AIMLAPI: 'AIMLAPI API key',
      NANOGPT: 'NanoGPT API key',
      CHUTES: 'Chutes API key',
      ELECTRONHUB: 'ElectronHub API key',
      POLLINATIONS: 'Pollinations API key',
      WORKERS_AI: 'Cloudflare Workers AI API key',
      CUSTOM: 'Custom API key',
    };
    const getSecretLabelByIdCompat = (key: string) => SECRET_KEY_LABELS[key] ?? String(key ?? '');

    // ---- reasoning.js formatReasoning 兼容（connection-manager 拼接思维链）----
    const formatReasoningCompat = (reasoning: string, text: string) => {
      const r = String(reasoning ?? '');
      const t = String(text ?? '');
      if (!r) return { text: t, formatted: t };
      return { text: `${r}\n${t}`, formatted: `${r}\n${t}` };
    };

    // slash-commands 系列模块共用同一组绑定
    // P-11：SlashCommandParser 从恒空 stub 升级为真实现：
    // - SlashCommand.fromProps(props) 从 props 构造命令对象（ST 1.18 静态工厂）
    // - SlashCommandParser.addCommandObject/addCommand 注册命令到 Palink SlashCommandEngine
    //   （复用 context.registerCommand 的签名适配），使插件 slash 命令真实可执行
    // - SlashCommandParser.parse(input) 解析并生成可执行闭包（quick-reply/connection-manager 依赖）
    // - 补齐 SlashCommandClosure/Scope/Executor/ReturnHelper 等配套类
    class SlashCommandScopeCompat {
      private parent: any;
      private variables: Map<string, string>;
      public pipe: string;
      constructor(parent?: any) {
        this.parent = parent ?? null;
        this.variables = new Map();
        this.pipe = '';
      }
      letVariable(name: string, value: string) { this.variables.set(name, value); }
      setVariable(name: string, value: string) {
        let scope: any = this;
        while (scope) {
          if (scope.variables.has(name)) { scope.variables.set(name, value); return; }
          scope = scope.parent;
        }
        this.variables.set(name, value);
      }
      getVariable(name: string): string {
        let scope: any = this;
        while (scope) {
          if (scope.variables.has(name)) return scope.variables.get(name) ?? '';
          scope = scope.parent;
        }
        return '';
      }
      existsVariable(name: string): boolean {
        let scope: any = this;
        while (scope) {
          if (scope.variables.has(name)) return true;
          scope = scope.parent;
        }
        return false;
      }
      deleteVariable(name: string): boolean { return this.variables.delete(name); }
      // ST 宏访问别名（quick-reply 用 scope.setMacro('arg::*', '')）
      setMacro(name: string, value: string) { this.variables.set(name, value); }
      getMacro(name: string): string { return this.getVariable(name); }
    }

    class SlashCommandClosureCompat {
      public commands: string;
      public scope: any;
      public source: string = '';
      public onProgress: ((done: number, total: number) => void) | null = null;
      constructor(commands: string, scope?: any) {
        this.commands = String(commands ?? '');
        this.scope = scope || new SlashCommandScopeCompat();
      }
      async execute(): Promise<{ pipe: string }> {
        try {
          const result = await SlashCommandEngine.execute(this.commands);
          return { pipe: (result && result.output) || '' };
        } catch (e) {
          console.error('[PluginSandbox] SlashCommandClosure.execute failed:', e);
          return { pipe: '' };
        }
      }
      getCopy() {
        const copy = new SlashCommandClosureCompat(this.commands, this.scope);
        copy.source = this.source;
        copy.onProgress = this.onProgress;
        return copy;
      }
    }

    class SlashCommandAbortControllerCompat {
      public signal: any;
      private aborted: boolean;
      constructor() { this.aborted = false; this.signal = { aborted: false }; }
      abort() { this.aborted = true; this.signal.aborted = true; }
      get isAborted() { return this.aborted; }
    }

    class SlashCommandDebugControllerCompat {
      public isDebugging: boolean;
      constructor() { this.isDebugging = false; }
      start() { this.isDebugging = true; }
      stop() { this.isDebugging = false; }
    }

    class SlashCommandBreakPointCompat {}
    class SlashCommandClosureResultCompat {
      public value: any;
      constructor(value: any) { this.value = value; }
    }

    class SlashCommandParserErrorCompat extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'SlashCommandParserError';
      }
    }

    class SlashCommandExecutorCompat extends SlashCommandClosureCompat {
      public start: number;
      public end: number;
      constructor(commands: string, start: number, end: number) {
        super(commands);
        this.start = start;
        this.end = end;
      }
    }

    const slashCommandReturnHelperCompat = {
      // ST SlashCommandReturnHelper.doReturn(returnType, list, { objectToStringFunc })
      doReturn: async (returnType: string | null, list: any[], options?: any) => {
        const type = String(returnType ?? 'pipe');
        const arr = Array.isArray(list) ? list : [list];
        if (type === 'object') return arr;
        if (type === 'pipe' || type === 'string') {
          if (options && typeof options.objectToStringFunc === 'function') {
            return options.objectToStringFunc(arr);
          }
          return arr.join(', ');
        }
        return arr;
      },
      enumList: (_options?: any) => () => [],
    };

    class SlashCommandArgumentCompat {
      public description: string;
      public typeList: any[];
      public isRequired: boolean;
      public acceptsMultiple: boolean;
      public defaultValue: any;
      public enumList: any[];
      public enumProvider: any;
      public forceEnum: boolean;
      constructor(
        description: string,
        typeList: any[] = [],
        isRequired: boolean = false,
        defaultValue: any = null,
        enumList: any[] = [],
        enumProvider?: any,
      ) {
        this.description = description;
        this.typeList = Array.isArray(typeList) ? typeList : [];
        this.isRequired = isRequired;
        this.acceptsMultiple = false;
        this.defaultValue = defaultValue;
        this.enumList = Array.isArray(enumList) ? enumList : [];
        this.enumProvider = enumProvider;
        this.forceEnum = false;
      }
      // ST 1.18: SlashCommandArgument.fromProps({ description, typeList, isRequired, acceptsMultiple, defaultValue, enumList, enumProvider, forceEnum })
      static fromProps(props: any): SlashCommandArgumentCompat {
        const arg = new SlashCommandArgumentCompat(
          props?.description ?? '',
          props?.typeList ?? [],
          props?.isRequired ?? false,
          props?.defaultValue ?? null,
          props?.enumList ?? [],
          props?.enumProvider ?? null,
        );
        arg.acceptsMultiple = props?.acceptsMultiple ?? false;
        arg.forceEnum = props?.forceEnum ?? false;
        return arg;
      }
    }

    class SlashCommandNamedArgumentCompat extends SlashCommandArgumentCompat {
      public name: string;
      constructor(
        name: string,
        description: string,
        typeList: any[] = [],
        isRequired: boolean = false,
        defaultValue: any = null,
        enumList: any[] = [],
        enumProvider?: any,
      ) {
        super(description, typeList, isRequired, defaultValue, enumList, enumProvider);
        this.name = name;
      }
      static fromProps(props: any): SlashCommandNamedArgumentCompat {
        return new SlashCommandNamedArgumentCompat(
          props?.name ?? '',
          props?.description ?? '',
          props?.typeList ?? [],
          props?.isRequired ?? false,
          props?.defaultValue ?? null,
          props?.enumList ?? [],
          props?.enumProvider,
        );
      }
    }

    class SlashCommandEnumValueCompat {
      public value: any;
      public description: string;
      public icon: number;
      constructor(value: any, description: string = '', icon: number = 0) {
        this.value = value;
        this.description = description;
        this.icon = icon;
      }
      static fromProps(props: any): SlashCommandEnumValueCompat {
        return new SlashCommandEnumValueCompat(
          props?.value ?? '',
          props?.description ?? '',
          props?.icon ?? 0,
        );
      }
    }

    // 插件注册的命令表（名称 → 命令对象），供 SlashCommandParser.parse 查命令
    const registeredSlashCommands = new Map<string, any>();
    // 已注册到 Palink 引擎的原始名称 → 别名列表（卸载时清理用）
    const registeredCommandAliases = new Map<string, string[]>();

    const registerCommandObjectToEngine = (command: any) => {
      if (!command || typeof command.name !== 'string' || !command.name) return;
      const callback = typeof command.callback === 'function' ? command.callback : undefined;
      if (!callback) return;
      try {
        context.registerCommand({
          name: command.name,
          callback,
          aliases: Array.isArray(command.aliases) ? command.aliases : undefined,
          help: command.helpString || command.help || '',
          returns: command.returns,
        });
        registeredSlashCommands.set(command.name, command);
        registeredCommandAliases.set(command.name, Array.isArray(command.aliases) ? command.aliases : []);
        // K-1 修复: 同步维护 SlashCommandParser.commands（ST 语义，name→command 对象，
        // 别名也指向同一 command；connection-manager/assets 插件直接索引该对象）
        if (SlashCommandParserCompat) {
          SlashCommandParserCompat.commands[command.name] = command;
          if (Array.isArray(command.aliases)) {
            for (const alias of command.aliases) {
              SlashCommandParserCompat.commands[alias] = command;
            }
          }
        }
      } catch (e) {
        console.warn(`[PluginSandbox] addCommandObject 注册失败 (${command.name}):`, e);
      }
    };

    class SlashCommandCompat {
      public name: string;
      public callback: Function;
      public aliases: string[];
      public helpString: string;
      public namedArgumentList: any[];
      public unnamedArgumentList: any[];
      public returns: any;
      public interruptible: boolean;
      public purgeFromMessage: boolean;
      constructor(
        name: string,
        callback: Function,
        aliases: string[] = [],
        helpString: string = '',
        namedArgumentList: any[] = [],
        unnamedArgumentList: any[] = [],
        returns?: any,
      ) {
        this.name = name;
        this.callback = callback;
        this.aliases = Array.isArray(aliases) ? aliases : [];
        this.helpString = helpString;
        this.namedArgumentList = Array.isArray(namedArgumentList) ? namedArgumentList : [];
        this.unnamedArgumentList = Array.isArray(unnamedArgumentList) ? unnamedArgumentList : [];
        this.returns = returns;
        this.interruptible = true;
        this.purgeFromMessage = false;
      }
      // ST 1.18: SlashCommand.fromProps({ name, callback, aliases, helpString,
      //   namedArgumentList, unnamedArgumentList, returns, interruptible, purgeFromMessage })
      static fromProps(props: any): SlashCommandCompat {
        return new SlashCommandCompat(
          props?.name ?? '',
          props?.callback,
          props?.aliases ?? [],
          props?.helpString ?? props?.help ?? '',
          props?.namedArgumentList ?? [],
          props?.unnamedArgumentList ?? [],
          props?.returns,
        );
      }
    }

    class SlashCommandParserCompat {
      // K-1 修复: ST 1.18.0 SlashCommandParser.js:44 `static commands = {}`（name→command
      // 对象，含别名）。connection-manager(index.js:227/417)/assets(index.js:108/499)/
      // SlashCommandBrowser(index.js:79-82) 直接索引该对象。
      static commands: Record<string, any> = {};
      static addCommandObject(command: any) {
        registerCommandObjectToEngine(command);
      }
      static addCommand(name: string, callback: Function, aliases?: string[], helpString?: string) {
        registerCommandObjectToEngine({ name, callback, aliases, helpString, help: helpString });
      }
      static removeCommand(name: string): boolean {
        try {
          SlashCommandEngine.unregister(name);
          const aliases = registeredCommandAliases.get(name) || [];
          for (const alias of aliases) {
            SlashCommandEngine.unregister(alias);
          }
          registeredCommandAliases.delete(name);
          // K-1: 同步从 commands 对象移除（name 与别名）
          delete SlashCommandParserCompat.commands[name];
          for (const alias of aliases) {
            delete SlashCommandParserCompat.commands[alias];
          }
          return registeredSlashCommands.delete(name);
        } catch {
          return false;
        }
      }
      static getCommand(name: string) {
        return registeredSlashCommands.get(name);
      }
      static getAllCommands() {
        return Array.from(registeredSlashCommands.values());
      }
      static getCommandsCount(): number {
        return registeredSlashCommands.size;
      }
      // 实例方法 parse：将命令字符串解析为可执行闭包（quick-reply/connection-manager 依赖）
      // ST 签名: parse(input, isQuiet, args, abortController, debugController) → SlashCommandClosure
      public commandIndex: any[] = [];
      parse(
        input: string,
        _isQuiet?: boolean,
        _args?: any[],
        _abortController?: any,
        _debugController?: any,
      ): SlashCommandClosureCompat {
        const closure = new SlashCommandClosureCompat(input);
        // 构造 commandIndex（供编辑器断点/进度功能使用；非关键路径可留空）
        this.commandIndex = [];
        return closure;
      }
    }

    const slashCommandModule: Record<string, unknown> = {
      SlashCommand: SlashCommandCompat,
      SlashCommandParser: SlashCommandParserCompat,
      SlashCommandArgument: SlashCommandArgumentCompat,
      SlashCommandNamedArgument: SlashCommandNamedArgumentCompat,
      SlashCommandEnumValue: SlashCommandEnumValueCompat,
      SlashCommandClosure: SlashCommandClosureCompat,
      SlashCommandAbortController: SlashCommandAbortControllerCompat,
      SlashCommandDebugController: SlashCommandDebugControllerCompat,
      SlashCommandBreakPoint: SlashCommandBreakPointCompat,
      SlashCommandClosureResult: SlashCommandClosureResultCompat,
      SlashCommandParserError: SlashCommandParserErrorCompat,
      SlashCommandExecutor: SlashCommandExecutorCompat,
      SlashCommandScope: SlashCommandScopeCompat,
      slashCommandReturnHelper: slashCommandReturnHelperCompat,
      ARGUMENT_TYPE: {
        STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean',
        DICTIONARY: 'dictionary', LIST: 'list', SUBCOMMAND: 'subcommand',
        VARIABLE_NAME: 'variable_name', ENUM: 'enum',
      },
      commonEnumProviders: {
        messages: () => [],
        characters: () => [],
        personas: () => [],
        boolean: (_format: string) => () => {
          const vals = _format === 'trueFalse'
            ? [new SlashCommandEnumValueCompat('true', 'true'), new SlashCommandEnumValueCompat('false', 'false')]
            : [new SlashCommandEnumValueCompat('yes', 'yes'), new SlashCommandEnumValueCompat('no', 'no')];
          return vals;
        },
        enumList: (list: any[], _options?: any) => () =>
          Array.isArray(list) ? list.map((v: any) => new SlashCommandEnumValueCompat(v)) : [],
      },
      enumIcons: { NONE: 0, STAR: 1 },
      enumTypes: { command: 'command', enum: 'enum', variable: 'variable', name: 'name' },
    };

    const moduleMap: Record<string, Record<string, unknown>> = {
      // script.js — ST 主脚本（最常被导入的模块）
      'script.js': {
        characters,
        // P-5: chat/chat_metadata 改实时 getter —— 此前为 createMockRequire 构建时的
        // 快照（stContext.chatMetadata 取一次），runtime setContext 切换聊天后模块仍
        // 指向旧对象，quick-reply 等插件读旧值。每次访问经 buildStContext() 取最新
        // （内部 map(toStMessage) 生成副本，插件改动不污染主应用消息数组）。
        get chat() {
          try {
            const st = buildStContext() || {};
            return Array.isArray(st.chat) ? st.chat : chat;
          } catch {
            return chat;
          }
        },
        get chat_metadata() {
          try {
            const st = buildStContext() || {};
            return st.chatMetadata ?? chatMetadata;
          } catch {
            return chatMetadata;
          }
        },
        eventSource: sandbox.eventSource,
        event_types: sandbox.eventTypes,
        this_chid: thisChid,
        name1,
        name2,
        main_api: mainApi,
        is_send_press: false,
        online_status: true,
        // P-5 同源修复：getCurrentChatId 此前返回 createMockRequire 构建时快照，
        // 聊天切换后仍指向旧 chatId，regex/tts/vectors/stable-diffusion 等插件
        // 用「chatId !== getCurrentChatId()」做聊天切换判定会失效。改为实时读取。
        getCurrentChatId: () => {
          try {
            return (buildStContext()?.chatId as string) ?? chatId;
          } catch {
            return chatId;
          }
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        messageFormatting: sandbox.messageFormatting,
        reloadCurrentChat: async () => { /* no-op in palink-native */ },
        // Phase 1: 扩展惯用「原地改嵌套字段 + saveSettingsDebounced()」持久化，
        // 嵌套写不触发 Proxy set 拦截器，故此处必须同时持久化共享 store
        saveSettingsDebounced: (...args: unknown[]) => {
          saveExtensionSettingsDebounced();
          if (typeof stContext.saveSettingsDebounced === 'function') {
            try { (stContext.saveSettingsDebounced as Function)(...args); } catch { /* ignore */ }
          }
        },
        substituteParams: sandbox.substituteParams,
        substituteParamsExtended: sandbox.substituteParams,
        generateQuietPrompt: typeof stContext.generateQuietPrompt === 'function'
          ? stContext.generateQuietPrompt
          : async () => '',
        generateRaw: typeof stContext.generateRaw === 'function'
          ? stContext.generateRaw
          : async () => '',
        setExtensionPrompt: sandbox.setExtensionPrompt,
        extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        getMaxPromptTokens: () => 4096,
        streamingProcessor: null,
        animation_duration: 200,
        animation_easing: 'ease',
        activateSendButtons: () => {},
        deactivateSendButtons: () => {},
        appendMediaToMessage: () => {},
        saveChatConditional: async () => {},
        // P-6: shared.js 顶层 import（CONNECT_API_MAP/createModelIcon）→ 此前缺失 undefined
        CONNECT_API_MAP: {
          openai: { name: 'OpenAI', api: 'openai' },
          custom: { name: 'Custom', api: 'custom' },
          anthropic: { name: 'Anthropic', api: 'anthropic' },
          google: { name: 'Google AI Studio', api: 'google' },
          mistral: { name: 'Mistral', api: 'mistral' },
          xai: { name: 'xAI', api: 'xai' },
          zai: { name: 'Z.ai', api: 'zai' },
          moonshot: { name: 'Moonshot', api: 'moonshot' },
          deepseek: { name: 'DeepSeek', api: 'deepseek' },
          openrouter: { name: 'OpenRouter', api: 'openrouter' },
          groq: { name: 'Groq', api: 'groq' },
          vertexai: { name: 'Vertex AI', api: 'vertexai' },
        },
        createModelIcon: (api: string) => `icon-${String(api ?? '').toLowerCase()}`,
      },

      // extensions.js — 扩展系统核心
      'extensions.js': {
        extension_settings: extensionSettings,
        getContext: sandbox.getContext,
        getApiUrl: () => '/api',
        doExtrasFetch: async (url: string, options: any) =>
          (sandbox.fetch as any)?.(url, options),
        // K-4 修复: ST extensions.js:2061-2111 writeExtensionField(characterId, key, value)
        // 写角色卡 data.extensions.{key} 并 POST /api/characters/merge-attributes 持久化
        // （此前缺失 → regex/engine.js:148 等插件 import 后调用抛 TypeError）。
        // A-3 修复（2026-08-23）: 收敛到共享 writeExtensionFieldCompat（与
        // getContext 轨 / sandbox.getContext 轨同一实现），消除三轨三义。
        writeExtensionField: (characterId: number | string, key: string, value: unknown): Promise<void> =>
          writeExtensionFieldCompat(characterId, key, value),
        modules: [],
        renderExtensionTemplateAsync: async (extensionName = '', templateName = '', data: Record<string, any> = {}): Promise<string> => {
          const templates = (context as unknown as Record<string, unknown>).pluginTemplates as
            | Array<{ path?: string; content?: string; missing?: boolean }>
            | undefined;
          const wanted = normalizeTemplateName(String(templateName || extensionName || 'template'));
          const found = Array.isArray(templates)
            ? templates.find((t) => {
                if (!t || t.missing || typeof t.content !== 'string') return false;
                const p = normalizeTemplateName(String(t.path || ''));
                return p === wanted || p.endsWith('/' + wanted) || p.endsWith('/templates/' + wanted) || p.endsWith('/template/' + wanted);
              })
            : undefined;
          if (found?.content) {
            // P-8: 完整 Handlebars 渲染（{{#if}}/{{#each}}/helper 等），失败回退简单替换
            return compileFullTemplateForSandbox(found.content, data);
          }
          return '';
        },
        ModuleWorkerWrapper: class {
          private fn: Function;
          private timer: ReturnType<typeof setInterval> | null = null;
          constructor(fn: Function) { this.fn = fn; }
          set(interval: number) { this.timer = setInterval(() => this.fn(), interval); }
          clearTimeout() { if (this.timer) clearInterval(this.timer); }
        },
        installExtension: async () => {},
        deleteExtension: async () => {},
        extensionNames: [],
        EMPTY_AUTHOR: '',
        getAuthorFromUrl: () => '',
        isOfficialExtension: () => false,
        // P-6: shared.js 顶层 import openThirdPartyExtensionMenu → 此前缺失 undefined
        openThirdPartyExtensionMenu: async () => {},
      },

      // group-chats.js
      'group-chats.js': {
        selected_group: stContext.groupId ?? null,
        is_group_generating: false,
      },

      // popup.js
      // P-6: 补 POPUP_RESULT（connection-manager/expressions/quick-reply 顶层 import）
      'popup.js': {
        callGenericPopup: sandbox.callGenericPopup,
        Popup: sandbox.Popup,
        POPUP_TYPE: sandbox.POPUP_TYPE,
        POPUP_RESULT: { AFFIRMATIVE: 'AFFIRMATIVE', NEGATIVE: 'NEGATIVE', CUSTOM: 'CUSTOM' },
      },

      // utils.js — 工具函数集合
      'utils.js': {
        download: () => {},
        escapeHtml: (s: string) => String(s).replace(
          /[&<>"']/g,
          (c: string) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c),
        ),
        getStringHash: (s: string) => {
          let h = 0;
          for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
          return h;
        },
        debounce: (fn: Function, delay: number) => {
          let t: ReturnType<typeof setTimeout> | null = null;
          return (...args: any[]) => {
            if (t) clearTimeout(t);
            t = setTimeout(() => fn(...args), delay);
          };
        },
        // ST 1.18 utils.js debounceAsync：带 promise 语义的防抖（quick-reply 的
        // QuickReplySet.save = debounceAsync(() => this.performSave(), 200) 依赖）。
        debounceAsync: (fn: Function, timeout = 250) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let debouncePromise: Promise<any> | null = null;
          let debounceResolver: ((v: any) => void) | null = null;
          return (...args: any[]) => {
            if (timer) clearTimeout(timer);
            if (!debouncePromise) {
              debouncePromise = new Promise(resolve => {
                debounceResolver = resolve;
              });
            }
            timer = setTimeout(() => {
              const result = fn(...args);
              if (debounceResolver) debounceResolver(result);
              debouncePromise = null;
              debounceResolver = null;
            }, timeout);
            return debouncePromise;
          };
        },
        waitUntilCondition: async (cond: () => boolean, timeout = 5000) => {
          const start = Date.now();
          while (!cond()) {
            if (Date.now() - start > timeout) return false;
            await new Promise(r => setTimeout(r, 50));
          }
          return true;
        },
        extractAllWords: (s: string) => String(s).split(/\s+/).filter(Boolean),
        isTrueBoolean: (v: any) => v === true || v === 'true',
        isFalseBoolean: (v: any) => v === false || v === 'false',
        equalsIgnoreCaseAndAccents: (a: string, b: string) =>
          String(a).toLowerCase() === String(b).toLowerCase(),
        getFileText: async () => '',
        getSortableDelay: () => 100,
        regexFromString: (s: string) => {
          const m = String(s).match(/^\/(.+)\/([gimuy]*)$/);
          return m ? new RegExp(m[1], m[2]) : new RegExp(s);
        },
        setInfoBlock: () => {},
        uuidv4: () =>
          'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          }),
        getBase64Async: async () => '',
        getFileExtension: (name: string) => {
          const m = String(name).match(/\.([^./\\]+)$/);
          return m ? m[1] : '';
        },
        saveBase64AsFile: () => {},
        ensureImageFormatSupported: (url: string) => url,
        resetScrollHeight: () => {},
        flashHighlight: () => {},
        isValidUrl: (s: string) => {
          try { new URL(s); return true; } catch { return false; }
        },
        // ===== K-3: ST 1.18.0 utils.js 缺失导出补齐 =====
        // gallery 插件打开即 TypeError 的 4 个函数（utils.js:1248/1617/1719/3035）。
        clamp: (value: number, min: number, max: number) =>
          Math.min(Math.max(value, min), max),
        // ST 通过后端 /api/files/sanitize-filename 清理文件名；Palink 后端无此端点，
        // 按 ST 后端同样的非法字符规则本地实现（Windows 保留字符 + 控制字符）。
        getSanitizedFilename: async (fileName: string) =>
          String(fileName ?? '').replace(/[/\\?%*:|"<>]/g, '_').replace(/[\x00-\x1f]/g, ''),
        // ST 创建 link/script 元素加载外部 css/js；沙箱隔离原则下不真正注入外部
        // 资源到文档，直接 resolve（调用方 await 后继续，不抛 TypeError）。
        loadFileToDocument: (url: string, type: string) =>
          new Promise<void>((resolve) => {
            if (type !== 'css' && type !== 'js') {
              resolve();
              return;
            }
            try {
              // 安全降级：仅记录，不加载外部脚本/样式到主文档
              console.debug(`[PluginSandbox] loadFileToDocument 沙箱降级: ${type} ${String(url).slice(0, 120)}`);
            } catch { /* ignore */ }
            resolve();
          }),
        // 沙箱内无真实 <video> 帧捕获能力，返回空 dataURL（gallery 视频缩略图跳过）。
        getVideoThumbnail: async (_videoUrl: string, _maxWidth?: number, _maxHeight?: number, _type = 'image/jpeg') => '',
      },

      // ===== K-2: ST 1.18.0 缺失整模块补齐 =====
      // chats.js / world-info.js / dragdrop.js 此前完全缺失 → attachments/vectors/gallery
      // 顶层 import 得 undefined，调用即 TypeError。Palink 无 ST 的 Data Bank 附件系统，
      // 故按"签名对齐 + 安全兜底"实现：读类返回空数组/空文本，写类 no-op，调用方不崩溃。
      // 消费点：vectors:26-29（getDataBankAttachments*/getFileAttachment/getSortedEntries）、
      // attachments:2（deleteAttachment/uploadFileAttachmentToServer）、
      // gallery:17-21（DragAndDropHandler/deleteMediaFromServer）。
      'chats.js': {
        getDataBankAttachments: (_includeDisabled = false) => [],
        getDataBankAttachmentsForSource: (_source: string, _includeDisabled = true) => [],
        // ST 通过 fetch(url) 读取附件文本；沙箱 fetch 为同源代理，可正常读取
        // Palink 同源附件资源，失败返回 null（vectors 遇 null 会 continue 跳过）。
        getFileAttachment: async (url: string) => {
          try {
            const resp = await (sandbox.fetch as any)?.(url, { method: 'GET' });
            if (!resp || !resp.ok) return null;
            return await resp.text();
          } catch {
            return null;
          }
        },
        deleteAttachment: async () => false,
        uploadFileAttachmentToServer: async () => '',
        deleteMediaFromServer: async (_url: string, _silent = false) => false,
      },

      // world-info.js —— vectors:29 消费 getSortedEntries（世界书条目向量化入口）。
      // Palink 世界书数据由后端管理，沙箱内返回空数组让 vectors 优雅跳过。
      'world-info.js': {
        getSortedEntries: async () => [],
      },

      // dragdrop.js —— gallery:17 消费 DragAndDropHandler（拖拽上传处理）。
      // 最小实现：构造/销毁均安全 no-op，不绑定真实 DOM 拖拽（沙箱内无文件系统能力）。
      'dragdrop.js': {
        DragAndDropHandler: class DragAndDropHandlerCompat {
          constructor(_selector?: string, _onDrop?: (files: any[]) => void) { /* no-op */ }
          destroy(): void { /* no-op */ }
        },
      },

      // i18n.js
      'i18n.js': {
        t: (s: string) => s,
        translate: (s: string) => s,
      },

      // tokenizers.js
      // K-9 修复: 委托 getContext 的真实实现（getContext.ts 已接后端 /api/tokenizers/count
      // 与 /api/tokenizers/encode），修复 token-counter/memory 插件计数恒 0/空数组；
      // 失败静默回退。签名对齐 ST 1.18.0：getTextTokens(tokenizerType, str)——
      // 第一个参数是 tokenizer 类型（数字枚举），第二个是文本；tokenizers 枚举值
      // 与 ST 一致（NONE:0/GPT2:1/OPENAI:2/LLAMA:3...）。
      'tokenizers.js': {
        getTextTokens: (tokenizerType: number, str?: string) => {
          try {
            const ctx = (sandbox.getContext as any)?.();
            const fn = ctx?.getTextTokens;
            if (typeof fn === 'function') {
              const r = fn(str ?? '', _stTokenizerTypeToName(tokenizerType));
              return Array.isArray(r) ? r : [];
            }
          } catch { /* ignore */ }
          return [];
        },
        getTokenCountAsync: async (str: string, tokenizerType?: number) => {
          try {
            const ctx = (sandbox.getContext as any)?.();
            const fn = ctx?.getTokenCountAsync;
            if (typeof fn === 'function') {
              const n = await fn(str ?? '', _stTokenizerTypeToName(tokenizerType));
              return typeof n === 'number' && Number.isFinite(n) ? n : 0;
            }
          } catch { /* ignore */ }
          return 0;
        },
        // ST 1.18.0 tokenizers 枚举（tokenizers.js:16-38 前 4 个 + 常用 API 类型）
        tokenizers: { NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5, API_CURRENT: 6, MISTRAL: 7, YI: 8, API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10, CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15, COMMAND_R: 16, NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99 },
        getFriendlyTokenizerName: (forApi?: string) => {
          // ST: openai → tokenizerName=getTokenizerModel()、tokenizerId=OPENAI(2)
          const isOpenAI = !forApi || forApi === 'openai';
          return {
            tokenizerName: isOpenAI ? 'cl100k_base' : 'noop',
            tokenizerKey: isOpenAI ? 'openai' : 'none',
            tokenizerId: isOpenAI ? 2 : 0,
          };
        },
      },

      // constants.js
      // P-6: debounce_timeout 从数字改为 ST 1.18 对象结构（stable-diffusion 读 .relaxed/.short）；
      //     补 IMAGE_OVERSWIPE/SWIPE_DIRECTION/VIDEO_EXTENSIONS（stable-diffusion 顶层 import）
      'constants.js': {
        debounce_timeout: {
          slow: 1000,
          medium: 500,
          relaxed: 100,
          standard: 250,
          quick: 50,
          fast: 25,
          short: 10,
        },
        MEDIA_DISPLAY: { GRID: 0, CARD: 1, HIDE: 2 },
        MEDIA_SOURCE: { PROMPT: 0, CHAT: 1, USER: 2 },
        MEDIA_TYPE: { NONE: 0, IMAGE: 1, VIDEO: 2, AUDIO: 3, FILE: 4 },
        SCROLL_BEHAVIOR: 'smooth',
        IMAGE_OVERSWIPE: { NONE: 0, GENERATE: 1, SEND: 2 },
        SWIPE_DIRECTION: { RIGHT: 1, LEFT: -1 },
        VIDEO_EXTENSIONS: ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'],
      },

      // power-user.js
      // P-9: power_user 字段补齐 —— 原仅 { persona_show_user_name, persona_description_position }
      // 缺 waifuMode/experimental_macro_engine 等 → expressions 读 waifuMode 失效、memory 读
      // experimental_macro_engine 恒 undefined 走旧分支。补齐 ST 1.18.0 power_user 常用字段
      // （waifuMode=false 关闭精灵图模式，避免依赖缺失的精灵图资源；其余取 ST 默认）。
      'power-user.js': {
        loadMovingUIState: () => {},
        performFuzzySearch: performFuzzySearchCompat,
        // P-6: vectors 顶层 import collapseNewlines/registerDebugFunction
        collapseNewlines: (s: string) => String(s ?? '').replace(/\n{3,}/g, '\n\n'),
        registerDebugFunction: () => {},
        // P-9 相关：ST power-user.js 导出 persona_description_positions
        persona_description_positions: { IN_PROMPT: 0, IN_CHAT: 1, AFTER_CHAT: 2 },
        power_user: {
          persona_show_user_name: false,
          persona_description_position: 0,
          waifuMode: false,
          experimental_macro_engine: true,
          macro_in_chat: true,
          instruct: { enabled: false },
          context_creation: { enabled: false },
          show_card_avatar: true,
          show_avatar_in_sidebar: false,
          avatar_in_sidebar: false,
          show_name_in_sidebar: true,
          show_avatar_in_chat: false,
          show_avatar_in_editor: true,
          always_show_name: false,
          multi_avatar_sources: false,
          use_old_message_input: false,
          enable_macros: true,
          enable_stable_ui: true,
          hotswap_enabled: true,
          auto_scan_character_card_metadata: true,
          enable_moving_ui: false,
          flush_on_user_message: false,
          flush_on_ai_message: false,
          flush_on_chat_switch: false,
        },
      },

      // preset-manager.js
      // K-4 修复: 补 ST preset-manager.js:846/876 的 readPresetExtensionField /
      // writePresetExtensionField 与 getSelectedPresetName（regex/index.js:1680-1685
      // onMainApiChanged 直接调用，此前缺失 → init TypeError）。
      // Palink 无 ST preset 数据，读取返回 null、写入 no-op（安全兜底不崩溃）。
      'preset-manager.js': {
        getPresetManager: () => ({
          getPresets: () => [],
          selectPreset: () => {},
          getPreset: () => ({}),
          getSelectedPresetName: () => '',
          readPresetExtensionField: () => null,
          writePresetExtensionField: async () => {},
        }),
      },

      // secrets.js
      // P-10: SECRET_KEYS 补齐 —— 原为 {}，导致 shared.js throwIfInvalidModel 中
      // SECRET_KEYS.OPENAI === undefined → secret_state[undefined] → 恒抛 "API key is not set"。
      // 补齐 ST 1.18.0 全部 SECRET_KEYS 常量；secret_state 保持空对象（Palink 密钥由
      // 后端 provider 管理，插件不直接持有明文 key），但校验逻辑不再误判。
      'secrets.js': {
        SECRET_KEYS: {
          OPENAI: 'OPENAI',
          OPENROUTER: 'OPENROUTER',
          CLAUDE: 'CLAUDE',
          MAKERSUITE: 'MAKERSUITE',
          GROQ: 'GROQ',
          MISTRAL: 'MISTRAL',
          XAI: 'XAI',
          ZAI: 'ZAI',
          MOONSHOT: 'MOONSHOT',
          DEEPSEEK: 'DEEPSEEK',
          VERTEXAI: 'VERTEXAI',
          SCALINGLABS: 'SCALINGLABS',
          NOVELAI: 'NOVELAI',
          HORDE: 'HORDE',
          DEEPLX: 'DEEPLX',
          AI21: 'AI21',
          DREAMGEN: 'DREAMGEN',
          TINYGRAIN: 'TINYGRAIN',
          CUSTOM: 'CUSTOM',
          OPENAI_LABEL: 'OpenAI',
          OPENROUTER_LABEL: 'OpenRouter',
          CLAUDE_LABEL: 'Anthropic',
          MAKERSUITE_LABEL: 'Google AI Studio',
          GROQ_LABEL: 'Groq',
          MISTRAL_LABEL: 'Mistral',
          XAI_LABEL: 'xAI',
          ZAI_LABEL: 'Z.ai',
          MOONSHOT_LABEL: 'Moonshot',
          DEEPSEEK_LABEL: 'DeepSeek',
          NOVELAI_LABEL: 'NovelAI',
          HORDE_LABEL: 'AI Horde',
          DEEPLX_LABEL: 'DeepLX',
          AI21_LABEL: 'AI21',
          DREAMGEN_LABEL: 'DreamGen',
          TINYGRAIN_LABEL: 'TinyGrain',
        },
        secret_state: {},
        getSecretLabelById: getSecretLabelByIdCompat,
        // ST secrets.js 还导出以下常用 API（连接管理器等可能调用）
        isSecretSet: (_key: string) => false,
        setSecret: async () => {},
        deleteSecret: async () => {},
        writeSecret: async () => {},
        getSecret: (_key: string) => '',
        getSecretKeys: () => [],
      },

      // openai.js
      // P-10: oai_settings 字段补齐 —— 原仅 { preset: 'default' }，缺 reverse_proxy/custom_url
      // 等。shared.js（getMultimodalCaption）读 oai_settings.reverse_proxy/proxy_password 做
      // reverse proxy 判定；caption/vectors 读 oai_settings 配置模型。补齐 ST 1.18.0 常用字段。
      // proxies/ZAI_ENDPOINT 为 shared.js 顶层 import，此前缺失 → import 得 undefined。
      'openai.js': {
        oai_settings: {
          preset: 'default',
          chat_completion_source: 'openai',
          reverse_proxy: '',
          custom_url: '',
          proxy_password: '',
          openai_model: 'gpt-4o',
          max_context: 16384,
          max_tokens: 2048,
          temperature: 1,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0,
          stream_openai: true,
          openai_use_fallback: false,
          openai_fallback_models: [],
          openai_max_concurrent_requests: 4,
          openai_max_retries: 5,
          openai_max_timeout: 60,
          nsfw_filter: false,
          nsfw_toggle: false,
          nsfw_toggle_keys: [],
          custom_instructions: '',
          custom_instructions_enabled: false,
          new_max_tokens: 2048,
          new_max_context: 16384,
          vertexai_auth_mode: 'service_account',
          vertexai_region: 'us-central1',
          vertexai_express_project_id: '',
          vertexai_express_region: 'us-central1',
          mistral_api_mode: 'endpoint',
          mistral_server_endpoint: '',
          mistral_express_project_id: '',
          mistral_express_region: 'eu-west-1',
          groq_api_url: '',
          deepseek_api_url: '',
          zai_api_url: '',
          moonshot_api_url: '',
          aya_ai_model: '',
        },
        proxies: [],
        // P-6: ZAI_ENDPOINT 为对象（shared.js 读 ZAI_ENDPOINT.COMMON），原缺失 → undefined
        ZAI_ENDPOINT: {
          COMMON: 'https://api.z.ai/api/paas/v4/chat/completions',
          EXPRESS: 'https://express.z.ai/api/paas/v4/chat/completions',
        },
        getCustomUrl: () => '',
        getReverseProxy: () => '',
        // ST openai.js 常用导出
        getContext: () => ({}),
        oai_settings_migrations: {},
        is_openai_configured: false,
        use_reverse_proxy: false,
      },

      // textgen-settings.js
      'textgen-settings.js': {
        textgen_types: { OOBA: 0, MANCER: 1, APHRODITE: 2, TABBYAPI: 3 },
        textgenerationwebui_settings: { temp: 1, top_p: 1 },
      },

      // RossAscends-mods.js
      'RossAscends-mods.js': {
        dragElement: () => {},
        getMessageTimeStamp: () => new Date().toISOString(),
      },

      // reasoning.js
      'reasoning.js': {
        removeReasoningFromString: (s: string) => s,
        // P-6: formatReasoning（connection-manager 顶层 import，拼接思维链 + 正文）
        formatReasoning: formatReasoningCompat,
        // ST reasoning.js 常用导出
        reasoningStyle: 'native',
        getReasoningStyle: () => 'native',
      },

      // macros.js (绝对路径 /scripts/macros.js)
      'macros.js': {
        MacrosParser: class { static parse() { return []; } },
      },

      // macros/macro-system.js
      'macros/macro-system.js': {
        macros: {},
        MacroCategory: { GLOBAL: 'global', CHARACTER: 'character' },
      },

      // shared.js (extensions/shared.js)
      // P-6: ConnectionManagerRequestService（connection-manager 顶层 import，缺失 → TypeError）
      'shared.js': {
        countWebLlmTokens: async () => 0,
        generateWebLlmChatPrompt: async () => '',
        getWebLlmContextSize: () => 0,
        isWebLlmSupported: () => false,
        getMultimodalCaption: async () => '',
        getVideoCaption: async () => '',
        ConnectionManagerRequestService: ConnectionManagerRequestServiceCompat,
      },

      // lib.js — 第三方库统一入口
      // P-6: 补 Fuse/Popper（expressions/connection-manager/stable-diffusion 顶层 import）
      'lib.js': {
        DOMPurify: DOMPurify,
        Fuse: MiniFuse,
        Popper: popperCompat,
      },

      // action-loader.js (/scripts/action-loader.js)
      // P-6: stable-diffusion 顶层 import { ActionLoaderHandle, loader } → 此前缺失 TypeError
      'action-loader.js': {
        loader: actionLoaderCompat,
        ActionLoaderHandle: ActionLoaderHandleCompat,
      },

      // nai-settings.js
      // P-6: stable-diffusion 顶层 import getNovelAnlas 等 → 此前缺失 TypeError
      'nai-settings.js': {
        getNovelAnlas: naiSettingsCompat.getNovelAnlas,
        getNovelUnlimitedImageGeneration: naiSettingsCompat.getNovelUnlimitedImageGeneration,
        loadNovelSubscriptionData: naiSettingsCompat.loadNovelSubscriptionData,
      },

      // tool-calling.js
      // P-6: stable-diffusion 顶层 import { ToolManager } → 此前缺失 TypeError
      'tool-calling.js': {
        ToolManager: ToolManagerCompat,
      },

      // streaming-display.js (/scripts/streaming-display.js)
      // P-6: connection-manager 顶层 import { StreamingDisplay } → 此前缺失 TypeError
      'streaming-display.js': {
        StreamingDisplay: StreamingDisplayCompat,
      },

      // util/AccountStorage.js
      'util/AccountStorage.js': {
        accountStorage: {
          get: () => null,
          set: () => {},
          delete: () => {},
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
      },
    };

    // slash-commands 系列模块共用同一组绑定
    moduleMap['slash-commands/SlashCommand.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandParser.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandArgument.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandCommonEnumsProvider.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandEnumValue.js'] = slashCommandModule;
    // P-11: 补齐其余 slash-commands 子模块（quick-reply/connection-manager 等 import）
    moduleMap['slash-commands/SlashCommandClosure.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandAbortController.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandDebugController.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandScope.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandExecutor.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandBreakPoint.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandClosureResult.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandParserError.js'] = slashCommandModule;
    moduleMap['slash-commands/SlashCommandReturnHelper.js'] = slashCommandModule;

    // P-11: slash-commands.js 根模块（quick-reply 顶层 import，非子目录）。
    // executeSlashCommandsWithOptions/OnChatInput 委托到 Palink SlashCommandEngine，
    // setSlashCommandAutoComplete 提供补全（沙箱内轻量实现）。
    moduleMap['slash-commands.js'] = {
      executeSlashCommandsWithOptions: async (input: any, options?: any) => {
        const text = String(
          (typeof input === 'object' && input !== null) ? (input.command ?? input.source ?? input.text ?? input.value ?? '') : input,
        );
        try {
          const result = await SlashCommandEngine.execute(text);
          return { pipe: (result && result.output) || '', success: result?.success ?? true };
        } catch (e) {
          console.warn('[PluginSandbox] executeSlashCommandsWithOptions failed:', e);
          const onError = options?.onError;
          if (typeof onError === 'function') {
            try { await onError(e); } catch { /* ignore */ }
          }
          return { pipe: '', success: false };
        }
      },
      executeSlashCommandsOnChatInput: async (input: string, options?: any) => {
        const text = String(input ?? '');
        try {
          const result = await SlashCommandEngine.execute(text);
          return { pipe: (result && result.output) || '', success: result?.success ?? true };
        } catch (e) {
          console.warn('[PluginSandbox] executeSlashCommandsOnChatInput failed:', e);
          return { pipe: '', success: false };
        }
      },
      setSlashCommandAutoComplete: async (_element?: any, _quiet?: boolean) => {
        return { element: _element ?? null };
      },
      // ST 1.18 还导出 executeSlashCommands / executeSlashCommand（统一委托）
      executeSlashCommands: async (input: string) => {
        const text = String(input ?? '');
        const result = await SlashCommandEngine.execute(text);
        return (result && result.output) || '';
      },
      executeSlashCommand: async (input: string) => {
        const text = String(input ?? '');
        const result = await SlashCommandEngine.execute(text);
        return (result && result.output) || '';
      },
    };

    /**
     * 基于目录的 require 解析器：ST 模块白名单优先，其次解析插件本地模块。
     * 本地模块按 baseDir 解析相对路径（支持 ./ 与 ../），惰性求值并缓存导出。
     */
    const makeRequire = (baseDir: string): ((importPath: string) => Record<string, unknown>) => {
      return (importPath: string): Record<string, unknown> => {
        // 1. ST 模块白名单优先
        const normalized = normalizeModulePath(importPath);
        const stMod = moduleMap[normalized];
        if (stMod) return stMod;

        // 2. 插件本地模块（相对路径按 baseDir 解析）
        const localKey = importPath.startsWith('.')
          ? joinLocalPaths(baseDir, importPath)
          : normalized;
        if (this.pluginLocalFiles.has(localKey)) {
          const cached = this.pluginLocalExports.get(localKey);
          if (cached) return cached;
          // 预置空对象以支持循环依赖，再惰性求值覆盖
          this.pluginLocalExports.set(localKey, {});
          const content = this.pluginLocalFiles.get(localKey)!;
          const fileRequire = makeRequire(dirOf(localKey));
          const exports = this.evalLocalFile(localKey, content, fileRequire, context, pluginId);
          this.pluginLocalExports.set(localKey, exports);
          return exports;
        }

        console.warn(
          `[PluginSandbox] 未找到模块: ${importPath} → ${localKey} (plugin=${pluginId})，返回空对象`,
        );
        return {};
      };
    };

    return makeRequire(entryBaseDir);
  }

  /**
   * 获取 ST 事件类型枚举（全量，与 ST_EVENT_TYPES 一致）
   */
  private getEventTypes(): Record<string, string> {
    return { ...ST_EVENT_TYPES };
  }

  /**
   * 按 loading_order 排序加载插件清单
   */
  sortManifestsByOrder(manifests: PluginManifest[]): PluginManifest[] {
    return [...manifests].sort((a, b) => a.loadingOrder - b.loadingOrder);
  }

  /**
   * 调用 hooks.activate 指定的初始化函数
   */
  async callActivateHook(pluginId: string, hookName: string = 'activate'): Promise<void> {
    const moduleExports = this.loadedModules.get(pluginId);
    if (!moduleExports) {
      console.warn(`[PluginSandbox] 插件 ${pluginId} 未加载，无法调用钩子 ${hookName}`);
      return;
    }

    const hookFn = moduleExports[hookName] as Function | undefined;
    if (typeof hookFn === 'function') {
      try {
        await hookFn();
      } catch (error) {
        console.error(`[PluginSandbox] 插件 ${pluginId} 钩子 ${hookName} 执行失败:`, error);
        throw error;
      }
    }
  }

  /**
   * 注入插件 CSS
   */
  injectPluginCSS(pluginId: string, css: string): void {
    // 先移除旧的
    this.removePluginCSS(pluginId);

    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-plugin-id', pluginId);
    // S-1: CSS 消毒（移除 @import/javascript:url/expression 等危险构造）
    styleEl.textContent = sanitizePluginCss(css);
    document.head.appendChild(styleEl);

    this.injectedStyles.set(pluginId, styleEl);
  }

  /**
   * 移除插件 CSS
   */
  removePluginCSS(pluginId: string): void {
    const styleEl = this.injectedStyles.get(pluginId);
    if (styleEl) {
      styleEl.remove();
      this.injectedStyles.delete(pluginId);
    }
    // 也清理通过 data-plugin-id 标记的元素
    const elements = document.querySelectorAll(`style[data-plugin-id="${pluginId}"]`);
    elements.forEach(el => el.remove());
  }

  /**
   * 注册清理回调
   */
  registerCleanup(pluginId: string, callback: () => void): void {
    if (!this.cleanupCallbacks.has(pluginId)) {
      this.cleanupCallbacks.set(pluginId, []);
    }
    this.cleanupCallbacks.get(pluginId)!.push(callback);
  }

  /**
   * 清理插件所有资源（命令/宏/事件监听器/CSS/定时器）
   */
  cleanupPlugin(pluginId: string): void {
    // 执行清理回调
    const callbacks = this.cleanupCallbacks.get(pluginId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback();
        } catch (error) {
          console.error(`[PluginSandbox] 插件 ${pluginId} 清理回调失败:`, error);
        }
      }
      this.cleanupCallbacks.delete(pluginId);
    }

    // 移除 CSS
    this.removePluginCSS(pluginId);

    // 移除模块
    this.loadedModules.delete(pluginId);
  }

  /**
   * 获取插件模块导出
   */
  getModuleExports(pluginId: string): Record<string, unknown> | undefined {
    return this.loadedModules.get(pluginId);
  }

  /**
   * 检查插件是否已加载
   */
  isLoaded(pluginId: string): boolean {
    return this.loadedModules.has(pluginId);
  }
}

/**
 * 插件沙箱单例
 */
export const pluginSandbox = new PluginSandbox();
