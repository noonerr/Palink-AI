/*
 * 批次Q1 · `retrieveDisplayedMessage` 桥接契约（2026-10-21）
 *
 * 用户裁定的正题：卡片要能读**主页面**那条消息的真实 DOM（SPEC §2.4 最后一行）。
 * 一手契约：st-plugins/third-party/JS-Slash-Runner-main/@types/function/displayed_message.d.ts:21
 *   declare function retrieveDisplayedMessage(message_id: number): JQuery<HTMLDivElement>;
 * 一手实现：.../src/function/displayed_message.ts:87-89
 *   return $( '#chat > .mes[mesid = "<id>"]', window.parent.document ).find( 'div.mes_text' );
 *
 * 本文件钉四件事：
 *   A. 放开态（能拿到父文档）⇒ 返回**包住真实节点**的 JQuery 形状，`.text()` 读到真正文；
 *   B. 未放开态（opaque origin ⇒ frameElement 为 null）⇒ **诚实返回 null** + palinkDiag 留痕，
 *      ⛔ 不许返回假字符串/假对象凑数；
 *   C. 楼层没渲染 / 没有 .mes_text / 帧内没有 $ ⇒ 同样 null + 留痕（每种原因各有 detail）；
 *   D. 留痕归属是 frame_compat（**不是** host_capability）：这个键已实现，不该再被
 *      缺口排行算成"哪口井被踩到"。
 *
 * ⚠️ 执行的是求值后载体 COMPAT_V2_RUNTIME_ARTIFACT（生产 iframe 逐字节同源），
 *    不是未求值源码 —— 见 compat-v2-runtime-source.ts 的载体说明。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/q1-retrieve-displayed-message.test.ts
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

/**
 * 帧内 $ 的最小等价物：**故意不带** .text/.html/.append。
 * 这是 v2 轨（part-05 的 createParentDollarCollectionCompat）的真实形状 ——
 * 它的 nativeFallback 会把 .text() 委托给"DOM 元素上并不存在的 text 方法"，
 * 于是静默返回集合本身（形状对语义错）。生产实现必须自己补齐这三个方法。
 */
function makeDollarLike(nodes: unknown[]) {
  // 用 Record<string, any> 而不是 `unknown[] & {...}`：后者会让 find 的赋值撞上
  // Array.prototype.find 的签名（TS2322）。这里的形状本来就是"带额外方法的数组"。
  const collection = Array.from(nodes) as Record<string, any>;
  collection.find = function (this: unknown[], selector: string) {
    const found = (this as unknown as Array<{ querySelectorAll?: (s: string) => ArrayLike<unknown> }>)
      .flatMap((node) => Array.from(node.querySelectorAll?.(selector) || []));
    return makeDollarLike(found);
  };
  return collection;
}

function makeDollar(queryRoot: Document) {
  return (arg: unknown) => {
    if (arg && typeof arg === 'object' && (arg as { nodeType?: number }).nodeType === 1) {
      return makeDollarLike([arg]);
    }
    if (typeof arg === 'string') {
      return makeDollarLike(Array.from(queryRoot.querySelectorAll(arg)));
    }
    return makeDollarLike(Array.isArray(arg) ? arg : []);
  };
}

/** 造一个"父页面"文档：`#chat > .mes[mesid] > .mes_block > .mes_text`（与 Palink 主页面同形）。 */
function makeParentDocument(html: string): Document {
  const doc = document.implementation.createHTMLDocument('parent-page');
  doc.body.innerHTML = html;
  return doc;
}

interface BuildOptions {
  /** 父文档；null ⇒ 模拟 opaque origin（frameElement 为 null）。 */
  parentDoc?: Document | null;
  /** 帧内 $；undefined ⇒ 模拟 jQuery 与 shim 都缺席。 */
  dollar?: ((arg: unknown) => unknown) | undefined;
  lastMessageId?: number;
}

function buildFrame(options: BuildOptions = {}) {
  const diag = vi.fn();
  const post = vi.fn();
  const requestParent = vi.fn(async () => ({ ok: true, success: true }));
  const compatChat = [{ mesid: 0, mes: '第一条', name: '露缇雅' }];
  const ctx = { characterName: '露缇雅', characterId: 'lutiya', sessionId: '42', messageId: 0, userName: '我' };
  const win: Record<string, unknown> = {
    eventSource: { on: vi.fn(), once: vi.fn(), emit: vi.fn() },
    getContext: () => ({ characters: [] }),
    getLastMessageId: () => (options.lastMessageId === undefined ? 0 : options.lastMessageId),
    messageFormatting: (mes: string) => '<p>' + mes + '</p>',
    // opaque origin 时浏览器保证 frameElement 为 null —— 这里用同一个判据模拟"读不到"。
    frameElement: options.parentDoc ? { ownerDocument: options.parentDoc } : null,
  };
  if (options.dollar) win.$ = options.dollar;

  const factory = new Function(
    'window', 'ctx', 'post', 'requestParent', 'compatChat',
    'chatVariableStore', 'globalVariableStore', 'localVariableStore',
    'persistVariableStores', 'deleteByPath', 'emitCompatEvent', 'regexBackslashCompat',
    'palinkDiagRecord',
    sliceRegion(SRC) + '\nreturn tavernHelperTh134Compat;',
  );
  const th = factory(
    win, ctx, post, requestParent, compatChat,
    {}, {}, {},
    vi.fn(), () => false, vi.fn(), String.fromCharCode(92),
    diag,
  ) as Record<string, any>;
  return { th, win, diag, post, ctx, compatChat };
}

const CHAT_HTML = [
  '<div id="chat">',
  '  <div class="mes" mesid="0"><div class="mes_block"><div class="mes_text">第一楼正文</div></div></div>',
  '  <div class="mes" mesid="1"><div class="mes_block"><div class="mes_text">第二楼正文</div></div></div>',
  '</div>',
].join('');

describe('A 注册与契约形状', () => {
  it('H 段把 retrieveDisplayedMessage 注册进成员表（不再是"未实现"）', () => {
    expect(SRC).toContain('retrieveDisplayedMessage: th134RetrieveDisplayedMessage');
  });

  it('函数存在且是 function（typeof 检查，不是对象/字符串占位）', () => {
    const { th } = buildFrame({ parentDoc: makeParentDocument(CHAT_HTML), dollar: makeDollar(document) });
    expect(typeof th.retrieveDisplayedMessage).toBe('function');
  });
});

describe('B 放开态：读主页面真实 DOM', () => {
  it('返回包住 .mes_text 真实节点的集合，.text() 读到真正文', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    const $mes = th.retrieveDisplayedMessage(1);
    expect($mes).not.toBeNull();
    expect($mes.length).toBe(1);
    // 包的是**父文档里的那个节点**，不是帧内自造的 div
    expect($mes[0]).toBe(parentDoc.querySelector('#chat > .mes[mesid="1"] div.mes_text'));
    expect($mes.text()).toBe('第二楼正文');
  });

  it('.html() 读到正文 HTML，.append() 追加到真实节点（ST d.ts 的两个示例用法）', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    const $mes = th.retrieveDisplayedMessage(0);
    expect($mes.html()).toBe('第一楼正文');
    $mes.append('<pre>追加</pre>');
    // 只影响本次显示，节点仍是父文档那个
    expect(parentDoc.querySelector('#chat > .mes[mesid="0"] div.mes_text')!.querySelector('pre')!.textContent)
      .toBe('追加');
    expect($mes.text()).toBe('第一楼正文追加');
  });

  it('集合自带 .text/.html/.append 时不被覆盖（legacy 轨与真 jQuery 都走这条）', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const base = makeDollar(parentDoc);
    const text = vi.fn(() => '来自真 jQuery 的文本');
    const dollar = (arg: unknown) => {
      const collection = base(arg) as Record<string, unknown>;
      collection.text = text;
      collection.html = vi.fn(() => '');
      collection.append = vi.fn(() => collection);
      return collection;
    };
    const { th } = buildFrame({ parentDoc, dollar });
    const $mes = th.retrieveDisplayedMessage(0);
    expect($mes.text()).toBe('来自真 jQuery 的文本');
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('楼层号也接受数字字符串（卡里常见 getLastMessageId() 的字符串化用法）', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    expect(th.retrieveDisplayedMessage('0').text()).toBe('第一楼正文');
  });
});

describe('C 读不到：一律诚实返回 null + palinkDiag 留痕（不许造假值）', () => {
  it('未放开同源（frameElement 为 null）⇒ null，留痕说明是"未放开"', () => {
    const { th, diag } = buildFrame({ parentDoc: null, dollar: makeDollar(document) });
    const result = th.retrieveDisplayedMessage(0);
    expect(result).toBeNull();
    expect(result).not.toBe('');
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatchObject({
      owner: 'frame_compat',
      kind: 'missing_api',
      name: 'retrieveDisplayedMessage',
    });
    expect(String(diag.mock.calls[0][0].detail)).toContain('frameElement');
  });

  it('楼层没渲染（mesid 不存在）⇒ null + 留痕', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th, diag } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    expect(th.retrieveDisplayedMessage(9)).toBeNull();
    expect(String(diag.mock.calls[0][0].detail)).toContain('mesid=9');
  });

  it('楼层在但没有 div.mes_text ⇒ null + 留痕（不退回把整楼当正文）', () => {
    const parentDoc = makeParentDocument('<div id="chat"><div class="mes" mesid="0"><div class="mes_block">无正文容器</div></div></div>');
    const { th, diag } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    expect(th.retrieveDisplayedMessage(0)).toBeNull();
    expect(String(diag.mock.calls[0][0].detail)).toContain('mes_text');
  });

  it('帧内没有 $ ⇒ null + 留痕（不自己造一个 JQuery 形状的假对象）', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th, diag } = buildFrame({ parentDoc, dollar: undefined });
    expect(th.retrieveDisplayedMessage(0)).toBeNull();
    expect(String(diag.mock.calls[0][0].detail)).toContain('没有 $');
  });

  it('楼层号不是数字 ⇒ null + 留痕（不猜成 0）', () => {
    const parentDoc = makeParentDocument(CHAT_HTML);
    const { th, diag } = buildFrame({ parentDoc, dollar: makeDollar(parentDoc) });
    expect(th.retrieveDisplayedMessage('last')).toBeNull();
    expect(String(diag.mock.calls[0][0].detail)).toContain('数字楼层号');
  });

  it('留痕归属是 frame_compat（已实现的键不该再进 host_capability 缺口排行）', () => {
    const { th, diag } = buildFrame({ parentDoc: null, dollar: makeDollar(document) });
    th.retrieveDisplayedMessage(0);
    const owners = new Set(diag.mock.calls.map((call) => (call[0] as { owner: string }).owner));
    expect(Array.from(owners)).toEqual(['frame_compat']);
  });
});
