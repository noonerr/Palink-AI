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
    // 注意顺序：认领请求**永远要发出去**，哪怕手里还有活没干完。
    // [§9 R2 选项①] 后端靠同一 device_id 的重复认领给"正在渲染的任务"续期，
    // 否则第 45 秒任务就会被回收、被另一台设备重画一遍。改动前这里是
    // `if (inFlight.size > 0) return`，等于渲染期间不发心跳。
    let tasks: LocalImageTask[] = [];
    try {
      const resp = await deps.listTasks();
      tasks = Array.isArray(resp?.tasks) ? resp.tasks : [];
    } catch {
      return; // 后端不可达/未登录：静默等下一轮
    }
    deps.onPolled?.(tasks);
    if (inFlight.size > 0) return; // 手里还有活：这一轮只当心跳，不接新活
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
    // [§9 R3] **行为改动**：改动前这里是 `visibilityState !== 'visible' → return`，
    // 即页面一进后台就完全不拉（手机遥控、电脑出图的主场景直接失效）。
    // 现在改为隐藏也拉，如实接受浏览器的后台节流——Chrome 对隐藏页 timer 有钳制
    // （最坏分钟级；持有活跃 WebSocket 的页面豁免强化节流），实测项见 SPEC §7。
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
