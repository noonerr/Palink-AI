/**
 * StageIndicator — 聊天顶部的世界书阶段进度指示器
 */
import React from 'react';
import { BookOpen } from 'lucide-react';
import type { WorldBookStatus } from '@/types';

interface StageIndicatorProps {
  status: WorldBookStatus;
  onStageClick?: (index: number) => void;
}

export const StageIndicator: React.FC<StageIndicatorProps> = ({ status, onStageClick }) => {
  if (!status.active || !status.total_stages) return null;

  const stages = status.stages_overview || [];
  const current = status.current_stage_index ?? 0;
  const total = status.total_stages;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-blue-500/5 to-purple-500/5 border-b border-white/5">
      <BookOpen className="w-3.5 h-3.5 text-blue-400 shrink-0" />
      <span className="text-xs text-muted-foreground shrink-0">
        {status.world_book_name || '世界书'}
      </span>

      {/* Progress dots / bar */}
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none">
        {stages.map((stage, i) => {
          const isCompleted = i < current;
          const isCurrent = i === current;
          const isFuture = i > current;

          return (
            <button
              key={i}
              onClick={() => onStageClick?.(i)}
              title={stage.title || `阶段 ${i + 1}`}
              className={`
                group relative flex items-center gap-1 shrink-0 transition-all duration-300
                ${isCurrent ? 'scale-105' : 'scale-100'}
              `}
            >
              {/* Connector line */}
              {i > 0 && (
                <div className={`w-3 h-[2px] rounded-full transition-colors duration-500 ${
                  isCompleted ? 'bg-green-400/40' : isCurrent ? 'bg-blue-400/30' : 'bg-white/10'
                }`} />
              )}

              {/* Stage dot */}
              <div className={`
                w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-500
                ${isCompleted ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30' : ''}
                ${isCurrent ? 'bg-blue-500/25 text-blue-300 ring-2 ring-blue-500/40 shadow-[0_0_8px_rgba(59,130,246,0.2)]' : ''}
                ${isFuture ? 'bg-white/5 text-muted-foreground/50' : ''}
              `}>
                {isCompleted ? '✓' : i + 1}
              </div>

              {/* Current stage title tooltip */}
              {isCurrent && stage.title && (
                <span className="text-[11px] text-blue-300/80 max-w-20 truncate hidden sm:inline">
                  {stage.title}
                </span>
              )}

              {/* Hover tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded text-[10px] bg-gray-900/90 text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                {stage.title || `阶段 ${i + 1}`}
                {stage.summary && <div className="text-[9px] text-gray-400 max-w-40 truncate">{stage.summary}</div>}
              </div>
            </button>
          );
        })}
      </div>

      <span className="text-[11px] text-muted-foreground shrink-0">
        {current + 1}/{total}
      </span>
    </div>
  );
};
