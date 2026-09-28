/**
 * 模型清单拉取（设置页 Checkpoint 下拉用，B1-T1）。
 *
 * 锁两件事：①`/object_info` 的字段名 Service 端实际是 `input`（单数），二手实现
 * 也有 `inputs`，两者都要吃掉；②任何失败都要变成「空列表 + 中文原因」，设置页
 * 直接展示，绝不抛到 React 树里。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { extractCheckpointNames, listComfyUICheckpoints } from '../comfyui-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractCheckpointNames', () => {
  it('读标准 input.required.ckpt_name 结构', () => {
    const payload = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['a.safetensors', 'b.ckpt']] } },
      },
    };
    expect(extractCheckpointNames(payload)).toEqual(['a.safetensors', 'b.ckpt']);
  });

  it('兼容 inputs（复数）写法', () => {
    const payload = {
      CheckpointLoaderSimple: {
        inputs: { required: { ckpt_name: [['legacy.safetensors']] } },
      },
    };
    expect(extractCheckpointNames(payload)).toEqual(['legacy.safetensors']);
  });

  it('垃圾输入一律返回空数组，不抛', () => {
    expect(extractCheckpointNames(null)).toEqual([]);
    expect(extractCheckpointNames({})).toEqual([]);
    expect(extractCheckpointNames({ CheckpointLoaderSimple: {} })).toEqual([]);
    expect(extractCheckpointNames({ CheckpointLoaderSimple: { input: { required: {} } } })).toEqual([]);
  });
});

describe('listComfyUICheckpoints', () => {
  it('地址为空时给出可行动提示', async () => {
    const result = await listComfyUICheckpoints('');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });

  it('成功时返回模型名列表', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['qwen_image_bf16.safetensors']] } } },
      }),
    }));
    const result = await listComfyUICheckpoints('http://127.0.0.1:8188/');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen_image_bf16.safetensors']);
  });

  it('连不上（TypeError）时给「未授权/CORS」导向文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await listComfyUICheckpoints('http://127.0.0.1:8188');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('CORS');
  });

  it('HTTP 非 2xx 时报告状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await listComfyUICheckpoints('http://127.0.0.1:8188');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('500');
  });
});
