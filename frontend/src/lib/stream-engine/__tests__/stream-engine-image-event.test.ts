/**
 * [P1.3] stream-engine 出图事件分流回归测试。
 *
 * 修掉的 bug：`message_image_generated` 事件里的 `content` 是**整条消息正文**
 * （不是增量 chunk），而高级模式（`useChatView` 走的就是它）原先不区分事件类型，
 * 会把它当 chunk 追加 —— 开着自动出图的普通聊天页正文会翻倍显示。
 *
 * 这里用一条真 SSE 响应断言三件事：
 *  1. 出图事件被转发给专用回调；
 *  2. 它**没有**进入 `onChunk`/累加器；
 *  3. 最终 content 等于流式增量之和（不翻倍）。
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamEngine } from '@/lib/stream-engine';

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const request = {
  session_id: 'sess-1',
  session_type: 'chat' as const,
  message: 'hi',
  model: 'test-model',
  images: [],
  files: [],
};

describe('stream-engine 出图事件分流', () => {
  it('出图事件不进正文累加（否则正文翻倍）', async () => {
    const engine = new StreamEngine();
    const chunks: string[] = [];
    const generated: unknown[] = [];
    const failed: unknown[] = [];
    engine.setCallbacks({
      onChunk: (content) => {
        if (content) chunks.push(content);
      },
      onMessageImageGenerated: (payload) => generated.push(payload),
      onMessageImageGenerationFailed: (payload) => failed.push(payload),
    });

    const api = {
      stream: vi.fn(async () =>
        sseResponse([
          { content: '你好' },
          { content: '，世界' },
          {
            type: 'message_image_generated',
            message_id: 42,
            content: '你好，世界',
            media: [{ id: 'm_aabbccddeeff', status: 'ready', url: '/api/uploads/x.png' }],
            media_index: 0,
            media_display: 'inline',
          },
          { type: 'message_image_generation_failed', message_id: 43, error: '上游 500' },
        ]),
      ),
    };

    const result = await engine.sendViaSSE(request, api);

    expect(chunks).toEqual(['你好', '，世界']);
    expect(result.content).toBe('你好，世界');
    expect(engine.getContent().content).toBe('你好，世界');

    expect(generated).toHaveLength(1);
    expect((generated[0] as { message_id: number }).message_id).toBe(42);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { error: string }).error).toBe('上游 500');
  });

  it('没有订阅出图回调时也不影响正文（老调用方零改动）', async () => {
    const engine = new StreamEngine();
    const chunks: string[] = [];
    engine.setCallbacks({
      onChunk: (content) => {
        if (content) chunks.push(content);
      },
    });

    const api = {
      stream: vi.fn(async () =>
        sseResponse([
          { content: 'A' },
          { type: 'message_image_generated', message_id: 42, content: 'A' },
        ]),
      ),
    };

    const result = await engine.sendViaSSE(request, api);

    expect(chunks).toEqual(['A']);
    expect(result.content).toBe('A');
  });
});