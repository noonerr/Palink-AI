import { useCallback, useSyncExternalStore } from 'react';
import { ttsService, type TtsMessageStatus } from '@/services/tts';

/**
 * [TTS-P3] 读某条消息当前的语音播放状态（idle / loading / playing / paused）。
 *
 * 为什么走订阅而不是 prop：
 * - 播放状态是「全局唯一」的（同一时刻只播一条），用 prop 下发就得让上层
 *   持有 state、再广播给每条消息，等于把 Message 好不容易稳住的 memo 优化
 *   重新打散（见 P0/P1-A 的 442 → 26 次 render 修复）；
 * - 组件内部订阅时，React 只在快照值真的变了的那两条消息上重渲染，
 *   memo 比较器完全不受影响（新增 prop 才需要它参与比较）。
 *
 * getSnapshot 返回字符串（基本类型），React 用 Object.is 判等，语义正确。
 */
export function useTtsMessageStatus(
  messageId: string | number | null | undefined,
): TtsMessageStatus {
  const key = messageId === null || messageId === undefined ? null : String(messageId);

  const subscribe = useCallback((onStoreChange: () => void) => ttsService.subscribe(onStoreChange), []);
  const getSnapshot = useCallback(
    (): TtsMessageStatus => (key === null ? 'idle' : ttsService.getStatus(key)),
    [key],
  );
  const getServerSnapshot = useCallback((): TtsMessageStatus => 'idle', []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
