import React from 'react';
import { 
  MessageSquare, 
  FolderOpen, 
  Settings,
  Sun,
  Moon,
  LogOut,
  Bot,
  Monitor,
  Smartphone
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Link, useLocation } from 'react-router-dom';
import type { User } from '@/types';

interface SidebarProps {
  user?: User;
  isDark?: boolean;
  onThemeToggle?: () => void;
  lang?: string;
  onLangToggle?: () => void;
  onLogout?: () => void;
  t: Record<string, string>;
  switchDevice?: (newDevice: 'desktop' | 'mobile') => void;
  currentDevice?: 'desktop' | 'mobile';
}

interface NavItemProps {
  icon: React.ElementType;
  to: string;
  tooltip: string;
  label?: string;
  isMobile?: boolean;
}

const NavItem: React.FC<NavItemProps> = ({ icon: Icon, to, tooltip, label, isMobile }) => {
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

const getCurrentVariant = (): 'desktop' | 'mobile' => {
  const saved = localStorage.getItem('ui_mode');
  if (saved === 'desktop' || saved === 'mobile') {
    return saved as 'desktop' | 'mobile';
  }
  const userAgent = typeof window !== 'undefined' ? window.navigator.userAgent.toLowerCase() : '';
  const isMobileDevice = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
  return isMobileDevice ? 'mobile' : 'desktop';
};

const switchUiVariant = (target: 'desktop' | 'mobile') => {
  localStorage.setItem('ui_mode', target);
  window.location.reload();
};

// Desktop Sidebar Component
export const DesktopSidebar: React.FC<SidebarProps> = ({
  user,
  isDark,
  onThemeToggle,
  lang,
  onLangToggle,
  onLogout,
  t,
  switchDevice,
  currentDevice = 'desktop'
}) => {
  const nextVariant = currentDevice === 'desktop' ? 'mobile' : 'desktop';

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
          onClick={() => switchDevice && switchDevice(nextVariant)}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-sidebar-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all"
          title={nextVariant === 'mobile' ? 'Switch to Mobile UI' : 'Switch to Desktop UI'}
        >
          {nextVariant === 'mobile' ? <Smartphone size={18} /> : <Monitor size={18} />}
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
export const MobileBottomNav: React.FC<SidebarProps> = ({
  t,
  switchDevice,
  currentDevice = 'mobile'
}) => {
  const location = useLocation();
  const nextVariant = currentDevice === 'desktop' ? 'mobile' : 'desktop';
  const tabs = [
    { id: '/chat', icon: MessageSquare, label: t.nav_chat || 'Chat' },
    { id: '/workspace', icon: FolderOpen, label: t.nav_files || 'Workspace' },
    { id: '/characters', icon: Bot, label: t.nav_characters || 'Roleplay' },
    { id: '/settings', icon: Settings, label: t.nav_config || 'Settings' }
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 mx-2 mb-1 h-[64px] bg-white/70 dark:bg-slate-900/60 backdrop-blur-2xl rounded-[24px] border border-white/50 dark:border-slate-700/40 shadow-xl flex items-center justify-around pb-safe z-50 pointer-events-auto">
      {tabs.map((item) => {
        const IconComponent = item.icon;
        const isActive = location.pathname === item.id;
        return (
          <Link
            key={item.id}
            to={item.id}
            className={`relative flex flex-col items-center justify-center space-y-0.5 w-1/4 h-full transition-all duration-300 active:scale-[0.98] ${
              isActive ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <div className={`absolute inset-1 rounded-2xl transition-all duration-300 ${
              isActive ? 'bg-white/40 dark:bg-white/10' : ''
            }`} />
            <div className={`relative z-10 transition-all duration-300 ${isActive ? 'scale-110' : ''}`}>
              <IconComponent size={isActive ? 22 : 20} strokeWidth={isActive ? 2.5 : 2} />
            </div>
            <span className={`relative z-10 text-[12px] font-medium ${isActive ? 'font-semibold' : ''}`}>{item.label}</span>
          </Link>
        );
      })}
      {/* <button
        onClick={() => switchDevice && switchDevice(nextVariant)}
        className="absolute -top-12 right-4 w-10 h-10 rounded-full bg-white/70 dark:bg-slate-900/60 backdrop-blur-2xl border border-white/50 dark:border-slate-700/40 shadow-lg flex items-center justify-center text-sidebar-foreground hover:bg-sidebar-accent transition-all z-50"
        title={nextVariant === 'mobile' ? 'Switch to Mobile UI' : 'Switch to Desktop UI'}
      >
        {nextVariant === 'mobile' ? <Smartphone size={18} /> : <Monitor size={18} />}
      </button> */}
    </nav>
  );
};

// Main Sidebar Component (exports both)
export const Sidebar: React.FC<SidebarProps> = (props) => {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (isMobile) {
    return <MobileBottomNav {...props} />;
  }

  return <DesktopSidebar {...props} />;
};
