/*
 * setup 脚本可解析性守卫
 *
 * 背景（2026-09-30 实发）：`injectIntoContainer` 用模板字符串生成一段注入页面的
 * setup 脚本（负责挂 getGlobalWorldbookNames / setExtensionPrompt / injectPrompts
 * 等 ST 全局桥）。有人在该模板里直接写了正则字面量
 * `src.match(/^https:\/\/...jsdelivr\.net\/(.+)$/i)` —— 模板字符串会把 `\/` 的
 * 反斜杠吃掉，生成的脚本文本变成 `/^https://.../` 这种非法 JS。
 * 浏览器在 `appendChild(setupScript)` 那一刻同步抛
 * `SyntaxError: Failed to execute 'appendChild' on 'Node': Unexpected token ']'`，
 * 整批插件注入随之中断：ST 全局一个没挂、卡片自带扩展（含 CG 图库悬浮按钮）一个没注，
 * 用户侧表现为「角色面板和正文 UI 的框子都在、里面全空」。
 *
 * 本文件钉住两件事：
 *   1. 生成的 setup 脚本文本**必须能被解析**（真正的回归守卫）。
 *   2. 守卫本身不是恒真——用一个已知坏样本自证 `new Function` 抓得住这类错误。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SillyTavernPluginRuntime } from '../sillyTavernPluginRuntime';

// 桥接层会自发请求（如刷新世界书名），jsdom 下相对 URL 无法解析会刷一堆噪声。
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => [],
      text: async () => '[]',
      clone() {
        return this;
      },
    })),
  );
});

const SETUP_ID = '__palink_runtime_setup__';

function getSetupScriptText(container: HTMLElement): string | null {
  const el = Array.from(container.querySelectorAll('script[data-palink-st-plugin-id]')).find(
    (n) => n.getAttribute('data-palink-st-plugin-id') === SETUP_ID,
  );
  return el && typeof el.textContent === 'string' ? el.textContent : null;
}

function inject(): { container: HTMLElement; text: string | null } {
  const runtime = new SillyTavernPluginRuntime();
  (runtime as any).config = { plugins: [] } as any;
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime.injectIntoContainer(container);
  return { container, text: getSetupScriptText(container) };
}

describe('setup 脚本可解析性（模板字符串反斜杠守卫）', () => {
  it('setup 脚本确实被注入容器', () => {
    const { text } = inject();
    expect(text, 'setup 脚本没被注入，守卫失去意义').toBeTruthy();
  });

  it('生成的 setup 脚本文本必须能通过 JS 解析', () => {
    const { text } = inject();
    expect(text).toBeTruthy();
    // 这一句就是回归本体：模板里再写丢反斜杠的正则字面量 → 这里直接红。
    expect(() => new Function(text as string)).not.toThrow();
  });

  it('图片代理钩子仍在脚本里（防止改写时被误删）', () => {
    const { text } = inject();
    expect(text).toContain('data-palink-proxy');
    expect(text).toContain('/api/image-proxy?url=');
  });

  it('守卫自证：丢反斜杠的写法确实会被解析检查抓住', () => {
    // 已知坏样本 = 事故当时生成的文本（模板吞掉反斜杠后的形态），必须抛。
    const broken = "var src=''; var mm = src.match(/^https://[a-z0-9.-]*jsdelivr.net/(.+)$/i);";
    expect(() => new Function(broken)).toThrow(SyntaxError);
  });
});
