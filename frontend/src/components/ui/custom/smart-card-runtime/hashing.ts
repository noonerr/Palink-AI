// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import type { CharacterSmartCardContext, Language } from '@/types';
import { smartCardAdaptedHtmlCache } from './shared';
import { getSmartCardCacheValue, hashSmartCardSource, setSmartCardCacheValue } from './primitives';
import { SmartCardPersistedStorage } from './storage';

export function stableSmartCardStringify(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (value == null) return String(value);
  const valueType = typeof value;
  if (valueType === 'string') {
    const text = value as string;
    return text.length > 4096 ? `str:${text.length}:${hashSmartCardSource(text)}` : JSON.stringify(text);
  }
  if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(value);
  if (valueType === 'function' || valueType === 'symbol' || valueType === 'undefined') return valueType;
  if (depth > 5) return '[depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 120).map((item) => stableSmartCardStringify(item, depth + 1, seen));
    return `[${items.join(',')}${value.length > 120 ? `,+${value.length - 120}` : ''}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 160)
    .map((key) => `${JSON.stringify(key)}:${stableSmartCardStringify((value as Record<string, unknown>)[key], depth + 1, seen)}`);
  return `{${entries.join(',')}}`;
}


export function hashSmartCardUnknown(value: unknown): string {
  return hashSmartCardSource(stableSmartCardStringify(value));
}


export function getSmartCardBootContextSignature(
  context: CharacterSmartCardContext,
  interfaceLanguage: Language,
  persistedStorage: SmartCardPersistedStorage,
  sourceFingerprint: string,
  presentationMode: CharacterSmartCardContext['presentationMode'],
  trustedNative: boolean,
): string {
  return [
    context.characterId || '',
    context.characterName || '',
    context.userName || '',
    context.language || interfaceLanguage,
    context.firstMes || '',
    hashSmartCardUnknown(context.alternateGreetings || []),
    hashSmartCardUnknown(context.characterExtensions || null),
    hashSmartCardUnknown(context.presetData || null),
    hashSmartCardUnknown(context.globalRegexScripts || []),
    hashSmartCardUnknown(context.stPluginRuntimeConfig || null),
    hashSmartCardUnknown(persistedStorage),
    context.sessionId || '',
    presentationMode || 'inline',
    trustedNative ? 'native' : 'sandbox',
    sourceFingerprint,
  ].join('|');
}


export function adaptSmartCardRuntimeAccess(html: string): string {
  const source = String(html || '');
  const cacheKey = hashSmartCardSource(source);
  const cached = getSmartCardCacheValue(smartCardAdaptedHtmlCache, cacheKey);
  if (cached !== undefined) return cached;

  const result = source
    .replace(/\bwindow\s*\.\s*parent\s*\.\s*AutoCardUpdaterAPI\b/g, 'window.AutoCardUpdaterAPI')
    .replace(/\bparent\s*\.\s*AutoCardUpdaterAPI\b/g, 'window.AutoCardUpdaterAPI')
    .replace(/\bwindow\s*\.\s*top\s*\.\s*AutoCardUpdaterAPI\b/g, 'window.AutoCardUpdaterAPI')
    .replace(/\btop\s*\.\s*AutoCardUpdaterAPI\b/g, 'window.AutoCardUpdaterAPI')
    .replace(/\bwindow\s*\.\s*parent\s*\.\s*\$\s*\(/g, 'window.PalinkSmartCard.parent$(')
    .replace(/\bparent\s*\.\s*\$\s*\(/g, 'window.PalinkSmartCard.parent$(')
    .replace(/\bwindow\s*\.\s*top\s*\.\s*\$\s*\(/g, 'window.PalinkSmartCard.parent$(')
    .replace(/\btop\s*\.\s*\$\s*\(/g, 'window.PalinkSmartCard.parent$(')
    .replace(/\bwindow\s*\.\s*parent\s*\.\s*document\s*\.\s*getElementById\s*\(/g, 'window.PalinkSmartCard.parentDocument.getElementById(')
    .replace(/\bparent\s*\.\s*document\s*\.\s*getElementById\s*\(/g, 'window.PalinkSmartCard.parentDocument.getElementById(')
    .replace(/\bwindow\s*\.\s*top\s*\.\s*document\s*\.\s*getElementById\s*\(/g, 'window.PalinkSmartCard.parentDocument.getElementById(')
    .replace(/\btop\s*\.\s*document\s*\.\s*getElementById\s*\(/g, 'window.PalinkSmartCard.parentDocument.getElementById(')
    .replace(/\bwindow\s*\.\s*parent\s*\.\s*document\s*\.\s*querySelector(All)?\s*\(/g, (_match, all) => `window.PalinkSmartCard.parentDocument.querySelector${all || ''}(`)
    .replace(/\bparent\s*\.\s*document\s*\.\s*querySelector(All)?\s*\(/g, (_match, all) => `window.PalinkSmartCard.parentDocument.querySelector${all || ''}(`)
    .replace(/\bwindow\s*\.\s*top\s*\.\s*document\s*\.\s*querySelector(All)?\s*\(/g, (_match, all) => `window.PalinkSmartCard.parentDocument.querySelector${all || ''}(`)
    .replace(/\btop\s*\.\s*document\s*\.\s*querySelector(All)?\s*\(/g, (_match, all) => `window.PalinkSmartCard.parentDocument.querySelector${all || ''}(`)
    .replace(/\bwindow\s*\.\s*parent\s*\.\s*document\b/g, 'window.PalinkSmartCard.parentDocument')
    .replace(/\bparent\s*\.\s*document\b/g, 'window.PalinkSmartCard.parentDocument')
    .replace(/\bwindow\s*\.\s*top\s*\.\s*document\b/g, 'window.PalinkSmartCard.parentDocument')
    .replace(/\btop\s*\.\s*document\b/g, 'window.PalinkSmartCard.parentDocument');
  return setSmartCardCacheValue(smartCardAdaptedHtmlCache, cacheKey, result);
}

/**
 * 这些关键字后面出现的 `/` 一定是正则字面量的起点，而不是除号。
 * （`return /x/`、`typeof /x/`、`case /x/` 等；若不特判，会被"前一个有意义字符是单词字符"
 *  的规则误判成除法，导致真正的正则不被识别。）
 */
