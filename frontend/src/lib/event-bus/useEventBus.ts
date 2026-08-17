/**
 * 事件总线 React Hook
 */

import { useEffect, useRef, useCallback } from 'react';
import { eventBus, type EventName, type EventListener, type EventPayload } from './index';

/**
 * 使用事件总线的React Hook
 * 
 * 自动处理订阅和取消订阅，组件卸载时自动清理
 */
export function useEventBus() {
  return eventBus;
}

/**
 * 订阅事件的Hook
 * 
 * @param event 事件名称
 * @param listener 监听器函数
 * @param deps 依赖数组（listener变化时重新订阅）
 */
export function useEventListener<K extends EventName>(
  event: K,
  listener: EventListener<K>,
  deps: any[] = []
): void {
  const listenerRef = useRef(listener);
  
  // 更新listener引用
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);

  useEffect(() => {
    const wrappedListener = (payload: EventPayload<K>) => {
      listenerRef.current(payload);
    };
    
    const unsubscribe = eventBus.on(event, wrappedListener);
    return unsubscribe;
  }, [event, ...deps]);
}

/**
 * 触发事件的Hook（返回稳定的回调引用）
 */
export function useEmitEvent<K extends EventName>(event: K) {
  return useCallback((payload: EventPayload<K>) => {
    eventBus.emit(event, payload);
  }, [event]);
}

/**
 * 一次性订阅事件的Hook
 */
export function useOnceEventListener<K extends EventName>(
  event: K,
  listener: EventListener<K>,
  deps: any[] = []
): void {
  const listenerRef = useRef(listener);
  
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);

  useEffect(() => {
    const wrappedListener = (payload: EventPayload<K>) => {
      listenerRef.current(payload);
    };
    
    const unsubscribe = eventBus.once(event, wrappedListener);
    return unsubscribe;
  }, [event, ...deps]);
}

export default useEventBus;
