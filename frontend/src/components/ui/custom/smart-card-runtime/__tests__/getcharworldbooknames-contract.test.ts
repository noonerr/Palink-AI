/*
 * getCharWorldbookNames 形状契约测试（三轨并一轨 · S1 · G1）
 *
 * 背景：三处实现形状/时序各不相同，且**没有一处**对上真机消费者。
 *
 *   | # | 位置 | 2026-10-13 改前 |
 *   |---|---|---|
 *   | 1 | utils/sillyTavernPluginRuntime.ts（大堂/主页面轨） | Promise<string[]> |
 *   | 2 | smart-card-runtime/frame-shim/legacy-st-sim.ts（单间轨 shim）     | Promise<{primary,additional}> |
 *   | 3 | smart-card-runtime/SillyTavernCompatRuntime.ts（单间轨 runtime）  | Promise<{primary,additional}> |
 *
 * ⚠️ 本文件推翻了 S1 交接文档的一句话结论。交接文档称「ST 契约是 Promise<string[]>，
 *    MVU await 后读 .length」，实测三条证据都不支持：
 *     1. 本仓自带 ST 类型声明
 *        st-plugins/third-party/JS-Slash-Runner-main/@types/function/worldbook.d.ts:32
 *          declare function getCharWorldbookNames(character_name): CharWorldbooks;
 *          type CharWorldbooks = { primary: string | null; additional: string[] };
 *        —— 对象形状，且**返回值不是 Promise**。
 *     2. 真机 MVU bundle（backend/data/smart_card_assets/ 三份：307KB / 573KB / 137KB）
 *        调用形如 getCharWorldbookNames('current').primary ?? 'unknown' —— **不 await、读 .primary**；
 *        三份里 `await getCharWorldbookNames` 出现次数 = 0。
 *     3. 同仓 JS-Slash-Runner 自家实现 src/function/worldbook.ts:50 即
 *        同步转调 getCharLorebooks({ name })，其消费者 character.ts:115 读 .primary。
 *   ⇒ 真缺陷是「三处都返回 Promise，而消费者不 await」：.primary 恒 undefined，
 *     MVU 的 initialized_lorebooks 键退化成 'unknown'。改成 string[] 只会让 await 派也拿错形状。
 *
 * 因此本文件钉住的契约是：**同步返回 { primary: string|null, additional: string[] }**。
 * 三处一起钉（防止只改一处，与 frame-getchatmessages-id-lookup.test.ts 同手法）。
 *
 * 口径：切真实函数体 + new Function 执行 + 断言行为，不 grep 源码字符串。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/getcharworldbooknames-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';

// vitest 固定以 frontend/ 为 cwd 运行（同 storage-isolation-contract.test.ts）
const MAIN_TRACK_SOURCE = readFileSync(
  join(process.cwd(), 'src/utils/sillyTavernPluginRuntime.ts'),
  'utf8',
);
const COMPAT_V2_SOURCE = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts'),
  'utf8',
);

/** 从 marker 起花括号配平，原样切出一段代码（不重写逻辑，避免测到一份"我以为的实现"）。 */
function sliceBraceBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  expect(i, `no '{' after marker: ${marker}`).toBeGreaterThan(-1);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

const MAIN_TRACK_BODY = sliceBraceBlock(
  MAIN_TRACK_SOURCE,
  'window.getCharWorldbookNames = function(name) {',
);
/** 主页面轨本 API 的数据源（冷缓存刷新就在这里发起），一并切片以测真实调用链。 */
const LOREBOOKS_BODY = sliceBraceBlock(
  MAIN_TRACK_SOURCE,
  'window.getCharLorebooks = function(opts) {',
);
const SHIM_BODY = sliceBraceBlock(
  LEGACY_ST_SIM_SEGMENT,
  'const getCharWorldbookNamesCompat = () => {',
);
const COMPAT_V2_BODY = sliceBraceBlock(
  COMPAT_V2_SOURCE,
  'const getCharWorldbookNamesCompat = () => {',
);

// ── 主页面轨：注入 window / runtime 后取出真实实现 ──────────────────────────
interface MainTrackOpts {
  books?: { primary: string | null; additional: string[] } | null;
  bridge?: boolean;
  characterUuid?: string;
}
function buildMainTrack(opts: MainTrackOpts = {}) {
  const { books = { primary: '角色世界书', additional: ['附加世界书'] }, bridge = true, characterUuid = 'char-1' } = opts;
  const stubHits: Array<[string, string]> = [];
  const refreshCalls: string[] = [];
  const win: any = {
    getCharLorebooks: (_o?: any) => (books ? { primary: books.primary, additional: [...books.additional] } : { primary: null, additional: [] }),
  };
  if (bridge) {
    win.__palinkBridge = {
      charLorebooks: () => (books ? { primary: books.primary, additional: [...books.additional] } : { primary: null, additional: [] }),
      charLorebooksFor: () => characterUuid,
      refreshCharLorebooks: async (cid: string) => {
        refreshCalls.push(cid);
        return { primary: null, additional: [] };
      },
    };
  }
  const runtime: any = {
    context: { characterUuid },
    recordStubHit: (name: string, why: string) => { stubHits.push([name, why]); },
  };
  const fn = new Function(
    'window', 'runtime',
    `${MAIN_TRACK_BODY}\nreturn window.getCharWorldbookNames;`,
  )(win, runtime);
  return { fn: fn as (name?: string) => any, stubHits, refreshCalls, win };
}

// ── 帧内两轨：注入闭包变量后取出真实实现 ──────────────────────────────────
interface FrameTrackOpts {
  activeWorldbookName?: string;
  parentResult?: any;
  parentThrows?: boolean;
}
function buildFrameTrack(body: string, opts: FrameTrackOpts = {}) {
  const { activeWorldbookName = '', parentResult = { success: true, name: '', entries: [] }, parentThrows = false } = opts;
  const requestParent = vi.fn(async (_action: string, _payload?: any) => {
    if (parentThrows) throw new Error('parent rpc exploded');
    return parentResult;
  });
  const post = vi.fn((_msg: any) => undefined);
  const fn = new Function(
    'activeWorldbookName', 'worldbookNamesWarmStarted', 'requestParent', 'post',
    `${body}\nreturn getCharWorldbookNamesCompat;`,
  )(activeWorldbookName, false, requestParent, post);
  return { fn: fn as () => any, requestParent, post };
}

const FRAME_TRACKS: Array<[string, string]> = [
  ['单间轨 shim（legacy-st-sim）', SHIM_BODY],
  ['单间轨 runtime（SillyTavernCompatRuntime）', COMPAT_V2_BODY],
];

// ============================================================
// A 形状契约：三处都必须**同步**返回 { primary, additional }
// ============================================================
describe('A 形状契约 —— 三处都同步返回 { primary, additional }', () => {
  it('[红→S1 转绿] 主页面轨：同步返回对象，不是 Promise、不是 string[]', () => {
    const { fn } = buildMainTrack();
    const out = fn('current');
    expect(typeof out).toBe('object');
    expect(out).not.toBeNull();
    expect(Array.isArray(out)).toBe(false);
    expect(typeof out.then).toBe('undefined');
    expect(out.primary).toBe('角色世界书');
    expect(Array.isArray(out.additional)).toBe(true);
    expect(out.additional).toEqual(['附加世界书']);
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：同步返回对象，不是 Promise、不是 string[]', (_label, body) => {
    const { fn } = buildFrameTrack(body, { activeWorldbookName: '卡自建世界书' });
    const out = fn();
    expect(typeof out).toBe('object');
    expect(out).not.toBeNull();
    expect(Array.isArray(out)).toBe(false);
    expect(typeof out.then).toBe('undefined');
    expect(out.primary).toBe('卡自建世界书');
    expect(Array.isArray(out.additional)).toBe(true);
    expect(out.additional).toEqual(['卡自建世界书']);
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：空绑定返回 { primary: null, additional: [] }（不是 undefined）', (_label, body) => {
    const { fn } = buildFrameTrack(body, { activeWorldbookName: '' });
    const out = fn();
    expect(out).toEqual({ primary: null, additional: [] });
  });
});

// ============================================================
// B 真机消费者写法契约：不 await、直接读 .primary
// ============================================================
describe('B 真机 MVU 写法 —— getCharWorldbookNames(...).primary 必须拿到真值', () => {
  it('[红→S1 转绿] 主页面轨：MVU 的 .primary ?? unknown 拿得到世界书名', () => {
    const { fn } = buildMainTrack({ books: { primary: '主世界书', additional: [] } });
    // 真机 bundle 原文（去敏）：const e = getCharWorldbookNames('current').primary ?? 'unknown'
    expect(fn('current').primary ?? 'unknown').toBe('主世界书');
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：MVU 的 .primary ?? unknown 拿得到世界书名', (_label, body) => {
    const { fn } = buildFrameTrack(body, { activeWorldbookName: '主世界书' });
    expect(fn().primary ?? 'unknown').toBe('主世界书');
  });

  it('[红→S1 转绿] 主页面轨：按名查询时把 name 透传给 getCharLorebooks', () => {
    const seen: any[] = [];
    const { fn, win } = buildMainTrack();
    win.getCharLorebooks = (o: any) => { seen.push(o); return { primary: '别人的世界书', additional: [] }; };
    expect(fn('某个角色').primary).toBe('别人的世界书');
    expect(seen[0]).toEqual({ name: '某个角色' });
  });
});

// ============================================================
// C 冷缓存自热：同步 API 等不起，必须后台补一次
// ============================================================
describe('C 冷缓存自热（不阻塞同步返回）', () => {
  it('[红→S1 转绿] 主页面轨：缓存角色与当前不符时后台 kick refreshCharLorebooks', () => {
    // 本 API 的数据源是 window.getCharLorebooks（真实现，一并切片执行），冷缓存刷新由它发起：
    // 桥缓存是惰性拉取的（注入时角色 id 未必已进 context），首次调用几乎必撞冷缓存，
    // 不 kick 的话这张卡永远查不到自己的世界书绑定。
    const refreshCalls: string[] = [];
    const win: any = {
      __palinkBridge: {
        charLorebooks: () => ({ primary: null, additional: [] }),
        charLorebooksFor: () => '另一个角色',
        refreshCharLorebooks: async (cid: string) => {
          refreshCalls.push(cid);
          return { primary: null, additional: [] };
        },
      },
    };
    const runtime: any = { context: { characterUuid: 'char-1' }, recordStubHit: () => undefined };
    const fn = new Function(
      'window', 'runtime',
      `${LOREBOOKS_BODY}\n${MAIN_TRACK_BODY}\nreturn window.getCharWorldbookNames;`,
    )(win, runtime) as (name?: string) => any;
    const out = fn('current');
    expect(out).toEqual({ primary: null, additional: [] });
    expect(refreshCalls).toEqual(['char-1']);
  });

  it('[红→S1 转绿] 主页面轨：缓存已是当前角色时不重复刷新', () => {
    const refreshCalls: string[] = [];
    const win: any = {
      __palinkBridge: {
        charLorebooks: () => ({ primary: '角色世界书', additional: [] }),
        charLorebooksFor: () => 'char-1',
        refreshCharLorebooks: async (cid: string) => {
          refreshCalls.push(cid);
          return { primary: null, additional: [] };
        },
      },
    };
    const runtime: any = { context: { characterUuid: 'char-1' }, recordStubHit: () => undefined };
    const fn = new Function(
      'window', 'runtime',
      `${LOREBOOKS_BODY}\n${MAIN_TRACK_BODY}\nreturn window.getCharWorldbookNames;`,
    )(win, runtime) as (name?: string) => any;
    expect(fn('current').primary).toBe('角色世界书');
    expect(refreshCalls).toEqual([]);
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：冷缓存时后台自热一次，且重复调用不重复 RPC', (_label, body) => {
    const { fn, requestParent } = buildFrameTrack(body, {
      activeWorldbookName: '',
      parentResult: { success: true, name: '父侧世界书' },
    });
    expect(fn()).toEqual({ primary: null, additional: [] });
    fn();
    fn();
    expect(requestParent).toHaveBeenCalledTimes(1);
    expect(requestParent).toHaveBeenCalledWith('getCharWorldbook', { args: [] });
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：自热完成后后续调用拿到真值', async (_label, body) => {
    const { fn } = buildFrameTrack(body, {
      activeWorldbookName: '',
      parentResult: { success: true, name: '父侧世界书' },
    });
    expect(fn().primary).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(fn().primary).toBe('父侧世界书');
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：缓存已热则不再发 RPC', (_label, body) => {
    const { fn, requestParent } = buildFrameTrack(body, { activeWorldbookName: '已热世界书' });
    expect(fn().primary).toBe('已热世界书');
    expect(requestParent).not.toHaveBeenCalled();
  });
});

// ============================================================
// D 降级留痕：不可用/失败不许静默返回
// ============================================================
describe('D 降级不静默', () => {
  it('[红→S1 转绿] 主页面轨：桥不可用时记桩并返回空绑定', () => {
    const { fn, stubHits } = buildMainTrack({ bridge: false });
    expect(fn('current')).toEqual({ primary: null, additional: [] });
    expect(stubHits.some(([name]) => name === 'getCharWorldbookNames')).toBe(true);
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：父侧应答失败时降级留痕（post 一条 warn）', async (_label, body) => {
    const { fn, post } = buildFrameTrack(body, {
      activeWorldbookName: '',
      parentResult: { success: false, error: 'timeout' },
    });
    expect(fn()).toEqual({ primary: null, additional: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(post).toHaveBeenCalled();
    expect(post.mock.calls[0][0]).toMatchObject({ type: 'log', level: 'warn' });
  });

  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：父侧 RPC 抛异常不冒泡到卡脚本', async (_label, body) => {
    const { fn } = buildFrameTrack(body, { activeWorldbookName: '', parentThrows: true });
    expect(() => fn()).not.toThrow();
    await Promise.resolve();
    expect(fn()).toEqual({ primary: null, additional: [] });
  });
});
