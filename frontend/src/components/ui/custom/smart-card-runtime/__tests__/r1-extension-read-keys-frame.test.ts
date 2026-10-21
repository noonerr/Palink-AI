/*
 * 批次R1（2026-10-21）· 帧内扩展读面 5 键的行为契约。
 *
 * 口径：执行型，一律用求值后载体 `COMPAT_V2_RUNTIME_ARTIFACT`（与生产 iframe
 * 逐字节同源的脚本），**不拿未求值源码文本 new Function**。
 *
 * 契约一手（酒馆助手 @types/function/extension.d.ts + index.d.ts:47）：
 *   isAdmin(): boolean                                     :2  同步
 *   getTavernHelperExtensionId(): string                   :5  同步
 *   getExtensionType(id): 'local'|'global'|'system'|null   :15 同步
 *   isInstalledExtension(id): boolean                      :40 同步
 *   getExtensionStatus = getExtensionInstallationInfo      index.d.ts:47 +
 *     src/function/extension.ts:23-39 —— **异步**，不含"启用与否"。
 *
 * 数据源：ctx.extensionCatalog（宿主按 user_id 作用域拉好的快照）与
 * ctx.isAdmin（App 的 /api/users/me role 快照）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/r1-extension-read-keys-frame.test.ts
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

const CATALOG = {
  isAdmin: true,
  source: 'runtime_config',
  plugins: [
    {
      id: 'plugin-local-1',
      extensionId: 'JS-Slash-Runner',
      name: 'JS-Slash-Runner',
      manifestName: 'JS-Slash-Runner',
      type: 'local',
      enabled: true,
      version: '5.9.0',
      sourceUrl: null,
    },
    {
      id: 'plugin-global-1',
      extensionId: 'Global-Ext',
      name: 'Global Ext',
      manifestName: 'Global-Ext',
      type: 'global',
      enabled: false,
      version: '1.2.3',
      sourceUrl: 'https://example.com/global-ext.git',
    },
  ],
};

function buildFrame(stub: {
  ctx?: Record<string, unknown>;
  parentResult?: unknown;
} = {}) {
  const BACKSLASH = String.fromCharCode(92);
  const requestParent = vi.fn(async () => (
    stub.parentResult === undefined ? { ok: true, success: true } : stub.parentResult
  ));
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
      ...(stub.ctx || {}),
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

const warned = (post: any, needle: string) => (post.mock.calls as any[]).some((call) => {
  const msg = String((call[0] && call[0].message) || '');
  return msg.indexOf(needle) >= 0;
});

describe('5 键确实注册；破坏性四键仍不注册（R2 边界）', () => {
  it('读类 5 键都是函数', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG, isAdmin: true } });
    ['getExtensionStatus', 'getExtensionType', 'getTavernHelperExtensionId', 'isInstalledExtension', 'isAdmin']
      .forEach((name) => expect(typeof th[name], name).toBe('function'));
  });

  it('install / uninstall / reinstall / update 四键必须仍未注册（本批不做）', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG, isAdmin: true } });
    ['installExtension', 'uninstallExtension', 'reinstallExtension', 'updateExtension']
      .forEach((name) => expect(th[name], name + ' 属批次R2，不得在本批出现').toBeUndefined());
  });
});

describe('getTavernHelperExtensionId（extension.d.ts:5）', () => {
  it("同步返回 'JS-Slash-Runner'（酒馆助手源码里的常量，src/function/extension.ts:7-9）", () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG } });
    const value = th.getTavernHelperExtensionId();
    expect(value).toBe('JS-Slash-Runner');
    expect(value && typeof value.then).not.toBe('function');
  });
});

describe('getExtensionType（extension.d.ts:15）', () => {
  it('本地私有插件 => local；全局插件 => global（数据来自 ctx.extensionCatalog）', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG } });
    expect(th.getExtensionType('JS-Slash-Runner')).toBe('local');
    expect(th.getExtensionType('Global-Ext')).toBe('global');
  });

  it('按 ST 后缀匹配：传内部全名 third-party/Global-Ext 也命中', () => {
    const { th } = buildFrame({
      ctx: {
        extensionCatalog: {
          ...CATALOG,
          plugins: [{ ...CATALOG.plugins[1], extensionId: 'third-party/Global-Ext' }],
        },
      },
    });
    expect(th.getExtensionType('Global-Ext')).toBe('global');
    expect(th.getExtensionType('third-party/Global-Ext')).toBe('global');
  });

  it('不存在 => null（同步，不返回 Promise）', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG } });
    const value = th.getExtensionType('Not-Installed');
    expect(value).toBeNull();
    expect(value && typeof value.then).not.toBe('function');
  });

  it('目录未就绪 => null + 留痕（不冒充"未安装"）', () => {
    const { th, post } = buildFrame({ ctx: {} });
    expect(th.getExtensionType('JS-Slash-Runner')).toBeNull();
    expect(warned(post, '扩展目录未就绪')).toBe(true);
  });
});

describe('isInstalledExtension（extension.d.ts:40）', () => {
  it('= getExtensionType !== null：已装 true / 未装 false', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG } });
    expect(th.isInstalledExtension('JS-Slash-Runner')).toBe(true);
    expect(th.isInstalledExtension('Global-Ext')).toBe(true);
    expect(th.isInstalledExtension('Not-Installed')).toBe(false);
  });

  it('返回布尔而不是 thenable（同步契约）', () => {
    const { th } = buildFrame({ ctx: { extensionCatalog: CATALOG } });
    const value = th.isInstalledExtension('JS-Slash-Runner');
    expect(typeof value).toBe('boolean');
    expect(value && typeof value.then).not.toBe('function');
  });
});

describe('isAdmin（extension.d.ts:2）—— 两种角色各一条 + 缺省安全默认', () => {
  it('admin 角色 => true（真值来自 ctx.isAdmin，不是恒值）', () => {
    const { th } = buildFrame({ ctx: { isAdmin: true } });
    expect(th.isAdmin()).toBe(true);
  });

  it('非 admin 角色 => false', () => {
    const { th } = buildFrame({ ctx: { isAdmin: false } });
    expect(th.isAdmin()).toBe(false);
  });

  it('宿主没有下发角色 => false（安全默认）并留痕，不冒充管理员', () => {
    const { th, post } = buildFrame({ ctx: {} });
    expect(th.isAdmin()).toBe(false);
    expect(warned(post, '宿主未下发当前用户角色')).toBe(true);
  });

  it('返回值是同步布尔，不是 Promise', () => {
    const { th } = buildFrame({ ctx: { isAdmin: true } });
    const value = th.isAdmin();
    expect(typeof value).toBe('boolean');
    expect(value && typeof value.then).not.toBe('function');
  });
});

describe('getExtensionStatus（index.d.ts:47 = getExtensionInstallationInfo，异步）', () => {
  it('异步返回 ST 四字段（不是"启用与否"；enabled 是 Palink 附加字段）', async () => {
    const info = {
      current_branch_name: '',
      current_commit_hash: '5.9.0',
      is_up_to_date: true,
      remote_url: '',
      enabled: true,
    };
    const { th, requestParent } = buildFrame({
      ctx: { extensionCatalog: CATALOG },
      parentResult: { ok: true, success: true, info },
    });
    const promise = th.getExtensionStatus('JS-Slash-Runner');
    expect(promise && typeof promise.then).toBe('function');
    await expect(promise).resolves.toEqual(info);
    expect(requestParent).toHaveBeenCalledWith('getExtensionStatus', { extensionId: 'JS-Slash-Runner' });
  });

  it('扩展不存在 => null（d.ts 的"未安装"口径，不抛错）', async () => {
    const { th } = buildFrame({
      ctx: { extensionCatalog: CATALOG },
      parentResult: { ok: true, success: true, info: null },
    });
    await expect(th.getExtensionStatus('Not-Installed')).resolves.toBeNull();
  });

  it('父侧失败 => 抛错（可见失败，不静默返回 null 装成"未安装"）', async () => {
    const { th } = buildFrame({
      ctx: { extensionCatalog: CATALOG },
      parentResult: { ok: false, success: false, error: 'boom' },
    });
    await expect(th.getExtensionStatus('JS-Slash-Runner')).rejects.toThrow(/getExtensionStatus 失败/);
  });
});
