/**
 * [P3 2026-10-06] generation-engine（卡脚本/插件 API 链路）思考别名字段不重复累加。
 *
 * 背景：该文件是四问题排查第二轮复核发现的**漏修点**——主聊天链路
 * （useCharacterChat×3 + stream-engine）修复 P3 时未同步此文件，线上
 * Generate / generateQuietPrompt / generateRaw 触发的生成思考文本持续翻倍。
 * 根因同源：后端 stream_builder.py 每条思考增量同时发射同值的 `reasoning` 与
 * `model_reasoning`（兼容别名），前端两个字段都累加 ⇒ 每条增量出现两次。
 *
 * 修复：只累加 `reasoning`，忽略别名（后端保证两字段同值同发，
 * 纯 model_reasoning 块按契约不存在）。
 * **反证**：把 generate() 的 SSE 回调翻回 `if (modelReasoning) fullReasoning += modelReasoning`
 * 时本测试立刻变红（'I I want want' ≠ 'I want'）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtimeStub } = vi.hoisted(() => ({
  runtimeStub: {
    startGeneration: vi.fn(),
    onStreamToken: vi.fn(),
    onStreamReasoningDone: vi.fn(),
    emitGenerationEnded: vi.fn(),
    stopGeneration: vi.fn(),
  },
}));

vi.mock('@/services/api', () => ({
  api: { stream: vi.fn(), get: vi.fn() },
}));

vi.mock('@/services/message-manager', () => ({
  messageManager: {
    getCurrentCharacterId: vi.fn(() => 'char-1'),
    _currentSessionId: 'sess-1',
  },
}));

vi.mock('@/lib/sillytavern/runtime', () => ({
  getGlobalSillyTavernRuntime: () => runtimeStub,
}));

import { generationEngine } from '@/services/generation-engine';
import { api } from '@/services/api';

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('generation-engine 思考别名字段不重复累加（P3 漏修点）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 走 _resolveModel 的 _currentModel 优先路径，避开 /api/admin/system/defaults
    generationEngine.setContext({ model: 'test-model' });
  });

  it('reasoning + model_reasoning 同值双字段只累加一次', async () => {
    (api.stream as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse([
        // 模拟 stream_builder 的实际输出：每条思考增量带同值的两个字段
        { reasoning: 'I ', model_reasoning: 'I ' },
        { reasoning: 'want', model_reasoning: 'want' },
        { reasoning: ' to', model_reasoning: ' to' },
        { content: '正文开始' },
      ]),
    );

    await generationEngine.generate('hello');

    // 生成链路走通（防止 catch 分支静默吞错导致断言落空）
    expect(runtimeStub.emitGenerationEnded).toHaveBeenCalledWith('plain', '正文开始');
    expect(runtimeStub.onStreamToken).toHaveBeenCalledWith('正文开始');
    // 双累加会得到 'I I want want'；修复后只累加 reasoning
    expect(runtimeStub.onStreamReasoningDone).toHaveBeenCalledWith('I want to');
  });

  it('只带 reasoning 的旧格式不受影响', async () => {
    (api.stream as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse([{ reasoning: '思考' }, { reasoning: '过程' }]),
    );

    await generationEngine.generate('hello');

    expect(runtimeStub.onStreamReasoningDone).toHaveBeenCalledWith('思考过程');
  });
});
