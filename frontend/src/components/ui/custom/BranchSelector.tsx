/**
 * BranchSelector — 分支选择器
 * 从 CharacterChat 提取的可复用组件
 */
import React, { useState, useRef, useCallback } from 'react';
import { GitBranch, Plus, ChevronDown, Check, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { CharacterChatSessionBranch } from '@/types';

export interface BranchSelectorProps {
  branches: CharacterChatSessionBranch[];
  selectedBranch: CharacterChatSessionBranch | null;
  onSelect: (branch: CharacterChatSessionBranch) => void;
  onCreate: (name: string) => void;
  onDelete: (branchId: string) => void;
  t: Record<string, string>;
  /** 禁用整个选择器 */
  disabled?: boolean;
}

export function BranchSelector({
  branches,
  selectedBranch,
  onSelect,
  onCreate,
  onDelete,
  t,
  disabled = false,
}: BranchSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setIsOpen(false));

  const handleCreate = useCallback(() => {
    if (newBranchName.trim()) {
      onCreate(newBranchName);
      setNewBranchName('');
    }
  }, [newBranchName, onCreate]);

  const handleSelect = useCallback((branch: CharacterChatSessionBranch) => {
    onSelect(branch);
    setIsOpen(false);
  }, [onSelect]);

  const handleDelete = useCallback((e: React.MouseEvent, branchId: string) => {
    e.stopPropagation();
    onDelete(branchId);
  }, [onDelete]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium",
          "bg-secondary hover:bg-secondary/80 transition-all",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          isOpen && "ring-2 ring-primary/20"
        )}
      >
        <GitBranch size={16} />
        <span>{selectedBranch?.branch_name || 'Main'}</span>
        <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] glass-strong rounded-xl shadow-xl border border-border z-[70] overflow-hidden animate-fade-in-up">
          <div className="p-2 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Input
                placeholder={t.new_branch_name || '新分支名称'}
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                className="text-sm h-8"
              />
              <Button size="sm" className="h-8 px-3" onClick={handleCreate} disabled={!newBranchName.trim()}>
                <Plus size={14} />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {branches.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">{t.no_branches || '暂无分支'}</div>
            ) : (
              branches.map((branch) => (
                <div
                  key={branch.id}
                  className={cn(
                    "flex items-center justify-between px-3 py-2.5 text-sm transition-all",
                    selectedBranch?.id === branch.id
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <button
                    onClick={() => handleSelect(branch)}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    <GitBranch size={14} />
                    <div className="flex-1">
                      <div className="font-medium">{branch.branch_name}</div>
                      {branch.is_active && <div className="text-xs opacity-70">{t.current || '当前'}</div>}
                    </div>
                    {selectedBranch?.id === branch.id && <Check size={14} />}
                  </button>
                  {!branch.is_active && branches.length > 1 && (
                    <Button
                      variant="ghost" size="icon"
                      className="h-7 w-7 opacity-50 hover:opacity-100 hover:text-destructive"
                      onClick={(e) => handleDelete(e, branch.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default BranchSelector;
