/*
 * API-7 第一批（2026-10-24）· 15 条 ST 命令的确定性契约
 *
 * 期望值抄自 ST 1.18 参照源码（`d:/SillyTavern-release`，只读授权在案），
 * 每条注释写明出处文件与行号；消息族通过真实 runtime 上下文（`SillyTavernRuntime`）
 * 读同一份数组，不是给命令喂假 chat。
 *
 * 本批 15 条：
 *   test / is-mobile / trimtokens / count / messages / message-role / message-name /
 *   addswipe / delswipe / delname / comment / sendas / inject / flushinject / listinjects
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/st-compat-commands-chat-api7.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';
import { ST_118_COMMAND_NAMES } from '@/lib/slash-engine/st-command-catalog';
import {
  SillyTavernRuntime,
  getGlobalSillyTavernRuntime,
  setGlobalSillyTavernRuntime,
} from '@/lib/sillytavern/runtime';
import { messageManager } from '@/services/message-manager';
import { promptInjection } from '@/services/prompt-injection';

ensureSlashCommandsBootstrapped();

const BATCH = [
  'test', 'is-mobile', 'trimtokens', 'count',
  'messages', 'message-role', 'message-name',
  'addswipe', 'delswipe', 'delname', 'comment', 'sendas',
  'inject', 'flushinject', 'listinjects',
];

const run = async (input: string) => (await SlashCommandEngine.execute(input)).output;

const previousRuntime = getGlobalSillyTavernRuntime();
let currentRuntime: SillyTavernRuntime | null = null;

/** 用给定 chat 建一个 ST runtime 并挂成全局读源（与 CharacterChat 的 setContext 同型）。 */
function useChat(chat: any[]): SillyTavernRuntime {
  const runtime = new SillyTavernRuntime({
    name: 'User',
    character: { name: 'Alice', description: '' },
    chat,
    chatId: 'session-api7',
    chatMetadata: {},
  } as any);
  setGlobalSillyTavernRuntime(runtime);
  currentRuntime = runtime;
  return runtime;
}

/** ST 消息最小形状（name / mes / is_user / is_system / swipes / extra）。 */
const msg = (name: string, mes: string, extra: Record<string, unknown> = {}) => ({
  name,
  mes,
  is_user: name === 'User',
  is_system: false,
  send_date: 1,
  extra,
});

beforeEach(() => {
  useChat([msg('User', 'hi'), msg('Alice', 'hello there.')]);
  messageManager.clearMessages();
});

afterEach(() => {
  setGlobalSillyTavernRuntime(previousRuntime);
  currentRuntime = null;
  messageManager.clearMessages();
  vi.restoreAllMocks();
});

describe('API-7 第一批：命令名确实可用（不再落 Unknown command）', () => {
  it('15 条全部在 ST 1.18 权威名单里，且宿主引擎已注册', () => {
    expect(BATCH.length).toBe(15);
    for (const name of BATCH) {
      expect(ST_118_COMMAND_NAMES).toContain(name);
      expect(SlashCommandEngine.getCommand(name)).toBeTruthy();
    }
  });

  it('逐条调用都不返回 "Unknown command"', async () => {
    const samples: Record<string, string> = {
      test: '/test pattern="hi" hi',
      'is-mobile': '/is-mobile',
      trimtokens: '/trimtokens limit=100 hi there',
      count: '/count',
      messages: '/messages 0',
      'message-role': '/message-role',
      'message-name': '/message-name',
      addswipe: '/addswipe extra',
      delswipe: '/delswipe',
      delname: '/delname Nobody',
      comment: '/comment note',
      sendas: '/sendas name="Alice" text',
      inject: '/inject probe text',
      flushinject: '/flushinject',
      listinjects: '/listinjects',
    };
    for (const name of BATCH) {
      const output = await run(samples[name]);
      expect(output, `${name} 不应落 Unknown command`).not.toContain('Unknown command');
    }
  });
});

describe('test（slash-commands.js:3361-3381）', () => {
  it('命中 / 未命中分别返回 JSON 布尔', async () => {
    expect(await run('/test pattern="green" Blue house and green car')).toBe('true');
    // ST helpString 自带用例：pattern=green → true、pattern=blue → false（正文里是 Blue）
    expect(await run('/test pattern="Blue" Blue house and green car')).toBe('true');
    expect(await run('/test pattern="blue" Blue house and green car')).toBe('false');
  });

  it('支持 /pattern/flags 写法（regexFromString：utils.js:1388）', async () => {
    expect(await run('/test pattern="/GREEN/i" Blue house and green car')).toBe('true');
    expect(await run('/test pattern="/GREEN/" Blue house and green car')).toBe('false');
  });

  it('空 pattern 与非法 pattern 抛错（走引擎 Error 通道，不是空串假成功）', async () => {
    expect(await run('/test pattern=" " text')).toContain("Argument of 'pattern=' cannot be empty");
    expect(await run('/test pattern="[" text')).toContain("not a valid regular expression");
  });

  it('无未命名参数时用管道输入（与 textOf 口径一致）', async () => {
    expect(await run('/echo blue | /test pattern="blue"')).toBe('true');
  });
});

describe('is-mobile（slash-commands.js:3262；口径见实现注释）', () => {
  const stubMatchMedia = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({ matches, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
  };

  it('窄视口 true / 宽视口 false（与 Palink {{isMobile}} 同规则）', async () => {
    stubMatchMedia(true);
    expect(await run('/is-mobile')).toBe('true');
    stubMatchMedia(false);
    expect(await run('/is-mobile')).toBe('false');
  });

  it('无 matchMedia 的运行环境返回 false 而不是 undefined', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
    expect(await run('/is-mobile')).toBe('false');
  });
});

describe('trimtokens（slash-commands.js:3954-3994，估算降级分支）', () => {
  it('未超限原样返回', async () => {
    expect(await run('/trimtokens limit=100 hello world')).toBe('hello world');
  });

  it('limit ≤ 0 返回空串；无文本返回空串', async () => {
    expect(await run('/trimtokens limit=0 hello world')).toBe('');
    expect(await run('/trimtokens limit=5')).toBe('');
  });

  it('direction=end 保留前缀，direction=start 保留后缀', async () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const end = await run(`/trimtokens limit=1 direction=end ${text}`);
    const start = await run(`/trimtokens limit=1 direction=start ${text}`);
    expect(text.startsWith(end)).toBe(true);
    expect(text.endsWith(start)).toBe(true);
    expect(end.length).toBeLessThan(text.length);
    expect(start.length).toBeLessThan(text.length);
  });

  it('limit 非数字时原样返回（ST :3965-3968）', async () => {
    expect(await run('/trimtokens limit=abc hello world')).toBe('hello world');
  });
});

describe('count（extensions/token-counter/index.js:97-112）', () => {
  it('只统计非 system 消息的正文（本地估算，非 0 且与空聊天不同）', async () => {
    const twoMessages = await run('/count');
    expect(Number(twoMessages)).toBeGreaterThan(0);
    useChat([msg('Alice', 'hello there.', {}), { ...msg('Note', 'hidden note'), is_system: true }]);
    expect(await run('/count')).toBe(twoMessages);
  });

  it('空聊天返回 0', async () => {
    useChat([]);
    expect(await run('/count')).toBe('0');
  });
});

describe('messages（slash-commands.js:4151-4220）', () => {
  it('单条 / 区间；缺省不带作者名', async () => {
    expect(await run('/messages 1')).toBe('hello there.');
    expect(await run('/messages 0-1')).toBe('hi\n\nhello there.');
  });

  it('names=on 时前缀作者名', async () => {
    expect(await run('/messages names=on 1')).toBe('Alice: hello there.');
  });

  it('role 过滤：user / assistant / system（narrator）', async () => {
    useChat([
      msg('User', 'question'),
      msg('Alice', 'answer'),
      { ...msg('System', 'narrator line'), extra: { type: 'narrator' } },
    ]);
    expect(await run('/messages role=user 0-2')).toBe('question');
    expect(await run('/messages role=assistant 0-2')).toBe('answer');
    expect(await run('/messages role=system 0-2')).toBe('narrator line');
  });

  it('hidden=off 排除 system 消息（缺省 hidden=on 全收）', async () => {
    useChat([{ ...msg('Note', 'hidden'), is_system: true }, msg('Alice', 'visible')]);
    expect(await run('/messages 0-1')).toBe('hidden\n\nvisible');
    expect(await run('/messages hidden=off 0-1')).toBe('visible');
  });

  it('非法区间 warn + 空串；非法 role 抛错', async () => {
    expect(await run('/messages 5')).toBe('');
    expect(await run('/messages 1-0')).toBe('');
    expect(await run('/messages role=wizard 0')).toContain('Invalid role provided');
  });
});

describe('message-role（slash-commands.js:5820-5858）', () => {
  it('不给 role 时读取；at=-1 指向末条', async () => {
    expect(await run('/message-role')).toBe('assistant');
    expect(await run('/message-role at=-1')).toBe('assistant');
    expect(await run('/message-role at=0')).toBe('user');
  });

  it('narrator 消息报告 system', async () => {
    useChat([{ ...msg('System', 'x'), extra: { type: 'narrator' } }]);
    expect(await run('/message-role')).toBe('system');
  });

  it('给 role 时改写并返回新角色（system 落 extra.type=narrator）', async () => {
    const chat = [msg('Alice', 'hello')];
    useChat(chat);
    expect(await run('/message-role user')).toBe('user');
    expect(chat[0].is_user).toBe(true);
    expect(await run('/message-role system')).toBe('system');
    expect((chat[0].extra as any).type).toBe('narrator');
    expect(await run('/message-role assistant')).toBe('assistant');
    expect(chat[0].is_user).toBe(false);
    expect((chat[0].extra as any).type).toBeUndefined();
  });

  it('越界下标 warn + 空串', async () => {
    expect(await run('/message-role at=9')).toBe('');
  });
});

describe('message-name（slash-commands.js:5869-5915）', () => {
  it('不给 name 时读取原文', async () => {
    expect(await run('/message-name')).toBe('Alice');
    expect(await run('/message-name at=0')).toBe('User');
  });

  it('给 name 时改写并返回新名', async () => {
    const chat = [msg('Alice', 'hello')];
    useChat(chat);
    expect(await run('/message-name "Chloe"')).toBe('Chloe');
    expect(chat[0].name).toBe('Chloe');
  });
});

describe('addswipe / delswipe（slash-commands.js:4617-4675 / :4678-4685）', () => {
  it('addswipe 追加并返回新下标；switch=true 时切过去', async () => {
    const chat = [{ ...msg('Alice', 'first'), swipes: ['first'], swipe_id: 0, swipe_info: [{}] }];
    useChat(chat);
    expect(await run('/addswipe second')).toBe('1');
    expect((chat[0] as any).swipes).toEqual(['first', 'second']);
    expect((chat[0] as any).swipe_id).toBe(0);
    expect(await run('/addswipe switch=true third')).toBe('2');
    expect((chat[0] as any).swipe_id).toBe(2);
    expect((chat[0] as any).mes).toBe('third');
  });

  it('user / system 消息不接受 swipe；空文本返回空串', async () => {
    useChat([{ ...msg('User', 'mine'), swipes: ['mine'], swipe_id: 0 }]);
    expect(await run('/addswipe extra')).toBe('');
    useChat([{ ...msg('Note', 'sys'), is_system: true, swipes: ['sys'], swipe_id: 0 }]);
    expect(await run('/addswipe extra')).toBe('');
    useChat([{ ...msg('Alice', 'a'), swipes: ['a'], swipe_id: 0 }]);
    expect(await run('/addswipe')).toBe('');
  });

  it('delswipe 按 1-based 删除并返回新选中下标', async () => {
    const chat = [{ ...msg('Alice', 'one'), swipes: ['one', 'two', 'three'], swipe_id: 1, swipe_info: [{}, {}, {}] }];
    useChat(chat);
    expect(await run('/delswipe 1')).toBe('0');
    expect((chat[0] as any).swipes).toEqual(['two', 'three']);
    expect((chat[0] as any).swipe_info.length).toBe(2);
    expect((chat[0] as any).mes).toBe('two');
  });

  it('只剩一条 swipe 时拒绝删除（script.js:9295-9298）', async () => {
    useChat([{ ...msg('Alice', 'only'), swipes: ['only'], swipe_id: 0 }]);
    expect(await run('/delswipe')).toBe('');
  });
});

describe('delname（slash-commands.js:5047-5075）', () => {
  it('删掉所有同名消息，返回空串', async () => {
    const chat = [msg('Alice', 'a1'), msg('User', 'u1'), msg('Alice', 'a2')];
    useChat(chat);
    expect(await run('/delname Alice')).toBe('');
    expect(chat.map((m) => m.name)).toEqual(['User']);
  });

  it('名字缺失时 warn + 空串，一条不删', async () => {
    const chat = [msg('Alice', 'a1')];
    useChat(chat);
    expect(await run('/delname')).toBe('');
    expect(chat.length).toBe(1);
  });
});

describe('comment（slash-commands.js:6112-6157）', () => {
  it('追加注释消息：name=Note、is_system、extra.type=comment', async () => {
    const chat = [msg('Alice', 'hello')];
    useChat(chat);
    expect(await run('/comment this is a note')).toBe('');
    expect(chat.length).toBe(2);
    expect(chat[1]).toMatchObject({ name: 'Note', is_system: true, is_user: false, mes: 'this is a note' });
    expect((chat[1].extra as any).type).toBe('comment');
  });

  it('at=0 插到开头；compact=true 落 isSmallSys', async () => {
    const chat = [msg('Alice', 'hello')];
    useChat(chat);
    await run('/comment compact=true at=0 first');
    expect(chat[0].mes).toBe('first');
    expect((chat[0].extra as any).isSmallSys).toBe(true);
  });
});

describe('sendas（slash-commands.js:5928-5991，avatar/bias 有意未移植）', () => {
  it('按 name 追加 assistant 消息，缺省返回空串', async () => {
    const chat = [msg('User', 'hi')];
    useChat(chat);
    expect(await run('/sendas name="Alice" hello from alice')).toBe('');
    expect(chat.length).toBe(2);
    expect(chat[1]).toMatchObject({ name: 'Alice', is_user: false, mes: 'hello from alice' });
    expect((chat[1] as any).swipes).toEqual(['hello from alice']);
  });

  it('return=pipe 时把正文返回到管道', async () => {
    const chat = [msg('User', 'hi')];
    useChat(chat);
    expect(await run('/sendas name="Alice" return=pipe text')).toBe('text');
    expect(chat.length).toBe(2);
  });

  it('没给 name 时回落当前角色名', async () => {
    const chat = [msg('User', 'hi')];
    useChat(chat);
    await run('/sendas hi');
    expect(chat[1]?.name).toBe('Alice');
  });
});

describe('inject / flushinject / listinjects（slash-commands.js:3778-3889）', () => {
  it('inject 返回 id，并同时写 chat_metadata.script_injects 与 promptInjection', async () => {
    const runtime = useChat([msg('Alice', 'hello')]);
    expect(await run('/inject id=probe position=chat depth=2 hello world')).toBe('probe');
    const metadata = runtime.getContext().chatMetadata as any;
    expect(metadata.script_injects.probe).toMatchObject({ value: 'hello world', position: 1, depth: 2, role: 0 });
    // ST position 映射：before→2 / after→0 / chat→1 / none→-1（script.js:483-488）
    expect(promptInjection.snapshotSandbox('')['script_inject_probe']).toMatchObject({
      content: 'hello world', position: 1, depth: 2, role: 0,
    });
  });

  it('无 id 时自动生成；空正文删除同名注入', async () => {
    const runtime = useChat([]);
    const id = await run('/inject position=before text');
    expect(id.length).toBeGreaterThan(0);
    expect((runtime.getContext().chatMetadata as any).script_injects[id]).toBeTruthy();
    await run(`/inject id=${id}`);
    expect((runtime.getContext().chatMetadata as any).script_injects[id]).toBeUndefined();
  });

  it('listinjects return=object 返回 JSON；缺省返回可读文本', async () => {
    useChat([]);
    await run('/inject id=a hello');
    const json = JSON.parse(await run('/listinjects return=object'));
    expect(json.a.value).toBe('hello');
    const text = await run('/listinjects');
    expect(text).toContain('**a**');
    expect(text).toContain('IN_PROMPT');
  });

  it('flushinject 无 id 清空全部；带 id 只清该条', async () => {
    const runtime = useChat([]);
    await run('/inject id=a one');
    await run('/inject id=b two');
    expect(await run('/flushinject a')).toBe('');
    const metadata = runtime.getContext().chatMetadata as any;
    expect(metadata.script_injects.a).toBeUndefined();
    expect(metadata.script_injects.b).toBeTruthy();
    expect(promptInjection.snapshotSandbox('')['script_inject_a']?.content).toBe('');
    await run('/flushinject');
    expect(Object.keys(metadata.script_injects)).toEqual([]);
  });
});
