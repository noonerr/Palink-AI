/*
 * [PLUGIN-ON-DEMAND L1] 切卡差集热插拔契约测试（spec §2.7.3）
 *
 * 要钉住的两条语义：
 *   1. **共用插件的节点不被重建** —— 切到另一张卡时，两张卡都用的插件必须保持
 *      同一个 DOM 节点实例（节点身份不变 = 已绑事件/面板状态不丢 = 肉眼无闪烁）。
 *   2. **消失的插件必须被卸干净** —— 只在卡 A 里出现的插件，切到卡 B 后容器里
 *      不能残留它的 script / style（`<anchor>[data-palink-st-plugin-id]` 锚点回收）。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  SillyTavernPluginRuntime,
  computePluginDiff,
} from '../sillyTavernPluginRuntime';

// 桥接层里有自发请求（如刷新世界书名），jsdom 下相对 URL 无法解析会刷一堆
// ERR_INVALID_URL 噪声，掩盖真正的结果。这里 stub 掉 fetch，只保留可读性。
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => [],
      text: async () => '[]',
      clone() {
        return this;
      },
    })),
  );
});

const SETUP_ID = '__palink_runtime_setup__';

function makePlugin(id: string, name: string) {
  return {
    id,
    name,
    plugin_type: 'sillytavern_extension',
    source_type: 'manual',
    resources: {
      css: [{ content: `.${id}-style{color:red}` }],
      js: [{ content: `window.__${id}_marker = 'loaded';` }],
    },
  } as any;
}

function makeRuntime(pluginIds: string[]) {
  const runtime = new SillyTavernPluginRuntime();
  (runtime as any).config = { plugins: pluginIds.map((id) => makePlugin(id, id)) } as any;
  return runtime;
}

function nodesFor(container: HTMLElement, pluginId: string) {
  return Array.from(
    container.querySelectorAll('script[data-palink-st-plugin-id], style[data-palink-st-plugin-id]'),
  ).filter((el) => el.getAttribute('data-palink-st-plugin-id') === pluginId);
}

describe('computePluginDiff（纯函数，差集计算的边界）', () => {
  it('当前为空 → 全部需要注入，无卸载', () => {
    expect(computePluginDiff([], ['a', 'b'])).toEqual({ toUnload: [], toInject: ['a', 'b'] });
  });

  it('清单不变 → 两个差集都为空（这是"不闪"的数学前提）', () => {
    expect(computePluginDiff(['a', 'b'], ['b', 'a'])).toEqual({ toUnload: [], toInject: [] });
  });

  it('与顺序无关，只按成员判定', () => {
    expect(computePluginDiff(['a', 'b'], ['b', 'c'])).toEqual({ toUnload: ['a'], toInject: ['c'] });
  });

  it('目标为空 → 全部卸载，无注入', () => {
    expect(computePluginDiff(['a'], [])).toEqual({ toUnload: ['a'], toInject: [] });
  });

  it('setup 脚本锚点不参与差集（它不属于任何插件）', () => {
    expect(computePluginDiff([SETUP_ID, 'a'], [SETUP_ID, 'a'])).toEqual({
      toUnload: [],
      toInject: [],
    });
    expect(computePluginDiff([SETUP_ID], [])).toEqual({ toUnload: [], toInject: [] });
  });

  it('重复 id 去重（历史赋值多次也不会算出重复清单）', () => {
    expect(computePluginDiff(['a', 'a', 'b'], ['b', 'b'])).toEqual({
      toUnload: ['a'],
      toInject: [],
    });
  });
});

describe('injectIntoContainer diffOnly（DOM 层热插拔）', () => {
  it('共用插件保持同一节点实例；仅差异部分被装卸', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const runtime = makeRuntime(['a', 'b']);
    runtime.injectIntoContainer(container);
    expect(runtime.getInjectedPluginIds().sort()).toEqual(['a', 'b']);

    const aNodeBefore = nodesFor(container, 'a')[0];
    expect(aNodeBefore).toBeTruthy();

    // 切到「共用 a + 新增 c」的卡：b 该走，a 必须原样留着
    (runtime as any).config = {
      plugins: [makePlugin('a', 'a'), makePlugin('c', 'c')],
    } as any;
    runtime.injectIntoContainer(container, { diffOnly: true });

    expect(runtime.getInjectedPluginIds().sort()).toEqual(['a', 'c']);
    // ① 共用插件：节点身份不变
    expect(nodesFor(container, 'a')[0]).toBe(aNodeBefore);
    // ② 已消失的插件：节点被回收干净
    expect(nodesFor(container, 'b')).toHaveLength(0);
    // ③ 新增插件：确实注入了
    expect(nodesFor(container, 'c').length).toBeGreaterThan(0);

    runtime.unloadAll();
    container.remove();
  });

  it('setup 脚本在差集注入下不会重复追加', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const runtime = makeRuntime(['a']);
    runtime.injectIntoContainer(container);
    runtime.injectIntoContainer(container, { diffOnly: true });
    runtime.injectIntoContainer(container, { diffOnly: true });

    expect(nodesFor(container, SETUP_ID)).toHaveLength(1);

    runtime.unloadAll();
    container.remove();
  });

  it('名单清空 → 插件节点全部回收，容器只剩 setup（走一次全量外部清理）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const runtime = makeRuntime(['a']);
    runtime.injectIntoContainer(container);
    (runtime as any).config = { plugins: [] } as any;
    runtime.injectIntoContainer(container, { diffOnly: true });

    expect(runtime.getInjectedPluginIds()).toEqual([]);
    expect(nodesFor(container, 'a')).toHaveLength(0);

    runtime.unloadAll();
    container.remove();
  });

  it('容器换实例时差集不生效，退化为全量重装（行为与 L0 一致）', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    document.body.append(first, second);

    const runtime = makeRuntime(['a']);
    runtime.injectIntoContainer(first);
    const nodeBefore = nodesFor(first, 'a')[0];

    runtime.injectIntoContainer(second, { diffOnly: true });

    // 容器都不是同一个 → 必须重新注入一份（老容器里的节点仍在，由 unloadAll 处理）
    expect(nodesFor(second, 'a').length).toBeGreaterThan(0);
    expect(nodesFor(second, 'a')[0]).not.toBe(nodeBefore);

    runtime.unloadAll();
    first.remove();
    second.remove();
  });

  it('unloadPlugin 单独调用可精确摘掉一个插件', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const runtime = makeRuntime(['a', 'b']);
    runtime.injectIntoContainer(container);

    expect(runtime.unloadPlugin('b')).toBe(true);
    expect(nodesFor(container, 'b')).toHaveLength(0);
    expect(nodesFor(container, 'a').length).toBeGreaterThan(0);
    expect(runtime.getInjectedPluginIds()).toEqual(['a']);

    runtime.unloadAll();
    container.remove();
  });
});
