/**
 * WorldBookSelector — 新建对话时选择世界书
 */
import React from 'react';
import { BookOpen } from 'lucide-react';
import type { WorldBook } from '@/types';

interface WorldBookSelectorProps {
  worldBooks: WorldBook[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading?: boolean;
}

export function WorldBookSelector({
  worldBooks, selectedId, onSelect, loading,
}: WorldBookSelectorProps) {
  if (loading) {
    return <div className="text-xs text-muted-foreground py-2">加载世界书...</div>;
  }

  if (worldBooks.length === 0) {
    return null; // Don't show selector if no world books exist
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <BookOpen className="w-3.5 h-3.5" />
        世界书 / 剧本（可选）
      </label>
      <div className="flex flex-wrap gap-2">
        {/* No world book option */}
        <button
          onClick={() => onSelect(null)}
          className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
            selectedId === null
              ? 'bg-white/15 text-foreground ring-1 ring-white/20'
              : 'bg-white/5 text-muted-foreground hover:bg-white/10'
          }`}
        >
          无
        </button>
        {worldBooks.map(wb => (
          <button
            key={wb.id}
            onClick={() => onSelect(wb.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
              selectedId === wb.id
                ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30'
                : 'bg-white/5 text-muted-foreground hover:bg-white/10'
            }`}
          >
            <BookOpen className="w-3 h-3" />
            {wb.name}
            {wb.is_parsed && (
              <span className="text-[10px] opacity-60">{wb.stage_count}段</span>
            )}
          </button>
        ))}
      </div>
      {selectedId && (
        <p className="text-[11px] text-blue-400/60">
          AI将按世界书的阶段内容引导角色扮演剧情发展
        </p>
      )}
    </div>
  );
};
