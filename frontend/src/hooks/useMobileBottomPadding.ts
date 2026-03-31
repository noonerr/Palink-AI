import { useState, useEffect } from 'react';

export const useMobileBottomPadding = () => {
  const [paddingClass, setPaddingClass] = useState<string>('pb-32 sm:pb-0');

  useEffect(() => {
    let rafId: number | null = null;

    const getPaddingClass = (totalPadding: number) => {
      if (totalPadding <= 80) return 'pb-20 sm:pb-0';
      if (totalPadding <= 112) return 'pb-28 sm:pb-0';
      if (totalPadding <= 144) return 'pb-36 sm:pb-0';
      return 'pb-32 sm:pb-0';
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
        const totalPadding = navHeight + 32;
        const nextClass = getPaddingClass(totalPadding);
        setPaddingClass((prev) => (prev === nextClass ? prev : nextClass));
      } else {
        setPaddingClass((prev) => (prev === 'pb-32 sm:pb-0' ? prev : 'pb-32 sm:pb-0'));
      }
    };

    const scheduleUpdate = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(updatePadding);
    };

    const timeoutId = setTimeout(scheduleUpdate, 100);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);
    window.addEventListener('load', scheduleUpdate);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
      window.removeEventListener('load', scheduleUpdate);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return paddingClass;
};
