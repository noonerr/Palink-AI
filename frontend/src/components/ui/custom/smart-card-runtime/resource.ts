// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { api } from '@/services/api';
import { SMART_CARD_ASSET_PROXY_ENDPOINT, SMART_CARD_DEFERRED_RESOURCE_DELAY_MS, SMART_CARD_DEFERRED_RESOURCE_LIMIT, SMART_CARD_DEFERRED_START_DELAY_MS, SMART_CARD_HIGH_FONT_LIMIT, SMART_CARD_HIGH_IMAGE_LIMIT, SMART_CARD_HIGH_RESOURCE_DELAY_MS, SMART_CARD_HIGH_RESOURCE_LIMIT, SMART_CARD_HIGH_STYLE_LIMIT, SMART_CARD_PRECONNECT_LIMIT, SMART_CARD_RESOURCE_WARM_TIMEOUT_MS, smartCardOptimizedHtmlCache, smartCardPrefetchedAssetUrls, smartCardResourcePlanCache, smartCardWarmedResources } from './shared';
import type { SmartCardResource, SmartCardResourceKind, SmartCardResourcePlan } from './shared';
import type { SillyTavernPluginRuntimeConfig } from '@/types';
import { cancelSmartCardIdleTask, classifySmartCardResource, escapeHtmlAttribute, getSillyTavernPluginAssetUrl, getSmartCardCacheValue, getSmartCardHintPreloadAs, hashSmartCardSource, hintSmartCardOrigin, isCrossOriginResource, normalizeSmartCardResourceUrl, postSmartCardAssetPrefetch, scheduleSmartCardIdleTask, setSmartCardCacheValue } from './primitives';
import { addAttributeToHtmlTag } from './script-norm';
import { hashSmartCardUnknown } from './hashing';
import { getSmartCardAssetMode } from './asset-mode';

export function getSmartCardAssetProxyUrl(rawUrl: string): string | null {
  let normalized = normalizeSmartCardResourceUrl(rawUrl);
  if (!normalized) return null;
  // 修剪尾部不配对的闭括号：文本场景 `(https://x.com/a.png)` 的正则匹配会把末尾 `)` 吞入 URL；
  // 而真正的图片 URL 可能含成对括号（postimg 重名文件如 `...-(2).png`），不能整串丢。
  // 统计括号：闭合多于开启时，去掉尾部的多余 `)`，保留成对括号。
  let openCount = 0;
  let closeCount = 0;
  for (const ch of normalized) {
    if (ch === '(') openCount += 1;
    else if (ch === ')') closeCount += 1;
  }
  while (closeCount > openCount && normalized.endsWith(')')) {
    normalized = normalized.slice(0, -1);
    closeCount -= 1;
  }
  const kind = classifySmartCardResource(normalized, 'other');
  // 脚本（<script src> 及 JS 内引用的 CDN 脚本）一律直连加载，与 SillyTavern 行为一致：
  // 后端 /api/smart-card-assets 只代理 image/style/font（.js 返回 415），
  // 若把脚本改写为代理 URL，jQuery 等 CDN 脚本无法加载，会连带触发 shim $ 兜底和脚本中断。
  if (!['image', 'style', 'font'].includes(kind)) return null;
  // direct 模式（默认）：图片/样式/字体全部浏览器直连第三方（对齐 ST，后端零媒体流量）。
  // 字体直连的边界：@font-face 跨源要求 CORS，ACAO:* 源（Google Fonts/jsdelivr 等）
  // 正常；不发 CORS 头的字体源会失效（ST 主页面渲染下同样失效——字体 CORS 是
  // 浏览器通用要求，非 iframe 特有），需要时用户可切 proxy 模式。
  if (getSmartCardAssetMode() === 'direct') return null;

  try {
    const parsedUrl = new URL(normalized);
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    if (parsedUrl.origin === currentOrigin) return null;
  } catch {
    return null;
  }

  const variant = kind === 'image' ? '&variant=ui' : '';
  return `${SMART_CARD_ASSET_PROXY_ENDPOINT}${encodeURIComponent(normalized)}${variant}`;
}


/**
 * https 页面下把浏览器直连加载的 http:// 资源升级为 https://。
 * 混合内容（https 页面加载 http 资源）会被浏览器拦截或自动尝试升级；在 HTML
 * 层主动升级可让 <img>/<link> 与预热 fetch 行为一致（fetch 对 http 混合内容
 * 是直接拒绝的，被动等浏览器升级救不了预热）。
 * 仅当页面协议为 https 且 URL 以 http:// 开头时升级；http 页面（本地开发）
 * 原样返回，避免破坏引用本地 http 服务（ComfyUI 等）的卡片。
 * http-only 图床升级后会失败——但留在 http:// 在 https 页面下同样加载不了
 *（混合内容拦截），不存在"不升级更好"的分支；此类图床仅 proxy 模式可用。
 */
export function upgradeMixedContentSmartCardUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  if (window.location.protocol !== 'https:') return url;
  return /^http:\/\//i.test(url) ? `https://${url.slice('http://'.length)}` : url;
}

export function rewriteSmartCardAssetUrlsForProxy(html: string): string {
  // 允许 `()` 进入 URL 匹配：postimg 等图床的重名文件 URL 含成对括号（如 `...(2).png`），
  // 若排除 `)` 会把 URL 截断、剩余 `).png` 粘连到代理 URL 的 `&variant=ui` 后面，
  // 后端解析出非法 variant 返回 400。成对括号保留，尾部孤立的 `)` 由
  // getSmartCardAssetProxyUrl 修剪（文本场景 `(url)` 的闭合括号）。
  // 不走代理的 URL（直连模式图片/样式、两模式下的脚本）做混合内容升级。
  return String(html || '').replace(/https?:\/\/[^\s"'`\\<>]+/gi, (url) => (
    getSmartCardAssetProxyUrl(url) || upgradeMixedContentSmartCardUrl(url)
  ));
}


export function optimizeSmartCardHtmlForRuntime(html: string): string {
  const source = String(html || '');
  // 缓存键须含资源模式：direct/proxy 的 URL 改写结果不同，切换模式后不能复用旧缓存
  const cacheKey = `${getSmartCardAssetMode()}:${hashSmartCardSource(source)}`;
  const cached = getSmartCardCacheValue(smartCardOptimizedHtmlCache, cacheKey);
  if (cached !== undefined) return cached;

  let imageIndex = 0;
  const result = rewriteSmartCardAssetUrlsForProxy(source)
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const isLikelyInitialImage = imageIndex < 2;
      imageIndex += 1;
      let result = tag;
      result = addAttributeToHtmlTag(result, 'decoding', 'async');
      result = addAttributeToHtmlTag(result, 'loading', isLikelyInitialImage ? 'eager' : 'lazy');
      result = addAttributeToHtmlTag(result, 'fetchpriority', isLikelyInitialImage ? 'high' : 'low');
      // 直连模式下浏览器直接访问图床：no-referrer 规避按 Referer 防盗链的图床
      //（代理模式为同源请求，不发 Referer 也无影响）
      result = addAttributeToHtmlTag(result, 'referrerpolicy', 'no-referrer');
      return result;
    });
  return setSmartCardCacheValue(smartCardOptimizedHtmlCache, cacheKey, result);
}


export function buildSmartCardResourcePlan(html: string): SmartCardResourcePlan {
  const source = String(html || '');
  const cacheKey = hashSmartCardSource(source);
  const cached = getSmartCardCacheValue(smartCardResourcePlanCache, cacheKey);
  if (cached) return cached;

  const seen = new Set<string>();
  const high: SmartCardResource[] = [];
  const deferred: SmartCardResource[] = [];
  const originCandidates: string[] = [];
  let highStyleCount = 0;
  let highImageCount = 0;
  let highFontCount = 0;
  let index = 0;

  const resolvePriority = (
    kind: SmartCardResourceKind,
    requestedPriority: 'high' | 'deferred',
  ): 'high' | 'deferred' => {
    if (requestedPriority !== 'high') return 'deferred';
    if (high.length >= SMART_CARD_HIGH_RESOURCE_LIMIT) return 'deferred';
    if (kind === 'style') {
      if (highStyleCount >= SMART_CARD_HIGH_STYLE_LIMIT) return 'deferred';
      highStyleCount += 1;
      return 'high';
    }
    if (kind === 'script') return 'deferred';
    if (kind === 'font') {
      if (highFontCount >= SMART_CARD_HIGH_FONT_LIMIT) return 'deferred';
      highFontCount += 1;
      return 'high';
    }
    if (kind === 'image') {
      if (highImageCount >= SMART_CARD_HIGH_IMAGE_LIMIT) return 'deferred';
      highImageCount += 1;
      return 'high';
    }
    return 'deferred';
  };

  const addResource = (rawUrl: string, fallbackKind: SmartCardResourceKind, priority: 'high' | 'deferred') => {
    const url = normalizeSmartCardResourceUrl(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const kind = classifySmartCardResource(url, fallbackKind);
    const resolvedPriority = resolvePriority(kind, priority);
    // 直连资源做混合内容升级，保证 preload 提示/预热 fetch 与改写后的 HTML URL 一致
    const resourceUrl = getSmartCardAssetProxyUrl(url) || upgradeMixedContentSmartCardUrl(url);
    const resource: SmartCardResource = { url: resourceUrl, sourceUrl: url, kind, priority: resolvedPriority, index: index++ };
    if (resolvedPriority === 'high') high.push(resource);
    else deferred.push(resource);

    try {
      const origin = new URL(resourceUrl, typeof window !== 'undefined' ? window.location.href : 'http://localhost').origin;
      const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      if (origin !== currentOrigin && !originCandidates.includes(origin)) originCandidates.push(origin);
    } catch {
      // Ignore invalid origins; the resource itself has already been normalized.
    }
  };

  const scriptBlocks: string[] = [];
  const nonScriptSource = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs = '', body = '') => {
    const srcMatch = String(attrs).match(/\bsrc=(["'])(.*?)\1/i);
    if (srcMatch?.[2] && !/jquery/i.test(srcMatch[2])) addResource(srcMatch[2], 'script', 'deferred');
    scriptBlocks.push(String(body || ''));
    return ' ';
  });

  nonScriptSource.replace(/<link\b([^>]*)>/gi, (_match, attrs = '') => {
    const href = String(attrs).match(/\bhref=(["'])(.*?)\1/i)?.[2];
    if (!href) return '';
    const rel = String(attrs).match(/\brel=(["'])(.*?)\1/i)?.[2] || '';
    const fallbackKind = /stylesheet/i.test(rel) ? 'style' : 'other';
    addResource(href, fallbackKind, /stylesheet/i.test(rel) ? 'high' : 'deferred');
    return '';
  });

  nonScriptSource.replace(/<(?:img|source|video|audio)\b([^>]*)>/gi, (_match, attrs = '') => {
    const src = String(attrs).match(/\bsrc=(["'])(.*?)\1/i)?.[2];
    if (src) addResource(src, 'image', 'high');
    const srcset = String(attrs).match(/\bsrcset=(["'])(.*?)\1/i)?.[2];
    if (srcset) {
      srcset.split(',').forEach((part) => {
        const candidate = part.trim().split(/\s+/)[0];
          if (candidate) addResource(candidate, 'image', 'deferred');
      });
    }
    return '';
  });

  nonScriptSource.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url = '') => {
    addResource(url, 'image', 'deferred');
    return '';
  });

  scriptBlocks.join('\n').replace(/https?:\/\/[^\s"'`\\<>]+/gi, (url) => {
    const normalizedUrl = normalizeSmartCardResourceUrl(url);
    const kind = normalizedUrl ? classifySmartCardResource(normalizedUrl, 'other') : 'other';
    const priority = kind === 'image' && high.length < SMART_CARD_HIGH_RESOURCE_LIMIT ? 'high' : 'deferred';
    addResource(url, kind, priority);
    return '';
  });

  return setSmartCardCacheValue(smartCardResourcePlanCache, cacheKey, {
    preconnectOrigins: originCandidates.slice(0, SMART_CARD_PRECONNECT_LIMIT),
    high: high.sort((a, b) => a.index - b.index).slice(0, SMART_CARD_HIGH_RESOURCE_LIMIT),
    deferred: deferred.sort((a, b) => a.index - b.index).slice(0, SMART_CARD_DEFERRED_RESOURCE_LIMIT),
  });
}


export function buildSillyTavernPluginResourcePlan(config: SillyTavernPluginRuntimeConfig | null | undefined): SmartCardResourcePlan {
  const cacheKey = hashSmartCardUnknown(config || null);
  const cached = getSmartCardCacheValue(smartCardResourcePlanCache, `st-plugin:${cacheKey}`);
  if (cached) return cached;

  const high: SmartCardResource[] = [];
  const deferred: SmartCardResource[] = [];
  const preconnectOrigins: string[] = [];
  const seen = new Set<string>();
  let index = 10_000;
  let highImageCount = 0;
  let highFontCount = 0;
  let highStyleCount = 0;

  const addPluginResource = (url: string, kind: SmartCardResourceKind) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const resource: SmartCardResource = { url, sourceUrl: url, kind, priority: 'deferred', index: index++ };
    if (kind === 'style' && highStyleCount < SMART_CARD_HIGH_STYLE_LIMIT) {
      highStyleCount += 1;
      resource.priority = 'high';
      high.push(resource);
    } else if (kind === 'font' && highFontCount < SMART_CARD_HIGH_FONT_LIMIT) {
      highFontCount += 1;
      resource.priority = 'high';
      high.push(resource);
    } else if (kind === 'image' && highImageCount < SMART_CARD_HIGH_IMAGE_LIMIT) {
      highImageCount += 1;
      resource.priority = 'high';
      high.push(resource);
    } else {
      deferred.push(resource);
    }
    try {
      const origin = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost').origin;
      const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      if (origin !== currentOrigin && !preconnectOrigins.includes(origin)) preconnectOrigins.push(origin);
    } catch {
      // Local plugin asset URLs are still valid even when origin parsing is unavailable.
    }
  };

  (config?.plugins || []).forEach((plugin) => {
    const pluginId = String(plugin?.id || '');
    (plugin?.resources?.css || []).forEach((resource) => {
      if (resource?.missing) return;
      const path = resource.path || '';
      String(resource.content || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, rawUrl = '') => {
        const value = String(rawUrl || '').trim();
        if (!value || /^(?:data:|blob:|https?:|\/|#)/i.test(value)) return '';
        const base = String(path || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const resolvedPath = [base, value].filter(Boolean).join('/');
        const assetUrl = getSillyTavernPluginAssetUrl(pluginId, resolvedPath);
        if (assetUrl) addPluginResource(assetUrl, classifySmartCardResource(resolvedPath, 'image'));
        return '';
      });
    });
    (plugin?.resources?.assets || []).forEach((asset) => {
      if (!asset?.path) return;
      const url = getSillyTavernPluginAssetUrl(pluginId, asset.path);
      if (url) addPluginResource(url, classifySmartCardResource(asset.path, 'other'));
    });
  });

  return setSmartCardCacheValue(smartCardResourcePlanCache, `st-plugin:${cacheKey}`, {
    preconnectOrigins: preconnectOrigins.slice(0, SMART_CARD_PRECONNECT_LIMIT),
    high: high.slice(0, SMART_CARD_HIGH_RESOURCE_LIMIT),
    deferred: deferred.slice(0, SMART_CARD_DEFERRED_RESOURCE_LIMIT),
  });
}


export function buildSmartCardResourceHints(plan: SmartCardResourcePlan): string {
  const connectionHints = plan.preconnectOrigins
    .map((origin) => {
      const safeOrigin = escapeHtmlAttribute(origin);
      return `<link rel="preconnect" href="${safeOrigin}" crossorigin><link rel="dns-prefetch" href="${safeOrigin}">`;
    })
    .join('');
  const preloadHints = plan.high
    .map((resource) => {
      const preloadAs = getSmartCardHintPreloadAs(resource.kind);
      if (!preloadAs) return '';
      const safeUrl = escapeHtmlAttribute(resource.url);
      const isCrossOrigin = isCrossOriginResource(resource.url);
      const crossOrigin = isCrossOrigin && resource.kind !== 'image' ? ' crossorigin' : '';
      return `<link rel="preload" href="${safeUrl}" as="${preloadAs}"${crossOrigin}>`;
    })
    .join('');
  return `${connectionHints}${preloadHints}`;
}


export function fetchWarmSmartCardResource(url: string, controller?: AbortController | null) {
  if (typeof fetch !== 'function') return;
  const isCrossOrigin = isCrossOriginResource(url);
  fetch(url, {
    mode: isCrossOrigin ? 'no-cors' : 'cors',
    credentials: isCrossOrigin ? 'omit' : 'same-origin',
    cache: 'force-cache',
    signal: controller?.signal,
  }).catch(() => {
    // Remote card assets are best-effort; rendering should never wait on warmup.
  });
}


export function warmSmartCardResource(resource: SmartCardResource): () => void {
  if (typeof window === 'undefined' || smartCardWarmedResources.has(resource.url)) return () => {};
  smartCardWarmedResources.add(resource.url);

  if (resource.kind === 'image') {
    const image = new Image();
    let active = true;
    image.decoding = 'async';
    image.loading = 'eager';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => { active = false; };
    image.onerror = () => { active = false; };
    image.src = resource.url;

    return () => {
      if (!active) return;
      image.onload = null;
      image.onerror = null;
      image.src = '';
    };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const preloadAs = typeof document !== 'undefined' ? getSmartCardHintPreloadAs(resource.kind) : null;
  let link: HTMLLinkElement | null = null;
  let timeoutId: number | undefined;

  const removeLink = () => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    link?.parentNode?.removeChild(link);
    link = null;
  };

  if (preloadAs && document.head) {
    link = document.createElement('link');
    link.rel = 'preload';
    link.as = preloadAs;
    link.href = resource.url;
    if (isCrossOriginResource(resource.url)) {
      link.crossOrigin = 'anonymous';
    }
    link.dataset.palinkSmartCardWarm = resource.kind;
    link.addEventListener('load', () => window.setTimeout(removeLink, 4000), { once: true });
    link.addEventListener('error', removeLink, { once: true });
    document.head.appendChild(link);
    timeoutId = window.setTimeout(removeLink, SMART_CARD_RESOURCE_WARM_TIMEOUT_MS);
  } else {
    fetchWarmSmartCardResource(resource.url, controller);
  }

  return () => {
    controller?.abort();
    removeLink();
  };
}


export function getSmartCardRemoteAssetUrls(resources: SmartCardResource[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  [...resources]
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
      if (a.kind !== b.kind) {
        const rank: Record<SmartCardResourceKind, number> = { style: 0, font: 1, script: 2, image: 3, other: 4 };
        return rank[a.kind] - rank[b.kind];
      }
      return a.index - b.index;
    })
    .forEach((resource) => {
    // 服务端预取只服务仍走代理的资源：proxy 模式为 style+font；
    // direct 模式全部资源直连，服务器无缓存可预热，不预取
    const proxiedKinds = getSmartCardAssetMode() === 'direct' ? [] : ['style', 'font'];
    if (!proxiedKinds.includes(resource.kind)) return;
    const url = normalizeSmartCardResourceUrl(resource.sourceUrl);
    if (!url || seen.has(url) || smartCardPrefetchedAssetUrls.has(url)) return;

    try {
      const parsedUrl = new URL(url);
      const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      if (parsedUrl.origin === currentOrigin) return;
    } catch {
      return;
    }

    seen.add(url);
    urls.push(url);
  });
  return urls;
}


export function prefetchSmartCardAssets(plan: SmartCardResourcePlan): () => void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return () => {};

  const highUrls = getSmartCardRemoteAssetUrls(plan.high);
  const deferredUrls = getSmartCardRemoteAssetUrls(plan.deferred);
  postSmartCardAssetPrefetch(highUrls);

  const deferredHandle = scheduleSmartCardIdleTask(() => {
    postSmartCardAssetPrefetch(deferredUrls);
  }, SMART_CARD_DEFERRED_START_DELAY_MS);

  return () => cancelSmartCardIdleTask(deferredHandle);
}


export function scheduleSmartCardResourceWarmup(plan: SmartCardResourcePlan): () => void {
  if (typeof window === 'undefined') return () => {};

  plan.preconnectOrigins.forEach(hintSmartCardOrigin);
  const cancelPrefetch = prefetchSmartCardAssets(plan);

  const timers: number[] = [];
  const cleanups: Array<() => void> = [];
  const schedule = (
    resources: SmartCardResource[],
    startDelay: number,
    stepDelay: number,
  ) => {
    resources.forEach((resource, index) => {
      const timer = window.setTimeout(() => {
        cleanups.push(warmSmartCardResource(resource));
      }, startDelay + index * stepDelay);
      timers.push(timer);
    });
  };

  schedule(plan.high.filter((resource) => resource.kind !== 'image'), SMART_CARD_HIGH_RESOURCE_DELAY_MS, SMART_CARD_HIGH_RESOURCE_DELAY_MS);
  schedule(plan.deferred.filter((resource) => resource.kind !== 'image'), SMART_CARD_DEFERRED_START_DELAY_MS, SMART_CARD_DEFERRED_RESOURCE_DELAY_MS);

  return () => {
    cancelPrefetch();
    timers.forEach((timer) => window.clearTimeout(timer));
    cleanups.forEach((cleanup) => cleanup());
  };
}

