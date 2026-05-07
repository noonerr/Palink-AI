import { useState, useEffect } from 'react';

export const useMobileBottomPadding = () => {
  const [paddingClass, setPaddingClass] = useState<string>('pb-0');

  useEffect(() => {
    let rafId: number | null = null;

    const getPaddingClass = (totalPadding: number) => {
      if (totalPadding <= 200) return 'pb-48';
      if (totalPadding <= 250) return 'pb-56';
      if (totalPadding <= 300) return 'pb-64';
      return 'pb-72';
    };

    const updatePadding = () => {
      const isMobile = window.innerWidth < 768;
      if (!isMobile) {
        setPaddingClass('pb-0');
        return;
      }

      const bottomNav = document.querySelector('nav[data-dock="true"]');
      if (bottomNav) {
        const navHeight = bottomNav.getBoundingClientRect().height;
        const totalPadding = navHeight + 180;
        const nextClass = getPaddingClass(totalPadding);
        setPaddingClass((prev) => (prev === nextClass ? prev : nextClass));
      } else {
        setPaddingClass((prev) => (prev === 'pb-56' ? prev : 'pb-56'));
      }
    };

    const scheduleUpdate = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(updatePadding);
    };

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
