/**
 * StorylinePanel — fullscreen overlay wrapping StorylineMap
 * Triggered by the "故事线" button in CharacterView header
 */

import React, { useEffect, useCallback } from 'react';
import { X, GitBranch, Map as MapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StorylineMap, { type BranchTree } from './StorylineMap';

interface StorylinePanelProps {
  branchTree: BranchTree;
  activeBranchName: string;
  characterName: string;
  onClose: () => void;
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  isDark: boolean;
  sessionId?: string;
  onDeleteBranch?: (branchId: string) => void;
}

function StorylinePanel({
  branchTree,
  activeBranchName,
  characterName,
  onClose,
  onNavigate,
  isDark,
  sessionId,
  onDeleteBranch,
}: StorylinePanelProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleNavigate = useCallback(
    async (branchId: string, messageId: number | null, isLeaf: boolean) => {
      await onNavigate(branchId, messageId, isLeaf);
      onClose();
    },
    [onNavigate, onClose]
  );

  const totalNodes = branchTree.branches.reduce((sum, b) => sum + b.nodes.length, 0);
  const totalBranches = branchTree.branches.length;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col" style={{ isolation: 'isolate' }}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative flex flex-col w-full h-full">
        {/* Top bar */}
        <div
          className={`relative z-10 flex items-center justify-between px-6 py-3 bg-gradient-to-t pointer-events-auto ${
            isDark
              ? 'from-gray-900/100 via-gray-900/80 to-gray-900/0 text-white'
              : 'from-white/100 via-white/80 to-white/0 text-gray-900'
          }`}
          style={{ backdropFilter: 'blur(12px)' }}
        >
          {/* Left: title */}
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-indigo-500/20' : 'bg-indigo-50'}`}>
              <MapIcon size={18} className="text-indigo-400" />
            </div>
            <div>
              <h2 className="font-bold text-base leading-none">故事线</h2>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {characterName}
              </p>
            </div>

            {/* Stats pills */}
            <div className="hidden sm:flex items-center gap-2 ml-4">
              <span
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium ${
                  isDark ? 'bg-indigo-500/20 text-indigo-300' : 'bg-indigo-50 text-indigo-600'
                }`}
              >
                <GitBranch size={11} />
                {totalBranches} 条分支
              </span>
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                  isDark ? 'bg-gray-700/60 text-gray-400' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {totalNodes} 个对话节点
              </span>
            </div>
          </div>

          {/* Center: current branch */}
          <div className="hidden md:flex items-center gap-2">
            <GitBranch size={14} className="text-indigo-400" />
            <span className={`text-sm ${isDark ? 'text-indigo-300' : 'text-indigo-600'} font-semibold`}>
              当前：{activeBranchName}
            </span>
          </div>

          {/* Right: hint + close */}
          <div className="flex items-center gap-3">
            <span className={`hidden lg:block text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              点击节点可回溯 / 分叉 · 可自由拖拽 · Esc 关闭
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className={`h-8 w-8 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
            >
              <X size={16} />
            </Button>
          </div>
        </div>

        {/* Empty state */}
        {totalNodes === 0 ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center gap-3 ${
              isDark ? 'bg-gray-900/95' : 'bg-slate-50/95'
            }`}
          >
            <div className={`p-5 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
              <MapIcon size={40} className="text-indigo-400 mx-auto" />
            </div>
            <p className={`text-base font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              还没有对话记录
            </p>
            <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              开始第一句对话，故事线将自动生成
            </p>
          </div>
        ) : (
          /* React Flow canvas */
          <div className="flex-1 overflow-hidden">
            <StorylineMap
              branchTree={branchTree}
              onNavigate={handleNavigate}
              isDark={isDark}
              sessionId={sessionId}
              onDeleteBranch={onDeleteBranch}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default StorylinePanel;
