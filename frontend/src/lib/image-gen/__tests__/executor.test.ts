/**
 * 浏览器桥接执行器（executor）契约测试：认领 → 执行 → 回传/上报失败。
 * 依赖全注入，不碰网络与 React。
 */
import { describe, expect, it, vi } from 'vitest';
import { ComfyUIError } from '../comfyui-client';
import { createImageTaskExecutorForTest, type ExecutorDeps } from '../executor';
import type { LocalImageTask } from '@/types/imageGeneration';

function makeTask(id: string): LocalImageTask {
  return {
    task_id: id,
    kind: 'comfyui',
    message_kind: 'chat',
    session_id: 's1',
    message_id: 1,
    media_id: 'm_abc123456789',
    prompt: 'a cat',
    base_url: 'http://127.0.0.1:8188',
    workflow: {},
    timeout_ms: 20000,
    created_at: 0,
  };
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps & {
  submitResult: ReturnType<typeof vi.fn>;
  submitFail: ReturnType<typeof vi.fn>;
  executeTask: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
} {
  return {
    listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    submitResult: vi.fn().mockResolvedValue({ status: 'ok' }),
    submitFail: vi.fn().mockResolvedValue({ status: 'ok' }),
    executeTask: vi.fn().mockResolvedValue(['AAAA']),
    ...overrides,
  } as never;
}

describe('executor 轮询执行', () => {
  it('认领任务 → 执行 → 回传结果', async () => {
    const deps = makeDeps({
      listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('lt_1')] }),
    });
    const executor = createImageTaskExecutorForTest(deps);
    await executor.pollOnce();

    expect(deps.executeTask).toHaveBeenCalledTimes(1);
    expect(deps.executeTask).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'lt_1' }));
    expect(deps.submitResult).toHaveBeenCalledWith('lt_1', ['AAAA']);
    expect(deps.submitFail).not.toHaveBeenCalled();
    expect(executor.state.completedCount).toBe(1);
  });

  it('执行失败 → 携带中文原因上报 /fail', async () => {
    const deps = makeDeps({
      listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('lt_2')] }),
      executeTask: vi.fn().mockRejectedValue(
        new ComfyUIError('cors_blocked', 'CORS 未放行'),
      ),
    });
    const executor = createImageTaskExecutorForTest(deps);
    await executor.pollOnce();

    expect(deps.submitResult).not.toHaveBeenCalled();
    expect(deps.submitFail).toHaveBeenCalledWith('lt_2', 'CORS 未放行');
    expect(executor.state.failedCount).toBe(1);
    expect(executor.state.lastError).toBe('CORS 未放行');
  });

  it('in-flight 期间重复 poll 不重复执行', async () => {
    let release!: (images: string[]) => void;
    const gate = new Promise<string[]>((resolve) => { release = resolve; });
    const deps = makeDeps({
      listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask('lt_3')] }),
      executeTask: vi.fn().mockReturnValue(gate),
    });
    const executor = createImageTaskExecutorForTest(deps);

    const first = executor.pollOnce();
    // 等第一轮真正进入 in-flight（listTasks 已返回、任务已登记）再发第二轮
    await vi.waitFor(() => expect(executor.state.inFlightTaskIds).toEqual(['lt_3']));
    await executor.pollOnce(); // 应早退（in-flight 非空）
    release(['AAAA']);
    await first;

    expect(deps.listTasks).toHaveBeenCalledTimes(1);
    expect(deps.executeTask).toHaveBeenCalledTimes(1);
    expect(deps.submitResult).toHaveBeenCalledTimes(1);
  });

  it('任务数组为空时不触发执行', async () => {
    const deps = makeDeps();
    const executor = createImageTaskExecutorForTest(deps);
    await executor.pollOnce();
    expect(deps.executeTask).not.toHaveBeenCalled();
  });

  it('listTasks 抛错（未登录等）→ 静默跳过本轮', async () => {
    const deps = makeDeps({
      listTasks: vi.fn().mockRejectedValue(new Error('401')),
    });
    const executor = createImageTaskExecutorForTest(deps);
    await expect(executor.pollOnce()).resolves.toBeUndefined();
    expect(deps.executeTask).not.toHaveBeenCalled();
  });
});
