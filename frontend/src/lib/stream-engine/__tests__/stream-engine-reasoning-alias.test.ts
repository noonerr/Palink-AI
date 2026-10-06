/**
 * [P3 2026-10-06] 思考内容「两字两字重复」回归测试。
 *
 * 根因：后端 stream_builder.py 每条思考增量同时发射同值的 `reasoning` 与
 * `model_reasoning`（后者是给旧前端的兼容别名字段）。前端把两个字段**都累加**
 * 进 fullReasoning ⇒ 每条增量出现两次，真机表现为 "II want Want To To" 式
 * 逐条翻倍（WS 路径无此问题，因为 websocket_manager.send_chunk 只发 reasoning）。
 *
 * 修复：stream-engine 只累加 `reasoning`，忽略别名。本测试喂入带双字段的
 * 真 SSE 响应，断言思考文本只累加一次。**反证**：把修复翻回
 * `reasoningDelta = \`${reasoning}${modelReasoning}\`` 时本测试立刻变红。
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

describe('stream-engine 思考别名字段不重复累加', () => {
  it('reasoning + model_reasoning 双字段同值时只累加一次', async () => {
    const engine = new StreamEngine();
    const reasoningChunks: string[] = [];
    engine.setCallbacks({
      onChunk: (_content, reasoning) => {
        if (reasoning) reasoningChunks.push(reasoning);
      },
    });

    const api = {
      stream: vi.fn(async () =>
        sseResponse([
          // 模拟 stream_builder 的实际输出：每条增量带同值的两个字段
          { reasoning: 'I ', model_reasoning: 'I ' },
          { reasoning: 'want', model_reasoning: 'want' },
          { reasoning: ' to', model_reasoning: ' to' },
          { content: '正文开始' },
        ]),
      ),
    };

    const result = await engine.sendViaSSE(request, api);

    expect(reasoningChunks).toEqual(['I ', 'want', ' to']);
    expect(engine.getContent().reasoning).toBe('I want to');
    expect(result.reasoning).toBe('I want to');
    expect(result.content).toBe('正文开始');
  });

  it('只带 reasoning 的旧格式不受影响', async () => {
    const engine = new StreamEngine();
    const api = {
      stream: vi.fn(async () =>
        sseResponse([{ reasoning: '思考' }, { reasoning: '过程' }]),
      ),
    };

    const result = await engine.sendViaSSE(request, api);
    expect(result.reasoning).toBe('思考过程');
  });
});
