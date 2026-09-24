/**
 * [P1.4] `MessageMedia` 组件三态 + 多图切换 + 重试交互测试。
 *
 * 用 react-dom/client + React.act 真实挂载（项目未装 @testing-library/react，
 * 且这层交互不值得为此引依赖）：
 * - pending：比例骨架 + 已等待秒数，且**与 ready 用同一套比例盒子**（防 CLS）；
 * - ready：`<img>` 指向 `/api/uploads/...`（走 N-7 短令牌链路）；
 * - failed：原因 + 重试按钮 → 回调带上该条 media 的 id（服务端据此原位复位）；
 * - 多图：左右箭头切 index，计数随之变化。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageMedia } from '@/components/ui/custom/MessageMedia';
import {
  MEDIA_PENDING_TIMEOUT_MS,
  buildPendingMediaItem,
  type MediaItem,
} from '@/lib/messageMedia';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * 挂载并冲掉一帧微任务：`AsyncUploadImg` 会在 effect 里异步换短令牌
 * （N-7），不把它放进 act 会得到「update not wrapped in act」警告。
 */
async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
  });
  return container;
}

/** 在同一个 root 上重渲染（props 变化场景）。 */
async function rerender(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function readyItem(id: string): MediaItem {
  return {
    id,
    status: 'ready',
    url: `/api/uploads/generated-images/${id}.png`,
    width: 512,
    height: 1024,
  };
}

describe('MessageMedia', () => {
  it('pending：渲染比例骨架 + 已等待秒数（不是空白）', async () => {
    const item = buildPendingMediaItem({ id: 'm_aabbccddeeff', width: 768, height: 1024 });
    const el = await mount(<MessageMedia media={[item]} />);

    const box = el.querySelector('[data-palink-message-media]');
    expect(box).not.toBeNull();
    expect(el.textContent).toContain('正在生成配图');
    expect(el.textContent).toContain('已等待');

    const skeleton = el.querySelector('[role="status"]') as HTMLElement;
    expect(skeleton).not.toBeNull();
    // 骨架必须预留与最终图相同的比例，否则完成后版面跳动（CLS）
    expect(skeleton.style.aspectRatio.replace(/\s/g, '')).toBe('768/1024');
    expect(skeleton.querySelector('img')).toBeNull();
  });

  it('ready：渲染图片，且与 pending 用同一套比例盒子', async () => {
    const el = await mount(<MessageMedia media={[readyItem('m_aabbccddeeff')]} />);

    const img = el.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('/api/uploads/generated-images/m_aabbccddeeff.png');
    expect(img.getAttribute('loading')).toBe('lazy');

    const box = img.parentElement as HTMLElement;
    expect(box.style.aspectRatio.replace(/\s/g, '')).toBe('512/1024');
  });

  it('failed：显示原因并可重试，回调带上该条 media 的 id', async () => {
    const onRetry = vi.fn();
    const item: MediaItem = {
      ...readyItem('m_aabbccddeeff'),
      status: 'failed',
      url: null,
      error: '图片生成服务返回错误',
    };
    const el = await mount(<MessageMedia media={[item]} onRetry={onRetry} />);

    expect(el.textContent).toContain('图片生成服务返回错误');
    const button = el.querySelector('button[aria-label="重新生成这张图"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith('m_aabbccddeeff');
  });

  it('未传 onRetry 时不渲染重试按钮（只读场景）', async () => {
    const item: MediaItem = { ...readyItem('m_aabbccddeeff'), status: 'failed', url: null, error: 'x' };
    const el = await mount(<MessageMedia media={[item]} />);
    expect(el.querySelector('button[aria-label="重新生成这张图"]')).toBeNull();
  });

  it('悬挂的 pending 超时后渲染为失败（不永久转圈）', async () => {
    const stale = buildPendingMediaItem({ id: 'm_aabbccddeeff' });
    stale.created_at = new Date(Date.now() - MEDIA_PENDING_TIMEOUT_MS - 5000).toISOString();

    const el = await mount(<MessageMedia media={[stale]} />);

    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.textContent).toContain('生成超时');
  });

  it('多图：左右箭头切换并更新计数；单图不渲染箭头', async () => {
    const media = [readyItem('m_111111111111'), readyItem('m_222222222222'), readyItem('m_333333333333')];
    const el = await mount(<MessageMedia media={media} />);

    expect(el.textContent).toContain('1/3');
    const next = el.querySelector('button[aria-label="下一张"]') as HTMLButtonElement;
    const prev = el.querySelector('button[aria-label="上一张"]') as HTMLButtonElement;
    expect(next).not.toBeNull();
    expect(prev).not.toBeNull();

    act(() => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(el.textContent).toContain('2/3');
    expect((el.querySelector('img') as HTMLImageElement).getAttribute('src')).toContain('m_222222222222');

    act(() => {
      prev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(el.textContent).toContain('1/3');

    // 单图：无箭头
    const single = await mount(<MessageMedia media={[readyItem('m_444444444444')]} />);
    expect(single.querySelector('button[aria-label="下一张"]')).toBeNull();
  });

  it('新增一张图后自动切到最新那条（点完「配图」要看到新的那张）', async () => {
    const first = readyItem('m_111111111111');
    const el = await mount(<MessageMedia media={[first]} />);
    expect((el.querySelector('img') as HTMLImageElement).getAttribute('src')).toContain('m_111111111111');

    const pending = buildPendingMediaItem({ id: 'm_222222222222' });
    await rerender(<MessageMedia media={[first, pending]} />);

    expect(el.textContent).toContain('2/2');
    expect(el.textContent).toContain('正在生成配图');
  });

  it('空数组不渲染任何东西（无数据即无 UI）', async () => {
    const el = await mount(<MessageMedia media={[]} />);
    expect(el.querySelector('[data-palink-message-media]')).toBeNull();
  });
});
