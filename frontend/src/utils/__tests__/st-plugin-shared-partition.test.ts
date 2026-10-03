/**
 * [B4-SHARED-PARTITION] 切卡后共用插件的扩展提示词注入不丢 —— 回归测试。
 *
 * 背景（两个各自正确的设计合在一起是错的）：
 *   1. 扩展提示词按角色分区（`sandbox:<characterId>`），切卡时旧卡分区被 detach；
 *   2. `injectIntoContainer({diffOnly:true})` 对**共用插件整个跳过**（script 节点
 *      不重建）→ 浏览器不重跑它 → 它的 `setExtensionPrompt` 也就不会重跑。
 * 于是 A 卡清空后，B 卡拿不到该共用插件的注入。
 *
 * 修法不重跑脚本（会闪烁/重复绑事件），而是把注册项**搬到**新分区。
 * 因此测试必须忠实模拟浏览器语义：插件脚本在 `appendChild` 那一帧自行注册
 * （靠 `registeringPluginId` 归属），而不是注入后手工补一次调用 —— 手工补
 * 等于替插件多跑一次，会得到假通过。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SillyTavernPluginRuntime } from '../sillyTavernPluginRuntime';
import { promptInjection, setActivePromptCharacter } from '@/services/prompt-injection';

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK', headers: new Headers(),
    json: async () => [], text: async () => '[]', clone() { return this; },
  })));
});

/** 插件脚本在被执行的那一帧自行注册，与真实插件同构。 */
function makePlugin(id: string) {
  return {
    id, name: id, plugin_type: 'sillytavern_extension', source_type: 'manual',
    resources: {
      css: [{ content: `.${id}{}` }],
      js: [{ content: `/* ${id} 在此帧注册 */`, registerAtExec: `${id}-fmt` }],
    },
  } as any;
}

/**
 * jsdom 不执行 appendChild 的 <script>（`runScripts` 未开）。
 *
 * 所以这里用最小侵入的方式还原「appendChild 同步执行脚本」这一帧：
 * 打一个 appendChild 包装，在**节点被 append 的同步帧内**调 window 桥完成注册。
 * 这一帧正是 `registeringPluginId` 有效的窗口，所以归属能记到插件名下，
 * rebind 才有依据。若改成注入后手工补，等于替插件多跑一次，会得到假通过。
 */
function withScriptExec(container: HTMLElement): () => void {
  const orig = container.appendChild.bind(container);
  (container as any).appendChild = (node: any) => {
    const res = orig(node);
    const pid = typeof node?.getAttribute === 'function'
      ? node.getAttribute('data-palink-st-plugin-id')
      : null;
    if (pid && !pid.startsWith('__palink')) {
      (window as any).__palinkSetExtensionPrompt?.(`${pid}-fmt`, `FORMAT-FROM-${pid}`, 1, 2);
    }
    return res;
  };
  return () => { (container as any).appendChild = orig; };
}

function scripts(container: HTMLElement) {
  return Array.from(container.querySelectorAll('script[data-palink-st-plugin-id]'));
}

function nodeOf(container: HTMLElement, pluginId: string, tag = 'script') {
  return Array.from(container.querySelectorAll(`${tag}[data-palink-st-plugin-id]`))
    .find(n => n.getAttribute('data-palink-st-plugin-id') === pluginId);
}

describe('B4 共用插件的扩展提示词跨卡搬运', () => {
  it('切到 B 卡后，A/B 共用插件的注入条目仍在 B 分区', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const restore = withScriptExec(container);
    const runtime = new SillyTavernPluginRuntime();

    setActivePromptCharacter('card-A');
    (runtime as any).config = { plugins: [makePlugin('shared'), makePlugin('onlyA')] };
    runtime.injectIntoContainer(container);

    const A = Object.keys(promptInjection.getPromptsForGeneration('card-A'));
    expect(A).toContain('shared-fmt');
    expect(A).toContain('onlyA-fmt');

    // 切卡：同步 effect 先 detach 旧分区并切活动角色，插件注入随后异步到达
    promptInjection.detachSandbox('card-A');
    setActivePromptCharacter('card-B');
    (runtime as any).config = { plugins: [makePlugin('shared'), makePlugin('onlyB')] };
    runtime.injectIntoContainer(container, { diffOnly: true });

    const B = Object.keys(promptInjection.getPromptsForGeneration('card-B'));
    // 共用插件：脚本没重跑，但注册项必须被搬过来
    expect(B).toContain('shared-fmt');
    // B 独有插件：这一轮真的执行了，正常注册
    expect(B).toContain('onlyB-fmt');
    // A 独有插件不该出现在 B
    expect(B).not.toContain('onlyA-fmt');

    restore();
    runtime.unloadAll();
    container.remove();
  });

  it('搬运不重建共用插件的 DOM 节点（无闪烁、无重复注入）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const restore = withScriptExec(container);
    const runtime = new SillyTavernPluginRuntime();

    setActivePromptCharacter('card-A');
    (runtime as any).config = { plugins: [makePlugin('shared'), makePlugin('onlyA')] };
    runtime.injectIntoContainer(container);
    const scriptBefore = nodeOf(container, 'shared');
    const styleBefore = nodeOf(container, 'shared', 'style');

    promptInjection.detachSandbox('card-A');
    setActivePromptCharacter('card-B');
    (runtime as any).config = { plugins: [makePlugin('shared'), makePlugin('onlyB')] };
    runtime.injectIntoContainer(container, { diffOnly: true });

    // 节点身份不变 → 事件绑定、面板 DOM、插件内部状态都不丢
    expect(nodeOf(container, 'shared')).toBe(scriptBefore);
    expect(nodeOf(container, 'shared', 'style')).toBe(styleBefore);
    // 共用插件只注入一份，不因搬运而重复
    expect(scripts(container).filter(n => n.getAttribute('data-palink-st-plugin-id') === 'shared')).toHaveLength(1);
    // A 独有插件被卸掉
    expect(nodeOf(container, 'onlyA')).toBeUndefined();

    restore();
    runtime.unloadAll();
    container.remove();
  });

  it('detach 留存快照供后续搬运，clear 则不留存', () => {
    promptInjection.clear();
    setActivePromptCharacter('card-X');
    promptInjection.setExtensionPrompt('x-fmt', 'X', 1, 2);

    promptInjection.detachSandbox('card-X');
    expect(promptInjection.getPromptsForGeneration('card-X')).toEqual({});
    expect(Object.keys(promptInjection.peekDetachedSandbox('card-X'))).toContain('x-fmt');

    promptInjection.clear();
    setActivePromptCharacter('card-Y');
    promptInjection.setExtensionPrompt('y-fmt', 'Y', 1, 2);
    promptInjection.clearCharacterSandbox('card-Y');
    expect(Object.keys(promptInjection.peekDetachedSandbox('card-Y'))).toEqual([]);
  });
});