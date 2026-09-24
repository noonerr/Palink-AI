/**
 * [P1.4] 消息媒体契约测试：`extra.media` 的读取、乐观占位、快照收敛、超时判定。
 *
 * 这些是「P1 验收四条」里纯逻辑那部分的守门人：
 *  1. 点击 → 立刻有占位（乐观插入，不等网络）；
 *  2. 服务端快照整组替换（幂等、不拼接）；
 *  3. 失败 → 占位转 failed 且可重试（同 id 原位）；
 *  4. 悬挂的 pending 超时后渲染为 failed，不永久转圈；
 *  5. 旧后端用 `content` 的降级路径仍然可用。
 */
import { describe, expect, it } from 'vitest';
import {
  MEDIA_PENDING_TIMEOUT_MS,
  applyMediaEvent,
  buildPendingMediaItem,
  effectiveMediaStatus,
  friendlyImageGenerationError,
  getMediaSnapshot,
  isPendingTimedOut,
  newMediaId,
  withFailedMedia,
  withMediaSnapshot,
  withPendingMedia,
  type MediaItem,
} from '@/lib/messageMedia';

interface Msg {
  id?: string | number;
  content?: string;
  extra?: Record<string, unknown>;
}

function readyItem(id: string, url = `/api/uploads/generated-images/${id}.png`): MediaItem {
  return { id, status: 'ready', url, width: 512, height: 512 };
}

describe('extra.media 读取', () => {
  it('坏数据一律降级为空快照，不抛', () => {
    expect(getMediaSnapshot(undefined).media).toEqual([]);
    expect(getMediaSnapshot(null).media).toEqual([]);
    expect(getMediaSnapshot({ media: 'not-a-list' }).media).toEqual([]);
    expect(getMediaSnapshot({ media: [null, 42, {}, { id: 'x' }] }).media).toEqual([]);
    expect(getMediaSnapshot({ media: [{ id: 'a', status: 'weird' }] }).media).toEqual([]);
  });

  it('media_index 越界/非整数时回落到 0', () => {
    const extra = { media: [readyItem('a')], media_index: 99 };
    expect(getMediaSnapshot(extra).media_index).toBe(0);
    expect(getMediaSnapshot({ ...extra, media_index: -1 }).media_index).toBe(0);
    expect(getMediaSnapshot({ ...extra, media_index: 1.5 }).media_index).toBe(0);
  });

  it('media_display 只认 gallery，其余落 inline', () => {
    const media = [readyItem('a')];
    expect(getMediaSnapshot({ media, media_display: 'gallery' }).media_display).toBe('gallery');
    expect(getMediaSnapshot({ media, media_display: 'nope' }).media_display).toBe('inline');
  });

  it('保留 extra 里其它键（swipe_info / reasoning 不能被出图挤掉）', () => {
    const msg: Msg = { id: 1, extra: { reasoning: '思考', swipe_info: [{ a: 1 }] } };
    const next = withPendingMedia(msg, buildPendingMediaItem({ id: 'm_aabbccddeeff' }));
    expect(next.extra?.reasoning).toBe('思考');
    expect(next.extra?.swipe_info).toEqual([{ a: 1 }]);
    expect(getMediaSnapshot(next.extra).media).toHaveLength(1);
  });
});

describe('乐观占位', () => {
  it('生成的 id 形如 m_ + 12 位十六进制（服务端才会采纳）', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(newMediaId()).toMatch(/^m_[0-9a-f]{12}$/);
    }
  });

  it('占位带上目标宽高（骨架按它预留比例，防 CLS）', () => {
    const item = buildPendingMediaItem({ id: 'm_aabbccddeeff', width: 768, height: 1024 });
    expect(item.status).toBe('pending');
    expect(item.url).toBeNull();
    expect([item.width, item.height]).toEqual([768, 1024]);
    expect(item.created_at).toBeTruthy();
  });

  it('同一个 id 重复插只保留一条（连点/重试不会插两条）', () => {
    const msg: Msg = { id: 1 };
    const withOne = withPendingMedia(msg, buildPendingMediaItem({ id: 'm_aabbccddeeff' }));
    const withTwo = withPendingMedia(withOne, buildPendingMediaItem({ id: 'm_aabbccddeeff' }));
    expect(getMediaSnapshot(withTwo.extra).media).toHaveLength(1);
  });
});

describe('服务端快照收敛', () => {
  it('整组替换（幂等）：重复应用同一事件结果不变', () => {
    const msg: Msg = { id: 7 };
    const snapshot = {
      media: [readyItem('m_aabbccddeeff')],
      media_index: 0,
      media_display: 'inline',
    };
    const once = withMediaSnapshot(msg, snapshot);
    const twice = withMediaSnapshot(once, snapshot);
    expect(getMediaSnapshot(twice.extra).media).toEqual(getMediaSnapshot(once.extra).media);
  });

  it('事件按 message_id 定位，不碰其它消息', () => {
    const messages: Msg[] = [
      { id: 1, extra: {} },
      { id: 2, extra: { media: [buildPendingMediaItem({ id: 'm_aabbccddeeff' })] } },
    ];
    const next = applyMediaEvent(messages, {
      type: 'message_image_generated',
      message_id: 2,
      media: [readyItem('m_aabbccddeeff')],
      media_index: 0,
      media_display: 'inline',
    });
    expect(next[0].extra).toEqual({});
    expect(getMediaSnapshot(next[1].extra).media[0].status).toBe('ready');
  });

  it('待重试的 id 不匹配时不动那条（别的图成功不该把这条也改成 ready）', () => {
    const msg: Msg = {
      id: 3,
      extra: { media: [{ ...buildPendingMediaItem({ id: 'm_111111111111' }) }] },
    };
    const next = withMediaSnapshot(msg, {
      media: [buildPendingMediaItem({ id: 'm_222222222222' })],
      media_index: 0,
      media_display: 'inline',
    });
    expect(getMediaSnapshot(next.extra).media[0].id).toBe('m_222222222222');
  });
});

describe('失败收敛', () => {
  it('按 media_id 标记失败并写入原因', () => {
    const msg: Msg = {
      id: 4,
      extra: { media: [buildPendingMediaItem({ id: 'm_aabbccddeeff' })] },
    };
    const next = withFailedMedia(msg, '上游 500', 'm_aabbccddeeff');
    const item = getMediaSnapshot(next.extra).media[0];
    expect(item.status).toBe('failed');
    expect(item.error).toBe('上游 500');
  });

  it('已 ready 的图不受影响（多图时一张失败不连坐）', () => {
    const msg: Msg = {
      id: 5,
      extra: {
        media: [
          readyItem('m_111111111111'),
          buildPendingMediaItem({ id: 'm_222222222222' }),
        ],
      },
    };
    const next = withFailedMedia(msg, 'boom', 'm_222222222222');
    const media = getMediaSnapshot(next.extra).media;
    expect(media[0].status).toBe('ready');
    expect(media[0].error).toBeNull();
    expect(media[1].status).toBe('failed');
  });

  it('失败事件带 media_id 时只收敛那一条', () => {
    const messages: Msg[] = [{
      id: 6,
      extra: {
        media: [
          buildPendingMediaItem({ id: 'm_111111111111' }),
          buildPendingMediaItem({ id: 'm_222222222222' }),
        ],
      },
    }];
    const next = applyMediaEvent(messages, {
      type: 'message_image_generation_failed',
      message_id: 6,
      error: '上游 500',
      media_id: 'm_222222222222',
    });
    const media = getMediaSnapshot(next[0].extra).media;
    expect(media[0].status).toBe('pending');
    expect(media[1].status).toBe('failed');
  });
});

describe('降级路径（旧后端）', () => {
  it('事件只带 content 时按 content 替换正文（一个版本周期的兼容）', () => {
    const messages: Msg[] = [{ id: 8, content: '正文', extra: {} }];
    const next = applyMediaEvent(messages, {
      type: 'message_image_generated',
      message_id: 8,
      content: '正文\n\n![生成图片](/api/uploads/x.png)',
    });
    expect(next[0].content).toContain('![生成图片]');
    expect(getMediaSnapshot(next[0].extra).media).toEqual([]);
  });

  it('新后端（带 media）时不碰 content —— 正文长度必须不变', () => {
    const messages: Msg[] = [{ id: 9, content: '正文', extra: {} }];
    const next = applyMediaEvent(messages, {
      type: 'message_image_generated',
      message_id: 9,
      media: [readyItem('m_aabbccddeeff')],
      media_index: 0,
      media_display: 'inline',
      content: '这段内容不该被采用',
    });
    expect(next[0].content).toBe('正文');
  });
});

describe('渲染期超时收敛（D3）', () => {
  it('未超时的 pending 保持 pending', () => {
    const item = buildPendingMediaItem({ id: 'm_aabbccddeeff' });
    expect(effectiveMediaStatus(item)).toBe('pending');
    expect(isPendingTimedOut(item)).toBe(false);
  });

  it('超时的 pending 渲染为 failed（页面刷新/断线后的悬挂占位）', () => {
    const item = buildPendingMediaItem({ id: 'm_aabbccddeeff' });
    const future = Date.now() + MEDIA_PENDING_TIMEOUT_MS + 1000;
    expect(effectiveMediaStatus(item, future)).toBe('failed');
    expect(isPendingTimedOut(item, future)).toBe(true);
  });

  it('ready / failed 不受时间影响', () => {
    const future = Date.now() + MEDIA_PENDING_TIMEOUT_MS * 100;
    expect(effectiveMediaStatus(readyItem('m_aabbccddeeff'), future)).toBe('ready');
    expect(effectiveMediaStatus({ ...readyItem('a'), status: 'failed' }, future)).toBe('failed');
  });

  it('created_at 缺失或不可解析时不动状态（不误判）', () => {
    const item = buildPendingMediaItem({ id: 'm_aabbccddeeff' });
    const broken = { ...item, created_at: 'not-a-date' };
    expect(effectiveMediaStatus(broken)).toBe('pending');
    expect(effectiveMediaStatus({ ...item, created_at: undefined })).toBe('pending');
  });
});

describe('失败文案人话化', () => {
  it('客户端超时 abort 给出「稍后刷新」的路（服务端可能已生成好）', () => {
    const abortError = new Error('signal is aborted without reason');
    abortError.name = 'AbortError';
    expect(friendlyImageGenerationError(abortError)).toContain('稍后刷新');
  });

  it('网络层失败翻成中文', () => {
    expect(friendlyImageGenerationError(new TypeError('Failed to fetch'))).toContain('网络异常');
  });

  it('后端 5xx 脱敏文案（Internal server error）补成可操作提示', () => {
    expect(friendlyImageGenerationError(new Error('Internal server error'))).toContain('出图服务返回错误');
  });

  it('后端原文（已是人话）原样保留', () => {
    expect(friendlyImageGenerationError(new Error('图片生成服务未配置'))).toBe('图片生成服务未配置');
  });

  it('拿不到 message 时给兜底文案', () => {
    expect(friendlyImageGenerationError(null)).toBe('图片生成失败');
  });
});