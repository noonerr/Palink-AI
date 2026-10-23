import { beforeEach, describe, expect, it } from 'vitest';
import { resolveStableChatMetadata } from '../getContext';

/**
 * P2-20 契约：`getContext().chatMetadata` 必须是稳定引用的对象。
 *
 * 真机回归（Smart Memory 1.8.3 · updateLastActive）：
 *   旧实现在 runtime 的 chatMetadata 为空时回退 `{}` 字面量 ⇒ 每次 getContext()
 *   都得到新对象 ⇒ 插件「先建 SM 空对象、下一行写 lastActive」写进临时对象后丢失，
 *   抛 `Cannot set properties of undefined (setting 'lastActive')`。
 */
describe('resolveStableChatMetadata（P2-20）', () => {
  beforeEach(() => {
    delete (window as any).chat_metadata;
  });

  it('runtime 为空时两次解析返回同一对象，写入不会丢（复刻插件守卫链）', () => {
    const meta1 = resolveStableChatMetadata({ chatMetadata: {} });
    if (!meta1['SM']) meta1['SM'] = {};
    meta1['SM'].lastActive = 123;

    const meta2 = resolveStableChatMetadata({ chatMetadata: {} });
    expect(meta2).toBe(meta1);
    expect(meta2['SM'].lastActive).toBe(123);
  });

  it('window 已有 metadata 时优先使用它', () => {
    (window as any).chat_metadata = { existing: { lastActive: 9 } };
    const meta = resolveStableChatMetadata({ chatMetadata: {} });
    expect(meta).toBe((window as any).chat_metadata);
    expect(meta['existing'].lastActive).toBe(9);
  });

  it('runtime 非空时使用 runtime 的对象（不覆盖已有数据）', () => {
    const runtimeMeta = { fromRuntime: { lastActive: 1 } };
    const meta = resolveStableChatMetadata({ chatMetadata: runtimeMeta });
    expect(meta).toBe(runtimeMeta);
  });

  it('window.chat_metadata 被清空后仍会就地重建，不会是 undefined', () => {
    const meta = resolveStableChatMetadata(null);
    expect(meta).toBe((window as any).chat_metadata);
    expect(typeof meta).toBe('object');
  });
});
