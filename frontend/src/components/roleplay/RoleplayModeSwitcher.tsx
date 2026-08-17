/**
 * 角色扮演模式切换组件
 * 支持在iframe模式和原生模式之间切换
 */

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { SillyTavernIframe } from '@/components/sillytavern/SillyTavernIframe';
import { NativeRoleplayChat } from './NativeRoleplayChat';
import type { Character, CharacterChatMessage, CharacterChatSession, User } from '@/types';

// ============================================================
// 组件属性
// ============================================================

export interface RoleplayModeSwitcherProps {
  character: Character;
  session: CharacterChatSession | null;
  messages: CharacterChatMessage[];
  user: User;
  isGenerating: boolean;
  onSendMessage: (content: string, images?: string[]) => Promise<string | null>;
  onStopGeneration: () => void;
  onEditMessage: (messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  className?: string;
}

// ============================================================
// 模式类型
// ============================================================

type RoleplayMode = 'iframe' | 'native';

// ============================================================
// RoleplayModeSwitcher 组件
// ============================================================

export function RoleplayModeSwitcher({
  character,
  session,
  messages,
  user,
  isGenerating,
  onSendMessage,
  onStopGeneration,
  onEditMessage,
  onDeleteMessage,
  className,
}: RoleplayModeSwitcherProps) {
  const [mode, setMode] = useState<RoleplayMode>(() => {
    // 从localStorage读取用户偏好
    const saved = localStorage.getItem('palink_roleplay_mode');
    return (saved === 'native' || saved === 'iframe') ? saved : 'iframe';
  });

  // 切换模式
  const handleModeSwitch = useCallback((newMode: RoleplayMode) => {
    setMode(newMode);
    localStorage.setItem('palink_roleplay_mode', newMode);
    toast.success(`已切换到${newMode === 'iframe' ? 'iframe' : '原生'}模式`);
  }, []);

  // 渲染模式切换按钮
  const renderModeSwitcher = () => {
    return (
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => handleModeSwitch('iframe')}
          className={`px-3 py-1 rounded-lg text-sm ${
            mode === 'iframe'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground'
          }`}
        >
          iframe模式
        </button>
        <button
          onClick={() => handleModeSwitch('native')}
          className={`px-3 py-1 rounded-lg text-sm ${
            mode === 'native'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground'
          }`}
        >
          原生模式
        </button>
      </div>
    );
  };

  // 渲染内容
  const renderContent = () => {
    if (mode === 'iframe') {
      return (
        <SillyTavernIframe
          character={character}
          messages={messages}
          user={user}
          sessionId={session?.id}
          onSendMessage={onSendMessage}
          isGenerating={isGenerating}
        />
      );
    }

    return (
      <NativeRoleplayChat
        character={character}
        session={session}
        messages={messages}
        user={user}
        isGenerating={isGenerating}
        onSendMessage={onSendMessage}
        onStopGeneration={onStopGeneration}
        onEditMessage={onEditMessage}
        onDeleteMessage={onDeleteMessage}
      />
    );
  };

  return (
    <div className={`flex flex-col h-full ${className || ''}`}>
      {renderModeSwitcher()}
      <div className="flex-1">
        {renderContent()}
      </div>
    </div>
  );
}

export default RoleplayModeSwitcher;
