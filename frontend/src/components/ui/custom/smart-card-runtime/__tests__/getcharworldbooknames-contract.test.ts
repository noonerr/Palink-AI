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
 * ⚠️ [S5 2026-10-15] 第 1 行（大堂/主页面轨 utils/sillyTavernPluginRuntime.ts）已随
 *    S5「删大堂」**整体删除**，本测试只剩第 2/3 行两条帧内轨（单间轨 shim + 单间轨 runtime）；
 *    主页面轨相关的 `buildMainTrack` / 切片断言一并移除（对照对象已不存在）。
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
 * 帧内两处一起钉（防止只改一处，与 frame-getchatmessages-id-lookup.test.ts 同手法）。
 *
 * 口径：切真实函数体 + new Function 执行 + 断言行为，不 grep 源码字符串。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/getcharworldbooknames-contract.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';
// [S4 2026-10-15] 运行时体已按行拆到 runtime-body/part-01..08.ts，改为读拼接后的源码文本。
// [包L 2026-10-18] 执行型测试 ⇒ 用求值后载体（与生产 iframe 逐字节一致），未求值文本会假绿。
import { COMPAT_V2_RUNTIME_ARTIFACT as COMPAT_V2_SOURCE } from './compat-v2-runtime-source';

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

const SHIM_BODY = sliceBraceBlock(
  LEGACY_ST_SIM_SEGMENT,
  'const getCharWorldbookNamesCompat = () => {',
);
const COMPAT_V2_BODY = sliceBraceBlock(
  COMPAT_V2_SOURCE,
  'const getCharWorldbookNamesCompat = () => {',
);

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
  it.each(FRAME_TRACKS)('[红→S1 转绿] %s：MVU 的 .primary ?? unknown 拿得到世界书名', (_label, body) => {
    const { fn } = buildFrameTrack(body, { activeWorldbookName: '主世界书' });
    expect(fn().primary ?? 'unknown').toBe('主世界书');
  });

});

// ============================================================
// C 冷缓存自热：同步 API 等不起，必须后台补一次
// ============================================================
describe('C 冷缓存自热（不阻塞同步返回）', () => {
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
