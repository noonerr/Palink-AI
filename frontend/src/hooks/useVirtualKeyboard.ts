import { useState, useEffect, useRef, useCallback } from 'react';

export const useVirtualKeyboard = () => {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const baselineViewportHeightRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const orientationTimerRef = useRef<number | null>(null);
  const focusPollTimerRef = useRef<number | null>(null);

  const isEditableFocusedEl = useCallback((el: Element | null) => {
    if (!el || !(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }, []);

  const isEditableFocused = useCallback(() => {
    return isEditableFocusedEl(document.activeElement as Element | null);
  }, [isEditableFocusedEl]);

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

  // 哨兵实测：fixed bottom:0 的元素在 iOS 上锚定「键盘上沿」（已在用户设备
  // 验证——聊天输入框贴键盘正是这个机制）。用一个隐藏哨兵元素量出
  // 可视区真实可用高度，完全不依赖 visualViewport 事件/数值。
  const measureAvailableHeight = useCallback(() => {
    try {
      const s = document.createElement('div');
      s.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none;';
      document.body.appendChild(s);
      const top = s.getBoundingClientRect().top;
      s.remove();
      return top;
    } catch {
      return window.innerHeight;
    }
  }, []);

  const commitKeyboardState = useCallback(() => {
    const currentViewportHeight = getCurrentViewportHeight();
    const focused = isEditableFocused();
    const baseline = baselineViewportHeightRef.current || currentViewportHeight;
    const baselineDelta = Math.max(0, baseline - currentViewportHeight);
    const viewportDelta = getViewportDiffHeight();
    // 哨兵实测可用高度（iOS 键盘弹起时 fixed bottom:0 会顶到键盘上沿）
    const availableHeight = measureAvailableHeight();
    const sentinelDelta = Math.max(0, window.innerHeight - availableHeight);
    const nextHeight = Math.max(baselineDelta, viewportDelta, sentinelDelta);
    // 阈值 60px：避免 iOS 安全区差值（约 34px）误判
    const open = focused && nextHeight > 60;

    if (!open) {
      baselineViewportHeightRef.current = Math.max(baselineViewportHeightRef.current, currentViewportHeight);
    }

    setKeyboardHeight(open ? Math.round(nextHeight) : 0);
    setIsKeyboardOpen(open);
    return open;
  }, [getCurrentViewportHeight, getViewportDiffHeight, isEditableFocused, measureAvailableHeight]);

  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      commitKeyboardState();
    });
  }, [commitKeyboardState]);

  useEffect(() => {
    const vv = window.visualViewport;

    // 使用 visualViewport 高度作为基准，不混入 window.innerHeight
    // iOS WebApp 中 window.innerHeight 包含安全区域（状态栏+Home条），
    // 而 visualViewport 不包含，两者差值会导致误判键盘为打开状态
    baselineViewportHeightRef.current = getCurrentViewportHeight();

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

    // 聚焦期间持续轮询（300ms）：哨兵实测既能捕捉键盘「打开」（动画进行中
    // 高度渐变），也能捕捉「关闭」（下滑收起键盘但焦点保留的场景）。
    // 视觉视口事件在 iOS 上延迟/漏触发，轮询哨兵是最可靠的兜底。
    const handleFocusIn = () => {
      scheduleUpdate();
      if (focusPollTimerRef.current !== null) {
        window.clearTimeout(focusPollTimerRef.current);
      }
      const poll = () => {
        if (!isEditableFocused()) return; // 失焦即停
        commitKeyboardState();
        focusPollTimerRef.current = window.setTimeout(poll, 300);
      };
      focusPollTimerRef.current = window.setTimeout(poll, 300);
    };

    const handleFocusOut = () => {
      if (focusPollTimerRef.current !== null) {
        window.clearTimeout(focusPollTimerRef.current);
        focusPollTimerRef.current = null;
      }
      scheduleUpdate();
    };

    if (vv) {
      vv.addEventListener('resize', scheduleUpdate);
      vv.addEventListener('scroll', scheduleUpdate);
    }
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('focusout', handleFocusOut, true);
    scheduleUpdate();

    return () => {
      if (focusPollTimerRef.current !== null) {
        window.clearTimeout(focusPollTimerRef.current);
        focusPollTimerRef.current = null;
      }
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
      window.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('focusout', handleFocusOut, true);
    };
  }, [getCurrentViewportHeight, getViewportDiffHeight, isEditableFocused, isEditableFocusedEl, scheduleUpdate, commitKeyboardState]);

  // ── 键盘弹起时在 <html> 挂 palink-kb-open 类：全局隐藏底部 dock 栏、
  // 让各聊天输入框吸到键盘上沿（CSS 与聊天屏消费该状态）
  // 【K13 已停用】回到最原始基线：无类、无变量、无 JS 抬升/检测——聚焦态
  // 由 index.css 的 :has(:focus) 纯 CSS 处理（输入框落底 + dock 隐藏），
  // 其余交给系统原生行为。此 effect 保留空壳注释以防回滚时找不到锚点。
  useEffect(() => {
    const root = document.documentElement;
    const KbTitleMark = '⌨K15';
    const cleanTitle = (t: string) => t.replace(new RegExp(`^\\s*${KbTitleMark}\\s*`), '');
    // 诊断标记仍保留：⌨ = 键盘检测链判定为开（与布局无关，仅供真机读数）
    if (isKeyboardOpen) {
      if (!document.title.includes(KbTitleMark)) {
        document.title = `${KbTitleMark} ${cleanTitle(document.title)}`;
      }
    } else {
      if (document.title.includes(KbTitleMark)) {
        document.title = cleanTitle(document.title);
      }
    }
    void root;
  }, [isKeyboardOpen]);

  // ── 【K13 已整体移除】键盘几何 effect（t=0 落位/静止校正/记忆缓存）──
  // 用户拍板回到最原始基线：不做任何 JS 键盘布局，聚焦态交给
  // index.css 的 :has(:focus) 纯 CSS + 系统原生行为。回滚参考 git 历史。

  // ── 【K13 已移除】滚动压制（scrollTo(0,0)）──
  // 原始基线下要观察系统原生行为（包括它自己的滚动补偿），不做对抗。

  // ── 手势级滚动阻断（一步到位）────────────────────────────────
  // 【真机教训】"能往下滑到 shell 之下的空白背景"来自手指拖动文档。
  // 在 touchmove 上按方向判断：这条触摸链上没有任何能在当前方向滚动的
  // 容器时直接 preventDefault——文档纹丝不动，没有"滚了再拉回"的过程。
  // 只有消息列表这类真滚动区放行；到边界后继续拖也会被拦（无滚动链传导）。
  // 点击与水平手势（|dy|<4px）不干预，MobilePager 擦洗 / dock 拖动不受影响。
  useEffect(() => {
    let startY = 0;
    let chain: HTMLElement[] = [];
    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      chain = [];
      for (let el = e.target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
          chain.push(el);
        }
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dy) < 4) return; // 点击 / 水平擦洗，不干预
      for (const el of chain) {
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if ((dy > 0 && !atTop) || (dy < 0 && !atBottom)) return; // 有容器能消化该方向
      }
      e.preventDefault(); // 没有任何容器能滚 → 文档纹丝不动
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
    };
  }, []);

  return { keyboardHeight, isKeyboardOpen };
};