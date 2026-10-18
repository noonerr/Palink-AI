/**
 * [包N ② 2026-10-19] 卡样式「被移除/被替换」取证观察器契约测试。
 *
 * 病灶（REPORT_包K §5.1 K-1）：卡自己的 <style> 被抹掉时 __palinkFrameErrors 只有
 * unknown error，答不出"是谁、用什么方式删的"。本观察器给移除/替换事件补**节点身份取证**：
 *   - 被移除节点：tagName、id、data-* / href 关键属性、文本长度；
 *   - 触发线索：record.target 身份、同批 addedNodes（有 = 替换，无 = 纯删除）。
 * ⛔ 红线：纯观测面，不改 STYLE-GUARD 恢复范围、不弹 toast、不改 guardSnapshot。
 *
 * 求值方式：与 style-guard-inframe-contract.test.ts 同法 —— 从**求值后产物**
 * （模板求值后的 COMPAT_V2_RUNTIME_ARTIFACT）按 marker 切出真实 IIFE，new Function 注入
 * window.parent.postMessage 夹具后**真的装观察器、真的删/换节点**，断言上报载荷而非文本。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/style-removal-forensics-contract.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';

/** 从 `(function xxx()` 起按花括号配平切出完整 IIFE（含尾部 )();）。 */
function sliceIife(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const tail = src.indexOf(')();', i);
  expect(tail, 'IIFE tail not found').toBeGreaterThan(-1);
  return src.slice(start, tail + 4);
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Posted { source: string; type: string; kind: string; message: string; filename: string; node: any }

// MutationObserver 回调是异步微任务，安装函数返回后才跑 —— window.parent 必须在 flush 期间
// 一直是夹具。故覆盖一次、测后 afterEach 还原，而不是 install 函数内 finally 还原。
let origParentDesc: PropertyDescriptor | undefined;
let parentOverridden = false;
const createdObservers: Array<{ disconnect: () => void }> = [];

function ensureParentOverride(fakeParent: { postMessage: (p: any) => void }): void {
  if (!parentOverridden) {
    origParentDesc = Object.getOwnPropertyDescriptor(window, 'parent');
    parentOverridden = true;
  }
  // 每个用例都指向本轮的 posted 数组（观察器跨用例存活，须重绑目标）。
  Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true, writable: true });
}

function restoreParentOverride(): void {
  if (parentOverridden) {
    if (origParentDesc) Object.defineProperty(window, 'parent', origParentDesc);
    parentOverridden = false;
  }
}

function installForensicsFromSource(posted: Posted[]): void {
  const region = sliceIife(SRC, '(function installStyleRemovalForensicsInFrame()');
  const fakeParent = { postMessage: (payload: any) => { posted.push(payload); } };
  ensureParentOverride(fakeParent);
  // 观察器体引用 frameId / window.parent；frameId 在产物里是外层 const，切片后是自由变量
  // ⇒ 必须以形参注入，否则 postMessage 抛错。
  // 每个用例新建的观察器跨用例存活 ⇒ 用一个代理 MutationObserver 记下实例，afterEach 统一断开。
  const RealMO = (globalThis as any).MutationObserver;
  class TrackedMO {
    private _real: MutationObserver;
    constructor(cb: MutationCallback) {
      this._real = new RealMO(cb);
      createdObservers.push(this);
    }
    observe(...args: Parameters<MutationObserver['observe']>) { return this._real.observe(...args); }
    disconnect() { this._real.disconnect(); }
    takeRecords() { return this._real.takeRecords(); }
  }
  // eslint-disable-next-line no-new-func
  const factory = new Function('frameId', 'MutationObserver', region + '\nvoid 0;');
  factory('frame-forensic-0001', TrackedMO);
}

describe('卡样式移除/替换取证观察器（包N ②）', () => {
  let posted: Posted[];

  beforeEach(() => {
    posted = [];
    createdObservers.length = 0;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // 断开本轮所有观察器并还原 window.parent，避免跨用例串扰。
    createdObservers.forEach((o) => { try { o.disconnect(); } catch { /* ignore */ } });
    createdObservers.length = 0;
    restoreParentOverride();
    delete (window as any).__palinkStyleGuardRestored;
    delete (window as any).__palinkStyleGuardSnapshot;
  });

  it('纯删除一个带 id 与 data-* 的 <style> ⇒ 上报 node_removed + 节点身份', async () => {
    const styleEl = document.createElement('style');
    styleEl.id = 'tavern-cg-album-style';
    styleEl.setAttribute('data-palink-forensic', 'card-side');
    styleEl.textContent = '.tcg { color: red; }';
    document.head.appendChild(styleEl);

    installForensicsFromSource(posted);
    styleEl.remove();
    await flushMicrotasks();

    const hit = posted.find((p) => p.kind === 'node_removed');
    expect(hit, '删除事件必须有取证上报').toBeTruthy();
    expect(hit!.source).toBe('palink-smart-card-frame');
    expect(hit!.type).toBe('frame-error');
    expect(hit!.message).toContain('tavern-cg-album-style');
    expect(hit!.message).toContain('removedStyledCount=1');
    // 节点身份取证：tagName / id / data-* / textLen 都得在
    const first = hit!.node.removedStyled[0];
    expect(first.tagName).toBe('STYLE');
    expect(first.id).toBe('tavern-cg-album-style');
    expect(first.attrs['data-palink-forensic']).toBe('card-side');
    expect(first.textLen).toBe('.tcg { color: red; }'.length);
    expect(hit!.filename).toBe('tavern-cg-album-style');
  });

  it('head.innerHTML 重写（删旧加新）⇒ 判为 node_replaced，并带 addedStyled 身份', async () => {
    const oldStyle = document.createElement('style');
    oldStyle.id = 'galgame-ui-plugin-styles';
    oldStyle.textContent = '.gp { color: blue; }';
    document.head.appendChild(oldStyle);

    installForensicsFromSource(posted);
    // 模拟卡侧 bundle 整体重写 head（包E/包K 实测路径）
    document.head.innerHTML = '<style id="new-only">.n{}</style>';
    await flushMicrotasks();

    const replaced = posted.find((p) => p.kind === 'node_replaced');
    expect(replaced, '替换事件应判 node_replaced').toBeTruthy();
    expect(replaced!.message).toContain('node_replaced');
    const removedIds = replaced!.node.removedStyled.map((x: any) => x.id);
    expect(removedIds).toContain('galgame-ui-plugin-styles');
    expect(replaced!.node.addedTotal).toBeGreaterThanOrEqual(1);
    const addedIds = replaced!.node.addedStyled.map((x: any) => x.id);
    expect(addedIds).toContain('new-only');
  });

  it('非样式节点（DIV）移除 ⇒ 不取证上报；取证不改变任何 DOM', async () => {
    const div = document.createElement('div');
    div.id = 'plain-div';
    document.body.appendChild(div);
    const styleBefore = document.head.querySelectorAll('style').length;

    installForensicsFromSource(posted);
    div.remove();
    await flushMicrotasks();

    expect(posted.filter((p) => p.kind === 'node_removed' || p.kind === 'node_replaced')).toHaveLength(0);
    expect(document.head.querySelectorAll('style').length).toBe(styleBefore);
  });

  it('取证上报上限封顶，不刷屏；且观察器不写任何恢复相关全局', async () => {
    installForensicsFromSource(posted);
    for (let i = 0; i < 40; i += 1) {
      const s = document.createElement('style');
      s.id = 'bulk-' + i;
      s.textContent = 'x';
      document.head.appendChild(s);
      s.remove();
    }
    await flushMicrotasks();
    const removals = posted.filter((p) => p.kind === 'node_removed' || p.kind === 'node_replaced');
    expect(removals.length).toBeLessThanOrEqual(24);
    expect((window as any).__palinkStyleGuardRestored).toBeUndefined();
    expect((window as any).__palinkStyleGuardSnapshot).toBeUndefined();
  });

  it('反证锚点：若上报被改成空串/无 node，取证断言必红（这里直接验证切出的区确有 node 载荷）', () => {
    const region = sliceIife(SRC, '(function installStyleRemovalForensicsInFrame()');
    expect(region).toContain('removedStyled: removedStyled');
    expect(region).toContain('node_replaced');
    expect(region).toContain('node_removed');
    // 红线：区里不得出现恢复/诊断调用（不改恢复范围、不弹 toast）
    expect(region).not.toContain('restoreCardStyles');
    expect(region).not.toContain('reportDiagnostic');
    expect(region).not.toContain('takeStyleSnapshot');
  });
});
