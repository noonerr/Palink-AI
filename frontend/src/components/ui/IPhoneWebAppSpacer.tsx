import { useState, useEffect } from 'react';

export function isIPhoneWebAppMode(): boolean {
  if (typeof window === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && 
    (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
}

export function IPhoneWebAppSpacer({ height = '50px' }: { height?: string }) {
  const [bgColor, setBgColor] = useState(() => {
    if (typeof window === 'undefined') return '#ffffff';
    const isDark = document.documentElement.classList.contains('dark');
    return isDark ? '#000000' : '#ffffff';
  });
  
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains('dark');
      setBgColor(isDark ? '#000000' : '#ffffff');
    });
    
    observer.observe(document.documentElement, { 
      attributes: true, 
      attributeFilter: ['class'] 
    });
    
    return () => observer.disconnect();
  }, []);
  
  if (typeof window === 'undefined') return null;
  
  const isIPhoneWebApp = isIPhoneWebAppMode();
  
  if (!isIPhoneWebApp) return null;
  
  return <div style={{ height, flexShrink: 0, backgroundColor: bgColor, borderBottom: 'none' }} />;
}
