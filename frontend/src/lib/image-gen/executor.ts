/**
 * 浏览器桥接执行器（模块级单例 + React 接线）。
 *
 * 职责：页面可见且桥接已启用时，每 2.5s 向自家后端认领待执行的本地出图任务，
 * 驱动 `comfyui-client` 打用户本机 ComfyUI，把结果/失败原因回传后端。
 * 媒体收敛完全由后端等待协程负责——本模块不碰消息状态，也不新增推送事件
 * （轮询是刻意选择：不动 useChatWebSocket / stream-engine 等活跃面，见 SPEC §2）。
 *
 * 权限弹窗（Chrome 本地网络访问）：首次真实请求 127.0.0.1 时由浏览器弹出，
 * 用户允许后按站点持久。执行器不做任何预扫描——只处理后端明确下发的任务。
 */
import type { LocalImageTask } from '@/types/imageGeneration';
import { ComfyUIError, executeComfyUITask } from './comfyui-client';

export interface ExecutorDeps {
  listTasks: () => Promise<{ tasks: LocalImageTask[] }>;
  submitResult: (taskId: string, images: string[]) => Promise<unknown>;
  submitFail: (taskId: string, error: string) => Promise<unknown>;
  executeTask: (task: LocalImageTask) => Promise<string[]>;
  /** 每次认领后回调（测试断言用）。 */
  onPolled?: (tasks: LocalImageTask[]) => void;
}

export interface ExecutorState {
  inFlightTaskIds: string[];
  completedCount: number;
  failedCount: number;
  lastError: string | null;
}

function createExecutor(deps: ExecutorDeps) {
  const inFlight = new Set<string>();
  const state: ExecutorState = { inFlightTaskIds: [], completedCount: 0, failedCount: 0, lastError: null };

  function failureMessage(error: unknown): string {
    if (error instanceof ComfyUIError) return error.message;
    return String((error as Error)?.message || '本机 ComfyUI 执行失败');
  }

  /** 单轮认领+执行。同一 task_id 不会并发执行；单轮串行处理，未完成留到下轮。 */
  async function pollOnce(): Promise<void> {
    if (inFlight.size > 0) return; // 上一轮还没跑完，等下一轮
    let tasks: LocalImageTask[] = [];
    try {
      const resp = await deps.listTasks();
      tasks = Array.isArray(resp?.tasks) ? resp.tasks : [];
    } catch {
      return; // 后端不可达/未登录：静默等下一轮
    }
    deps.onPolled?.(tasks);
    for (const task of tasks) {
      if (inFlight.has(task.task_id)) continue;
      inFlight.add(task.task_id);
      state.inFlightTaskIds = [...inFlight];
      try {
        const images = await deps.executeTask(task);
        await deps.submitResult(task.task_id, images);
        state.completedCount += 1;
      } catch (error) {
        state.failedCount += 1;
        state.lastError = failureMessage(error);
        try {
          await deps.submitFail(task.task_id, state.lastError);
        } catch {
          // 上报失败也吞掉：任务 45s 后会被回收重派
        }
      } finally {
        inFlight.delete(task.task_id);
        state.inFlightTaskIds = [...inFlight];
      }
    }
  }

  return { pollOnce, state };
}

export type ImageTaskExecutor = ReturnType<typeof createExecutor>;

/** 测试入口：注入依赖构造执行器。 */
export function createImageTaskExecutorForTest(deps: ExecutorDeps): ImageTaskExecutor {
  return createExecutor(deps);
}

// ---------------------------------------------------------------------------
// React 接线：App 根部挂一次
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 2500;

let activeExecutor: ImageTaskExecutor | null = null;

/** 非组件侧读法（设置页展示当前执行情况用）。 */
export function getActiveExecutor(): ImageTaskExecutor | null {
  return activeExecutor;
}

export function startExecutorLoop(deps: {
  isEnabled: () => boolean;
  listTasks: ExecutorDeps['listTasks'];
  submitResult: ExecutorDeps['submitResult'];
  submitFail: ExecutorDeps['submitFail'];
}): () => void {
  const executor = createExecutor({
    listTasks: deps.listTasks,
    submitResult: deps.submitResult,
    submitFail: deps.submitFail,
    executeTask: (task) => executeComfyUITask(task),
  });
  activeExecutor = executor;

  let stopped = false;
  const tick = () => {
    if (stopped || !deps.isEnabled()) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void executor.pollOnce();
  };
  tick();
  const timer = window.setInterval(tick, POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    if (activeExecutor === executor) activeExecutor = null;
  };
}
