import React from 'react';

interface TopBarProps {
  height?: string;
  theme?: 'dark' | 'light';
}

function TopBar({
  height = 'calc(env(safe-area-inset-top) + 4.2rem)',
  theme = 'dark',
}: TopBarProps) {
  const isDark = theme === 'dark';
  const gradientBase = isDark ? '15, 23, 42' : '255, 250, 250';

  return (
    <div
      id="mobile-chat-top-bar"
      data-role="mobile-chat-top-bar"
      className="mobile-chat-top-bar absolute top-0 left-0 right-0 z-[18] pointer-events-none"
      aria-hidden="true"
      style={{
        height,
        backgroundImage: `linear-gradient(to bottom, rgba(${gradientBase}, 0.9) 0%, rgba(${gradientBase}, 0.45) 48%, rgba(${gradientBase}, 0) 100%)`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        opacity: 1,
        boxShadow: 'none',
      }}
    />
  );
};

export default TopBar;