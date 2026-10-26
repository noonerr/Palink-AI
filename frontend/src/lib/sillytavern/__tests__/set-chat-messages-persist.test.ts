/**
 * [API-3 2026-10-26] setChatMessages 落库契约（getContext 轨与沙箱轨共享实现
 * applyStChatMessages，落库逻辑在 persistStChatFloors）。
 *
 * 钉死四件事（对应台账 [P2-9] 第 3 项 / [P2-10] 修复验收）：
 *   ① 真发出了写请求（逐楼 PUT，保留主键；**不走** /api/chats/save 全删重插）
 *   ② 空读源时不发任何全量/逐楼覆盖（防把真历史抹掉）
 *   ③ 失败不返回 true（旧实现全程零网络请求却 return true 的假成功已消灭）
 *   ④ 不跨会话顶包：sessionId 只取宿主权威值 runtime.context.chatId，
 *      并以 X-Palink-Session-Id 头 + 会头 palink_session_id 双向校验
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/set-chat-messages-persist.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    stream: vi.fn(),
  },
}));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

import { applyStChatMessages } from '../getContext';
import {
  createSillyTavernRuntime,
  destroySillyTavernRuntime,
} from '../runtime';
import { messageManager } from '@/services/message-manager';
import { resetCompatStubStats, COMPAT_STUB_WINDOW_KEY } from '@/lib/plugin-system/compat-stub-registry';

/** 宿主喂入的内存 chat（与 runtime-body 同源：**不带后端主键**）。 */
const BASE_CHAT = [
  { name: 'User', mes: 'hi', is_user: true, send_date: 1000, swipes: ['hi'], swipe_id: 0 },
  { name: 'Bot', mes: 'hello', is_user: false, send_date: 2000, swipes: ['hello'], swipe_id: 0 },
];

/** /api/chats/get 回读桩：首条聊天头 + 带主键 id 的楼层（silly_tavern.py _message_to_st 形状）。 */
function dbChat() {
  return [
    { chat_metadata: { palink_session_id: 'sess-api3' } },
    { id: 201, mesid: 0, name: 'User', mes: 'hi', is_user: true, swipes: ['hi'], swipe_id: 0 },
    { id: 202, mesid: 1, name: 'Bot', mes: 'hello', is_user: false, swipes: ['hello'], swipe_id: 0 },
  ];
}

function setupRuntime(overrides?: Record<string, unknown>) {
  createSillyTavernRuntime({
    chat: BASE_CHAT.map((m) => ({ ...m })),
    chatId: 'sess-api3',
    characterUuid: 'uuid-api3',
    name2: 'Bot',
    character: { name: 'Bot', description: '' },
    characters: [],
    ...overrides,
  } as any);
}

const stubStats = (): Map<string, { count: number }> | undefined =>
  (window as any)[COMPAT_STUB_WINDOW_KEY] as Map<string, { count: number }> | undefined;

beforeEach(() => {
  resetCompatStubStats();
  messageManager.clearMessages();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.post.mockImplementation(async (url: string) =>
    (url === '/api/chats/get' ? dbChat() : {}));
  apiMock.put.mockResolvedValue({ status: 'ok' });
  apiMock.patch.mockResolvedValue({ status: 'ok' });
  setupRuntime();
});

afterEach(() => {
  destroySillyTavernRuntime();
  messageManager.clearMessages();
});

describe('① 真的发出了写请求（保主键逐楼 PUT/PATCH）', () => {
  it('★ 改一栋正文 ⇒ 只对该楼发 PUT，URL 用后端主键、体带 content/swipes', async () => {
    const ok = await applyStChatMessages([
      { name: 'User', mes: 'hi', is_user: true, swipes: ['hi'], swipe_id: 0 },
      { name: 'Bot', mes: '改后', is_user: false, swipes: ['改后'], swipe_id: 0 },
    ]);
    expect(ok).toBe(true);
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    const [url, body] = apiMock.put.mock.calls[0] as any[];
    expect(url).toBe('/api/character-sessions/sess-api3/messages/202');
    expect(body.content).toBe('改后');
    expect(body.swipes).toEqual(['改后']);
    // 写请求前先回读了权威楼层（楼层→主键映射的唯一来源）
    expect(apiMock.post).toHaveBeenCalledWith(
      '/api/chats/get',
      expect.objectContaining({ avatar_url: 'palink-uuid-api3.png' }),
      expect.objectContaining({ headers: { 'X-Palink-Session-Id': 'sess-api3' } }),
    );
    // 绝不走整包 chats/save（全删重插换主键 ⇒ 孤儿化记忆镜像，见 persistStChatFloors 注释）
    expect(apiMock.post.mock.calls.some((c: any[]) => String(c[0]).includes('chats/save'))).toBe(false);
  });

  it('未变化的楼层不发任何写（热路径防写风暴）', async () => {
    const ok = await applyStChatMessages(BASE_CHAT.map((m) => ({ ...m })));
    expect(ok).toBe(true);
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('is_hidden 变化走 PATCH 可见性端点', async () => {
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0], is_hidden: true },
      { ...BASE_CHAT[1] },
    ]);
    expect(ok).toBe(true);
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(apiMock.patch).toHaveBeenCalledTimes(1);
    const [url, body] = apiMock.patch.mock.calls[0] as any[];
    expect(url).toBe('/api/character-sessions/sess-api3/messages/201');
    expect(body.is_hidden).toBe(true);
  });

  it('COT 双版本：格式化文本写非激活 swipe ⇒ swipes 原样落库、激活槽不被覆写', async () => {
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], swipes: ['hello', '格式化'], swipe_id: 0 },
    ]);
    expect(ok).toBe(true);
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.put.mock.calls[0] as any[];
    expect(body.content).toBe('hello');
    expect(body.swipes).toEqual(['hello', '格式化']);
  });

  it('只改 mes 未同步 swipes（美化卡回写形态）⇒ 按宿主同款折叠：新正文写进激活槽再落库', async () => {
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后', swipes: ['hello'], swipe_id: 0 },
    ]);
    expect(ok).toBe(true);
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.put.mock.calls[0] as any[];
    expect(body.content).toBe('改后');
    expect(body.swipes).toEqual(['改后']);
  });
});

describe('② 空读源 gate：读不到权威 chat 数组时不发任何覆盖写', () => {
  it('★ runtime.context.chat 为空（落到 messageManager 兜底）⇒ 零网络请求 + false', async () => {
    setupRuntime({ chat: [] });
    messageManager.addMessage({ id: 'm1', name: 'User', mes: 'x', is_user: true, send_date: 1 });
    const ok = await applyStChatMessages([
      { name: 'User', mes: 'y', is_user: true },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('回读 /api/chats/get 拿不到数组 ⇒ 同样一个写请求都不发', async () => {
    apiMock.post.mockResolvedValueOnce({}); // 非数组（后端缺席形状）
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});

describe('③ 失败不返回 true（假成功已消灭）', () => {
  it('★ PUT 失败 ⇒ false + 降级桩登记', async () => {
    apiMock.put.mockRejectedValueOnce(new Error('boom'));
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(stubStats()?.has('setChatMessages:persist')).toBe(true);
  });

  it('回读请求本身抛错 ⇒ false + 留痕', async () => {
    apiMock.post.mockRejectedValueOnce(new Error('offline'));
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(stubStats()?.has('setChatMessages:persist')).toBe(true);
  });

  it('插件传截断数组（隐含删楼）⇒ 拒绝落库返回 false，不发 DELETE', async () => {
    const ok = await applyStChatMessages([{ ...BASE_CHAT[0] }]);
    expect(ok).toBe(false);
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it('mes 未改、仅把激活槽挪向格式化文本（COT 切展示保原文）⇒ 保主键通道不写这楼，如实 false', async () => {
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: 'hello', swipes: ['格式化', 'hello'], swipe_id: 0 },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(stubStats()?.has('setChatMessages:persist')).toBe(true);
  });

  it('落库全部成功时**不**登记降级桩（口径：桩只代表缺口）', async () => {
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(true);
    expect(stubStats()?.has('setChatMessages:persist') ?? false).toBe(false);
  });
});

describe('④ 不跨会话顶包：sessionId 取宿主权威值', () => {
  it('★ chatId 为空 ⇒ 放弃落库（绝不退化为 avatar 推断）', async () => {
    setupRuntime({ chatId: '' });
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('characterUuid 缺失（角色定位不可靠）⇒ 同样放弃', async () => {
    setupRuntime({ characterUuid: '' });
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('回读会头声明的 palink_session_id 与宿主 chatId 不一致 ⇒ 中止，不发任何写', async () => {
    apiMock.post.mockImplementation(async (url: string) => {
      if (url !== '/api/chats/get') return {};
      const rows = dbChat();
      (rows[0] as any).chat_metadata.palink_session_id = 'sess-OTHER';
      return rows;
    });
    const ok = await applyStChatMessages([
      { ...BASE_CHAT[0] },
      { ...BASE_CHAT[1], mes: '改后' },
    ]);
    expect(ok).toBe(false);
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});
