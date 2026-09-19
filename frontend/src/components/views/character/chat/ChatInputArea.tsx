/**
 * ChatInputArea — 聊天输入区域
 * 从 CharacterChat 提取的输入区域组件，统一处理移动端和桌面端
 */
import React from 'react';
import { createPortal } from 'react-dom';
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
  // 移动端故事线侧栏展开时，输入框与正文/dock 同步右移 80vw（默认收起）
  mobileSidebarOpen?: boolean;
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
  mobileSidebarOpen = false,
}: ChatInputAreaProps) {
  // 键盘未弹起时输入框停在 dock 栏上方；弹起后 dock 隐藏。
  const cssDockHeight = typeof getComputedStyle !== 'undefined'
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--palink-dock-height') || '90', 10)
    : 90;
  const mobileComposerClosedBottomPx = composerBottomPx > 0 ? composerBottomPx : cssDockHeight;
  // 【K13 原始基线】不做任何 JS 抬升：关闭态停在 dock 上方；聚焦后由纯 CSS
  // （index.css :has(:focus)）落到最底 bottom:0，之后交给系统原生行为。
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
    // 【关键】fixed + Portal 到 document.body：
    // iOS 26/27 键盘弹起只缩 visual viewport、layout viewport 不变（WebKit
    // Bug 304976），fixed bottom:0 不再被系统顶起 —— 位置完全由 JS 写入的
    // --palink-kb-vh 决定（K9 一步到位，无过渡）。
    // Portal 到 body 是为了逃离 MobilePager 槽位的 transform/will-change
    // 包含块（否则 fixed 会锚到槽位而不是视口），同时使
    // index.css 的 body > [data-palink-chat-composer] 抬升规则命中本元素
    // （对话主页的嵌套 composer 被该选择器排除）。
    const mobileComposer = (
      <div
        data-palink-chat-composer="true"
        className={cn(
          'fixed left-0 right-0 z-[20] px-3 pt-2',
          'bg-gradient-to-t from-transparent via-transparent to-transparent'
        )}
        style={{
          bottom: mobileComposerBottom,
          // 故事线侧栏展开：正文右移 80%、dock 右移 80vw，输入框同为 body 内
          // fixed 元素，需手动平移 80vw 并沿用同一条 300ms 曲线，三者同步右移
          // 【K19】此元素不得挂 animate-chat-input-appear：该动画 forwards fill 的
          // transform 会永久覆盖本 inline transform（CSS 动画 > 内联样式），
          // 侧栏展开后输入框停在原地——2026-09-03 真机+浏览器实测根因。
          // 入场动画移到内层 div（两层 transform 可叠加）。
          transform: mobileSidebarOpen ? 'translate3d(80vw, 0, 0)' : 'translate3d(0, 0, 0)',
          transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div className="mx-auto max-w-3xl animate-chat-input-appear">
          {/* 移动端"新对话"按钮已按用户要求移除（2026-08-30）：入口与桌面 Dock/侧栏重复，
              且遮挡输入区左侧。桌面端按钮保留（[TAG:DESKTOP-DO-NOT-TOUCH] 范围）。 */}
          <ChatInput
            {...chatInputProps}
          />
        </div>
      </div>
    );
    return createPortal(mobileComposer, document.body);
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
