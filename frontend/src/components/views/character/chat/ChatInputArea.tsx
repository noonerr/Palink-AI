/**
 * ChatInputArea — 聊天输入区域
 * 从 CharacterChat 提取的输入区域组件，统一处理移动端和桌面端
 */
import React from 'react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import type { Character } from '@/types';

const MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX = 92;
const MOBILE_CHAT_INPUT_GAP_PX = 20;

export interface ChatInputAreaProps {
  isMobile: boolean;
  isDark: boolean;
  isGenerating: boolean;
  isKeyboardOpen: boolean;
  composerBottomPx: number;
  keyboardHeight: number;
  // 输入
  inputValue: string;
  setInputValue: (v: string) => void;
  attachments: any[];
  onRemoveAttachment: (idx: number) => void;
  uploading: boolean;
  onUpload: (file: File, type: 'image' | 'file') => Promise<void>;
  onSend: () => Promise<void>;
  onStop: () => void;
  onNewSession: () => void;
  // 角色
  character: Character;
  t: Record<string, string>;
}

export function ChatInputArea({
  isMobile,
  isDark,
  isGenerating,
  isKeyboardOpen,
  composerBottomPx,
  keyboardHeight,
  inputValue,
  setInputValue,
  attachments,
  onRemoveAttachment,
  uploading,
  onUpload,
  onSend,
  onStop,
  onNewSession,
  character,
  t,
}: ChatInputAreaProps) {
  // iOS WebApp 忽略 interactive-widget=overlays-content，键盘弹出时视口自动缩小
  // （nav 已被推到键盘上方），因此输入框始终用 CSS 变量定位在 nav 上方，
  // 不需要额外加 keyboardHeight（否则会双重偏移，输入框离 nav 很远）
  const cssDockHeight = typeof getComputedStyle !== 'undefined'
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--palink-dock-height') || '90', 10)
    : 90;
  const mobileComposerClosedBottomPx = composerBottomPx > 0 ? composerBottomPx : cssDockHeight;
  // 始终用 CSS var()，让浏览器实时读取 --palink-dock-height（由 MobileBottomNav 写入）
  const mobileComposerBottom = `var(--palink-dock-height, ${mobileComposerClosedBottomPx}px)`;

  const placeholder = t.chat_with_character
    ? t.chat_with_character.replace('{name}', character.name)
    : `与${character.name}对话...`;

  const newConversationButton = (
    <button
      type="button"
      className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      onClick={onNewSession}
      title={t.new_conversation || '新对话'}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14"/><path d="M5 12h14"/>
      </svg>
    </button>
  );

  const chatInputProps = {
    value: inputValue,
    onChange: setInputValue,
    onSend: onSend,
    onUpload: onUpload,
    attachments,
    onRemoveAttachment,
    disabled: isGenerating,
    uploading,
    placeholder,
    streaming: isGenerating,
    onStop,
    variant: 'mobile-demo' as const,
    theme: (isDark ? 'dark' : 'light') as 'dark' | 'light',
  };

  // 移动端
  if (isMobile) {
    return (
      <div
        data-palink-chat-composer="true"
        className={cn(
          'fixed left-0 right-0 z-[20] px-3 pt-2 animate-chat-input-appear',
          'bg-gradient-to-t from-transparent via-transparent to-transparent'
        )}
        style={{ bottom: mobileComposerBottom }}
      >
        <div className="mx-auto max-w-3xl">
          <ChatInput
            {...chatInputProps}
            leadingAction={newConversationButton}
          />
        </div>
      </div>
    );
  }

  // 桌面端
  // [TAG:DESKTOP-DO-NOT-TOUCH] 整个桌面端暂不重构，等用户说"重构桌面端"后再改
  return (
    <div data-palink-chat-composer="true" className="px-4 pt-[7px] backdrop-blur-[20px]">
      <div className="flex gap-2 overflow-visible items-center min-h-[58px] rounded-[28px] px-3 py-2.5 backdrop-blur-2xl border border-[#ddd4c5] bg-[#FFFAFA] shadow-[0_10px_28px_rgba(120,106,79,0.14)] dark:border-slate-700/80 dark:bg-[#23283c] dark:shadow-[0_12px_30px_rgba(2,6,23,0.45)]">
        {newConversationButton}
        <div className="flex-1">
          <ChatInput
            {...chatInputProps}
            noContainerStyle
          />
        </div>
      </div>
    </div>
  );
}

export { MOBILE_CHAT_INPUT_ESTIMATED_HEIGHT_PX, MOBILE_CHAT_INPUT_GAP_PX };

export default ChatInputArea;
