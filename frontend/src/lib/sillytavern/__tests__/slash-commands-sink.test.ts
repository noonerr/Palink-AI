/*
 * [S5-GDEP2 2026-10-15 / S5 2026-10-15 订正] Palink 专有 slash 命令下沉守卫（7 分支 / 9 命令名）
 *
 * 背景：Palink 专有的一批 slash 命令（/branch-create、/checkpoint-create、/checkpoint-go、
 * /chat-fork、/getchatname、/model、/profile、/preset、/profile-list）此前**只**存在于
 * utils/sillyTavernPluginRuntime.ts（大堂轨）的 runSlashCommand 里。S5 删除大堂轨后这批
 * 命令整体消失，而沙箱轨（lib/plugin-system/sandbox.ts 的 triggerSlash）与 getContext 轨
 * 是 S5 后插件触发 slash 命令的入口 —— 于是「删大堂 = 逻辑丢失」。
 * 本次把它们下沉为 lib/sillytavern/slash-commands-compat.ts 的 runPalinkSlashCommands，
 * 两轨共调同一份。
 *
 * ⚠️ [S5 2026-10-15] 大堂轨（utils/sillyTavernPluginRuntime.ts）已**整体删除**，
 *    原 C 段（大堂轨行为对照）随对照对象消失而移除；A/B/D/E 段保留并继续守卫存活链路。
 *
 * 本文件钉三件事：
 *   A. 逐命令行为：9 个命令名的返回值 / 请求体 / 事件派发 / recordStubHit 副作用
 *      （红线下沉只搬不改语义，所以这些断言就是「旧实现」的等价契约）。
 *   B. **window 哨兵反证**：在真实 window 上装假桥（__palinkBridge.runSlashCommand 与
 *      window.triggerSlash 都返回 "BRIDGE-*"），再调共享实现 / 沙箱 triggerSlash ——
 *      结果里一旦出现哨兵就说明还在读 window 桥，测试变红。
 *      并且走**插件真路径**（executePluginCode 里 var triggerSlash = __sandbox.triggerSlash）
 *      证明沙箱轨无需 window 注入即可拿到这批命令。
 *   D. 源码层：沙箱轨与 getContext 轨都接了共享实现，且共享实现自身不读 window 桥。
 *   E. getContext 轨行为（沙箱插件 getContext() 的兜底来源）。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/slash-commands-sink.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// 只 mock 后端出口：其余链路（全局 runtime / generationEngine / 事件派发）走真实实现。
vi.mock('@/services/api', () => ({
  api: {
    get: vi.fn(async () => []),
    post: (...args: unknown[]) => apiPost(...args),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    stream: vi.fn(),
  },
  getCsrfToken: vi.fn(() => 'gdep2-csrf'),
}));

import { runPalinkSlashCommands } from '@/lib/sillytavern/slash-commands-compat';
import { createSillyTavernRuntime, destroySillyTavernRuntime } from '@/lib/sillytavern/runtime';
import { generationEngine } from '@/services/generation-engine';
import { resetCompatStubStats, getCompatStubStats } from '@/lib/plugin-system/compat-stub-registry';
import { pluginSandbox } from '@/lib/plugin-system/sandbox';
import { getContext } from '@/lib/sillytavern/getContext';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'plugin-system', 'sandbox.ts'),
  'utf-8',
);
const SHARED_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'slash-commands-compat.ts'),
  'utf-8',
);
const GETCONTEXT_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'getContext.ts'),
  'utf-8',
);

/** 沙箱轨（全局 runtime）会话。 */
const SANDBOX_SID = 'sess-gdep2-sandbox';
const SANDBOX_UUID = 'uuid-gdep2-sandbox';

/** 后端调用流水（url + body），供断言请求体。 */
let calls: Array<{ url: string; body: any }> = [];
/** window 事件流水。 */
let events: Array<{ type: string; detail: any }> = [];

const W = window as any;

/** 装上 window 桥哨兵：任何读到它们的实现都会返回 BRIDGE-*（S5 后该桥已无人注入，哨兵只用于反证不依赖它）。 */
function installBridgeSentinels(): void {
  W.__palinkBridge = {
    runSlashCommand: async () => 'BRIDGE-RUN',
    saveChatMessages: async () => 'BRIDGE-SAVE',
    resolveMessageAnchor: async () => ({ branchId: 'BRIDGE-BRANCH', messageId: -999 }),
    fetchSessionMessages: async () => [{ mesid: 3, id: -999 }],
  };
  W.triggerSlash = async () => 'BRIDGE-TRIGGER';
}

beforeEach(() => {
  calls = [];
  events = [];
  apiPost.mockReset();
  apiPost.mockImplementation(async (url: string, body?: any) => {
    calls.push({ url: String(url), body });
    if (String(url).includes('/api/chats/get')) {
      return [
        { chat_metadata: { palink_branch_id: 'br-1' } },
        { mesid: 2, id: 22, mes: 'floor-2' },
        { mesid: 3, id: 33, mes: 'floor-3' },
      ];
    }
    return { ok: true };
  });
  resetCompatStubStats();
  for (const type of ['palink:switchBranch', 'palink:chatMessagesUpdated']) {
    window.addEventListener(type, ((e: Event) => {
      events.push({ type, detail: (e as CustomEvent).detail });
    }) as EventListener);
  }
  createSillyTavernRuntime({
    name: 'User',
    character: { name: 'Bot', description: '' },
    chat: [],
    chatId: SANDBOX_SID,
    name2: 'Bot',
    characterUuid: SANDBOX_UUID,
  } as any);
  generationEngine.setContext({ model: '' });
  installBridgeSentinels();
});

afterEach(() => {
  for (const type of ['palink:switchBranch', 'palink:chatMessagesUpdated']) {
    window.removeEventListener(type, (() => {}) as EventListener);
  }
  delete W.__palinkBridge;
  delete W.triggerSlash;
  delete W.__bridgeSeen;
  destroySillyTavernRuntime();
});

/** 取出某 url 相关的最后一次调用。 */
function lastCall(match: string) {
  const hit = [...calls].reverse().find(c => c.url.includes(match));
  expect(hit, `没有发出含 "${match}" 的请求，实际：${JSON.stringify(calls.map(c => c.url))}`).toBeTruthy();
  return hit!;
}

describe('A. 共享实现逐命令行为（沙箱轨口径：deps 缺省 → 全局 runtime 解析）', () => {
  it('① /getchatname 返回当前聊天文件名', async () => {
    await expect(runPalinkSlashCommands('/getchatname')).resolves.toBe(
      `palink-session-${SANDBOX_SID}.jsonl`,
    );
  });

  it('① /branch-create 3 建分支（带 parent 锚点 + 派发 palink:switchBranch）', async () => {
    await expect(runPalinkSlashCommands('/branch-create 3')).resolves.toBe('');
    const call = lastCall('/branches');
    expect(call.url).toBe(`/api/character-sessions/${SANDBOX_SID}/branches`);
    expect(call.body).toEqual({
      session_id: SANDBOX_SID,
      same_level: false,
      parent_branch_id: 'br-1',
      parent_message_id: 33,
    });
    expect(events).toContainEqual({ type: 'palink:switchBranch', detail: { sessionId: SANDBOX_SID } });
    // 反证：楼层锚点来自真实 /api/chats/get，不是哨兵桥给的 -999
    expect(lastCall('/api/chats/get').body).toEqual({
      avatar_url: `palink-${SANDBOX_UUID}.png`,
      ch_name: 'Bot',
    });
  });

  it('① /checkpoint-create mesId=2 名声 走同一分支并带 branch_name', async () => {
    await expect(runPalinkSlashCommands('/checkpoint-create mesId=2 名声')).resolves.toBe('');
    const call = lastCall('/branches');
    expect(call.body).toEqual({
      session_id: SANDBOX_SID,
      same_level: false,
      parent_branch_id: 'br-1',
      parent_message_id: 22,
      branch_name: '名声',
    });
  });

  it('② /checkpoint-go 3 切分支并带 up_to_message_id', async () => {
    await expect(runPalinkSlashCommands('/checkpoint-go 3')).resolves.toBe('');
    const call = lastCall('/switch?limit=10');
    expect(call.url).toBe(
      `/api/character-sessions/${SANDBOX_SID}/branches/br-1/switch?limit=10&up_to_message_id=33`,
    );
    expect(events).toContainEqual({
      type: 'palink:switchBranch',
      detail: { sessionId: SANDBOX_SID, branchId: 'br-1', messageId: 33 },
    });
  });

  it('③ /chat-fork 同级分叉（same_level: true）', async () => {
    await expect(runPalinkSlashCommands('/chat-fork')).resolves.toBe('');
    expect(lastCall('/branches').body).toEqual({ session_id: SANDBOX_SID, same_level: true });
  });

  it('⑤ /model 写入与读取（COT 换模型，generationEngine 共享单例）', async () => {
    await expect(runPalinkSlashCommands('/model gpt-x')).resolves.toBe('Model: gpt-x');
    expect(generationEngine._currentModel).toBe('gpt-x');
    await expect(runPalinkSlashCommands('/model')).resolves.toBe('Current model: gpt-x');
    // quiet=true 形态：只回裸模型名（Galgame 快照/恢复闭环用）
    await expect(runPalinkSlashCommands('/model quiet=true gpt-y')).resolves.toBe('gpt-y');
    expect(generationEngine._currentModel).toBe('gpt-y');
    await expect(runPalinkSlashCommands('/model quiet=true')).resolves.toBe('gpt-y');
  });

  it('⑥ /profile /preset 映射为模型（set 返空串、get 返模型名）', async () => {
    await expect(runPalinkSlashCommands('/preset gpt-z')).resolves.toBe('');
    expect(generationEngine._currentModel).toBe('gpt-z');
    await expect(runPalinkSlashCommands('/profile')).resolves.toBe('gpt-z');
    await expect(runPalinkSlashCommands('/profile quiet=true')).resolves.toBe('gpt-z');
    await expect(runPalinkSlashCommands('/profile gpt-w')).resolves.toBe('');
    expect(generationEngine._currentModel).toBe('gpt-w');
  });

  it('⑦ /profile-list 返回空串且登记 recordStubHit（降级可见，不静默吞）', async () => {
    await expect(runPalinkSlashCommands('/profile-list')).resolves.toBe('');
    const stats = getCompatStubStats();
    expect(stats.has('slash:profile-list')).toBe(true);
    expect(stats.get('slash:profile-list')!.count).toBeGreaterThan(0);
    expect(W.__palinkCompatStats.has('slash:profile-list')).toBe(true);
  });

  it('命中判据：未命中返回 null（交给调用方落引擎），会话类命令无 sessionId 时按未命中处理', async () => {
    await expect(runPalinkSlashCommands('/__no_such_command')).resolves.toBeNull();
    await expect(runPalinkSlashCommands('/unknown /unknown')).resolves.toBeNull();
    // 无会话 → 会话类命令落到"未命中"（与旧实现 falsy 判定一致）
    destroySillyTavernRuntime();
    await expect(runPalinkSlashCommands('/branch-create 3')).resolves.toBeNull();
    await expect(runPalinkSlashCommands('/chat-fork')).resolves.toBeNull();
    // /getchatname 无会话时仍算命中，返回空串（旧实现同款）
    await expect(runPalinkSlashCommands('/getchatname')).resolves.toBe('');
    createSillyTavernRuntime({
      name: 'User', character: { name: 'Bot', description: '' }, chat: [],
      chatId: SANDBOX_SID, name2: 'Bot', characterUuid: SANDBOX_UUID,
    } as any);
  });

  it('异常降级：后端抛错时返回空串（已命中语义），不把 rejection 抛给插件', async () => {
    apiPost.mockImplementation(async () => { throw new Error('net-down'); });
    await expect(runPalinkSlashCommands('/chat-fork')).resolves.toBe('');
    await expect(runPalinkSlashCommands('/getchatname')).resolves.toBe(`palink-session-${SANDBOX_SID}.jsonl`);
  });
});

describe('B. window 哨兵反证：不依赖大堂注入的 window 桥', () => {
  it('共享实现在 window 桥存在时仍走原生实现（结果不含哨兵）', async () => {
    const out = await runPalinkSlashCommands('/getchatname');
    expect(out).toBe(`palink-session-${SANDBOX_SID}.jsonl`);
    expect(String(out)).not.toContain('BRIDGE');
  });

  it('/branch-create 不用 window 桥给的假锚点（-999 / BRIDGE-BRANCH）', async () => {
    await runPalinkSlashCommands('/branch-create 3');
    const body = lastCall('/branches').body;
    expect(body.parent_message_id).toBe(33);
    expect(JSON.stringify(body)).not.toContain('BRIDGE');
  });

  it('沙箱轨插件真路径：triggerSlash("/getchatname") 拿到真实文件名而非哨兵', async () => {
    const exports = await pluginSandbox.executePluginCode(
      `module.exports = { run: function (cmd) { return triggerSlash(cmd); } };`,
      {} as any,
      '__gdep2_probe__',
    );
    const run = (exports as any).run;
    expect(typeof run).toBe('function');
    await expect(run('/getchatname')).resolves.toBe(`palink-session-${SANDBOX_SID}.jsonl`);
    await expect(run('/profile-list')).resolves.toBe('');
  });

  it('沙箱轨插件真路径：/chat-fork 真的打到分支 API（不是静默空桩）', async () => {
    const exports = await pluginSandbox.executePluginCode(
      `module.exports = { fork: function () { return triggerSlash('/chat-fork'); } };`,
      {} as any,
      '__gdep2_probe2__',
    );
    await (exports as any).fork();
    expect(lastCall('/branches').body).toEqual({ session_id: SANDBOX_SID, same_level: true });
  });

  it('沙箱轨未命中时仍落 SlashCommandEngine（原有行为未被前置层吃掉）', async () => {
    const { SlashCommandEngine } = await import('@/lib/slash-engine');
    SlashCommandEngine.register({
      name: '__gdep2_echo',
      description: 'S5-GDEP2 测试命令',
      callback: (_named: Record<string, string>, unnamed: string[]) => `engine:${unnamed[0] ?? ''}`,
    });
    try {
      const exports = await pluginSandbox.executePluginCode(
        `module.exports = { run: function (cmd) { return triggerSlash(cmd); } };`,
        {} as any,
        '__gdep2_probe3__',
      );
      await expect((exports as any).run('/__gdep2_echo tail')).resolves.toBe('engine:tail');
    } finally {
      SlashCommandEngine.unregister('__gdep2_echo');
    }
  });
});

describe('D. 源码层守卫', () => {
  /** 剥掉注释，避免"注释里提到 window 桥"被误判成代码引用。 */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('共享实现自身不读 window 桥（不得出现 __palinkBridge / window.triggerSlash）', () => {
    const code = stripComments(SHARED_SRC);
    expect(/__palinkBridge/.test(code), '共享实现不得读大堂注入的 window.__palinkBridge').toBe(false);
    expect(/window\s*\??\.\s*triggerSlash/.test(code), '共享实现不得读 window.triggerSlash').toBe(false);
  });

  it('沙箱轨 triggerSlash 前置了共享实现，且未命中才落引擎', () => {
    const code = stripComments(SANDBOX_SRC);
    expect(code).toContain('runPalinkSlashCommands(');
    expect(code).toContain('executeSlashCommandCompat(');
    expect(/\bwindow\s*\??\.\s*triggerSlash\b/.test(code), '沙箱轨不得改回读 window 桥').toBe(false);
  });

  it('[S5 2026-10-15] 大堂轨已整体删除；原 7 分支内联实现只剩共享实现一份', () => {
    // 删码守卫：S5（宽口径）把 utils/sillyTavernPluginRuntime.ts 整个删除。
    // 该文件若被"恢复"回来，说明 S5 的删除被回滚 —— 这条会红。
    expect(
      fs.existsSync(
        path.resolve(__dirname, '..', '..', '..', 'utils', 'sillyTavernPluginRuntime.ts'),
      ),
      'S5 删大堂：utils/sillyTavernPluginRuntime.ts 必须已不存在',
    ).toBe(false);
    // 原大堂内联实现的特征正则不得出现在任何存活轨里（只剩共享实现一份）
    expect(stripComments(SANDBOX_SRC)).not.toContain('/checkpoint-go\\s+(\\d+)');
    expect(stripComments(GETCONTEXT_SRC)).not.toContain('/checkpoint-go\\s+(\\d+)');
    // 防假绿：正则确实能识别出旧的大堂内联实现写法
    const oldSample = 'const m = cmd.match(/^\\/checkpoint-go\\s+(\\d+)/);';
    expect(oldSample).toContain('/checkpoint-go\\s+(\\d+)');
  });

  it('getContext 轨 triggerSlash 也前置了共享实现（S5-GDEP2 第三轨）', () => {
    const code = stripComments(GETCONTEXT_SRC);
    expect(code).toContain("import { runPalinkSlashCommands } from './slash-commands-compat'");
    expect(
      /triggerSlash:[\s\S]{0,900}?runPalinkSlashCommands\(args\[0\]\)/.test(code),
      'getContext 轨 triggerSlash 未前置共享实现（S5 后沙箱插件经 getContext() 会静默落到未知命令）',
    ).toBe(true);
    expect(code).toContain('if (palinkResult !== null) return palinkResult');
    expect(/\bwindow\s*\??\.\s*triggerSlash\b/.test(code), 'getContext 轨不得读 window 桥').toBe(false);
    // 防假绿：旧的"只走引擎"写法必须过不了上面那条正则
    const oldSample = 'triggerSlash: async (...args: any[]) => executeSlashCommandCompat(args[0]),';
    expect(/triggerSlash:[\s\S]{0,900}?runPalinkSlashCommands\(args\[0\]\)/.test(oldSample)).toBe(false);
  });
});

describe('E. getContext 轨（沙箱插件 getContext() 的兜底来源）行为', () => {
  it('getContext().triggerSlash("/getchatname") 返回真实文件名（不是未知命令降级）', async () => {
    const ctx = getContext() as any;
    await expect(ctx.triggerSlash('/getchatname')).resolves.toBe(
      `palink-session-${SANDBOX_SID}.jsonl`,
    );
  });

  it('getContext().triggerSlash("/chat-fork") 真的打到分支 API', async () => {
    const ctx = getContext() as any;
    await ctx.triggerSlash('/chat-fork');
    expect(lastCall('/branches').body).toEqual({ session_id: SANDBOX_SID, same_level: true });
  });

  it('getContext 轨不读 window 桥（哨兵不出现）', async () => {
    const ctx = getContext() as any;
    const out = await ctx.triggerSlash('/getchatname');
    expect(String(out)).not.toContain('BRIDGE');
  });

  it('getContext 轨未命中时仍落 SlashCommandEngine（原行为未被前置层吃掉）', async () => {
    const { SlashCommandEngine } = await import('@/lib/slash-engine');
    SlashCommandEngine.register({
      name: '__gdep2_ctx_echo',
      description: 'S5-GDEP2 getContext 轨测试命令',
      callback: (_named: Record<string, string>, unnamed: string[]) => `ctx-engine:${unnamed[0] ?? ''}`,
    });
    try {
      const ctx = getContext() as any;
      await expect(ctx.triggerSlash('/__gdep2_ctx_echo tail')).resolves.toBe('ctx-engine:tail');
    } finally {
      SlashCommandEngine.unregister('__gdep2_ctx_echo');
    }
  });
});