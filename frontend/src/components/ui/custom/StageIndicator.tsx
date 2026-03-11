/**
 * StageIndicator — 世界书激活词条数量 badge（Phase 6B）
 */
import React from 'react';
import { BookOpen } from 'lucide-react';
import type { WorldBookStatus } from '@/types';

interface StageIndicatorProps {
  status: WorldBookStatus;
}

export const StageIndicator: React.FC<StageIndicatorProps> = ({ status }) => {
  if (!status.active) return null;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 border border-blue-500/20">
      <BookOpen className="w-3 h-3 text-blue-400 shrink-0" />
      <span className="text-xs text-blue-300/80 max-w-20 truncate hidden sm:inline">
        {status.world_book_name || '世界书'}
      </span>
      <span className="text-[11px] font-medium text-blue-400 shrink-0">
        {status.active_entries_count} 条
      </span>
    </div>
  );
};
