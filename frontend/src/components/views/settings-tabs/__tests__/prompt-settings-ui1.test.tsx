/**
 * [批次UI1 2026-10-21] 设置页「作者注」「破甲」控件行为测试。
 *
 * 钉住的语义：
 *   1. 作者注四项从 GET /api/users/me/settings 回填（后端本来就在回）；
 *   2. 深度只在"位置 = 聊天内 @ 深度(1)"时可用 —— 其余位置**禁用而非隐藏**
 *      （ST index.html:7761-7766 把深度输入框放在 In-chat 选项里，等价语义）；
 *   3. 保存作者注 PUT 的 body 恰好是四格，且带用户改后的值；
 *   4. 破甲保存 PUT {jailbreak}，空串是合法值（= 不注入）；
 *   5. PromptSettings 里不再出现"显示角色状态"这句指向不存在开关的文案
 *      （盘点报告 §3.1-② / 批次UI1-4）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PromptSettings } from '../PromptSettings';
import { api } from '@/services/api';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), put: vi.fn() },
  invalidateCache: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedGet = vi.mocked(api.get);
const mockedPut = vi.mocked(api.put);

const SETTINGS = {
  use_custom_prompts: false,
  custom_chat_prompt_zh: null,
  custom_chat_prompt_en: null,
  custom_character_prompt_zh: null,
  custom_character_prompt_en: null,
  author_note: 'AN TEXT',
  author_note_position: 0,
  author_note_frequency: 2,
  author_note_depth: 6,
  jailbreak: 'JB TEXT',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedGet.mockReset();
  mockedPut.mockReset();
  mockedGet.mockResolvedValue(SETTINGS as any);
  mockedPut.mockResolvedValue({ status: 'ok' } as any);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSettings() {
  await act(async () => {
    root.render(<PromptSettings token="test-token" />);
  });
  await act(async () => {});
}

function q(testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`未找到 data-testid=${testid}`);
  return el as HTMLElement;
}

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('PromptSettings 作者注 / 破甲控件', () => {
  it('GET 回填作者注四项与破甲，且深度在非 In-chat 位置被禁用（不隐藏）', async () => {
    await renderSettings();

    expect((q('author-note-text') as HTMLTextAreaElement).value).toBe('AN TEXT');
    expect((q('author-note-position') as HTMLSelectElement).value).toBe('0');
    expect((q('author-note-frequency') as HTMLInputElement).value).toBe('2');
    expect((q('author-note-depth') as HTMLInputElement).value).toBe('6');
    expect((q('jailbreak-text') as HTMLTextAreaElement).value).toBe('JB TEXT');

    // position=0（场景后）⇒ 深度不可用，但仍在 DOM 里（用户能看出为什么）
    expect((q('author-note-depth') as HTMLInputElement).disabled).toBe(true);
    // 频率仅在"停用"时禁用；position=0 时仍可用（后端对所有非 NONE 位置都做频率门控）
    expect((q('author-note-frequency') as HTMLInputElement).disabled).toBe(false);
  });

  it('切到「聊天内 @ 深度」后深度解禁；切到「停用」后频率禁用', async () => {
    await renderSettings();

    await act(async () => {
      setSelect(q('author-note-position') as HTMLSelectElement, '1');
    });
    expect((q('author-note-depth') as HTMLInputElement).disabled).toBe(false);

    await act(async () => {
      setSelect(q('author-note-position') as HTMLSelectElement, '-1');
    });
    expect((q('author-note-depth') as HTMLInputElement).disabled).toBe(true);
    expect((q('author-note-frequency') as HTMLInputElement).disabled).toBe(true);
  });

  it('保存作者注 ⇒ PUT body 只含四格且是用户改后的值', async () => {
    await renderSettings();

    await act(async () => {
      setTextarea(q('author-note-text') as HTMLTextAreaElement, 'NEW AN');
    });
    await act(async () => {
      setSelect(q('author-note-position') as HTMLSelectElement, '1');
    });
    await act(async () => {
      q('author-note-save').click();
    });
    await act(async () => {});

    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut).toHaveBeenCalledWith('/api/users/me/settings', {
      author_note: 'NEW AN',
      author_note_position: 1,
      author_note_frequency: 2,
      author_note_depth: 6,
    });
  });

  it('保存破甲 ⇒ PUT {jailbreak}，空串也照发（= 清空 = 不注入）', async () => {
    await renderSettings();

    await act(async () => {
      setTextarea(q('jailbreak-text') as HTMLTextAreaElement, '');
    });
    await act(async () => {
      q('jailbreak-save').click();
    });
    await act(async () => {});

    expect(mockedPut).toHaveBeenCalledWith('/api/users/me/settings', { jailbreak: '' });
  });

  it('删掉"显示角色状态"的误导文案（UI1-4：不补假开关）', async () => {
    await renderSettings();
    expect(container.textContent || '').not.toContain('显示角色状态');
  });
});
