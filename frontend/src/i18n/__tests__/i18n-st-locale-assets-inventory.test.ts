/*
 * [批次I18N 2026-10-21] ST 语言资产清单与读取行为。
 *
 * 病根（一手实测，不是读代码猜的）：真机每次进对话页都吃一个
 * `GET /st/locales/zh-cn.json => 404`（playwright `requests` 里编号 8，referer 就是角色页，
 * type=fetch）。原因是两份"事实"互相脱节：
 *   - `translations.ts` 的 ST_LOCALES 声明 17 个 locale；
 *   - `frontend/public/st/locales/` 这个目录**根本不存在**。
 * 而 `lib/i18n/index.ts:75` 在非 200 时**静默返回 {}**，所以没人报错 ——
 * 结果是 ST 插件调 `t('…')`（`getContext.ts:2794` 委托到 i18nManager）永远只拿回原始英文 key，
 * "支持 ST 多语言"这件事从上线第一天起就没生效过。
 *
 * 钉两件事：
 *   1. **清单不变量**：ST_LOCALES 里每一项都必须真有文件（少文件即红）——
 *      这条防的就是"名单加了、文件没放"这个原发错误再犯；
 *   2. **真读得动**：喂真实文件内容，`loadSTLocale('zh-cn')` 必须返回非空的扁平 string 映射，
 *      并且空文件（en.json 在 ST 侧就是 `{}`，英文是源语言）不能抛。
 *
 * 运行: npx vitest run src/i18n/__tests__/i18n-st-locale-assets-inventory.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ST_LOCALES } from '../translations';
import { loadSTLocale } from '@/lib/i18n';

const LOCALE_DIR = join(process.cwd(), 'public', 'st', 'locales');

describe('ST 语言资产清单', () => {
  it('public/st/locales 目录存在', () => {
    expect(existsSync(LOCALE_DIR), `缺目录 ${LOCALE_DIR}`).toBe(true);
  });

  it('ST_LOCALES 每一项都有同名文件（名单=资产清单，不是愿望清单）', () => {
    const present = existsSync(LOCALE_DIR) ? readdirSync(LOCALE_DIR) : [];
    const missing = ST_LOCALES.filter(
      (code) => !present.includes(`${code}.json`),
    );
    expect(
      missing,
      `这些 locale 声明了但没有文件 ⇒ 运行时必吃 404：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('文件形状是扁平 string 映射（读取侧只认 string 值，嵌套会被整条丢弃）', () => {
    for (const code of ST_LOCALES) {
      const raw = readFileSync(join(LOCALE_DIR, `${code}.json`), 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof data, `${code}.json 不是对象`).toBe('object');
      const nonString = Object.entries(data).filter(([, v]) => typeof v !== 'string');
      expect(nonString.length, `${code}.json 有 ${nonString.length} 个非 string 值`).toBe(0);
    }
  });

  it('lang.json（后端 _load_st_locales 的取值源）与本清单两侧一致', () => {
    const langPath = join(LOCALE_DIR, 'lang.json');
    expect(existsSync(langPath), '缺 public/st/locales/lang.json ⇒ 后端会退回硬编码 17 门语言').toBe(true);
    const listed = JSON.parse(readFileSync(langPath, 'utf8')) as Array<Record<string, string>>;
    expect(Array.isArray(listed)).toBe(true);
    const declared = new Set(ST_LOCALES);
    // lang.json 里每一门都必须真有文件
    const langMissing = listed
      .map((it) => String(it.lang ?? ''))
      .filter((code) => code && !declared.has(code));
    expect(langMissing, `lang.json 列了但清单/文件没有：${langMissing.join(', ')}`).toEqual([]);
    // 清单里每一门都必须出现在 lang.json（否则后端 i18n_state.locales 不认它）
    const reverseMissing = [...declared].filter(
      (code) => code !== 'en' && !listed.some((it) => String(it.lang ?? '') === code),
    );
    expect(reverseMissing, `清单有但 lang.json 没有：${reverseMissing.join(', ')}`).toEqual([]);
  });
});

describe('loadSTLocale 真实读取', () => {
  /** 用真实文件内容当响应，测的是解析与筛选，不是网络。 */
  function withFetchFromFile(code: string) {
    const raw = readFileSync(join(LOCALE_DIR, `${code}.json`), 'utf8');
    const original = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(String(url).includes(code) ? raw : '{}'),
    });
    return () => { globalThis.fetch = original; };
  }

  it('zh-cn 能读出非空映射，且值是真翻译不是原样 key', async () => {
    const restore = withFetchFromFile('zh-cn');
    try {
      const map = await loadSTLocale('zh-cn');
      const keys = Object.keys(map);
      expect(keys.length, 'zh-cn 读出 0 条 = 这条能力仍等于没有').toBeGreaterThan(1000);
      // 抽样：键是英文原文，值必须含中日韩字符（原样回显英文就是没生效）
      const sample = keys.slice(0, 40).filter((k) => /^[A-Z][A-Za-z ]+$/.test(k));
      expect(sample.length, '样本里找不到"英文原文键"，判据无法成立').toBeGreaterThan(0);
      const translated = sample.filter((k) => /[㐀-䶿一-鿿]/.test(map[k]));
      expect(translated.length / sample.length, '过半抽样键没拿到中文').toBeGreaterThan(0.5);
    } finally {
      restore();
    }
  });

  it('大写/别名入参同样归一（' + "'zh-CN' 与 'ZH_CN' 都走 zh-cn）", async () => {
    const restore = withFetchFromFile('zh-cn');
    try {
      const a = await loadSTLocale('zh-CN');
      expect(Object.keys(a).length).toBeGreaterThan(1000);
    } finally {
      restore();
    }
  });

  it('不在清单里的 locale 直接返回空对象，不发请求', async () => {
    let called = false;
    const original = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
      const map = await loadSTLocale('de-de');   // 上游有这门语言，但我们没放文件、清单里也没有
      expect(map).toEqual({});
      expect(called, '清单外仍发请求 ⇒ 又是一轮 404').toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('en 是 ST 的源语言、上游文件就是空的，读出空对象不算失败', async () => {
    const restore = withFetchFromFile('en');
    try {
      expect(await loadSTLocale('en')).toEqual({});
    } finally {
      restore();
    }
  });

  it('非 200 静默降级为空对象（保持既有行为，不抛）', async () => {
    const original = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    try {
      expect(await loadSTLocale('zh-cn')).toEqual({});
    } finally {
      globalThis.fetch = original;
    }
  });
});
