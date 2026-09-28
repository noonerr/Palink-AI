/**
 * 多设备算力路由（B2-T3）的前端一半。
 *
 * 锁三件事：
 * 1. 角色判定：auto → 桌面当算力、移动端当遥控器；显式值优先。
 * 2. [§9 R3] **可见性行为改动**：改动前 `visibilityState !== 'visible'` 直接 return
 *    （隐藏页零轮询），现在两种可见性都要发认领请求。测试同时锁住 hidden 也发。
 * 3. [§9 R2] 渲染期间也要发认领请求（= 心跳续期），否则 45s 后活会被别的设备抢走。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCapability, getComputeRole, setComputeRole, getDeviceId, resetDeviceId } from '../device';
import { createImageTaskExecutorForTest } from '../executor';
import type { LocalImageTask } from '@/types/imageGeneration';

const task = (id: string): LocalImageTask => ({
  task_id: id,
  kind: 'comfyui',
  message_kind: 'chat',
  media_id: 'm1',
  prompt: 'p',
  base_url: 'http://127.0.0.1:8188',
  workflow: {},
  timeout_ms: 120000,
  created_at: 0,
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('pointer: fine') ? true : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('设备角色', () => {
  it('auto 在桌面（指针精确）上当算力', () => {
    expect(resolveCapability('auto')).toBe('provider');
  });

  it('auto 在移动端当遥控器', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: fine') ? false : true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(resolveCapability('auto')).toBe('controller');
  });

  it('显式角色覆盖自动判定', () => {
    expect(resolveCapability('controller')).toBe('controller');
    expect(resolveCapability('provider')).toBe('provider');
  });

  it('角色写入后可读回，非法值回落 auto', () => {
    expect(getComputeRole()).toBe('auto');
    setComputeRole('controller');
    expect(getComputeRole()).toBe('controller');
    localStorage.setItem('palink_image_compute_role', 'garbage');
    expect(getComputeRole()).toBe('auto');
  });

  it('device_id 是随机 uuid 且可重置（不是设备指纹）', () => {
    const first = getDeviceId();
    expect(first).toBeTruthy();
    expect(getDeviceId()).toBe(first);
    const second = resetDeviceId();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe('执行器轮询节奏', () => {
  it('[§9 R3] 页面隐藏时也要发认领请求（改动前是完全不拉）', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const calls: string[] = [];
    const executor = createImageTaskExecutorForTest({
      listTasks: async () => {
        calls.push('claim');
        return { tasks: [] };
      },
      submitResult: async () => ({}),
      submitFail: async () => ({}),
      executeTask: async () => ['x'],
    });
    await executor.pollOnce();
    expect(calls).toEqual(['claim']);
  });

  it('页面可见时同样发认领请求', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    let calls = 0;
    const executor = createImageTaskExecutorForTest({
      listTasks: async () => {
        calls += 1;
        return { tasks: [task('t1')] };
      },
      submitResult: async () => ({}),
      submitFail: async () => ({}),
      executeTask: async () => ['x'],
    });
    await executor.pollOnce();
    expect(calls).toBe(1);
    expect(executor.state.completedCount).toBe(1);
  });

  it('[§9 R2] 手里还有活时仍然发认领请求（= 心跳续期）', async () => {
    let calls = 0;
    const executor = createImageTaskExecutorForTest({
      listTasks: async () => {
        calls += 1;
        return { tasks: [] };
      },
      submitResult: async () => ({}),
      submitFail: async () => ({}),
      // 永远不 resolve：模拟本机还在渲染
      executeTask: () => new Promise<string[]>(() => {}),
    });
    void executor.pollOnce(); // 故意不 await：让任务停在 in-flight
    await new Promise((r) => setTimeout(r, 10));
    await executor.pollOnce();
    expect(calls).toBe(2); // 第二轮照样发请求 = 续期
    expect(executor.state.inFlightTaskIds).toHaveLength(0); // 但它没接新活（列表为空）
  });
});
