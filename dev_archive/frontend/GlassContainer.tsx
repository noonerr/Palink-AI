/**
 * 文件路径: frontend/src/components/ui/custom/GlassContainer.tsx
 * 用途: 玻璃拟态容器组件
 * 特性:
 * - 支持 backdrop-filter blur 效果
 * - 半透明背景与边框
 * - 多种预设强度（light/medium/strong）
 * - 支持 hover 动效
 * - 自动适配深色/浅色主题
 */

import React from 'react';
import { cn } from '@/lib/utils';

interface GlassContainerProps {
  children: React.ReactNode;
  className?: string;
  intensity?: 'light' | 'medium' | 'strong';
  hover?: boolean;
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  border?: boolean;
  shadow?: boolean;
}

export const GlassContainer: React.FC<GlassContainerProps> = ({
  children,
  className = '',
  intensity = 'medium',
  hover = false,
  rounded = 'xl',
  border = true,
  shadow = false,
}) => {
  const intensityStyles = {
    light: {
      bg: 'bg-white/40 dark:bg-black/20',
      blur: 'backdrop-blur-sm',
      border: 'border-white/30 dark:border-white/10',
    },
    medium: {
      bg: 'bg-white/60 dark:bg-black/40',
      blur: 'backdrop-blur-xl',
      border: 'border-white/40 dark:border-white/10',
    },
    strong: {
      bg: 'bg-white/80 dark:bg-black/60',
      blur: 'backdrop-blur-2xl',
      border: 'border-white/50 dark:border-white/20',
    },
  };

  const roundedStyles = {
    sm: 'rounded-lg',
    md: 'rounded-xl',
    lg: 'rounded-2xl',
    xl: 'rounded-3xl',
    '2xl': 'rounded-[2rem]',
    full: 'rounded-full',
  };

  const styles = intensityStyles[intensity];

  return (
    <div
      className={cn(
        styles.bg,
        styles.blur,
        border && styles.border,
        border && 'border',
        roundedStyles[rounded],
        shadow && 'shadow-lg shadow-black/5 dark:shadow-black/20',
        hover && 'transition-all duration-300 hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:-translate-y-0.5',
        className
      )}
    >
      {children}
    </div>
  );
};

// 简化的 GlassCard 组件（保持向后兼容）
interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  className = '',
  hover = false,
}) => {
  return (
    <GlassContainer
      intensity="medium"
      rounded="xl"
      hover={hover}
      className={className}
    >
      {children}
    </GlassContainer>
  );
};

// 玻璃拟态按钮容器
interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const GlassButton: React.FC<GlassButtonProps> = ({
  children,
  className = '',
  variant = 'primary',
  size = 'md',
  ...props
}) => {
  const variantStyles = {
    primary: 'bg-gradient-to-r from-[#0044ff] to-[#00f2ff] text-white border-transparent',
    secondary: 'bg-white/10 dark:bg-white/5 text-foreground border-white/20 dark:border-white/10',
    ghost: 'bg-transparent text-foreground border-transparent hover:bg-white/10 dark:hover:bg-white/5',
  };

  const sizeStyles = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      className={cn(
        'relative overflow-hidden rounded-2xl font-semibold',
        'backdrop-blur-xl transition-all duration-200',
        'border border-white/20',
        'hover:shadow-lg hover:shadow-black/10',
        'active:scale-95',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};
