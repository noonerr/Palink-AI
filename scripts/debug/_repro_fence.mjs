// Reproduce the fence extraction logic from CharacterCardRenderer.tsx
const HTML_CODE_BLOCK_PATTERN = /(`{3,})html\s*\r?\n([\s\S]*?)\r?\n`{3,}\s*(?:\$[0-9]+\s*)?(?=\r?\n|$)/g;
const OPEN_HTML_CODE_BLOCK_PATTERN = /(^|\n)(`{3,})html\s*\r?\n([\s\S]*)$/i;
const FULL_HTML_START_PATTERN = /(?:^|\n)\s*(?:html\s*)?(?:<!DOCTYPE\s+html|<html[\s>])/i;

function normalizeHtmlCandidate(text) {
  return String(text || '')
    .trim()
    .replace(/^html\s*(?=<!DOCTYPE\s+html|<html[\s>])/i, '')
    .replace(/^(`{3,})html\s*\r?\n/i, '')
    .replace(/\r?\n(`{3,})\s*$/i, '')
    .trim();
}

function looksLikeSmartCardHtml(text) {
  if (!text) return false;
  if (/<palink-html>[\s\S]*?<\/palink-html>/i.test(text)) return true;
  HTML_CODE_BLOCK_PATTERN.lastIndex = 0;
  if (HTML_CODE_BLOCK_PATTERN.test(text)) { HTML_CODE_BLOCK_PATTERN.lastIndex = 0; return true; }
  HTML_CODE_BLOCK_PATTERN.lastIndex = 0;
  if (OPEN_HTML_CODE_BLOCK_PATTERN.test(text) && /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(text)) return true;
  const candidate = normalizeHtmlCandidate(text);
  if (/<!DOCTYPE\s+html|<html[\s>]/i.test(candidate)) return true;
  if (/<script[\s>]/i.test(candidate)) return true;
  if (/\son[a-z]+\s*=/i.test(candidate)) return true;
  if (/<style[\s>][\s\S]*<\/style>/i.test(candidate) && /<(?:button|input|select|textarea|form|section|main|div)\b/i.test(candidate)) return true;
  return false;
}

function findHtmlCodeFence(source, cursor) {
  const slice = source.slice(cursor);
  // 兼容 Showdown 把围栏包进 <p> 的情况：<p>```html ... ```</p> 或 ```<br />
  // 开围栏前允许可选 <p[^>]*>，闭合围栏后允许可选 </p> / <br> / <br />。
  const closedMatch = slice.match(/(?:^|\n)\s*(?:<p\b[^>]*>\s*)?(`{3,})html\s*\r?\n([\s\S]*?)\r?\n\1\s*(?:<\/p>|<br\s*\/?>)?\s*(?:\$[0-9]+\s*)?(?=\r?\n|$)/i);
  if (closedMatch && closedMatch.index !== undefined) {
    const start = cursor + closedMatch.index;
    return { start, end: start + closedMatch[0].length, html: normalizeHtmlCandidate(closedMatch[2]), priority: 1 };
  }
  const openMatch = slice.match(/(?:^|\n)\s*(?:<p\b[^>]*>\s*)?(`{3,})html\s*\r?\n([\s\S]*)$/i);
  if (openMatch && openMatch.index !== undefined && /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(openMatch[2] || '')) {
    const start = cursor + openMatch.index;
    return { start, end: source.length, html: normalizeHtmlCandidate(openMatch[2]), priority: 1 };
  }
  return null;
}

function findFullHtmlDocument(source, cursor) {
  const slice = source.slice(cursor);
  const startMatch = slice.match(FULL_HTML_START_PATTERN);
  if (!startMatch || startMatch.index === undefined) return null;
  const rawStart = cursor + startMatch.index;
  const matchedStart = startMatch[0].search(/(?:html\s*)?(?:<!DOCTYPE\s+html|<html[\s>])/i);
  const docStart = rawStart + Math.max(0, matchedStart);
  const afterStart = source.slice(docStart);
  const closeMatch = afterStart.match(/<\/html\s*>/i);
  const end = closeMatch && closeMatch.index !== undefined ? docStart + closeMatch.index + closeMatch[0].length : source.length;
  return { start: docStart, end, html: normalizeHtmlCandidate(source.slice(docStart, end)), priority: 2 };
}

function findNextHtmlBlock(source, cursor) {
  const candidates = [findHtmlCodeFence(source, cursor), findFullHtmlDocument(source, cursor)].filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start || a.priority - b.priority);
  const next = candidates[0];
  return { start: next.start, end: next.end, html: next.html };
}

function extractHtmlRenderParts(text) {
  const source = String(text || '');
  const parts = [];
  let cursor = 0;
  let foundHtml = false;
  while (cursor < source.length) {
    const next = findNextHtmlBlock(source, cursor);
    if (!next) { parts.push({ type: 'markdown', content: source.slice(cursor) }); break; }
    if (next.start > cursor) parts.push({ type: 'markdown', content: source.slice(cursor, next.start) });
    if (next.html.trim()) { parts.push({ type: 'html', content: next.html.trim() }); foundHtml = true; }
    cursor = Math.max(next.end, cursor + 1);
  }
  if (!foundHtml) return null;
  return parts;
}

function show(label, html) {
  const striped = html.replace(/\n/g, '\\n');
  console.log('=== ' + label + ' ===');
  console.log('INPUT: ' + striped.slice(0, 200));
  const parts = extractHtmlRenderParts(html);
  if (!parts) { console.log('  -> null (NO HTML FOUND)'); return; }
  parts.forEach((p, i) => {
    if (p.type === 'markdown') console.log(`  [markdown ${i}] ${JSON.stringify(p.content).slice(0, 150)}`);
    else console.log(`  [html ${i}] <${p.content.length} chars> starts: ${JSON.stringify(p.content.slice(0, 60))}`);
  });
}

const fullDoc = '<!DOCTYPE html>\n<html>\n<head><style>body{}</style></head>\n<body><div class="statusbar">HI</div></body>\n</html>';
const frag = '<div class="statusbar"><span>HI</span></div>';

show('clean full doc fenced', '```html\n' + fullDoc + '\n```');
show('prose + fenced full doc', 'hello world\n```html\n' + fullDoc + '\n```');
show('prose + fenced fragment', 'hello\n```html\n' + frag + '\n```');
show('prose + fenced + trailing prose no newline', 'hello\n```html\n' + frag + '\n```tail');
show('fenced with trailing text same line closing', '```html\n' + frag + '\n``` more');
show('two newlines before closing', '```html\n' + fullDoc + '\n\n```');
show('fenced fragment with internal blank lines', '```html\n' + frag + '\n\n```\n');
// 真实泄漏场景：Showdown 把围栏包进 <p> —— <p>```html ... ```</p>
show('Showdown wrapped p (full doc)', '<p>```html\n' + fullDoc + '\n```</p>');
show('Showdown wrapped p + newline after', '<p>```html\n' + fullDoc + '\n```</p>\n');
show('prose + Showdown wrapped p', 'hello\n<p>```html\n' + fullDoc + '\n```</p>');