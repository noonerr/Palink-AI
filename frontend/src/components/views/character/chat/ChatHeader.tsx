/**
 * ChatHeader — 聊天头部组件
 * 从 CharacterChat 提取的头部组件，包含角色信息、模型选择器、预设选择器
 */
import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { PresetSelector } from '@/components/ui/custom/PresetSelector';
import { GenerationParamsPanel } from '@/components/ui/custom/GenerationParamsPanel';
import { ChatMoreMenu } from './ChatMoreMenu';
import type { Character, Model, GenerationPreset } from '@/types';

export interface ChatHeaderProps {
  isMobile: boolean;
  isDark: boolean;
  isNavigating: boolean;
  // 角色
  selectedCharacter: Character;
  // 模型
  models: Model[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  // 预设
  currentPreset: GenerationPreset | null;
  setCurrentPreset: (preset: GenerationPreset) => void;
  showPresetPanel: boolean;
  setShowPresetPanel: (v: boolean) => void;
  // 侧边栏
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleMobileSidebar: () => void;
  // 混合删除模式
  isMixedDeleteMode: boolean;
  selectedWholeMessages: Set<number>;
  selectedMessageParts: Map<number, Set<string>>;
  onMixedDelete: () => Promise<void>;
  onExitDeleteMode: () => void;
  // 更多菜单 props
  moreMenuProps: React.ComponentProps<typeof ChatMoreMenu>;
  t: Record<string, string>;
  // 返回角色列表
  onBackToList?: () => void;
}

export function ChatHeader({
  isMobile,
  isDark,
  isNavigating,
  selectedCharacter,
  models,
  selectedModel,
  onSelectModel,
  currentPreset,
  setCurrentPreset,
  showPresetPanel,
  setShowPresetPanel,
  mobileSidebarOpen,
  sidebarCollapsed,
  onToggleSidebar,
  onToggleMobileSidebar,
  isMixedDeleteMode,
  selectedWholeMessages,
  selectedMessageParts,
  onMixedDelete,
  onExitDeleteMode,
  moreMenuProps,
  t,
  onBackToList,
}: ChatHeaderProps) {
  return (
    <header
      className={cn(
        'flex items-center justify-between z-40',
        isMobile
          ? cn(
              'absolute left-0 right-0 top-0 z-50 pointer-events-auto'
            )
          : cn(
              'h-16 px-4 pt-safe border-b',
              isDark
                ? 'border-slate-700/70 bg-slate-950/80 backdrop-blur-[20px]'
                : 'border-[#ddd4c5] bg-[#FFFAFA]/80 backdrop-blur-[20px]'
            )
      )}
      style={isMobile ? { height: 'calc(env(safe-area-inset-top) + 3rem + 8px)' } : undefined}
    >
      {/* 移动端毛玻璃背景层：底部透明多点，顶部不透明多点（和 ChatViewMobile 完全一致） */}
      {isMobile && (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{
            backdropFilter: 'blur(16px) saturate(160%)',
            WebkitBackdropFilter: 'blur(16px) saturate(160%)',
            backgroundImage: isDark
              ? 'linear-gradient(to top, rgba(20,20,30,0) 0%, rgba(20,20,30,0.04) 30%, rgba(20,20,30,0.15) 50%, rgba(20,20,30,0.35) 70%, rgba(20,20,30,0.65) 100%)'
              : 'linear-gradient(to top, rgba(255,255,255,0) 0%, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.35) 70%, rgba(255,255,255,0.65) 100%)',
            WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 15%, rgba(0,0,0,0.7) 30%, rgba(0,0,0,1) 45%, rgba(0,0,0,1) 100%)',
            maskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 15%, rgba(0,0,0,0.7) 30%, rgba(0,0,0,1) 45%, rgba(0,0,0,1) 100%)',
          }}
        />
      )}
      {/* 移动端交互内容层：和 ChatViewMobile 的内容层规格完全一致 */}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-between',
          isMobile ? 'z-10 pointer-events-none px-5 pb-1' : 'relative z-10 w-full'
        )}
        style={isMobile ? { paddingTop: 'calc(env(safe-area-inset-top) + 10px)' } : undefined}
      >
      <div className={cn(isMobile ? 'pointer-events-auto flex items-center space-x-3' : 'relative z-10 flex items-center space-x-3')}>
        {/* 返回角色列表按钮 - 仅移动端、且传入 onBackToList 时显示 */}
        {isMobile && onBackToList && (
          <Button
            variant="ghost"
            size="icon"
            className="!h-10 !w-10 rounded-full transition-all duration-300 ease-in-out backdrop-blur-[20px] bg-transparent hover:!bg-[#FFFAFA]/30 dark:hover:!bg-white/[0.05] border border-[#ddd4c5]/40"
            onClick={onBackToList}
            aria-label="返回角色列表"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </Button>
        )}
        {/* Storyline toggle button - 仅移动端显示 */}
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              '!h-10 !w-10 rounded-full transition-all duration-300 ease-in-out backdrop-blur-[20px] bg-transparent hover:!bg-[#FFFAFA]/30 dark:hover:!bg-white/[0.05] border border-[#ddd4c5]/40',
              mobileSidebarOpen && 'rotate-180'
            )}
            onClick={onToggleMobileSidebar}
            aria-label="toggle-storyline"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
          </Button>
        )}
        {/* Desktop sidebar toggle - 仅桌面端显示 */}
        {!isMobile && (
          <button
            className="h-12 w-12 rounded-2xl backdrop-blur-[20px] bg-primary/10 hover:bg-primary/20 text-primary transition-all flex flex-shrink-0 items-center justify-center"
            onClick={onToggleSidebar}
          >
            {!sidebarCollapsed ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            )}
          </button>
        )}
        {/* Character avatar and name */}
        <div className="w-10 h-10 rounded-2xl overflow-hidden flex-shrink-0">
          {selectedCharacter.avatar ? (
            <img src={selectedCharacter.avatar} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="w-6 h-6 text-gray-400 dark:text-gray-500">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
              </svg>
            </div>
          )}
        </div>
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-white">{selectedCharacter.name}</h2>
        </div>
      </div>

      {/* Right side actions */}
      <div className={cn(isMobile ? 'pointer-events-auto flex items-center gap-1' : 'relative z-10 flex items-center gap-1')}>
        {/* Model selector icon button */}
        <ModelSelector
          models={models}
          currentModel={selectedModel}
          onSelect={onSelectModel}
          triggerStyle="icon"
          size="sm"
          theme={isDark ? 'dark' : 'light'}
          mobileIconClassName={isMobile ? '!h-10 !w-10 !bg-transparent !shadow-none' : undefined}
        />

        {/* Preset selector + params panel（仅保留面板，删除 compact 触发按钮）*/}
        <div className="relative">
          <GenerationParamsPanel
            currentPreset={currentPreset}
            onPresetChange={setCurrentPreset}
            theme={isDark ? 'dark' : 'light'}
            open={showPresetPanel}
            onClose={() => setShowPresetPanel(false)}
          />
        </div>

        {/* More options menu / Delete mode button */}
        {isMixedDeleteMode ? (
          <div className="flex items-center gap-1">
            <button
              className={cn(
                "transition-all inline-flex items-center justify-center gap-1.5 text-sm font-medium backdrop-blur-[20px]",
                isMobile
                  ? "h-10 px-3 rounded-full"
                  : "h-12 px-3 rounded-2xl",
                (selectedWholeMessages.size > 0 || selectedMessageParts.size > 0)
                  ? "bg-red-500/90 hover:bg-red-600 text-white"
                  : "bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] text-muted-foreground"
              )}
              onClick={async () => {
                if (selectedWholeMessages.size > 0 || selectedMessageParts.size > 0) {
                  await onMixedDelete();
                }
              }}
              disabled={selectedWholeMessages.size === 0 && selectedMessageParts.size === 0}
            >
              <Trash2Icon />
              {(selectedWholeMessages.size > 0 || selectedMessageParts.size > 0)
                ? (t.delete_selected_items || '删除选中')
                : (t.select_to_delete || '选择删除')}
            </button>
            <button
              className={cn(
                "backdrop-blur-[20px] bg-transparent hover:bg-[#FFFAFA]/30 dark:hover:bg-white/[0.05] transition-all inline-flex items-center justify-center",
                isMobile ? "!h-10 !w-10 rounded-full" : "h-12 w-12 rounded-2xl"
              )}
              onClick={onExitDeleteMode}
              title={t.cancel_select_mode || '退出删除模式'}
            >
              <XIcon />
            </button>
          </div>
        ) : (
          <ChatMoreMenu {...moreMenuProps} mobileButtonClassName={isMobile ? '!h-10 !w-10 rounded-full' : undefined} />
        )}
      </div>
      </div>
    </header>
  );
}

function Trash2Icon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  );
}

function XIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

export default ChatHeader;
