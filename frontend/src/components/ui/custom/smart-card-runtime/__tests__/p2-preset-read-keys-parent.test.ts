/*
 * 预设读类 3 键 —— 父侧动作契约测试（ST-BRIDGE-PRESET 2026-10-21 批次P2 段③）
 *
 * 帧内测试（p2-preset-read-keys-frame.test.ts）只证明"桥过去了"；这份证明**落点对不对**：
 *   ① getPresetNames  ← GET /api/prompt-manager/presets（登录态 user_id 过滤）
 *   ② getLoadedPresetName ← 有会话取会话预设的 base_name（= ST 的"从哪份加载来"），
 *                          无会话退回 /presets/selection 的 resolved_name
 *   ③ getPreset('in_use') ← GET /api/prompt-manager/sessions/{id}/preset
 *      getPreset('名字')   ← 列表按名解析；不存在 ⇒ success:false（帧内转成 throw，d.ts @throws）
 *   ④ **越权面**：会话 id 只认宿主 requestContext.sessionId，帧内 payload 里塞 sessionId
 *      不生效（帧是卡写的代码，读 payload 等于把越权面交给卡）
 *
 * 契约一手：st-plugins/third-party/JS-Slash-Runner-main/@types/function/preset.d.ts
 *   getPresetNames(): string[] / getLoadedPresetName(): string /
 *   getPreset(name: 'in_use' | string): Preset（不存在 @throws）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/p2-preset-read-keys-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();

vi.mock('@/services/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  invalidateCache: vi.fn(),
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

// [批次P3 P3-B 2026-10-21] 数据源改指 `generation_presets`：
// 父侧不再读 `/api/prompt-manager/presets`（那背后是 `prompt_presets`，**全库 0 行**），
// 改读服务端一次算好的快照 `/api/prompt-manager/presets/snapshot`。
// 快照里每份预设已经是 ST `Preset` 形状（`{settings, prompts, prompts_unused, extensions}`）。
const SNAPSHOT = {
  store: 'generation_presets',
  names: ['预设B', '预设A'],
  loaded_name: '预设A',
  in_use: {
    settings: { temperature: 0.5 },
    prompts: [{ id: 'main', content: '本对话改过的内容' }],
    prompts_unused: [],
    extensions: {},
  },
  presets: {
    预设B: {
      settings: { temperature: 0.8 },
      prompts: [{ id: 'main', content: 'B 的主提示词' }],
      prompts_unused: [],
      extensions: {},
    },
    预设A: {
      settings: {},
      prompts: [{ id: 'main', content: 'A 的主提示词' }],
      prompts_unused: [],
      extensions: {},
    },
  },
  source: 'session',
};

const SESSION_PRESET = {
  source: 'session',
  name: '预设A（本对话副本）',
  base_preset_id: '12',
  base_name: '预设A',
  base_store: 'generation_presets',
  entries: [{ id: 'main', content: '本对话改过的内容' }],
  config: { temperature: 0.5 },
  is_session_copy: true,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  getMock.mockImplementation(async (url: string) => {
    if (url in overrides) return overrides[url];
    if (url === '/api/prompt-manager/presets/snapshot') return SNAPSHOT;
    if (url.indexOf('/api/prompt-manager/presets/snapshot?') === 0) return SNAPSHOT;
    if (url === '/api/prompt-manager/presets/selection') {
      return { selected_name: '预设A', resolved_name: '预设A', resolved_id: 12, source: 'selected' };
    }
    if (url.indexOf('/api/prompt-manager/sessions/') === 0) return SESSION_PRESET;
    return null;
  });
}

async function callAction(
  actionName: string,
  payload: Record<string, unknown> = {},
  sessionId: string | null = 'sess-1',
) {
  let out: { ok: boolean; result: any } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
    // 与生产同形：`CharacterChat.tsx:1078` 那次调用**同时**给 selectedSession 与 sessionId，
    // 且 selectedSession 只由宿主构造（帧改不到它）。只给 sessionId 就测不到
    // "帧用 payload.__palinkContext.sessionId 顶包"这条真实通道（主脑复核补）。
    { sessionId, selectedSession: sessionId ? ({ id: sessionId } as never) : null, selectedCharacterName: '露缇雅' } as never,
    {
      type: 'request',
      requestId: 'req-1',
      action: actionName,
      payload,
      respond: (r: { ok: boolean; result?: unknown }) => {
        out = { ok: r.ok, result: r.result };
      },
    } as never,
  );
  return out;
}

beforeEach(() => {
  getMock.mockReset();
  mockApi();
});

describe('预设读类 · getPresetNames', () => {
  it('从 `/presets/snapshot` 取名字列表（数组必须对象包裹到达）', async () => {
    const out = await callAction('getPresetNames');
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    expect(out.result.names).toEqual(['预设B', '预设A']);
    // [批次P3 P3-B] 数据源改指：这里必须是快照端点，不再是空的 `/presets`
    expect(
      getMock.mock.calls.some((c) => String(c[0]).indexOf('/api/prompt-manager/presets/snapshot') === 0),
    ).toBe(true);
    expect(
      getMock.mock.calls.some((c) => c[0] === '/api/prompt-manager/presets'),
      '`/api/prompt-manager/presets`（prompt_presets，全库 0 行）不再被本链消费',
    ).toBe(false);
  });

  it('后端访问失败 ⇒ success:false（帧内转 throw，不返空数组装成功）', async () => {
    getMock.mockImplementation(async () => {
      throw new Error('boom');
    });
    const out = await callAction('getPresetNames');
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_list_failed');
    expect(out.result.names).toBeUndefined();
  });
});

describe('预设读类 · getLoadedPresetName', () => {
  it('有会话 ⇒ 返回会话预设的 base_name（ST 的"从哪份加载来"语义）', async () => {
    const out = await callAction('getLoadedPresetName');
    expect(out.result.success).toBe(true);
    expect(out.result.name).toBe('预设A');
    expect(
      getMock.mock.calls.some((c) => c[0] === '/api/prompt-manager/sessions/sess-1/preset'),
    ).toBe(true);
  });

  it('无会话 ⇒ 退回全局选中那份（不报错、不造名字）', async () => {
    const out = await callAction('getLoadedPresetName', {}, null);
    expect(out.result.success).toBe(true);
    expect(out.result.name).toBe('预设A');
    expect(getMock.mock.calls.some((c) => c[0] === '/api/prompt-manager/presets/selection')).toBe(true);
    // 没有会话时**不该**去打会话端点（否则会 404 噪音）
    expect(getMock.mock.calls.some((c) => String(c[0]).indexOf('/sessions/') >= 0)).toBe(false);
  });

  it('一份预设都没有 ⇒ name=null（不造 Default）', async () => {
    mockApi({
      '/api/prompt-manager/sessions/sess-1/preset': {
        source: 'global',
        name: null,
        base_preset_id: null,
        base_name: null,
        entries: [],
        config: null,
        is_session_copy: false,
      },
    });
    const out = await callAction('getLoadedPresetName');
    expect(out.result.success).toBe(true);
    expect(out.result.name).toBeNull();
  });
});

describe('预设读类 · getPreset', () => {
  it("getPreset('in_use') ⇒ 本对话当前生效那份（entries→prompts、config→settings）", async () => {
    const out = await callAction('getPreset', { presetName: 'in_use' });
    expect(out.result.success).toBe(true);
    expect(out.result.preset.prompts).toEqual([{ id: 'main', content: '本对话改过的内容' }]);
    expect(out.result.preset.settings).toEqual({ temperature: 0.5 });
    // ST Preset 的另两个容器必须是空容器而不是缺字段
    expect(out.result.preset.prompts_unused).toEqual([]);
    expect(out.result.preset.extensions).toEqual({});
  });

  it('不传名字时按 in_use 处理（d.ts 的 LiteralUnion 默认口径）', async () => {
    const out = await callAction('getPreset', {});
    expect(out.result.success).toBe(true);
    expect(out.result.preset.settings).toEqual({ temperature: 0.5 });
  });

  it('按名解析全局预设；config 为 null 时 settings 是 {}（原样透传，不补默认值）', async () => {
    const out = await callAction('getPreset', { presetName: '预设A' });
    expect(out.result.success).toBe(true);
    expect(out.result.preset.prompts).toEqual([{ id: 'main', content: 'A 的主提示词' }]);
    expect(out.result.preset.settings).toEqual({});
  });

  it('名字不存在 ⇒ success:false + preset_not_found（帧内转 throw，d.ts @throws）', async () => {
    const out = await callAction('getPreset', { presetName: '查无此预设' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_not_found');
    expect(out.result.preset).toBeUndefined();
  });

  it('无会话且要 in_use ⇒ no_active_session（不拿全局份冒充"本对话"）', async () => {
    const out = await callAction('getPreset', { presetName: 'in_use' }, null);
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('no_active_session');
  });
});

describe('预设读类 · 越权面', () => {
  it('帧内 payload 里塞 sessionId 不生效：只认宿主 requestContext', async () => {
    // 宿主没有会话，payload 里伪造一个别人的会话 id
    const out = await callAction('getPreset', { presetName: 'in_use', sessionId: 'someone-else' }, null);
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('no_active_session');
    expect(
      getMock.mock.calls.some((c) => String(c[0]).indexOf('someone-else') >= 0),
      '帧内传入的 sessionId 绝不能进 URL',
    ).toBe(false);
  });

  it('宿主无会话时，帧经 payload.__palinkContext.sessionId 顶包也不生效（真实通道）', async () => {
    // 这是 `handleSmartCardCompatRequest` 里唯一让帧影响会话 id 的入口：
    // `sessionId: context.sessionId || payload.__palinkContext.sessionId`。
    // 上一例塞的是 payload.sessionId（那个键根本没人读），所以它测不到这条通道。
    // 预设面只认宿主的 selectedSession.id ⇒ 宿主没会话就是 no_active_session，
    // 绝不能拿帧给的 id 去打会话端点（用户裁定：卡片只能读自己这一份对话分身）。
    const out = await callAction('getPreset', {
      presetName: 'in_use',
      __palinkContext: { sessionId: 'someone-else-session' },
    }, null);
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('no_active_session');
    expect(
      getMock.mock.calls.some((c) => String(c[0]).indexOf('someone-else-session') >= 0),
      '帧内 __palinkContext 传入的 sessionId 绝不能进 URL',
    ).toBe(false);
  });

  it('会话 id 走 URL 编码，不拼出额外路径段', async () => {
    await callAction('getPreset', { presetName: 'in_use' }, 'a/b c');
    const call = getMock.mock.calls.find((c) => String(c[0]).indexOf('/sessions/') >= 0);
    expect(String(call?.[0])).toBe('/api/prompt-manager/sessions/a%2Fb%20c/preset');
  });

  it('__pending__ 视为"还没有会话"，不去打会话端点', async () => {
    const out = await callAction('getLoadedPresetName', {}, '__pending__');
    expect(out.result.success).toBe(true);
    expect(getMock.mock.calls.some((c) => String(c[0]).indexOf('/sessions/') >= 0)).toBe(false);
  });
});
