/**
 * WorldBookOverview — 侧边滑出面板，世界书阶段时间线 + 快速跳转
 */
import React from 'react';
import { BookOpen, X, ChevronRight, CheckCircle, Circle, PlayCircle } from 'lucide-react';
// GlassCard reserved for future styling
import type { WorldBookStatus } from '@/types';

interface WorldBookOverviewProps {
  status: WorldBookStatus;
  isOpen: boolean;
  onClose: () => void;
  onJump: (index: number) => void;
}

export const WorldBookOverview: React.FC<WorldBookOverviewProps> = ({
  status, isOpen, onClose, onJump,
}) => {
  if (!isOpen || !status.active) return null;

  const current = status.current_stage_index ?? 0;
  const stages = status.stages_overview || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative w-full max-w-sm h-full glass-strong overflow-hidden animate-in slide-in-from-right duration-300"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="font-semibold text-sm">{status.world_book_name || '世界书概览'}</h3>
              <p className="text-[11px] text-muted-foreground">
                阶段 {current + 1} / {status.total_stages}
                {status.stage_transition_mode === 'auto' && ' · 自动过渡'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[11px] top-3 bottom-3 w-[2px] bg-white/10" />

            <div className="space-y-1">
              {stages.map((stage, i) => {
                const isCompleted = i < current;
                const isCurrent = i === current;
                const isFuture = i > current;

                return (
                  <button
                    key={i}
                    onClick={() => onJump(i)}
                    className={`
                      relative w-full flex items-start gap-3 p-2.5 rounded-lg text-left transition-all
                      ${isCurrent ? 'bg-blue-500/10 ring-1 ring-blue-500/20' : 'hover:bg-white/5'}
                    `}
                  >
                    {/* Status icon */}
                    <div className="relative z-10 mt-0.5 shrink-0">
                      {isCompleted && <CheckCircle className="w-6 h-6 text-green-400" />}
                      {isCurrent && <PlayCircle className="w-6 h-6 text-blue-400" />}
                      {isFuture && <Circle className="w-6 h-6 text-white/20" />}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-medium ${
                          isCurrent ? 'text-blue-300' : isCompleted ? 'text-foreground' : 'text-muted-foreground/60'
                        }`}>
                          {stage.title || `阶段 ${i + 1}`}
                        </span>
                        {isCurrent && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-300">当前</span>
                        )}
                      </div>
                      {stage.summary && (
                        <p className={`text-[11px] mt-0.5 line-clamp-2 ${
                          isFuture ? 'text-muted-foreground/40' : 'text-muted-foreground'
                        }`}>
                          {stage.summary}
                        </p>
                      )}
                    </div>

                    <ChevronRight className={`w-4 h-4 shrink-0 mt-0.5 ${
                      isCurrent ? 'text-blue-400' : 'text-white/10'
                    }`} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
