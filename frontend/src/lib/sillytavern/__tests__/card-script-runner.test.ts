/*
 * 卡内 tavern_helper 脚本执行器契约测试
 *
 * 钉住四条语义（都是 2026-09-30 定下来的硬约束）：
 *   1. 顶层 import/export 必须走 `<script type="module">`，其余走经典脚本
 *      —— 形态搞错的话整段被浏览器当非法 JS 丢掉，卡内按钮永远不出现。
 *   2. 幂等：同一条脚本只允许存在一份。
 *   3. 单条失败不拖垮整批：appendChild 抛错要落进 failed，后面的脚本照常注入。
 *   4. 止血开关（localStorage = '0'）必须整体不执行。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CARD_SCRIPT_ATTR,
  CARD_SCRIPT_KILL_SWITCH_KEY,
  CARD_SCRIPT_STORAGE_STUB,
  isTopLevelEsm,
  patchCardContentLoaded,
  removeCardTavernHelperScripts,
  runCardTavernHelperScripts,
} from '../card-script-runner';
import {
  getCompatStubStats,
  resetCompatStubStats,
} from '../../plugin-system/compat-stub-registry';

function makeExtensions(scripts: unknown[]) {
  return { tavern_helper: { scripts } } as any;
}

function entry(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, type: 'script', enabled: true, content, ...extra };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  window.localStorage.removeItem(CARD_SCRIPT_KILL_SWITCH_KEY);
  resetCompatStubStats();
});

afterEach(() => {
  document.querySelectorAll(`[${CARD_SCRIPT_ATTR}]`).forEach((n) => n.remove());
  host.remove();
});

describe('isTopLevelEsm', () => {
  it('顶层 import 判为模块（含被块注释挡在前面的写法）', () => {
    expect(isTopLevelEsm("import 'https://cdn/x.js'")).toBe(true);
    expect(isTopLevelEsm('/* hi */\nimport { a } from "x";')).toBe(true);
    expect(isTopLevelEsm('export const Schema = 1;')).toBe(true);
  });
  it('普通全局脚本判为非模块', () => {
    expect(isTopLevelEsm('var a = 1; window.b = a;')).toBe(false);
    // 正文中间出现 import 字样不算顶层 ESM
    expect(isTopLevelEsm('var s = "please import later";')).toBe(false);
  });
});

describe('runCardTavernHelperScripts', () => {
  it('模块脚本用 type=module，普通脚本用经典脚本', () => {
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('mvu', "import 'https://cdn/bundle.js'"), entry('cg', 'window.__cg=1;')]),
      host,
    );
    const mvu = host.querySelector('script[data-palink-card-script-id="mvu"]') as HTMLScriptElement;
    const cg = host.querySelector('script[data-palink-card-script-id="cg"]') as HTMLScriptElement;
    expect(mvu?.type).toBe('module');
    expect(cg?.type).not.toBe('module');
    expect(res.ran).toEqual(['mvu', 'cg']);
  });

  it('幂等：第二次调用不重复注入', () => {
    const ext = makeExtensions([entry('cg', 'window.__cg=1;')]);
    runCardTavernHelperScripts(ext, host);
    const second = runCardTavernHelperScripts(ext, host);
    expect(host.querySelectorAll('[data-palink-card-script-id="cg"]').length).toBe(1);
    expect(second.ran).toEqual([]);
    expect(second.skipped[0].reason).toContain('幂等');
  });

  it('enabled=false / 空正文 / 非 script 类型一律跳过', () => {
    const res = runCardTavernHelperScripts(
      makeExtensions([
        entry('off', 'window.x=1;', { enabled: false }),
        entry('empty', '   '),
        entry('other', 'window.y=1;', { type: 'button' }),
      ]),
      host,
    );
    expect(res.ran).toEqual([]);
    expect(res.skipped.map((s) => s.id).sort()).toEqual(['empty', 'off', 'other']);
  });

  it('单条注入抛错只计入 failed，后面的脚本照常注入（整批不被拖垮）', () => {
    const realAppend = host.appendChild.bind(host);
    const spy = vi_spy_attach_once(host, 'boom');
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('bad', 'window.bad=1;'), entry('good', 'window.good=1;')]),
      host,
    );
    spy.restore();
    expect(res.failed.map((f) => f.id)).toEqual(['bad']);
    expect(res.failed[0].error).toContain('boom');
    expect(res.ran).toEqual(['good']);
    expect(host.querySelector('[data-palink-card-script-id="good"]')).toBeTruthy();
    // 失败的那条不得留下半截节点
    expect(host.querySelectorAll('[data-palink-card-script-id="bad"]').length).toBe(0);
    void realAppend;
  });

  it('止血开关为 0 时整体不执行', () => {
    window.localStorage.setItem(CARD_SCRIPT_KILL_SWITCH_KEY, '0');
    const res = runCardTavernHelperScripts(makeExtensions([entry('cg', 'window.__cg=1;')]), host);
    expect(res.ran).toEqual([]);
    expect(res.skipped[0].reason).toContain('止血开关');
    expect(host.children.length).toBe(0);
  });

  it('没有 tavern_helper 的卡什么都不做（不误伤普通卡）', () => {
    const res = runCardTavernHelperScripts({ depth_prompt: {} }, host);
    // namespaced / storagePatchFailed：P0 起新增的改写结果清单（2026-10-02）
    expect(res).toEqual({
      ran: [],
      failed: [],
      skipped: [],
      namespaced: [],
      storagePatchFailed: [],
    });
  });
});

describe('[P0] 存储命名空间改写在注入链上的真实落点', () => {
  const CARD_ID = 'b09ed5df-c5db-4870-8b7a-ff6ef5275312';

  /**
   * 用**未挂载**的容器注入：jsdom 只对已进入文档的 `<script>` 求值，未挂载则不执行。
   *
   * 必须这么做的原因（2026-10-02 实测）：jsdom 的脚本求值 realm 与测试 realm 不共享
   * 后加的全局属性 —— 生产端 `window.__palinkCardStorage = …` 在测试脚本里查不到，
   * 注入即抛 `ReferenceError`（真实浏览器同 realm，不存在这个问题）。
   * 本组只断言「正文被改写成视图调用」，执行面由既有用例
   * 「改写真的让卡脚本初始化跑起来」覆盖。
   */
  function detachedHost(): HTMLElement {
    return document.createElement('div');
  }

  it('传了 characterId：经典脚本正文里的 localStorage 被改写成 __palinkCardStorage', () => {
    const box = detachedHost();
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('album', "var v = localStorage.getItem('tavern_cg_album_unlocked');")]),
      box,
      { characterId: CARD_ID },
    );
    const el = box.querySelector('script[data-palink-card-script-id="album"]') as HTMLScriptElement;
    expect(el.textContent).toContain("__palinkCardStorage('local').getItem");
    expect(el.textContent).not.toContain('localStorage.getItem');
    expect(res.namespaced).toEqual(['album']);
    expect(res.storagePatchFailed).toEqual([]);
  });

  it('链式宿主取法也必须改写（旧实现对 window.top.localStorage 一处都不匹配）', () => {
    const box = detachedHost();
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('album', "window.top.localStorage.setItem('k','1');")]),
      box,
      { characterId: CARD_ID },
    );
    const el = box.querySelector('script[data-palink-card-script-id="album"]') as HTMLScriptElement;
    expect(el.textContent).toContain("__palinkCardStorage('local').setItem");
    expect(res.namespaced).toEqual(['album']);
  });

  it('一处坏位置不再废掉整条：文案里的关键词原样，真访问照样改写', () => {
    const box = detachedHost();
    const res = runCardTavernHelperScripts(
      makeExtensions([
        entry(
          'album',
          ["var v = localStorage.getItem('k');", "console.warn('localStorage 不可用');"].join('\n'),
        ),
      ]),
      box,
      { characterId: CARD_ID },
    );
    const el = box.querySelector('script[data-palink-card-script-id="album"]') as HTMLScriptElement;
    expect(el.textContent).toContain("__palinkCardStorage('local').getItem('k')");
    expect(el.textContent).toContain("'localStorage 不可用'");
    expect(res.namespaced).toEqual(['album']);
    expect(res.storagePatchFailed).toEqual([]);
  });

  it('提到关键词却一处都改不了：进 storagePatchFailed + 降级登记（旧的静默面）', () => {
    const box = detachedHost();
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('weird', 'var o = { localStorage: 1 };')]),
      box,
      { characterId: CARD_ID },
    );
    expect(res.namespaced).toEqual([]);
    expect(res.storagePatchFailed).toEqual([
      { id: 'weird', name: 'weird', keywordHits: 1, applied: 0, rolledBack: 1 },
    ]);
    // 生产构建 drop_console:true 会剥掉 console.warn —— 线上唯一能看见的留痕就是这个统计
    const stat = getCompatStubStats().get(CARD_SCRIPT_STORAGE_STUB);
    expect(stat?.count).toBe(1);
    expect(stat?.lastDetail).toContain('关键词 1 处');
  });

  it('拿不到 characterId：不改写、但进 storagePatchFailed（不再静默）', () => {
    const box = detachedHost();
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('album', "localStorage.setItem('k','1');")]),
      box,
    );
    const el = box.querySelector('script[data-palink-card-script-id="album"]') as HTMLScriptElement;
    expect(el.textContent).toContain('localStorage.setItem');
    expect(el.textContent).not.toContain('__palinkCardStorage');
    expect(res.namespaced).toEqual([]);
    expect(res.storagePatchFailed).toEqual([
      { id: 'album', name: 'album', keywordHits: 1, applied: 0, rolledBack: 0 },
    ]);
    // 「没拿到 id」也要留痕：这条路径过去是完全静默的
    expect(getCompatStubStats().get(CARD_SCRIPT_STORAGE_STUB)?.lastDetail).toContain('未拿到角色 id');
  });

  it('切卡防串：上一张卡的 id 不得被「这次没拿到 id」的批次继续使用', () => {
    const box = detachedHost();
    runCardTavernHelperScripts(
      makeExtensions([entry('s1', "localStorage.setItem('k','1');")]),
      box,
      { characterId: 'card-A' },
    );
    // 第二张卡的脚本，这一次调用方没传 id —— 必须按「无隔离」处理，
    // 而不是沿用 card-A（沿用会把 B 的解锁写进 A 的命名空间 = 反向串卡）
    const res = runCardTavernHelperScripts(
      makeExtensions([entry('s2', "localStorage.setItem('k','2');")]),
      box,
    );
    const el = box.querySelector('script[data-palink-card-script-id="s2"]') as HTMLScriptElement;
    expect(el.textContent).toBe("localStorage.setItem('k','2');");
    expect(res.namespaced).toEqual([]);
    expect(res.storagePatchFailed).toMatchObject([{ id: 's2', applied: 0 }]);
  });
});

describe('DOMContentLoaded 改写（卡脚本初始化能不能跑起来的关键）', () => {
  it('patchCardContentLoaded 把 DOMContentLoaded 换成 palink-card-init', () => {
    const out = patchCardContentLoaded("document.addEventListener('DOMContentLoaded', function(){});");
    expect(out).toContain('palink-card-init');
    expect(out).not.toContain('DOMContentLoaded');
  });

  it('经典脚本注入时正文被改写，模块脚本正文保持原样', () => {
    runCardTavernHelperScripts(
      makeExtensions([
        entry('cg', "document.addEventListener('DOMContentLoaded', function(){});"),
        entry('mvu', "import 'https://cdn/x.js';"),
      ]),
      host,
    );
    const cg = host.querySelector('script[data-palink-card-script-id="cg"]') as HTMLScriptElement;
    const mvu = host.querySelector('script[data-palink-card-script-id="mvu"]') as HTMLScriptElement;
    expect(cg.textContent).toContain('palink-card-init');
    expect(mvu.textContent).toBe("import 'https://cdn/x.js';");
  });

  it('注入后至少派发一次 palink-card-init（否则卡脚本的初始化永不触发）', () => {
    let fired = 0;
    const listener = () => { fired += 1; };
    document.addEventListener('palink-card-init', listener);
    try {
      runCardTavernHelperScripts(makeExtensions([entry('cg', 'var a=1;')]), host);
      expect(fired).toBeGreaterThan(0);
    } finally {
      document.removeEventListener('palink-card-init', listener);
    }
  });

  it('改写真的让卡脚本初始化跑起来（脚本在 palink-card-init 上建 UI）', () => {
    runCardTavernHelperScripts(
      makeExtensions([
        entry(
          'album',
          "document.addEventListener('DOMContentLoaded', function(){ var d=document.createElement('div'); d.id='palink-test-float-btn'; document.body.appendChild(d); });",
        ),
      ]),
      host,
    );
    expect(document.getElementById('palink-test-float-btn')).toBeTruthy();
  });
});

describe('removeCardTavernHelperScripts', () => {
  it('脚本在 body 上直接创建的 UI 也会被摘掉（离开聊天页不飘按钮）', () => {
    runCardTavernHelperScripts(
      makeExtensions([
        entry(
          'album',
          "var d=document.createElement('div'); d.id='palink-test-body-node'; document.body.appendChild(d);",
        ),
      ]),
      host,
    );
    expect(document.getElementById('palink-test-body-node')).toBeTruthy();
    removeCardTavernHelperScripts(host);
    expect(document.getElementById('palink-test-body-node')).toBeNull();
  });

  it('卸载只摘脚本节点', () => {
    runCardTavernHelperScripts(makeExtensions([entry('a', 'var x=1;'), entry('b', 'var y=2;')]), host);
    expect(removeCardTavernHelperScripts(host)).toBe(2);
    expect(host.children.length).toBe(0);
  });
});

/** 让第一次 appendChild 抛错，模拟「脚本内容非法 → 浏览器同步抛 SyntaxError」 */
function vi_spy_attach_once(el: HTMLElement, message: string) {
  const original = el.appendChild.bind(el);
  let hit = 0;
  (el as any).appendChild = function (node: Node) {
    hit += 1;
    if (hit === 1) throw new Error(message);
    return original(node as any);
  };
  return { restore() { (el as any).appendChild = original; } };
}
