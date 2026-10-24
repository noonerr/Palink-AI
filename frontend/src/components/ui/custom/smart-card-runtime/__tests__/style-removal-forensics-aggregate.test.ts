/**
 * [UI-2 2026-10-24] style_removal 取证 · 会话级聚合器测试。
 *
 * 验收口径（SPEC_ST三面一致对齐施工计划_2026-10-24.md §2 UI-2 / 差距 D-4）：
 *   ① 同一节点（同 nodeId/selector）+ 同一原因重复移除 N 次 ⇒ 诊断记录条数 = 1、
 *      计数字段 = N（可从 diag 导出 JSON 的 records[].count 读到）；
 *   ② 不同节点各记各的、不同原因（node_removed / node_replaced）不合并；
 *   ③ 首次记录信息量不降级（message/textLength/身份全保留）；
 *   ④ 无身份载荷回退旧逐条行为（不聚合不丢信息）；
 *   ⑤ diag 关闭时计数面仍在 window.__palinkStyleRemovalAgg（零打扰，不弹任何 UI）；
 *   ⑥ 绑定锚点：CharacterCardRenderer 的 frame-error 分支必须真的接上聚合器（源码锚，
 *      风格同 frame-error-reporting-contract.test.ts），且全量记录路径未被降级。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/style-removal-forensics-aggregate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absorbStyleRemovalFrameError,
  getStyleRemovalAggSnapshot,
  isStyleRemovalForensicPayload,
  resetStyleRemovalAggForTest,
  STYLE_REMOVAL_AGG_WINDOW_KEY,
  styleRemovalAggKeyOf,
} from '../style-removal-forensics-aggregate';
import {
  palinkDiagDump,
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

  it('无节点身份的载荷不聚合：回退旧行为（恒 first，不进诊断计数）', () => {
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

  it('CharacterCardRenderer frame-error 分支必须接上聚合器：重复事件早退、首次走全量记录', () => {
    expect(rendererSource).toContain('isStyleRemovalForensicPayload(data)');
    expect(rendererSource).toContain('absorbStyleRemovalFrameError(data');
    expect(rendererSource).toContain('if (!verdict.first) return;');
    // 首次全量记录路径未被降级（取证字段一个不少）
    expect(rendererSource).toContain('node: data.node && typeof data.node === \'object\' ? data.node : undefined');
    expect(rendererSource).toContain('errorReason: typeof data.errorReason');
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
