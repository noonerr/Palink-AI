/*
 * 预设读类 3 键 —— 帧内行为测试（ST-BRIDGE-PRESET 2026-10-21 批次P2 段③）
 *
 * 口径：**执行型**，一律用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`
 * （与生产 iframe 逐字节同源的脚本）。**刻意不 import 载体一**（未求值源码文本）：
 * 拿它做行为断言 = 假绿/假红双向骗人（见 compat-v2-runtime-source.ts 文首）。
 * 本文件不含任何"未求值文本 + new Function"的组合，故不需要进
 * runtime-source-carrier-fidelity.test.ts 的混合载体白名单。
 *
 * 钉住的是「桥不是空壳」这一层：每个成员都必须真的发起 requestParent，
 * 且失败时**抛错**（ST 契约里这三个键的失败语义是 throw / null，不是静默假成功）。
 * 父侧落点对不对由 p2-preset-read-keys-parent.test.ts 负责。
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

/** 帧内环境：H 段只依赖这 12 个外部符号（与 h-tavernhelper-134-contract 的夹具同源）。 */
function buildFrame(parentResult: unknown = { ok: true, success: true }) {
  const BACKSLASH = String.fromCharCode(92);
  const requestParent = vi.fn(async () => parentResult);
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
    { characterName: '露缇雅', characterId: 'lutiya', sessionId: '42', messageId: 1, userName: '我' },
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
  return { th, requestParent };
}

describe('帧内成员确实存在（反向锚点：从 part-07 摘掉任一成员 ⇒ 本文件必红）', () => {
  it('三个读类键都是函数', () => {
    const { th } = buildFrame();
    expect(typeof th.getPresetNames).toBe('function');
    expect(typeof th.getLoadedPresetName).toBe('function');
    expect(typeof th.getPreset).toBe('function');
  });

  it('写类与判定类键**没有**被顺手注册（本批不碰 P3，也不写恒假实现）', () => {
    const { th } = buildFrame();
    [
      'createPreset', 'replacePreset', 'updatePresetWith', 'createOrReplacePreset',
      'deletePreset', 'renamePreset', 'loadPreset', 'setPreset', 'getProxyPresetNames',
      'isPresetNormalPrompt', 'isPresetPresetSystemPrompt', 'isPresetSystemPrompt',
      'isPresetPlaceholderPrompt',
    ].forEach((name) => {
      expect(th[name], name + ' 不该在本批出现').toBeUndefined();
    });
  });
});

describe('getPresetNames（preset.d.ts）', () => {
  it('真的发起父侧请求，并把 names 原样返回', async () => {
    const { th, requestParent } = buildFrame({ ok: true, success: true, names: ['预设A', '预设B'] });
    await expect(th.getPresetNames()).resolves.toEqual(['预设A', '预设B']);
    expect(requestParent).toHaveBeenCalledWith('getPresetNames', {});
  });

  it('父侧失败 ⇒ 抛错（不返空数组：空数组是"真的没有预设"这个合法状态）', async () => {
    const { th } = buildFrame({ ok: true, success: false, error: 'preset_list_failed' });
    await expect(th.getPresetNames()).rejects.toThrow(/preset_list_failed/);
  });

  it('父侧返回的 names 不是数组时退化成空数组，不抛（形状兜底）', async () => {
    const { th } = buildFrame({ ok: true, success: true, names: null });
    await expect(th.getPresetNames()).resolves.toEqual([]);
  });
});

describe('getLoadedPresetName（preset.d.ts）', () => {
  it('返回父侧给的 name', async () => {
    const { th, requestParent } = buildFrame({ ok: true, success: true, name: '预设A' });
    await expect(th.getLoadedPresetName()).resolves.toBe('预设A');
    expect(requestParent).toHaveBeenCalledWith('getLoadedPresetName', {});
  });

  it('父侧给 null ⇒ 返回 null（不造 Default）', async () => {
    const { th } = buildFrame({ ok: true, success: true, name: null });
    await expect(th.getLoadedPresetName()).resolves.toBeNull();
  });

  it('父侧失败 ⇒ 抛错', async () => {
    const { th } = buildFrame({ ok: true, success: false, error: 'preset_read_failed' });
    await expect(th.getLoadedPresetName()).rejects.toThrow(/preset_read_failed/);
  });
});

describe('getPreset（preset.d.ts）', () => {
  it("把名字原样交给父侧，'in_use' 也一样", async () => {
    const { th, requestParent } = buildFrame({
      ok: true,
      success: true,
      preset: { settings: { temperature: 0.5 }, prompts: [], prompts_unused: [], extensions: {} },
    });
    await th.getPreset('in_use');
    expect(requestParent).toHaveBeenCalledWith('getPreset', { presetName: 'in_use' });
    const out = await th.getPreset('预设A');
    expect(requestParent).toHaveBeenCalledWith('getPreset', { presetName: '预设A' });
    expect(out).toMatchObject({ settings: { temperature: 0.5 } });
  });

  it('不传名字 ⇒ 交给父侧 undefined（父侧按 in_use 处理）', async () => {
    const { th, requestParent } = buildFrame({ ok: true, success: true, preset: { prompts: [] } });
    await th.getPreset();
    const call = (requestParent as any).mock.calls.at(-1) as any[];
    expect(call[0]).toBe('getPreset');
    expect(call[1].presetName).toBeUndefined();
  });

  it('预设不存在 ⇒ 抛错（d.ts 的 @throws，不返 undefined 装成功）', async () => {
    const { th } = buildFrame({ ok: true, success: false, error: 'preset_not_found' });
    await expect(th.getPreset('查无此预设')).rejects.toThrow(/preset_not_found/);
  });
});
