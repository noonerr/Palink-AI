// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { SMART_CARD_CSP_NONCE, smartCardNormalizedScriptCache } from './shared';
import { escapeHtmlAttribute, escapeQuotedScriptNewlines, getSmartCardCacheValue, hashSmartCardSource, loosenSmartCardGlobalLexicalDeclarations, setSmartCardCacheValue } from './primitives';

export function normalizeSmartCardScriptBlocks(html: string): string {
  const source = String(html || '');
  const cacheKey = hashSmartCardSource(source);
  const cached = getSmartCardCacheValue(smartCardNormalizedScriptCache, cacheKey);
  if (cached !== undefined) return cached;

  const result = source.replace(
    /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi,
    (_match, attrs = '', script = '') => {
      let normalizedAttrs = attrs || '';
      // 状态栏等卡片脚本常以 <script type="module"> 内联。但沙箱 iframe 仅 allow-scripts
      // （无 allow-same-origin）时，浏览器会直接禁止 module 脚本执行，导致面板 JS 完全不跑
      // （颜色/按钮/文字替换全部失效）。若脚本无 import/export（即经典脚本语义），降级为
      // 普通 <script>，使其在沙箱内可正常执行；CSP nonce 由 addSmartCardScriptNonce 统一补上。
      if (
        /\btype\s*=\s*["']?module["']?/i.test(normalizedAttrs)
        && !/(^|[^.\w$])import\s*[<(]|[^.\w$]export\s+[{(*]|import\s+[\w*{]|export\s+default|import\.meta/i.test(script || '')
      ) {
        normalizedAttrs = normalizedAttrs.replace(/\s*\btype\s*=\s*["']?module["']?/i, '');
      }
      return `<script${normalizedAttrs}>${escapeQuotedScriptNewlines(loosenSmartCardGlobalLexicalDeclarations(script))}</script>`;
    }
  );
  return setSmartCardCacheValue(smartCardNormalizedScriptCache, cacheKey, result);
}


export function addAttributeToHtmlTag(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${name}\\s*=`, 'i');
  if (pattern.test(tag)) return tag;
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${escapeHtmlAttribute(value)}"${end}`);
}


export function addSmartCardScriptNonce(html: string): string {
  return String(html || '').replace(/<script\b([^>]*)>/gi, (match, attrs = '') => {
    if (/\snonce\s*=/i.test(String(attrs))) return match;
    return `<script${attrs} nonce="${escapeHtmlAttribute(SMART_CARD_CSP_NONCE)}">`;
  });
}

