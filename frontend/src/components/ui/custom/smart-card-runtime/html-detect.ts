// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { HTML_CODE_BLOCK_PATTERN, OPEN_HTML_CODE_BLOCK_PATTERN } from './shared';
import { htmlSupportsOuterCollapse, htmlUsesViewportHeight, normalizeHtmlCandidate } from './primitives';

export function isFullHtmlDocument(html: string): boolean {
  return /<!DOCTYPE\s+html|<html[\s>]/i.test(normalizeHtmlCandidate(html));
}


export function looksLikeSmartCardHtml(text: string): boolean {
  if (!text) return false;
  if (/<palink-html>[\s\S]*?<\/palink-html>/i.test(text)) return true;
  HTML_CODE_BLOCK_PATTERN.lastIndex = 0;
  if (HTML_CODE_BLOCK_PATTERN.test(text)) {
    HTML_CODE_BLOCK_PATTERN.lastIndex = 0;
    return true;
  }
  HTML_CODE_BLOCK_PATTERN.lastIndex = 0;
  if (OPEN_HTML_CODE_BLOCK_PATTERN.test(text) && /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(text)) return true;
  const candidate = normalizeHtmlCandidate(text);
  if (isFullHtmlDocument(candidate)) return true;
  if (/<script[\s>]/i.test(candidate)) return true;
  if (/\son[a-z]+\s*=/i.test(candidate)) return true;
  if (/<style[\s>][\s\S]*<\/style>/i.test(candidate) && /<(?:button|input|select|textarea|form|section|main|div)\b/i.test(candidate)) return true;
  return false;
}


export function looksLikeRenderableCardHtml(text: string): boolean {
  if (looksLikeSmartCardHtml(text)) return true;
  const candidate = normalizeHtmlCandidate(text);
  if (!candidate || !/<[a-zA-Z][\w:-]*(?:\s[^>]*)?>/.test(candidate)) return false;
  // <content>/<message>/<response> 是角色卡语义标签，内容应走 formatMessage 路径
  // （Showdown 转换 Markdown 标记），preprocessMarkdownForShowdown 会保护这些标签
  if (/<\/?(?:thinking|start|now_plot|sakura_status|analysis|reasoning)\b[^>]*>/i.test(candidate)
    && !/<(?:div|span|section|article|main|aside|nav|header|footer|table|button|input|select|textarea|img|svg|canvas|details|summary|style)\b/i.test(candidate)) {
    return false;
  }
  if (/<(?:script|style)\b/i.test(candidate)) return true;
  if (/<(?:div|span|section|article|main|aside|nav|header|footer|table|thead|tbody|tr|td|th|button|input|select|textarea|label|img|picture|svg|canvas|details|summary|progress|meter)\b/i.test(candidate)
    && /\b(?:class|style|data-[\w-]+|role|aria-[\w-]+|id)\s*=/i.test(candidate)) {
    return true;
  }
  const richTagCount = (candidate.match(/<\/?(?:div|span|section|article|main|table|tr|td|button|img|svg|details|summary)\b/gi) || []).length;
  return richTagCount >= 3;
}


export function htmlPrefersAvailableHeight(html: string): boolean {
  return htmlUsesViewportHeight(html) || /\b(?:mg-launcher|mg-wrapper-reset|main-wrapper|dashboard)\b/i.test(html);
}


export function htmlPrefersImmersive(html: string): boolean {
  const candidate = String(html || '');
  if (htmlSupportsOuterCollapse(candidate)) return true;
  if (/\b(?:mg-launcher|mg-wrapper-reset)\b/i.test(candidate)) return true;
  // [FULLSCREEN-ADAPT] 开局界面/启动器类（如"星空启动器"、"魔法少女大冒险"开局界面）：
  // 卡片通过界面正则把 <占位符> 替换成完整 HTML 文档，含 #launcher/.launcher 主体
  // （height:9Xvh 全屏）。这类界面在 ST 中原样渲染在页面视口上即全屏效果，
  // Palink 应走沉浸式全屏分支，而非被压成小高度内联 iframe。
  // 注意：不依赖 body{height:100vh}/flex 居中等样式特征判定——状态栏面板的 body
  // 也常写 height:100vh 且源 HTML 含多个 body 规则（含 @media 内的 flex 居中），
  // 依赖样式会误判，导致消息被整页全屏面板占满。仅以显式 launcher 元素为准。
  if (/\b(?:#launcher|id\s*=\s*["']launcher["']|class\s*=\s*["'][^"']*\blauncher\b[^"']*["'])/i.test(candidate)) return true;
  // 不再用宽泛的 position:fixed / height:100vh 正则判定沉浸式——
  // 状态栏面板的 starfield/falling-stars 等 position:fixed 装饰层与 main-container
  // 的 calc(100vh-…)/min-height:100% 会被误判为沉浸式。
  return false;
}


export function htmlNeedsIframe(html: string): boolean {
  const candidate = normalizeHtmlCandidate(html);
  if (/<script[\s>]/i.test(candidate)) return true;
  if (/<(?:iframe|object|embed|base|form)\b/i.test(candidate)) return true;
  if (/\son[a-z]+\s*=/i.test(candidate)) return true;
  if (/\b(?:window|document|localStorage|sessionStorage)\s*\./i.test(candidate)) return true;
  if (/\b(?:getContext|SillyTavern|eventSource|sendToTavern|AutoCardUpdaterAPI)\s*\(/i.test(candidate)) return true;
  return false;
}

