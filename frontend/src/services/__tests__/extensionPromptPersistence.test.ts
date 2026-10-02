/**
 * [PROMPT-EVERY-TURN 2026-10-02] 扩展提示词持久化中继单测。
 * 边界：本模块只做 console 级诊断（用户拍板驳回 toast），POST 失败静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../api', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
  },
}));

vi.mock('../../components/ui/custom/smart-card-runtime/primitives', async () => {
  // 与生产实现同构的 FNV-1a（primitives.hashSmartCardSource）
  const hashSmartCardSource = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  return { hashSmartCardSource };
});

import {
  computeSmartCardBundleSourceKey,
  noteSentExtensionPrompts,
  persistFrameExtensionPrompts,
} from '../extensionPromptPersistence';
import type { SmartCardPluginScriptBundle } from '../../components/ui/custom/smart-card-runtime/primitives';

function makeBundle(scripts: Array<{ pluginId: string; path: string; content: string }>): SmartCardPluginScriptBundle {
  return {
    generated_at: '2026-10-02T00:00:00Z',
    scripts: scripts.map((s) => ({ pluginId: s.pluginId, kind: 'js' as const, path: s.path, content: s.content })),
  } as unknown as SmartCardPluginScriptBundle;
}

describe('computeSmartCardBundleSourceKey', () => {
  it('空包返回空串', () => {
    expect(computeSmartCardBundleSourceKey(null)).toBe('');
    expect(computeSmartCardBundleSourceKey({ generated_at: '', scripts: [] } as SmartCardPluginScriptBundle)).toBe('');
  });

  it('同内容不同对象 → 同键（内容决定键，与 generated_at 无关）', () => {
    const a = computeSmartCardBundleSourceKey(makeBundle([{ pluginId: 'p1', path: 'main.js', content: 'spec text' }]));
    const b = computeSmartCardBundleSourceKey(makeBundle([{ pluginId: 'p1', path: 'main.js', content: 'spec text' }]));
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a.startsWith('fnv1a-')).toBe(true);
  });

  it('内容变化 → 键变化', () => {
    const a = computeSmartCardBundleSourceKey(makeBundle([{ pluginId: 'p1', path: 'main.js', content: 'v7.1 规范' }]));
    const b = computeSmartCardBundleSourceKey(makeBundle([{ pluginId: 'p1', path: 'main.js', content: 'v7.2 规范' }]));
    expect(a).not.toBe(b);
  });

  it('无 content 的脚本被忽略', () => {
    const bundle = {
      generated_at: '',
      scripts: [{ pluginId: 'p1', kind: 'js', path: 'x.js', content: 'code' }, { pluginId: 'p2', kind: 'js', path: 'y.js' }],
    } as unknown as SmartCardPluginScriptBundle;
    expect(computeSmartCardBundleSourceKey(bundle)).toBeTruthy();
  });
});

describe('persistFrameExtensionPrompts', () => {
  beforeEach(() => {
    postMock.mockClear();
  });

  it('首报发送 POST，载荷含 character_id/source_key/prompts', () => {
    persistFrameExtensionPrompts('char-1', { 'bubble-dialogue-format': { value: '规范文本', position: 0, depth: 0, role: 0 } }, 'fnv1a-key1234');
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('/api/extension-prompts/persist');
    expect((body as { character_id: string }).character_id).toBe('char-1');
    expect((body as { source_key: string }).source_key).toBe('fnv1a-key1234');
    expect((body as { prompts: Record<string, { content: string }> }).prompts['bubble-dialogue-format'].content).toBe('规范文本');
  });

  it('同内容重复上报被去重', () => {
    const snapshot = { fmt: { value: '固定文本', position: 0 } };
    persistFrameExtensionPrompts('char-2', snapshot, 'fnv1a-key2222');
    persistFrameExtensionPrompts('char-2', snapshot, 'fnv1a-key2222');
    persistFrameExtensionPrompts('char-2', snapshot, 'fnv1a-key2222');
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('内容变化才重新发送', () => {
    persistFrameExtensionPrompts('char-3', { fmt: { value: 'v1' } }, 'fnv1a-key3333');
    persistFrameExtensionPrompts('char-3', { fmt: { value: 'v1' } }, 'fnv1a-key3333');
    persistFrameExtensionPrompts('char-3', { fmt: { value: 'v2' } }, 'fnv1a-key3333');
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('空 content 条目不发送', () => {
    persistFrameExtensionPrompts('char-4', { fmt: { value: '   ' } }, 'fnv1a-key4444');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('缺 characterId / sourceKey / prompts 不发送', () => {
    persistFrameExtensionPrompts(undefined, { fmt: { value: 'x' } }, 'fnv1a-key5555');
    persistFrameExtensionPrompts('char-6', { fmt: { value: 'x' } }, '');
    persistFrameExtensionPrompts('char-6', undefined, 'fnv1a-key5555');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('POST 失败静默（console.warn，不抛出）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postMock.mockRejectedValueOnce(new Error('network down'));
    expect(() =>
      persistFrameExtensionPrompts('char-7', { fmt: { value: 'y' } }, 'fnv1a-key7777'),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('noteSentExtensionPrompts（缺席回归检测，仅 console）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('首轮不警告；回归才警告', () => {
    noteSentExtensionPrompts('c1', 's1', ['fmt']);
    expect(warnSpy).not.toHaveBeenCalled();
    noteSentExtensionPrompts('c1', 's1', ['fmt']);
    expect(warnSpy).not.toHaveBeenCalled();
    noteSentExtensionPrompts('c1', 's1', []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('fmt');
  });

  it('冷却期内同一 identifier 不重复警告', () => {
    noteSentExtensionPrompts('c2', 's2', ['a', 'b']);
    noteSentExtensionPrompts('c2', 's2', []);
    noteSentExtensionPrompts('c2', 's2', []);
    expect(warnSpy).toHaveBeenCalledTimes(2); // a、b 各一次
  });

  it('不同会话互不串扰', () => {
    noteSentExtensionPrompts('c3', 'sA', ['fmt']);
    noteSentExtensionPrompts('c3', 'sB', []); // sB 上一轮无记录 → 不警告
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
