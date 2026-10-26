/*
 * 包W · 静默点接入守卫（第 ③ 笔）
 *
 * 钉四件事：
 *   A. 「新增空 catch 判红」：本包扫过的文件里，静默 catch（空 body，或只有一句注释）
 *      的数量必须 ≤ 基线；part-04 / part-05 / part-07 已清零，必须恒等于 0。
 *      ⇒ 谁再写一个吞掉异常又不落记录的 catch，这里立刻红。
 *   B. 站点名单：23 处 catch 记录的名字必须在**求值后载体**里逐条出现，且
 *      compat_catch_swallowed 出现次数恒等于站点数（少一处 = 有人摘掉了记录）。
 *   C. 帧内记录器的行为（求值 COMPAT_V2_RUNTIME_ARTIFACT 里的真实代码，不是副本）：
 *      去重计数、上送形状（severity=info ⇒ 不弹 toast）、环形上限、
 *      以及「位置取栈里的位置行而不是消息行」这条真机踩过的坑。
 *   D. 卡脚本失败记录必须带脚本名与身份（切片求值 bootstrap 的真实 helper）。
 *
 * 载体口径见 docs/_active/report/REPORT_包L_测试载体不保真假绿清单_2026-10-18.md：
 * 执行型断言只用 COMPAT_V2_RUNTIME_ARTIFACT。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-silent-point-guards.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_V2_RUNTIME_ARTIFACT } from './compat-v2-runtime-source';
import * as diag from '../palink-diag';
import { buildCardScriptFrameBootstrap, recordCardScriptInjectionFailure } from '@/lib/sillytavern/card-script-runner';

const RUNTIME_BODY_DIR = 'src/components/ui/custom/smart-card-runtime/runtime-body';
const readSource = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

/** 静默 catch = 空 body，或 body 里只有一句注释（等价于什么都不做）。 */
const SILENT_CATCH_PATTERN = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)*\}/g;
const silentCatchCount = (text: string) => (text.match(SILENT_CATCH_PATTERN) || []).length;

/**
 * 基线（包W 第 ③ 笔落地时实测；只降不升）。
 * part-04 / part-05 / part-07 = 0 是本包的成果，必须钉死。
 */
const SILENT_CATCH_BASELINE: Array<{ file: string; max: number; mustBeZero?: boolean }> = [
  { file: `${RUNTIME_BODY_DIR}/part-01.ts`, max: 11 },
  { file: `${RUNTIME_BODY_DIR}/part-02.ts`, max: 1 },
  { file: `${RUNTIME_BODY_DIR}/part-03.ts`, max: 5 },
  { file: `${RUNTIME_BODY_DIR}/part-04.ts`, max: 0, mustBeZero: true },
  { file: `${RUNTIME_BODY_DIR}/part-05.ts`, max: 0, mustBeZero: true },
  { file: `${RUNTIME_BODY_DIR}/part-06.ts`, max: 19 },
  { file: `${RUNTIME_BODY_DIR}/part-07.ts`, max: 0, mustBeZero: true },
  { file: `${RUNTIME_BODY_DIR}/part-08.ts`, max: 50 },
  { file: 'src/components/ui/custom/smart-card-runtime/palink-diag.ts', max: 7 },
  { file: 'src/components/ui/custom/CharacterCardRenderer.tsx', max: 9 },
  { file: 'src/components/ui/custom/Message.tsx', max: 3 },
  { file: 'src/lib/sillytavern/card-script-runner.ts', max: 8 },
];

const CATCH_SITES: string[] = [
  'part-04:dollar-text-set', 'part-04:dollar-html-set', 'part-04:dollar-append-move',
  'part-04:dollar-prepend-move', 'part-04:dollar-remove', 'part-04:dollar-show', 'part-04:dollar-hide',
  'part-05:dollar-html-empty', 'part-05:dollar-attr-object-set', 'part-05:dollar-attr-single-set',
  'part-05:dollar-blur', 'part-05:dollar-focus', 'part-05:dollar-before-insert',
  'part-05:dollar-after-insert', 'part-05:dollar-wrap', 'part-05:dollar-unwrap',
  'part-05:dollar-method-apply', 'part-05:dollar-query-creation', 'part-05:dollar-proxy-set',
  'part-05:emit-compat-event',
  'part-07:tavernhelper-proxy-marker', 'part-07:worker-terminate', 'part-07:worker-postmessage',
  // [批次TH 2026-10-26] 音频 autoplay 被浏览器拦下（playing 标志翻回 false，标志与实际发声一致）
  // 与 loadPreset 同步返回 true 后父侧 PUT selection 失败（选中名实际未切换）——两处新登记。
  'part-07:audio_play_blocked', 'part-07:preset_load_failed',
];

/** 切出求值后载体里「帧内记录器」那一段（从记录器注释到 window.context 形状留痕之后）。 */
function frameRecorderRegion(artifact: string): string {
  const start = artifact.indexOf('var PALINK_DIAG_OWNERS');
  const end = artifact.indexOf('const executeCompatInlineScriptCompat');
  expect(start, '帧内记录器段起点丢失（改名字段请先改守卫）').toBeGreaterThanOrEqual(0);
  expect(end, '帧内记录器段终点丢失').toBeGreaterThan(start);
  return artifact.slice(start, end);
}

interface FrameHarness {
  window: Record<string, unknown>;
  posted: Array<Record<string, unknown>>;
}

function buildFrameHarness(): FrameHarness {
  const posted: Array<Record<string, unknown>> = [];
  const win: Record<string, unknown> = {};
  const factory = new Function(
    'window',
    'post',
    'frameId',
    'ctx',
    'runtimeVersion',
    'runtimeMode',
    `${frameRecorderRegion(COMPAT_V2_RUNTIME_ARTIFACT)}
return { record: window.__palinkDiagRecord, dump: window.__palinkDiagDump, filename: palinkDiagFilenameFromStack, line: palinkDiagLineFromStack };`,
  );
  const api = factory(
    win,
    (payload: Record<string, unknown>) => { posted.push(payload); },
    'frame-guard-0001',
    { characterId: 'card-guard-0001' },
    'guard-runtime',
    'guard-mode',
  );
  // 求值这段时会顺带落「window.context 形状缺口」那条启动记录 ⇒ 断言一律按 kind 过滤，
  // 不依赖总数（总数随启动记录漂）。
  return { window: Object.assign(win, api), posted };
}

function recordsOfKind(h: FrameHarness, kind: string): Array<Record<string, unknown>> {
  const dump = JSON.parse((h.window.dump as () => string)());
  return dump.records.filter((r: Record<string, unknown>) => r.kind === kind);
}

describe('A 包W · 新增空 catch 判红（只限本包扫过的文件）', () => {
  SILENT_CATCH_BASELINE.forEach(({ file, max, mustBeZero }) => {
    const name = file.split('/').pop() as string;
    it(`${name} 的静默 catch 不得超过基线 ${max}`, () => {
      const count = silentCatchCount(readSource(file));
      expect(count, `${name} 里出现了没有记录的 catch ⇒ 请调 palinkDiagRecord / recordPalinkDiag 落一条`).toBeLessThanOrEqual(max);
      if (mustBeZero) expect(count, `${name} 已由包W 清零，不得再引入静默 catch`).toBe(0);
    });
  });

  it('part-04 / part-05 / part-07 的每一处 catch 都必须带记录调用', () => {
    ['part-04', 'part-05', 'part-07'].forEach((stem) => {
      const text = readSource(`${RUNTIME_BODY_DIR}/${stem}.ts`);
      const catchTotal = (text.match(/catch\s*(?:\([^)]*\))?\s*\{/g) || []).length;
      const recorded = (text.match(/palinkDiagRecord/g) || []).length;
      expect(recorded, `${stem} 里 catch 数量与记录数量必须对得上`).toBeGreaterThanOrEqual(Math.min(catchTotal, CATCH_SITES.filter((s) => s.startsWith(`${stem}:`)).length));
    });
  });
});

describe('B 包W · 站点名与记录种类必须在场（摘掉任一处记录即红）', () => {
  it('23 个 catch 站点名逐条出现在求值后载体里', () => {
    CATCH_SITES.forEach((site) => {
      expect(COMPAT_V2_RUNTIME_ARTIFACT, `站点 ${site} 的记录丢失`).toContain(site);
    });
  });

  it('compat_catch_swallowed 出现次数恰好等于站点数', () => {
    const occurrences = COMPAT_V2_RUNTIME_ARTIFACT.split('compat_catch_swallowed').length - 1;
    expect(occurrences).toBe(CATCH_SITES.length);
  });

  it('未实现 slash 命令：既记 host_capability，又照旧返回空串', () => {
    const region = COMPAT_V2_RUNTIME_ARTIFACT.slice(
      COMPAT_V2_RUNTIME_ARTIFACT.indexOf("if (bridgedResult.indexOf('Error: Unknown command') === 0)"),
    );
    const head = region.slice(0, 900);
    expect(head).toContain("owner: 'host_capability'");
    expect(head).toContain("kind: 'slash_command_unimplemented'");
    expect(head).toContain("return '';");
  });

  it('TavernHelper 未实现键：记 host_capability 且不调新返回值', () => {
    const region = COMPAT_V2_RUNTIME_ARTIFACT.slice(
      COMPAT_V2_RUNTIME_ARTIFACT.indexOf("code: 'missing_api'"),
      COMPAT_V2_RUNTIME_ARTIFACT.indexOf("code: 'missing_api'") + 1400,
    );
    expect(region).toContain("owner: 'host_capability'");
    expect(region).toContain('tavernhelper_key_unimplemented');
    expect(region).toContain("requestParent('unknownApiCall'");
  });

  it('rejection 轨与 window error 轨都进记录器（toast 那条 reportDiagnostic 仍在）', () => {
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain("kind: 'unhandled_rejection'");
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain("kind: refMatch ? 'global_shape_absent' : 'script_error'");
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain("code: 'unhandled_rejection'");
  });

  it('window.context 形状缺口在启动时如实记一条 frame_compat', () => {
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain("name: 'window.context'");
    expect(COMPAT_V2_RUNTIME_ARTIFACT).toContain("kind: 'global_shape_absent'");
  });

  it('宿主侧接入点在位（卡脚本身份 / 变量块残留 / 帧记录吸收）', () => {
    const runner = readSource('src/lib/sillytavern/card-script-runner.ts');
    expect(runner).toContain('recordCardScriptInjectionFailure');
    expect(runner).toContain('card_script_injection_failed');
    const message = readSource('src/components/ui/custom/Message.tsx');
    expect(message).toContain('variable_block_residual');
    const renderer = readSource('src/components/ui/custom/CharacterCardRenderer.tsx');
    expect(renderer).toContain('absorbFrameDiagnostic(');
  });
});

describe('C 包W · 帧内记录器行为（求值真实载体）', () => {
  it('同名去重：1 条记录、count 累加、首次细节不被覆盖', () => {
    const h = buildFrameHarness();
    const record = h.window.record as (input: Record<string, unknown>) => Record<string, unknown>;
    const first = record({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate', detail: '首次细节' });
    expect(first).toBeTruthy();
    record({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate' });
    record({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate' });
    const hits = recordsOfKind(h, 'slash_command_unimplemented');
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(3);
    expect(hits[0].detail).toBe('首次细节');
    expect(hits[0].owner).toBe('host_capability');
    const dump = JSON.parse((h.window.dump as () => string)());
    expect(dump.frameId).toBe('frame-guard-0001');
    expect(dump.cardId).toBe('card-guard-0001');
    expect(dump.records.some((r: Record<string, unknown>) => r.name === 'window.context')).toBe(true);
  });

  it('上送走既有 st:diagnostic，severity=info（宿主 toast 闸门对 info 不弹 ⇒ 用户可见行为不变）', () => {
    const h = buildFrameHarness();
    const record = h.window.record as (input: Record<string, unknown>) => unknown;
    h.posted.length = 0;
    record({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.getPreset' });
    const payload = h.posted[0];
    expect(payload).toBeTruthy();
    expect(payload.type).toBe('st:diagnostic');
    const diagnostic = payload.diagnostic as Record<string, unknown>;
    expect(diagnostic.severity).toBe('info');
    expect(diagnostic.code).toBe('palink_diag');
    expect(String(diagnostic.detail).startsWith('palinkDiag:')).toBe(true);
    const uplinked = JSON.parse(String(diagnostic.detail).replace('palinkDiag:', ''));
    expect(uplinked.owner).toBe('host_capability');
    expect(uplinked.count).toBe(1);
  });

  it('环形上限：灌 500 条后不超 200，dropped 记账', () => {
    const h = buildFrameHarness();
    const record = h.window.record as (input: Record<string, unknown>) => unknown;
    for (let i = 0; i < 500; i += 1) record({ owner: 'frame_compat', kind: 'flood', name: `f-${i}` });
    const dump = JSON.parse((h.window.dump as () => string)());
    expect(dump.totals.records).toBeLessThanOrEqual(200);
    expect(dump.totals.dropped).toBeGreaterThanOrEqual(300);
    expect(dump.limits.perFrame).toBe(200);
  });

  it('位置从栈里的「位置行」取，不是首行消息（真机踩过的坑：filename 恒空）', () => {
    const h = buildFrameHarness();
    const filename = h.window.filename as (stack: string) => string;
    const line = h.window.line as (stack: string) => { lineno: number; colno: number };
    const chromeStack = ['Error: boom', '    at execute (about:srcdoc:81:1)', '    at Array.forEach (<anonymous>)'].join(String.fromCharCode(10));
    expect(filename(chromeStack)).toBe('about:srcdoc');
    expect(line(chromeStack)).toEqual({ lineno: 81, colno: 1 });
    const firefoxStack = 'execute@about:srcdoc:81:1';
    expect(filename(firefoxStack)).toBe('about:srcdoc');
  });

  it('owner 只认四类名单：写野名字一律回落到 frame_compat（派单口径不被污染）', () => {
    const h = buildFrameHarness();
    const record = h.window.record as (input: Record<string, unknown>) => Record<string, unknown>;
    const bogus = record({ owner: 'backend_team', kind: 'card_script_injection_failed', name: 'bogus-owner' });
    expect(bogus.owner).toBe('frame_compat');
    const ok = record({ owner: 'card_authored', kind: 'card_script_injection_failed', name: '变量结构' });
    expect(ok.owner).toBe('card_authored');
  });
});

describe('D 包W · 卡脚本 bootstrap 身份取证（求值真实 bootstrap 源码）', () => {
  function sliceBootstrap(artifact: string, startMarker: string, endMarker: string): string {
    const start = artifact.indexOf(startMarker);
    const end = artifact.indexOf(endMarker, start);
    expect(start, `bootstrap 段起点丢失：${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return artifact.slice(start, end);
  }

  it('palinkCardScriptDiagRecord 带 id / 脚本名 / 字节数，并按报错文本定 owner', () => {
    const src = buildCardScriptFrameBootstrap('frame-bootstrap-guard');
    const helpers = sliceBootstrap(src, 'const palinkCardScriptLf', 'const execute = (scripts) =>');
    const records: Array<Record<string, unknown>> = [];
    // helper 切片里连着「window 报错 ↔ 未 load 脚本」那条一次性关联监听（card-script-runner.ts:447），
    // 它在本包之外，夹具只给 no-op，不让它改变 records 计数。
    const win: Record<string, unknown> = {
      addEventListener: () => {},
      __palinkDiagRecord: (input: Record<string, unknown>) => { records.push(input); },
    };
    const factory = new Function('window', `${helpers}
return {
  record: palinkCardScriptDiagRecord,
  syntaxish: palinkCardScriptSyntaxish,
  failureText: palinkCardScriptFailureText,
  add: palinkCardScriptPendingAdd,
  remove: palinkCardScriptPendingRemove,
  lines: palinkCardScriptLineCount,
};`);
    const api = factory(win);
    api.record({
      id: '2d6bd520-probe',
      name: '变量结构',
      content: 'a'.repeat(3054),
      failure: {
        message: "Uncaught SyntaxError: Unexpected token '}'",
        filename: 'about:srcdoc',
        lineno: 81,
        colno: 1,
        stack: "SyntaxError: Unexpected token '}'",
      },
      via: 'window_error_correlated',
    });
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.owner).toBe('card_authored');
    expect(rec.kind).toBe('card_script_injection_failed');
    expect(rec.name).toBe('变量结构');
    expect(String(rec.detail)).toContain('2d6bd520-probe');
    expect(String(rec.detail)).toContain('3054 字节');
    expect(rec.textLength).toBe(3054);
    expect(rec.filename).toBe('about:srcdoc');
    expect(rec.lineno).toBe(81);
    expect(rec.colno).toBe(1);

    api.record({ id: 'bare', name: '', content: 'x', failure: {}, via: 'element_onerror' });
    expect(records[1].owner).toBe('frame_compat');
    expect(String(records[1].detail)).toContain('归属待人工判定');
    expect(records[1].name).toBe('bare');

    expect(api.syntaxish("Unexpected token '}'")).toBe(true);
    expect(api.syntaxish('TypeError: x is not a function')).toBe(false);
    expect(api.lines('a' + String.fromCharCode(10) + 'b')).toBe(2);
  });

  it('记录器不在场时（切片夹具）bootstrap 取证不得抛错 —— 保证行为零变化', () => {
    const src = buildCardScriptFrameBootstrap('frame-bootstrap-guard-2');
    const start = src.indexOf('const palinkCardScriptLf');
    const end = src.indexOf('const execute = (scripts) =>');
    const helpers = src.slice(start, end);
    const factory = new Function('window', `${helpers}
return { record: palinkCardScriptDiagRecord };`);
    const api = factory({ addEventListener: () => {} });
    expect(() => api.record({ id: 'a', name: 'b', content: 'c', failure: new Error('x'), via: 'unit' })).not.toThrow();
  });

  it('宿主侧 recordCardScriptInjectionFailure 落 recordPalinkDiag 且身份齐全', () => {
    diag.resetPalinkDiagForTest();
    diag.setPalinkDiagEnabled(true, false);
    recordCardScriptInjectionFailure({
      id: 'host-probe-id',
      name: '变量结构（宿主轨）',
      content: 'line1' + String.fromCharCode(10) + 'line2',
      failure: { message: "Uncaught SyntaxError: Unexpected token '}'", stack: '', filename: '', lineno: -1, colno: -1 },
      via: 'host_append_throw',
      characterId: 'card-host-1',
    });
    const records = diag.palinkDiagRecords();
    expect(records).toHaveLength(1);
    expect(records[0].owner).toBe('card_authored');
    expect(records[0].name).toBe('变量结构（宿主轨）');
    expect(records[0].detail).toContain('host-probe-id');
    expect(records[0].detail).toContain('2 行');
    diag.resetPalinkDiagForTest();
  });
});
