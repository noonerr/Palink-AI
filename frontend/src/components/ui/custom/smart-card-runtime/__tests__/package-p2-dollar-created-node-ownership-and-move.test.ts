/**
 * 包P2：卡帧内 `$('<html 串>')` 的**文档归属**与 `append`/`appendTo` 的**搬运落点**。
 *
 * 线上取证结论（2026-10-19，探针 `.tmp_probe/probe_pp2_created_doc_provenance.js` 与
 * `.tmp_probe/probe_pp2_append_micro.js`，:16000 产物 7/7 帧逐字一致，billedHits=0）：
 *  ① 创建路径**没有**被卡自带 jQuery 覆盖：帧内 `window.$` 的描述符是 `{get, set}`（= 兼容层
 *     installDollarBridgeCompat 装的桥），`$.fn` 为 undefined（无真 jQuery 接管）；
 *     `$('<div>')` 确实走了兼容层的 HTML 串分支——帧内 `document.createElement`('template')
 *     与该 template 的 innerHTML 赋值被 hook 当场抓到。
 *  ② 造出的节点 `ownerDocument` 是 **HTMLTemplateElement 的「模板内容文档」**
 *     （nodeType 9 / ctor HTMLDocument / location 为 null / URL about:blank /
 *     没有 documentElement / childNodes 0 / defaultView null）——浏览器规范行为；
 *     在同一帧手工 `createElement('template')` + `content.childNodes` 复现得到**同一形状**。
 *     ⇒ 包N 的「容器随后被丢弃」与包P 段①的「选择器解析到父文档快照节点」两条假设均被否证：
 *     选择器解析到的是 live 节点，外来的只是**创建路径**的归属文档。
 *  ③ 致命一击在搬运：`$(节点).appendTo(head)` 连**原生创建的 live 节点**也搬不进去
 *     （inHead=false），而原生 `head.appendChild(同一个外来 box)` 成功（connected 且被 adopt
 *     进 live 文档）。兼容层 `appendTo` 把整条集合交给 `append`，而集合是 `nativeFallback`
 *     Proxy：对它取任何未知属性都返回一个函数 ⇒ `value?.nodeType` 恒真 ⇒ 走进
 *     `appendChild(整个 Proxy)` → TypeError 被 `catch {}` 吞掉 → **静默空转**。
 *     于是「建容器 → 把 head 的 style 塞进容器 → appendTo(head)」这条卡侧常见链，
 *     样式进了容器却回不到生效文档 = 用户看到的「卡自带样式整段裸奔」。
 *
 * 判据口径：**对齐真 jQuery**（oracle = node_modules/jquery，版本由本文件实测打印），
 * 不是让某张卡好看。两侧各跑在一份**同构** jsdom 文档上（节点不可能同时属于两份文档）。
 * 载体纪律见 compat-v2-runtime-source.ts 文件头 与
 * docs/_active/report/REPORT_包L_测试载体不保真假绿清单_2026-10-18.md：
 * 执行型断言**只用求值后载体** COMPAT_V2_RUNTIME_ARTIFACT（与生产 iframe 逐字节同源），
 * ⛔ 不从 runtime-body/part-*.ts 手工切函数片段。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore 本机 node_modules/jsdom 未随包提供类型声明（无 @types/jsdom），构造签名由 newWindow 自己标注
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';
import { COMPAT_V2_RUNTIME_ARTIFACT } from './compat-v2-runtime-source';

const JQUERY_SOURCE = readFileSync(join(process.cwd(), 'node_modules/jquery/dist/jquery.js'), 'utf8');

/** 两侧共用的同构 DOM：head 里一条探针样式 + body 里两个容器。 */
const FIXTURE_HTML = [
  '<!doctype html><html><head>',
  '<style id="probe-style">.probe{color:red}</style>',
  '</head><body>',
  '<div id="wrap"></div>',
  '<div id="other"></div>',
  '</body></html>',
].join('');

type Dollar = (arg: unknown) => any;
type Win = {
  document: Document;
  eval: (code: string) => unknown;
  $?: unknown;
  jQuery?: unknown;
  PalinkSmartCard?: Record<string, unknown>;
};

/** 节点最终落在哪：只认「这份文档的 head/body」与父链，不信任何文档的 getElementById。 */
function classifyNode(node: Element | null, doc: Document): string {
  if (!node) return 'gone';
  if (node.parentNode === doc.head) return 'head';
  if (node.isConnected && doc.contains(node)) {
    const parent = node.parentElement;
    return parent ? 'in-body:' + (parent.id || parent.tagName.toLowerCase()) : 'in-body:<none>';
  }
  if (node.parentNode && !node.isConnected) {
    let holder: Element | null = node.parentElement;
    while (holder && holder.parentElement) holder = holder.parentElement;
    return 'detached:' + (holder ? holder.id || holder.tagName.toLowerCase() : '<no-ancestor>');
  }
  return 'orphan';
}

/** 节点归属：线上实测与真 jQuery 都以「ownerDocument 是否就是这份文档」判定。 */
function ownershipOf(node: Element | null, doc: Document): string {
  if (!node) return 'null';
  if (node.ownerDocument === doc) return 'live-doc';
  const od = node.ownerDocument as Document | null;
  return 'other-doc:' + [
    'nodeType=' + (od ? od.nodeType : '-'),
    'url=' + (od ? String(od.URL) : '-'),
    'hasDE=' + (od && od.documentElement ? 'yes' : 'no'),
    'childNodes=' + (od ? od.childNodes.length : '-'),
  ].join(',');
}

function newWindow(): Win {
  const dom = new JSDOM(FIXTURE_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  return dom.window as unknown as Win;
}

/** Palink 侧：整段求值后生产运行时，取它装到 window 上的桥（不切片、不重写逻辑）。 */
function bootPalink(): { win: Win; dollar: Dollar } {
  const win = newWindow();
  let bootThrow = '';
  try {
    win.eval(COMPAT_V2_RUNTIME_ARTIFACT);
  } catch (error) {
    bootThrow = (error as Error)?.message || String(error);
  }
  const candidates: unknown[] = [win.$, win.jQuery, win.PalinkSmartCard?.parent$];
  const dollar = candidates.find((c) => typeof c === 'function') as Dollar | undefined;
  if (!dollar) {
    throw new Error(
      'Palink 兼容层未发布可调用的 dollar。boot-throw=' + (bootThrow || 'none') +
      ' | typeof window.$=' + typeof win.$ +
      ' | typeof window.jQuery=' + typeof win.jQuery +
      ' | PalinkSmartCard 键=' + Object.keys(win.PalinkSmartCard || {}).join(','),
    );
  }
  if (bootThrow) throw new Error('Palink 兼容层启动抛错：' + bootThrow);
  return { win, dollar };
}

/** 真 jQuery 侧：同一份同构 DOM，jQuery 直接跑在该 window 上。 */
function bootJQuery(): { win: Win; dollar: Dollar } {
  const win = newWindow();
  win.eval(JQUERY_SOURCE);
  const dollar = (typeof win.$ === 'function' ? win.$ : win.jQuery) as Dollar;
  if (typeof dollar !== 'function') throw new Error('真 jQuery 未挂到 window.$');
  return { win, dollar };
}

function jqueryVersion(): string {
  const { dollar } = bootJQuery();
  return String((dollar as unknown as { fn: { jquery: string } }).fn?.jquery);
}

type Row = { id: string; what: string; palink: string; jquery: string; differs: boolean };
const rows: Row[] = [];

/** 同一调用形状跑两边，记录观察值；两侧观察值必须一致（= 语义对齐真 jQuery）。 */
function abCase(id: string, what: string, observe: (dollar: Dollar, win: Win) => string): Row {
  const p = bootPalink();
  const j = bootJQuery();
  const runSide = (win: Win, dollar: Dollar) => {
    try {
      return observe(dollar, win);
    } catch (error) {
      return 'throw:' + ((error as Error)?.message || String(error)).slice(0, 90);
    }
  };
  const palink = runSide(p.win, p.dollar);
  const jquery = runSide(j.win, j.dollar);
  const row = { id, what, palink, jquery, differs: palink !== jquery };
  rows.push(row);
  return row;
}

/**
 * 卡侧那条链的**线上同形**复现：建容器 → `append(样式节点)` → `appendTo(head)`。
 * 观察三个量：容器最终挂在哪、样式是否还在生效文档里、样式的归属文档。
 * （注意 append 的参数是**节点**不是集合 —— 与线上帧内实测到的形状一致。）
 */
function chainProbe(dollar: Dollar, win: Win): string {
  const doc = win.document;
  const style = doc.getElementById('probe-style');
  const box = dollar('<div id="pp2-box"></div>');
  box.append(style);
  box.appendTo(doc.head);
  const b = box[0] as Element | undefined;
  return [
    'wrapper=' + (!b ? 'none' : b.parentNode === doc.head ? 'liveHead' : b.parentNode ? 'in:' + b.parentNode.nodeName : 'detached'),
    'styleConnected=' + (style ? String(Boolean(style.isConnected)) : 'null'),
    'styleOwner=' + (style ? (style.ownerDocument === doc ? 'live' : 'foreign') : 'null'),
  ].join(' | ');
}

describe('包P2：兼容层创建节点文档归属 与 append/appendTo 搬运落点（对齐真 jQuery）', () => {
  it('P0 oracle 侧事实：真 jQuery 造的节点归本帧文档，卡侧那条链跑完容器进 live head 且样式仍生效', () => {
    const { win, dollar } = bootJQuery();
    const doc = win.document;
    const made = dollar('<div id="jq-made"></div>')[0] as Element;
    expect(ownershipOf(made, doc), '真 jQuery 的创建归属应是本帧文档').toBe('live-doc');
    expect(chainProbe(dollar, win), '真 jQuery：容器进 live head、样式仍连着且归 live 文档').toBe(
      'wrapper=liveHead | styleConnected=true | styleOwner=live',
    );
  });

  it('P1 创建路径归属：dollar 造 div，节点 ownerDocument 必须是本帧文档', () => {
    const row = abCase('P1', 'dollar(div 串)[0].ownerDocument 归属', (dollar, win) => {
      return ownershipOf(dollar('<div id="pp2-made"></div>')[0] as Element, win.document);
    });
    expect(row.palink, row.what).toBe(row.jquery);
  });

  it('P2 卡侧整链：建容器 → append(样式节点) → appendTo(head)，容器进 live head 且样式仍生效', () => {
    const row = abCase('P2', 'chainProbe：容器落点/样式连通性/样式归属', chainProbe);
    expect(row.palink, row.what).toBe(row.jquery);
    expect(row.palink, '线上红基线形状：wrapper=detached | styleConnected=false').toBe(
      'wrapper=liveHead | styleConnected=true | styleOwner=live',
    );
  });

  it('P3 appendTo 字符串目标（卡侧另一写法）', () => {
    const row = abCase('P3', 'dollar(div).appendTo(head 串) 后容器落点', (dollar, win) => {
      const box = dollar('<div id="pp2-str"></div>');
      box.appendTo('head');
      return classifyNode(box[0] as Element, win.document);
    });
    expect(row.palink, row.what).toBe(row.jquery);
  });

  it('P4 append 收到「集合」当参数时也要搬运（nativeFallback Proxy 使 nodeType 判定恒真 ⇒ 静默空转）', () => {
    const row = abCase('P4', 'dollar(#wrap).append(dollar(#probe-style)) 集合参数搬运', (dollar, win) => {
      dollar('#wrap').append(dollar('#probe-style'));
      return classifyNode(win.document.getElementById('probe-style'), win.document);
    });
    expect(row.palink, row.what).toBe(row.jquery);
  });

  it('P5 原生创建的 live 节点也必须搬得动（排除「只有外来文档节点搬不动」这一误判）', () => {
    const row = abCase('P5', 'dollar(createElement(div)).appendTo(head)', (dollar, win) => {
      const node = win.document.createElement('div');
      node.id = 'pp2-live';
      dollar(node).appendTo(win.document.head);
      return classifyNode(node, win.document);
    });
    expect(row.palink, row.what).toBe(row.jquery);
  });

  it('P6 prepend 与 prependTo 同源缺陷', () => {
    const row = abCase('P6', 'dollar(#wrap).prepend(dollar(#probe-style)) 后样式落点', (dollar, win) => {
      dollar('#wrap').prepend(dollar('#probe-style'));
      return classifyNode(win.document.getElementById('probe-style'), win.document);
    });
    expect(row.palink, row.what).toBe(row.jquery);

    const row2 = abCase('P6b', 'dollar(#probe-style).prependTo(#wrap) 后样式落点', (dollar, win) => {
      dollar('#probe-style').prependTo('#wrap');
      return classifyNode(win.document.getElementById('probe-style'), win.document);
    });
    expect(row2.palink, row2.what).toBe(row2.jquery);
  });

  it('差异表汇总：全部用例 Palink 与真 jQuery 观察值一致（红 = 存在实测语义差）', () => {
    // eslint-disable-next-line no-console
    console.info(
      '[包P2 A/B 差异表] jQuery=' + jqueryVersion() +
      ' | 载体=COMPAT_V2_RUNTIME_ARTIFACT(' + COMPAT_V2_RUNTIME_ARTIFACT.length + ' 字节)\n' +
      rows.map((r) => `${r.id} | ${r.what} | Palink=${r.palink} | jQuery=${r.jquery} | 差异=${r.differs}`).join('\n'),
    );
    const diffs = rows.filter((r) => r.differs);
    expect(diffs.map((r) => `${r.id}: Palink=${r.palink} vs jQuery=${r.jquery}`), '实测语义差异清单').toEqual([]);
  });
});
