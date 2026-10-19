/*
 * 包H 契约测试 —— TavernHelper 134 权威键广度（2026-10-18）
 *
 * 交接单：docs/_active/HANDOFF_提示词_包H_TavernHelper广度_2026-10-18.md
 * 报告：docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md
 *
 * 分母从 fixture 来，不手数：
 *   fixtures/th134-names.json 由下面这条命令生成（写在 fixture 的 _generated_by 字段里）：
 *   grep -rhoE "readonly [a-zA-Z_$][a-zA-Z0-9_$]*[?]?\s*:" \
 *     st-plugins/third-party/JS-Slash-Runner-main/@types/function/ \
 *     | sed -E 's/readonly //;s/[?]?\s*:$//' | sort -u
 *
 * 求值的是 part-07 里 **>>> H-TH134 FAMILY BEGIN/END 之间的真源码**（与
 * lorebook-family-contract.test.ts 同一套口径：切真源码 + new Function 执行 + 断言行为），
 * 期望值逐条写明 ST 出处（st-plugins/third-party/JS-Slash-Runner-main/src/function/*.ts）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
// [包L 2026-10-18] 两个载体各按语义取用：
//   · SRC     = 求值后产物（生产 iframe 逐字节同源）⇒ new Function 执行断言一律用它；
//   · SRC_RAW = 未求值源码文本 ⇒ 只用于「H 段源码里一个裸反斜杠都没有」这类
//     **针对源码写法本身**的纪律断言（该断言判的就是「有没有会被模板求值吃掉的转义」）。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC, COMPAT_V2_RUNTIME_SOURCE as SRC_RAW } from './compat-v2-runtime-source';

const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/__tests__/fixtures/th134-names.json'), 'utf8'),
) as { _count: number; names: string[] };
const TH134: string[] = FIXTURE.names;

const BEGIN = '>>> H-TH134 FAMILY BEGIN';
const END = '<<< H-TH134 FAMILY END';

/** 行尾归一：源文件 CRLF / 模板求值产物 LF，两者只差行尾时不应判为语义差异。 */
const flatNewlines = (s: string) => s
  .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10))
  .split(String.fromCharCode(13)).join('');

function sliceRegion(src: string): string {
  const begin = src.indexOf(BEGIN);
  expect(begin, 'missing ' + BEGIN).toBeGreaterThan(-1);
  const end = src.indexOf(END);
  expect(end, 'missing ' + END).toBeGreaterThan(begin);
  return src.slice(src.indexOf('\n', begin) + 1, src.lastIndexOf('\n', end));
}

/** 切出对象字面量的顶层键名（4 空格缩进那一层，与 part-07 既有写法一致）。 */
function topLevelKeys(src: string, objectName: string): string[] {
  const start = src.indexOf('const ' + objectName + ' = {');
  expect(start, 'missing object: ' + objectName).toBeGreaterThan(-1);
  const stop = src.indexOf('\n  };', start);
  const block = src.slice(start, stop);
  return Array.from(block.matchAll(/^    ([A-Za-z_$][A-Za-z0-9_$]*):/gm)).map((m) => m[1]);
}

interface Stub {
  globals?: Record<string, unknown>;
  parentResult?: unknown;
  chat?: Record<string, unknown>;
  global?: Record<string, unknown>;
  local?: Record<string, unknown>;
  characters?: Array<Record<string, unknown>>;
  lastMessageId?: number;
}

/**
 * 造一个"帧内环境"：window 上的既有实现 + 三个变量表 + ctx + compatChat。
 * ⚠️ requestParent 的返回形状照抄 v2 真机形状（SillyTavernCompatRuntime.ts:4659 的
 *    { ok: true, ...data.result }），不照抄自己的假设 —— 见 MEMORY.md「帧内两套 requestParent」。
 */
function buildFrame(stub: Stub = {}) {
  const BACKSLASH = String.fromCharCode(92);
  const chatStore: Record<string, unknown> = stub.chat ?? { 华恋: { 好感度: 5 }, 列表: [1, 2] };
  const globalStore: Record<string, unknown> = stub.global ?? { 全局: 'g' };
  const localStore: Record<string, unknown> = stub.local ?? { 局部: 'l' };
  const persist = vi.fn();
  const events: string[] = [];
  const emitCompatEvent = vi.fn((name: string) => { events.push(name); });
  const post = vi.fn();
  const requestParent = vi.fn(async () => stub.parentResult ?? { ok: true, success: true });
  const compatChat: Array<Record<string, unknown>> = [
    { mesid: 0, mes: '第一条', name: '露缇雅' },
    { mesid: 1, mes: '第二条', name: '露缇雅' },
  ];
  const ctx = { characterName: '露缇雅', characterId: 'lutiya', sessionId: '42', messageId: 1, userName: '我' };
  const win: Record<string, unknown> = {
    eventSource: { on: vi.fn(), once: vi.fn(), emit: vi.fn() },
    getContext: () => ({ characters: stub.characters ?? [{ name: '露缇雅', avatar: 'lutiya.png', data: { name: '露缇雅', greeting: '你好' } }] }),
    getLastMessageId: () => (stub.lastMessageId === undefined ? 1 : stub.lastMessageId),
    messageFormatting: vi.fn((mes: string) => '<p>' + mes + '</p>'),
    getWorldbookNames: vi.fn(() => ['角色世界书', '全局书']),
    getGlobalWorldbookNames: vi.fn(() => ['全局书']),
    rebindGlobalWorldbooks: vi.fn(),
    getLorebookEntries: vi.fn(async () => [{ comment: 'a' }]),
    getLorebookSettings: vi.fn(() => ({ scan_depth: 2 })),
    setLorebookSettings: vi.fn(),
    getCharLorebooks: vi.fn(() => ({ primary: '角色世界书', additional: [] })),
    getCurrentCharPrimaryLorebook: vi.fn(() => '角色世界书'),
    createWorldbook: vi.fn(async () => true),
    createWorldbookEntries: vi.fn(async () => ({ worldbook: [], new_entries: [] })),
    deleteWorldbookEntries: vi.fn(async () => ({ worldbook: [], deleted_entries: [] })),
    setWorldbookEntries: vi.fn(async () => ({ success: true })),
    createOrReplaceWorldbook: vi.fn(async () => true),
    rebindChatWorldbook: vi.fn(async () => ({ success: true })),
    reloadCurrentChat: vi.fn(async () => true),
    substituteParamsExtended: vi.fn((text: string) => String(text).replace('{{char}}', '露缇雅')),
    triggerSlash: vi.fn(async () => 'slash-result'),
    getTavernVersion: vi.fn(() => '1.18.0'),
    getTavernHelperVersion: vi.fn(() => '5.9.0'),
    setChatMessage: vi.fn(async () => true),
    addOneMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    ...stub.globals,
  };
  const deleteByPath = (target: Record<string, unknown>, path: string) => {
    const parts = String(path || '').split('.').filter(Boolean);
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = cursor[parts[i]];
      if (!next || typeof next !== 'object') return false;
      cursor = next as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (!last || !Object.prototype.hasOwnProperty.call(cursor, last)) return false;
    delete cursor[last];
    return true;
  };
  const factory = new Function(
    'window', 'ctx', 'post', 'requestParent', 'compatChat',
    'chatVariableStore', 'globalVariableStore', 'localVariableStore',
    'persistVariableStores', 'deleteByPath', 'emitCompatEvent', 'regexBackslashCompat',
    sliceRegion(SRC) + '\nreturn tavernHelperTh134Compat;',
  );
  const th = factory(
    win, ctx, post, requestParent, compatChat,
    chatStore, globalStore, localStore,
    persist, deleteByPath, emitCompatEvent, BACKSLASH,
  ) as Record<string, any>;
  return { th, win, ctx, post, requestParent, persist, compatChat, chatStore, globalStore, localStore, events };
}

// ============================================================
// A 分母与"不许自发明名字"
// ============================================================
describe('A fixture 与注册口径', () => {
  it('fixture 是 134 个唯一键，且写明生成命令', () => {
    expect(TH134).toHaveLength(134);
    expect(new Set(TH134).size).toBe(134);
    expect(FIXTURE._count).toBe(134);
    const meta = readFileSync(join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/__tests__/fixtures/th134-names.json'), 'utf8');
    expect(meta).toContain('JS-Slash-Runner-main/@types/function');
  });

  it('H 段注册的每个键都在 134 权威表里（禁止自发明名字）', () => {
    const keys = topLevelKeys(SRC, 'tavernHelperTh134Compat');
    expect(keys.length).toBeGreaterThanOrEqual(40);
    expect(keys.filter((k) => TH134.indexOf(k) < 0)).toEqual([]);
  });

  it('帧内 TavernHelper 对 134 的命中 ≥ 55（改前真机实测只有 13）', () => {
    const compat = topLevelKeys(SRC, 'tavernHelperCompat');
    const extra = topLevelKeys(SRC, 'tavernHelperTh134Compat');
    const legacyMirror = Array.from(
      readFileSync(join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim-parts/part-b.ts'), 'utf8')
        .matchAll(/^    ([A-Za-z_$][A-Za-z0-9_$]*): window\.TavernHelper/gm),
    ).map((m) => m[1]);
    const union = new Set([...compat, ...extra, ...legacyMirror]);
    const hit = TH134.filter((n) => union.has(n));
    expect(hit.length).toBeGreaterThanOrEqual(55);
    // 反证锚点：H 段被摘掉时命中数必须掉下来 —— 这条断言就是"改坏必红"的落点。
    const withoutH = new Set([...compat, ...legacyMirror]);
    expect(TH134.filter((n) => withoutH.has(n)).length).toBeLessThan(20);
  });

  it('H 段源码里一个裸反斜杠都没有（模板串求值会把反斜杠d变成d；包H 因此只用 regexBackslashCompat 与纯字符串操作）', () => {
    // 这条判的是**源码写法本身** —— 区域里只要出现单反斜杠，模板求值就会把它吞掉，
    // 所以必须用未求值载体 SRC_RAW（换成求值后产物这条就失去意义了）。
    const region = sliceRegion(SRC_RAW);
    const bs = String.fromCharCode(92);
    expect(region.split('\n').filter((line) => line.indexOf(bs) >= 0)).toEqual([]);
    expect(region.indexOf('regexBackslashCompat')).toBeGreaterThan(-1);
    // 推论并实测：无裸反斜杠 ⇒ 该区域求值前后逐字节一致 ⇒ 本文件的 new Function 行为
    // 断言与生产 iframe 同语义（包L 的假绿这一类在这里不成立）。
    // 唯一允许的差别是行尾：源文件是 CRLF，而模板求值按 ECMAScript 规范把 CR/CRLF 归一成
    // LF —— 与 JS 语义无关，故比对前先做行尾归一，否则会出现「只差一个回车」的假阴性。
    expect(flatNewlines(sliceRegion(SRC))).toBe(flatNewlines(region));
  });

  it('D 类键一个都没注册（假实现红线；名单逐条来自报告 §3 分类全表）', () => {
    const registered = new Set(topLevelKeys(SRC, 'tavernHelperTh134Compat'));
    // ⚠️ 2026-10-20 包AA C 改判：'registerMacroLike' 已从本 D 名单移出（D 76→75、C 45→46）。
    //   移出**不是**为了凑绿这条守卫，而是底层能力当天才真的有了：
    //   ① 成员形态一手依据：st-plugins/third-party/JS-Slash-Runner-main/@types/function/index.d.ts:98
    //      （`readonly registerMacroLike` 就写在 TavernHelper 的成员清单里，与 deleteLorebook 同列）；
    //   ② 真实实现：runtime-body/part-03.ts 的 registerMacroLikeCompat（主脑独立复跑 10/10 绿：
    //      注册后对正文生效、返回 { unregister }、同 source+flags 去重、注销后失效、与 {{}} 宏先后顺序），
    //      帧内成员键由 part-07.ts 的 th134Bridge('registerMacroLike') 桥到**同一个**窗口全局实现。
    //   台账同步：docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md（订正段）、
    //   docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2 macro_register 行。
    const forbidden = [
      'getPreset', 'setPreset', 'loadPreset', 'getLoadedPresetName', 'builtin', 'default_preset',
      'createCharacter', 'deleteCharacter', 'replaceCharacter', 'importRawCharacter', 'RawCharacter',
      'getPersona', 'createPersona', 'getCurrentPersonaId',
      'playAudio', 'getAudioList', 'getAudioSettings',
      'installExtension', 'isInstalledExtension', 'isAdmin', 'getTavernHelperExtensionId',
      'injectPrompts', 'uninjectPrompts', 'deleteWorldbook', 'deleteLorebook',
      'retrieveDisplayedMessage', 'stopGenerationById', 'getModelList',
      'getAllEnabledScriptButtons', 'rotateChatMessages', 'importRawWorldbook', 'importRawChat',
      'setCurrentCharLorebooks', 'rebindCharWorldbooks', 'getTavernRegexes', 'formatAsTavernRegexedString',
    ];
    expect(forbidden.filter((n) => registered.has(n))).toEqual([]);
    // 正向锚点（配套上面那条改判）：registerMacroLike 确实进了成员清单，且桥不是空壳。
    expect(registered.has('registerMacroLike')).toBe(true);
    expect(SRC.indexOf("registerMacroLike: th134Bridge('registerMacroLike')")).toBeGreaterThan(-1);
    // 而且 proxy 也不会为它们造假存在性：H 段没有往 tavernHelperCompat 里塞同名键
    ['getPreset', 'createCharacter', 'playAudio', 'getModelList'].forEach((n) => {
      expect(topLevelKeys(SRC, 'tavernHelperCompat')).not.toContain(n);
    });
  });
});

// ============================================================
// B 变量族（variables.ts 的形状）
// ============================================================
describe('B 变量族', () => {
  it('deleteVariable 返回 { variables, delete_occurred }，不是布尔（variables.d.ts:281）', () => {
    const { th, persist } = buildFrame();
    const out = th.deleteVariable('华恋.好感度');
    expect(out.delete_occurred).toBe(true);
    expect(out.variables).not.toHaveProperty(['华恋', '好感度']);
    expect(persist).toHaveBeenCalled();
    const again = th.deleteVariable('华恋.好感度');
    expect(again.delete_occurred).toBe(false);
  });

  it('insertOrAssignVariables：对象深合并、数组整体替换（variables.ts:246 的 mergeWith 定制器）', () => {
    const { th, chatStore } = buildFrame();
    const out = th.insertOrAssignVariables({ 华恋: { 认知度: 3 }, 列表: [9] });
    expect(out.华恋).toEqual({ 好感度: 5, 认知度: 3 });
    expect(out.列表).toEqual([9]);
    expect(chatStore.华恋).toEqual({ 好感度: 5, 认知度: 3 });
  });

  it('insertVariables：已有键保持不动，只补缺（variables.ts:266 base 是传入值）', () => {
    const { th } = buildFrame();
    const out = th.insertVariables({ 华恋: { 好感度: 99 }, 神乐光: { 好感度: 1 } });
    expect(out.华恋).toEqual({ 好感度: 5 });
    expect(out.神乐光).toEqual({ 好感度: 1 });
  });

  it('updateVariablesWith 支持 async updater，完成后才落盘（variables.ts:219-223）', async () => {
    const { th, persist } = buildFrame();
    const promise = th.updateVariablesWith((old: any) => Promise.resolve({ ...old, 异步: true }));
    expect(typeof promise.then).toBe('function');
    const out = await promise;
    expect(out.异步).toBe(true);
    expect(persist).toHaveBeenCalled();
  });

  it('写 chat 作用域会发 CHAT_VARIABLES_UPDATED（露缇雅「变量变化」面板的观测面）', () => {
    const { th, events } = buildFrame();
    th.insertOrAssignVariables({ 新键: 1 });
    expect(events).toContain('CHAT_VARIABLES_UPDATED');
  });

  it('不支持的作用域抛错，不静默给空表（静默空表会让卡把"读不到"当成"不存在"）', () => {
    const { th } = buildFrame();
    expect(() => th.updateVariablesWith((old: any) => old, { type: 'preset' })).toThrow(/type=preset/);
    expect(() => th.deleteVariable('a', { type: 'message' })).toThrow(/type=message/);
    expect(th.deleteVariable('全局', { type: 'global' }).delete_occurred).toBe(true);
  });
});

// ============================================================
// C 世界书 / lorebook 族（ST 源码里两者同物：worldbook.ts 顶部直接 import lorebook）
// ============================================================
describe('C 世界书 / lorebook 族', () => {
  it('getLorebooks 就是 getWorldbookNames（worldbook.ts:23 与 lorebook.ts:202 同源 world_names）', () => {
    const { th, win } = buildFrame();
    expect(th.getLorebooks()).toEqual(['角色世界书', '全局书']);
    expect((win.getWorldbookNames as any)).toHaveBeenCalled();
  });

  it('setLorebookEntries / replaceLorebookEntries 都落到 setWorldbookEntries(target, entries, options)', () => {
    const { th, win } = buildFrame();
    th.setLorebookEntries('角色世界书', [{ comment: 'x' }], { render: 'immediate' });
    expect((win.setWorldbookEntries as any)).toHaveBeenCalledWith('角色世界书', [{ comment: 'x' }], { render: 'immediate' });
  });

  it('createLorebook / createLorebookEntries / deleteLorebookEntries 是上游同物别名', () => {
    const { th, win } = buildFrame();
    th.createLorebook('新书');
    expect((win.createWorldbook as any)).toHaveBeenCalledWith('新书');
    th.createLorebookEntries('角色世界书', [{ comment: 'n' }]);
    expect((win.createWorldbookEntries as any)).toHaveBeenCalledWith('角色世界书', [{ comment: 'n' }]);
    th.deleteLorebookEntries('角色世界书', () => true);
    expect((win.deleteWorldbookEntries as any)).toHaveBeenCalledWith('角色世界书', expect.any(Function));
  });

  it('updatelorebookEntriesWith：读 → updater → 写 → 回读（worldbook.ts:432-439）', async () => {
    const { th, win } = buildFrame();
    (win.getLorebookEntries as any).mockResolvedValueOnce([{ comment: 'a' }]).mockResolvedValueOnce([{ comment: 'a' }, { comment: 'b' }]);
    const out = await th.updatelorebookEntriesWith('角色世界书', (list: any[]) => [...list, { comment: 'b' }]);
    expect(out).toEqual([{ comment: 'a' }, { comment: 'b' }]);
    expect((win.setWorldbookEntries as any)).toHaveBeenCalledWith('角色世界书', [{ comment: 'a' }, { comment: 'b' }], {});
    expect((win.getLorebookEntries as any)).toHaveBeenCalledTimes(2);
  });

  it('getChatWorldbookName：有绑定给真名，无绑定给 null（lorebook.ts:310-322）', () => {
    const { th } = buildFrame();
    expect(th.getChatWorldbookName()).toBe('角色世界书');
    const off = buildFrame({ globals: { getCurrentCharPrimaryLorebook: () => null } });
    expect(off.th.getChatWorldbookName()).toBeNull();
  });

  it('getOrCreateChatWorldbook：已绑定直接回名，不重复建书（lorebook.ts:339-343）', async () => {
    const { th, win } = buildFrame();
    await expect(th.getOrCreateChatWorldbook()).resolves.toBe('角色世界书');
    expect((win.createWorldbook as any)).not.toHaveBeenCalled();
  });

  it('getOrCreateChatWorldbook：无绑定时建新书并绑定，名字归一化到 64 字符（lorebook.ts:345-361）', async () => {
    const { th, win } = buildFrame({ globals: { getCurrentCharPrimaryLorebook: () => null } });
    const name = await th.getOrCreateChatWorldbook();
    expect(name).toBe('Chat_Book_42');
    expect((win.createWorldbook as any)).toHaveBeenCalledWith('Chat_Book_42', []);
    expect((win.rebindChatWorldbook as any)).toHaveBeenCalledWith('current', 'Chat_Book_42');
  });

  it('getOrCreateChatWorldbook：传入名与既有书重名时抛错，不覆盖别人的书（lorebook.ts:347-350）', async () => {
    const { th } = buildFrame({ globals: { getCurrentCharPrimaryLorebook: () => null } });
    await expect(th.getOrCreateChatWorldbook('全局书')).rejects.toThrow(/已存在/);
  });

  it('replaceWorldbook：书不存在时走 createOrReplaceWorldbook（worldbook.ts:377-389）', async () => {
    const { th, win } = buildFrame();
    await th.replaceWorldbook('新书', [{ comment: 'z' }], {});
    expect((win.createOrReplaceWorldbook as any)).toHaveBeenCalledWith('新书', [{ comment: 'z' }], {});
    await th.replaceWorldbook('角色世界书', [{ comment: 'y' }], {});
    expect((win.setWorldbookEntries as any)).toHaveBeenCalledWith('角色世界书', [{ comment: 'y' }], {});
  });

  it('桥接的实现在帧内不存在时 warn + undefined，不造一个成功值', () => {
    const { th, post } = buildFrame({ globals: { getWorldbookNames: undefined } });
    expect(th.getWorldbookNames()).toBeUndefined();
    expect(post).toHaveBeenCalled();
  });
});

// ============================================================
// D 角色只读族（数据只来自 getContext().characters / ctx）
// ============================================================
describe('D 角色只读族', () => {
  it('名字与 id 从 characters 来，id = 头像文件名去扩展名（character.ts:26-33）', () => {
    const { th } = buildFrame({
      characters: [
        { name: '露缇雅', avatar: 'lutiya.png' },
        { name: '别人', avatar: 'dir/other.json' },
      ],
    });
    expect(th.getCharacterNames()).toEqual(['露缇雅', '别人']);
    expect(th.getCharacterIds()).toEqual(['lutiya', 'dir/other']);
    expect(th.getCurrentCharacterName()).toBe('露缇雅');
    expect(th.getCurrentCharacterId()).toBe('lutiya');
    expect(th.getCharAvatarPath('别人')).toBe('dir/other.json');
  });

  it('getCharData 命中给 data、未命中给 null（raw_character.d.ts:105 的 | null）', () => {
    const { th } = buildFrame();
    expect(th.getCharData('current')).toEqual({ name: '露缇雅', greeting: '你好' });
    expect(th.getCharData('查无此人')).toBeNull();
  });

  it('getCharacter 未命中抛错（character.d.ts:103 的 @throws）', async () => {
    const { th } = buildFrame();
    await expect(th.getCharacter('查无此人')).rejects.toThrow(/未找到角色卡/);
    await expect(th.getCharacter('current')).resolves.toMatchObject({ name: '露缇雅' });
  });
});

// ============================================================
// E displayed / util / global
// ============================================================
describe('E displayed / util / global', () => {
  it('formatAsDisplayedMessage 走 messageFormatting 并带上楼层（displayed_message.d.ts:36）', () => {
    const { th, win } = buildFrame();
    expect(th.formatAsDisplayedMessage('台词', { message_id: 0 })).toBe('<p>台词</p>');
    expect((win.messageFormatting as any)).toHaveBeenCalledWith('台词', '露缇雅', false, false, 0);
  });

  it('formatAsDisplayedMessage 楼层越界抛错（displayed_message.d.ts:40 @throws）', () => {
    const { th } = buildFrame({ lastMessageId: 3 });
    expect(() => th.formatAsDisplayedMessage('x', { message_id: 9 })).toThrow(/超出/);
  });

  it('getMessageId 只认 TH-message 帧名，其它一律抛（util.ts:109-115）', () => {
    const { th } = buildFrame();
    expect(th.getMessageId('TH-message--7--0')).toBe(7);
    expect(th.getMessageId('TH-message--12--3_4')).toBe(12);
    expect(() => th.getMessageId('palink-frame-1')).toThrow(/不要对全局脚本 iframe 调用 getMessageId/);
  });

  it('errorCatched 上报后继续抛，async 拒绝也一样（util.ts:17-42 不吞异常）', async () => {
    const { th, post } = buildFrame();
    expect(() => th.errorCatched(() => { throw new Error('boom'); })()).toThrow('boom');
    await expect(th.errorCatched(() => Promise.reject(new Error('async boom')))()).rejects.toThrow('async boom');
    expect(post).toHaveBeenCalled();
    const messages = post.mock.calls.map((call: any[]) => JSON.stringify(call[0]));
    expect(messages.some((m: string) => m.indexOf('async boom') >= 0)).toBe(true);
  });

  it('initializeGlobal 挂到 window 并发 global_<name>_initialized（global.ts:8-12）', () => {
    const { th, win } = buildFrame();
    th.initializeGlobal('Mvu', { ok: 1 });
    expect((win as any).Mvu).toEqual({ ok: 1 });
    expect((win.eventSource as any).emit).toHaveBeenCalledWith('global_Mvu_initialized');
  });

  it('waitGlobalInitialized：已在场立刻 resolve，否则挂 once 等事件（global.ts:16-25）', async () => {
    const { th, win } = buildFrame();
    th.initializeGlobal('Mvu', { ok: 1 });
    await expect(th.waitGlobalInitialized('Mvu')).resolves.toBeUndefined();
    expect((win.eventSource as any).once).not.toHaveBeenCalled();
    // 未在场时返回的是"等事件"的 Promise，桩里的 once 不会自己触发 ⇒ 只登记、不 await（await 必挂）。
    const pending = th.waitGlobalInitialized('还没挂的东西');
    expect(typeof pending.then).toBe('function');
    expect((win.eventSource as any).once).toHaveBeenCalledWith('global_还没挂的东西_initialized', expect.any(Function));
    pending.catch(() => undefined);
  });

  it('substitudeMacros 走 substituteParamsExtended（util.ts:9-11）', () => {
    const { th, win } = buildFrame();
    expect(th.substitudeMacros('{{char}} 你好')).toBe('露缇雅 你好');
    expect((win.substituteParamsExtended as any)).toHaveBeenCalledWith('{{char}} 你好');
  });

  it('版本号桥到帧内既有实现，不在帧内硬编', () => {
    const { th } = buildFrame();
    expect(th.getTavernVersion()).toBe('1.18.0');
    expect(th.getTavernHelperVersion()).toBe('5.9.0');
  });

  it('stopAllGeneration 走既有父侧动作 stopGeneration', async () => {
    const { th, requestParent } = buildFrame();
    await th.stopAllGeneration();
    expect(requestParent).toHaveBeenCalledWith('stopGeneration', {});
  });

  it('triggerSlash 桥到帧内真实现（part-08:790 的 runPalinkSlash 通道）', async () => {
    const { th, win } = buildFrame();
    await expect(th.triggerSlash('/echo hi')).resolves.toBe('slash-result');
    expect((win.triggerSlash as any)).toHaveBeenCalledWith('/echo hi');
  });
});

// ============================================================
// F chat_message 写族
// ============================================================
describe('F chat_message 写族', () => {
  it('setChatMessages 的 content 走真写路径 setChatMessage(content, messageId, options)', async () => {
    const { th, win, compatChat } = buildFrame();
    await th.setChatMessages([{ message_id: 0, message: '改后' }]);
    expect((win.setChatMessage as any)).toHaveBeenCalledWith('改后', 0, {});
    expect(compatChat[0].mes).toBe('改后');
  });

  it('setChatMessages 的 name/extra/data 只更新帧内镜像并 warn（父侧无该写通道）', async () => {
    const { th, post, compatChat } = buildFrame();
    await th.setChatMessages([{ message_id: 1, name: '旁白', is_hidden: true }]);
    expect(compatChat[1].name).toBe('旁白');
    expect(compatChat[1].is_system).toBe(true);
    const messages = post.mock.calls.map((call: any[]) => JSON.stringify(call[0]));
    expect(messages.some((m: string) => m.indexOf('只更新了帧内镜像') >= 0)).toBe(true);
  });

  it('createChatMessages 追加走 addOneMessage，role 决定 name/is_user（chat_message.ts:322-348）', async () => {
    const { th, win } = buildFrame();
    await th.createChatMessages([{ role: 'user', message: '你好' }, { role: 'system', message: '旁白' }]);
    const first = (win.addOneMessage as any).mock.calls[0][0];
    expect(first).toMatchObject({ mes: '你好', name: '我', is_user: true });
    const second = (win.addOneMessage as any).mock.calls[1][0];
    expect(second).toMatchObject({ mes: '旁白', name: 'system', is_user: false });
  });

  it('createChatMessages 指定中间楼层插入时抛错，不悄悄追加到末尾（chat_message.ts:319 有 splice）', async () => {
    const { th } = buildFrame();
    await expect(th.createChatMessages([{ role: 'user', message: 'x' }], { insert_before: 1 })).rejects.toThrow(/暂不支持在指定楼层插入/);
  });

  it('deleteChatMessages 从大到小删，避免下标漂移（chat_message.ts:393 先 sort）', async () => {
    const { th, win } = buildFrame();
    await th.deleteChatMessages([0, 1]);
    const order = (win.deleteMessage as any).mock.calls.map((call: any[]) => call[0]);
    expect(order).toEqual([1, 0]);
  });

  it('帧内写实现缺席时一律抛错，不返回一个假成功', async () => {
    const missing = buildFrame({
      globals: { setChatMessage: undefined, addOneMessage: undefined, deleteMessage: undefined },
    });
    await expect(missing.th.setChatMessages([{ message_id: 0, message: 'x' }])).rejects.toThrow(/setChatMessage 未注册/);
    await expect(missing.th.createChatMessages([{ role: 'user', message: 'x' }])).rejects.toThrow(/addOneMessage 未注册/);
    await expect(missing.th.deleteChatMessages([0])).rejects.toThrow(/deleteMessage 未注册/);
    // 写世界书同理：setter 不在就抛，不能让卡以为条目已经保存
    const noBook = buildFrame({ globals: { setWorldbookEntries: undefined } });
    await expect(noBook.th.setLorebookEntries('书', [])).rejects.toThrow(/setWorldbookEntries 未注册/);
  });
});
