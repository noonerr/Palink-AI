import { useState, useEffect, useRef, useCallback } from 'react';

export const useVirtualKeyboard = () => {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const baselineViewportHeightRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const orientationTimerRef = useRef<number | null>(null);

  const isEditableFocused = useCallback(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }, []);

  const getCurrentViewportHeight = useCallback(() => {
    const vv = window.visualViewport;
    if (!vv) return window.innerHeight;
    return vv.height + vv.offsetTop;
  }, []);

  const getViewportDiffHeight = useCallback(() => {
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;

    // 使用 visualViewport 高度作为基准，不混入 window.innerHeight
    // iOS WebApp 中 window.innerHeight 包含安全区域（状态栏+Home条），
    // 而 visualViewport 不包含，两者差值会导致误判键盘为打开状态
    baselineViewportHeightRef.current = getCurrentViewportHeight();

    const commitKeyboardState = () => {
      const currentViewportHeight = getCurrentViewportHeight();
      const focused = isEditableFocused();
      const baseline = baselineViewportHeightRef.current || currentViewportHeight;
      const baselineDelta = Math.max(0, baseline - currentViewportHeight);
      const viewportDelta = getViewportDiffHeight();
      const nextHeight = Math.max(baselineDelta, viewportDelta);
      // 阈值提高到 50px，避免 iOS 安全区差值（约 34px）导致误判
      const open = focused && nextHeight > 50;

      if (!open) {
        baselineViewportHeightRef.current = Math.max(baselineViewportHeightRef.current, currentViewportHeight);
      }

      setKeyboardHeight(open ? Math.round(nextHeight) : 0);
      setIsKeyboardOpen(open);
    };

    const scheduleUpdate = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        commitKeyboardState();
      });
    };

    const handleOrientationChange = () => {
      if (orientationTimerRef.current !== null) {
        window.clearTimeout(orientationTimerRef.current);
      }
      baselineViewportHeightRef.current = getCurrentViewportHeight();
      scheduleUpdate();
      orientationTimerRef.current = window.setTimeout(() => {
        orientationTimerRef.current = null;
        baselineViewportHeightRef.current = getCurrentViewportHeight();
        scheduleUpdate();
      }, 240);
    };

    if (vv) {
      vv.addEventListener('resize', scheduleUpdate);
      vv.addEventListener('scroll', scheduleUpdate);
    }
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('focusin', scheduleUpdate, true);
    window.addEventListener('focusout', scheduleUpdate, true);
    scheduleUpdate();

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (orientationTimerRef.current !== null) {
        window.clearTimeout(orientationTimerRef.current);
        orientationTimerRef.current = null;
      }
      if (vv) {
        vv.removeEventListener('resize', scheduleUpdate);
        vv.removeEventListener('scroll', scheduleUpdate);
      }
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('focusin', scheduleUpdate, true);
      window.removeEventListener('focusout', scheduleUpdate, true);
    };
  }, [getCurrentViewportHeight, getViewportDiffHeight, isEditableFocused]);

  return { keyboardHeight, isKeyboardOpen };
};
