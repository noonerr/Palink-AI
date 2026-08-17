// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import type { CharacterSmartCardContext, Language, SillyTavernPluginRuntimeConfig, SillyTavernPluginRuntimeItem, SmartCardRenderMode, SmartCardRuntimeMode } from '@/types';
import { api } from '@/services/api';
import { IFRAME_MAX_HEIGHT, IFRAME_VIEWPORT_MIN_HEIGHT, SMART_CARD_ASSET_PREFETCH_ENDPOINT, SMART_CARD_CONTEXT_ANCHOR_RADIUS, SMART_CARD_CONTEXT_FULL_MESSAGE_LIMIT, SMART_CARD_CONTEXT_HEAD_MESSAGE_COUNT, SMART_CARD_CONTEXT_RECENT_MESSAGE_COUNT, SMART_CARD_DEFERRED_RESOURCE_LIMIT, SMART_CARD_HIGH_RESOURCE_LIMIT, SMART_CARD_PRECONNECT_LIMIT, SMART_CARD_RENDER_CACHE_LIMIT, SMART_CARD_TRUST_STORAGE_PREFIX, smartCardHintedOrigins, smartCardPrefetchedAssetUrls } from './shared';
import type { IframeRenderMode, RgbaColor, SmartCardImmersiveTheme, SmartCardResource, SmartCardResourceKind, SmartCardResourcePlan } from './shared';

export let smartCardRuntimeConfigFallback: SillyTavernPluginRuntimeConfig | null = null;

/**
 * [P0-SRCDOC-SLIM] 插件脚本包：从完整 runtime config 中剥离出的 js/modules 源码。
 *
 * 源码（~4.4MB，主要为酒馆助手脚本）不再内联进 srcDoc / context-update postMessage，
 * 改由父页面在 iframe 就绪后经 `plugin-scripts-push` 单次推送，避免每张卡反复
 * 传输与解析同一份大源码（srcDoc 内联 + 深拷贝 → 滑动卡顿的主因）。
 * css/templates 的 content 保留在瘦身 config 中（体积小，且资源计划依赖 css 提取 url()）。
 *
 * [P1-SRCDOC-SLIM] 推送内容进一步「清单化」：postMessage 只携带元数据 + source URL
 * （url 字段，指向后端 /api/plugins/{id}/source/{path}），content 由 iframe 按需
 * 经父页面批量拉取，父页面走 HTTP 缓存。bundle 本体仍保留完整 content 作为父侧
 * 应答的数据源。
 */
export interface SmartCardPluginScriptBundle {
  generated_at?: string;
  scripts: Array<{
    pluginId: string;
    kind: 'js' | 'module';
    path?: string;
    zip_path?: string | null;
    execute?: boolean;
    content?: string | null;
    /** [P1-SRCDOC-SLIM] 源码 HTTP URL（清单化后 iframe 按此定位内容）。 */
    url?: string;
  }>;
}

export let smartCardPluginScriptBundle: SmartCardPluginScriptBundle = { scripts: [] };


/** [P1-SRCDOC-SLIM] 插件源码路径归一化（与 iframe normalizeStPluginPathCompat 同构）。 */
export function normalizeSmartCardPluginSourcePath(rawPath: string): string {
  return String(rawPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/** [P1-SRCDOC-SLIM] 插件源码内容 key（pluginId::归一化路径），父/子两侧共用。 */
export function getSmartCardPluginSourceKey(pluginId: string, rawPath: string): string {
  return `${String(pluginId || '')}::${normalizeSmartCardPluginSourcePath(rawPath)}`;
}

/** [P1-SRCDOC-SLIM] 插件 js/modules 源码的 HTTP URL（后端 /source 端点）。 */
export function getSillyTavernPluginSourceUrl(pluginId: string, rawPath: string): string | null {
  const id = String(pluginId || '').trim();
  const path = normalizeSmartCardPluginSourcePath(rawPath);
  if (!id || !path) return null;
  return `/api/plugins/${encodeURIComponent(id)}/source/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

/** [P1-SRCDOC-SLIM] 推送清单：剥离 content，仅保留元数据 + source URL。 */
export function slimSmartCardPluginScriptBundle(bundle: SmartCardPluginScriptBundle): SmartCardPluginScriptBundle {
  return {
    generated_at: bundle.generated_at,
    scripts: (bundle.scripts || []).map((script) => {
      const { content: _content, ...rest } = script;
      return rest;
    }),
  };
}


/** 剥离单插件 js/modules 源码 content，其余字段（含 css/templates content）原样保留。 */
export function slimSmartCardPluginRuntimeItem(plugin: SillyTavernPluginRuntimeItem): SillyTavernPluginRuntimeItem {
  const resources = plugin.resources;
  if (!resources) return plugin;
  const slimResources: NonNullable<SillyTavernPluginRuntimeItem['resources']> = { ...resources };
  if (Array.isArray(resources.js)) {
    slimResources.js = resources.js.map((resource) => {
      if (!resource || typeof resource.content !== 'string') return resource;
      const { content: _content, ...rest } = resource;
      return rest;
    });
  }
  if (Array.isArray(resources.modules)) {
    slimResources.modules = resources.modules.map((resource) => {
      if (!resource || typeof resource.content !== 'string') return resource;
      const { content: _content, ...rest } = resource;
      return rest;
    });
  }
  return { ...plugin, resources: slimResources };
}


/** 从完整 runtime config 提取 js/modules 源码为独立脚本包。 */
export function buildSmartCardPluginScriptBundle(config: SillyTavernPluginRuntimeConfig): SmartCardPluginScriptBundle {
  const scripts: SmartCardPluginScriptBundle['scripts'] = [];
  (config.plugins || []).forEach((plugin) => {
    const pluginId = String(plugin.id || plugin.name || '');
    (plugin.resources?.js || []).forEach((resource) => {
      if (!resource || resource.missing || typeof resource.content !== 'string') return;
      scripts.push({
        pluginId,
        kind: 'js',
        path: resource.path,
        zip_path: resource.zip_path,
        execute: resource.execute,
        content: resource.content,
        // [P1-SRCDOC-SLIM] 清单化：附带源码 HTTP URL（推送时剥离 content）。
        url: getSillyTavernPluginSourceUrl(pluginId, resource.zip_path || resource.path || '') || undefined,
      });
    });
    (plugin.resources?.modules || []).forEach((resource) => {
      if (!resource || resource.missing || typeof resource.content !== 'string') return;
      scripts.push({
        pluginId,
        kind: 'module',
        path: resource.path,
        zip_path: resource.zip_path,
        content: resource.content,
        // [P1-SRCDOC-SLIM] 清单化：附带源码 HTTP URL（推送时剥离 content）。
        url: getSillyTavernPluginSourceUrl(pluginId, resource.zip_path || resource.path || '') || undefined,
      });
    });
  });
  return { generated_at: config.generated_at, scripts };
}


export function getSmartCardPluginScriptBundle(): SmartCardPluginScriptBundle {
  return smartCardPluginScriptBundle;
}


export function normalizeHtmlCandidate(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^html\s*(?=<!DOCTYPE\s+html|<html[\s>])/i, '')
    .replace(/^(`{3,})html\s*\r?\n/i, '')
    .replace(/\r?\n(`{3,})\s*$/i, '')
    .trim();
}


export function htmlUsesViewportHeight(html: string): boolean {
  // 只能用「height / min-height」，不能用 max-height：max-height: 75vh 这类隐藏图层的
  // 约束（如 lightbox 全屏遮罩里的内层图片）会把 `height` 子串命中的 vh 误判成「文档
  // 依赖视口高度」，导致 prefersAvailableHeight 走「填充可用高度」分支、iframe 被撑到
  // 数千像素而被挤到视口外（白屏）。用负向断言 (?<!max-) 排除 max-height 前缀。
  return /(?<!max-)height\s*:\s*(?:\d+(?:\.\d+)?(?:dvh|vh)|calc\([^)]*(?:dvh|vh)[^)]*\))/i.test(html);
}


export function htmlSupportsOuterCollapse(html: string): boolean {
  return /id=(["'])main-wrapper\1/i.test(html) && /id=(["'])dashboard\1/i.test(html);
}


export function hashSmartCardSource(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}


export async function preloadSmartCardRuntimeConfig(): Promise<SillyTavernPluginRuntimeConfig | null> {
  if (typeof window === 'undefined') return smartCardRuntimeConfigFallback;
  try {
    const config = await api.get<SillyTavernPluginRuntimeConfig>('/api/plugins/runtime/config', { cacheTtlMs: 30_000 });
    if (config && typeof config === 'object') {
      const normalized: SillyTavernPluginRuntimeConfig = {
        plugins: Array.isArray(config.plugins) ? config.plugins : [],
        extension_settings: config.extension_settings && typeof config.extension_settings === 'object'
          ? config.extension_settings
          : {},
        generated_at: config.generated_at,
      };
      // [P0-SRCDOC-SLIM] fallback 只保留瘦身版（无 js/modules 源码 content），
      // 源码整体打包进 smartCardPluginScriptBundle 经 plugin-scripts-push 单次推送。
      smartCardRuntimeConfigFallback = {
        ...normalized,
        plugins: normalized.plugins.map(slimSmartCardPluginRuntimeItem),
      };
      smartCardPluginScriptBundle = buildSmartCardPluginScriptBundle(normalized);
    }
  } catch {
    // Optional compatibility data; embedded card runtime still works without it.
  }
  return smartCardRuntimeConfigFallback;
}


export function getSmartCardCacheValue<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}


export function setSmartCardCacheValue<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  while (cache.size > SMART_CARD_RENDER_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
  return value;
}


export function getSmartCardTrustKey(characterId: string | undefined, fingerprint: string): string {
  return `${SMART_CARD_TRUST_STORAGE_PREFIX}${characterId || 'unknown'}:${fingerprint}`;
}


export function compactSmartCardChatMessages(
  chatMessages: CharacterSmartCardContext['chatMessages'],
  messageIndex?: number,
): CharacterSmartCardContext['chatMessages'] {
  if (!Array.isArray(chatMessages)) return chatMessages;
  if (chatMessages.length <= SMART_CARD_CONTEXT_FULL_MESSAGE_LIMIT) return chatMessages;

  const selectedIndexes = new Set<number>();
  const addIndex = (index: number) => {
    if (index >= 0 && index < chatMessages.length) selectedIndexes.add(index);
  };

  for (let index = 0; index < SMART_CARD_CONTEXT_HEAD_MESSAGE_COUNT; index += 1) addIndex(index);

  const anchor = Number.isFinite(Number(messageIndex)) ? Number(messageIndex) : -1;
  if (anchor >= 0) {
    for (
      let index = anchor - SMART_CARD_CONTEXT_ANCHOR_RADIUS;
      index <= anchor + SMART_CARD_CONTEXT_ANCHOR_RADIUS;
      index += 1
    ) {
      addIndex(index);
    }
  }

  for (
    let index = Math.max(0, chatMessages.length - SMART_CARD_CONTEXT_RECENT_MESSAGE_COUNT);
    index < chatMessages.length;
    index += 1
  ) {
    addIndex(index);
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => chatMessages[index]);
}


export function getCurrentInterfaceLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  const candidates = [
    document.documentElement.getAttribute('lang'),
    window.localStorage.getItem('lang'),
    window.localStorage.getItem('palink-lang'),
  ];
  return candidates.some((value) => value === 'en') ? 'en' : 'zh';
}


export function isIOSLikeDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}


export function clampColorByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}


export function getRelativeLuminance(color: RgbaColor): number {
  const transform = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * transform(color.r)) + (0.7152 * transform(color.g)) + (0.0722 * transform(color.b));
}


export function getDefaultImmersiveTheme(): SmartCardImmersiveTheme {
  return {
    backgroundColor: 'rgb(0, 0, 0)',
    foregroundColor: 'rgb(255, 255, 255)',
    isDark: true,
  };
}


export function clampSmartCardHeight(value: number, minHeight = IFRAME_VIEWPORT_MIN_HEIGHT): number {
  if (!Number.isFinite(value)) return minHeight;
  return Math.max(minHeight, Math.min(Math.round(value), IFRAME_MAX_HEIGHT));
}


export function getVisualViewportHeight(): number {
  if (typeof window === 'undefined') return 760;
  return window.visualViewport?.height || window.innerHeight || 760;
}


export function getLayoutViewportHeight(): number {
  if (typeof window === 'undefined') return 760;
  return window.innerHeight || document.documentElement?.clientHeight || window.visualViewport?.height || 760;
}


export function isSmartCardVisualKeyboardLikelyOpen(stableViewportHeight?: number, frameFocusedEditable = false): boolean {
  if (typeof window === 'undefined') return false;
  const visualHeight = window.visualViewport?.height || 0;
  if (visualHeight <= 0) return false;

  const rawLayoutHeight = Math.max(
    window.innerHeight || 0,
    document.documentElement?.clientHeight || 0,
    1,
  );
  const stableHeight = Math.max(
    rawLayoutHeight,
    Number.isFinite(Number(stableViewportHeight)) ? Number(stableViewportHeight) : 0,
  );
  const rawDelta = rawLayoutHeight - visualHeight;
  const stableDelta = stableHeight - visualHeight;
  const threshold = Math.max(96, stableHeight * 0.15);
  return rawDelta > threshold || (frameFocusedEditable && stableDelta > threshold);
}


export function roundSmartCardNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(numeric * 100) / 100;
}


export function getNearestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement || null;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/i.test(style.overflowY) && current.clientHeight > 0) return current;
    current = current.parentElement;
  }
  return null;
}


export function findPalinkHtmlBlock(source: string, cursor: number): { start: number; end: number; html: string; priority: number } | null {
  const slice = source.slice(cursor);
  const match = slice.match(/<palink-html>([\s\S]*?)<\/palink-html>/i);
  if (!match || match.index === undefined) return null;
  const start = cursor + match.index;
  return {
    start,
    end: start + match[0].length,
    html: String(match[1] || '').trim(),
    priority: 0,
  };
}


export function dedupeHtmlParts(htmlParts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of htmlParts) {
    const key = part.trim().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}


export function stripHtmlFenceLeftovers(text: string): string {
  let result = String(text || '');
  // ① 移除"内层为空"的围栏块：HTML 面板被提取走后，```html … ``` 中间只剩空白。
  //    精确匹配「开围栏行 + 零个/多个空白行 + 闭围栏行」，并连带吃掉开围栏行前的
  //    一个换行；含实质内容的围栏块不匹配（保留）。
  result = result.replace(/[ \t]*\n?```[a-zA-Z0-9_-]*[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*```[ \t]*/g, '');
  // ② 配对围栏保留，孤立围栏标记行移除：无配对开/闭围栏的残留标记。配对的真实
  // markdown 代码块（```xxx … ``` 内含实质内容）原样保留；未闭合的开围栏在
  // 状态机结束后回退移除（如剥离指令块后残留的单行 ```）。
  // Showdown 常把整段围栏包进 <p>…</p>（如 <p>```html…```</p>），面板提取后残留的
  // 闭合围栏会带 </p> 后缀（` ```</p> `），裸围栏正则匹配不到导致 ``` 泄漏成正文。
  // 因此先剥掉 <p>/</p>/<br> 壳再判定围栏行，判定仍不识别带正文的普通行。
  const lines = result.split('\n');
  const out: string[] = [];
  let inFence = false;
  let lastOpenIdx = -1;
  for (const line of lines) {
    const marker = String(line)
      .trim()
      .replace(/^<p\b[^>]*>\s*/i, '')
      .replace(/<br\s*\/?>\s*$/i, '')
      .replace(/\s*<\/p>\s*$/i, '')
      .trim();
    const isOpen = /^`{3,}[a-zA-Z0-9_-]*\s*$/.test(marker);
    const isClose = /^`{3,}\s*$/.test(marker);
    if (inFence) {
      if (isClose) inFence = false;
      out.push(line);
      continue;
    }
    if (isOpen) {
      inFence = true;
      lastOpenIdx = out.length;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  if (inFence && lastOpenIdx >= 0) out.splice(lastOpenIdx, 1);
  return out.join('\n');
}


export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}


export function normalizeSmartCardStorageId(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return (text || fallback).replace(/[^\w.-]+/g, '_').slice(0, 96) || fallback;
}


export function escapeHtmlAttribute(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}


export const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);


export function escapeQuotedScriptNewlines(script: string): string {
  let result = '';
  // Track quote type: single, double, or template literal (backtick).
  // Template literals are tracked so that quotes inside ${...} expressions
  // don't confuse the parser. Newlines inside template literals are preserved
  // (they are valid in JS template strings).
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  // Track ${...} interpolation depth inside template literals so that nested
  // quotes and backticks inside expressions are handled correctly.
  let templateExprDepth = 0;
  // 词法上下文：行注释 / 块注释 / 正则字面量。
  // 卡片脚本常含正则字面量（如 /['"]/ 或 /[^\s]+/）与注释；若仅按引号扫描，
  // 正则/注释内部的引号会误判为字符串开始，把后续真实代码的换行错误转义，
  // 直接产生 SyntaxError（“srcdoc Invalid token”）。此处显式跟踪这三类上下文。
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  let regexCharClassDepth = 0;

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];

    // ---- 行注释：遇到 //（非字符串/正则内）跳到行尾 ----
    if (!quote && !inRegex && !inBlockComment && char === '/' && next === '/') {
      inLineComment = true;
      result += char;
      continue;
    }
    if (inLineComment) {
      result += char;
      if (char === '\n') inLineComment = false;
      continue;
    }

    // ---- 块注释：/* ... */ ----
    if (!quote && !inRegex && !inLineComment && char === '/' && next === '*') {
      inBlockComment = true;
      result += char;
      result += next;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      result += char;
      if (char === '*' && next === '/') {
        result += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    // ---- 正则字面量：进入 /.../ ----
    if (!quote && !inLineComment && !inBlockComment && char === '/' && !inRegex) {
      // 判定 `/` 是「正则起点」还是「除号」。
      // 必须先向前跳过空白再取最后一个有意义字符：否则 `w / h` 这类两侧带空格的除法
      // 会因为紧邻前字符是空格而被当成正则起点，一路吞到下一个 `/` 才退出，
      // 期间的字符串裸换行不再被转义，最终在 iframe 内抛 SyntaxError
      // （典型现场：`el.clientWidth / 360` 与 `el.clientHeight / 2` 之间夹一段多行字符串）。
      let scan = i - 1;
      while (scan >= 0 && (script[scan] === ' ' || script[scan] === '\t' || script[scan] === '\r' || script[scan] === '\n')) {
        scan -= 1;
      }
      const prevMeaningful = scan >= 0 ? script[scan] : '';
      let prevIsWord = /[\w$)\]}]/.test(prevMeaningful);
      // 但关键字后面跟的是正则而非除法：return /x/、typeof /x/、case /x/ 等。
      if (prevIsWord && /[\w$]/.test(prevMeaningful)) {
        let wordStart = scan;
        while (wordStart >= 0 && /[\w$]/.test(script[wordStart])) wordStart -= 1;
        if (REGEX_PRECEDING_KEYWORDS.has(script.slice(wordStart + 1, scan + 1))) {
          prevIsWord = false;
        }
      }
      if (!prevIsWord) {
        inRegex = true;
        regexCharClassDepth = 0;
        escaped = false;
        result += char;
        continue;
      }
    }
    if (inRegex) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '[') {
        regexCharClassDepth += 1;
      } else if (char === ']') {
        if (regexCharClassDepth > 0) regexCharClassDepth -= 1;
      } else if (char === '/' && regexCharClassDepth === 0) {
        inRegex = false;
      }
      continue;
    }

    // Only escape newlines in single/double quoted strings (not template literals)
    if (quote && quote !== '`' && char === '\r') {
      if (next === '\n') i += 1;
      result += '\\n';
      escaped = false;
      continue;
    }

    if (quote && quote !== '`' && char === '\n') {
      result += '\\n';
      escaped = false;
      continue;
    }

    result += char;

    if (!quote) {
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        escaped = false;
      }
      continue;
    }

    // Inside template literal: track ${...} interpolation
    if (quote === '`') {
      if (!escaped && char === '$' && next === '{') {
        templateExprDepth += 1;
      } else if (!escaped && templateExprDepth > 0 && char === '}') {
        templateExprDepth -= 1;
      } else if (!escaped && char === '`' && templateExprDepth === 0) {
        // End of template literal (only when not inside ${...})
        quote = null;
      }
      if (char === '\\') {
        escaped = true;
      } else {
        escaped = false;
      }
      continue;
    }

    // Inside single/double quoted string
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === quote) {
      quote = null;
    }
  }

  return result;
}


export function loosenSmartCardGlobalLexicalDeclarations(script: string): string {
  const redeclarableNames = [
    'State',
    'GameState',
    'CardState',
    'CHARACTER_COLORS',
    'WEATHER_ICONS',
  ];
  const names = redeclarableNames.join('|');
  return String(script || '')
    .replace(new RegExp(`\\b(?:const|let)\\s+(${names})\\s*=`, 'g'), 'var $1 =')
    .replace(new RegExp(`\\bclass\\s+(${names})\\b`, 'g'), 'var $1 = class $1');
}


export function normalizeSmartCardResourceUrl(rawUrl: string): string | null {
  const cleaned = String(rawUrl || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/&amp;/g, '&');
  if (!cleaned || /^(?:data|blob|javascript|mailto):/i.test(cleaned) || cleaned.startsWith('#')) return null;

  try {
    const url = new URL(cleaned, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}


export function classifySmartCardResource(url: string, fallback: SmartCardResourceKind = 'other'): SmartCardResourceKind {
  const lower = url.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)(?:[?#]|$)/i.test(lower)) return 'image';
  if (/\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(lower) || /fonts\.gstatic\.com/i.test(lower)) return 'font';
  if (/\.css(?:[?#]|$)/i.test(lower) || /fonts\.googleapis\.com|font-awesome/i.test(lower)) return 'style';
  if (/\.m?js(?:[?#]|$)/i.test(lower) || /jquery|lodash|underscore/i.test(lower)) return 'script';
  if (/postimg|imgur|image|avatar|photo|pic/i.test(lower)) return 'image';
  return fallback;
}


export function getSillyTavernPluginAssetUrl(pluginId: string, assetPath: string): string | null {
  const id = String(pluginId || '').trim();
  const path = String(assetPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => encodeURIComponent(part))
    .join('/');
  if (!id || !path) return null;
  return `/api/plugins/${encodeURIComponent(id)}/asset/${path}`;
}


export function mergeSmartCardResourcePlans(basePlan: SmartCardResourcePlan, extraPlan: SmartCardResourcePlan): SmartCardResourcePlan {
  const seen = new Set<string>();
  const mergeResources = (left: SmartCardResource[], right: SmartCardResource[], limit: number) => {
    const merged: SmartCardResource[] = [];
    [...left, ...right]
      .sort((a, b) => a.index - b.index)
      .forEach((resource) => {
        if (!resource.url || seen.has(resource.url)) return;
        seen.add(resource.url);
        merged.push(resource);
      });
    return merged.slice(0, limit);
  };
  const preconnectOrigins = Array.from(new Set([
    ...basePlan.preconnectOrigins,
    ...extraPlan.preconnectOrigins,
  ])).slice(0, SMART_CARD_PRECONNECT_LIMIT);
  const high = mergeResources(basePlan.high, extraPlan.high, SMART_CARD_HIGH_RESOURCE_LIMIT);
  const deferredSeen = new Set(high.map((resource) => resource.url));
  const deferred = [...basePlan.deferred, ...extraPlan.deferred]
    .sort((a, b) => a.index - b.index)
    .filter((resource) => {
      if (!resource.url || deferredSeen.has(resource.url)) return false;
      deferredSeen.add(resource.url);
      return true;
    })
    .slice(0, SMART_CARD_DEFERRED_RESOURCE_LIMIT);
  return { preconnectOrigins, high, deferred };
}


export function getSmartCardHintPreloadAs(kind: SmartCardResourceKind): HTMLLinkElement['as'] | null {
  if (kind === 'font') return 'font';
  return null;
}


export function isCrossOriginResource(url: string): boolean {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    return new URL(url, base).origin !== currentOrigin;
  } catch {
    return false;
  }
}


export function hintSmartCardOrigin(origin: string) {
  if (typeof document === 'undefined' || !origin || smartCardHintedOrigins.has(origin)) return;
  smartCardHintedOrigins.add(origin);

  const head = document.head;
  if (!head) return;

  const preconnect = document.createElement('link');
  preconnect.rel = 'preconnect';
  preconnect.href = origin;
  preconnect.crossOrigin = 'anonymous';
  preconnect.dataset.palinkSmartCardHint = 'preconnect';
  head.appendChild(preconnect);

  const dnsPrefetch = document.createElement('link');
  dnsPrefetch.rel = 'dns-prefetch';
  dnsPrefetch.href = origin;
  dnsPrefetch.dataset.palinkSmartCardHint = 'dns-prefetch';
  head.appendChild(dnsPrefetch);
}


export function postSmartCardAssetPrefetch(urls: string[]): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  if (urls.length === 0) return;
  urls.forEach((url) => smartCardPrefetchedAssetUrls.add(url));
  const token = window.localStorage.getItem('palink_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  fetch(SMART_CARD_ASSET_PREFETCH_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers,
    body: JSON.stringify({ urls }),
  }).catch(() => {
    // Failed remote assets are remembered for this page lifetime so broken card URLs
    // don't repeatedly consume the warmup queue on every iframe remount.
  });
}


export function scheduleSmartCardIdleTask(callback: () => void, timeout = 1200): number {
  if (typeof window === 'undefined') return 0;
  const requestIdleCallback = (window as typeof window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  }).requestIdleCallback;
  if (requestIdleCallback) {
    return requestIdleCallback(() => callback(), { timeout });
  }
  return window.setTimeout(callback, timeout);
}


export function cancelSmartCardIdleTask(handle: number): void {
  if (typeof window === 'undefined' || !handle) return;
  const cancelIdleCallback = (window as typeof window & {
    cancelIdleCallback?: (handle: number) => void;
  }).cancelIdleCallback;
  if (cancelIdleCallback) cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}


export function resolveHtmlRenderMode(html: string, requestedMode: SmartCardRenderMode): 'inline-html' | IframeRenderMode {
  if (requestedMode === 'iframe-js') return 'iframe-js';
  if (requestedMode === 'immersive-sandbox') return 'iframe-js';
  if (requestedMode === 'immersive-trusted-native') return 'trusted-native';
  if (requestedMode === 'static-html' || requestedMode === 'inline-html') return 'inline-html';
  // auto 模式：始终使用 iframe-js，避免 inline-html 模式下角色卡内嵌脚本
  // 通过 dangerouslySetInnerHTML 在主页面执行，修改 React 管理的 DOM，
  // 导致 NotFoundError: insertBefore/removeChild 崩溃。
  return 'iframe-js';
}


export function toSmartCardRuntimeMode(mode: IframeRenderMode): SmartCardRuntimeMode {
  if (mode === 'trusted-native') return 'native-trusted';
  if (mode === 'static-html') return 'static-html';
  return 'sandbox';
}


export function sanitizeCss(css: string): string {
  return String(css || '')
    .replace(/@import\s+[^;]+;/gi, '')
    .replace(/url\(\s*(['"]?)\s*javascript:[^)]+\)/gi, 'url()');
}


export function scopeSelector(selector: string, scopeSelectorText: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith(scopeSelectorText)) return trimmed;
  if (/^(?:html|body|:root)$/i.test(trimmed)) return scopeSelectorText;
  if (/^(?:html|body)\b/i.test(trimmed)) {
    return trimmed.replace(/^(?:html|body)\b/i, scopeSelectorText);
  }
  return `${scopeSelectorText} ${trimmed}`;
}


export function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}


export function extractTagContent(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i');
  const match = String(html || '').match(pattern);
  return match?.[1] || '';
}


export function collectInlineStyles(html: string): string[] {
  const styles: string[] = [];
  String(html || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css = '') => {
    if (css) styles.push(css);
    return '';
  });
  return styles;
}

