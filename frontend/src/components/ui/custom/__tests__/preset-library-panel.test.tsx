/**
 * 预设模板库面板测试（`PresetLibraryPanel`，对应后端 /api/preset-library）。
 *
 * 钉住的语义：
 *   1. 四类清单归一化：context/instruct 的 id/display_name/is_builtin 与
 *      sysprompt/reasoning 的 name/builtin 两种口径都能读；缺字段/非数组不抛。
 *   2. 导入摘要：created/skipped/warnings 兼容字符串与对象两种条目。
 *   3. 组件渲染：四个分组 + 条数 + 内置小标；非内置才有删除按钮；sysprompt/reasoning
 *      只做库管理（底部说明在位）。
 *   4. 导入：multipart 带 file（自动识别时不带 kind），导入后展示 created 数与 warnings、
 *      并重拉清单、回调父组件刷新。
 *
 * 运行: cd frontend && npx vitest run src/components/ui/custom/__tests__/preset-library-panel.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PresetLibraryPanel,
  normalizePresetLibrary,
  normalizePresetLibraryItem,
  summarizePresetLibraryImport,
} from '../PresetLibraryPanel';
import { api } from '@/services/api';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  invalidateCache: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Dialog 在 jsdom 里会引入 portal/focus-trap 噪音；删除确认文案不是本测重点。
vi.mock('@/components/ui/custom/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const LIBRARY = {
  context: [
    { id: 1, name: 'Default', display_name: '默认模板', is_builtin: true },
    { id: 2, name: 'ChatML', display_name: 'ChatML', is_builtin: false },
  ],
  instruct: [{ id: 3, name: 'Alpaca', display_name: 'Alpaca 指令', is_builtin: true }],
  sysprompt: [
    { name: 'Main', builtin: true },
    { name: 'NSFW', builtin: false },
  ],
  reasoning: [{ name: 'DeepSeek', builtin: true }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedGet.mockReset();
  mockedPost.mockReset();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function byTestId(id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`未找到 data-testid=${id}`);
  return el as HTMLElement;
}

describe('normalizePresetLibraryItem / normalizePresetLibrary', () => {
  it('兼容两套清单口径并保留内置标记', () => {
    expect(normalizePresetLibraryItem({ id: 7, name: 'Ctx', display_name: '上下文', is_builtin: true })).toEqual({
      key: '7',
      name: 'Ctx',
      displayName: '上下文',
      builtin: true,
    });
    expect(normalizePresetLibraryItem({ name: 'Sys', builtin: true })).toEqual({
      key: 'Sys',
      name: 'Sys',
      displayName: 'Sys',
      builtin: true,
    });
    // 无 id 时用 name 当定位键；无 name/display_name 时用 id
    expect(normalizePresetLibraryItem({ id: 9, display_name: '仅显示名' })?.key).toBe('9');
    expect(normalizePresetLibraryItem({ name: 'Plain' })?.builtin).toBe(false);
    // 不合法条目返回 null
    expect(normalizePresetLibraryItem(null)).toBeNull();
    expect(normalizePresetLibraryItem({ foo: 'bar' })).toBeNull();
  });

  it('四类分组缺失或非数组时按空处理，不抛', () => {
    const norm = normalizePresetLibrary({ context: [{ name: 'A' }], sysprompt: 'oops' });
    expect(norm.context).toHaveLength(1);
    expect(norm.instruct).toEqual([]);
    expect(norm.sysprompt).toEqual([]);
    expect(norm.reasoning).toEqual([]);
    expect(normalizePresetLibrary(null)).toEqual({
      context: [],
      instruct: [],
      sysprompt: [],
      reasoning: [],
    });
  });
});

describe('summarizePresetLibraryImport', () => {
  it('兼容字符串与对象条目，并展开 warnings', () => {
    const summary = summarizePresetLibraryImport({
      created: ['ChatML', { kind: 'instruct', name: 'Alpaca' }],
      skipped: [{ kind: 'context', name: 'Dup' }],
      warnings: [
        '上下文模板 ChatML 丢弃键：world_info_before',
        { kind: 'context', name: 'ChatML', message: '丢弃未知键: foo' },
      ],
    });
    expect(summary.created).toEqual(['ChatML', '指令模板：Alpaca']);
    expect(summary.skipped).toEqual(['上下文模板：Dup']);
    expect(summary.warnings).toEqual([
      '上下文模板 ChatML 丢弃键：world_info_before',
      '上下文模板：ChatML：丢弃未知键: foo',
    ]);
  });

  it('空/非法返回值不抛，全部给空数组', () => {
    expect(summarizePresetLibraryImport(undefined)).toEqual({ created: [], skipped: [], warnings: [] });
    expect(summarizePresetLibraryImport({ created: null })).toEqual({
      created: [],
      skipped: [],
      warnings: [],
    });
  });
});

describe('PresetLibraryPanel 渲染', () => {
  it('渲染四个分组、条数与内置标记，只有非内置项有删除按钮', async () => {
    mockedGet.mockResolvedValue(LIBRARY);
    await act(async () => {
      root.render(<PresetLibraryPanel />);
    });
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledWith('/api/preset-library');

    const groups = container.querySelectorAll('[data-testid="preset-library-group"]');
    expect(groups).toHaveLength(4);

    const counts: Record<string, string> = {};
    container.querySelectorAll('[data-testid="preset-library-count"]').forEach((el) => {
      counts[(el as HTMLElement).dataset.kind || ''] = el.textContent || '';
    });
    expect(counts.context).toBe('2 项');
    expect(counts.instruct).toBe('1 项');
    expect(counts.sysprompt).toBe('2 项');
    expect(counts.reasoning).toBe('1 项');

    // 显示名优先，内置小标存在
    expect(container.textContent).toContain('默认模板');
    expect(container.textContent).toContain('内置');

    // 内置：Default / Alpaca / Main / DeepSeek
    const builtinRows = container.querySelectorAll('[data-testid="preset-library-row"][data-builtin="true"]');
    expect(builtinRows).toHaveLength(4);

    const deleteButtons = container.querySelectorAll('[data-testid="preset-library-delete"]');
    const deleteKeys = Array.from(deleteButtons).map(
      (el) => `${(el as HTMLElement).dataset.kind}/${(el as HTMLElement).dataset.key}`,
    );
    expect(deleteKeys.sort()).toEqual(['context/2', 'sysprompt/NSFW']);

    // sysprompt/reasoning 本批不接生成，说明必须在位
    expect(byTestId('preset-library-note').textContent).toContain(
      '原生对话暂未消费 sysprompt/reasoning',
    );
  });
});

describe('PresetLibraryPanel 导入', () => {
  it('multipart 上传 file、展示 created/warnings、重拉清单并回调父组件', async () => {
    mockedGet.mockResolvedValue(LIBRARY);
    mockedPost.mockResolvedValue({
      created: ['ChatML', { kind: 'instruct', name: 'NewInstruct' }],
      skipped: ['Dup'],
      warnings: [{ kind: 'context', name: 'ChatML', message: '丢弃未知键: foo' }],
    });
    const onChanged = vi.fn();

    await act(async () => {
      root.render(<PresetLibraryPanel onChanged={onChanged} />);
    });
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(1);

    const input = byTestId('preset-library-file-input') as HTMLInputElement;
    const file = new File(['{"name":"ChatML"}'], 'chatml.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockedPost.mock.calls[0];
    expect(url).toBe('/api/preset-library/import');
    expect(body).toBeInstanceOf(FormData);
    const formData = body as FormData;
    expect(formData.get('file')).toBe(file);
    // 自动识别模式不带 kind
    expect(formData.get('kind')).toBeNull();

    const summaryText = byTestId('preset-library-import-summary').textContent || '';
    expect(summaryText).toContain('已导入 2 项');
    expect(summaryText).toContain('跳过 1 项');
    expect(summaryText).toContain('丢弃未知键: foo');

    // 导入后重拉清单 + 父组件收到变更通知
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
