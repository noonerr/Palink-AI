/**
 * 亮色模式智能卡对比度增强 —— 纯函数工具模块。
 *
 * 与 contrast-enhancer.ts（运行时增强器）解耦：本文件只做颜色解析 / 亮度 /
 * 对比度计算 / 调整，不碰 DOM，可被主文档与 iframe 内共享调用。
 *
 * 设计要点（对齐 docs/light-mode-contrast-enhancement/spec.md §3.2）：
 * - resolveEffectiveBackground：半透明背景沿祖先链向上做 alpha 合成；linear-gradient
 *   退化为取首个颜色 stop（多数卡片的渐变首色 ≈ 底色）。
 * - adjustForContrast：保持色相（H）与饱和度（S）不变，只沿 HSL 亮度轴远离背景方向
 *   步进，直到满足 WCAG 对比度 —— 多色字体只变明暗、不变色相，符合用户决策。
 */

import type { RgbaColor } from './shared';

export interface ContrastResult {
  /** 当前对比度（WCAG ratio） */
  ratio: number;
  /** 是否已满足 minRatio */
  readable: boolean;
  /** 调整后的颜色（readable 时等于原色） */
  adjusted: RgbaColor;
}

const GRADIENT_COLOR_TOKEN = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|color\(srgb[\s\S]*?\)/gi;

/** 十六进制 → RGB。支持 #rgb / #rrggbb / #rrggbbaa。 */
function hexToRgba(hex: string): RgbaColor | null {
  const source = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3,8}$/i.test(source)) return null;
  let r = 0; let g = 0; let b = 0; let a = 1;
  if (source.length === 3 || source.length === 4) {
    r = parseInt(source[0] + source[0], 16);
    g = parseInt(source[1] + source[1], 16);
    b = parseInt(source[2] + source[2], 16);
    if (source.length === 4) a = parseInt(source[3] + source[3], 16) / 255;
  } else if (source.length === 6 || source.length === 8) {
    r = parseInt(source.slice(0, 2), 16);
    g = parseInt(source.slice(2, 4), 16);
    b = parseInt(source.slice(4, 6), 16);
    if (source.length === 8) a = parseInt(source.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  return { r, g, b, a };
}

/** 解析现代 CSS 颜色函数：rgb()/rgba()/color(srgb)。返回 null 表示不可解析。 */
function funcToRgba(value: string): RgbaColor | null {
  const source = String(value || '').trim().toLowerCase();
  if (!source) return null;

  // color(srgb r g b) / color(srgb r g b / a)，数值 0-1
  const srgbMatch = source.match(/^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+%?)\s*)?\)$/);
  if (srgbMatch) {
    const alpha = srgbMatch[4] === undefined ? 1 : (srgbMatch[4].endsWith('%') ? Number(srgbMatch[4].slice(0, -1)) / 100 : Number(srgbMatch[4]));
    return {
      r: Math.round(Number(srgbMatch[1]) * 255),
      g: Math.round(Number(srgbMatch[2]) * 255),
      b: Math.round(Number(srgbMatch[3]) * 255),
      a: Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1)),
    };
  }

  // rgba?（r,g,b[,a]）或 rgb(r g b / a)
  const commaMatch = source.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+%?)\s*)?\)$/);
  if (commaMatch) {
    const alpha = commaMatch[4] === undefined ? 1 : (commaMatch[4].endsWith('%') ? Number(commaMatch[4].slice(0, -1)) / 100 : Number(commaMatch[4]));
    return {
      r: Math.min(255, Math.round(Number(commaMatch[1]))),
      g: Math.min(255, Math.round(Number(commaMatch[2]))),
      b: Math.min(255, Math.round(Number(commaMatch[3]))),
      a: Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1)),
    };
  }
  const spaceMatch = source.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+%?)\s*)?\)$/);
  if (spaceMatch) {
    const alpha = spaceMatch[4] === undefined ? 1 : (spaceMatch[4].endsWith('%') ? Number(spaceMatch[4].slice(0, -1)) / 100 : Number(spaceMatch[4]));
    return {
      r: Math.min(255, Math.round(Number(spaceMatch[1]))),
      g: Math.min(255, Math.round(Number(spaceMatch[2]))),
      b: Math.min(255, Math.round(Number(spaceMatch[3]))),
      a: Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1)),
    };
  }
  return null;
}

/** 解析任意 CSS 颜色字符串 → RgbaColor；不可解析返回 null。 */
export function parseCssColor(value: string): RgbaColor | null {
  const source = String(value || '').trim();
  if (!source || /^transparent$/i.test(source)) return null;
  if (source.startsWith('#')) return hexToRgba(source);
  return funcToRgba(source);
}

/**
 * 从 linear-gradient / radial-gradient 背景中提取"主导底色"。
 * 取第一个颜色 stop（多数卡片的渐变首色 ≈ 底色）；解析失败返回 null。
 */
export function extractGradientBaseColor(backgroundImage: string): RgbaColor | null {
  const source = String(backgroundImage || '');
  const funcMatch = source.match(/(?:linear|radial|conic)-gradient\s*\(\s*[^)]*\)/i);
  if (!funcMatch) return null;
  // 找函数内第一个颜色 token（跳过角度/位置参数前的 to/at 等）
  const tokens = funcMatch[0].match(GRADIENT_COLOR_TOKEN) || [];
  if (tokens.length === 0) return null;
  const first = tokens[0];
  if (!first) return null;
  return parseCssColor(first);
}

/**
 * 从元素向上沿祖先链解析"有效背景色"：
 * - 每层取 background-color（半透明则继续向上合成）
 * - background-image 为渐变时用其主导底色参与合成
 * - 遇到不透明背景即终止
 * 全链透明时返回 null（调用方应保守跳过，避免误调）。
 */
export function resolveEffectiveBackground(el: Element, win: Window | null): RgbaColor | null {
  if (!win) return null;
  let blended: RgbaColor | null = null;
  let current: Element | null = el;
  while (current) {
    let style: CSSStyleDeclaration;
    try {
      style = win.getComputedStyle(current);
    } catch {
      break;
    }
    const bgImage = String(style.backgroundImage || '').trim();
    let layer: RgbaColor | null = null;
    if (bgImage && !/^none$/i.test(bgImage)) {
      layer = extractGradientBaseColor(bgImage);
    }
    if (!layer) layer = parseCssColor(style.backgroundColor);
    if (layer) {
      if (layer.a >= 0.999) {
        blended = { r: layer.r, g: layer.g, b: layer.b, a: 1 };
        break;
      }
      blended = blended ? alphaBlend(layer, blended) : { r: layer.r, g: layer.g, b: layer.b, a: layer.a };
    }
    current = current.parentElement;
  }
  if (!blended) return null;
  return { r: blended.r, g: blended.g, b: blended.b, a: 1 };
}

/** 前景半透明层叠到背景上（标准 alpha 合成，0-255 通道）。 */
export function alphaBlend(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const a = Math.min(1, Math.max(0, foreground.a));
  const mix = (f: number, b: number) => Math.round(f * a + b * (1 - a));
  return {
    r: mix(foreground.r, background.r),
    g: mix(foreground.g, background.g),
    b: mix(foreground.b, background.b),
    a: 1,
  };
}

function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度（0-1）。 */
export function relativeLuminance(color: RgbaColor): number {
  return 0.2126 * channelToLinear(color.r) + 0.7152 * channelToLinear(color.g) + 0.0722 * channelToLinear(color.b);
}

/** WCAG 对比度（1-21）。 */
export function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function rgbToHsl(color: RgbaColor): { h: number; s: number; l: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

export function hslToRgb(hsl: { h: number; s: number; l: number }): RgbaColor {
  const { h, s, l } = hsl;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    a: 1,
  };
}

/**
 * 对比度检测 + 调整一体入口。
 * ratio >= minRatio → 原样返回（多色字体中可读的颜色不动）。
 * 否则保持色相/饱和度，沿亮度轴远离背景步进直到满足 minRatio。
 */
export function ensureContrast(
  foreground: RgbaColor,
  background: RgbaColor,
  minRatio = 4.5,
): ContrastResult {
  let ratio = contrastRatio(foreground, background);
  if (ratio >= minRatio) return { ratio, readable: true, adjusted: foreground };

  const hsl = rgbToHsl(foreground);
  // 背景越亮 → 文字应越暗；背景越暗 → 文字应越亮
  const darken = relativeLuminance(background) > 0.5;
  let best = { ...foreground };
  let bestRatio = ratio;
  let l = hsl.l;
  // 步进 0.03（保守）：调整更接近原色、更柔和；24 步上限保证最终达标
  for (let i = 0; i < 24; i += 1) {
    l += darken ? -0.03 : 0.03;
    if (l < 0.04) l = 0.04;
    if (l > 0.96) l = 0.96;
    const candidate = hslToRgb({ h: hsl.h, s: hsl.s, l });
    const candidateRatio = contrastRatio(candidate, background);
    if (candidateRatio > bestRatio) {
      best = candidate;
      bestRatio = candidateRatio;
    }
    if (candidateRatio >= minRatio) break;
  }
  return { ratio: bestRatio, readable: bestRatio >= minRatio, adjusted: best };
}

/** RgbaColor → CSS rgb() 字符串（不透明度已归一）。 */
export function rgbaToString(color: RgbaColor): string {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}
