// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { FULL_HTML_START_PATTERN, HTML_CODE_BLOCK_PATTERN, OPEN_HTML_CODE_BLOCK_PATTERN } from './shared';
import type { SmartCardRenderPart } from './shared';
import { extractTagContent, findPalinkHtmlBlock, hashSmartCardSource, normalizeHtmlCandidate, stripHtmlFenceLeftovers } from './primitives';
import { isFullHtmlDocument, looksLikeRenderableCardHtml, looksLikeSmartCardHtml } from './html-detect';

export function looksLikeRawSmartCardRemainder(text: string): boolean {
  const candidate = normalizeHtmlCandidate(text);
  if (!candidate) return false;
  if (/^`{3,}\s*$/i.test(candidate)) return true;
  if (/^(?:`{3,}\s*)?html\s*(?:`{3,}\s*)?$/i.test(candidate)) return true;
  if (looksLikeSmartCardHtml(candidate)) return true;
  if (FULL_HTML_START_PATTERN.test(candidate)) return true;
  if (/<\/?(?:script|style|head|body|html)\b/i.test(candidate)) return true;

  // Card scripts sometimes leak as unfenced JS/CSS after a partial markdown fence match.
  return /(?:window\.[A-Za-z0-9_$]+|document\.getElementById|document\.querySelector|localStorage|sessionStorage|const\s+[A-Z0-9_]{3,}|function\s+[A-Za-z0-9_$]+\s*\()/i.test(candidate);
}


export function extractFullHtmlDocuments(text: string): { htmlParts: string[]; remaining: string } {
  const htmlParts: string[] = [];
  const remainingParts: string[] = [];
  let cursor = 0;
  const source = String(text || '');

  while (cursor < source.length) {
    const slice = source.slice(cursor);
    const startMatch = slice.match(FULL_HTML_START_PATTERN);
    if (!startMatch || startMatch.index === undefined) {
      remainingParts.push(source.slice(cursor));
      break;
    }

    const start = cursor + startMatch.index;
    const prefix = source.slice(cursor, start).trim();
    if (prefix) remainingParts.push(prefix);

    const docStart = cursor + startMatch.index + startMatch[0].search(/(?:html\s*)?(?:<!DOCTYPE\s+html|<html[\s>])/i);
    const afterStart = source.slice(docStart);
    const closeMatch = afterStart.match(/<\/html\s*>/i);
    const end = closeMatch && closeMatch.index !== undefined
      ? docStart + closeMatch.index + closeMatch[0].length
      : source.length;

    htmlParts.push(normalizeHtmlCandidate(source.slice(docStart, end)));
    cursor = end;
  }

  return {
    htmlParts,
    remaining: remainingParts.join('\n').trim(),
  };
}


export function settleExtractedSmartCard(htmlParts: string[], remaining: string): { htmlParts: string[]; remaining: string } {
  const fullDocs = extractFullHtmlDocuments(remaining);
  if (fullDocs.htmlParts.length > 0) {
    htmlParts.push(...fullDocs.htmlParts);
    remaining = fullDocs.remaining;
  }

  if (/^\s*\$[0-9]+\s*$/.test(remaining)) {
    return { htmlParts, remaining: '' };
  }

  if (remaining && looksLikeRawSmartCardRemainder(remaining)) {
    return { htmlParts, remaining: '' };
  }

  return { htmlParts, remaining: remaining.trim() };
}


export function extractHtmlBlocks(text: string): { htmlParts: string[]; remaining: string } | null {
  const htmlParts: string[] = [];
  let hasMatch = false;

  let processed = text.replace(/<palink-html>([\s\S]*?)<\/palink-html>/gi, (_match, content) => {
    hasMatch = true;
    htmlParts.push(String(content).trim());
    return '';
  });

  processed = processed.replace(HTML_CODE_BLOCK_PATTERN, (_match, _ticks, content) => {
    hasMatch = true;
    htmlParts.push(normalizeHtmlCandidate(content));
    return '';
  });
  HTML_CODE_BLOCK_PATTERN.lastIndex = 0;

  if (hasMatch) {
    return settleExtractedSmartCard(htmlParts, processed.trim());
  }

  const openFenceMatch = processed.match(OPEN_HTML_CODE_BLOCK_PATTERN);
  if (openFenceMatch && /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(openFenceMatch[3] || '')) {
    const beforeFence = processed.slice(0, openFenceMatch.index).trim();
    return settleExtractedSmartCard([normalizeHtmlCandidate(openFenceMatch[3])], beforeFence);
  }

  const fullDocs = extractFullHtmlDocuments(processed);
  if (fullDocs.htmlParts.length > 0) {
    return settleExtractedSmartCard(fullDocs.htmlParts, fullDocs.remaining);
  }

  const candidate = normalizeHtmlCandidate(text);
  if (isFullHtmlDocument(candidate)) {
    return { htmlParts: [candidate], remaining: '' };
  }

  return null;
}



export function appendMarkdownPart(parts: SmartCardRenderPart[], content: string) {
  const normalized = normalizeRemainingMarkdown(content);
  if (!normalized) return;
  // [FIX] 面板提取后，正文片段若为可渲染的结构化 HTML（如角色卡"[美化]猫神对话框"
  // 把开场白转成的 .nk-msg 对话框），它不是面板提取残留的 JS/CSS 残缺，而是真正的
  // 消息正文，应作为 markdown 片段保留（走 renderRemaining → sanitizeStCompatHtml
  // 内联渲染出 .nk-msg 样式），而不是被 looksLikeRawSmartCardRemainder 当作 raw
  // remainder 丢弃——否则开场白在含状态栏面板的消息里会整体消失（残留 ``` 围栏被
  // 渲染成可见文本）。
  const isPreservableFragment =
    looksLikeRenderableCardHtml(normalized)
    && !/^\s*`{3,}/.test(normalized)
    && !/\b(?:window\.|document\.|localStorage|sessionStorage)\b/.test(normalized)
    && !/(?:^|\n)\s*(?:const|let|var|function)\s+/.test(normalized);
  if (!isPreservableFragment && looksLikeRawSmartCardRemainder(normalized)) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === 'markdown') {
    previous.content = `${previous.content}\n${normalized}`.trim();
    return;
  }
  parts.push({ type: 'markdown', content: normalized });
}


export function findHtmlCodeFence(source: string, cursor: number): { start: number; end: number; html: string; priority: number } | null {
  const slice = source.slice(cursor);
  // 兼容 Showdown 把围栏包进 <p> 的情况：<p>```html ... ```</p> 或 ```<br />。
  // 开围栏前允许可选 <p[^>]*>，闭合围栏后允许可选 </p> / <br> / <br />。
  // 否则围栏在 findFullHtmlDocument 兜底时被拆成「<p>```html」+「```</p>」两段，
  // 面板前后残留 ```html / ``` 被当作纯文本渲染（真实泄漏场景）。
  const closedMatch = slice.match(/(?:^|\n)\s*(?:<p\b[^>]*>\s*)?(`{3,})html\s*\r?\n([\s\S]*?)\r?\n\1\s*(?:<\/p>|<br\s*\/?>)?\s*(?:\$[0-9]+\s*)?(?=\r?\n|$)/i);
  if (closedMatch && closedMatch.index !== undefined) {
    const start = cursor + closedMatch.index;
    return {
      start,
      end: start + closedMatch[0].length,
      html: normalizeHtmlCandidate(closedMatch[2]),
      priority: 1,
    };
  }

  const openMatch = slice.match(/(?:^|\n)\s*(?:<p\b[^>]*>\s*)?(`{3,})html\s*\r?\n([\s\S]*)$/i);
  if (
    openMatch &&
    openMatch.index !== undefined &&
    /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(openMatch[2] || '')
  ) {
    const start = cursor + openMatch.index;
    return {
      start,
      end: source.length,
      html: normalizeHtmlCandidate(openMatch[2]),
      priority: 1,
    };
  }

  return null;
}


export function findFullHtmlDocument(source: string, cursor: number): { start: number; end: number; html: string; priority: number } | null {
  const slice = source.slice(cursor);
  const startMatch = slice.match(FULL_HTML_START_PATTERN);
  if (!startMatch || startMatch.index === undefined) return null;

  const rawStart = cursor + startMatch.index;
  const matchedStart = startMatch[0].search(/(?:html\s*)?(?:<!DOCTYPE\s+html|<html[\s>])/i);
  const docStart = rawStart + Math.max(0, matchedStart);
  const afterStart = source.slice(docStart);
  const closeMatch = afterStart.match(/<\/html\s*>/i);
  const end = closeMatch && closeMatch.index !== undefined
    ? docStart + closeMatch.index + closeMatch[0].length
    : source.length;

  return {
    start: docStart,
    end,
    html: normalizeHtmlCandidate(source.slice(docStart, end)),
    priority: 2,
  };
}


export function findNextHtmlBlock(source: string, cursor: number): { start: number; end: number; html: string } | null {
  const candidates = [
    findPalinkHtmlBlock(source, cursor),
    findHtmlCodeFence(source, cursor),
    findFullHtmlDocument(source, cursor),
  ].filter(Boolean) as Array<{ start: number; end: number; html: string; priority: number }>;

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start || a.priority - b.priority);
  const next = candidates[0];
  return { start: next.start, end: next.end, html: next.html };
}


export function extractHtmlRenderParts(text: string): SmartCardRenderPart[] | null {
  const source = String(text || '');
  const parts: SmartCardRenderPart[] = [];
  let cursor = 0;
  let foundHtml = false;

  const normalizedSource = normalizeHtmlCandidate(source);
  const hasExplicitHtmlBlock = /<palink-html>|`{3,}html/i.test(source);
  if (
    !hasExplicitHtmlBlock
    && looksLikeRenderableCardHtml(source)
    && normalizedSource.startsWith('<')
  ) {
    // Collapse into a single html part EXCEPT when the content mixes the AI's prose
    // reply with a full HTML document (the status-bar / smart-card case). In that
    // case we must NOT collapse: the prose has to render as markdown in the parent
    // document (correct font, normal flow) while the document renders in its own
    // isolated iframe below. Collapsing would merge both into one iframe, making the
    // prose inherit the document's `body { font-family }` and dropping the separate
    // panel position beneath the message.
    const fullDocs = extractFullHtmlDocuments(source);
    const remainingText = String(fullDocs.remaining || '').trim();
    // 判定"正文 + 完整文档"混合：存在完整文档，且文档之外还有非文档文本（哪怕该文本
    // 被面板的 <style>/<script> 污染，例如 Showdown 把面板 <style> 包进 <p> 导致开头是
    // `<p><style>`）。只要 remaining 不是"另一个完整文档"就强制拆分，让正文在父文档渲染、
    // 文档进独立 iframe。旧守卫用 looksLikeRawSmartCardRemainder 会误把含 <style> 的剩余文本
    // 判成 raw card remainder 而放弃拆分，导致整段合进同一 iframe 复现字体污染。
    const isProsePlusDocument =
      fullDocs.htmlParts.length > 0 &&
      remainingText.length > 0 &&
      !FULL_HTML_START_PATTERN.test(remainingText);
    if (!isProsePlusDocument) {
      return [{ type: 'html', content: normalizedSource }];
    }
    // fall through to the split loop below
  }

  while (cursor < source.length) {
    const next = findNextHtmlBlock(source, cursor);
    if (!next) {
      appendMarkdownPart(parts, source.slice(cursor));
      break;
    }

    if (next.start > cursor) {
      appendMarkdownPart(parts, source.slice(cursor, next.start));
    }

    if (next.html.trim()) {
      parts.push({ type: 'html', content: next.html.trim() });
      foundHtml = true;
    }
    cursor = Math.max(next.end, cursor + 1);
  }

  if (!foundHtml) return null;
  return parts;
}


export function getHtmlRenderSignature(html: string): string {
  const candidate = normalizeHtmlCandidate(html);
  const title = candidate.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (title) return `title:${title}`;

  const bodyClass = candidate.match(/<body\b[^>]*\bclass=(["'])(.*?)\1/i)?.[2]
    ?.replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (bodyClass) return `body-class:${bodyClass}`;

  const rootId = candidate.match(/<(?:main|section|div|article)\b[^>]*\bid=(["'])(.*?)\1/i)?.[2]
    ?.trim()
    .toLowerCase();
  if (rootId) return `root-id:${rootId}`;

  const rootClass = candidate.match(/<(?:main|section|div|article)\b[^>]*\bclass=(["'])(.*?)\1/i)?.[2]
    ?.replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (rootClass) return `root-class:${rootClass}`;

  return `hash:${hashSmartCardSource(candidate.slice(0, 12000))}`;
}

// 防御性清理：移除智能卡面板提取后残留的 HTML 代码围栏标记（```html / ```）。
// findHtmlCodeFence / HTML_CODE_BLOCK_PATTERN 提取面板时，若 Showdown 包装的围栏
// （<p>```html…```</p>）匹配不完整，会在面板前后残留成行的 ```html 与 ```，
// 被当作纯文本渲染成肉眼可见的 ```html / ``` 文字（所有卡都会出现）。

export function normalizeRemainingMarkdown(remaining: string): string {
  return stripHtmlFenceLeftovers(
    String(remaining || '')
      .replace(/Error:\s*(?:请求已中断，未收到模型回复。?|Request aborted[^.\n]*(?:\.\s*)?)/gi, ' ')
      .replace(/<palink-html>/gi, ' ')
      .replace(/<sakura_status>[\s\S]*?<\/sakura_status>/gi, '')
      .replace(/<\/?content>/gi, ''),
  ).trim();
}


export function removeFullDocumentShell(html: string): string {
  const candidate = normalizeHtmlCandidate(html)
    .replace(/<!DOCTYPE\s+html[^>]*>/gi, '')
    .trim();

  if (!isFullHtmlDocument(candidate)) return candidate;

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(candidate, 'text/html');
      return doc.body?.innerHTML || candidate;
    } catch {
      // Fall back to the regex extraction below.
    }
  }

  const body = extractTagContent(candidate, 'body');
  return (body || candidate)
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .trim();
}

