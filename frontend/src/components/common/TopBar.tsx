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
        // 顶部有色（不透明）→ 底部（靠近内容）完全透明
        backgroundImage: `linear-gradient(to top, rgba(${gradientBase}, 0) 0%, rgba(${gradientBase}, 0.85) 100%)`,
        backdropFilter: 'blur(22px) saturate(180%)',
        WebkitBackdropFilter: 'blur(22px) saturate(180%)',
        // 底部（靠近内容）完全透明（无模糊） → 顶部模糊最强
        WebkitMaskImage: 'linear-gradient(to top, transparent 0%, black 100%)',
        maskImage: 'linear-gradient(to top, transparent 0%, black 100%)',
        opacity: 1,
        boxShadow: 'none',
      }}
    />
  );
};

export default TopBar;