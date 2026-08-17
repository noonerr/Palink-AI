/**
 * i18n - 国际化框架
 * 基于 SillyTavern i18n.js
 */

import { useState, useCallback, useEffect } from 'react';
import { TRANSLATIONS, ST_LOCALES } from '@/i18n/translations';

// ============================================================
// 类型定义
// ============================================================

export type Locale = 'zh-CN' | 'en-US' | string;

export interface I18nConfig {
  defaultLocale: Locale;
  fallbackLocale: Locale;
  storageKey: string;
}

export interface AddLocaleDataOptions {
  /** 合并模式：true 时不覆盖已存在的 key（Palink 内置优先，ST 仅补充缺失 key） */
  merge?: boolean;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: I18nConfig = {
  defaultLocale: 'zh-CN',
  fallbackLocale: 'en-US',
  storageKey: 'palink_locale',
};

// ============================================================
// Locale 规范化
// ============================================================

/**
 * 将各种 locale 标识符规范化为 ST locale 标识
 * - 'zh-CN' / 'zh' -> 'zh-cn'（映射到内置 zh 翻译 + ST zh-cn）
 * - 'en-US' / 'en' -> 'en'（映射到内置 en 翻译）
 * - ST locale（如 'ja-jp'）保持小写原样
 */
const LOCALE_ALIASES: Record<string, string> = {
  'zh': 'zh-cn',
  'zh-cn': 'zh-cn',
  'zh-tw': 'zh-tw',
  'en': 'en',
  'en-us': 'en',
};

function normalizeLocale(locale: string): string {
  const lower = locale.toLowerCase();
  return LOCALE_ALIASES[lower] ?? lower;
}

// ============================================================
// ST locale 异步加载
// ============================================================

/**
 * 异步加载 ST locale JSON 文件
 * 加载失败时静默降级，返回空对象（不抛出错误）
 * @param locale ST locale 标识（如 'zh-cn', 'ja-jp'）
 */
export async function loadSTLocale(locale: string): Promise<Record<string, string>> {
  try {
    const normalized = normalizeLocale(locale);
    if (!ST_LOCALES.includes(normalized)) {
      return {};
    }
    const response = await fetch(`/st/locales/${normalized}.json`);
    if (!response.ok) {
      return {};
    }
    const data = await response.json();
    if (!data || typeof data !== 'object') {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    // 静默降级，不抛出错误
    return {};
  }
}

// ============================================================
// I18nManager 类
// ============================================================

export class I18nManager {
  private locale: Locale;
  private translations: Map<Locale, Map<string, string>> = new Map();
  private config: I18nConfig;
  private loadedSTLocales: Set<string> = new Set();

  constructor(config?: Partial<I18nConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.defaultLocale = normalizeLocale(this.config.defaultLocale);
    this.config.fallbackLocale = normalizeLocale(this.config.fallbackLocale);

    // 从本地存储加载语言设置
    const savedLocale = localStorage.getItem(this.config.storageKey);
    this.locale = normalizeLocale(savedLocale || this.config.defaultLocale);

    // 优先加载内置的 zh / en 翻译
    this.loadBuiltinTranslations();

    // 启动时异步加载当前 locale 的 ST 数据（不阻塞构造）
    this.loadAndMergeSTLocale(this.locale).catch(() => {
      // 静默降级
    });
  }

  /**
   * 加载内置 zh / en 翻译
   * - 'zh' 内置翻译 -> 'zh-cn' locale
   * - 'en' 内置翻译 -> 'en' locale
   */
  private loadBuiltinTranslations(): void {
    this.addLocaleData('zh-cn', TRANSLATIONS.zh);
    this.addLocaleData('en', TRANSLATIONS.en);
  }

  /**
   * 获取当前语言
   */
  getLocale(): Locale {
    return this.locale;
  }

  /**
   * 设置语言（同步版本）
   * 注意：同步版本不会触发 ST locale 异步加载，如需加载 ST 数据请使用 setLocaleAsync
   */
  setLocale(locale: Locale): void {
    this.locale = normalizeLocale(locale);
    localStorage.setItem(this.config.storageKey, this.locale);
  }

  /**
   * 设置语言（异步版本）
   * 切换到非内置 locale 时自动加载对应的 ST locale 数据
   * 加载失败时静默降级到 fallback
   */
  async setLocaleAsync(locale: Locale): Promise<void> {
    const normalized = normalizeLocale(locale);
    await this.loadAndMergeSTLocale(normalized);
    this.locale = normalized;
    localStorage.setItem(this.config.storageKey, normalized);
  }

  /**
   * 异步加载并合并 ST locale 数据到 translations
   * - ST key 不覆盖 Palink 内置 key（merge 模式，Palink 优先）
   * - 已加载的 locale 不会重复加载
   * - 加载失败时静默降级
   */
  async loadAndMergeSTLocale(locale: string): Promise<void> {
    const normalized = normalizeLocale(locale);
    if (!ST_LOCALES.includes(normalized)) {
      return;
    }
    if (this.loadedSTLocales.has(normalized)) {
      return;
    }
    this.loadedSTLocales.add(normalized);

    const data = await loadSTLocale(normalized);
    // 合并 ST locale 数据（merge=true，不覆盖已有 Palink key）
    this.addLocaleData(normalized, data, { merge: true });
  }

  /**
   * 初始化：预加载当前 locale 与 fallback locale 的 ST 数据
   * 可在应用启动时调用以确保 ST 翻译就绪
   */
  async init(): Promise<void> {
    await Promise.all([
      this.loadAndMergeSTLocale(this.locale),
      this.loadAndMergeSTLocale(this.config.fallbackLocale),
    ]);
  }

  /**
   * 添加翻译数据
   * @param options.merge 合并模式：true 时仅补充缺失的 key，不覆盖已有 key（Palink 优先）
   */
  addLocaleData(locale: Locale, data: Record<string, string>, options?: AddLocaleDataOptions): void {
    const normalized = normalizeLocale(locale);
    if (!this.translations.has(normalized)) {
      this.translations.set(normalized, new Map());
    }

    const localeMap = this.translations.get(normalized)!;
    for (const [key, value] of Object.entries(data)) {
      if (options?.merge && localeMap.has(key)) {
        // merge 模式：Palink 内置 key 优先，不覆盖
        continue;
      }
      localeMap.set(key, value);
    }
  }

  /**
   * 批量添加翻译数据
   * @param options.merge 合并模式：true 时仅补充缺失的 key，不覆盖已有 key
   */
  addLocaleDatas(datas: Record<Locale, Record<string, string>>, options?: AddLocaleDataOptions): void {
    for (const [locale, data] of Object.entries(datas)) {
      this.addLocaleData(locale, data, options);
    }
  }

  /**
   * 翻译函数
   */
  t(key: string, ...values: any[]): string {
    // 获取当前语言的翻译
    let translation = this.getTranslation(this.locale, key);

    // 如果没有找到，使用回退语言
    if (!translation && this.locale !== this.config.fallbackLocale) {
      translation = this.getTranslation(this.config.fallbackLocale, key);
    }

    // 如果还是没有，返回key
    if (!translation) {
      return key;
    }

    // 替换占位符 {0}, {1}, ...
    if (values.length > 0) {
      return translation.replace(/\{(\d+)\}/g, (match, index) => {
        const idx = parseInt(index, 10);
        return idx < values.length ? String(values[idx]) : match;
      });
    }

    return translation;
  }

  /**
   * 获取翻译
   */
  private getTranslation(locale: Locale, key: string): string | undefined {
    const normalized = normalizeLocale(locale);
    const localeMap = this.translations.get(normalized);
    return localeMap?.get(key);
  }

  /**
   * 检查翻译是否存在
   */
  hasTranslation(key: string, locale?: Locale): boolean {
    const targetLocale = normalizeLocale(locale || this.locale);
    const localeMap = this.translations.get(targetLocale);
    return localeMap?.has(key) ?? false;
  }

  /**
   * 获取所有支持的语言（已加载的）
   */
  getSupportedLocales(): Locale[] {
    return Array.from(this.translations.keys());
  }

  /**
   * 获取所有可用的 locale 列表（包括尚未加载的 ST locale）
   */
  get availableLocales(): string[] {
    const loaded = Array.from(this.translations.keys());
    return Array.from(new Set([...ST_LOCALES, ...loaded]));
  }

  /**
   * 获取语言的翻译数量
   */
  getTranslationCount(locale: Locale): number {
    const normalized = normalizeLocale(locale);
    return this.translations.get(normalized)?.size ?? 0;
  }
}

// ============================================================
// 全局实例
// ============================================================

export const i18nManager = new I18nManager();

// ============================================================
// 便捷函数
// ============================================================

export function t(key: string, ...values: any[]): string {
  return i18nManager.t(key, ...values);
}

export function translate(key: string, ...values: any[]): string {
  return i18nManager.t(key, ...values);
}

export function getCurrentLocale(): Locale {
  return i18nManager.getLocale();
}

export function setLocale(locale: Locale): void {
  i18nManager.setLocale(locale);
}

export async function setLocaleAsync(locale: Locale): Promise<void> {
  await i18nManager.setLocaleAsync(locale);
}

export function addLocaleData(locale: Locale, data: Record<string, string>, options?: AddLocaleDataOptions): void {
  i18nManager.addLocaleData(locale, data, options);
}

export function getAvailableLocales(): string[] {
  return i18nManager.availableLocales;
}

// ============================================================
// React Hook
// ============================================================

export function useTranslation() {
  const [locale, setLocaleState] = useState(i18nManager.getLocale());

  const handleSetLocale = useCallback((newLocale: Locale) => {
    i18nManager.setLocale(newLocale);
    setLocaleState(newLocale);
  }, []);

  const handleSetLocaleAsync = useCallback(async (newLocale: Locale) => {
    await i18nManager.setLocaleAsync(newLocale);
    setLocaleState(i18nManager.getLocale());
  }, []);

  const translateFn = useCallback((key: string, ...values: any[]) => {
    return i18nManager.t(key, ...values);
  }, [locale]);

  return {
    t: translateFn,
    locale,
    setLocale: handleSetLocale,
    setLocaleAsync: handleSetLocaleAsync,
    supportedLocales: i18nManager.getSupportedLocales(),
    availableLocales: i18nManager.availableLocales,
  };
}
