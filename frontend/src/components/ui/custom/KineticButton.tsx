/**
 * 文件路径: frontend/src/components/ui/custom/KineticButton.tsx
 * 用途: Kinetic 动效按钮组件
 * 特性:
 * - 鼠标/触摸移动时按钮内背景与文字产生微位移
 * - 使用 requestAnimationFrame 做平滑插值
 * - 移动端降级为简单缩放效果
 * - 支持多种预设样式（send/recv/primary/secondary）
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

interface KineticButtonProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'send' | 'recv' | 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
}

export function KineticButton({
  children,
  className = '',
  variant = 'primary',
  size = 'md',
  onClick,
  disabled = false,
}: KineticButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  
  // 动画状态
  const targetRef = useRef({ x: 0, y: 0 });
  const currentRef = useRef({ x: 0, y: 0 });
  
  const isMobile = useIsMobile();
  const [isHovered, setIsHovered] = useState(false);

  // 动画循环
  const animate = useCallback(() => {
    const smoothFactor = 0.08;
    
    currentRef.current.x += (targetRef.current.x - currentRef.current.x) * smoothFactor;
    currentRef.current.y += (targetRef.current.y - currentRef.current.y) * smoothFactor;

    if (bgRef.current) {
      bgRef.current.style.transform = `translate3d(${currentRef.current.x}px, ${currentRef.current.y}px, 0)`;
    }
    if (textRef.current) {
      textRef.current.style.transform = `translate3d(${currentRef.current.x * 0.5}px, ${currentRef.current.y * 0.5}px, 0)`;
    }

    // 如果接近目标且目标是0，停止动画
    const threshold = 0.05;
    if (
      Math.abs(currentRef.current.x) < threshold &&
      Math.abs(currentRef.current.y) < threshold &&
      targetRef.current.x === 0 &&
      targetRef.current.y === 0
    ) {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    rafIdRef.current = requestAnimationFrame(animate);
  }, []);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!buttonRef.current || isMobile) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // 检查是否在按钮范围内
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const maxOffset = 15;
      const rx = (clientX - centerX) / 25;
      const ry = (clientY - centerY) / 25;
      
      targetRef.current.x = Math.max(Math.min(rx, maxOffset), -maxOffset);
      targetRef.current.y = Math.max(Math.min(ry, maxOffset), -maxOffset);
    } else {
      targetRef.current.x = 0;
      targetRef.current.y = 0;
    }

    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(animate);
    }
  }, [isMobile, animate]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    handleMove(e.clientX, e.clientY);
  }, [handleMove]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    handleMove(touch.clientX, touch.clientY);
  }, [handleMove]);

  const reset = useCallback(() => {
    targetRef.current.x = 0;
    targetRef.current.y = 0;
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(animate);
    }
  }, [animate]);

  useEffect(() => {
    if (isMobile) return;

    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('touchmove', handleTouchMove);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [isMobile, handleMouseMove, handleTouchMove]);

  const variantStyles = {
    send: {
      container: 'h-16',
      bg: 'bg-gradient-to-br from-[#0044ff] to-[#00f2ff] shadow-lg shadow-[#00f2ff]/25',
      text: 'text-white',
    },
    recv: {
      container: 'h-16',
      bg: 'bg-white/5 border border-white/10',
      text: 'text-foreground',
    },
    primary: {
      container: 'h-14',
      bg: 'bg-gradient-to-br from-[#0044ff] to-[#00f2ff] shadow-lg shadow-[#00f2ff]/25',
      text: 'text-white',
    },
    secondary: {
      container: 'h-14',
      bg: 'bg-white/10 border border-white/20',
      text: 'text-foreground',
    },
  };

  const sizeStyles = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  const styles = variantStyles[variant];

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        reset();
      }}
      onTouchStart={() => setIsHovered(true)}
      onTouchEnd={() => {
        setIsHovered(false);
        reset();
      }}
      className={cn(
        'relative w-full rounded-[20px] cursor-pointer select-none',
        'perspective-[1000px]',
        '-webkit-tap-highlight-color-transparent',
        'transition-transform duration-200',
        isMobile && isHovered && 'scale-95',
        !isMobile && 'hover:scale-[1.02]',
        disabled && 'opacity-50 cursor-not-allowed',
        styles.container,
        sizeStyles[size],
        className
      )}
      style={{ perspective: '1000px' }}
    >
      {/* 背景层 */}
      <div
        ref={bgRef}
        className={cn(
          'absolute inset-0 rounded-[20px] will-change-transform',
          'shadow-md',
          styles.bg
        )}
        style={{ transform: 'translate3d(0,0,0)' }}
      />
      
      {/* 文字层 */}
      <div
        ref={textRef}
        className={cn(
          'relative z-10 w-full h-full flex items-center justify-center gap-2.5',
          'font-bold pointer-events-none will-change-transform',
          styles.text
        )}
        style={{ transform: 'translate3d(0,0,0)' }}
      >
        {children}
      </div>
    </button>
  );
};

// 简化的 Kinetic 按钮钩子（用于自定义实现）
export const useKinetic = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        const maxOffset = 10;
        const x = Math.max(Math.min((e.clientX - centerX) / 20, maxOffset), -maxOffset);
        const y = Math.max(Math.min((e.clientY - centerY) / 20, maxOffset), -maxOffset);
        setOffset({ x, y });
      }
    };

    const handleMouseLeave = () => {
      setOffset({ x: 0, y: 0 });
    };

    element.addEventListener('mousemove', handleMouseMove);
    element.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      element.removeEventListener('mousemove', handleMouseMove);
      element.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  return { ref, offset };
};
