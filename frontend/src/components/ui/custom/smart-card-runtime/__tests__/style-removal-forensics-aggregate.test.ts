/**
 * [UI-2 2026-10-24] style_removal 取证 · 会话级聚合器测试。
 * [UI-2b 2026-10-26 用户裁定] 在聚合之上再加「平时静默、真出问题才报」的分流断言：
 *   原本钉住「首次必须全量上报 console」的用例（本文件第 ⑥ 组绑定锚点）已改为钉住
 *   **新的分流语义**（shouldLog / shouldRecord + 探针升级），正向锚点保留、不删。
 *
 * 验收口径（SPEC_ST三面一致对齐施工计划_2026-10-24.md §2 UI-2 / 差距 D-4 +
 * SPEC_下一程计划_用户裁定与排期_2026-10-26.md §1 第 7 条「降噪但保留取证」）：
 *   ① 同一节点（同 nodeId/selector）+ 同一原因重复移除 N 次 ⇒ 诊断记录条数 = 1、
 *      计数字段 = N（可从 diag 导出 JSON 的 records[].count 读到）；
 *   ② 不同节点各记各的、不同原因（node_removed / node_replaced）不合并；
 *   ③ 首次记录信息量不降级（message/textLength/身份全保留）；
 *   ④ 无身份载荷不进聚合账（恒 first、不进诊断计数）；UI-2b 起它代表"取证面结构异常"，
 *      整会话只报一次，之后只累 unkeyed 总数；
 *   ⑤ diag 关闭时计数面仍在 window.__palinkStyleRemovalAgg（零打扰，不弹任何 UI）；
 *   ⑥ 绑定锚点：CharacterCardRenderer 的 frame-error 分支必须真的接上聚合器（源码锚，
 *      风格同 frame-error-reporting-contract.test.ts），且分流后取证路径未被降级；
 *   ⑦ UI-2b 分流：默认（非开发者模式）一条都不 log/record，只累计数；开发者模式逐条 log、
 *      仅首次 record；真出问题（HEAD 被摘 / settle 后样式真丢失 / 守护真回灌 / 帧高度塌陷）
 *      各升级恰好一条（守护与高度是宿主全局量 ⇒ 整会话各只一条；升级总量有会话封顶）；
 *      读不到帧文档或文档已重建时只记 probesSkipped，绝不假报；取证载荷缺身份 ⇒ 整会话只报一次。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/style-removal-forensics-aggregate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absorbStyleRemovalFrameError,
  getPendingStyleRemovalProbes,
  getStyleRemovalAggSnapshot,
  getStyleRemovalForensicsSummary,
  isStyleRemovalForensicPayload,
  registerStyleRemovalProbeContext,
  resetStyleRemovalAggForTest,
  removedIncludesHeadNode,
  runDueStyleRemovalProbes,
  STYLE_REMOVAL_AGG_WINDOW_KEY,
  STYLE_REMOVAL_ESCALATION_REASON,
  STYLE_REMOVAL_PROBE_SETTLE_MS,
  STYLE_REMOVAL_SUMMARY_WINDOW_KEY,
  styleRemovalAggKeyOf,
  styleRemovalIdentityMissingFromDoc,
  styleRemovalVerboseEnabled,
  type AbsorbStyleRemovalResult,
  type StyleRemovalEscalation,
} from '../style-removal-forensics-aggregate';
import {
  PALINK_DIAG_STORAGE_KEY,
  palinkDiagDump,
  palinkDiagEnabled,
  palinkDiagExplicitlyEnabled,
  palinkDiagRecords,
  resetPalinkDiagForTest,
  setPalinkDiagEnabled,
} from '../palink-diag';

/** 仿真帧内取证观察器（part-08.ts handleStyleRemovalRecords）发出的 postMessage 载荷。 */
function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'palink-smart-card-frame',
    frameId: 'frame-agg-0001',
    type: 'frame-error',
    kind: 'node_removed',
    message: 'style_removal[node_removed] removedStyledCount=1 addedCount=0 target=HEAD#- first=STYLE#tavern-cg-album-style textLen=12320',
    filename: 'tavern-cg-album-style',
    lineno: -1,
    colno: -1,
    errorReason: 'style_removal_forensics',
    node: {
      removedStyled: [{ tagName: 'STYLE', id: 'tavern-cg-album-style', attrs: { 'data-palink-forensic': 'card-side' }, textLen: 12320 }],
      addedStyled: [],
      target: 'HEAD#-',
      removedTotal: 1,
      addedTotal: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetPalinkDiagForTest();
  resetStyleRemovalAggForTest();
  setPalinkDiagEnabled(true, false);
});

afterEach(() => {
  resetPalinkDiagForTest();
  resetStyleRemovalAggForTest();
});

describe('style_removal 取证 · 会话级聚合（UI-2 / D-4）', () => {
  it('同一节点同一原因重复 N 次：first 标记恰 1 次、诊断记录 1 条、count=N', () => {
    const N = 6;
    const firsts: boolean[] = [];
    for (let i = 0; i < N; i += 1) {
      const r = absorbStyleRemovalFrameError(makePayload(), { frameId: 'f1', cardId: 'c1' });
      firsts.push(r.first);
    }
    expect(firsts.filter(Boolean)).toHaveLength(1);

    const records = palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'));
    expect(records).toHaveLength(1);
    expect(records[0].count).toBe(N);
    expect(records[0].owner).toBe('frame_compat');
    expect(records[0].origin).toBe('frame');
    expect(records[0].frameId).toBe('f1');

    // 会话账：count=N、suppressed=N-1
    const snap = getStyleRemovalAggSnapshot();
    expect(snap.size).toBe(1);
    const entry = snap.get('node_removed|STYLE#tavern-cg-album-style');
    expect(entry?.count).toBe(N);
    expect(entry?.suppressed).toBe(N - 1);
  });

  it('计数字段可从 diag 导出 JSON 读到（palinkDiagDump records[].count = N）', () => {
    const N = 4;
    for (let i = 0; i < N; i += 1) absorbStyleRemovalFrameError(makePayload(), { frameId: 'f1' });
    const dump = JSON.parse(palinkDiagDump()) as { records: Array<{ name: string; count: number }> };
    const hit = dump.records.filter((r) => r.name.startsWith('style_removal:'));
    expect(hit).toHaveLength(1);
    expect(hit[0].count).toBe(N);
    // window 观测面同值
    const w = window as unknown as Record<string, Map<string, { count: number }>>;
    const agg = w[STYLE_REMOVAL_AGG_WINDOW_KEY];
    expect(agg).toBeTruthy();
    expect(agg!.get('node_removed|STYLE#tavern-cg-album-style')?.count).toBe(N);
  });

  it('首次记录信息量不降级：message 全文与 textLength 均保留', () => {
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'f1' });
    const rec = palinkDiagRecords().find((r) => r.name.startsWith('style_removal:'));
    expect(rec).toBeTruthy();
    expect(rec!.detail).toContain('style_removal[node_removed]');
    expect(rec!.detail).toContain('tavern-cg-album-style');
    expect(rec!.detail).toContain('textLen=12320');
    expect(rec!.filename).toBe('tavern-cg-album-style');
    expect(rec!.textLength).toBe(12320);
  });

  it('不同节点各记各的；不同原因（node_removed / node_replaced）不合并', () => {
    const styleA = makePayload();
    const styleB = makePayload({
      message: 'style_removal[node_removed] removedStyledCount=1 addedCount=0 target=HEAD#- first=STYLE#galgame-ui-plugin-styles textLen=440000',
      filename: 'galgame-ui-plugin-styles',
      node: { removedStyled: [{ tagName: 'STYLE', id: 'galgame-ui-plugin-styles', attrs: {}, textLen: 440000 }], addedStyled: [], target: 'HEAD#-', removedTotal: 1, addedTotal: 0 },
    });
    const replacedA = makePayload({
      kind: 'node_replaced',
      node: {
        removedStyled: [{ tagName: 'STYLE', id: 'tavern-cg-album-style', attrs: {}, textLen: 12320 }],
        addedStyled: [{ tagName: 'STYLE', id: 'new-only', attrs: {}, textLen: 10 }],
        target: 'HEAD#-',
        removedTotal: 1,
        addedTotal: 1,
      },
    });
    absorbStyleRemovalFrameError(styleA, { frameId: 'f1' });
    absorbStyleRemovalFrameError(styleA, { frameId: 'f2' }); // 另一帧的同节点 → 仍合并（会话级）
    absorbStyleRemovalFrameError(styleB, { frameId: 'f1' });
    absorbStyleRemovalFrameError(replacedA, { frameId: 'f1' });

    const snap = getStyleRemovalAggSnapshot();
    expect(snap.size).toBe(3);
    expect(snap.get('node_removed|STYLE#tavern-cg-album-style')?.count).toBe(2);
    expect(snap.get('node_removed|STYLE#galgame-ui-plugin-styles')?.count).toBe(1);
    expect(snap.get('node_replaced|STYLE#tavern-cg-album-style')?.count).toBe(1);
    expect(palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'))).toHaveLength(3);
  });

  it('LINK 无 id 时按 href 取身份；不同 href 不合并', () => {
    expect(styleRemovalAggKeyOf(makePayload({
      node: { removedStyled: [{ tagName: 'LINK', id: '', attrs: { href: 'https://x/foo.css', rel: 'stylesheet' }, textLen: 0 }] },
    }))).toBe('node_removed|LINK@https://x/foo.css');
    const other = styleRemovalAggKeyOf(makePayload({
      node: { removedStyled: [{ tagName: 'LINK', id: '', attrs: { href: 'https://x/bar.css' }, textLen: 0 }] },
    }));
    expect(other).toBe('node_removed|LINK@https://x/bar.css');
    expect(other).not.toBe('node_removed|LINK@https://x/foo.css');
  });

  it('无节点身份的载荷不聚合：恒 first、不进诊断计数（UI-2b 起：默认整会话只报一次结构异常，之后只累 unkeyed 总数）', () => {
    const bare = makePayload({ node: undefined });
    expect(styleRemovalAggKeyOf(bare)).toBeNull();
    for (let i = 0; i < 3; i += 1) {
      const r = absorbStyleRemovalFrameError(bare, { frameId: 'f1' });
      expect(r.first).toBe(true);
      expect(r.key).toBeNull();
    }
    expect(palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'))).toHaveLength(0);
    expect(getStyleRemovalAggSnapshot().size).toBe(0);
  });

  it('diag 关闭时：去重判定与 window 计数面照常（diag 面按既有开关口径静默）', () => {
    setPalinkDiagEnabled(false, false);
    const firsts: boolean[] = [];
    for (let i = 0; i < 3; i += 1) firsts.push(absorbStyleRemovalFrameError(makePayload(), { frameId: 'f1' }).first);
    expect(firsts.filter(Boolean)).toHaveLength(1);
    expect(getStyleRemovalAggSnapshot().get('node_removed|STYLE#tavern-cg-album-style')?.count).toBe(3);
    expect(palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'))).toHaveLength(0);
  });

  it('isStyleRemovalForensicPayload 只认 style_removal_forensics，其它 frame-error 不进聚合', () => {
    expect(isStyleRemovalForensicPayload(makePayload())).toBe(true);
    expect(isStyleRemovalForensicPayload(makePayload({ errorReason: 'plain_script_error' }))).toBe(false);
    expect(isStyleRemovalForensicPayload({ type: 'frame-csp' })).toBe(false);
    expect(isStyleRemovalForensicPayload(null)).toBe(false);
  });
});

describe('style_removal 聚合 · 绑定锚点与红线（源码锚，防无意拆除）', () => {
  // vitest 固定以 frontend/ 为 cwd（同 frame-error-reporting-contract.test.ts 的取源方式）
  const rendererSource = readFileSync(join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'), 'utf8');
  const aggSource = readFileSync(join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/style-removal-forensics-aggregate.ts'), 'utf8');

  it('CharacterCardRenderer frame-error 分支必须接上聚合器：默认静默早退、只有该报的才继续（UI-2b 分流锚点）', () => {
    expect(rendererSource).toContain('isStyleRemovalForensicPayload(data)');
    expect(rendererSource).toContain('absorbStyleRemovalFrameError(data');
    // 分流语义的正向锚点：早退条件从「非首次」改成了「不该刷」，取证账仍在（下面两条字段锚未动）
    expect(rendererSource).toContain('if (!styleRemovalVerdict.shouldLog) return;');
    expect(rendererSource).toContain('const shouldRecordFrameError = !styleRemovalVerdict || styleRemovalVerdict.shouldRecord;');
    // 记录路径未被降级（取证字段一个不少）
    expect(rendererSource).toContain('node: data.node && typeof data.node === \'object\' ? data.node : undefined');
    expect(rendererSource).toContain('errorReason: typeof data.errorReason');
    // 真出问题的升级上报出口：探针上下文注册 + 升级条目带 escalationTrigger
    expect(rendererSource).toContain('registerStyleRemovalProbeContext(frameId');
    expect(rendererSource).toContain('escalationTrigger: escalation.trigger');
    expect(rendererSource).toContain('卡内样式异常(取证升级)');
  });

  it('红线：聚合器不碰 STYLE-GUARD 恢复/守护、不弹任何 UI（按调用形态查，注释里的红线声明不算）', () => {
    // 不 import 守护模块、不出现恢复/快照调用（带调用括号才算调用，注释声明不算）
    expect(aggSource).not.toContain("from './style-guard'");
    expect(aggSource).not.toContain('restoreCardStyles(');
    expect(aggSource).not.toContain('takeStyleSnapshot(');
    expect(aggSource).not.toContain('guardSnapshot(');
    expect(aggSource).not.toContain('toast(');
    expect(aggSource).not.toContain('postMessage(');
  });
});

describe('style_removal 降噪分流（UI-2b 2026-10-26 裁定：平时静默，真出问题才报）', () => {
  /** 造一份帧文档：ids 里的 <style> 在位，anonymous 给匿名样式长度集合。 */
  function makeFrameDoc(opts: { ids?: string[]; anonLens?: number[]; hrefs?: string[] } = {}): Document {
    const doc = document.implementation.createHTMLDocument('frame');
    (opts.ids || []).forEach((id) => {
      const el = doc.createElement('style');
      el.id = id;
      el.textContent = '.x{}';
      doc.head.appendChild(el);
    });
    (opts.anonLens || []).forEach((len) => {
      const el = doc.createElement('style');
      el.textContent = 'a'.repeat(len);
      doc.head.appendChild(el);
    });
    (opts.hrefs || []).forEach((href) => {
      const el = doc.createElement('link');
      el.setAttribute('rel', 'stylesheet');
      el.setAttribute('href', href);
      doc.head.appendChild(el);
    });
    return doc;
  }

  function harness(overrides: Partial<{
    doc: Document | null;
    guardRestored: number;
    renderedHeight: number;
  }> = {}) {
    const escalations: StyleRemovalEscalation[] = [];
    let currentDoc: Document | null = overrides.doc === undefined ? makeFrameDoc() : overrides.doc;
    let guardRestored = overrides.guardRestored === undefined ? 0 : overrides.guardRestored;
    let renderedHeight = overrides.renderedHeight === undefined ? 600 : overrides.renderedHeight;
    const unregister = registerStyleRemovalProbeContext('probe-frame', {
      resolveDocument: () => currentDoc,
      readGuardRestored: () => guardRestored,
      readRenderedHeight: () => renderedHeight,
      reportEscalation: (esc) => { escalations.push(esc); },
    });
    return {
      escalations,
      unregister,
      setDoc: (doc: Document | null) => { currentDoc = doc; },
      setGuardRestored: (n: number) => { guardRestored = n; },
      setRenderedHeight: (n: number) => { renderedHeight = n; },
      runDue: (offsetMs = STYLE_REMOVAL_PROBE_SETTLE_MS + 1) => runDueStyleRemovalProbes(Date.now() + offsetMs),
    };
  }

  /** 默认（非开发者模式）：显式诊断关；本机站点隐式默认开不算显式（否则本地开发照旧刷屏）。 */
  function asQuiet(): void {
    setPalinkDiagEnabled(null, false);
    try { localStorage.removeItem(PALINK_DIAG_STORAGE_KEY); } catch { /* 无存储环境按未显式开启处理 */ }
    delete (window as unknown as Record<string, unknown>).__palinkStyleRemovalVerbose;
  }

  it('判据基线：本机站点隐式开诊断 ≠ 显式开（默认必须静默）', () => {
    asQuiet();
    expect(palinkDiagEnabled()).toBe(true);          // 本机站点默认在记（取证面照常）
    expect(palinkDiagExplicitlyEnabled()).toBe(false); // 但没人显式开 ⇒ 不逐条
    expect(styleRemovalVerboseEnabled()).toBe(false);
  });

  it('默认静默：同一节点重复 8 次，一条都不 log / record，但会话账与 diag 计数照常累计', () => {
    asQuiet();
    const verdicts: AbsorbStyleRemovalResult[] = [];
    for (let i = 0; i < 8; i += 1) {
      verdicts.push(absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-quiet', cardId: 'c1' }));
    }
    expect(verdicts.every((v) => v.shouldLog === false)).toBe(true);
    expect(verdicts.every((v) => v.shouldRecord === false)).toBe(true);
    expect(verdicts.every((v) => v.trigger === null)).toBe(true);
    // 首次标记语义不变（取证不降级）
    expect(verdicts.filter((v) => v.first)).toHaveLength(1);
    expect(verdicts[7].count).toBe(8);
    expect(getStyleRemovalAggSnapshot().get('node_removed|STYLE#tavern-cg-album-style')?.suppressed).toBe(7);
    expect(palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'))[0].count).toBe(8);
  });

  it('开发者模式（显式开诊断）= 逐条 log，但仍只有首次 record（防 50 格缓冲被取证刷满）', () => {
    setPalinkDiagEnabled(true, true);
    expect(styleRemovalVerboseEnabled()).toBe(true);
    const first = absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-verbose' });
    const second = absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-verbose' });
    expect(first.shouldLog).toBe(true);
    expect(first.shouldRecord).toBe(true);
    expect(first.trigger).toBe('per_event_verbose');
    expect(second.shouldLog).toBe(true);
    expect(second.shouldRecord).toBe(false);
    expect(second.count).toBe(2);
    // 刷新页面后（内存覆盖归零、localStorage 仍 '1'）逐条放行依然成立 ⇒ 开发者模式是真的开关
    setPalinkDiagEnabled(null, false);
    expect(palinkDiagExplicitlyEnabled()).toBe(true);
    expect(styleRemovalVerboseEnabled()).toBe(true);
    try { localStorage.removeItem(PALINK_DIAG_STORAGE_KEY); } catch { /* 无存储环境跳过 */ }
    expect(styleRemovalVerboseEnabled()).toBe(false);
  });

  it('控制台逃生口 window.__palinkStyleRemovalVerbose = true 同样逐条放行', () => {
    asQuiet();
    (window as unknown as Record<string, unknown>).__palinkStyleRemovalVerbose = true;
    expect(styleRemovalVerboseEnabled()).toBe(true);
    expect(absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-escape' }).shouldLog).toBe(true);
    delete (window as unknown as Record<string, unknown>).__palinkStyleRemovalVerbose;
    expect(absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-escape' }).shouldLog).toBe(false);
  });

  it('T1 真出问题：被摘节点含 HEAD（文档级拆除）⇒ 立即升级一条（log + record），非取证载荷不触发', () => {
    asQuiet();
    expect(removedIncludesHeadNode(makePayload())).toBe(false);
    const headPayload = makePayload({
      message: 'style_removal[node_removed] removedStyledCount=1 target=HTML#-',
      node: { removedStyled: [{ tagName: 'HEAD', id: '', attrs: {}, textLen: 200 }], addedStyled: [], target: 'HTML#-', removedTotal: 1, addedTotal: 0 },
    });
    expect(removedIncludesHeadNode(headPayload)).toBe(true);
    const v = absorbStyleRemovalFrameError(headPayload, { frameId: 'f-head' });
    expect(v.shouldLog).toBe(true);
    expect(v.shouldRecord).toBe(true);
    expect(v.trigger).toBe('head_node_removed');
    // 已定性 ⇒ 不再挂探针，重复事件也不重复升级
    const before = getPendingStyleRemovalProbes().length;
    absorbStyleRemovalFrameError(headPayload, { frameId: 'f-head' });
    expect(getPendingStyleRemovalProbes().length).toBe(before);
  });

  it('T2 真出问题：settle 窗口后被摘节点身份仍不在帧文档 ⇒ 恰好升级一条 style_content_missing', () => {
    asQuiet();
    const h = harness({ doc: makeFrameDoc({ ids: ['other-style'] }) }); // tavern-cg-album-style 不在了
    const v = absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame', cardId: 'card-1' });
    expect(v.shouldLog).toBe(false); // 事件当下仍静默，等探针结论
    expect(h.runDue()).toBe(1);
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].trigger).toBe('style_content_missing');
    expect(h.escalations[0].errorReason).toBe(STYLE_REMOVAL_ESCALATION_REASON);
    expect(h.escalations[0].frameId).toBe('probe-frame');
    expect(h.escalations[0].cardId).toBe('card-1');
    expect(h.escalations[0].message).toContain('tavern-cg-album-style');
    // 再喂重复事件 + 再跑探针 ⇒ 不重复升级（一条封顶）
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    expect(h.runDue()).toBe(0);
    expect(h.escalations).toHaveLength(1);
    expect(getStyleRemovalAggSnapshot().get('node_removed|STYLE#tavern-cg-album-style')?.escalated).toBe(true);
    h.unregister();
  });

  it('T2 反证（正常搬家）：节点已回到帧文档 ⇒ 探针不升级，控制台保持静默', () => {
    asQuiet();
    const h = harness({ doc: makeFrameDoc({ ids: ['tavern-cg-album-style'] }) });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    expect(h.runDue()).toBe(1);
    expect(h.escalations).toHaveLength(0);
    expect(getStyleRemovalForensicsSummary().escalated).toBe(0);
    h.unregister();
  });

  it('LINK 身份按 href 判；href 还在 ⇒ 不升级，href 消失 ⇒ 升级', () => {
    const linkPayload = makePayload({
      node: { removedStyled: [{ tagName: 'LINK', id: '', attrs: { href: 'https://x/foo.css', rel: 'stylesheet' }, textLen: 0 }], addedStyled: [], target: 'HEAD#-', removedTotal: 1, addedTotal: 0 },
    });
    expect(styleRemovalIdentityMissingFromDoc(makeFrameDoc({ hrefs: ['https://x/foo.css'] }), { tag: 'LINK', id: '', href: 'https://x/foo', textLen: 0 }, 1)).toBe(false);
    expect(styleRemovalIdentityMissingFromDoc(makeFrameDoc({ hrefs: ['https://x/bar.css'] }), { tag: 'LINK', id: '', href: 'https://x/foo.css', textLen: 0 }, 1)).toBe(true);
    asQuiet();
    const h = harness({ doc: makeFrameDoc({ hrefs: ['https://x/foo.css'] }) });
    absorbStyleRemovalFrameError(linkPayload, { frameId: 'probe-frame' });
    h.runDue();
    expect(h.escalations).toHaveLength(0);
    h.unregister();
  });

  it('匿名样式（无 id/href）：长度还在且文档样式数没减 ⇒ 不升级；样式数掉了 ⇒ 升级（防 textLen 漂移假阳性）', () => {
    asQuiet();
    const anon = makePayload({
      message: 'style_removal[node_removed] first=STYLE#- textLen=64',
      filename: '',
      node: { removedStyled: [{ tagName: 'STYLE', id: '', attrs: {}, textLen: 64 }], addedStyled: [], target: 'HEAD#-', removedTotal: 1, addedTotal: 0 },
    });
    // 健在：同长度匿名样式还在，样式数也没减少 ⇒ 判成"搬回来了"，静默
    const hAlive = harness({ doc: makeFrameDoc({ anonLens: [64, 10, 10] }) });
    absorbStyleRemovalFrameError(anon, { frameId: 'probe-frame' });
    expect(hAlive.runDue()).toBe(1);
    expect(hAlive.escalations).toHaveLength(0);
    hAlive.unregister();

    // 真丢：文档里既没有该长度、样式总数也少了
    resetStyleRemovalAggForTest();
    const hLost = harness({ doc: makeFrameDoc({ anonLens: [10, 10] }) });
    absorbStyleRemovalFrameError(anon, { frameId: 'probe-frame' });
    expect(hLost.runDue()).toBe(1);
    expect(hLost.escalations).toHaveLength(1);
    expect(hLost.escalations[0].trigger).toBe('style_content_missing');
    hLost.unregister();

    // 长度命中但样式总数减少（同长度不同节点的漂移）⇒ 仍判丢失，宁缺毋滥的方向是"能查到就报"
    expect(styleRemovalIdentityMissingFromDoc(makeFrameDoc({ anonLens: [64, 10] }), { tag: 'STYLE', id: '', href: '', textLen: 64 }, 3)).toBe(true);
    expect(styleRemovalIdentityMissingFromDoc(makeFrameDoc({ anonLens: [64, 10, 10] }), { tag: 'STYLE', id: '', href: '', textLen: 64 }, 3)).toBe(false);
  });

  it('T3 真出问题：宿主样式守护在这期间真的回灌过 ⇒ 升级 style_guard_restored；宿主全局计数 ⇒ 整会话只报一条', () => {
    asQuiet();
    let guard = 0;
    const escalations: StyleRemovalEscalation[] = [];
    const doc = makeFrameDoc({ ids: ['tavern-cg-album-style', 'galgame-ui-plugin-styles'] });
    const unregister = registerStyleRemovalProbeContext('probe-frame', {
      resolveDocument: () => doc,
      readGuardRestored: () => guard,
      readRenderedHeight: () => 600,
      reportEscalation: (esc) => { escalations.push(esc); },
    });
    const payloadB = makePayload({
      message: 'style_removal[node_removed] first=STYLE#galgame-ui-plugin-styles textLen=440000',
      filename: 'galgame-ui-plugin-styles',
      node: { removedStyled: [{ tagName: 'STYLE', id: 'galgame-ui-plugin-styles', attrs: {}, textLen: 440000 }], addedStyled: [], target: 'HEAD#-', removedTotal: 1, addedTotal: 0 },
    });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    absorbStyleRemovalFrameError(payloadB, { frameId: 'probe-frame' });
    guard = 3; // 守护动手补回过 ⇒ 这批样式确实离开过生效文档
    expect(runDueStyleRemovalProbes(Date.now() + STYLE_REMOVAL_PROBE_SETTLE_MS + 1)).toBe(2);
    expect(escalations).toHaveLength(1); // 两个键各判一次，但守护计数是分不出帧的全局量 ⇒ 只报一条
    expect(escalations[0].trigger).toBe('style_guard_restored');
    unregister();
  });

  it('升级上报有会话封顶：第 13 个真丢失身份只记账，不再刷控制台（噪声有界、取证不丢）', () => {
    asQuiet();
    const h = harness({ doc: makeFrameDoc({ ids: ['anchor-style'] }) });
    for (let i = 0; i < 13; i += 1) {
      absorbStyleRemovalFrameError(makePayload({
        message: `style_removal[node_removed] first=STYLE#bulk-${i}`,
        filename: `bulk-${i}`,
        node: { removedStyled: [{ tagName: 'STYLE', id: `bulk-${i}`, attrs: {}, textLen: 100 + i }], addedStyled: [], target: 'HEAD#-', removedTotal: 1, addedTotal: 0 },
      }), { frameId: 'probe-frame' });
    }
    expect(h.runDue()).toBe(13);
    expect(h.escalations).toHaveLength(12);
    expect(h.escalations.every((e) => e.trigger === 'style_content_missing')).toBe(true);
    const summary = getStyleRemovalForensicsSummary();
    expect(summary.escalated).toBe(13);
    expect(summary.escalationReports).toBe(12);
    expect(summary.escalationReportsCapped).toBe(1);
    h.unregister();
  });

  it('T4 真出问题：帧渲染高度与文档布局高度同时为 0 ⇒ frame_height_collapsed；折叠态给 -1 不判', () => {
    asQuiet();
    const h = harness({ doc: makeFrameDoc({ ids: ['tavern-cg-album-style'] }), renderedHeight: 0 });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    h.runDue();
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].trigger).toBe('frame_height_collapsed');
    h.unregister();
    resetStyleRemovalAggForTest();
    const collapsedCard = harness({ doc: makeFrameDoc({ ids: ['tavern-cg-album-style'] }), renderedHeight: -1 });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    collapsedCard.runDue();
    expect(collapsedCard.escalations).toHaveLength(0);
    collapsedCard.unregister();
  });

  it('判不了就不报：帧文档读不到 / 文档已被重建 ⇒ 只记 probesSkipped，不产生任何升级', () => {
    asQuiet();
    const hUnreadable = harness({ doc: null });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    expect(hUnreadable.runDue()).toBe(1);
    expect(hUnreadable.escalations).toHaveLength(0);
    expect(getStyleRemovalForensicsSummary().probesSkipped).toBeGreaterThanOrEqual(1);
    hUnreadable.unregister();

    resetStyleRemovalAggForTest();
    const docA = makeFrameDoc({ ids: ['tavern-cg-album-style'] });
    const hRebuilt = harness({ doc: docA });
    absorbStyleRemovalFrameError(makePayload(), { frameId: 'probe-frame' });
    hRebuilt.setDoc(makeFrameDoc({ ids: [] })); // srcDoc 重建 ⇒ 旧身份无从比对
    hRebuilt.runDue();
    expect(hRebuilt.escalations).toHaveLength(0);
    hRebuilt.unregister();
  });

  it('取证载荷缺节点身份（取证面结构异常）：默认只报一次，之后静默且只累 unkeyed 总数', () => {
    asQuiet();
    const bare = makePayload({ node: undefined });
    const first = absorbStyleRemovalFrameError(bare, { frameId: 'f-bare' });
    expect(first.shouldLog).toBe(true);
    expect(first.trigger).toBe('forensics_payload_unkeyed');
    const later = absorbStyleRemovalFrameError(bare, { frameId: 'f-bare' });
    expect(later.shouldLog).toBe(false);
    expect(later.count).toBe(2);
    expect(getStyleRemovalForensicsSummary().unkeyed).toBe(2);
    expect(getStyleRemovalAggSnapshot().size).toBe(0);
  });

  it('静默 ≠ 无痕：默认路径下 __palinkStyleRemovalSummary() / 会话账 / diag 导出都读得到量级', () => {
    asQuiet();
    for (let i = 0; i < 5; i += 1) absorbStyleRemovalFrameError(makePayload(), { frameId: 'f-audit', cardId: 'c-audit' });
    const w = window as unknown as Record<string, unknown>;
    expect(typeof w[STYLE_REMOVAL_SUMMARY_WINDOW_KEY]).toBe('function');
    const summary = (w[STYLE_REMOVAL_SUMMARY_WINDOW_KEY] as typeof getStyleRemovalForensicsSummary)();
    expect(summary.keys).toBe(1);
    expect(summary.events).toBe(5);
    expect(summary.suppressed).toBe(4);
    expect(summary.escalated).toBe(0);
    expect(summary.entries[0].key).toBe('node_removed|STYLE#tavern-cg-album-style');
    expect(palinkDiagRecords().filter((r) => r.name.startsWith('style_removal:'))[0].count).toBe(5);
    void palinkDiagDump();
  });
});
