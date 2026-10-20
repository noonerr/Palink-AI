/*
 * 角色库写侧 7 键 —— 父侧动作契约测试（ST-BRIDGE-CHARLIB 2026-10-20 批次B 段②）
 *
 * 钉住 SmartCardCompatController 里 dispatchSmartCardCharacterAction 一族。
 * 字段映射表（验收物）见 REPORT_包AC §7A，本文件钉住表里每一条落点：
 *   version → character_version；first_messages → first_mes + alternate_greetings；
 *   extensions → JSON 列；worldbook → worldbooks 两列合取（character_id + type='character_book'）。
 *
 * 安全口径（本文件的重点）：
 *   · 同名判重父侧做（后端 POST 不查重，character_service.py:28-44 一手核实）；
 *   · 越权：不在本人列表里的 id ⇒ 解析不到 ⇒ 绝不发 PUT/DELETE；
 *   · 删除必然级联席聊（character_service.py:118-145）⇒ 必须显式 delete_chats:true 才执行。
 *
 * 契约一手：character.d.ts:59/76/91/141/183、import_raw.d.ts:12、raw_character.d.ts:5-97
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-bridge-charlib-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
const wbListMock = vi.fn();
const wbUpdateMock = vi.fn();

vi.mock('@/services/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  invalidateCache: vi.fn(),
}));

vi.mock('@/services/worldbookApi', () => ({
  worldbookApi: {
    list: (...args: unknown[]) => wbListMock(...args),
    update: (...args: unknown[]) => wbUpdateMock(...args),
    delete: vi.fn(),
  },
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';

const CID = 'char-own-1';

const OWN_CHAR = {
  id: CID,
  name: '我的角色',
  description: 'd',
  avatar: 'a.png',
  first_mes: '开场白0',
  alternate_greetings: ['开场白1', '开场白2'],
  creator: '作者',
  character_version: '1.2',
  creator_notes: '备注',
  extensions: { regex_scripts: [], tavern_helper: { scripts: [], variables: {} } },
};

const BOOK = { id: 'wb-1', name: '书A', character_id: CID, type: 'character_book' };

function mockChars(rows: unknown[]) {
  getMock.mockImplementation(async (url: string) => {
    if (url === '/api/characters') return rows;
    return null;
  });
}

async function callAction(actionName: string, payload: Record<string, unknown> = {}) {
  let out: { ok: boolean; result: any } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
    { selectedCharacterId: CID } as never,
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
  wbListMock.mockReset();
  wbUpdateMock.mockReset();
  postMock.mockResolvedValue({ character: { id: 'char-new-1' } });
  putMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({ status: 'ok' });
  wbListMock.mockResolvedValue([BOOK]);
  wbUpdateMock.mockResolvedValue(BOOK);
  getMock.mockResolvedValue(null);
});

describe('createCharacter / createOrReplaceCharacter（character.d.ts:59-80）', () => {
  it('同名判重：已存在 ⇒ created=false 且不 POST（后端不查重，父侧补）', async () => {
    mockChars([OWN_CHAR]);
    const dup = await callAction('createCharacter', { characterName: '我的角色' });
    expect(dup.result.created).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("名为 'current' ⇒ created=false", async () => {
    mockChars([]);
    const res = await callAction('createCharacter', { characterName: 'current' });
    expect(res.result.created).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('新建：ST 字段逐条映射（version/first_messages/extensions），不夹带未知字段', async () => {
    mockChars([]);
    const res = await callAction('createCharacter', {
      characterName: '新角色',
      character: {
        description: 'desc',
        version: '2.0',
        creator: '作者B',
        creator_notes: 'notes',
        first_messages: ['开场0', '开场1', '开场2'],
        extensions: { regex_scripts: [{ id: 'r1' }], tavern_helper: { scripts: [] }, world: '书A' },
      },
    });
    expect(res.result.created).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('/api/characters');
    expect(body).toMatchObject({
      name: '新角色',
      description: 'desc',
      character_version: '2.0',
      creator: '作者B',
      creator_notes: 'notes',
      first_mes: '开场0',
      alternate_greetings: ['开场1', '开场2'],
      extensions: { regex_scripts: [{ id: 'r1' }], tavern_helper: { scripts: [] }, world: '书A' },
    });
    expect(body).not.toHaveProperty('first_messages');
    expect(body).not.toHaveProperty('version');
  });

  it('avatar 传对象（Blob 未转 dataURL）⇒ 报 avatar_blob_unsupported，不 POST', async () => {
    mockChars([]);
    const res = await callAction('createCharacter', {
      characterName: '新角色',
      character: { avatar: { __blob: true } },
    });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toBe('avatar_blob_unsupported');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('列表失败 ⇒ 抛（不返 false 冒充同名）', async () => {
    getMock.mockRejectedValue(new Error('down'));
    const res = await callAction('createCharacter', { characterName: '新角色' });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toBe('character_list_failed');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('createOrReplace：已存在走 PUT（created=false）/ 不存在走 POST（created=true）/ 同名多只抛', async () => {
    mockChars([OWN_CHAR]);
    const replaced = await callAction('createOrReplaceCharacter', {
      characterName: '我的角色',
      character: { description: '新描述' },
    });
    expect(replaced.result.created).toBe(false);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][0]).toBe('/api/characters/' + CID);

    putMock.mockClear();
    mockChars([]);
    const created = await callAction('createOrReplaceCharacter', { characterName: '新角色' });
    expect(created.result.created).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);

    mockChars([OWN_CHAR, { ...OWN_CHAR, id: 'char-own-2' }]);
    const ambiguous = await callAction('createOrReplaceCharacter', { characterName: '我的角色' });
    expect(ambiguous.result.error).toBe('character_name_ambiguous');
  });
});

describe('deleteCharacter（character.d.ts:91-94）', () => {
  it('不存在 ⇒ deleted=false 且不 DELETE；别人的 id 同理（越权面）', async () => {
    mockChars([OWN_CHAR]);
    const miss = await callAction('deleteCharacter', { characterName: '不存在的角色', options: { delete_chats: true } });
    expect(miss.result.deleted).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();

    const foreign = await callAction('deleteCharacter', { characterName: 'char-other-9', options: { delete_chats: true } });
    expect(foreign.result.deleted).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('未显式 delete_chats:true ⇒ delete_chats_required，不 DELETE（防意外级联席聊）', async () => {
    mockChars([OWN_CHAR]);
    const noOpt = await callAction('deleteCharacter', { characterName: '我的角色' });
    expect(noOpt.result.success).toBe(false);
    expect(noOpt.result.error).toBe('delete_chats_required');
    expect(deleteMock).not.toHaveBeenCalled();

    const explicitFalse = await callAction('deleteCharacter', { characterName: '我的角色', options: { delete_chats: false } });
    expect(explicitFalse.result.error).toBe('delete_chats_required');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("delete_chats:true ⇒ 执行；'current' 落到 selectedCharacterId；删除异常按后端失败抛", async () => {
    mockChars([OWN_CHAR]);
    const ok = await callAction('deleteCharacter', { characterName: 'current', options: { delete_chats: true } });
    expect(ok.result.deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith('/api/characters/' + CID);

    deleteMock.mockRejectedValue(new Error('boom'));
    const boom = await callAction('deleteCharacter', { characterName: '我的角色', options: { delete_chats: true } });
    expect(boom.result.success).toBe(false);
    expect(boom.result.error).toBe('character_delete_failed');
  });
});

describe('replaceCharacter / getCharacterDetail（character.d.ts:141-145 + 读半周期）', () => {
  it('replaceCharacter：不存在抛 character_not_found；命中走 PUT 且不动 Palink 专有列', async () => {
    mockChars([]);
    const miss = await callAction('replaceCharacter', { characterName: '我的角色', character: { description: 'x' } });
    expect(miss.result.error).toBe('character_not_found');
    expect(putMock).not.toHaveBeenCalled();

    mockChars([OWN_CHAR]);
    const ok = await callAction('replaceCharacter', {
      characterName: '我的角色',
      character: { description: '新描述', first_messages: ['新开场'] },
    });
    expect(ok.result.success).toBe(true);
    const [url, body] = putMock.mock.calls[0];
    expect(url).toBe('/api/characters/' + CID);
    expect(body).toMatchObject({ description: '新描述', first_mes: '新开场', alternate_greetings: [] });
    expect(body).not.toHaveProperty('ui_config');
    expect(body).not.toHaveProperty('preset_data');
  });

  it('replaceCharacter：worldbook 名 ⇒ 走世界书两列合取绑定（character_id + character_book）', async () => {
    mockChars([OWN_CHAR]);
    const res = await callAction('replaceCharacter', {
      characterName: '我的角色',
      character: { worldbook: '书A' },
    });
    expect(res.result.success).toBe(true);
    expect(wbUpdateMock).toHaveBeenCalledTimes(1);
    const [bookId, patch] = wbUpdateMock.mock.calls[0];
    expect(bookId).toBe('wb-1');
    expect(patch).toEqual({ character_id: CID, type: 'character_book' });
  });

  it('getCharacterDetail：读回 ST 形状（first_messages 拼接 + worldbook 名）', async () => {
    mockChars([OWN_CHAR]);
    const res = await callAction('getCharacterDetail', { characterName: '我的角色' });
    expect(res.result.success).toBe(true);
    expect(res.result.character).toMatchObject({
      name: '我的角色',
      version: '1.2',
      creator: '作者',
      creator_notes: '备注',
      worldbook: '书A',
      first_messages: ['开场白0', '开场白1', '开场白2'],
    });
  });
});

describe('importRawCharacter（import_raw.d.ts:12）', () => {
  it('dataURL ⇒ multipart POST /api/characters/import，返回 {ok,status,character_id}', async () => {
    const res = await callAction('importRawCharacter', {
      filename: 'card.png',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(res.result.success).toBe(true);
    expect(res.result.status).toBe('ok');
    expect(res.result.character_id).toBe('char-new-1');
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('/api/characters/import');
    expect(body instanceof FormData).toBe(true);
  });

  it('非 dataURL ⇒ raw_character_content_required，不发请求', async () => {
    const res = await callAction('importRawCharacter', { filename: 'card.png', dataUrl: '' });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toBe('raw_character_content_required');
    expect(postMock).not.toHaveBeenCalled();
  });
});
