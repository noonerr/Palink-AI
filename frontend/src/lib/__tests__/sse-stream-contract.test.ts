import { describe, expect, it } from 'vitest';
import { consumeSseStream } from '../sseStream';

/** 把若干文本块包成一个 SSE Response（用于验证分帧与跨 chunk 拼接）。 */
function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('consumeSseStream 契约（L2-3 收口的唯一解析器）', () => {
  it('同时接受 `data:` 与 `data: ` 两种前缀，且能跨 chunk 拼出事件', async () => {
    const events: Record<string, unknown>[] = [];
    await consumeSseStream(
      responseFrom(['data:{"a":1}\n\nda', 'ta: {"b":2}\n\n: keep-alive\n\n', 'data: [DONE]\n\n']),
      (json) => events.push(json),
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('流结束时冲刷没有空行收尾的尾事件', async () => {
    const events: Record<string, unknown>[] = [];
    await consumeSseStream(responseFrom(['data: {"tail":true}']), (json) => events.push(json));
    expect(events).toEqual([{ tail: true }]);
  });

  it('onJson 抛出的非 SyntaxError 会冒泡（调用方据此中断）', async () => {
    await expect(
      consumeSseStream(responseFrom(['data: {"x":1}\n\n']), () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('JSON 坏行静默跳过，不影响后续事件', async () => {
    const events: Record<string, unknown>[] = [];
    await consumeSseStream(responseFrom(['data: not-json\n\ndata: {"ok":1}\n\n']), (json) =>
      events.push(json),
    );
    expect(events).toEqual([{ ok: 1 }]);
  });
});
