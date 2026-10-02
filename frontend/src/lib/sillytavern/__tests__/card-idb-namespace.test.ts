/*
 * 甲方案：IndexedDB 按角色分库 —— 契约测试
 *
 * 钉住四条不能退的语义：
 *   1. **只动白名单里的库** —— 一刀切会让 galgame 插件读到空库，Live2D 绑定直接失效。
 *   2. **不同角色开不同的库** —— 这是整个甲方案的立项理由（同名 CG 分组互相覆盖丢数据）。
 *   3. **自举脚本必须能进子帧** —— 气泡插件跑在嵌套 srcdoc 子帧里，那里是全新 realm，
 *      不继承父帧任何属性；srcdoc 的两条写入路径（属性赋值 / setAttribute）都得堵住。
 *   4. **注入的源码必须是可执行的纯 JS** —— SillyTavernCompatRuntime 是模板串，
 *      里面写错一个反引号就是「整段运行时静默死亡」，所以这里真的把它丢进 vm 跑。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import {
  CARD_SCOPED_IDB_DBS,
  IDB_NS_KILL_SWITCH_KEY,
  IDB_NS_RUNTIME_SOURCE,
  buildIdbBootstrapSource,
  prependIdbBootstrap,
  sanitizeIdbSuffix,
  scopeIdbName,
} from '../card-idb-namespace';
import { buildSillyTavernCompatRuntimeV2Shim } from '../../../components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime';

const CARD_A = '13db28eb-0000-4000-8000-000000000001';
const CARD_B = 'be906232-0000-4000-8000-000000000002';

/** 伪造一个能记录调用的 IDBFactory */
function fakeIdb() {
  const calls: Array<{ method: string; name: string; version?: number }> = [];
  return {
    calls,
    open: (name: string, version?: number) => {
      calls.push({ method: 'open', name, version });
      return { __fake: 'request' };
    },
    deleteDatabase: (name: string) => {
      calls.push({ method: 'deleteDatabase', name });
      return { __fake: 'request' };
    },
    cmp: () => 0,
  };
}

/** 把 RUNTIME_SOURCE 跑进隔离的 vm，拿到它声明的那些函数 */
function loadRuntimeSource(): Record<string, any> {
  const sandbox: Record<string, unknown> = {
    window: {},
    Object,
    JSON,
    String,
    console,
    Math,
  };
  new vm.Script(IDB_NS_RUNTIME_SOURCE).runInNewContext(sandbox);
  return sandbox as Record<string, any>;
}

describe('sanitizeIdbSuffix 后缀安全化', () => {
  it('UUID 里的连字符保留，其余非安全字符剥掉', () => {
    expect(sanitizeIdbSuffix(CARD_A)).toBe(CARD_A);
    expect(sanitizeIdbSuffix('a b/c:d')).toBe('abcd');
  });

  it('缺失或全是非法字符 → 空串（空串 = 不分库，而不是造个怪库名）', () => {
    expect(sanitizeIdbSuffix('')).toBe('');
    expect(sanitizeIdbSuffix(null)).toBe('');
    expect(sanitizeIdbSuffix(undefined)).toBe('');
    expect(sanitizeIdbSuffix('！！！')).toBe('');
  });

  it('超长会被截断，避免把库名撑爆', () => {
    expect(sanitizeIdbSuffix('a'.repeat(500)).length).toBe(64);
  });
});

describe('scopeIdbName 白名单分库', () => {
  it('白名单内的库加角色后缀，不同角色得到不同库名', () => {
    expect(scopeIdbName('BubbleDialogueAvatars', sanitizeIdbSuffix(CARD_A))).toBe(
      'BubbleDialogueAvatars__' + CARD_A,
    );
    expect(scopeIdbName('BubbleDialogueAvatars', sanitizeIdbSuffix(CARD_A))).not.toBe(
      scopeIdbName('BubbleDialogueAvatars', sanitizeIdbSuffix(CARD_B)),
    );
  });

  it('白名单外的库名原样放行（一刀切会打断 Live2D 绑定）', () => {
    // GalgameUIPluginDB 是父帧 Live2DPoolPanel 与帧内插件共用的，绝不能改
    expect(scopeIdbName('GalgameUIPluginDB', sanitizeIdbSuffix(CARD_A))).toBe('GalgameUIPluginDB');
    expect(scopeIdbName('随便什么库', sanitizeIdbSuffix(CARD_A))).toBe('随便什么库');
  });

  it('后缀为空时一律不改（拿不到角色身份就退回原生行为）', () => {
    expect(scopeIdbName('BubbleDialogueAvatars', '')).toBe('BubbleDialogueAvatars');
  });

  it('白名单内容本身就是契约的一部分，别随手加', () => {
    expect(CARD_SCOPED_IDB_DBS).toEqual(['BubbleDialogueAvatars']);
  });
});

describe('prependIdbBootstrap 自举脚本注入', () => {
  it('插在 srcdoc 最前面，保证先于子帧自己的脚本执行', () => {
    expect(prependIdbBootstrap('<div>x</div>', 'BOOT();')).toBe('<script>BOOT();</script><div>x</div>');
  });

  it('不是 HTML 就原样返回，不瞎改', () => {
    expect(prependIdbBootstrap('', 'BOOT();')).toBe('');
    expect(prependIdbBootstrap('纯文本', 'BOOT();')).toBe('纯文本');
    expect(prependIdbBootstrap(null, 'BOOT();')).toBe('');
  });
});

describe('IDB_NS_RUNTIME_SOURCE（真的丢进 vm 跑一遍）', () => {
  it('声明了运行时需要的全部函数，且能被解析执行', () => {
    const loaded = loadRuntimeSource();
    for (const fn of [
      'sanitizeIdbSuffix',
      'buildIdbBootstrap',
      'scopeIdbName',
      'makeScopedIdbShim',
      'prependIdbBootstrap',
      'installIdbShimPropagation',
    ]) {
      expect(typeof loaded[fn], `${fn} 必须存在`).toBe('function');
    }
  });

  it('vm 里的 scopeIdbName 与 TS 实现语义一致（两边不能漂移）', () => {
    const loaded = loadRuntimeSource();
    const suffix = sanitizeIdbSuffix(CARD_A);
    expect(loaded.scopeIdbName('BubbleDialogueAvatars', suffix)).toBe(
      scopeIdbName('BubbleDialogueAvatars', suffix),
    );
    expect(loaded.scopeIdbName('GalgameUIPluginDB', suffix)).toBe('GalgameUIPluginDB');
  });

  it('makeScopedIdbShim 只对白名单改名，其余透传原生实现', () => {
    const loaded = loadRuntimeSource();
    const idb = fakeIdb();
    const shim = loaded.makeScopedIdbShim(idb, sanitizeIdbSuffix(CARD_A));

    shim.open('BubbleDialogueAvatars', 3);
    shim.open('GalgameUIPluginDB', 1);
    shim.deleteDatabase('BubbleDialogueAvatars');

    expect(idb.calls).toEqual([
      { method: 'open', name: 'BubbleDialogueAvatars__' + CARD_A, version: 3 },
      { method: 'open', name: 'GalgameUIPluginDB', version: 1 },
      { method: 'deleteDatabase', name: 'BubbleDialogueAvatars__' + CARD_A },
    ]);
  });

  it('installIdbShimPropagation 堵住 srcdoc 的两条写入路径', () => {
    const loaded = loadRuntimeSource();
    let stored = '';
    let lastAttr: [string, string] | null = null;
    const proto: Record<string, any> = {};
    Object.defineProperty(proto, 'srcdoc', {
      configurable: true,
      get() {
        return stored;
      },
      set(v: string) {
        stored = v;
      },
    });
    proto.setAttribute = function (name: string, value: string) {
      lastAttr = [name, value];
    };

    const sandboxWindow = (loaded.window as Record<string, any>);
    sandboxWindow.HTMLIFrameElement = { prototype: proto };
    loaded.installIdbShimPropagation('CHAR1', 'BOOT();');

    // 路径一：el.srcdoc = x
    proto.srcdoc = '<div>dcRoot</div>';
    expect(stored).toBe('<script>BOOT();</script><div>dcRoot</div>');

    // 路径二：setAttribute('srcdoc', x)
    proto.setAttribute('srcdoc', '<p>hi</p>');
    expect(lastAttr).toEqual(['srcdoc', '<script>BOOT();</script><p>hi</p>']);

    // 非 srcdoc 的属性不受影响
    proto.setAttribute('title', 't');
    expect(lastAttr).toEqual(['title', 't']);
  });

  it('重复安装不会层层套娃（幂等，靠 __palinkIdbNs 标记）', () => {
    const loaded = loadRuntimeSource();
    const proto: Record<string, any> = {};
    let attrValue = '';
    Object.defineProperty(proto, 'srcdoc', { configurable: true, get: () => '', set: () => {} });
    proto.setAttribute = function (_name: string, value: string) {
      attrValue = value;
    };
    (loaded.window as Record<string, any>).HTMLIFrameElement = { prototype: proto };

    loaded.installIdbShimPropagation('CHAR1', 'BOOT();');
    const firstPatched = proto.setAttribute;
    loaded.installIdbShimPropagation('CHAR1', 'BOOT();');

    // 第二次调用必须识别到标记直接 return，否则会套成「前缀再前缀」的俄罗斯套娃
    expect(proto.setAttribute).toBe(firstPatched);
    expect(firstPatched.__palinkIdbNs).toBe(true);

    // 真跑一次，确认套娃没发生：<script> 前缀只应有一层
    proto.setAttribute('srcdoc', '<p>x</p>');
    expect(attrValue.match(/<script>/g)?.length ?? 0).toBe(1);
  });
});

describe('止血开关 idbNamespaceDisabled', () => {
  /** 造一个「自己是 iframe、父窗口有真实 localStorage」的沙箱 */
  function loadWithParent(parentLocalStorage: unknown) {
    const sandbox: Record<string, unknown> = { window: {}, Object, JSON, String };
    const self = sandbox.window as Record<string, any>;
    self.parent = { localStorage: parentLocalStorage };
    new vm.Script(IDB_NS_RUNTIME_SOURCE).runInNewContext(sandbox);
    // 让 window.parent !== window（上面已保证），再补 window 自身引用
    return sandbox as Record<string, any>;
  }

  it('父窗口写了 0 就关闭', () => {
    const store: Record<string, string> = { [IDB_NS_KILL_SWITCH_KEY]: '0' };
    const loaded = loadWithParent({ getItem: (k: string) => store[k] ?? null });
    expect(loaded.idbNamespaceDisabled()).toBe(true);
  });

  it('缺省 / 其它值都视为开启', () => {
    const empty = loadWithParent({ getItem: () => null });
    expect(empty.idbNamespaceDisabled()).toBe(false);

    const other = loadWithParent({ getItem: () => '1' });
    expect(other.idbNamespaceDisabled()).toBe(false);
  });

  it('父窗口不可读（跨源 / 沙箱）时不抛错，按开启处理', () => {
    const loaded = loadWithParent(
      new Proxy({}, { get() { throw new Error('SecurityError'); } }),
    );
    expect(() => loaded.idbNamespaceDisabled()).not.toThrow();
    expect(loaded.idbNamespaceDisabled()).toBe(false);
  });

  it('顶层窗口（parent === window）不当作开关来源', () => {
    const sandbox: Record<string, unknown> = { window: {}, Object, JSON, String };
    const self = sandbox.window as Record<string, any>;
    self.localStorage = { getItem: () => '0' }; // 自己是顶层，parent 就是自己
    self.parent = self;
    new vm.Script(IDB_NS_RUNTIME_SOURCE).runInNewContext(sandbox);
    expect((sandbox as Record<string, any>).idbNamespaceDisabled()).toBe(false);
  });

  it('生成的运行时脚本确实调用了这个开关（否则开关是死的）', () => {
    const built = buildSillyTavernCompatRuntimeV2Shim({
      context: {
        characterId: CARD_A,
        characterName: 'c',
        userName: 'u',
        language: 'zh',
        messageId: 1,
        messageContent: '',
        chatMessages: [],
        persistedStorage: { localStorage: {}, sessionStorage: {} },
        firstMes: '',
        alternateGreetings: [],
        sessionId: 's',
        variables: {},
        depth: 0,
        isInit: false,
        trustedNative: false,
        sourceFingerprint: 'fp',
        presentationMode: 'inline',
        viewport: null,
      },
      frameId: 'f',
      sourceHtml: '<div></div>',
      mode: 'inline',
    } as any);
    expect(built).toContain('idbNamespaceDisabled()');
    expect(built).toContain(IDB_NS_KILL_SWITCH_KEY);
  });
});

describe('子帧自举脚本 buildIdbBootstrapSource', () => {
  it('在子帧 realm 里把白名单库改名为带后缀的库', () => {
    const idb = fakeIdb();
    const sandbox: Record<string, unknown> = { window: { indexedDB: idb }, Object, JSON, String };
    new vm.Script(buildIdbBootstrapSource(sanitizeIdbSuffix(CARD_A))).runInNewContext(sandbox);

    const scoped = (sandbox.window as any).indexedDB;
    scoped.open('BubbleDialogueAvatars', 3);
    expect(idb.calls).toEqual([
      { method: 'open', name: 'BubbleDialogueAvatars__' + CARD_A, version: 3 },
    ]);
  });

  it('子帧里白名单外的库同样放行', () => {
    const idb = fakeIdb();
    const sandbox: Record<string, unknown> = { window: { indexedDB: idb }, Object, JSON, String };
    new vm.Script(buildIdbBootstrapSource(sanitizeIdbSuffix(CARD_B))).runInNewContext(sandbox);
    (sandbox.window as any).indexedDB.open('GalgameUIPluginDB', 1);
    expect(idb.calls[0].name).toBe('GalgameUIPluginDB');
  });

  it('子帧里没有 indexedDB 时不抛错（隐私模式）', () => {
    const sandbox: Record<string, unknown> = { window: {}, Object, JSON, String };
    expect(() => {
      new vm.Script(buildIdbBootstrapSource('CHAR1')).runInNewContext(sandbox);
    }).not.toThrow();
  });
});

describe('生成的运行时脚本必须带上分库能力', () => {
  const buildFor = (characterId: string) =>
    buildSillyTavernCompatRuntimeV2Shim({
      context: {
        characterId,
        characterName: '甲方案卡',
        userName: 'u',
        language: 'zh',
        messageId: 1,
        messageContent: '',
        chatMessages: [],
        persistedStorage: { localStorage: {}, sessionStorage: {} },
        firstMes: '',
        alternateGreetings: [],
        sessionId: 's',
        variables: {},
        depth: 0,
        isInit: false,
        trustedNative: false,
        sourceFingerprint: 'fp',
        presentationMode: 'inline',
        viewport: null,
      },
      frameId: 'frame-1',
      sourceHtml: '<div></div>',
      mode: 'inline',
    } as any);

  it('角色 id 随 ctx 一起注入，分库后缀由它在运行时推出', () => {
    const forA = buildFor(CARD_A);
    const forB = buildFor(CARD_B);
    expect(forA).toContain(CARD_A);
    expect(forB).toContain(CARD_B);
    // 两条路径都必须带上分库逻辑，否则外部脚本那条线会漏
    expect(forA).toContain('installIdbShimPropagation');
    expect(forA).toContain('makeScopedIdbShim');
    expect(forA).toContain('BubbleDialogueAvatars');
  });

  it('外部脚本路径（buildSmartCardCompatRuntimeExternalScript）同样带分库', async () => {
    const { buildSmartCardCompatRuntimeExternalScript } = await import(
      '../../../components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime'
    );
    const external = buildSmartCardCompatRuntimeExternalScript();
    expect(external).toContain('installIdbShimPropagation');
    expect(external).toContain('BubbleDialogueAvatars');
  });
});
