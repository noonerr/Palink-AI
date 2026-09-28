/**
 * ComfyUI 浏览器直连客户端契约测试（SPEC_文生图浏览器桥接执行_2026-09-28）。
 * 全程 mock fetch，不碰真实网络。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyUIError, executeComfyUITask, probeComfyUI } from '../comfyui-client';
import type { LocalImageTask } from '@/types/imageGeneration';

const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function blobResponse(bytes: Uint8Array<ArrayBuffer>, status = 200): Response {
  return { ok: status < 400, status, blob: async () => new Blob([bytes]) } as unknown as Response;
}

function makeTask(overrides: Partial<LocalImageTask> = {}): LocalImageTask {
  return {
    task_id: 'lt_test00000001',
    kind: 'comfyui',
    message_kind: 'chat',
    session_id: 's1',
    message_id: 1,
    media_id: 'm_abc123456789',
    prompt: 'a cat',
    base_url: 'http://127.0.0.1:8188',
    workflow: { '9': { class_type: 'SaveImage' } },
    timeout_ms: 20000,
    created_at: 0,
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

describe('probeComfyUI 两段式探测', () => {
  it('端口无应答 → unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await probeComfyUI('http://127.0.0.1:8188');
    expect(result.status).toBe('unreachable');
    // 第一段失败就不再发第二段
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('端口有服务但 CORS 拦截 → cors_blocked', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return Promise.resolve({ ok: true } as Response);
      return Promise.reject(new TypeError('CORS'));
    });
    const result = await probeComfyUI('http://127.0.0.1:8188');
    expect(result.status).toBe('cors_blocked');
  });

  it('在线且可读 → ok 并带版本', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return Promise.resolve({ ok: true } as Response);
      return Promise.resolve(jsonResponse({ system: { comfyui_version: '0.3.40' } }));
    });
    const result = await probeComfyUI('http://127.0.0.1:8188/');
    expect(result.status).toBe('ok');
    expect(result.version).toBe('0.3.40');
  });

  it('空地址 → unreachable 且不发请求', async () => {
    const result = await probeComfyUI('   ');
    expect(result.status).toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('executeComfyUITask 执行闭环', () => {
  it('提交 → 轮询 history → /view 取图 → 裸 base64', async () => {
    const pngB64 = Buffer.from(PNG_BYTES).toString('base64');
    let historyCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href === 'http://127.0.0.1:8188/prompt') {
        return Promise.resolve(jsonResponse({ prompt_id: 'p1' }));
      }
      if (href === 'http://127.0.0.1:8188/history/p1') {
        historyCalls += 1;
        if (historyCalls === 1) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({
          p1: {
            status: { status_str: 'success' },
            outputs: { '9': { images: [{ filename: 'c.png', subfolder: '', type: 'output' }] } },
          },
        }));
      }
      if (href.startsWith('http://127.0.0.1:8188/view?')) {
        return Promise.resolve(blobResponse(PNG_BYTES));
      }
      return Promise.reject(new TypeError(`unexpected url ${href}`));
    });

    const stages: string[] = [];
    const images = await executeComfyUITask(makeTask(), {
      pollIntervalMs: 1,
      onStage: (stage) => stages.push(stage),
    });

    expect(images).toEqual([pngB64]);
    expect(stages).toEqual(['submit', 'poll', 'fetch']);
    const submitCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/prompt'));
    expect(JSON.parse(submitCall![1].body)).toEqual({ prompt: { '9': { class_type: 'SaveImage' } } });
    // /view 的查询参数来自 history 的 image ref
    const viewCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/view?'));
    expect(String(viewCall![0])).toContain('filename=c.png');
  });

  it('工作流执行失败 → workflow_error', async () => {
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: 'p1' }));
      if (href.endsWith('/history/p1')) {
        return Promise.resolve(jsonResponse({
          p1: { status: { status_str: 'error' }, outputs: {} },
        }));
      }
      return Promise.reject(new TypeError('unexpected'));
    });

    await expect(
      executeComfyUITask(makeTask(), { pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ code: 'workflow_error' });
  });

  it('history 里只有 temp 预览时取 fallback，有 output 时优先 output', async () => {
    const pngB64 = Buffer.from(PNG_BYTES).toString('base64');
    let historyCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: 'p1' }));
      if (href.endsWith('/history/p1')) {
        historyCalls += 1;
        return Promise.resolve(jsonResponse({
          p1: {
            outputs: { '9': { images: [
              { filename: 'temp.png', subfolder: '', type: 'temp' },
              { filename: 'out.png', subfolder: 'sub', type: 'output' },
            ] } },
          },
        }));
      }
      if (href.includes('/view?')) {
        expect(href).toContain('filename=out.png');
        return Promise.resolve(blobResponse(PNG_BYTES));
      }
      return Promise.reject(new TypeError('unexpected'));
    });

    const images = await executeComfyUITask(makeTask(), { pollIntervalMs: 1 });
    expect(images).toEqual([pngB64]);
    expect(historyCalls).toBe(1);
  });

  it('deadline 到点 → timeout', async () => {
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: 'p1' }));
      if (href.endsWith('/history/p1')) return Promise.resolve(jsonResponse({}));
      return Promise.reject(new TypeError('unexpected'));
    });

    await expect(
      executeComfyUITask(makeTask(), {
        pollIntervalMs: 1,
        deadlineMs: Date.now() + 40,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('提交阶段连接失败 → connect_failed（带可行动文案）', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(executeComfyUITask(makeTask())).rejects.toMatchObject({
      code: 'connect_failed',
    });
    await expect(executeComfyUITask(makeTask())).rejects.toThrow(ComfyUIError);
  });

  it('ComfyUI 返回 HTTP 4xx → submit_rejected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad workflow' }, 400));
    await expect(executeComfyUITask(makeTask())).rejects.toMatchObject({
      code: 'submit_rejected',
    });
  });
});
