import { useState, useEffect } from 'react';

export const useMobileBottomPadding = () => {
  const [paddingClass, setPaddingClass] = useState<string>('pb-32 sm:pb-0');

  useEffect(() => {
    const updatePadding = () => {
      const isMobile = window.innerWidth < 768;
      if (!isMobile) {
        setPaddingClass('sm:pb-0');
        return;
      }

      const bottomNav = document.querySelector('nav.fixed.bottom-0');
      if (bottomNav) {
        const navHeight = bottomNav.getBoundingClientRect().height;
        const totalPadding = navHeight + 32;
        
        if (totalPadding <= 80) {
          setPaddingClass('pb-20 sm:pb-0');
        } else if (totalPadding <= 112) {
          setPaddingClass('pb-28 sm:pb-0');
        } else if (totalPadding <= 144) {
          setPaddingClass('pb-36 sm:pb-0');
        } else {
          setPaddingClass('pb-32 sm:pb-0');
        }
      } else {
        setPaddingClass('pb-32 sm:pb-0');
      }
    };

    const timeoutId = setTimeout(updatePadding, 100);
    window.addEventListener('resize', updatePadding);
    
    const observer = new MutationObserver(() => {
      setTimeout(updatePadding, 100);
    });
    
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', updatePadding);
      observer.disconnect();
    };
  }, []);

  return paddingClass;
};
