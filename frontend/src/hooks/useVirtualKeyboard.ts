import { useState, useEffect } from 'react';

export const useVirtualKeyboard = () => {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const isMobile = window.innerWidth < 768;
      if (!isMobile) {
        setKeyboardHeight(0);
        setIsKeyboardOpen(false);
        return;
      }
      const height = window.innerHeight - vv.height - vv.offsetTop;
      const open = height > 50;
      setKeyboardHeight(open ? height : 0);
      setIsKeyboardOpen(open);
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return { keyboardHeight, isKeyboardOpen };
};
