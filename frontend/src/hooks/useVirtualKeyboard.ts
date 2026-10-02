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

  // ── 键盘真实弹起时在 <html> 挂 palink-dock-kb-hide 类：全局隐藏底部 dock 栏。
  // 【2026-09-05 修正】K13 曾把 dock 隐藏交给 index.css 的 :has(:focus) 纯 CSS——
  // 但「键盘已收起、焦点仍在输入框」（Android 返回键收键盘 / iOS 收起键）时
  // :focus 仍匹配 → 没有键盘 dock 却消失（用户实测报障）。改为由本 hook 的
  // 检测链（聚焦 + 视口实测收缩 >60px）驱动专用类，桌面无收缩永不隐藏。
  // 类名刻意不用 palink-kb-open——那是 K9/K12 旧键盘布局的开关，其休眠规则
  // （composer 抬升/rp-chat-area 封顶）依赖已停写的 --palink-kb-vh，不能激活。
  // 诊断标记仍保留：⌨ = 键盘检测链判定为开（与布局无关，仅供真机读数）
  useEffect(() => {
    const root = document.documentElement;
    const KbTitleMark = '⌨K17';
    const DockHideClass = 'palink-dock-kb-hide';
    const cleanTitle = (t: string) => t.replace(new RegExp(`^\\s*${KbTitleMark}\\s*`), '');
    root.classList.toggle(DockHideClass, isKeyboardOpen);
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

  // ── 【K21f 2026-10-01 已整体移除】手势级滚动阻断（document 非 passive touchmove）──
  // 它防的老问题「把页面拖到 shell 之下的空白背景」已随 K21e 几何修复物理消失
  // （webview=状态栏↔Home Indicator 之间、docHeight==clientHeight，文档无可滚余量），
  // 且 html/body 的 overscroll-behavior:none 与各容器 contain 已原生断链。
  // 非 passive document 监听的代价是 iOS 放弃合成器直接滚动（每帧回主线程），
  // 全 App 滚动发肉——两害相权删除。若旧场景在某种键盘补偿下复发，回滚参考
  // git 历史（touchstart 祖先链 getComputedStyle + touchmove 方向判断 preventDefault）。

  return { keyboardHeight, isKeyboardOpen };
};