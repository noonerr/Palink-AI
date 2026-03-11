/**
 * StageControls — 世界书阶段手动控制按钮（放在二级菜单内）
 */
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { WorldBookStatus } from '@/types';

interface StageControlsProps {
  status: WorldBookStatus;
  onNext: () => void;
  onPrev: () => void;
  onJump: (index: number) => void;
}

export const StageControls: React.FC<StageControlsProps> = ({
  status, onNext, onPrev, onJump,
}) => {
  if (!status.active || !status.total_stages) return null;

  const current = status.current_stage_index ?? 0;
  const total = status.total_stages;
  const isFirst = current === 0;
  const isLast = current >= total - 1;

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground">世界书阶段控制</div>

      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={isFirst}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          上一阶段
        </button>

        <span className="text-sm font-medium text-foreground/80 min-w-[3rem] text-center">
          {current + 1} / {total}
        </span>

        <button
          onClick={onNext}
          disabled={isLast}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          下一阶段
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Quick jump */}
      {total > 3 && (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: total }, (_, i) => (
            <button
              key={i}
              onClick={() => onJump(i)}
              className={`w-7 h-7 rounded-md text-xs font-medium transition-colors ${
                i === current
                  ? 'bg-blue-500/25 text-blue-300 ring-1 ring-blue-500/40'
                  : i < current
                    ? 'bg-green-500/10 text-green-400/70 hover:bg-green-500/20'
                    : 'bg-white/5 text-muted-foreground/50 hover:bg-white/10'
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      {status.current_stage && (
        <div className="p-2 rounded-lg bg-white/5 text-xs">
          <span className="text-muted-foreground">当前: </span>
          <span className="text-foreground">{status.current_stage.title || `阶段 ${current + 1}`}</span>
          {status.current_stage.summary && (
            <p className="text-muted-foreground mt-1 text-[11px] line-clamp-2">{status.current_stage.summary}</p>
          )}
        </div>
      )}
    </div>
  );
};
