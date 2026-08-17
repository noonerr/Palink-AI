/**
 * SillyTavern UI - 主布局组件
 * 复刻 SillyTavern 的完整 UI 布局
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { 
  MessageSquare, Users, BookOpen, Settings, Sliders, 
  ChevronLeft, ChevronRight, Plus, Search, MoreVertical,
  Bot, User, Send, Paperclip, Mic, Image, Volume2,
  Bookmark, Star, Copy, Trash2, Edit, RefreshCw,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen
} from 'lucide-react';
import type { Character, CharacterChatSession, CharacterChatMessage, User as UserType } from '@/types';

// ============================================================
// 类型定义
// ============================================================

export interface SillyTavernUILayoutProps {
  character: Character;
  session: CharacterChatSession | null;
  messages: CharacterChatMessage[];
  user: UserType;
  isGenerating: boolean;
  onSendMessage: (content: string, images?: string[]) => Promise<void>;
  onStopGeneration: () => void;
  onEditMessage: (messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onSwipeMessage?: (messageId: string, direction: 'left' | 'right') => void;
  className?: string;
}

type LeftPanelTab = 'characters' | 'chats' | 'groups';
type RightPanelTab = 'character' | 'worldbook' | 'extensions' | 'regex' | 'settings';

// ============================================================
// SillyTavernUILayout 组件
// ============================================================

export function SillyTavernUILayout({
  character,
  session,
  messages,
  user,
  isGenerating,
  onSendMessage,
  onStopGeneration,
  onEditMessage,
  onDeleteMessage,
  onSwipeMessage,
  className,
}: SillyTavernUILayoutProps) {
  const isMobile = useIsMobile();
  const [leftPanelOpen, setLeftPanelOpen] = useState(!isMobile);
  const [rightPanelOpen, setRightPanelOpen] = useState(!isMobile);
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>('chats');
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('character');
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 发送消息
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isGenerating) return;
    const content = inputValue.trim();
    setInputValue('');
    await onSendMessage(content);
  }, [inputValue, isGenerating, onSendMessage]);

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className={cn('flex h-full bg-background text-foreground', className)}>
      {/* ──── 左侧面板 ──── */}
      {!isMobile && (
        <div
          className={cn(
            'flex flex-col border-r border-border transition-all duration-300',
            leftPanelOpen ? 'w-64' : 'w-0 overflow-hidden'
          )}
        >
          {/* 左侧面板头部 */}
          <div className="flex items-center justify-between p-2 border-b border-border">
            <div className="flex gap-1">
              <button
                onClick={() => setLeftPanelTab('characters')}
                className={cn(
                  'p-1.5 rounded text-xs',
                  leftPanelTab === 'characters' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                )}
              >
                <Bot size={14} />
              </button>
              <button
                onClick={() => setLeftPanelTab('chats')}
                className={cn(
                  'p-1.5 rounded text-xs',
                  leftPanelTab === 'chats' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                )}
              >
                <MessageSquare size={14} />
              </button>
              <button
                onClick={() => setLeftPanelTab('groups')}
                className={cn(
                  'p-1.5 rounded text-xs',
                  leftPanelTab === 'groups' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                )}
              >
                <Users size={14} />
              </button>
            </div>
            <button className="p-1 hover:bg-accent rounded">
              <Plus size={14} />
            </button>
          </div>

          {/* 搜索栏 */}
          <div className="p-2">
            <div className="flex items-center gap-2 px-2 py-1 bg-muted rounded">
              <Search size={14} className="text-muted-foreground" />
              <input
                type="text"
                placeholder="搜索..."
                className="flex-1 bg-transparent text-sm outline-none"
              />
            </div>
          </div>

          {/* 列表内容 */}
          <div className="flex-1 overflow-y-auto p-2">
            {leftPanelTab === 'characters' && (
              <div className="space-y-1">
                {/* 角色列表 */}
                <div className="flex items-center gap-2 p-2 rounded bg-accent">
                  <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center">
                    {character.avatar ? (
                      <img src={character.avatar} alt="" className="w-full h-full rounded object-cover" />
                    ) : (
                      <Bot size={16} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{character.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{character.description?.slice(0, 30)}</div>
                  </div>
                </div>
              </div>
            )}

            {leftPanelTab === 'chats' && (
              <div className="space-y-1">
                {/* 聊天历史 */}
                <div className="flex items-center gap-2 p-2 rounded bg-accent">
                  <MessageSquare size={14} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{session?.title || '新对话'}</div>
                    <div className="text-xs text-muted-foreground">{messages.length} 条消息</div>
                  </div>
                </div>
              </div>
            )}

            {leftPanelTab === 'groups' && (
              <div className="text-center text-muted-foreground text-sm py-4">
                暂无群聊
              </div>
            )}
          </div>
        </div>
      )}

      {/* ──── 中间主区域 ──── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ──── 顶部栏 ──── */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            {!isMobile && (
              <button
                onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                className="p-1 hover:bg-accent rounded"
              >
                {leftPanelOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              </button>
            )}
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center">
                {character.avatar ? (
                  <img src={character.avatar} alt="" className="w-full h-full rounded object-cover" />
                ) : (
                  <Bot size={16} />
                )}
              </div>
              <div>
                <div className="text-sm font-medium">{character.name}</div>
                <div className="text-xs text-muted-foreground">
                  {isGenerating ? '生成中...' : `${messages.length} 条消息`}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* 模型选择 */}
            <button className="px-2 py-1 text-xs bg-muted rounded hover:bg-accent">
              模型
            </button>
            {/* 预设选择 */}
            <button className="px-2 py-1 text-xs bg-muted rounded hover:bg-accent">
              预设
            </button>
            {/* 参数设置 */}
            <button className="p-1 hover:bg-accent rounded">
              <Sliders size={14} />
            </button>
            {/* 更多选项 */}
            <button className="p-1 hover:bg-accent rounded">
              <MoreVertical size={14} />
            </button>
            {!isMobile && (
              <button
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                className="p-1 hover:bg-accent rounded"
              >
                {rightPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </button>
            )}
          </div>
        </div>

        {/* ──── 消息区域 ──── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-primary/10 flex items-center justify-center">
                  {character.avatar ? (
                    <img src={character.avatar} alt="" className="w-full h-full rounded-2xl object-cover" />
                  ) : (
                    <Bot size={40} className="text-primary" />
                  )}
                </div>
                <h2 className="text-xl font-semibold mb-2">{character.name}</h2>
                <p className="text-muted-foreground text-sm max-w-md">
                  {character.description?.slice(0, 100) || '开始与这个角色对话吧！'}
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div
                key={msg.id || index}
                className={cn(
                  'flex gap-3 group',
                  msg.is_user ? 'flex-row-reverse' : 'flex-row'
                )}
              >
                {/* 头像 */}
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                    {msg.is_user ? (
                      user.avatar ? (
                        <img src={user.avatar} alt="" className="w-full h-full rounded-lg object-cover" />
                      ) : (
                        <User size={20} />
                      )
                    ) : (
                      character.avatar ? (
                        <img src={character.avatar} alt="" className="w-full h-full rounded-lg object-cover" />
                      ) : (
                        <Bot size={20} />
                      )
                    )}
                  </div>
                </div>

                {/* 消息内容 */}
                <div className={cn('flex-1 max-w-[70%]', msg.is_user ? 'text-right' : 'text-left')}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">
                      {msg.is_user ? user.username : character.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : ''}
                    </span>
                  </div>
                  <div
                    className={cn(
                      'p-3 rounded-lg text-sm whitespace-pre-wrap',
                      msg.is_user
                        ? 'bg-primary text-primary-foreground ml-auto'
                        : 'bg-muted'
                    )}
                  >
                    {msg.content}
                  </div>

                  {/* 消息操作按钮 */}
                  <div className={cn(
                    'flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity',
                    msg.is_user ? 'justify-end' : 'justify-start'
                  )}>
                    {onSwipeMessage && (
                      <>
                        <button
                          onClick={() => onSwipeMessage(String(msg.id), 'left')}
                          className="p-1 hover:bg-accent rounded"
                          title="上一个回复"
                        >
                          <ChevronLeft size={12} />
                        </button>
                        <button
                          onClick={() => onSwipeMessage(String(msg.id), 'right')}
                          className="p-1 hover:bg-accent rounded"
                          title="下一个回复"
                        >
                          <ChevronRight size={12} />
                        </button>
                      </>
                    )}
                    <button className="p-1 hover:bg-accent rounded" title="复制">
                      <Copy size={12} />
                    </button>
                    <button className="p-1 hover:bg-accent rounded" title="编辑">
                      <Edit size={12} />
                    </button>
                    <button className="p-1 hover:bg-accent rounded" title="书签">
                      <Bookmark size={12} />
                    </button>
                    <button className="p-1 hover:bg-accent rounded" title="重新生成">
                      <RefreshCw size={12} />
                    </button>
                    <button
                      onClick={() => onDeleteMessage(String(msg.id))}
                      className="p-1 hover:bg-accent rounded text-destructive"
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* ──── 输入区域 ──── */}
        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <button className="p-2 hover:bg-accent rounded" title="附件">
              <Paperclip size={18} />
            </button>
            <button className="p-2 hover:bg-accent rounded" title="图片">
              <Image size={18} />
            </button>
            <div className="flex-1 relative">
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`发送消息给 ${character.name}...`}
                disabled={isGenerating}
                className="w-full resize-none rounded-lg border border-border bg-background p-3 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                rows={1}
                style={{ minHeight: '44px', maxHeight: '120px' }}
              />
            </div>
            <button className="p-2 hover:bg-accent rounded" title="语音">
              <Mic size={18} />
            </button>
            <button className="p-2 hover:bg-accent rounded" title="TTS">
              <Volume2 size={18} />
            </button>
            {isGenerating ? (
              <button
                onClick={onStopGeneration}
                className="p-2 bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90"
              >
                停止
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputValue.trim()}
                className="p-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ──── 右侧面板 ──── */}
      {!isMobile && (
        <div
          className={cn(
            'flex flex-col border-l border-border transition-all duration-300',
            rightPanelOpen ? 'w-80' : 'w-0 overflow-hidden'
          )}
        >
          {/* 右侧面板标签 */}
          <div className="flex items-center border-b border-border">
            <button
              onClick={() => setRightPanelTab('character')}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium text-center',
                rightPanelTab === 'character' ? 'border-b-2 border-primary' : 'hover:bg-accent'
              )}
            >
              角色
            </button>
            <button
              onClick={() => setRightPanelTab('worldbook')}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium text-center',
                rightPanelTab === 'worldbook' ? 'border-b-2 border-primary' : 'hover:bg-accent'
              )}
            >
              世界书
            </button>
            <button
              onClick={() => setRightPanelTab('extensions')}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium text-center',
                rightPanelTab === 'extensions' ? 'border-b-2 border-primary' : 'hover:bg-accent'
              )}
            >
              扩展
            </button>
            <button
              onClick={() => setRightPanelTab('regex')}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium text-center',
                rightPanelTab === 'regex' ? 'border-b-2 border-primary' : 'hover:bg-accent'
              )}
            >
              正则
            </button>
            <button
              onClick={() => setRightPanelTab('settings')}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium text-center',
                rightPanelTab === 'settings' ? 'border-b-2 border-primary' : 'hover:bg-accent'
              )}
            >
              设置
            </button>
          </div>

          {/* 右侧面板内容 */}
          <div className="flex-1 overflow-y-auto p-3">
            {rightPanelTab === 'character' && (
              <div className="space-y-4">
                {/* 角色头像 */}
                <div className="flex justify-center">
                  <div className="w-24 h-24 rounded-xl bg-primary/20 flex items-center justify-center">
                    {character.avatar ? (
                      <img src={character.avatar} alt="" className="w-full h-full rounded-xl object-cover" />
                    ) : (
                      <Bot size={48} className="text-primary" />
                    )}
                  </div>
                </div>

                {/* 角色信息 */}
                <div className="text-center">
                  <h3 className="text-lg font-semibold">{character.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{character.description}</p>
                </div>

                {/* 角色属性 */}
                <div className="space-y-2">
                  <div className="p-2 bg-muted rounded">
                    <div className="text-xs font-medium mb-1">性格</div>
                    <div className="text-sm">{character.personality || '未设置'}</div>
                  </div>
                  <div className="p-2 bg-muted rounded">
                    <div className="text-xs font-medium mb-1">场景</div>
                    <div className="text-sm">{character.scenario || '未设置'}</div>
                  </div>
                  <div className="p-2 bg-muted rounded">
                    <div className="text-xs font-medium mb-1">开场白</div>
                    <div className="text-sm">{character.first_mes || '未设置'}</div>
                  </div>
                </div>
              </div>
            )}

            {rightPanelTab === 'worldbook' && (
              <div className="text-center text-muted-foreground text-sm py-4">
                <BookOpen size={32} className="mx-auto mb-2" />
                <p>世界书管理</p>
                <p className="text-xs mt-1">添加条目以增强角色记忆</p>
              </div>
            )}

            {rightPanelTab === 'extensions' && (
              <div className="text-center text-muted-foreground text-sm py-4">
                <Settings size={32} className="mx-auto mb-2" />
                <p>扩展管理</p>
                <p className="text-xs mt-1">安装和管理扩展插件</p>
              </div>
            )}

            {rightPanelTab === 'regex' && (
              <div className="text-center text-muted-foreground text-sm py-4">
                <RefreshCw size={32} className="mx-auto mb-2" />
                <p>正则脚本</p>
                <p className="text-xs mt-1">管理文本替换规则</p>
              </div>
            )}

            {rightPanelTab === 'settings' && (
              <div className="space-y-4">
                <div className="p-2 bg-muted rounded">
                  <div className="text-xs font-medium mb-2">模型参数</div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Temperature</span>
                      <span className="text-sm text-muted-foreground">0.7</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Top P</span>
                      <span className="text-sm text-muted-foreground">0.9</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Max Tokens</span>
                      <span className="text-sm text-muted-foreground">2048</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
