/*
 * [ASM-3 2026-10-24] getWorldInfoPrompt 后端同源测试
 *
 * 断言三件事：
 *   1. 返回值来自后端端点 POST /api/character-sessions/{chatId}/worldbook-scan
 *      （mock 端点改返回 → 插件侧跟着变）；
 *   2. 与前端自算引擎（lib/worldbook scanAndBuildContext / getActiveEntries）
 *      彻底无关——引擎里塞入"会给出不同答案"的书，结果仍等于后端返回；
 *   3. 契约形状 = ST 1.18.0 WIPromptResult（async + 对象，world-info.js:892），
 *      无会话/请求失败时回退 ST 空结果形状（:4638），不回退前端引擎。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// getContext 经 top-level await 动态导入（拉起浏览器包副作用链，同 parity 测试）。
// '@/services/api' 必须在导入前 mock：getWorldInfoPrompt 的数据通道只剩它。
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(async () => []),
  put: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
}));

vi.mock('@/services/api', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
  getCsrfToken: vi.fn(() => 'test-csrf'),
  invalidateCache: vi.fn(),
}));

const { getContext } = await import('../getContext');
const { createSillyTavernRuntime, getGlobalSillyTavernRuntime } = await import('../runtime');
const { messageManager } = await import('@/services/message-manager');
const { stWorldBookManagerSingleton } = await import('../runtime');

// 建全局 runtime（getContext 读 runtime.getContext() 的 chatId；测试环境无宿主 App，需自建）
createSillyTavernRuntime({ chatId: '' });

// ── 后端端点的拟真返回（worldbook-scan 契约形状，见 backend/app/api/worldbook.py） ──

function backendPayload(shot: 'A' | 'B') {
  if (shot === 'A') {
    return {
      session_id: 'sess-asm3',
      worldInfoString: '后端装配文本A（条目1+条目2）',
      worldInfoBefore: '条目1（before）',
      worldInfoAfter: '条目2（after）',
      worldInfoExamples: [{ position: 'before', content: 'EM条目' }],
      worldInfoDepth: [{ depth: 4, entries: ['深度条目'], role: 0 }],
      anBefore: ['AN上条目'],
      anAfter: ['AN下条目'],
      outletEntries: { main: ['出口条目'] },
      entries: [
        {
          entry_id: 'stage-1', title: '条目1', status: 'activated',
          reason: 'constant', matched_keywords: [], tokens_estimate: 42,
          position: 0, recursion_depth: -1, world_book_id: 'wb-1',
          book_name: '书A', lore_source: 'character',
        },
        {
          entry_id: 'stage-2', title: '条目2', status: 'activated',
          reason: 'keyword: 后端', matched_keywords: ['后端'], tokens_estimate: 7,
          position: 1, recursion_depth: 0, world_book_id: 'wb-1',
          book_name: '书A', lore_source: 'character',
        },
        {
          entry_id: 'stage-3', title: '未命中', status: 'skipped',
          reason: 'no keyword match', matched_keywords: [], tokens_estimate: 0,
          position: null, recursion_depth: -1, world_book_id: 'wb-1',
          book_name: '书A', lore_source: 'character',
        },
      ],
      activated_entry_ids: ['stage-1', 'stage-2'],
      budget: {
        budget_used: 49, total_tokens: 49,
        world_info_budget: 25, world_info_budget_cap: 0,
        max_context_tokens: 8192,
      },
      book_sources: { 'wb-1': { name: '书A', source: 'character', type: 'world_book' } },
      chat_length: 3,
      read_only: true,
    };
  }
  return {
    session_id: 'sess-asm3',
    worldInfoString: '后端装配文本B（预算裁剪后仅剩条目1）',
    worldInfoBefore: '',
    worldInfoAfter: '条目1（after）',
    worldInfoExamples: [],
    worldInfoDepth: [],
    anBefore: [],
    anAfter: [],
    outletEntries: {},
    entries: [
      {
        entry_id: 'stage-1', title: '条目1', status: 'activated',
        reason: 'constant', matched_keywords: [], tokens_estimate: 42,
        position: 1, recursion_depth: -1, world_book_id: 'wb-1',
        book_name: '书A', lore_source: 'character',
      },
    ],
    activated_entry_ids: ['stage-1'],
    budget: {
      budget_used: 42, total_tokens: 42,
      world_info_budget: 5, world_info_budget_cap: 100,
      max_context_tokens: 4096,
    },
    book_sources: {},
    chat_length: 3,
    read_only: true,
  };
}

/** 切 chatId 触发缓存键变化（getWorldInfoPrompt 只缓存最近一帧，键含 chatId）。 */
function switchChat(chatId: string) {
  const rt = getGlobalSillyTavernRuntime();
  if (!rt) throw new Error('runtime 未初始化');
  rt.setContext({ chatId } as any);
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.get.mockClear();
});

describe('[ASM-3] getWorldInfoPrompt 数据源 = 后端权威装配', () => {
  it('#1 返回后端端点的 WIPromptResult（worldInfoString/entries/budget 逐项来自 mock 响应）', async () => {
    switchChat('sess-asm3');
    mocks.post.mockResolvedValueOnce(backendPayload('A'));

    const result = await getContext().getWorldInfoPrompt();

    // 1. 打的是会话级后端端点，而不是任何前端扫描
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][0]).toBe('/api/character-sessions/sess-asm3/worldbook-scan');

    // 2. ST 契约字段
    expect(result.worldInfoString).toBe('后端装配文本A（条目1+条目2）');
    expect(result.worldInfoBefore).toBe('条目1（before）');
    expect(result.worldInfoAfter).toBe('条目2（after）');
    expect(result.anBefore).toEqual(['AN上条目']);
    expect(result.anAfter).toEqual(['AN下条目']);
    expect(result.worldInfoExamples).toEqual([{ position: 'before', content: 'EM条目' }]);
    expect(result.worldInfoDepth).toEqual([{ depth: 4, entries: ['深度条目'], role: 0 }]);
    expect(result.outletEntries).toEqual({ main: ['出口条目'] });

    // 3. Palink 扩展：激活列表/预算（ASM-3 的对账面）
    expect(result.worldInfoEntries.map((e) => e.entry_id)).toEqual(['stage-1', 'stage-2', 'stage-3']);
    expect(result.worldInfoEntries.filter((e) => e.status === 'activated').map((e) => e.entry_id))
      .toEqual(['stage-1', 'stage-2']);
    expect(result.worldInfoBudget).toEqual({
      budget_used: 49, total_tokens: 49,
      world_info_budget: 25, world_info_budget_cap: 0,
      max_context_tokens: 8192,
    });
  });

  it('#2 mock 端点改返回 → 插件侧跟着变（返回值确系来自后端，非本地计算）', async () => {
    switchChat('sess-asm3-b'); // 换会话避免命中上一帧缓存
    mocks.post.mockResolvedValueOnce(backendPayload('A'));

    const first = await getContext().getWorldInfoPrompt();
    expect(first.worldInfoString).toBe('后端装配文本A（条目1+条目2）');
    expect(first.worldInfoBudget?.max_context_tokens).toBe(8192);

    // 同一会话内新消息落地 → 缓存键变化 → 重新打端点，端点给了不同答案
    (messageManager.messages as any[]).push({ id: 'msg-new', role: 'user', content: '新消息' });
    mocks.post.mockResolvedValueOnce(backendPayload('B'));

    const second = await getContext().getWorldInfoPrompt();
    expect(second.worldInfoString).toBe('后端装配文本B（预算裁剪后仅剩条目1）');
    expect(second.worldInfoEntries.map((e) => e.entry_id)).toEqual(['stage-1']);
    expect(second.worldInfoBudget).toEqual({
      budget_used: 42, total_tokens: 42,
      world_info_budget: 5, world_info_budget_cap: 100,
      max_context_tokens: 4096,
    });
  });

  it('#3 与前端自算引擎无关：引擎里塞入会命中聊天的书，结果仍等于后端返回', async () => {
    switchChat('sess-asm3-c');
    // 前端引擎数据面：一本"若走前端扫描必然输出不同文本"的书
    stWorldBookManagerSingleton.loadWorldBook({
      id: 'wb-frontend-decoy',
      name: '前端诱饵书',
      description: '',
      tags: [],
      createdAt: '',
      updatedAt: '',
      entries: [{
        id: 'decoy-1',
        uid: 0,
        key: ['诱饵'],
        keysecondary: [],
        content: 'FRONTEND_ENGINE_TEXT_不该出现',
        comment: '',
        selective: false,
        constant: false,
        vectorized: false,
        position: 0,
        depth: 0,
        order: 100,
        scanDepth: null,
        caseSensitive: false,
        matchWholeWords: false,
        enabled: true,
      } as any],
    });
    stWorldBookManagerSingleton.setActiveWorldBooks(['wb-frontend-decoy']);
    // 聊天里放进会命中诱饵关键词的消息，前端引擎若被调用必然激活诱饵条目
    (messageManager.messages as any[]).push({ id: 'msg-decoy', role: 'user', content: '诱饵 诱饵 诱饵' });

    mocks.post.mockResolvedValueOnce(backendPayload('A'));
    const result = await getContext().getWorldInfoPrompt();

    expect(result.worldInfoString).toBe('后端装配文本A（条目1+条目2）');
    expect(result.worldInfoString).not.toContain('FRONTEND_ENGINE_TEXT');
    expect(JSON.stringify(result)).not.toContain('FRONTEND_ENGINE_TEXT');
    expect(result.worldInfoEntries.map((e) => e.entry_id)).toEqual(['stage-1', 'stage-2', 'stage-3']);
  });

  it('#4 无会话（chatId 空）→ ST 空结果形状，不打端点', async () => {
    switchChat('');
    const result = await getContext().getWorldInfoPrompt();
    expect(result.worldInfoString).toBe('');
    expect(result.worldInfoEntries).toEqual([]);
    expect(result.worldInfoBudget).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('#5 端点失败 → ST 空结果形状（world-info.js:4638），不回退前端引擎', async () => {
    switchChat('sess-asm3-e');
    // 诱饵书仍在引擎里（上一用例注册）；若失败路径回退引擎，必然混入诱饵文本
    mocks.post.mockRejectedValueOnce(new Error('boom'));

    const result = await getContext().getWorldInfoPrompt();
    expect(result.worldInfoString).toBe('');
    expect(result.worldInfoEntries).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('FRONTEND_ENGINE_TEXT');
  });
});
