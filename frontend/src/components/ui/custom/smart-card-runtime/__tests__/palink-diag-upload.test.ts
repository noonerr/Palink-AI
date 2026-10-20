/*
 * 包AG · 批次D — 记录器"节流上传"契约测试（父侧）
 *
 * 背景：包W 的红线原是"零网络"。2026-10-20 用户裁决 5 明确授权放开为
 * "记录器已启用的前提下允许上传到自家后端留痕"，但三条硬约束不许放宽：
 *   ① 只在 palinkDiagEnabled() 为真时上传（外部站点默认关）；
 *   ② 只传结构化字段白名单，detail / stack 一个字节都不传；
 *   ③ 失败静默、只试一次、不弹框不影响页面。
 *
 * 本文件逐条钉住这三条 + 增量计数语义。
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/palink-diag-upload.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DIAG_UPLOAD_ENDPOINT,
  DIAG_UPLOAD_FIELDS,
  DIAG_UPLOAD_LIMITS,
  absorbFrameDiagnostic,
  diagUploadStats,
  flushPalinkDiagUpload,
  installPalinkDiagGlobals,
  recordPalinkDiag,
  resetPalinkDiagForTest,
  setPalinkDiagEnabled,
} from '../palink-diag';

type FetchCall = { url: string; init: Record<string, unknown> };

function installFetchSpy(impl?: () => Promise<unknown>) {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    if (impl) return impl();
    return { ok: true, status: 200 };
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

function bodyOf(call: FetchCall): { batchId: string; records: Array<Record<string, unknown>> } {
  return JSON.parse(String(call.init.body));
}

beforeEach(() => {
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(true, false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPalinkDiagForTest();
});

describe('硬约束① 闸门：只在记录器启用时上传', () => {
  it('外部站点（默认关）产生记录后：fetch 调用数必须为 0', async () => {
    // 模拟公网访客：hostname 不是本机/内网，且没有手动开关
    localStorage.removeItem('palink.diag.enabled');
    resetPalinkDiagForTest();
    vi.stubGlobal('window', { location: { hostname: 'palink.example.com' } });
    const { spy } = installFetchSpy();

    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate' });
    const result = await flushPalinkDiagUpload();

    expect(spy).toHaveBeenCalledTimes(0);
    expect(result.skipped).toBe('disabled');
    expect(result.sent).toBe(0);
  });

  it('手动关（本机站点但用户关了）同样零 fetch', async () => {
    setPalinkDiagEnabled(false, false);
    const { spy } = installFetchSpy();
    recordPalinkDiag({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'site-a' });
    await flushPalinkDiagUpload();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('启用时：打到 /api/diagnostics/records，带 batchId 与 records', async () => {
    const { spy, calls } = installFetchSpy();
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'translate' });
    const result = await flushPalinkDiagUpload();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe(DIAG_UPLOAD_ENDPOINT);
    expect(DIAG_UPLOAD_ENDPOINT).toBe('/api/diagnostics/records');
    const body = bodyOf(calls[0]);
    expect(typeof body.batchId).toBe('string');
    expect(body.batchId.length).toBeGreaterThan(0);
    expect(body.records).toHaveLength(1);
    expect(result).toMatchObject({ sent: 1, ok: true });
  });
});

describe('硬约束② 白名单：detail / stack 一个字节都不传', () => {
  it('上传体每个记录的键集合与 DIAG_UPLOAD_FIELDS 逐键相等（多一个少一个都红）', async () => {
    const { calls } = installFetchSpy();
    recordPalinkDiag({
      owner: 'card_authored',
      kind: 'card_script_injection_failed',
      name: '变量结构',
      detail: '这里可能有卡正文片段：{hp:100}',
      stack: '    at inline (card:1:1)',
      filename: 'inline',
      lineno: 81,
      colno: 1,
      textLength: 4096,
      cardId: 'card-1',
    });
    await flushPalinkDiagUpload();

    const body = bodyOf(calls[0]);
    const keys = Object.keys(body.records[0]).sort();
    expect(keys).toEqual([...DIAG_UPLOAD_FIELDS].sort());
    expect(keys).toHaveLength(11);
    for (const forbidden of ['detail', 'stack', 'origin', 'firstAt', 'lastAt', 'key']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('载荷序列化后不含 detail / stack 的原文（逐字节搜）', async () => {
    const { calls } = installFetchSpy();
    const secretDetail = '绝不能上传的正文-A7f3';
    const secretStack = 'at cardScriptSecret-B9k1';
    recordPalinkDiag({
      owner: 'frame_compat',
      kind: 'compat_catch_swallowed',
      name: 'site-b',
      detail: secretDetail,
      stack: secretStack,
    });
    await flushPalinkDiagUpload();

    const raw = String(calls[0].init.body);
    expect(raw).not.toContain(secretDetail);
    expect(raw).not.toContain(secretStack);
    expect(raw).not.toContain('绝不能上传的正文');
  });

  it('帧内上送的 detail 同样被剥掉（absorb 路径不例外）', async () => {
    const { calls } = installFetchSpy();
    absorbFrameDiagnostic({
      detail: `palinkDiag:${JSON.stringify({
        owner: 'host_capability',
        kind: 'slash_command_unimplemented',
        name: 'alias',
        detail: '帧内细节-ShouldNotUpload',
        count: 1,
      })}`,
    });
    await flushPalinkDiagUpload();
    const raw = String(calls[0].init.body);
    expect(raw).not.toContain('帧内细节-ShouldNotUpload');
    expect(Object.keys(bodyOf(calls[0]).records[0]).sort()).toEqual([...DIAG_UPLOAD_FIELDS].sort());
  });
});

describe('硬约束③ 失败静默、只试一次', () => {
  it('网络失败：不抛、只发一次、不重试', async () => {
    const { spy } = installFetchSpy(() => Promise.reject(new Error('Failed to fetch')));
    recordPalinkDiag({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'setElementList' });

    const first = await flushPalinkDiagUpload();
    expect(first).toMatchObject({ sent: 0, ok: false });
    expect(spy).toHaveBeenCalledTimes(1);

    // 同一批记录不会再被重发一次（只试一次）
    const second = await flushPalinkDiagUpload();
    expect(second.sent).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(diagUploadStats().failedBatches).toBe(1);
  });

  it('HTTP 500：同样静默（不抛），只累加失败批次', async () => {
    installFetchSpy(() => Promise.resolve({ ok: false, status: 500 }));
    recordPalinkDiag({ owner: 'frame_compat', kind: 'host_script_error', name: 'boom' });
    const result = await flushPalinkDiagUpload();
    expect(result.ok).toBe(false);
    expect(diagUploadStats()).toMatchObject({ failedBatches: 1, lastResult: 'http_500' });
  });

  it('没有待上传记录时不打网络（空批不发）', async () => {
    const { spy } = installFetchSpy();
    const result = await flushPalinkDiagUpload();
    expect(result.skipped).toBe('empty');
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

describe('计数语义与配额', () => {
  it('count 传增量：先传 3，再累加 2 条后只传 2', async () => {
    const { calls } = installFetchSpy();
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    await flushPalinkDiagUpload();
    expect(bodyOf(calls[0]).records[0].count).toBe(3);

    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'echo' });
    await flushPalinkDiagUpload();
    expect(bodyOf(calls[1]).records[0].count).toBe(2);
  });

  it('单批条数不超过 batchRecords，剩下的留在 pending', async () => {
    const { calls } = installFetchSpy();
    const total = DIAG_UPLOAD_LIMITS.batchRecords + 5;
    for (let i = 0; i < total; i += 1) {
      recordPalinkDiag({ owner: 'frame_compat', kind: 'frame_record', name: `n-${i}` });
    }
    await flushPalinkDiagUpload();
    expect(bodyOf(calls[0]).records).toHaveLength(DIAG_UPLOAD_LIMITS.batchRecords);
    expect(diagUploadStats().pending).toBe(5);
  });

  it('批次配额到顶后不再上传（总量封顶，长驻页面不会无限灌）', async () => {
    const { spy } = installFetchSpy();
    for (let i = 0; i < DIAG_UPLOAD_LIMITS.maxBatches; i += 1) {
      recordPalinkDiag({ owner: 'frame_compat', kind: 'frame_record', name: `cap-${i}` });
      await flushPalinkDiagUpload();
    }
    expect(spy).toHaveBeenCalledTimes(DIAG_UPLOAD_LIMITS.maxBatches);

    recordPalinkDiag({ owner: 'frame_compat', kind: 'frame_record', name: 'after-cap' });
    const result = await flushPalinkDiagUpload();
    expect(result.skipped).toBe('batch_cap');
    expect(spy).toHaveBeenCalledTimes(DIAG_UPLOAD_LIMITS.maxBatches);
  });
});

describe('202 条未实现命令的留痕链路', () => {
  it('帧内 slash_command_unimplemented 记录能进上传载荷（名字/缺口 id 都在）', async () => {
    const { calls } = installFetchSpy();
    absorbFrameDiagnostic({
      detail: `palinkDiag:${JSON.stringify({
        owner: 'host_capability',
        kind: 'slash_command_unimplemented',
        name: 'persona-create',
        count: 2,
      })}`,
      stack: '',
    }, { frameId: 'frame-7', cardId: 'card-9' });
    await flushPalinkDiagUpload();

    const record = bodyOf(calls[0]).records[0];
    expect(record).toMatchObject({
      owner: 'host_capability',
      kind: 'slash_command_unimplemented',
      name: 'persona-create',
      count: 2,
      missingStSubsystem: 'persona_crud',
      frameId: 'frame-7',
      cardId: 'card-9',
    });
  });

  it('全局入口挂上 __palinkDiagUploadNow / __palinkDiagUploadStats（真机查验用）', () => {
    installPalinkDiagGlobals();
    const w = window as unknown as Record<string, unknown>;
    expect(typeof w.__palinkDiagUploadNow).toBe('function');
    expect(typeof w.__palinkDiagUploadStats).toBe('function');
    // 白名单是 11 个结构化字段，键名固定（与后端 DIAG_UPLOAD_FIELDS 同序）
    expect([...DIAG_UPLOAD_FIELDS]).toHaveLength(11);
  });
});
