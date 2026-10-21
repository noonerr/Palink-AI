/*
 * 小尾巴批次 ③-B4：宿主插件沙箱「写侧越界、读侧不认」的读写同域回归（2026-10-21）
 *
 * 真机现象（本轮实测复现，非引用二手结论）：
 *   [Plugin Regex] RegexPresetManager: Could not find preset select element in the DOM.
 *   现场：http://localhost:16000/characters/c28061bb… 控制台 msgid=45。
 *
 * 病灶链条（每一环都有可执行断言，见下）：
 *   1. `st-plugins/regex/index.js:1728` 取模板、`:1729` `$('#regex_container').append(settingsHtml)`
 *      —— 写侧走 `createSandboxedJQuery` 的 ST 挂载点回退（sandbox.ts 原 :1546-1568），
 *      节点落进 **真实 document 的 `#regex_container`**（React 在 `#extensions_settings2` 下渲染的那个），
 *      而**不是**插件私有 container `#palink-extension-container-<id>`。
 *   2. 同一文件 `:161` 随后用 `document.getElementById('regex_presets')` 取自己刚写进去的节点
 *      —— 读侧（`sandboxedDocument` 的 getElementById）只查私有 container，
 *      container 外只对 `ST_MOUNT_POINT_IDS` / `ST_CHAT_SELECTOR_IDS` 两个白名单回退，
 *      `regex_presets` 两个都不在 ⇒ 返回 null ⇒ `:163` 报错并 return，
 *      **预设下拉的 change/create/update/apply/delete 监听器永远不挂**。
 *   ⇒ 写面比读面宽：插件能写进挂载点，却读不到自己写进去的东西。
 *
 * 修法（sandbox.ts `isInsidePluginWritableMount`）：读侧对"写侧本来就能写进去的那两处"
 *   （id 命中 ST_MOUNT_POINT_IDS 的祖先之下、或 `[data-sandbox-created-container]` 之下）
 *   开放回退。**不放开任意真实 document 元素** —— 第 3 条用例就是钉这条边界的。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/b4-regex-preset-select-mount.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginSandbox } from '../sandbox';

/** 真实模板：与生产同一份文件，不造夹具（8745 字节，含 #regex_presets_block / select#regex_presets）。 */
const DROPDOWN_HTML = readFileSync(
  join(process.cwd(), '..', 'st-plugins', 'regex', 'dropdown.html'),
  'utf8',
);

const CONTEXT = {
  on: () => {},
  off: () => {},
  emit: () => {},
  once: () => {},
  removeAllListeners: () => {},
  storage: {
    get: () => undefined,
    set: () => {},
    delete: () => {},
    clear: () => {},
  },
  registerCommand: () => {},
  registerMacro: () => {},
  log: () => {},
};

/**
 * 插件侧结果回收：沙箱把 window 代理掉了，写 window.__x 不会落到测试侧的 window。
 * 所以让插件把结果序列化进一个 data-probe 属性、append 到 document.body
 * （body 被重映射到插件私有 container，测试侧照样读得到）。
 */
function containerFor(pluginId: string): HTMLElement | null {
  const sanitized = String(pluginId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return document.getElementById(`palink-extension-container-${sanitized}`);
}

async function runProbePlugin(pluginId: string, body: string, templates: unknown[]): Promise<any> {
  const ctx: any = { ...CONTEXT, pluginTemplates: templates };
  const sandbox = new PluginSandbox();
  await sandbox.executePluginCode(
    `
      import { renderExtensionTemplateAsync } from 'extensions.js';
      export async function init() {
        var __result = {};
        ${body}
        var __sink = document.createElement('div');
        __sink.setAttribute('data-probe', JSON.stringify(__result));
        document.body.appendChild(__sink);
      }
    `,
    ctx,
    pluginId,
  );
  await sandbox.callActivateHook(pluginId, 'init');
  const sink = containerFor(pluginId)?.querySelector('[data-probe]');
  expect(sink, '插件侧结果回收器必须落在私有 container 内').toBeTruthy();
  return JSON.parse(sink!.getAttribute('data-probe') as string);
}

/** 复刻生产 DOM：React 已渲染 #extensions_settings2 > 空的 #regex_container。 */
function seedHostDom(extra = ''): void {
  document.body.innerHTML =
    '<div id="root"><div id="extensions_settings2">' +
    '<div id="regex_container" class="extension_container"></div>' +
    '<div id="qr_container" class="extension_container"></div>' +
    '</div>' + extra + '</div>';
}

describe('B4 宿主插件沙箱读写同域（执行型，真实 PluginSandbox + 真实 dropdown.html）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('① 写侧：真实 dropdown.html 经 extensions.js 轨渲染后，确实落进真实 #regex_container', async () => {
    seedHostDom();
    const out = await runProbePlugin(
      'b4-write',
      `
        var html = await renderExtensionTemplateAsync('regex', 'dropdown');
        __result.htmlLen = String(html || '').length;
        $('#regex_container').append($(html));
        var rc = document.getElementById('regex_container');
        __result.rcChildren = rc && rc.children ? rc.children.length : -1;
      `,
      [{ path: 'dropdown.html', content: DROPDOWN_HTML }],
    );
    // 模板不是空串（空串就是本轮线上"容器一直空着"的那一型故障）
    expect(out.htmlLen, 'renderExtensionTemplateAsync 不得返回空串').toBeGreaterThan(200);
    expect(out.rcChildren).toBeGreaterThanOrEqual(1);
    // 真实 document 侧同步可见
    expect(document.getElementById('regex_container')!.children.length).toBeGreaterThanOrEqual(1);
    expect(document.getElementById('regex_presets')).not.toBeNull();
  });

  it('② 读侧（修复本体）：插件随后 document.getElementById 能读到自己写进挂载点的节点', async () => {
    seedHostDom();
    const out = await runProbePlugin(
      'b4-read',
      `
        var html = await renderExtensionTemplateAsync('regex', 'dropdown');
        $('#regex_container').append($(html));
        var sel = document.getElementById('regex_presets');
        __result.found = sel ? 'FOUND' : 'NULL';
        __result.tag = sel ? String(sel.tagName) : '';
        // 监听器能不能挂，就看这一步 —— 复刻 index.js:161 之后紧接着的 addEventListener
        __result.canBind = !!(sel && typeof sel.addEventListener === 'function');
        if (sel) sel.addEventListener('change', function () {});
      `,
      [{ path: 'dropdown.html', content: DROPDOWN_HTML }],
    );
    expect(out.found, '修复前这里必为 NULL（写越界/读不认）').toBe('FOUND');
    expect(out.tag).toBe('SELECT');
    expect(out.canBind).toBe(true);
  });

  it('③ 边界：真实 document 里不在任何 ST 挂载点之下的 id，插件仍然读不到（读面没被放开）', async () => {
    seedHostDom('<div id="palink-app-private"><span id="app-internal-node">x</span></div>');
    const out = await runProbePlugin(
      'b4-boundary',
      `
        __result.appNode = document.getElementById('app-internal-node') ? 'VISIBLE' : 'HIDDEN';
        __result.chatNode = document.getElementById('regex_container') ? 'VISIBLE' : 'HIDDEN';
      `,
      [],
    );
    // #app-internal-node 在 #root 下但不在挂载点白名单之下 ⇒ 必须继续读不到
    expect(out.appNode).toBe('HIDDEN');
    // #regex_container 本身是白名单挂载点 ⇒ 一直读得到（既有口径不变）
    expect(out.chatNode).toBe('VISIBLE');
  });

  it('④ 惰性容器：$() 在 #palink-plugin-mount 下建出来的容器，其内部节点读侧同样认', async () => {
    // 只给 #root，不给任何 ST 容器 ⇒ 逼 $() 走惰性创建分支（qr_container 在 ST_MOUNT_POINT_IDS 里）
    document.body.innerHTML = '<div id="root"></div>';
    const out = await runProbePlugin(
      'b4-lazy',
      `
        var inner = document.createElement('div');
        inner.setAttribute('id', 'lazy_inner_node');
        var deep = document.createElement('b');
        deep.setAttribute('id', 'lazy_deep_node');
        inner.appendChild(deep);
        // getElementById 走 ST_MOUNT_POINT_IDS 的惰性创建分支拿到容器，再原生 appendChild
        var target = document.getElementById('qr_container');
        target.appendChild(inner);
        __result.createdContainer = target ? 'YES' : 'NO';
        __result.createdAttrPresent = (function () {
          var c = document.getElementById('qr_container');
          return c && c.hasAttribute('data-sandbox-created-container') ? 'YES' : 'NO';
        })();
        __result.containerChildren = (function () {
          var c = document.getElementById('qr_container');
          return c ? c.children.length : -1;
        })();
        __result.inner = document.getElementById('lazy_inner_node') ? 'FOUND' : 'NULL';
        __result.deep = document.getElementById('lazy_deep_node') ? 'FOUND' : 'NULL';
      `,
      [],
    );
    expect(out.createdContainer).toBe('YES');
    expect(out.createdAttrPresent, '惰性容器必须带 data-sandbox-created-container 标记').toBe('YES');
    expect(out.containerChildren).toBeGreaterThanOrEqual(1);
    expect(out.inner).toBe('FOUND');
    expect(out.deep, '惰性容器要往下多层也必须能读（不只直接子节点）').toBe('FOUND');
  });

  it('⑤ 反证锚点：修复判据真的依赖新分支 —— 挂载点之外的同名节点仍返回 null', async () => {
    // 同名 id 放在非挂载点子树里：读侧不得因为"有这个名字"就放行
    document.body.innerHTML =
      '<div id="root"><div id="somewhere-else"><select id="regex_presets"></select></div></div>';
    const out = await runProbePlugin(
      'b4-negative',
      `
        __result.outsideMount = document.getElementById('regex_presets') ? 'FOUND' : 'NULL';
      `,
      [],
    );
    expect(out.outsideMount).toBe('NULL');
  });

  it('⑥ querySelector 口径与 getElementById 一致（纯 #id 选择器同样回退）', async () => {
    seedHostDom();
    const out = await runProbePlugin(
      'b4-qsa',
      `
        var html = await renderExtensionTemplateAsync('regex', 'dropdown');
        $('#regex_container').append($(html));
        __result.bySelector = document.querySelector('#regex_presets') ? 'FOUND' : 'NULL';
      `,
      [{ path: 'dropdown.html', content: DROPDOWN_HTML }],
    );
    expect(out.bySelector).toBe('FOUND');
  });
});
