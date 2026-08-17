/**
 * ChatEmptyState — 聊天空状态
 * 从 CharacterChat 提取的空状态组件（无会话时的欢迎页）
 */
import React from 'react';
import { Play, BookOpen, X, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Character } from '@/types';

export interface ChatEmptyStateProps {
  character: Character;
  isMobile: boolean;
  isDark: boolean;
  isKeyboardOpen: boolean;
  composerBottomPx: number;
  showDesktopHint: boolean;
  initializingChat: boolean;
  t: Record<string, string>;
  onDismissDesktopHint: () => void;
  onShowWorldBookManager: () => void;
  onStartConversation: () => void;
}

export function ChatEmptyState({
  character,
  isMobile,
  isDark,
  isKeyboardOpen,
  composerBottomPx,
  showDesktopHint,
  initializingChat,
  t,
  onDismissDesktopHint,
  onShowWorldBookManager,
  onStartConversation,
}: ChatEmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
      <div
        className="w-full max-w-2xl flex flex-col items-center animate-fade-in-up"
        style={isMobile ? { paddingBottom: isKeyboardOpen ? 0 : (composerBottomPx > 0 ? `${composerBottomPx}px` : undefined) } : undefined}
      >
        {isMobile && <div style={{ height: 'calc(env(safe-area-inset-top) + 3.5rem)', width: '100%' }} />}
        {isMobile && showDesktopHint && (
          <div className={cn(
            'w-full mb-4 px-4 py-3 rounded-xl border text-sm flex items-start gap-3',
            isDark
              ? 'bg-blue-950/30 border-blue-800/50 text-blue-200'
              : 'bg-blue-50 border-blue-200 text-blue-800'
          )}>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <div className="flex-1">
              <p className="font-medium mb-1">移动端窄屏模式</p>
              <p className="text-xs opacity-80">
                当前为移动端优化布局。如需更完整的宽屏体验（如侧边栏故事线），建议使用电脑端浏览器访问。
              </p>
            </div>
            <button
              onClick={onDismissDesktopHint}
              className="flex-shrink-0 p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="mb-6 sm:mb-10 text-center">
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-primary/20 to-primary/5 rounded-3xl mx-auto flex items-center justify-center text-5xl mb-4 sm:mb-6 shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
            {character.avatar ? (
              <img src={character.avatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="w-16 h-16 sm:w-20 sm:h-20 text-gray-400 dark:text-gray-500">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
              </svg>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold mb-2">{character.name}</h1>
          <p className="text-muted-foreground text-sm sm:text-base">{t.start_roleplay_hint || '开始与这个角色对话吧！'}</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            className={cn(
              'inline-flex items-center gap-1.5 text-sm font-medium rounded-2xl px-3 py-1.5 border backdrop-blur-[20px] transition-all',
              character.has_character_book
                ? 'border-amber-400/50 bg-amber-50/60 text-amber-700 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300'
                : 'border-[#d9cfbf]/50 bg-[#FFFAFA]/40 text-slate-700 dark:border-white/[0.15] dark:bg-white/[0.07] dark:text-white/80'
            )}
            onClick={onShowWorldBookManager}
          >
            <BookOpen size={14} />
            {character.has_character_book
              ? (t.view_character_book || '查看角色书')
              : (t.manage_worldbook || '管理世界书')}
          </button>
        </div>
        <div className="mt-4">
          <button
            className={cn(
              'inline-flex items-center justify-center gap-2 text-base font-medium rounded-2xl h-12 px-8 border backdrop-blur-[20px] transition-all',
              'bg-slate-900/80 dark:bg-white/80 text-white dark:text-slate-900 border-slate-700/30 dark:border-white/20',
              'hover:bg-slate-800/90 dark:hover:bg-white/90 active:scale-[0.98]'
            )}
            onClick={onStartConversation}
            disabled={initializingChat}
          >
            {initializingChat ? (
              <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Play size={20} />
            )}
            {t.start_conversation || '开始对话'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatInitializingState({
  isMobile,
  isKeyboardOpen,
  composerBottomPx,
  t,
}: {
  isMobile: boolean;
  isKeyboardOpen: boolean;
  composerBottomPx: number;
  t: Record<string, string>;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 w-full overflow-y-auto">
      <div
        className="w-full flex flex-col items-center animate-fade-in-up"
        style={isMobile ? { paddingBottom: isKeyboardOpen ? 0 : (composerBottomPx > 0 ? `${composerBottomPx}px` : undefined) } : undefined}
      >
        {isMobile && <div style={{ height: 'calc(env(safe-area-inset-top) + 3.5rem)', width: '100%' }} />}
        <div className="animate-spin text-primary mb-4"><Bot size={32} /></div>
        <p className="text-muted-foreground">{t.loading_conversation || '正在加载对话...'}</p>
      </div>
    </div>
  );
}

export default ChatEmptyState;
