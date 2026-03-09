import React from 'react';

interface SettingGroupProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingGroup: React.FC<SettingGroupProps> = ({ 
  title, 
  children, 
  className = "" 
}) => (
  <div className={`mb-8 ${className}`}>
    {title && <div className="px-3 mb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">{title}</div>}
    <div className="bg-white dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 rounded-2xl divide-y divide-gray-50 dark:divide-gray-800 shadow-sm transition-all hover:shadow-md">{children}</div>
  </div>
);
