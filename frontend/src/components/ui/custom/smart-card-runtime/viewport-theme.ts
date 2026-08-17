// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { IFRAME_AVAILABLE_MIN_HEIGHT, IFRAME_DEFAULT_HEIGHT, IFRAME_INLINE_MAX_HEIGHT, IFRAME_VIEWPORT_BOTTOM_GAP, IFRAME_VIEWPORT_FALLBACK_BOTTOM_RESERVED, IFRAME_VIEWPORT_MAX_INITIAL_HEIGHT, IFRAME_VIEWPORT_MAX_RATIO, IFRAME_VIEWPORT_MIN_HEIGHT, IFRAME_VIEWPORT_RATIO, INLINE_MIN_HEIGHT } from './shared';
import type { RgbaColor, SmartCardImmersiveTheme, SmartCardViewportContext } from './shared';
import { clampColorByte, clampSmartCardHeight, getDefaultImmersiveTheme, getLayoutViewportHeight, getNearestScrollContainer, getRelativeLuminance, htmlUsesViewportHeight, isSmartCardVisualKeyboardLikelyOpen, roundSmartCardNumber } from './primitives';

export function parseCssColor(value: string | undefined | null): RgbaColor | null {
  const source = String(value || '').trim();
  if (!source) return null;

  const rgbMatch = source.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgbMatch) {
    return {
      r: clampColorByte(Number(rgbMatch[1])),
      g: clampColorByte(Number(rgbMatch[2])),
      b: clampColorByte(Number(rgbMatch[3])),
      a: rgbMatch[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgbMatch[4]))),
    };
  }

  const modernRgbMatch = source.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i);
  if (modernRgbMatch) {
    const alpha = modernRgbMatch[4]?.endsWith('%')
      ? Number(modernRgbMatch[4].slice(0, -1)) / 100
      : modernRgbMatch[4] == null ? 1 : Number(modernRgbMatch[4]);
    return {
      r: clampColorByte(Number(modernRgbMatch[1])),
      g: clampColorByte(Number(modernRgbMatch[2])),
      b: clampColorByte(Number(modernRgbMatch[3])),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  const hexMatch = source.match(/^#([0-9a-f]{3,8})$/i);
  if (!hexMatch) return null;

  const hex = hexMatch[1];
  if (hex.length === 3 || hex.length === 4) {
    const expanded = hex.split('').map((part) => part + part).join('');
    return parseCssColor(`#${expanded}`);
  }
  if (hex.length !== 6 && hex.length !== 8) return null;

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}


export function rgbaToCss(color: RgbaColor, alpha = color.a): string {
  return `rgba(${clampColorByte(color.r)}, ${clampColorByte(color.g)}, ${clampColorByte(color.b)}, ${Math.max(0, Math.min(1, alpha))})`;
}


export function flattenColorOver(color: RgbaColor, base: RgbaColor): RgbaColor {
  const alpha = Math.max(0, Math.min(1, color.a));
  const inverseAlpha = 1 - alpha;
  return {
    r: clampColorByte(color.r * alpha + base.r * inverseAlpha),
    g: clampColorByte(color.g * alpha + base.g * inverseAlpha),
    b: clampColorByte(color.b * alpha + base.b * inverseAlpha),
    a: 1,
  };
}


export function resolveImmersiveTheme(theme?: SmartCardImmersiveTheme | null): Required<SmartCardImmersiveTheme> {
  const fallback = getDefaultImmersiveTheme();
  const themeBackground = parseCssColor(theme?.backgroundColor);
  const fallbackBackground = parseCssColor(fallback.backgroundColor)!;
  const resolvedBackground = themeBackground && themeBackground.a > 0.05
    ? flattenColorOver(themeBackground, fallbackBackground)
    : parseCssColor(fallback.backgroundColor)!;
  const inferredDark = getRelativeLuminance(resolvedBackground) < 0.34;
  const resolvedForeground = parseCssColor(theme?.foregroundColor)
    || parseCssColor(inferredDark ? 'rgb(255, 255, 255)' : 'rgb(15, 23, 42)')!;

  return {
    backgroundColor: rgbaToCss(resolvedBackground),
    foregroundColor: rgbaToCss(resolvedForeground),
    isDark: typeof theme?.isDark === 'boolean' ? theme.isDark : inferredDark,
  };
}


export function extractSmartCardCssColors(source: string): RgbaColor[] {
  const colors: RgbaColor[] = [];
  const colorPattern = /rgba?\(\s*[^)]*?\)|#[0-9a-f]{3,8}\b/gi;
  let match: RegExpExecArray | null;
  while ((match = colorPattern.exec(source)) !== null) {
    const color = parseCssColor(match[0]);
    if (color && color.a > 0.05) colors.push(color);
  }
  return colors;
}


export function inferImmersiveThemeFromHtml(html: string, customCss?: string): SmartCardImmersiveTheme {
  const source = `${customCss || ''}\n${html || ''}`;
  const declarations: string[] = [];

  source.replace(/\bbackground(?:-color)?\s*:\s*([^;{}]+)/gi, (_match, value = '') => {
    declarations.push(String(value));
    return '';
  });
  source.replace(/\bstyle=(["'])(.*?)\1/gi, (_match, _quote, value = '') => {
    declarations.push(String(value));
    return '';
  });

  const colors = declarations.flatMap(extractSmartCardCssColors);
  const preferredColor = colors.find((color) => getRelativeLuminance(flattenColorOver(color, parseCssColor('rgb(0, 0, 0)')!)) < 0.92)
    || colors[0];
  if (!preferredColor) return getDefaultImmersiveTheme();

  const flattened = flattenColorOver(preferredColor, parseCssColor('rgb(0, 0, 0)')!);
  const isDark = getRelativeLuminance(flattened) < 0.34;
  return {
    backgroundColor: rgbaToCss(flattened),
    foregroundColor: isDark ? 'rgb(255, 255, 255)' : 'rgb(15, 23, 42)',
    isDark,
  };
}


export function estimateIframeInitialHeight(html: string): number {
  if (!htmlUsesViewportHeight(html)) return IFRAME_DEFAULT_HEIGHT;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 760;
  return Math.max(
    IFRAME_VIEWPORT_MIN_HEIGHT,
    Math.min(Math.round(viewportHeight * IFRAME_VIEWPORT_RATIO), IFRAME_VIEWPORT_MAX_INITIAL_HEIGHT),
  );
}


export function estimateIframeMaxHeight(html: string, initialHeight: number): number {
  if (!htmlUsesViewportHeight(html)) {
    return Math.max(
      initialHeight,
      INLINE_MIN_HEIGHT,
      IFRAME_INLINE_MAX_HEIGHT,
    );
  }
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 760;
  return Math.max(
    initialHeight,
    IFRAME_VIEWPORT_MIN_HEIGHT,
    Math.min(Math.round(viewportHeight * IFRAME_VIEWPORT_MAX_RATIO), IFRAME_VIEWPORT_MAX_INITIAL_HEIGHT),
  );
}


export function clampSmartCardAvailableHeight(value: number): number {
  if (!Number.isFinite(value)) return IFRAME_AVAILABLE_MIN_HEIGHT;
  const viewportHeight = getLayoutViewportHeight();
  const responsiveMinimum = Math.min(
    IFRAME_VIEWPORT_MIN_HEIGHT,
    Math.max(IFRAME_AVAILABLE_MIN_HEIGHT, Math.round(viewportHeight * 0.18)),
  );
  const minimum = Math.min(responsiveMinimum, Math.max(IFRAME_AVAILABLE_MIN_HEIGHT, Math.round(value)));
  return clampSmartCardHeight(value, minimum);
}


export function getSmartCardComposerHeight(): number {
  if (typeof document === 'undefined') return 0;
  const composer = document.querySelector<HTMLElement>('[data-palink-chat-composer="true"]');
  const rect = composer?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return 0;
  return roundSmartCardNumber(rect.height);
}


export function getSmartCardSafeAreaTop(isIOSDevice: boolean): number {
  if (typeof window === 'undefined') return isIOSDevice ? 48 : 0;
  const visualOffsetTop = roundSmartCardNumber(window.visualViewport?.offsetTop || 0);
  if (isIOSDevice) return Math.max(48, visualOffsetTop);
  return Math.max(0, visualOffsetTop);
}


/**
 * P1-2（问题 3）: 读取真实底部安全区（env(safe-area-inset-bottom)）。
 *
 * CSS 变量的 getPropertyValue('--xxx') 返回字面量 `env(safe-area-inset-bottom, 0px)`
 * 而非计算值，无法直接当数字用。用临时元素法：padding-bottom 设为 env(...) 后读取
 * computedStyle.paddingBottom（浏览器已解析为 px）。桌面端/不支持时返回 0。
 */
export function getSmartCardSafeAreaBottom(): number {
  if (typeof document === 'undefined') return 0;
  try {
    const probe = document.createElement('div');
    probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    document.body.appendChild(probe);
    const raw = getComputedStyle(probe).paddingBottom;
    probe.remove();
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) && px > 0 ? roundSmartCardNumber(px) : 0;
  } catch {
    return 0;
  }
}


export function collectSmartCardViewportContext(
  anchor: HTMLElement | null,
  options: {
    isIOSDevice: boolean;
    prefersImmersive: boolean;
    prefersAvailableHeight: boolean;
    availableHeight: number;
    stableViewportHeight?: number;
    frameFocusedEditable?: boolean;
  },
): SmartCardViewportContext {
  if (typeof window === 'undefined') {
    return {
      width: 390,
      height: IFRAME_VIEWPORT_MIN_HEIGHT,
      visualWidth: 390,
      visualHeight: IFRAME_VIEWPORT_MIN_HEIGHT,
      safeTop: options.isIOSDevice ? 48 : 0,
      safeBottom: 0,
      composerHeight: 0,
      availableHeight: options.availableHeight || IFRAME_VIEWPORT_MIN_HEIGHT,
      keyboardOpen: false,
      immersive: options.prefersImmersive,
    };
  }

  const visualViewport = window.visualViewport;
  const width = roundSmartCardNumber(window.innerWidth || document.documentElement?.clientWidth || 390);
  const rawLayoutHeight = roundSmartCardNumber(window.innerHeight || document.documentElement?.clientHeight || 760);
  const visualWidth = roundSmartCardNumber(visualViewport?.width || width);
  const visualHeight = roundSmartCardNumber(visualViewport?.height || rawLayoutHeight);
  const offsetTop = roundSmartCardNumber(visualViewport?.offsetTop || 0);
  const offsetLeft = roundSmartCardNumber(visualViewport?.offsetLeft || 0);
  const scale = roundSmartCardNumber(visualViewport?.scale || 1, 1);
  const composerHeight = getSmartCardComposerHeight();
  const stableViewportHeight = Math.max(
    rawLayoutHeight,
    Number.isFinite(Number(options.stableViewportHeight)) ? Number(options.stableViewportHeight) : 0,
    // F2 修复: 兜底最小值改用 IFRAME_VIEWPORT_MIN_HEIGHT(320)，与 CharacterCardRenderer.tsx:472
    // 一致——原硬编码 760 在小视口/移动端会把全屏覆盖层撑高导致底部裁剪。
    IFRAME_VIEWPORT_MIN_HEIGHT,
  );
  const rawKeyboardOpen = isSmartCardVisualKeyboardLikelyOpen(
    stableViewportHeight,
    options.frameFocusedEditable !== false,
  );
  const keyboardOpen = options.prefersImmersive
    ? false
    : rawKeyboardOpen && options.frameFocusedEditable !== false;
  const layoutVisualHeight = stableViewportHeight;
  const inferredAvailableHeight = options.prefersAvailableHeight
    ? getSmartCardAvailableHeight(anchor, stableViewportHeight)
    : Math.max(IFRAME_AVAILABLE_MIN_HEIGHT, layoutVisualHeight - (options.prefersImmersive ? getSmartCardSafeAreaTop(options.isIOSDevice) : 0));
  const availableHeight = options.prefersAvailableHeight && options.availableHeight > 0
    ? Math.max(IFRAME_AVAILABLE_MIN_HEIGHT, options.availableHeight)
    : inferredAvailableHeight;

  return {
    width,
    height: roundSmartCardNumber(layoutVisualHeight),
    visualWidth,
    visualHeight: roundSmartCardNumber(layoutVisualHeight),
    offsetTop,
    offsetLeft,
    scale,
    safeTop: getSmartCardSafeAreaTop(options.isIOSDevice),
    // P1-2（问题 3）: 读取真实底部安全区，不再恒 0——iPhone Home 条场景
    // 卡片 CSS 用 var(--palink-safe-bottom) 时底部按钮不再贴底。
    safeBottom: getSmartCardSafeAreaBottom(),
    composerHeight,
    availableHeight: roundSmartCardNumber(availableHeight),
    keyboardOpen,
    immersive: options.prefersImmersive,
  };
}


export function getSmartCardAvailableHeight(anchor: HTMLElement | null, stableViewportHeight?: number): number {
  if (typeof window === 'undefined') return IFRAME_VIEWPORT_MIN_HEIGHT;

  const viewportHeight = Number.isFinite(Number(stableViewportHeight))
    ? Math.max(IFRAME_AVAILABLE_MIN_HEIGHT, Number(stableViewportHeight))
    : getLayoutViewportHeight();
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const keyboardLikelyOpen = isSmartCardVisualKeyboardLikelyOpen(stableViewportHeight, true);
  const composer = document.querySelector<HTMLElement>('[data-palink-chat-composer="true"]');
  const composerTop = composer?.getBoundingClientRect().top;

  if (!keyboardLikelyOpen && Number.isFinite(composerTop) && (composerTop as number) > anchorTop) {
    return clampSmartCardAvailableHeight((composerTop as number) - anchorTop - IFRAME_VIEWPORT_BOTTOM_GAP);
  }

  const scrollContainer = getNearestScrollContainer(anchor);
  if (!keyboardLikelyOpen && scrollContainer) {
    const containerBottom = scrollContainer.getBoundingClientRect().bottom;
    if (containerBottom > anchorTop) {
      return clampSmartCardAvailableHeight(containerBottom - anchorTop - IFRAME_VIEWPORT_BOTTOM_GAP);
    }
  }

  return clampSmartCardAvailableHeight(viewportHeight - anchorTop - IFRAME_VIEWPORT_FALLBACK_BOTTOM_RESERVED);
}

