/*
 * 世界书写桥四键 —— 父侧动作契约测试（ST-BRIDGE-BOOKBIND 2026-10-20 批次A）
 *
 * 钉住的是 SmartCardCompatController 里这次新增的两个父侧动作：
 *   · deleteSmartCardWorldbook —— 帧内 deleteWorldbook / deleteLorebook 的落点
 *   · rebindSmartCardCharWorldbooks —— 帧内 rebindCharWorldbooks / setCurrentCharLorebooks 的落点
 *
 * 为什么单独立一份：帧内那条只能证明"桥过去了"，证明不了"落库对不对"。
 * 书↔角色的绑定在本仓是**两列合取**（character_id + type=='character_book'），
 * 少一列就变成"绑完读不回来"的假通道，这个错只有在父侧才看得见。
 *
 * 契约一手：
 *   worldbook.d.ts:184-190  deleteWorldbook(name) -> Promise<boolean>，失败返 false
 *   worldbook.d.ts:21-39    rebindCharWorldbooks('current', {primary, additional}) -> Promise<void>
 *   lorebook.d.ts:27-28/51-52  两个 deprecated 同义名（与本这批共用同一份父侧实现）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-bridge-bookbind-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/services/worldbookApi', () => ({
  worldbookApi: {
    list: (...args: unknown[]) => listMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const CID = 'char-under-test';
const BOOK_A = { id: 'book-a', name: '世界书A', type: 'world_book' };
const BOOK_B = { id: 'book-b', name: '世界书B', type: 'world_book' };
const BOOK_DUP = { id: 'book-dup', name: '重名书', type: 'world_book' };
const BOOK_DUP2 = { id: 'book-dup2', name: '重名书', type: 'world_book' };

async function callAction(
  actionName: string,
  context: unknown,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; result: any; error?: string }> {
  let out: { ok: boolean; result: any; error?: string } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
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
    selectedCharacterName: '测试角色',
    selectedCharacterId: CID,
    selectedSession: { id: 'session-1' },
    sessionId: 'session-1',
    wb: {},
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  updateMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({ ok: true });
});

// ============================================================
// A 删除整本世界书
// ============================================================
describe('A deleteWorldbook —— 不可逆，任何不确定都不许假成功', () => {
  it('命中唯一同名书 ⇒ success:true，且删的是那一本的 id', async () => {
    listMock.mockResolvedValue([BOOK_A, BOOK_B]);
    const res = await callAction('deleteWorldbook', baseContext(), { name: '世界书B' });
    expect(res.result).toEqual({ success: true });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(BOOK_B.id);
  });

  it('deleteLorebook 是同一个动作（deprecated 同义名，不复制实现）', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('deleteLorebook', baseContext(), { name: '世界书A' });
    expect(res.result).toEqual({ success: true });
    expect(deleteMock).toHaveBeenCalledWith(BOOK_A.id);
  });

  it('书不存在 ⇒ success:false + worldbook_not_found，不调删除', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('deleteWorldbook', baseContext(), { name: '没有这本书' });
    expect(res.result).toEqual({ success: false, error: 'worldbook_not_found' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('同名多本 ⇒ 拒绝删除（worldbook_name_ambiguous），不替调用方猜一本', async () => {
    // 删了不可逆；ST 里书名实质唯一，本仓允许重名 ⇒ 歧义必须暴露而不是取第一本。
    listMock.mockResolvedValue([BOOK_DUP, BOOK_DUP2]);
    const res = await callAction('deleteWorldbook', baseContext(), { name: '重名书' });
    expect(res.result).toEqual({ success: false, error: 'worldbook_name_ambiguous' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('没给名字 ⇒ worldbook_name_required', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('deleteWorldbook', baseContext(), {});
    expect(res.result).toEqual({ success: false, error: 'worldbook_name_required' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('列表接口报错 ⇒ worldbook_list_failed，不会退化成"当你没书"', async () => {
    listMock.mockRejectedValue(new Error('network down'));
    const res = await callAction('deleteWorldbook', baseContext(), { name: '世界书A' });
    expect(res.result).toEqual({ success: false, error: 'worldbook_list_failed' });
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// B 卡↔书绑定
// ============================================================
describe('B rebindCharWorldbooks —— primary 必须落成两列的合取', () => {
  it('绑 primary ⇒ character_id 与 type 同时写（缺 type 就变成"绑完读不回来"）', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('rebindCharWorldbooks', baseContext(), {
      characterName: 'current',
      charWorldbooks: { primary: '世界书A', additional: [] },
    });
    expect(res.result).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith(BOOK_A.id, {
      character_id: CID,
      type: 'character_book',
    });
  });

  it('setCurrentCharLorebooks 是单参同义形态（characterName 缺省补 current）', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('setCurrentCharLorebooks', baseContext(), {
      lorebooks: { primary: '世界书A' },
    });
    expect(res.result).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith(BOOK_A.id, {
      character_id: CID,
      type: 'character_book',
    });
  });

  it('非 current 角色名 ⇒ character_name_unsupported，不替别人绑书', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('rebindCharWorldbooks', baseContext(), {
      characterName: '别人的角色',
      charWorldbooks: { primary: '世界书A', additional: [] },
    });
    expect(res.result).toEqual({ success: false, error: 'character_name_unsupported' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('没有当前角色 ⇒ no_active_character，不落到"全局书"上', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('rebindCharWorldbooks', baseContext({ selectedCharacterId: null }), {
      characterName: 'current',
      charWorldbooks: { primary: '世界书A', additional: [] },
    });
    expect(res.result).toEqual({ success: false, error: 'no_active_character' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('primary 为空 ⇒ 解绑：已绑的角色书降级回 world_book 且解绑归属', async () => {
    // list 被高频调用：第一次按 primary 名查不到（空 names），第二次按角色查已有绑定
    listMock.mockResolvedValue([{ id: 'book-old', name: '旧角色书', type: 'character_book' }]);
    const res = await callAction('rebindCharWorldbooks', baseContext(), {
      characterName: 'current',
      charWorldbooks: { primary: null, additional: [] },
    });
    expect(res.result).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith('book-old', {
      character_id: null,
      type: 'world_book',
    });
  });

  it('additional 只绑归属不标 character_book（否则会跟 primary 抢 books[0]）', async () => {
    // ⚠ 这里不能用 Once 序列打桩：父侧会先跑一轮 demoteOtherCharBooks（自带一次按角色的
    //   列表查询），调用顺序一变整套 Once 就错位。改成按**查询语义**区分，与后端 SQL 同形：
    //     · type=character_book  ⇒ 该角色已绑的角色书（后端 worldbook.py:287 的同款过滤）
    //     · 不带 type            ⇒ 该用户全部书（resolveWorldbookByName 的查法）
    const OLD = { id: 'book-old', name: '旧角色书', type: 'character_book' };
    listMock.mockImplementation((params?: { character_id?: string; type?: string }) =>
      Promise.resolve(params?.type === 'character_book' ? [OLD] : [BOOK_A, BOOK_B, OLD]),
    );
    const res = await callAction('rebindCharWorldbooks', baseContext(), {
      characterName: 'current',
      charWorldbooks: { primary: '世界书A', additional: ['世界书B'] },
    });
    expect(res.result).toEqual({ success: true });
    // primary 拿到 character_book 标记
    expect(updateMock).toHaveBeenCalledWith(BOOK_A.id, {
      character_id: CID,
      type: 'character_book',
    });
    // additional 只有归属、不带标记 —— ST 里 additional 参与注入是"第二个挂载位"，
    // 本仓读侧取 books[0]，标了就会让 primary 变成看 updated_at 的轮盘赌。
    expect(updateMock).toHaveBeenCalledWith(BOOK_B.id, {
      character_id: CID,
      type: 'world_book',
    });
  });

  it('primary 名字对不上任何书 ⇒ worldbook_not_found，不静默成功', async () => {
    listMock.mockResolvedValue([BOOK_A]);
    const res = await callAction('rebindCharWorldbooks', baseContext(), {
      characterName: 'current',
      charWorldbooks: { primary: '查无此书', additional: [] },
    });
    expect(res.result).toEqual({ success: false, error: 'worldbook_not_found' });
  });
});
