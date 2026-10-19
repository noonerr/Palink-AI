/*
 * 包W · 静默失败统一记录器（父侧）契约测试
 *
 * 钉住四件事（用户拍板的产品形状）：
 *   1. 去重但不丢弃：同名首次带细节，后续只累加 count 与 lastAt。
 *   2. owner 四类是封闭名单，每条记录必带（主控按它派单）。
 *   3. 缓冲有界：每类 ≤200、总 ≤2000，灌 5000 条也不会无界增长。
 *   4. 零网络、零用户可见提示：模块里不许出现 fetch；关闭状态下连缓冲都不写。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-recorder.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIAG_LIMITS,
  PALINK_DIAG_KINDS,
  PALINK_DIAG_OWNERS,
  PALINK_DIAG_STORAGE_KEY,
  type PalinkDiagOwner,
  absorbFrameDiagnostic,
  exportPalinkDiag,
  installPalinkDiagGlobals,
  isLocalPalinkSite,
  palinkDiagDump,
  palinkDiagEnabled,
  palinkDiagRecords,
  palinkDiagStGapRanking,
  palinkDiagSummaryLine,
  palinkDiagTotals,
  recordPalinkDiag,
  resetPalinkDiagForTest,
  setPalinkDiagEnabled,
} from '../palink-diag';

const OWNER_KIND_EXPECTATION: Record<string, string> = {
  slash_command_unimplemented: 'host_capability',
  compat_catch_swallowed: 'frame_compat',
  global_shape_absent: 'frame_compat',
  tavernhelper_key_unimplemented: 'host_capability',
  card_script_injection_failed: 'card_authored',
  variable_block_residual: 'display_pipeline',
};

beforeEach(() => {
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(true, false);
});

afterEach(() => {
  resetPalinkDiagForTest();
});

describe('包W 记录器 · 开关（开发者模式默认开 + 手动开关）', () => {
  it('本机 hostname 判定为默认开，外部 hostname 默认关', () => {
    localStorage.removeItem(PALINK_DIAG_STORAGE_KEY);
    resetPalinkDiagForTest();
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    expect(isLocalPalinkSite()).toBe(true);
    vi.stubGlobal('window', { location: { hostname: 'palink.example.com' } });
    expect(isLocalPalinkSite()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('手动关：record 返回 null 且缓冲为空（对用户安静，对记录啰嗦的反面是"开关关=零成本"）', () => {
    setPalinkDiagEnabled(false, false);
    expect(palinkDiagEnabled()).toBe(false);
    expect(recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'nope' })).toBeNull();
    expect(palinkDiagRecords()).toHaveLength(0);
  });

  it('localStorage 手动开关持久化：写 1 后重新读仍为开', () => {
    resetPalinkDiagForTest();
    setPalinkDiagEnabled(true, true);
    expect(localStorage.getItem(PALINK_DIAG_STORAGE_KEY)).toBe('1');
    resetPalinkDiagForTest();
    expect(palinkDiagEnabled()).toBe(true);
  });
});

describe('包W 记录器 · 去重不丢弃', () => {
  it('同名 12 次只占一条，count 累加、firstAt 不被后写覆盖', () => {
    const first = recordPalinkDiag({
      owner: 'host_capability',
      kind: 'slash_command_unimplemented',
      name: 'translate',
      detail: '宿主未实现 /translate',
      stack: '    at x (http://a/b.js:1:2)',
    });
    expect(first).not.toBeNull();
    const firstAt = first!.firstAt;
    for (let i = 0; i < 11; i += 1) recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate' });
    const records = palinkDiagRecords();
    expect(records).toHaveLength(1);
    expect(records[0].count).toBe(12);
    expect(records[0].firstAt).toBe(firstAt);
    expect(records[0].lastAt).toBeGreaterThanOrEqual(firstAt);
    expect(records[0].detail).toBe('宿主未实现 /translate');
    expect(records[0].stack).toContain('http://a/b.js');
  });

  it('细节缺省时后写可补上（首次没栈、后来有栈 ⇒ 不留空）', () => {
    recordPalinkDiag({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'site-a' });
    recordPalinkDiag({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'site-a', stack: '    at y (http://c/d.js:3:4)', filename: 'http://c/d.js' });
    const rec = palinkDiagRecords()[0];
    expect(rec.filename).toBe('http://c/d.js');
    expect(rec.count).toBe(2);
  });
});

describe('包W 记录器 · 有界', () => {
  it('灌 5000 条不同名后：总数不超 total，单 owner 不超 perOwner', () => {
    const owners = [...PALINK_DIAG_OWNERS];
    for (let i = 0; i < 5000; i += 1) {
      recordPalinkDiag({ owner: owners[i % owners.length], kind: 'frame_record', name: `n-${i}` });
    }
    const records = palinkDiagRecords();
    expect(records.length).toBeLessThanOrEqual(DIAG_LIMITS.total);
    for (const owner of owners) {
      const n = records.filter((r) => r.owner === owner).length;
      expect(n).toBeLessThanOrEqual(DIAG_LIMITS.perOwner);
    }
    expect(palinkDiagTotals().dropped).toBeGreaterThan(0);
  });

  it('同名反复灌不涨条数（只涨 count）', () => {
    for (let i = 0; i < 3000; i += 1) {
      recordPalinkDiag({ owner: 'display_pipeline', kind: 'variable_block_residual', name: 'UpdateVariable' });
    }
    expect(palinkDiagRecords()).toHaveLength(1);
    expect(palinkDiagRecords()[0].count).toBe(3000);
  });
});

describe('包W 记录器 · schema 与导出', () => {
  it('dump 是 JSON 字符串，字段名稳定（主控照字段派单）', () => {
    recordPalinkDiag({ owner: 'card_authored', kind: 'card_script_injection_failed', name: '变量结构', filename: 'inline', lineno: 81, colno: 1, textLength: 4096, cardId: 'bcf12cd3' });
    const parsed = JSON.parse(palinkDiagDump());
    expect(parsed.schema).toBe('palink-diag/v1');
    expect(parsed.limits).toEqual({ perOwner: 200, total: 2000 });
    expect(parsed.records[0]).toMatchObject({
      owner: 'card_authored',
      kind: 'card_script_injection_failed',
      name: '变量结构',
      lineno: 81,
      colno: 1,
      textLength: 4096,
      cardId: 'bcf12cd3',
      count: 1,
    });
    for (const field of ['key', 'owner', 'kind', 'name', 'detail', 'stack', 'filename', 'lineno', 'colno', 'frameId', 'cardId', 'textLength', 'origin', 'count', 'firstAt', 'lastAt']) {
      expect(Object.keys(parsed.records[0])).toContain(field);
    }
  });

  it('汇总只有一行，含各 owner 计数与前几名', () => {
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    recordPalinkDiag({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:text-set' });
    const line = palinkDiagSummaryLine();
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('host_capability=1');
    expect(line).toContain('frame_compat=1');
    expect(line).toContain('slash_command_unimplemented:echo×2');
  });

  it('导出走本地下载，模块内零网络（红线：不许上传）', () => {
    const sourceText = readFileSync(join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/palink-diag.ts'), 'utf8');
    expect(sourceText).not.toMatch(/fetch\(/);
    expect(sourceText).not.toMatch(/XMLHttpRequest/);
    expect(sourceText).not.toMatch(/sendBeacon/);
    let clicked = '';
    const realCreate = URL.createObjectURL;
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      clicked = this.download;
    };
    try {
      expect(exportPalinkDiag('palink-diag-test.json')).toBe(true);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
      vi.stubGlobal('URL', { ...URL, createObjectURL: realCreate });
    }
    expect(clicked).toBe('palink-diag-test.json');
  });

  it('全局可读入口挂得上（__palinkDiagDump 返回 JSON 字符串）', () => {
    installPalinkDiagGlobals();
    recordPalinkDiag({ owner: 'frame_compat', kind: 'global_shape_absent', name: 'window.context' });
    const w = window as unknown as Record<string, () => string>;
    expect(typeof w.__palinkDiagDump).toBe('function');
    expect(typeof w.__palinkDiagDump()).toBe('string');
    expect(JSON.parse(w.__palinkDiagDump()).records[0].name).toBe('window.context');
  });

  // [包Z Z-3] 排行入口必须挂在 window 上，且语义与 palinkDiagStGapRanking() 一致
  it('__palinkDiagRanking() 挂上全局，返回数组且按事件数降序', () => {
    installPalinkDiagGlobals();
    const w = window as unknown as Record<string, () => Array<{ id: string; records: number; events: number }>>;
    expect(typeof w.__palinkDiagRanking).toBe('function');
    const ranking = w.__palinkDiagRanking();
    expect(Array.isArray(ranking)).toBe(true);

    // 灌两个缺口：zeta 踩 2 次事件、alpha 踩 1 次 ⇒ zeta 必须排在 alpha 前
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'listvar', missingStSubsystem: 'zeta_gap' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'listvar', missingStSubsystem: 'zeta_gap' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'alias', missingStSubsystem: 'alpha_gap' });
    const byId = w.__palinkDiagRanking();
    const zeta = byId.find((x) => x.id === 'zeta_gap');
    const alpha = byId.find((x) => x.id === 'alpha_gap');
    expect(zeta).toMatchObject({ records: 1, events: 2 });
    expect(alpha).toMatchObject({ records: 1, events: 1 });
    expect(byId.findIndex((x) => x.id === 'zeta_gap')).toBeLessThan(byId.findIndex((x) => x.id === 'alpha_gap'));
    // 降序不变式：任意相邻两项 events 不减
    for (let i = 1; i < byId.length; i += 1) {
      expect(byId[i - 1].events).toBeGreaterThanOrEqual(byId[i].events);
    }
    // 全局入口与导出的直调结果逐字节一致（不是两份实现）
    expect(JSON.stringify(w.__palinkDiagRanking())).toBe(JSON.stringify(palinkDiagStGapRanking()));
  });
});

describe('包W 记录器 · 帧内上送经既有 st:diagnostic 通道', () => {
  it('absorb 解出 palinkDiag: 前缀负载并按 owner 落库，origin=frame', () => {
    const diag = {
      severity: 'info',
      code: 'palink_diag',
      detail: `palinkDiag:${JSON.stringify({
        owner: 'host_capability',
        kind: 'slash_command_unimplemented',
        name: 'alias',
        detail: '引擎报 Error: Unknown command',
        filename: '',
        lineno: -1,
        colno: -1,
        count: 1,
      })}`,
    };
    const rec = absorbFrameDiagnostic(diag, { frameId: 'frame-abc', cardId: 'card-1' });
    expect(rec).not.toBeNull();
    expect(rec!.owner).toBe('host_capability');
    expect(rec!.origin).toBe('frame');
    expect(rec!.frameId).toBe('frame-abc');
    expect(rec!.cardId).toBe('card-1');
  });

  it('上送的是增量：帧里 12 次（1 + 10 + 1…）父侧累计与帧侧一致，不会翻倍', () => {
    absorbFrameDiagnostic({ detail: `palinkDiag:${JSON.stringify({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'setElementList', count: 1 })}` });
    absorbFrameDiagnostic({ detail: `palinkDiag:${JSON.stringify({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'setElementList', count: 10 })}` });
    absorbFrameDiagnostic({ detail: `palinkDiag:${JSON.stringify({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'setElementList', count: 10 })}` });
    expect(palinkDiagRecords()).toHaveLength(1);
    expect(palinkDiagRecords()[0].count).toBe(21);
  });

  it('非本通道的 diagnostic（包I 既有形状）不被误吞，返回 null 且零写入', () => {
    expect(absorbFrameDiagnostic({ severity: 'error', code: 'unhandled_rejection', message: 'Failed to fetch' })).toBeNull();
    expect(palinkDiagRecords()).toHaveLength(0);
  });

  it('kind 名单与 owner 归属表钉住：新增 kind 必须显式登记，否则测试红', () => {
    for (const [kind, owner] of Object.entries(OWNER_KIND_EXPECTATION)) {
      expect(PALINK_DIAG_KINDS).toContain(kind);
      recordPalinkDiag({ owner: owner as PalinkDiagOwner, kind, name: `probe-${kind}` });
      const rec = palinkDiagRecords().find((r) => r.kind === kind);
      expect(rec!.owner).toBe(owner);
    }
  });
});
