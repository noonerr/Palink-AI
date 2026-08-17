/**
 * ChatSidebar — 聊天侧边栏（故事线）
 * 从 CharacterChat 提取的侧边栏组件，统一处理移动端和桌面端
 */
import React, { Suspense, lazy } from 'react';
import { Map as MapIcon, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BranchTree } from '@/components/ui/custom/StorylineMap';
import type { CharacterChatSessionBranch } from '@/types';

// 故事线地图依赖 @xyflow/react + dagre（合计约 2MB 源码），只在用户打开故事线
// 侧边栏时才需要。懒加载使其独立成 chunk，避免拖累角色聊天首屏加载；
// 侧边栏打开瞬间 fallback 显示轻量占位，chunk 加载后（本地缓存，毫秒级）即渲染。
const StorylineMap = lazy(() => import('@/components/ui/custom/StorylineMap'));

const HISTORY_SLIDE_DURATION_MS = 300;

export interface ChatSidebarProps {
  isMobile: boolean;
  isDark: boolean;
  isNavigating: boolean;
  // 故事线数据
  branchTree: BranchTree | null;
  selectedSessionId?: string;
  selectedBranch: CharacterChatSessionBranch | null;
  branches: CharacterChatSessionBranch[];
  // 移动端侧边栏状态
  mobileSidebarOpen: boolean;
  // 桌面端侧边栏状态
  sidebarCollapsed: boolean;
  // 回调
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => Promise<void>;
  onCreateBranch: () => Promise<void>;
  onDeleteBranch: (branchId: string) => void;
  onClose: () => void;
}

export function ChatSidebar({
  isMobile,
  isDark,
  isNavigating,
  branchTree,
  selectedSessionId,
  selectedBranch,
  branches,
  mobileSidebarOpen,
  sidebarCollapsed,
  onNavigate,
  onCreateBranch,
  onDeleteBranch,
  onClose,
}: ChatSidebarProps) {
  const hasStoryline = branchTree && branchTree.branches.reduce((sum, b) => sum + b.nodes.length, 0) > 0;

  const sidebarHeader = (
    <div className={cn(
      'absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-3 pb-10 bg-gradient-to-b pointer-events-none',
      isDark ? 'from-[#1f2233] via-[#1f2233]/80 to-transparent' : 'from-[#FFFAFA] via-[#FFFAFA]/80 to-transparent'
    )}>
      <div className="flex items-center gap-2 pointer-events-auto">
        <div className={cn('p-1.5 rounded-lg', isDark ? 'bg-indigo-500/20' : 'bg-indigo-50')}>
          <MapIcon size={14} className="text-indigo-400" />
        </div>
        <span className={cn('text-sm font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>
          故事线
        </span>
      </div>
      <div className="flex items-center gap-1 pointer-events-auto">
        <button
          onClick={onCreateBranch}
          className={cn(
            'h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors',
            isDark
              ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30'
              : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
          )}
          title="创建新分支"
        >
          <Plus size={11} />
          <span>新分支</span>
        </button>
        {selectedBranch && branches.length > 1 && (
          <button
            onClick={() => onDeleteBranch(selectedBranch.id)}
            className={cn(
              'h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-medium transition-colors',
              selectedBranch.is_active
                ? isDark
                  ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                  : 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                : isDark
                  ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                  : 'bg-red-50 text-red-600 hover:bg-red-100'
            )}
            title={selectedBranch.is_active ? '删除当前分支（将切换到其他分支）' : '删除当前分支'}
          >
            <Trash2 size={11} />
            <span>删除</span>
          </button>
        )}
        <button
          onClick={() => { if (!isNavigating) onClose(); }}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors',
            isDark
              ? 'border-slate-600/80 bg-[#2d3350] text-slate-100'
              : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700'
          )}
          aria-label="close-storyline"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );

  const sidebarContent = hasStoryline ? (
    <div className="flex-1 min-h-0 overflow-hidden">
      <Suspense fallback={
        <div className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2',
          isDark ? 'bg-gray-900/95 text-gray-400' : 'bg-slate-50/95 text-slate-500'
        )}>
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span className="text-xs">故事线加载中…</span>
        </div>
      }>
        <StorylineMap
          branchTree={branchTree!}
          onNavigate={onNavigate}
          isDark={isDark}
          sessionId={selectedSessionId}
          onDeleteBranch={onDeleteBranch}
        />
      </Suspense>
    </div>
  ) : (
    <div className={cn(
      'flex-1 flex flex-col items-center justify-center gap-3 px-4 pt-16',
      isDark ? 'bg-gray-900/95' : 'bg-slate-50/95'
    )}>
      <div className={cn('p-5 rounded-2xl shadow-lg', isDark ? 'bg-gray-800' : 'bg-white')}>
        <MapIcon size={40} className="text-indigo-400 mx-auto" />
      </div>
      <p className={cn('text-base font-semibold', isDark ? 'text-gray-300' : 'text-gray-600')}>
        还没有对话记录
      </p>
      <p className={cn('text-sm', isDark ? 'text-gray-500' : 'text-gray-400')}>
        开始第一句对话，故事线将自动生成
      </p>
    </div>
  );

  // 移动端侧边栏
  if (isMobile) {
    return (
      <aside
        className={cn(
          'mobile-storyline-sidebar fixed inset-y-0 left-0 w-[320px] transform-gpu px-0 pb-0 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-transform ease-in-out z-[60]',
          isDark ? 'border-r border-slate-700/70 bg-[#1f2233] backdrop-blur-[24px]' : 'border-r border-[#ddd4c5] bg-[#FFFAFA] backdrop-blur-[20px]'
        )}
        style={{
          transform: `translate3d(${mobileSidebarOpen ? 0 : -320}px, 0, 0)`,
          transitionDuration: `${HISTORY_SLIDE_DURATION_MS}ms`,
        }}
      >
        <div className="flex h-full flex-col overflow-hidden relative">
          {sidebarContent}
          {sidebarHeader}
        </div>
      </aside>
    );
  }

  // 桌面端侧边栏
  return (
    <div className={`transition-all duration-300 ease-in-out overflow-hidden relative flex-shrink-0 ${!sidebarCollapsed ? 'w-[320px] opacity-100' : 'w-0 opacity-0'}`}>
      <div className="w-[320px] h-full flex-shrink-0 border-r border-border/50 glass flex flex-col relative overflow-hidden">
        {sidebarContent}
        {sidebarHeader}
      </div>
    </div>
  );
}

export default ChatSidebar;
