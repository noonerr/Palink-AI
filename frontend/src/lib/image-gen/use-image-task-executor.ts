/**
 * 浏览器桥接执行器的 React 接线：在 App 根部挂一次。
 *
 * 桥接启用（出图开启 + 激活服务商为 browser 执行）**且本设备角色是算力方**时
 * 才启动认领轮询；遥控器设备（手机）零轮询——它靠既有 SSE/WS 事件看结果。
 * 角色变更（设置页）时重挂；未启用时零开销：不建定时器、不发请求。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services/api';
import { useImageGenerationAvailability } from '@/hooks/useImageGenerationAvailability';
import { startExecutorLoop } from './executor';
import {
  COMPUTE_ROLE_EVENT,
  getComputeRole,
  getDeviceId,
  resolveCapability,
  type ComputeRole,
} from './device';

export function useImageTaskExecutor(): void {
  const availability = useImageGenerationAvailability();
  const bridgeEnabled = availability.enabled && availability.browserExecution;
  const [roleVersion, setRoleVersion] = useState(0);
  const role = useMemo(() => getComputeRole(), [roleVersion]);
  const isProvider = resolveCapability(role) === 'provider';
  const active = bridgeEnabled && isProvider;

  // 设置页改角色后重挂：storage 事件只跨标签页，同页走自定义事件广播。
  useEffect(() => {
    const onChange = () => setRoleVersion((value) => value + 1);
    window.addEventListener(COMPUTE_ROLE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(COMPUTE_ROLE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  useEffect(() => {
    if (!active) return; // 遥控器设备：零轮询
    const deviceId = getDeviceId();
    const capability = resolveCapability(role);
    return startExecutorLoop({
      isEnabled: () => active,
      // 带上设备身份：后端据此区分"同一台设备来续期"与"另一台设备来抢活"。
      listTasks: () => api.imageGeneration.listLocalTasks({ device_id: deviceId, capability }),
      submitResult: (taskId, images) => api.imageGeneration.submitLocalTaskResult(taskId, images),
      submitFail: (taskId, error) => api.imageGeneration.submitLocalTaskFail(taskId, error),
    });
  }, [active, role]);
}

export type { ComputeRole };
