import React from 'react';

interface SettingItemProps {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  desc?: string;
  children?: React.ReactNode;
  className?: string;
  danger?: boolean;
}

export function SettingItem({ 
  icon: Icon, 
  label, 
  desc, 
  children, 
  className = "", 
  danger = false 
}: SettingItemProps) {
  return (
    <div className={`flex items-center justify-between p-4 min-h-[72px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors first:rounded-t-2xl last:rounded-b-2xl ${className}`}>
      <div className="flex items-center gap-4 overflow-hidden">
        {Icon && <div className={`p-2.5 rounded-xl ${danger ? 'bg-red-50 text-red-500' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}><Icon size={20}/></div>}
        <div className="flex-1 min-w-0">
          <div className={`font-medium text-sm truncate ${danger ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}>{label}</div>
          {desc && <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{desc}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 ml-6 flex items-center gap-2">{children}</div>
    </div>
  );
}
