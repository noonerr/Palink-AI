import { useState, useEffect } from 'react';

export const useMobileBottomPadding = () => {
  const [paddingClass, setPaddingClass] = useState<string>('pb-56 sm:pb-0');

  useEffect(() => {
    let rafId: number | null = null;

    const getPaddingClass = (totalPadding: number) => {
      if (totalPadding <= 200) return 'pb-48 sm:pb-0';
      if (totalPadding <= 250) return 'pb-56 sm:pb-0';
      if (totalPadding <= 300) return 'pb-64 sm:pb-0';
      return 'pb-72 sm:pb-0';
    };

    const updatePadding = () => {
      const isMobile = window.innerWidth < 768;
      if (!isMobile) {
        setPaddingClass((prev) => (prev === 'sm:pb-0' ? prev : 'sm:pb-0'));
        return;
      }

      const bottomNav = document.querySelector('nav.fixed.bottom-0');
      if (bottomNav) {
        const navHeight = bottomNav.getBoundingClientRect().height;
        const totalPadding = navHeight + 180; // 输入框高度+80px间距
        const nextClass = getPaddingClass(totalPadding);
        setPaddingClass((prev) => (prev === nextClass ? prev : nextClass));
      } else {
        setPaddingClass((prev) => (prev === 'pb-56 sm:pb-0' ? prev : 'pb-56 sm:pb-0')); // 默认值增加以适配fixed输入框+80px间距
      }
    };

    const scheduleUpdate = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(updatePadding);
    };

    // 初始运行两次，确保DOM完全加载
    scheduleUpdate();
    setTimeout(scheduleUpdate, 100);
    setTimeout(scheduleUpdate, 500);
    
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return paddingClass;
};
