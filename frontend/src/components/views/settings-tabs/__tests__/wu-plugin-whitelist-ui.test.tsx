/*
 * [批次WU 2026-10-21] 插件网络白名单「设置页 → 运行时」贯通测试。
 *
 * 本批唯一新增物是 UI（机制早就在跑），所以测的必须是**这条链**而不是模块自洽：
 * 用户在插件页敲一个主机名 ⇒ localStorage 里的值必须是沙箱认的那种格式
 * ⇒ 沙箱真正的判定函数随即放行。三段里任何一段断开都是静默失效
 * （历史上"接上了但读不到"那批的同款事故），单测解析函数抓不到"UI 写错格式"。
 *
 * 钉住的语义：
 *   1. 这一栏在页面上**可达**（不需要手工敲 localStorage，也不用管理员额外开关）；
 *   2. 默认 CDN 五项只读展示、用户项可增删；空态有一句话解释；
 *   3. 点"添加"落盘的是逗号分隔裸主机名，且 `isUrlAllowedByPluginWhitelist` 立刻放行；
 *   4. 粘贴完整 URL / host:port 也能用（会被收成裸主机名）；非法输入报错且不写盘；
 *   5. 删到空 ⇒ 键被删除（回到默认态）；
 *   6. 本批之前手工敲的值（带空格、大小写混杂）仍显示为可删的条目。
 *
 * 运行: npx vitest run src/components/views/settings-tabs/__tests__/wu-plugin-whitelist-ui.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AdminPluginsTab } from '../AdminPluginsTab';
import { api } from '@/services/api';
import { PLUGIN_FETCH_WHITELIST_STORAGE_KEY } from '@/lib/plugin-system/plugin-fetch-whitelist';
import { isUrlAllowedByPluginWhitelist } from '@/lib/plugin-system/sandbox';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), raw: vi.fn() },
  invalidateCache: vi.fn(),
  isAbortError: () => false,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGet = vi.mocked(api.get);

const CROSS_PORT = 43999;
const rawStored = () => localStorage.getItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.removeItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedGet.mockReset();
  mockedGet.mockResolvedValue([] as any);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
  vi.clearAllMocks();
});

async function renderTab() {
  await act(async () => {
    root.render(<AdminPluginsTab />);
  });
  await act(async () => {});
}

function q(testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`未找到 data-testid=${testid}`);
  return el as HTMLElement;
}

function maybe(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function typeHost(value: string) {
  await act(async () => {
    setInput(q('plugin-whitelist-input') as HTMLInputElement, value);
  });
}

async function clickAdd() {
  await act(async () => {
    q('plugin-whitelist-add').click();
  });
}

describe('AdminPluginsTab 插件网络白名单', () => {
  it('入口可达：默认 CDN 五项只读展示，用户项初始为空并有说明', async () => {
    await renderTab();

    const text = container.textContent || '';
    expect(text).toContain('插件网络白名单');
    expect(text).toContain('cdn.jsdelivr.net');
    expect(text).toContain('cdnjs.cloudflare.com');
    expect(maybe('plugin-whitelist-empty')).not.toBe(null);
    expect(text).toContain('当前没有自定义放行主机');
    // 默认项不写进存储（用户删不掉，也不该被误当成"用户加过的"）
    expect(rawStored()).toBe(null);
  });

  it('添加 ⇒ 落盘逗号格式 ⇒ 沙箱判定立刻放行（这条是本批的全部意义）', async () => {
    await renderTab();
    await typeHost('localhost');
    await clickAdd();

    expect(rawStored()).toBe('localhost');
    expect(maybe('plugin-whitelist-chip-localhost')).not.toBe(null);
    expect(maybe('plugin-whitelist-empty')).toBe(null);
    // 用与页面不同端口的 URL：确保放行来自"主机名命中白名单"，不是同源兜底
    expect(isUrlAllowedByPluginWhitelist(`http://localhost:${CROSS_PORT}/api/tags`)).toBe(true);
    // 输入框已清空，避免连点把同一条再敲一遍
    expect((q('plugin-whitelist-input') as HTMLInputElement).value).toBe('');
  });

  it('粘贴完整 URL 或 host:port 也能用：收裸主机名后按主机名放行', async () => {
    await renderTab();
    await typeHost('http://127.0.0.1:11434/v1/chat/completions');
    await clickAdd();

    expect(rawStored()).toBe('127.0.0.1');
    expect(isUrlAllowedByPluginWhitelist('http://127.0.0.1:11434/api/tags')).toBe(true);
    expect(isUrlAllowedByPluginWhitelist('http://127.0.0.1:7860/sdapi/v1/txt2img')).toBe(true);
    // 只放开这一台：别的主机仍被拦
    expect(isUrlAllowedByPluginWhitelist('http://192.168.1.90:11434/api/tags')).toBe(false);

    await typeHost('ollama.internal:11434');
    await clickAdd();
    expect(rawStored()).toBe('127.0.0.1,ollama.internal');
  });

  it('回车等同于点添加', async () => {
    await renderTab();
    await typeHost('127.0.0.1');
    await act(async () => {
      q('plugin-whitelist-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(rawStored()).toBe('127.0.0.1');
  });

  it('非法输入：报错、不写盘、不产生条目', async () => {
    await renderTab();
    await typeHost('my computer');
    await clickAdd();

    expect(maybe('plugin-whitelist-error')).not.toBe(null);
    expect(String(container.textContent)).toContain('请输入合法主机名');
    expect(rawStored()).toBe(null);
    expect(maybe('plugin-whitelist-empty')).not.toBe(null);
  });

  it('「加本机 AI 服务」一次补两条且不重复', async () => {
    await renderTab();
    await act(async () => {
      q('plugin-whitelist-preset-local').click();
    });
    expect(rawStored()).toBe('localhost,127.0.0.1');

    await act(async () => {
      q('plugin-whitelist-preset-local').click();
    });
    expect(rawStored()).toBe('localhost,127.0.0.1');
  });

  it('删除条目 ⇒ 删到空时键消失 ⇒ 判定回到拦截', async () => {
    localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, 'localhost');
    await renderTab();
    expect(maybe('plugin-whitelist-chip-localhost')).not.toBe(null);
    expect(isUrlAllowedByPluginWhitelist(`http://localhost:${CROSS_PORT}/api/tags`)).toBe(true);

    await act(async () => {
      q('plugin-whitelist-remove-localhost').click();
    });
    expect(rawStored()).toBe(null);
    expect(maybe('plugin-whitelist-chip-localhost')).toBe(null);
    expect(isUrlAllowedByPluginWhitelist(`http://localhost:${CROSS_PORT}/api/tags`)).toBe(false);
  });

  it('本批之前手工敲的值（带空格/大小写）仍显示成可删条目；下次真正改动时被归一', async () => {
    localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, ' LocalHost , 192.168.1.50');
    await renderTab();

    expect(maybe('plugin-whitelist-chip-localhost')).not.toBe(null);
    expect(maybe('plugin-whitelist-chip-192.168.1.50')).not.toBe(null);

    // 加一个已在固定名单里的域名 ⇒ 不产生用户项、也不改写存储（没改动就不落盘）
    await typeHost('unpkg.com');
    await clickAdd();
    expect(rawStored()).toBe(' LocalHost , 192.168.1.50');
    expect(maybe('plugin-whitelist-chip-unpkg.com')).toBe(null);

    // 真加一条 ⇒ 整份按逗号格式重写，旧的空格/大小写杂质消失
    await typeHost('10.0.0.8');
    await clickAdd();
    expect(rawStored()).toBe('localhost,192.168.1.50,10.0.0.8');
    expect(isUrlAllowedByPluginWhitelist('http://10.0.0.8:1234/api')).toBe(true);
  });
});
