/*
 * 批次E2b-3 守卫：构建期生成的插件 CSS 必须与仓内真实文件逐字节一致（2026-10-21）
 *
 * bundled-plugin-css.generated.ts 是 st-plugins/regex/debugger.css 的字符串副本，
 * 用来在注入插件 CSS 时内联 @import（该文件不在后端插件 source_data 里，资产端点 404）。
 * 生成模块而不是 ?raw 的原因见 bundled-plugin-css.ts 文件头：本模块会被
 * vite.config.ts 的配置期导入链解析，那条链早于 Vite 插件生效，`?raw` 不可用。
 *
 * 因此这里必须守住「副本 = 真实文件」：改了 st-plugins/regex/debugger.css 却忘了
 * 重新生成，本测试立刻红，而不是让线上悄悄用旧样式。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/bundled-plugin-css.generated.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGEX_DEBUGGER_CSS } from '../bundled-plugin-css.generated';
import {
  BUNDLED_ST_PLUGIN_CSS,
  getBundledStPluginCss,
  resolveBundledCssImportPath,
  inlineBundledStPluginCssImports,
} from '../bundled-plugin-css';

const realDebuggerCss = readFileSync(
  join(process.cwd(), '..', 'st-plugins', 'regex', 'debugger.css'),
  'utf8',
);

describe('E2b-3 生成模块与源文件一致性', () => {
  it('REGEX_DEBUGGER_CSS 与 st-plugins/regex/debugger.css 逐字节相等', () => {
    expect(REGEX_DEBUGGER_CSS).toBe(realDebuggerCss);
    expect(BUNDLED_ST_PLUGIN_CSS['regex/debugger.css']).toBe(realDebuggerCss);
  });

  it('按插件名/manifest 名/命名空间都能查到同一份内容', () => {
    expect(getBundledStPluginCss('Regex', 'debugger.css')).toBe(realDebuggerCss);
    expect(getBundledStPluginCss(['other', 'Regex'], './debugger.css')).toBe(realDebuggerCss);
    expect(getBundledStPluginCss('regex', 'debugger.css')).toBe(realDebuggerCss);
    expect(getBundledStPluginCss('Regex', 'style.css')).toBeUndefined();
    expect(getBundledStPluginCss('Other', 'debugger.css')).toBeUndefined();
  });

  it('相对路径解析：./、子目录、../ 与根路径/外链区分正确', () => {
    expect(resolveBundledCssImportPath('style.css', 'debugger.css')).toBe('debugger.css');
    expect(resolveBundledCssImportPath('css/style.css', './debugger.css')).toBe('css/debugger.css');
    expect(resolveBundledCssImportPath('css/style.css', '../debugger.css')).toBe('debugger.css');
    expect(resolveBundledCssImportPath('style.css', '/assets/x.css')).toBe('');
    expect(resolveBundledCssImportPath('style.css', 'https://x/y.css')).toBe('');
  });

  it('宿主 helper 内联真实 style.css 后，@import 消失且 debugger 规则在', () => {
    const styleCss = readFileSync(join(process.cwd(), '..', 'st-plugins', 'regex', 'style.css'), 'utf8');
    const out = inlineBundledStPluginCssImports(styleCss, 'Regex', 'style.css');
    expect(out).toContain('#regex_debugger_rules {');
    expect(out).not.toContain('@import');
    expect(out).toContain('.regex_settings .menu_button {');
  });
});
