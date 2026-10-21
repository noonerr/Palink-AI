/*
 * 批次S · 「帧侧会话顶包」全链收口 —— 父侧动作契约测试（2026-10-21）
 *
 * 背景（主脑 2026-10-21 复核 + 本批次 S-1 逐动作清点）：
 *   `handleSmartCardCompatRequest` 原先把
 *     `sessionId: context.sessionId || payload.__palinkContext?.sessionId`
 *   合并进 requestContext。宿主当时**没有会话**时，帧可以自己塞一个**同用户**会话 id，
 *   于是「世界书绑定 / 会话改名 / generateQuietPrompt 取历史」三类动作能打到另一份对话。
 *   后端按 user_id 过滤 ⇒ 不是跨账号，但违反用户裁定「卡片只能碰自己这一份对话」。
 *
 * 本批次 S-2 收口口径（与预设面 P2 同源）：
 *   所有需要"当前会话"的动作只认**宿主构造的 `selectedSession.id`**（帧改不到它）；
 *   `__pending__` 视为"还没有会话"；不再回落 `payload.__palinkContext.sessionId`，
 *   也不再回落接口上那个可被调用方独立填写的 `context.sessionId`（已标 deprecated）。
 *
 * 覆盖的"用到会话"分支（对应报告 §S-1 表）：
 *   · createOrReplaceWorldbook / createWorldbook / setWorldbookEntries
 *   · createWorldbookEntries（共用 createOrReplaceSmartCardWorldBook）
 *   · rebindChatWorldbook / activateChatWorldbook
 *   · renameChat
 *   · generateRaw / generateQuietPrompt
 *   · 预设读类（P2 已单独覆盖，本文件只钉 getLoadedPresetName 的无会话回退不被顶包）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/s-frame-session-spoof-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
const wbListMock = vi.fn();
const wbUpdateMock = vi.fn();
const wbDeleteMock = vi.fn();
const wbGetMock = vi.fn();

vi.mock('@/services/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  invalidateCache: vi.fn(),
}));

vi.mock('@/services/worldbookApi', () => ({
  worldbookApi: {
    list: (...args: unknown[]) => wbListMock(...args),
    get: (...args: unknown[]) => wbGetMock(...args),
    update: (...args: unknown[]) => wbUpdateMock(...args),
    delete: (...args: unknown[]) => wbDeleteMock(...args),
  },
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const HOST_SESSION = 'host-session';
const FRAME_SESSION = 'frame-injected-other-session';

type CallOut = { ok: boolean; result: any; error?: string };

async function callAction(
  actionName: string,
  state: unknown,
  context: unknown,
  payload: Record<string, unknown> = {},
): Promise<CallOut> {
  let out: CallOut = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    state as never,
    context as never,
    {
      type: 'request',
      requestId: 'req-s',
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
    selectedCharacterId: 'char-1',
    selectedModel: 'model-1',
    selectedSession: { id: HOST_SESSION },
    // 与生产同形（CharacterChat.tsx 同一次调用同时给两个字段，且同源）。
    sessionId: HOST_SESSION,
    branchId: 'branch-1',
    wb: { loadSessionStatus: vi.fn(async () => undefined) },
    ...overrides,
  };
}

/** 帧侧顶包形态：宿主没有会话 + 帧在 payload 里塞一个别人的会话 id。 */
function noHostSessionContext() {
  return baseContext({ selectedSession: null, sessionId: null });
}

function frameSpoofPayload(extra: Record<string, unknown> = {}) {
  return { __palinkContext: { sessionId: FRAME_SESSION }, ...extra };
}

/** generateRaw/generateQuietPrompt 在手势闸门名单里；生产由父侧改写为已验证结果。 */
function generatePayload(extra: Record<string, unknown> = {}) {
  return { __palinkUserGesture: true, ...frameSpoofPayload(extra) };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  deleteMock.mockReset();
  wbListMock.mockReset();
  wbUpdateMock.mockReset();
  wbDeleteMock.mockReset();
  wbGetMock.mockReset();
  getMock.mockResolvedValue([]);
  wbListMock.mockResolvedValue([]);
  postMock.mockResolvedValue({ success: true, content: '模型回复' });
});

// ============================================================
// ① generateRaw / generateQuietPrompt —— 不得把帧给的会话写进请求体
// ============================================================
describe('generateRaw / generateQuietPrompt：会话 id 只认宿主 selectedSession', () => {
  function generateCall() {
    return postMock.mock.calls.find(
      (call) => call[0] === '/api/character-chat/smart-card-generate',
    );
  }

  it('反证1：宿主无会话 + 帧塞 session ⇒ generateRaw 请求体不带该 id', async () => {
    const out = await callAction(
      'generateRaw',
      { worldBook: null },
      noHostSessionContext(),
      generatePayload({ content: '续写' }),
    );
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    const call = generateCall();
    expect(call, '必须真的发出生成请求（不是被误拦）').toBeTruthy();
    expect(call?.[1].session_id).not.toBe(FRAME_SESSION);
    expect(call?.[1].session_id).toBeUndefined();
    expect(call?.[1].mode).toBe('raw');
    expect(call?.[1].include_history).toBe(false);
    expect(call?.[1].character_id).toBe('char-1');
  });

  it('反证1：宿主无会话 + 帧塞 session ⇒ generateQuietPrompt 请求体不带该 id', async () => {
    const out = await callAction(
      'generateQuietPrompt',
      { worldBook: null },
      noHostSessionContext(),
      generatePayload({ content: '静默总结' }),
    );
    expect(out.ok).toBe(true);
    const call = generateCall();
    expect(call, '必须真的发出生成请求').toBeTruthy();
    expect(call?.[1].session_id).not.toBe(FRAME_SESSION);
    expect(call?.[1].session_id).toBeUndefined();
    expect(call?.[1].mode).toBe('quiet');
    expect(call?.[1].include_history).toBe(true);
  });

  it('反证1：帧在顶层 payload.sessionId 塞 id 同样不生效', async () => {
    await callAction(
      'generateQuietPrompt',
      { worldBook: null },
      noHostSessionContext(),
      generatePayload({ content: 'x', sessionId: FRAME_SESSION }),
    );
    expect(generateCall()?.[1].session_id).toBeUndefined();
  });

  it('反证1：只给 context.sessionId（无 selectedSession）也不算宿主会话', async () => {
    // 接口上的 sessionId 字段已 deprecated：它可能被任意调用方独立填写，
    // 不能作为"宿主身份"的证据。宿主真调用点永远同时给 selectedSession。
    await callAction(
      'generateQuietPrompt',
      { worldBook: null },
      baseContext({ selectedSession: null, sessionId: FRAME_SESSION }),
      generatePayload({ content: 'x' }),
    );
    expect(generateCall()?.[1].session_id).toBeUndefined();
  });

  it('__pending__ 视为"还没有会话"，不带 session_id', async () => {
    await callAction(
      'generateQuietPrompt',
      { worldBook: null },
      baseContext({ selectedSession: { id: '__pending__' }, sessionId: '__pending__' }),
      generatePayload({ content: 'x' }),
    );
    expect(generateCall()?.[1].session_id).toBeUndefined();
  });

  it('正向：宿主有会话时请求体就是宿主那个 id（帧顶包无效）', async () => {
    const out = await callAction(
      'generateQuietPrompt',
      { worldBook: null },
      baseContext(),
      generatePayload({ content: 'x' }),
    );
    expect(out.result.success).toBe(true);
    expect(generateCall()?.[1].session_id).toBe(HOST_SESSION);
  });
});

// ============================================================
// ② renameChat —— 帧不得替宿主决定改哪一份会话的名字
// ============================================================
describe('renameChat：帧顶包不得改名到另一份会话', () => {
  it('反证2：宿主无会话 + 帧塞 session ⇒ no_active_session 且不发请求', async () => {
    const out = await callAction(
      'renameChat',
      { worldBook: null },
      noHostSessionContext(),
      frameSpoofPayload({ title: '新名字' }),
    );
    expect(out.result).toEqual({ success: false, error: 'no_active_session' });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('反证2：只给 context.sessionId（无 selectedSession）同样拒绝', async () => {
    const out = await callAction(
      'renameChat',
      { worldBook: null },
      baseContext({ selectedSession: null, sessionId: FRAME_SESSION }),
      { title: '新名字' },
    );
    expect(out.result.success).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('正向：宿主有会话 ⇒ file_name 用宿主 id（帧顶包无效）', async () => {
    postMock.mockResolvedValue({ result: 'ok' });
    const out = await callAction(
      'renameChat',
      { worldBook: null },
      baseContext(),
      frameSpoofPayload({ title: '新名字' }),
    );
    expect(out.result).toEqual({ success: true, name: '新名字' });
    expect(postMock).toHaveBeenCalledWith('/api/chats/rename-session', {
      file_name: `palink-session-${HOST_SESSION}`,
      new_name: '新名字',
      avatar_url: 'palink-char-1.png',
    });
  });
});

// ============================================================
// ③ 世界书创建/绑定族 —— 四个入口共用 createOrReplaceSmartCardWorldBook
// ============================================================
describe('世界书写路径：宿主无会话时不得绑到帧指的会话', () => {
  const ACTIONS = ['createOrReplaceWorldbook', 'createWorldbook', 'setWorldbookEntries', 'createWorldbookEntries'];
  const ENTRIES = [{ content: '一条可用条目', key: ['k'] }];

  for (const actionName of ACTIONS) {
    it(`反证2：${actionName} 宿主无会话 + 帧塞 session ⇒ 拒绝且不落任何 HTTP`, async () => {
      const out = await callAction(
        actionName,
        { worldBook: null },
        noHostSessionContext(),
        frameSpoofPayload({ name: '书', entries: ENTRIES }),
      );
      expect(out.ok).toBe(false);
      expect(getMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    });
  }

  it('正向：宿主有会话 ⇒ 世界书绑到宿主会话，绝不出现帧给的那个 id', async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/worldbooks/import') return { id: 'wb-1', name: '书' };
      return {};
    });
    const out = await callAction(
      'createWorldbook',
      { worldBook: null },
      baseContext(),
      frameSpoofPayload({ name: '书', entries: ENTRIES }),
    );
    expect(out.result.success).toBe(true);
    const urls = postMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`/api/character-sessions/${HOST_SESSION}/worldbook`);
    expect(urls.some((url) => url.indexOf(FRAME_SESSION) >= 0), '帧给的 id 绝不能进任何 URL').toBe(false);
  });
});

// ============================================================
// ④ rebindChatWorldbook / activateChatWorldbook
// ============================================================
describe('rebindChatWorldbook / activateChatWorldbook：帧顶包不得改绑别的会话', () => {
  const STATE = { worldBook: { id: 'wb-1', name: '书', entries: [] } };

  for (const actionName of ['rebindChatWorldbook', 'activateChatWorldbook']) {
    it(`反证2：${actionName} 宿主无会话 + 帧塞 session ⇒ 不发绑定请求`, async () => {
      await callAction(actionName, STATE, noHostSessionContext(), frameSpoofPayload());
      expect(postMock).not.toHaveBeenCalled();
    });
  }

  it('正向：宿主有会话 ⇒ 绑到宿主会话并刷新它的状态', async () => {
    const context = baseContext();
    const out = await callAction('rebindChatWorldbook', STATE, context, frameSpoofPayload());
    expect(out.result).toEqual({ success: true, name: '书', world_book_id: 'wb-1' });
    expect(postMock).toHaveBeenCalledWith(`/api/character-sessions/${HOST_SESSION}/worldbook`, {
      world_book_id: 'wb-1',
    });
    expect(context.wb.loadSessionStatus).toHaveBeenCalledWith(HOST_SESSION);
    expect(postMock.mock.calls.some((call) => String(call[0]).indexOf(FRAME_SESSION) >= 0)).toBe(false);
  });
});

// ============================================================
// ⑤ 预设读类（P2 已细测，这里只钉"通道彻底不存在"）
// ============================================================
describe('预设读类：__palinkContext 通道已从 dispatcher 移除', () => {
  it('宿主无会话 + 帧塞 session ⇒ getLoadedPresetName 走全局选中份，不打会话端点', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/api/prompt-manager/presets/selection') {
        return { resolved_name: '全局预设' };
      }
      return null;
    });
    const out = await callAction(
      'getLoadedPresetName',
      { worldBook: null },
      noHostSessionContext(),
      frameSpoofPayload(),
    );
    expect(out.result).toEqual({ success: true, name: '全局预设' });
    expect(
      getMock.mock.calls.some((call) => String(call[0]).indexOf(FRAME_SESSION) >= 0),
      '帧给的 id 绝不能进 URL',
    ).toBe(false);
    expect(getMock.mock.calls.some((call) => String(call[0]).indexOf('/sessions/') >= 0)).toBe(false);
  });
});
