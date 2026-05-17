import React from 'react';
import {
  MessageSquare,
  FolderOpen,
  Settings,
  Sun,
  Moon,
  LogOut,
  Bot
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Link, useLocation } from 'react-router-dom';
import type { User } from '@/types';
import { useIsMobile } from '@/hooks/use-mobile';

interface SidebarProps {
  user?: User | null;
  isDark?: boolean;
  onThemeToggle?: () => void;
  lang?: string;
  onLangToggle?: () => void;
  onLogout?: () => void;
  t: Record<string, string>;
  sidebarCollapsed?: boolean;
  isKeyboardOpen?: boolean;
}

interface NavItemProps {
  icon: React.ElementType;
  to: string;
  tooltip: string;
  label?: string;
  isMobile?: boolean;
}

function NavItem({ icon: Icon, to, tooltip, label, isMobile }: NavItemProps) {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      className={cn(
        'sidebar-item rounded-xl flex items-center justify-center transition-all duration-200',
        'hover:bg-sidebar-accent',
        isMobile
          ? 'flex-col gap-1 py-2 px-3 flex-1 min-w-0'
          : 'w-12 h-12',
        isActive
          ? 'active bg-sidebar-primary text-sidebar-primary-foreground shadow-lg shadow-sidebar-primary/25'
          : 'text-sidebar-foreground hover:text-sidebar-foreground'
      )}
      title={tooltip}
    >
      <Icon size={isMobile ? 20 : 22} strokeWidth={isActive ? 2.5 : 2} />
      {isMobile && label && (
        <span className="text-[12px] font-medium truncate max-w-full">{label}</span>
      )}
    </Link>
  );
};

// Desktop Sidebar Component
export function DesktopSidebar({
  user,
  isDark,
  onThemeToggle,
  lang,
  onLangToggle,
  onLogout,
  t,
}: SidebarProps) {
  return (
    <aside className="w-[64px] h-full flex flex-col items-center pt-[max(1rem,env(safe-area-inset-top))] pb-5 bg-sidebar text-sidebar-foreground border-r border-sidebar-border/40">
      {/* Logo */}
      <div className="mb-8">
        <div className="w-10 h-10 bg-sidebar-primary rounded-xl flex items-center justify-center shadow-md shadow-sidebar-primary/20">
          <span className="text-sidebar-primary-foreground font-bold text-lg">P</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-2 w-full px-2 items-center">
        <NavItem
          icon={MessageSquare}
          to="/chat"
          tooltip={t.nav_chat || 'Chat'}
        />
        <NavItem
          icon={FolderOpen}
          to="/workspace"
          tooltip={t.nav_files || 'Workspace'}
        />
        <NavItem
          icon={Bot}
          to="/characters"
          tooltip={t.nav_characters || 'Roleplay'}
        />
      </nav>

      {/* Bottom Actions */}
      <div className="flex flex-col gap-3 items-center">
        <NavItem
          icon={Settings}
          to="/settings"
          tooltip={t.nav_config || 'Settings'}
        />

        <div className="w-8 h-px bg-sidebar-border my-1" />

        <button
          onClick={onThemeToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-sidebar-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all"
          title={isDark ? 'Light Mode' : 'Dark Mode'}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button
          onClick={onLangToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold text-sidebar-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all"
          title={t.lang_switch || 'Switch Language'}
        >
          {(lang || 'zh').toUpperCase()}
        </button>

        <button
          onClick={onLogout}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-sidebar-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
          title={t.logout || 'Logout'}
        >
          <LogOut size={18} />
        </button>

        <div className="mt-2">
          <Avatar className="w-9 h-9 ring-2 ring-transparent hover:ring-primary/50 transition-all cursor-pointer">
            <AvatarImage src={user?.avatar} />
            <AvatarFallback className="bg-secondary text-sm font-medium">
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </AvatarFallback>
          </Avatar>
        </div>
      </div>
    </aside>
  );
};

// Mobile Bottom Navigation Component
export function MobileBottomNav({
  t,
  isDark = false,
  sidebarCollapsed = true,
  isKeyboardOpen = false
}: SidebarProps) {
  const location = useLocation();
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Record<string, HTMLAnchorElement | null>>({});
  const [slider, setSlider] = React.useState<{ left: number; width: number; ready: boolean }>({ left: 0, width: 0, ready: false });
  const tabs = React.useMemo(() => [
    { id: '/chat', icon: MessageSquare, label: t.nav_chat || 'Chat' },
    { id: '/workspace', icon: FolderOpen, label: t.nav_files || 'Workspace' },
    { id: '/characters', icon: Bot, label: t.nav_characters || 'Roleplay' },
    { id: '/settings', icon: Settings, label: t.nav_config || 'Settings' }
  ], [t.nav_chat, t.nav_files, t.nav_characters, t.nav_config]);

  const getActiveId = React.useCallback(() => {
    const exact = tabs.find((tab) => location.pathname === tab.id);
    if (exact) return exact.id;
    const nested = tabs.find((tab) => location.pathname.startsWith(`${tab.id}/`));
    return nested?.id || '/chat';
  }, [location.pathname, tabs]);

  const updateSlider = React.useCallback((targetId?: string) => {
    const dock = dockRef.current;
    if (!dock) return;

    const activeId = targetId || getActiveId();
    const target = itemRefs.current[activeId];
    if (!target) return;

    const dockRect = dock.getBoundingClientRect();
    const itemRect = target.getBoundingClientRect();
    const pad = 4;

    const nextLeft = itemRect.left - dockRect.left + pad;
    const nextWidth = Math.max(itemRect.width - pad * 2, 0);

    setSlider((prev) => {
      if (prev.ready && Math.abs(prev.left - nextLeft) < 0.5 && Math.abs(prev.width - nextWidth) < 0.5) {
        return prev;
      }
      return {
        left: nextLeft,
        width: nextWidth,
        ready: true,
      };
    });
  }, [getActiveId]);

  React.useEffect(() => {
    updateSlider();
  }, [updateSlider, location.pathname]);

  React.useEffect(() => {
    const onResize = () => updateSlider();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateSlider]);

  return (
    <nav className={cn(
      'fixed bottom-0 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center pointer-events-auto transition-all duration-300 ease-in-out w-[92%] max-w-[560px]',
      !sidebarCollapsed && 'translate-x-[calc(-50%+280px)]',
      isKeyboardOpen && 'translate-y-full opacity-0 pointer-events-none'
    )} data-dock="true">
      <div
        ref={dockRef}
        className={cn(
          'relative flex h-[70px] w-[92%] max-w-[560px] select-none items-center justify-around rounded-[35px] border backdrop-blur-[30px] shadow-[0_10px_28px_rgba(120,106,79,0.14)]',
          isDark 
            ? 'border-slate-600/80 bg-[#2d3350]' 
            : 'border-[#ddd4c5] bg-[#FFFAFA]'
        )}
        data-dock="true"
      >
        <div
          className={cn(
            'absolute top-1/2 z-[1] h-[52px] -translate-y-1/2 rounded-[26px] transition-[left,width] duration-300 ease-[cubic-bezier(0.22,0.65,0.22,1)]',
            !slider.ready && 'opacity-0',
            isDark ? 'bg-white/[0.15]' : 'bg-[#ece2d3]/50'
          )}
          style={{ left: slider.left, width: slider.width }}
        />
        {tabs.map((item) => {
          const IconComponent = item.icon;
          const isActive = getActiveId() === item.id;
          return (
            <Link
              key={item.id}
              to={item.id}
              replace
              ref={(el) => {
                itemRefs.current[item.id] = el;
              }}
              className={cn(
                'relative z-[2] flex h-full w-[22%] flex-col items-center justify-center gap-1 text-center transition-all duration-300 active:scale-[0.98]',
                isDark
                  ? (isActive ? 'text-white' : 'text-white/65')
                  : (isActive ? 'text-slate-900' : 'text-slate-700/85')
              )}
              data-dock="true"
            >
              <IconComponent size={22} strokeWidth={isActive ? 2.5 : 2} />
              <span className={cn('text-[10px] leading-none', isActive ? 'font-semibold' : 'font-medium')}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
      <p className={cn(
        'text-center text-[10px] pb-[calc(8px+min(env(safe-area-inset-bottom),8px))]',
        isDark ? 'text-white/40' : 'text-slate-400/60'
      )}>
        {t.ai_disclaimer}
      </p>
    </nav>
  );
};

// Main Sidebar Component (exports both)
export function Sidebar(props: SidebarProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileBottomNav {...props} />;
  }

  return <DesktopSidebar {...props} />;
};
