/*
 * [PLUGIN-ON-DEMAND P1] 角色设置页「插件」Tab 行为测试
 *
 * 用 vitest 的 jsdom + react-dom/client 直接渲染真组件（本项目没装
 * @testing-library，这里手写 render + act 的最小封装），api 层用 vi.mock 打桩。
 *
 * 钉住的语义：
 *   1. inherit 模式下勾选框禁用且视觉为未选（此时行的 enabled 不参与写入判断）；
 *   2. 切到 allowlist 后，默认勾选 = 识别建议（suggestions）；
 *   3. 未改动时 save() **不发请求**（幂等，避免每次点保存都写一遍脏数据）；
 *   4. 有改动时 PUT body = { mode, plugins:[{plugin_id, enabled}] } 与用户勾选一致；
 *   5. 读取失败显示错误提示，不会白屏、不会抛。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CharacterPluginsTab, type CharacterPluginsTabHandle } from '../CharacterPluginsTab';
import { api } from '@/services/api';

vi.mock('@/services/api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

const mockedGet = vi.mocked(api.get);
const mockedPut = vi.mocked(api.put);

const STATE_OK = {
  mode: 'inherit',
  plugins: [
    { plugin_id: 'p-a', plugin_name: '酒馆助手', plugin_type: 'tavern_helper', enabled: null },
    { plugin_id: 'p-b', plugin_name: '天气插件', plugin_type: 'sillytavern_extension', enabled: null },
  ],
  suggestions: [
    { plugin_id: 'p-a', plugin_name: '酒馆助手', plugin_type: 'tavern_helper', reason: '卡内自带脚本', source: 'detected' },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedGet.mockReset();
  mockedPut.mockReset();
  mockedPut.mockResolvedValue({ status: 'ok' } as any);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderTab(id = 'char-1') {
  const ref = React.createRef<CharacterPluginsTabHandle>();
  await act(async () => {
    root.render(<CharacterPluginsTab ref={ref} characterId={id} />);
  });
  // 等 effects 里的异步 GET 落定
  await act(async () => {});
  return ref;
}

function q(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`未找到 data-testid=${testid}`);
  return el as HTMLElement;
}

function checkbox(pluginId: string) {
  return q(`plugin-tab-toggle-${pluginId}`) as HTMLInputElement;
}

async function clickMode(mode: 'inherit' | 'allowlist') {
  const radio = q(`plugin-mode-${mode}`).querySelector('input') as HTMLInputElement;
  await act(async () => {
    radio.click();
  });
}

describe('CharacterPluginsTab', () => {
  it('读取 GET /plugin-state，inherit 模式下勾选框禁用且不可改', async () => {
    mockedGet.mockResolvedValue(STATE_OK as any);
    const ref = await renderTab();

    expect(mockedGet).toHaveBeenCalledWith('/api/characters/char-1/plugin-state');
    expect(checkbox('p-a').disabled).toBe(true);
    expect(checkbox('p-b').disabled).toBe(true);
    expect(checkbox('p-a').checked).toBe(false);
    expect(ref.current?.isDirty()).toBe(false);
  });

  it('未改动时 save() 不发 PUT（幂等，不制造脏写）', async () => {
    mockedGet.mockResolvedValue(STATE_OK as any);
    const ref = await renderTab();

    await act(async () => {
      await ref.current?.save();
    });
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it('切到 allowlist 后勾选框可用，默认勾选 = 识别建议，并标脏', async () => {
    mockedGet.mockResolvedValue(STATE_OK as any);
    const ref = await renderTab();

    await clickMode('allowlist');

    expect(checkbox('p-a').disabled).toBe(false);
    expect(checkbox('p-a').checked).toBe(true); // 建议命中 → 默认勾
    expect(checkbox('p-b').checked).toBe(false);
    expect(ref.current?.isDirty()).toBe(true);
  });

  it('save() 提交 {mode, plugins}，与用户勾选逐条一致', async () => {
    mockedGet.mockResolvedValue(STATE_OK as any);
    const ref = await renderTab();
    await clickMode('allowlist');
    await act(async () => {
      checkbox('p-b').click();
    });

    await act(async () => {
      await ref.current?.save();
    });

    expect(mockedPut).toHaveBeenCalledTimes(1);
    const [url, body] = mockedPut.mock.calls[0] as [string, any];
    expect(url).toBe('/api/characters/char-1/plugin-state');
    expect(body.mode).toBe('allowlist');
    expect(body.plugins.find((p: any) => p.plugin_id === 'p-a').enabled).toBe(true);
    expect(body.plugins.find((p: any) => p.plugin_id === 'p-b').enabled).toBe(true);
    // 保存后回到干净状态（再点一次保存不会重复写）
    expect(ref.current?.isDirty()).toBe(false);
  });

  it('服务端已有 allowlist 名单时按库里的 enabled 回填，而非按建议默认', async () => {
    mockedGet.mockResolvedValue({
      ...STATE_OK,
      mode: 'allowlist',
      plugins: [
        { plugin_id: 'p-a', plugin_name: '酒馆助手', plugin_type: 'tavern_helper', enabled: false },
        { plugin_id: 'p-b', plugin_name: '天气插件', plugin_type: 'sillytavern_extension', enabled: true },
      ],
    } as any);
    await renderTab();

    expect(checkbox('p-a').checked).toBe(false);
    expect(checkbox('p-b').checked).toBe(true);
  });

  it('读取失败 → 显示错误提示，不抛不白屏', async () => {
    mockedGet.mockRejectedValue(new Error('boom'));
    const ref = await renderTab();

    expect(q('plugin-tab-error').textContent).toContain('读取插件列表失败');
    // 失败时不该把界面标成脏的（没有可提交的东西）
    expect(ref.current?.isDirty()).toBe(false);
  });
});
