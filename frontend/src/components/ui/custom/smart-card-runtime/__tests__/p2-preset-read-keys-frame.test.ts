/*
 * 预设读类 3 键 —— 帧内行为测试（ST-BRIDGE-PRESET 2026-10-21 批次P2 段③ + 批次P3 订正）
 *
 * 口径：**执行型**，一律用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`
 * （与生产 iframe 逐字节同源的脚本）。**刻意不 import 载体一**（未求值源码文本）：
 * 拿它做行为断言 = 假绿/假红双向骗人（见 compat-v2-runtime-source.ts 文首）。
 * 本文件不含任何"未求值文本 + new Function"的组合，故不需要进
 * runtime-source-carrier-fidelity.test.ts 的混合载体白名单。
 *
 * [批次P3 P3-A 2026-10-21] 本文件在 P2 版本上做了**订正**，原因是主脑实机查出 P1：
 * 三键在 P2 里被接成 `async`（返回 Promise），而 ST 契约是**同步**
 * （`preset.d.ts:150` `getPresetNames(): string[]`）⇒ 真卡按 ST 写法拿到的是 `undefined`。
 * **"接错成异步"比"没接"更难发现**：不报错、不留痕、门禁全绿 —— 因为 P2 的用例
 * 都 `await` 了返回值，而 `await` 对同步值和 Promise **一样成立**，两种实现都能绿。
 * ⇒ 判据从"断值"改成"**断形状**"：`expect(v && typeof v.then).not.toBe('function')`。
 *
 * P3 后的帧内语义：三键**同步读宿主带进 ctx 的预设快照**（`ctx.presetSnapshot`），
 * 不再 requestParent（父侧 dispatcher 内部异步允许，**对外必须同步**）。
 * 快照缺失 ⇒ 返回 [] / null 并 palinkDiag 留痕，⛔ 不返回 undefined 冒充"没有预设"。
 *
 * 契约一手：st-plugins/third-party/JS-Slash-Runner-main/@types/function/preset.d.ts
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/p2-preset-read-keys-frame.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';

const BEGIN = '>>> H-TH134 FAMILY BEGIN';
const END = '<<< H-TH134 FAMILY END';

function sliceRegion(src: string): string {
  const begin = src.indexOf(BEGIN);
  expect(begin, 'missing ' + BEGIN).toBeGreaterThan(-1);
  const end = src.indexOf(END);
  expect(end, 'missing ' + END).toBeGreaterThan(begin);
  return src.slice(src.indexOf('\n', begin) + 1, src.lastIndexOf('\n', end));
}

/** 帧内预设快照（服务端 `/api/prompt-manager/presets/snapshot` 的形状，帧内读驼峰）。 */
const SNAPSHOT = {
  store: 'generation_presets',
  names: ['平衡', '自由'],
  loadedName: '平衡',
  inUse: { settings: { temperature: 0.7 }, prompts: [{ id: 'main', content: 'in_use' }], prompts_unused: [], extensions: {} },
  presets: {
    平衡: { settings: { temperature: 0.7 }, prompts: [{ id: 'main', content: 'A' }], prompts_unused: [], extensions: {} },
    自由: { settings: {}, prompts: [{ id: 'main', content: 'B' }], prompts_unused: [], extensions: {} },
  },
  source: 'global',
};

/**
 * 帧内环境：H 段只依赖这 12 个外部符号（与 h-tavernhelper-134-contract 的夹具同源）。
 * `presetSnapshot` 走 ctx —— 与生产一致（宿主经 boot 内联 + context-update 热更送进来）。
 */
function buildFrame(ctxOverride: Record<string, unknown> = {}) {
  const BACKSLASH = String.fromCharCode(92);
  const requestParent = vi.fn(async () => ({ ok: true, success: true }));
  const post = vi.fn();
  const win: Record<string, unknown> = { eventSource: { on: vi.fn(), once: vi.fn(), emit: vi.fn() } };
  const factory = new Function(
    'window', 'ctx', 'post', 'requestParent', 'compatChat',
    'chatVariableStore', 'globalVariableStore', 'localVariableStore',
    'persistVariableStores', 'deleteByPath', 'emitCompatEvent', 'regexBackslashCompat',
    sliceRegion(SRC) + '\nreturn tavernHelperTh134Compat;',
  );
  const th = factory(
    win,
    {
      characterName: '露缇雅', characterId: 'lutiya', sessionId: '42', messageId: 1, userName: '我',
      ...ctxOverride,
    },
    post,
    requestParent,
    [],
    {},
    {},
    {},
    vi.fn(),
    () => false,
    vi.fn(),
    BACKSLASH,
  ) as Record<string, any>;
  return { th, requestParent, post };
}

describe('帧内成员确实存在（反向锚点：从 part-07 摘掉任一成员 ⇒ 本文件必红）', () => {
  it('三个读类键都是函数', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(typeof th.getPresetNames).toBe('function');
    expect(typeof th.getLoadedPresetName).toBe('function');
    expect(typeof th.getPreset).toBe('function');
  });

  it('写类与判定类键的注册边界（[批次TH 2026-10-26 改写，未删] 写类 9 键已真落地并注册；判定类与代理名单仍不得出现）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    // [批次TH 2026-10-26] 写类 9 键从"不得出现"改为"必须出现"——它们走父侧既有路由
    // （loadPreset 同步快照判定 + 8 个 async 桥），行为断言见
    // h-tavernhelper-134-contract.test.ts 的 I 组与 th-preset-write-keys-parent.test.ts。
    [
      'loadPreset', 'createPreset', 'createOrReplacePreset', 'deletePreset', 'renamePreset',
      'replacePreset', 'setPreset', 'updatePresetWith', 'importRawPreset',
    ].forEach((name) => {
      expect(typeof th[name], name + ' 批次TH 已落地，不得再缺席').toBe('function');
    });
    // ⛔ 反向红线保持：isPreset* 三键与 getProxyPresetNames 仍是 D（本批裁定留 D 档），
    //   谁把它们注册成假实现，这里必红。
    [
      'getProxyPresetNames',
      'isPresetNormalPrompt', 'isPresetSystemPrompt',
      'isPresetPlaceholderPrompt',
    ].forEach((name) => {
      expect(th[name], name + ' 不得被注册成假实现').toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// [批次P3 P3-A] 同步契约 —— **本节是本次要修的 P1 的正面判据**
// 断"不得是 thenable"，而不是断"值对不对"（await 会把同步值与 Promise 一并喂饱）。
// ---------------------------------------------------------------------------
describe('三键对外必须同步（ST 契约；P3-A 正面判据）', () => {
  it('getPresetNames 的返回值不得是 thenable', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    const v = th.getPresetNames();
    expect(v && typeof v.then).not.toBe('function');
    expect(Array.isArray(v)).toBe(true);
  });

  it('getLoadedPresetName 的返回值不得是 thenable', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    const v = th.getLoadedPresetName();
    expect(v && typeof v.then).not.toBe('function');
    expect(v).toBe('平衡');
  });

  it("getPreset 的返回值不得是 thenable（'in_use'）", () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    const v = th.getPreset('in_use');
    expect(v && typeof v.then).not.toBe('function');
    expect(v.prompts).toEqual([{ id: 'main', content: 'in_use' }]);
  });

  it('三个键都**不发起** requestParent（父侧内部异步允许，对外必须同步读快照）', () => {
    const { th, requestParent } = buildFrame({ presetSnapshot: SNAPSHOT });
    th.getPresetNames();
    th.getLoadedPresetName();
    th.getPreset('平衡');
    expect(requestParent).not.toHaveBeenCalled();
  });
});

describe('getPresetNames（preset.d.ts）', () => {
  it('同步返回快照里的名字列表（原样，不补不删）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(th.getPresetNames()).toEqual(['平衡', '自由']);
  });

  it('返回的数组是副本（卡改它不会污染 ctx 里的快照）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    const names = th.getPresetNames();
    names.push('污染项');
    expect(th.getPresetNames()).toEqual(['平衡', '自由']);
  });

  it('快照还没到 ⇒ 返回**空数组**（不是 undefined，也不是 Promise）并留痕', () => {
    const { th, post } = buildFrame();
    const v = th.getPresetNames();
    expect(v).toEqual([]);
    expect(v).not.toBeUndefined();
    expect(v && typeof v.then).not.toBe('function');
    // 留痕：warn 一定要发出来，否则"没快照"和"真的没有预设"又混成一类
    expect(post).toHaveBeenCalled();
    const warned = (post as any).mock.calls.some((c: any[]) => {
      const msg = String((c[0] && c[0].message) || '');
      return msg.indexOf('预设快照未就绪') >= 0;
    });
    expect(warned, '快照缺失必须 warn 留痕').toBe(true);
  });

  it('快照里的 names 不是数组 ⇒ 退化成空数组（形状兜底）', () => {
    const { th } = buildFrame({ presetSnapshot: { names: null, presets: {} } });
    expect(th.getPresetNames()).toEqual([]);
  });
});

describe('getLoadedPresetName（preset.d.ts）', () => {
  it('同步返回快照的 loadedName', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(th.getLoadedPresetName()).toBe('平衡');
  });

  it('快照里 loadedName 为 null ⇒ 返回 null（不造 Default）', () => {
    const { th } = buildFrame({ presetSnapshot: { names: [], loadedName: null, presets: {} } });
    expect(th.getLoadedPresetName()).toBeNull();
  });

  it('快照还没到 ⇒ 返回 null（不是 undefined、不是 Promise）', () => {
    const { th } = buildFrame();
    const v = th.getLoadedPresetName();
    expect(v).toBeNull();
    expect(v).not.toBeUndefined();
    expect(v && typeof v.then).not.toBe('function');
  });
});

describe('getPreset（preset.d.ts）', () => {
  it("'in_use' ⇒ 本对话当前生效那份（快照的 inUse）", () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(th.getPreset('in_use')).toMatchObject({ settings: { temperature: 0.7 } });
  });

  it('不传名字 ⇒ 按 in_use 处理（d.ts 的 LiteralUnion 默认口径）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(th.getPreset()).toMatchObject({ settings: { temperature: 0.7 } });
  });

  it('按名解析；形状仍是 ST 四键（prompts/settings/prompts_unused/extensions）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    const preset = th.getPreset('自由');
    expect(Object.keys(preset).sort()).toEqual(['extensions', 'prompts', 'prompts_unused', 'settings']);
    expect(preset.prompts).toEqual([{ id: 'main', content: 'B' }]);
    expect(preset.settings).toEqual({});
  });

  it('名字不存在 ⇒ 抛错（d.ts 的 @throws，不返 undefined 装成功）', () => {
    const { th } = buildFrame({ presetSnapshot: SNAPSHOT });
    expect(() => th.getPreset('查无此预设')).toThrow(/预设不存在/);
  });

  it('快照还没到 ⇒ 抛错（可见失败，⛔ 不静默返回假对象）', () => {
    const { th } = buildFrame();
    expect(() => th.getPreset('in_use')).toThrow(/快照未就绪/);
  });

  it('快照里有 inUse 但 presets 索引缺失 ⇒ 按名取时抛错（不拿 inUse 顶包）', () => {
    const { th } = buildFrame({
      presetSnapshot: { names: [], loadedName: 'x', inUse: { prompts: [] } },
    });
    expect(() => th.getPreset('某个名字')).toThrow(/presets/);
  });
});
