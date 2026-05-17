import React from 'react';
import { cn } from '@/lib/utils';

interface LoadingDotsProps {
  className?: string;
  color?: string;
  size?: number;
}

export function LoadingDots({ 
  className, 
  color = 'text-slate-400',
  size = 6 
}: LoadingDotsProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <style>{`
        @keyframes dotPulse1 {
          0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
          30% { opacity: 1; transform: scale(1); }
        }
        @keyframes dotPulse2 {
          0%, 20%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        @keyframes dotPulse3 {
          0%, 40%, 100% { opacity: 0.3; transform: scale(0.8); }
          70% { opacity: 1; transform: scale(1); }
        }
        @keyframes dotPulse4 {
          0%, 0%, 100% { opacity: 0.3; transform: scale(0.8); }
          90% { opacity: 1; transform: scale(1); }
        }
        .dot-1 { animation: dotPulse1 1.2s ease-in-out infinite; }
        .dot-2 { animation: dotPulse2 1.2s ease-in-out infinite; }
        .dot-3 { animation: dotPulse3 1.2s ease-in-out infinite; }
        .dot-4 { animation: dotPulse4 1.2s ease-in-out infinite; }
      `}</style>
      <span 
        className={cn('dot-1 rounded-full inline-block', color)}
        style={{ width: size, height: size }}
      />
      <span 
        className={cn('dot-2 rounded-full inline-block', color)}
        style={{ width: size, height: size }}
      />
      <span 
        className={cn('dot-3 rounded-full inline-block', color)}
        style={{ width: size, height: size }}
      />
      <span 
        className={cn('dot-4 rounded-full inline-block', color)}
        style={{ width: size, height: size }}
      />
    </div>
  );
};
