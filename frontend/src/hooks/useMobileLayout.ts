/**
 * useMobileLayout — 移动端布局计算 Hook
 * 从 CharacterChat 提取的移动端底部导航栏高度计算逻辑
 */
import { useState, useEffect } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';

export function useMobileLayout() {
  const isMobile = useIsMobile();
  const [composerBottomPx, setComposerBottomPx] = useState(0);

  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const measureNav = () => {
      if (!isMobile) {
        setComposerBottomPx(0);
        return;
      }
      // 优先读取 MobileBottomNav 写入的 CSS 变量，实现输入框与 dock 栏精确贴合
      const cssDockHeight = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--palink-dock-height') || '0',
        10,
      );
      if (cssDockHeight > 0) {
        setComposerBottomPx(cssDockHeight);
      } else {
        // 兜底：测量 dock 栏的可见面板（内部圆角条）
        const dockSurface = document.querySelector('nav[data-dock="true"] > div[data-dock="true"]') as HTMLElement | null;
        const dockTarget = dockSurface ?? document.querySelector('nav[data-dock="true"]');
        if (dockTarget) {
          const rect = dockTarget.getBoundingClientRect();
          const offsetFromBottom = Math.ceil(window.innerHeight - rect.top);
          setComposerBottomPx(offsetFromBottom > 0 ? offsetFromBottom : (isIOS ? 78 : 90));
        } else {
          setComposerBottomPx(isIOS ? 78 : 90);
        }
      }
    };
    measureNav();

    // 延迟重新测量，确保 dock 栏已完全渲染布局（iOS WebApp 尤其需要）
    const delayIds = [80, 180, 320, 480].map((d) => window.setTimeout(measureNav, d));

    const resizeHandler = () => measureNav();
    window.addEventListener('resize', resizeHandler);
    window.addEventListener('orientationchange', resizeHandler);

    // ResizeObserver: 监听 dock 栏尺寸变化（如字体加载、内容异步渲染）
    const resizeObserver = new ResizeObserver(() => measureNav());

    const navObserver = new MutationObserver(() => {
      setTimeout(measureNav, 100);
      setTimeout(measureNav, 500);
    });

    // 使用 MutationObserver 监听 dock 栏自身及子树变化
    const navEl = document.querySelector('nav[data-dock="true"]');
    const dockSurfaceEl = document.querySelector('nav[data-dock="true"] > div[data-dock="true"]');
    if (dockSurfaceEl) {
      navObserver.observe(dockSurfaceEl, { attributes: true, attributeFilter: ['class', 'style'] });
      resizeObserver.observe(dockSurfaceEl);
    }
    if (navEl) {
      navObserver.observe(navEl, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true });
      resizeObserver.observe(navEl);
    }

    return () => {
      window.removeEventListener('resize', resizeHandler);
      window.removeEventListener('orientationchange', resizeHandler);
      navObserver.disconnect();
      resizeObserver.disconnect();
      delayIds.forEach((id) => window.clearTimeout(id));
    };
  }, [isMobile]);

  return {
    isMobile,
    composerBottomPx,
  };
}

export default useMobileLayout;
