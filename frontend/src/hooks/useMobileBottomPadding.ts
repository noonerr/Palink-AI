import { useState, useEffect } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';

export const useMobileBottomPadding = () => {
  const [paddingClass, setPaddingClass] = useState<string>('pb-0');
  const isMobile = useIsMobile();

  useEffect(() => {
    let rafId: number | null = null;

    const getPaddingClass = (totalPadding: number) => {
      if (totalPadding <= 80) return 'pb-20';
      if (totalPadding <= 112) return 'pb-28';
      if (totalPadding <= 144) return 'pb-36';
      return 'pb-44';
    };

    const updatePadding = () => {
      if (!isMobile) {
        setPaddingClass('pb-0');
        return;
      }

      const bottomNav = document.querySelector('nav[data-dock="true"]');
      if (bottomNav) {
        const navHeight = bottomNav.getBoundingClientRect().height;
        const totalPadding = navHeight + 32;
        const nextClass = getPaddingClass(totalPadding);
        setPaddingClass((prev) => (prev === nextClass ? prev : nextClass));
      } else {
        setPaddingClass((prev) => (prev === 'pb-28' ? prev : 'pb-28'));
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
  }, [isMobile]);

  return paddingClass;
};
