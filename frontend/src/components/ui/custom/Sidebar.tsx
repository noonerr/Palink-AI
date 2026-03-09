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

interface SidebarProps {
  user?: User;
  isDark?: boolean;
  onThemeToggle?: () => void;
  lang?: string;
  onLangToggle?: () => void;
  onLogout?: () => void;
  t: Record<string, string>;
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
        'hover:bg-primary/10',
        isMobile 
          ? 'flex-col gap-1 py-2 px-3 flex-1 min-w-0'
          : 'w-12 h-12',
        isActive 
          ? 'active bg-primary text-primary-foreground shadow-lg shadow-primary/25' 
          : 'text-muted-foreground hover:text-foreground'
      )}
      title={tooltip}
    >
      <Icon size={isMobile ? 20 : 22} strokeWidth={isActive ? 2.5 : 2} />
      {isMobile && label && (
        <span className="text-[10px] font-medium truncate max-w-full">{label}</span>
      )}
    </Link>
  );
};

// Desktop Sidebar Component
export const DesktopSidebar: React.FC<SidebarProps> = ({
  user,
  isDark,
  onThemeToggle,
  lang,
  onLangToggle,
  onLogout,
  t
}) => {
  return (
    <aside className="w-[72px] h-full flex flex-col items-center py-5">
      {/* Logo */}
      <div className="mb-8">
        <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center shadow-md shadow-primary/20">
          <span className="text-primary-foreground font-bold text-lg">P</span>
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
        
        <div className="w-8 h-px bg-border my-1" />
        
        <button
          onClick={onThemeToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-primary/10 transition-all"
          title={isDark ? 'Light Mode' : 'Dark Mode'}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        
        <button
          onClick={onLangToggle}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-primary/10 transition-all"
          title={t.lang_switch || 'Switch Language'}
        >
          {(lang || 'zh').toUpperCase()}
        </button>
        
        <button
          onClick={onLogout}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
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
  t
}) => {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 glass-strong flex items-center justify-around px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <NavItem
        icon={MessageSquare}
        to="/chat"
        tooltip={t.nav_chat || 'Chat'}
        label={t.nav_chat || 'Chat'}
        isMobile
      />
      <NavItem
        icon={FolderOpen}
        to="/workspace"
        tooltip={t.nav_files || 'Workspace'}
        label={t.nav_files || 'Workspace'}
        isMobile
      />
      <NavItem
        icon={Bot}
        to="/characters"
        tooltip={t.nav_characters || 'Roleplay'}
        label={t.nav_characters || 'Roleplay'}
        isMobile
      />
      <NavItem
        icon={Settings}
        to="/settings"
        tooltip={t.nav_config || 'Settings'}
        label={t.nav_config || 'Settings'}
        isMobile
      />
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
