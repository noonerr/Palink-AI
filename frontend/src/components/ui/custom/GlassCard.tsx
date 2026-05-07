import React from 'react';
import { cn } from '@/lib/utils';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  strong?: boolean;
  hover?: boolean;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const GlassCard: React.FC<GlassCardProps> = ({ 
  children, 
  className = '',
  strong = false,
  hover = false,
  onClick,
}) => {
  return (
    <div 
      className={cn(
        strong ? 'glass-strong' : 'glass',
        'rounded-2xl',
        hover && 'card-hover',
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  );
};
