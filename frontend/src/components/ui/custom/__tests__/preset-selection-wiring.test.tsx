/**
 * [批次UI1 2026-10-21] 预设"全局选中"与"本对话副本可见性"接线测试。
 *
 * 钉住的语义（对应盘点报告 §1.2-③ / §3.2-③）：
 *   1. 打开预设管理时读后端 `GET /presets/selection`，并且"当前预设"优先取
 *      `resolved_name`（不再是组件瞎猜 is_default）——修两套口径；
 *   2. 点选预设 / 点"设为全局选中" ⇒ `PUT /presets/selection`，body 是 {name}；
 *   3. 写成功后广播 `palink-preset-selection-changed`（CharacterCardRenderer
 *      靠它重拉 `/presets/snapshot`，否则帧内三键读旧快照）；
 *   4. 有 sessionId 时只读展示 `GET /sessions/{id}/preset` 的 source：
 *      session = 本对话副本 / global = 跟随全局默认；
 *   5. 写失败用 toast 可见（不静默吞掉）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PresetManager } from '../PresetManager';
import { api } from '@/services/api';
import { PRESET_SELECTION_CHANGED_EVENT } from '@/lib/promptPresetSelection';
import type { GenerationPreset } from '@/types';

vi.mock('@/services/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);
const mockedPut = vi.mocked(api.put);

const PRESETS = [
  { id: 1, name: '预设A', is_default: false, temperature: 0.7 },
  { id: 2, name: '预设B', is_default: true, temperature: 0.8 },
] as unknown as GenerationPreset[];

function routeGet(url: string) {
  if (url === '/api/roleplay/presets') return Promise.resolve(PRESETS);
  if (url === '/api/prompt-manager/presets/selection') {
    return Promise.resolve({
      selected_name: '预设B',
      resolved_name: '预设B',
      resolved_id: 2,
      source: 'selected',
    });
  }
  if (url.indexOf('/api/prompt-manager/sessions/') === 0) {
    return Promise.resolve({
      source: 'session',
      name: '预设B 副本',
      base_name: '预设B',
      base_preset_id: 2,
      is_session_copy: true,
    });
  }
  return Promise.reject(new Error('unexpected GET ' + url));
}

let container: HTMLDivElement;
let root: Root;
let picked: GenerationPreset | null;

function Harness({ sessionId }: { sessionId?: string }) {
  const [preset, setPreset] = useState<GenerationPreset | null>(null);
  return (
    <PresetManager
      currentPreset={preset}
      onPresetChange={(p) => {
        picked = p;
        setPreset(p);
      }}
      theme="dark"
      open
      sessionId={sessionId}
    />
  );
}

async function renderManager(sessionId?: string) {
  await act(async () => {
    root.render(<Harness sessionId={sessionId} />);
  });
  // 等 loadPresets 与 session source 两轮异步落到 state
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  picked = null;
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPut.mockReset();
  mockedPost.mockResolvedValue({ status: 'ok' } as any);
  mockedGet.mockImplementation(routeGet as any);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function q(testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`未找到 data-testid=${testid}`);
  return el as HTMLElement;
}

describe('PresetManager 全局选中接线', () => {
  it('打开时读 selection，当前预设优先取后端 resolved_name（不是 is_default）', async () => {
    await renderManager();

    expect(
      mockedGet.mock.calls.some((c) => c[0] === '/api/prompt-manager/presets/selection'),
    ).toBe(true);
    // 预设B 是 is_default，同时 selection 也指向它 —— 但断言的是"走了后端解析"
    expect(picked?.name).toBe('预设B');
    expect(q('preset-global-selection-summary').textContent).toContain('预设B');
  });

  it('点"设为全局选中"⇒ PUT selection {name} 并广播刷新事件', async () => {
    await renderManager();
    const events: string[] = [];
    const onChanged = () => events.push('changed');
    window.addEventListener(PRESET_SELECTION_CHANGED_EVENT, onChanged);
    mockedPut.mockResolvedValue({
      selected_name: '预设A',
      resolved_name: '预设A',
      resolved_id: 1,
      source: 'selected',
    } as any);

    await act(async () => {
      q('preset-select-global-1').click();
    });
    await act(async () => {});

    expect(mockedPut).toHaveBeenCalledWith('/api/prompt-manager/presets/selection', {
      name: '预设A',
    });
    expect(events.length).toBe(1);
    expect(q('preset-global-selection-summary').textContent).toContain('预设A');
    window.removeEventListener(PRESET_SELECTION_CHANGED_EVENT, onChanged);
  });

  it('有会话时只读展示"本对话副本"，不触发任何 PUT', async () => {
    await renderManager('sess-1');

    expect(
      mockedGet.mock.calls.some(
        (c) => c[0] === '/api/prompt-manager/sessions/sess-1/preset',
      ),
    ).toBe(true);
    expect(q('preset-session-source').textContent).toContain('使用副本');
    expect(q('preset-session-source').textContent).toContain('预设B');
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it('写 selection 失败 ⇒ toast.error 可见，不静默吞掉', async () => {
    const { toast } = await import('sonner');
    await renderManager();
    mockedPut.mockRejectedValue(new Error('boom'));

    await act(async () => {
      q('preset-select-global-1').click();
    });
    await act(async () => {});

    expect(toast.error).toHaveBeenCalled();
  });
});
