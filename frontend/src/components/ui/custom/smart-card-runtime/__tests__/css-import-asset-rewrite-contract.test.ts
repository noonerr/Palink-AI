/*
 * 批次E2-3：帧内插件 CSS 的 @import 必须重写到可解析的插件资产 URL（2026-10-21）
 *
 * 真机报错（REPORT_控制台报错九类定性_2026-10-21 §B10）：
 *   Refused to apply style from 'http://localhost:16000/characters/debugger.css'
 *   because its MIME type ('text/html') is not a supported stylesheet MIME type
 * 每轮 14 条。源头：st-plugins/regex/style.css:1 `@import "debugger.css";`。
 * 帧内注入只重写 url()、不处理 @import（part-01.ts rewriteStPluginCssUrlsCompat），
 * 相对路径按帧文档 base 解析成 /characters/debugger.css → nginx SPA fallback 返回
 * index.html → strict MIME 拒绝。批次Q1 放开 same-origin 后这条潜伏引用才开始发请求。
 *
 * 修法：与 url() 同源改写 —— 相对 @import 指向 /api/plugins/<id>/asset/<path>
 * （后端 resources.assets 已收 debugger.css，返回 text/css）。外链/data:/blob:/
 * 根路径保持原样，不越权改写。
 *
 * 载体纪律：本文件用**求值后产物** COMPAT_V2_RUNTIME_ARTIFACT，从中切出
 * rewriteStPluginCssUrlsCompat 真跑（不是未求值源码文本），故不进
 * runtime-source-carrier-fidelity.test.ts 的混合载体白名单。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/css-import-asset-rewrite-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';

const REGEX_PLUGIN_ID = 'db0c6324-2b5e-41ae-9221-43ef24b1a3ba';
const REGEX_PLUGIN = { id: REGEX_PLUGIN_ID };
const EXPECTED_DEBUGGER_URL = `/api/plugins/${REGEX_PLUGIN_ID}/asset/debugger.css`;

/**
 * 从求值后运行时体切出 rewriteStPluginCssUrlsCompat 并真跑。
 * 只替换两个资源解析 helper（生产里分别拼资产 URL / 在 plugin.resources.assets 里查路径），
 * 其余全是生产文本本尊。
 */
function makeRewrite(): (css: string, plugin?: any, basePath?: string) => string {
  const startMarker = 'const rewriteStPluginCssUrlsCompat = ';
  const start = SRC.indexOf(startMarker);
  expect(start, '求值后运行时体里找不到 rewriteStPluginCssUrlsCompat').toBeGreaterThan(-1);
  const endMarker = '\n  const escapeHtmlCompat = ';
  const end = SRC.indexOf(endMarker, start);
  expect(end, '找不到 rewriteStPluginCssUrlsCompat 的结束锚点').toBeGreaterThan(start);
  const body = SRC.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'stPluginAssetUrlCompat',
    'resolveStPluginAssetPathCompat',
    body + '\nreturn rewriteStPluginCssUrlsCompat;',
  );
  return factory(
    (pluginId: string, assetPath: string) => `/api/plugins/${pluginId}/asset/${assetPath}`,
    (_plugin: any, value: string) => value,
  );
}

describe('E2-3 帧内 @import 重写（执行型，载体二）', () => {
  const rewrite = makeRewrite();

  it('真实 st-plugins/regex/style.css：首行 @import "debugger.css" 改成绝对资产 URL', () => {
    const realCss = readFileSync(
      join(process.cwd(), '..', 'st-plugins', 'regex', 'style.css'),
      'utf8',
    );
    expect(realCss.startsWith('@import "debugger.css";')).toBe(true);

    const out = rewrite(realCss, REGEX_PLUGIN, 'style.css');
    expect(out.startsWith(`@import url("${EXPECTED_DEBUGGER_URL}");`)).toBe(true);
    expect(out).not.toContain('@import "debugger.css"');
    // 不得留下任何相对 debugger.css 引用（quoted / unquoted / url() 三种写法）
    expect(out).not.toMatch(/@import\s+url\(\s*["']?(?:\.{0,2}\/)?debugger\.css/);
    // 样式主体原样保留
    expect(out).toContain('.regex_settings .menu_button {');
  });

  it('@import url(debugger.css) 无引号写法同样重写', () => {
    expect(rewrite('@import url(debugger.css);', REGEX_PLUGIN, 'style.css'))
      .toBe(`@import url("${EXPECTED_DEBUGGER_URL}");`);
  });

  it('@import url("debugger.css") 带引号写法同样重写，媒体查询后缀保留', () => {
    expect(rewrite('@import url("debugger.css") screen;', REGEX_PLUGIN, 'style.css'))
      .toBe(`@import url("${EXPECTED_DEBUGGER_URL}") screen;`);
  });

  it('外部/data:/blob:/协议相对/根路径 @import 一律不改写（不越权）', () => {
    const externals = [
      '@import "https://cdn.example.com/x.css";',
      '@import "//cdn.example.com/x.css";',
      '@import "/assets/x.css";',
      '@import "data:text/css,.a%7Bcolor:red%7D";',
      '@import "blob:https://x/y";',
    ];
    for (const css of externals) {
      expect(rewrite(css, REGEX_PLUGIN, 'style.css'), css).toBe(css);
    }
  });

  it('既有 url() 相对路径重写行为没被改坏（回归钉）', () => {
    expect(rewrite('.x { background: url("img/a.png"); }', REGEX_PLUGIN, 'style.css'))
      .toBe(`.x { background: url("/api/plugins/${REGEX_PLUGIN_ID}/asset/img/a.png"); }`);
    expect(rewrite('.x { background: url(https://cdn.example.com/a.png); }', REGEX_PLUGIN, 'style.css'))
      .toBe('.x { background: url(https://cdn.example.com/a.png); }');
  });

  it('URL 可解析性：重写结果指向插件资产端点，且仓内 debugger.css 真实存在', () => {
    // 端点形状 = stPluginAssetUrlCompat 对普通资产的同一形状（见上一条回归钉）
    expect(EXPECTED_DEBUGGER_URL).toMatch(
      new RegExp(`^/api/plugins/${REGEX_PLUGIN_ID}/asset/debugger\\.css$`),
    );
    const debuggerCss = readFileSync(
      join(process.cwd(), '..', 'st-plugins', 'regex', 'debugger.css'),
      'utf8',
    );
    expect(debuggerCss).toContain('#regex_debugger_rules');
  });
});
