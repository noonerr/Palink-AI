/**
 * 构建期捆绑的 ST 插件 CSS 资源（批次E2b，2026-10-21）
 *
 * 要解决的问题：st-plugins/regex/style.css 首行 `@import "debugger.css";`，
 * 但 debugger.css 不在插件 source_data 的 resources 里（后端资产端点 404 text/html），
 * `/st-plugins/regex/*` 也不经站点下发。把相对路径改写成绝对 URL 只能改形式，
 * 目标文件不存在 ⇒ 浏览器仍报 MIME 拒绝（E2 方案已被实机否证）。
 *
 * 做法：把仓内真实文件生成成 TS 字符串模块（bundled-plugin-css.generated.ts），
 * 在注入插件 CSS 时把能解析到的相对 @import **内联**进 <style>。
 * 生成模块而不是 `?raw` 的原因：本模块会被 vite.config.ts 的配置期导入链
 * （vite-plugins/smart-card-runtime-asset.ts → SillyTavernCompatRuntime）吃到，
 * 那条链由 esbuild 在 Vite 插件生效前解析，`?raw` 查询串会解析失败。
 *
 * 同步纪律：st-plugins/regex/debugger.css 改动后必须重新生成
 * bundled-plugin-css.generated.ts；守卫测试 bundled-plugin-css.generated.test.ts
 * 逐字节比对两者，漂移即红。
 */

import { REGEX_DEBUGGER_CSS } from './bundled-plugin-css.generated';

/**
 * key = 插件目录名（小写）+ '/' + 插件内相对路径（小写无关，匹配时统一小写）。
 * 目前只有 regex 插件的 debugger.css 属于「仓内有、插件资产里没有」这一类。
 */
export const BUNDLED_ST_PLUGIN_CSS: Readonly<Record<string, string>> = {
  'regex/debugger.css': REGEX_DEBUGGER_CSS,
};

/** 把插件标识归一成目录名：'Regex' → 'regex'，'Regex Plugin' → 'regex-plugin'。 */
function normalizePluginFolder(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 归一插件内相对路径：去 ./、折叠 ..、反斜杠转正斜杠。 */
export function normalizeBundledCssAssetPath(value: string): string {
  const parts: string[] = [];
  String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .forEach((segment) => {
      if (!segment || segment === '.') return;
      if (segment === '..') {
        parts.pop();
        return;
      }
      parts.push(segment);
    });
  return parts.join('/');
}

/** 以 basePath（如 'style.css'）为基准解析 @import 的相对路径。绝对/外链返回空串。 */
export function resolveBundledCssImportPath(basePath: string, rawValue: string): string {
  const value = String(rawValue || '').trim();
  if (!value || /^(?:data:|blob:|https?:|\/\/|\/|#)/i.test(value)) return '';
  const baseDir = String(basePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .slice(0, -1)
    .join('/');
  if (value.startsWith('.')) {
    return normalizeBundledCssAssetPath((baseDir ? baseDir + '/' : '') + value);
  }
  return normalizeBundledCssAssetPath(value);
}

/** 在构建期资源表里查内容；pluginHints 可传插件名/manifest 名/命名空间。 */
export function getBundledStPluginCss(
  pluginHints: string | Array<string | null | undefined>,
  assetPath: string,
): string | undefined {
  const hints = Array.isArray(pluginHints) ? pluginHints : [pluginHints];
  const normalizedPath = normalizeBundledCssAssetPath(assetPath).toLowerCase();
  if (!normalizedPath) return undefined;
  for (const hint of hints) {
    const folder = normalizePluginFolder(String(hint || ''));
    if (!folder) continue;
    const content = BUNDLED_ST_PLUGIN_CSS[`${folder}/${normalizedPath}`];
    if (typeof content === 'string') return content;
  }
  return undefined;
}

/** 保留 @import 的 media / layer 条件语义（目前实际消费方只用无后缀形式）。 */
function wrapInlinedCss(content: string, conditions: string): string {
  const tail = String(conditions || '').trim().replace(/;$/, '').trim();
  if (!tail) return content;
  const layerMatch = tail.match(/^layer\(\s*([^)]*)\s*\)$/i);
  if (layerMatch) {
    const layerName = String(layerMatch[1] || '').trim();
    return `@layer${layerName ? ' ' + layerName : ''} {\n${content}\n}`;
  }
  return `@media ${tail} {\n${content}\n}`;
}

/**
 * 把能解析到构建期资源的相对 @import 内联成 CSS 文本。
 * 外链 / data: / blob: / 根路径 @import 原样保留；解析不到的相对 @import 也原样保留，
 * 由调用方决定「剥离 + 诊断」还是「继续走既有消毒」。
 */
export function inlineBundledStPluginCssImports(
  css: string,
  pluginHints: string | Array<string | null | undefined>,
  basePath = '',
): string {
  return String(css || '')
    .replace(
      /@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)\s*([^;]*);?/gi,
      (match, _quote, rawValue, conditions) => {
        const resolved = resolveBundledCssImportPath(basePath, rawValue);
        if (!resolved) return match;
        const content = getBundledStPluginCss(pluginHints, resolved);
        return content === undefined ? match : wrapInlinedCss(content, conditions);
      },
    )
    .replace(
      /@import\s+(['"])([^'"]+)\1\s*([^;]*);?/gi,
      (match, _quote, rawValue, conditions) => {
        const resolved = resolveBundledCssImportPath(basePath, rawValue);
        if (!resolved) return match;
        const content = getBundledStPluginCss(pluginHints, resolved);
        return content === undefined ? match : wrapInlinedCss(content, conditions);
      },
    );
}
