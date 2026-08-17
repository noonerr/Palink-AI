// Reproduce EXACT current CharacterCardRenderer.tsx findHtmlCodeFence (line 954-983, simple version)
function normalizeHtmlCandidate(text) {
  return String(text || '')
    .trim()
    .replace(/^html\s*(?=<!DOCTYPE\s+html|<html[\s>])/i, '')
    .replace(/^(`{3,})html\s*\r?\n/i, '')
    .replace(/\r?\n(`{3,})\s*$/i, '')
    .trim();
}

// EXACT current component regex
function findHtmlCodeFence(source, cursor) {
  const slice = source.slice(cursor);
  const closedMatch = slice.match(/(`{3,})html\s*\r?\n([\s\S]*?)\r?\n\1\s*(?:\$[0-9]+\s*)?(?=\r?\n|$)/i);
  if (closedMatch && closedMatch.index !== undefined) {
    const start = cursor + closedMatch.index;
    return { start, end: start + closedMatch[0].length, html: normalizeHtmlCandidate(closedMatch[2]), priority: 1 };
  }
  const openMatch = slice.match(OPEN_HTML_CODE_BLOCK_PATTERN);
  if (openMatch && openMatch.index !== undefined && /<!DOCTYPE\s+html|<html[\s>]|<style[\s>]|<script[\s>]/i.test(openMatch[3] || '')) {
    const start = cursor + openMatch.index + (openMatch[1] ? openMatch[1].length : 0);
    return { start, end: source.length, html: normalizeHtmlCandidate(openMatch[3]), priority: 1 };
  }
  return null;
}

const OPEN_HTML_CODE_BLOCK_PATTERN = /(^|\n)(`{3,})html\s*\r?\n([\s\S]*)$/i;
const FULL_HTML_START_PATTERN = /(?:^|\n)\s*(?:html\s*)?(?:<!DOCTYPE\s+html|<html[\s>])/i;

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

const fullDoc = '<!DOCTYPE html>\n<html><head><style>body{}</style></head><body><div class="statusbar">HI</div><script>window.x=1</script></body></html>';

const cases = [
  ['plain fenced', '```html\n' + fullDoc + '\n```'],
  ['fenced trailing $4', '```html\n' + fullDoc + '\n```\n$4'],
  ['fenced + newline after', '```html\n' + fullDoc + '\n```\n'],
  ['fenced trailing text same line', '```html\n' + fullDoc + '\n``` more text'],
  ['content before fence', 'hello\n```html\n' + fullDoc + '\n```'],
  ['content before+after', 'hello\n```html\n' + fullDoc + '\n```\nworld'],
];

for (const [label, src] of cases) {
  const fence = findHtmlCodeFence(src, 0);
  const full = findFullHtmlDocument(src, 0);
  console.log('=== ' + label + ' ===');
  console.log('  fence match?', fence ? 'YES start=' + fence.start + ' end=' + fence.end : 'NO');
  console.log('  fullDoc match?', full ? 'YES start=' + full.start + ' end=' + full.end : 'NO');
}