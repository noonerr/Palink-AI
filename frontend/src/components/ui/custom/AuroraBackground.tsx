/**
 * 文件路径: frontend/src/components/ui/custom/AuroraBackground.tsx
 * 用途: Aurora 多层 Blob 背景组件
 * 特性: 
 * - 三个渐变 Blob 层，带有浮动和变形动画
 * - 支持深色/浅色主题自动切换
 * - 支持角色特定的自定义颜色
 * - 性能优化：使用 transform3d 和 will-change 硬件加速
 * - 移动端自动降级（减少动画复杂度）
 */

import React, { useEffect, useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCharacterUI } from './CharacterUIProvider';

interface AuroraBackgroundProps {
  className?: string;
  reducedMotion?: boolean;
}

export function AuroraBackground({ 
  className = ''
}: AuroraBackgroundProps) {
  const _isMobile = useIsMobile();
  const { uiConfig } = useCharacterUI();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_prefersReducedMotion, _setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const checkReducedMotion = () => {
      const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      _setPrefersReducedMotion(mediaQuery.matches);
    };
    checkReducedMotion();
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    mediaQuery.addEventListener('change', checkReducedMotion);

    return () => {
      mediaQuery.removeEventListener('change', checkReducedMotion);
    };
  }, [_setPrefersReducedMotion]);

  const shouldReduceMotion = uiConfig?.effects?.aurora_enabled ? false : true;

  const colors = useMemo(() => {
    if (uiConfig?.effects) {
      return {
        blob1From: uiConfig.effects.aurora_color1 || '#00f2ff',
        blob1To: uiConfig.effects.aurora_color1 || '#00c3ff',
        blob2From: uiConfig.effects.aurora_color2 || '#4400ff',
        blob2To: uiConfig.effects.aurora_color2 || '#8800ff',
        blob3From: uiConfig.effects.aurora_color3 || '#00ff88',
        blob3To: uiConfig.effects.aurora_color3 || '#00f2ff',
      };
    }
    return {
      blob1From: '#00f2ff',
      blob1To: '#00c3ff',
      blob2From: '#4400ff',
      blob2To: '#8800ff',
      blob3From: '#00ff88',
      blob3To: '#00f2ff',
    };
  }, [uiConfig]);

  return (
    <div 
      className={cn(
        "fixed inset-0 z-0 overflow-hidden pointer-events-none",
        className
      )}
      aria-hidden="true"
    >
      <div 
        className={cn(
          "absolute rounded-full aurora-blob-1",
          "w-[500px] h-[500px] -top-[100px] -left-[100px]",
          "blur-[40px] opacity-20",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-1 animate-aurora-morph"
        )}
        style={{
          background: `linear-gradient(135deg, ${colors.blob1From}, ${colors.blob1To})`,
          animationDuration: shouldReduceMotion ? '0s' : '14s, 10s',
          transform: 'translate3d(0,0,0)',
        }}
      />

      <div 
        className={cn(
          "absolute rounded-full aurora-blob-2",
          "w-[450px] h-[450px] -bottom-[50px] -right-[50px]",
          "blur-[40px] opacity-20",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-2 animate-aurora-morph"
        )}
        style={{
          background: `linear-gradient(135deg, ${colors.blob2From}, ${colors.blob2To})`,
          animationDuration: shouldReduceMotion ? '0s' : '12s, 9s',
          animationDelay: shouldReduceMotion ? '0s' : '-5s',
          transform: 'translate3d(0,0,0)',
        }}
      />

      <div 
        className={cn(
          "absolute rounded-full aurora-blob-3",
          "w-[300px] h-[300px] top-[40%] left-[30%]",
          "blur-[40px] opacity-[0.15]",
          "will-change-transform",
          "transform-gpu translate-z-0",
          !shouldReduceMotion && "animate-aurora-float-3 animate-aurora-morph"
        )}
        style={{
          background: `linear-gradient(135deg, ${colors.blob3From}, ${colors.blob3To})`,
          animationDuration: shouldReduceMotion ? '0s' : '16s, 12s',
          animationDelay: shouldReduceMotion ? '0s' : '-2s',
          transform: 'translate3d(0,0,0)',
        }}
      />
    </div>
  );
};
