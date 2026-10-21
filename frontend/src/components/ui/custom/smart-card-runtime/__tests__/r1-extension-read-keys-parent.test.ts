/*
 * 批次R1（2026-10-21）· 扩展读面 / 启停的父侧落点与越权面。
 *
 * 这份证明"数据从哪来、对谁生效"：
 *   - getExtensionCatalog ← GET /api/plugins/runtime/config（管理员加 include_disabled=1）
 *   - getExtensionStatus  ← 同一目录 + ST installation info 形状（@types/function/extension.d.ts:17-29）
 *   - toggleSmartCardExtension ← PUT /api/plugins/{id}/toggle（后端按 user_id 作用域收紧）
 *
 * 越权口径（本文件的重点）：
 *   - 他人的插件根本不在按 user_id 过滤的目录里 ⇒ extension_not_found，**不发起 PUT**；
 *   - 全局插件对非管理员 ⇒ admin_required，**不发起 PUT**；
 *   - 目录读取失败 ⇒ 显式错误，不吞成"未安装"。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/r1-extension-read-keys-parent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const invalidateCacheMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', () => ({
  api: apiMock,
  invalidateCache: invalidateCacheMock,
}));

import { handleSmartCardCompatRequest } from '../SmartCardCompatController';
import {
  SMART_CARD_EXTENSION_CATALOG_CHANGED_EVENT,
  fetchSmartCardExtensionCatalog,
  toggleSmartCardExtension,
} from '../extension-catalog';

const RUNTIME_PAYLOAD = {
  plugins: [
    {
      id: 'plugin-local-1',
      name: 'JS-Slash-Runner',
      plugin_type: 'tavern_helper',
      owner_scope: 'local',
      enabled: true,
      version: '5.9.0',
      manifest: { name: 'JS-Slash-Runner', display_name: '酒馆助手' },
      extension_settings: {},
      resources: { css: [], js: [], templates: [], modules: [], assets: [] },
    },
    {
      id: 'plugin-global-1',
      name: 'Global Ext',
      plugin_type: 'sillytavern_extension',
      owner_scope: 'global',
      enabled: false,
      version: '1.2.3',
      manifest: { name: 'Global-Ext', display_name: 'Global Ext' },
      extension_settings: {},
      resources: { css: [], js: [], templates: [], modules: [], assets: [] },
    },
  ],
  extension_settings: {},
  generated_at: '2026-10-21T00:00:00Z',
};

const ADMIN_USER = { id: 1, username: 'admin', role: 'admin' };
const NORMAL_USER = { id: 2, username: 'alice', role: 'user' };

function mockApi(role: 'admin' | 'user', payload: any = RUNTIME_PAYLOAD) {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url === '/api/users/me') return role === 'admin' ? ADMIN_USER : NORMAL_USER;
    if (url.indexOf('/api/plugins/runtime/config') === 0) {
      if (url.indexOf('include_disabled=1') >= 0) {
        if (role !== 'admin') {
          const error: any = new Error('Not enough permissions');
          error.status = 403;
          throw error;
        }
        return payload;
      }
      return {
        ...payload,
        // 非管理员端点只下发启用项（与后端 include_disabled=0 的行为一致）
        plugins: payload.plugins.filter((item: any) => item.enabled !== false),
      };
    }
    return null;
  });
}

async function callAction(actionName: string, payload: Record<string, unknown> = {}) {
  let out: { ok: boolean; result: any; error?: string } = { ok: false, result: null };
  await handleSmartCardCompatRequest(
    {} as never,
    { selectedCharacterName: '露缇雅', selectedSession: null } as never,
    {
      type: 'request',
      requestId: 'req-r1',
      action: actionName,
      payload,
      respond: (r: { ok: boolean; result?: unknown; error?: string }) => {
        out = { ok: r.ok, result: r.result, error: r.error };
      },
    } as never,
  );
  return out;
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.put.mockReset();
  invalidateCacheMock.mockReset();
});

describe('getExtensionCatalog · 按角色选择作用域', () => {
  it('管理员 => include_disabled=1，isAdmin=true，local/global/启用状态原样保留', async () => {
    mockApi('admin');
    const out = await callAction('getExtensionCatalog');
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    expect(out.result.catalog.isAdmin).toBe(true);
    expect(out.result.catalog.source).toBe('runtime_config');
    expect(
      apiMock.get.mock.calls.some((c) => String(c[0]) === '/api/plugins/runtime/config?include_disabled=1'),
    ).toBe(true);

    const local = out.result.catalog.plugins.find((p: any) => p.id === 'plugin-local-1');
    const global = out.result.catalog.plugins.find((p: any) => p.id === 'plugin-global-1');
    expect(local).toMatchObject({ extensionId: 'JS-Slash-Runner', type: 'local', enabled: true });
    expect(global).toMatchObject({ extensionId: 'Global-Ext', type: 'global', enabled: false });
  });

  it('普通用户 => 不提权请求 include_disabled，source 如实降级，isAdmin=false', async () => {
    mockApi('user');
    const out = await callAction('getExtensionCatalog');
    expect(out.result.success).toBe(true);
    expect(out.result.catalog.isAdmin).toBe(false);
    expect(out.result.catalog.source).toBe('runtime_config_enabled_only');
    expect(
      apiMock.get.mock.calls.some((c) => String(c[0]).indexOf('include_disabled=1') >= 0),
    ).toBe(false);
    // 非管理员目录里只有启用项（禁用插件不可见 => isInstalledExtension 对它只能诚实说 false，
    // 这正是 source 字段要留痕的原因）
    expect(out.result.catalog.plugins.some((p: any) => p.id === 'plugin-global-1')).toBe(false);
  });

  it('目录读取失败 => 动作可见失败（不返回空目录冒充"没装插件"）', async () => {
    apiMock.get.mockImplementation(async () => {
      throw new Error('network down');
    });
    const out = await callAction('getExtensionCatalog');
    expect(out.ok).toBe(false);
    expect(String(out.error || '')).toContain('network down');
  });
});

describe('getExtensionStatus · ST installation info 形状', () => {
  it('已安装 => 四字段 + Palink 附加 enabled；版本进 current_commit_hash', async () => {
    mockApi('admin');
    const out = await callAction('getExtensionStatus', { extensionId: 'JS-Slash-Runner' });
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    expect(out.result.info).toMatchObject({
      current_branch_name: '',
      current_commit_hash: '5.9.0',
      is_up_to_date: true,
      remote_url: '',
      enabled: true,
    });
  });

  it('不存在 => info=null（d.ts 的 null 口径，不是错误）', async () => {
    mockApi('admin');
    const out = await callAction('getExtensionStatus', { extensionId: 'Not-Installed' });
    expect(out.ok).toBe(true);
    expect(out.result.success).toBe(true);
    expect(out.result.info).toBeNull();
  });
});

describe('toggleSmartCardExtension · 成功路径与失败可见', () => {
  it('本人插件 => PUT /api/plugins/{id}/toggle，返回新状态并广播刷新事件', async () => {
    mockApi('admin');
    apiMock.put.mockResolvedValue({ enabled: false });
    const events: string[] = [];
    const handler = () => events.push('changed');
    window.addEventListener(SMART_CARD_EXTENSION_CATALOG_CHANGED_EVENT, handler);

    const result = await toggleSmartCardExtension('JS-Slash-Runner', false);
    window.removeEventListener(SMART_CARD_EXTENSION_CATALOG_CHANGED_EVENT, handler);

    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.extensionId).toBe('JS-Slash-Runner');
    expect(apiMock.put).toHaveBeenCalledWith('/api/plugins/plugin-local-1/toggle');
    expect(invalidateCacheMock).toHaveBeenCalledWith('/api/plugins/runtime/config');
    expect(events).toEqual(['changed']);
  });

  it('后端失败 => success:false + 错误信息 + status（不吞）', async () => {
    mockApi('admin');
    const error: any = new Error('Plugin not found');
    error.status = 404;
    apiMock.put.mockRejectedValue(error);

    const result = await toggleSmartCardExtension('JS-Slash-Runner', false);
    expect(result.success).toBe(false);
    expect(result.error).toBe('extension_toggle_failed');
    expect(result.message).toContain('Plugin not found');
    expect(result.status).toBe(404);
  });
});

describe('toggleSmartCardExtension · 越权面（父侧第一道）', () => {
  it('他人插件不在本用户目录里 => extension_not_found，且**不发起** PUT', async () => {
    mockApi('user');
    const result = await toggleSmartCardExtension('someone-elses-plugin', true);
    expect(result.success).toBe(false);
    expect(result.error).toBe('extension_not_found');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('全局插件 + 非管理员 => admin_required，且**不发起** PUT', async () => {
    // 管理员目录里能看到全局插件；把角色切回普通用户后目录只剩启用项。
    // 为了模拟"能看到全局插件但无权切"的 ST 语义，这里直接构造管理员目录再改 isAdmin。
    mockApi('admin');
    const catalog = await fetchSmartCardExtensionCatalog();
    expect(catalog.plugins.some((p) => p.id === 'plugin-global-1')).toBe(true);

    mockApi('user');
    // 非管理员目录里全局插件被禁用 => 默认端点不返回它；改用启用状态的全局插件验证第二道。
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/api/users/me') return NORMAL_USER;
      if (url.indexOf('/api/plugins/runtime/config') === 0) {
        return {
          ...RUNTIME_PAYLOAD,
          plugins: RUNTIME_PAYLOAD.plugins.map((p) => ({ ...p, enabled: true })),
        };
      }
      return null;
    });
    const result = await toggleSmartCardExtension('Global-Ext', false);
    expect(result.success).toBe(false);
    expect(result.error).toBe('admin_required');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('目录刷新失败 => extension_catalog_failed（不是"扩展不存在"）', async () => {
    apiMock.get.mockImplementation(async () => {
      throw new Error('catalog down');
    });
    const result = await toggleSmartCardExtension('JS-Slash-Runner', true);
    expect(result.success).toBe(false);
    expect(result.error).toBe('extension_catalog_failed');
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});
