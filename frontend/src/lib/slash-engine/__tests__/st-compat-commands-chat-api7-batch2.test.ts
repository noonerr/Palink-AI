/*
 * API-7 批 2A（2026-10-26）· 第二批 10 条 ST 命令的确定性契约
 *
 * 期望值抄自 ST 1.18 参照源码（`d:/SillyTavern-release`，只读授权在案），
 * 每条注释写明出处文件与行号；结构仿同目录 st-compat-commands-chat-api7.test.ts。
 *
 * 本批 10 条：
 *   getchatname / hide / unhide / sysname / cut /
 *   note / note-depth / note-frequency / note-position / persona-get
 *
 * ⚠️ 键名口径：/note 族写本仓键 author_note*（装配消费键），不是 ST 的 note_*，
 *    见 st-compat-commands-chat.ts 第二批段注释。测试直接断言这些键。
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/st-compat-commands-chat-api7-batch2.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const apiState = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (url: string) => apiState.get(url),
      put: (url: string, body: unknown) => apiState.put(url, body),
    },
  };
});

import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';
import { ST_118_COMMAND_NAMES } from '@/lib/slash-engine/st-command-catalog';
import {
  SillyTavernRuntime,
  getGlobalSillyTavernRuntime,
  setGlobalSillyTavernRuntime,
} from '@/lib/sillytavern/runtime';
import { runPalinkSlashCommands } from '@/lib/sillytavern/slash-commands-compat';
import { messageManager } from '@/services/message-manager';

ensureSlashCommandsBootstrapped();

const BATCH = [
  'getchatname', 'hide', 'unhide', 'sysname', 'cut',
  'note', 'note-depth', 'note-frequency', 'note-position', 'persona-get',
];

/** 别名 → 主名（st-command-catalog ST_118_COMMAND_ALIASES 同款键值）。 */
const ALIASES: Array<[string, string]> = [
  ['depth', 'note-depth'],
  ['freq', 'note-frequency'],
  ['note-freq', 'note-frequency'],
  ['pos', 'note-position'],
  ['note-pos', 'note-position'],
  ['persona-data', 'persona-get'],
];

const run = async (input: string) => (await SlashCommandEngine.execute(input)).output;

const previousRuntime = getGlobalSillyTavernRuntime();
let currentRuntime: SillyTavernRuntime | null = null;

/**
 * 用给定 chat 建一个 ST runtime 并挂成全局读源（与 CharacterChat 的 setContext 同型）。
 * chatMetadata 留空 = 生产形状（CharacterChat.tsx 的 stContext 不喂 chatMetadata，
 * 运行时构造器缺省 `{}`），此时写入按 P2-20 口径落 window.chat_metadata。
 */
function useChat(chat: any[], chatMetadata?: Record<string, unknown>): SillyTavernRuntime {
  const runtime = new SillyTavernRuntime({
    name: 'User',
    character: { name: 'Alice', description: '' },
    chat,
    chatId: 'session-b2',
    chatMetadata: chatMetadata ?? {},
  } as any);
  setGlobalSillyTavernRuntime(runtime);
  currentRuntime = runtime;
  return runtime;
}

/** ST 消息最小形状（与 batch1 测试同款）。 */
const msg = (name: string, mes: string, extra: Record<string, unknown> = {}) => ({
  name,
  mes,
  is_user: name === 'User',
  is_system: false,
  send_date: 1,
  extra,
});

const metadata = (): Record<string, any> => (window as any).chat_metadata ?? {};

const personaRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  name: 'Player',
  description: 'brave soul',
  avatar: '/avatars/p1.png',
  characterBindings: { 'char-uuid-1': 'char-uuid-1' },
  isDefault: false,
  personaShow: true,
  personaDescriptionPosition: 4,
  personaDescriptionDepth: 4,
  title: 'Hero',
  role: 1,
  lorebook: 'lb-1',
  ...overrides,
});

let personaRows: ReturnType<typeof personaRow>[];

beforeEach(() => {
  useChat([msg('User', 'hi'), msg('Alice', 'hello there.')]);
  messageManager.clearMessages();
  (window as any).chat_metadata = {};
  personaRows = [
    personaRow(),
    personaRow({ id: 'p-2', name: 'Admin', isDefault: true, characterBindings: {}, title: null, role: null, lorebook: null, description: '' }),
  ];
  apiState.get.mockReset();
  apiState.get.mockImplementation((url: string) => {
    if (url === '/api/personas') return Promise.resolve(personaRows);
    if (url === '/api/personas/active') return Promise.resolve({ activePersonaId: 'p-1' });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiState.put.mockReset();
  apiState.put.mockResolvedValue(undefined);
});

afterEach(() => {
  setGlobalSillyTavernRuntime(previousRuntime);
  currentRuntime = null;
  messageManager.clearMessages();
  delete (window as any).chat_metadata;
  vi.restoreAllMocks();
});

describe('API-7 批 2A：命令名确实可用（不再落 Unknown command）', () => {
  it('10 条全部在 ST 1.18 权威名单里，且宿主引擎已注册（含别名）', () => {
    expect(BATCH.length).toBe(10);
    for (const name of BATCH) {
      expect(ST_118_COMMAND_NAMES).toContain(name);
      expect(SlashCommandEngine.getCommand(name)).toBeTruthy();
    }
    for (const [alias, main] of ALIASES) {
      const command = SlashCommandEngine.getCommand(alias);
      expect(command, `别名 /${alias} 应可解析`).toBeTruthy();
      expect(command?.name).toBe(main);
    }
  });

  it('逐条调用都不返回 "Unknown command"', async () => {
    const samples: Record<string, string> = {
      getchatname: '/getchatname',
      hide: '/hide',
      unhide: '/unhide',
      sysname: '/sysname Dave',
      cut: '/cut 0',
      note: '/note probe',
      'note-depth': '/note-depth 2',
      'note-frequency': '/note-frequency 2',
      'note-position': '/note-position chat',
      'persona-get': '/persona-get',
    };
    for (const name of BATCH) {
      const output = await run(samples[name]);
      expect(output, `${name} 不应落 Unknown command`).not.toContain('Unknown command');
    }
  });
});

describe('getchatname（slash-commands.js:463-469；与三轨前置逐字同口径）', () => {
  it('返回 palink-session-<sessionId>.jsonl，与 runPalinkSlashCommands 前置逐字一致', async () => {
    expect(await run('/getchatname')).toBe('palink-session-session-b2.jsonl');
    await expect(runPalinkSlashCommands('/getchatname')).resolves.toBe(await run('/getchatname'));
  });

  it('无会话时返空串（两个轨一致）', async () => {
    setGlobalSillyTavernRuntime(null);
    expect(await run('/getchatname')).toBe('');
    await expect(runPalinkSlashCommands('/getchatname')).resolves.toBe('');
  });
});

describe('hide / unhide（slash-commands.js:1835-1879 → chats.js:147-170）', () => {
  it('缺省隐藏最后一条；返回空串', async () => {
    const chat = [msg('User', 'hi'), msg('Alice', 'hello there.')];
    useChat(chat);
    expect(await run('/hide')).toBe('');
    expect(chat[0].is_system).toBe(false);
    expect(chat[1].is_system).toBe(true);
  });

  it('range 与 name 过滤（不匹配的名字跳过）', async () => {
    const chat = [msg('User', 'hi'), msg('Alice', 'a'), msg('Alice', 'b')];
    useChat(chat);
    expect(await run('/hide 0-2')).toBe('');
    expect(chat.every((m) => m.is_system)).toBe(true);
    const chat2 = [msg('User', 'hi'), msg('Alice', 'a')];
    useChat(chat2);
    expect(await run('/hide name="Alice" 0-1')).toBe('');
    expect(chat2[0].is_system).toBe(false);
    expect(chat2[1].is_system).toBe(true);
  });

  it('unhide 复位 is_system', async () => {
    const chat = [{ ...msg('User', 'hi'), is_system: true }, msg('Alice', 'a')];
    useChat(chat);
    expect(await run('/unhide 0')).toBe('');
    expect(chat[0].is_system).toBe(false);
    expect(chat[1].is_system).toBe(false);
  });

  it('非法 range 与空聊天：warn + 空串，不抛', async () => {
    const chat = [msg('User', 'hi')];
    useChat(chat);
    expect(await run('/hide 5')).toBe('');
    expect(await run('/hide 1-0')).toBe('');
    expect(chat[0].is_system).toBe(false);
    useChat([]);
    expect(await run('/hide')).toBe('');
  });
});

describe('sysname（slash-commands.js:1397-1405 → :5734-5740）', () => {
  it('写 chat_metadata.narrator_name 并落库（PUT metadata）', async () => {
    expect(await run('/sysname Dave')).toBe('');
    expect(metadata().narrator_name).toBe('Dave');
    expect(apiState.put).toHaveBeenCalledWith(
      '/api/character-sessions/session-b2/metadata',
      expect.objectContaining({ narrator_name: 'Dave' }),
    );
  });

  it('空参重置为 System（ST 同款，每次都 save）', async () => {
    metadata().narrator_name = 'Old';
    expect(await run('/sysname')).toBe('');
    expect(metadata().narrator_name).toBe('System');
    expect(apiState.put).toHaveBeenCalledTimes(1);
  });

  it('落库失败 warn 不抛（_persistChatMetadata 同款静默）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiState.put.mockRejectedValue(new Error('network down'));
    expect(await run('/sysname Dave')).toBe('');
    expect(metadata().narrator_name).toBe('Dave');
    expect(warn).toHaveBeenCalled();
  });

  it('无会话时仍写内存 metadata，但不发 PUT', async () => {
    setGlobalSillyTavernRuntime(null);
    expect(await run('/sysname Dave')).toBe('');
    expect(metadata().narrator_name).toBe('Dave');
    expect(apiState.put).not.toHaveBeenCalled();
  });
});

describe('cut（power-user.js:4160-4174 → :2821-2862 doMesCut）', () => {
  it('单条：返回被删正文（带 \\n 后缀），消息出数组', async () => {
    const chat = [msg('User', 'hi'), msg('Alice', 'hello there.')];
    useChat(chat);
    expect(await run('/cut 1')).toBe('hello there.\n');
    expect(chat.map((m) => m.mes)).toEqual(['hi']);
  });

  it('区间：逐条先取正文再删，返回按序拼接', async () => {
    const chat = [msg('User', 'hi'), msg('Alice', 'hello there.'), msg('User', 'again')];
    useChat(chat);
    expect(await run('/cut 0-1')).toBe('hi\nhello there.\n');
    expect(chat.map((m) => m.mes)).toEqual(['again']);
  });

  it('缺参 / 越界 / 非数字：空串且不动数组', async () => {
    const chat = [msg('User', 'hi')];
    useChat(chat);
    expect(await run('/cut')).toBe('');
    expect(await run('/cut 5')).toBe('');
    expect(await run('/cut abc')).toBe('');
    expect(chat.length).toBe(1);
  });
});

describe('note 族（authors-note.js:502-560；键名用本仓 author_note*，见实现注释）', () => {
  it('/note 有参写 + 返回当前值 + 落库；无参只读', async () => {
    expect(await run('/note brave heart')).toBe('brave heart');
    expect(metadata().author_note).toBe('brave heart');
    expect(apiState.put).toHaveBeenCalledWith(
      '/api/character-sessions/session-b2/metadata',
      expect.objectContaining({ author_note: 'brave heart' }),
    );
    apiState.put.mockClear();
    expect(await run('/note')).toBe('brave heart');
    expect(apiState.put).not.toHaveBeenCalled();
  });

  it('管道经显式 {{pipe}} 进入（ST 同款，无隐式管道）', async () => {
    expect(await run('/echo piped text | /note {{pipe}}')).toBe('piped text');
    expect(metadata().author_note).toBe('piped text');
  });

  it('运行时 chatMetadata 非空时优写该引用（P2-20 口径），window 不沾', async () => {
    useChat([msg('User', 'hi')], { keep: 1 });
    expect(await run('/note inner')).toBe('inner');
    expect((currentRuntime!.getContext().chatMetadata as any).author_note).toBe('inner');
    expect(metadata().author_note).toBeUndefined();
  });

  it('note-depth：写 Math.abs(Number)；别名 depth；NaN 不写', async () => {
    expect(await run('/note-depth 3')).toBe('3');
    expect(metadata().author_note_depth).toBe(3);
    expect(await run('/depth -2')).toBe('2');
    expect(metadata().author_note_depth).toBe(2);
    expect(await run('/note-depth abc')).toBe('');
    expect(metadata().author_note_depth).toBe(2);
    expect(await run('/note-depth')).toBe('2');
  });

  it('note-frequency：别名 freq / note-freq', async () => {
    expect(await run('/note-frequency 2')).toBe('2');
    expect(await run('/freq 3')).toBe('3');
    expect(await run('/note-freq 4')).toBe('4');
    expect(metadata().author_note_frequency).toBe(4);
  });

  it('note-position：ST 字面映射 + 读侧首个匹配名（2 → before_scenario）', async () => {
    expect(await run('/note-position chat')).toBe('chat');
    expect(metadata().author_note_position).toBe(1);
    expect(await run('/pos before')).toBe('before_scenario');
    expect(metadata().author_note_position).toBe(2);
    expect(await run('/note-pos after')).toBe('after');
    expect(metadata().author_note_position).toBe(0);
    expect(await run('/note-position')).toBe('after');
  });

  it('note-position：none/inactive → -1（本仓 twin 超集），非法值不写', async () => {
    expect(await run('/note-position none')).toBe('none');
    expect(metadata().author_note_position).toBe(-1);
    expect(await run('/note-position bogus')).toBe('');
    expect(metadata().author_note_position).toBe(-1);
  });

  it('每次写都落库到会话 metadata', async () => {
    await run('/note deep');
    await run('/note-depth 5');
    await run('/note-frequency 2');
    await run('/note-position chat');
    expect(apiState.put).toHaveBeenCalledTimes(4);
    for (const call of apiState.put.mock.calls) {
      expect(call[0]).toBe('/api/character-sessions/session-b2/metadata');
    }
  });
});

describe('persona-get（personas.js:2638-2698 + :2275-2320；宿主数据源直连 api）', () => {
  it('field 十键逐字：name/description/title/position/depth/role/lorebook', async () => {
    expect(await run('/persona-get field=name')).toBe('Player');
    expect(await run('/persona-get field=description')).toBe('brave soul');
    expect(await run('/persona-get field=title')).toBe('Hero');
    expect(await run('/persona-get field=position')).toBe('4');
    expect(await run('/persona-get field=depth')).toBe('4');
    expect(await run('/persona-get field=role')).toBe('1');
    expect(await run('/persona-get field=lorebook')).toBe('lb-1');
  });

  it('field=avatar 是 persona 唯一键（ST 语义），default 是布尔串', async () => {
    expect(await run('/persona-get field=avatar')).toBe('p-1');
    expect(await run('/persona-get field=default')).toBe('false');
    expect(await run('/persona-get persona="Admin" field=default')).toBe('true');
  });

  it('field=connections 返回 character 类连接的紧凑 JSON', async () => {
    expect(await run('/persona-get field=connections')).toBe('[{"type":"character","id":"char-uuid-1"}]');
  });

  it('无 field：全量数据 pretty JSON（ST pipe 缺省）；return=object 为紧凑 JSON', async () => {
    const full = JSON.parse(await run('/persona-get'));
    expect(full).toEqual({
      avatar: 'p-1',
      name: 'Player',
      description: 'brave soul',
      title: 'Hero',
      position: 4,
      depth: 4,
      role: 1,
      lorebook: 'lb-1',
      default: false,
      connections: [{ type: 'character', id: 'char-uuid-1' }],
    });
    expect(await run('/persona-get')).toContain('\n  "name"');
    const compact = await run('/persona-get return=object');
    expect(JSON.parse(compact)).toEqual(full);
    expect(compact).not.toContain('\n');
  });

  it('persona 实参按名称 / 唯一键解析（current 缺省走 /api/personas/active）', async () => {
    expect(await run('/persona-get persona="Admin" field=name')).toBe('Admin');
    expect(await run('/persona-get persona="p-2" field=name')).toBe('Admin');
    expect(await run('/persona-get field=name')).toBe('Player');
    // current 路径才会查 /active（按名/按 id 直接从列表解析）
    expect(apiState.get).toHaveBeenCalledWith('/api/personas/active');
  });

  it('找不到 / 同名不唯一 / 无当前人设 / 后端失败：一律空串不抛', async () => {
    expect(await run('/persona-get persona="Nobody" field=name')).toBe('');
    personaRows.push(personaRow({ id: 'p-3', name: 'Dup' }), personaRow({ id: 'p-4', name: 'Dup' }));
    expect(await run('/persona-get persona="Dup" field=name')).toBe('');
    apiState.get.mockImplementation((url: string) => {
      if (url === '/api/personas') return Promise.resolve(personaRows);
      if (url === '/api/personas/active') return Promise.resolve({ activePersonaId: null });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    expect(await run('/persona-get field=name')).toBe('');
    apiState.get.mockRejectedValue(new Error('backend down'));
    expect(await run('/persona-get field=name')).toBe('');
  });

  it('未知 field 返空串；return=bogus 抛 Unknown return type（ST default 分支）；无通道类型返空串', async () => {
    expect(await run('/persona-get field=nothing')).toBe('');
    expect(await run('/persona-get return=bogus')).toContain('Error: Unknown return type: bogus');
    expect(await run('/persona-get return=none')).toBe('');
  });

  it('别名 persona-data 同主名', async () => {
    expect(await run('/persona-data field=name')).toBe('Player');
  });
});
