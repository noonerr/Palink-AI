/**
 * 亮色模式智能卡对比度自动增强 —— 运行时增强器。
 *
 * 职责（对齐 docs/light-mode-contrast-enhancement/spec.md §3.3）：
 * - 遍历卡片容器内"直接持有文本"的可见元素，逐元素计算 color vs 有效背景的
 *   WCAG 对比度；不达标元素用 inline style（important）覆盖为调整色。
 * - 非破坏：不改卡片源 HTML/`<style>`；原色存于 data 属性，清除时原样恢复。
 * - 只在亮色模式且全局开关开启时生效；主题切回暗色即清除全部覆盖。
 * - MutationObserver（rAF 节流）覆盖流式输出与卡片脚本动态增删。
 *
 * 兼容两条渲染路径：
 * - 主文档内联路径（.mes_text 内联 HTML / InlineHtmlRenderer / ReactMarkdown）
 * - iframe 路径（同源 iframe contentDocument，父页面直接读写）
 */

import {
  ensureContrast,
  parseCssColor,
  resolveEffectiveBackground,
  rgbaToString,
} from './contrast';

export const PALINK_AUTO_CONTRAST_STORAGE_KEY = 'palink-auto-contrast';

/** 调整标记属性：打上即表示该元素颜色被本增强器覆盖过。 */
export const CONTRAST_ADJUSTED_ATTR = 'data-palink-contrast';
/** 原始颜色（getComputedStyle 值）存于此属性，清除时原样恢复。 */
const CONTRAST_ORIGINAL_ATTR = 'data-palink-contrast-original';
/** 卡片作者可用该属性豁免某元素。 */
export const CONTRAST_SKIP_ATTR = 'data-palink-contrast-skip';

export interface ContrastEnhancerOptions {
  /** 扫描范围（卡片容器） */
  container: HTMLElement;
  /** 容器所属文档（主文档或 iframe contentDocument） */
  doc: Document;
  /** 主题根节点（主文档 html），用于监听 data-theme 切换 */
  themeRoot: Element;
  /** 是否启用：外部判定（全局开关 + 亮色模式），返回 false 时清除覆盖并停止调整 */
  isEnabled: () => boolean;
  /** WCAG 最小对比度，默认 4.5 */
  minRatio?: number;
  /** 单次扫描元素上限（性能保护），默认 600 */
  maxElements?: number;
  /** 调整数量变化回调（用于角标提示） */
  onAdjusted?: (count: number) => void;
}

export interface ContrastEnhancerHandle {
  /** 立即执行一次扫描 */
  run: () => number;
  /** 清除全部覆盖并停止监听 */
  dispose: () => void;
}

/** 默认启用判定：全局开关开启 且 亮色模式。 */
export function isContrastEnhancementEnabled(): boolean {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (localStorage.getItem(PALINK_AUTO_CONTRAST_STORAGE_KEY) === '0') return false;
    return document.documentElement.dataset.theme !== 'dark';
  } catch {
    return false;
  }
}

/** 从 CSS 样式声明收集"直接持有文本"的叶子文本元素。 */
function collectTextElements(
  container: HTMLElement,
  doc: Document,
  maxElements: number,
): Element[] {
  const win = doc.defaultView;
  if (!win || typeof doc.createTreeWalker !== 'function') return [];
  const results: Element[] = [];
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let el: Element | null;
  // 跳过容器自身（其文本由子元素持有）
  let guard = 0;
  while ((el = walker.nextNode() as Element | null) !== null) {
    if (guard++ > 4000) break;
    if (results.length >= maxElements) break;
    if (el === container) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
    if (el.closest(`svg, canvas, video, audio, img, picture, input, textarea, select, option, .palink-th-panel, [${CONTRAST_SKIP_ATTR}]`)) continue;
    // 已标记过的元素由 run 内先恢复再重扫，这里不重复收集
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const opacity = Number(style.opacity || 1);
    if (!Number.isFinite(opacity) || opacity < 0.05) continue;
    // 必须有直接文本节点（叶子文本持有者），避免重复处理嵌套元素
    let hasDirectText = false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && String(node.textContent || '').trim()) {
        hasDirectText = true;
        break;
      }
    }
    if (!hasDirectText) continue;
    // [保守策略] 只增强"有特效背景"的内容（开场白/对话卡等卡片作者设计的渐变特效）：
    // 自身或祖先链（≤5 层，不越过容器）存在 gradient 背景才参与增强；
    // 普通纯文字、通用面板（palink-th-panel 已排除）一律不调，避免大范围改色破坏卡片原设计。
    let hasEffectBackground = false;
    let ancestor: Element | null = el;
    let depth = 0;
    while (ancestor && ancestor !== container && depth < 5) {
      const bgImage = win.getComputedStyle(ancestor).backgroundImage;
      if (bgImage && !/^none$/i.test(bgImage) && /gradient/i.test(bgImage)) {
        hasEffectBackground = true;
        break;
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }
    if (!hasEffectBackground) continue;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) continue;
    results.push(el);
  }
  return results;
}

export function attachContrastEnhancer(options: ContrastEnhancerOptions): ContrastEnhancerHandle {
  const {
    container,
    doc,
    themeRoot,
    isEnabled,
    minRatio = 4.5,
    maxElements = 600,
    onAdjusted,
  } = options;

  let disposed = false;
  let timerId = 0;
  let lastCount = -1;

  const win = doc.defaultView;

  /** 恢复被覆盖元素的原色并清除标记。 */
  const clearOverrides = (): void => {
    const marked = container.querySelectorAll(`[${CONTRAST_ADJUSTED_ATTR}]`);
    for (const el of marked) {
      const original = el.getAttribute(CONTRAST_ORIGINAL_ATTR);
      if (original) {
        try {
          (el as HTMLElement).style.setProperty('color', original, 'important');
        } catch { /* ignore */ }
      }
      el.removeAttribute(CONTRAST_ADJUSTED_ATTR);
      el.removeAttribute(CONTRAST_ORIGINAL_ATTR);
    }
    if (marked.length > 0) {
      lastCount = 0;
      onAdjusted?.(0);
    }
  };

  const run = (): number => {
    if (disposed || !win) return 0;
    if (!isEnabled()) {
      clearOverrides();
      return 0;
    }

    // 先恢复旧覆盖，再以当前样式重新判定（避免旧 important 影响 computed 采样）
    clearOverrides();

    let count = 0;
    const elements = collectTextElements(container, doc, maxElements);
    for (const el of elements) {
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(el);
      } catch {
        continue;
      }
      const foreground = parseCssColor(style.color);
      if (!foreground) continue;
      const background = resolveEffectiveBackground(el, win);
      if (!background) continue; // 背景不可解析 → 保守跳过，避免误调
      const result = ensureContrast(foreground, background, minRatio);
      // 注意：ensureContrast.readable 表示"调整后是否达标"，不代表"原本可读"——
      // 原本可读时 adjusted 等于原色；只有原本不可读（需调整）时 adjusted 才变化。
      // 因此用"颜色是否变化"判断是否需要应用调整，避免把已调整元素误当"可读"跳过。
      const unchanged =
        result.adjusted.r === foreground.r
        && result.adjusted.g === foreground.g
        && result.adjusted.b === foreground.b;
      if (unchanged) continue;
      const target = el as HTMLElement;
      try {
        target.setAttribute(CONTRAST_ORIGINAL_ATTR, style.color);
        target.setAttribute(CONTRAST_ADJUSTED_ATTR, '');
        target.style.setProperty('color', rgbaToString(result.adjusted), 'important');
      } catch {
        continue;
      }
      count += 1;
    }

    if (count !== lastCount) {
      lastCount = count;
      onAdjusted?.(count);
    }
    return count;
  };

  const scheduleRun = (): void => {
    if (disposed) return;
    // 用 setTimeout 节流（32ms）：比 rAF 更可靠——MCP 自动化/后台标签环境下
    // rAF 回调可被无限期延迟（实测数百 ms 不触发），导致 observer 触发的调度被吞，
    // 增强器永不执行。32ms 节流对流式输出已足够平滑。
    if (timerId) {
      clearTimeout(timerId);
      timerId = 0;
    }
    timerId = window.setTimeout(() => {
      timerId = 0;
      run();
    }, 32);
  };

  // 主题切换联动：data-theme 变化 → 重判（亮色注入 / 暗色清除）
  let themeObserver: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(scheduleRun);
    themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // 内容变化（流式输出 / 卡片脚本动态增删）→ 重扫
  let contentObserver: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    contentObserver = new MutationObserver(scheduleRun);
    contentObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  // 首次运行：立即同步扫描一次（不依赖 rAF，保证首帧即生效），再补一次调度兜底
  if (!disposed) run();
  const initTimer = window.setTimeout(scheduleRun, 60);

  return {
    run,
    dispose() {
      disposed = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = 0;
      }
      if (initTimer) clearTimeout(initTimer);
      themeObserver?.disconnect();
      contentObserver?.disconnect();
      clearOverrides();
    },
  };
}
