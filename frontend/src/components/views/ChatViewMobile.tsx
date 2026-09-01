import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, X, Edit3, Trash2, Menu, Globe, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/custom/ConfirmDialog';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { Message } from '@/components/ui/custom/Message';
import { ChatInput } from '@/components/ui/custom/ChatInput';
import { ChatSessionList } from '@/components/ui/custom/ChatSessionList';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import type { Model } from '@/types';
import { useChatView } from '@/hooks/useChatView';
import { useMobileChatAnimations } from '@/hooks/useMobileChatAnimations';
import { useMobileKeyboardAdapter } from '@/hooks/useMobileKeyboardAdapter';

interface ChatViewProps {
  token: string;
  user: { avatar?: string; username: string };
  models: Model[];
  currentModel: string;
  setCurrentModel: (modelId: string) => void;
  t: Record<string, string>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  isDark?: boolean;
  isKeyboardOpen?: boolean;
  showModelReasoning?: boolean;
}

export function ChatViewMobile({
  user,
  models,
  currentModel,
  setCurrentModel,
  t,
  sidebarCollapsed,
  setSidebarCollapsed,
  isDark = false,
  isKeyboardOpen = false,
  showModelReasoning = true,
}: ChatViewProps) {
  const chat = useChatView({ currentModel, t });
  const anim = useMobileChatAnimations(chat.activeSessionId, chat.messages);
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
  const [composerBottomLockPx, setComposerBottomLockPx] = useState<number | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchAvailable, setWebSearchAvailable] = useState(true);
  const kb = useMobileKeyboardAdapter({
    isKeyboardOpen,
    displayWelcome: anim.displayWelcome,
    messagesLength: chat.messages.length,
    streaming: chat.streaming,
    hasSentFirstMessage,
    composerBottomLockPx,
  });

  const historyOpen = !sidebarCollapsed;
  const displayedSuggestions = anim.sessionVisualSnapshot ? [] : chat.suggestions;
  const hideBottomComposerDuringWelcomeDrop = anim.welcomeDropping && !anim.welcomeDropHandoffReady;
  const keepComposerVisualBright = anim.welcomeDropping || composerBottomLockPx !== null || chat.isSendingMessage;
  const getComposerTargetBottomPx = useCallback(() => {
    const cssDockHeight = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--palink-dock-height') || '90',
      10,
    );
    if (cssDockHeight > 0) return cssDockHeight;

    return kb.composerBottomOffset > 0 ? kb.composerBottomOffset : 90;
  }, [kb.composerBottomOffset]);

  // 【K9】对话主页按用户要求排除在键盘抬升方案之外：输入框恒在 dock 栏上方
  // （或欢迎动画期间的锁定值），键盘弹起时保持系统默认行为，不做 JS 抬升、
  // 不消费 --palink-kb-vh。键盘一步到位抬升仅角色聊天页（ChatInputArea）适用。
  const composerBottomStyle = composerBottomLockPx !== null
    ? `${kb.composerBottomOffset}px`
    : 'var(--palink-dock-height, 90px)';

  const handleSelectSession = (session: any) => {
    const sessionId = typeof session === 'string' ? session : session.id;
    setComposerBottomLockPx(null);
    anim.startSessionSwitchAnimation({
      activeSessionId: chat.activeSessionId,
      messages: chat.messages,
      historyOpen,
      onApplySwitch: async (id: string) => {
        chat.setActiveSessionId(id);
        await chat.loadMessages(id);
      },
      sessionId,
      setSidebarCollapsed,
      setHasSentFirstMessage: (v: boolean) => setHasSentFirstMessage(v),
      setMemoryStats: chat.setMemoryStats,
    });
  };

  const handleNewSession = () => {
    setComposerBottomLockPx(null);
    anim.startSessionSwitchAnimation({
      activeSessionId: chat.activeSessionId,
      messages: chat.messages,
      historyOpen,
      onApplySwitch: async () => {
        chat.setActiveSessionId(null);
        chat.setMessages([]);
        chat.setSuggestions([]);
      },
      sessionId: '__new__',
      setSidebarCollapsed,
      setHasSentFirstMessage: (v: boolean) => setHasSentFirstMessage(v),
      setMemoryStats: chat.setMemoryStats,
    });
  };

  const handleSend = async (overrideText?: string) => {
    const text = typeof overrideText === 'string' ? overrideText : chat.input;
    if ((!text.trim() && chat.attachments.length === 0) || chat.streaming || chat.uploading) return;

    const isFromWelcome = !chat.activeSessionId && chat.messages.length === 0 && !anim.welcomeDropping;

    if (isFromWelcome) {
      const switchToken = anim.sessionSwitchTokenRef.current + 1;
      const welcomeDropVisualTotalMs =
        anim.WELCOME_DROP_START_DELAY_MS + anim.WELCOME_DROP_DURATION_MS + anim.WELCOME_DROP_HANDOFF_HOLD_MS;
      const messageMountDelayMs = Math.max(
        0,
        anim.WELCOME_DROP_START_DELAY_MS + anim.WELCOME_DROP_HANDOFF_AT_MS - 80,
      );
      const targetBottomPx = getComposerTargetBottomPx();
      anim.sessionSwitchTokenRef.current = switchToken;
      anim.suppressSmoothScrollRef.current = true;
      setComposerBottomLockPx(targetBottomPx);

      setHasSentFirstMessage(true);
      chat.isAtBottomRef.current = true;
      kb.pendingInitialBottomLockRef.current = true;
      kb.initialBottomLockUntilRef.current = performance.now() + welcomeDropVisualTotalMs + 250;

      anim.setSessionVisualSnapshot(null);
      anim.setShowNewContentView(false);
      anim.setNewSessionFadeState('fading-in');
      anim.runWelcomeInputDropAnimation(text, {
        targetBottomPx,
      });

      window.setTimeout(() => {
        if (anim.sessionSwitchTokenRef.current === switchToken) {
          anim.setNewSessionFadeState('idle');
          anim.suppressSmoothScrollRef.current = false;
          setComposerBottomLockPx(null);
        }
      }, welcomeDropVisualTotalMs);

      await new Promise((resolve) => window.setTimeout(resolve, messageMountDelayMs));
      if (anim.sessionSwitchTokenRef.current !== switchToken) return;

      await chat.handleSend(text, webSearchEnabled, {
        streamStartDelayMs: Math.max(0, welcomeDropVisualTotalMs - messageMountDelayMs),
      });
      return;
    }

    setHasSentFirstMessage(true);
    await chat.handleSend(overrideText, webSearchEnabled);
    anim.suppressSmoothScrollRef.current = false;
  };

  const confirmDelete = async () => {
    const pending = chat.pendingDelete;
    const currentActiveId = chat.activeSessionId;
    const selected = chat.selectedSessions;
    await chat.confirmDelete();
    if (pending?.type === 'batch' && currentActiveId && selected.has(currentActiveId)) {
      setHasSentFirstMessage(false);
    } else if (pending?.type === 'single' && currentActiveId === (pending as { type: 'single'; id: string }).id) {
      setHasSentFirstMessage(false);
    }
  };

  const handleDeleteMessage = (messageId: string | number, messageIndex: number) => {
    chat.handleDeleteMessage(messageId as number, messageIndex);
  };

  useEffect(() => {
    api.get('/api/admin/web-search', { cacheTtlMs: 60_000 }).then((data: any) => {
      if (data && data.enabled === false) setWebSearchAvailable(false);
    }).catch(() => {});
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    chat.isAtBottomRef.current = distanceFromBottom < 120;
  }, [chat.isAtBottomRef]);

  useEffect(() => {
    const behavior: ScrollBehavior = chat.streaming || anim.welcomeDropping || anim.suppressSmoothScrollRef.current ? 'auto' : 'smooth';
    if (chat.isAtBottomRef.current) {
      chat.messagesEndRef.current?.scrollIntoView({ behavior });
    }
  }, [chat.messages, chat.streaming, anim.welcomeDropping, anim.suppressSmoothScrollRef, chat.isAtBottomRef, chat.messagesEndRef]);

  useEffect(() => {
    if (anim.displayWelcome || chat.messages.length === 0) {
      kb.pendingInitialBottomLockRef.current = false;
      return;
    }
    if (!kb.pendingInitialBottomLockRef.current) return;
    if (performance.now() >= kb.initialBottomLockUntilRef.current) {
      kb.pendingInitialBottomLockRef.current = false;
      return;
    }
    let rafA: number | null = null;
    let rafB: number | null = null;
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        chat.messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    });
    return () => {
      if (rafA !== null) cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [anim.displayWelcome, chat.messages.length, kb.messageBottomPaddingPx, chat.messagesEndRef, kb.initialBottomLockUntilRef, kb.pendingInitialBottomLockRef]);

  useEffect(() => {
    if (anim.isWelcome) {
      setComposerBottomLockPx(null);
      anim.resetWelcomeAnimation();
    }
  }, [anim.isWelcome, anim]);

  return (
    <>
      {/* 页面根不再自绘背景：移动端轨道的单一渐变垫在 pager 容器层（屏幕锚定，
          切换时背景零变化），此根保持透明、只负责文字基调色 */}
      <div className={cn('relative h-full overflow-hidden', isDark ? 'text-slate-100' : 'text-slate-900')}>

      <aside
        className={cn(
          'mobile-history-sidebar fixed inset-y-0 left-0 w-[80%] transform-gpu px-4 pb-4 pt-[env(safe-area-inset-top)] transition-transform ease-in-out',
          chat.showDeleteConfirm ? 'z-[31]' : 'z-[60]',
          isDark ? 'border-r border-slate-700/70 bg-[#020617]' : 'border-r border-[#ddd4c5] bg-[#F8FAFC]'
        )}
        style={{
          // 关闭态位移用自身宽度的 -100%（固定元素宽度=视口 80%，不再依赖 px 常数）
          transform: `translate3d(${historyOpen ? 0 : -100}%, 0, 0)`,
          transitionDuration: `${anim.HISTORY_SLIDE_DURATION_MS}ms`,
          // 与底部 dock / 正文右移共用同一条曲线（Tailwind ease-in-out），三者逐帧同步
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className={cn('mb-2 flex h-[60px] items-center justify-between', isDark ? 'border-b border-slate-700/70' : 'border-b border-[#ddd4c5]')}>
            <span className={cn('text-lg font-semibold', isDark ? 'text-white/95' : 'text-slate-800')}>
              {chat.isDeleteMode ? t.batch_manage : t.chat_history}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  // 新建对话：先退出删除模式（内部顺带清空选中态），再走统一的新会话动画
                  if (chat.isDeleteMode) {
                    chat.setIsDeleteMode(false);
                  }
                  handleNewSession();
                }}
                aria-label="new-session"
                title={t.new_chat || '新建对话'}
                className="!h-10 !w-10 rounded-full"
              >
                <Plus size={18} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (chat.isDeleteMode) {
                    if (chat.selectedSessions.size > 0) {
                      chat.handleBatchDelete();
                    } else {
                      chat.setIsDeleteMode(false);
                    }
                  } else {
                    chat.setIsDeleteMode(true);
                  }
                }}
                aria-label="toggle-delete-mode"
                className={cn(
                  '!h-10 !w-10 rounded-full',
                  chat.isDeleteMode && chat.selectedSessions.size > 0
                    ? 'text-red-500 bg-red-500/15 hover:bg-red-500/25 dark:text-red-400 dark:bg-red-500/20 dark:hover:bg-red-500/30'
                    : ''
                )}
              >
                {chat.isDeleteMode ? (chat.selectedSessions.size > 0 ? <Trash2 size={18} /> : <X size={18} />) : <Edit3 size={18} />}
              </Button>
            </div>
          </div>

          <ChatSessionList
            sessions={chat.sessions}
            activeSessionId={chat.activeSessionId}
            onSessionSelect={handleSelectSession}
            isDeleteMode={chat.isDeleteMode}
            setIsDeleteMode={chat.setIsDeleteMode}
            selectedSessions={chat.selectedSessions}
            toggleSessionSelect={chat.toggleSessionSelect}
            onBatchDelete={chat.handleBatchDelete}
            onNewSession={handleNewSession}
            onDeleteSession={chat.handleDeleteSession}
            showNewButton={true}
            showDeleteButton={false}
            showHeaderActions={false}
            t={t}
          />
        </div>
      </aside>

        <div
          className={cn(
            // 正文容器不再自绘背景（画布由 pager 容器层统一垫 #F8FAFC/#020617）
            'mobile-history-main absolute inset-0 z-10 flex h-full w-full flex-col overflow-visible transition-transform ease-in-out will-change-transform'
        )}
        style={{
          // 正文右移量 = 侧栏宽（自身宽 80%，与侧栏 w-[80%] 同步）
          transform: `translate3d(${historyOpen ? 80 : 0}%, 0, 0)`,
          transitionDuration: `${anim.HISTORY_SLIDE_DURATION_MS}ms`,
          // 与底部 dock / 侧栏滑入共用同一条曲线，三者逐帧同步
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        onClick={() => {
          if (historyOpen) {
            setSidebarCollapsed(true);
          }
        }}
      >
        <div
          id="mobile-chat-top-bar"
          ref={kb.mobileTopBarRef}
          className={cn(
            'absolute left-0 right-0 top-0 z-[18]'
          )}
          style={{ height: 'calc(env(safe-area-inset-top) + 3rem + 8px)' }}
        >
          {/* 毛玻璃层：底部更透明（羽化区拉长到45%），顶部不透明 */}
          <div
            className="absolute inset-0 z-0 pointer-events-none"
            style={{
              backdropFilter: 'blur(16px) saturate(160%)',
              WebkitBackdropFilter: 'blur(16px) saturate(160%)',
              // 底部更透明：background alpha 缓慢上升，mask 羽化区拉长到 45%
              backgroundImage: isDark
                ? 'linear-gradient(to top, rgba(20,20,30,0) 0%, rgba(20,20,30,0.04) 30%, rgba(20,20,30,0.15) 50%, rgba(20,20,30,0.35) 70%, rgba(20,20,30,0.65) 100%)'
                : 'linear-gradient(to top, rgba(255,255,255,0) 0%, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.35) 70%, rgba(255,255,255,0.65) 100%)',
              WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 15%, rgba(0,0,0,0.7) 30%, rgba(0,0,0,1) 45%, rgba(0,0,0,1) 100%)',
              maskImage: 'linear-gradient(to top, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 15%, rgba(0,0,0,0.7) 30%, rgba(0,0,0,1) 45%, rgba(0,0,0,1) 100%)',
            }}
          />
          {/* 分隔线：自身也做透明度渐变，底端淡顶端显 */}
          <div
            className="absolute left-0 right-0 bottom-0 z-[5] border-b border-border/40 pointer-events-none"
            style={{
              WebkitMaskImage: 'linear-gradient(to top, black 0%, black 20%, transparent 100%)',
              maskImage: 'linear-gradient(to top, black 0%, black 20%, transparent 100%)',
            }}
          />
          {/* 交互元素层：保持原排版不变 */}
          <div className="absolute inset-0 z-10 pointer-events-none px-5 pb-1 pt-[calc(env(safe-area-inset-top)+10px)]">
            <div className="mx-auto flex max-w-3xl items-center justify-between pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className={cn(
                  '!h-10 !w-10 rounded-full transition-all duration-300 ease-in-out',
                  historyOpen && 'rotate-180'
                )}
                data-history-toggle="true"
                aria-label="toggle-history"
              >
                <Menu size={20} />
              </Button>

              <div className="flex items-center gap-2">
                {webSearchAvailable && !anim.displayWelcome && (
                <button
                  onClick={() => setWebSearchEnabled(prev => !prev)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200',
                    webSearchEnabled
                      ? cn(
                          isDark
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                        )
                      : cn(
                          isDark
                            ? 'bg-slate-700/40 text-slate-400 border border-slate-600/30 hover:bg-slate-700/60'
                            : 'bg-gray-100/80 text-slate-500 border border-gray-200/50 hover:bg-gray-200/80'
                        )
                  )}
                >
                  <Globe size={12} className={cn('transition-colors', webSearchEnabled ? 'text-emerald-500' : '')} />
                  <span>{webSearchEnabled ? '搜索开' : '搜索关'}</span>
                </button>
              )}

              <ModelSelector
                models={models}
                currentModel={currentModel}
                onSelect={setCurrentModel}
                size="sm"
                triggerStyle="mobile-inline"
                theme={isDark ? 'dark' : 'light'}
              />
            </div>
          </div>
          </div>
        </div>

        <div className="relative flex flex-1 overflow-hidden">
          <div
            className={cn(
              'flex flex-col overflow-hidden transition-opacity ease-in-out',
              anim.newSessionFadeState === 'fading-out' ? 'opacity-0 w-full h-full' : 'opacity-100 w-full h-full'
            )}
            style={{
              transitionDuration: `${anim.NEW_SESSION_FADE_DURATION_MS}ms`,
              pointerEvents: anim.newSessionFadeState === 'fading-out' ? 'none' : 'auto'
            }}
          >
            <div className={cn('flex flex-1 flex-col overflow-hidden', anim.displayWelcome && 'items-center justify-center')}>
              {anim.displayWelcome ? (
                <div className="w-full max-w-md -translate-y-[10vh] px-5 text-center mx-auto">
                <h1 className={cn('text-3xl font-extrabold', isDark ? 'text-[#a8c8ff]' : 'text-slate-800')}>你好呀</h1>
                <p className={cn('mt-3 text-sm', isDark ? 'text-white/70' : 'text-slate-600')}>有什么问题，随时问 AI</p>

                {chat.developerMode && (
                  <p className={cn('mt-4 text-xs', isDark ? 'text-amber-200/90' : 'text-amber-700')}>开发者模式已开启：发送不会请求真实模型</p>
                )}

                <div ref={anim.welcomeComposerRef} className={cn('mx-auto mt-8 w-full', anim.welcomeDropAnimating && 'invisible')}>
                  <ChatInput
                    value={chat.input}
                    onChange={chat.setInput}
                    onSend={handleSend}
                    onUpload={chat.handleUpload}
                    attachments={chat.attachments}
                    onRemoveAttachment={(idx) => chat.setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    models={models}
                    currentModel={currentModel}
                    onModelChange={setCurrentModel}
                    disabled={chat.streaming || chat.isSendingMessage}
                    dimDisabled={!keepComposerVisualBright}
                    uploading={chat.uploading}
                    placeholder={t.ask_anything}
                    streaming={chat.streaming}
                    onStop={chat.handleStopStreaming}
                    variant="mobile-demo"
                    theme={isDark ? 'dark' : 'light'}
                    showModelSelector={true}
                    modelSelectorTriggerStyle="icon"
                    webSearchEnabled={webSearchEnabled}
                    onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                    showWebSearch={webSearchAvailable}
                  />
                </div>
                </div>
              ) : (
          <>
            <div
              ref={kb.messagesScrollWrapRef}
              data-palink-msg-scroll="true"
              className="flex-1 min-h-0 overflow-y-auto"
              onScroll={handleScroll}
            >
              <div className="px-3 pb-4">
                <div
                  ref={kb.messageStackRef}
                  className="mx-auto w-[92%] max-w-[560px] space-y-6"
                  style={{ paddingBottom: `${kb.messageBottomPaddingPx}px` }}
                >
                  {/* 顶部安全空间：高度与 header 完全一致(env(safe-area-inset-top)+4.5rem+8px)，确保最上面的消息不被 header 挡住 */}
                  <div aria-hidden style={{ height: 'calc(env(safe-area-inset-top) + 3rem + 8px)', width: '100%' }} />
                  {anim.displayedMessages.map((msg, idx) => (
                    <div key={msg.id || idx} className="flex items-start gap-2" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 120px' }}>
                      <div className="flex-1">
                        <Message
                          message={msg}
                          userAvatar={user.avatar}
                          userName={user.username}
                          models={models}
                          streaming={(chat.streaming && idx === anim.displayedMessages.length - 1) || chat.regeneratingMessageIndex === idx}
                          isLast={idx === anim.displayedMessages.length - 1}
                          t={t}
                          tokens={msg.tokens}
                          memoryStats={chat.memoryMode === 'rule' && idx === anim.displayedMessages.length - 1 && msg.role === 'assistant' ? chat.memoryStats : null}
                          onCompress={chat.memoryMode === 'rule' && idx === anim.displayedMessages.length - 1 && msg.role === 'assistant' ? chat.manualCompressMemory : undefined}
                          compressing={chat.compressing}
                          onRegenerate={msg.role === 'assistant' && !chat.streaming ? () => chat.handleRegenerate(idx) : undefined}
                          canRegenerate={msg.role === 'assistant' && !chat.streaming}
                          onDelete={msg.id ? () => handleDeleteMessage(msg.id, idx) : undefined}
                          onEdit={msg.id ? (newContent: string) => chat.handleEditMessage(msg.id, idx, newContent) : undefined}
                          canEdit={msg.role === 'assistant' && !chat.streaming}
                          onGenerateImage={msg.id != null ? chat.handleGenerateImage : undefined}
                          isGeneratingImage={msg.id != null ? chat.generatingImageMessageIds.has(String(msg.id)) : false}
                          showSelect={false}
                          isCharacterChat={false}
                          memoryMode={chat.memoryMode}
                          showModelReasoning={showModelReasoning}
                        />
                      </div>
                    </div>
                  ))}

                  {chat.streamStatus === 'queued' && chat.queueInfo && (
                    <div className="flex items-center gap-3 pl-10 animate-fade-in-up">
                      <div className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm',
                        isDark
                          ? 'bg-amber-900/20 border border-amber-700/50 text-amber-300'
                          : 'bg-amber-50 border border-amber-200 text-amber-700'
                      )}>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>排队中 · 第 {chat.queueInfo.position + 1} 位</span>
                        {chat.queueInfo.estimatedWait > 0 && (
                          <span className={isDark ? 'text-amber-400' : 'text-amber-500'}>· 预计 {Math.ceil(chat.queueInfo.estimatedWait)}s</span>
                        )}
                      </div>
                    </div>
                  )}

                  {displayedSuggestions.length > 0 && !chat.streaming && (
                    <div className="flex flex-wrap gap-2 pl-10 animate-fade-in-up">
                      {displayedSuggestions.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSend(s)}
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            isDark
                              ? 'border-slate-600/80 bg-[#2b314c] text-slate-100 hover:bg-[#363d5c]'
                              : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f8f2e8]'
                          )}
                        >
                          <Sparkles size={10} className="mr-1 inline" />
                          {s}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={chat.messagesEndRef} />
                </div>
              </div>
            </div>

            <div
              data-palink-chat-composer="true"
              className={cn(
                'absolute left-0 right-0 z-[20] px-3 pt-2 transform-gpu',
                'bg-gradient-to-t from-transparent via-transparent to-transparent',
                hideBottomComposerDuringWelcomeDrop
                  ? 'invisible pointer-events-none'
                  : 'visible'
              )}
              style={{ bottom: composerBottomStyle }}
            >
              <div ref={kb.mobileComposerRef} className="mx-auto w-[92%] max-w-[560px]">
                <ChatInput
                  value={chat.input}
                  onChange={chat.setInput}
                  onSend={handleSend}
                  onUpload={chat.handleUpload}
                  attachments={chat.attachments}
                  onRemoveAttachment={(idx) => chat.setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  models={models}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  disabled={chat.streaming || chat.isSendingMessage}
                  dimDisabled={!keepComposerVisualBright}
                  uploading={chat.uploading}
                  placeholder={t.ask_anything}
                  streaming={chat.streaming}
                  onStop={chat.handleStopStreaming}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                  webSearchEnabled={webSearchEnabled}
                  onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                  showWebSearch={webSearchAvailable}
                />
              </div>
            </div>

          </>
        )}
            </div>
          </div>

          {anim.showNewContentView && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity ease-in-out',
                anim.newSessionFadeState === 'fading-in' || anim.newSessionFadeState === 'idle' ? 'opacity-100' : 'opacity-0'
              )}
              style={{ transitionDuration: `${anim.NEW_SESSION_FADE_DURATION_MS}ms` }}
            >
              <div className="flex flex-1 flex-col overflow-hidden">
            <div
              ref={kb.messagesScrollWrapRef}
              data-palink-msg-scroll="true"
              className="flex-1 min-h-0 overflow-y-auto"
              onScroll={handleScroll}
            >
              <div className="px-3 pb-4">
                <div
                  ref={kb.messageStackRef}
                  className="mx-auto w-[92%] max-w-[560px] space-y-6"
                  style={{ paddingBottom: `${kb.messageBottomPaddingPx}px` }}
                >
                  {/* 顶部安全空间：高度与 header 完全一致(env(safe-area-inset-top)+4.5rem+8px)，确保最上面的消息不被 header 挡住 */}
                  <div aria-hidden style={{ height: 'calc(env(safe-area-inset-top) + 3rem + 8px)', width: '100%' }} />
                  {anim.displayedMessages.map((msg, idx) => (
                    <div key={msg.id || idx} className="flex items-start gap-2" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 120px' }}>
                      <div className="flex-1">
                        <Message
                          message={msg}
                          userAvatar={user.avatar}
                          userName={user.username}
                          models={models}
                          streaming={(chat.streaming && idx === anim.displayedMessages.length - 1) || chat.regeneratingMessageIndex === idx}
                          isLast={idx === anim.displayedMessages.length - 1}
                          t={t}
                          tokens={msg.tokens}
                          memoryStats={chat.memoryMode === 'rule' && idx === anim.displayedMessages.length - 1 && msg.role === 'assistant' ? chat.memoryStats : null}
                          onCompress={chat.memoryMode === 'rule' && idx === anim.displayedMessages.length - 1 && msg.role === 'assistant' ? chat.manualCompressMemory : undefined}
                          compressing={chat.compressing}
                          onRegenerate={msg.role === 'assistant' && !chat.streaming ? () => chat.handleRegenerate(idx) : undefined}
                          canRegenerate={msg.role === 'assistant' && !chat.streaming}
                          onDelete={msg.id ? () => handleDeleteMessage(msg.id, idx) : undefined}
                          onEdit={msg.id ? (newContent: string) => chat.handleEditMessage(msg.id, idx, newContent) : undefined}
                          canEdit={msg.role === 'assistant' && !chat.streaming}
                          onGenerateImage={msg.id != null ? chat.handleGenerateImage : undefined}
                          isGeneratingImage={msg.id != null ? chat.generatingImageMessageIds.has(String(msg.id)) : false}
                          showSelect={false}
                          isCharacterChat={false}
                          memoryMode={chat.memoryMode}
                          showModelReasoning={showModelReasoning}
                        />
                      </div>
                    </div>
                  ))}

                  {chat.streamStatus === 'queued' && chat.queueInfo && (
                    <div className="flex items-center gap-3 pl-10 animate-fade-in-up">
                      <div className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm',
                        isDark
                          ? 'bg-amber-900/20 border border-amber-700/50 text-amber-300'
                          : 'bg-amber-50 border border-amber-200 text-amber-700'
                      )}>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>排队中 · 第 {chat.queueInfo.position + 1} 位</span>
                        {chat.queueInfo.estimatedWait > 0 && (
                          <span className={isDark ? 'text-amber-400' : 'text-amber-500'}>· 预计 {Math.ceil(chat.queueInfo.estimatedWait)}s</span>
                        )}
                      </div>
                    </div>
                  )}

                  {displayedSuggestions.length > 0 && !chat.streaming && (
                    <div className="flex flex-wrap gap-2 pl-10 animate-fade-in-up">
                      {displayedSuggestions.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSend(s)}
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            isDark
                              ? 'border-slate-600/80 bg-[#2b314c] text-slate-100 hover:bg-[#363d5c]'
                              : 'border-[#ddd4c5] bg-[#FFFAFA] text-slate-700 hover:bg-[#f8f2e8]'
                          )}
                        >
                          <Sparkles size={10} className="mr-1 inline" />
                          {s}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={chat.messagesEndRef} />
                </div>
              </div>
            </div>

            <div
              data-palink-chat-composer="true"
              className={cn(
                'absolute left-0 right-0 z-[20] px-3 pt-2 transform-gpu',
                'bg-gradient-to-t from-transparent via-transparent to-transparent',
                hideBottomComposerDuringWelcomeDrop
                  ? 'invisible pointer-events-none'
                  : 'visible'
              )}
              style={{ bottom: composerBottomStyle }}
            >
              <div ref={kb.mobileComposerRef} className="mx-auto w-[92%] max-w-[560px]">
                <ChatInput
                  value={chat.input}
                  onChange={chat.setInput}
                  onSend={handleSend}
                  onUpload={chat.handleUpload}
                  attachments={chat.attachments}
                  onRemoveAttachment={(idx) => chat.setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  models={models}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  disabled={chat.streaming || chat.isSendingMessage}
                  dimDisabled={!keepComposerVisualBright}
                  uploading={chat.uploading}
                  placeholder={t.ask_anything}
                  streaming={chat.streaming}
                  onStop={chat.handleStopStreaming}
                  variant="mobile-demo"
                  theme={isDark ? 'dark' : 'light'}
                  showModelSelector={true}
                  modelSelectorTriggerStyle="icon"
                  webSearchEnabled={webSearchEnabled}
                  onToggleWebSearch={() => setWebSearchEnabled(prev => !prev)}
                  showWebSearch={false}
                />
              </div>
            </div>
              </div>
            </div>
          )}
        </div>

      <ConfirmDialog
          open={chat.showDeleteConfirm}
          onOpenChange={chat.setShowDeleteConfirm}
          title={
            chat.pendingDelete?.type === 'batch'
              ? `${t.delete_selected}?`
              : chat.pendingDelete?.type === 'message'
              ? '删除消息?'
              : `${t.delete_chat}?`
          }
          description={
            chat.pendingDelete?.type === 'batch'
              ? `确定要删除选中的 ${chat.selectedSessions.size} 个对话吗？此操作无法撤销。`
              : chat.pendingDelete?.type === 'message'
              ? '确定要删除这条消息吗？此操作无法撤销。'
              : '确定要删除这个对话吗？此操作无法撤销。'
          }
          onConfirm={confirmDelete}
          confirmText={t.ok}
          cancelText={t.cancel}
        />

        {anim.welcomeDropping && anim.welcomeDropSnapshot && (
          <div
            className={cn(
              'pointer-events-none fixed z-[24] transform-gpu',
              anim.welcomeDropAnimating && 'animate-welcome-drop'
            )}
            style={{
              top: `${anim.welcomeDropSnapshot.top}px`,
              left: `${anim.welcomeDropSnapshot.left}px`,
              width: `${anim.welcomeDropSnapshot.width}px`,
              ['--welcome-drop-distance' as string]: `${anim.welcomeDropDistance}px`,
              ['--welcome-drop-duration' as string]: `${anim.WELCOME_DROP_DURATION_MS}ms`,
            }}
          >
            <ChatInput
              value={anim.welcomeDropInputValue}
              onChange={() => {}}
              onSend={() => {}}
              onUpload={() => Promise.resolve()}
              attachments={[]}
              onRemoveAttachment={() => {}}
              models={models}
              currentModel={currentModel}
              onModelChange={() => {}}
              disabled={true}
              dimDisabled={false}
              uploading={false}
              placeholder={t.ask_anything}
              streaming={false}
              onStop={() => {}}
              variant="mobile-demo"
              theme={isDark ? 'dark' : 'light'}
              showModelSelector={true}
              modelSelectorTriggerStyle="icon"
              showWebSearch={false}
              visualOnly={true}
            />
          </div>
        )}
      </div>
      </div>
    </>
  );
};
