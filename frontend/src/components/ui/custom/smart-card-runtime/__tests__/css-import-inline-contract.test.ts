/*
 * 批次E2b-3：插件 CSS 的相对 @import 必须内联（2026-10-21）
 *
 * E2 曾把 `@import "debugger.css"` 改写成 /api/plugins/<id>/asset/debugger.css，
 * 但实机否证：该插件 source_data 里没有 debugger.css，资产端点返回 404 text/html，
 * 浏览器仍报 strict MIME；`/st-plugins/regex/*` 也不经站点下发。
 * ⇒ 改 URL 只能改形式，目标文件不在任何可服务位置。
 *
 * E2b 改为：构建期把 st-plugins/regex/debugger.css 生成字符串模块
 * （lib/sillytavern/bundled-plugin-css.generated.ts），注入插件 CSS 时把能解析到的
 * 相对 @import 直接内联进 <style>；解析不到的相对 @import 剥掉并报 info 诊断。
 *
 * 载体纪律：帧内行为用**求值后产物** COMPAT_V2_RUNTIME_ARTIFACT 切片真跑；
 * 宿主 sanitizePluginCss 用真实导出。两处都不做「源码里含某字符串」式假断言。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/css-import-inline-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import { sanitizePluginCss } from '@/lib/plugin-system/sandbox';

const REGEX_PLUGIN_ID = 'db0c6324-2b5e-41ae-9221-43ef24b1a3ba';
const REGEX_PLUGIN = { id: REGEX_PLUGIN_ID, name: 'Regex' };

const realStyleCss = readFileSync(
  join(process.cwd(), '..', 'st-plugins', 'regex', 'style.css'),
  'utf8',
);
const realDebuggerCss = readFileSync(
  join(process.cwd(), '..', 'st-plugins', 'regex', 'debugger.css'),
  'utf8',
);

/**
 * 从求值后运行时体切出内联/重写逻辑并真跑。
 * 注入的四个 helper 是生产里同名的外部依赖：
 *   resolveStPluginAssetPathCompat / normalizeStPluginPathCompat（路径解析）
 *   stPluginAssetUrlCompat（既有 url() 重写用）
 *   reportDiagnostic（解析不到时的 info 诊断通道）
 * 其余（构建期 CSS 表、@import 内联、url() 重写）全是生产文本本尊。
 */
function makeRewrite(reportDiagnostic: (diagnostic: any) => void = () => {}) {
  const startMarker = 'const PALINK_BUNDLED_ST_PLUGIN_CSS_COMPAT = ';
  const start = SRC.indexOf(startMarker);
  expect(start, '求值后运行时体里找不到内联逻辑').toBeGreaterThan(-1);
  const endMarker = '\n  const escapeHtmlCompat = ';
  const end = SRC.indexOf(endMarker, start);
  expect(end, '找不到内联逻辑的结束锚点').toBeGreaterThan(start);
  const body = SRC.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'resolveStPluginAssetPathCompat',
    'normalizeStPluginPathCompat',
    'reportDiagnostic',
    'stPluginAssetUrlCompat',
    body + '\nreturn rewriteStPluginCssUrlsCompat;',
  );
  return factory(
    (_plugin: any, value: string) => value,
    (value: string) => value,
    reportDiagnostic,
    (pluginId: string, assetPath: string) => `/api/plugins/${pluginId}/asset/${assetPath}`,
  ) as (css: string, plugin?: any, basePath?: string) => string;
}

describe('E2b-3 帧内插件 CSS 内联（执行型，载体二）', () => {
  it('真实 st-plugins/regex/style.css：debugger.css 内容被内联，样式表里不再有 @import', () => {
    expect(realStyleCss.startsWith('@import "debugger.css";')).toBe(true);
    const out = makeRewrite()(realStyleCss, REGEX_PLUGIN, 'style.css');

    expect(out.startsWith('/* Styles for the debugger UI */')).toBe(true);
    expect(out).toContain('#regex_debugger_rules {');
    expect(out).toContain('.regex_settings .menu_button {');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('debugger.css');
    expect(out).not.toContain(`/api/plugins/${REGEX_PLUGIN_ID}/asset/debugger.css`);
  });

  it('@import url(debugger.css) / @import url("debugger.css") 两种写法同样内联', () => {
    for (const css of ['@import url(debugger.css);', '@import url("debugger.css");']) {
      const out = makeRewrite()(css, REGEX_PLUGIN, 'style.css');
      expect(out, css).toContain('#regex_debugger_rules {');
      expect(out, css).not.toContain('@import');
    }
  });

  it('带媒体查询的 @import 内联后保留条件（包进 @media）', () => {
    const out = makeRewrite()('@import url("debugger.css") screen;', REGEX_PLUGIN, 'style.css');
    expect(out.startsWith('@media screen {')).toBe(true);
    expect(out).toContain('#regex_debugger_rules {');
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });

  it('外链/data:/blob:/协议相对/根路径 @import 原样保留（不越权改写）', () => {
    const externals = [
      '@import "https://cdn.example.com/x.css";',
      '@import "//cdn.example.com/x.css";',
      '@import "/assets/x.css";',
      '@import "data:text/css,.a%7Bcolor:red%7D";',
      '@import "blob:https://x/y";',
    ];
    const rewrite = makeRewrite();
    for (const css of externals) {
      expect(rewrite(css, REGEX_PLUGIN, 'style.css'), css).toBe(css);
    }
  });

  it('解析不到的相对 @import 被剥离且报 info 诊断（不静默消音）', () => {
    const report = vi.fn();
    const rewrite = makeRewrite(report);
    const out = rewrite('@import "missing.css";\n.x { color: red; }', REGEX_PLUGIN, 'style.css');

    expect(out).toContain('/* [palink] removed unresolved @import: missing.css */');
    // 只允许注释里出现字样；不能留下真正的 @import 指令
    expect(out).not.toMatch(/@import\s*(?:url|["'])/i);
    expect(out).toContain('.x { color: red; }');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      severity: 'info',
      code: 'st_plugin_css_import_unresolved',
      apiName: 'missing.css',
    });
  });

  it('既有 url() 相对路径重写行为没被改坏（回归钉）', () => {
    const rewrite = makeRewrite();
    expect(rewrite('.x { background: url("img/a.png"); }', REGEX_PLUGIN, 'style.css'))
      .toBe(`.x { background: url("/api/plugins/${REGEX_PLUGIN_ID}/asset/img/a.png"); }`);
    expect(rewrite('.x { background: url(https://cdn.example.com/a.png); }', REGEX_PLUGIN, 'style.css'))
      .toBe('.x { background: url(https://cdn.example.com/a.png); }');
  });
});

describe('E2b-3 宿主轨 sanitizePluginCss 同步内联（执行型）', () => {
  it('传入插件名时 debugger.css 先内联再消毒，@import 不残留', () => {
    const out = sanitizePluginCss(realStyleCss, 'Regex');
    expect(out).toContain('#regex_debugger_rules {');
    expect(out).toContain('.regex_settings .menu_button {');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('debugger.css');
  });

  it('无插件名时维持旧的消毒口径：@import 剥离、不内联（安全兜底不变）', () => {
    const out = sanitizePluginCss(realStyleCss);
    expect(out).not.toContain('@import');
    expect(out).not.toContain('#regex_debugger_rules');
    expect(out).toContain('.regex_settings .menu_button {');
  });

  it('真实 debugger.css 内容与构建期生成模块一致（交给生成守卫再钉一次）', () => {
    expect(realDebuggerCss).toContain('#regex_debugger_rules');
    expect(sanitizePluginCss(realStyleCss, 'Regex')).toContain(realDebuggerCss.trim().slice(0, 60));
  });
});
