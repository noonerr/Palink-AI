import React from 'react';
import { Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

export function WidescreenPrompt() {
  const isMobile = useIsMobile();
  const [isDark, setIsDark] = React.useState(document.documentElement.classList.contains('dark'));
  const [isTouchDevice, setIsTouchDevice] = React.useState(false);

  React.useEffect(() => {
    const checkTouch = () => {
      setIsTouchDevice(window.matchMedia('(pointer: coarse)').matches);
    };
    checkTouch();
    const mediaQuery = window.matchMedia('(pointer: coarse)');
    mediaQuery.addEventListener('change', checkTouch);
    return () => mediaQuery.removeEventListener('change', checkTouch);
  }, []);

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  if (isMobile || !isTouchDevice) return null;

  const lang = localStorage.getItem('lang') || 'zh';

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] flex items-center justify-center',
        'animate-[fadeIn_0.5s_ease-out]',
        isDark
          ? 'bg-black/80 backdrop-blur-xl'
          : 'bg-white/80 backdrop-blur-xl'
      )}
    >
      <div
        className={cn(
          'flex flex-col items-center gap-6 p-10 rounded-3xl max-w-md mx-4',
          isDark
            ? 'bg-white/5 border border-white/10 shadow-2xl shadow-black/50'
            : 'bg-white/60 border border-white/40 shadow-2xl shadow-black/10'
        )}
      >
        <div
          className={cn(
            'w-20 h-20 rounded-2xl flex items-center justify-center',
            isDark
              ? 'bg-gradient-to-br from-cyan-500/20 to-blue-500/20'
              : 'bg-gradient-to-br from-cyan-100 to-blue-100'
          )}
        >
          <Monitor
            size={40}
            className={cn(
              isDark ? 'text-cyan-400' : 'text-cyan-600'
            )}
            strokeWidth={1.5}
          />
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h2
            className={cn(
              'text-2xl font-semibold',
              isDark ? 'text-white' : 'text-gray-900'
            )}
          >
            {lang === 'zh' ? '请使用电脑端访问' : 'Please use desktop'}
          </h2>
          <p
            className={cn(
              'text-sm leading-relaxed',
              isDark ? 'text-white/60' : 'text-gray-500'
            )}
          >
            {lang === 'zh'
              ? '为获得最佳体验，请在电脑浏览器中打开本应用'
              : 'For the best experience, please open this app in a desktop browser'}
          </p>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
};
