/*
 * [S5-GDEP1 2026-10-15] 沙箱轨反向依赖解耦守卫
 *
 * 背景：getContext.ts 的 triggerSlash / getChatMessages / setChatMessages
 * 与 sandbox.ts 的 triggerSlash / setChatMessages 此前都委托
 * utils/sillyTavernPluginRuntime.ts（大堂轨）注入的 window 同名桥。
 * 大堂轨在 S5 删除后 window 桥消失 ⇒ 这些 API 会静默降级为空值。
 *
 * 本文件用两条互补的守卫钉住"已解耦"：
 *   A. 行为层：故意在 window 上装**哨兵**（返回 "BRIDGE-*" 的假桥），
 *      再调用上述 API —— 若结果里出现哨兵值，说明仍在读 window 桥，测试变红。
 *   B. 源码层：sandbox.ts / getContext.ts 的**代码文本**（剥掉注释后）
 *      不得再出现 window.triggerSlash / window.getChatMessages /
 *      window.setChatMessages 读取。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/sandbox-dep-decouple.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// [API-3 2026-10-26] applyStChatMessages 已接真落库（逐楼 PUT/PATCH + /api/chats/get
// 回读）。本文件是"解耦"守卫，不测网络细节（落库契约见 set-chat-messages-persist.test.ts），
// 故把 @/services/api 的传输方法替换为可控桩；其余导出保留真实模块。
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

import {
  getContext,
  selectStChatMessages,
  applyStChatMessages,
  executeSlashCommandCompat,
} from '@/lib/sillytavern/getContext';
import {
  createSillyTavernRuntime,
  destroySillyTavernRuntime,
  getGlobalSillyTavernRuntime,
} from '@/lib/sillytavern/runtime';
import { messageManager } from '@/services/message-manager';
import { SlashCommandEngine } from '@/lib/slash-engine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GETCONTEXT_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'getContext.ts'), 'utf-8');
const SANDBOX_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'plugin-system', 'sandbox.ts'),
  'utf-8',
);

/** 剥掉行注释与块注释，避免"注释里提到 window.xxx"被误判成代码引用。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** window 桥读取模式（只针对本次解耦的三个 API）。 */
const BRIDGE_READ_RE = /\b(?:window|w)\??\.(?:triggerSlash|getChatMessages|setChatMessages)\b/;

const BASE_CHAT = [
  { name: 'User', mes: 'hi', is_user: true, send_date: 1000, swipe_id: 0 },
  { name: 'Bot', mes: 'hello', is_user: false, send_date: 2000, swipes: ['hello'], swipe_id: 0 },
  { name: 'Bot', mes: 'bye', is_user: false, send_date: 3000, swipes: ['bye'], swipe_id: 0 },
];

// 后端 /api/chats/get 的权威楼层回读桩（首条是聊天头，其余带主键 id）。
const DB_CHAT_WITH_IDS = [
  { chat_metadata: { palink_session_id: 'sess-s5dep' } },
  { id: 101, mesid: 0, name: 'User', mes: 'hi', is_user: true, swipes: ['hi'], swipe_id: 0 },
  { id: 102, mesid: 1, name: 'Bot', mes: 'hello', is_user: false, swipes: ['hello'], swipe_id: 0 },
  { id: 103, mesid: 2, name: 'Bot', mes: 'bye', is_user: false, swipes: ['bye'], swipe_id: 0 },
];

const W = window as any;

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.post.mockImplementation(async (url: string) =>
    (url === '/api/chats/get' ? DB_CHAT_WITH_IDS.map((x) => ({ ...x })) : {}));
  apiMock.put.mockResolvedValue({ status: 'ok' });
  apiMock.patch.mockResolvedValue({ status: 'ok' });
  apiMock.delete.mockResolvedValue({ status: 'ok' });
  messageManager.clearMessages();
  createSillyTavernRuntime({
    chat: BASE_CHAT.map(m => ({ ...m })),
    chatId: 'sess-s5dep',
    // [API-3] 落库只认宿主权威标识（chatId + characterUuid），测试给出完整对
    characterUuid: 'uuid-s5dep',
    name2: 'Bot',
    character: { name: 'Bot', description: '' },
    characters: [],
  } as any);
  // 哨兵：模拟"大堂轨还活着"时注入的 window 桥。已解耦的实现不得读到它们。
  W.triggerSlash = () => 'BRIDGE-TRIGGER';
  W.getChatMessages = () => ['BRIDGE-GET'];
  W.__bridgeSetCalled = false;
  W.setChatMessages = () => {
    W.__bridgeSetCalled = true;
    return 'BRIDGE-SET';
  };
});

afterEach(() => {
  delete W.triggerSlash;
  delete W.getChatMessages;
  delete W.setChatMessages;
  delete W.__bridgeSetCalled;
  messageManager.clearMessages();
  destroySillyTavernRuntime();
});

describe('A. 行为层：三个 API 在 window 桥存在时也不读它', () => {
  it('getChatMessages 走原生 chat 源（ST 语义：id=-1 取末条）', () => {
    const ctx = getContext() as any;
    const last = ctx.getChatMessages(-1);
    expect(Array.isArray(last)).toBe(true);
    expect(last.length).toBe(1);
    expect(last[0].mes).toBe('bye');
    // 输出形状：message 别名 + swipe_id 兜底 0（大堂桥同款）
    expect(last[0].message).toBe('bye');
    expect(last[0].swipe_id).toBe(0);
    // 反证：没有吃到 window 桥哨兵
    expect(last).not.toContain('BRIDGE-GET');
  });

  it('getChatMessages 支持下标 / 全量 / role=assistant 过滤 / includeSwipes', () => {
    const ctx = getContext() as any;
    expect(ctx.getChatMessages(0)[0].mes).toBe('hi');
    expect(ctx.getChatMessages().length).toBe(3);
    const assistantOnly = ctx.getChatMessages(-1, { role: 'assistant' });
    expect(assistantOnly.length).toBe(1);
    expect(assistantOnly[0].is_user).toBe(false);
    const withSwipes = ctx.getChatMessages(1, { includeSwipes: true });
    expect(withSwipes[0].swipes).toEqual(['hello']);
    // 越界下标 → 空数组（与 ST/大堂桥同口径，不是全量）
    expect(ctx.getChatMessages(99)).toEqual([]);
  });

  it('triggerSlash 真的执行 SlashCommandEngine（且不读 window 桥）', async () => {
    SlashCommandEngine.register({
      name: '__s5dep_echo',
      description: 'S5-GDEP1 测试命令',
      callback: (_named: Record<string, string>, unnamed: string[]) => String(unnamed[0] ?? ''),
    });
    try {
      const ctx = getContext() as any;
      const out = await ctx.triggerSlash('/__s5dep_echo dep-ok');
      expect(out).toBe('dep-ok');
      // 反证：没有吃到 window 桥哨兵
      expect(out).not.toBe('BRIDGE-TRIGGER');
    } finally {
      SlashCommandEngine.unregister('__s5dep_echo');
    }
  });

  it('executeSlashCommandCompat 取 CommandResult.output（不是 "[object Object]"）', async () => {
    SlashCommandEngine.register({
      name: '__s5dep_raw',
      description: 'S5-GDEP1 测试命令',
      callback: () => 'raw-ok',
    });
    try {
      await expect(executeSlashCommandCompat('/__s5dep_raw')).resolves.toBe('raw-ok');
      await expect(executeSlashCommandCompat('')).resolves.toBe('');
    } finally {
      SlashCommandEngine.unregister('__s5dep_raw');
    }
  });

  it('setChatMessages 写原生 runtime.context.chat（且不读 window 桥）并真发落库 PUT', async () => {
    const ctx = getContext() as any;
    const ok = await ctx.setChatMessages([
      { name: 'User', mes: 'a', is_user: true, swipe_id: 0 },
      { name: 'Bot', mes: 'b', is_user: false, swipes: ['b'], swipe_id: 0 },
      { name: 'Bot', mes: 'bye', is_user: false, swipes: ['bye'], swipe_id: 0 },
    ]);
    // [API-3] true 现在意味着"落库请求真的写成了"（api 桩恒成功），不再是内存假成功
    expect(ok).toBe(true);
    // 反证：没有吃到 window 桥哨兵
    expect(W.__bridgeSetCalled).toBe(false);

    const rt = getGlobalSillyTavernRuntime() as any;
    expect(rt.context.chat.length).toBe(3);
    expect(rt.context.chat[1].mes).toBe('b');
    // 下一次 getContext() 立即读到新值（无需等 React 重渲染）
    expect((getContext() as any).getChatMessages(-1)[0].mes).toBe('bye');
    // [API-3] 变化的两楼各发一次保主键 PUT；未变的那楼（103）不得重写
    expect(apiMock.put).toHaveBeenCalledTimes(2);
    const urls = apiMock.put.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls).toContain('/api/character-sessions/sess-s5dep/messages/101');
    expect(urls).toContain('/api/character-sessions/sess-s5dep/messages/102');
    expect(urls).not.toContain('/api/character-sessions/sess-s5dep/messages/103');
    // 落库绝不走 /api/chats/save 整包覆盖（全删重插换主键，见 getContext 注释）
    expect(apiMock.post.mock.calls.every((c: any[]) => !String(c[0]).includes('chats/save'))).toBe(true);
  });

  it('setChatMessages 支持部分更新形态 [{message_id, swipes, swipe_id}]（COT：格式化写非激活槽可落库）', async () => {
    const ctx = getContext() as any;
    await ctx.setChatMessages([
      { name: 'User', mes: 'a', is_user: true, swipe_id: 0 },
      { name: 'Bot', mes: 'b', is_user: false, swipes: ['b'], swipe_id: 0 },
      { name: 'Bot', mes: 'bye', is_user: false, swipes: ['bye'], swipe_id: 0 },
    ]);
    apiMock.put.mockClear();
    // 格式化文本写入**非激活**槽（swipe_id=0 仍指向原文槽）⇒ 双版本可保键落库
    const ok = await ctx.setChatMessages([{ message_id: 1, swipes: ['b', '格式化'], swipe_id: 0 }]);
    expect(ok).toBe(true);

    const rt = getGlobalSillyTavernRuntime() as any;
    expect(rt.context.chat.length).toBe(3);
    expect(rt.context.chat[1].swipes).toEqual(['b', '格式化']);
    expect(rt.context.chat[1].swipe_id).toBe(0);
    // 正文不得被部分更新清掉
    expect(rt.context.chat[1].mes).toBe('b');
    expect(W.__bridgeSetCalled).toBe(false);
    // 真的 PUT 了这一楼的主键 102，且带着完整 swipes（激活槽=content，非激活槽原样）
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.put.mock.calls[0] as any[];
    expect(body.swipes).toEqual(['b', '格式化']);
    expect(body.content).toBe('b');
  });

  it('setChatMessages 在 messageManager 为读源时用 add/update/delete 组合写入（且不落库）', async () => {
    // 构造"无 runtime chat"场景（messageManager 即读源）
    createSillyTavernRuntime({ chat: [], chatId: 'sess-mm', character: { name: 'Bot', description: '' } } as any);
    messageManager.addMessage({ id: 'm1', name: 'User', mes: 'old', is_user: true, send_date: 1 });

    const ok1 = await applyStChatMessages([
      { name: 'User', mes: 'new', is_user: true },
      { name: 'Bot', mes: 'reply', is_user: false },
    ]);
    // [API-3 空读源 gate] runtime chat 为空 ⇒ 权威历史读不到，**一律不发写请求**
    //（旧大堂桥时代整包 chats/save 会清空会话；逐楼路线同样禁止错对齐写）
    expect(ok1).toBe(false);
    expect(apiMock.post.mock.calls.every((c: any[]) => String(c[0]) !== '/api/chats/get')).toBe(true);
    expect(apiMock.put).not.toHaveBeenCalled();

    expect(messageManager.messages.length).toBe(2);
    expect(messageManager.messages[0].id).toBe('m1'); // 同下标复用原 id（update 而非重建）
    expect(messageManager.messages[0].mes).toBe('new');
    expect(messageManager.messages[1].mes).toBe('reply');

    // 缩减：写回 1 条 → 多出的被 delete
    const ok2 = await applyStChatMessages([{ name: 'User', mes: 'only', is_user: true }]);
    expect(ok2).toBe(false); // 同上：空读源不落库
    expect(messageManager.messages.length).toBe(1);
    expect(messageManager.messages[0].mes).toBe('only');
  });

  it('setChatMessages 落库不完整时登记降级桩（不再是"每会话必现"的假成功留痕）', async () => {
    // [API-3] 语义反转：内存写 + 落库成功 ⇒ **不**登记；本次用"楼层数不一致"
    // （插件传入截断数组，隐含删楼意图，保主键路线拒绝落库）构造不完整路径。
    const ok = await applyStChatMessages([{ name: 'User', mes: 'x', is_user: true }]);
    expect(ok).toBe(false);
    const stats = W.__palinkCompatStats as Map<string, { count: number }> | undefined;
    expect(stats).toBeDefined();
    expect(stats!.has('setChatMessages:persist')).toBe(true);
    expect(stats!.get('setChatMessages:persist')!.count).toBeGreaterThan(0);
  });

  it('selectStChatMessages 无入参时自行解析读源（不依赖 window）', () => {
    const list = selectStChatMessages(null, -1);
    expect(list.length).toBe(1);
    expect(list[0].mes).toBe('bye');
  });
});

describe('B. 源码层：两轨代码里不得再出现三个 API 的 window 桥读取', () => {
  it('sandbox.ts（剥注释后）不再读 window 桥，且已接共享实现', () => {
    const code = stripComments(SANDBOX_SRC);
    expect(BRIDGE_READ_RE.test(code), 'sandbox.ts 仍在读 window 桥').toBe(false);
    expect(code).toContain('executeSlashCommandCompat(');
    expect(code).toContain('applyStChatMessages(');
  });

  it('getContext.ts（剥注释后）不再读 window 桥', () => {
    const code = stripComments(GETCONTEXT_SRC);
    expect(BRIDGE_READ_RE.test(code), 'getContext.ts 仍在读 window 桥').toBe(false);
    expect(code).toContain('executeSlashCommandCompat(args[0])');
    expect(code).toContain('selectStChatMessages(chat, id, opts)');
  });

  it('守卫自身有效：正则能识别出旧实现文本（防假绿）', () => {
    expect(BRIDGE_READ_RE.test('const w = window as any; w.triggerSlash(cmd);')).toBe(true);
    expect(BRIDGE_READ_RE.test('if (typeof w?.getChatMessages === "function") {}')).toBe(true);
    expect(BRIDGE_READ_RE.test('window.setChatMessages = function(){}')).toBe(true);
  });
});
