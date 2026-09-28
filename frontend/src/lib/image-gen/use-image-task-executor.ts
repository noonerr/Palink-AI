/**
 * 浏览器桥接执行器的 React 接线：在 App 根部挂一次。
 *
 * 桥接启用（出图开启 + 激活服务商为 browser 执行）时启动认领轮询；配置变更后
 * `invalidateImageGenerationConfig()` 会触发本 hook 重挂。未启用时零开销——
 * 不建定时器、不发请求。
 */
import { useEffect } from 'react';
import { api } from '@/services/api';
import { useImageGenerationAvailability } from '@/hooks/useImageGenerationAvailability';
import { startExecutorLoop } from './executor';

export function useImageTaskExecutor(): void {
  const availability = useImageGenerationAvailability();
  const bridgeEnabled = availability.enabled && availability.browserExecution;

  useEffect(() => {
    if (!bridgeEnabled) return;
    return startExecutorLoop({
      isEnabled: () => bridgeEnabled,
      listTasks: () => api.imageGeneration.listLocalTasks(),
      submitResult: (taskId, images) => api.imageGeneration.submitLocalTaskResult(taskId, images),
      submitFail: (taskId, error) => api.imageGeneration.submitLocalTaskFail(taskId, error),
    });
  }, [bridgeEnabled]);
}
