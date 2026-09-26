/*
 * [PLUGIN-ON-DEMAND P1] 角色编辑页「插件」Tab 接线契约
 *
 * 钉住的是**最容易悄悄丢掉的一环**：插件名单走独立端点 /plugin-state，
 * 不随 PUT /api/characters/{id} 一起提交 —— 如果编辑页的「保存」按钮没有显式补一次，
 * 用户在插件 Tab 勾半天，保存后回到聊天看不出任何变化（数据在脏 JSX 里就丢了）。
 *
 * 因此这里对整页做真渲染（jsdom + createRoot），验证：
 *   1. 存在「插件」Tab，点击后插件面板可见；
 *   2. 勾选 + 点保存 → 先 PUT /plugin-state，再触发 onSave（顺序不能反）；
 *   3. 没动插件时点保存 → 不写 /plugin-state，仍触发 onSave。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CharacterEditor } from '../CharacterEditor';
import { api } from '@/services/api';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), put: vi.fn() },
}));

const mockedGet = vi.mocked(api.get);
const mockedPut = vi.mocked(api.put);

const PLUGIN_STATE = {
  mode: 'inherit',
  plugins: [
    { plugin_id: 'p-a', plugin_name: '酒馆助手', plugin_type: 'tavern_helper', enabled: null },
  ],
  suggestions: [{ plugin_id: 'p-a', plugin_name: '酒馆助手', reason: '卡内自带脚本', source: 'detected' }],
};

const CHARACTER = { id: 'char-9', name: '测试角色', avatar: null } as any;

let container: HTMLDivElement;
let root: Root;
let onSave: Mock<() => void>;
let onCancel: Mock<() => void>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onSave = vi.fn();
  onCancel = vi.fn();
  mockedGet.mockReset();
  mockedPut.mockReset();
  mockedPut.mockResolvedValue({ status: 'ok' } as any);
  mockedGet.mockResolvedValue(PLUGIN_STATE as any);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderEditor() {
  await act(async () => {
    root.render(
      <CharacterEditor
        selectedCharacter={CHARACTER}
        editingCharacter={{ name: '测试角色' }}
        onSetEditingCharacter={() => {}}
        onSave={onSave}
        onCancel={onCancel}
        onImageUpload={() => {}}
      />,
    );
  });
  await act(async () => {});
}

function q(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`未找到 data-testid=${testid}`);
  return el as HTMLElement;
}

function firstSaveButton() {
  // 保存按钮在外提的操作区里（SVGRenderer: lucide Save + 文案"保存"）
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === '保存',
  );
  if (!btn) throw new Error('未找到保存按钮');
  return btn as HTMLButtonElement;
}

describe('CharacterEditor 插件 Tab 接线', () => {
  it('切到插件 Tab → 面板挂载并读取 plugin-state', async () => {
    await renderEditor();
    await act(async () => {
      q('character-editor-tab-plugins').click();
    });

    expect(mockedGet).toHaveBeenCalledWith('/api/characters/char-9/plugin-state');
    expect(q('character-plugins-tab')).toBeTruthy();
  });

  it('勾选后保存 → 先 PUT /plugin-state 再触发 onSave', async () => {
    await renderEditor();
    await act(async () => {
      q('character-editor-tab-plugins').click();
    });
    // 切 allowlist（此时相对服务端 inherit 已是改动）
    await act(async () => {
      (q('plugin-mode-allowlist').querySelector('input') as HTMLInputElement).click();
    });

    await act(async () => {
      firstSaveButton().click();
    });

    const urls = mockedPut.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('/api/characters/char-9/plugin-state');
    expect(onSave).toHaveBeenCalledTimes(1);
    // 顺序：plugin-state 的写必须发生在 onSave 之前
    expect(urls.indexOf('/api/characters/char-9/plugin-state')).toBeGreaterThanOrEqual(0);
    expect(onSave.mock.invocationCallOrder[0]).toBeGreaterThan(mockedPut.mock.invocationCallOrder[0]);
  });

  it('没改插件时保存 → 不写 /plugin-state，但仍触发 onSave', async () => {
    await renderEditor();
    await act(async () => {
      q('character-editor-tab-plugins').click();
    });

    await act(async () => {
      firstSaveButton().click();
    });

    expect(mockedPut).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('新建角色（selectedCharacter 为空）不显示插件 Tab', async () => {
    await act(async () => {
      root.render(
        <CharacterEditor
          selectedCharacter={null}
          editingCharacter={{}}
          onSetEditingCharacter={() => {}}
          onSave={onSave}
          onCancel={onCancel}
          onImageUpload={() => {}}
        />,
      );
    });
    await act(async () => {});

    expect(container.querySelector('[data-testid="character-editor-tab-plugins"]')).toBeNull();
    expect(container.querySelector('[data-testid="character-plugins-tab"]')).toBeNull();
  });
});
