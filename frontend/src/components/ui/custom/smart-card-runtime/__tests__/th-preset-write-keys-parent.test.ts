/*
 * 预设写类 9 键 —— 父侧动作契约测试（ST-BRIDGE-PRESET-WRITE 2026-10-26 批次TH）
 *
 * 帧内测试（h-tavernhelper-134-contract.test.ts 的 I 组）只证明"桥过去了"；这份证明**落点对不对**：
 *   ① loadPreset          → PUT  /api/prompt-manager/presets/selection（prompt_manager.py:111，404 ⇒ false）
 *   ② createPreset        → POST /api/roleplay/presets/import（multipart；同名 ⇒ created:false 不发请求）
 *   ③ deletePreset        → 逐同名 id DELETE；共享行 id（404）跳过，本人行命中即成功
 *   ④ renamePreset        → PUT  /api/roleplay/presets/{id} { name }
 *   ⑤ writeSessionPreset  → PUT  /api/prompt-manager/sessions/{宿主会话 id}/preset —— 会话 id 只认
 *                           宿主 requestContext（P2-12 #14），帧内 payload 塞的 sessionId 不顶包
 *   ⑥ replaceNamedPreset  → PUT  /api/roleplay/presets/{id}（只有生成参数列可写；prompts_written:false）
 *   ⑦ importRawPreset     → filename 参数权威（覆盖 content JSON 里的 name）；非 JSON ⇒ 拒发
 *   ⑧ 写成功后广播 PRESET_SELECTION_CHANGED_EVENT ⇒ 快照热更（render:'none' 除外）
 *
 * ⚠️ 本文件是 mock 版路由闭环；"建→读回→删→404"的真数据闭环要连真实后端跑
 *    （真机写链探针，验收阶段由主脑跑），这里钉的是**通道接对没有**。
 *
 * 契约一手：st-plugins/third-party/JS-Slash-Runner-main/@types/function/preset.d.ts:169-365
 *   + import_raw.d.ts:40。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/th-preset-write-keys-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
const notifyMock = vi.fn();

vi.mock('@/services/api', () => {
  class ApiError extends Error {
    status: number;
    // 形参与真身一致（api.ts:117 status/message/errorInfo），让 instanceof 判定走同一条路。
    constructor(status: number, message: string, _errorInfo?: unknown) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: {
      get: (...args: unknown[]) => getMock(...args),
      post: (...args: unknown[]) => postMock(...args),
      put: (...args: unknown[]) => putMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
    invalidateCache: vi.fn(),
    ApiError,
  };
});
vi.mock('@/lib/promptPresetSelection', () => ({
  notifyPresetSelectionChanged: (...args: unknown[]) => notifyMock(...args),
}));

import { ApiError } from '@/services/api';
import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const SNAPSHOT = {
  store: 'generation_presets',
  names: ['预设A', '预设B'],
  loaded_name: '预设A',
  in_use: { settings: {}, prompts: [], prompts_unused: [], extensions: {} },
  presets: {},
  source: 'session',
};

function mockApi(overrides: Record<string, unknown> = {}) {
  getMock.mockImplementation(async (url: string) => {
    if (url in overrides) return overrides[url];
    if (url === '/api/prompt-manager/presets/snapshot') return SNAPSHOT;
    if (url.indexOf('/api/prompt-manager/presets/snapshot?') === 0) return SNAPSHOT;
    if (url === '/api/roleplay/presets') {
      // 与生产同形：列表响应**不带 user_id**，可能混入 user_id IS NULL 的共享行（presets.py:114-115）。
      // id=1 模拟共享行（后端 DELETE/PUT 必 404），id=2 是本人行。
      return [
        { id: 1, name: '预设A', temperature: 0.7 },
        { id: 2, name: '预设A', temperature: 0.8 },
      ];
    }
    return null;
  });
  postMock.mockResolvedValue({ id: 9, name: '预设C' });
  putMock.mockResolvedValue({ ok: true });
  deleteMock.mockResolvedValue({ ok: true });
}

async function callAction(
  actionName: string,
  payload: Record<string, unknown> = {},
  sessionId: string | null = 'sess-1',
) {
  let out: { ok: boolean; result: any } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
    // 与生产同形：selectedSession 只由宿主构造（CharacterChat.tsx:1078），帧改不到它。
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
  postMock.mockReset();
  putMock.mockReset();
  deleteMock.mockReset();
  notifyMock.mockReset();
  mockApi();
});

describe('批次TH 预设写类 · loadPreset', () => {
  it('成功 → PUT selection 并广播快照刷新', async () => {
    const out = await callAction('loadPreset', { name: '预设B' });
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    expect(putMock).toHaveBeenCalledWith('/api/prompt-manager/presets/selection', { name: '预设B' });
    expect(notifyMock).toHaveBeenCalledWith('预设B');
  });

  it('404（查无此名/共享行）⇒ success:false preset_not_found（帧内转 false），不广播', async () => {
    putMock.mockRejectedValueOnce(new ApiError(404, 'Preset not found', {} as never));
    const out = await callAction('loadPreset', { name: '查无此名' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_not_found');
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('批次TH 预设写类 · createPreset', () => {
  it("名为 'in_use' ⇒ 拒绝，不发任何写请求", async () => {
    const out = await callAction('createPreset', { name: 'in_use', preset: {} });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_name_invalid');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('同名（快照名单已含）⇒ created:false，不发请求（d.ts:188 同名失败）', async () => {
    const out = await callAction('createPreset', { name: '预设A', preset: { settings: {}, prompts: [] } });
    expect(out.result.success).toBe(true);
    expect(out.result.created).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('新名 ⇒ 走 /import multipart，prompts 原样进文件（presets.py:287 唯一 prompts_data 写通道）', async () => {
    const preset = {
      settings: { temperature: 1, max_completion_tokens: 512, top_p: 0.9 },
      prompts: [{ id: 'main', content: '正文' }],
    };
    const out = await callAction('createPreset', { name: '预设C', preset });
    expect(out.result.success).toBe(true);
    expect(out.result.created).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, form] = postMock.mock.calls[0] as [string, FormData];
    expect(url).toBe('/api/roleplay/presets/import');
    const file = form.get('file') as File;
    const body = JSON.parse(await file.text()) as Record<string, unknown>;
    expect(body.name).toBe('预设C');
    expect(body).toMatchObject({ temperature: 1, max_tokens: 512, top_p: 0.9 });
    expect(body.prompts).toEqual([{ id: 'main', content: '正文' }]);
  });
});

describe('批次TH 预设写类 · deletePreset（共享行红线）', () => {
  it('共享行 id 404 ⇒ 跳过试下一个同名 id；本人行命中 ⇒ deleted:true', async () => {
    deleteMock.mockImplementation(async (url: string) => {
      if (url === '/api/roleplay/presets/1') throw new ApiError(404, 'Preset not found', {} as never);
      return { ok: true };
    });
    const out = await callAction('deletePreset', { name: '预设A' });
    expect(out.result.success).toBe(true);
    expect(out.result.deleted).toBe(true);
    const urls = deleteMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(['/api/roleplay/presets/1', '/api/roleplay/presets/2']);
  });

  it('只剩共享行（全 404）⇒ preset_not_found，帧内转 false —— 写/删永不落 user_id IS NULL 行', async () => {
    deleteMock.mockRejectedValue(new ApiError(404, 'Preset not found', {} as never));
    const out = await callAction('deletePreset', { name: '预设A' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_not_found');
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('名字不在快照名单（服务端只列本人行）⇒ preset_not_found，且不解析 id', async () => {
    const out = await callAction('deletePreset', { name: '别人的预设' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_not_found');
    expect(getMock).not.toHaveBeenCalledWith('/api/roleplay/presets');
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('批次TH 预设写类 · renamePreset', () => {
  it('成功 → PUT { name: 新名 } 并广播；共享行 404 跳过同 deletePreset', async () => {
    putMock.mockImplementation(async (url: string) => {
      if (url === '/api/roleplay/presets/1') throw new ApiError(404, 'Preset not found', {} as never);
      return { ok: true };
    });
    const out = await callAction('renamePreset', { name: '预设A', newName: '预设A改' });
    expect(out.result.success).toBe(true);
    expect(putMock).toHaveBeenCalledWith('/api/roleplay/presets/2', { name: '预设A改' });
    expect(notifyMock).toHaveBeenCalled();
  });

  it("新名是 'in_use' ⇒ 拒绝", async () => {
    const out = await callAction('renamePreset', { name: '预设A', newName: 'in_use' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_name_invalid');
  });
});

describe('批次TH 预设写类 · writeSessionPreset（P2-12 #14 会话顶包）', () => {
  it('会话 id 只认宿主 requestContext：帧内 payload 塞 sessionId 不顶包', async () => {
    const out = await callAction('writeSessionPreset', {
      settings: { temperature: 0.9 },
      prompts: [{ id: 'main' }],
      __palinkContext: { sessionId: '帧内伪造' },
    });
    expect(out.result.success).toBe(true);
    const [url, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/prompt-manager/sessions/sess-1/preset');
    expect(body.config).toEqual({ temperature: 0.9 });
    expect(body.entries).toEqual([{ id: 'main' }]);
  });

  it('宿主无会话 ⇒ no_active_session，不 PUT', async () => {
    const out = await callAction('writeSessionPreset', { settings: {}, prompts: [] }, null);
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('no_active_session');
    expect(putMock).not.toHaveBeenCalled();
  });

  it("render:'none'（d.ts:231 不刷新前端显示）⇒ 成功但跳过快照热更广播", async () => {
    const out = await callAction('writeSessionPreset', { settings: {}, prompts: [], render: 'none' });
    expect(out.result.success).toBe(true);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('批次TH 预设写类 · replaceNamedPreset（prompts 无全局写通道）', () => {
  it('只 PUT 生成参数列（ST max_completion_tokens → 本仓 max_tokens），prompts_written:false 如实上报', async () => {
    const out = await callAction('replaceNamedPreset', {
      name: '预设A',
      settings: { temperature: 1, max_completion_tokens: 2048, top_p: 0.5 },
      prompts: [{ id: 'main' }],
    });
    expect(out.result.success).toBe(true);
    expect(out.result.prompts_written).toBe(false);
    const [url, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/roleplay/presets/1');
    expect(body).toEqual({ temperature: 1, max_tokens: 2048, top_p: 0.5 });
  });

  it('查无此名 ⇒ preset_not_found（帧内转 @throws）', async () => {
    const out = await callAction('replaceNamedPreset', { name: '别人的预设', settings: {}, prompts: [] });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_not_found');
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('批次TH 预设写类 · importRawPreset', () => {
  it('filename 参数权威（d.ts "@param filename 预设名"）：覆盖 content JSON 自带 name', async () => {
    const out = await callAction('importRawPreset', {
      filename: '卡给的预设名',
      content: JSON.stringify({ name: 'content 里的名字', temperature: 1, prompts: [] }),
    });
    expect(out.result.success).toBe(true);
    const [url, form] = postMock.mock.calls[0] as [string, FormData];
    expect(url).toBe('/api/roleplay/presets/import');
    const body = JSON.parse(await (form.get('file') as File).text()) as Record<string, unknown>;
    expect(body.name).toBe('卡给的预设名');
  });

  it('content 不是 JSON 对象 ⇒ preset_import_invalid_json，拒发请求', async () => {
    const out = await callAction('importRawPreset', { filename: 'x', content: '这不是JSON' });
    expect(out.result.success).toBe(false);
    expect(out.result.error).toBe('preset_import_invalid_json');
    expect(postMock).not.toHaveBeenCalled();
  });
});
