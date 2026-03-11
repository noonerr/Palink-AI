/**
 * WorldBookOverview — 侧边滑出面板，展示当前已激活的世界书词条
 */
import React from 'react';
import { BookOpen, X, Zap } from 'lucide-react';
import type { WorldBookStatus } from '@/types';

interface WorldBookOverviewProps {
  status: WorldBookStatus;
  isOpen: boolean;
  onClose: () => void;
}

export const WorldBookOverview: React.FC<WorldBookOverviewProps> = ({
  status, isOpen, onClose,
}) => {
  if (!isOpen || !status.active) return null;

  const entries = status.entries_overview || [];

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
                当前已激活 {status.active_entries_count} 条词条
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

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto p-4">
          {entries.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">暂无激活的词条</p>
              <p className="text-xs mt-1">对话中匹配到关键词后会自动注入</p>
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/10 ring-1 ring-blue-500/20"
                >
                  <Zap className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-blue-300">{entry.title || '无标题'}</p>
                    {entry.keys_preview && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">关键词: {entry.keys_preview}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
