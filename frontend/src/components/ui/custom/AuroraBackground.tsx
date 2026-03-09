/**
 * 文件路径: frontend/src/components/ui/custom/AuroraBackground.tsx
 * 用途: Aurora 多层 Blob 背景组件
 * 特性: 
 * - 三个渐变 Blob 层，带有浮动和变形动画
 * - 支持深色/浅色主题自动切换
 * - 性能优化：使用 transform3d 和 will-change 硬件加速
 * - 移动端自动降级（减少动画复杂度）
 */

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface AuroraBackgroundProps {
  className?: string;
  reducedMotion?: boolean;
}

export const AuroraBackground: React.FC<AuroraBackgroundProps> = ({ 
  className = ''
  // reducedMotion 参数保留供将来使用，当前强制静态背景
}) => {
  // 以下状态保留供将来恢复动画时使用
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_isMobile, _setIsMobile] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_prefersReducedMotion, _setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    // 检测移动设备（保留供将来使用）
    const checkMobile = () => {
      const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
      const isSmallScreen = window.innerWidth < 768;
      _setIsMobile(isTouchDevice || isSmallScreen);
    };

    // 检测用户是否偏好减少动画（保留供将来使用）
    const checkReducedMotion = () => {
      const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      _setPrefersReducedMotion(mediaQuery.matches);
    };

    checkMobile();
    checkReducedMotion();

    window.addEventListener('resize', checkMobile);
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    mediaQuery.addEventListener('change', checkReducedMotion);

    return () => {
      window.removeEventListener('resize', checkMobile);
      mediaQuery.removeEventListener('change', checkReducedMotion);
    };
  }, [_setIsMobile, _setPrefersReducedMotion]);

  // 注意：当前设置为静态背景以优化系统资源（GPU/CPU/内存）占用
  // 如需恢复动态动画，将下一行改为：const shouldReduceMotion = reducedMotion || _prefersReducedMotion || _isMobile;
  const shouldReduceMotion = true; // 强制静态背景模式

  return (
    <div 
      className={cn(
        "fixed inset-0 z-0 overflow-hidden pointer-events-none",
        className
      )}
      aria-hidden="true"
    >
      {/* Blob 1 - 左上，青色系 */}
      <div 
        className={cn(
          "absolute rounded-full aurora-blob-1",
          "w-[500px] h-[500px] -top-[100px] -left-[100px]",
          "bg-gradient-to-br from-[#00f2ff] to-[#00c3ff]",
          "dark:from-[#00f2ff] dark:to-[#00c3ff]",
          "blur-[40px] opacity-20",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-1 animate-aurora-morph"
        )}
        style={{
          animationDuration: shouldReduceMotion ? '0s' : '14s, 10s',
          transform: 'translate3d(0,0,0)',
        }}
      />

      {/* Blob 2 - 右下，深蓝/紫色系 */}
      <div 
        className={cn(
          "absolute rounded-full aurora-blob-2",
          "w-[450px] h-[450px] -bottom-[50px] -right-[50px]",
          "bg-gradient-to-br from-[#4400ff] to-[#8800ff]",
          "dark:from-[#4400ff] dark:to-[#8800ff]",
          "blur-[40px] opacity-20",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-2 animate-aurora-morph"
        )}
        style={{
          animationDuration: shouldReduceMotion ? '0s' : '12s, 9s',
          animationDelay: shouldReduceMotion ? '0s' : '-5s',
          transform: 'translate3d(0,0,0)',
        }}
      />

      {/* Blob 3 - 中间辅助形状 */}
      <div 
        className={cn(
          "absolute rounded-full aurora-blob-3",
          "w-[300px] h-[300px] top-[40%] left-[30%]",
          "bg-gradient-to-br from-[#00ff88] to-[#00f2ff]",
          "dark:from-[#00ff88] dark:to-[#00f2ff]",
          "blur-[40px] opacity-[0.15]",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-3 animate-aurora-morph"
        )}
        style={{
          animationDuration: shouldReduceMotion ? '0s' : '16s, 12s',
          animationDelay: shouldReduceMotion ? '0s' : '-2s',
          transform: 'translate3d(0,0,0)',
        }}
      />

      {/* 浅色模式颜色覆盖 - 更明显的光效 */}
      <style>{`
        [data-theme="light"] .aurora-blob-1,
        [data-theme="light"] .aurora-blob-2,
        [data-theme="light"] .aurora-blob-3 {
          opacity: 0.15 !important;
          filter: blur(60px) saturate(0.8) !important;
        }
        /* 明亮青色 - 左上 */
        [data-theme="light"] .aurora-blob-1 {
          background: linear-gradient(135deg, #4facfe, #00f2fe) !important;
        }
        /* 明亮蓝色 - 右下 */
        [data-theme="light"] .aurora-blob-2 {
          background: linear-gradient(135deg, #667eea, #764ba2) !important;
        }
        /* 明亮绿色 - 中间 */
        [data-theme="light"] .aurora-blob-3 {
          background: linear-gradient(135deg, #43e97b, #38f9d7) !important;
        }
      `}</style>
    </div>
  );
};
