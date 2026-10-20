/*
 * 人设 11 键 —— 父侧动作契约测试（ST-BRIDGE-PERSONA 2026-10-20 批次B）
 *
 * 钉住 SmartCardCompatController 里 dispatchSmartCardPersonaAction 一族：
 * persona.d.ts 逐条契约的父侧落点。帧内测试（求值后载体）只证明"桥过去了"，
 * 这份证明"落库参数对不对"：ST 形状 ↔ Palink /api/personas 的字段映射、
 * 同名判重（后端 POST 无查重，父侧补）、current 走 /active、
 * 以及**越权被拒**：传一个不在本人列表里的 id ⇒ 解析不到 ⇒ 不动手（不 POST/PUT/DELETE）。
 *
 * 契约一手：
 *   persona.d.ts:30/37   getPersonaNames/Ids —— string[]
 *   persona.d.ts:44/51   getCurrentPersonaName/Id —— 无当前人设 null
 *   persona.d.ts:60      getPersonaAvatarPath —— 不存在/不唯一 null（不抛），后端失败抛
 *   persona.d.ts:71      getPersona —— 不存在/不唯一抛
 *   persona.d.ts:85-89   createPersona —— 同名返 false；后端失败抛
 *   persona.d.ts:104-108 createOrReplacePersona —— 创建 true/替换 false；名称不唯一抛
 *   persona.d.ts:119     deletePersona —— 不存在返 false；后端失败抛
 *   persona.d.ts:137-141 replacePersona —— Promise<void>；不存在抛
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-bridge-persona-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/services/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  invalidateCache: vi.fn(),
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const OWN = {
  id: 'p-own-1',
  name: '我的设',
  description: 'd',
  avatar: 'a.png',
  characterBindings: { 'char-1': 'char-1' },
  isDefault: false,
  personaShow: false,
  personaDescriptionPosition: 4,
  personaDescriptionDepth: 4,
  title: '标题',
  role: 1,
  lorebook: 'lb',
};
const OTHER = { ...OWN, id: 'p-other-1', name: '别人的设' };

function mockList(rows: unknown[]) {
  getMock.mockImplementation(async (url: string) => {
    if (url === '/api/personas') return rows;
    if (url === '/api/personas/active') {
      const hit = (rows as any[]).find((r) => r.id === 'p-own-1');
      return { activePersonaId: hit ? hit.id : null, persona: hit ?? null };
    }
    return null;
  });
}

async function callAction(actionName: string, payload: Record<string, unknown> = {}) {
  let out: { ok: boolean; result: any } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
    {} as never,
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
  postMock.mockResolvedValue({ id: 'p-new-1' });
  putMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({ ok: true });
  getMock.mockResolvedValue(null);
});

describe('人设读族（persona.d.ts:30-71）', () => {
  it('getPersonaNames / getPersonaIds 映射列表（数组必须对象包裹到达）', async () => {
    mockList([OWN, OTHER]);
    const names = await callAction('getPersonaNames');
    expect(names.ok).toBe(true);
    expect(names.result.names).toEqual(['我的设', '别人的设']);
    const ids = await callAction('getPersonaIds');
    expect(ids.result.ids).toEqual(['p-own-1', 'p-other-1']);
  });

  it('getCurrentPersonaName / getCurrentPersonaId 走 /active，无当前人设返 null', async () => {
    mockList([OWN, OTHER]);
    const name = await callAction('getCurrentPersonaName');
    expect(name.result.name).toBe('我的设');
    const id = await callAction('getCurrentPersonaId');
    expect(id.result.id).toBe('p-own-1');
    expect(getMock.mock.calls.some((c) => c[0] === '/api/personas/active')).toBe(true);

    mockList([]);
    const none = await callAction('getCurrentPersonaName');
    expect(none.result.name).toBeNull();
    const noneId = await callAction('getCurrentPersonaId');
    expect(noneId.result.id).toBeNull();
  });

  it('getPersonaAvatarPath：命中返路径；不存在返 null 且不抛；列表失败才抛', async () => {
    mockList([OWN]);
    const hit = await callAction('getPersonaAvatarPath', { personaRef: '我的设' });
    expect(hit.result.path).toBe('a.png');

    const miss = await callAction('getPersonaAvatarPath', { personaRef: '不存在的设' });
    expect(miss.ok).toBe(true);
    expect(miss.result.path).toBeNull();

    getMock.mockRejectedValue(new Error('network down'));
    const boom = await callAction('getPersonaAvatarPath', { personaRef: '我的设' });
    expect(boom.result.success).toBe(false);
    expect(boom.result.error).toBe('persona_list_failed');
  });

  it('getPersona 按名称取完整 ST 形状（connections/depth/role/lorebook 全字段）', async () => {
    mockList([OWN]);
    const got = await callAction('getPersona', { personaRef: '我的设' });
    expect(got.result.success).toBe(true);
    expect(got.result.persona).toMatchObject({
      avatar_id: 'p-own-1',
      name: '我的设',
      title: '标题',
      description: 'd',
      position: 4,
      depth: 4,
      role: 1,
      lorebook: 'lb',
      is_default: false,
    });
    // connections：Palink dict → ST 数组，只映射 character 类
    expect(got.result.persona.connections).toEqual([{ type: 'character', id: 'char-1' }]);
  });

  it('getPersona：同名多只拒（persona_name_ambiguous，不替调用方猜一只）', async () => {
    mockList([OWN, { ...OWN, id: 'p-own-2' }]);
    const got = await callAction('getPersona', { personaRef: '我的设' });
    expect(got.result.success).toBe(false);
    expect(got.result.error).toBe('persona_name_ambiguous');
  });

  it("getPersona：'current' 经 /active 解析，未设置时 persona_not_found", async () => {
    mockList([OWN]);
    const got = await callAction('getPersona', { personaRef: 'current' });
    expect(got.result.success).toBe(true);
    expect(got.result.persona.avatar_id).toBe('p-own-1');

    mockList([OTHER]);
    const none = await callAction('getPersona', { personaRef: 'current' });
    expect(none.result.success).toBe(false);
    expect(none.result.error).toBe('persona_not_found');
  });
});

describe('人设写族（persona.d.ts:85-141）', () => {
  it('createPersona：同名判重（后端 POST 无查重，父侧补）⇒ false 且不落库', async () => {
    mockList([OWN, OTHER]);
    const dup = await callAction('createPersona', { personaName: '我的设' });
    expect(dup.result.success).toBe(true);
    expect(dup.result.created).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("createPersona：名为 'current' 按契约返 false", async () => {
    mockList([]);
    const res = await callAction('createPersona', { personaName: 'current' });
    expect(res.result.created).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('createPersona：新建成功，ST 字段全部映射进 Palink 写法', async () => {
    mockList([]);
    const res = await callAction('createPersona', {
      personaName: '新设',
      persona: {
        title: 't',
        role: 2,
        lorebook: 'l',
        position: 2,
        depth: 6,
        connections: [{ type: 'character', id: 'char-9' }, { type: 'group', id: 'g-1' }],
      },
    });
    expect(res.result.created).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('/api/personas');
    expect(body).toMatchObject({
      name: '新设',
      title: 't',
      role: 2,
      lorebook: 'l',
      persona_description_position: 2,
      persona_description_depth: 6,
      // group 类连接被丢弃（用户拍板只映射 character 类），不是整包塞进扩展字段
      character_bindings: { 'char-9': 'char-9' },
    });
    expect(body).not.toHaveProperty('connections');
  });

  it('createPersona：列表失败 ⇒ 抛（不返 false 冒充"同名已存在"）', async () => {
    getMock.mockRejectedValue(new Error('list down'));
    const res = await callAction('createPersona', { personaName: '新设' });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toBe('persona_list_failed');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('createOrReplacePersona：已存在走 PUT（created=false），不存在走 POST（created=true）', async () => {
    mockList([OWN]);
    const replaced = await callAction('createOrReplacePersona', { personaName: '我的设', persona: { title: 'x' } });
    expect(replaced.result.created).toBe(false);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][0]).toBe('/api/personas/p-own-1');
    expect(postMock).not.toHaveBeenCalled();

    postMock.mockClear();
    putMock.mockClear();
    mockList([]);
    const created = await callAction('createOrReplacePersona', { personaName: '新设', persona: { title: 'x' } });
    expect(created.result.created).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('createOrReplacePersona：同名多只抛 persona_name_ambiguous', async () => {
    mockList([OWN, { ...OWN, id: 'p-own-2' }]);
    const res = await callAction('createOrReplacePersona', { personaName: '我的设' });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toBe('persona_name_ambiguous');
    expect(postMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('deletePersona：解析不到（含**别人的 id**）⇒ false 且绝不发 DELETE', async () => {
    mockList([OWN]);
    const miss = await callAction('deletePersona', { personaRef: '不存在的设' });
    expect(miss.result.success).toBe(true);
    expect(miss.result.deleted).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();

    // 越权面：别人的 persona id 不在本人列表里 ⇒ 解析不到 ⇒ 不动手
    const foreign = await callAction('deletePersona', { personaRef: 'p-other-1' });
    expect(foreign.result.deleted).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletePersona：命中才删；删除异常按后端访问失败抛', async () => {
    mockList([OWN]);
    const ok = await callAction('deletePersona', { personaRef: '我的设' });
    expect(ok.result.deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith('/api/personas/p-own-1');

    deleteMock.mockRejectedValue(new Error('delete down'));
    const boom = await callAction('deletePersona', { personaRef: '我的设' });
    expect(boom.result.success).toBe(false);
    expect(boom.result.error).toBe('persona_delete_failed');
  });

  it('replacePersona：不存在抛 persona_not_found；命中走 PUT 映射', async () => {
    mockList([]);
    const miss = await callAction('replacePersona', { personaRef: '我的设', persona: { title: 'x' } });
    expect(miss.result.success).toBe(false);
    expect(miss.result.error).toBe('persona_not_found');
    expect(putMock).not.toHaveBeenCalled();

    mockList([OWN]);
    const ok = await callAction('replacePersona', {
      personaRef: 'p-own-1',
      persona: { title: '新标题', is_default: true, connections: [{ type: 'character', id: 'char-2' }] },
    });
    expect(ok.result.success).toBe(true);
    const [url, body] = putMock.mock.calls[0];
    expect(url).toBe('/api/personas/p-own-1');
    expect(body).toMatchObject({
      title: '新标题',
      is_default: true,
      character_bindings: { 'char-2': 'char-2' },
    });
  });
});
