/*
 * 角色世界书回退契约测试（三轨并一轨 · S1 · G11）
 *
 * 背景（2026-10-13 真机实证）：单间轨父侧的 `getCharWorldbook` 只认
 * `SmartCardCompatControllerState.worldBook`（**卡自建**的世界书，:315 才赋值）
 * ⇒ 卡未自建时恒返回空绑定。而主页面轨（大堂轨）的权威实现走的是
 *   GET /api/worldbooks?character_id=<cid>&type=character_book
 * （见 utils/sillyTavernPluginRuntime.ts:819-843），能拿到角色自带世界书。
 *
 * 真机对照（角色 露缇雅1.2 / 会话 f25daab6，session_world_books 0 行）：
 *   主页面  getCharWorldbookNames('current').primary === '露缇雅1.2'
 *   卡片帧  getCharWorldbookNames('current').primary === null
 *
 * 用户可见后果：卡 iframe 看不到角色自带世界书 —— 而那本正是承载 MVU `[InitVar]`
 * 条目的世界书 ⇒ MVU 的 zn() 拿不到候选世界书 ⇒ 变量初始化落空。
 * 今天默认走大堂轨所以没暴露，S3 把默认切到单间轨即失效。
 *
 * 关键字段映射：后端把 ST 世界书条目的 `comment` 存成 `title`
 * （backend/app/api/worldbook.py:597 `title=entry.get("comment", ...)`），
 * 所以回退时**必须把 title 映射回 comment**，否则 MVU 的
 * `entry.comment?.toLowerCase().includes('[initvar]')` 匹配不到。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/char-worldbook-fallback-contract.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/services/worldbookApi', () => ({
  worldbookApi: {
    list: (...args: unknown[]) => listMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  },
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const CID = 'c28061bb-a9b7-46a9-a255-2692d57001fc';
const CHAR_BOOK = { id: 'e342e7c4-aece-409f-9809-c7dc169a5e91', name: '露缇雅1.2', type: 'character_book' };
const STAGES = [
  { id: 's1', title: '[InitVar]变量初始化', content: 'stat_data: {}', stage_index: 0 },
  { id: 's2', title: '世界观', content: '某设定', stage_index: 1 },
];

async function callAction(
  actionName: string,
  state: unknown,
  context: unknown,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; result: any; error?: string }> {
  let out: { ok: boolean; result: any; error?: string } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    state as never,
    context as never,
    {
      type: 'request',
      requestId: 'req-1',
      action: actionName,
      payload,
      respond: (r: { ok: boolean; result?: unknown; error?: string }) => {
        out = { ok: r.ok, result: r.result, error: r.error };
      },
    } as never,
  );
  return out;
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    selectedCharacterName: '露缇雅1.2',
    selectedCharacterId: CID,
    selectedSession: { id: 'f25daab6-fc7b-4223-abdb-6dea4c2eb284' },
    sessionId: 'f25daab6-fc7b-4223-abdb-6dea4c2eb284',
    wb: {},
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  listMock.mockResolvedValue([CHAR_BOOK]);
  getMock.mockResolvedValue({ ...CHAR_BOOK, stages: STAGES });
});

// ============================================================
// A 卡未自建世界书时，回退到角色 character_book
// ============================================================
describe('A getCharWorldbook —— 卡自建缺失时回退到角色 character_book', () => {
  it('[红→S1 转绿] state.worldBook 为 null 时返回角色自带世界书名（不再是空绑定）', async () => {
    const { result } = await callAction('getCharWorldbook', { worldBook: null }, baseContext());
    expect(result.success).toBe(true);
    expect(result.name).toBe('露缇雅1.2');
    expect(result.world_book_id).toBe(CHAR_BOOK.id);
  });

  it('[红→S1 转绿] 按 character_id + type=character_book 查询（对齐主页面桥的权威源）', async () => {
    await callAction('getCharWorldbook', { worldBook: null }, baseContext());
    expect(listMock).toHaveBeenCalledWith({ character_id: CID, type: 'character_book' });
  });

  it('[红→S1 转绿] 条目把 title 映射回 comment（否则 MVU 匹配不到 [initvar]）', async () => {
    const { result } = await callAction('getCharWorldbook', { worldBook: null }, baseContext());
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries).toHaveLength(2);
    const initEntry = result.entries.find((e: any) => String(e.comment).toLowerCase().includes('[initvar]'));
    expect(initEntry, '必须有一条 comment 含 [initvar] 的条目').toBeTruthy();
    expect(initEntry.content).toBe('stat_data: {}');
  });

  it('[红→S1 转绿] getWorldbookEntries 同样回退（zn() 用它拉 [initvar] 条目）', async () => {
    const { result } = await callAction('getWorldbookEntries', { worldBook: null }, baseContext());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(String(result[0].comment)).toContain('[InitVar]');
  });
});

// ============================================================
// B 卡自建存在时行为不变（不许把既有路径改坏）
// ============================================================
describe('B 卡自建世界书优先，行为与修复前逐字一致', () => {
  it('[红→S1 转绿] state.worldBook 存在时直接用它的 name/entries，且不打 API', async () => {
    const state = {
      worldBook: { id: 'wb-1', name: '卡自建', entries: [{ comment: 'x', content: 'y' }] },
    };
    const { result } = await callAction('getCharWorldbook', state, baseContext());
    expect(result.name).toBe('卡自建');
    expect(result.world_book_id).toBe('wb-1');
    expect(result.entries).toEqual([{ comment: 'x', content: 'y' }]);
    expect(listMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('[红→S1 转绿] 卡自建存在时 getWorldbookEntries 也走原路径', async () => {
    const state = {
      worldBook: { id: 'wb-1', name: '卡自建', entries: [{ comment: 'x' }] },
    };
    const { result } = await callAction('getWorldbookEntries', state, baseContext());
    expect(result).toEqual([{ comment: 'x' }]);
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// C 降级：拿不到也不能抛（卡脚本会因此崩）
// ============================================================
describe('C 降级 —— 任何失败都返回空绑定，不抛给卡脚本', () => {
  it('[红→S1 转绿] 无 characterId 时返回空绑定且不打 API', async () => {
    const { result } = await callAction('getCharWorldbook', { worldBook: null }, baseContext({ selectedCharacterId: null }));
    expect(result.success).toBe(true);
    expect(result.name).toBe('');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('[红→S1 转绿] 角色没有 character_book 时返回空绑定', async () => {
    listMock.mockResolvedValue([]);
    const { result } = await callAction('getCharWorldbook', { worldBook: null }, baseContext());
    expect(result.success).toBe(true);
    expect(result.name).toBe('');
  });

  it('[红→S1 转绿] API 抛错时返回空绑定（不抛）', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    const { result } = await callAction('getCharWorldbook', { worldBook: null }, baseContext());
    expect(result.success).toBe(true);
    expect(result.name).toBe('');
  });

  it('[红→S1 转绿] getWorldbookEntries 在 API 抛错时返回空数组（zn() 要 for...of）', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    const { result } = await callAction('getWorldbookEntries', { worldBook: null }, baseContext());
    expect(result).toEqual([]);
  });
});
